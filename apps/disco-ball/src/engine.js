'use strict';
/* Disco Ball engine. The sparkle clock and every voice run here on the audio
 * rendering thread, so a tile's flash and its note share one sample-accurate
 * clock. The main thread only sends intent and draws what this side reports. */
const SR = sampleRate, TWO_PI = 2 * Math.PI;
const CEILING = 0.5; // -6 dBFS soft ceiling: the device's line-out stage adds +6 dB
const SPARKS = 24, RATE_TICKS = [4, 2, 1]; // 1/4, 1/8, 1/16 of the 16th-note tick clock
const decayCoef = seconds => Math.exp(-1 / (seconds * SR));

class Spark {
  constructor() {
    this.on = false; this.t = 0; this.age = 0;
    this.ks = new Float32Array(512); this.ksN = 0; this.ksI = 0; this.ksG = 0; // Karplus-Strong string
  }
}

// An inharmonic gong: fixed partials, long ring.
const GONG_F = [82.4, 116.8, 167.3, 221.9, 307.6];
const GONG_A = [1, 0.65, 0.45, 0.3, 0.22];

// Acid bass layer: one bar of 16th steps in semitones over A1 (-1 = rest),
// with accents that kick the filter open.
const ACID = [0, -1, 12, 0, 3, -1, 12, 10, 0, 12, -1, 15, 12, 0, 10, -1];
const ACID_ACC = [1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 0];

