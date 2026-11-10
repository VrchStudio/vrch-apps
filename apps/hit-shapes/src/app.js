'use strict';
/* Settings, controls, sound and saving. engine.js keeps time and makes the sound on the audio thread;
 * stage.js draws the picture with the shapes in shapes.js. A second, picture-only copy of the App (role 'output')
 * runs on a big screen and follows this one through VrchApp.output. */
const $ = id => document.getElementById(id);
const TRACKS = SHAPES.length, STEPS = 16, PATTERNS = 4, SR = 48000;
const SWING = [['Off', 0], ['Light', 0.08], ['Medium', 0.16], ['Heavy', 0.25]];
const PATTERN_NAMES = 'ABCD';
// Sound is heard a while after the engine renders it: the App audio port forwards 20 ms blocks to the host, which
// queues them, and the audio device adds its own delay. The picture waits this long so a shape appears when its hit
// is heard. Measured in the Playground on desktop Chrome: 65-94 ms in all, about 40 ms of it the audio device's own.
const LATENCY_MS = 75;
const HOLD_MS = 500; // K4 held this long changes the style instead of the pattern; E1 held this long changes the colours instead of the swing
// Preset patterns, one row per voice: '.' off, 'x' on, 'X' accent. D starts empty.
const PRESETS = [
  {BD: 'X...x...x...x...', CP: '....X.......X...', OH: '..x...x...x...x.', CH: 'xx.xxx.xxx.xxx.x'},
  {BD: 'X.....x...X..x..', SD: '....X.......X...', CH: 'x.x.x.x.x.x.x.x.', CB: '...x.....x......', RS: '.......x.......x'},
  {BD: 'X.........x.....', SD: '........X.......', LT: '......x......xX.', CB: 'x..x..x..x..x...', OH: '....x.........x.', RS: '..x..x....x.....'},
  {},
];

const cellIndex = (pattern, track, step) => (pattern * TRACKS + track) * STEPS + step;
function presetCells() {
  const cells = new Uint8Array(PATTERNS * TRACKS * STEPS);
  PRESETS.forEach((preset, p) => SHAPES.forEach(({id}, t) => {
    const row = preset[id] || '';
    for (let s = 0; s < STEPS; s++) cells[cellIndex(p, t, s)] = row[s] === 'X' ? 2 : row[s] === 'x' ? 1 : 0;
  }));
  return cells;
}
const defaults = () => ({
  bpm: 120, swing: 0, sel: 0, pattern: 0, mutes: 0, theme: 0, style: 1, alt: 0, cells: presetCells(),
  tune: SHAPES.map(() => 0), decay: SHAPES.map(() => 50),
});
const whole = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
function restore(saved) {
  const s = defaults();
  if (!saved || typeof saved !== 'object') return s;
  s.bpm = whole(saved.bpm, 40, 240, 120); s.swing = whole(saved.swing, 0, SWING.length - 1, 0);
  s.sel = whole(saved.sel, 0, TRACKS - 1, 0); s.pattern = whole(saved.pattern, 0, PATTERNS - 1, 0);
  s.mutes = whole(saved.mutes, 0, (1 << TRACKS) - 1, 0); s.theme = whole(saved.theme, 0, PALETTES.length - 1, 0);
  s.style = whole(saved.style, 0, STYLES.length - 1, s.style); s.alt = whole(saved.alt, 0, (1 << TRACKS) - 1, 0);
  if (typeof saved.cells === 'string' && saved.cells.length === s.cells.length) {
    for (let i = 0; i < s.cells.length; i++) s.cells[i] = whole(saved.cells[i], 0, 2, 0);
  }
  if (Array.isArray(saved.tune)) s.tune = s.tune.map((_, i) => whole(saved.tune[i], -12, 12, 0));
  if (Array.isArray(saved.decay)) s.decay = s.decay.map((_, i) => whole(saved.decay[i], 0, 100, 50));
  return s;
}
const snapshot = () => ({
  bpm: state.bpm, swing: state.swing, sel: state.sel, pattern: state.pattern, mutes: state.mutes, theme: state.theme, style: state.style, alt: state.alt,
  cells: state.cells.join(''), tune: [...state.tune], decay: [...state.decay],
});

