'use strict';
/* Drum 808 engine. The step sequencer and all twelve voices run here, on the
 * audio rendering thread, so step timing is sample-accurate and never waits on
 * UI work, storage or messages. The main thread only sends intent. */
const TRACKS = 12, STEPS = 16, PATTERNS = 4;
const BD = 0, SD = 1, LT = 2, MT = 3, HT = 4, RS = 5, CL = 6, CP = 7, CB = 8, CY = 9, OH = 10, CH = 11;
// The closed hat fires first on a step so its choke never cuts an open hat placed on the same step.
const ORDER = [CH, BD, SD, LT, MT, HT, RS, CL, CP, CB, CY, OH];
const VELOCITY = 0.72; // an unaccented step; an accented step plays at 1
const CEILING = 0.5; // -6 dBFS soft ceiling: the device's line-out stage adds +6 dB
// Per-voice output trims, calibrated offline so the default kit is balanced.
const TRIM = [0.353, 0.344, 0.268, 0.285, 0.301, 0.241, 0.25, 1.725, 0.356, 0.87, 1.38, 1.21];
const TOM_FREQ = [88, 128, 176], TOM_DECAY = [0.15, 0.12, 0.1];
// The six square-wave oscillators the original shares between cymbal and hats.
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];
const SR = sampleRate, TWO_PI = 2 * Math.PI;
const decayCoef = seconds => Math.exp(-1 / (seconds * SR));

function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
// Band-limited (PolyBLEP) square wave from a 0..1 phase.
function square(phase, dt) {
  let half = phase + 0.5;
  if (half >= 1) half -= 1;
  return (phase < 0.5 ? 1 : -1) + blep(phase, dt) - blep(half, dt);
}

// Zero-delay-feedback state-variable filter (Simper). band is unity-gain at the centre.
class Svf {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.low = 0; this.band = 0; this.high = 0; this.set(1000, 0.707); }
  set(freq, q) {
    const g = Math.tan(Math.PI * Math.min(freq, SR * 0.45) / SR);
    this.k = 1 / q; this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  run(x) {
    const v3 = x - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    this.low = v2; this.band = this.k * v1; this.high = x - this.k * v1 - v2;
  }
}

class Voice {
  constructor() {
    this.on = false; this.t = 0; this.amp = 0; this.env = 0; this.env2 = 0; this.pitch = 0;
    this.k1 = 0; this.k2 = 0; this.kp = 0; this.f1 = 0; this.f2 = 0; this.ph1 = 0; this.ph2 = 0;
    this.a = new Svf(); this.b = new Svf();
  }
}

