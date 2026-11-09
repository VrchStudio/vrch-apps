/* Botanica Engine — AudioWorklet (植物系 / petalcore).
 *
 * Instruments: felt piano ↔ glass ↔ music-box keys (additive), string/air pad,
 * formant vocal chops & choir, sub bass, soft/organic drums, ASMR foley
 * (droplets, glass tinks, twigs, leaves, seeds, fuurin chimes, bamboo) and a
 * living ambience bed (wind, rain on leaves, birds).
 *
 * Processing: tape wobble + bitcrush, beat-repeat style stutters, tape stops,
 * reverses, granular cloud & granular "spectral" freeze, multiband-style
 * sidechain pump, ping-pong echo and an octave shimmer reverb.
 *
 * Arrangement: a sample-accurate arranger that moves through dawn → bloom →
 * canopy → glitch → canopy → petal-fall, over Royal-Road–style progressions
 * with 7ths/9ths, a motif-based melody, glass arpeggios, vocal gestures,
 * organic percussion and quantized glitch events. */
'use strict';

const SR = sampleRate;
const TWO_PI = Math.PI * 2;
const TS = 4096;
const SIN = new Float32Array(TS + 1);
for (let i = 0; i <= TS; i++) SIN[i] = Math.sin((i / TS) * TWO_PI);
function sn(ph) { ph -= Math.floor(ph); const x = ph * TS, i = x | 0; return SIN[i] + (SIN[i + 1] - SIN[i]) * (x - i); }
let ns = 0x2545f491;
function rnd() { ns ^= ns << 13; ns ^= ns >>> 17; ns ^= ns << 5; return (ns >>> 0) / 4294967296; }
function noise() { return rnd() * 2 - 1; }
function sat(x) { if (x > 3) return 1; if (x < -3) return -1; const x2 = x * x; return x * (27 + x2) / (27 + 9 * x2); }
function blep(t, dt) { if (t < dt) { t /= dt; return t + t - t * t - 1; } if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; } return 0; }
const MTOF = new Float32Array(160);
for (let i = 0; i < 160; i++) MTOF[i] = 440 * Math.pow(2, (i - 69) / 12);
const mtof = (m) => MTOF[Math.max(0, Math.min(159, Math.round(m)))] * Math.pow(2, (m - Math.round(m)) / 12);
function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* ── harmony ──────────────────────────────────────────────────────────── */
const Q = {
  M7: [0, 4, 7, 11], M9: [0, 4, 7, 11, 14], add9: [0, 4, 7, 14], D7: [0, 4, 7, 10], m7: [0, 3, 7, 10],
  m9: [0, 3, 7, 10, 14], sus4: [0, 5, 7, 10], s2: [0, 2, 7, 14], L: [0, 4, 7, 11, 18], m11: [0, 3, 7, 10, 17],
  madd9: [0, 3, 7, 14], hd7: [0, 3, 6, 10],
};
// [root semitone above key, quality]
const PROGS = [
  [[5, 'M7'], [7, 'D7'], [4, 'm7'], [9, 'm9']],                                              // Royal Road  IV–V–iii–vi
  [[5, 'M9'], [7, 'add9'], [9, 'm9'], [0, 'M7']],                                            // Hope        IV–V–vi–I
  [[5, 'M7'], [7, 'sus4'], [4, 'm7'], [9, 'm7'], [2, 'm9'], [7, 'sus4'], [0, 'M9'], [0, 'L']], // Sunbeam
  [[0, 'M9'], [2, 'add9'], [9, 'm9'], [5, 'L']],                                             // Lydian float
  [[0, 'add9'], [7, 'add9'], [9, 'm7'], [4, 'm7'], [5, 'M7'], [0, 'add9'], [5, 'M9'], [7, 'sus4']], // Canon
  [[9, 'm9'], [5, 'M7'], [0, 'add9'], [7, 'sus4']],                                          // Tide
  [[5, 'M7'], [4, 'D7'], [9, 'm9'], [7, 'm7']],                                              // Just spring
  [[0, 'M9'], [5, 'L'], [0, 'M9'], [5, 'L']],                                                // Environmental
];
const MAJ = [0, 2, 4, 5, 7, 9, 11];
const MIN = [0, 2, 3, 5, 7, 8, 10];
// Re-voice a major-key progression in the parallel natural minor (V7 kept for a harmonic-minor cadence).
const MIN_ROOT = { 0: 0, 2: 2, 4: 3, 5: 5, 7: 7, 9: 8, 11: 10 };
const TO_MINOR = { M7: 'm7', M9: 'm9', add9: 'madd9', L: 'm11' };
const TO_MAJOR = { m7: 'M7', m9: 'M9', m11: 'M9' };
function toMinor([root, q]) {
  const r = MIN_ROOT[root] ?? root;
  if (r === 2) return [r, 'hd7'];                                   // ii∅
  if (r === 0 || r === 5 || r === 7) return [r, TO_MINOR[q] || q];  // i, iv, v
  if (r === 8 && q === 'm11') return [r, 'L'];                      // bVI lydian is diatonic
  if (r === 10 && q === 'm7') return [r, 'D7'];                     // bVII7
  return [r, TO_MAJOR[q] || q];                                     // bIII, bVI, bVII
}
const MPROGS = PROGS.map((p) => p.map(toMinor));

/* ── form ─────────────────────────────────────────────────────────────── */
//            mel  arp  pad  vox  bass fol  drm  glitch freeze amb  choir
const SECT = {
  dawn:   { id: 0, mel: .35, arp: 0, pad: 1, vox: .5, bass: .45, fol: .5, drm: 0, g: .45, z: 1.2, amb: 1.3, choir: 1 },
  bloom:  { id: 1, mel: .85, arp: .55, pad: .8, vox: .55, bass: .8, fol: .85, drm: .5, g: .8, z: .5, amb: .9, choir: 0 },
  canopy: { id: 2, mel: 1, arp: 1, pad: .85, vox: 1, bass: 1, fol: 1, drm: 1, g: 1, z: .3, amb: .55, choir: 0 },
  glitch: { id: 3, mel: .55, arp: .7, pad: .6, vox: .6, bass: .3, fol: .7, drm: .2, g: 2.4, z: 1.8, amb: .7, choir: 0 },
  petal:  { id: 4, mel: .6, arp: .15, pad: .8, vox: .35, bass: .5, fol: .5, drm: 0, g: .4, z: .8, amb: 1.3, choir: 1 },
};

