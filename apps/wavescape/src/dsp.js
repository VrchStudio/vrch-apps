/* Wavescape — a two-layer wavetable synthesizer with a step sequencer
 * (AudioWorklet), in the spirit of a compact wavetable Boutique.
 *
 * Each voice reads two wavetables (LAYER 1 and LAYER 2) at a shared
 * POSITION, blends them with LAYER MIX, bends the result through a wave
 * shaper and a multimode filter, and is shaped by three ADSR envelopes
 * (OSC, FILTER, AMP) and one LFO. The mix runs through chorus, delay and
 * reverb. The sequencer and arpeggiator run here, sample-accurately.
 *
 *   table L1 ─┐                       ┌─ OSC env ─► position / mix / shaper
 *             ├─ mix ─► shaper ─► filter ─► amp ─► chorus ─► delay ─► reverb
 *   table L2 ─┘                       └─ FILTER env, AMP env, LFO
 *
 * This file is also loaded by the page as a plain script: the page builds
 * the band-limited tables in chunks (buildTable) and posts them here, so the
 * audio thread never runs an FFT.
 */

const TAU = Math.PI * 2;
const TABLE_N = 1024;           // samples per frame
const FRAMES = 32;              // frames per table; POSITION 0-127 scans them
const MIP_LIMITS = [384, 128, 40, 12];  // harmonics kept per mip level
const MAX_VOICES = 8;
const SUB = 16;                 // control-rate block (samples)

/* ── wavetables ─────────────────────────────────────────────────────────
 * Each table is a function of x in [0, 1] (the frame) giving either a
 * waveform over one cycle (wave: (p, x) => y) or a harmonic spectrum
 * (spec: (h, x) => amplitude, sine phase).                                */
const frac = (v) => v - Math.floor(v);
const sawW = (p) => 2 * frac(p) - 1;
const triW = (p) => { const q = frac(p); return q < 0.5 ? 4 * q - 1 : 3 - 4 * q; };
const sqrW = (p) => (frac(p) < 0.5 ? 1 : -1);
const gauss = (d, w) => Math.exp(-(d * d) / (2 * w * w));

function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
// fixed random spectra for DIGI and NOISE
const DIGI_KEYS = [0, 1, 2, 3, 4].map((k) => {
  const r = seeded(1234 + k * 77);
  const a = new Float32Array(64);
  for (let h = 1; h < 64; h++) a[h] = r() < 0.35 ? (0.3 + r()) / Math.pow(h, 0.55) : 0;
  a[1] = 0.8 + r() * 0.4;
  return a;
});
const NOISE_SPEC = (() => {
  const r = seeded(99);
  const a = new Float32Array(400);
  for (let h = 1; h < 400; h++) a[h] = 0.4 + r();
  return a;
})();
const VOWELS = [[800, 1150], [500, 1800], [300, 2300], [500, 900], [350, 800]];
const ORGANS = [
  [1, 0, 0, 0, 0, 0], [1, 0.8, 0.6, 0.5, 0, 0], [1, 1, 1, 1, 0.8, 0.8], [0.6, 0.4, 0.9, 0.4, 0.8, 1]
];
const ORGAN_H = [1, 2, 3, 4, 6, 8];

