'use strict';
/* The engine: eight drum voices on a 16-step sequencer, all on the audio rendering thread, so step timing is
 * sample-accurate and never waits on drawing, storage or messages. The main thread only sends intent.
 *
 * The voices are the Drum 808 voices of the same name, copied from Drum 808 1.0.3 (apps/drum-808/src/engine.js at
 * commit e186da4). Each App is packaged from its own src folder alone, so the two cannot share one file. The synthesis
 * is unchanged: the engine test in tests/ compares every voice with Drum 808's, sample for sample. What differs is
 * the voice list (eight of the twelve), the processor name, and the step report, which also names the accented voices
 * so the picture can draw them. */
const TRACKS = 8, STEPS = 16, PATTERNS = 4;
// Voice numbers follow shapes.js: one shape per voice, in this order.
const BD = 0, SD = 1, CH = 2, OH = 3, CP = 4, LT = 5, RS = 6, CB = 7;
// The closed hat fires first on a step so its choke never cuts an open hat placed on the same step.
const ORDER = [CH, BD, SD, LT, RS, CP, CB, OH];
// Voices are summed in Drum 808's order, so a whole pattern also matches it exactly.
const MIX = [BD, SD, LT, RS, CP, CB, OH, CH];
const VELOCITY = 0.72; // an unaccented step; an accented step plays at 1
const CEILING = 0.5; // -6 dBFS soft ceiling: the device's line-out stage adds +6 dB
// Per-voice output trims, calibrated offline for Drum 808 so the default kit is balanced.
const TRIM = [0.353, 0.344, 1.21, 1.38, 1.725, 0.268, 0.241, 0.356];
const TOM_FREQ = 88, TOM_DECAY = 0.15;
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