/* ── keys: additive felt piano ↔ glass ↔ music box ─────────────────────── */
const PART = {
  piano: { r: [1, 2.002, 3.006, 4.012, 5.03], a: [1, .42, .22, .12, .07], d: [1, .72, .52, .4, .3] },
  glass: { r: [1, 2.756, 5.404, 8.933, 13.34], a: [1, .5, .3, .17, .1], d: [1, .62, .42, .3, .22] },
  box:   { r: [1, 4.07, 2.0, 8.2, 11.6], a: [1, .34, .2, .11, .05], d: [1, .5, .8, .3, .2] },
};
class Keys {
  constructor() {
    this.on = false; this.ph = new Float64Array(5); this.inc = new Float64Array(5);
    this.amp = new Float32Array(5); this.dec = new Float32Array(5); this.id = -1;
  }
  start(id, midi, vel, timbre, P, gate, off) {
    const f = mtof(midi);
    let A, B, t;
    if (timbre < 0.5) { A = PART.piano; B = PART.glass; t = timbre * 2; } else { A = PART.glass; B = PART.box; t = (timbre - 0.5) * 2; }
    const T60 = (0.45 + Math.pow(P.sustain, 1.4) * 7.5) * Math.pow(261.6 / f, 0.35);
    const br = 0.25 + P.bright * 0.75;
    for (let k = 0; k < 5; k++) {
      const r = A.r[k] + (B.r[k] - A.r[k]) * t;
      const a = A.a[k] + (B.a[k] - A.a[k]) * t;
      const d = A.d[k] + (B.d[k] - A.d[k]) * t;
      this.inc[k] = f * r / SR;
      this.amp[k] = this.inc[k] < 0.45 ? a * vel * Math.pow(br, k) : 0;
      this.dec[k] = Math.exp(-6.9 / (T60 * d * SR));
      if (!this.on) this.ph[k] = rnd();
    }
    this.att = this.on ? this.att * 0.5 : 0;
    this.attInc = 1 / (SR * (0.0015 + P.soft * P.soft * 0.09));
    this.hn = (1 - P.soft * 0.8) * 0.35 * vel; this.hdec = Math.exp(-1 / (SR * 0.005)); this.hlp = 0;
    this.lpA = 1 - Math.exp(-TWO_PI * Math.min(SR * 0.42, f * (2.5 + P.bright * 16) + 400) / SR);
    this.lp = this.on ? this.lp : 0;
    this.rel = Math.exp(-1 / (SR * (0.12 + P.sustain * 0.9)));
    this.releasing = false; this.gate = gate; this.age = 0; this.id = id; this.on = true; this.off = off;
    this.pan = 0.5 + (Math.min(1, Math.max(0, (midi - 48) / 48)) - 0.5) * 0.6;
  }
  release() { this.releasing = true; }
  render(L, R, N, g) {
    const ph = this.ph, inc = this.inc, amp = this.amp, dec = this.dec;
    let att = this.att, hn = this.hn, hlp = this.hlp, lp = this.lp, e = 0;
    const lpA = this.lpA, rel = this.rel, hdec = this.hdec, attInc = this.attInc;
    const pl = (1 - this.pan) * g, pr = this.pan * g;
    for (let i = this.off; i < N; i++) {
      if (!this.releasing && this.gate > 0 && this.age >= this.gate) this.releasing = true;
      this.age++;
      if (att < 1) { att += attInc; if (att > 1) att = 1; }
      let s = 0;
      for (let k = 0; k < 5; k++) {
        const p = ph[k]; const x = p * TS - Math.floor(p) * TS; const j = x | 0;
        s += (SIN[j] + (SIN[j + 1] - SIN[j]) * (x - j)) * amp[k];
        ph[k] = p + inc[k]; amp[k] *= this.releasing ? dec[k] * rel : dec[k];
      }
      hlp += (noise() * hn - hlp) * 0.18; hn *= hdec;
      lp += (s * att + hlp - lp) * lpA;
      L[i] += lp * pl; R[i] += lp * pr; e += lp * lp * g * g;
    }
    for (let k = 0; k < 5; k++) ph[k] -= Math.floor(ph[k]);
    this.att = att; this.hn = hn; this.hlp = hlp; this.lp = lp; this.off = 0;
    if (amp[0] + amp[1] + amp[2] < 1e-4) { this.on = false; this.id = -1; }
    return e;
  }
}

/* ── pad: two soft saws + sub, slow filter ─────────────────────────────── */
class Pad {
  constructor() { this.on = false; this.ph1 = 0; this.ph2 = 0; this.ph3 = 0; this.l = 0; this.b = 0; this.env = 0; }
  start(midi, vel, P, gate, off) {
    this.f = mtof(midi); this.vel = vel; this.gate = gate; this.age = 0; this.off = off;
    this.stage = 1; this.on = true;
    this.att = 1 / (SR * (0.35 + P.soft * 2.2)); this.relc = Math.exp(-1 / (SR * (0.9 + P.sustain * 2.5)));
    this.pan = 0.2 + rnd() * 0.6;
  }
  release() { this.stage = 3; }
  render(L, R, N, P, lfo) {
    const d1 = this.f * (1.0045 + lfo * 0.002) / SR, d2 = this.f * (0.9958 - lfo * 0.002) / SR, d3 = this.f * 0.5 / SR;
    const fc = Math.min(0.9, 2 * Math.sin(Math.PI * Math.min(SR * 0.2, 260 + P.bright * P.bright * 4200 + this.f * 1.5) / SR));
    let { ph1, ph2, ph3, l, b, env } = this;
    const g = this.vel * 0.085, pl = 1 - this.pan, pr = this.pan;
    let e = 0;
    for (let i = this.off; i < N; i++) {
      if (this.stage === 1) { env += this.att; if (env >= 1) { env = 1; this.stage = 2; } }
      else if (this.stage === 3) { env *= this.relc; if (env < 1e-4) { env = 0; this.on = false; break; } }
      if (this.stage < 3 && this.gate > 0 && this.age >= this.gate) this.stage = 3;
      this.age++;
      ph1 += d1; if (ph1 >= 1) ph1 -= 1; ph2 += d2; if (ph2 >= 1) ph2 -= 1; ph3 += d3; if (ph3 >= 1) ph3 -= 1;
      const x = (2 * ph1 - 1 - blep(ph1, d1)) + (2 * ph2 - 1 - blep(ph2, d2)) + sn(ph3) * 0.6;
      l += fc * b; const h = x - l - 0.9 * b; b += fc * h;
      const y = l * env * g;
      L[i] += y * pl; R[i] += y * pr; e += y * y;
    }
    Object.assign(this, { ph1, ph2, ph3, l, b, env }); this.off = 0;
    return e;
  }
}

/* ── vocal: formant chops & choir ─────────────────────────────────────── */
const VOWELS = [[800, 1150, 2900], [350, 2000, 2800], [270, 2140, 2950], [450, 800, 2830], [325, 700, 2700]];
class Vox {
  constructor() { this.on = false; this.ph = 0; this.fl = new Float32Array(3); this.fb = new Float32Array(3); this.fs = new Float32Array(3); this.env = 0; }
  start(midi, vel, vowel, choir, gate, off, glideFrom) {
    this.f = mtof(midi); this.f0 = glideFrom ? mtof(glideFrom) : this.f * 0.94; this.vel = vel;
    this.vA = VOWELS[vowel % 5]; this.vB = VOWELS[(vowel + 1 + (choir ? 2 : 0)) % 5];
    this.choir = choir; this.gate = gate; this.age = 0; this.off = off; this.on = true; this.stage = 1;
    this.att = 1 / (SR * (choir ? 0.45 : 0.008)); this.relc = Math.exp(-1 / (SR * (choir ? 0.7 : 0.05)));
    this.pan = 0.3 + rnd() * 0.4;
  }
  release() { this.stage = 3; }
  render(L, R, N, shift, vibPh, gain) {
    const fl = this.fl, fb = this.fb;
    let ph = this.ph, env = this.env;
    // per-block formant morph and pitch glide
    const k = Math.min(1, this.age / (SR * (this.choir ? 1.6 : 0.18)));
    const fs = this.fs, q = this.choir ? 0.07 : 0.1;
    for (let j = 0; j < 3; j++) fs[j] = Math.min(0.95, 2 * Math.sin(Math.PI * Math.min(SR * 0.2, (this.vA[j] + (this.vB[j] - this.vA[j]) * k) * shift) / SR));
    const glide = Math.min(1, this.age / (SR * 0.06));
    const vib = 1 + Math.sin(vibPh) * 0.0045 * Math.min(1, this.age / (SR * 0.25));
    const f = (this.f0 + (this.f - this.f0) * glide) * vib, dt = f / SR;
    const g = this.vel * (this.choir ? 0.11 : 0.16) * gain, pl = 1 - this.pan, pr = this.pan;
    let e = 0;
    for (let i = this.off; i < N; i++) {
      if (this.stage === 1) { env += this.att; if (env >= 1) { env = 1; this.stage = 2; } }
      else if (this.stage === 3) { env *= this.relc; if (env < 1e-4) { env = 0; this.on = false; break; } }
      if (this.stage < 3 && this.gate > 0 && this.age >= this.gate) this.stage = 3;
      this.age++;
      ph += dt; if (ph >= 1) ph -= 1;
      const src = (2 * ph - 1 - blep(ph, dt)) + noise() * 0.12;
      let y = 0;
      fl[0] += fs[0] * fb[0]; let h = src - fl[0] - q * fb[0]; fb[0] += fs[0] * h; y += fb[0];
      fl[1] += fs[1] * fb[1]; h = src - fl[1] - q * fb[1]; fb[1] += fs[1] * h; y += fb[1] * 0.55;
      fl[2] += fs[2] * fb[2]; h = src - fl[2] - q * fb[2]; fb[2] += fs[2] * h; y += fb[2] * 0.3;
      y *= env * g * 1.4;
      L[i] += y * pl; R[i] += y * pr; e += y * y;
    }
    this.ph = ph; this.env = env; this.off = 0;
    return e;
  }
}

