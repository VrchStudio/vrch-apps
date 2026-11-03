/* Petal FM — a six-operator FM synthesizer in the manner of the DX7, played
 * by one-key chords (AudioWorklet).
 *
 * Each voice has six sine operators. One of the 32 classic algorithms routes
 * them: modulators phase-modulate the operators below them and carriers sum
 * to the output; one operator feeds back on itself. Every operator has a
 * frequency ratio (coarse, fine, detune), an output level and a four-rate,
 * four-level envelope working in the log (dB) domain, with keyboard rate
 * scaling and velocity sensitivity, as on the original.
 *
 * The chord engine plays the notes the page sends in one of five ways:
 * CHORD (together), STRUM, SLOP (loose, humanised), ARP and HARP, and doubles
 * the root on a separate bass voice.
 */

const TAU = Math.PI * 2;
const SUB = 16;                // control-rate block
const MAX_VOICES = 16;
// arpeggio divisions in beats: 1/4, 1/8, 1/8T, 1/16, 1/16T, 1/32
const ARP_DIVS = [1, 0.5, 1 / 3, 0.25, 1 / 6, 0.125];
const SINE_N = 4096;
const SINE = new Float32Array(SINE_N + 1);
for (let i = 0; i <= SINE_N; i++) SINE[i] = Math.sin((i / SINE_N) * TAU);

/* The 32 algorithms, as operator routing flags in the order OP6 … OP1
 * (from the open-source Music Synthesizer for Android engine):
 *   bits 0-1 output bus (0 = audio out, 1, 2), bit 2 add to that bus,
 *   bits 4-5 input bus, bit 6 feedback in, bit 7 feedback out.          */
const ALGORITHMS = [
  [0xc1, 0x11, 0x11, 0x14, 0x01, 0x14], [0x01, 0x11, 0x11, 0x14, 0xc1, 0x14],
  [0xc1, 0x11, 0x14, 0x01, 0x11, 0x14], [0x41, 0x11, 0x94, 0x01, 0x11, 0x14],
  [0xc1, 0x14, 0x01, 0x14, 0x01, 0x14], [0x41, 0x94, 0x01, 0x14, 0x01, 0x14],
  [0xc1, 0x11, 0x05, 0x14, 0x01, 0x14], [0x01, 0x11, 0xc5, 0x14, 0x01, 0x14],
  [0x01, 0x11, 0x05, 0x14, 0xc1, 0x14], [0x01, 0x05, 0x14, 0xc1, 0x11, 0x14],
  [0xc1, 0x05, 0x14, 0x01, 0x11, 0x14], [0x01, 0x05, 0x05, 0x14, 0xc1, 0x14],
  [0xc1, 0x05, 0x05, 0x14, 0x01, 0x14], [0xc1, 0x05, 0x11, 0x14, 0x01, 0x14],
  [0x01, 0x05, 0x11, 0x14, 0xc1, 0x14], [0xc1, 0x11, 0x02, 0x25, 0x05, 0x14],
  [0x01, 0x11, 0x02, 0x25, 0xc5, 0x14], [0x01, 0x11, 0x11, 0xc5, 0x05, 0x14],
  [0xc1, 0x14, 0x14, 0x01, 0x11, 0x14], [0x01, 0x05, 0x14, 0xc1, 0x14, 0x14],
  [0x01, 0x14, 0x14, 0xc1, 0x14, 0x14], [0xc1, 0x14, 0x14, 0x14, 0x01, 0x14],
  [0xc1, 0x14, 0x14, 0x01, 0x14, 0x04], [0xc1, 0x14, 0x14, 0x14, 0x04, 0x04],
  [0xc1, 0x14, 0x14, 0x04, 0x04, 0x04], [0xc1, 0x05, 0x14, 0x01, 0x14, 0x04],
  [0x01, 0x05, 0x14, 0xc1, 0x14, 0x04], [0x04, 0xc1, 0x11, 0x14, 0x01, 0x14],
  [0xc1, 0x14, 0x01, 0x14, 0x04, 0x04], [0x04, 0xc1, 0x11, 0x14, 0x04, 0x04],
  [0xc1, 0x14, 0x04, 0x04, 0x04, 0x04], [0xc4, 0x04, 0x04, 0x04, 0x04, 0x04]
];
const carriersOf = (alg) => ALGORITHMS[alg].filter((f) => (f & 3) === 0).length;

