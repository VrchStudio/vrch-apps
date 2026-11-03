'use strict';
/* Pitch Shift audio worklet — STFT phase vocoder plus a chroma key detector.

   Vocoder: analysis frames of N samples hop by HA; each bin's phase is advanced
   by (synthesis hop / analysis hop) x its true phase advance, which stretches the
   signal by that factor without adding harmonics. The stretched stream is read
   back at the same factor, so pitch moves and duration does not. Time-domain
   normalisation by the accumulated window energy keeps the level flat for any
   synthesis hop, so the ratio can change while playing.

   Key detector: a longer FFT (CH samples) folds spectral energy into 12 pitch
   classes; the accumulated chroma is correlated with Krumhansl-Kessler major and
   minor profiles for all 12 roots. */

const SR = sampleRate;
const N = 1024;                 // vocoder FFT size (~21 ms)
const HA = 128;                 // analysis hop
const BINS = N >> 1;
const TWO_PI = Math.PI * 2;
const OLA_RING = 16384;
const OLA_MASK = OLA_RING - 1;
const IN_RING = 16384;          // holds a full chroma window
const IN_MASK = IN_RING - 1;
const DRY_RING = 4096;
const DRY_MASK = DRY_RING - 1;
const DRY_DELAY = 1024;         // dry path delay, matches the vocoder latency

const CH = 8192;                // chroma FFT size (~171 ms)
const CH_HOP = 4096;            // chroma update every ~85 ms
const CH_MIN_F = 70;            // lowest analysed frequency
const CH_MAX_F = 2200;          // highest analysed frequency

const HANN = new Float32Array(N);
for (let i = 0; i < N; i++) HANN[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / N);
const HANN2 = new Float32Array(N);
for (let i = 0; i < N; i++) HANN2[i] = HANN[i] * HANN[i];
const CH_HANN = new Float32Array(CH);
for (let i = 0; i < CH; i++) CH_HANN[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / CH);

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
  return { re, im, transform, size: n };
}

const VOC = makeFFT(N);
const CHR = makeFFT(CH);

/* Pitch class of every chroma bin, C = 0; -1 outside the analysed range. */
/* Each bin contributes to two neighbouring semitones, so a partial sitting
   between two bins is not rounded onto the wrong pitch class. */
const CH_IN = new Uint8Array((CH >> 1) + 1);
const CH_PCA = new Int8Array((CH >> 1) + 1);
const CH_PCB = new Int8Array((CH >> 1) + 1);
const CH_WA = new Float32Array((CH >> 1) + 1);
const CH_WB = new Float32Array((CH >> 1) + 1);
const CH_BASS = new Uint8Array((CH >> 1) + 1);
for (let k = 1; k <= CH >> 1; k++) {
  const f = (k * SR) / CH;
  if (f < CH_MIN_F || f > CH_MAX_F) { CH_IN[k] = 0; continue; }
  CH_IN[k] = 1;
  const midi = 69 + 12 * Math.log2(f / 440);
  const lo = Math.floor(midi);
  const fr = midi - lo;
  CH_PCA[k] = ((lo % 12) + 12) % 12;
  CH_PCB[k] = (((lo + 1) % 12) + 12) % 12;
  const w = 1 / Math.sqrt(f);             // flatter spectrum, less bass dominance
  CH_WA[k] = w * (1 - fr);
  CH_WB[k] = w * fr;
  CH_BASS[k] = f <= 330 ? 1 : 0;          // bass register, where the root lives
}

/* Key profiles, normalised (zero mean, unit norm) per root.
   Temperley's corpus-derived profiles separate relative major and minor better
   than Krumhansl-Kessler: the minor profile carries the raised leading tone. */
const PROF_MAJOR = [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0];
const PROF_MINOR = [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0];
const KEYS = [];
for (let mode = 0; mode < 2; mode++) {
  const base = mode ? PROF_MINOR : PROF_MAJOR;
  for (let root = 0; root < 12; root++) {
    const p = new Float32Array(12);
    for (let i = 0; i < 12; i++) p[(root + i) % 12] = base[i];
    let mean = 0;
    for (let i = 0; i < 12; i++) mean += p[i];
    mean /= 12;
    let norm = 0;
    for (let i = 0; i < 12; i++) { p[i] -= mean; norm += p[i] * p[i]; }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 12; i++) p[i] /= norm;
    KEYS.push({ root, minor: mode, p });
  }
}

/* Relative major/minor, or the two modes of one tonic, share their pitch
   material; switching between them must clear a higher bar. */
function isAmbiguous(a, b) {
  if (a.root === b.root) return true;
  const rel = a.minor ? (a.root + 3) % 12 : (a.root + 9) % 12;
  return b.root === rel && b.minor !== a.minor;
}

