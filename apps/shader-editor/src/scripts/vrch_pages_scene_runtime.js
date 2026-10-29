/* VRCH Scene Runtime v1 for Image Viewer V2. */
(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VrchSceneRuntime = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root) {
  'use strict';

  const THREE = root.THREE;
  const Contract = root.VrchSceneContract;
  const SignalBusCtor = root.VrchSceneSignalBus && root.VrchSceneSignalBus.SignalBus;
  const SourceBinding = root.VrchSceneSourceBinding || (typeof require === 'function' ? require('./vrch_pages_scene_source_binding.js') : null);

  function runtimeError(code, stage, message, details) {
    if (Contract && Contract.ContractError) return new Contract.ContractError(code, stage, message, details);
    const error = new Error(message);
    error.code = code;
    error.stage = stage;
    error.details = details || [];
    return error;
  }

  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function id(prefix) {
    const uuid = root.crypto && typeof root.crypto.randomUUID === 'function'
      ? root.crypto.randomUUID()
      : Math.random().toString(16).slice(2) + Date.now().toString(16);
    return prefix + '-' + uuid;
  }

  function sourceSize(source) {
    return {
      width: Math.max(1, Number(source && (source.videoWidth || source.naturalWidth || source.width)) || 1),
      height: Math.max(1, Number(source && (source.videoHeight || source.naturalHeight || source.height)) || 1)
    };
  }

  function defaultSlot(slot) {
    return {
      slot: slot,
      desired: { route: null },
      actual: { connection: 'disconnected', valid: false, stale: false, frame_id: 0, age_ms: 0 },
      geometry: { fit: 'cover', crop: [0, 0, 1, 1], rotation: 0, mirror_x: false, mirror_y: false }
    };
  }

  function fitCode(value) {
    return value === 'contain' ? 0 : value === 'stretch' ? 2 : 1;
  }

  function normalizeViewerDisplayMode(value) {
    const mode = String(value || '').toLowerCase();
    return ['fit', 'crop', 'stretch', 'original', 'tile-repeat', 'tile-mirror', 'projection'].includes(mode)
      ? mode
      : 'fit';
  }

  function viewerDisplayFitCode(value, fallback) {
    const mode = normalizeViewerDisplayMode(value);
    if (mode === 'fit' || mode === 'projection') return 0;
    if (mode === 'stretch') return 2;
    if (mode === 'original') return 3;
    if (mode === 'tile-repeat') return 4;
    if (mode === 'tile-mirror') return 5;
    if (mode === 'crop') return 1;
    return fitCode(fallback);
  }

  function normalizeViewerTileAnchor(value, displayMode) {
    if (Number(value) === 1) return 1;
    if (Number(value) === 2) return 2;
    if (Number(value) === 0 && value !== '' && value != null) return 0;
    const anchor = String(value || '').toLowerCase();
    if (anchor === 'top-left') return 1;
    if (anchor === 'bottom-right-to-center') return 2;
    if (anchor === 'center') return 0;
    return normalizeViewerDisplayMode(displayMode) === 'tile-mirror' ? 2 : 0;
  }

  function rotationCode(value) {
    return Math.max(0, [0, 90, 180, 270].indexOf(Number(value)));
  }

  // The generic shader mapping (vrchMapSourceUv) is affine for every non-tile
  // fit, and for tile fits an affine tile coordinate whose fraction is placed
  // affinely: prepare them once per frame instead of in every source sample.
  function sourcePlacement(fit, width, height, crop, rotation, mirrorX, mirrorY, originTopLeft, viewWidth, viewHeight, tileAnchor) {
    let croppedWidth = Math.max(1, width * crop[2]);
    let croppedHeight = Math.max(1, height * crop[3]);
    if (rotation === 1 || rotation === 3) { const swap = croppedWidth; croppedWidth = croppedHeight; croppedHeight = swap; }
    const outputAspect = Math.max(1, viewWidth) / Math.max(1, viewHeight);
    const sourceAspect = croppedWidth / Math.max(1, croppedHeight);
    let sx = 1, sy = 1, inside = false;
    if (fit === 0) {
      inside = true;
      if (outputAspect > sourceAspect) sx = outputAspect / sourceAspect;
      else sy = sourceAspect / outputAspect;
    } else if (fit === 1) {
      if (outputAspect > sourceAspect) sy = sourceAspect / outputAspect;
      else sx = outputAspect / sourceAspect;
    } else if (fit === 3) {
      inside = true;
      const originalHeight = 0.8047378541;
      sx = 1 / Math.max(originalHeight * sourceAspect / outputAspect, 0.000001);
      sy = 1 / Math.max(originalHeight, 0.000001);
    }
    const tiled = fit === 4 || fit === 5;
    // Rows: placed.x = x[0]*u + x[1]*v + x[2], placed.y likewise. Tiles start
    // from the identity on the in-tile fraction.
    let x = tiled ? [1, 0, 0] : [sx, 0, 0.5 - 0.5 * sx];
    let y = tiled ? [0, 1, 0] : [0, sy, 0.5 - 0.5 * sy];
    const flip = (row) => [-row[0], -row[1], 1 - row[2]];
    if (mirrorX) x = flip(x);
    if (mirrorY) y = flip(y);
    if (rotation === 1) { const nextX = y; y = flip(x); x = nextX; }
    else if (rotation === 2) { x = flip(x); y = flip(y); }
    else if (rotation === 3) { const nextX = flip(y); y = x; x = nextX; }
    const texel = [crop[2], originTopLeft ? -crop[3] : crop[3], crop[0], originTopLeft ? 1 - crop[1] : crop[1]];
    if (!tiled) return { map: inside ? 2 : 1, affine: [x[0], x[1], y[0], y[1]], shift: [x[2], y[2]], texel, post: [1, 0, 0, 1], tile: [0, 0, 0, 0] };
    // Tile cells use CSS pixels of the cropped (rotated) source, as V1 does.
    const countX = Math.max(Math.max(1, viewWidth) / croppedWidth, 0.000001);
    const countY = Math.max(Math.max(1, viewHeight) / croppedHeight, 0.000001);
    const shift = tileAnchor === 1 ? [0, 1 - countY] : tileAnchor === 2 ? [1 - 0.5 * countX, 1 - 0.5 * countY] : [0.5 - 0.5 * countX, 0.5 - 0.5 * countY];
    // Mirrored row parity follows the top-left row index: (1 - v) * countY - offset.
    const rowOffset = tileAnchor === 0 ? (countY - 1) * 0.5 : tileAnchor === 2 ? countY * 0.5 - 1 : 0;
    return {
      map: fit === 5 ? 4 : 3,
      affine: [countX, 0, 0, countY],
      shift,
      texel,
      post: [x[0], x[1], y[0], y[1]],
      tile: [x[2], y[2], -countY, countY - rowOffset]
    };
  }

  function makeTexture(source) {
    if (!THREE || !source) return null;
    const isVideo = typeof root.HTMLVideoElement !== 'undefined' && source instanceof root.HTMLVideoElement;
    const texture = isVideo && typeof THREE.VideoTexture === 'function' ? new THREE.VideoTexture(source) : new THREE.Texture(source);
    texture.needsUpdate = true;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.flipY = true;
    // sRGB storage lets the texture unit decode samples (VRCH_SRGB_SOURCES).
    if ('colorSpace' in texture && THREE.SRGBColorSpace !== undefined) texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function makeSignalTexture(source) {
    if (!THREE || !source) return null;
    if (source.isTexture) return source;
    if (source.data && source.width && source.height) {
      const data = source.data;
      const type = data instanceof Float32Array ? THREE.FloatType : THREE.UnsignedByteType;
      const texture = new THREE.DataTexture(data, source.width, source.height, THREE.RGBAFormat, type);
      texture.needsUpdate = true;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.flipY = false;
      if ('colorSpace' in texture && THREE.NoColorSpace !== undefined) texture.colorSpace = THREE.NoColorSpace;
      return texture;
    }
    const texture = typeof THREE.CanvasTexture === 'function' && typeof root.HTMLCanvasElement !== 'undefined' && source instanceof root.HTMLCanvasElement
      ? new THREE.CanvasTexture(source)
      : makeTexture(source);
    if (texture) texture.flipY = true;
    return texture;
  }

  function canReuseSourceTexture(texture, source) {
    if (!texture || !texture.isTexture || texture.isDataTexture || !texture.image || !source) return false;
    const previous = sourceSize(texture.image);
    const next = sourceSize(source);
    return previous.width === next.width && previous.height === next.height &&
      sourceHasTopLeftTextureOrigin(texture.image) === sourceHasTopLeftTextureOrigin(source);
  }

  function sourceHasTopLeftTextureOrigin(source) {
    // WebGL ignores UNPACK_FLIP_Y_WEBGL for ImageBitmap uploads. Three's
    // Texture.flipY therefore cannot normalize workflow frames decoded with
    // createImageBitmap, while it still works for canvas/image/video sources.
    // Keep that browser-level difference out of authored shaders by exposing
    // one runtime-only source-origin uniform.
    return typeof root.ImageBitmap !== 'undefined' && source instanceof root.ImageBitmap;
  }

  function stripVersion(source) {
    return String(source || '').replace(/^#version 300 es\s*/, '');
  }

  function percentile(values, quantile) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
    return sorted[index];
  }

  function defaultRefreshMs(config) {
    const estimate = config && config.refresh_estimate;
    return 1000 / ((estimate && estimate.default_hz) || 60);
  }

  // Shared by a runtime and its effects. The Viewer render loop calls
  // observeTick on every animation frame (skipped refreshes included), so the
  // lowest cluster of intervals is the refresh interval of the display it draws on.
  // A Visual rendering every refresh at exactly two refreshes per frame would
  // look like a slower display, so the estimate only rises while frames are
  // paced, when skipped refreshes show the real interval.
  function createFramePacing(config) {
    const estimate = (config && config.refresh_estimate) || {};
    const pacing = { minIntervalMs: 0, divisor: 0, appliedRefreshMs: null, refreshMs: defaultRefreshMs(config), deltas: [], lastTick: 0, ticks: 0 };
    pacing.observeTick = function observeTick(time) {
      const delta = time - this.lastTick;
      this.lastTick = time;
      if (!(delta >= 4 && delta <= 100)) return;
      this.deltas.push(delta);
      if (this.deltas.length > (estimate.window || 120)) this.deltas.shift();
      this.ticks += 1;
      if (this.ticks % (estimate.update_every || 30) !== 0 || this.deltas.length < (estimate.min_samples || 60)) return;
      const sorted = this.deltas.slice().sort((a, b) => a - b);
      const low = sorted[Math.floor(sorted.length * 0.1)];
      const cluster = sorted.filter((value) => Math.abs(value - low) <= low * (estimate.cluster_tolerance || 0.15));
      if (cluster.length < sorted.length * (estimate.cluster_share || 0.15)) return;
      const next = cluster[Math.floor(cluster.length / 2)];
      if (next < this.refreshMs * 0.99 || (next > this.refreshMs * 1.01 && this.minIntervalMs > 0)) this.refreshMs = next;
    };
    return pacing;
  }

  function refreshMsOf(framePacing, config) {
    return framePacing && framePacing.refreshMs > 0 ? framePacing.refreshMs : defaultRefreshMs(config);
  }

  const TILE_MUSIC_SIGNAL = 'audio.v2.flip_tiles';
  function rank(x, y, seed) {
    let n = Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663) ^ Math.imul(seed, 83492791);
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    return (n ^ (n >>> 16)) >>> 0;
  }
  function createTileMusicEvents(effect) {
    if (!(effect.definition.signals || []).some(signal => signal.id === TILE_MUSIC_SIGNAL && signal.type === 'texture')) return null;
    let source = null;
    const state = {};
    function clear() {
      Object.assign(state, {tiles: [], serial: 0, previousBeat: 0, previousOnset: 0, noteFast: 0, noteSlow: 0, noteArmed: true, lastTrigger: -Infinity, lastEnd: -Infinity, period: .5, lastTime: null, window: [], events: [], lastCount: 0, lastStrength: 0});
      source = null;
    }
    clear();
    function resize() {
      const size = effect.uniforms.iResolution.value, blocks = effect.instance.params.blocks;
      const width = Math.ceil(size.x / Math.min(size.x, size.y) * blocks), rows = Math.ceil(size.y / Math.min(size.x, size.y) * blocks);
      if (source?.width === width && source?.rows === rows) return;
      const previous = new Map(state.tiles.map(tile => [tile.x + ':' + tile.y, tile]));
      state.tiles = [];
      for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) state.tiles.push(previous.get(x + ':' + y) || {x, y, time: -10, seed: 0, duration: 0, hold: 0, perspective: 0, strength: 0});
      source = {data: new Float32Array(width * rows * 8), width, rows, height: rows * 2};
    }
    function trigger(time, strength, kind = 'beat', params = effect.instance.params) {
      resize();
      const master = effect.instance.modulation_master.audio;
      const band = kind === 'beat' ? master.band_gains.low : (master.band_gains.low + master.band_gains.mid + master.band_gains.high) / 3;
      const power = Math.min(1, Math.max(0, strength * (master.enabled ? master.strength * band : 0)));
      const available = state.tiles.filter(tile => time - tile.time >= tile.duration + tile.hold);
      const count = Math.round(available.length * params.density * power);
      if (count < 1) return false;
      const seed = ++state.serial;
      available.sort((a, b) => rank(a.x, a.y, seed) - rank(b.x, b.y, seed));
      for (let i = 0; i < count; i++) Object.assign(available[i], {time, seed, duration: params.duration, hold: .04, perspective: .48, strength: power, kind});
      const interval = time - state.lastTrigger;
      if (interval > .25 && interval < 2) {
        const multiple = Math.max(1, Math.round(interval / state.period));
        const observed = Math.max(.28, Math.min(1, interval / multiple));
        state.period = state.period * .75 + observed * .25;
      } else if (interval >= 2) state.period = .5;
      state.lastTrigger = time; state.lastEnd = time + params.duration + .04;
      state.lastCount = count; state.lastStrength = power;
      state.events.push({time, count, strength: power, kind, duration: params.duration, hold: .04, perspective: .48, seed});
      if (state.events.length > 256) state.events.shift();
      return true;
    }
    function update(time, audio, frame) {
      resize();
      const beat = frame.signals['audio.v2.beat'] || 0, onset = frame.signals['audio.v2.onset'] || 0;
      if (state.lastTime !== time) {
        const energy = Math.max(0, Number(audio?.v2_raw_energy ?? audio?.rms ?? 0));
        const low = Math.max(0, Number(audio?.v2_raw_low ?? audio?.raw_low ?? 0));
        const flux = Math.max(0, Number(audio?.v2_flux ?? 0));
        state.window.push({time: frame.time, energy, low});
        state.window = state.window.filter(sample => frame.time - sample.time <= .101);
        const floor = Math.min(...state.window.map(sample => sample.energy)), lowFloor = Math.min(...state.window.map(sample => sample.low));
        const rise = (energy - floor) / Math.max(.005, energy), lowRise = (low - lowFloor) / Math.max(.005, low);
        const sensitivity = frame.params.note_response || 0;
        const threshold = .24 - .16 * sensitivity;
        const delta = Math.max(1 / 120, frame.delta);
        state.noteFast += (energy - state.noteFast) * (1 - Math.exp(-delta / .02));
        state.noteSlow += (energy - state.noteSlow) * (1 - Math.exp(-delta / .12));
        const noteAttack = (state.noteFast - state.noteSlow) / Math.max(.008, state.noteFast);
        if (noteAttack < threshold * .35) state.noteArmed = true;
        const drum = beat - state.previousBeat > .08 && lowRise >= .32 && low - lowFloor >= .008;
        const note = sensitivity > 0 && state.noteArmed && noteAttack >= threshold && state.noteFast > .015 && flux > .1;
        // Consume each rising envelope once, even while a turn is busy.
        // Never defer a missed note until an arbitrary free frame.
        if (note) state.noteArmed = false;
        // Every strike comes from an actual attack. Cadence only rejects
        // duplicate attacks; it never generates a free-running beat clock.
        const separated = frame.time >= state.lastEnd + .025 && frame.time - state.lastTrigger >= (drum ? Math.min(.65, state.period * .64) : .27);
        if ((drum || note) && separated) {
          const level = drum ? Math.max(low, energy) : energy;
          const strength = drum ? Math.min(1, Math.sqrt(level) * 1.35) * (.5 + .5 * Math.max(rise, lowRise)) : Math.min(1, Math.sqrt(level) * 2.1) * (.7 + .3 * Math.max(rise, noteAttack));
          trigger(frame.time, strength, drum ? 'beat' : 'onset', frame.params);
        }
      }
      state.previousBeat = beat; state.previousOnset = onset; state.lastTime = time;
      const master = effect.instance.modulation_master.audio, enabled = master.enabled && master.strength > 0;
      const offset = state.tiles.length * 4;
      state.tiles.forEach((tile, index) => {
        source.data.set([tile.time, tile.seed, enabled && tile.seed > 0 ? 1 : 0, tile.strength], index * 4);
        source.data.set([tile.duration, tile.hold, tile.perspective, tile.kind === 'onset' ? 1 : 0], offset + index * 4);
      });
      effect.setSignalTexture(TILE_MUSIC_SIGNAL, source);
      return frame;
    };
    return {state, trigger, update, reset: clear};
  }

  // audio.v2.spectrum: a short history of log-frequency spectra for line
  // visuals. Texture rows 0..11 pack history levels 4 per texel (line k = row
  // floor(k / 4), channel k % 4, newest first); row 12 holds the per-column
  // maximum in R, the fraction of time until the next history step in G and
  // the largest line mean in B; row 13 texel r holds the means of lines
  // 4r..4r+3 and row 14 texel r their onset accents (1 where an attack began).
  const SPECTRUM_SIGNAL = 'audio.v2.spectrum';
  const SPECTRUM_WIDTH = 128, SPECTRUM_LINES = 48, SPECTRUM_RATE = 20, SPECTRUM_NOISE_GATE = 0.012;
  function createSpectrumHistory(effect) {
    if (!(effect.definition.signals || []).some(signal => signal.id === SPECTRUM_SIGNAL && signal.type === 'texture')) return null;
    const bands = 64, rows = SPECTRUM_LINES / 4 + 3;
    const data = new Uint8Array(SPECTRUM_WIDTH * rows * 4);
    const texture = new THREE.DataTexture(data, SPECTRUM_WIDTH, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.flipY = false;
    if ('colorSpace' in texture && THREE.NoColorSpace !== undefined) texture.colorSpace = THREE.NoColorSpace;
    // Per-band frequency (octaves from 1 kHz) and Settings band-gain weights.
    const octaves = new Float32Array(bands), weights = [];
    for (let band = 0; band < bands; band++) {
      const hz = 40 * Math.pow(12000 / 40, (band + 0.5) / bands);
      octaves[band] = Math.log2(hz / 1000);
      const toMid = Math.min(1, Math.max(0, Math.log2(hz / 250) + 0.5)), toHigh = Math.min(1, Math.max(0, Math.log2(hz / 2500) + 0.5));
      weights.push([1 - toMid, toMid * (1 - toHigh), toHigh]);
    }
    const raw = new Float32Array(bands), peaks = new Float32Array(bands), level = new Float32Array(bands), smooth = new Float32Array(bands), line = new Float32Array(SPECTRUM_WIDTH);
    const history = Array.from({length: SPECTRUM_LINES}, () => new Float32Array(SPECTRUM_WIDTH));
    const means = new Float32Array(SPECTRUM_LINES), accents = new Float32Array(SPECTRUM_LINES);
    const state = {};
    function reset() {
      level.fill(0);
      peaks.fill(0.5);
      means.fill(0);
      accents.fill(0);
      history.forEach(row => row.fill(0));
      Object.assign(state, {head: 0, clock: 0, peak: 0.5, onset: 0});
    }
    reset();
    function update(time, audio, frame) {
      const delta = Math.max(0, frame.delta), params = frame.params, smoothness = params.smooth ?? 0.5;
      const master = effect.instance.modulation_master.audio, strength = Number(master.strength ?? master.gain ?? 1);
      const spectrum = audio && audio.v2_spectrum;
      const live = master.enabled && strength > 0 && spectrum && spectrum.length === bands && Number(audio.v2_raw_energy ?? audio.rms ?? 0) >= SPECTRUM_NOISE_GATE;
      const gains = master.band_gains || {low: 1, mid: 1, high: 1};
      // Pink-tilt compensation; each band then follows both the loudest band
      // and its own recent peak, so quiet treble moves as visibly as bass.
      let peak = 0;
      for (let band = 0; band < bands; band++) {
        const w = weights[band], gain = w[0] * gains.low + w[1] * gains.mid + w[2] * gains.high;
        raw[band] = live ? Math.min(1.5, Math.max(0, (spectrum[band] + 4 * octaves[band] + 76) / 46) * gain) : 0;
        peak = Math.max(peak, raw[band]);
        peaks[band] += (raw[band] - peaks[band]) * (1 - Math.exp(-delta / (raw[band] > peaks[band] ? 0.3 : 6)));
      }
      state.peak += (peak - state.peak) * (1 - Math.exp(-delta / (peak > state.peak ? 0.4 : 5)));
      const scale = Math.min(1.5, strength), release = 0.12 + 0.3 * smoothness;
      for (let band = 0; band < bands; band++) {
        const global = raw[band] / Math.max(0.45, state.peak), local = raw[band] / Math.max(0.3, peaks[band]);
        // Near-silent bands are not lifted by their own peak.
        const target = Math.pow(Math.min(1.4, scale * (0.4 * global + 0.6 * local) * Math.min(1, raw[band] / 0.08)), 1.6);
        level[band] += (target - level[band]) * (1 - Math.exp(-delta / (target > level[band] ? 0.03 : release)));
      }
      // Spread along frequency, then resample to the texture width.
      const sigma = 0.6 + 2.6 * smoothness, radius = Math.ceil(sigma * 2.5);
      for (let band = 0; band < bands; band++) {
        let sum = 0, total = 0;
        for (let offset = -radius; offset <= radius; offset++) {
          const index = Math.min(bands - 1, Math.max(0, band + offset)), weight = Math.exp(-offset * offset / (2 * sigma * sigma));
          sum += level[index] * weight; total += weight;
        }
        smooth[band] = sum / total;
      }
      for (let x = 0; x < SPECTRUM_WIDTH; x++) {
        const position = x / (SPECTRUM_WIDTH - 1) * (bands - 1), index = Math.floor(position), f = position - index;
        const p0 = smooth[Math.max(0, index - 1)], p1 = smooth[index], p2 = smooth[Math.min(bands - 1, index + 1)], p3 = smooth[Math.min(bands - 1, index + 2)];
        line[x] = Math.min(1, Math.max(0, p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)))));
      }
      state.clock += delta * SPECTRUM_RATE;
      for (let steps = 0; state.clock >= 1 && steps < 4; steps++) {
        state.clock -= 1;
        state.head = (state.head + SPECTRUM_LINES - 1) % SPECTRUM_LINES;
        accents[state.head] = 0;
      }
      state.clock = Math.min(state.clock, 0.999);
      history[state.head].set(line);
      means[state.head] = line.reduce((sum, value) => sum + value, 0) / SPECTRUM_WIDTH;
      // An attack marks the spectrum captured at that moment; it recedes with its line.
      const onset = Number(frame.signals && frame.signals['audio.v2.onset']) || 0;
      if (live && onset > 0.5 && state.onset <= 0.5) accents[state.head] = 1;
      state.onset = onset;
      const top = SPECTRUM_LINES / 4 * SPECTRUM_WIDTH * 4, meanRow = top + SPECTRUM_WIDTH * 4, accentRow = meanRow + SPECTRUM_WIDTH * 4;
      for (let x = 0; x < SPECTRUM_WIDTH; x++) data[top + x * 4] = 0;
      for (let k = 0; k < SPECTRUM_LINES; k++) {
        const slot = (state.head + k) % SPECTRUM_LINES, row = history[slot], base = (k >> 2) * SPECTRUM_WIDTH * 4 + (k & 3);
        data[meanRow + k] = Math.round(means[slot] * 255);
        data[accentRow + k] = Math.round(accents[slot] * 255);
        for (let x = 0; x < SPECTRUM_WIDTH; x++) {
          const value = Math.round(row[x] * 255);
          data[base + x * 4] = value;
          if (value > data[top + x * 4]) data[top + x * 4] = value;
        }
      }
      const fraction = Math.round(state.clock * 255), meanMax = Math.round(Math.max(...means) * 255);
      for (let x = 0; x < SPECTRUM_WIDTH; x++) { data[top + x * 4 + 1] = fraction; data[top + x * 4 + 2] = meanMax; }
      effect.setSignalTexture(SPECTRUM_SIGNAL, texture);
      return frame;
    }
    return {state, update, reset};
  }

  class SceneEffect {
    constructor(options) {
      if (!THREE || !Contract || !SignalBusCtor) throw runtimeError('runtime_unavailable', 'runtime', 'Scene Runtime dependencies are unavailable.');
      this.scene = options.scene;
      this.camera = options.camera;
      this.renderer = options.renderer;
      this.definition = options.definition;
      this.instance = clone(options.instance);
      this.trusted = options.trusted === true;
      this.signalBus = options.signalBus || new SignalBusCtor();
      this.sourceSlots = [defaultSlot('A'), defaultSlot('B')];
      this.sourceTextures = [null, null];
      this.sourceInputs = [null, null];
      this.signalTextures = [null, null];
      this.signalTextureInputs = [null, null];
      this.isVrchSceneEffect = true;
      this.displayMode = normalizeViewerDisplayMode(options.displayMode);
      this.tileAnchor = normalizeViewerTileAnchor(options.tileAnchor, this.displayMode);
      this.epochSeconds = null;
      this.lastTimeSeconds = null;
      this.frame = 0;
      this.visible = true;
      this.parameterPhaseClock = new Contract.ParameterPhaseClock(this.definition);
      this.resolutionOverride = null;
      this.onFrameSample = typeof options.onFrameSample === 'function' ? options.onFrameSample : null;
      this.disposed = false;
      this.uniforms = this._createUniforms();
      // Optional frame stage: per-frame values in a texels x 1 float texture.
      this.frameTarget = null;
      if (this.definition.frame) {
        this.frameTarget = new THREE.WebGLRenderTarget(this.definition.frame.texels, 1, {
          type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
          depthBuffer: false, stencilBuffer: false, generateMipmaps: false
        });
        this.uniforms.uVrchFrameData = { value: this.frameTarget.texture };
      }
      // Optional coarse stage: one value per divisor x divisor block, sized to the main pass every frame.
      this.coarseTarget = null;
      if (this.definition.coarse) {
        this.coarseTarget = new THREE.WebGLRenderTarget(1, 1, {
          type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
          depthBuffer: false, stencilBuffer: false, generateMipmaps: false
        });
        this.uniforms.uVrchCoarseData = { value: this.coarseTarget.texture };
      }
      this.geometry = new THREE.BufferGeometry();
      this.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      this.material = new THREE.RawShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: stripVersion(Contract.buildVertexShader()),
        fragmentShader: stripVersion(Contract.buildFragmentShader(this.definition, { trusted: this.trusted })),
        glslVersion: THREE.GLSL3,
        defines: THREE.SRGBColorSpace !== undefined ? { VRCH_SRGB_SOURCES: '' } : {},
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      this.mesh = new THREE.Mesh(this.geometry, this.material);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 100000;
      if (this.scene) this.scene.add(this.mesh);
      if (this.frameTarget) {
        this.frameMaterial = new THREE.RawShaderMaterial({
          uniforms: this.uniforms,
          vertexShader: stripVersion(Contract.buildVertexShader()),
          fragmentShader: stripVersion(Contract.buildFrameShader(this.definition, { trusted: this.trusted })),
          glslVersion: THREE.GLSL3,
          blending: THREE.NoBlending,
          depthTest: false,
          depthWrite: false
        });
        this.frameScene = new THREE.Scene();
        const frameMesh = new THREE.Mesh(this.geometry, this.frameMaterial);
        frameMesh.frustumCulled = false;
        this.frameScene.add(frameMesh);
        this.frameCamera = new THREE.Camera();
      }
      if (this.coarseTarget) {
        this.coarseMaterial = new THREE.RawShaderMaterial({
          uniforms: this.uniforms,
          vertexShader: stripVersion(Contract.buildVertexShader()),
          fragmentShader: stripVersion(Contract.buildCoarseShader(this.definition, { trusted: this.trusted })),
          glslVersion: THREE.GLSL3,
          blending: THREE.NoBlending,
          depthTest: false,
          depthWrite: false
        });
        this.coarseScene = new THREE.Scene();
        const coarseMesh = new THREE.Mesh(this.geometry, this.coarseMaterial);
        coarseMesh.frustumCulled = false;
        this.coarseScene.add(coarseMesh);
        this.coarseCamera = new THREE.Camera();
      }
      this._applyInstanceUniforms(this.instance.params || {});
      this._applySourceUniforms();
      this.musicEvents = createTileMusicEvents(this);
      this.spectrumHistory = createSpectrumHistory(this);
    }

    _placeholderTexture(slot) {
      const light = slot === 0 ? [12, 14, 18, 255] : [20, 22, 28, 255];
      const dark = [4, 5, 7, 255];
      const bytes = new Uint8Array(light.concat(dark, dark, light));
      const texture = new THREE.DataTexture(bytes, 2, 2, THREE.RGBAFormat, THREE.UnsignedByteType);
      texture.needsUpdate = true;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      if ('colorSpace' in texture && THREE.SRGBColorSpace !== undefined) texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    }

    _createUniforms() {
      const uniforms = {
        iResolution: { value: new THREE.Vector3(1, 1, 1) },
        uVrchViewportResolution: { value: new THREE.Vector2(1, 1) },
        iTime: { value: 0 },
        iTimeDelta: { value: 0 },
        iFrame: { value: 0 },
        uVrchPhasesValid: { value: true },
        uVrchSignals: { value: new Float32Array(16) }
      };
      uniforms.uVrchTileAnchor = { value: this.tileAnchor };
      for (let slot = 0; slot < 2; slot += 1) {
        const placeholder = this._placeholderTexture(slot);
        this.sourceTextures[slot] = placeholder;
        uniforms['uVrchSource' + slot] = { value: placeholder };
        uniforms['uVrchSource' + slot + 'Valid'] = { value: false };
        uniforms['uVrchSource' + slot + 'Stale'] = { value: false };
        uniforms['uVrchSource' + slot + 'Resolution'] = { value: new THREE.Vector2(1, 1) };
        uniforms['uVrchSource' + slot + 'Age'] = { value: 0 };
        uniforms['uVrchSource' + slot + 'Fit'] = { value: 1 };
        uniforms['uVrchSource' + slot + 'Crop'] = { value: new THREE.Vector4(0, 0, 1, 1) };
        uniforms['uVrchSource' + slot + 'Rotation'] = { value: 0 };
        uniforms['uVrchSource' + slot + 'Mirror'] = { value: new THREE.Vector2(0, 0) };
        uniforms['uVrchSource' + slot + 'OriginTopLeft'] = { value: false };
        uniforms['uVrchSource' + slot + 'Map'] = { value: 0 };
        uniforms['uVrchSource' + slot + 'Affine'] = { value: new THREE.Vector4(1, 0, 0, 1) };
        uniforms['uVrchSource' + slot + 'Shift'] = { value: new THREE.Vector2(0, 0) };
        uniforms['uVrchSource' + slot + 'Texel'] = { value: new THREE.Vector4(1, 1, 0, 0) };
        uniforms['uVrchSource' + slot + 'Post'] = { value: new THREE.Vector4(1, 0, 0, 1) };
        uniforms['uVrchSource' + slot + 'Tile'] = { value: new THREE.Vector4(0, 0, 0, 0) };
      }
      for (let slot = 0; slot < 2; slot += 1) {
        const placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
        placeholder.needsUpdate = true;
        placeholder.minFilter = THREE.NearestFilter;
        placeholder.magFilter = THREE.NearestFilter;
        this.signalTextures[slot] = placeholder;
        uniforms['uVrchSignalTexture' + slot] = { value: placeholder };
        uniforms['uVrchSignalTexture' + slot + 'Valid'] = { value: false };
      }
      const spec = Contract.makeUniformSpec(this.definition, this.instance, { trusted: this.trusted });
      Object.keys(spec).forEach((name) => {
        const item = spec[name];
        let value = item.value;
        if (item.type === 'vec2') value = new THREE.Vector2(value[0], value[1]);
        if (item.type === 'vec4') value = new THREE.Vector4(value[0], value[1], value[2], value[3]);
        uniforms[name] = { value: value };
      });
      return uniforms;
    }

    _applyInstanceUniforms(params) {
      this.definition.parameters.forEach((parameter) => {
        const uniform = this.uniforms['uParam_' + parameter.key];
        if (!uniform) return;
        const value = params[parameter.key];
        if (parameter.type === 'color') {
          const rgba = value.length === 3 ? value.concat(1) : value;
          uniform.value.set(rgba[0], rgba[1], rgba[2], rgba[3]);
        } else if (parameter.type === 'vec2') {
          uniform.value.set(value[0], value[1]);
        } else if (parameter.type === 'enum') {
          uniform.value = Math.max(0, (parameter.options || []).indexOf(value));
        } else {
          uniform.value = value;
        }
      });
    }

    _applySourceUniforms() {
      this.sourceSlots.forEach((slotState, index) => {
        const geometry = slotState.geometry || defaultSlot(index === 0 ? 'A' : 'B').geometry;
        const actual = slotState.actual || {};
        const source = this.sourceInputs[index];
        const size = sourceSize(source);
        this.uniforms['uVrchSource' + index].value = this.sourceTextures[index];
        this.uniforms['uVrchSource' + index + 'Valid'].value = !!source && actual.valid !== false;
        this.uniforms['uVrchSource' + index + 'Stale'].value = !!actual.stale;
        this.uniforms['uVrchSource' + index + 'Resolution'].value.set(size.width, size.height);
        this.uniforms['uVrchSource' + index + 'Age'].value = Math.max(0, Number(actual.age_ms) || 0) / 1000;
        this.uniforms['uVrchSource' + index + 'Fit'].value = viewerDisplayFitCode(this.displayMode, geometry.fit);
        const crop = Array.isArray(geometry.crop) && geometry.crop.length === 4 ? geometry.crop : [0, 0, 1, 1];
        this.uniforms['uVrchSource' + index + 'Crop'].value.set(crop[0], crop[1], crop[2], crop[3]);
        this.uniforms['uVrchSource' + index + 'Rotation'].value = rotationCode(geometry.rotation);
        this.uniforms['uVrchSource' + index + 'Mirror'].value.set(geometry.mirror_x ? 1 : 0, geometry.mirror_y ? 1 : 0);
        this.uniforms['uVrchSource' + index + 'OriginTopLeft'].value = sourceHasTopLeftTextureOrigin(source);
      });
    }

    _applySourcePlacement() {
      const view = this.uniforms.uVrchViewportResolution.value;
      let placed = true;
      for (let index = 0; index < 2; index += 1) {
        const prefix = 'uVrchSource' + index;
        const resolution = this.uniforms[prefix + 'Resolution'].value;
        const crop = this.uniforms[prefix + 'Crop'].value;
        const mirror = this.uniforms[prefix + 'Mirror'].value;
        const placement = sourcePlacement(this.uniforms[prefix + 'Fit'].value, resolution.x, resolution.y,
          [crop.x, crop.y, crop.z, crop.w], this.uniforms[prefix + 'Rotation'].value, mirror.x > 0.5, mirror.y > 0.5,
          !!this.uniforms[prefix + 'OriginTopLeft'].value, view.x, view.y, this.uniforms.uVrchTileAnchor.value);
        this.uniforms[prefix + 'Map'].value = placement ? placement.map : 0;
        if (!placement) { placed = false; continue; }
        this.uniforms[prefix + 'Affine'].value.set(placement.affine[0], placement.affine[1], placement.affine[2], placement.affine[3]);
        this.uniforms[prefix + 'Shift'].value.set(placement.shift[0], placement.shift[1]);
        this.uniforms[prefix + 'Texel'].value.set(placement.texel[0], placement.texel[1], placement.texel[2], placement.texel[3]);
        this.uniforms[prefix + 'Post'].value.set(placement.post[0], placement.post[1], placement.post[2], placement.post[3]);
        this.uniforms[prefix + 'Tile'].value.set(placement.tile[0], placement.tile[1], placement.tile[2], placement.tile[3]);
      }
      // Every fit is placed today; the define keeps the generic mapping available.
      // The map of each source only changes with the display fit, so it is
      // compiled in and each sample skips the other maps' branches.
      const defines = this.material.defines || (this.material.defines = {});
      if (placed !== Object.prototype.hasOwnProperty.call(defines, 'VRCH_PLACED_SOURCES')) {
        if (placed) defines.VRCH_PLACED_SOURCES = '';
        else delete defines.VRCH_PLACED_SOURCES;
        this.material.needsUpdate = true;
      }
      for (let index = 0; index < 2; index += 1) {
        const key = 'VRCH_SOURCE' + index + '_MAP';
        const map = placed ? String(this.uniforms['uVrchSource' + index + 'Map'].value | 0) : undefined;
        if (defines[key] !== map) {
          if (map === undefined) delete defines[key];
          else defines[key] = map;
          this.material.needsUpdate = true;
        }
      }
    }

    _sourceCount() {
      return Math.max(0, Math.min(2, Number(this.definition && this.definition.runtime && this.definition.runtime.max_sources) || 0));
    }

    _setSourceInput(index, source, slotState) {
      if (index < 0 || index >= this._sourceCount()) return false;
      const next = source || null;
      const oldInput = this.sourceInputs[index];
      const oldTexture = this.sourceTextures[index];
      if (next !== oldInput) {
        this.sourceInputs[index] = next;
        if (canReuseSourceTexture(oldTexture, next)) {
          oldTexture.image = next;
          oldTexture.flipY = true;
          oldTexture.needsUpdate = true;
        } else if (next) {
          if (oldTexture && oldTexture.dispose) oldTexture.dispose();
          this.sourceTextures[index] = makeTexture(next);
        } else {
          if (oldTexture && oldTexture.dispose) oldTexture.dispose();
          this.sourceTextures[index] = this._placeholderTexture(index);
        }
      } else if (next && oldTexture && !oldTexture.isVideoTexture) {
        // Canvas-backed sources retain their DOM identity while their pixels
        // change. Mark only the declared logical source for upload.
        oldTexture.needsUpdate = true;
      }
      if (slotState) {
        this.sourceSlots[index] = Object.assign(defaultSlot(index === 0 ? 'A' : 'B'), clone(slotState));
      } else {
        const slot = this.sourceSlots[index];
        slot.actual.connection = next ? 'connected' : 'disconnected';
        slot.actual.valid = !!next;
        slot.actual.stale = false;
        if (next && next !== oldInput) slot.actual.frame_id += 1;
        slot.actual.age_ms = 0;
      }
      return next !== oldInput || !!slotState;
    }

    setSource(index, source, slotState) {
      const changed = this._setSourceInput(index, source, slotState);
      if (changed || source) this._applySourceUniforms();
      return changed;
    }

    setSources(sources, slotStates) {
      const inputs = Array.isArray(sources) ? sources : [];
      const states = Array.isArray(slotStates) ? slotStates : [];
      const count = this._sourceCount();
      let changed = false;
      for (let index = 0; index < count; index += 1) {
        changed = this._setSourceInput(index, inputs[index] || null, states[index] || null) || changed;
      }
      if (changed || count > 0) this._applySourceUniforms();
      return changed;
    }

    setData(previousSource, currentSource) {
      // Compatibility adapter for legacy transition callers. SceneRuntime's
      // physical A/B path uses setSource(s) so an absent second source is not
      // silently duplicated and uploaded.
      return this.setSources([
        currentSource || previousSource || null,
        previousSource || currentSource || null
      ]);
    }

    setSourceSlotState(slotName, state) {
      const index = slotName === 'B' ? 1 : 0;
      this.sourceSlots[index] = Object.assign(defaultSlot(index === 0 ? 'A' : 'B'), clone(state || {}));
      this._applySourceUniforms();
    }

    setSignalTexture(signalId, source) {
      const textureSignals = (this.definition.signals || []).filter((signal) => signal.type === 'texture');
      const index = textureSignals.findIndex((signal) => signal.id === signalId);
      if (index < 0 || index > 1) return false;
      if (source === this.signalTextureInputs[index]) {
        const texture = this.signalTextures[index];
        if (texture) texture.needsUpdate = true;
        this.uniforms['uVrchSignalTexture' + index + 'Valid'].value = !!source;
        return true;
      }
      this.signalTextureInputs[index] = source || null;
      const old = this.signalTextures[index];
      if (old && old.dispose) old.dispose();
      const texture = makeSignalTexture(source) || new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      texture.needsUpdate = true;
      this.signalTextures[index] = texture;
      this.uniforms['uVrchSignalTexture' + index].value = texture;
      this.uniforms['uVrchSignalTexture' + index + 'Valid'].value = !!source;
      return true;
    }

    setDisplayMode(value, tileAnchor) {
      const next = normalizeViewerDisplayMode(value);
      const nextAnchor = normalizeViewerTileAnchor(tileAnchor, next);
      if (next === this.displayMode && nextAnchor === this.tileAnchor) return false;
      this.displayMode = next;
      this.tileAnchor = nextAnchor;
      this.uniforms.uVrchTileAnchor.value = nextAnchor;
      this._applySourceUniforms();
      return true;
    }

    setInstance(instance) {
      this.instance = Contract.normalizeInstance(this.definition, instance, { trusted: this.trusted });
      this._applyInstanceUniforms(this.instance.params);
    }

    updateParams(params) {
      if (params && params.sceneInstance) this.setInstance(params.sceneInstance);
    }

    setResolutionOverride(width, height) {
      this.resolutionOverride = width && height ? { width: width, height: height } : null;
    }

    resetEpoch() {
      this.epochSeconds = null;
      this.lastTimeSeconds = null;
      this.frame = 0;
      this.parameterPhaseClock.reset();
      this.signalBus.reset();
      if (this.musicEvents) this.musicEvents.reset();
      if (this.spectrumHistory) this.spectrumHistory.reset();
    }

    prepareFrame(timeSeconds, audioData) {
      const now = Number.isFinite(timeSeconds) ? timeSeconds : 0;
      if (this.epochSeconds == null) this.epochSeconds = now;
      const sceneTime = Math.max(0, now - this.epochSeconds);
      const rawDelta = this.lastTimeSeconds == null ? 0 : Math.max(0, now - this.lastTimeSeconds);
      const delta = Math.min(0.1, rawDelta);
      this.lastTimeSeconds = now;
      const size = new THREE.Vector2(1, 1);
      if (this.resolutionOverride) size.set(this.resolutionOverride.width, this.resolutionOverride.height);
      else if (this.renderer && this.renderer.getDrawingBufferSize) this.renderer.getDrawingBufferSize(size);
      this.uniforms.iResolution.value.set(Math.max(1, size.x), Math.max(1, size.y), 1);
      const canvas = this.renderer && this.renderer.domElement;
      const viewportWidth = this.resolutionOverride
        ? this.resolutionOverride.width
        : Number(canvas && canvas.clientWidth) || Math.max(1, size.x / Math.max(1, Number(this.renderer && this.renderer.getPixelRatio && this.renderer.getPixelRatio()) || 1));
      const viewportHeight = this.resolutionOverride
        ? this.resolutionOverride.height
        : Number(canvas && canvas.clientHeight) || Math.max(1, size.y / Math.max(1, Number(this.renderer && this.renderer.getPixelRatio && this.renderer.getPixelRatio()) || 1));
      this.uniforms.uVrchViewportResolution.value.set(Math.max(1, viewportWidth), Math.max(1, viewportHeight));
      this._applySourcePlacement();
      this.uniforms.iTime.value = sceneTime;
      this.uniforms.iTimeDelta.value = delta;
      this.uniforms.iFrame.value = this.frame;
      const signalMap = this.signalBus.update(audioData, now * 1000);
      const signals = this.signalBus.readForDefinition(this.definition, this.instance);
      const signalUniform = this.uniforms.uVrchSignals.value;
      signalUniform.fill(0);
      signals.slice(0, 16).forEach((value, index) => { signalUniform[index] = value; });
      const effectiveParams = this.signalBus.applyBindings(this.definition, this.instance, delta * 1000);
      this._applyInstanceUniforms(effectiveParams);
      const phases = this.parameterPhaseClock.update(effectiveParams, delta);
      Object.keys(phases).forEach((key) => { this.uniforms['uVrchPhase_' + key].value = phases[key]; });
      this._renderFrameStage();
      this._renderCoarseStage();
      this.frame += 1;
      if (rawDelta > 0 && this.onFrameSample) this.onFrameSample(rawDelta * 1000);
      const result = { time: sceneTime, delta: delta, frame: this.frame - 1, signals: signalMap, params: effectiveParams };
      if (this.musicEvents) this.musicEvents.update(now, audioData, result);
      if (this.spectrumHistory) this.spectrumHistory.update(now, audioData, result);
      return result;
    }

    // The frame stage renders before the main pass with this frame's uniforms.
    _renderFrameStage() {
      if (!this.frameTarget || !this.renderer || !this.renderer.setRenderTarget) return;
      const previous = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.frameTarget);
      this.renderer.render(this.frameScene, this.frameCamera);
      this.renderer.setRenderTarget(previous);
    }

    // The coarse stage covers the main pass (iResolution) in divisor x divisor blocks.
    _renderCoarseStage() {
      if (!this.coarseTarget || !this.renderer || !this.renderer.setRenderTarget) return;
      const divisor = this.definition.coarse.divisor;
      const resolution = this.uniforms.iResolution.value;
      const width = Math.max(1, Math.ceil(resolution.x / divisor));
      const height = Math.max(1, Math.ceil(resolution.y / divisor));
      if (this.coarseTarget.width !== width || this.coarseTarget.height !== height) this.coarseTarget.setSize(width, height);
      const previous = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.coarseTarget);
      this.renderer.render(this.coarseScene, this.coarseCamera);
      this.renderer.setRenderTarget(previous);
    }

    render(timeSeconds, interactionState, audioData) {
      if (this.disposed || !this.visible) return;
      this.prepareFrame(timeSeconds, audioData);
    }

    attachTo(scene, camera) {
      if (this.scene && this.mesh) this.scene.remove(this.mesh);
      this.scene = scene;
      this.camera = camera;
      if (this.scene && this.mesh) this.scene.add(this.mesh);
    }

    setVisible(value) {
      this.visible = !!value;
      if (this.mesh) this.mesh.visible = this.visible;
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.musicEvents = null;
      this.spectrumHistory = null;
      if (this.scene && this.mesh) this.scene.remove(this.mesh);
      if (this.geometry) this.geometry.dispose();
      if (this.material) this.material.dispose();
      if (this.frameMaterial) this.frameMaterial.dispose();
      if (this.frameTarget) this.frameTarget.dispose();
      this.frameMaterial = null;
      this.frameTarget = null;
      this.frameScene = null;
      if (this.coarseMaterial) this.coarseMaterial.dispose();
      if (this.coarseTarget) this.coarseTarget.dispose();
      this.coarseMaterial = null;
      this.coarseTarget = null;
      this.coarseScene = null;
      this.sourceTextures.forEach((texture) => { if (texture && texture.dispose) texture.dispose(); });
      this.signalTextures.forEach((texture) => { if (texture && texture.dispose) texture.dispose(); });
      this.sourceTextures = [];
      this.sourceInputs = [];
      this.signalTextures = [];
      this.signalTextureInputs = [];
      this.mesh = null;
    }
  }

  class SceneVisualSlot {
    constructor(options) {
      this.transitionManager = options.transitionManager;
      this.swapEffect = options.swapEffect;
      this.restoreEffect = options.restoreEffect;
      this.baseEffect = this.transitionManager.effect || null;
      this.visualEffect = null;
      this.visible = 'base';
      this.pending = null;
    }

    get isVisualActive() {
      return this.visible === 'visual';
    }

    _setEffectVisible(effect, visible) {
      if (!effect) return;
      if (typeof this.transitionManager._setEffectVisible === 'function') {
        this.transitionManager._setEffectVisible(effect, visible);
        return;
      }
      ['mesh', 'particleSystem', 'object3d'].forEach((key) => {
        if (effect[key] && typeof effect[key] === 'object') effect[key].visible = !!visible;
      });
      if (typeof effect.setVisible === 'function') effect.setVisible(!!visible);
    }

    enforceExclusiveVisibility() {
      const showVisual = this.visible === 'visual';
      this._setEffectVisible(this.baseEffect, !showVisual);
      this._setEffectVisible(this.visualEffect, showVisual);
      return { base: !showVisual, visual: showVisual };
    }

    setBaseEffect(effect) {
      if (!effect) return;
      const previous = this.baseEffect;
      this.baseEffect = effect;
      if (this.isVisualActive && previous && previous !== effect && previous !== this.transitionManager.effect && typeof previous.dispose === 'function') {
        previous.dispose();
      }
      this.enforceExclusiveVisibility();
    }

    syncEffectSources(effect) {
      if (!effect || typeof effect.setData !== 'function') return;
      if (effect.isVrchSceneEffect) return;
      const previousSource = this.transitionManager.cachedImgA || this.transitionManager.cachedImgB || null;
      const currentSource = this.transitionManager.cachedImgB || this.transitionManager.cachedImgA || null;
      if (previousSource || currentSource) effect.setData(previousSource, currentSource);
    }

    keepVisual(effect) {
      this.visualEffect = effect || null;
      if (effect && typeof effect.setVisible === 'function') effect.setVisible(false);
      this.visible = 'base';
      this.enforceExclusiveVisibility();
    }

    async stageVisual(effect) {
      if (!effect) throw runtimeError('runtime_unavailable', 'visual-slot', 'A visual effect is required.');
      if (this.pending) throw runtimeError('transaction_busy', 'visual-slot', 'A visual swap is already pending.');
      this.syncEffectSources(effect);
      const previous = { visible: this.visible, visualEffect: this.visualEffect, baseEffect: this.baseEffect };
      await this.swapEffect(effect, { retainPrevious: true });
      this.pending = { target: 'visual', effect: effect, previous: previous };
    }

    stageVisibleVisual(effect) {
      if (this.pending) throw runtimeError('transaction_busy', 'visual-slot', 'A visual swap is already pending.');
      if (this.transitionManager.effect !== effect) throw runtimeError('runtime_conflict', 'visual-slot', 'The prepared visual is not visible.');
      this.pending = {
        target: 'visual',
        effect: effect,
        previous: { visible: this.visible, visualEffect: this.visualEffect, baseEffect: this.baseEffect }
      };
    }

    async stageBase(createBaseEffect) {
      if (this.pending) throw runtimeError('transaction_busy', 'visual-slot', 'A visual swap is already pending.');
      if (!this.isVisualActive) return false;
      let effect = this.baseEffect;
      if ((!effect || effect.disposed) && typeof createBaseEffect === 'function') effect = await createBaseEffect();
      if (!effect) throw runtimeError('runtime_unavailable', 'visual-slot', 'The Viewer base effect is unavailable.');
      this.syncEffectSources(effect);
      const previous = { visible: this.visible, visualEffect: this.visualEffect, baseEffect: this.baseEffect };
      await this.swapEffect(effect, { retainPrevious: true });
      this.pending = { target: 'base', effect: effect, previous: previous };
      return true;
    }

    commit() {
      const pending = this.pending;
      if (!pending) return false;
      const retained = this.transitionManager.takeRetainedEffect();
      if (pending.target === 'visual') {
        if (pending.previous.visible === 'base') {
          this.baseEffect = retained || pending.previous.baseEffect;
          const hiddenVisual = pending.previous.visualEffect;
          if (hiddenVisual && hiddenVisual !== pending.effect && hiddenVisual !== this.baseEffect && typeof hiddenVisual.dispose === 'function') hiddenVisual.dispose();
        } else if (retained && retained !== pending.effect && retained !== this.baseEffect && typeof retained.dispose === 'function') {
          retained.dispose();
        }
        this.visualEffect = pending.effect;
        this.visible = 'visual';
      } else {
        this.baseEffect = pending.effect;
        this.visualEffect = retained || pending.previous.visualEffect;
        this.visible = 'base';
      }
      this.pending = null;
      this.enforceExclusiveVisibility();
      return true;
    }

    async rollback() {
      if (!this.pending) return false;
      try { await this.restoreEffect(); }
      finally {
        this.pending = null;
        this.enforceExclusiveVisibility();
      }
      return true;
    }

    dispose() {
      const effects = new Set([this.visualEffect]);
      if (this.pending) effects.add(this.pending.effect);
      effects.forEach((effect) => {
        if (effect && effect !== this.transitionManager.effect && effect !== this.baseEffect && typeof effect.dispose === 'function') effect.dispose();
      });
      this.pending = null;
      this.visualEffect = null;
      this.baseEffect = null;
    }
  }

  class SceneRuntime {
    constructor(options = {}) {
      if (!THREE || !Contract || !SignalBusCtor) throw runtimeError('runtime_unavailable', 'runtime', 'Scene Runtime dependencies are unavailable.');
      if (!options.transitionManager || !options.transitionManager.renderer) throw runtimeError('runtime_unavailable', 'runtime', 'TransitionManager is required.');
      this.transitionManager = options.transitionManager;
      this.renderer = options.transitionManager.renderer;
      this.targetViewerId = options.targetViewerId || 'main';
      this.displayMode = normalizeViewerDisplayMode(options.displayMode);
      this.tileAnchor = normalizeViewerTileAnchor(options.tileAnchor, this.displayMode);
      this.runtimeOwner = 'legacy';
      this.deviceProfile = options.deviceProfile || 'auto';
      this.store = options.store || null;
      this.onRuntimeOwnerChange = typeof options.onRuntimeOwnerChange === 'function' ? options.onRuntimeOwnerChange : null;
      this.persistence = { mode: this.store ? 'opening' : 'none', supported: false, granted: false, restored: false, last_error: null };
      this.definitionCache = new Map();
      this.trustedHashes = new Set();
      this.active = null;
      this.draft = null;
      this.activationArm = null;
      this.history = [];
      this.telemetry = [];
      this.signalBus = new SignalBusCtor();
      this.sourceSlots = [defaultSlot('A'), defaultSlot('B')];
      this.physicalSources = { A: null, B: null };
      this.sourceBindingState = SourceBinding ? SourceBinding.createState(options.sourceBindingState) : { source_bindings: { 0: 'A', 1: 'B' }, source_a_channel: '1', source_b_channel: '2', revision: 0 };
      this.signalTextureSources = new Map();
      this.previewTimer = null;
      this.leaseTimer = null;
      this.pendingHandoff = null;
      this.contextLost = false;
      this.config = Object.assign({
        leaseTtlMs: Contract.CONFIG.leaseTtlMs,
        mainPreviewTtlMs: Contract.CONFIG.mainPreviewTtlMs,
        swapTimeoutMs: Contract.CONFIG.protocolTimeouts['scene.commit'],
        historyLimit: Contract.CONFIG.historyLimit,
        telemetryLimit: 512,
        stagingSize: Contract.CONFIG.stagingSizePx,
        stagingBudgetMs: Contract.CONFIG.stagingBudgetMs,
        performanceWindowFrames: Contract.CONFIG.performanceWindowFrames,
        performanceOverrunWindows: Contract.CONFIG.performanceOverrunWindows,
        performanceRecoveryWindows: Contract.CONFIG.performanceRecoveryWindows,
        performanceScales: Contract.CONFIG.performanceScaleLadder.slice()
      }, options.config || {});
      const capabilities = this.renderer.capabilities || {};
      this.webgl2 = capabilities.isWebGL2 === true;
      if (!this.webgl2) throw runtimeError('capability_missing', 'runtime', 'Scene Runtime requires WebGL2.');
      this.basePixelRatio = this.renderer.getPixelRatio ? this.renderer.getPixelRatio() : (root.devicePixelRatio || 1);
      this.performanceState = {
        profile: this._resolveDeviceProfile(),
        quality_variant: 'standard',
        profile_scale: 1,
        render_scale: 1,
        target_frame_ms: 16.7,
        status: 'warming',
        sample_count: 0,
        frame_time_p50_ms: null,
        frame_time_p95_ms: null,
        frame_time_mean_ms: null,
        overrun_windows: 0,
        healthy_windows: 0,
        degraded_reason: null,
        frame_pacing: 'every_refresh'
      };
      this.frameSamples = [];
      // Shared with every effect this runtime creates; the Viewer render loop
      // reports each refresh and skips refreshes until minIntervalMs has passed.
      this.framePacing = createFramePacing(Contract.CONFIG.edgeFramePacing);
      this.paceProbe = { frames: 0, quick: 0, late: 0 };
      // A preview budget (Console Viewer while an audience Viewer runs on the
      // same machine) caps render scale and frame rate; null renders normally.
      this.renderBudget = null;
      this.visualSlot = new SceneVisualSlot({
        transitionManager: this.transitionManager,
        swapEffect: (effect, swapOptions) => this._swapEffect(effect, swapOptions),
        restoreEffect: () => this._restoreRetainedEffect()
      });
      this._bindContextEvents();
    }

    _setRuntimeOwner(owner, reason) {
      const next = owner === 'scene' ? 'scene' : 'legacy';
      const previous = this.runtimeOwner;
      this.runtimeOwner = next;
      if (this.onRuntimeOwnerChange && (previous !== next || reason === 'restore')) {
        this.onRuntimeOwnerChange(next, { previous: previous, reason: reason || 'runtime' });
      }
      return next;
    }

    _resolveDeviceProfile() {
      if (['edge', 'standard', 'high'].includes(this.deviceProfile)) return this.deviceProfile;
      const gl = this.renderer.getContext();
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      if (/v3d|raspberry|swiftshader|llvmpipe|software rasterizer/i.test(renderer)) return 'edge';
      if (/rtx|radeon rx|apple m[2-9]|arc a[5-9]/i.test(renderer)) return 'high';
      return 'standard';
    }

    _preferredScale(definition) {
      const profile = this.performanceState.profile;
      const profiles = definition && definition.quality && definition.quality.profiles;
      const configured = profiles && profiles[profile] && Number(profiles[profile].preferred_scale);
      let scale = Number.isFinite(configured) ? configured : (profile === 'edge' ? 0.5 : profile === 'standard' ? 0.85 : 1);
      // Edge scales are measured on the Console Viewer; a canvas above the
      // 960 x 540 budget (1080p at half size) renders the same pixel count.
      const reference = Number(Contract.CONFIG.edgeReferencePixels);
      const canvas = this.renderer && this.renderer.domElement;
      const pixels = (Number(canvas && canvas.clientWidth) || 0) * (Number(canvas && canvas.clientHeight) || 0) * this.basePixelRatio * this.basePixelRatio;
      if (profile === 'edge' && reference > 0 && pixels > reference) scale *= Math.sqrt(reference / pixels);
      return Math.max(0.5, Math.min(1, scale));
    }

    _targetFrameMs() {
      // Edge displays report below their minimum frame rate (24 fps); others keep 60 fps.
      return this.performanceState.profile === 'edge' ? 1000 / Contract.CONFIG.edgeMinimumFps : 16.7;
    }

    _applyRenderScale(scale) {
      const next = Math.max(0.5, Math.min(1, Number(scale) || 1));
      this.performanceState.render_scale = next;
      if (!this.renderer.setPixelRatio || !this.renderer.setSize) return;
      const canvas = this.renderer.domElement;
      const width = Math.max(1, Number(canvas && canvas.clientWidth) || root.innerWidth || 1);
      const height = Math.max(1, Number(canvas && canvas.clientHeight) || root.innerHeight || 1);
      this.renderer.setPixelRatio(this.basePixelRatio * next);
      this.renderer.setSize(width, height, false);
    }

    _activatePerformanceProfile(definition) {
      const profile = this.performanceState.profile;
      const preferredScale = this._preferredScale(definition);
      this.frameSamples = [];
      this.performanceState = Object.assign({}, this.performanceState, {
        quality_variant: profile,
        profile_scale: preferredScale,
        target_frame_ms: this._targetFrameMs(),
        status: 'warming',
        sample_count: 0,
        frame_time_p50_ms: null,
        frame_time_p95_ms: null,
        frame_time_mean_ms: null,
        overrun_windows: 0,
        healthy_windows: 0,
        degraded_reason: null,
        frame_pacing: 'every_refresh'
      });
      this.framePacing.minIntervalMs = 0;
      this.framePacing.divisor = 0;
      this.framePacing.appliedRefreshMs = null;
      this.paceProbe = { frames: 0, quick: 0, late: 0 };
      this._applyRenderScale(preferredScale);
      if (this.renderBudget) this._applyRenderBudget();
    }

    _observeFrame(frameTimeMs) {
      if (this.runtimeOwner !== 'scene' || !Number.isFinite(frameTimeMs) || frameTimeMs <= 0) return;
      if (this.performanceState.profile === 'edge') this._observePacing(frameTimeMs);
      const windowSize = Math.max(30, Number(this.config.performanceWindowFrames) || Contract.CONFIG.performanceWindowFrames);
      this.frameSamples.push(frameTimeMs);
      if (this.frameSamples.length > windowSize) this.frameSamples.shift();
      this.performanceState.sample_count += 1;
      if (this.frameSamples.length < windowSize || this.performanceState.sample_count % windowSize !== 0) return;
      const p50 = percentile(this.frameSamples, 0.5);
      const p95 = percentile(this.frameSamples, 0.95);
      const mean = this.frameSamples.reduce((sum, value) => sum + value, 0) / this.frameSamples.length;
      this.performanceState.frame_time_p50_ms = Number(p50.toFixed(3));
      this.performanceState.frame_time_p95_ms = Number(p95.toFixed(3));
      this.performanceState.frame_time_mean_ms = Number(mean.toFixed(3));
      // Edge displays keep their render scale: frame rate comes from the visual
      // itself. Below the minimum average rate the state reports over budget.
      if (this.renderBudget) {
        this.performanceState.status = 'preview';
        this.performanceState.degraded_reason = null;
        return;
      }
      if (this.performanceState.profile === 'edge') {
        const over = mean > this.performanceState.target_frame_ms;
        if (over && this.performanceState.status !== 'over_budget') {
          this._record('performance_over_budget', { render_scale: this.performanceState.render_scale, frame_time_mean_ms: this.performanceState.frame_time_mean_ms });
        }
        this.performanceState.status = over ? 'over_budget' : 'healthy';
        this.performanceState.degraded_reason = over ? 'minimum_fps' : null;
        return;
      }
      // Other profiles allow 10% refresh jitter on p95.
      if (p95 > this.performanceState.target_frame_ms * 1.1) {
        this.performanceState.overrun_windows += 1;
        this.performanceState.healthy_windows = 0;
        if (this.performanceState.overrun_windows >= this.config.performanceOverrunWindows) {
          const scales = this.config.performanceScales.slice().sort((a, b) => b - a);
          const next = scales.find((scale) => scale < this.performanceState.render_scale - 0.001);
          if (next != null) {
            this._applyRenderScale(next);
            this.performanceState.status = 'degraded';
            this.performanceState.degraded_reason = 'frame_time_p95';
            this.performanceState.overrun_windows = 0;
            this._record('performance_degraded', { render_scale: next, frame_time_p95_ms: this.performanceState.frame_time_p95_ms });
          } else {
            this.performanceState.status = 'over_budget';
            this.performanceState.degraded_reason = 'minimum_scale_exceeded';
            this._record('performance_over_budget', { render_scale: this.performanceState.render_scale, frame_time_p95_ms: this.performanceState.frame_time_p95_ms });
          }
        }
      } else {
        this.performanceState.healthy_windows += 1;
        this.performanceState.overrun_windows = 0;
        this.performanceState.status = this.performanceState.render_scale < this.performanceState.profile_scale ? 'degraded' : 'healthy';
        if (this.performanceState.healthy_windows >= this.config.performanceRecoveryWindows) {
          const scales = this.config.performanceScales.slice().sort((a, b) => a - b);
          const next = scales.find((scale) => scale > this.performanceState.render_scale + 0.001 && scale <= this.performanceState.profile_scale + 0.001);
          if (next != null) {
            this._applyRenderScale(next);
            this.performanceState.status = next < this.performanceState.profile_scale ? 'degraded' : 'healthy';
            this.performanceState.degraded_reason = next < this.performanceState.profile_scale ? 'frame_time_p95' : null;
            this._record('performance_recovered', { render_scale: next, frame_time_p95_ms: this.performanceState.frame_time_p95_ms });
          }
          this.performanceState.healthy_windows = 0;
        }
      }
    }

    setRenderBudget(budget) {
      const next = budget && typeof budget === 'object'
        ? { maxScale: Math.max(0.5, Math.min(1, Number(budget.maxScale) || 1)), maxFps: Math.max(0, Number(budget.maxFps) || 0) }
        : null;
      const previous = this.renderBudget;
      if ((!previous && !next) || (previous && next && previous.maxScale === next.maxScale && previous.maxFps === next.maxFps)) return false;
      this.renderBudget = next;
      if (next) {
        this._applyRenderBudget();
      } else {
        this._applyRenderScale(this.performanceState.profile_scale || 1);
        this.framePacing.minIntervalMs = 0;
        this.framePacing.divisor = 0;
        this.framePacing.appliedRefreshMs = null;
        this.paceProbe = { frames: 0, quick: 0, late: 0 };
        this.performanceState.frame_pacing = 'every_refresh';
        this.performanceState.status = 'warming';
      }
      this.frameSamples = [];
      this._record('render_budget_changed', { preview: !!next });
      return true;
    }

    _applyRenderBudget() {
      const budget = this.renderBudget;
      const pacing = Contract.CONFIG.edgeFramePacing || { slack_ms: 6, slack_refresh_share: 0.4 };
      const refresh = refreshMsOf(this.framePacing, pacing);
      this._applyRenderScale(Math.min(this.performanceState.profile_scale || 1, budget.maxScale));
      // The preview renders on the multiple of the refresh interval closest to its maximum rate.
      const divisor = budget.maxFps > 0 ? Math.max(1, Math.round(1000 / budget.maxFps / refresh)) : 0;
      this.framePacing.divisor = 0;
      this.framePacing.appliedRefreshMs = refresh;
      this.framePacing.minIntervalMs = divisor > 0 ? divisor * refresh - Math.min(pacing.slack_ms, refresh * (pacing.slack_refresh_share || 0.4)) : 0;
      this.performanceState.frame_pacing = divisor > 0 ? 'preview_' + Math.round(1000 / (divisor * refresh)) : 'every_refresh';
      this.performanceState.refresh_hz = Number((1000 / refresh).toFixed(2));
      this.performanceState.status = 'preview';
    }

    // Edge displays: a Visual that cannot render on every refresh renders on
    // every k-th refresh of the measured display rate, instead of bursts of
    // quick frames and long stalls; k grows while frames keep missing that slot.
    _observePacing(frameTimeMs) {
      const pacing = Contract.CONFIG.edgeFramePacing;
      const framePacing = this.framePacing;
      if (!pacing || !framePacing) return;
      const refresh = refreshMsOf(framePacing, pacing);
      // A new refresh estimate re-times the current cadence without changing its step.
      if (framePacing.appliedRefreshMs != null && Math.abs(framePacing.appliedRefreshMs - refresh) > 0.01) {
        if (this.renderBudget) this._applyRenderBudget();
        else if (framePacing.divisor > 0) this._setPacingDivisor(framePacing.divisor);
      }
      if (this.renderBudget) return;
      const probe = this.paceProbe;
      probe.frames += 1;
      const maxDivisor = Math.floor(pacing.max_interval_ms / refresh);
      if (framePacing.divisor > 0) {
        if (frameTimeMs > framePacing.divisor * refresh * pacing.late_ratio) probe.late = (probe.late || 0) + 1;
        if (probe.frames < pacing.probe_frames) return;
        const lateShare = (probe.late || 0) / probe.frames;
        probe.frames = 0;
        probe.quick = 0;
        probe.late = 0;
        if (lateShare > pacing.late_share && framePacing.divisor < maxDivisor) this._setPacingDivisor(framePacing.divisor + 1);
        return;
      }
      if (frameTimeMs <= refresh * pacing.on_time_refresh_ratio) probe.quick += 1;
      if (probe.frames < pacing.probe_frames) return;
      const keepsUp = probe.quick / probe.frames >= pacing.on_time_share;
      probe.frames = 0;
      probe.quick = 0;
      probe.late = 0;
      if (keepsUp || maxDivisor < pacing.initial_divisor) return;
      this._setPacingDivisor(pacing.initial_divisor);
    }

    _setPacingDivisor(divisor) {
      const pacing = Contract.CONFIG.edgeFramePacing;
      const framePacing = this.framePacing;
      const refresh = refreshMsOf(framePacing, pacing);
      const changed = framePacing.divisor !== divisor;
      framePacing.divisor = divisor;
      framePacing.appliedRefreshMs = refresh;
      framePacing.minIntervalMs = divisor * refresh - Math.min(pacing.slack_ms, refresh * pacing.slack_refresh_share);
      const fps = Math.round(1000 / (divisor * refresh));
      this.performanceState.frame_pacing = 'locked_' + fps;
      this.performanceState.refresh_hz = Number((1000 / refresh).toFixed(2));
      if (changed) this._record('frame_pacing_locked', { fps: fps, refresh_hz: this.performanceState.refresh_hz });
    }

    getPerformanceState() {
      return clone(this.performanceState);
    }

    _bindContextEvents() {
      const canvas = this.renderer.domElement;
      if (!canvas || !canvas.addEventListener) return;
      canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        this.contextLost = true;
        this._record('context_lost', {});
      });
      canvas.addEventListener('webglcontextrestored', () => {
        this.contextLost = false;
        this._record('context_restored', {});
        this._recoverContext().catch((error) => {
          this._record('context_restore_failed', { code: error.code || 'compile_failed', message: error.message || String(error) });
        });
      });
    }

    async _recoverContext() {
      if (this.runtimeOwner !== 'scene' || !this.active) return;
      const trusted = this.trustedHashes.has(this.active.revision.scene_ref.content_hash);
      const replacement = this._makeEffect(this.active.definition, this.active.instance, trusted);
      this._compileStaging(replacement);
      replacement.resetEpoch();
      await this._swapEffect(replacement);
      if (this.active.effect && this.active.effect !== replacement) this.active.effect.dispose();
      this.active.effect = replacement;
      this._record('context_recovered', { revision_id: this.active.revision.revision_id });
    }

    _record(type, data) {
      this.telemetry.push({ at: new Date().toISOString(), type: type, data: clone(data || {}) });
      if (this.telemetry.length > this.config.telemetryLimit) this.telemetry.splice(0, this.telemetry.length - this.config.telemetryLimit);
    }

    async initializePersistence() {
      if (!this.store) return clone(this.persistence);
      try {
        await this.store.open();
        const persistence = await this.store.requestPersistence();
        this.persistence = Object.assign({}, this.persistence, persistence, { restored: false, last_error: null });
        const saved = await this.store.loadRuntimeState();
        this.history = clone(saved.history || []).slice(0, this.config.historyLimit);
        if (!saved.active) {
          if (saved.recovered_interrupted_commit) this._record('storage_interrupted_commit_recovered', {});
          return clone(this.persistence);
        }
        const restored = saved.active;
        const hash = restored.revision.scene_ref.content_hash;
        const trusted = this.trustedHashes.has(hash);
        this._assertTrusted(restored.definition, hash);
        Contract.validateDefinition(restored.definition, { trusted: trusted });
        restored.instance = Contract.normalizeInstance(restored.definition, restored.instance, { trusted: trusted });
        const effect = this._makeEffect(restored.definition, restored.instance, trusted);
        try {
          this._compileStaging(effect);
          effect.resetEpoch();
        } catch (error) {
          if (!effect.disposed) effect.dispose();
          throw error;
        }
        this.definitionCache.set(hash, clone(restored.definition));
        this.active = { definition: clone(restored.definition), instance: clone(restored.instance), effect: effect, revision: clone(restored.revision) };
        this._setRuntimeOwner(restored.runtime_owner === 'legacy' ? 'legacy' : 'scene', 'restore');
        if (this.runtimeOwner === 'scene') {
          await this.visualSlot.stageVisual(effect);
          this.visualSlot.commit();
          this._activatePerformanceProfile(this.active.definition);
        } else {
          this.visualSlot.keepVisual(effect);
          this._applyRenderScale(1);
        }
        this.persistence.restored = true;
        this._record('storage_restored', { revision_id: restored.revision.revision_id, scene_ref: restored.revision.scene_ref });
      } catch (error) {
        this.persistence.mode = this.store.mode || this.persistence.mode;
        this.persistence.last_error = { code: error.code || 'persistence_failed', stage: error.stage || 'persistence', message: error.message || String(error) };
        this._record('storage_restore_failed', this.persistence.last_error);
      }
      return clone(this.persistence);
    }

    async registerCatalog(catalog, definitions) {
      const definitionById = new Map((definitions || []).map((definition) => [definition.scene_id, definition]));
      for (const entry of (catalog && catalog.entries) || []) {
        const definition = definitionById.get(entry.scene_ref.scene_id);
        if (!definition) continue;
        const hash = await Contract.sha256Ref(definition);
        if (hash !== entry.scene_ref.content_hash) throw runtimeError('schema_invalid', 'catalog', 'Catalog hash mismatch for ' + definition.scene_id + '.');
        Contract.validateDefinition(definition, { trusted: entry.trusted === true });
        this.definitionCache.set(hash, clone(definition));
        if (entry.trusted === true) this.trustedHashes.add(hash);
      }
      return { definitions: this.definitionCache.size, trusted: this.trustedHashes.size };
    }

    _sceneEffects() {
      const effects = new Set();
      if (this.active && this.active.effect) effects.add(this.active.effect);
      if (this.draft && this.draft.effect) effects.add(this.draft.effect);
      if (this.visualSlot && this.visualSlot.visualEffect) effects.add(this.visualSlot.visualEffect);
      return Array.from(effects).filter((effect) => effect && effect.isVrchSceneEffect);
    }

    _liveSceneEffects() {
      const effect = this.transitionManager && this.transitionManager.effect;
      return effect && effect.isVrchSceneEffect ? [effect] : [];
    }

    _resolvedSources() {
      if (SourceBinding) return SourceBinding.resolve(this.sourceBindingState, this.physicalSources);
      const bindings = this.sourceBindingState.source_bindings;
      return [this.physicalSources[bindings[0]] || null, this.physicalSources[bindings[1]] || null];
    }

    _syncEffectSources() {
      const sources = this._resolvedSources();
      const bindings = this.sourceBindingState.source_bindings;
      const states = [
        this.sourceSlots[bindings[0] === 'B' ? 1 : 0],
        this.sourceSlots[bindings[1] === 'B' ? 1 : 0]
      ];
      this._sceneEffects().forEach((effect) => {
        effect.setSources(sources, states);
      });
      if (this.visualSlot && typeof this.visualSlot.enforceExclusiveVisibility === 'function') this.visualSlot.enforceExclusiveVisibility();
      return sources;
    }

    _syncSingleEffectSources(effect) {
      if (!effect || !effect.isVrchSceneEffect) return;
      const sources = this._resolvedSources();
      const bindings = this.sourceBindingState.source_bindings;
      effect.setSources(sources, [
        this.sourceSlots[bindings[0] === 'B' ? 1 : 0],
        this.sourceSlots[bindings[1] === 'B' ? 1 : 0]
      ]);
    }

    _syncPhysicalSource(slotName) {
      const slot = slotName === 'B' ? 'B' : 'A';
      const physicalIndex = slot === 'B' ? 1 : 0;
      const bindings = this.sourceBindingState.source_bindings;
      // Source frames are a hot path. Upload only to the effect that is
      // actually rendered; hidden drafts and retained visuals are refreshed
      // once immediately before they become visible.
      this._liveSceneEffects().forEach((effect) => {
        const count = Math.max(0, Math.min(2, Number(effect.definition && effect.definition.runtime && effect.definition.runtime.max_sources) || 0));
        for (let logicalIndex = 0; logicalIndex < count; logicalIndex += 1) {
          if (bindings[logicalIndex] !== slot) continue;
          effect.setSource(logicalIndex, this.physicalSources[slot], this.sourceSlots[physicalIndex]);
        }
      });
      if (this.visualSlot && typeof this.visualSlot.enforceExclusiveVisibility === 'function') this.visualSlot.enforceExclusiveVisibility();
    }

    updateSources(previousSource, currentSource, options) {
      const previous = previousSource || currentSource || null;
      const current = currentSource || previousSource || null;
      const config = options || {};
      if (this.transitionManager) {
        if (this.runtimeOwner === 'scene') {
          this.transitionManager.cachedImgA = previous;
          this.transitionManager.cachedImgB = current;
        } else if (typeof this.transitionManager.updateImages === 'function') {
          this.transitionManager.updateImages(previous, current);
        }
      }
      if (config.updatePhysicalA !== false) this.updatePhysicalSource('A', current, { route: 'viewer-primary' });
    }

    updatePhysicalSource(slotName, source, state) {
      const slot = slotName === 'B' ? 'B' : 'A';
      const index = slot === 'B' ? 1 : 0;
      const previous = this.physicalSources[slot];
      this.physicalSources[slot] = source || null;
      const slotState = this.sourceSlots[index];
      if (state && Object.prototype.hasOwnProperty.call(state, 'route')) slotState.desired.route = state.route;
      slotState.actual.connection = source ? 'connected' : (state && state.connection) || 'disconnected';
      slotState.actual.valid = !!source && (!state || state.valid !== false);
      slotState.actual.stale = !!(state && state.stale);
      if (source && source !== previous) slotState.actual.frame_id += 1;
      slotState.actual.age_ms = Math.max(0, Number(state && state.age_ms) || 0);
      this._syncPhysicalSource(slot);
      return clone(slotState);
    }

    clearPhysicalSource(slotName, state) {
      return this.updatePhysicalSource(slotName, null, state || { connection: 'disconnected' });
    }

    setSourceBindings(patch) {
      const result = SourceBinding
        ? SourceBinding.patchState(this.sourceBindingState, patch || {})
        : { state: this.sourceBindingState, changed: false };
      this.sourceBindingState = result.state;
      if (result.changed) {
        this._syncEffectSources();
        this._record('source_binding_updated', clone(this.sourceBindingState));
      }
      return clone(this.sourceBindingState);
    }

    getSourceBindingState() {
      return clone(this.sourceBindingState);
    }

    setExternalSignals(values) {
      if (this.signalBus && typeof this.signalBus.setExternalValues === 'function') this.signalBus.setExternalValues(values || {});
    }

    setSignalTexture(signalId, source) {
      if (source) this.signalTextureSources.set(signalId, source);
      else this.signalTextureSources.delete(signalId);
      this._sceneEffects().forEach((effect) => effect.setSignalTexture(signalId, source || null));
      return !!source;
    }

    setDisplayMode(value, tileAnchor) {
      this.displayMode = normalizeViewerDisplayMode(value);
      this.tileAnchor = normalizeViewerTileAnchor(tileAnchor, this.displayMode);
      const effects = new Set();
      if (this.active && this.active.effect) effects.add(this.active.effect);
      if (this.draft && this.draft.effect) effects.add(this.draft.effect);
      if (this.visualSlot && this.visualSlot.visualEffect) effects.add(this.visualSlot.visualEffect);
      effects.forEach((effect) => {
        if (effect && typeof effect.setDisplayMode === 'function') effect.setDisplayMode(this.displayMode, tileAnchor);
      });
      return this.displayMode;
    }

    setBaseEffect(effect) {
      this.visualSlot.setBaseEffect(effect);
    }

    setSourceSlotState(slotName, state) {
      const index = slotName === 'B' ? 1 : 0;
      this.sourceSlots[index] = Object.assign(defaultSlot(index === 0 ? 'A' : 'B'), clone(state || {}));
      this._syncEffectSources();
    }

    injectTrigger(signalId, amount) {
      this.signalBus.injectTrigger(signalId, amount);
    }

    getCapabilities() {
      const gl = this.renderer.getContext();
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      return {
        runtime_owner: this.runtimeOwner,
        abi: ['vrch-mainimage@1'],
        webgl2: this.webgl2,
        renderer: renderer,
        software_renderer: /swiftshader|llvmpipe|software rasterizer/i.test(renderer),
        device_profile: this.deviceProfile,
        source_slots: clone(this.sourceSlots),
        source_binding: clone(this.sourceBindingState),
        signals: ['audio.rms', 'audio.low', 'audio.mid', 'audio.high', 'audio.centroid', 'audio.beat', 'audio.low_hit', 'external.knock'],
        signal_textures: true,
        main_preview: true,
        runtime_version: 1,
        display_mode: this.displayMode,
        tile_anchor: this.tileAnchor,
        persistence: clone(this.persistence),
        performance: this.getPerformanceState()
      };
    }

    _assertTrusted(definition, hash) {
      if (definition.provenance && definition.provenance.kind === 'builtin' && !this.trustedHashes.has(hash)) {
        throw runtimeError('policy_rejected', 'trust', 'Unrecognized content cannot self-declare the builtin trust tier.');
      }
    }

    _makeEffect(definition, instance, trusted) {
      const stagingScene = new THREE.Scene();
      const effect = new SceneEffect({
        scene: stagingScene,
        camera: this.transitionManager.camera,
        renderer: this.renderer,
        definition: definition,
        instance: instance,
        trusted: trusted,
        displayMode: this.displayMode,
        tileAnchor: this.tileAnchor,
        signalBus: this.signalBus,
        onFrameSample: (frameTimeMs) => this._observeFrame(frameTimeMs)
      });
      effect.framePacing = this.framePacing;
      const sources = this._resolvedSources();
      const bindings = this.sourceBindingState.source_bindings;
      effect.setSources(sources, [
        this.sourceSlots[bindings[0] === 'B' ? 1 : 0],
        this.sourceSlots[bindings[1] === 'B' ? 1 : 0]
      ]);
      this.signalTextureSources.forEach((source, signalId) => effect.setSignalTexture(signalId, source));
      return effect;
    }

    _compileStaging(effect) {
      if (this.contextLost) throw runtimeError('context_lost', 'compile', 'WebGL context is lost.');
      const size = this.config.stagingSize;
      const target = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, stencilBuffer: false });
      const previousTarget = this.renderer.getRenderTarget ? this.renderer.getRenderTarget() : null;
      const gl = this.renderer.getContext();
      const pixel = new Uint8Array(4);
      const started = performance.now();
      try {
        for (let index = 0; index < 16 && gl.getError() !== gl.NO_ERROR; index += 1) { /* clear prior errors */ }
        this._compileRawProgram(gl, effect.definition, effect.trusted);
        effect.setResolutionOverride(size, size);
        effect.prepareFrame(0, null);
        this.renderer.compile(effect.scene, effect.camera);
        this.renderer.setRenderTarget(target);
        this.renderer.clear(true, true, true);
        this.renderer.render(effect.scene, effect.camera);
        if (gl.finish) gl.finish();
        this.renderer.readRenderTargetPixels(target, Math.floor(size / 2), Math.floor(size / 2), 1, 1, pixel);
        const errorCode = gl.getError();
        if (errorCode !== gl.NO_ERROR) throw runtimeError('first_frame_failed', 'first_frame', 'WebGL error ' + errorCode + ' during staging.');
        return {
          compile_link_first_frame_ms: Number((performance.now() - started).toFixed(3)),
          center_pixel_rgba: Array.from(pixel),
          programs: this.renderer.info && this.renderer.info.programs ? this.renderer.info.programs.length : null
        };
      } catch (error) {
        if (error && error.code) throw error;
        throw runtimeError('compile_failed', 'compile', error && error.message ? error.message : 'Scene shader compilation failed.');
      } finally {
        effect.setResolutionOverride(null, null);
        this.renderer.setRenderTarget(previousTarget || null);
        target.dispose();
      }
    }

    _compileRawProgram(gl, definition, trusted) {
      const compile = (type, source, label) => {
        const shader = gl.createShader(type);
        if (!shader) throw runtimeError('compile_failed', 'compile', 'Could not allocate the ' + label + ' shader.');
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          const log = String(gl.getShaderInfoLog(shader) || 'Unknown shader compiler error.').slice(0, 4000);
          gl.deleteShader(shader);
          throw runtimeError('compile_failed', 'compile', label + ' shader did not compile.', [log]);
        }
        return shader;
      };
      const vertex = compile(gl.VERTEX_SHADER, Contract.buildVertexShader(), 'Vertex');
      let fragment = null;
      let program = null;
      try {
        fragment = compile(gl.FRAGMENT_SHADER, Contract.buildFragmentShader(definition, { trusted: trusted }), 'Fragment');
        program = gl.createProgram();
        if (!program) throw runtimeError('compile_failed', 'link', 'Could not allocate a shader program.');
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          const log = String(gl.getProgramInfoLog(program) || 'Unknown shader linker error.').slice(0, 4000);
          throw runtimeError('compile_failed', 'link', 'Scene shader program did not link.', [log]);
        }
      } finally {
        if (program) gl.deleteProgram(program);
        if (fragment) gl.deleteShader(fragment);
        gl.deleteShader(vertex);
      }
    }

    _scheduleLease() {
      if (this.leaseTimer) clearTimeout(this.leaseTimer);
      if (!this.draft) return;
      const delay = Math.max(1, new Date(this.draft.writer_lease.lease_expires_at).getTime() - Date.now());
      this.leaseTimer = setTimeout(() => {
        this._expireDraft('lease_expired').catch(() => {});
      }, delay);
    }

    _renewLease() {
      if (!this.draft) return;
      this.draft.writer_lease.lease_expires_at = new Date(Date.now() + this.config.leaseTtlMs).toISOString();
      this._scheduleLease();
    }

    _assertDraft(command, options = {}) {
      const draft = this.draft;
      if (!draft || (options.transactionId && draft.transaction_id !== options.transactionId)) throw runtimeError('transaction_not_found', 'transaction', 'Working transaction was not found.');
      if (!options.allowExpired && new Date(draft.writer_lease.lease_expires_at).getTime() <= Date.now()) throw runtimeError('transaction_expired', 'transaction', 'Writer lease expired.');
      if (options.state && draft.state !== options.state) throw runtimeError('transaction_state_invalid', 'transaction', command + ' is not allowed while the draft is ' + draft.state + '.');
      if (options.senderId && draft.writer_lease.holder_client_id !== options.senderId) throw runtimeError('transaction_busy', 'transaction', 'Another controller owns this draft.', [draft.writer_lease.holder_client_id]);
      if (options.leaseVersion != null && draft.writer_lease.lease_version !== options.leaseVersion) throw runtimeError('draft_conflict', 'transaction', 'Writer lease version is stale.');
      if (options.draftVersion != null && draft.draft_version !== options.draftVersion) throw runtimeError('draft_conflict', 'transaction', 'Draft version is stale.');
      return draft;
    }

    async prepare(command) {
      if (this.draft && command.replace_existing === true) await this._expireDraft('visual-control-replaced');
      if (this.draft) throw runtimeError('transaction_busy', 'prepare', 'Another draft is already pending.', [this.draft.writer_lease.holder_client_id]);
      let definition = command.definition || null;
      const requestedHash = command.scene_ref && command.scene_ref.content_hash;
      if (!definition && requestedHash) definition = this.definitionCache.get(requestedHash) || null;
      if (!definition) throw runtimeError('definition_required', 'prepare', 'The Viewer does not have this SceneDefinition.');
      const hash = await Contract.sha256Ref(definition);
      if (requestedHash && requestedHash !== hash) throw runtimeError('definition_hash_mismatch', 'prepare', 'SceneDefinition hash does not match scene_ref.');
      const trusted = this.trustedHashes.has(hash);
      this._assertTrusted(definition, hash);
      Contract.validateDefinition(definition, { trusted: trusted });
      const instance = Contract.normalizeInstance(definition, command.instance, { trusted: trusted });
      if (instance.scene_ref.scene_id !== definition.scene_id || instance.scene_ref.content_hash !== hash) throw runtimeError('definition_hash_mismatch', 'prepare', 'SceneInstance does not reference the exact definition.');
      const effect = this._makeEffect(definition, instance, trusted);
      let validation;
      try {
        validation = this._compileStaging(effect);
        if (Number.isFinite(this.config.stagingBudgetMs) && validation.compile_link_first_frame_ms > this.config.stagingBudgetMs) {
          throw runtimeError('performance_rejected', 'performance', 'Candidate exceeded the staging compile and first-frame budget.', [{
            observed_ms: validation.compile_link_first_frame_ms,
            budget_ms: this.config.stagingBudgetMs
          }]);
        }
      } catch (error) {
        effect.dispose();
        this._record('scene_rejected', { code: error.code || 'compile_failed', stage: error.stage || 'compile' });
        throw error;
      }
      const now = Date.now();
      this.definitionCache.set(hash, clone(definition));
      this.draft = {
        transaction_id: command.transaction_id,
        base_revision_id: command.base_revision_id || (this.active && this.active.revision.revision_id) || null,
        draft_version: 1,
        candidate_scene_ref: { scene_id: definition.scene_id, content_hash: hash },
        definition: clone(definition),
        instance: instance,
        owner: command.sender_type || 'shader-editor-v2',
        writer_lease: { holder_client_id: command.sender_id, lease_version: 1, lease_expires_at: new Date(now + this.config.leaseTtlMs).toISOString() },
        preview_target: 'local_mirror',
        state: 'Ready',
        effect: effect,
        validation: validation,
        preview_main: false,
        preview_expires_at: null
      };
      this._scheduleLease();
      this._record('scene_ready', { transaction_id: command.transaction_id, scene_ref: this.draft.candidate_scene_ref, validation: validation });
      return this.draftSnapshot(true);
    }

    draftSnapshot(includeInstance) {
      if (!this.draft) return null;
      const draft = {
        transaction_id: this.draft.transaction_id,
        base_revision_id: this.draft.base_revision_id,
        draft_version: this.draft.draft_version,
        candidate_scene_ref: clone(this.draft.candidate_scene_ref),
        owner: this.draft.owner,
        writer_lease: clone(this.draft.writer_lease),
        preview_target: this.draft.preview_target,
        state: this.draft.state,
        validation: clone(this.draft.validation),
        preview_main: this.draft.preview_main,
        preview_expires_at: this.draft.preview_expires_at
      };
      if (includeInstance) draft.instance = clone(this.draft.instance);
      return draft;
    }

    patchDraft(command) {
      const draft = this._assertDraft('draft.patch', {
        transactionId: command.transaction_id,
        senderId: command.sender_id,
        state: 'Ready',
        leaseVersion: command.lease_version,
        draftVersion: command.expected_draft_version
      });
      const next = clone(draft.instance);
      Object.assign(next.params, command.set_params || {});
      const remove = new Set(command.remove_binding_ids || []);
      const byId = new Map((next.bindings || []).filter((binding) => !remove.has(binding.binding_id)).map((binding) => [binding.binding_id, binding]));
      (command.upsert_bindings || []).forEach((binding) => byId.set(binding.binding_id, clone(binding)));
      next.bindings = Array.from(byId.values());
      if (command.modulation_master) next.modulation_master = clone(command.modulation_master);
      draft.instance = Contract.normalizeInstance(draft.definition, next, { trusted: this.trustedHashes.has(draft.candidate_scene_ref.content_hash) });
      draft.effect.setInstance(draft.instance);
      draft.draft_version += 1;
      this._renewLease();
      this._record('draft_updated', { transaction_id: draft.transaction_id, draft_version: draft.draft_version });
      return this.draftSnapshot(true);
    }

    async _persistRuntimeOwner(owner) {
      if (!this.store || typeof this.store.setRuntimeOwner !== 'function') return { durable: false };
      return this.store.setRuntimeOwner(owner);
    }

    async clearVisual(createBaseEffect) {
      const swapRequired = this.visualSlot.isVisualActive;
      if (swapRequired) await this.visualSlot.stageBase(createBaseEffect);
      try {
        const persistence = await this._persistRuntimeOwner('legacy');
        if (swapRequired) this.visualSlot.commit();
        if (this.active && this.visualSlot.visualEffect) this.active.effect = this.visualSlot.visualEffect;
        this._setRuntimeOwner('legacy', 'visual-cleared');
        this._applyRenderScale(1);
        this.activationArm = null;
        this._record('visual_cleared', {});
        return { status: 'cleared', owner: 'legacy', durable: persistence.durable === true };
      } catch (error) {
        if (swapRequired) await this.visualSlot.rollback();
        throw error;
      }
    }

    async showActiveVisual() {
      if (!this.active) throw runtimeError('runtime_unavailable', 'visual-slot', 'No committed visual is available.');
      if (this.draft) throw runtimeError('transaction_busy', 'visual-slot', 'Finish or cancel the working draft before restoring the visual.');
      if (this.visualSlot.isVisualActive) return { status: 'activated', owner: 'scene', expected_definition_hash: this.active.revision.scene_ref.content_hash };
      let effect = this.active.effect;
      if (!effect || effect.disposed) {
        const trusted = this.trustedHashes.has(this.active.revision.scene_ref.content_hash);
        effect = this._makeEffect(this.active.definition, this.active.instance, trusted);
        this._compileStaging(effect);
      }
      this._syncSingleEffectSources(effect);
      effect.resetEpoch();
      await this.visualSlot.stageVisual(effect);
      try {
        const persistence = await this._persistRuntimeOwner('scene');
        this.visualSlot.commit();
        this.active.effect = effect;
        this._setRuntimeOwner('scene', 'visual-restored');
        this._activatePerformanceProfile(this.active.definition);
        this._record('visual_restored', { revision_id: this.active.revision.revision_id });
        return { status: 'activated', owner: 'scene', expected_definition_hash: this.active.revision.scene_ref.content_hash, durable: persistence.durable === true };
      } catch (error) {
        await this.visualSlot.rollback();
        throw error;
      }
    }

    async activateRuntime(command, createLegacyEffect) {
      if (command.owner === 'legacy' && command.apply_on_commit !== true) {
        if (this.draft && command.replace_existing === true) await this._expireDraft('visual-control-cleared');
        const result = await this.clearVisual(createLegacyEffect);
        return Object.assign({ transaction_id: null, expected_definition_hash: null }, result);
      }
      if (command.owner !== 'scene') throw runtimeError('schema_invalid', 'runtime_activation', 'Unsupported visual mode.');
      if (command.apply_on_commit === true) {
        const draft = this._assertDraft('runtime.activate', { transactionId: command.transaction_id, senderId: command.sender_id, state: 'Ready' });
        if (command.expected_definition_hash !== draft.candidate_scene_ref.content_hash) throw runtimeError('definition_hash_mismatch', 'runtime_activation', 'Activation is not bound to the exact draft hash.');
        this.activationArm = { transaction_id: draft.transaction_id, definition_hash: draft.candidate_scene_ref.content_hash, sender_id: command.sender_id };
        return { status: 'armed', owner: this.runtimeOwner, transaction_id: draft.transaction_id, expected_definition_hash: draft.candidate_scene_ref.content_hash };
      }
      const result = await this.showActiveVisual();
      return Object.assign({ transaction_id: null }, result);
    }

    armRuntime(command) {
      return this.activateRuntime(command, null);
    }

    _swapEffect(effect, options = {}) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.transitionManager.cancelEffectSwap(runtimeError('first_frame_timeout', 'first_frame', 'Timed out waiting for the first committed frame.'));
          reject(runtimeError('first_frame_timeout', 'first_frame', 'Timed out waiting for the first committed frame.'));
        }, this.config.swapTimeoutMs);
        this.transitionManager.adoptEffect(effect, {
          retainPrevious: options.retainPrevious === true,
          onCommit: () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          },
          onRollback: (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(runtimeError('first_frame_failed', 'first_frame', error && error.message ? error.message : 'First frame failed.'));
          }
        });
      });
    }

    _restoreRetainedEffect() {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.transitionManager.cancelEffectSwap();
          reject(runtimeError('first_frame_timeout', 'rollback', 'Timed out restoring the retained last-good effect.'));
        }, this.config.swapTimeoutMs);
        const started = this.transitionManager.restoreRetainedEffect({
          onCommit: () => { if (!settled) { settled = true; clearTimeout(timer); resolve(true); } },
          onRollback: (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } }
        });
        if (!started) { settled = true; clearTimeout(timer); resolve(false); }
      });
    }

    _rebuildDraftEffect(draft) {
      if (!draft || (draft.effect && !draft.effect.disposed)) return;
      const trusted = this.trustedHashes.has(draft.candidate_scene_ref.content_hash);
      const replacement = this._makeEffect(draft.definition, draft.instance, trusted);
      this._compileStaging(replacement);
      draft.effect = replacement;
    }

    _createRevision(instance, sceneRef, command, operationKind) {
      return {
        revision_id: id('rev'),
        parent_revision_id: this.active && this.active.revision ? this.active.revision.revision_id : null,
        transaction_id: command.transaction_id || null,
        committed_at: new Date().toISOString(),
        actor: 'user',
        operation_kind: operationKind || 'human-edit',
        scene_ref: clone(sceneRef),
        instance_snapshot: clone(instance),
        summary: command.summary || 'Updated visual scene.',
        validation_ref: command.validation_ref || 'viewer:first-frame'
      };
    }

    async commit(command) {
      const draft = this._assertDraft('scene.commit', {
        transactionId: command.transaction_id,
        senderId: command.sender_id,
        state: 'Ready',
        leaseVersion: command.lease_version,
        draftVersion: command.expected_draft_version
      });
      if (command.expected_definition_hash !== draft.candidate_scene_ref.content_hash) throw runtimeError('definition_hash_mismatch', 'commit', 'Commit hash does not match the ready draft.');
      if (draft.base_revision_id !== ((this.active && this.active.revision.revision_id) || null)) throw runtimeError('stale_revision', 'commit', 'Base revision is stale.');
      if (this.runtimeOwner === 'legacy') {
        const arm = this.activationArm;
        if (!arm || arm.transaction_id !== draft.transaction_id || arm.definition_hash !== draft.candidate_scene_ref.content_hash || arm.sender_id !== command.sender_id) {
          throw runtimeError('runtime_conflict', 'commit', 'Scene activation must be armed before committing from legacy runtime.');
        }
      }
      draft.state = 'Committing';
      const ownerBeforeCommit = this.runtimeOwner;
      const activeBeforeCommit = this.active;
      const performanceBeforeCommit = this.getPerformanceState();
      const revision = this._createRevision(draft.instance, draft.candidate_scene_ref, command, command.operation_kind || 'human-edit');
      let journalStarted = false;
      let sceneWasVisible = !!(draft.preview_main && this.transitionManager.effect === draft.effect);
      let durability = { durable: false };
      try {
        this._activatePerformanceProfile(draft.definition);
        if (sceneWasVisible) this.visualSlot.stageVisibleVisual(draft.effect);
        if (this.store) {
          durability = await this.store.beginRuntimeCommit(draft.definition, draft.instance, revision);
          journalStarted = true;
          this.persistence.mode = this.store.mode;
        }
        if (!sceneWasVisible) {
          this._syncSingleEffectSources(draft.effect);
          draft.effect.resetEpoch();
          await this.visualSlot.stageVisual(draft.effect);
          sceneWasVisible = true;
        }
        if (this.store) durability = await this.store.finalizeRuntimeCommit(draft.definition, draft.instance, revision);
        this.visualSlot.commit();
        this.active = { definition: clone(draft.definition), instance: clone(draft.instance), effect: draft.effect, revision: revision };
        this._setRuntimeOwner('scene', 'scene-committed');
        this.history.unshift(clone(revision));
        this.history = this.history.slice(0, this.config.historyLimit);
        this.activationArm = null;
        this._clearDraftTimers();
        this.draft = null;
        this.persistence.mode = this.store ? this.store.mode : 'none';
        this._record('scene_committed', { revision_id: revision.revision_id, scene_ref: revision.scene_ref, durable: durability.durable === true });
        return { revision: clone(revision), runtime_owner: this.runtimeOwner, instance: clone(this.active.instance), durable: durability.durable === true };
      } catch (error) {
        if (this.visualSlot.pending) {
          try { await this.visualSlot.rollback(); } catch (rollbackError) {
            this._record('scene_rollback_failed', { code: rollbackError.code || 'first_frame_failed' });
          }
        }
        this.active = activeBeforeCommit;
        this._setRuntimeOwner(ownerBeforeCommit, 'commit-rollback');
        this.performanceState = performanceBeforeCommit;
        this._applyRenderScale(performanceBeforeCommit.render_scale);
        if (journalStarted && this.store) await this.store.rollbackRuntimeCommit(revision, error);
        draft.state = 'Ready';
        draft.preview_main = false;
        draft.preview_target = 'local_mirror';
        draft.preview_expires_at = null;
        try { this._rebuildDraftEffect(draft); } catch (rebuildError) {
          this._record('draft_rebuild_failed', { code: rebuildError.code || 'compile_failed' });
        }
        this._record('scene_commit_rolled_back', { code: error.code || 'first_frame_failed' });
        throw error;
      }
    }

    _clearDraftTimers() {
      if (this.leaseTimer) clearTimeout(this.leaseTimer);
      if (this.previewTimer) clearTimeout(this.previewTimer);
      this.leaseTimer = null;
      this.previewTimer = null;
      this.pendingHandoff = null;
    }

    async _restorePreview(disposeCandidate) {
      if (!this.draft || !this.draft.preview_main) return;
      const candidate = this.draft.effect;
      if (disposeCandidate) {
        await new Promise((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (!settled) { settled = true; this.transitionManager.cancelEffectSwap(); reject(runtimeError('first_frame_timeout', 'preview', 'Timed out restoring last-good.')); }
          }, this.config.swapTimeoutMs);
          const restored = this.transitionManager.restoreRetainedEffect({
            onCommit: () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } },
            onRollback: (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } }
          });
          if (!restored) { clearTimeout(timer); settled = true; resolve(); }
        });
      } else {
        const lastGood = this.transitionManager.takeRetainedEffect();
        if (!lastGood) throw runtimeError('runtime_unavailable', 'preview', 'No last-good effect is retained.');
        await this._swapEffect(lastGood, { retainPrevious: true });
        const retainedCandidate = this.transitionManager.takeRetainedEffect();
        if (retainedCandidate !== candidate) throw runtimeError('runtime_unavailable', 'preview', 'Preview candidate identity was lost.');
      }
      this.draft.preview_main = false;
      this.draft.preview_target = 'local_mirror';
      this.draft.preview_expires_at = null;
      if (this.previewTimer) clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }

    async previewMain(command) {
      const draft = this._assertDraft('scene.preview_main.request', {
        transactionId: command.transaction_id,
        senderId: command.sender_id,
        state: 'Ready',
        leaseVersion: command.lease_version
      });
      if (command.co_located_confirmed !== true) throw runtimeError('capability_missing', 'preview', 'Main preview requires explicit co-located confirmation.');
      if (command.action === 'stop') {
        await this._restorePreview(false);
        return { status: 'restored', expires_at: null, restored_revision_id: this.active && this.active.revision.revision_id };
      }
      if (command.action !== 'start') throw runtimeError('schema_invalid', 'preview', 'Preview action must be start or stop.');
      if (!draft.preview_main) {
        this._syncSingleEffectSources(draft.effect);
        draft.effect.resetEpoch();
        await this._swapEffect(draft.effect, { retainPrevious: true });
        draft.preview_main = true;
      }
      draft.preview_target = 'main_takeover';
      draft.preview_expires_at = new Date(Date.now() + this.config.mainPreviewTtlMs).toISOString();
      if (this.previewTimer) clearTimeout(this.previewTimer);
      this.previewTimer = setTimeout(() => { this._restorePreview(false).catch(() => {}); }, this.config.mainPreviewTtlMs);
      this._renewLease();
      return { status: 'active', expires_at: draft.preview_expires_at, restored_revision_id: null };
    }

    async abort(command) {
      const draft = this._assertDraft('scene.abort', {
        transactionId: command.transaction_id,
        senderId: command.system ? null : command.sender_id,
        leaseVersion: command.system ? null : command.lease_version,
        allowExpired: command.system === true
      });
      const restoredRevisionId = this.active && this.active.revision.revision_id;
      if (draft.preview_main) await this._restorePreview(true);
      else draft.effect.dispose();
      this._clearDraftTimers();
      this.activationArm = null;
      this.draft = null;
      this._record('scene_aborted', { transaction_id: draft.transaction_id, reason: command.reason || 'cancelled' });
      return { reason: command.reason || 'cancelled', restored_revision_id: restoredRevisionId };
    }

    async _expireDraft(reason) {
      if (!this.draft) return;
      await this.abort({ transaction_id: this.draft.transaction_id, system: true, reason: reason });
    }

    requestHandoff(command) {
      const draft = this._assertDraft('transaction.handoff.request', { transactionId: command.transaction_id, state: 'Ready' });
      if (command.from_sender_id !== draft.writer_lease.holder_client_id || command.to_sender_id !== command.sender_id) throw runtimeError('schema_invalid', 'handoff', 'Handoff identities do not match the authoritative lease.');
      const deadlineMs = new Date(command.deadline).getTime();
      if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) throw runtimeError('schema_invalid', 'handoff', 'Handoff deadline is invalid.');
      this.pendingHandoff = {
        id: command.handoff_request_id || id('handoff'),
        from: command.from_sender_id,
        to: command.to_sender_id,
        reason: command.reason || '',
        deadline: new Date(deadlineMs).toISOString(),
        lease_version: draft.writer_lease.lease_version,
        request_message_id: command.request_message_id || null,
        request_id: command.request_id || null
      };
      return clone(this.pendingHandoff);
    }

    resolveHandoff(command) {
      const draft = this._assertDraft('transaction.handoff.' + command.action, { transactionId: command.transaction_id, senderId: command.sender_id, state: 'Ready', leaseVersion: command.lease_version });
      const pending = this.pendingHandoff;
      if (!pending || pending.id !== command.handoff_request_id) throw runtimeError('transaction_not_found', 'handoff', 'Handoff request was not found.');
      if (new Date(pending.deadline).getTime() <= Date.now()) {
        this.pendingHandoff = null;
        return { handoff_result_id: id('handoff-result'), status: 'expired', holder_client_id: draft.writer_lease.holder_client_id, lease_version: draft.writer_lease.lease_version };
      }
      if (command.action === 'deny') {
        this.pendingHandoff = null;
        return { handoff_result_id: id('handoff-result'), status: 'denied', holder_client_id: draft.writer_lease.holder_client_id, lease_version: draft.writer_lease.lease_version };
      }
      draft.writer_lease.holder_client_id = pending.to;
      draft.writer_lease.lease_version += 1;
      this.pendingHandoff = null;
      this._renewLease();
      return { handoff_result_id: id('handoff-result'), status: 'granted', holder_client_id: draft.writer_lease.holder_client_id, lease_version: draft.writer_lease.lease_version };
    }

    expireHandoff(handoffRequestId) {
      const pending = this.pendingHandoff;
      if (!pending || pending.id !== handoffRequestId || !this.draft) return null;
      this.pendingHandoff = null;
      return {
        handoff_result_id: id('handoff-result'),
        status: 'expired',
        holder_client_id: this.draft.writer_lease.holder_client_id,
        lease_version: this.draft.writer_lease.lease_version,
        from_sender_id: pending.from,
        to_sender_id: pending.to
      };
    }

    async takeover(command) {
      const draft = this._assertDraft('transaction.takeover.request', { transactionId: command.transaction_id, state: 'Ready' });
      if (command.confirmed !== true) throw runtimeError('takeover_confirmation_required', 'takeover', 'Explicit takeover confirmation is required.');
      if (command.expected_lease_version !== draft.writer_lease.lease_version) throw runtimeError('draft_conflict', 'takeover', 'Writer lease version is stale.');
      if (draft.preview_main) await this._restorePreview(false);
      const oldTransactionId = draft.transaction_id;
      draft.transaction_id = command.new_transaction_id || id('tx');
      draft.writer_lease.holder_client_id = command.sender_id;
      draft.writer_lease.lease_version += 1;
      draft.draft_version += 1;
      draft.preview_main = false;
      draft.preview_target = 'local_mirror';
      this.activationArm = null;
      this.pendingHandoff = null;
      this._renewLease();
      return { status: 'taken_over', old_transaction_id: oldTransactionId, new_transaction_id: draft.transaction_id, draft: this.draftSnapshot(true) };
    }

    async patchInstance(command) {
      if (this.runtimeOwner !== 'scene' || !this.active) throw runtimeError('runtime_conflict', 'instance', 'No active Scene instance is available.');
      if (command.base_revision_id && command.base_revision_id !== this.active.revision.revision_id) throw runtimeError('stale_revision', 'instance', 'Base revision is stale.');
      const next = clone(this.active.instance);
      Object.assign(next.params, command.set_params || {});
      const remove = new Set(command.remove_binding_ids || []);
      const byId = new Map((next.bindings || []).filter((binding) => !remove.has(binding.binding_id)).map((binding) => [binding.binding_id, binding]));
      (command.upsert_bindings || []).forEach((binding) => byId.set(binding.binding_id, clone(binding)));
      next.bindings = Array.from(byId.values());
      if (command.modulation_master) next.modulation_master = clone(command.modulation_master);
      next.params = Object.assign({}, next.params);
      const trusted = this.trustedHashes.has(this.active.revision.scene_ref.content_hash);
      const coalesced = command.phase === 'update' || command.phase === 'begin';
      if (coalesced) {
        this.active.instance = Contract.normalizeInstance(this.active.definition, next, { trusted: trusted });
        this.active.effect.setInstance(this.active.instance);
        this._record('instance_updated', { revision_id: this.active.revision.revision_id, coalesced: true });
        return { instance: clone(this.active.instance), revision_id: this.active.revision.revision_id, revision: null, coalesced: true, durable: this.store ? this.store.mode === 'durable' : false };
      }
      next.instance_id = id('instance');
      const normalized = Contract.normalizeInstance(this.active.definition, next, { trusted: trusted });
      const revision = this._createRevision(normalized, this.active.revision.scene_ref, command, 'instance-patch');
      let durability = { durable: false };
      let journalStarted = false;
      try {
        if (this.store) {
          durability = await this.store.beginRuntimeCommit(this.active.definition, normalized, revision);
          journalStarted = true;
          durability = await this.store.finalizeRuntimeCommit(this.active.definition, normalized, revision);
        }
        this.active.instance = normalized;
        this.active.revision = revision;
        this.active.effect.setInstance(this.active.instance);
        this.history.unshift(clone(revision));
        this.history = this.history.slice(0, this.config.historyLimit);
        this._record('instance_updated', { revision_id: revision.revision_id, coalesced: false, durable: durability.durable === true });
        return { instance: clone(this.active.instance), revision_id: revision.revision_id, revision: clone(revision), coalesced: false, durable: durability.durable === true };
      } catch (error) {
        if (journalStarted && this.store) await this.store.rollbackRuntimeCommit(revision, error);
        this._record('instance_update_rejected', { code: error.code || 'persistence_failed' });
        throw error;
      }
    }

    transactionResult(transactionId) {
      if (!this.draft || this.draft.transaction_id !== transactionId) return { status: 'none', snapshot: null };
      return { status: this.draft.state.toLowerCase(), snapshot: this.draftSnapshot(true) };
    }

    stateSnapshot() {
      return {
        active: this.active ? { scene_ref: clone(this.active.revision.scene_ref), instance: clone(this.active.instance), revision_id: this.active.revision.revision_id, runtime_owner: this.runtimeOwner } : { scene_ref: null, instance: null, revision_id: null, runtime_owner: this.runtimeOwner },
        working_draft: this.draftSnapshot(true),
        capabilities: this.getCapabilities(),
        sources: clone(this.sourceSlots),
        source_binding: clone(this.sourceBindingState),
        signals: clone(this.signalBus.values),
        history: clone(this.history.slice(0, 20)),
        persistence: clone(this.persistence),
        performance: this.getPerformanceState()
      };
    }

    getDefinition(contentHash) {
      const definition = this.definitionCache.get(contentHash);
      return definition ? clone(definition) : null;
    }

    dispose() {
      this._clearDraftTimers();
      if (this.draft && this.draft.effect && (!this.active || this.draft.effect !== this.active.effect)) this.draft.effect.dispose();
      if (this.visualSlot) this.visualSlot.dispose();
      if (this.active && this.active.effect && this.active.effect !== this.transitionManager.effect) this.active.effect.dispose();
      this.draft = null;
      this.active = null;
      if (this.store && typeof this.store.close === 'function') this.store.close();
    }
  }

  return Object.freeze({
    SceneEffect: SceneEffect,
    SceneVisualSlot: SceneVisualSlot,
    SceneRuntime: SceneRuntime,
    createFramePacing: createFramePacing,
    defaultSlot: defaultSlot,
    sourceHasTopLeftTextureOrigin: sourceHasTopLeftTextureOrigin,
    normalizeViewerDisplayMode: normalizeViewerDisplayMode,
    viewerDisplayFitCode: viewerDisplayFitCode,
    normalizeViewerTileAnchor: normalizeViewerTileAnchor
  });
});
