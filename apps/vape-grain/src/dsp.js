/* Vape Grain — ambient granular engine (AudioWorklet).
 *
 * Each preset is a small instrument: ambient pads in the spirit of a cinematic
 * pad engine (chord beds, slow or tempo-synced grain clouds, an evolving
 * "motion" layer, a long hall with octave shimmer) and hyperpop / cloud rap
 * voices (supersaw plucks, sidechain pump, reversed haze).
 * The four macros are re-mapped per preset.
 *
 * The breath is the envelope: the synth level is the input's own level, with
 * no ADSR of its own (see `process`). Its length scales the effect tails: a
 * short puff gets short echo and reverb, a long exhale long ones. Holding K3
 * (or the screen) plays like a steady exhale.
 *
 *   input ──► 4 s capture ring ─┐
 *   chord bed (per preset) ─────┤──► grains (cloud + sequenced) ──► sum
 *   drone + breath ─────────────┘
 *        sum ─► drive ─► fold ─► HP ─► SVF filter ─► formant ─► crush ─► motion
 *            ─► chorus ─► phaser ─► ping-pong delay ─► hall (+shimmer)
 *            ─► (post motion: sidechain / stutter) ─► clip
 */

const TAU = Math.PI * 2;
const RING_SECONDS = 4;
const TONE_SECONDS = 2;
const MAX_GRAINS = 48;

/* ── presets ────────────────────────────────────────────────────────────
 * bed     : 'saw' | 'sine' | 'glass' | 'bell' | 'reed' | 'noise'
 * chord   : semitones stacked in the bed (the bed is a sustained chord)
 * voices  : detuned copies per chord note, spread over `detune` cents
 * scale   : semitone offsets a grain may be transposed by
 * seq     : tempo-synced grain pulses { div: steps per beat, pattern, arp }
 * motion  : tempo-synced movement; motionRate in cycles per beat,
 *           motionShape 'sine' | 'decay' | 'ramp' | 'gate' | 'pump';
 *           motionPost moves it after the reverb (sidechain / stutter)
 * window  : grain window 'hann' | 'tukey' | 'square' | 'perc'
 * glide   : (base) semitones each grain starts above pitch, falling back over
 *           glideTime; reset by every breath, or every step with glideReset
 * base    : parameter values before macros
 * macros  : which parameter E1..E4 move, and over what range
 * lfo     : slow modulation [target, rate Hz, depth]; pitch depth in cents
 */