const TABLES = [
  { name: 'BASIC', wave: (p, x) => {
    const s = Math.sin(TAU * p), t = triW(p + 0.25), w = sawW(p + 0.5), q = sqrW(p);
    if (x < 1 / 3) { const k = x * 3; return s * (1 - k) + t * k; }
    if (x < 2 / 3) { const k = x * 3 - 1; return t * (1 - k) + w * k; }
    const k = x * 3 - 2; return w * (1 - k) + q * k;
  } },
  { name: 'PWM', wave: (p, x) => { const w = 0.5 - 0.46 * x; return (frac(p) < w ? 1 : -1) - (2 * w - 1); } },
  { name: 'SYNC', wave: (p, x) => sawW(frac(p) * (1 + x * 6)) },
  { name: 'FORMANT', spec: (h, x) => {
    const c = 2 + x * 38;
    return gauss(h - c, 1.5 + c * 0.12) + (h === 1 ? 0.5 : 0);
  } },
  { name: 'VOWEL', spec: (h, x) => {
    const pos = x * (VOWELS.length - 1), i = Math.min(VOWELS.length - 2, pos | 0), f = pos - i;
    const f1 = (VOWELS[i][0] * (1 - f) + VOWELS[i + 1][0] * f) / 130;
    const f2 = (VOWELS[i][1] * (1 - f) + VOWELS[i + 1][1] * f) / 130;
    return gauss(h - f1, 1.2) + 0.7 * gauss(h - f2, 1.8) + 0.25 / h;
  } },
  { name: 'ORGAN', spec: (h, x) => {
    const k = ORGAN_H.indexOf(h);
    if (k < 0) return 0;
    const pos = x * (ORGANS.length - 1), i = Math.min(ORGANS.length - 2, pos | 0), f = pos - i;
    return ORGANS[i][k] * (1 - f) + ORGANS[i + 1][k] * f;
  } },
  { name: 'HARMONIC', spec: (h, x) => {
    const n = 1 + x * 31;
    return h <= n ? 1 / h : h - 1 < n ? (n - h + 1) / h : 0;
  } },
  { name: 'ODD', spec: (h, x) => {
    if (h % 2 === 0) return 0;
    return (1 / h) * (1 + 3 * gauss(h - (1 + x * 30), 2.5));
  } },
  { name: 'FOLD', wave: (p, x) => Math.sin(Math.sin(TAU * p) * (1 + x * 7) * Math.PI * 0.5) },
  { name: 'FM', wave: (p, x) => Math.sin(TAU * p + x * 5 * Math.sin(TAU * 2 * p)) },
  { name: 'DIGI', spec: (h, x) => {
    if (h >= 64) return 0;
    const pos = x * (DIGI_KEYS.length - 1), i = Math.min(DIGI_KEYS.length - 2, pos | 0), f = pos - i;
    return DIGI_KEYS[i][h] * (1 - f) + DIGI_KEYS[i + 1][h] * f;
  } },
  { name: 'BELL', wave: (p, x) => Math.sin(TAU * p + (0.2 + x * 3.5) * Math.sin(TAU * 7 * p)) },
  { name: 'GLASS', spec: (h, x) => {
    const o = Math.log2(h) - (0.5 + x * 4.5);
    return Math.exp(-o * o * 1.6) * (h === 1 ? 1.4 : 1) / Math.sqrt(h);
  } },
  { name: 'STRINGS', wave: (p, x) => (sawW(p) - sawW(p + 0.04 + x * 0.46)) * 0.5 },
  { name: 'CHIP', wave: (p, x) => {
    const levels = Math.pow(2, 5.5 - x * 4.5);
    const q = Math.floor(frac(p) * 32) / 32;
    return Math.round((x < 0.5 ? triW(q) : sqrW(q)) * levels) / levels;
  } },
  { name: 'NOISE', spec: (h, x) => (h < 400 ? NOISE_SPEC[h] * Math.pow(h, -(1.6 - x * 1.1)) : 0) }
];

/** One frame as a time-domain cycle of n samples (for drawing). */
function frameWave(t, x, n) {
  const tab = TABLES[t];
  const out = new Float32Array(n);
  if (tab.wave) {
    for (let i = 0; i < n; i++) out[i] = tab.wave(i / n, x);
  } else {
    for (let h = 1; h <= 40; h++) {
      const a = tab.spec(h, x);
      if (a < 1e-4) continue;
      for (let i = 0; i < n; i++) out[i] += a * Math.sin(TAU * h * i / n);
    }
  }
  let peak = 1e-6;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
}

/** In-place radix-2 complex FFT (inverse when inv). */
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? TAU : -TAU) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** Band-limited mip levels of table t: an array of Float32Array(FRAMES·N),
 *  every frame normalised to the same RMS. Runs on the page. */