class Engine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cells = new Uint8Array(PATTERNS * TRACKS * STEPS);
    this.pattern = 0; this.queued = -1;
    this.bpm = 120; this.swing = 0; this.mutes = 0;
    this.level = new Float32Array(TRACKS).fill(80);
    this.tune = new Float32Array(TRACKS);
    this.decay = new Float32Array(TRACKS).fill(50);
    this.running = false; this.step = 0; this.toNext = 0; this.first = false;
    this.voices = Array.from({length: TRACKS}, () => new Voice());
    this.metal = new Float64Array(METAL.length);
    this.seed = 0x2545f491; this.dcX = 0; this.dcY = 0;
    this.hits = [];
    // roll: the voice that is being held down (-1: none), for how many frames, and the frames to its next hit while
    // the pattern is stopped.
    this.roll = -1; this.rollHeld = 0; this.rollWait = 0;
    // The step being played, how long it lasts, and how far into it the music is: a hit by hand is written into the
    // nearer step. skip: a step written ahead of its time is not played a second time when the bar gets there.
    this.at = 0; this.stepLength = 1; this.into = 0;
    this.skip = new Int8Array(TRACKS).fill(-1);
    this.rec = false; // Record: only then are hits by hand and rolls written into the pattern
    this.port.onmessage = ({data}) => this.message(data);
  }

  stepFrames() { return SR * 15 / this.bpm; }
  // A held voice starts to roll after one step, and never sooner than a short tap lasts.
  rollStart() { return Math.max(this.stepFrames(), SR * 0.18); }
  // Write a hit by hand into the playing pattern at a step that is still empty. Returns the cell written, or -1.
  write(track, step) {
    const index = (this.pattern * TRACKS + track) * STEPS + step;
    if (this.cells[index]) return -1;
    this.cells[index] = 1;
    return index;
  }

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
      case 'voice': this.tune[m.track] = m.tune; this.decay[m.track] = m.decay; break;
      case 'pattern':
        if (m.now || !this.running) { this.pattern = m.index; this.queued = -1; }
        else this.queued = m.index === this.pattern ? -1 : m.index;
        break;
      case 'start': this.running = true; this.step = 0; this.toNext = 0; this.first = true; this.skip.fill(-1); break;
      case 'record': this.rec = !!m.on; break;
      case 'roll': this.roll = m.on ? m.track : -1; this.rollHeld = 0; this.rollWait = this.rollStart(); break;
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
      case LT:
        v.f1 = TOM_FREQ * tune; v.ph1 = 0; v.env2 = 1;
        v.kp = decayCoef(0.035); v.k1 = decayCoef(TOM_DECAY * decay); v.k2 = decayCoef(0.006);
        v.a.set(2500, 0.7);
        break;
      case RS:
        v.f1 = 480 * tune; v.f2 = 1690 * tune; v.ph1 = 0; v.ph2 = 0;
        v.k1 = decayCoef(0.0055 * decay); v.a.set(250, 0.7);
        break;
      case CP:
        v.a.set(1050 * tune, 2.2); v.k1 = decayCoef(0.07 * decay);
        break;
      case CB:
        v.f1 = 540 * tune; v.f2 = 800 * tune; v.ph1 = 0; v.ph2 = 0; v.env2 = 1;
        v.k1 = decayCoef(0.008); v.k2 = decayCoef(0.07 * decay);
        v.a.set(3500 * tune, 0.7); v.b.set(500, 0.7);
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
    let mask = 0, accents = 0;
    for (const n of ORDER) {
      const value = this.cells[base + n * STEPS], skipped = this.skip[n] === this.step;
      if (skipped) this.skip[n] = -1;
      if (value && !((this.mutes >> n) & 1) && !skipped) {
        this.trigger(n, value === 2 ? 1 : VELOCITY);
        mask |= 1 << n;
        if (value === 2) accents |= 1 << n;
      }
    }
    this.port.postMessage({type: 'step', step: this.step, pattern: this.pattern, queued: this.queued, mask, accents, frame, first: this.first});
    this.first = false;
    // A voice held down rolls: a hit on every step, written into the pattern while Record is on. Where the pattern
    // already plays the voice on this step, that is the roll's hit.
    if (this.roll >= 0 && this.rollHeld >= this.rollStart()) {
      const n = this.roll, cell = this.rec ? this.write(n, this.step) : -1;
      if (!((mask >> n) & 1)) { this.trigger(n, VELOCITY); this.port.postMessage({type: 'hit', track: n, frame, cell}); }
    }
    this.at = this.step; this.into = 0;
    this.stepLength = this.stepFrames() * (this.step % 2 === 0 ? 1 + this.swing : 1 - this.swing);
    this.toNext += this.stepLength;
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
    if (vs[OH].on || vs[CH].on) {
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
    for (const n of MIX) {
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
        case LT:
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
        this.trigger(m.track, VELOCITY);
        // With Record on, while the pattern plays, the hit is written into the nearer step: the one being played, or
        // the next one.
        let cell = -1;
        if (this.rec && this.running && !this.first) {
          const late = this.into >= this.stepLength / 2, step = late ? (this.at + 1) % STEPS : this.at;
          cell = this.write(m.track, step);
          if (late) this.skip[m.track] = step;
        }
        this.port.postMessage({type: 'hit', id: m.id, track: m.track, frame: currentFrame, cell});
      }
      this.hits.length = 0;
    }
    for (let i = 0; i < out.length; i++) {
      if (this.running) {
        if (this.toNext <= 0) this.fire(currentFrame + i);
        this.toNext -= 1; this.into++;
      }
      if (this.roll >= 0) {
        this.rollHeld++;
        if (!this.running && --this.rollWait <= 0) { // stopped: the roll keeps its own time, one hit per step length
          this.rollWait = this.stepFrames();
          this.trigger(this.roll, VELOCITY);
          this.port.postMessage({type: 'hit', track: this.roll, frame: currentFrame + i, cell: -1});
        }
      }
      out[i] = this.render();
    }
    return true;
  }
}

registerProcessor('engine', Engine);
