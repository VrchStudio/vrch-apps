'use strict';
/* Vocal Chain audio worklet — a dynamic-mic vocal strip.

   input gain -> denoise (downward expander) -> pitch correction (phase vocoder)
   -> distortion -> 3-band OTT -> output trim -> limiter.

   Every stage has its own parameters; the page structure lives in the UI. */

const SR = sampleRate;
const N = 512;
const HA = 64;
const BINS = N >> 1;
const TWO_PI = Math.PI * 2;
const OLA_RING = 16384;
const OLA_MASK = OLA_RING - 1;
const IN_RING = 8192;
const IN_MASK = IN_RING - 1;

const HANN = new Float32Array(N);
for (let i = 0; i < N; i++) HANN[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / N);
const HANN2 = new Float32Array(N);
for (let i = 0; i < N; i++) HANN2[i] = HANN[i] * HANN[i];

function makeFFT(n) {
  const bits = Math.log2(n);
  const rev = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  const cos = new Float32Array(n >> 1);
  const sin = new Float32Array(n >> 1);
  for (let i = 0; i < n >> 1; i++) {
    cos[i] = Math.cos((TWO_PI * i) / n);
    sin[i] = Math.sin((TWO_PI * i) / n);
  }
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  function transform(inverse) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const tw = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += tw) {
          const wr = cos[k];
          const wi = inverse ? sin[k] : -sin[k];
          const a = i + j;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
    if (inverse) {
      const s = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; }
    }
  }
  return { re, im, transform };
}
const VOC = makeFFT(N);

const SCALE_MAJOR = [0, 2, 4, 5, 7, 9, 11];
const SCALE_MINOR = [0, 2, 3, 5, 7, 8, 10];
const PITCH_MIN = 70;
const PITCH_MAX = 1000;
const PITCH_HOP = 512;
const PITCH_WIN = 2048;
const PITCH_DEC = 2;

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  lowpass(f, q) { return this.set('lp', f, q); }
  highpass(f, q) { return this.set('hp', f, q); }
  set(type, f, q) {
    const w = (TWO_PI * Math.min(f, SR * 0.45)) / SR;
    const c = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    const a0 = 1 + al;
    if (type === 'lp') { this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; }
    else { this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0; }
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - al) / a0;
    return this;
  }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

const dbToLin = (db) => Math.pow(10, db / 20);