/* ── one-shots: drums and foley ───────────────────────────────────────── */
// drum kinds: 0 kick, 1 snare, 2 clap, 3 hat, 4 open hat, 5 thump (organic kick)
// foley kinds: 10 drop, 11 tink, 12 twig, 13 leaves, 14 pop, 15 seeds, 16 chime, 17 bamboo, 18 swell
class Shot {
  constructor() { this.on = false; }
  start(kind, f, vel, pan, off, dur) {
    this.kind = kind; this.f = f; this.vel = vel; this.pan = pan; this.off = off; this.t = 0; this.on = true;
    this.ph = 0; this.ph2 = rnd(); this.ph3 = rnd(); this.l = 0; this.b = 0; this.h1 = 0; this.h2 = 0; this.ge = 0;
    this.dur = dur || 0;
  }
  render(L, R, N) {
    const pl = 1 - this.pan, pr = this.pan, v = this.vel, kind = this.kind;
    let e = 0;
    for (let i = this.off; i < N; i++) {
      const t = this.t / SR; this.t++;
      let y = 0;
      switch (kind) {
        case 0: { const f = 46 + 125 * Math.exp(-t / 0.028); this.ph += f / SR; y = sn(this.ph) * Math.exp(-t / 0.3) + noise() * Math.exp(-t / 0.0018) * 0.25; if (t > 0.9) this.on = false; break; }
        case 5: { const f = 60 + 70 * Math.exp(-t / 0.02); this.ph += f / SR; y = sn(this.ph) * Math.exp(-t / 0.12) * 0.8; this.l += (noise() - this.l) * 0.05; y += this.l * Math.exp(-t / 0.02) * 0.6; if (t > 0.5) this.on = false; break; }
        case 1: { this.ph += 185 / SR; const n = noise(); this.l += 0.55 * this.b; const h = n - this.l - 0.5 * this.b; this.b += 0.55 * h; y = sn(this.ph) * Math.exp(-t / 0.05) * 0.45 + this.b * Math.exp(-t / 0.13) * 0.7; if (t > 0.6) this.on = false; break; }
        case 2: { const n = noise(); this.l += 0.42 * this.b; const h = n - this.l - 0.35 * this.b; this.b += 0.42 * h; const b1 = Math.exp(-t / 0.006) + (t > 0.009 ? Math.exp(-(t - 0.009) / 0.006) : 0) + (t > 0.019 ? Math.exp(-(t - 0.019) / 0.09) : 0); y = this.b * b1 * 0.55; if (t > 0.5) this.on = false; break; }
        case 3: case 4: { const n = noise(); this.h1 += (n - this.h1) * 0.55; this.h2 += ((n - this.h1) - this.h2) * 0.5; y = ((n - this.h1) - this.h2) * Math.exp(-t / (kind === 3 ? 0.03 : 0.2)) * 0.5; if (t > (kind === 3 ? 0.2 : 0.8)) this.on = false; break; }
        case 10: { const f = this.f * (1 + 1.6 * (1 - Math.exp(-t / 0.011))); this.ph += f / SR; y = sn(this.ph) * Math.min(1, t / 0.0015) * Math.exp(-t / 0.045) * 0.55; if (t > 0.3) this.on = false; break; }
        case 11: { this.ph += this.f / SR; this.ph2 += this.f * 2.32 / SR; this.ph3 += this.f * 4.25 / SR; const en = Math.exp(-t / 0.22); y = (sn(this.ph) + sn(this.ph2) * 0.55 * en + sn(this.ph3) * 0.3 * en * en) * en * 0.28; if (t > 1.2) this.on = false; break; }
        case 12: { const ex = t < 0.0012 ? noise() : 0; const fc = 2 * Math.sin(Math.PI * this.f / SR); this.l += fc * this.b; const h = ex - this.l - 0.03 * this.b; this.b += fc * h; y = this.b * 0.5 * Math.exp(-t / 0.03); if (t > 0.15) this.on = false; break; }
        case 13: { if ((this.t & 127) === 0) this.ge = rnd() < 0.45 ? rnd() : this.ge * 0.3; const n = noise(); this.l += 0.75 * this.b; const h = n - this.l - 0.6 * this.b; this.b += 0.75 * h; const sh = Math.sin(Math.PI * Math.min(1, t / this.dur)); y = this.b * this.ge * sh * 0.5; if (t > this.dur) this.on = false; break; }
        case 14: { const f = this.f * (0.6 + 0.8 * Math.exp(-t / 0.008)); this.ph += f / SR; y = sn(this.ph) * Math.exp(-t / 0.02) * 0.5; if (t > 0.12) this.on = false; break; }
        case 15: { const n = noise(); this.h1 += (n - this.h1) * 0.35; y = (n - this.h1) * Math.min(1, t / 0.004) * Math.exp(-t / 0.035) * 0.45; if (t > 0.2) this.on = false; break; }
        case 16: { this.ph += this.f / SR; this.ph2 += this.f * 2.76 * 1.002 / SR; this.ph3 += this.f * 5.4 / SR; const en = Math.exp(-t / 1.4); y = (sn(this.ph) + sn(this.ph2) * 0.4 * Math.exp(-t / 0.5) + sn(this.ph3) * 0.2 * Math.exp(-t / 0.25)) * en * 0.2 * Math.min(1, t / 0.002); if (t > 4) this.on = false; break; }
        case 17: { this.ph += this.f / SR; this.ph2 += this.f * 2.92 / SR; y = (sn(this.ph) * Math.exp(-t / 0.16) + sn(this.ph2) * 0.35 * Math.exp(-t / 0.05)) * 0.4 + noise() * Math.exp(-t / 0.002) * 0.15; if (t > 0.7) this.on = false; break; }
        case 18: { // reverse swell into a section change
          const k = Math.min(1, t / this.dur), n = noise();
          const fc = Math.min(0.9, 2 * Math.sin(Math.PI * (200 + k * k * 7000) / SR));
          this.l += fc * this.b; const h = n - this.l - 0.5 * this.b; this.b += fc * h;
          this.ph += this.f / SR; y = (this.b * 0.5 + sn(this.ph) * 0.25) * k * k * k * 0.5;
          if (t >= this.dur) this.on = false; break; }
        default: this.on = false;
      }
      y *= v;
      L[i] += y * pl; R[i] += y * pr; e += y * y;
      if (!this.on) break;
    }
    this.off = 0;
    return e;
  }
}

class Grain {
  constructor() { this.on = false; }
}

const Base = typeof AudioWorkletProcessor === 'function' ? AudioWorkletProcessor : class {};

