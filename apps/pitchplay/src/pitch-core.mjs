import createStretch from './vendor/signalsmith-engine.mjs';
import {RobotVoice} from './robot-voice.mjs';
import {SpeechClarity} from './speech-clarity.mjs';

const TAU = Math.PI * 2;
const KEYS = ['robot', 'roughness', 'tremolo', 'vibrato', 'double', 'tone', 'body', 'air', 'breath', 'articulation', 'clarity'];
const COLOR_KEYS = [...KEYS, 'carrier'];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// A private WASM instance per processor. Equal input/output sample counts keep
// speaking speed fixed. Vocal-tract shape and phonation are independent of f0.
export async function createVoiceEngine(sampleRate = 48000, channels = 2, {blockFrames = 2304} = {}) {
  return new VoiceEngine(await createStretch({noInitialRun: true}), sampleRate, channels, blockFrames);
}

export class VoiceEngine {
  constructor(wasm, sampleRate, channels, blockFrames) {
    this.wasm = wasm; this.sampleRate = sampleRate; this.count = channels;
    wasm._configure(channels, blockFrames, 256, false);
    wasm._setFormantBase(0);
    this.latency = wasm._inputLatency() + wasm._outputLatency();
    this.capacity = 960;
    const address = wasm._setBuffers(channels, this.capacity);
    this.wasmInput = Array.from({length: channels}, (_, c) => new Float32Array(wasm.HEAP8.buffer, address + c * this.capacity * 4, this.capacity));
    this.wasmOutput = Array.from({length: channels}, (_, c) => new Float32Array(wasm.HEAP8.buffer, address + (c + channels) * this.capacity * 4, this.capacity));
    this.dry = Array.from({length: channels}, () => new Float32Array(this.latency));
    this.dryPosition = 0;
    this.delay = Array.from({length: channels}, () => new Float32Array(1024));
    this.delayPosition = 0;
    this.low = new Float64Array(channels); this.high = new Float64Array(channels);
    this.articulationDryLow = new Float64Array(channels); this.articulationWetLow = new Float64Array(channels);
    this.articulationDryHighLow = new Float64Array(channels); this.articulationWetHighLow = new Float64Array(channels);
    this.clarityEnergy = new Float64Array(channels); this.clarityHighEnergy = new Float64Array(channels);
    this.envelope = new Float64Array(channels);
    this.robotVoice = new RobotVoice(sampleRate, channels);
    this.speechClarity = new SpeechClarity(sampleRate, channels, this.latency);
    this.target = {pitch: 0, mix: 1, bypass: false, formant: null, carrier: 90,
      robot: 0, roughness: 0, tremolo: 0, vibrato: 0, double: 0, tone: 0, body: 0, air: 0, breath: 0, articulation: 0, clarity: 0, level: 1};
    this.color = {...this.target};
    this.pitch = 0; this.mix = 1; this.enabled = 1; this.shifted = 0; this.level = 1;
    this.phase = 0; this.motion = 0; this.doublePhase = 0; this.random = 0x72414c;
    this.smoothing = 1 - Math.exp(-1 / (sampleRate * .008));
    this.lowAlpha = 1 - Math.exp(-TAU * 350 / sampleRate);
    this.highAlpha = 1 - Math.exp(-TAU * 3600 / sampleRate);
    this.articulationAlpha = 1 - Math.exp(-TAU * 3000 / sampleRate);
    this.clarityAttack = 1 - Math.exp(-1 / (sampleRate * .001));
    this.attack = 1 - Math.exp(-1 / (sampleRate * .006));
    this.release = 1 - Math.exp(-1 / (sampleRate * .065));
    this.inputPeak = 0; this.outputPeak = 0; this.clipped = 0; this.frames = 0;
    this.lastPitch = NaN; this.lastFormant = NaN;
  }