const PRESETS = [
  {
    id: 'DRIFT', gain: 0.85, root: 110, bed: 'saw', voices: 3, detune: 20, harmonics: 9,
    chord: [0, 7, 12], scale: [0, 0, 7, 12, -12, 19], pitchDetune: 10,
    srcMix: 0.92, breath: 0.015, drone: 0.08,
    window: 'hann', reverse: 0.30, bpm: 76,
    base: { grainLen: 0.45, dens: 16, cutoff: 2600, q: 0.15, hp: 0.05, drive: 0.08,
            crush: 0, formant: 0, chorus: 0.50, phaser: 0.10, seq: 0,
            motion: 0.15, motionRate: 0.25, motionFilter: 0.6,
            delayMix: 0.18, delayTime: 0.789, delayFb: 0.50,
            wet: 0.70, decay: 0.88, damp: 0.35, shimmer: 0.08 },
    motionShape: 'sine',
    macros: {
      grain: ['grainLen', 0.12, 1.0], air: ['dens', 4, 40],
      tone: ['cutoff', 600, 8000], space: ['wet', 0.30, 1.0]
    },
    lfo: [['cutoff', 0.05, 0.30], ['pan', 0.07, 0.5]]
  },
  {
    id: 'GLASS', gain: 0.85, root: 440, bed: 'glass', voices: 2, detune: 6,
    chord: [0, 7], scale: [0, 7, 12, 19, 24, -12], pitchDetune: 6,
    srcMix: 0.95, breath: 0.0, drone: 0.03,
    window: 'hann', reverse: 0.20, bpm: 70,
    base: { grainLen: 0.12, dens: 10, cutoff: 9000, q: 0.10, hp: 0.30, drive: 0.0,
            crush: 0, formant: 0, chorus: 0.25, phaser: 0, seq: 0,
            motion: 0, motionRate: 0.25, motionFilter: 0,
            delayMix: 0.35, delayTime: 0.643, delayFb: 0.55,
            wet: 0.75, decay: 0.92, damp: 0.15, shimmer: 0.45 },
    motionShape: 'sine',
    macros: {
      grain: ['grainLen', 0.04, 0.40], air: ['dens', 2, 24],
      tone: ['cutoff', 3000, 14000], space: ['shimmer', 0, 0.90]
    },
    lfo: [['pan', 0.13, 0.7]]
  },
  {
    id: 'PULSE', gain: 0.9, root: 98, bed: 'saw', voices: 3, detune: 14, harmonics: 9,
    chord: [0, 7, 15], scale: [0, 12, 7, 19], pitchDetune: 6,
    srcMix: 0.95, breath: 0.01, drone: 0.06,
    window: 'hann', reverse: 0.10, bpm: 84,
    seqDiv: 2, pattern: [1, 0.45, 0.8, 0.4, 1, 0.5, 0.7, 0.6],
    base: { grainLen: 0.25, dens: 5, cutoff: 1800, q: 0.35, hp: 0.10, drive: 0.15,
            crush: 0, formant: 0, chorus: 0.35, phaser: 0.15, seq: 1,
            motion: 0.70, motionRate: 2, motionFilter: 1.4,
            delayMix: 0.30, delayTime: 0.536, delayFb: 0.45,
            wet: 0.55, decay: 0.85, damp: 0.30, shimmer: 0 },
    motionShape: 'decay',
    macros: {
      grain: ['grainLen', 0.08, 0.60], air: ['motion', 0, 1],
      tone: ['cutoff', 500, 6000], space: ['wet', 0.20, 0.95]
    },
    lfo: [['pan', 0.09, 0.4]]
  },
  {
    id: 'CHOIR', gain: 0.88, root: 130.81, bed: 'saw', voices: 3, detune: 14, harmonics: 10,
    chord: [0, 7, 12], scale: [0, 0, 7, 12, -5], pitchDetune: 8,
    srcMix: 0.92, breath: 0.02, drone: 0.06,
    window: 'hann', reverse: 0.25, bpm: 72,
    base: { grainLen: 0.60, dens: 14, cutoff: 3500, q: 0.15, hp: 0.15, drive: 0.05,
            crush: 0, formant: 0.40, chorus: 0.60, phaser: 0, seq: 0,
            motion: 0.12, motionRate: 0.125, motionFilter: 0.3,
            delayMix: 0.15, delayTime: 0.833, delayFb: 0.40,
            wet: 0.75, decay: 0.90, damp: 0.30, shimmer: 0.15 },
    motionShape: 'sine',
    macros: {
      grain: ['formant', 0, 1], air: ['dens', 4, 30],
      tone: ['cutoff', 1200, 7000], space: ['wet', 0.30, 1.0]
    },
    lfo: [['pitch', 0.21, 6], ['pan', 0.06, 0.5]]
  },
  {
    id: 'TIDE', gain: 0.45, root: 55, bed: 'sine', voices: 2, detune: 8,
    chord: [0, 7, 12, 19], scale: [0, 12, 7, -12], pitchDetune: 5,
    srcMix: 0.95, breath: 0.01, drone: 0.22,
    window: 'hann', reverse: 0.50, bpm: 66,
    base: { grainLen: 1.2, dens: 8, cutoff: 900, q: 0.25, hp: 0, drive: 0.15,
            crush: 0, formant: 0, chorus: 0.30, phaser: 0.10, seq: 0,
            motion: 0.35, motionRate: 0.0625, motionFilter: 1.2,
            delayMix: 0.10, delayTime: 0.909, delayFb: 0.40,
            wet: 0.80, decay: 0.93, damp: 0.50, shimmer: 0 },
    motionShape: 'sine',
    macros: {
      grain: ['grainLen', 0.30, 2.0], air: ['dens', 2, 16],
      tone: ['cutoff', 250, 2500], space: ['wet', 0.30, 1.0]
    },
    lfo: [['pan', 0.04, 0.6]]
  },
  {
    id: 'DUST', gain: 0.77, root: 174.61, bed: 'saw', voices: 2, detune: 8, harmonics: 6,
    chord: [0, 4, 7, 11], scale: [0, 12, 7, -12, 5], pitchDetune: 10,
    srcMix: 0.65, breath: 0.04, drone: 0.05,
    window: 'hann', reverse: 0.20, bpm: 80,
    base: { grainLen: 0.30, dens: 12, cutoff: 2200, q: 0.20, hp: 0.10, drive: 0.25,
            crush: 0.25, formant: 0, chorus: 0.30, phaser: 0.20, wow: 0.5, seq: 0,
            motion: 0.20, motionRate: 0.5, motionFilter: 0.4,
            delayMix: 0.25, delayTime: 0.75, delayFb: 0.45,
            wet: 0.60, decay: 0.84, damp: 0.55, shimmer: 0 },
    motionShape: 'sine',
    macros: {
      grain: ['wow', 0, 1], air: ['dens', 3, 30],
      tone: ['cutoff', 600, 5000], space: ['wet', 0.20, 0.95]
    },
    lfo: []
  },
  {
    id: 'AURORA', gain: 1.05, root: 293.66, bed: 'glass', voices: 2, detune: 8,
    chord: [0, 7, 14], scale: [0, 7, 12, 14, 19, 24, 19, 14], pitchDetune: 4,
    srcMix: 0.97, breath: 0.0, drone: 0.03,
    window: 'hann', reverse: 0.10, bpm: 90,
    seqDiv: 4, arp: true,
    pattern: [1, 0, 0.6, 0, 0.8, 0, 0.5, 0.3, 1, 0, 0.6, 0.3, 0.8, 0, 0.5, 0],
    base: { grainLen: 0.18, dens: 4, cutoff: 7000, q: 0.10, hp: 0.25, drive: 0,
            crush: 0, formant: 0, chorus: 0.30, phaser: 0, seq: 0.8,
            motion: 0.20, motionRate: 0.25, motionFilter: 0.5,
            delayMix: 0.35, delayTime: 0.5, delayFb: 0.55,
            wet: 0.80, decay: 0.93, damp: 0.20, shimmer: 0.50 },
    motionShape: 'sine',
    macros: {
      grain: ['grainLen', 0.05, 0.50], air: ['seq', 0, 1],
      tone: ['cutoff', 2500, 12000], space: ['shimmer', 0, 0.90]
    },
    lfo: [['pan', 0.11, 0.6]]
  },

  /* ── hyperpop / cloud rap ─────────────────────────────────────────── */
  {
    id: 'HYPER', gain: 0.42, root: 220, bed: 'saw', voices: 5, detune: 30, harmonics: 10,
    chord: [0, 7, 12], scale: [0, 12, 7, 19, 24], pitchDetune: 8,
    srcMix: 0.95, breath: 0.02, drone: 0,
    window: 'square', reverse: 0, bpm: 160,
    base: { grainLen: 0.035, dens: 45, cutoff: 9000, q: 0.20, hp: 0.45, drive: 0.50, fold: 0.25,
            crush: 0, formant: 0, chorus: 0.35, phaser: 0, seq: 0,
            motion: 0.45, motionRate: 1, motionFilter: 0,
            delayMix: 0.25, delayTime: 0.1875, delayFb: 0.35,
            wet: 0.35, decay: 0.72, damp: 0.20, shimmer: 0 },
    motionShape: 'pump', motionPost: true,
    macros: {
      grain: ['grainLen', 0.012, 0.08], air: ['dens', 10, 80],
      tone: ['cutoff', 2000, 14000], space: ['motion', 0, 0.9]
    },
    lfo: [['pan', 0.27, 0.5]]
  },
  {
    id: 'CLOUD', gain: 1.15, root: 174.61, bed: 'saw', voices: 4, detune: 18, harmonics: 6,
    chord: [0, 4, 7, 11], scale: [0, 12, 7, -12], pitchDetune: 12,
    srcMix: 0.85, breath: 0.03, drone: 0.05,
    window: 'hann', reverse: 0.50, bpm: 135,
    base: { grainLen: 0.25, dens: 12, cutoff: 3500, q: 0.15, hp: 0.10, drive: 0.05, fold: 0,
            crush: 0, formant: 0, chorus: 0.55, phaser: 0.20, seq: 0,
            motion: 0.25, motionRate: 1, motionFilter: 0,
            delayMix: 0.35, delayTime: 0.444, delayFb: 0.50,
            wet: 0.80, decay: 0.90, damp: 0.15, shimmer: 0.25 },
    motionShape: 'pump', motionPost: true,
    macros: {
      grain: ['grainLen', 0.06, 0.40], air: ['dens', 3, 30],
      tone: ['cutoff', 800, 8000], space: ['wet', 0.3, 1.0]
    },
    lfo: [['pitch', 0.08, 15], ['pan', 0.11, 0.7]]
  }
];