class PitchShift extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inRing = new Float32Array(IN_RING);
    this.inW = 0;
    this.olaSig = new Float32Array(OLA_RING);
    this.olaNorm = new Float32Array(OLA_RING);
    this.dryRing = new Float32Array(DRY_RING);

    /* vocoder */
    this.lastPh = new Float32Array(BINS + 1);
    this.synPh = new Float32Array(BINS + 1);
    this.ratioT = 1;
    this.ratio = 1;
    this.hopS = HA;
    this.playRate = 1;
    this.m = 0;
    this.olaNext = 0;
    this.lastEnd = 0;
    this.p = 0;
    this.started = false;

    /* key detector */
    this.chroma = new Float32Array(12);
    this.bass = new Float32Array(12);
    this.chromaTmp = new Float32Array(12);
    this.chromaTmp2 = new Float32Array(12);
    this.chromaShape = new Float32Array(12);
    this.bassShape = new Float32Array(12);
    this.band = new Float32Array((CH >> 1) + 1);      // in-band magnitudes
    this.bandIdx = new Int32Array((CH >> 1) + 1);     // their bin indices
    this.sample = new Float32Array(1024);             // subsample for percentile/flatness
    this.curKey = -1;
    this.weakReported = false;
    this.weakCount = 0;
    this.ema = new Float32Array(24).fill(-2);
    this.dwell = 0;
    this.challenger = -1;
    this.challengeCount = 0;
    this.chromaAt = 0;
    this.chromaUpdates = 0;
    this.silentSteps = 0;
    this.reportedSilence = false;
    this.keyRoot = -1;
    this.keyMinor = 0;
    this.keyR = 0;
    this.chromaOut = new Array(12).fill(0);

    /* shared parameters */
    this.mix = 1;
    this.mixT = 1;
    this.vol = 0.75;
    this.volT = 0.75;
    this.byp = 0;
    this.bypT = 0;
    this.gAmt = 0;
    this.gAmtT = 0;
    this.hpX = 0;
    this.hpY = 0;
    this.mIn = 0;
    this.mOut = 0;
    this.mN = 0;
    this.dryW = 0;
    this.a = 1 - Math.exp(-1 / (SR * 0.02));
    this.port.onmessage = ({ data }) => this.onMessage(data);
  }

  onMessage(d) {
    if (!d || d.type !== 'params' || !d.p) return;
    const p = d.p;
    const st = Number.isFinite(p.st) ? p.st : 0;
    // synthesis hop stays at or below N/4 so overlapping frames recombine cleanly
    this.ratioT = Math.max(0.5, Math.min(2, Math.pow(2, st / 12)));
    this.gAmtT = Math.abs(st) > 0.001 ? 1 : 0;
    this.mixT = Math.max(0, Math.min(1, Number(p.mix)));
    this.volT = Math.max(0, Math.min(1, Number(p.vol)));
    this.bypT = p.bypass || p.compare ? 1 : 0;
  }

  /* One vocoder frame: window -> FFT -> phase advance -> IFFT -> overlap-add. */
  frame() {
    this.ratio += (this.ratioT - this.ratio) * 0.35;
    this.hopS = Math.max(64, Math.min(N >> 2, Math.round(HA * this.ratio)));
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
    if (BINS < N) { re[BINS] = 0; im[BINS] = 0; }
    for (let k = 1; k < BINS; k++) {
      const xr = re[k];
      const xi = im[k];
      const mag = Math.sqrt(xr * xr + xi * xi);
      const ph = Math.atan2(xi, xr);
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

  /* Chroma of the most recent window, folded into the running pitch-class energy. */
  chromaStep() {
    const re = CHR.re;
    const im = CHR.im;
    const start = this.inW - CH;
    for (let i = 0; i < CH; i++) {
      re[i] = this.inRing[(start + i) & IN_MASK] * CH_HANN[i];
      im[i] = 0;
    }
    CHR.transform(false);

    // collect the in-band spectrum, then estimate its noise floor
    const band = this.band;
    const bandIdx = this.bandIdx;
    let count = 0;
    let energy = 0;
    for (let k = 1; k <= CH >> 1; k++) {
      if (!CH_IN[k]) continue;
      const xr = re[k];
      const xi = im[k];
      const mag = Math.sqrt(xr * xr + xi * xi);
      band[count] = mag;
      bandIdx[count] = k;
      energy += mag;
      count++;
    }

    // spectral flatness over a subsample: noise-like frames carry no key, skip them
    const step = Math.max(1, Math.floor(count / 512));
    let sn = 0;
    let sum = 0;
    let logSum = 0;
    for (let i = 0; i < count; i += step) {
      const m = band[i] + 1e-9;
      this.sample[sn++] = m;
      sum += m;
      logSum += Math.log(m);
    }
    const arith = sum / Math.max(1, sn);
    const flatness = arith > 0 ? Math.exp(logSum / Math.max(1, sn)) / arith : 1;

    const tmp = this.chromaTmp;
    const low = this.bassShape;               // reused as the per-frame bass fold
    tmp.fill(0);
    low.fill(0);
    if (flatness < 0.45 && sn >= 8) {
      // median-ish floor from the subsample keeps broadband hits from flooding in
      const sorted = this.sample.slice(0, sn).sort();
      const floor = sorted[Math.floor(sn * 0.25)];
      const gate = Math.max(floor * 2.5, 1e-9);
      for (let i = 0; i < count; i++) {
        const v = band[i] - gate;
        if (v <= 0) continue;
        const k = bandIdx[i];
        const a = v * CH_WA[k];
        const b = v * CH_WB[k];
        tmp[CH_PCA[k]] += a;
        tmp[CH_PCB[k]] += b;
        if (CH_BASS[k]) {
          low[CH_PCA[k]] += a;
          low[CH_PCB[k]] += b;
        }
      }
      let tsum = 0;
      for (let i = 0; i < 12; i++) tsum += tmp[i];
      if (tsum > 0) for (let i = 0; i < 12; i++) tmp[i] /= tsum;   // every frame counts once
    }

    // Several seconds of memory: a key is a property of the progression, not of
    // the chord that happens to be sounding now.
    const decay = 0.985;
    const c = this.chroma;
    const lb = this.bass;
    for (let i = 0; i < 12; i++) {
      c[i] = c[i] * decay + tmp[i];
      lb[i] = lb[i] * decay + low[i];
    }

    this.chromaUpdates++;
    if (energy > 1e-3) {
      this.silentSteps = 0;
      this.reportedSilence = false;
      if (this.chromaUpdates >= 2) this.estimateKey();
    } else if (this.silentSteps < 24) {
      this.silentSteps++;
      if (this.silentSteps === 12 && !this.reportedSilence) {
        this.reportedSilence = true;
        this.chroma.fill(0);
        this.bass.fill(0);
        this.curKey = -1;
        this.port.postMessage({ type: 'key', root: -1, minor: 0, r: 0, chroma: new Array(12).fill(0) });
      }
    }
  }

  /* Score every key on both the full chroma and the bass-register chroma.
     The bass anchors the tonic, which is what separates relative major/minor. */
  estimateKey() {
    const c = this.chroma;
    let total = 0;
    for (let i = 0; i < 12; i++) total += c[i];
    if (total < 1e-6) return;
    const shape = this.chromaShape;
    for (let i = 0; i < 12; i++) shape[i] = c[i] / total;

    const b = this.bassShape;
    let bassTotal = 0;
    for (let i = 0; i < 12; i++) bassTotal += this.bass[i];
    if (bassTotal > 1e-6) {
      for (let i = 0; i < 12; i++) b[i] = this.bass[i] / bassTotal;
    } else {
      for (let i = 0; i < 12; i++) b[i] = shape[i];
    }

    // A single note or a dyad cannot define a key: measure how many pitch
    // classes actually carry energy and refuse to name a key below that.
    let entropy = 0;
    for (let i = 0; i < 12; i++) {
      const p = shape[i];
      if (p > 1e-6) entropy -= p * Math.log(p);
    }
    const spread = Math.exp(entropy);

    let cm = 0;
    let bm = 0;
    for (let i = 0; i < 12; i++) { cm += shape[i]; bm += b[i]; }
    cm /= 12;
    bm /= 12;

    const scores = this.scores || (this.scores = new Float32Array(24));
    const corrs = this.corrs || (this.corrs = new Float32Array(24));
    for (let i = 0; i < KEYS.length; i++) {
      const p = KEYS[i].p;
      let rc = 0, rb = 0, nc = 0, nb = 0;
      for (let j = 0; j < 12; j++) {
        const dc = shape[j] - cm;
        const db = b[j] - bm;
        rc += dc * p[j];
        rb += db * p[j];
        nc += dc * dc;
        nb += db * db;
      }
      const corrC = nc > 1e-9 ? rc / Math.sqrt(nc) : 0;   // profile is unit norm
      const corrB = nb > 1e-9 ? rb / Math.sqrt(nb) : 0;
      const score = 0.9 * corrC + 0.1 * corrB;
      scores[i] = score;
      corrs[i] = corrC;
      // smooth each key's score: the decision follows a trend, not one frame
      this.ema[i] = this.ema[i] < -1.5 ? score : this.ema[i] + (score - this.ema[i]) * 0.18;
    }

    let best = -2;
    let bestKey = 0;
    let second = -2;
    let secondKey = 0;
    for (let i = 0; i < KEYS.length; i++) {
      const v = this.ema[i];
      if (v > best) { second = best; secondKey = bestKey; best = v; bestKey = i; }
      else if (v > second) { second = v; secondKey = i; }
    }

    if (spread < 2.2) {
      // not enough harmonic content to name a key at all
      this.weakCount++;
      if (!this.weakReported && this.weakCount >= 6) {
        this.weakReported = true;
        this.chromaOut.fill(0);
        this.port.postMessage({
          type: 'key', root: -1, minor: 0, r: 0, margin: 0, altRoot: -1, altMinor: 0,
          weak: true, chroma: this.chromaOut.slice(), bass: new Array(12).fill(0)
        });
      }
      return;
    }
    this.weakReported = false;
    this.weakCount = 0;

    // hysteresis: a different key must win clearly, and keep winning, to take over
    if (this.curKey < 0) {
      this.curKey = bestKey;
      this.challenger = -1;
      this.challengeCount = 0;
    } else if (bestKey !== this.curKey) {
      const lead = this.ema[bestKey] - this.ema[this.curKey];
      // relative major/minor and same-root mode flips share their material:
      // demand a much wider margin so the readout does not oscillate
      const ambiguous = isAmbiguous(KEYS[this.curKey], KEYS[bestKey]);
      const need = (ambiguous ? 0.12 : 0.05) + Math.max(0, 0.6 - corrs[bestKey]) * 0.25;
      if (lead > need) {
        if (this.challenger === bestKey) this.challengeCount++;
        else { this.challenger = bestKey; this.challengeCount = 1; }
        if (this.challengeCount >= (ambiguous ? 6 : 3) && this.dwell >= 14) {
          this.curKey = bestKey;
          this.challenger = -1;
          this.challengeCount = 0;
          this.dwell = 0;
        }
      } else {
        this.challenger = -1;
        this.challengeCount = 0;
      }
    } else {
      this.challenger = -1;
      this.challengeCount = 0;
    }
    this.dwell++;

    const k = KEYS[this.curKey];
    const alt = KEYS[secondKey];
    const margin = best - second;
    this.keyRoot = k.root;
    this.keyMinor = k.minor;
    this.keyR = corrs[this.curKey];
    for (let i = 0; i < 12; i++) this.chromaOut[i] = Math.round(shape[i] * 100) / 100;
    this.port.postMessage({
      type: 'key',
      root: k.root,
      minor: k.minor,
      r: Math.round(Math.max(0, this.keyR) * 100) / 100,
      margin: Math.round(margin * 100) / 100,
      altRoot: alt.root,
      altMinor: alt.minor,
      chroma: this.chromaOut.slice(),
      bass: Array.prototype.map.call(b, (v) => Math.round(v * 100) / 100)
    });
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || L;
    const input = inputs[0];
    const inL = input && input[0] ? input[0] : null;
    const inR = input && input.length > 1 ? input[1] : null;
    const n = L.length;

    for (let i = 0; i < n; i++) {
      this.mix += (this.mixT - this.mix) * this.a;
      this.vol += (this.volT - this.vol) * this.a;
      this.byp += (this.bypT - this.byp) * this.a;
      this.gAmt += (this.gAmtT - this.gAmt) * this.a;

      const raw = inR ? (inL[i] + inR[i]) * 0.5 : inL ? inL[i] : 0;
      const hp = raw - this.hpX + 0.995 * this.hpY;
      this.hpX = raw;
      this.hpY = hp;
      this.inRing[this.inW & IN_MASK] = hp;
      this.inW++;

      this.dryRing[this.dryW & DRY_MASK] = hp;
      const dry = this.dryRing[(this.dryW - DRY_DELAY) & DRY_MASK];
      this.dryW++;

      // keep a short, pitch-independent lookahead ahead of playback
      let guard = 0;
      while (this.olaNext - this.p < this.hopS * 2 && guard++ < 4) {
        if (this.m * HA + N > this.inW) break;
        this.frame();
      }

      let wet = 0;
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
        wet = norm > 1e-3 ? sig / norm : 0;
        this.p += this.playRate;
      }

      let y = dry + this.mix * (wet - dry);
      y = dry + (y - dry) * (1 - this.byp);
      y = Math.tanh(y * this.vol * 1.15);

      L[i] = y;
      if (R !== L) R[i] = y;

      const ax = hp < 0 ? -hp : hp;
      const ay = y < 0 ? -y : y;
      if (ax > this.mIn) this.mIn = ax;
      if (ay > this.mOut) this.mOut = ay;

      if (!this.started && this.m > 0) this.started = true;
    }

    if (this.inW >= CH && this.inW - this.chromaAt >= CH_HOP) {
      this.chromaAt = this.inW;
      this.chromaStep();
    }

    this.mN += n;
    if (this.mN >= 2048) {
      this.port.postMessage({ type: 'meter', inp: this.mIn, out: this.mOut });
      this.mN = 0;
      this.mIn = 0;
      this.mOut = 0;
    }
    return true;
  }
}

registerProcessor('pitch-shift', PitchShift);
