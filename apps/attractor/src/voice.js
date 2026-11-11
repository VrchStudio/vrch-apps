// voice.js: the audio thread behind "sound". It follows one point through the formula and plays where it is: x on the
// left, y on the right (for a flow, x and z). A map takes "hear" steps a second with a straight line between them; a
// flow moves "hear" units of its own time a second. Nothing here is random: the same letters sound the same.
//
// IN   {type: 'formula', formula}   the entry from formulas.js to follow
//      {type: 'letters', k}         a, b, c, d
//      {type: 'on', on}             fade in, or fade out
'use strict';
const FUNCTIONS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, abs: Math.abs, sign: Math.sign, sqrt: Math.sqrt, exp: Math.exp, log: Math.log, floor: Math.floor,
  pow: Math.pow, min: Math.min, max: Math.max, atan: (y, x) => x === undefined ? Math.atan(y) : Math.atan2(y, x),
  mod: (x, y) => x - y * Math.floor(x / y), fract: x => x - Math.floor(x),
};
// Reads one expression as formulas.js writes it for the picture: numbers, + - * /, brackets, the functions above and
// the names in "slots". Returns a function of the list of values those names stand for.
function parse(text, slots) {
  const tokens = text.match(/\d*\.?\d+(?:[eE][-+]?\d+)?|[A-Za-z_][\w.]*|[-+*/(),]/g) || [];
  let at = 0;
  const peek = () => tokens[at], take = () => tokens[at++];
  function primary() {
    const t = take();
    if (t === '(') { const inside = sum(); take(); return inside; }
    if (t === '-') { const value = primary(); return v => -value(v); }
    if (t === '+') return primary();
    if (t === undefined) throw new Error('cannot read ' + text);
    if (/^[\d.]/.test(t)) { const number = Number(t); return () => number; }
    if (peek() === '(') {
      take();
      const args = [sum()];
      while (peek() === ',') { take(); args.push(sum()); }
      take();
      const f = FUNCTIONS[t];
      if (!f) throw new Error('unknown function ' + t);
      return args.length === 1 ? v => f(args[0](v)) : v => f(args[0](v), args[1](v));
    }
    const slot = slots.indexOf(t);
    if (slot < 0) throw new Error('unknown name ' + t);
    return v => v[slot];
  }
  function product() {
    let left = primary();
    while (peek() === '*' || peek() === '/') { const times = take() === '*', l = left, r = primary(); left = times ? v => l(v) * r(v) : v => l(v) / r(v); }
    return left;
  }
  function sum() {
    let left = product();
    while (peek() === '+' || peek() === '-') { const plus = take() === '+', l = left, r = product(); left = plus ? v => l(v) + r(v) : v => l(v) - r(v); }
    return left;
  }
  const whole = sum();
  if (at !== tokens.length) throw new Error('cannot read ' + text);
  return whole;
}
// A formula's rule as a function: rule(point, letters, out) writes the next point of a map, or the rate of change of
// a flow, into out.
function compile(formula) {
  const slots = ['a', 'b', 'c', 'd', 'p.x', 'p.y', 'p.z'], helpers = [];
  for (const line of formula.with || []) {
    const cut = line.indexOf('=');
    helpers.push(parse(line.slice(cut + 1), slots));
    slots.push(line.slice(0, cut).trim());
  }
  const body = formula.flow || formula.step, inner = body.slice(body.indexOf('(') + 1, body.lastIndexOf(')')), parts = [];
  for (let i = 0, depth = 0, from = 0; i <= inner.length; i++) {
    const ch = inner[i];
    if (ch === '(') depth++; else if (ch === ')') depth--;
    else if ((ch === ',' && !depth) || i === inner.length) { parts.push(inner.slice(from, i)); from = i + 1; }
  }
  const outs = parts.map(part => parse(part, slots)), v = new Float64Array(slots.length);
  return (p, k, out) => {
    v[0] = k[0]; v[1] = k[1]; v[2] = k[2]; v[3] = k[3]; v[4] = p[0]; v[5] = p[1]; v[6] = p[2];
    for (let i = 0; i < helpers.length; i++) v[7 + i] = helpers[i](v);
    out[0] = outs[0](v); out[1] = outs[1](v); out[2] = outs.length > 2 ? outs[2](v) : 0;
  };
}