// the device microphone delivers an inverted signal; flip it back upright
const INPUT_POLARITY = -1;
// input RMS that plays the synth at full level, and the most it may exceed it
const INPUT_REF = 0.06;
const INPUT_MAX = 1.5;
// level of a held K3 / touch "breath"
const HOLD_LEVEL = 0.85;
// Latched amplifier for pressure-type input. The signal arrives AC-coupled:
// a breath shows up as a one-sided (DC-like) pulse when it starts, an
// opposite-polarity pulse when it stops, and little in between. The first
// pulse switches the amplifier on, the opposite pulse switches it off.
const AMP_LEVEL = 0.85;         // synth level while the amplifier is on
const AMP_REFRACTORY = 0.3;     // s; after switching off, before it may switch on again
// Measured on the device: the opening pulse is followed within ~0.1 s by a
// small opposite ring (6-22 % of it), and the breath's end, short or long,
// gives an opposite pulse of 60-110 % of it. So only an opposite pulse of at
// least AMP_CLOSE_RATIO × the opening pulse closes the amplifier.
const AMP_CLOSE_RATIO = 0.5;
// A very short puff can also end as a fast swing from the opening side across
// zero; a swing of AMP_CLOSE_RATIO within this window closes too. The ring is
// ~50 ms after the opening pulse has died away, so it never swings that far.
const AMP_SWING_TIME = 0.012;   // s
// The microphone is read without echo cancellation, so the synth's own output
// comes back into it. The opening threshold is raised by this fraction of the
// recent output level, so that returning sound cannot open the amplifier.
const FEEDBACK_RATIO = 0.08;
const AMP_HOLDOFF = 1.5;        // s after a close in which a new opening must be...
const AMP_REOPEN_RATIO = 0.3;   // ...at least this strong vs the last breath's pulse
const AMP_MAX = 30;             // s; failsafe if the closing pulse is missed
const PULSE_DC_RATIO = 0.5;     // |mean| / RMS above which a pulse is DC-like
// a breath ends after the input stays below half the trigger level this long
const BREATH_GAP = 0.15;
// breath length → tail scale: TAIL_MIN at or below SHORT_BREATH, TAIL_MAX at
// or above LONG_BREATH, logarithmic in between (1× at about 0.7 s)
const SHORT_BREATH = 0.25;
const LONG_BREATH = 4;
const TAIL_MIN = 0.4;
const TAIL_MAX = 2.0;
// overall lengthening of every echo and reverb tail
const TAIL_BOOST = 1.3;

const VOWELS = [[800, 1150], [500, 1800], [300, 2300], [500, 900], [350, 800]];

// Freeverb tunings at 44.1 kHz; scaled to the running rate.
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const SPREAD = 23;
const SHIFT_LEN = 4096;

/* ── small DSP blocks ─────────────────────────────────────────────────── */
class Comb {
  constructor(length) {
    this.buf = new Float32Array(Math.max(1, length | 0));
    this.i = 0;
    this.store = 0;
  }
  process(input, feedback, damp) {
    const out = this.buf[this.i];
    this.store = out * (1 - damp) + this.store * damp;
    this.buf[this.i] = input + this.store * feedback;
    if (++this.i >= this.buf.length) this.i = 0;
    return out;
  }
}

class Allpass {
  constructor(length) {
    this.buf = new Float32Array(Math.max(1, length | 0));
    this.i = 0;
  }
  process(input, feedback) {
    const bufout = this.buf[this.i];
    const out = -input + bufout;
    this.buf[this.i] = input + bufout * feedback;
    if (++this.i >= this.buf.length) this.i = 0;
    return out;
  }
}

