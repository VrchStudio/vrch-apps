'use strict';
/* Beatbox Coach audio worklet: onset detection, sound recognition,
   beatbox voice synthesis and a sample-accurate step sequencer. */

const SR = sampleRate;
const TAU = Math.PI * 2;
const WIN = Math.round(SR * 0.008);      // analysis window after an onset (decision latency)
const PRE = Math.round(SR * 0.006);      // pre-roll kept for recorded takes
const TAKE = Math.round(SR * 0.5);       // length of a recorded take
const TAIL = Math.round(SR * 0.04);      // hold-off after a decision in live modes

// Sounds: 0 B (kick), 1 Pf (snare), 2 K (click snare), 3 t (closed hat), 4 ts (open hat)
// Fingerprint = share of amplitude in 5 bands (<200, ~500, ~1.4k, ~3.5k, >6.5k Hz)
const DEFAULT_PROTOS = [
  [0.50, 0.25, 0.12, 0.08, 0.05],
  [0.14, 0.20, 0.28, 0.22, 0.16],
  [0.06, 0.14, 0.36, 0.30, 0.14],
  [0.03, 0.06, 0.14, 0.32, 0.45],
  [0.03, 0.06, 0.13, 0.30, 0.48]
];

const KITS = [
  { kF0: 150, kF1: 48, kPt: 0.03, kDec: 0.2, drive: 1.8, sF: 1900, sDec: 0.08, sTone: 190, hDec: 0.022, crush: 0, buzz: 0, air: 0 },
  { kF0: 115, kF1: 43, kPt: 0.06, kDec: 0.6, drive: 1.3, sF: 1700, sDec: 0.13, sTone: 175, hDec: 0.035, crush: 0, buzz: 0, air: 0 },
  { kF0: 140, kF1: 52, kPt: 0.03, kDec: 0.24, drive: 3.2, sF: 1600, sDec: 0.1, sTone: 200, hDec: 0.03, crush: 1, buzz: 0, air: 0 },
  { kF0: 120, kF1: 62, kPt: 0.025, kDec: 0.12, drive: 1.2, sF: 1400, sDec: 0.07, sTone: 160, hDec: 0.02, crush: 0, buzz: 1, air: 1 }
];
const DEMO_KIT = 3; // the mouth-like "human" voicing is used for all demonstrations

let seed = 0x2545f491;
function noise() {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) / 2147483648 - 1;
}

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(type, f, q) {
    const w = TAU * Math.min(f, SR * 0.45) / SR;
    const c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    if (type === 'lp') { this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; }
    else if (type === 'hp') { this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0; }
    else { this.b0 = al / a0; this.b1 = 0; this.b2 = -al / a0; }
    this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
    return this;
  }
  reset() { this.z1 = 0; this.z2 = 0; return this; }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

class Voice {
  constructor() { this.on = false; this.f1 = new Biquad(); this.f2 = new Biquad(); this.f3 = new Biquad(); }

  start(kind, kit, gain, buf) {
    const k = KITS[kit] || KITS[0];
    this.kind = kind; this.k = k; this.g = gain; this.n = 0;
    this.ph = 0; this.ph2 = 0; this.hold = 0; this.held = 0; this.buf = buf || null;
    let len = 0.1;
    switch (kind) {
      case 0: this.f1.set('lp', 2500, 0.7).reset(); this.f2.set('lp', 420, 0.9).reset(); len = k.kDec * 6; break;
      case 1: this.f1.set('bp', k.sF, 0.9).reset(); this.f2.set('lp', 1200, 0.7).reset(); this.f3.set('bp', 4800, 1).reset(); len = k.sDec * 7; break;
      case 2: this.f1.set('bp', 2800, 2.5).reset(); this.f2.set('lp', 4000, 0.7).reset(); len = 0.16; break;
      case 3: this.f1.set('hp', 7000, 0.7).reset(); this.f2.set('hp', 7000, 0.7).reset(); len = k.hDec * 8; break;
      case 4: this.f1.set('hp', 5200, 0.7).reset(); this.f2.set('bp', 8500, 2).reset(); len = 0.7; break;
      case 5: case 6: len = 0.08; break;
      case 7: len = buf.length / SR; break;
    }
    this.end = Math.max(1, Math.ceil(len * SR));
    this.on = true;
  }