class VocalChain extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inRing = new Float32Array(IN_RING);
    this.inW = 0;
    this.olaSig = new Float32Array(OLA_RING);
    this.olaNorm = new Float32Array(OLA_RING);
    this.lastPh = new Float32Array(BINS + 1);
    this.synPh = new Float32Array(BINS + 1);

    /* vocoder */
    this.ratio = 1;
    this.ratioT = 1;
    this.hopS = HA;
    this.playRate = 1;
    this.m = 0;
    this.olaNext = 0;
    this.lastEnd = 0;
    this.p = 0;
    this.started = false;

    /* pitch tracker */
    this.pitchAt = 0;
    this.f0 = 0;
    this.midi = 0;
    this.targetMidi = 69;
    this.voiced = false;
    this.pitchBuf = new Float32Array(PITCH_WIN);
    this.dec = new Float32Array(PITCH_WIN / PITCH_DEC);
    this.tuneGain = 1;

    /* params */
    this.gainDb = 36; this.gainDbT = 36;
    this.amt = 0.5; this.amtT = 0.5;
    this.tuneSpeed = 0.5; this.tuneSpeedT = 0.5;
    this.vol = 0.8; this.volT = 0.8;
    this.tuneOn = true;
    this.keyRoot = 9;
    this.keyMinor = 1;
    this.key = 19;

    /* denoise */
    this.dnOn = true;
    this.dnThrDb = -55; this.dnThrDbT = -55;
    this.dnDepth = 0.85; this.dnDepthT = 0.85;
    this.dnAttMs = 2; this.dnAttMsT = 2;
    this.dnRelMs = 120; this.dnRelMsT = 120;
    this.dnEnv = 0;
    this.dnGain = 1;
    this.dnStrength = 0.6; this.dnStrengthT = 0.6;
    this.nf = new Float32Array(BINS + 1);      // per-bin noise floor
    this.binGain = new Float32Array(BINS + 1); // smoothed per-bin gain
    this.quiet = false;

    /* OTT */
    this.ottOn = true;
    this.ottThrDb = -26; this.ottThrDbT = -26;
    this.ottUp = 0.7; this.ottUpT = 0.7;
    this.ottDown = 0.6; this.ottDownT = 0.6;
    this.ottSpeed = 0.4; this.ottSpeedT = 0.4;
    this.lpLow1 = new Biquad().lowpass(120, 0.707);
    this.lpLow2 = new Biquad().lowpass(120, 0.707);
    this.hpHigh1 = new Biquad().highpass(1200, 0.707);
    this.hpHigh2 = new Biquad().highpass(1200, 0.707);
    this.envL = 0;
    this.envM = 0;
    this.envH = 0;

    /* distortion */
    this.distOn = false;
    this.drive = 0; this.driveT = 0;
    this.tone = 0.5; this.toneT = 0.5;
    this.distMix = 0.5; this.distMixT = 0.5;
    this.distBias = 0; this.distBiasT = 0;
    this.toneL = new Biquad().lowpass(4200, 0.707);
    this.toneHz = 4200;

    /* output */
    this.limGain = 1;
    this.limAtt = 1 - Math.exp(-1 / (SR * 0.001));
    this.limRel = 1 - Math.exp(-1 / (SR * 0.12));
    this.mIn = 0;
    this.mOut = 0;
    this.mN = 0;

    this.a = 1 - Math.exp(-1 / (SR * 0.03));
    this.port.onmessage = ({ data }) => this.onMessage(data);
  }

  onMessage(d) {
    if (!d || d.type !== 'params' || !d.p) return;
    const p = d.p;
    const num = (v, lo, hi, fb) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb);

    this.gainDbT = num(p.gainDb, 0, 60, 36);
    this.amtT = num(p.amt, 0, 1, 0.5);
    this.tuneSpeedT = num(p.tuneSpeed, 0, 1, 0.5);
    this.volT = num(p.vol, 0, 1.2, 0.8);
    this.tuneOn = !!p.tuneOn;

    this.dnOn = !!p.dnOn;
    this.dnThrDbT = num(p.dnThrDb, -80, -20, -55);
    this.dnDepthT = num(p.dnDepth, 0, 1, 0.85);
    this.dnStrengthT = num(p.dnStrength, 0, 1, 0.6);
    this.dnAttMsT = num(p.dnAttMs, 0.5, 50, 2);
    this.dnRelMsT = num(p.dnRelMs, 20, 600, 120);

    this.ottOn = !!p.ottOn;
    this.ottThrDbT = num(p.ottThrDb, -50, 0, -26);
    this.ottUpT = num(p.ottUp, 0, 1, 0.7);
    this.ottDownT = num(p.ottDown, 0, 1, 0.6);
    this.ottSpeedT = num(p.ottSpeed, 0, 1, 0.4);

    this.distOn = !!p.distOn;
    this.driveT = num(p.drive, 0, 1, 0);
    this.toneT = num(p.tone, 0, 1, 0.5);
    this.distMixT = num(p.distMix, 0, 1, 0.5);
    this.distBiasT = num(p.distBias, 0, 0.5, 0);

    if (Number.isFinite(p.key)) {
      this.key = Math.max(0, Math.min(23, Math.round(p.key)));
      this.keyRoot = this.key >> 1;
      this.keyMinor = this.key & 1;
    }
  }

  /* ---- pitch tracking ---- */
  trackPitch() {
    const start = this.inW - PITCH_WIN;
    if (start < 0) return;
    for (let i = 0; i < PITCH_WIN; i++) this.pitchBuf[i] = this.inRing[(start + i) & IN_MASK];

    let mean = 0;
    for (let i = 0; i < PITCH_WIN; i++) mean += this.pitchBuf[i];
    mean /= PITCH_WIN;
    const n = PITCH_WIN / PITCH_DEC;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const v = (this.pitchBuf[i * PITCH_DEC] + this.pitchBuf[i * PITCH_DEC + 1]) * 0.5 - mean;
      this.dec[i] = v;
      energy += v * v;
    }
    const sr = SR / PITCH_DEC;
    if (energy < 1e-7) { this.voiced = false; this.f0 = 0; return; }

    const lagMin = Math.max(2, Math.floor(sr / PITCH_MAX));
    const lagMax = Math.min(n - 2, Math.ceil(sr / PITCH_MIN));
    let bestLag = 0;
    let bestVal = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let sum = 0;
      const lim = n - lag;
      for (let i = 0; i < lim; i++) sum += this.dec[i] * this.dec[i + lag];
      const r = sum / energy;
      if (r > bestVal) { bestVal = r; bestLag = lag; }
    }
    if (bestVal < 0.45 || bestLag <= 0) { this.voiced = false; this.f0 = 0; return; }

    let lag = bestLag;
    {
      const l = Math.max(lagMin, bestLag - 1);
      const rlag = Math.min(lagMax, bestLag + 1);
      const val = (L) => {
        let sum = 0;
        const lim = n - L;
        for (let i = 0; i < lim; i++) sum += this.dec[i] * this.dec[i + L];
        return sum / energy;
      };
      const a = val(l);
      const b = val(bestLag);
      const c = val(rlag);
      const denom = a - 2 * b + c;
      if (Math.abs(denom) > 1e-9) lag = bestLag + (0.5 * (a - c)) / denom;
    }
    this.f0 = sr / lag;
    this.voiced = true;
    this.midi = 69 + 12 * Math.log2(this.f0 / 440);
  }

  tuneTarget(midi) {
    const scale = this.keyMinor ? SCALE_MINOR : SCALE_MAJOR;
    const root = this.keyRoot;
    const base = Math.round(midi);
    let best = base;
    let bestDist = 99;
    for (let off = -3; off <= 3; off++) {
      const m = base + off;
      const pc = (((m - root) % 12) + 12) % 12;
      if (scale.indexOf(pc) < 0) continue;
      const d = Math.abs(m - midi);
      if (d < bestDist) { bestDist = d; best = m; }
    }
    return best;
  }

  /* ---- vocoder ---- */
  frame() {
    this.hopS = Math.max(32, Math.min(N >> 2, Math.round(HA * this.ratio)));
    this.playRate = this.hopS / HA;
    const base = this.m * HA;
    const re = VOC.re;
    const im = VOC.im;
    for (let i = 0; i < N; i++) {
      re[i] = this.inRing[(base + i) & IN_MASK] * HANN[i];
      im[i] = 0;
    }
    VOC.transform(false);

    const expct = (TWO_PI * HA) / N;
    const adv = this.hopS / HA;
    im[0] = 0;
    re[BINS] = 0;
    im[BINS] = 0;
    const spectral = this.dnOn && this.dnStrength > 0.01;
    for (let k = 1; k < BINS; k++) {
      const xr = re[k];
      const xi = im[k];
      let mag = Math.sqrt(xr * xr + xi * xi);
      const ph = Math.atan2(xi, xr);

      if (spectral) {
        // learn the noise spectrum in pauses, subtract it while singing
        const nf = this.nf[k];
        if (this.quiet) this.nf[k] = nf < mag ? nf + (mag - nf) * 0.25 : nf + (mag - nf) * 0.002;
        let want = 1;
        if (mag > 1e-9) {
          const over = (this.nf[k] / mag) * 1.4;          // slight over-subtraction
          want = 1 - this.dnStrength * Math.min(1.6, over);
          if (want < 0.06) want = 0.06;                    // keep a residual floor
        }
        this.binGain[k] += (want - this.binGain[k]) * (want < this.binGain[k] ? 0.5 : 0.04);
        mag *= this.binGain[k];
      }
      let d = ph - this.lastPh[k] - k * expct;
      d -= TWO_PI * Math.round(d / TWO_PI);
      this.lastPh[k] = ph;
      let s = this.synPh[k] + (k * expct + d) * adv;
      s -= TWO_PI * Math.round(s / TWO_PI);
      this.synPh[k] = s;
      const cr = mag * Math.cos(s);
      const ci = mag * Math.sin(s);
      re[k] = cr;
      im[k] = ci;
      re[N - k] = cr;
      im[N - k] = -ci;
    }

    VOC.transform(true);

    const pos = this.olaNext;
    const from = pos > this.lastEnd ? pos : this.lastEnd;
    for (let i = from; i < pos + N; i++) {
      const idx = i & OLA_MASK;
      this.olaSig[idx] = 0;
      this.olaNorm[idx] = 0;
    }
    if (this.lastEnd < pos + N) this.lastEnd = pos + N;
    const out = VOC.re;
    for (let i = 0; i < N; i++) {
      const idx = (pos + i) & OLA_MASK;
      this.olaSig[idx] += out[i] * HANN[i];
      this.olaNorm[idx] += HANN2[i];
    }
    this.olaNext = pos + this.hopS;
    this.m++;
  }

  /* per-band OTT gain from the band envelope */
  bandGain(env) {
    const thrDown = dbToLin(this.ottThrDb);
    const thrUp = thrDown * 0.3;
    let g = 1;
    if (env > thrDown && thrDown > 0) {
      g *= Math.pow(thrDown / env, this.ottDown * (1 - 1 / 2.5));
    }
    if (env < thrUp && env > 1e-9) {
      g *= Math.pow(thrUp / env, this.ottUp * (1 - 1 / 3));
    }
    return g;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || L;
    const input = inputs[0];
    const inL = input && input[0] ? input[0] : null;
    const inR = input && input.length > 1 ? input[1] : null;
    const n = L.length;

    const ottAttBase = 1 - Math.exp(-1 / (SR * 0.004));
    const ottRelBase = 1 - Math.exp(-1 / (SR * 0.09));

    for (let i = 0; i < n; i++) {
      this.gainDb += (this.gainDbT - this.gainDb) * this.a;
      this.amt += (this.amtT - this.amt) * this.a;
      this.tuneSpeed += (this.tuneSpeedT - this.tuneSpeed) * this.a;
      this.vol += (this.volT - this.vol) * this.a;
      this.drive += (this.driveT - this.drive) * this.a;
      this.tone += (this.toneT - this.tone) * this.a;
      this.distMix += (this.distMixT - this.distMix) * this.a;
      this.distBias += (this.distBiasT - this.distBias) * this.a;
      this.dnThrDb += (this.dnThrDbT - this.dnThrDb) * this.a;
      this.dnDepth += (this.dnDepthT - this.dnDepth) * this.a;
      this.dnStrength += (this.dnStrengthT - this.dnStrength) * this.a;
      this.dnAttMs += (this.dnAttMsT - this.dnAttMs) * this.a;
      this.dnRelMs += (this.dnRelMsT - this.dnRelMs) * this.a;
      this.ottThrDb += (this.ottThrDbT - this.ottThrDb) * this.a;
      this.ottUp += (this.ottUpT - this.ottUp) * this.a;
      this.ottDown += (this.ottDownT - this.ottDown) * this.a;
      this.ottSpeed += (this.ottSpeedT - this.ottSpeed) * this.a;

      const raw = inR ? (inL[i] + inR[i]) * 0.5 : inL ? inL[i] : 0;
      let x = raw * Math.pow(10, this.gainDb / 20);

      /* denoise: downward expander with its own attack/release */
      const ax0 = x < 0 ? -x : x;
      if (this.dnOn && this.dnDepth > 0.001) {
        const dnAtt = 1 - Math.exp(-1 / (SR * (this.dnAttMs / 1000)));
        const dnRel = 1 - Math.exp(-1 / (SR * (this.dnRelMs / 1000)));
        this.dnEnv += (ax0 > this.dnEnv ? dnAtt : dnRel) * (ax0 - this.dnEnv);
        const thr = dbToLin(this.dnThrDb);
        let want = 1;
        if (this.dnEnv < thr && thr > 1e-9) {
          const open = this.dnEnv / thr;
          want = 1 - this.dnDepth * (1 - open * open);
        }
        this.dnGain += (want - this.dnGain) * 0.02;
        // the spectral stage learns its noise profile only while the gate is shut
        this.quiet = this.dnEnv < thr;
      } else {
        this.dnGain += (1 - this.dnGain) * 0.05;
        this.quiet = false;
      }

      this.inRing[this.inW & IN_MASK] = x;
      this.inW++;

      if (this.inW - this.pitchAt >= PITCH_HOP) {
        this.pitchAt = this.inW;
        this.trackPitch();
        let target = 1;
        if (this.tuneOn && this.voiced && this.f0 > 0) {
          this.targetMidi = this.tuneTarget(this.midi);
          const semis = this.targetMidi - this.midi;
          target = Math.pow(2, Math.max(-2, Math.min(2, semis)) / 12);
        }
        const k = 0.08 + this.amt * 0.35 + this.tuneSpeed * 0.5;
        this.tuneGain += (target - this.tuneGain) * k;
        this.ratioT = Math.max(0.5, Math.min(2, this.tuneGain));
      }
      this.ratio += (this.ratioT - this.ratio) * 0.35;

      let guard = 0;
      while (this.olaNext - this.p < this.hopS * 2 && guard++ < 4) {
        if (this.m * HA + N > this.inW) break;
        this.frame();
      }
      let y = 0;
      if (this.started && this.p < this.olaNext) {
        const pos = this.p;
        const i0 = Math.floor(pos);
        const f = pos - i0;
        const a0 = this.olaSig[i0 & OLA_MASK];
        const a1 = this.olaSig[(i0 + 1) & OLA_MASK];
        const n0 = this.olaNorm[i0 & OLA_MASK];
        const n1 = this.olaNorm[(i0 + 1) & OLA_MASK];
        const sig = a0 + (a1 - a0) * f;
        const norm = n0 + (n1 - n0) * f;
        y = norm > 1e-3 ? sig / norm : 0;
        this.p += this.playRate;
      }
      if (!this.started && this.m > 0) this.started = true;

      /* time-domain gate: silences what the spectral stage leaves behind */
      y *= this.dnGain;

      /* distortion: drive, tone, mix */
      if (this.distOn && this.drive > 0.001) {
        const pre = 1 + this.drive * 30;
        // bias adds asymmetry, which brings in even harmonics
        const bias = this.distBias * 2;
        const shaped = (Math.tanh(y * pre + bias) - Math.tanh(bias)) / Math.tanh(pre);
        const hz = 500 + this.tone * 8500;
        if (Math.abs(hz - this.toneHz) > 200) { this.toneHz = hz; this.toneL.set('lp', hz, 0.707); }
        const toned = this.toneL.run(shaped);
        y = y * (1 - this.distMix) + toned * this.distMix;
      }

      /* OTT */
      if (this.ottOn && (this.ottUp > 0.01 || this.ottDown > 0.01)) {
        const loA = this.lpLow2.run(this.lpLow1.run(y));
        const hiA = this.hpHigh2.run(this.hpHigh1.run(y));
        const midA = y - loA - hiA;
        const sp = this.ottSpeed;
        const att = ottAttBase * (0.25 + sp * 2.5);
        const rel = ottRelBase * (0.4 + sp * 2);
        const aL = Math.abs(loA);
        const aM = Math.abs(midA);
        const aH = Math.abs(hiA);
        this.envL += (aL > this.envL ? att : rel) * (aL - this.envL);
        this.envM += (aM > this.envM ? att : rel) * (aM - this.envM);
        this.envH += (aH > this.envH ? att : rel) * (aH - this.envH);
        y = loA * this.bandGain(this.envL)
          + midA * this.bandGain(this.envM)
          + hiA * this.bandGain(this.envH);
      }

      y *= this.vol;

      const ay = Math.abs(y);
      const want = ay > 0.95 ? 0.95 / ay : 1;
      this.limGain += (want < this.limGain ? this.limAtt : this.limRel) * (want - this.limGain);
      y = Math.tanh(y * this.limGain);

      L[i] = y;
      if (R !== L) R[i] = y;

      if (ax0 > this.mIn) this.mIn = ax0;
      if (ay > this.mOut) this.mOut = ay;
    }

    this.mN += n;
    if (this.mN >= 2048) {
      this.port.postMessage({
        type: 'meter',
        inp: this.mIn,
        out: this.mOut,
        f0: this.voiced ? Math.round(this.f0 * 10) / 10 : 0,
        midi: this.voiced ? Math.round(this.midi * 10) / 10 : 0,
        target: this.voiced && this.tuneOn ? this.targetMidi : 0,
        voiced: this.voiced ? 1 : 0,
        dn: Math.round(this.dnGain * 100) / 100
      });
      this.mN = 0;
      this.mIn = 0;
      this.mOut = 0;
    }
    return true;
  }
}

registerProcessor('vocal-chain', VocalChain);