function buildTable(t) {
  const N = TABLE_N, H = N / 2;
  const tab = TABLES[t];
  const mips = MIP_LIMITS.map(() => new Float32Array(FRAMES * N));
  const sre = new Float64Array(N), sim = new Float64Array(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < FRAMES; f++) {
    const x = f / (FRAMES - 1);
    sre.fill(0); sim.fill(0);
    if (tab.wave) {
      for (let i = 0; i < N; i++) { sre[i] = tab.wave(i / N, x); }
      fft(sre, sim, false);
    } else {
      for (let h = 1; h < H; h++) {
        const a = tab.spec(h, x);
        if (!a) continue;
        // sine phase: X[h] = -i·a·N/2, X[N-h] = conj
        sim[h] = -a * N / 2;
        sim[N - h] = a * N / 2;
      }
    }
    sre[0] = 0; sim[0] = 0;
    let norm = 0;
    MIP_LIMITS.forEach((limit, m) => {
      re.set(sre); im.set(sim);
      for (let h = limit + 1; h <= N - limit - 1; h++) { re[h] = 0; im[h] = 0; }
      fft(re, im, true);
      if (m === 0) {
        let s = 0;
        for (let i = 0; i < N; i++) s += re[i] * re[i];
        norm = 0.42 / (Math.sqrt(s / N) || 1);
      }
      const out = mips[m];
      for (let i = 0; i < N; i++) out[f * N + i] = re[i] * norm;
    });
  }
  return mips;
}

/* ── small DSP blocks ─────────────────────────────────────────────────── */
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];

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

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// envelope stage times from 0..1 knobs
const attackTime = (v) => 0.001 + Math.pow(v, 2.2) * 6;
const decayTime = (v) => 0.005 + Math.pow(v, 2.2) * 9;
const releaseTime = (v) => 0.005 + Math.pow(v, 2.2) * 12;
const FILTER_TYPES = ['LPF24', 'LPF12', 'HPF24', 'HPF12', 'BPF24', 'BPF12', 'VINTAGE'];
const LFO_WAVES = ['SIN', 'TRI', 'SAW', 'SQR', 'S&H', 'RND'];
// arpeggio step lengths, in 16ths: 1/8, 1/16, 1/8 triplet, 1/32
const ARP_RATES = [2, 1, 4 / 3, 0.5];

class Env {
  constructor() { this.stage = 0; this.v = 0; }   // 0 idle 1 attack 2 decay/sustain 3 release
  on() { this.stage = 1; }
  off() { if (this.stage) this.stage = 3; }
  /** advance n samples with settings {a,d,s,r} (0..1 knobs) */
  step(set, n, sr) {
    if (this.stage === 1) {
      this.v += n / (attackTime(set.a) * sr);
      if (this.v >= 1) { this.v = 1; this.stage = 2; }
    } else if (this.stage === 2) {
      const k = Math.exp(-n / (decayTime(set.d) * sr * 0.25));
      this.v = set.s + (this.v - set.s) * k;
    } else if (this.stage === 3) {
      this.v *= Math.exp(-n / (releaseTime(set.r) * sr * 0.25));
      if (this.v < 1e-4) { this.v = 0; this.stage = 0; }
    }
    return this.v;
  }
}

class Voice {
  constructor() {
    this.note = 60; this.vel = 1; this.on = false; this.age = 0; this.id = 0;
    this.freq = 261.6; this.target = 261.6;
    this.ph = [0, 0, 0, 0];           // L1 left, L1 right, L2 left, L2 right
    this.envO = new Env(); this.envF = new Env(); this.envA = new Env();
    this.s1 = [0, 0, 0, 0]; this.s2 = [0, 0, 0, 0];   // filter states (2 stages × ic1, ic2) L
    this.r1 = [0, 0, 0, 0]; this.r2 = [0, 0, 0, 0];   // R
    this.randPos = 0;
    this.offAt = -1;                  // sample count until a sequenced note-off
  }
  get active() { return this.envA.stage !== 0; }
}

const Processor = typeof AudioWorkletProcessor === 'function' ? AudioWorkletProcessor : class {};