  tick() {
    const t = this.n / SR, k = this.k;
    let y = 0;
    switch (this.kind) {
      case 0: { // B: pitch-dropping thump, lip click, optional lip buzz
        const f = k.kF1 + (k.kF0 - k.kF1) * Math.exp(-t / k.kPt);
        this.ph += f / SR; if (this.ph >= 1) this.ph -= 1;
        y = Math.sin(TAU * this.ph) * Math.exp(-t / k.kDec);
        y += this.f1.run(noise()) * Math.exp(-t / 0.0015) * 0.9;
        if (k.buzz) {
          this.ph2 += 88 / SR; if (this.ph2 >= 1) this.ph2 -= 1;
          y += this.f2.run(this.ph2 * 2 - 1) * Math.exp(-t / 0.035) * 0.7;
        }
        y = Math.tanh(k.drive * y) / Math.tanh(k.drive);
        break;
      }
      case 1: { // Pf: lip burst + breathy band noise + short body
        const n = noise();
        y = this.f1.run(n) * Math.exp(-t / k.sDec) * 2.2
          + this.f2.run(n) * Math.exp(-t / 0.004) * 1.2
          + Math.sin(TAU * k.sTone * t) * Math.exp(-t / 0.035) * 0.5;
        if (k.air) y += this.f3.run(n) * Math.exp(-t / (k.sDec * 1.4)) * 1.2;
        y = Math.tanh(y * 1.2);
        break;
      }
      case 2: { // K: tongue click snare
        const n = noise();
        y = this.f1.run(n) * Math.exp(-t / 0.018) * 3
          + Math.sin(TAU * 1050 * t) * Math.exp(-t / 0.012) * 0.45
          + this.f2.run(n) * Math.exp(-t / 0.002) * 0.8;
        y = Math.tanh(y);
        break;
      }
      case 3: y = this.f1.run(this.f2.run(noise())) * Math.exp(-t / k.hDec) * 0.8; break;
      case 4: {
        const n = noise();
        y = (this.f1.run(n) * 0.5 + this.f2.run(n) * 0.9) * Math.min(1, t / 0.004) * Math.exp(-t / 0.11);
        break;
      }
      case 5: y = Math.sin(TAU * 1500 * t) * Math.exp(-t / 0.01) * 0.5; break;
      case 6: y = Math.sin(TAU * 2100 * t) * Math.exp(-t / 0.012) * 0.6; break;
      case 7: y = this.buf[this.n]; break;
    }
    if (k.crush && this.kind < 5) {
      if (this.hold-- <= 0) { this.hold = 3; this.held = Math.round(y * 24) / 24; }
      y = this.held;
    }
    if (++this.n >= this.end) this.on = false;
    return y * this.g;
  }
}

