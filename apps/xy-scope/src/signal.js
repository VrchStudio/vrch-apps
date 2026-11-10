// signal.js: how every sample is made. This one file decides both the sound and the picture.
//
// It runs in two places with the same code: on the audio thread (engine.js sends x to the left speaker and y to the
// right) and on the page (before sound starts, and on a large output, the picture is computed here directly).
//
// IN   p    the settings, see settings() below
//      s    the running state from create(): oscillator phases, tumble, spin angle, envelopes
// OUT  out[2i] = x and out[2i + 1] = y for n samples. A full-size figure spans -1..1; a spinning one reaches 1.42.
//      The same numbers are the beam position on screen and, times LEVEL, the speaker samples.
//
// To remix: change render(). Add an oscillator, read x and y from a table of points, modulate anything here, and the
// sound and the picture follow together. Keep every sample within +-1.42 and avoid sudden jumps (they click).
(() => {
  'use strict';
  const SR = 48000, DT = 1 / SR, TAU = Math.PI * 2;
  const LEVEL = 0.345;       // speaker sample = value x LEVEL: -9 dBFS for a full-size figure, never above -6 dBFS
  const PARTIALS = 31;       // highest harmonic of a shaped wave; fewer for high notes so nothing folds back (aliases)
  const GLIDE = 0.02;        // seconds: every setting moves smoothly, so turning a knob never clicks
  const LOCK = 0.04;         // seconds: how quickly Y settles into step with X after the ratio changes
  const perSample = seconds => 1 - Math.exp(-DT / seconds);
  const K_GLIDE = perSample(GLIDE), K_LOCK = perSample(LOCK), K_HOLD = perSample(0.008), K_STRIKE = perSample(0.002), K_REST = perSample(0.15);

  // The settings a figure is made of.
  const settings = () => ({
    freq: 110,       // X pitch in Hz
    ratio: 1.5,      // Y pitch = X pitch x ratio
    num: 3, den: 2,  // the same ratio as whole numbers; den 0 means "free": any ratio, and the figure never rests
    drift: 0.1,      // Hz added to Y: the figure slowly tumbles and the two notes beat
    shape: 0,        // 0 sine .. 0.5 triangle .. 1 trapezoid
    spin: 0,         // turns per second of the whole figure
    decay: 1.5,      // seconds a strike takes to die away
    hold: 0,         // 1 while the tone is held
    strike: 0,       // 1 while the strike key is down
  });

  // tumble: which view of the figure is showing, 0..1. At 0.25 it is wide open (a circle for 1:1, an 8 for 2:1); at 0
  // and 0.5 it folds into a single line. Drift moves it; with no drift it rests.
  const create = () => ({
    px: 0, py: 0, tumble: 0.25, angle: 0,
    freq: -1, ratio: 1, drift: 0, spin: 0, shape: -1,   // the smoothed settings actually sounding (-1: not started)
    hold: 0, strike: 0,                                 // the two envelopes, 0..1
    amp: new Float32Array(PARTIALS + 1),                // harmonic levels of the current shape
  });
  const copy = s => ({...s, amp: new Float32Array(s.amp)});
  // Where Y sits against X (in cycles of Y) for a tumble view of the whole-number ratio num:den.
  const offset = (tumble, num, den) => (tumble + (den - num) / 4) / den;

  // Harmonic levels for a shape. Sine has only the first. A triangle adds odd harmonics falling as 1/k^2; narrowing its
  // ramp (a trapezoid) makes them stronger. Built from sines up to PARTIALS, so the wave has no content above that.
  function harmonics(shape, amp) {
    const toTriangle = Math.min(1, shape * 2), ramp = (Math.PI / 2) * (1 - 0.7 * Math.max(0, shape * 2 - 1));
    for (let k = 1; k <= PARTIALS; k += 2) {
      const soften = k === 1 ? 1 : Math.sin(Math.PI * k / (PARTIALS + 1)) / (Math.PI * k / (PARTIALS + 1));
      const angular = 4 / (Math.PI * ramp * k * k) * Math.sin(k * ramp) * soften;
      amp[k] = (k === 1 ? 1 - toTriangle : 0) + toTriangle * angular;
    }
  }
  // One sample of the shaped wave at a phase counted in cycles, summing odd harmonics up to "top".
  function wave(phase, amp, top) {
    const a = TAU * phase, s1 = Math.sin(a);
    if (top < 3) return amp[1] * s1;
    const c1 = Math.cos(a), c2 = c1 * c1 - s1 * s1, s2 = 2 * s1 * c1;
    let s = s1, c = c1, sum = amp[1] * s1;
    for (let k = 3; k <= top; k += 2) { const next = s * c2 + c * s2; c = c * c2 - s * s2; s = next; sum += amp[k] * s; }
    return sum;
  }
  const highest = (hz, shaped) => shaped ? Math.max(1, Math.min(PARTIALS, Math.floor(0.45 * SR / hz))) : 1;

  function render(s, p, out, n) {
    if (s.freq < 0) {
      s.freq = p.freq; s.ratio = p.ratio; s.drift = p.drift; s.spin = p.spin;
      if (p.den > 0) s.py = p.ratio * s.px + offset(s.tumble, p.num, p.den);
    }
    // Shape moves once per call (a call is a few milliseconds).
    const shape = s.shape < 0 ? p.shape : s.shape + (p.shape - s.shape) * (1 - Math.exp(-n * DT / GLIDE));
    if (shape !== s.shape) { s.shape = Math.abs(shape - p.shape) < 1e-4 ? p.shape : shape; harmonics(s.shape, s.amp); }
    const shaped = s.shape > 0, amp = s.amp, den = p.den, locked = den > 0;
    const fade = Math.exp(-6.908 * DT / Math.max(0.05, p.decay));   // a strike falls 60 dB in "decay" seconds
    let {px, py, tumble, angle, freq, ratio, drift, spin, hold, strike} = s;
    for (let i = 0; i < n; i++) {
      freq += (p.freq - freq) * K_GLIDE; ratio += (p.ratio - ratio) * K_GLIDE;
      drift += (p.drift - drift) * K_GLIDE; spin += (p.spin - spin) * K_GLIDE;

      // Two oscillators. X runs at the pitch, Y at pitch x ratio + drift.
      px += freq * DT;
      py += (freq * ratio + drift) * DT;
      if (locked) {
        // A whole-number ratio closes the figure. Keep Y exactly in step with X so the figure shows the tumble view:
        // drift turns the view, and any leftover error is eased out (heard as a very short slide into tune).
        tumble += den * drift * DT; tumble -= Math.floor(tumble);
        if (Math.abs(ratio - p.ratio) < 0.01) {
          let error = py - p.ratio * px - offset(tumble, p.num, den);
          error -= Math.round(error * den) / den;
          py -= error * K_LOCK;
        }
        if (px >= 12) { px -= 12; py -= 12 * p.num / den; }
      } else {
        if (px >= 1) px -= 1;
        if (py >= 1) py -= 1;
      }
      let x = wave(px, amp, highest(freq, shaped));
      let y = wave(py, amp, highest(freq * ratio + drift, shaped));

      // Spin turns the whole figure: on screen it rotates, in the speakers X and Y trade places. With no spin the
      // figure eases back upright.
      if (p.spin !== 0) { angle += spin * DT; angle -= Math.floor(angle); }
      else if (angle !== 0) { angle -= Math.round(angle * 2) / 2; angle -= angle * K_REST; if (Math.abs(angle) < 1e-5) angle = 0; }
      if (angle !== 0) {
        const c = Math.cos(TAU * angle), k = Math.sin(TAU * angle), turned = x * c - y * k;
        y = x * k + y * c; x = turned;
      }

      // Loudness, which is also size. Hold fades in and out in about 30 ms; a strike rises at once and dies away.
      hold += (p.hold - hold) * K_HOLD;
      strike = p.strike ? strike + (1 - strike) * K_STRIKE : strike < 1e-5 ? 0 : strike * fade;
      const level = Math.max(hold, strike);
      out[2 * i] = x * level; out[2 * i + 1] = y * level;
    }
    Object.assign(s, {px, py, tumble, angle, freq, ratio, drift, spin, hold, strike});
  }

  globalThis.XYSignal = {SR, LEVEL, settings, create, copy, render};
})();