class BotanicaEngine extends Base {
  constructor() {
    super();
    this.keys = Array.from({ length: 10 }, () => new Keys());
    this.pads = Array.from({ length: 5 }, () => new Pad());
    this.vox = Array.from({ length: 3 }, () => new Vox());
    this.shots = Array.from({ length: 14 }, () => new Shot());
    this.grains = Array.from({ length: 12 }, () => new Grain());
    this.bass = { on: false, ph: 0, f: 55, tf: 55, env: 0, stage: 0, gate: 0, age: 0, l: 0, vel: 0.8, off: 0 };
    this.P = {
      timbre: 0.15, bright: 0.55, soft: 0.5, sustain: 0.5, glitch: 0.35, grain: 0.3, freeze: 0.3, crush: 0.2,
      keys: 0.8, voice: 0.6, foley: 0.6, beat: 0.6, shimmer: 0.5, echo: 0.35, ambience: 0.5, bass: 0.6, volume: 0.8,
    };
    this.S = { on: false, bpm: 92, energy: 0.6, evolve: 0.5, seed: 7, key: 0, mode: 0, prog: 0, melody: 0.6 };
    // buses
    this.mL = new Float32Array(128); this.mR = new Float32Array(128);
    this.dL = new Float32Array(128); this.dR = new Float32Array(128);
    this.aL = new Float32Array(128); this.aR = new Float32Array(128);
    this.xL = new Float32Array(128); this.xR = new Float32Array(128);
    this.zN = Math.round(SR * 0.7); this.zL = new Float32Array(this.zN); this.zR = new Float32Array(this.zN);
    this.yL = new Float32Array(128); this.yR = new Float32Array(128);
    this.gL = new Float32Array(128); this.gR = new Float32Array(128);
    // capture buffer for repeat / grains
    this.GN = 1 << 17; this.cL = new Float32Array(this.GN); this.cR = new Float32Array(this.GN); this.cw = 0;
    this.rep = { on: false, kind: 0, start: 0, len: 0, pos: 0, rate: 1, rate1: 1, t: 0, dur: 0, mix: 0, fade: 0 };
    this.frz = { on: false, pos: 0, until: 0, mix: 0 };
    this.grainClock = 0;
    // tape wobble
    this.wN = 4096; this.wL = new Float32Array(this.wN); this.wR = new Float32Array(this.wN); this.ww = 0; this.wph1 = 0; this.wph2 = 0;
    this.crushHold = 0; this.crushL = 0; this.crushR = 0; this.crushBurst = 0;
    // echo
    this.eN = 1 << 17; this.eL = new Float32Array(this.eN); this.eR = new Float32Array(this.eN); this.ew = 0; this.elpL = 0; this.elpR = 0;
    // reverb
    const k = SR / 44100;
    const mk = (n) => ({ b: new Float32Array(Math.round(n * k)), i: 0, s: 0 });
    this.rcL = [1116, 1188, 1277, 1356, 1422, 1491].map(mk);
    this.rcR = [1139, 1211, 1300, 1379, 1445, 1514].map(mk);
    this.raL = [556, 441, 341].map(mk); this.raR = [579, 464, 364].map(mk);
    this.psN = 4096; this.ps = new Float32Array(this.psN); this.psw = 0; this.psp = 0; this.shimFb = 0;
    // ambience
    this.amb = { wl: 0, wb: 0, wl2: 0, wb2: 0, wlfo: rnd() * 10, rain: 0, rh: 0, bird: 0, birdT: SR * 3, bph: 0, bf: 0, bnext: 0, chirps: 0, level: 0 };
    // master
    this.lim = 1; this.dcL = 0; this.dcR = 0; this.dcxL = 0; this.dcxR = 0;
    this.duck = 0; this.lfo = 0; this.vibPh = 0;
    // sequencer
    this.t = 0; this.nextStep = 0; this.step = 0; this.bar = 0; this.secIdx = 0; this.secBar = 0; this.cycle = 0;
    this.events = []; this.curOff = 0; this.padNotes = []; this.lastVox = 0; this.meterAcc = new Float32Array(9); this.meterN = 0;
    this.keyId = 0;
    this.buildSong();
    this.port.onmessage = (ev) => this.onMsg(ev.data);
  }

  /* ── control messages ── */
  onMsg(m) {
    if (!m) return;
    if (m.type === 'p') Object.assign(this.P, m.p);
    else if (m.type === 'seq') {
      const was = this.S.on;
      const prev = { seed: this.S.seed, prog: this.S.prog, mode: this.S.mode, energy: this.S.energy, evolve: this.S.evolve, melody: this.S.melody };
      Object.assign(this.S, m.s);
      if (prev.seed !== this.S.seed || prev.prog !== this.S.prog || prev.mode !== this.S.mode || Math.abs(prev.melody - this.S.melody) > 0.05) this.buildMotifs();
      if (Math.abs(prev.energy - this.S.energy) > 0.04 || Math.abs(prev.evolve - this.S.evolve) > 0.04) this.buildForm(false);
      if (this.S.on && !was) { this.step = 0; this.bar = 0; this.secIdx = 0; this.secBar = 0; this.cycle = 0; this.buildForm(true); this.nextStep = this.t + 256; this.announceSection(); }
      if (!this.S.on && was) { this.events.length = 0; for (const p of this.pads) p.release(); for (const v of this.vox) v.release(); this.bass.stage = 3; }
    } else if (m.type === 'on') { this.curOff = 0; this.keyOn(m.id, m.midi, m.vel, this.P.timbre, 0); }
    else if (m.type === 'off') { for (const v of this.keys) if (v.id === m.id) v.release(); }
  }

  /* ── song structure ── */
  buildSong() { this.buildForm(true); this.buildMotifs(); }
  buildForm(reset) {
    const e = this.S.energy, ev = this.S.evolve;
    const scale = 1.7 - ev * 1.1;
    const L = (n) => Math.max(2, Math.round(n * scale / 2) * 2);
    const f = [['dawn', L(8)], ['bloom', L(8)]];
    if (e > 0.3) f.push(['canopy', L(8)]); else f.push(['bloom', L(4)]);
    f.push(['glitch', Math.max(2, L(4))]);
    if (e > 0.55) f.push(['canopy', L(8)]); else f.push(['bloom', L(4)]);
    f.push(['petal', L(8)]);
    this.form = f;
    if (reset) { this.secIdx = 0; this.secBar = 0; }
    else { this.secIdx = Math.min(this.secIdx, f.length - 1); this.secBar = Math.min(this.secBar, f[this.secIdx][1] - 1); }
  }
  buildMotifs() {
    const r = mulberry(this.S.seed * 9973 + this.S.prog * 131 + this.cycle * 7);
    this.mr = r;
    const act = this.S.melody;
    // pentatonic lean: skip 4th/7th in major, 2nd/6th in minor
    const avoidA = this.S.mode ? 1 : 3, avoidB = this.S.mode ? 5 : 6;
    const mk = () => {
      const notes = new Array(32).fill(null);
      let deg = 4 + Math.floor(r() * 3);
      for (let s = 0; s < 32; s++) {
        const strong = s % 8 === 0, eighth = s % 2 === 0;
        const p = strong ? 0.85 : eighth ? 0.25 + act * 0.45 : act * act * 0.35;
        if (r() < p) {
          const step = [-2, -1, -1, 1, 1, 2, 3, -3, 0][Math.floor(r() * 9)];
          deg = Math.max(0, Math.min(11, deg + step));
          if (!strong && (deg % 7 === avoidA || deg % 7 === avoidB) && r() < 0.7) deg += r() < 0.5 ? -1 : 1; // pentatonic lean
          notes[s] = { deg, v: strong ? 0.9 : 0.55 + r() * 0.3 };
        }
      }
      // durations: until next onset, max 6 steps
      for (let s = 0; s < 32; s++) if (notes[s]) { let d = 1; while (d < 6 && !notes[(s + d) % 32]) d++; notes[s].len = d; }
      return notes;
    };
    const A = mk(), B = mk();
    const A2 = A.map((n, s) => (s >= 24 ? B[s] : n));
    this.motifs = [A, A2, B, A];
    // vocal chop rhythm (16 steps), arp pattern, foley weights
    this.voxPat = Array.from({ length: 16 }, (_, s) => ([0, 3, 6, 10, 12, 14].includes(s) && r() < 0.75) ? { len: 1 + Math.floor(r() * 2), tone: Math.floor(r() * 3), vowel: Math.floor(r() * 5) } : null);
    this.arpDir = r() < 0.5 ? 1 : -1;
    this.bamboo = Array.from({ length: 16 }, (_, s) => (s % 3 === 0 && r() < 0.8) ? Math.floor(r() * 4) : -1);
    this.kickAlt = r() < 0.5;
  }

  chordAt(bar) { const p = (this.S.mode ? MPROGS : PROGS)[this.S.prog % PROGS.length]; return p[bar % p.length]; }
  chordTones(ch, center) {
    const iv = Q[ch[1]], root = this.S.key + ch[0];
    const out = [];
    for (const x of iv) { let m = root + x; while (m < center - 6) m += 12; while (m >= center + 6) m -= 12; out.push(m); }
    return out.sort((a, b) => a - b);
  }
  degMidi(deg, oct) { const o = Math.floor(deg / 7), i = deg - o * 7; return 12 * (oct + 1) + this.S.key + (this.S.mode ? MIN : MAJ)[i] + 12 * o; }

