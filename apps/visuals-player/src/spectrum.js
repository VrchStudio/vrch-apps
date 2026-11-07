/* Visuals Player audio features, shared by the App (a live microphone or line in) and the build script that
   precomputes the built-in tracks: a Web Audio AnalyserNode reading (Blackman window, smoothing 0) turned into the
   shared VrchImageAudio.computeSceneSignalSample features, exactly as Live Console reads them. */
(root => {
  'use strict';
  const SR = 48000, FFT = 1024, BINS = FFT / 2, MIN_DB = -100, MAX_DB = -30;
  const WINDOW = Float32Array.from({length: FFT}, (_, i) => 0.42 - 0.5 * Math.cos(2 * Math.PI * i / FFT) + 0.08 * Math.cos(4 * Math.PI * i / FFT));
  const BITS = Math.log2(FFT), REVERSE = new Uint16Array(FFT), COS = new Float32Array(BINS), SIN = new Float32Array(BINS);
  for (let i = 0; i < FFT; i++) { let r = 0; for (let b = 0; b < BITS; b++) r |= ((i >> b) & 1) << (BITS - 1 - b); REVERSE[i] = r; }
  for (let i = 0; i < BINS; i++) { COS[i] = Math.cos(-2 * Math.PI * i / FFT); SIN[i] = Math.sin(-2 * Math.PI * i / FFT); }
  // The scalar features in the order a precomputed track stores them, followed by the 64 spectrum bands.
  const SCALARS = ['raw_low', 'raw_mid', 'raw_high', 'rms', 'centroid', 'v2_raw_energy', 'v2_raw_low', 'v2_raw_mid', 'v2_raw_high',
    'v2_low_share', 'v2_mid_share', 'v2_high_share', 'v2_brightness', 'v2_flux'];
  const BANDS = 64, DB_FLOOR = -160;

  class Spectrum {
    constructor(audio = root.VrchImageAudio) {
      this.audio = audio;
      this.re = new Float32Array(FFT); this.im = new Float32Array(FFT);
      this.frequency = new Uint8Array(BINS); this.time = new Uint8Array(FFT); this.db = new Float32Array(BINS);
      this.previous = new Float32Array(BINS).fill(-Infinity); this.samples = new Float32Array(FFT);
    }
    // The FFT samples ending at frame 'end' of stereo channels, mixed to mono like the AnalyserNode.
    read(left, right, end) {
      const start = Math.round(end) - FFT, {re, im, samples, time} = this;
      for (let i = 0; i < FFT; i++) {
        const at = start + i, value = at >= 0 && at < left.length ? (left[at] + right[at]) * 0.5 : 0;
        samples[i] = value; time[i] = Math.max(0, Math.min(255, Math.round(128 * (1 + value))));
        re[REVERSE[i]] = value * WINDOW[i]; im[REVERSE[i]] = 0;
      }
      for (let size = 2; size <= FFT; size <<= 1) {
        const half = size >> 1, step = FFT / size;
        for (let i = 0; i < FFT; i += size) for (let j = 0; j < half; j++) {
          const k = i + j, l = k + half, c = COS[j * step], s = SIN[j * step];
          const tr = re[l] * c - im[l] * s, ti = re[l] * s + im[l] * c;
          re[l] = re[k] - tr; im[l] = im[k] - ti; re[k] += tr; im[k] += ti;
        }
      }
      for (let k = 0; k < BINS; k++) {
        const magnitude = Math.hypot(re[k], im[k]) / FFT, db = magnitude > 0 ? 20 * Math.log10(magnitude) : -Infinity;
        this.db[k] = db;
        this.frequency[k] = Math.max(0, Math.min(255, Math.floor(255 * (db - MIN_DB) / (MAX_DB - MIN_DB))));
      }
      return this.compute();
    }
    // A live AnalyserNode, as the Shader Editor App reads one.
    readAnalyser(analyser) {
      analyser.getByteFrequencyData(this.frequency); analyser.getByteTimeDomainData(this.time);
      analyser.getFloatFrequencyData(this.db); analyser.getFloatTimeDomainData(this.samples);
      return this.compute();
    }
    compute() {
      const sample = this.audio.computeSceneSignalSample(this.frequency, this.time, {sampleRate: SR, fftSize: FFT,
        minDecibels: MIN_DB, maxDecibels: MAX_DB, frequencyDecibels: this.db, previousFrequencyDecibels: this.previous, timeSamples: this.samples});
      this.previous.set(this.db);
      return sample;
    }
  }

  // A precomputed track: a 56-byte header (magic VPF1, version, frame rate, frame count, scalar count, band count, the
  // track file's SHA-256), then per frame the scalars as float32 and the spectrum bands as dB steps in one byte each.
  const MAGIC = 0x31465056, HEADER = 56, FRAME = SCALARS.length * 4 + BANDS;
  const encodeDb = db => Math.max(0, Math.min(255, Math.round((Math.max(DB_FLOOR, db) - DB_FLOOR) * 255 / -DB_FLOOR)));
  const decodeDb = value => DB_FLOOR + value * -DB_FLOOR / 255;
  function encodeTrack(frames, rate, sha256) {
    const bytes = new Uint8Array(HEADER + frames.length * FRAME), view = new DataView(bytes.buffer);
    [MAGIC, 1, rate, frames.length, SCALARS.length, BANDS].forEach((value, index) => view.setUint32(index * 4, value, true));
    for (let i = 0; i < 32; i++) bytes[24 + i] = parseInt(sha256.slice(i * 2, i * 2 + 2), 16);
    frames.forEach((sample, index) => {
      const at = HEADER + index * FRAME;
      SCALARS.forEach((key, k) => view.setFloat32(at + k * 4, Number(sample[key]) || 0, true));
      for (let b = 0; b < BANDS; b++) bytes[at + SCALARS.length * 4 + b] = encodeDb(sample.v2_spectrum?.[b] ?? DB_FLOOR);
    });
    return bytes;
  }
  class TrackFeatures {
    constructor(buffer) {
      const view = this.view = new DataView(buffer);
      if (buffer.byteLength < HEADER || view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== 1
        || view.getUint32(16, true) !== SCALARS.length || view.getUint32(20, true) !== BANDS) throw Error('Unknown track features.');
      this.rate = view.getUint32(8, true); this.frames = view.getUint32(12, true);
      if (buffer.byteLength !== HEADER + this.frames * FRAME) throw Error('Track features are incomplete.');
      this.sha256 = [...new Uint8Array(buffer, 24, 32)].map(value => value.toString(16).padStart(2, '0')).join('');
    }
    get duration() { return this.frames / this.rate; }
    // The features at 'seconds' into the track, as computeSceneSignalSample returns them.
    at(seconds) {
      const index = Math.max(0, Math.min(this.frames - 1, Math.floor(seconds * this.rate)));
      const at = HEADER + index * FRAME, view = this.view, sample = {v2_spectrum: new Float32Array(BANDS)};
      SCALARS.forEach((key, k) => { sample[key] = view.getFloat32(at + k * 4, true); });
      for (let b = 0; b < BANDS; b++) sample.v2_spectrum[b] = decodeDb(view.getUint8(at + SCALARS.length * 4 + b));
      return sample;
    }
  }

  const api = Object.freeze({SR, FFT, MIN_DB, MAX_DB, Spectrum, TrackFeatures, encodeTrack});
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VisualsSpectrum = api;
})(typeof window !== 'undefined' ? window : globalThis);
