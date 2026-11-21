/* Visuals Player built-in music: original songs synthesised inside the App. The drums are the Drum 808 App's own voices
   (beats/drum808-engine.js, copied unchanged); bass, chords and leads are small subtractive and FM voices sharing a
   reverb, an echo and a bus compressor. A song renders bar by bar and always the same way, in the App's worker and in
   the package tests, so the picture can follow it with or without sound. */
(root => {
  'use strict';
  const SR = 48000, TAU = Math.PI * 2, CONTROL = 16;
  const mtof = note => 440 * Math.pow(2, (note - 69) / 12);
  const VOICES = {BD: 0, SD: 1, LT: 2, MT: 3, HT: 4, RS: 5, CL: 6, CP: 7, CB: 8, CY: 9, OH: 10, CH: 11};
  // Which Drum 808 instance plays each drum key: kick alone (it drives the ducking), snares and claps (reverb),
  // hats and cymbal, and percussion with its own closed hat as a shaker that never chokes the open hat.
  const BUS_OF = {BD: 'kick', SD: 'snare', CP: 'snare', RS: 'snare', CH: 'hats', OH: 'hats', CY: 'hats',
    LT: 'perc', MT: 'perc', HT: 'perc', CB: 'perc', CL: 'perc', SH: 'perc'};
  const VOICE_OF = key => key === 'SH' ? VOICES.CH : VOICES[key];
  const VELOCITY = {X: 1, x: 0.8, o: 0.56, g: 0.34};

  function blep(t, dt) {
    if (t < dt) { t /= dt; return t + t - t * t - 1; }
    if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
    return 0;
  }
  const saw = (p, dt) => 2 * p - 1 - blep(p, dt);
  function square(p, dt) { let h = p + 0.5; if (h >= 1) h -= 1; return (p < 0.5 ? 1 : -1) + blep(p, dt) - blep(h, dt); }

  // Zero-delay-feedback state-variable filter (Simper), as in the drum engine.
  class Svf {
    constructor(freq = 1000, q = 0.707) { this.ic1 = 0; this.ic2 = 0; this.low = 0; this.band = 0; this.high = 0; this.set(freq, q); }
    set(freq, q) {
      const g = Math.tan(Math.PI * Math.min(Math.max(freq, 20), SR * 0.45) / SR);
      this.k = 1 / q; this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
    }
    run(x) {
      const v3 = x - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
      this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
      this.low = v2; this.band = this.k * v1; this.high = x - this.k * v1 - v2;
    }
  }
  class Noise {
    constructor(seed) { this.x = seed | 0 || 0x2545f491; }
    next() { let x = this.x; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.x = x |= 0; return x / 2147483648; }
  }

  // Attack is linear from the current level (a re-gated voice never drops); decay and release are exponential.
  class Env {
    constructor([a, d, s, r]) { this.v = 0; this.stage = 0; this.inc = 1 / Math.max(1, a * SR); this.dk = Math.exp(-4 / Math.max(1, d * SR)); this.s = s; this.rk = Math.exp(-4 / Math.max(1, r * SR)); }
    gate() { this.stage = 1; }
    release() { if (this.stage) this.stage = 3; }
    next() {
      switch (this.stage) {
        case 1: this.v += this.inc; if (this.v >= 1) { this.v = 1; this.stage = 2; } break;
        case 2: this.v = this.s + (this.v - this.s) * this.dk; break;
        case 3: this.v *= this.rk; if (this.v < 1e-5) { this.v = 0; this.stage = 0; } break;
      }
      return this.v;
    }
  }

  const WAVES = {saw: 0, square: 1, mix: 2, fm: 3, sine: 4};
  // One note of an instrument: detuned oscillators panned across the stereo field, or a two-operator FM voice with a
  // short metallic 'tine' for electric piano and bell, through a resonant low-pass with its own envelope.
  class Voice {
    constructor(p) {
      this.p = p; this.wave = WAVES[p.wave] ?? 0; this.amp = new Env(p.amp); this.filt = new Env(p.fenv || [0.001, 0.2, 0, 0.2]);
      this.l = new Svf(); this.r = new Svf(); this.count = 0;
      const n = this.wave === WAVES.fm ? 1 : p.unison || 1;
      this.phase = new Float64Array(n); this.inc = new Float64Array(n); this.ratio = new Float64Array(n);
      this.panL = new Float32Array(n); this.panR = new Float32Array(n);
      for (let u = 0; u < n; u++) {
        const spread = n === 1 ? 0 : u / (n - 1) * 2 - 1;
        this.ratio[u] = Math.pow(2, spread * (p.detune || 0) / 1200);
        const angle = (1 + spread * (p.width ?? 0.8)) * Math.PI / 4;
        this.panL[u] = Math.cos(angle) * Math.SQRT2 / n; this.panR[u] = Math.sin(angle) * Math.SQRT2 / n;
        this.phase[u] = (u * 0.618034) % 1;
      }
      this.sub = 0; this.subInc = 0; this.mod = 0; this.modInc = 0; this.tine = 0; this.tineInc = 0;
      this.index = 0; this.tineIndex = 0; this.ik = 1; this.tk = 1;
      this.note = -1; this.freq = 0; this.target = 0; this.glide = 0; this.vel = 0; this.accent = 0; this.gateLeft = 0; this.keyCut = 1000; this.age = 0;
      this.outL = 0; this.outR = 0;
    }
    get active() { return this.amp.stage !== 0; }
    retune() {
      const f = this.freq / SR;
      for (let u = 0; u < this.inc.length; u++) this.inc[u] = f * this.ratio[u];
      this.subInc = f / 2; this.modInc = f * (this.p.ratio || 1); this.tineInc = f * (this.p.tineRatio || 14);
    }
    start(note, vel, gate, slide, accent) {
      const p = this.p;
      this.note = note; this.vel = vel; this.accent = accent; this.gateLeft = Math.max(1, gate); this.age = 0;
      this.target = mtof(note);
      this.keyCut = (p.cutoff || 18000) * Math.pow(2, (p.key || 0) * (note - 60) / 12);
      if (slide && this.active && this.freq) { this.glide = Math.exp(-1 / ((p.glide || 0.06) * SR)); return; }
      this.glide = 0; this.freq = this.target; this.retune();
      this.amp.gate(); this.filt.v = p.retrigger === false ? this.filt.v : 0; this.filt.gate(); this.count = 0;
      if (this.wave === WAVES.fm) {
        this.index = (p.index || 1) * (0.6 + 0.6 * vel); this.tineIndex = p.tine || 0;
        this.ik = Math.exp(-1 / ((p.indexDecay || 0.8) * SR)); this.tk = Math.exp(-1 / ((p.tineDecay || 0.03) * SR));
      }
    }
    render(cut) {
      const p = this.p;
      if (this.glide) {
        this.freq = this.target + (this.freq - this.target) * this.glide;
        if (Math.abs(this.freq - this.target) < 0.05) { this.freq = this.target; this.glide = 0; }
        this.retune();
      }
      if (this.gateLeft > 0 && --this.gateLeft === 0) { this.amp.release(); this.filt.release(); }
      const a = this.amp.next() * this.vel, f = this.filt.next();
      this.age++;
      if ((this.count++ & (CONTROL - 1)) === 0 && p.cutoff) {
        const c = this.keyCut * cut * Math.pow(2, (p.env || 0) * (1 + (p.accentEnv || 0) * this.accent) * f);
        this.l.set(c, p.q || 0.707); this.r.set(c, p.q || 0.707);
      }
      let left = 0, right = 0;
      if (this.wave === WAVES.fm) {
        this.phase[0] += this.inc[0]; if (this.phase[0] >= 1) this.phase[0] -= 1;
        this.mod += this.modInc; if (this.mod >= 1) this.mod -= 1;
        this.tine += this.tineInc; if (this.tine >= 1) this.tine -= 1;
        const s = Math.sin(TAU * this.phase[0] + this.index * Math.sin(TAU * this.mod) + this.tineIndex * Math.sin(TAU * this.tine));
        this.index *= this.ik; this.tineIndex *= this.tk;
        left = right = s * 0.7;
      } else {
        const n = this.inc.length, wave = this.wave;
        for (let u = 0; u < n; u++) {
          const dt = this.inc[u]; let ph = this.phase[u] + dt; if (ph >= 1) ph -= 1; this.phase[u] = ph;
          const s = wave === 0 ? saw(ph, dt) : wave === 1 ? square(ph, dt) : wave === 2 ? (u & 1 ? square(ph, dt) : saw(ph, dt)) : Math.sin(TAU * ph);
          left += s * this.panL[u]; right += s * this.panR[u];
        }
      }
      if (p.sub) {
        this.sub += this.subInc; if (this.sub >= 1) this.sub -= 1;
        const s = Math.sin(TAU * this.sub) * p.sub; left += s; right += s;
      }
      if (p.drive) { left = Math.tanh(left * p.drive) / p.drive; right = Math.tanh(right * p.drive) / p.drive; }
      if (p.cutoff) { this.l.run(left); this.r.run(right); left = this.l.low; right = this.r.low; }
      this.outL = left * a; this.outR = right * a;
    }
  }

  class Instrument {
    constructor(p) {
      this.p = p; this.voices = Array.from({length: p.poly || 1}, () => new Voice(p));
      this.cut = 1; this.level = 1; this.l = 0; this.r = 0; this.lfo = 0; this.lfoInc = (p.tremolo?.rate || 0) / SR;
    }
    play(note, vel, gate, slide = false, accent = 0) {
      const vs = this.voices;
      let v = null;
      if (vs.length === 1) v = vs[0];
      else {
        v = vs.find(voice => voice.note === note && voice.active) || vs.find(voice => !voice.active);
        if (!v) v = vs.reduce((oldest, voice) => voice.age > oldest.age ? voice : oldest, vs[0]);
      }
      v.start(note, vel * (1 + (this.p.accentLevel || 0) * accent), gate, slide && vs.length === 1, accent);
    }
    render() {
      let l = 0, r = 0;
      const vs = this.voices; for (let k = 0; k < vs.length; k++) { const v = vs[k]; if (v.amp.stage) { v.render(this.cut); l += v.outL; r += v.outR; } }
      if (this.lfoInc) {
        this.lfo += this.lfoInc; if (this.lfo >= 1) this.lfo -= 1;
        const pan = Math.sin(TAU * this.lfo) * this.p.tremolo.depth;
        l *= 1 - pan; r *= 1 + pan;
      }
      const gain = this.level * (this.p.gain || 1);
      this.l = l * gain; this.r = r * gain;
    }
  }

  // Freeverb, tuned for 48 kHz, with a pre-delay and a low cut on what goes in.
  const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], ALLPASSES = [556, 441, 341, 225];
  class Comb {
    constructor(n) { this.buf = new Float32Array(n); this.i = 0; this.store = 0; }
    run(x, feedback, damp) {
      const out = this.buf[this.i];
      this.store = out * (1 - damp) + this.store * damp;
      this.buf[this.i] = x + this.store * feedback;
      if (++this.i === this.buf.length) this.i = 0;
      return out;
    }
  }
  class Allpass {
    constructor(n) { this.buf = new Float32Array(n); this.i = 0; }
    run(x) { const b = this.buf[this.i]; this.buf[this.i] = x + b * 0.5; if (++this.i === this.buf.length) this.i = 0; return b - x; }
  }
  class Reverb {
    constructor({size = 0.84, damp = 0.35, predelay = 0.025, lowCut = 280} = {}) {
      const scale = SR / 44100;
      this.cl = COMBS.map(n => new Comb(Math.round(n * scale))); this.cr = COMBS.map(n => new Comb(Math.round((n + 23) * scale)));
      this.al = ALLPASSES.map(n => new Allpass(Math.round(n * scale))); this.ar = ALLPASSES.map(n => new Allpass(Math.round((n + 23) * scale)));
      this.size = size; this.damp = damp; this.pre = new Float32Array(Math.max(1, Math.round(predelay * SR))); this.pi = 0;
      this.hp = new Svf(lowCut, 0.6); this.lp = new Svf(9000, 0.6); this.l = 0; this.r = 0;
    }
    run(x) {
      const delayed = this.pre[this.pi]; this.pre[this.pi] = x; if (++this.pi === this.pre.length) this.pi = 0;
      this.hp.run(delayed); this.lp.run(this.hp.high);
      const input = this.lp.low * 0.028;
      let l = 0, r = 0;
      for (let k = 0; k < 8; k++) { l += this.cl[k].run(input, this.size, this.damp); r += this.cr[k].run(input, this.size, this.damp); }
      for (let k = 0; k < 4; k++) { l = this.al[k].run(l); r = this.ar[k].run(r); }
      this.l = l; this.r = r;
    }
  }
  // A ping-pong echo: the left repeat feeds the right and back, each repeat a little darker.
  class Echo {
    constructor(seconds, feedback = 0.42, tone = 3800) {
      this.n = Math.max(1, Math.round(seconds * SR)); this.bl = new Float32Array(this.n); this.br = new Float32Array(this.n); this.i = 0;
      this.fb = feedback; this.tl = 0; this.tr = 0; this.k = 1 - Math.exp(-TAU * tone / SR); this.hp = new Svf(220, 0.6); this.l = 0; this.r = 0;
    }
    run(x) {
      const dl = this.bl[this.i], dr = this.br[this.i];
      this.tl += (dl - this.tl) * this.k; this.tr += (dr - this.tr) * this.k;
      this.hp.run(x);
      this.bl[this.i] = this.hp.high + this.tr * this.fb; this.br[this.i] = this.tl * this.fb;
      if (++this.i === this.n) this.i = 0;
      this.l = dl; this.r = dr;
    }
  }

  // ---- Songs ---------------------------------------------------------------------------------------------------------
  // Drum rows: 16 steps, X accent, x normal, o soft, g ghost. Pitched rows: '-' holds the note before, '.' rests.
  // Bass tokens: R root, O octave, 5 fifth, 3 third, 7 seventh, 9 ninth, 4 fourth, n a semitone under the next root.
  // Arp tokens: 0-9 and a-f index the chord's notes upwards through the octaves.
  // Chords are [root, voicing] in MIDI notes; the bass plays the root.
  const SONGS = [
    {
      id: 'glass-city', title: 'Glass City', bpm: 124, swing: 0, seed: 11,
      kit: {BD: [92, 2, 42], SD: [70, 0, 45], CP: [84, 0, 55], RS: [64, 2, 50], CH: [70, 3, 30], OH: [66, 2, 40], CY: [52, 4, 22],
        LT: [62, 7, 40], MT: [60, 7, 40], HT: [58, 7, 35], CB: [50, 0, 40], CL: [54, 0, 50], SH: [46, 6, 18]},
      buses: {kick: [0.86, 0, 0], snare: [0.85, 0, 0.3], hats: [0.95, -0.18, 0.06], perc: [0.8, 0.3, 0.22]},
      reverb: {size: 0.86, damp: 0.3, predelay: 0.03}, echo: [0.75, 0.45, 3400], duck: [0.004, 0.2],
      chords: [[30, [57, 61, 64, 68]], [38, [57, 61, 64, 66]], [33, [59, 61, 64, 69]], [40, [56, 59, 64, 66]]],
      instruments: {
        bass: {part: 'bass', wave: 'saw', unison: 1, sub: 0.3, cutoff: 320, q: 1.1, env: 2.1, fenv: [0.001, 0.09, 0, 0.05], amp: [0.002, 0.16, 0.25, 0.04], gate: 0.55, gain: 0.5, duck: 0.55, drive: 1.6},
        pad: {part: 'chords', wave: 'saw', poly: 10, unison: 3, detune: 16, width: 0.9, cutoff: 900, q: 0.8, env: 1.2, fenv: [1.6, 2.5, 0.4, 2], amp: [0.9, 2, 0.75, 2.2], gate: 1, gain: 0.16, duck: 0.45, verb: 0.55, echo: 0},
        arp: {part: 'arp', octave: 12, wave: 'mix', poly: 4, unison: 2, detune: 7, width: 0.6, cutoff: 700, q: 1.6, env: 3.2, key: 0.5, fenv: [0.001, 0.16, 0, 0.12], amp: [0.002, 0.24, 0, 0.18], gate: 0.5, gain: 0.3, duck: 0.25, verb: 0.3, echo: 0.42},
        lead: {part: 'melody', wave: 'saw', poly: 2, unison: 3, detune: 9, width: 0.5, cutoff: 1600, q: 1.2, env: 1.6, fenv: [0.01, 0.4, 0.3, 0.4], amp: [0.02, 0.5, 0.7, 0.45], gate: 0.92, gain: 0.17, duck: 0.2, verb: 0.45, echo: 0.3},
      },
      patterns: {
        drums: {
          intro: {BD: 'X...x...x...x...', CH: '..x...x...x...x.', SH: 'g.g.g.g.g.g.g.g.'},
          lift: {BD: 'X...x...x...x...', CH: '..xg..xg..xg..xg', CP: '....x.......x...', SH: 'g.og.og.g.og.og.', MT: '......o.......g.'},
          glass: {BD: 'X...x...x...x...', CH: '..xg..xg..xg..xg', OH: '..o...o...o...o.', CP: '....x.......x...', CY: 'o.g.o.g.o.g.o.g.', MT: '...g..o.......o.', HT: '.........g....g.', SH: 'gog.gog.gog.gog.'},
          break: {CH: '..g...g...g...g.', SH: 'g...g...g...g...'},
        },
        fills: {
          snare: {SD: '....o.o.x.xxXxXX', CP: '....x.......x...'},
          toms: {LT: '..........o.x...', MT: '........x.......', HT: '......o.......X.', SD: '............x.x.'},
        },
        bass: {
          roll: ['.RRR.RRR.RRR.RRO', '.RRR.RRR.RR5.ROR'],
        },
        pad: {hold: ['x---------------']},
        arp: {
          up: ['0213243546352413'],
          wide: ['0213243546352413', '02468ace86420246'],
        },
        lead: {
          hook: [
            [[0, 80, 3], [4, 81, 2], [7, 80, 1], [8, 76, 4], [14, 73, 2]],
            [[0, 76, 6], [8, 73, 2], [10, 76, 2], [12, 78, 4]],
            [[0, 76, 3], [4, 73, 2], [7, 71, 1], [8, 73, 6]],
            [[0, 71, 6], [8, 68, 4], [12, 71, 4]],
          ],
        },
      },
      sections: [
        {name: 'Intro', bars: 4, play: {drums: 'intro', pad: 'hold', arp: 'up'}, auto: {pad: {cut: [0.35, 0.7]}, arp: {cut: [0.25, 0.45], level: [0.6, 0.8]}}},
        {name: 'Lift', bars: 12, play: {drums: 'lift', bass: 'roll', pad: 'hold', arp: 'up'}, auto: {arp: {cut: [0.45, 1]}, pad: {cut: [0.7, 1]}}, fx: {fill: 'snare'}},
        {name: 'Glass', bars: 16, play: {drums: 'glass', bass: 'roll', pad: 'hold', arp: 'wide'}, auto: {arp: {cut: [1, 1.4]}}, fx: {crash: true, boom: true, fill: 'toms'}},
        {name: 'Break', bars: 8, play: {drums: 'break', pad: 'hold', arp: 'up', lead: 'hook'}, auto: {arp: {cut: [0.6, 1.2]}, pad: {cut: [1, 1.6]}}, fx: {riser: 4, fill: 'snare'}},
        {name: 'City', bars: 16, play: {drums: 'glass', bass: 'roll', pad: 'hold', arp: 'wide', lead: 'hook'}, auto: {arp: {cut: [1.2, 1.5]}}, fx: {crash: true, boom: true, fill: 'toms'}},
        {name: 'Outro', bars: 8, play: {drums: 'lift', bass: 'roll', pad: 'hold', arp: 'up'}, auto: {arp: {cut: [1, 0.25]}, pad: {cut: [1, 0.4], level: [1, 0.4]}, bass: {cut: [1, 0.6]}}},
      ],
    },
    {
      id: 'afterglow', title: 'Afterglow', bpm: 121, swing: 0.1, seed: 23,
      kit: {BD: [90, 0, 48], SD: [62, 3, 40], CP: [86, -1, 62], RS: [70, 3, 45], CH: [60, 2, 28], OH: [70, 1, 48], CY: [50, 2, 50],
        LT: [64, 10, 38], MT: [64, 12, 34], HT: [60, 12, 30], CB: [48, 0, 40], CL: [56, 2, 50], SH: [52, 8, 16]},
      buses: {kick: [0.84, 0, 0], snare: [0.85, 0.04, 0.34], hats: [0.95, -0.22, 0.08], perc: [0.85, 0.32, 0.25]},
      reverb: {size: 0.88, damp: 0.4, predelay: 0.02}, echo: [0.75, 0.48, 2800], duck: [0.004, 0.22],
      chords: [[33, [60, 64, 67, 71]], [29, [57, 60, 64, 67]], [36, [59, 62, 64, 67]], [28, [55, 59, 62, 64]]],
      instruments: {
        bass: {part: 'bass', wave: 'sine', unison: 1, sub: 0, cutoff: 900, q: 0.9, env: 0.6, fenv: [0.001, 0.12, 0.3, 0.1], amp: [0.004, 0.3, 0.7, 0.06], gate: 0.85, gain: 0.5, duck: 0.5, drive: 2.4},
        stab: {part: 'chords', wave: 'mix', poly: 8, unison: 2, detune: 10, width: 0.8, cutoff: 760, q: 1.3, env: 2.4, fenv: [0.001, 0.14, 0, 0.1], amp: [0.002, 0.3, 0.12, 0.16], gate: 0.4, gain: 0.3, duck: 0.4, verb: 0.35, echo: 0.5},
        pad: {part: 'chords', wave: 'saw', poly: 10, unison: 3, detune: 14, width: 0.9, cutoff: 700, q: 0.8, env: 1, fenv: [1.2, 2, 0.4, 2], amp: [1.2, 2, 0.8, 2.5], gate: 1, gain: 0.14, duck: 0.4, verb: 0.6},
        keys: {part: 'melody', wave: 'fm', poly: 3, ratio: 1, index: 1.5, indexDecay: 0.7, tine: 0.8, tineRatio: 14, tineDecay: 0.03, cutoff: 5200, q: 0.7, amp: [0.002, 1.6, 0.15, 0.5], gate: 0.9, gain: 0.26, duck: 0.15, verb: 0.4, echo: 0.35, tremolo: {rate: 3.5, depth: 0.25}},
      },
      patterns: {
        drums: {
          intro: {BD: 'X...x...x...x...', SH: 'ggogggogggogggog', RS: '.......o..o.....'},
          groove: {BD: 'X...x...x...x...', CP: '....x.......x...', OH: '..o...o...o...o.', SH: 'ggogggogggogggog', RS: '.......o..o....g'},
          full: {BD: 'X...x...x...x...', CP: '....x.......x...', SD: '....g.......g..g', OH: '..o...o...o...o.', SH: 'ggogggogggogggog', RS: '.......o..o....g', LT: 'o.....o.....g...', MT: '...g......o.....'},
          break: {SH: 'g.og..og..og..og', RS: '.......o..o.....'},
        },
        fills: {
          snare: {SD: '........o.o.xxXX', CP: '....x...........'},
          congas: {LT: 'o.....o...o.g.o.', MT: '...g...o.x...x.X', CP: '....x.......x...'},
        },
        bass: {
          bounce: ['R..R..R...R.O...', 'R..R..R...5.R.O.'],
          walk: ['R..R..R...R.O...', 'R..R..R..5..3.n.'],
        },
        stab: {
          dub: ['..x...x....x..x.', '..x...x...x...x.'],
        },
        pad: {hold: ['x---------------']},
        keys: {
          call: [
            [[0, 76, 3], [4, 79, 2], [7, 76, 1], [10, 74, 2], [13, 72, 3]],
            [[2, 69, 2], [6, 72, 2], [10, 71, 4]],
            [[0, 76, 2], [3, 74, 2], [6, 71, 2], [10, 67, 3], [14, 69, 2]],
            [[0, 71, 6], [8, 67, 2], [11, 64, 4]],
          ],
        },
      },
      sections: [
        {name: 'Intro', bars: 8, play: {drums: 'intro', stab: 'dub'}, auto: {stab: {cut: [0.3, 0.8]}}},
        {name: 'Groove', bars: 16, play: {drums: 'groove', bass: 'bounce', stab: 'dub'}, auto: {stab: {cut: [0.8, 1.2]}}, fx: {crash: true, fill: 'snare'}},
        {name: 'Dusk', bars: 8, play: {drums: 'break', pad: 'hold', stab: 'dub', keys: 'call'}, auto: {stab: {cut: [0.6, 0.9], level: [0.6, 0.8]}}, fx: {riser: 2, fill: 'snare'}},
        {name: 'Afterglow', bars: 16, play: {drums: 'full', bass: 'walk', stab: 'dub', pad: 'hold', keys: 'call'}, auto: {stab: {cut: [1.1, 1.4]}, pad: {level: [0.6, 0.8]}}, fx: {crash: true, boom: true, fill: 'congas'}},
        {name: 'Outro', bars: 8, play: {drums: 'groove', bass: 'bounce', stab: 'dub'}, auto: {stab: {cut: [1, 0.3]}, bass: {level: [1, 0.6]}}},
      ],
    },
    {
      id: 'neon-circuit', title: 'Neon Circuit', bpm: 127, swing: 0.04, seed: 37,
      kit: {BD: [94, 1, 40], SD: [72, 2, 38], CP: [84, 1, 48], RS: [60, 0, 40], CH: [72, 4, 26], OH: [62, 3, 36], CY: [56, 0, 60],
        LT: [70, 0, 55], MT: [70, 0, 50], HT: [68, 0, 45], CB: [62, 0, 45], CL: [60, 0, 50], SH: [44, 8, 16]},
      buses: {kick: [0.86, 0, 0], snare: [0.88, 0, 0.26], hats: [0.95, -0.15, 0.05], perc: [0.8, 0.28, 0.2]},
      reverb: {size: 0.8, damp: 0.3, predelay: 0.02}, echo: [0.75, 0.4, 3000], duck: [0.004, 0.16],
      chords: [[40, [55, 59, 62, 66]], [40, [55, 59, 62, 66]], [36, [55, 59, 62, 64]], [38, [54, 57, 59, 62]]],
      instruments: {
        acid: {part: 'bass', wave: 'saw', unison: 1, sub: 0.25, cutoff: 240, q: 7, env: 2.6, accentEnv: 0.6, accentLevel: 0.35, key: 0.3, fenv: [0.001, 0.22, 0, 0.08], amp: [0.002, 0.3, 0.6, 0.03], gate: 0.6, glide: 0.055, gain: 0.34, duck: 0.4, drive: 2.2, verb: 0.08, echo: 0.12},
        stab: {part: 'chords', wave: 'square', poly: 8, unison: 2, detune: 12, width: 0.9, cutoff: 1400, q: 1.1, env: 2, fenv: [0.001, 0.1, 0, 0.1], amp: [0.002, 0.18, 0, 0.12], gate: 0.35, gain: 0.2, duck: 0.35, verb: 0.35, echo: 0.45},
        pad: {part: 'chords', wave: 'saw', poly: 10, unison: 3, detune: 18, width: 0.95, cutoff: 1100, q: 0.9, env: 1, fenv: [2, 2, 0.5, 2], amp: [1.5, 2, 0.8, 2.5], gate: 1, gain: 0.12, duck: 0.5, verb: 0.6},
      },
      patterns: {
        drums: {
          intro: {BD: 'X.....x...x.....', CH: 'ogxgogxgogxgogxg', CL: '..o.....o.o.....'},
          acid: [{BD: 'X.....x...x.....', CP: '....x.......x...', CH: 'ogxgogxgogxgogxg', CB: '......o....o....', CL: '..o.....o.o.....'},
            {BD: 'X.....x...x..x..', CP: '....x.......x...', CH: 'ogxgogxgogxgogxo', CB: '......o....o..g.', CL: '..o.....o.o.....'}],
          peak: [{BD: 'X.....x...x.....', CP: '....x.......x...', SD: '....g.......g...', CH: 'ogxgogxgogxgogxg', OH: '..........o.....', CB: '......o....o....', LT: 'g.......g.......', CL: '..o.....o.o.....'},
            {BD: 'X.....x...x..x..', CP: '....x.......x...', SD: '....g.......g..g', CH: 'ogxgogxgogxgogxo', OH: '..........o.....', CB: '......o....o..g.', HT: '.............o..', CL: '..o.....o.o.....'}],
          break: {CH: 'g.g.g.g.g.g.g.g.', CB: '......o....o....', CL: '..o.....o.o.....'},
        },
        fills: {
          toms: {LT: '........x.x...X.', MT: '....x.x.........', HT: 'x.x.............', CP: '....x.......x...'},
          snare: {SD: 'o.o.o.o.x.x.xxXX', CP: '....x.......x...'},
        },
        acid: {
          line: [{notes: [0, 0, 12, null, 0, 10, 0, 7, 0, null, 12, 3, 0, 7, 15, 12], accent: 'x...x.....x...x.', slide: '..x....x.....x..'},
            {notes: [0, null, 0, 12, 10, 0, 3, null, 0, 12, 0, 7, null, 5, 7, 10], accent: 'x.....x...x....x', slide: '...x......x..x..'}],
          drive: [{notes: [0, 12, 0, 12, 0, 10, 12, 7, 0, 12, 0, 15, 12, 7, 3, 5], accent: 'x.x...x...x.x..x', slide: '.x.x....x....x..'},
            {notes: [0, 0, 12, 0, 7, 0, 10, 12, 0, 0, 15, 12, 10, 7, 5, 3], accent: 'x...x...x.x...x.', slide: '..x...x.....xx..'}],
        },
        stab: {hits: ['x.....x.........', '...x......x.....'], sparse: ['x...............', '......x.........']},
        pad: {hold: ['x---------------']},
      },
      sections: [
        {name: 'Intro', bars: 8, play: {drums: 'intro', acid: 'line'}, auto: {acid: {cut: [0.5, 1]}}},
        {name: 'Circuit', bars: 16, play: {drums: 'acid', acid: 'line', stab: 'sparse'}, auto: {acid: {cut: [1, 2.6]}}, fx: {crash: true, fill: 'toms'}},
        {name: 'Static', bars: 8, play: {drums: 'break', pad: 'hold', stab: 'hits', acid: 'line'}, auto: {acid: {cut: [1.2, 3.2], level: [0.7, 0.9]}}, fx: {riser: 4, fill: 'snare'}},
        {name: 'Neon', bars: 16, play: {drums: 'peak', acid: 'drive', stab: 'hits', pad: 'hold'}, auto: {acid: {cut: [2, 4.5]}, pad: {level: [0.5, 0.7]}}, fx: {crash: true, boom: true, fill: 'toms'}},
        {name: 'Outro', bars: 8, play: {drums: 'acid', acid: 'line'}, auto: {acid: {cut: [2.4, 0.5]}}},
      ],
    },
    {
      id: 'slow-sundays', title: 'Slow Sundays', bpm: 86, swing: 0.2, seed: 53, vinyl: 1,
      kit: {BD: [92, -2, 62], SD: [74, -2, 58], CP: [60, -3, 50], RS: [62, 0, 45], CH: [56, -1, 34], OH: [52, -1, 50], CY: [40, 0, 50],
        LT: [56, 0, 50], MT: [56, 0, 45], HT: [52, 0, 40], CB: [40, 0, 40], CL: [44, 0, 45], SH: [40, 3, 22]},
      buses: {kick: [0.8, 0, 0], snare: [0.9, 0.04, 0.2], hats: [0.85, -0.2, 0.05], perc: [0.7, 0.25, 0.12]},
      reverb: {size: 0.82, damp: 0.5, predelay: 0.015, lowCut: 220}, echo: [0.5, 0.38, 2200], duck: [0.006, 0.26], tone: 12000, air: 0.5,
      chords: [[38, [53, 57, 60, 64]], [31, [53, 57, 59, 64]], [36, [52, 55, 59, 62]], [33, [55, 58, 61, 65]]],
      instruments: {
        bass: {part: 'bass', wave: 'sine', unison: 1, sub: 0, cutoff: 700, q: 0.8, env: 0.4, fenv: [0.002, 0.2, 0.4, 0.2], amp: [0.006, 0.6, 0.6, 0.12], gate: 0.92, gain: 0.52, duck: 0.25, drive: 1.8},
        keys: {part: 'chords', wave: 'fm', poly: 12, ratio: 1, index: 1.3, indexDecay: 0.9, tine: 0.7, tineRatio: 14, tineDecay: 0.035, cutoff: 3600, q: 0.7, amp: [0.003, 2.4, 0.25, 0.6], gate: 1, gain: 0.3, duck: 0.15, verb: 0.38, echo: 0.1, tremolo: {rate: 4.2, depth: 0.3}},
        bell: {part: 'melody', wave: 'fm', poly: 3, ratio: 2.76, index: 1.1, indexDecay: 0.5, tine: 0, cutoff: 6000, q: 0.7, amp: [0.002, 1.2, 0.1, 0.7], gate: 0.9, gain: 0.18, duck: 0.1, verb: 0.5, echo: 0.4},
      },
      patterns: {
        drums: {
          intro: {SH: 'g.o.g.o.g.o.g.o.'},
          boom: [{BD: 'X.....x...x.....', SD: '....X.......X...', CP: '....o.......o...', CH: 'x.ogx.o.x.ogx.og', RS: '.......g......g.'},
            {BD: 'X.....x.x.....g.', SD: '....X.......X..g', CP: '....o.......o...', CH: 'x.ogx.o.x.ogx.o.', OH: '..............o.', RS: '.......g........'}],
          busy: [{BD: 'X.....x...x.....', SD: '....X.......X...', CP: '....o.......o...', CH: 'xgogxgogxgogxgog', SH: '..g...g...g...g.', RS: '.......g......g.'},
            {BD: 'X.....x.x.....g.', SD: '....X.......X..g', CP: '....o.......o...', CH: 'xgogxgogxgogxgo.', OH: '..............o.', SH: '..g...g...g...g.', RS: '.......g........'}],
        },
        fills: {
          snare: {SD: '....X.....g.o.xX', CP: '....o...........'},
        },
        bass: {
          walk: ['R-----..R--.5--n', 'R-----..R--.3-5n'],
        },
        keys: {
          comp: ['X-----o---------', 'x-----.---o---.-'],
        },
        bell: {
          tune: [
            [[4, 74, 2], [6, 76, 2], [8, 77, 4], [14, 76, 2]],
            [[0, 74, 4], [6, 71, 2], [8, 72, 6]],
            [[2, 67, 2], [4, 71, 2], [6, 74, 6], [12, 72, 2], [14, 71, 2]],
            [[0, 73, 4], [6, 70, 2], [8, 69, 8]],
          ],
        },
      },
      sections: [
        {name: 'Intro', bars: 4, play: {drums: 'intro', keys: 'comp'}, auto: {keys: {cut: [0.4, 1]}}},
        {name: 'Sunday', bars: 16, play: {drums: 'boom', bass: 'walk', keys: 'comp'}, fx: {fill: 'snare'}},
        {name: 'Window', bars: 8, play: {drums: 'busy', bass: 'walk', keys: 'comp', bell: 'tune'}, fx: {fill: 'snare'}},
        {name: 'Afternoon', bars: 12, play: {drums: 'boom', bass: 'walk', keys: 'comp', bell: 'tune'}, fx: {fill: 'snare'}},
        {name: 'Outro', bars: 8, play: {drums: 'intro', bass: 'walk', keys: 'comp', bell: 'tune'}, auto: {keys: {cut: [1, 0.5]}, bell: {level: [1, 0.5]}, bass: {level: [1, 0.4]}}},
      ],
    },
  ];

  const steps = (row, length = 16) => typeof row === 'string' ? row.padEnd(length, '.').slice(0, length) : row;
  const cycle = (list, index) => Array.isArray(list) ? list[index % list.length] : list;
  const ramp = (range, t) => !range ? 1 : range[0] > 0 && range[1] > 0 ? range[0] * Math.pow(range[1] / range[0], t) : range[0] + (range[1] - range[0]) * t;
  const ARP = '0123456789abcdef';

  // The song's timing: bar starts are rounded once, so rendering any range of bars joins without a gap.
  function describe(song) {
    const step = SR * 60 / song.bpm / 4, bar = step * 16;
    let at = 0;
    const sections = song.sections.map(section => { const start = at; at += section.bars; return {...section, start}; });
    const bars = at;
    return {id: song.id, title: song.title, bpm: song.bpm, bars, stepSamples: step, barSamples: bar,
      barStart: index => Math.round(index * bar), duration: Math.round(bars * bar) / SR,
      sections: sections.map(section => Math.round(section.start * bar) / SR).slice(1), parts: sections};
  }

  class SongRenderer {
    // Drum808: the Drum 808 engine's processor class, loaded with a minimal AudioWorklet shim.
    constructor(index, Drum808) {
      const song = this.song = SONGS[index];
      this.info = describe(song);
      this.drums = {};
      for (const bus of ['kick', 'snare', 'hats', 'perc']) this.drums[bus] = new Drum808();
      for (const [key, [level, tune, decay]] of Object.entries(song.kit)) this.drums[BUS_OF[key]].message({type: 'voice', track: VOICE_OF(key), level, tune, decay});
      this.instruments = {};
      for (const [name, patch] of Object.entries(song.instruments)) this.instruments[name] = new Instrument(patch);
      this.reverb = new Reverb(song.reverb); this.echo = new Echo(song.echo[0] * 60 / song.bpm, song.echo[1], song.echo[2]);
      this.noiseL = new Noise(song.seed * 7919); this.noiseR = new Noise(song.seed * 104729); this.crackle = new Noise(song.seed * 31);
      this.riser = {left: 0, length: 1, l: new Svf(), r: new Svf()}; this.boom = {t: 1e9, phase: 0};
      this.duckT = 1e9; this.duck = 0; this.env = 0; this.gain = 1; this.target = 1;
      this.lowL = new Svf(32, 0.7); this.lowR = new Svf(32, 0.7); this.airL = new Svf(5200, 0.6); this.airR = new Svf(5200, 0.6); this.hiss = new Svf(song.tone || 6000, 0.6); this.toneL = new Svf(song.tone || 20000, 0.6); this.toneR = new Svf(song.tone || 20000, 0.6);
      this.events = [];
    }

    // The bar's events in time order: [frame within the bar, kind, ...].
    plan(bar) {
      const song = this.song, info = this.info, P = song.patterns;
      const section = info.parts.find(part => bar >= part.start && bar < part.start + part.bars) || info.parts.at(-1);
      const inSection = bar - section.start, last = inSection === section.bars - 1, fx = section.fx || {};
      const step = info.stepSamples, swing = song.swing || 0;
      const at = s => Math.round(s * step + (s % 2 ? swing * step : 0));
      const chordIndex = bar % song.chords.length, [root, voicing] = song.chords[chordIndex], [nextRoot] = song.chords[(bar + 1) % song.chords.length];
      const events = [];
      // Drums: the section's pattern, with its fill over the last bar and the kick out before a drop.
      let drums = section.play.drums ? {...cycle(P.drums[section.play.drums], inSection)} : {};
      if (last && fx.fill) Object.assign(drums, P.fills[fx.fill]);
      if (last && fx.riser) drums.BD = (drums.BD || '').slice(0, 8);
      for (const [key, row] of Object.entries(drums)) {
        const cells = steps(row);
        for (let s = 0; s < 16; s++) { const v = VELOCITY[cells[s]]; if (v) events.push([at(s), 0, key, v * (1 - 0.06 * ((s * 7 + bar * 3) % 5) / 4)]); }
      }
      if (inSection === 0 && fx.crash) events.push([0, 0, 'CY', 1]);
      if (inSection === 0 && fx.boom) events.push([0, 2]);
      if (fx.riser && inSection === section.bars - fx.riser) events.push([0, 3, Math.round(fx.riser * info.barSamples)]);
      // Pitched parts.
      for (const [name, which] of Object.entries(section.play)) {
        if (name === 'drums') continue;
        const inst = this.instruments[name], patch = song.instruments[name], pattern = cycle(P[name]?.[which], inSection);
        if (!inst || !pattern) continue;
        const gate = patch.gate || 0.8;
        if (patch.part === 'melody') {
          for (const [s, note, length, vel = 0.8] of cycle(P[name][which], bar)) events.push([at(s), 1, name, note, vel, Math.round(length * step * gate)]);
          continue;
        }
        if (typeof pattern === 'object' && !Array.isArray(pattern) && pattern.notes) {
          const accent = steps(pattern.accent || ''), slide = steps(pattern.slide || '');
          pattern.notes.forEach((offset, s) => {
            if (offset == null) return;
            const tied = slide[s] === 'x';
            events.push([at(s), 1, name, root + offset, 0.8, Math.round(step * (tied ? 1.05 : gate)), slide[(s + 15) % 16] === 'x' && s > 0, accent[s] === 'x' ? 1 : 0]);
          });
          continue;
        }
        const cells = steps(pattern);
        for (let s = 0; s < 16; s++) {
          const c = cells[s];
          if (c === '.' || c === '-') continue;
          let hold = 1; while (s + hold < 16 && cells[s + hold] === '-') hold++;
          const length = Math.round(hold * step * gate);
          if (patch.part === 'bass') {
            const third = voicing.some(n => (n - root) % 12 === 3) ? 3 : 4, seventh = voicing.some(n => (n - root) % 12 === 11) ? 11 : 10;
            const offset = {R: 0, O: 12, 5: 7, 3: third, 7: seventh, 9: 14, 4: 5}[c];
            const note = c === 'n' ? nextRoot - 1 + (nextRoot - 1 < root - 6 ? 12 : 0) : root + (offset ?? 0);
            events.push([at(s), 1, name, note, 0.85, length, false, 0]);
          } else if (patch.part === 'chords') {
            const vel = VELOCITY[c] || 0.8;
            for (const note of voicing) events.push([at(s), 1, name, note + (patch.octave || 0), vel, length, false, 0]);
          } else if (patch.part === 'arp') {
            const k = ARP.indexOf(c);
            if (k < 0) continue;
            const sorted = [...voicing].sort((a, b) => a - b), note = sorted[k % sorted.length] + 12 * Math.floor(k / sorted.length) + (patch.octave || 0);
            events.push([at(s), 1, name, note, s % 4 === 0 ? 0.9 : 0.7, length, false, 0]);
          }
        }
      }
      events.sort((a, b) => a[0] - b[0]);
      this.automation = {section, inSection};
      return events;
    }

    fire(event) {
      const kind = event[1];
      if (kind === 0) {
        const key = event[2], bus = BUS_OF[key];
        this.drums[bus].trigger(VOICE_OF(key), event[3]);
        if (this.busList) this.busList.find(entry => entry.name === bus).idle = 0;
        if (key === 'BD') this.duckT = 0;
      } else if (kind === 1) this.instruments[event[2]].play(event[3], event[4], event[5], event[6], event[7]);
      else if (kind === 2) this.boom = {t: 0, phase: 0};
      else if (kind === 3) this.riser = {...this.riser, left: event[2], length: event[2]};
    }

    // Section automation (filter cut-off and level per instrument), set once per control block.
    automate(frame, barFrames) {
      const {section, inSection} = this.automation, t = (inSection + frame / barFrames) / section.bars;
      for (const [name, inst] of Object.entries(this.instruments)) {
        const auto = section.auto?.[name];
        inst.cut = ramp(auto?.cut, t); inst.level = auto?.level ? ramp(auto.level, t) : 1;
      }
    }

    // Renders bars [from, from + count) into new left and right channels.
    render(from, count) {
      const info = this.info, start = info.barStart(from), frames = info.barStart(from + count) - start;
      const left = new Float32Array(frames), right = new Float32Array(frames);
      const song = this.song, buses = song.buses, ins = this.instruments, names = Object.keys(ins);
      const insts = names.map(name => ins[name]), ducks = names.map(name => song.instruments[name].duck || 0);
      const verbs = names.map(name => (song.instruments[name].verb || 0) * 0.5), echoes = names.map(name => (song.instruments[name].echo || 0) * 0.5);
      const [duckA, duckR] = song.duck, duckAttack = Math.max(1, Math.round(duckA * SR)), duckK = Math.exp(-1 / (duckR * SR)), air = song.air ?? 0.9;
      const panOf = pan => [Math.cos((1 + pan) * Math.PI / 4) * Math.SQRT2, Math.sin((1 + pan) * Math.PI / 4) * Math.SQRT2];
      const busList = this.busList ||= ['kick', 'snare', 'hats', 'perc'].map(name => { const [gain, pan, verb] = buses[name]; const [pl, pr] = panOf(pan); return {name, drum: this.drums[name], l: gain * pl, r: gain * pr, verb: gain * verb, idle: 0}; });
      const atk = 1 - Math.exp(-1 / (0.004 * SR)), rel = 1 - Math.exp(-1 / (0.18 * SR));
      const THRESHOLD = 0.42, RATIO = 2.2, MAKEUP = 1.18, CEILING = 0.92;
      let out = 0;
      for (let b = from; b < from + count; b++) {
        const barFrames = info.barStart(b + 1) - info.barStart(b), events = this.plan(b);
        let next = 0;
        for (let i = 0; i < barFrames; i++, out++) {
          while (next < events.length && events[next][0] <= i) this.fire(events[next++]);
          if ((i & (CONTROL - 1)) === 0) this.automate(i, barFrames);
          // Ducking from the last kick.
          const t = this.duckT++, duck = this.duck = t < duckAttack ? t / duckAttack : this.duck * duckK;
          let l = 0, r = 0, verb = 0, echo = 0;
          // A drum instance with every voice silent is skipped until its next hit.
          for (let k = 0; k < 4; k++) {
            const bus = busList[k];
            if (bus.idle > 0) { bus.idle--; continue; }
            const s = bus.drum.render(); l += s * bus.l; r += s * bus.r; verb += s * bus.verb;
            if ((i & 127) === 0 && !bus.drum.voices.some(voice => voice.on)) bus.idle = 127;
          }
          for (let k = 0; k < insts.length; k++) {
            const inst = insts[k];
            inst.render();
            const g = 1 - ducks[k] * duck, il = inst.l * g, ir = inst.r * g;
            l += il; r += ir; verb += (il + ir) * verbs[k]; echo += (il + ir) * echoes[k];
          }
          if (this.riser.left > 0) {
            const k = 1 - this.riser.left-- / this.riser.length, cutoff = 300 * Math.pow(2, 5 * k);
            if ((i & (CONTROL - 1)) === 0) { this.riser.l.set(cutoff, 2.5); this.riser.r.set(cutoff * 1.08, 2.5); }
            this.riser.l.run(this.noiseL.next()); this.riser.r.run(this.noiseR.next());
            const a = 0.16 * k * k;
            l += this.riser.l.band * a; r += this.riser.r.band * a; verb += (this.riser.l.band + this.riser.r.band) * a * 0.8;
          }
          if (this.boom.t < SR * 1.2) {
            const bt = this.boom.t++ / SR, f = 38 + 70 * Math.exp(-bt / 0.06);
            this.boom.phase += f / SR; if (this.boom.phase >= 1) this.boom.phase -= 1;
            const s = Math.sin(TAU * this.boom.phase) * 0.34 * Math.exp(-bt / 0.5);
            l += s; r += s; verb += s * 0.3;
          }
          if (song.vinyl) {
            this.hiss.run(this.noiseL.next());
            const crackle = this.crackle.next() > 0.99965 ? this.crackle.next() * 0.09 : 0;
            l += this.hiss.low * 0.006 + crackle; r += this.hiss.low * 0.006 + crackle * 0.8;
          }
          this.reverb.run(verb); this.echo.run(echo);
          l += this.reverb.l + this.echo.l * 0.9; r += this.reverb.r + this.echo.r * 0.9;
          if (song.tone) { this.toneL.run(l); this.toneR.run(r); l = this.toneL.low; r = this.toneR.low; }
          // A low cut and an air shelf, a bus compressor, then a soft ceiling.
          this.lowL.run(l); this.lowR.run(r); l = this.lowL.high; r = this.lowR.high;
          this.airL.run(l); this.airR.run(r); l += this.airL.high * air; r += this.airR.high * air;
          const level = Math.max(Math.abs(l), Math.abs(r));
          this.env += (level - this.env) * (level > this.env ? atk : rel);
          if ((i & (CONTROL - 1)) === 0) this.target = this.env > THRESHOLD ? Math.pow(THRESHOLD / this.env, 1 - 1 / RATIO) : 1;
          this.gain += (this.target - this.gain) * 0.002;
          l *= this.gain * MAKEUP; r *= this.gain * MAKEUP;
          left[out] = CEILING * Math.tanh(l / CEILING); right[out] = CEILING * Math.tanh(r / CEILING);
        }
      }
      return {left, right, start};
    }
  }

  const api = Object.freeze({SR, songs: SONGS.map(describe).map(({parts, barStart, ...info}) => info), describe: index => describe(SONGS[index]), SongRenderer});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.VisualsBeats = api;
})(typeof self !== 'undefined' ? self : globalThis);