class WavescapeProcessor extends Processor {
  constructor() {
    super();
    const sr = sampleRate;
    this.sr = sr;
    this.tables = [];               // [t] = mips
    this.voices = [];
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());
    this.nextId = 1;
    this.p = null;                  // patch
    this.lfoPhase = 0; this.lfoSH = 0; this.lfoRnd = 0; this.lfoRndT = 0;
    this.hpfL = 0; this.hpfR = 0;

    this.chorusL = new DelayLine(0.03, sr); this.chorusR = new DelayLine(0.03, sr); this.chorusPh = 0;
    this.delayL = new DelayLine(1.6, sr); this.delayR = new DelayLine(1.6, sr);
    const sc = sr / 44100;
    this.combL = COMBS.map((n) => new Comb(n * sc)); this.combR = COMBS.map((n) => new Comb((n + 23) * sc));
    this.apL = ALLPASSES.map((n) => new Allpass(n * sc)); this.apR = ALLPASSES.map((n) => new Allpass((n + 23) * sc));

    // sequencer / arpeggiator
    this.seq = null;
    this.playing = false;
    this.stepIndex = -1;
    this.stepCountdown = 0;         // samples to the next 16th
    this.tick = 0;                  // 16ths since start (for shuffle parity)
    this.seqVoices = [];            // voice ids started by the current step (for ties)
    this.arp = { on: false, type: 0, oct: 1, rate: 1, hold: false };
    this.held = [];                 // keys down (or latched), in press order
    this.latched = [];
    this.arpIndex = 0; this.arpCountdown = 0; this.arpVoice = 0;
    this.lastMod = { pos: 0, mix: 0 };
    this.meterCount = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(d) {
    if (!d || typeof d !== 'object') return;
    if (d.type === 'table' && Array.isArray(d.mips)) this.tables[d.index] = d.mips;
    else if (d.type === 'patch') this.p = d.patch;
    else if (d.type === 'seq') this.seq = d.seq;
    else if (d.type === 'transport') {
      if (d.play && !this.playing) { this.playing = true; this.stepIndex = -1; this.stepCountdown = 0; this.tick = 0; }
      else if (!d.play && this.playing) { this.playing = false; this.releaseSeq(); }
    } else if (d.type === 'arp') {
      const was = this.arp.on;
      this.arp = { ...this.arp, ...d.arp };
      if (!this.arp.hold) this.latched = [];
      if (was && !this.arp.on) this.releaseArp();
    } else if (d.type === 'note') {
      if (d.on) this.keyDown(d.note, d.vel || 100);
      else this.keyUp(d.note);
    } else if (d.type === 'panic') {
      for (const v of this.voices) { v.envA.stage = 0; v.envA.v = 0; v.on = false; }
    }
  }

  /* ── keys, arpeggio ─────────────────────────────────────────────────── */
  keyDown(note, vel) {
    if (this.arp.on) {
      if (this.arp.hold && this.held.length === 0) this.latched = [];
      if (!this.held.includes(note)) this.held.push(note);
      if (this.arp.hold && !this.latched.includes(note)) this.latched.push(note);
      if (this.arpNotes().length === 1) { this.arpIndex = 0; this.arpCountdown = 0; }
      return;
    }
    this.noteOn(note, vel / 127, -1);
  }
  keyUp(note) {
    this.held = this.held.filter((n) => n !== note);
    if (this.arp.on) {
      if (!this.arp.hold && this.held.length === 0) this.releaseArp();
      return;
    }
    for (const v of this.voices) if (v.on && v.note === note && v.offAt < 0) this.voiceOff(v);
  }
  arpNotes() {
    const base = (this.arp.hold ? this.latched : this.held).slice().sort((a, b) => a - b);
    const list = [];
    for (let o = 0; o < this.arp.oct; o++) for (const n of base) list.push(n + 12 * o);
    return list;
  }
  releaseArp() { for (const v of this.voices) if (v.on && v.arp) this.voiceOff(v); }
  releaseSeq() { for (const v of this.voices) if (v.on && v.seq) this.voiceOff(v); this.seqVoices = []; }