class BeatboxCoach extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = Array.from({ length: 14 }, () => new Voice());
    this.hp = new Biquad().set('hp', 70, 0.7);
    this.bands = [
      new Biquad().set('lp', 200, 0.707),
      new Biquad().set('bp', 500, 0.9),
      new Biquad().set('bp', 1400, 0.9),
      new Biquad().set('bp', 3500, 0.9),
      new Biquad().set('hp', 6500, 0.707)
    ];
    this.p = { mode: 'transform', kit: 0, mix: 0, sens: 0.6, vol: 0.8, comp: 0.02, muted: false };
    this.protos = DEFAULT_PROTOS.map((a) => a.slice());
    this.frame = 0;
    this.fast = 0; this.slow = 0; this.oe = 0; this.floor = 0.001;
    this.rFast = Math.exp(-1 / (SR * 0.01));
    this.aSlow = 1 - Math.exp(-1 / (SR * 0.12));
    this.rOut = Math.exp(-1 / (SR * 0.08));
    this.aFloorDown = 1 - Math.exp(-1 / (SR * 0.05));
    this.aFloorUp = 1 - Math.exp(-1 / (SR * 3));
    this.cap = null;
    this.refract = 0; this.muteUntil = 0;
    this.ring = new Float32Array(PRE); this.ringPos = 0;
    this.pending = [];
    this.seq = null;
    this.mIn = 0; this.mOut = 0; this.mN = 0;
    this.port.onmessage = ({ data }) => this.onMessage(data);
  }

  onMessage(d) {
    if (!d) return;
    if (d.type === 'params') {
      Object.assign(this.p, d.p);
      if (d.protos) this.protos = d.protos;
    } else if (d.type === 'trigger') {
      this.play(d.sound, d.demo ? DEMO_KIT : this.p.kit, 0.9);
      if (d.mute) this.muteUntil = Math.max(this.muteUntil, this.frame + SR * 0.45);
    } else if (d.type === 'ab') {
      this.play(7, 0, 1, d.audio);
      const at = this.frame + d.audio.length + Math.round(SR * 0.3);
      this.pending.push({ at, sound: d.sound });
      this.muteUntil = at + Math.round(SR * 0.5);
    } else if (d.type === 'seq') {
      const len = SR * 60 / d.bpm / 4;
      const next = this.frame + Math.round(SR * 0.08);
      this.seq = { kind: d.kind, steps: d.steps, len, next, idx: 0, start: next + 16 * len, hits: [], done: 0 };
    } else if (d.type === 'stop') {
      this.seq = null;
    }
  }

  play(kind, kit, gain, buf) {
    let v = this.voices.find((x) => !x.on);
    if (!v) v = this.voices.reduce((a, b) => (a.n > b.n ? a : b));
    v.start(kind, kit, gain, buf);
  }

  stepSeq() {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.frame >= this.pending[i].at) { this.play(this.pending[i].sound, DEMO_KIT, 0.9); this.pending.splice(i, 1); }
    }
    const s = this.seq;
    if (!s) return;
    if (s.done) {
      if (this.frame >= s.done) {
        this.port.postMessage({ type: 'practice', hits: s.hits });
        this.seq = null;
      }
      return;
    }
    if (this.frame < s.next) return;
    if (s.kind === 'demo') {
      const c = s.steps[s.idx % 16];
      if (c >= 0) this.play(c, DEMO_KIT, 0.85);
      this.port.postMessage({ type: 'step', idx: s.idx % 16 });
    } else if (s.kind === 'metro') {
      if (s.idx % 4 === 0) this.play(s.idx % 16 === 0 ? 6 : 5, 0, 0.45);
    } else if (s.kind === 'practice') {
      if (s.idx >= 48) { s.done = this.frame + Math.round(s.len * 0.6); return; }
      if (s.idx % 4 === 0) this.play(s.idx === 0 ? 6 : 5, 0, s.idx < 16 ? 0.7 : 0.22);
      this.port.postMessage({ type: 'step', idx: s.idx });
    }
    s.idx++;
    s.next += s.len;
  }

  listening() {
    if (this.p.mode === 'lab') return true;
    if (this.p.mode === 'rhythm') return !this.seq || this.seq.kind !== 'demo';
    return true;
  }

  nearest(fp) {
    let best = 0, bd = Infinity;
    for (let c = 0; c < this.protos.length; c++) {
      const q = this.protos[c];
      let d = 0;
      for (let b = 0; b < 5; b++) { const z = fp[b] - q[b]; d += z * z; }
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  detect(h) {
    this.ring[this.ringPos] = h;
    if (++this.ringPos >= PRE) this.ringPos = 0;
    const b = this.bands;
    const e0 = b[0].run(h), e1 = b[1].run(h), e2 = b[2].run(h), e3 = b[3].run(h), e4 = b[4].run(h);
    const a = Math.abs(h);
    this.fast = a > this.fast ? this.fast + (a - this.fast) * 0.3 : this.fast * this.rFast;
    this.slow += (this.fast - this.slow) * this.aSlow;
    if (a > this.mIn) this.mIn = a;

    const cap = this.cap;
    if (cap) {
      if (cap.n < WIN) {
        cap.e[0] += e0 * e0; cap.e[1] += e1 * e1; cap.e[2] += e2 * e2; cap.e[3] += e3 * e3; cap.e[4] += e4 * e4;
      }
      if (cap.audio && PRE + cap.n < TAKE) cap.audio[PRE + cap.n] = h;
      if (this.fast > cap.peak) cap.peak = this.fast;
      cap.n++;
      if (cap.n === WIN) this.decide(cap);
      if (!cap.dur && cap.n > WIN && this.fast < cap.peak * 0.12) cap.dur = cap.n / SR;
      if (cap.n >= (cap.audio ? TAKE - PRE : WIN + TAIL)) this.finish(cap);
      return;
    }

    // background noise floor: falls quickly, rises slowly, so steady room noise never triggers
    this.floor += (this.fast - this.floor) * (this.fast < this.floor ? this.aFloorDown : this.aFloorUp);
    const thr = Math.max(0.15 * Math.pow(10, -this.p.sens * 2), this.floor * (2 + (1 - this.p.sens) * 4));
    // our own output leaks back into the microphone on speakers: raise the bar while it rings
    this.thrNow = thr + this.oe * 0.8;
    if (this.frame >= this.refract && this.frame >= this.muteUntil && this.listening()
        && this.fast > this.thrNow && this.fast > this.slow * 2.0) {
      const c = { at: this.frame, n: 0, e: [0, 0, 0, 0, 0], peak: this.fast, thr, dur: 0, audio: null, fp: null, cls: 0 };
      if (this.p.mode === 'lab') {
        c.audio = new Float32Array(TAKE);
        for (let j = 0; j < PRE; j++) c.audio[j] = this.ring[(this.ringPos + j) % PRE];
      }
      this.cap = c;
    }
  }

  decide(cap) {
    let sum = 0;
    const fp = cap.e.map((x) => { const r = Math.sqrt(x); sum += r; return r; });
    for (let i = 0; i < 5; i++) fp[i] = sum > 0 ? fp[i] / sum : 0.2;
    cap.fp = fp;
    let cls = this.nearest(fp);
    if (cls === 4) cls = 3; // open vs closed hat needs the length; live modes answer at once with t
    cap.cls = cls;
    if (this.p.mode === 'lab') return;
    const gain = Math.max(0.5, Math.min(1, 0.55 + 0.25 * Math.log10(cap.peak / cap.thr)));
    if (!this.p.muted) {
      this.play(cls, this.p.kit, gain);
      this.refract = this.frame + Math.round(SR * 0.05);
    }
    const s = this.seq;
    if (s && s.kind === 'practice') s.hits.push({ pos: (cap.at - this.p.comp * SR - s.start) / s.len, cls });
    this.port.postMessage({ type: 'hit', cls });
  }

  finish(cap) {
    this.cap = null;
    this.refract = Math.max(this.refract, this.frame + Math.round(SR * 0.02));
    if (!cap.audio || !cap.fp) return;
    const dur = cap.dur || cap.n / SR;
    let cls = this.nearest(cap.fp);
    if (cls === 3 || cls === 4) cls = dur > 0.09 ? 4 : 3;
    this.port.postMessage({ type: 'take', fp: cap.fp, dur, cls, audio: cap.audio }, [cap.audio.buffer]);
  }

  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0];
    const L = out[0], R = out[1];
    const vol = this.p.vol * this.p.vol * 1.3;
    const dry = this.p.mode === 'transform' && !this.p.muted ? this.p.mix * 1.5 : 0;
    for (let i = 0; i < L.length; i++) {
      const x = inp ? inp[i] : 0;
      this.stepSeq();
      this.detect(this.hp.run(x));
      let y = dry * x;
      for (let v = 0; v < this.voices.length; v++) if (this.voices[v].on) y += this.voices[v].tick();
      y = this.p.muted ? 0 : Math.tanh(y * vol);
      L[i] = y; if (R) R[i] = y;
      const ay = Math.abs(y);
      this.oe = ay > this.oe ? ay : this.oe * this.rOut;
      if (ay > this.mOut) this.mOut = ay;
      this.frame++;
    }
    this.mN += L.length;
    if (this.mN >= 2048) {
      this.port.postMessage({ type: 'meter', inp: this.mIn, out: this.mOut, thr: this.thrNow || 0 });
      this.mN = 0; this.mIn = 0; this.mOut = 0;
    }
    return true;
  }
}

registerProcessor('beatbox-coach', BeatboxCoach);