// Output role: a picture-only copy on a big or second screen. It makes no sound, reads no controls, saves nothing
// and shows no text; it draws what the controlling copy sends.
const isOutput = (() => { try { return VrchApp.context?.role === 'output'; } catch (_) { return false; } })();
const relay = VrchApp.output || null;
document.documentElement.dataset.role = isOutput ? 'output' : 'control';
const stage = createStage($('picture'), {maxPixels: isOutput ? 1920 * 1080 : Infinity});

let state = defaults(), ready = false, disposed = false;
// playing: Start was pressed. running: the engine has begun the bar, so the picture follows the hits.
const ui = {playing: false, running: false, rec: false, queued: -1, lit: new Uint8Array(TRACKS), playhead: -1};
const held = new Set();
let dirty = true, monitorDirty = true, monitorBusy = false, publishDirty = true;

// What the picture is drawn from. The big screen receives the same values.
function picture() {
  const from = cellIndex(state.pattern, 0, 0);
  return {
    cells: state.cells.subarray(from, from + TRACKS * STEPS), bpm: state.bpm, swing: SWING[state.swing][1], mutes: state.mutes,
    tune: state.tune, decay: state.decay, theme: state.theme, style: state.style, alt: state.alt, sel: state.sel, playing: ui.running,
  };
}
const wallClock = () => stage.origin + Date.now() - performance.now();
function send(event) {
  if (isOutput || !relay) return;
  try { relay.send({...event, clock: wallClock()}); } catch (_) {}
}
function publish() {
  publishDirty = false;
  if (isOutput || !relay) return;
  const p = picture();
  try { relay.publish({...p, t: 'state', cells: Array.from(p.cells).join(''), pattern: state.pattern, clock: wallClock()}); } catch (_) {}
}
function invalidate() {
  dirty = true; monitorDirty = true; publishDirty = true;
  stage.set(picture());
}