  set(values) {
    if (Number.isFinite(values.pitch)) this.target.pitch = clamp(values.pitch, -12, 24);
    if (Number.isFinite(values.mix)) this.target.mix = clamp(values.mix, 0, 1);
    if (typeof values.bypass === 'boolean') this.target.bypass = values.bypass;
    if (Number.isFinite(values.level)) this.target.level = clamp(values.level, 0, 1);
    if (values.formant === null || Number.isFinite(values.formant)) this.target.formant = values.formant === null ? null : clamp(values.formant, -24, 24);
    if (Number.isFinite(values.carrier)) this.target.carrier = clamp(values.carrier, 20, 300);
    for (const key of KEYS) if (Number.isFinite(values[key])) this.target[key] = clamp(values[key], ['tone', 'body', 'air'].includes(key) ? -1 : 0, 1);
    this.hasVoice = Math.abs(this.target.pitch) > .001 || Math.abs(this.target.formant || 0) > .001 || KEYS.some(k => Math.abs(this.target[k]) > .001);
  }

  reset() {
    this.wasm._reset();
    this.robotVoice.reset();
    this.speechClarity.reset();
    for (const channel of [...this.dry, ...this.delay]) channel.fill(0);
    this.low.fill(0); this.high.fill(0); this.envelope.fill(0);
    this.articulationDryLow.fill(0); this.articulationWetLow.fill(0);
    this.articulationDryHighLow.fill(0); this.articulationWetHighLow.fill(0);
    this.clarityEnergy.fill(0); this.clarityHighEnergy.fill(0);
    this.dryPosition = this.delayPosition = this.frames = this.inputPeak = this.outputPeak = this.clipped = 0;
  }

  warm() {
    const input = Array.from({length: this.count}, () => Float32Array.from({length: 960}, (_, i) => .01 * Math.sin(TAU * 173 * i / this.sampleRate)));
    const output = input.map(() => new Float32Array(960));
    this.set({pitch: 3, formant: 1.5});
    for (let i = 0; i < 8; i++) this.process(input, output);
    this.set({pitch: 0, formant: null}); this.pitch = this.shifted = 0;
    this.reset();
  }

  process(input, output) {
    // 64 divides both browser render quanta (128) and SDK packets (960).
    // Parameters therefore follow the same sample timeline in either mode.
    for (let offset = 0; offset < output[0].length; offset += 64) this.processChunk(input, output, offset, Math.min(64, output[0].length - offset));
  }