class DelayLine {
  constructor(seconds, sr) {
    this.buf = new Float32Array(Math.max(2, Math.ceil(seconds * sr)));
    this.i = 0;
  }
  read(delaySamples) {
    // Wrap into [0, len): a plain `while (p < 0) p += len` can round back up to
    // exactly len when the delay time is a whole number of samples, which would
    // read past the end and turn the whole delay path into NaN.
    const len = this.buf.length;
    let p = this.i - delaySamples;
    p -= Math.floor(p / len) * len;
    if (!(p >= 0 && p < len)) p = 0;
    const i0 = p | 0;
    const i1 = i0 + 1 >= len ? 0 : i0 + 1;
    const f = p - i0;
    return this.buf[i0] * (1 - f) + this.buf[i1] * f;
  }
  write(v) {
    this.buf[this.i] = v;
    if (++this.i >= this.buf.length) this.i = 0;
  }
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Motion shapes, m in [0, 1) → level in [0, 1]. */
function motionValue(m, shape) {
  if (shape === 'decay') return Math.min(1, m * 25) * Math.exp(-m * 5);
  if (shape === 'ramp') return m;
  if (shape === 'gate') return m < 0.5 ? 1 : 0;
  if (shape === 'pump') return 1 - (1 - m) * (1 - m);
  return 0.5 + 0.5 * Math.cos(TAU * m);
}

/** Sine partials of a preset's chord bed: { f, a, ph }. Every frequency is a
 *  multiple of 0.5 Hz, so each completes whole cycles over the 2 s loop and
 *  grains can read across the loop point without a click. */
function bedPartials(preset, sr) {
  const list = [];
  const chord = preset.chord || [0];
  const V = Math.max(1, preset.voices || 1);
  const H = preset.harmonics || 1;
  let shape;
  if (preset.bed === 'sine') shape = [[1, 1], [2, 0.28], [3, 0.10]];
  else if (preset.bed === 'glass') shape = [[1, 1], [2, 0.45], [3, 0.22], [4.2, 0.12], [6, 0.06]];
  else if (preset.bed === 'bell') shape = [[1, 1], [2.76, 0.6], [5.4, 0.35], [8.93, 0.2]];
  else if (preset.bed === 'reed') {
    shape = [];
    for (let h = 1; h <= H; h += 2) shape.push([h, 1 / h]);
  } else {
    shape = [];
    for (let h = 1; h <= H; h++) shape.push([h, 1 / Math.pow(h, 1.15)]);
  }
  let k = 0;
  chord.forEach((semi, ci) => {
    const base = preset.root * Math.pow(2, semi / 12);
    const noteAmp = ci === 0 ? 1 : 0.7;
    for (let v = 0; v < V; v++) {
      const cents = V > 1 ? (v / (V - 1) - 0.5) * (preset.detune || 0) : 0;
      const det = Math.pow(2, cents / 1200);
      for (const [ratio, amp] of shape) {
        const f = Math.round(base * ratio * det * 2) / 2;
        if (f <= 0 || f > sr * 0.4) continue;
        list.push({ f, a: (amp * noteAmp) / V, ph: (k++ * 2.39996) % TAU });
      }
    }
  });
  return list;
}

/* Chord beds are synthesised outside the audio thread: the page loads this
 * file as a plain script too, builds each bed in small chunks with
 * createBedJob / stepBedJob, and posts the finished buffer to the processor. */
function createBedJob(preset, sr) {
  const n = Math.floor(TONE_SECONDS * sr);
  const parts = preset.bed === 'noise' ? [] : bedPartials(preset, sr);
  const P = parts.length;
  const job = {
    buf: new Float32Array(n), i: 0, P, noise: preset.bed === 'noise', lp: 0,
    c: new Float64Array(P), s: new Float64Array(P),
    x: new Float64Array(P), y: new Float64Array(P), a: new Float64Array(P)
  };
  parts.forEach((p, k) => {
    const w = TAU * p.f / sr;
    job.c[k] = Math.cos(w); job.s[k] = Math.sin(w);
    job.x[k] = Math.cos(p.ph); job.y[k] = Math.sin(p.ph);
    job.a[k] = p.a;
  });
  return job;
}

/** Advance a bed job by about maxOps partial-samples; true once complete. */
function stepBedJob(job, maxOps) {
  const { buf, P, c, s, x, y, a } = job;
  const n = buf.length;
  const end = Math.min(n, job.i + Math.max(256, Math.floor(maxOps / Math.max(1, P))));
  for (let i = job.i; i < end; i++) {
    let v = 0;
    if (job.noise) {
      job.lp += (Math.random() * 2 - 1 - job.lp) * 0.25;
      v = job.lp;
    }
    for (let k = 0; k < P; k++) {
      v += y[k] * a[k];
      const nx = x[k] * c[k] - y[k] * s[k];
      y[k] = x[k] * s[k] + y[k] * c[k];
      x[k] = nx;
    }
    buf[i] = v;
  }
  job.i = end;
  if (end < n) return false;
  if (job.noise) {
    const fade = Math.min(n >> 1, 960);
    for (let i = 0; i < fade; i++) {
      buf[i] *= i / fade;
      buf[n - 1 - i] *= i / fade;
    }
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += buf[i] * buf[i];
  const k = 0.12 / (Math.sqrt(sum / n) || 1);
  for (let i = 0; i < n; i++) buf[i] *= k;
  return true;
}

const Processor = typeof AudioWorkletProcessor === 'function' ? AudioWorkletProcessor : class {};

class VapeGrainProcessor extends Processor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const sr = sampleRate;
    this.sr = sr;

    this.ringLen = Math.floor(RING_SECONDS * sr);
    this.ring = new Float32Array(this.ringLen);
    this.write = 0;

    this.presetIndex = Math.max(0, Math.min(PRESETS.length - 1, opts.preset | 0));
    this.beds = [];
    this.bed = null;

    this.targetMacros = { grain: 0.5, air: 0.5, tone: 0.5, space: 0.5 };
    this.macros = { grain: 0.5, air: 0.5, tone: 0.5, space: 0.5 };
    const m = opts.macros || {};
    for (const k of ['grain', 'air', 'tone', 'space']) {
      if (Number.isFinite(m[k])) this.targetMacros[k] = this.macros[k] = clamp01(m[k]);
    }

    this.demo = !!opts.demo;
    this.demoClock = 0;
    this.demoGap = 1.6;

    this.grains = [];
    for (let i = 0; i < MAX_GRAINS; i++) {
      this.grains.push({ on: false, age: 0, dur: 1, pos: 0, rate: 1, rm: 1, amp: 1, panL: 0.7, panR: 0.7, buf: null });
    }

    this.energy = 0;
    this.peak = 0;
    this.floor = 0.0015;
    this.wasOn = false;
    this.puffEnv = 0;
    this.held = false;
    this.holdEnv = 0;
    this.dc = 0;
    this.lastPulse = 0;
    this.latched = false;
    this.latchSign = 0;
    this.openPeak = 0;
    this.lastPeak = 0;
    this.dcHist = new Float32Array(8);
    this.dcHistAt = 0;
    this.latchAge = AMP_REFRACTORY;
    this.ampEnv = 0;
    this.holdLp = 0;
    this.quiet = 0;
    this.gate = false;
    this.env = 0;
    this.glideEnv = 0;
    this.gateTime = 1;
    this.tailScale = 1;
    this.muted = false;

    this.dronePhase = [0, 0, 0, 0];
    this.droneLfo = [0, 0, 0, 0];

    this.fL = 0; this.bL = 0; this.fR = 0; this.bR = 0;
    this.fm1L = 0; this.fm1bL = 0; this.fm2L = 0; this.fm2bL = 0;
    this.fm1R = 0; this.fm1bR = 0; this.fm2R = 0; this.fm2bR = 0;
    this.hpL = 0;
    this.hpR = 0;

    this.holdL = 0; this.holdR = 0; this.holdCount = 0;

    this.chorusL = new DelayLine(0.05, sr);
    this.chorusR = new DelayLine(0.05, sr);
    this.chorusPhase = 0;

    this.apL = [0, 0, 0, 0].map(() => ({ x: 0, y: 0 }));
    this.apR = [0, 0, 0, 0].map(() => ({ x: 0, y: 0 }));
    this.phaserPhase = 0;

    this.delayL = new DelayLine(2, sr);
    this.delayR = new DelayLine(2, sr);

    const scale = sr / 44100;
    this.combL = COMBS.map((n) => new Comb(n * scale));
    this.combR = COMBS.map((n) => new Comb((n + SPREAD) * scale));
    this.apLhall = ALLPASSES.map((n) => new Allpass(n * scale));
    this.apRhall = ALLPASSES.map((n) => new Allpass((n + SPREAD) * scale));

    // octave-up shimmer: two crossfaded taps sweeping a short delay line
    this.shift = new DelayLine(SHIFT_LEN / sr + 0.01, sr);
    this.shiftPhase = 0;
    this.shimLp = 0;
    this.shimFb = 0;

    this.beats = 0;
    this.seqPhase = 0;
    this.seqStep = -1;
    this.arpStep = 0;
    this.motionAmp = 1;

    this.time = 0;
    this.blockCount = 0;
    this.outLevel = 0;
    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  onMessage(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'macros' && data.value) {
      for (const k of ['grain', 'air', 'tone', 'space']) {
        if (Number.isFinite(data.value[k])) this.targetMacros[k] = clamp01(data.value[k]);
      }
    } else if (data.type === 'preset') {
      const next = Math.max(0, Math.min(PRESETS.length - 1, data.index | 0));
      if (next !== this.presetIndex) {
        this.presetIndex = next;
        this.bed = this.beds[next] || null;
        this.beats = 0;
        this.seqPhase = 0;
        this.seqStep = -1;
        this.arpStep = 0;
      }
    } else if (data.type === 'bed') {
      const index = data.index | 0;
      if (data.buf instanceof Float32Array && index >= 0 && index < PRESETS.length) {
        this.beds[index] = data.buf;
        if (index === this.presetIndex) this.bed = data.buf;
      }
    } else if (data.type === 'mute') {
      this.muted = !!data.on;
      if (this.muted) this.puffEnv = 0;
    } else if (data.type === 'hold') {
      this.held = !!data.on;
    }
  }