/* ---------- audio engine ---------- */
let engine = null, opening = null, audioEpoch = 0, hitSeq = 0;
const clock = [];
const post = message => engine?.node.port.postMessage(message);
function syncEngine() {
  post({type: 'cells', value: state.cells}); post({type: 'record', on: ui.rec});
  post({type: 'tempo', value: state.bpm});
  post({type: 'swing', value: SWING[state.swing][1]});
  post({type: 'mutes', value: state.mutes});
  SHAPES.forEach((_, track) => post({type: 'voice', track, tune: state.tune[track], decay: state.decay[track]}));
  post({type: 'pattern', index: state.pattern, now: true});
}
function openAudio() {
  if (engine) return Promise.resolve(engine);
  if (opening) return opening;
  const epoch = ++audioEpoch;
  opening = (async () => {
    const ctx = new AudioContext({sampleRate: SR, latencyHint: 'interactive', sinkId: {type: 'none'}});
    let output = null;
    try {
      void ctx.resume().catch(() => {});
      output = await VrchApp.audio.openOutput({channels: 1});
      if (epoch !== audioEpoch || disposed) throw Object.assign(new Error('stale'), {code: 'stale'});
      const destination = await output.createNode(ctx);
      await ctx.audioWorklet.addModule('engine.js');
      if (epoch !== audioEpoch || disposed) throw Object.assign(new Error('stale'), {code: 'stale'});
      const node = new AudioWorkletNode(ctx, 'engine', {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1]});
      node.port.onmessage = onEngine;
      node.onprocessorerror = () => { closeAudio(); status('Audio stopped. Press Start to retry.'); };
      node.connect(destination);
      engine = {ctx, output, node};
      clock.length = 0; stage.reset();
      syncEngine();
      return engine;
    } catch (error) {
      await Promise.allSettled([output?.close(), ctx.close()]);
      throw error;
    } finally {
      opening = null;
    }
  })();
  return opening;
}
function closeAudio() {
  const old = engine;
  engine = null; ++audioEpoch;
  ui.playing = false; ui.running = false;
  invalidate();
  if (!old) return;
  old.node.port.postMessage({type: 'stop'});
  old.node.disconnect();
  void Promise.allSettled([old.output.close(), old.ctx.state === 'closed' ? null : old.ctx.close()]);
}
function audioError(error) {
  if (error?.code === 'stale' || disposed) return;
  ui.playing = false; ui.running = false; invalidate();
  const code = error?.code || error?.name;
  status(['capability_denied', 'io_not_authorized', 'permission_denied'].includes(code)
    ? 'Allow audio in Menu, then press Start.' : 'Audio unavailable. Press Start to retry.');
}
// Where the audio clock sits on the screen's clock. The engine's own clock is read in jumps, always a little behind,
// so the earliest of the recent readings is the true one; the hits themselves keep their exact audio time.
function readClock() {
  if (!engine || engine.ctx.state !== 'running') return;
  clock.push(performance.now() - engine.ctx.currentTime * 1000);
  if (clock.length > 120) clock.shift();
  const target = Math.min(...clock) + LATENCY_MS, gap = target - stage.origin;
  stage.origin = Math.abs(gap) > 20 ? target : stage.origin + Math.max(-0.25, Math.min(0.25, gap));
}
function onEngine({data: m}) {
  if (!engine) return;
  readClock();
  const time = m.frame / SR * 1000;
  if (m.type === 'step') {
    if (!ui.playing) return;
    if (m.first) { ui.running = true; stage.set({playing: true}); publish(); }
    // The bar count goes along, so a big screen that joins mid-song is at the same place in the picture's long turns.
    send({t: 'step', step: m.step, mask: m.mask, accents: m.accents, time, first: m.first, bar: stage.step({...m, time})});
    if (m.pattern !== state.pattern) {
      state.pattern = m.pattern;
      if (ui.queued === m.pattern) ui.queued = -1;
      invalidate(); persist();
    }
  } else if (m.type === 'hit') {
    // With Record on, while the pattern plays, the engine writes a hit by hand, or a roll's, into the step nearest
    // to it. Each press of K3 is one take, remembered so that it can be taken back.
    if (m.cell >= 0 && !state.cells[m.cell]) {
      state.cells[m.cell] = 1;
      if (!take) { take = []; takes.push(take); }
      take.push(m.cell);
      invalidate(); persist();
    }
    send({t: 'hit', voice: m.track, time, ...stage.strike({voice: m.track, time})});
  }
}