  announceSection() {
    const s = this.form[this.secIdx];
    this.port.postMessage({ type: 's', name: s[0], i: this.secIdx, n: this.form.length, bars: s[1], form: this.form.map((x) => x[0]), lens: this.form.map((x) => x[1]) });
  }

  /* ── event queue (sample accurate) ── */
  at(t, kind, a, b, c, d, e) { this.events.push({ t, kind, a, b, c, d, e }); }
  runEvent(ev) {
    const P = this.P;
    switch (ev.kind) {
      case 'key': this.keyOn(this.keyId++, ev.a, ev.b, ev.c, ev.d); break;
      case 'shot': this.shot(ev.a, ev.b, ev.c, ev.d, ev.e); break;
      case 'vox': this.voxOn(ev.a, ev.b, ev.c, ev.d, ev.e); break;
      case 'glitch': this.glitchOn(ev.a, ev.b, ev.c); break;
      case 'pad': {
        const pad = this.pads.find((x) => !x.on) || this.pads[ev.d % this.pads.length];
        pad.start(ev.a, ev.b, P, ev.c, this.curOff);
        if (ev.d === 0) this.port.postMessage({ type: 'n', l: 'p', m: ev.a, v: ev.b });
        break; }
      case 'bass': this.bassOn(ev.a, ev.b, ev.c); break;
      default: break;
    }
  }

  keyOn(id, midi, vel, timbre, gate) {
    let v = this.keys.find((x) => !x.on);
    if (!v) { v = this.keys[0]; for (const x of this.keys) if (x.amp[0] < v.amp[0]) v = x; }
    v.start(id, midi, vel, timbre, this.P, gate, this.curOff);
    this.port.postMessage({ type: 'n', l: timbre > 0.6 ? 'c' : 'k', m: midi, v: vel });
  }
  shot(kind, f, vel, pan, dur) {
    let s = this.shots.find((x) => !x.on);
    if (!s) s = this.shots[(this.t >> 7) % this.shots.length];
    s.start(kind, f, vel, pan, this.curOff, dur);
    if (kind === 0 || kind === 5) this.duck = 1;
    else if (kind === 1 || kind === 2) this.duck = Math.max(this.duck, 0.6);
    if (kind !== 3 && kind !== 4 && kind !== 15) this.port.postMessage({ type: 'n', l: kind < 10 ? 'd' : 'f', k: kind, m: f, v: vel, p: pan });
  }
  voxOn(midi, vel, vowel, choir, gate) {
    let v = this.vox.find((x) => !x.on) || this.vox[this.lastVox++ % this.vox.length];
    v.start(midi, vel, vowel, choir, gate, this.curOff, choir ? 0 : midi - (rnd() < 0.3 ? 2 : 0.6));
    this.port.postMessage({ type: 'n', l: 'v', m: midi, v: vel });
  }
  bassOn(midi, vel, gate) {
    const b = this.bass;
    b.tf = mtof(midi); if (!b.on || b.stage === 3) b.f = b.tf;
    b.on = true; b.stage = 1; b.gate = gate; b.age = 0; b.vel = vel; b.off = this.curOff;
    this.port.postMessage({ type: 'n', l: 'b', m: midi, v: vel });
  }
  glitchOn(kind, durS, rate1) {
    // kinds: 0 stutter, 1 tape stop, 2 reverse, 3 crush burst, 4 gate chop
    const R = this.rep;
    if (kind === 3) { this.crushBurst = Math.round(durS * SR); this.port.postMessage({ type: 'g', k: kind, d: durS }); return; }
    R.on = true; R.kind = kind; R.t = 0; R.dur = Math.round(durS * SR);
    R.len = Math.max(64, Math.round((rate1 > 0 ? rate1 : 0.25) * this.stepDur()));
    R.start = (this.cw - R.len + this.GN) % this.GN;
    R.pos = 0; R.rate = 1; R.rate1 = kind === 0 ? (rnd() < 0.3 ? (rnd() < 0.5 ? 2 : 0.5) : 1) : 1;
    R.fade = 0;
    if (kind === 1 || kind === 2) R.pos = 0;
    this.port.postMessage({ type: 'g', k: kind, d: durS, s: R.len / SR });
  }
  freezeOn(bars) {
    const F = this.frz;
    F.on = true;
    const n = this.zN, GN = this.GN;
    for (let i = 0; i < n; i++) { const p = (this.cw - n + i + GN) & (GN - 1); this.zL[i] = this.cL[p]; this.zR[i] = this.cR[p]; }
    F.until = this.t + bars * 16 * this.stepDur();
    this.port.postMessage({ type: 'z', on: true, d: bars * 16 * this.stepDur() / SR });
  }
  stepDur() { return (60 / this.S.bpm) / 4 * SR; }