  /* ── voices ─────────────────────────────────────────────────────────── */
  noteOn(note, vel, lenSamples, tag) {
    const p = this.p;
    if (!p) return null;
    const freq = 440 * Math.pow(2, (note - 69) / 12);
    let v = null;
    if (!p.poly) {
      // solo: one voice, legato glide
      v = this.voices[0];
      for (let i = 1; i < this.voices.length; i++) if (this.voices[i].on) this.voiceOff(this.voices[i]);
      const legato = v.on;
      v.target = freq;
      if (!legato || !p.portaOn) v.freq = freq;
      v.note = note; v.vel = vel; v.on = true; v.offAt = lenSamples;
      v.seq = tag === 'seq'; v.arp = tag === 'arp';
      if (!legato) this.startVoice(v);
      return v;
    }
    for (const c of this.voices) if (!c.active) { v = c; break; }
    if (!v) { v = this.voices[0]; for (const c of this.voices) if (c.age > v.age) v = c; }
    const prev = this.lastFreq || freq;
    v.target = freq;
    v.freq = p.portaOn ? prev : freq;
    this.lastFreq = freq;
    v.note = note; v.vel = vel; v.on = true; v.offAt = lenSamples;
    v.seq = tag === 'seq'; v.arp = tag === 'arp';
    this.startVoice(v);
    return v;
  }
  startVoice(v) {
    const p = this.p;
    v.age = 0; v.id = this.nextId++;
    v.envO.on(); v.envF.on(); v.envA.on();
    v.randPos = (Math.random() - 0.5) * 2 * p.posRandom * 64;
    if (p.lfoKeyTrg) this.lfoPhase = 0;
    for (let i = 0; i < 4; i++) v.ph[i] = p.posRandom > 0 ? Math.random() : 0;
  }
  voiceOff(v) { v.on = false; v.offAt = -1; v.envO.off(); v.envF.off(); v.envA.off(); }

  /* ── sequencer clock ────────────────────────────────────────────────── */
  sixteenth() { return (60 / Math.max(30, this.seq ? this.seq.bpm : 120)) / 4 * this.sr; }

  runClock(n) {
    const seq = this.seq;
    if (this.playing && seq) {
      this.stepCountdown -= n;
      while (this.stepCountdown <= 0) {
        const len = Math.max(1, Math.min(64, seq.length | 0));
        this.stepIndex = (this.stepIndex + 1) % len;
        const s16 = this.sixteenth();
        // shuffle: even 16ths are long, odd ones short
        const sw = clamp(seq.shuffle || 0, 0, 0.9) * 0.5;
        const dur = s16 * (this.tick % 2 === 0 ? 1 + sw : 1 - sw);
        this.tick++;
        this.stepCountdown += dur;
        this.playStep(seq.steps[this.stepIndex], dur, this.stepIndex, len);
      }
    }
    if (this.arp.on) {
      const notes = this.arpNotes();
      if (notes.length) {
        this.arpCountdown -= n;
        while (this.arpCountdown <= 0) {
          const dur = this.sixteenth() * ARP_RATES[this.arp.rate | 0];
          this.arpCountdown += dur;
          let note;
          const L = notes.length;
          const i = this.arpIndex++;
          if (this.arp.type === 0) note = notes[i % L];
          else if (this.arp.type === 1) note = notes[L - 1 - (i % L)];
          else if (this.arp.type === 2) {
            const cyc = Math.max(1, 2 * L - 2), k = i % cyc;
            note = notes[k < L ? k : cyc - k];
          } else note = notes[(Math.random() * L) | 0];
          this.noteOn(note, 0.8, dur * 0.7, 'arp');
        }
      }
    }
  }

  playStep(step, dur, index, len) {
    // a tie from the previous step keeps its voices sounding
    if (!step || !step.on || !step.notes || !step.notes.length) { this.seqVoices = []; return; }
    const prev = index === 0 ? null : this.seq.steps[index - 1];
    if (step.tie && prev && prev.on && this.seqVoices.length) {
      for (const v of this.seqVoices) if (v.on) v.offAt = dur * clamp(step.gate, 0.05, 1);
      return;
    }
    const nextTie = this.seq.steps[(index + 1) % len];
    const tied = nextTie && nextTie.on && nextTie.tie;
    const gateLen = tied ? dur * 1.5 : dur * clamp(step.gate == null ? 0.5 : step.gate, 0.05, 1);
    this.seqVoices = [];
    for (const n of step.notes.slice(0, 8)) {
      const v = this.noteOn(n, (step.vel == null ? 100 : step.vel) / 127, gateLen, 'seq');
      if (v) this.seqVoices.push(v);
    }
  }