/* ---------- share link: v3.<pattern, swing, colours, style><tempo><the pattern's steps><each voice's tune and decay><shapes> ---------- */
// 65 URL-safe characters. Each voice's 16 steps (off, on, accent) pack into 5 of them, its tune and decay into 2, and
// which voices show their other shape into the last 2. v1 and v2 links, from before there were styles and second
// shapes, still open. A link the App cannot read is ignored and the App opens as saved.
const SHARE_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const SHARE_STATE = new RegExp('^v([123])\\.([A-Za-z0-9_-]+)$');
let shareTimer = 0, sharedState = '';
function shareState() {
  const digits = (n, count) => { let out = ''; for (let k = 0; k < count; k++) { out += SHARE_DIGITS[n % 64]; n = Math.floor(n / 64); } return out; };
  let text = 'v3.' + digits(state.pattern + 4 * state.swing + 16 * state.theme + 48 * state.style, 2) + digits(state.bpm - 40, 2);
  for (let t = 0; t < TRACKS; t++) {
    let n = 0;
    for (let s = STEPS - 1; s >= 0; s--) n = n * 3 + state.cells[cellIndex(state.pattern, t, s)];
    text += digits(n, 5);
  }
  for (let t = 0; t < TRACKS; t++) text += digits(state.tune[t] + 12 + 25 * Math.round(state.decay[t] / 2), 2);
  return text + digits(state.alt, 2);
}
function applyShare(share) {
  const match = typeof share?.state === 'string' ? SHARE_STATE.exec(share.state) : null;
  const version = Number(match?.[1]) || 1, wide = version >= 2 ? 2 : 1, body = match?.[2] || '';
  if (body.length !== wide + 2 + TRACKS * 7 + (version >= 3 ? 2 : 0)) return false;
  let at = 0;
  const number = count => { let n = 0; for (let k = count - 1; k >= 0; k--) n = n * 64 + SHARE_DIGITS.indexOf(body[at + k]); at += count; return n; };
  const head = number(wide), bpm = number(2) + 40, rows = [], voices = [];
  if (head >= 4 * SWING.length * PALETTES.length * STYLES.length || bpm > 240) return false;
  for (let t = 0; t < TRACKS; t++) {
    let n = number(5);
    if (n >= 3 ** STEPS) return false;
    const row = [];
    for (let s = 0; s < STEPS; s++) { row.push(n % 3); n = Math.floor(n / 3); }
    rows.push(row);
  }
  for (let t = 0; t < TRACKS; t++) {
    const n = number(2);
    if (n >= 25 * 51) return false;
    voices.push([n % 25 - 12, Math.floor(n / 25) * 2]);
  }
  const alt = version >= 3 ? number(2) : 0; // links from before there were second shapes open with the first ones
  if (alt >= 1 << TRACKS) return false;
  state.alt = alt;
  state.pattern = head % 4; state.swing = Math.floor(head / 4) % 4; state.theme = Math.floor(head / 16) % 3; state.bpm = bpm;
  if (version >= 2) state.style = Math.floor(head / 48);
  rows.forEach((row, t) => row.forEach((value, s) => { state.cells[cellIndex(state.pattern, t, s)] = value; }));
  voices.forEach(([tune, decay], t) => { state.tune[t] = tune; state.decay[t] = decay; });
  return true;
}
function shareSoon() {
  if (!VrchApp.share) return;
  clearTimeout(shareTimer);
  shareTimer = setTimeout(() => {
    const value = shareState();
    if (value === sharedState) return;
    sharedState = value;
    try { VrchApp.share.report({state: value}); } catch (_) {}
  }, 400);
}

