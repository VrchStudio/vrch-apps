// The sound of every formula, without a browser: voice.js follows each preset for two seconds at 48 kHz.
// The samples must be numbers, stay under the level limit, not be silent, and differ left from right. It also checks
// that voice.js reads a formula's expressions the way the picture's shader does, against De Jong written out by hand.
// Prints, per formula, the level and how often the left channel crosses zero (a rough "how high does it sound").
const assert = require('node:assert/strict'), path = require('node:path');
const SRC = path.resolve(__dirname, '../apps/attractor/src');
global.window = {};
require(path.join(SRC, 'formulas.js'));
const {compile, follower, shape, LEVEL} = require(path.join(SRC, 'voice.js'));
const FORMULAS = window.Formulas, SR = 48000;

const dejong = compile(FORMULAS[0]), out = [0, 0, 0];
for (const [x, y, k] of [[0.3, -0.7, [1.49, -2.28, 2.36, -2.13]], [-1.2, 0.4, [-2, -2, -1.2, 2]]]) {
  dejong([x, y, 0], k, out);
  assert(Math.abs(out[0] - (Math.sin(k[0] * y) - Math.cos(k[1] * x))) < 1e-12 && Math.abs(out[1] - (Math.sin(k[2] * x) - Math.cos(k[3] * y))) < 1e-12, 'De Jong is read as written');
}
const report = {};
for (const formula of FORMULAS) {
  const rows = [];
  for (const preset of formula.presets) {
    const point = follower(formula), second = point.flow ? 2 : 1, before = [0, 0], held = [0, 0];
    point.letters(preset);
    let peak = 0, square = 0, apart = 0, crossings = 0, last = 0;
    for (let i = 0; i < 2 * SR; i++) {
      point.step(1 / SR);
      const x = (point.now[0] - point.centre[0]) / point.view, y = (point.now[second] - point.centre[second]) / point.view;
      held[0] = x - before[0] + 0.997 * held[0]; held[1] = y - before[1] + 0.997 * held[1]; before[0] = x; before[1] = y;
      const l = shape(held[0]), r = shape(held[1]);
      assert(Number.isFinite(l) && Number.isFinite(r), formula.id + ' ' + preset + ' gives numbers');
      if (i < SR / 2) continue;   // let the point reach the figure first
      peak = Math.max(peak, Math.abs(l), Math.abs(r)); square += l * l + r * r; apart += Math.abs(l - r);
      if (last < 0 && l >= 0) crossings++;
      last = l;
    }
    const rms = Math.sqrt(square / (3 * SR));
    assert(peak <= LEVEL + 1e-9, formula.id + ' ' + preset + ' stays under the level: ' + peak);
    assert(rms > 0.003 && apart / (1.5 * SR) > 0.001, formula.id + ' ' + preset + ' sounds, and left differs from right: ' + JSON.stringify({rms, apart: apart / (1.5 * SR)}));
    rows.push({rms: Math.round(rms * 1000) / 1000, peak: Math.round(peak * 1000) / 1000, crossingsPerSecond: Math.round(crossings / 1.5)});
  }
  report[formula.id] = {rms: [Math.min(...rows.map(r => r.rms)), Math.max(...rows.map(r => r.rms))], peak: Math.max(...rows.map(r => r.peak)), crossingsPerSecond: [Math.min(...rows.map(r => r.crossingsPerSecond)), Math.max(...rows.map(r => r.crossingsPerSecond))]};
}
console.log(JSON.stringify(report, null, 1));
console.log('PASS every formula and preset can be heard: bounded, never silent, left and right differ.');