  closeAmp() {
    this.latched = false;
    this.latchAge = 0;
    this.lastPeak = this.openPeak;
  }

  /** Resolve macros into this block's parameter set. */
  params(preset, t) {
    const p = { ...preset.base };
    for (const key of ['grain', 'air', 'tone', 'space']) {
      const map = preset.macros[key];
      if (map) p[map[0]] = map[1] + (map[2] - map[1]) * this.macros[key];
    }
    p.lfoCents = 0;
    p.lfoPan = 0;
    for (const [target, rate, depth] of preset.lfo) {
      const v = Math.sin(TAU * rate * t);
      if (target === 'cutoff') p.cutoff *= 1 + depth * v;
      else if (target === 'pitch') p.lfoCents = depth * v;
      else if (target === 'pan') p.lfoPan = depth * v;
    }
    if (p.wow) {
      // tape wow + flutter: two incommensurate slow ripples on pitch
      p.lfoCents += p.wow * 35 * Math.sin(TAU * 0.62 * t + 1.3 * Math.sin(TAU * 0.11 * t));
    }
    return p;
  }

  spawn(preset, p, ampScale, semitone) {
    let g = null;
    let oldest = this.grains[0];
    for (let i = 0; i < this.grains.length; i++) {
      const v = this.grains[i];
      if (!v.on) { g = v; break; }
      if (v.age / v.dur > oldest.age / oldest.dur) oldest = v;
    }
    if (!g) g = oldest;

    const scale = preset.scale;
    const semi = semitone !== undefined ? semitone : scale[(Math.random() * scale.length) | 0];
    const reverse = Math.random() < preset.reverse;
    const durSec = Math.max(0.012, p.grainLen * (0.6 + Math.random() * 0.8));
    let pan = (Math.random() * 2 - 1) * 0.9 + p.lfoPan;
    pan = pan < -1 ? -1 : pan > 1 ? 1 : pan;

    g.on = true;
    g.age = 0;
    g.dur = Math.max(64, durSec * this.sr);
    const cents = p.lfoCents + (Math.random() - 0.5) * (preset.pitchDetune || 0);
    g.rate = Math.pow(2, (semi + cents / 100) / 12) * (reverse ? -1 : 1);
    g.rm = (p.glide || 0) > 0.01 ? Math.pow(2, (p.glide * this.glideEnv) / 12) : 1;
    // until the page delivers this preset's bed, grains read the breath only
    const tone = this.bed !== null && Math.random() < preset.srcMix;
    g.buf = tone ? this.bed : this.ring;
    g.pos = (g.buf.length * Math.random()) | 0;
    const angle = (pan + 1) * Math.PI * 0.25;
    g.panL = Math.cos(angle);
    g.panR = Math.sin(angle);
    g.amp = (0.5 + Math.random() * 0.5) * ampScale;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : out[0];
    const input = inputs[0] && inputs[0][0] ? inputs[0][0] : null;
    const inputR = inputs[0] && inputs[0][1] ? inputs[0][1] : null;
    const frames = outL.length;
    const sr = this.sr;
    const dt = frames / sr;
    const preset = PRESETS[this.presetIndex];

    const smooth = 1 - Math.exp(-dt / 0.06);
    for (const k of ['grain', 'air', 'tone', 'space']) {
      this.macros[k] += (this.targetMacros[k] - this.macros[k]) * smooth;
    }
    this.time += dt;
    const p = this.params(preset, this.time);

    // capture + energy
    let sum = 0;
    let sumX = 0;
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      let x;
      if (input) x = INPUT_POLARITY * (inputR ? (input[i] + inputR[i]) * 0.5 : input[i]);
      else if (this.demo) x = this.demoSample(dt);
      else x = 0;
      // a held K3 / touch, or the latched amplifier, writes a soft breath into
      // the ring for the grains; it is not counted as input energy
      let w = x;
      if (this.held || this.latched) {
        const white = Math.random() * 2 - 1;
        this.holdLp += (white - this.holdLp) * 0.35;
        w += (white * 0.25 + this.holdLp * 0.75) * 0.3;
      }
      this.ring[this.write] = w;
      if (++this.write >= this.ringLen) this.write = 0;
      sum += x * x;
      sumX += x;
      const a = x < 0 ? -x : x;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / frames);
    this.energy += (rms - this.energy) * (1 - Math.exp(-dt / 0.02));
    this.peak = Math.max(peak, this.peak * 0.82);

    // Noise floor: falls fast, rises slowly between breaths, and barely moves
    // during one — otherwise a steady exhale is learned as noise within
    // ~0.3 s and cut off. A constant noise (fan, hum) is still absorbed in ~10 s.
    // It also holds still while the amplifier is on or the synth is sounding:
    // the synth's own sound coming back through the microphone would
    // otherwise raise the threshold above the weak pulse that ends a breath.
    const rise = this.wasOn || this.latched || this.outLevel > 0.01 ? 0.00005 : 0.0015;
    this.floor += (this.energy - this.floor) * (this.energy < this.floor ? 0.35 : rise);
    if (this.floor < 1e-6) this.floor = 1e-6;
    const baseThreshold = this.floor * 6 + 0.0035;
    const threshold = baseThreshold + this.outLevel * FEEDBACK_RATIO;

    // A breath starts above the threshold and lasts until the input has stayed
    // below half of it for BREATH_GAP, so the natural wobble of an exhale does
    // not chop it into short one-shots.
    if (this.energy > (this.wasOn ? threshold * 0.5 : threshold)) this.quiet = 0;
    else this.quiet += dt;
    const on = this.wasOn ? this.quiet < BREATH_GAP : this.energy > threshold;
    this.wasOn = on;