/* ---------- actions (all synchronous, in memory) ---------- */
let saveTimer = 0, saveChain = Promise.resolve();
function persist() {
  shareSoon();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const value = snapshot();
    saveChain = saveChain.then(async () => {
      const old = await VrchApp.data.get('state');
      await VrchApp.data.set('state', value, {expectedVersion: old.version});
    }).catch(() => status('Settings could not be saved'));
  }, 300);
}
const wrap = (value, size) => ((value % size) + size) % size;
function setTempo(bpm) {
  const value = Math.max(40, Math.min(240, Math.round(bpm)));
  if (value === state.bpm) return;
  state.bpm = value; post({type: 'tempo', value}); invalidate(); persist();
}
function cycleSwing() { state.swing = wrap(state.swing + 1, SWING.length); post({type: 'swing', value: SWING[state.swing][1]}); invalidate(); persist(); }
function selectVoice(track) { state.sel = wrap(track, TRACKS); invalidate(); persist(); }
function toggleMute() { state.mutes ^= 1 << state.sel; post({type: 'mutes', value: state.mutes}); invalidate(); persist(); }
function setVoice(key, value) {
  if (value === state[key][state.sel]) return;
  state[key][state.sel] = value;
  post({type: 'voice', track: state.sel, tune: state.tune[state.sel], decay: state.decay[state.sel]});
  invalidate(); persist();
}
const setTune = value => setVoice('tune', Math.max(-12, Math.min(12, value)));
const setDecay = value => setVoice('decay', Math.max(0, Math.min(100, value)));
function cycleStep(step) {
  const i = cellIndex(state.pattern, state.sel, step), value = (state.cells[i] + 1) % 3;
  state.cells[i] = value;
  post({type: 'cell', index: i, value}); invalidate(); persist();
}
function nextTheme() { state.theme = wrap(state.theme + 1, PALETTES.length); invalidate(); persist(); }
function nextStyle() { state.style = wrap(state.style + 1, STYLES.length); invalidate(); persist(); }
function choosePattern(index) {
  if (ui.playing && engine) {
    ui.queued = index === state.pattern ? -1 : index;
    post({type: 'pattern', index, now: false});
  } else {
    ui.queued = -1;
    if (index !== state.pattern) { state.pattern = index; post({type: 'pattern', index, now: true}); persist(); }
  }
  invalidate();
}
const nextPattern = () => choosePattern(((ui.queued >= 0 ? ui.queued : state.pattern) + 1) % PATTERNS);
function stopPlayback() {
  ui.playing = false; ui.running = false;
  post({type: 'stop'});
  if (ui.queued >= 0) { state.pattern = ui.queued; ui.queued = -1; post({type: 'pattern', index: state.pattern, now: true}); persist(); }
  status(''); invalidate(); publish();
}
function togglePlay() {
  if (ui.playing) { stopPlayback(); return; }
  ui.playing = true; invalidate();
  const start = () => { if (!ui.playing) return; post({type: 'start'}); status(''); };
  if (engine) { void engine.ctx.resume().catch(() => {}); start(); return; }
  openAudio().then(start, audioError);
}
// Play the selected voice once, playing or stopped. The picture draws it when the engine reports it.
function hit() {
  const track = state.sel, strike = () => { post({type: 'hit', track, id: ++hitSeq}); if (rolling) post({type: 'roll', track, on: true}); };
  if (engine) { void engine.ctx.resume().catch(() => {}); strike(); } else openAudio().then(strike, audioError);
}
// K3 or a finger held down rolls the voice: after the first hit, one more on every step until it is let go.
let rolling = false;
// Record starts off every time the App opens: K3 only plays. takes: the steps each press of K3 wrote, newest last.
const takes = [];
let take = null;
function hold() {
  take = null;
  if (ui.rec) { take = []; takes.push(take); if (takes.length > 32) takes.shift(); }
  rolling = true; hit();
}
function setRecord(on) { ui.rec = on; post({type: 'record', on}); invalidate(); }
// Take back the last press of K3 that wrote something: its steps are cleared, unless they were made accents since.
function undo() {
  let last = takes.pop();
  while (last && !last.length) last = takes.pop();
  if (!last) return;
  if (last === take) take = null;
  for (const index of last) if (state.cells[index] === 1) { state.cells[index] = 0; post({type: 'cell', index, value: 0}); }
  invalidate(); persist();
}
function release() { if (!rolling) return; rolling = false; post({type: 'roll', on: false}); }
function nextShape() { state.alt ^= 1 << state.sel; invalidate(); persist(); }