const LEVEL = 0.3;          // no sample is louder than this (-10.5 dBFS)
const FADE_SECONDS = 0.03;  // in and out, so starting and stopping never click
const MAP_STEPS = 2400;     // steps a second for a map with no "hear"
// A sample from where the point is (1 is the edge of the view): loud parts are rounded off, never cut.
const shape = value => Math.tanh(value) * LEVEL;
// The point as it moves: step(seconds) advances it, and "now" is where it is (between two steps of a map).
function follower(formula) {
  const rule = compile(formula), flow = !!formula.flow, view = formula.view, centre = [0, 1, 2].map(i => (formula.centre || [])[i] || 0);
  const speed = formula.hear || (flow ? 100 : MAP_STEPS), p = [0, 0, 0], was = [0, 0, 0], now = [0, 0, 0], k1 = [0, 0, 0], k2 = [0, 0, 0], k3 = [0, 0, 0], k4 = [0, 0, 0], t = [0, 0, 0];
  let part = 1, k = [0, 0, 0, 0];
  const home = () => { for (let i = 0; i < 3; i++) p[i] = was[i] = centre[i] + (flow || i < 2 ? 0.137 * view * (i + 1) / 3 : 0); };
  const lost = () => !(Math.abs(p[0] - centre[0]) + Math.abs(p[1] - centre[1]) + Math.abs(p[2] - centre[2]) < 16 * view);
  home();
  return {
    flow, view, centre, now,
    letters(next) { k = next; },
    step(seconds) {
      if (flow) {
        const dt = speed * seconds;
        rule(p, k, k1);
        for (let i = 0; i < 3; i++) t[i] = p[i] + 0.5 * dt * k1[i];
        rule(t, k, k2);
        for (let i = 0; i < 3; i++) t[i] = p[i] + 0.5 * dt * k2[i];
        rule(t, k, k3);
        for (let i = 0; i < 3; i++) t[i] = p[i] + dt * k3[i];
        rule(t, k, k4);
        for (let i = 0; i < 3; i++) p[i] += dt / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
        if (lost()) home();
        now[0] = p[0]; now[1] = p[1]; now[2] = p[2];
        return;
      }
      part += speed * seconds;
      while (part >= 1) {
        part -= 1; was[0] = p[0]; was[1] = p[1];
        rule(was, k, t); p[0] = t[0]; p[1] = t[1];
        if (lost()) home();
      }
      now[0] = was[0] + (p[0] - was[0]) * part; now[1] = was[1] + (p[1] - was[1]) * part;
    },
  };
}

if (typeof registerProcessor === 'function') {
  class Voice extends AudioWorkletProcessor {
    constructor() {
      super();
      this.point = null; this.k = [0, 0, 0, 0]; this.on = false; this.gain = 0;
      this.before = [0, 0]; this.out = [0, 0];   // a slow high-pass takes out the figure's off-centre rest position
      this.port.onmessage = ({data: m}) => {
        if (m.type === 'formula') { try { this.point = follower(m.formula); this.point.letters(this.k); } catch (_) { this.point = null; } }
        else if (m.type === 'letters') { this.k = m.k; if (this.point) this.point.letters(m.k); }
        else if (m.type === 'on') this.on = !!m.on;
      };
    }
    process(_, outputs) {
      const left = outputs[0][0], right = outputs[0][1] || left, point = this.point;
      if (!point || (!this.on && this.gain <= 0)) return true;
      const fade = 1 / (FADE_SECONDS * sampleRate), second = point.flow ? 2 : 1;
      for (let i = 0; i < left.length; i++) {
        point.step(1 / sampleRate);
        this.gain = Math.max(0, Math.min(1, this.gain + (this.on ? fade : -fade)));
        const x = (point.now[0] - point.centre[0]) / point.view, y = (point.now[second] - point.centre[second]) / point.view;
        this.out[0] = x - this.before[0] + 0.997 * this.out[0]; this.out[1] = y - this.before[1] + 0.997 * this.out[1];
        this.before[0] = x; this.before[1] = y;
        left[i] = shape(this.out[0]) * this.gain;
        right[i] = shape(this.out[1]) * this.gain;
      }
      return true;
    }
  }
  registerProcessor('voice', Voice);
}
if (typeof module !== 'undefined') module.exports = {compile, follower, shape, LEVEL};