    // ── latched amplifier ───────────────────────────────────────────────
    // A pulse is DC-like when its signed mean is a large part of the same
    // block's RMS (a noisy exhale into a microphone averages out to ~0 and
    // never counts). The raw block mean is used, unsmoothed, so that on a very
    // short puff the opening and closing pulses stay apart.
    this.dc = sumX / frames;
    // the feedback margin only guards opening, so a closing pulse is still
    // seen while the synth is loud
    const pulseLevel = Math.max((this.latched ? baseThreshold : threshold) * 1.5, rms * PULSE_DC_RATIO);
    const pulse = this.dc > pulseLevel ? 1 : this.dc < -pulseLevel ? -1 : 0;
    const strength = this.dc < 0 ? -this.dc : this.dc;
    this.latchAge += dt;
    if (!this.latched) {
      // shortly after a breath, the slow rebound of the coupling may cross
      // the pulse level again; only a pulse comparable to the last one opens
      const reopen = this.latchAge > AMP_HOLDOFF || strength >= this.lastPeak * AMP_REOPEN_RATIO;
      if (pulse !== 0 && pulse !== this.lastPulse && this.latchAge > AMP_REFRACTORY && reopen) {
        this.latched = true;
        this.latchSign = pulse;
        this.latchAge = 0;
        this.openPeak = strength;
      }
    } else if (pulse === this.latchSign) {
      this.openPeak = Math.max(this.openPeak, strength);
    } else if (pulse === -this.latchSign) {
      const n = Math.min(this.dcHist.length, Math.max(1, Math.round(AMP_SWING_TIME / dt)));
      let toward = 0;
      for (let j = 0; j < n; j++) {
        const v = this.latchSign * this.dcHist[(this.dcHistAt - j + this.dcHist.length) % this.dcHist.length];
        if (v > toward) toward = v;
      }
      const close = this.openPeak * AMP_CLOSE_RATIO;
      if (strength >= close || toward + strength >= close) this.closeAmp();
    }
    this.lastPulse = pulse;
    this.dcHistAt = (this.dcHistAt + 1) % this.dcHist.length;
    this.dcHist[this.dcHistAt] = this.dc;
    if (this.latched && this.latchAge > AMP_MAX) this.closeAmp();
    if (this.muted) this.latched = false;

    // ── the input's own envelope drives the synth ───────────────────────
    // No ADSR of its own: the synth level is the input's RMS (20 ms follower)
    // above the noise floor, linear, with INPUT_REF as full scale. The breath
    // already carries its attack, swell and fade; release, echo and reverb
    // tails only come from the effects, scaled by the breath's length.
    const envStart = this.env;
    // the switching pulses are control, not sound: they never reach the synth
    let level = pulse !== 0 ? 0
      : Math.min(INPUT_MAX, Math.max(0, this.energy - threshold * 0.5) / INPUT_REF);
    // a held K3 / touch ramps like the input follower (20 ms), not a jump
    this.holdEnv += ((this.held ? HOLD_LEVEL : 0) - this.holdEnv) * (1 - Math.exp(-dt / 0.02));
    // the amplifier fades in over 20 ms and out over 80 ms
    const ampTarget = this.latched ? AMP_LEVEL : 0;
    this.ampEnv += (ampTarget - this.ampEnv) *
      (1 - Math.exp(-dt / (ampTarget > this.ampEnv ? 0.02 : 0.08)));
    level = Math.max(level, this.holdEnv, this.ampEnv);
    if (this.muted) level = 0;
    this.puffEnv = Math.min(1, level);

    const gate = !this.muted && (on || this.held || this.latched);
    const bps = (preset.bpm || 80) / 60;
    if (gate && !this.gate) {
      this.gateTime = 0;
      this.glideEnv = 1;
      if (envStart < 0.02) {
        // a fresh phrase: the breath starts the groove on the downbeat
        this.beats = 0;
        this.seqPhase = 1;
        this.seqStep = -1;
        this.arpStep = 0;
      }
    }
    this.gate = gate;

    // the current (or last) breath's length sets how long echo and reverb
    // ring; it grows while the breath lasts and is held after it ends
    if (gate) this.gateTime += dt;
    const breath = Math.max(SHORT_BREATH, Math.min(LONG_BREATH, this.gateTime));
    const tailTarget = TAIL_MIN + (TAIL_MAX - TAIL_MIN) *
      (Math.log(breath / SHORT_BREATH) / Math.log(LONG_BREATH / SHORT_BREATH));
    this.tailScale += (tailTarget - this.tailScale) * (1 - Math.exp(-dt / 0.25));

    this.env = level;
    const envEnd = this.env;
    this.glideEnv *= Math.exp(-dt / Math.max(0.02, p.glideTime || 0.2));

    // tempo clock (sequenced grains + motion)
    const beatStart = this.beats;
    this.beats += bps * dt;

    // grains
    if (this.env > 0.01 && !this.muted) {
      let budget = p.dens * Math.min(1, this.env * 2) * dt;
      while (budget > 0) {
        if (Math.random() < budget) this.spawn(preset, p, 1);
        budget -= 1;
      }
      if (preset.pattern && p.seq > 0.01) {
        this.seqPhase += bps * (preset.seqDiv || 4) * dt;
        while (this.seqPhase >= 1) {
          this.seqPhase -= 1;
          this.seqStep = (this.seqStep + 1) % preset.pattern.length;
          const vel = preset.pattern[this.seqStep] * p.seq;
          if (vel > 0.02) {
            if (preset.glideReset) this.glideEnv = 1;
            let semi;
            if (preset.arp) semi = preset.scale[this.arpStep++ % preset.scale.length];
            this.spawn(preset, p, vel * 1.4, semi);
          }
        }
      }
    }

