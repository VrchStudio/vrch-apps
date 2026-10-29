/* VRCH SignalBus v1: deterministic audio signals and parameter modulation. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VrchSceneSignalBus = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  'use strict';

  const DEFAULTS = Object.freeze({
    noiseGate: 0.015,
    scalarAttackMs: 45,
    scalarDecayMs: 180,
    beatThreshold: 0.16,
    beatRatio: 1.45,
    beatHoldMs: 110,
    triggerAttackMs: 12,
    triggerDecayMs: 220,
    v2NoiseGate: 0.012,
    v2MinDynamicRange: 0.08,
    v2ScalarAttackMs: 35,
    v2ScalarReleaseMs: 220,
    // Onsets are musical accents: a real rise of the PCM envelope backed by
    // spectral change, or an abrupt strong spectral change at steady level.
    // Ordinary frame-to-frame flux alone is not an accent.
    v2OnsetFastMs: 12,
    v2OnsetSlowMs: 250,
    v2OnsetRiseDb: 3,
    v2OnsetRearmDb: 1.2,
    v2OnsetFluxSupportRatio: 1.1,
    v2OnsetStrongFlux: 0.35,
    v2OnsetStrongFluxRatio: 3,
    v2OnsetStrongRearmRatio: 0.6,
    v2OnsetFluxBaselineMs: 800,
    v2OnsetHoldMs: 160,
    v2BeatThreshold: 0.18,
    v2BeatRatio: 1.35,
    v2BeatHoldMs: 110
  });

  function clamp01(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(1, number));
  }

  function approach(current, target, deltaMs, attackMs, decayMs) {
    const rising = target > current;
    const tau = Math.max(1, rising ? attackMs : decayMs);
    const alpha = 1 - Math.exp(-Math.max(0, deltaMs) / tau);
    return current + (target - current) * alpha;
  }

  function roundHalfAwayFromZero(value) {
    return value < 0 ? -Math.round(-value) : Math.round(value);
  }

  function finiteOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeAudioMaster(master) {
    const value = master && typeof master === 'object' ? master : {};
    if (value.contract_version === 2) {
      const bands = value.band_gains && typeof value.band_gains === 'object' ? value.band_gains : {};
      return {
        contract_version: 2,
        enabled: value.enabled !== false,
        strength: Math.max(0, Math.min(4, finiteOr(value.strength, 1))),
        band_gains: {
          low: Math.max(0, Math.min(4, finiteOr(bands.low, 1))),
          mid: Math.max(0, Math.min(4, finiteOr(bands.mid, 1))),
          high: Math.max(0, Math.min(4, finiteOr(bands.high, 1)))
        }
      };
    }
    return {
      contract_version: 1,
      enabled: value.enabled !== false,
      gain: Math.max(0, Math.min(4, finiteOr(value.gain, 1)))
    };
  }

  function audioBandForSignal(signalId) {
    const id = String(signalId || '');
    if (/(?:^|\.)low(?:_|\.|$)/.test(id)) return 'low';
    if (/(?:^|\.)mid(?:_|\.|$)/.test(id)) return 'mid';
    if (/(?:^|\.)high(?:_|\.|$)/.test(id)) return 'high';
    return null;
  }

  function curveValue(value, curve) {
    const input = clamp01(value);
    if (curve === 'ease_in') return input * input;
    if (curve === 'ease_out') return 1 - (1 - input) * (1 - input);
    if (curve === 'smoothstep') return input * input * (3 - 2 * input);
    return input;
  }

  class SignalBus {
    constructor(options = {}) {
      this.config = Object.assign({}, DEFAULTS, options);
      this.values = Object.create(null);
      this.values['audio.rms'] = 0;
      this.values['audio.low'] = 0;
      this.values['audio.mid'] = 0;
      this.values['audio.high'] = 0;
      this.values['audio.centroid'] = 0;
      this.values['audio.beat'] = 0;
      this.values['audio.low_hit'] = 0;
      this.values['audio.v2.energy'] = 0;
      this.values['audio.v2.low'] = 0;
      this.values['audio.v2.mid'] = 0;
      this.values['audio.v2.high'] = 0;
      this.values['audio.v2.low_share'] = 0;
      this.values['audio.v2.mid_share'] = 0;
      this.values['audio.v2.high_share'] = 0;
      this.values['audio.v2.brightness'] = 0;
      this.values['audio.v2.flux'] = 0;
      this.values['audio.v2.onset'] = 0;
      this.values['audio.v2.beat'] = 0;
      this.values['external.knock'] = 0;
      this._lastTimeMs = null;
      this._lowBaseline = 0.02;
      this._lastBeatMs = -Infinity;
      this._beatTarget = 0;
      this._lowHitTarget = 0;
      this._v2Floor = this.config.v2NoiseGate;
      this._v2Ceiling = Math.max(this.config.v2NoiseGate + this.config.v2MinDynamicRange, 0.2);
      this._v2LowBaseline = 0.02;
      this._lastV2BeatMs = -Infinity;
      this._v2OnsetTarget = 0;
      this._v2FluxBaseline = 0;
      this._v2OnsetFast = 0;
      this._v2OnsetSlow = 0;
      this._v2OnsetRiseArmed = true;
      this._v2OnsetFluxArmed = true;
      this._lastV2OnsetMs = -Infinity;
      this._v2BeatTarget = 0;
      this._knockTarget = 0;
      this._bindingState = new Map();
      this._externalValues = Object.create(null);
    }

    injectTrigger(signalId, amount = 1) {
      const value = clamp01(amount);
      if (signalId === 'external.knock') this._knockTarget = Math.max(this._knockTarget, value);
      if (signalId === 'audio.beat') this._beatTarget = Math.max(this._beatTarget, value);
      if (signalId === 'audio.low_hit') this._lowHitTarget = Math.max(this._lowHitTarget, value);
    }

    setExternalValues(values) {
      Object.keys(values || {}).forEach((signalId) => {
        if (!signalId.startsWith('tracking.')) return;
        const value = clamp01(values[signalId]);
        this._externalValues[signalId] = value;
        this.values[signalId] = value;
      });
      return Object.assign({}, this._externalValues);
    }

    clearExternalValues(prefix) {
      const match = String(prefix || 'tracking.');
      Object.keys(this._externalValues).forEach((signalId) => {
        if (!signalId.startsWith(match)) return;
        delete this._externalValues[signalId];
        this.values[signalId] = 0;
      });
    }

    update(audioData, timeMs) {
      const now = Number.isFinite(timeMs) ? timeMs : (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const deltaMs = this._lastTimeMs == null ? 16.667 : Math.min(100, Math.max(0, now - this._lastTimeMs));
      this._lastTimeMs = now;
      const source = audioData || {};
      const rawLow = clamp01(Number.isFinite(source.raw_low) ? source.raw_low : source.low);
      const rawMid = clamp01(Number.isFinite(source.raw_mid) ? source.raw_mid : source.mid);
      const rawHigh = clamp01(Number.isFinite(source.raw_high) ? source.raw_high : source.high);
      const rawRms = Number.isFinite(source.rms)
        ? clamp01(source.rms)
        : Math.sqrt((rawLow * rawLow + rawMid * rawMid + rawHigh * rawHigh) / 3);
      const gated = rawRms < this.config.noiseGate;
      const targets = {
        'audio.low': gated ? 0 : rawLow,
        'audio.mid': gated ? 0 : rawMid,
        'audio.high': gated ? 0 : rawHigh,
        'audio.rms': gated ? 0 : rawRms,
        'audio.centroid': gated ? 0 : (Number.isFinite(source.centroid) ? clamp01(source.centroid) : clamp01((rawLow * 0.1 + rawMid * 0.42 + rawHigh * 0.82) / Math.max(0.0001, rawLow + rawMid + rawHigh)))
      };
      Object.keys(targets).forEach((id) => {
        this.values[id] = approach(this.values[id] || 0, targets[id], deltaMs, this.config.scalarAttackMs, this.config.scalarDecayMs);
      });

      const v2RawEnergy = clamp01(Number.isFinite(source.v2_raw_energy) ? source.v2_raw_energy : rawRms);
      const v2RawLow = clamp01(Number.isFinite(source.v2_raw_low) ? source.v2_raw_low : rawLow);
      const v2RawMid = clamp01(Number.isFinite(source.v2_raw_mid) ? source.v2_raw_mid : rawMid);
      const v2RawHigh = clamp01(Number.isFinite(source.v2_raw_high) ? source.v2_raw_high : rawHigh);
      const v2Gated = v2RawEnergy < this.config.v2NoiseGate;
      this._v2Floor = approach(this._v2Floor, v2RawEnergy, deltaMs, v2RawEnergy < this._v2Floor ? 700 : 8000, v2RawEnergy < this._v2Floor ? 700 : 8000);
      this._v2Ceiling = approach(this._v2Ceiling, v2RawEnergy, deltaMs, v2RawEnergy > this._v2Ceiling ? 180 : 6000, v2RawEnergy > this._v2Ceiling ? 180 : 6000);
      const v2Range = Math.max(this.config.v2MinDynamicRange, this._v2Ceiling - this._v2Floor);
      const v2Energy = v2Gated ? 0 : clamp01((v2RawEnergy - Math.max(this.config.v2NoiseGate, this._v2Floor)) / v2Range);
      const shareTotal = finiteOr(source.v2_low_share, 0) + finiteOr(source.v2_mid_share, 0) + finiteOr(source.v2_high_share, 0);
      const fallbackTotal = v2RawLow + v2RawMid + v2RawHigh;
      const v2Shares = v2Gated ? [0, 0, 0] : (shareTotal > 0
        ? [source.v2_low_share / shareTotal, source.v2_mid_share / shareTotal, source.v2_high_share / shareTotal]
        : (fallbackTotal > 0 ? [v2RawLow / fallbackTotal, v2RawMid / fallbackTotal, v2RawHigh / fallbackTotal] : [0, 0, 0]));
      const v2Targets = {
        'audio.v2.energy': v2Energy,
        'audio.v2.low': v2Gated ? 0 : clamp01(v2Energy * v2Shares[0] * 2.4),
        'audio.v2.mid': v2Gated ? 0 : clamp01(v2Energy * v2Shares[1] * 2.4),
        'audio.v2.high': v2Gated ? 0 : clamp01(v2Energy * v2Shares[2] * 2.4),
        'audio.v2.brightness': v2Gated ? 0 : clamp01(source.v2_brightness),
        'audio.v2.flux': v2Gated ? 0 : clamp01(finiteOr(source.v2_flux, 0) / 0.15)
      };
      Object.keys(v2Targets).forEach((id) => {
        this.values[id] = approach(this.values[id] || 0, v2Targets[id], deltaMs, this.config.v2ScalarAttackMs, this.config.v2ScalarReleaseMs);
      });
      const smoothedShares = ['low', 'mid', 'high'].map((band, index) => {
        const id = 'audio.v2.' + band + '_share';
        this.values[id] = approach(this.values[id] || 0, v2Shares[index], deltaMs, this.config.v2ScalarAttackMs, this.config.v2ScalarReleaseMs);
        return this.values[id];
      });
      const smoothedShareTotal = smoothedShares.reduce((sum, value) => sum + value, 0);
      if (!v2Gated && smoothedShareTotal > 0) {
        ['low', 'mid', 'high'].forEach((band, index) => { this.values['audio.v2.' + band + '_share'] = smoothedShares[index] / smoothedShareTotal; });
      } else {
        ['low', 'mid', 'high'].forEach((band) => { this.values['audio.v2.' + band + '_share'] = 0; });
      }

      const v2Flux = finiteOr(source.v2_flux, 0);
      const envelopeAlpha = (tau) => 1 - Math.exp(-deltaMs / Math.max(1, tau));
      this._v2OnsetFast += (v2RawEnergy - this._v2OnsetFast) * envelopeAlpha(this.config.v2OnsetFastMs);
      this._v2OnsetSlow += (v2RawEnergy - this._v2OnsetSlow) * envelopeAlpha(this.config.v2OnsetSlowMs);
      const riseDb = 20 * Math.log10(Math.max(0.0001, this._v2OnsetFast) / Math.max(0.0001, this._v2OnsetSlow));
      const strongFlux = Math.max(this.config.v2OnsetStrongFlux, this._v2FluxBaseline * this.config.v2OnsetStrongFluxRatio);
      if (v2Gated || riseDb < this.config.v2OnsetRearmDb) this._v2OnsetRiseArmed = true;
      if (v2Gated || v2Flux < strongFlux * this.config.v2OnsetStrongRearmRatio) this._v2OnsetFluxArmed = true;
      const byRise = this._v2OnsetRiseArmed && riseDb >= this.config.v2OnsetRiseDb && v2Flux >= this._v2FluxBaseline * this.config.v2OnsetFluxSupportRatio;
      const byFlux = this._v2OnsetFluxArmed && v2Flux >= strongFlux;
      if (!v2Gated && (byRise || byFlux) && now - this._lastV2OnsetMs >= this.config.v2OnsetHoldMs) {
        this._v2OnsetTarget = 1;
        this._lastV2OnsetMs = now;
        this._v2OnsetRiseArmed = false;
        this._v2OnsetFluxArmed = false;
      }
      this._v2FluxBaseline = approach(this._v2FluxBaseline, v2Gated ? 0 : v2Flux, deltaMs, this.config.v2OnsetFluxBaselineMs, this.config.v2OnsetFluxBaselineMs);
      this._v2LowBaseline = approach(this._v2LowBaseline, v2RawLow, deltaMs, 750, 1400);
      const isV2Beat = !v2Gated && v2RawLow >= this.config.v2BeatThreshold && v2RawLow >= this._v2LowBaseline * this.config.v2BeatRatio && now - this._lastV2BeatMs >= this.config.v2BeatHoldMs;
      if (isV2Beat) {
        this._lastV2BeatMs = now;
        this._v2BeatTarget = 1;
      }
      this.values['audio.v2.onset'] = approach(this.values['audio.v2.onset'] || 0, this._v2OnsetTarget, deltaMs, this.config.triggerAttackMs, this.config.triggerDecayMs);
      this.values['audio.v2.beat'] = approach(this.values['audio.v2.beat'] || 0, this._v2BeatTarget, deltaMs, this.config.triggerAttackMs, this.config.triggerDecayMs);
      this._v2OnsetTarget = 0;
      this._v2BeatTarget = 0;

      this._lowBaseline = approach(this._lowBaseline, rawLow, deltaMs, 750, 1400);
      const isBeat = !gated && rawLow >= this.config.beatThreshold && rawLow >= this._lowBaseline * this.config.beatRatio && now - this._lastBeatMs >= this.config.beatHoldMs;
      if (isBeat) {
        this._lastBeatMs = now;
        this._beatTarget = 1;
        this._lowHitTarget = Math.max(this._lowHitTarget, rawLow);
      }
      this.values['audio.beat'] = approach(this.values['audio.beat'] || 0, this._beatTarget, deltaMs, this.config.triggerAttackMs, this.config.triggerDecayMs);
      this.values['audio.low_hit'] = approach(this.values['audio.low_hit'] || 0, this._lowHitTarget, deltaMs, this.config.triggerAttackMs, this.config.triggerDecayMs);
      this.values['external.knock'] = approach(this.values['external.knock'] || 0, this._knockTarget, deltaMs, this.config.triggerAttackMs, this.config.triggerDecayMs);
      this._beatTarget = 0;
      this._lowHitTarget = 0;
      this._knockTarget = 0;
      Object.keys(this._externalValues).forEach((signalId) => { this.values[signalId] = this._externalValues[signalId]; });
      return Object.assign({}, this.values);
    }

    read(signalId, fallback = 0) {
      const value = this.values[signalId];
      return Number.isFinite(value) ? value : fallback;
    }

    readMastered(signalId, audioMaster, fallback = 0) {
      const value = this.read(signalId, fallback);
      if (!String(signalId || '').startsWith('audio.')) return value;
      const master = normalizeAudioMaster(audioMaster);
      if (!master.enabled) return 0;
      if (master.contract_version === 1) return value * master.gain;
      const band = audioBandForSignal(signalId);
      return value * master.strength * (band ? master.band_gains[band] : 1);
    }

    readForDefinition(definition, instance) {
      const output = [];
      const audioMaster = instance && instance.modulation_master && instance.modulation_master.audio;
      (definition.signals || []).forEach((signal) => {
        if (signal.type === 'texture') return;
        output.push(this.readMastered(signal.id, audioMaster, signal.default));
      });
      return output;
    }

    applyBindings(definition, instance, deltaMs) {
      const parameters = new Map((definition.parameters || []).map((parameter) => [parameter.key, parameter]));
      const values = Object.assign({}, instance.params || {});
      const bindings = Array.isArray(instance.bindings) ? instance.bindings : [];
      const audioMaster = instance.modulation_master && instance.modulation_master.audio;
      bindings.forEach((binding) => {
        const parameter = parameters.get(binding.param_key);
        if (!parameter || !['float', 'int'].includes(parameter.type)) return;
        const base = Number(values[binding.param_key]);
        if (!Number.isFinite(base)) return;
        if (String(binding.signal_id || '').startsWith('audio.') && !normalizeAudioMaster(audioMaster).enabled) {
          this._bindingState.set(binding.binding_id, 0);
          return;
        }
        let signal = this.readMastered(binding.signal_id, audioMaster, 0);
        const bindingV2 = binding.binding_version === 2;
        if (bindingV2) {
          const inputMin = finiteOr(binding.input_min, 0);
          const inputMax = finiteOr(binding.input_max, 1);
          signal = curveValue((signal - inputMin) / Math.max(0.000001, inputMax - inputMin), binding.curve);
        }
        if (binding.polarity === 'negative') signal = -signal;
        else if (binding.polarity === 'bipolar') signal = signal * 2 - 1;
        const target = bindingV2
          ? signal * Number(binding.depth) * (binding.operator === 'multiply' ? 1 : parameter.max - parameter.min)
          : signal * Number(binding.amount);
        const previous = this._bindingState.get(binding.binding_id) || 0;
        const attack = Number.isFinite(binding.attack_ms) ? binding.attack_ms : binding.smoothing_ms;
        const decay = bindingV2
          ? binding.release_ms
          : (Number.isFinite(binding.decay_ms) ? binding.decay_ms : binding.smoothing_ms);
        // Attack/release follows excursion magnitude, independently of polarity.
        const envelopeMs = Math.abs(target) > Math.abs(previous) ? attack : decay;
        const smoothed = approach(previous, target, deltaMs, envelopeMs, envelopeMs);
        this._bindingState.set(binding.binding_id, smoothed);
        let effective = binding.operator === 'multiply' ? base * (1 + smoothed) : base + smoothed;
        if (binding.clamp !== false) effective = Math.max(parameter.min, Math.min(parameter.max, effective));
        if (parameter.type === 'int') effective = roundHalfAwayFromZero(effective);
        values[binding.param_key] = effective;
      });
      return values;
    }

    reset() {
      Object.keys(this.values).forEach((id) => { this.values[id] = 0; });
      this._bindingState.clear();
      this._lastTimeMs = null;
      this._lowBaseline = 0.02;
      this._lastBeatMs = -Infinity;
      this._v2Floor = this.config.v2NoiseGate;
      this._v2Ceiling = Math.max(this.config.v2NoiseGate + this.config.v2MinDynamicRange, 0.2);
      this._v2LowBaseline = 0.02;
      this._lastV2BeatMs = -Infinity;
      this._v2OnsetTarget = 0;
      this._v2FluxBaseline = 0;
      this._v2OnsetFast = 0;
      this._v2OnsetSlow = 0;
      this._v2OnsetRiseArmed = true;
      this._v2OnsetFluxArmed = true;
      this._lastV2OnsetMs = -Infinity;
      this._v2BeatTarget = 0;
      this._beatTarget = 0;
      this._lowHitTarget = 0;
      this._knockTarget = 0;
      Object.keys(this._externalValues).forEach((signalId) => { this.values[signalId] = this._externalValues[signalId]; });
    }
  }

  return Object.freeze({
    SignalBus: SignalBus,
    DEFAULTS: DEFAULTS,
    normalizeAudioMaster: normalizeAudioMaster,
    roundHalfAwayFromZero: roundHalfAwayFromZero
  });
});