  processChunk(input, output, offset, length) {
    const smooth = this.smoothing, blockSmooth = 1 - (1 - smooth) ** length;
    this.pitch += (this.target.pitch - this.pitch) * blockSmooth;
    const pitch = this.pitch + Math.sin(this.motion) * this.color.vibrato;
    // Absolute formant shift with compensation, independent of the pitch knob.
    // Legacy pitch-only roles intentionally retain their chipmunk colour.
    const formant = this.target.formant;
    if (pitch !== this.lastPitch) { this.wasm._setTransposeSemitones(pitch, 6000 / this.sampleRate); this.lastPitch = pitch; }
    if (formant !== this.lastFormant) { this.wasm._setFormantSemitones(formant ?? 0, formant !== null); this.lastFormant = formant; }
    for (let c = 0; c < this.count; c++) {
      const source = input[c] || input[0];
      for (let i = 0; i < length; i++) this.wasmInput[c][i] = Number.isFinite(source?.[offset + i]) ? clamp(source[offset + i], -1, 1) : 0;
    }
    this.wasm._process(length, length);
    for (let i = 0; i < length; i++) {
      this.mix += (this.target.mix - this.mix) * smooth;
      this.enabled += ((this.target.bypass ? 0 : 1) - this.enabled) * smooth;
      this.level += (this.target.level - this.level) * smooth;
      this.shifted += ((this.hasVoice ? 1 : 0) - this.shifted) * smooth;
      for (const k of COLOR_KEYS) this.color[k] += (this.target[k] - this.color[k]) * smooth;
      this.phase = (this.phase + TAU * this.color.carrier / this.sampleRate) % TAU;
      this.motion = (this.motion + TAU * 4.7 / this.sampleRate) % TAU;
      this.doublePhase = (this.doublePhase + TAU * .63 / this.sampleRate) % TAU;
      this.random ^= this.random << 13; this.random ^= this.random >>> 17; this.random ^= this.random << 5;
      const noise = this.random / 2147483648;
      if (this.color.robot > .0001) this.robotVoice.tick(this.color.carrier);
      const wet = this.mix * this.enabled * this.shifted;
      const read = (this.delayPosition - this.sampleRate * (.006 + .002 * Math.sin(this.doublePhase)) + 1024) % 1024;
      const first = Math.floor(read), fraction = read - first;
      for (let c = 0; c < this.count; c++) {
        const raw = this.wasmInput[c][i], dry = this.dry[c][this.dryPosition];
        this.dry[c][this.dryPosition] = raw;
        let value = this.wasmOutput[c][i];
        this.low[c] += this.lowAlpha * (value - this.low[c]);
        this.high[c] += this.highAlpha * (value - this.high[c]);
        const high = value - this.high[c];
        const amplitude = Math.abs(value), coefficient = amplitude > this.envelope[c] ? this.attack : this.release;
        this.envelope[c] += coefficient * (amplitude - this.envelope[c]);
        // Chest/air bands plus signal-dependent breath alter phonation. Breath
        // falls away at pauses instead of introducing a permanent hiss.
        value += this.low[c] * this.color.body * .65 + high * (this.color.air + this.color.tone) * .55;
        value += noise * this.envelope[c] * this.color.breath * .45;
        if (this.color.roughness > .0001) {
          const drive = 1 + this.color.roughness * 10, scale = this.envelope[c] + .003;
          const driven = Math.tanh(value * drive / scale) * scale / Math.tanh(drive);
          value += (driven - value) * this.color.roughness;
        }
        if (this.color.robot > .0001) value += (this.robotVoice.process(c, value) - value) * this.color.robot;
        value *= 1 - this.color.tremolo * (.5 + .5 * Math.sin(this.motion));
        const delayed = this.delay[c][first] * (1 - fraction) + this.delay[c][(first + 1) % 1024] * fraction;
        this.delay[c][this.delayPosition] = value;
        value += (delayed - value) * this.color.double * .5;
        // Keep sharp speech noise on its original timeline. Only the upper band
        // is replaced; the pitched vowels and aligned original compare remain.
        this.articulationDryLow[c] += this.articulationAlpha * (dry - this.articulationDryLow[c]);
        this.articulationWetLow[c] += this.articulationAlpha * (value - this.articulationWetLow[c]);
        const dryHigh = dry - this.articulationDryLow[c], wetHigh = value - this.articulationWetLow[c];
        this.articulationDryHighLow[c] += this.articulationAlpha * (dryHigh - this.articulationDryHighLow[c]);
        this.articulationWetHighLow[c] += this.articulationAlpha * (wetHigh - this.articulationWetHighLow[c]);
        value += ((dryHigh - this.articulationDryHighLow[c]) - (wetHigh - this.articulationWetHighLow[c])) * this.color.articulation;
        // Preserve the whole unvoiced consonant, not only its hiss above3kHz.
        // Voiced vowels retain the character; a quiet aligned speech component
        // also keeps words readable through sparse/low robotic carriers.
        let unvoiced = this.speechClarity.push(c, raw, this.dryPosition, this.color.robot);
        this.clarityEnergy[c] += this.clarityAttack * (dry * dry - this.clarityEnergy[c]);
        this.clarityHighEnergy[c] += this.clarityAttack * (dryHigh * dryHigh - this.clarityHighEnergy[c]);
        // A short noisy burst must not wait for a whole voicing window. This
        // fast aligned high-band cue protects plosives without a voiced floor.
        const burst = clamp((this.clarityHighEnergy[c] / (this.clarityEnergy[c] + 1e-10) - .18) / .22, 0, 1);
        unvoiced = Math.max(unvoiced, burst * this.color.robot);
        const bodyOriginal = .08 * (1 - this.color.robot);
        const original = this.color.clarity * (bodyOriginal + (1 - bodyOriginal) * unvoiced);
        value += (dry - value) * original;
        const safe = Math.abs(value) <= .9 ? value : Math.sign(value) * (.9 + .1 * Math.tanh((Math.abs(value) - .9) / .1));
        // Align dry and wet: blending no longer comb-filters the original,
        // and comparison keeps the same sample timeline.
        const mixed = dry * (1 - wet) + safe * wet;
        output[c][offset + i] = mixed * this.level;
        this.inputPeak = Math.max(this.inputPeak, Math.abs(raw));
        this.outputPeak = Math.max(this.outputPeak, Math.abs(mixed));
        if (Math.abs(value) > 1 && wet > .001) this.clipped++;
      }
      this.dryPosition = (this.dryPosition + 1) % this.latency;
      this.delayPosition = (this.delayPosition + 1) % 1024;
    }
    this.frames += length;
  }
}