class Drum808 extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cells = new Uint8Array(PATTERNS * TRACKS * STEPS);
    this.pattern = 0; this.queued = -1;
    this.bpm = 120; this.swing = 0; this.mutes = 0;
    this.level = new Float32Array(TRACKS).fill(80);
    this.tune = new Float32Array(TRACKS);
    this.decay = new Float32Array(TRACKS).fill(50);
    this.running = false; this.step = 0; this.toNext = 0; this.lateMax = 0;
    this.voices = Array.from({length: TRACKS}, () => new Voice());
    this.metal = new Float64Array(METAL.length);
    this.seed = 0x2545f491; this.dcX = 0; this.dcY = 0;
    this.hits = [];
    this.port.onmessage = ({data}) => this.message(data);
  }

  stepFrames() { return SR * 15 / this.bpm; }

  message(m) {
    switch (m.type) {
      case 'cells': this.cells.set(m.value); break;
      case 'cell': this.cells[m.index] = m.value; break;
      case 'tempo': {
        const before = this.stepFrames();
        this.bpm = m.value;
        // Stretch the step in progress so a tempo change takes effect at once.
        if (this.running) this.toNext *= this.stepFrames() / before;
        break;
      }
      case 'swing': this.swing = m.value; break;
      case 'mutes': this.mutes = m.value; break;
      case 'voice': this.level[m.track] = m.level; this.tune[m.track] = m.tune; this.decay[m.track] = m.decay; break;
      case 'pattern':
        if (m.now || !this.running) { this.pattern = m.index; this.queued = -1; }
        else this.queued = m.index === this.pattern ? -1 : m.index;
        break;
      case 'start': this.running = true; this.step = 0; this.toNext = 0; break;
      case 'stop': this.running = false; break;
      // Hits are triggered at the start of the next render quantum so the reported frame is exact.
      case 'hit': this.hits.push(m); break;
    }
  }

  trigger(n, velocity) {
    const v = this.voices[n];
    const tune = Math.pow(2, this.tune[n] / 12), decay = Math.pow(2, (this.decay[n] - 50) / 25);
    v.on = true; v.t = 0; v.env = 1; v.env2 = 0; v.pitch = 1;
    v.amp = velocity * Math.pow(this.level[n] / 80, 1.5) * TRIM[n];
    switch (n) {
      case BD:
        v.f1 = 49 * tune; v.ph1 = 0; v.env2 = 1;
        v.kp = decayCoef(0.008); v.k1 = decayCoef(0.22 * decay); v.k2 = decayCoef(0.0012);
        break;
      case SD:
        v.f1 = 180 * tune; v.f2 = 332 * tune; v.ph1 = 0; v.ph2 = 0; v.env2 = 1;
        v.kp = decayCoef(0.004); v.k1 = decayCoef(0.045 * decay); v.k2 = decayCoef(0.06 * decay);
        v.a.set(1800 * tune, 0.7); v.b.set(9000, 0.7);
        break;
      case LT: case MT: case HT:
        v.f1 = TOM_FREQ[n - LT] * tune; v.ph1 = 0; v.env2 = 1;
        v.kp = decayCoef(0.035); v.k1 = decayCoef(TOM_DECAY[n - LT] * decay); v.k2 = decayCoef(0.006);
        v.a.set(2500, 0.7);
        break;
      case RS:
        v.f1 = 480 * tune; v.f2 = 1690 * tune; v.ph1 = 0; v.ph2 = 0;
        v.k1 = decayCoef(0.0055 * decay); v.a.set(250, 0.7);
        break;
      case CL:
        v.f1 = 2500 * tune; v.ph1 = 0; v.k1 = decayCoef(0.016 * decay);
        break;
      case CP:
        v.a.set(1050 * tune, 2.2); v.k1 = decayCoef(0.07 * decay);
        break;
      case CB:
        v.f1 = 540 * tune; v.f2 = 800 * tune; v.ph1 = 0; v.ph2 = 0; v.env2 = 1;
        v.k1 = decayCoef(0.008); v.k2 = decayCoef(0.07 * decay);
        v.a.set(3500 * tune, 0.7); v.b.set(500, 0.7);
        break;
      case CY:
        v.env2 = 1; v.k1 = decayCoef(0.3 * decay); v.k2 = decayCoef(0.16 * decay);
        v.a.set(3500 * tune, 1.2); v.b.set(7000 * tune, 0.7);
        break;
      case OH: case CH:
        v.k1 = decayCoef((n === OH ? 0.11 : 0.015) * decay);
        v.a.set(8000 * tune, 0.9); v.b.set(6500 * tune, 0.7);
        break;
    }
    if (n === CH && this.voices[OH].on) this.voices[OH].k1 = decayCoef(0.004);
  }

  fire(frame) {
    if (this.step === 0 && this.queued >= 0) { this.pattern = this.queued; this.queued = -1; }
    const base = this.pattern * TRACKS * STEPS + this.step;
    let mask = 0;
    for (const n of ORDER) {
      const value = this.cells[base + n * STEPS];
      if (value && !((this.mutes >> n) & 1)) { this.trigger(n, value === 2 ? 1 : VELOCITY); mask |= 1 << n; }
    }
    this.lateMax = Math.max(this.lateMax, -this.toNext);
    this.port.postMessage({type: 'step', step: this.step, pattern: this.pattern, queued: this.queued, mask, frame, late: this.lateMax});
    this.toNext += this.stepFrames() * (this.step % 2 === 0 ? 1 + this.swing : 1 - this.swing);
    this.step = (this.step + 1) % STEPS;
  }

  render() {
    // One shared white-noise source, like the original's single noise generator.
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x |= 0;
    const noise = x / 2147483648;
    const vs = this.voices;
    let metal = 0;
    if (vs[CY].on || vs[OH].on || vs[CH].on) {
      for (let i = 0; i < METAL.length; i++) {
        const dt = METAL[i] / SR;
        let p = this.metal[i] + dt;
        if (p >= 1) p -= 1;
        this.metal[i] = p;
        metal += square(p, dt);
      }
      metal /= METAL.length;
    }
    let mix = 0;
    for (let n = 0; n < TRACKS; n++) {
      const v = vs[n];
      if (!v.on) continue;
      let s = 0;
      switch (n) {
        case BD:
          v.ph1 += v.f1 * (1 + 0.9 * v.pitch) / SR; if (v.ph1 >= 1) v.ph1 -= 1;
          s = Math.sin(TWO_PI * v.ph1) * v.env + 0.3 * v.env2;
          v.pitch *= v.kp; v.env *= v.k1; v.env2 *= v.k2;
          break;
        case SD: {
          const bend = 1 + 0.3 * v.pitch;
          v.ph1 += v.f1 * bend / SR; if (v.ph1 >= 1) v.ph1 -= 1;
          v.ph2 += v.f2 * bend / SR; if (v.ph2 >= 1) v.ph2 -= 1;
          v.a.run(noise); v.b.run(v.a.high);
          s = (0.6 * Math.sin(TWO_PI * v.ph1) + 0.4 * Math.sin(TWO_PI * v.ph2)) * v.env + 1.2 * v.b.low * v.env2;
          v.pitch *= v.kp; v.env *= v.k1; v.env2 *= v.k2;
          break;
        }
        case LT: case MT: case HT:
          v.ph1 += v.f1 * (1 + 0.25 * v.pitch) / SR; if (v.ph1 >= 1) v.ph1 -= 1;
          v.a.run(noise);
          s = Math.sin(TWO_PI * v.ph1) * v.env + 0.25 * v.a.low * v.env2;
          v.pitch *= v.kp; v.env *= v.k1; v.env2 *= v.k2;
          break;
        case RS:
          v.ph1 += v.f1 / SR; if (v.ph1 >= 1) v.ph1 -= 1;
          v.ph2 += v.f2 / SR; if (v.ph2 >= 1) v.ph2 -= 1;
          v.a.run(Math.tanh(3 * (0.7 * Math.sin(TWO_PI * v.ph1) + 0.9 * Math.sin(TWO_PI * v.ph2)) * v.env));
          s = v.a.high; v.env *= v.k1;
          break;
        case CL:
          v.ph1 += v.f1 / SR; if (v.ph1 >= 1) v.ph1 -= 1;
          s = Math.sin(TWO_PI * v.ph1) * v.env; v.env *= v.k1;
          break;
        case CP: {
          // Three fast noise bursts, then the decaying tail.
          const t = v.t / SR;
          let e;
          if (t < 0.0285) e = Math.exp(-(t % 0.0095) / 0.0024);
          else { e = 0.8 * v.env; v.env *= v.k1; }
          v.a.run(noise);
          s = v.a.band * e;
          break;
        }
        case CB: {
          const d1 = v.f1 / SR, d2 = v.f2 / SR;
          v.ph1 += d1; if (v.ph1 >= 1) v.ph1 -= 1;
          v.ph2 += d2; if (v.ph2 >= 1) v.ph2 -= 1;
          v.a.run(0.5 * (square(v.ph1, d1) + square(v.ph2, d2))); v.b.run(v.a.low);
          s = v.b.high * (0.65 * v.env + 0.35 * v.env2); v.env *= v.k1; v.env2 *= v.k2;
          break;
        }
        case CY:
          v.a.run(metal); v.b.run(metal);
          s = 0.6 * v.a.band * v.env + 0.8 * v.b.high * v.env2; v.env *= v.k1; v.env2 *= v.k2;
          break;
        case OH: case CH:
          v.a.run(metal); v.b.run(v.a.band);
          s = v.b.high * v.env; v.env *= v.k1;
          break;
      }
      mix += s * v.amp;
      v.t++;
      if (v.env < 1e-4 && v.env2 < 1e-4 && v.t > 1440) v.on = false;
    }
    // DC blocker, then the soft ceiling.
    const y = mix - this.dcX + 0.9987 * this.dcY;
    this.dcX = mix; this.dcY = y;
    return CEILING * Math.tanh(y / CEILING);
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    if (this.hits.length) {
      for (const m of this.hits) {
        this.trigger(m.track, m.accent ? 1 : VELOCITY);
        this.port.postMessage({type: 'hit', id: m.id, track: m.track, frame: currentFrame});
      }
      this.hits.length = 0;
    }
    for (let i = 0; i < out.length; i++) {
      if (this.running) {
        if (this.toNext <= 0) this.fire(currentFrame + i);
        this.toNext -= 1;
      }
      out[i] = this.render();
    }
    return true;
  }
}

registerProcessor('drum808-engine', Drum808);