  /* ── one 16th step of the arrangement ── */
  doStep(T) {
    const S = this.S, P = this.P;
    const sec = SECT[this.form[this.secIdx][0]];
    const secLen = this.form[this.secIdx][1];
    const sd = this.stepDur();
    const st = this.step, bar = this.bar;
    const e = S.energy;
    const halftime = S.bpm >= 124;
    const swing = halftime ? 0 : sd * 0.09;
    const tt = T + (st % 2 ? swing : 0);
    const ch = this.chordAt(bar);
    const lastBar = this.secBar === secLen - 1;
    const nextSec = this.form[(this.secIdx + 1) % this.form.length][0];
    const r = rnd;

    // chord change: pad + bass + choir
    if (st === 0) {
      const tones = this.chordTones(ch, 62);
      for (const p of this.pads) if (p.on && p.stage < 3) p.release();
      if (sec.pad > 0) {
        tones.slice(0, 4).forEach((m, j) => this.at(tt + j * 2, 'pad', m, 0.5 + 0.5 * sec.pad, 16 * sd * 1.02, j));
      }
      if (sec.choir && P.voice > 0.02) {
        this.at(tt, 'vox', tones[1] + 12 > 76 ? tones[1] : tones[1] + 12, 0.6, bar % 5, 1, 15 * sd);
        if (tones[2] !== undefined) this.at(tt + sd * 0.5, 'vox', tones[2] + 12 > 79 ? tones[2] : tones[2] + 12, 0.45, (bar + 2) % 5, 1, 14 * sd);
      }
      // freeze at bar starts
      const Z = P.freeze * sec.z;
      if (!this.frz.on && r() < Z * 0.3) this.freezeOn(r() < 0.5 ? 1 : 2);
    }
    // bass
    if (sec.bass > 0 && P.bass > 0.01) {
      const root = this.S.key + ch[0] + 36 + (this.S.key + ch[0] > 7 ? -12 : 0);
      if (st === 0) this.at(tt, 'bass', root, 0.9, (sec.drm > 0.5 ? 6 : 15) * sd);
      else if (sec.drm > 0.5 && e > 0.45 && (st === 10 || (st === 7 && this.kickAlt))) this.at(tt, 'bass', root + (st === 7 ? 12 : 0), 0.7, 3 * sd);
    }

    // melody (keys)
    const phrase = this.motifs[Math.floor(bar / 2) % 4];
    const cell = phrase[(bar % 2) * 16 + st];
    if (cell && r() < sec.mel * (0.55 + 0.45 * S.melody) * 1.15) {
      let m = this.degMidi(cell.deg, P.timbre < 0.4 ? 4 : 5);
      if (st % 8 === 0) { // snap to chord tone on strong beats
        const tones = this.chordTones(ch, m);
        let best = tones[0]; for (const x of tones) if (Math.abs(x - m) < Math.abs(best - m)) best = x; m = best;
      }
      const tim = P.timbre;
      this.at(tt, 'key', m, cell.v * (0.75 + 0.25 * sec.mel), tim, cell.len * sd * 1.1);
    }
    // glass arpeggio sparkle
    if (sec.arp > 0 && r() < sec.arp * (0.25 + e * 0.6)) {
      const tones = this.chordTones(ch, 79);
      const idx = ((this.arpDir > 0 ? st : 15 - st) + bar) % tones.length;
      const step16 = halftime ? st % 2 === 0 || e > 0.7 : st % 2 === 0;
      if (step16) this.at(tt, 'key', tones[idx] + (st >= 8 ? 12 : 0), 0.28 + r() * 0.15, Math.min(1, P.timbre * 0.4 + 0.6), 2 * sd);
    }
    // vocal chops
    if (!sec.choir && sec.vox > 0 && P.voice > 0.02) {
      const vc = this.voxPat[st];
      if (vc && r() < sec.vox * (0.4 + e * 0.6)) {
        const tones = this.chordTones(ch, 71);
        const m = tones[tones.length - 1 - (vc.tone % tones.length)];
        this.at(tt, 'vox', m, 0.75, vc.vowel, 0, vc.len * sd);
        if (sec.id === 2 && e > 0.6) this.at(tt, 'vox', m - (tones.includes(m - 3) ? 3 : 4), 0.5, (vc.vowel + 1) % 5, 0, vc.len * sd);
      }
    }

    // drums
    const D = sec.drm * P.beat;
    if (D > 0.02) {
      const organic = D < 0.45 || sec.id === 1;
      const kickSteps = halftime ? (st === 0 || st === 10 || (e > 0.7 && st === 3)) : (st === 0 || st === 10 || (this.kickAlt && st === 7));
      const snareStep = halftime ? st === 8 : (st === 4 || st === 12);
      const dv = Math.min(1, sec.drm + 0.3);
      if (kickSteps) this.at(tt, 'shot', organic ? 5 : 0, 0, 0.9 * dv, 0.5);
      if (snareStep) this.at(tt, 'shot', organic ? 2 : 1, 0, 0.7 * dv, 0.5);
      if (st % 2 === 0 || (e > 0.5 && r() < e * 0.5)) this.at(tt, 'shot', organic ? 15 : 3, 0, (st % 4 === 2 ? 0.6 : 0.35) * dv, 0.3 + r() * 0.4);
      // glitchy hat ratchets (1/32, 1/64)
      if ((st === 14 || st === 15) && r() < 0.25 + P.glitch * 0.6 && e > 0.35) {
        const n = r() < 0.5 ? 2 : 4;
        for (let j = 0; j < n; j++) this.at(tt + j * sd / n, 'shot', 3, 0, (0.25 + 0.5 * j / n) * dv, 0.4 + 0.4 * j / n);
      }
      if (st === 6 && halftime && r() < 0.3) this.at(tt, 'shot', 4, 0, 0.3 * dv, 0.65);
    }

    // organic foley groove
    const F = sec.fol * P.foley;
    if (F > 0.02) {
      const hi = this.chordTones(ch, 88);
      if (r() < F * 0.2) this.at(tt, 'shot', 10, mtof(hi[Math.floor(r() * hi.length)]) * 0.5, 0.45 + r() * 0.4, r());
      if (st % 4 === 2 && r() < F * 0.3) this.at(tt, 'shot', 12, 900 + r() * 1800, 0.5, r());
      if ((st === 4 || st === 12) && D < 0.4 && r() < F * 0.55) this.at(tt, 'shot', 13, 0, 0.6, 0.3 + r() * 0.4, 0.09 + r() * 0.12);
      if (st % 8 === 0 && r() < F * 0.16) this.at(tt, 'shot', 11, mtof(hi[0] + 12), 0.5, r());
      if (r() < F * 0.12 * e) this.at(tt, 'shot', 15, 0, 0.35, r());
      const bb = this.bamboo[st];
      if (bb >= 0 && r() < F * 0.32) { const lo = this.chordTones(ch, 67); this.at(tt, 'shot', 17, mtof(lo[bb % lo.length]), 0.55, 0.2 + r() * 0.6); }
      if (st === 0 && r() < F * 0.2 * (0.5 + P.ambience)) this.at(tt, 'shot', 16, mtof(hi[hi.length - 1]), 0.5, r());
      if (r() < F * 0.03) this.at(tt, 'shot', 14, 350 + r() * 250, 0.6, r());
    }

    // glitch events (quantized)
    const G = Math.min(1, P.glitch * sec.g);
    if (G > 0.01) {
      if (st === 12 && r() < G * 0.65) {
        const k = r();
        if (k < 0.45) this.at(tt, 'glitch', 0, 4 * sd / SR, r() < 0.5 ? 1 : 0.5);
        else if (k < 0.62) this.at(tt, 'glitch', 2, 4 * sd / SR, 0);
        else if (k < 0.8) this.at(tt, 'glitch', 4, 4 * sd / SR, 0.5);
        else this.at(tt, 'glitch', 3, 2 * sd / SR, 0);
      } else if (st % 4 === 0 && st !== 12 && r() < G * G * 0.35) {
        this.at(tt, 'glitch', 0, (r() < 0.5 ? 1 : 2) * sd / SR, r() < 0.5 ? 0.25 : 0.5);
      }
    }
    // section transitions
    if (lastBar) {
      if (st === 0 && (nextSec === 'canopy' || nextSec === 'glitch')) this.at(tt, 'shot', 18, mtof(this.S.key + 60), 0.55, 0.5, 16 * sd / SR);
      if (st === 12 && (nextSec === 'glitch' || sec.id === 3)) this.at(tt, 'glitch', 1, 4 * sd / SR, 0);
      if (st === 12 && nextSec === 'canopy' && sec.id !== 3 && D > 0.02) for (let j = 0; j < 8; j++) this.at(tt + j * sd / 2, 'shot', 1, 0, 0.2 + j * 0.07, 0.5);
    }

    // advance
    this.step = (st + 1) % 16;
    if (this.step === 0) {
      this.bar++; this.secBar++;
      if (this.secBar >= secLen) {
        this.secBar = 0; this.secIdx++;
        if (this.secIdx >= this.form.length) { this.secIdx = 0; this.cycle++; this.buildForm(true); this.buildMotifs(); }
        this.announceSection();
      }
    }
    this.nextStep += sd;
  }