  /* ── LFO ────────────────────────────────────────────────────────────── */
  lfoValue(p, n) {
    const rate = 0.05 * Math.pow(600, p.lfoRate);      // 0.05 .. 30 Hz
    const prev = this.lfoPhase;
    this.lfoPhase = frac(this.lfoPhase + rate * n / this.sr);
    const ph = this.lfoPhase;
    if (ph < prev) this.lfoSH = Math.random() * 2 - 1;
    switch (p.lfoWave | 0) {
      case 1: return triW(ph + 0.25);
      case 2: return sawW(ph);
      case 3: return sqrW(ph);
      case 4: return this.lfoSH;
      case 5:
        this.lfoRnd += (this.lfoSH - this.lfoRnd) * Math.min(1, rate * n / this.sr * 4);
        return this.lfoRnd;
      default: return Math.sin(TAU * ph);
    }
  }

  /* ── audio ──────────────────────────────────────────────────────────── */
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out.length > 1 ? out[1] : out[0];
    const frames = L.length;
    L.fill(0); R.fill(0);
    const p = this.p;
    if (!p) return true;
    const sr = this.sr;

    for (let off = 0; off < frames; off += SUB) {
      const n = Math.min(SUB, frames - off);
      this.runClock(n);
      const lfo = this.lfoValue(p, n);
      for (const v of this.voices) {
        if (!v.active) continue;
        if (v.on && v.offAt >= 0) { v.offAt -= n; if (v.offAt <= 0) this.voiceOff(v); }
        this.renderVoice(v, p, lfo, L, R, off, n);
      }
    }
    this.effects(p, L, R, frames);

