// Hit Shapes plays Drum 808's voices from its own copy of the engine. This runs both engines outside a browser and
// compares their output sample for sample: each voice alone at several Tune and Decay settings, accented and not, and
// a whole pattern with swing, a mute and the closed hat choking the open hat. It also checks what the picture relies
// on: every step is reported at its exact frame with the voices and accents that sounded.
//   node tests/hit_shapes_engine.cjs
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const SR = 48000, QUANTUM = 128;

function load(app) {
  const sandbox = {sampleRate: SR, currentFrame: 0, AudioWorkletProcessor: class { constructor() { this.port = {postMessage: m => this.posted.push(m)}; this.posted = []; } }, registered: null};
  sandbox.registerProcessor = (name, type) => { sandbox.registered = type; };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../apps', app, 'src/engine.js'), 'utf8'), sandbox);
  const engine = new sandbox.registered();
  return {
    engine, send: message => engine.port.onmessage({data: message}),
    render(seconds) {
      const out = new Float32Array(Math.ceil(seconds * SR / QUANTUM) * QUANTUM);
      for (let at = 0; at < out.length; at += QUANTUM) {
        const block = new Float32Array(QUANTUM);
        engine.process([], [[block]]);
        out.set(block, at);
        sandbox.currentFrame += QUANTUM;
      }
      return out;
    },
  };
}
// Hit Shapes voice -> the Drum 808 track with the same sound.
const VOICES = [['BD', 0], ['SD', 1], ['CH', 11], ['OH', 10], ['CP', 7], ['LT', 2], ['RS', 5], ['CB', 8]];
const same = (a, b, what) => {
  assert.equal(a.length, b.length);
  let peak = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) assert.fail(what + ': sample ' + i + ' differs (' + a[i] + ' vs ' + b[i] + ')'); peak = Math.max(peak, Math.abs(a[i])); }
  assert(peak > 0.01, what + ' is audible');
  return peak;
};

const result = {voices: {}, peak: 0};
for (const [index, [id, track]] of VOICES.entries()) {
  for (const [tune, decay] of [[0, 50], [7, 20], [-12, 100]]) {
    const mine = load('hit-shapes'), theirs = load('drum-808');
    mine.send({type: 'voice', track: index, tune, decay});
    theirs.send({type: 'voice', track, level: 80, tune, decay});
    mine.send({type: 'hit', track: index, id: 1}); theirs.send({type: 'hit', track, id: 1});
    result.voices[id] = same(mine.render(1.5), theirs.render(1.5), id + ' tune ' + tune + ' decay ' + decay);
  }
}

// A whole pattern: every voice, accents, the open hat choked by the closed hat, one voice muted, swing, 132 BPM.
const ROWS = {BD: 'X..x..x.X...x.x.', SD: '....X..x....X...', CH: 'x.xxx.xxX.xxx.xx', OH: '.x...x...X...x..', CP: '....x.......X...', LT: '......x......xX.', RS: '..x......x......', CB: 'X..x..x..x..x...'};
const mine = load('hit-shapes'), theirs = load('drum-808');
const cells = [new Uint8Array(4 * 8 * 16), new Uint8Array(4 * 12 * 16)];
VOICES.forEach(([id, track], index) => [...ROWS[id]].forEach((mark, step) => {
  const value = mark === 'X' ? 2 : mark === 'x' ? 1 : 0;
  cells[0][(8 + index) * 16 + step] = value; cells[1][(12 + track) * 16 + step] = value; // pattern B in both
}));
for (const [app, data, mute] of [[mine, cells[0], 1 << 6], [theirs, cells[1], 1 << 5]]) {
  app.send({type: 'cells', value: data}); app.send({type: 'tempo', value: 132}); app.send({type: 'swing', value: 0.16});
  app.send({type: 'mutes', value: mute}); app.send({type: 'pattern', index: 1, now: true}); app.send({type: 'start'});
}
result.peak = same(mine.render(4), theirs.render(4), 'the whole pattern');
assert(result.peak <= 0.5, 'the mix stays under the -6 dBFS ceiling: ' + result.peak);

// The step report drives the picture: same frames as Drum 808, with the voices that sounded and their accents.
const steps = mine.engine.posted.filter(m => m.type === 'step'), reference = theirs.engine.posted.filter(m => m.type === 'step');
assert(steps.length > 32);
assert.deepEqual(steps.map(m => [m.step, m.frame]), reference.map(m => [m.step, m.frame]), 'steps fire on the same frames');
assert.equal(steps[0].first, true); assert(steps.slice(1).every(m => m.first === false), 'only the first step after Start is marked');
for (const m of steps) {
  let mask = 0, accents = 0;
  VOICES.forEach(([id], index) => { const mark = ROWS[id][m.step]; if (mark !== '.' && index !== 6) { mask |= 1 << index; if (mark === 'X') accents |= 1 << index; } });
  assert.equal(m.mask, mask, 'step ' + m.step + ' names the voices that sounded'); assert.equal(m.accents, accents, 'step ' + m.step + ' names its accents');
}
result.steps = steps.length;
console.log(JSON.stringify({pass: true, ...result}));