/* ---------- controls ---------- */
let holdTimer = 0, heldLong = false, themeTimer = 0, themeLong = false, shapeTimer = 0, shapeLong = false, recTimer = 0, recLong = false, undoTimer = 0;
if (!isOutput) VrchApp.controls.onEvent(event => {
  if (!ready) return;
  const c = event.control;
  if (event.type === 'rotate') {
    const d = Math.trunc(Number(event.delta) || 0);
    if (!d) return;
    if (c === 'E1') setTempo(state.bpm + d);
    else if (c === 'E2') selectVoice(state.sel + d);
    else if (c === 'E3') setTune(state.tune[state.sel] + d);
    else if (c === 'E4') setDecay(state.decay[state.sel] + d * 2);
  } else if (event.type === 'down') {
    if (held.has(c)) return;
    held.add(c);
    if (c === 'E1') {
      // A press changes the swing when the knob comes up; a hold changes the colours instead. Neither makes a sound.
      themeLong = false;
      clearTimeout(themeTimer);
      themeTimer = setTimeout(() => { themeLong = true; nextTheme(); }, HOLD_MS);
    } else if (c === 'E2') {
      // A press mutes at once. Held, it takes back the last recording instead, and the mute is put back as it was.
      toggleMute();
      clearTimeout(undoTimer);
      undoTimer = setTimeout(() => { toggleMute(); undo(); }, HOLD_MS);
    } else if (c === 'E3') {
      // A press resets the tune when the knob comes up; a hold switches Record on or off instead.
      recLong = false;
      clearTimeout(recTimer);
      recTimer = setTimeout(() => { recLong = true; setRecord(!ui.rec); }, HOLD_MS);
    }
    else if (c === 'E4') {
      // A press resets the decay when the knob comes up; a hold gives the voice its other shape instead.
      shapeLong = false;
      clearTimeout(shapeTimer);
      shapeTimer = setTimeout(() => { shapeLong = true; nextShape(); }, HOLD_MS);
    }
    else if (c === 'K2') togglePlay();
    else if (c === 'K3') hold();
    else if (c === 'K4') {
      // A press changes the pattern when the key comes up; a hold changes the style instead.
      heldLong = false;
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => { heldLong = true; nextStyle(); }, HOLD_MS);
    }
  } else if (event.type === 'up' || event.type === 'cancel') {
    if (!held.delete(c)) return;
    if (c === 'E1') { clearTimeout(themeTimer); if (event.type === 'up' && !themeLong) cycleSwing(); }
    if (c === 'E2') clearTimeout(undoTimer);
    if (c === 'E3') { clearTimeout(recTimer); if (event.type === 'up' && !recLong) setTune(0); }
    if (c === 'E4') { clearTimeout(shapeTimer); if (event.type === 'up' && !shapeLong) setDecay(50); }
    if (c === 'K3') release();
    if (c !== 'K4') return;
    clearTimeout(holdTimer);
    if (event.type === 'up' && !heldLong) nextPattern();
  }
});