    // ── per-sample ──────────────────────────────────────────────────────
    const motion = clamp01(p.motion || 0);
    const motionRate = p.motionRate || 0.25;
    const shape = preset.motionShape;
    const mBlock = motionValue((beatStart * motionRate) % 1, shape);
    const cutoffMod = Math.pow(2, (p.motionFilter || 0) * motion * (mBlock - 0.5) * 2);
    const cutoff = Math.max(80, Math.min(sr * 0.15, p.cutoff * cutoffMod));
    const fCoef = 2 * Math.sin(Math.PI * cutoff / sr);
    const qd = 0.4 + p.q;
    const hpFreq = 25 * Math.pow(2, (p.hp || 0) * 7.5);
    const hpCoef = 1 - Math.exp(-TAU * Math.min(hpFreq, sr * 0.2) / sr);
    const drive = 1 + p.drive * 6;
    const driveNorm = 1 / (1 + p.drive * 1.6);
    const foldAmt = 1 + (p.fold || 0) * 6;
    const crushLevels = p.crush > 0.01 ? Math.pow(2, 12 - p.crush * 8) : 0;
    const crushHold = p.crush > 0.01 ? 1 + Math.floor(p.crush * 5) : 1;
    const delaySamples = Math.max(1, p.delayTime * sr);
    const wet = this.muted ? 0 : p.wet;
    const tail = this.tailScale * TAIL_BOOST;
    const hallFb = Math.min(0.988, Math.pow(0.74 + clamp01(p.decay) * 0.24, 1 / tail));
    const delayFb = Math.min(0.92, Math.pow(Math.min(0.85, Math.max(0, p.delayFb) + 0.1), 1 / tail));
    const delayMix = Math.min(0.6, p.delayMix * 1.25);
    const hallDamp = 0.05 + clamp01(p.damp) * 0.45;
    const shimmer = clamp01(p.shimmer || 0);
    const chorusDepth = p.chorus * 0.004 * sr;
    const chorusBase = 0.010 * sr;
    const live = this.muted ? 0 : 1;
    const droneScale = preset.drone * live * 0.5;
    const breathGain = preset.breath * this.puffEnv * live;
    // equal-loudness across grain size and density: overlap grows ~ dens × len
    const grainScale = (1.1 / Math.sqrt(1 + p.dens * p.grainLen)) * live;
    // the envelope is ramped per sample, so fast attacks do not step per block
    const envStep = (envEnd - envStart) / frames;
    let envNow = envStart;
    const glideK = Math.exp(-1 / (Math.max(0.02, p.glideTime || 0.2) * sr));
    const percAttack = 1 / (0.003 * sr);
    const post = !!preset.motionPost;
    const beatStep = (bps * motionRate) / sr;
    const motionSlew = 1 - Math.exp(-1 / (0.004 * sr));
    const shiftStep = 1 / SHIFT_LEN;

    // formant vowels (A E I O U), morphed by the macro
    let f1 = 0;
    let f2 = 0;
    if (p.formant > 0.005) {
      const pos = clamp01(p.formant) * (VOWELS.length - 1);
      const i0 = Math.min(VOWELS.length - 1, pos | 0);
      const i1 = Math.min(VOWELS.length - 1, i0 + 1);
      const f = pos - i0;
      f1 = VOWELS[i0][0] + (VOWELS[i1][0] - VOWELS[i0][0]) * f;
      f2 = VOWELS[i0][1] + (VOWELS[i1][1] - VOWELS[i0][1]) * f;
    }
    const c1 = 2 * Math.sin(Math.PI * Math.min(f1 || 500, sr * 0.12) / sr);
    const c2 = 2 * Math.sin(Math.PI * Math.min(f2 || 1500, sr * 0.12) / sr);
    const fmMix = Math.min(1, p.formant * 1.2);

    let mPhase = (beatStart * motionRate) % 1;