/* DX7 level scaling: levels 0-99 map to 0-127 units of 0.75 dB. */
const LOW_LEVELS = [0, 5, 9, 13, 17, 20, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41, 42, 43, 45, 46];
const scaleLevel = (l) => (l >= 20 ? 28 + l : LOW_LEVELS[Math.max(0, l | 0)]);
const unitsToAmp = (u) => Math.pow(2, u / 8);          // u <= 0
/** envelope speed in level units per second for a 0-99 rate (+ scaling) */
function rateSpeed(rate, scaleDelta) {
  const q = Math.min(63, ((rate * 41) >> 6) + scaleDelta);
  return 0.186 * (4 + (q & 3)) * Math.pow(2, q >> 2);
}

class OpEnv {
  constructor() { this.stage = 4; this.e = 0; }
  start(op, note) {
    this.op = op;
    // keyboard rate scaling: higher notes run their envelopes faster
    const x = Math.min(31, Math.max(0, Math.floor(note / 3) - 7));
    this.rsDelta = (op[13] * x) >> 3;
    this.e = scaleLevel(op[11]);
    this.stage = 0;
  }
  release() { if (this.stage < 3) this.stage = 3; }
  /** advance dt seconds; returns the envelope in level units (0-127) */
  step(dt) {
    if (this.stage > 3) return this.e;
    const op = this.op;
    const target = scaleLevel(op[8 + this.stage]);
    const speed = rateSpeed(op[4 + this.stage], this.rsDelta);
    if (this.e < target) {
      // attacks rise faster from low levels, as on the original
      this.e += speed * dt * (1 + 3 * (1 - this.e / 127));
      if (this.e >= target) { this.e = target; if (this.stage < 2) this.stage++; else if (this.stage === 3) this.stage = 4; }
    } else if (this.e > target) {
      this.e -= speed * dt;
      if (this.e <= target) { this.e = target; if (this.stage < 2) this.stage++; else if (this.stage === 3) this.stage = 4; }
    } else if (this.stage < 2) this.stage++;
    else if (this.stage === 3) this.stage = 4;
    return this.e;
  }
}

class Voice {
  constructor() {
    this.ph = new Float64Array(6);
    this.env = [0, 1, 2, 3, 4, 5].map(() => new OpEnv());
    this.amp = new Float32Array(6);
    this.fb1 = 0; this.fb2 = 0;
    this.on = false; this.active = false; this.note = 60; this.age = 0; this.vel = 1;
    this.patch = null; this.offIn = -1; this.tag = '';
  }
}

/* ── effects ──────────────────────────────────────────────────────────── */
class DelayLine {
  constructor(seconds, sr) { this.buf = new Float32Array(Math.ceil(seconds * sr) + 2); this.i = 0; }
  read(d) {
    const len = this.buf.length;
    let p = this.i - d;
    p -= Math.floor(p / len) * len;
    const i0 = p | 0, i1 = i0 + 1 >= len ? 0 : i0 + 1, f = p - i0;
    return this.buf[i0] * (1 - f) + this.buf[i1] * f;
  }
  write(v) { this.buf[this.i] = v; if (++this.i >= this.buf.length) this.i = 0; }
}
class Comb {
  constructor(n) { this.buf = new Float32Array(Math.max(1, n | 0)); this.i = 0; this.z = 0; }
  process(x, fb, damp) {
    const out = this.buf[this.i];
    this.z = out * (1 - damp) + this.z * damp;
    this.buf[this.i] = x + this.z * fb;
    if (++this.i >= this.buf.length) this.i = 0;
    return out;
  }
}
class Allpass {
  constructor(n) { this.buf = new Float32Array(Math.max(1, n | 0)); this.i = 0; }
  process(x) {
    const b = this.buf[this.i];
    this.buf[this.i] = x + b * 0.5;
    if (++this.i >= this.buf.length) this.i = 0;
    return b - x;
  }
}

// the bass voice: a round two-operator patch an octave or two below the root
const BASS_PATCH = {
  alg: 4, fb: 5, transpose: 0, lfo: [30, 0, 0, 0, 0],
  ops: [
    [0, 0, 0, 99, 95, 45, 30, 62, 99, 88, 80, 0, 2, 1],
    [0, 0, 0, 72, 99, 60, 30, 62, 99, 70, 40, 0, 3, 1],
    [1, 0, 0, 0, 99, 99, 99, 99, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 99, 99, 99, 99, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 99, 99, 99, 99, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 99, 99, 99, 99, 0, 0, 0, 0, 0, 0]
  ]
};

const Processor = typeof AudioWorkletProcessor === 'function' ? AudioWorkletProcessor : class {};