/* ---------- device screen ---------- */
const view = {voices: [], glyphs: [], steps: [], theme: -1, style: -1, alt: -1};
// The style button's sign for each style: a bar of lanes, a dial, a cloth of cells.
const STYLE_SIGNS = ['M2 4h12M2 8h12M2 12h12', 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M8 8h.01', 'M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z'];
function status(text) { $('status').textContent = text; }
function press(el, action) {
  el.addEventListener('pointerdown', event => {
    if (!ready) return;
    event.preventDefault();
    if (engine && engine.ctx.state === 'suspended') void engine.ctx.resume().catch(() => {});
    action();
  });
}
function build() {
  SHAPES.forEach(({id, name}, t) => {
    const b = document.createElement('button'), glyph = document.createElement('canvas'), label = document.createElement('span');
    b.className = 'voice'; b.setAttribute('aria-label', name); label.textContent = id;
    b.append(glyph, label);
    press(b, () => { if (t === state.sel) nextShape(); else selectVoice(t); }); // the selected voice again: its other shape
    $('voices').append(b); view.voices.push(b); view.glyphs.push(glyph);
  });
  for (let s = 0; s < STEPS; s++) {
    const b = document.createElement('button');
    b.className = 'step'; b.setAttribute('aria-label', 'Step ' + (s + 1));
    press(b, () => cycleStep(s)); $('steps').append(b); view.steps.push(b);
  }
  press($('picture'), hold);
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) $('picture').addEventListener(type, release);
  addEventListener('blur', release);
  press($('styleChip'), nextStyle);
  press($('recChip'), () => setRecord(!ui.rec));
  press($('undoChip'), undo);
  press($('colorChip'), nextTheme);
}
const toggle = (el, name, on) => { if (el.classList.contains(name) !== on) el.classList.toggle(name, on); };
function render() {
  const palette = PALETTES[state.theme], root = document.documentElement.style;
  if (view.theme !== state.theme || view.alt !== state.alt) {
    view.theme = state.theme; view.alt = state.alt;
    root.setProperty('--rec', palette.colors[0]); root.setProperty('--bg', palette.bg); root.setProperty('--ink', palette.ink); root.setProperty('--grid', palette.grid);
    [...$('colorChip').children].forEach((swatch, i) => { swatch.style.background = palette.colors[i]; });
    view.glyphs.forEach((glyph, t) => {
      glyph.width = Math.round(glyph.clientWidth * devicePixelRatio) || 64; glyph.height = Math.round(glyph.clientHeight * devicePixelRatio) || 40;
      stage.glyph(glyph, t, !!((state.alt >> t) & 1));
    });
  }
  if (view.style !== state.style) {
    view.style = state.style;
    $('styleChip').innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="' + STYLE_SIGNS[state.style] + '"/></svg>';
    $('styleChip').setAttribute('aria-label', 'Style: ' + STYLES[state.style]);
  }
  toggle($('recChip'), 'on', ui.rec); $('recChip').setAttribute('aria-pressed', String(ui.rec));
  $('undoChip').hidden = !takes.some(steps => steps.length);
  view.voices.forEach((b, t) => { toggle(b, 'selected', t === state.sel); toggle(b, 'muted', !!((state.mutes >> t) & 1)); });
  const color = stage.color(SHAPES[state.sel].color);
  view.steps.forEach((b, s) => {
    const value = state.cells[cellIndex(state.pattern, state.sel, s)];
    b.style.background = value ? color : '';
    toggle(b, 'on', value > 0); toggle(b, 'accent', value === 2);
  });
}
function updateMonitor() {
  if (!monitorDirty || monitorBusy) return;
  monitorDirty = false; monitorBusy = true;
  const item = (label, value) => ({label, value: String(value)}), id = SHAPES[state.sel].id, tune = state.tune[state.sel];
  const pattern = PATTERN_NAMES[state.pattern] + (ui.queued >= 0 ? ' > ' + PATTERN_NAMES[ui.queued] : '');
  VrchApp.monitor.set({
    E1: item('BPM', state.bpm + (state.swing ? ' · ' + SWING[state.swing][0] + ' swing' : '')),
    E2: item('Voice', id + ((state.mutes >> state.sel) & 1 ? ' · Muted' : '')),
    E3: item('Tune', tune > 0 ? '+' + tune : tune), E4: item('Decay', state.decay[state.sel]),
    K2: item(ui.playing ? 'Stop' : 'Start', ''), K3: item(ui.rec ? 'Rec' : 'Hit', id), K4: item(STYLES[state.style], pattern),
  }).catch(() => {}).finally(() => { monitorBusy = false; });
}
function layout() {
  let inset = 0;
  try { inset = VrchApp.context.safeInsets?.left || 0; } catch (_) {}
  const root = document.documentElement.style, box = $('stage');
  // The picture fills the screen; its steps, and the pads under them, keep clear of the edge that takes no touch.
  stage.resize(box.clientWidth, box.clientHeight, Math.min(2, devicePixelRatio || 1), isOutput ? 0 : inset);
  // The step pads sit under the picture's 16 steps.
  const columns = stage.columns();
  root.setProperty('--pad', columns.pad + 'px');
  view.theme = -1; dirty = true;
}
let drawnFor = -1;
function frame(now) {
  if (disposed) return;
  requestAnimationFrame(frame);
  // Some hosts run the frame callbacks twice for one screen refresh: one picture per refresh is enough.
  if (now === drawnFor) return;
  drawnFor = now;
  readClock();
  stage.render(now);
  if (!isOutput) {
    if (publishDirty) publish();
    if (dirty) { dirty = false; render(); }
    const playhead = ui.running ? stage.playStep : -1;
    if (playhead !== ui.playhead) { ui.playhead = playhead; view.steps.forEach((b, s) => toggle(b, 'play', s === playhead)); }
    for (let t = 0; t < TRACKS; t++) {
      const lit = stage.heard[t] < 90 ? 1 : 0;
      if (lit !== ui.lit[t]) { ui.lit[t] = lit; toggle(view.voices[t], 'lit', !!lit); }
    }
    updateMonitor();
  }
}