    for (let i = 0; i < frames; i++) {
      let dryL = 0;
      let dryR = 0;
      envNow += envStep;
      const droneGain = droneScale * envNow;
      const grainGain = grainScale * envNow;

      // drone
      if (droneGain > 1e-5) {
        let d = 0;
        for (let k = 0; k < 4; k++) {
          const vib = 1 + 0.0025 * Math.sin(this.droneLfo[k] + k);
          this.dronePhase[k] += (preset.root * (1 + k * 0.5) * vib) / sr;
          if (this.dronePhase[k] >= 1) this.dronePhase[k] -= 1;
          d += Math.sin(this.dronePhase[k] * TAU) / (k + 1);
          this.droneLfo[k] += 0.00002 * (1 + k * 0.37);
        }
        dryL += d * droneGain;
        dryR += d * droneGain;
      }

      // grains
      for (let gi = 0; gi < this.grains.length; gi++) {
        const g = this.grains[gi];
        if (!g.on) continue;
        const buf = g.buf;
        const len = buf.length;
        let pos = g.pos;
        if (pos < 0) pos += len;
        if (pos >= len) pos -= len;
        const i0 = pos | 0;
        const i1 = i0 + 1 >= len ? 0 : i0 + 1;
        const frac = pos - i0;
        const s = buf[i0] * (1 - frac) + buf[i1] * frac;
        const x = g.age / g.dur;
        let w;
        if (preset.window === 'tukey') w = Math.min(1, x * 5, (1 - x) * 5);
        else if (preset.window === 'square') w = Math.min(1, x * 12, (1 - x) * 12);
        else if (preset.window === 'perc') w = Math.min(1, g.age * percAttack, (1 - x) * 20) * Math.exp(-3 * x);
        else w = 0.5 - 0.5 * Math.cos(TAU * x);
        const a = s * w * g.amp * grainGain;
        dryL += a * g.panL;
        dryR += a * g.panR;

        if (g.rm !== 1) {
          g.rm = 1 + (g.rm - 1) * glideK;
          if (g.rm - 1 < 1e-4 && 1 - g.rm < 1e-4) g.rm = 1;
        }
        g.pos += g.rate * g.rm;
        if (g.pos >= len) g.pos -= len;
        if (g.pos < 0) g.pos += len;
        if (++g.age >= g.dur) g.on = false;
      }

      if (breathGain > 0 && input) {
        const b = INPUT_POLARITY * input[i] * breathGain;
        dryL += b;
        dryR += b;
      }

      // saturation → wavefold
      let l = Math.tanh(dryL * drive) * driveNorm;
      let r = Math.tanh(dryR * drive) * driveNorm;
      if (foldAmt > 1.01) {
        l = Math.sin(l * foldAmt);
        r = Math.sin(r * foldAmt);
      }

      // high-pass
      this.hpL += (l - this.hpL) * hpCoef;
      this.hpR += (r - this.hpR) * hpCoef;
      l -= this.hpL;
      r -= this.hpR;

      // state-variable low-pass
      this.fL += fCoef * this.bL;
      const highL = l - this.fL - qd * this.bL;
      this.bL += fCoef * highL;
      this.fR += fCoef * this.bR;
      const highR = r - this.fR - qd * this.bR;
      this.bR += fCoef * highR;
      l = this.fL;
      r = this.fR;

      // formant (vowel) filter
      if (fmMix > 0.005) {
        this.fm1L += c1 * this.fm1bL;
        const h1L = l - this.fm1L - 0.7 * this.fm1bL;
        this.fm1bL += c1 * h1L;
        this.fm2L += c2 * this.fm2bL;
        const h2L = l - this.fm2L - 0.7 * this.fm2bL;
        this.fm2bL += c2 * h2L;
        this.fm1R += c1 * this.fm1bR;
        const h1R = r - this.fm1R - 0.7 * this.fm1bR;
        this.fm1bR += c1 * h1R;
        this.fm2R += c2 * this.fm2bR;
        const h2R = r - this.fm2R - 0.7 * this.fm2bR;
        this.fm2bR += c2 * h2R;
        l = l * (1 - fmMix * 0.55) + (this.fm1bL * 1.4 + this.fm2bL * 0.9) * fmMix;
        r = r * (1 - fmMix * 0.55) + (this.fm1bR * 1.4 + this.fm2bR * 0.9) * fmMix;
      }

      // crush (lo-fi grit)
      if (crushLevels > 0) {
        if (this.holdCount <= 0) {
          this.holdL = Math.round(l * crushLevels) / crushLevels;
          this.holdR = Math.round(r * crushLevels) / crushLevels;
          this.holdCount = crushHold;
        }
        this.holdCount--;
        l = this.holdL;
        r = this.holdR;
      }

      // motion: tempo-synced volume pulses — before the space so ambient
      // tails stay smooth, or after it (post) for sidechain pump and stutter
      if (motion > 0.005) {
        const target = 1 - motion * (1 - motionValue(mPhase, shape));
        this.motionAmp += (target - this.motionAmp) * motionSlew;
        mPhase += beatStep;
        if (mPhase >= 1) mPhase -= 1;
        if (!post) {
          l *= this.motionAmp;
          r *= this.motionAmp;
        }
      }

      // chorus
      if (p.chorus > 0.01) {
        this.chorusPhase += TAU * 0.31 / sr;
        if (this.chorusPhase > TAU) this.chorusPhase -= TAU;
        const dL = chorusBase + chorusDepth * (0.5 + 0.5 * Math.sin(this.chorusPhase));
        const dR = chorusBase + chorusDepth * (0.5 + 0.5 * Math.sin(this.chorusPhase + Math.PI * 0.5));
        const wl = this.chorusL.read(dL);
        const wr = this.chorusR.read(dR);
        this.chorusL.write(l);
        this.chorusR.write(r);
        l = l * (1 - p.chorus * 0.5) + wl * p.chorus * 0.8;
        r = r * (1 - p.chorus * 0.5) + wr * p.chorus * 0.8;
      }

      // phaser
      if (p.phaser > 0.01) {
        this.phaserPhase += TAU * 0.07 / sr;
        if (this.phaserPhase > TAU) this.phaserPhase -= TAU;
        const ac = 0.25 + 0.2 * Math.sin(this.phaserPhase);
        let pl = l;
        let pr = r;
        for (let s = 0; s < 4; s++) {
          const yl = -ac * pl + this.apL[s].x + ac * this.apL[s].y;
          this.apL[s].x = pl; this.apL[s].y = yl; pl = yl;
          const yr = -ac * pr + this.apR[s].x + ac * this.apR[s].y;
          this.apR[s].x = pr; this.apR[s].y = yr; pr = yr;
        }
        l = l * (1 - p.phaser * 0.5) + pl * p.phaser * 0.5;
        r = r * (1 - p.phaser * 0.5) + pr * p.phaser * 0.5;
      }

      // ping-pong delay
      const dl = this.delayL.read(delaySamples);
      const dr = this.delayR.read(delaySamples);
      this.delayL.write(l + dr * delayFb);
      this.delayR.write(r + dl * delayFb);
      l += dl * delayMix;
      r += dr * delayMix;

      // hall, with the octave shimmer fed back into its input
      const inM = ((l + r) * 0.5 + this.shimFb * shimmer * 0.12) * 0.015;
      let wl = 0;
      let wr = 0;
      for (let k = 0; k < 8; k++) {
        wl += this.combL[k].process(inM, hallFb, hallDamp);
        wr += this.combR[k].process(inM, hallFb, hallDamp);
      }
      for (let k = 0; k < 4; k++) {
        wl = this.apLhall[k].process(wl, 0.5);
        wr = this.apRhall[k].process(wr, 0.5);
      }

      if (shimmer > 0.005) {
        this.shift.write((wl + wr) * 0.5);
        this.shiftPhase += shiftStep;
        if (this.shiftPhase >= 1) this.shiftPhase -= 1;
        const ph2 = this.shiftPhase + 0.5 >= 1 ? this.shiftPhase - 0.5 : this.shiftPhase + 0.5;
        const t1 = this.shift.read((1 - this.shiftPhase) * SHIFT_LEN + 1);
        const t2 = this.shift.read((1 - ph2) * SHIFT_LEN + 1);
        const up = t1 * Math.sin(Math.PI * this.shiftPhase) + t2 * Math.sin(Math.PI * ph2);
        this.shimLp += (up - this.shimLp) * 0.35;
        this.shimFb = Math.tanh(this.shimLp);
      } else {
        this.shimFb = 0;
      }

      let oL = l * (1 - wet * 0.5) + wl * wet * 1.6;
      let oR = r * (1 - wet * 0.5) + wr * wet * 1.6;
      if (post && motion > 0.005) {
        oL *= this.motionAmp;
        oR *= this.motionAmp;
      }

      outL[i] = Math.tanh(oL * 4.5 * preset.gain) * 0.92;
      outR[i] = Math.tanh(oR * 4.5 * preset.gain) * 0.92;
    }

    // output level for the feedback guard: fast attack, slow release (the
    // reverb keeps feeding the microphone after the dry sound stops)
    let outSum = 0;
    for (let i = 0; i < frames; i++) outSum += outL[i] * outL[i];
    const outRms = Math.sqrt(outSum / frames);
    this.outLevel += (outRms - this.outLevel) *
      (1 - Math.exp(-dt / (outRms > this.outLevel ? 0.005 : 0.3)));

    this.blockCount++;
    if (this.blockCount % 3 === 0) {
      let count = 0;
      for (let g = 0; g < this.grains.length; g++) if (this.grains[g].on) count++;
      this.port.postMessage({
        type: 'meter',
        env: this.puffEnv,
        cloud: this.env,
        grains: count,
        peak: this.peak,
        listening: this.wasOn || this.latched
      });
    }
    return true;
  }

  demoSample(dt) {
    this.demoClock += dt;
    if (this.demoClock > this.demoGap) {
      this.demoClock = 0;
      this.demoGap = 7 + Math.random() * 3;
    }
    const t = this.demoClock;
    const len = 1.15;
    if (t > len) return 0;
    const env = Math.sin(Math.PI * (t / len));
    const white = Math.random() * 2 - 1;
    this._demoLp = (this._demoLp || 0) + (white - (this._demoLp || 0)) * 0.4;
    return (white * 0.22 + this._demoLp * 0.78) * env * env * 0.5;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('vape-grain', VapeGrainProcessor);
} else {
  globalThis.VapeGrainBeds = { PRESETS, createBedJob, stepBedJob };
}