class DiscoBall extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bpm = 118; this.rate = 1; this.density = 2; this.timbre = 0;
    this.gain = 0.65; this.beat = true; this.style = 0; this.running = false;
    this.freqs = new Float32Array(0);
    this.visible = new Uint16Array(0);
    this.tick = 0; this.toNext = 0; this.lateMax = 0;
    this.sparks = Array.from({length: SPARKS}, () => new Spark());
    this.next = 0;
    this.pending = []; // queued burst/tap sparks: {wait (frames), tile}
    this.kick = {on: false, ph: 0, env: 0, pitch: 0, k1: 0, kp: 0};
    this.hat = {on: false, env: 0, k1: 0, lp: 0};
    this.clap = {on: false, env: 0, k1: 0, lp: 0, t: 0};
    this.bass = {on: false, ph: 0, env: 0, f: 55, k1: 0};
    this.gongV = {on: false, env: 0, k1: 0, ph: new Float64Array(GONG_F.length)};
    this.bar = 0;
    this.acid = false;
    this.acidV = {active: false, ph: 0, f: 55, env: 0, fenv: 0, lfo: 0, ic1: 0, ic2: 0, ke: 0, kf: 0};
    this.energy = 0.5; this.drive = 0.3;
    this.seed = 0x9e3779b9; this.dcX = 0; this.dcY = 0;
    this.port.onmessage = ({data}) => this.message(data);
  }

  tickFrames() { return SR * 15 / this.bpm; }

  message(m) {
    switch (m.type) {
      case 'tempo': {
        const before = this.tickFrames();
        this.bpm = m.value;
        if (this.running) this.toNext *= this.tickFrames() / before;
        break;
      }
      case 'rate': this.rate = m.value; break;
      case 'density': this.density = m.value; break;
      case 'volume': this.gain = Math.pow(m.value / 100, 1.5); break;
      case 'timbre': this.timbre = m.value; break;
      case 'beat': this.beat = m.value; break;
      case 'style': this.style = m.value; break;
      case 'acid': this.acid = m.value; break;
      case 'energy': this.energy = m.value; break;
      case 'drive': this.drive = m.value; break;
      case 'freqs': this.freqs = m.value; break;
      case 'visible': if (m.value.length) this.visible = m.value; break;
      case 'start': this.running = true; this.tick = 0; this.toNext = 0; this.bar = 0; break;
      case 'stop': this.running = false; this.pending.length = 0; break;
      case 'tap': this.pending.push({wait: 0, tile: m.tile}); break;
      case 'burst': {
        // A rising cascade: visible tiles sorted low to high, one every 42 ms.
        const pool = this.pool();
        if (!pool.length) break;
        const take = Math.min(10, pool.length), picked = [];
        for (let i = 0; i < take; i++) picked.push(pool[(Math.random() * pool.length) | 0]);
        picked.sort((a, b) => this.freqs[a] - this.freqs[b]);
        picked.forEach((tile, i) => this.pending.push({wait: i * 0.042 * SR, tile}));
        break;
      }
    }
  }

  pool() {
    if (this.visible.length) return this.visible;
    return this.freqs.length ? Array.from({length: this.freqs.length}, (_, i) => i) : [];
  }

  noise() {
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x |= 0;
    return x / 2147483648;
  }

  sparkle(tile, vel = 1) {
    if (!this.freqs.length) return;
    const f = this.freqs[Math.min(tile, this.freqs.length - 1)] * (1 + (Math.random() - 0.5) * 0.004);
    const v = this.sparks[this.next];
    this.next = (this.next + 1) % SPARKS;
    const soften = Math.pow(520 / f, 0.25); // keep high tiles from piercing
    v.on = true; v.t = 0; v.age = 0;
    v.p1 = Math.random(); v.nenv = 0; v.aenv = 0; v.ka = 1; v.ksN = 0;
    if (this.timbre === 0) {        // Bell
      v.f1 = f; v.f2 = f * 2.756; v.a1 = 0.68; v.a2 = 0.32;
      v.k1 = decayCoef(Math.min(0.8, Math.max(0.16, 0.42 * Math.pow(520 / f, 0.4))));
      v.kn = 1; v.namp = 0;
    } else if (this.timbre === 1) { // Pluck
      v.f1 = f; v.f2 = f * 2.01; v.a1 = 0.8; v.a2 = 0.2;
      v.k1 = decayCoef(0.13); v.kn = decayCoef(0.005); v.nenv = 1; v.namp = 0.35;
    } else if (this.timbre === 2) { // Glass
      v.f1 = f; v.f2 = f * 3.98; v.a1 = 0.62; v.a2 = 0.38;
      v.k1 = decayCoef(Math.min(1.4, Math.max(0.3, 0.9 * Math.pow(520 / f, 0.4))));
      v.kn = 1; v.namp = 0;
    } else if (this.timbre === 3) { // Funk: a snappy root-and-fifth stab
      v.f1 = f; v.f2 = f * 1.5; v.a1 = 0.64; v.a2 = 0.36;
      v.k1 = decayCoef(0.09); v.kn = decayCoef(0.0035); v.nenv = 1; v.namp = 0.3;
    } else if (this.timbre === 4) { // Strings: a slow-swelling detuned pad
      v.f1 = f; v.f2 = f * 2.004; v.a1 = 0.58; v.a2 = 0.42;
      v.k1 = decayCoef(Math.min(1.6, Math.max(0.5, 1.2 * Math.pow(520 / f, 0.3))));
      v.kn = 1; v.namp = 0;
      v.ka = 1 - Math.exp(-1 / (0.06 * SR));
    } else {                        // Guzheng: a bright plucked zither string
      const len = Math.max(24, Math.min(500, Math.round(SR / f)));
      for (let i = 0; i < len; i++) v.ks[i] = this.noise();
      v.ksN = len; v.ksI = 0; v.ksG = 0.996;
      v.k1 = decayCoef(0.35);
    }
    v.p2 = v.p1 * 1.7 % 1; v.env = 1; v.amp = 0.23 * soften * (0.55 + 0.45 * vel);
  }

  thump(decay, punch) {
    const k = this.kick;
    k.on = true; k.ph = 0; k.env = 1; k.pitch = 1; k.punch = punch;
    k.kp = decayCoef(0.022); k.k1 = decayCoef(decay);
  }

  tss(decay, amp) {
    const h = this.hat;
    h.on = true; h.env = 1; h.amp = amp; h.k1 = decayCoef(decay);
  }

  clapHit() {
    const c = this.clap;
    c.on = true; c.env = 1; c.t = 0; c.k1 = decayCoef(0.08);
  }

  bassNote(f, decay) {
    const b = this.bass;
    b.on = true; b.ph = 0; b.f = f; b.env = 1; b.k1 = decayCoef(decay);
  }

  gongHit() {
    const g = this.gongV;
    g.on = true; g.env = 1; g.k1 = decayCoef(2.2);
    g.ph.fill(0);
  }

  acidNote(semi, accent) {
    const a = this.acidV;
    a.active = true; a.f = 55 * Math.pow(2, semi / 12);
    a.env = 1; a.fenv = accent ? 1.5 : 1;
    a.ke = decayCoef(0.16); a.kf = decayCoef(0.1);
  }

  fire(frame) {
    const tiles = [];
    if (this.tick === 0) this.bar++;
    if (this.beat) {
      if (this.style === 2) {
        // Eurodance: four-on-the-floor with bouncing offbeat bass stabs, and
        // a gong ringing in every fourth bar.
        if (this.tick % 4 === 0) { this.thump(0.22, 2.7); this.port.postMessage({type: 'beat', frame}); }
        if (this.tick % 4 === 2) { this.bassNote(110, 0.12); this.tss(0.08, 0.18); }
        else if (this.tick % 2 === 1) this.tss(0.025, 0.07);
        if (this.tick === 4 || this.tick === 12) this.clapHit();
        if (this.tick === 0 && this.bar % 4 === 1) { this.gongHit(); this.port.postMessage({type: 'gong', frame}); }
      } else if (this.style === 1) {
        // Techno: harder four-on-the-floor, driving 16th hats, relentless one-note bass.
        if (this.tick % 4 === 0) { this.thump(0.17, 3.1); this.port.postMessage({type: 'beat', frame}); }
        if (this.tick % 4 === 2) this.tss(0.07, 0.2);
        else if (this.tick % 2 === 1) this.tss(0.03, 0.09);
        if (this.tick % 2 === 0) this.bassNote(55, 0.1);
      } else {
        if (this.tick % 4 === 0) { this.thump(0.26, 2.4); this.port.postMessage({type: 'beat', frame}); }
        if (this.tick % 4 === 2) this.tss(0.1, 0.17);
        if (this.tick === 4 || this.tick === 12) this.clapHit();
        // Octave-bouncing eighth-note bassline, the disco walk.
        if (this.tick % 2 === 0) this.bassNote(this.tick % 4 === 0 ? 55 : 110, 0.16);
      }
    }
    if (this.tick % RATE_TICKS[this.rate] === 0) {
      const pool = this.pool();
      if (pool.length) {
        // Groove dynamics: downbeats hit hard, offbeats sit back.
        const vel = this.tick % 4 === 0 ? 1 : this.tick % 2 === 0 ? 0.8 : 0.55;
        for (let i = 0; i < this.density; i++) {
          const tile = pool[(Math.random() * pool.length) | 0];
          if (!tiles.includes(tile)) { tiles.push(tile); this.sparkle(tile, vel); }
        }
      }
    }
    if (this.acid && ACID[this.tick] >= 0) this.acidNote(ACID[this.tick], ACID_ACC[this.tick]);
    this.lateMax = Math.max(this.lateMax, -this.toNext);
    if (tiles.length) this.port.postMessage({type: 'spark', tiles, frame, late: this.lateMax});
    this.toNext += this.tickFrames();
    this.tick = (this.tick + 1) % 16;
  }

  render() {
    const n = this.noise();
    let mix = 0;
    for (const v of this.sparks) {
      if (!v.on) continue;
      let s;
      if (v.ksN) {
        // Karplus-Strong plucked string for the Guzheng voice.
        s = v.ks[v.ksI];
        const nx = (v.ksI + 1) % v.ksN;
        v.ks[v.ksI] = v.ksG * 0.5 * (s + v.ks[nx]);
        v.ksI = nx;
        v.env *= v.k1;
      } else {
        v.p1 += v.f1 / SR; if (v.p1 >= 1) v.p1 -= 1;
        v.p2 += v.f2 / SR; if (v.p2 >= 1) v.p2 -= 1;
        s = (v.a1 * Math.sin(TWO_PI * v.p1) + v.a2 * Math.sin(TWO_PI * v.p2)) * v.env;
        if (v.nenv > 1e-4) { s += n * v.nenv * v.namp; v.nenv *= v.kn; }
        if (v.ka < 1) { v.aenv += v.ka * (1 - v.aenv); s *= v.aenv; }
        v.env *= v.k1;
      }
      mix += s * v.amp;
      if (++v.age > 960 && v.env < 1e-4) v.on = false;
    }
    const av = this.acidV;
    if (av.active) {
      // 303-style acid: a driven saw through a resonant lowpass whose cutoff
      // rides a per-note envelope plus a tempo-synced wobble.
      av.ph += av.f / SR; if (av.ph >= 1) av.ph -= 1;
      av.lfo += this.bpm / 120 / SR; if (av.lfo >= 1) av.lfo -= 1;
      const open = 0.25 + 1.5 * this.energy; // the energy knob rides the filter
      const cutoff = Math.min(7000, 120 + 2400 * av.fenv * av.fenv * open + 950 * this.energy * (0.5 + 0.5 * Math.sin(TWO_PI * av.lfo)));
      const g = Math.tan(Math.PI * cutoff / SR), k = 1 / 4.5;
      const a1 = 1 / (1 + g * (g + k)), a2 = g * a1;
      const v3 = (2 * av.ph - 1) - av.ic2, v1 = a1 * av.ic1 + a2 * v3, v2 = av.ic2 + a2 * av.ic1 + g * a2 * v3;
      av.ic1 = 2 * v1 - av.ic1; av.ic2 = 2 * v2 - av.ic2;
      mix += Math.tanh(1.6 * v2) * av.env * 0.5;
      av.env *= av.ke; av.fenv *= av.kf;
      if (av.env < 1e-4) av.active = false;
    }
    const gv = this.gongV;
    if (gv.on) {
      let sg = 0;
      for (let i = 0; i < GONG_F.length; i++) {
        gv.ph[i] += GONG_F[i] / SR; if (gv.ph[i] >= 1) gv.ph[i] -= 1;
        sg += GONG_A[i] * Math.sin(TWO_PI * gv.ph[i]);
      }
      mix += sg * gv.env * 0.38;
      gv.env *= gv.k1;
      if (gv.env < 1e-4) gv.on = false;
    }
    const k = this.kick;
    if (k.on) {
      k.ph += 49 * (1 + (k.punch || 2.4) * k.pitch) / SR; if (k.ph >= 1) k.ph -= 1;
      mix += Math.sin(TWO_PI * k.ph) * k.env * 0.85;
      k.pitch *= k.kp; k.env *= k.k1;
      if (k.env < 1e-4) k.on = false;
    }
    const h = this.hat;
    if (h.on) {
      h.lp += 0.22 * (n - h.lp);
      mix += (n - h.lp) * h.env * (h.amp || 0.17);
      h.env *= h.k1;
      if (h.env < 1e-4) h.on = false;
    }
    const c = this.clap;
    if (c.on) {
      // Two fast pre-bursts then the decaying body, clap-style.
      const t = c.t / SR;
      const burst = t < 0.02 ? Math.exp(-(t % 0.01) / 0.003) : 0;
      c.lp += 0.4 * (n - c.lp);
      mix += (n - c.lp) * Math.max(burst, c.env * 0.8) * 0.34;
      c.t++;
      if (t >= 0.02) c.env *= c.k1;
      if (c.env < 1e-4 && t > 0.02) c.on = false;
    }
    const b = this.bass;
    if (b.on) {
      b.ph += b.f / SR; if (b.ph >= 1) b.ph -= 1;
      const p = TWO_PI * b.ph;
      mix += (Math.sin(p) + 0.45 * Math.sin(2 * p) + 0.18 * Math.sin(3 * p)) * b.env * 0.42;
      b.env *= b.k1;
      if (b.env < 1e-4) b.on = false;
    }
    mix *= this.gain * (1 + 2.2 * this.drive); // drive pushes the mix into the soft ceiling
    const y = mix - this.dcX + 0.9987 * this.dcY;
    this.dcX = mix; this.dcY = y;
    return CEILING * Math.tanh(y / CEILING);
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      if (this.running) {
        if (this.toNext <= 0) this.fire(currentFrame + i);
        this.toNext -= 1;
      }
      if (this.pending.length) {
        const kept = [];
        for (const p of this.pending) {
          p.wait -= 1;
          if (p.wait <= 0) {
            this.sparkle(p.tile);
            this.port.postMessage({type: 'spark', tiles: [p.tile], frame: currentFrame + i, late: this.lateMax});
          } else kept.push(p);
        }
        this.pending = kept;
      }
      out[i] = this.render();
    }
    return true;
  }
}

registerProcessor('discoball-engine', DiscoBall);