/* ---------- the big screen ---------- */
function follow({data: m} = {}) {
  if (!m || typeof m !== 'object') return;
  if (Number.isFinite(m.clock)) stage.origin = m.clock - (Date.now() - performance.now());
  if (m.t === 'step') stage.step(m);
  else if (m.t === 'hit') stage.strike(m);
  else if (m.t === 'state' && typeof m.cells === 'string' && m.cells.length === TRACKS * STEPS) {
    const from = cellIndex(0, 0, 0);
    state.pattern = 0; state.bpm = whole(m.bpm, 40, 240, 120); state.mutes = whole(m.mutes, 0, (1 << TRACKS) - 1, 0);
    state.theme = whole(m.theme, 0, PALETTES.length - 1, 0); state.sel = whole(m.sel, 0, TRACKS - 1, 0);
    state.style = whole(m.style, 0, STYLES.length - 1, 0); state.alt = whole(m.alt, 0, (1 << TRACKS) - 1, 0);
    state.swing = Math.max(0, SWING.findIndex(([, amount]) => amount === m.swing));
    for (let i = 0; i < m.cells.length; i++) state.cells[from + i] = whole(m.cells[i], 0, 2, 0);
    if (Array.isArray(m.tune)) state.tune = state.tune.map((_, i) => whole(m.tune[i], -12, 12, 0));
    if (Array.isArray(m.decay)) state.decay = state.decay.map((_, i) => whole(m.decay[i], 0, 100, 50));
    ui.playing = ui.running = m.playing === true;
    shown.pattern = whole(m.pattern, 0, PATTERNS - 1, 0);
    stage.set(picture());
  }
}

/* ---------- for tests ---------- */
const shown = {pattern: 0};
window.__hitShapes = {
  role: isOutput ? 'output' : 'control',
  get firstFrameAt() { return stage.firstFrameAt; },
  get frames() { return stage.frames; },
  state: () => ({
    pattern: isOutput ? shown.pattern : state.pattern, bpm: state.bpm, swing: state.swing, voice: SHAPES[state.sel].id,
    playing: ui.playing, theme: state.theme, style: STYLES[state.style], record: ui.rec, takes: takes.filter(steps => steps.length).length,
    voices: SHAPES.map(({id}, t) => ({
      id, tune: state.tune[t], decay: state.decay[t], mute: !!((state.mutes >> t) & 1), other: !!((state.alt >> t) & 1),
      steps: Array.from({length: STEPS}, (_, s) => '.xX'[state.cells[cellIndex(isOutput ? 0 : state.pattern, t, s)]]).join(''),
    })),
  }),
  hits: () => stage.hits(),
};

addEventListener('error', event => status('Error: ' + (event.message || 'unknown')));
addEventListener('resize', layout);
addEventListener('pagehide', () => { disposed = true; clearTimeout(saveTimer); clearTimeout(holdTimer); clearTimeout(themeTimer); clearTimeout(shapeTimer); clearTimeout(recTimer); clearTimeout(undoTimer); closeAudio(); }, {once: true});
// The App's name is written once, in app.json.
fetch('app.json').then(response => response.json()).then(manifest => { document.title = manifest.name; }).catch(() => {});
if (!isOutput) build();
layout(); stage.set(picture()); stage.render(performance.now());
if (isOutput) {
  relay?.onMessage(follow);
  VrchApp.ready().then(() => { layout(); requestAnimationFrame(frame); }).catch(() => {});
} else {
  // Reading the saved settings does not wait for the App to be shown, so the picture rarely opens on the default.
  const saved = VrchApp.data.get('state').catch(() => null);
  VrchApp.ready().then(async () => {
    try { state = restore(((await saved) || await VrchApp.data.get('state'))?.value); }
    catch (_) { status('Saved settings unavailable'); }
    // A share link opens as a still picture of its rhythm; sound waits for K2.
    applyShare(VrchApp.context?.share);
    shareSoon();
    ready = true; layout(); invalidate();
    requestAnimationFrame(frame);
    // Warm the engine up so the first hit or Start has no setup delay. Before the visitor acts a browser may refuse
    // sound; that is not an error: Start opens it again and reports a real failure.
    openAudio().catch(() => {});
  }).catch(() => status('App could not start. Reopen it.'));
}