  /* ── audio ── */
  process(_in, outputs) {
    const out = outputs[0];
    const OL = out[0], OR = out[1] || out[0];
    const N = OL.length, P = this.P, t0 = this.t;
    const mL = this.mL, mR = this.mR, dL = this.dL, dR = this.dR, aL = this.aL, aR = this.aR, xL = this.xL, xR = this.xR;
    mL.fill(0); mR.fill(0); dL.fill(0); dR.fill(0); aL.fill(0); aR.fill(0); xL.fill(0); xR.fill(0);

    // sequencer → event queue
    if (this.S.on) {
      if (this.nextStep < t0 - SR) this.nextStep = t0;
      while (this.nextStep < t0 + N) this.doStep(this.nextStep);
    }
    if (this.events.length) {
      const ev = this.events;
      for (let i = ev.length - 1; i >= 0; i--) {
        if (ev[i].t < t0 + N) { this.curOff = Math.max(0, Math.min(N - 1, Math.floor(ev[i].t - t0))); this.runEvent(ev[i]); ev.splice(i, 1); }
      }
      this.curOff = 0;
    }

    // voices
    const meter = this.meterAcc;
    this.lfo += N / SR * 0.21; this.vibPh += N / SR * 5.6 * TWO_PI;
    const lfo = Math.sin(this.lfo * TWO_PI);
    const kg = P.keys * 0.8, vg = P.voice, fg = P.foley, bg = P.beat;
    for (const v of this.keys) if (v.on) meter[0] += v.render(mL, mR, N, kg);
    for (const v of this.pads) if (v.on) meter[1] += v.render(mL, mR, N, P, lfo);
    for (const v of this.vox) if (v.on) meter[2] += v.render(mL, mR, N, 1.13, this.vibPh, vg);
    // gain staging for layers after the fact (voices render at unity into buses)
    // keys and voice are mixed into mL/mR directly; apply layer gains via separate scaling below
    const bs = this.bass;
    if (bs.on && P.bass > 0.005) {
      const g = P.bass * 0.32 * bs.vel;
      let e2 = 0;
      for (let i = bs.off; i < N; i++) {
        if (bs.stage === 1) { bs.env += 1 / (SR * 0.008); if (bs.env >= 1) { bs.env = 1; bs.stage = 2; } }
        else if (bs.stage === 3) { bs.env *= 0.9993; if (bs.env < 1e-4) { bs.env = 0; bs.on = false; break; } }
        if (bs.stage < 3 && bs.gate > 0 && bs.age >= bs.gate) bs.stage = 3;
        bs.age++;
        bs.f += (bs.tf - bs.f) * 0.002;
        bs.ph += bs.f / SR; if (bs.ph >= 1) bs.ph -= 1;
        const s = sat(sn(bs.ph) * 1.6) * bs.env * g;
        mL[i] += s; mR[i] += s; e2 += s * s;
      }
      bs.off = 0; meter[3] += e2;
    }
    let dE = 0, fE = 0;
    for (const s of this.shots) if (s.on) {
      const e3 = s.render(s.kind < 10 ? dL : aL, s.kind < 10 ? dR : aR, N);
      if (s.kind < 10) dE += e3; else fE += e3;
    }
    meter[4] += dE * bg * bg; meter[5] += fE * fg * fg;

    // ambience bed (wind, rain on leaves, birds)
    const A = this.amb;
    const sec = this.S.on ? SECT[this.form[this.secIdx][0]] : SECT.dawn;
    const ambT = P.ambience * (this.S.on ? sec.amb : 0.8);
    A.level += (ambT - A.level) * 0.01;
    if (A.level > 0.003) {
      A.wlfo += N / SR * 0.07;
      const wc = 0.03 + 0.06 * (0.5 + 0.5 * Math.sin(A.wlfo * TWO_PI)), wc2 = 0.035 + 0.06 * (0.5 + 0.5 * Math.sin(A.wlfo * 4.3 + 1));
      const wg = A.level * 0.55, rg = A.level * 0.14;
      A.birdT -= N;
      if (A.birdT <= 0 && A.chirps === 0) { A.chirps = 3 + Math.floor(rnd() * 6); A.bf = 2600 + rnd() * 2400; A.bnext = 0; A.birdT = SR * (3 + rnd() * 9); A.bpan = rnd(); }
      let ae = 0;
      for (let i = 0; i < N; i++) {
        const n1 = noise(), n2 = noise();
        A.wl += wc * A.wb; let h = n1 - A.wl - 1.2 * A.wb; A.wb += wc * h;
        A.wl2 += wc2 * A.wb2; h = n2 - A.wl2 - 1.2 * A.wb2; A.wb2 += wc2 * h;
        let l = A.wl * wg * 0.6, r = A.wl2 * wg * 0.6;
        // rain on leaves: sparse sizzling ticks
        if (rnd() < 0.0035) A.rain = 0.4 + rnd() * 0.6;
        A.rh += (n1 - A.rh) * 0.6; const tick = (n1 - A.rh) * A.rain * rg; A.rain *= 0.985;
        l += tick; r += tick * 0.6;
        // bird chirps
        if (A.chirps > 0) {
          if (A.bnext <= 0) { A.bt = 0; A.bnext = SR * (0.07 + rnd() * 0.09); A.bdur = SR * (0.03 + rnd() * 0.05); A.chirps--; A.bsweep = (rnd() - 0.4) * 1.2; }
          A.bnext--;
          if (A.bt < A.bdur) {
            const k = A.bt / A.bdur; const f = A.bf * (1 + A.bsweep * k + 0.08 * Math.sin(A.bt * 0.02));
            A.bph += f / SR; const y = Math.sin(A.bph * TWO_PI) * Math.sin(Math.PI * k) * A.level * 0.09;
            l += y * (1 - A.bpan); r += y * A.bpan; A.bt++;
          }
        }
        xL[i] += l; xR[i] += r; ae += l * l;
      }
      meter[7] += ae;
    }

    // mix: music (ducked) + drums + foley
    const duckDepth = 0.5 * P.beat * (this.S.on ? sec.drm : 0);
    const duckRel = Math.exp(-1 / (SR * 0.16));
    const yL = this.yL, yR = this.yR;
    const cL = this.cL, cR = this.cR, GN = this.GN;
    const R = this.rep;
    const wob = P.crush * 0.0016 * SR, wN = this.wN, wL = this.wL, wR = this.wR;
    const crushAmt = P.crush;
    for (let i = 0; i < N; i++) {
      this.duck *= duckRel;
      const dg = 1 - duckDepth * this.duck;
      let l = mL[i] * dg * 0.9 + dL[i] * bg * 0.9 + aL[i] * fg * 2;
      let r = mR[i] * dg * 0.9 + dR[i] * bg * 0.9 + aR[i] * fg * 2;
      // tape wobble (unstable pitch)
      if (wob > 1) {
        this.wph1 += 0.55 / SR; this.wph2 += 6.3 / SR;
        const d = 8 + wob * (1 + 0.7 * Math.sin(this.wph1 * TWO_PI) + 0.3 * Math.sin(this.wph2 * TWO_PI));
        const w = this.ww; wL[w] = l; wR[w] = r; this.ww = (w + 1) & (wN - 1);
        let rp = w - d; if (rp < 0) rp += wN; const ri = rp | 0, rf = rp - ri, r2 = (ri + 1) & (wN - 1);
        l = wL[ri] + (wL[r2] - wL[ri]) * rf; r = wR[ri] + (wR[r2] - wR[ri]) * rf;
      }
      // capture
      const cw = this.cw; cL[cw] = l; cR[cw] = r; this.cw = (cw + 1) & (GN - 1);
      // repeater / tape / reverse
      if (R.on) {
        R.t++;
        const k = R.t / R.dur;
        let gl = 0, gr = 0, gate = 1;
        if (R.kind === 0 || R.kind === 4) {
          R.rate = 1 + (R.rate1 - 1) * k;
          R.pos += R.rate; if (R.pos >= R.len) R.pos -= R.len;
          const p = (R.start + (R.pos | 0)) & (GN - 1);
          const edge = Math.min(1, R.pos / 64, (R.len - R.pos) / 64);
          gl = cL[p] * edge; gr = cR[p] * edge;
          if (R.kind === 4) gate = ((R.t / (R.len * 0.5)) | 0) % 2 ? 0 : 1;
        } else if (R.kind === 1) {
          R.rate = Math.max(0, 1 - k * 1.15); R.pos += R.rate;
          const p = ((cw - R.t + (R.pos | 0)) + GN * 4) & (GN - 1);
          gl = cL[p]; gr = cR[p]; gate = R.rate > 0 ? 1 : 0;
        } else if (R.kind === 2) {
          const p = ((cw - 2 * R.t) + GN * 4) & (GN - 1);
          gl = cL[p]; gr = cR[p]; gate = Math.min(1, R.t / 128);
        }
        R.fade = Math.min(1, R.fade + 1 / 96);
        const fo = R.t > R.dur - 96 ? Math.max(0, (R.dur - R.t) / 96) : 1;
        const mx = R.fade * fo;
        l = l * (1 - mx) + gl * gate * mx; r = r * (1 - mx) + gr * gate * mx;
        if (R.t >= R.dur) R.on = false;
      }
      // bitcrush / sample hold
      const cb = this.crushBurst > 0 ? 1 : crushAmt * 0.35;
      if (this.crushBurst > 0) this.crushBurst--;
      if (cb > 0.02) {
        const hold = 1 + Math.floor(cb * 14);
        if (++this.crushHold >= hold) { this.crushHold = 0; const q = Math.pow(2, 15 - cb * 10); this.crushL = Math.round(l * q) / q; this.crushR = Math.round(r * q) / q; }
        l += (this.crushL - l) * Math.min(1, cb * 1.4); r += (this.crushR - r) * Math.min(1, cb * 1.4);
      }
      yL[i] = l; yR[i] = r;
    }

    // grains: cloud + freeze
    const gL = this.gL, gR = this.gR; gL.fill(0); gR.fill(0);
    const F = this.frz;
    if (F.on && this.t > F.until) { F.on = false; this.port.postMessage({ type: 'z', on: false }); }
    F.mix += ((F.on ? 0.55 + P.freeze * 0.45 : 0) - F.mix) * 0.02;
    const density = P.grain * P.grain * 34 + F.mix * 40;
    if (density > 0.2) {
      this.grainClock -= N / SR * density;
      while (this.grainClock <= 0) {
        this.grainClock += 0.6 + rnd() * 0.8;
        const g = this.grains.find((x) => !x.on);
        if (!g) break;
        const frozen = F.mix > 0.1 && rnd() < F.mix;
        g.on = true; g.t = 0;
        g.len = Math.round(SR * (frozen ? 0.09 + rnd() * 0.16 : 0.025 + rnd() * 0.1));
        const back = frozen ? 0 : SR * (0.06 + rnd() * 0.5);
        g.pos = frozen ? SR * 0.05 + rnd() * (this.zN - SR * 0.05 - g.len * 2.1) : (this.cw - back - g.len * 2 + GN * 2) % GN;
        const pr = rnd();
        g.rate = frozen ? (pr < 0.25 ? 2 : 1) : (pr < 0.3 ? 2 : pr < 0.45 ? 0.5 : pr < 0.6 ? 1.4983 : 1);
        g.dir = !frozen && rnd() < 0.3 ? -1 : 1;
        g.pan = rnd(); g.amp = frozen ? 0.5 : 0.6;
        g.frozen = frozen;
      }
    }
    let ge = 0;
    const gmix = P.grain * 0.9, zL = this.zL, zR = this.zR, zN = this.zN;
    for (const g of this.grains) {
      if (!g.on) continue;
      const amp = g.amp * (g.frozen ? F.mix : gmix);
      const pl = 1 - g.pan, pr = g.pan;
      for (let i = 0; i < N; i++) {
        const k = g.t / g.len; if (k >= 1) { g.on = false; break; }
        const w = Math.sin(Math.PI * k); const ww = w * w * amp;
        const p = g.pos + g.dir * g.t * g.rate; const pi = Math.floor(p), pf = p - pi;
        let sL, sR;
        if (g.frozen) { const a = Math.min(zN - 2, Math.max(0, pi)); sL = zL[a] + (zL[a + 1] - zL[a]) * pf; sR = zR[a] + (zR[a + 1] - zR[a]) * pf; }
        else { const a = (pi % GN + GN) % GN, b = (a + 1) & (GN - 1); sL = cL[a] + (cL[b] - cL[a]) * pf; sR = cR[a] + (cR[b] - cR[a]) * pf; }
        gL[i] += (sL * pl + sR * 0.3) * ww; gR[i] += (sR * pr + sL * 0.3) * ww;
        g.t++;
      }
    }

    // echo + shimmer reverb + master
    const sd = this.stepDur();
    const eT = Math.min(this.eN - 2, sd * 3), eFb = 0.22 + P.echo * 0.5, eMix = P.echo * 0.5;
    const eN = this.eN, eL = this.eL, eR = this.eR;
    const rvIn = 0.012 + P.shimmer * 0.03, rvMix = 0.35 + P.shimmer * 0.9, room = 0.8 + P.shimmer * 0.13, damp = 0.32;
    const shim = P.shimmer;
    const rcL = this.rcL, rcR = this.rcR, raL = this.raL, raR = this.raR;
    const ps = this.ps, psN = this.psN, W = 2048;
    const vol = P.volume;
    let peak = 0;
    for (let i = 0; i < N; i++) {
      let l = yL[i] + gL[i], r = yR[i] + gR[i];
      // ping-pong echo
      let rp = this.ew - eT; if (rp < 0) rp += eN; const ri = rp | 0;
      const el = eL[ri], er = eR[ri];
      this.elpL += (er - this.elpL) * 0.3; this.elpR += (el - this.elpR) * 0.3;
      eL[this.ew] = (l + r) * 0.5 * (eMix > 0.005 ? 1 : 0) + this.elpL * eFb; eR[this.ew] = this.elpR * eFb;
      this.ew = (this.ew + 1) & (eN - 1);
      l += el * eMix; r += er * eMix;
      // reverb
      const inp = (l + r + xL[i] * 0.6 + xR[i] * 0.6) * rvIn + this.shimFb;
      let ol = 0, or = 0;
      for (let c = 0; c < 6; c++) {
        const A1 = rcL[c], y1 = A1.b[A1.i]; A1.s = y1 * (1 - damp) + A1.s * damp; A1.b[A1.i] = inp + A1.s * room; if (++A1.i >= A1.b.length) A1.i = 0; ol += y1;
        const B1 = rcR[c], y2 = B1.b[B1.i]; B1.s = y2 * (1 - damp) + B1.s * damp; B1.b[B1.i] = inp + B1.s * room; if (++B1.i >= B1.b.length) B1.i = 0; or += y2;
      }
      for (let c = 0; c < 3; c++) {
        const A1 = raL[c], b1 = A1.b[A1.i]; A1.b[A1.i] = ol + b1 * 0.5; if (++A1.i >= A1.b.length) A1.i = 0; ol = b1 - ol;
        const B1 = raR[c], b2 = B1.b[B1.i]; B1.b[B1.i] = or + b2 * 0.5; if (++B1.i >= B1.b.length) B1.i = 0; or = b2 - or;
      }
      // octave-up shimmer fed back into the tank
      if (shim > 0.02) {
        ps[this.psw] = (ol + or) * 0.5; this.psw = (this.psw + 1) & (psN - 1);
        this.psp += 1 / W; if (this.psp >= 1) this.psp -= 1;
        const p2 = (this.psp + 0.5) % 1;
        const d1 = (1 - this.psp) * W, d2 = (1 - p2) * W;
        const s1 = ps[(this.psw - 1 - (d1 | 0) + psN) & (psN - 1)], s2 = ps[(this.psw - 1 - (d2 | 0) + psN) & (psN - 1)];
        const g1 = 1 - Math.abs(2 * this.psp - 1), g2 = 1 - Math.abs(2 * p2 - 1);
        this.shimFb = (s1 * g1 + s2 * g2) * shim * 0.0055;
      } else this.shimFb = 0;
      l += ol * rvMix * 0.25 + xL[i]; r += or * rvMix * 0.25 + xR[i];
      // dc block
      const xl = l, xr = r;
      this.dcL = xl - this.dcxL + 0.9995 * this.dcL; this.dcxL = xl; this.dcR = xr - this.dcxR + 0.9995 * this.dcR; this.dcxR = xr;
      l = this.dcL * vol; r = this.dcR * vol;
      const pk = Math.max(Math.abs(l), Math.abs(r));
      if (pk * this.lim > 0.92) this.lim = 0.92 / pk; else this.lim += (1 - this.lim) * 0.0002;
      l = sat(l * this.lim * 1.05); r = sat(r * this.lim * 1.05);
      OL[i] = l; if (OR !== OL) OR[i] = r;
      if (pk > peak) peak = pk;
    }
    meter[6] += (R.on ? 1 : 0) + (F.mix > 0.1 ? 0.6 : 0) + (this.crushBurst > 0 ? 0.6 : 0);
    meter[8] = Math.max(meter[8], peak);
    this.meterN += N;
    if (this.meterN >= 2048) {
      const n = this.meterN, m = this.meterAcc;
      this.port.postMessage({ type: 'm', lv: m[8], L: [Math.sqrt(m[0] / n), Math.sqrt(m[1] / n), Math.sqrt(m[2] / n), Math.sqrt(m[3] / n), Math.sqrt(m[4] / n), Math.sqrt(m[5] / n), m[6] / (n / N), Math.sqrt(m[7] / n)], bar: this.secBar, step: this.step, sec: this.secIdx });
      m.fill(0); this.meterN = 0;
    }
    this.t += N;
    return true;
  }
}

if (typeof registerProcessor === 'function') registerProcessor('botanica-engine', BotanicaEngine);
if (typeof globalThis !== 'undefined') globalThis.__BotanicaEngine = BotanicaEngine;