class PetalProcessor extends Processor {
  constructor() {
    super();
    const sr = sampleRate;
    this.sr = sr;
    this.voices = [];
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());
    this.patch = null;
    this.perf = { mode: 0, rate: 0.5, bass: 0.5, bassOct: 1, bpm: 100, div: 3, swing: 0 };
    this.fx = { chorus: 0.4, delay: 0.15, reverb: 0.3, volume: 0.8 };
    this.lfoPh = 0; this.lfoSH = 0; this.lfoAge = 0;
    // chord playback
    this.chord = null;         // { notes, bass, vel, held }
    this.queue = [];           // scheduled note-ons: { at (samples), note, vel, len }
    this.clock = 0;            // samples
    this.arpIndex = 0; this.arpNext = 0;
    this.chL = new DelayLine(0.03, sr); this.chR = new DelayLine(0.03, sr); this.chPh = 0;
    this.dL = new DelayLine(1.2, sr); this.dR = new DelayLine(1.2, sr);
    const sc = sr / 44100;
    this.combL = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => new Comb(n * sc));
    this.combR = [1139, 1211, 1300, 1379, 1445, 1514, 1580, 1640].map((n) => new Comb(n * sc));
    this.apL = [556, 441, 341, 225].map((n) => new Allpass(n * sc));
    this.apR = [579, 464, 364, 248].map((n) => new Allpass(n * sc));
    this.meterCount = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(d) {
    if (!d || typeof d !== 'object') return;
    if (d.type === 'patch') this.patch = d.patch;
    else if (d.type === 'perf') this.perf = { ...this.perf, ...d.perf };
    else if (d.type === 'fx') this.fx = { ...this.fx, ...d.fx };
    else if (d.type === 'chord') this.startChord(d.notes, d.bass, d.vel || 0.85);
    else if (d.type === 'release') this.releaseChord();
    else if (d.type === 'panic') { for (const v of this.voices) { v.active = false; v.on = false; } this.queue = []; this.chord = null; }
  }

  /* ── chords ─────────────────────────────────────────────────────────── */
  startChord(notes, bass, vel) {
    this.releaseChord();
    if (!notes || !notes.length) return;
    const sorted = notes.slice().sort((a, b) => a - b);
    this.chord = { notes: sorted, bass, vel };
    const mode = this.perf.mode | 0;
    const sr = this.sr;
    const now = this.clock;
    if (bass != null && this.perf.bass > 0.01) this.noteOn(bass, vel * this.perf.bass, -1, 'bass', BASS_PATCH);
    if (mode === 0) {
      for (const n of sorted) this.noteOn(n, vel, -1, 'chord');
    } else if (mode === 1) {
      // strum: low to high, 12-70 ms apart
      const gap = (0.012 + (1 - this.perf.rate) * 0.058) * sr;
      sorted.forEach((n, i) => this.queue.push({ at: now + i * gap, note: n, vel: vel * (1 - i * 0.04), len: -1 }));
    } else if (mode === 2) {
      // slop: loose timing and uneven velocities, like a relaxed hand
      const spread = (0.02 + this.perf.rate * 0.07) * sr;
      for (const n of sorted) this.queue.push({ at: now + Math.random() * spread, note: n, vel: vel * (0.75 + Math.random() * 0.3), len: -1 });
    } else {
      this.arpIndex = 0;
      this.arpNext = now;
    }
  }
  releaseChord() {
    this.queue = [];
    this.chord = null;
    for (const v of this.voices) if (v.on && (v.tag === 'chord' || v.tag === 'bass')) this.noteOff(v);
  }

  runChord(n) {
    this.clock += n;
    // queued strums
    if (this.queue.length) {
      const due = this.queue.filter((q) => q.at <= this.clock);
      if (due.length) {
        this.queue = this.queue.filter((q) => q.at > this.clock);
        for (const q of due) this.noteOn(q.note, q.vel, q.len, 'chord');
      }
    }
    const mode = this.perf.mode | 0;
    if (this.chord && mode >= 3 && this.clock >= this.arpNext) {
      const c = this.chord.notes;
      const sr = this.sr;
      // ARP and HARP lock to the tempo: one note per division of a beat,
      // alternate notes pushed late and early by the swing
      const beat = (60 / Math.max(20, this.perf.bpm)) * sr;
      const base = beat * (ARP_DIVS[this.perf.div | 0] || 0.25);
      const sw = Math.min(0.6, Math.max(0, this.perf.swing || 0)) * 0.5;
      const step = base * (this.arpIndex % 2 === 0 ? 1 + sw : 1 - sw);
      if (mode === 3) {
        // arpeggio: up through the chord
        const note = c[this.arpIndex++ % c.length];
        this.noteOn(note, this.chord.vel, step * 0.9, 'arp');
        this.arpNext += step;
      } else {
        // harp: fast glissandi up two octaves of chord tones and back down
        const tones = [];
        for (let o = 0; o < 2; o++) for (const x of c) tones.push(x + 12 * o);
        tones.push(c[0] + 24);
        const cyc = tones.length * 2 - 2;
        const k = this.arpIndex++ % cyc;
        const note = tones[k < tones.length ? k : cyc - k];
        this.noteOn(note, this.chord.vel * 0.8, step * 3, 'arp');
        this.arpNext += step;
      }
    }
  }

  /* ── voices ─────────────────────────────────────────────────────────── */
  noteOn(note, vel, lenSamples, tag, patch) {
    const p = patch || this.patch;
    if (!p) return;
    let v = null;
    for (const c of this.voices) if (!c.active) { v = c; break; }
    if (!v) {
      // steal the oldest released voice, else the oldest
      v = this.voices[0];
      let best = -1;
      for (const c of this.voices) {
        const score = c.age + (c.on ? 0 : 1e9);
        if (score > best) { best = score; v = c; }
      }
    }
    v.patch = p; v.note = note + (p.transpose || 0); v.vel = vel; v.tag = tag;
    v.on = true; v.active = true; v.age = 0; v.offIn = lenSamples;
    v.fb1 = v.fb2 = 0;
    for (let i = 0; i < 6; i++) { v.ph[i] = 0; v.env[i].start(p.ops[i], v.note); }
  }
  noteOff(v) { v.on = false; for (const e of v.env) e.release(); }

  /* ── audio ──────────────────────────────────────────────────────────── */
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out.length > 1 ? out[1] : out[0];
    const frames = L.length;
    L.fill(0); R.fill(0);
    if (!this.patch) return true;
    const sr = this.sr;
    for (let off = 0; off < frames; off += SUB) {
      const n = Math.min(SUB, frames - off);
      this.runChord(n);
      // LFO (patch-wide): speed, delay, pitch depth, amp depth, wave
      const [lSpeed, lDelay, lPmd, lAmd, lWave] = this.patch.lfo || [35, 0, 0, 0, 0];
      const hz = 0.06 * Math.pow(2, lSpeed / 10.3);
      const prev = this.lfoPh;
      this.lfoPh = (this.lfoPh + hz * n / sr) % 1;
      if (this.lfoPh < prev) this.lfoSH = Math.random() * 2 - 1;
      const lp = this.lfoPh;
      const lfo = lWave === 1 ? 1 - 2 * lp : lWave === 2 ? 2 * lp - 1 : lWave === 3 ? (lp < 0.5 ? 1 : -1)
        : lWave === 4 ? Math.sin(TAU * lp) : lWave === 5 ? this.lfoSH : 1 - 4 * Math.abs(lp - 0.5);
      for (const v of this.voices) {
        if (!v.active) continue;
        if (v.on && v.offIn >= 0) { v.offIn -= n; if (v.offIn <= 0) this.noteOff(v); }
        const fade = lDelay > 0 ? Math.min(1, v.age / (sr * (lDelay / 99) * (lDelay / 99) * 5 + 1)) : 1;
        this.renderVoice(v, L, R, off, n, lfo * fade, lPmd, lAmd);
      }
    }
    this.effects(L, R, frames);
    if (++this.meterCount >= 10) {
      this.meterCount = 0;
      let peak = 0;
      for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(L[i]));
      const levels = [0, 0, 0, 0, 0, 0];
      for (const v of this.voices) if (v.active && v.tag !== 'bass') for (let i = 0; i < 6; i++) levels[i] = Math.max(levels[i], v.amp[i]);
      this.port.postMessage({ type: 'meter', peak, levels, voices: this.voices.filter((v) => v.active).length });
    }
    return true;
  }

  renderVoice(v, L, R, off, n, lfo, pmd, amd) {
    const sr = this.sr;
    const p = v.patch;
    const flags = ALGORITHMS[p.alg];
    const dt = n / sr;
    v.age += n;
    // per-operator frequency (Hz) and amplitude for this block
    const base = 440 * Math.pow(2, (v.note - 69) / 12 + (lfo * pmd / 99) * 0.5 / 12);
    const inc = new Float64Array(6);
    let alive = false;
    for (let i = 0; i < 6; i++) {
      const op = p.ops[i];
      const ratio = (op[0] === 0 ? 0.5 : op[0]) * (1 + op[1] / 100);
      inc[i] = (base * ratio * Math.pow(2, (op[2] * 1.2) / 1200)) / sr;
      const e = v.env[i].step(dt);
      // velocity: sensitivity 0-7 takes up to ~31 dB off a soft note
      const velUnits = -op[12] * (1 - v.vel) * 6;
      const units = scaleLevel(op[3]) + e - 254 + velUnits;
      v.amp[i] = op[3] > 0 ? unitsToAmp(units) : 0;
      if (v.env[i].stage < 4 || v.amp[i] > 1e-4) alive = true;
    }
    if (!alive || v.age > sr * 40) { v.active = false; v.on = false; return; }
    // carriers ramp out once every carrier's envelope has died away
    let carrierAmp = 0;
    for (let k = 0; k < 6; k++) if ((flags[5 - k] & 3) === 0) carrierAmp = Math.max(carrierAmp, v.amp[k]);
    if (!v.on && carrierAmp < 2e-4) { v.active = false; return; }
    const ampMod = 1 - (amd / 99) * 0.5 * (1 + lfo);
    const outGain = (0.42 / Math.sqrt(carriersOf(p.alg))) * (v.tag === 'bass' ? 1.1 : 1);
    const fbIdx = p.fb > 0 ? Math.pow(2, p.fb - 7) : 0;
    const ph = v.ph, amp = v.amp;
    let fb1 = v.fb1, fb2 = v.fb2;
    let sum = 0;
    for (let s = 0; s < n; s++) {
      let bus1 = 0, bus2 = 0, outv = 0;
      // operators run OP6 … OP1, writing to and reading from two buses
      for (let j = 0; j < 6; j++) {
        const f = flags[j];
        const i = 5 - j;                 // operator index (0 = OP1)
        const a = amp[i];
        const inb = (f >> 4) & 3;
        let mod = inb === 1 ? bus1 : inb === 2 ? bus2 : 0;
        if (f & 0x40) mod += (fb1 + fb2) * 0.5 * fbIdx;
        let x = ph[i] + mod;
        x -= Math.floor(x);
        const xi = x * SINE_N, i0 = xi | 0;
        const y = (SINE[i0] + (SINE[i0 + 1] - SINE[i0]) * (xi - i0)) * a;
        ph[i] += inc[i]; if (ph[i] >= 1) ph[i] -= 1;
        if (f & 0x80) { fb2 = fb1; fb1 = y; }
        const ob = f & 3, add = f & 4;
        if (ob === 0) outv += y;
        else if (ob === 1) bus1 = add ? bus1 + y : y;
        else bus2 = add ? bus2 + y : y;
      }
      const o = outv * outGain * ampMod;
      L[off + s] += o;
      R[off + s] += o;
      sum += o;
    }
    v.fb1 = fb1; v.fb2 = fb2;
  }

  effects(L, R, frames) {
    const sr = this.sr, fx = this.fx;
    const chDepth = 0.0025 * sr, chBase = 0.007 * sr;
    const dTime = 0.375 * sr, dFb = 0.38, dMix = fx.delay * 0.5;
    const rMix = fx.reverb * 0.55, vol = fx.volume;
    for (let i = 0; i < frames; i++) {
      let l = L[i], r = R[i];
      if (fx.chorus > 0.01) {
        this.chPh += 0.6 / sr; if (this.chPh >= 1) this.chPh -= 1;
        const m = Math.sin(TAU * this.chPh);
        this.chL.write(l); this.chR.write(r);
        const wl = this.chL.read(chBase + chDepth * (1 + m)), wr = this.chR.read(chBase + chDepth * (1 - m));
        l = l * (1 - fx.chorus * 0.3) + wl * fx.chorus * 0.7;
        r = r * (1 - fx.chorus * 0.3) + wr * fx.chorus * 0.7;
      }
      if (dMix > 0.001) {
        const dl = this.dL.read(dTime), dr = this.dR.read(dTime * 1.5);
        this.dL.write(l + dr * dFb); this.dR.write(r + dl * dFb);
        l += dl * dMix; r += dr * dMix;
      }
      if (rMix > 0.001) {
        const inp = (l + r) * 0.015;
        let wl = 0, wr = 0;
        for (let c = 0; c < 8; c++) { wl += this.combL[c].process(inp, 0.86, 0.25); wr += this.combR[c].process(inp, 0.86, 0.25); }
        for (let a = 0; a < 4; a++) { wl = this.apL[a].process(wl); wr = this.apR[a].process(wr); }
        l += wl * rMix; r += wr * rMix;
      }
      L[i] = Math.tanh(l * vol * 1.2) * 0.92;
      R[i] = Math.tanh(r * vol * 1.2) * 0.92;
    }
  }
}

if (typeof registerProcessor === 'function') registerProcessor('petal-fm', PetalProcessor);
else if (typeof globalThis !== 'undefined') globalThis.PetalFM = { ALGORITHMS, carriersOf };