    if (++this.meterCount >= 12) {
      this.meterCount = 0;
      let peak = 0;
      for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      this.port.postMessage({
        type: 'meter', step: this.playing ? this.stepIndex : -1, peak,
        pos: this.lastMod.pos, mix: this.lastMod.mix,
        voices: this.voices.filter((v) => v.active).length
      });
    }
    return true;
  }

  renderVoice(v, p, lfo, L, R, off, n) {
    const sr = this.sr;
    const tA = this.tables[p.wave1 | 0], tB = this.tables[p.wave2 | 0];
    // envelopes (control rate)
    const eO = v.envO.step(p.envO, n, sr);
    const eF = v.envF.step(p.envF, n, sr);
    const eA = v.envA.step(p.envA, n, sr);
    v.age += n;
    // LFO fades in over its delay time, per voice
    const lfoDelay = p.lfoDelay * 4 * sr;
    const lfoV = lfo * (lfoDelay > 0 ? Math.min(1, v.age / lfoDelay) : 1);

    // glide
    if (v.freq !== v.target) {
      const k = Math.exp(-n / (Math.max(0.002, p.porta * p.porta * 2) * sr));
      v.freq = v.target + (v.freq - v.target) * k;
    }
    const range = [-1, 0, 1, 2][p.range | 0] ?? 0;
    const f = v.freq * Math.pow(2, range + (lfoV * p.pitchLfo * 2) / 12);
    const f2 = f * Math.pow(2, p.l2oct | 0);

    const pos = clamp(p.position + v.randPos + eO * p.posEnv * 127 + lfoV * p.posLfo * 64, 0, 127);
    const mix = clamp(p.layerMix + eO * p.mixEnv + lfoV * p.mixLfo * 0.5, 0, 1);
    const shape = clamp(p.shaper + eO * p.wsEnv + Math.abs(lfoV) * p.wsLfo * 0.5, 0, 1);
    if (v === this.voices[0] || v.age < 4096) this.lastMod = { pos, mix };

    // filter cutoff: 20 Hz .. 18 kHz, env ±6 octaves, LFO ±3, keyboard tracking
    const oct = p.cutoff * 9.8 + p.fenv * eF * 6 + lfoV * p.flfo * 3 + p.kybd * (v.note - 60) / 12;
    const fc = clamp(20 * Math.pow(2, oct), 20, sr * 0.45);
    const g = Math.tan(Math.PI * fc / sr);
    const vintage = (p.ftype | 0) === 6;
    const kq = 2 - 1.96 * clamp(p.res, 0, 1) * (vintage ? 1.02 : 1);
    const a1 = 1 / (1 + g * (g + kq)), a2 = g * a1, a3 = g * a2;
    const type = FILTER_TYPES[p.ftype | 0] || 'LPF24';
    const stages = type.endsWith('24') || vintage ? 2 : 1;
    const mode = type[0];                                     // L, H, B, V
    const drive = 1 + (p.drive | 0) * 1.6;
    const tremolo = 1 - p.lfoAmp * 0.5 * (1 + lfoV);
    const gain = eA * v.vel * p.level * tremolo * 0.85;

    // wavetable read setup
    const fpos = (pos / 127) * (FRAMES - 1);
    const fr0 = Math.min(FRAMES - 2, fpos | 0), ff = fpos - fr0;
    const mipFor = (freq) => {
      const maxH = (0.45 * sr) / freq;
      let m = 0;
      while (m < MIP_LIMITS.length - 1 && MIP_LIMITS[m] > maxH) m++;
      return m;
    };
    const A = tA ? tA[mipFor(f)] : null, B = tB ? tB[mipFor(f2)] : null;
    const spread = p.spread;
    const det = spread * 0.012;              // up to ±20 cents between L and R
    const incs = [(f * (1 - det)) / sr, (f * (1 + det)) / sr, (f2 * (1 - det)) / sr, (f2 * (1 + det)) / sr];
    const stereo = spread > 0.01;
    const base0 = fr0 * TABLE_N, base1 = base0 + TABLE_N;
    const read = (tab, ph) => {
      const x = ph * TABLE_N, i0 = x | 0, fx = x - i0, i1 = (i0 + 1) & (TABLE_N - 1);
      const s0 = tab[base0 + i0] + (tab[base0 + i1] - tab[base0 + i0]) * fx;
      const s1 = tab[base1 + i0] + (tab[base1 + i1] - tab[base1 + i0]) * fx;
      return s0 + (s1 - s0) * ff;
    };
    const wsDrive = 1 + shape * 5;
    const wsNorm = 1 / Math.sin(Math.min(Math.PI / 2, wsDrive * 0.6));
    const s1 = v.s1, s2 = v.s2, r1 = v.r1, r2 = v.r2;
    const ph = v.ph;

    for (let i = 0; i < n; i++) {
      let xl = 0, xr = 0;
      if (A) {
        const a = read(A, ph[0]);
        xl += a * (1 - mix);
        xr += (stereo ? read(A, ph[1]) : a) * (1 - mix);
      }
      if (B) {
        const b = read(B, ph[2]);
        xl += b * mix;
        xr += (stereo ? read(B, ph[3]) : b) * mix;
      }
      ph[0] += incs[0]; if (ph[0] >= 1) ph[0] -= 1;
      ph[2] += incs[2]; if (ph[2] >= 1) ph[2] -= 1;
      if (stereo) {
        ph[1] += incs[1]; if (ph[1] >= 1) ph[1] -= 1;
        ph[3] += incs[3]; if (ph[3] >= 1) ph[3] -= 1;
      }
      // wave shaper: a sine transfer curve, harder with the amount
      if (shape > 0.005) {
        xl = xl * (1 - shape) + Math.sin(xl * wsDrive * 0.6) * wsNorm * shape * 0.8;
        xr = xr * (1 - shape) + Math.sin(xr * wsDrive * 0.6) * wsNorm * shape * 0.8;
      }
      if (drive > 1) { xl = Math.tanh(xl * drive) / Math.sqrt(drive); xr = Math.tanh(xr * drive) / Math.sqrt(drive); }
      // TPT state-variable filter, one or two stages
      let yl = xl, yr = xr;
      for (let s = 0; s < stages; s++) {
        const o = s * 2;
        let v3 = yl - s2[o + 1];
        let v1 = a1 * s1[o] + a2 * v3, v2 = s2[o + 1] + a2 * s1[o] + a3 * v3;
        s1[o] = 2 * v1 - s1[o]; s2[o + 1] = 2 * v2 - s2[o + 1];
        yl = mode === 'H' ? yl - kq * v1 - v2 : mode === 'B' ? v1 : v2;
        if (vintage) yl = Math.tanh(yl * 1.2);
        v3 = yr - r2[o + 1];
        v1 = a1 * r1[o] + a2 * v3; v2 = r2[o + 1] + a2 * r1[o] + a3 * v3;
        r1[o] = 2 * v1 - r1[o]; r2[o + 1] = 2 * v2 - r2[o + 1];
        yr = mode === 'H' ? yr - kq * v1 - v2 : mode === 'B' ? v1 : v2;
        if (vintage) yr = Math.tanh(yr * 1.2);
      }
      L[off + i] += yl * gain;
      R[off + i] += yr * gain;
    }
  }

  effects(p, L, R, frames) {
    const sr = this.sr;
    // non-resonant HPF
    const hc = 1 - Math.exp(-TAU * (20 * Math.pow(60, p.hpf)) / sr);
    // chorus I / II (two modulated taps, opposite phases)
    const ch = p.chorus | 0;
    const chRate = ch === 2 ? 0.83 : 0.5, chDepth = (ch === 2 ? 0.0035 : 0.0022) * sr, chBase = 0.006 * sr;
    // delay
    const dTime = Math.max(1, (0.03 + p.delayTime * 1.17) * sr);
    const dFb = clamp(p.delayFb, 0, 0.92), dMix = p.delay * 0.6;
    // reverb
    const rMix = p.reverb * 0.5;
    const rFb = 0.7 + clamp(p.reverbTime, 0, 1) * 0.28;
    for (let i = 0; i < frames; i++) {
      let l = L[i], r = R[i];
      this.hpfL += (l - this.hpfL) * hc; this.hpfR += (r - this.hpfR) * hc;
      l -= this.hpfL; r -= this.hpfR;
      if (ch) {
        this.chorusPh += chRate / sr; if (this.chorusPh >= 1) this.chorusPh -= 1;
        const m = Math.sin(TAU * this.chorusPh);
        this.chorusL.write(l); this.chorusR.write(r);
        const wl = this.chorusL.read(chBase + chDepth * (1 + m));
        const wr = this.chorusR.read(chBase + chDepth * (1 - m));
        l = l * 0.7 + wl * 0.6; r = r * 0.7 + wr * 0.6;
      }
      if (dMix > 0.001) {
        const dl = this.delayL.read(dTime), dr = this.delayR.read(dTime);
        this.delayL.write(l + dr * dFb);
        this.delayR.write(r * 0.3 + dl * dFb);
        l += dl * dMix; r += dr * dMix;
      } else { this.delayL.write(0); this.delayR.write(0); }
      if (rMix > 0.001) {
        const inp = (l + r) * 0.015;
        let wl = 0, wr = 0;
        for (let c = 0; c < 8; c++) { wl += this.combL[c].process(inp, rFb, 0.3); wr += this.combR[c].process(inp, rFb, 0.3); }
        for (let a = 0; a < 4; a++) { wl = this.apL[a].process(wl); wr = this.apR[a].process(wr); }
        l += wl * rMix; r += wr * rMix;
      }
      // gentle limiter
      L[i] = Math.tanh(l * 1.1) * 0.9;
      R[i] = Math.tanh(r * 1.1) * 0.9;
    }
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('wavescape', WavescapeProcessor);
} else if (typeof globalThis !== 'undefined') {
  globalThis.WavescapeTables = { TABLES, FRAMES, TABLE_N, buildTable, frameWave, FILTER_TYPES, LFO_WAVES };
}
