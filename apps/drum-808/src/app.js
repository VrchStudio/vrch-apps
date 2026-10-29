'use strict';
/* Drum 808 UI and controls. Sequencing and sound run in engine.js on the audio
 * thread; this side only keeps state, sends intent and draws once per frame. */
const $ = id => document.getElementById(id);
const TRACKS = 12, STEPS = 16, PATTERNS = 4, SR = 48000;
const VOICES = [
  ['BD', 'Bass Drum'], ['SD', 'Snare Drum'], ['LT', 'Low Tom'], ['MT', 'Mid Tom'], ['HT', 'High Tom'], ['RS', 'Rim Shot'],
  ['CL', 'Claves'], ['CP', 'Hand Clap'], ['CB', 'Cowbell'], ['CY', 'Cymbal'], ['OH', 'Open Hat'], ['CH', 'Closed Hat'],
];
const PARAMS = [
  {key: 'level', name: 'Level', min: 0, max: 100, step: 2},
  {key: 'tune', name: 'Tune', min: -12, max: 12, step: 1},
  {key: 'decay', name: 'Decay', min: 0, max: 100, step: 2},
];
const SWING = [['Off', 0], ['Light', 0.08], ['Medium', 0.16], ['Heavy', 0.25]];
const PATTERN_NAMES = 'ABCD';
// The App audio port forwards 20 ms blocks to the host, so sound leaves the
// device a little after the context renders it. Used only to align the display.
const HOST_LATENCY_MS = 30;
// Preset grooves, one row per voice: '.' off, 'x' on, 'X' accent. D starts empty.
const PRESETS = [
  {BD: 'X.....x...X.....', SD: '....X.......X...', CP: '....x.......x...', CH: 'x.x.x.x.x.x.x...', OH: '..............x.', CB: '...x.........x..'},
  {BD: 'X...x...X...x...', CP: '....X.......X...', OH: '..x...x...x...x.', CH: '.x...x...x...x..'},
  {BD: 'X......x.X......', SD: '........X.......', CP: '........x.......', CH: 'x.x.x.x.x.xxx.x.'},
  {},
];

const cellIndex = (pattern, track, step) => (pattern * TRACKS + track) * STEPS + step;
function presetCells() {
  const cells = new Uint8Array(PATTERNS * TRACKS * STEPS);
  PRESETS.forEach((preset, p) => VOICES.forEach(([id], t) => {
    const row = preset[id] || '';
    for (let s = 0; s < STEPS; s++) cells[cellIndex(p, t, s)] = row[s] === 'X' ? 2 : row[s] === 'x' ? 1 : 0;
  }));
  return cells;
}
const defaults = () => ({
  bpm: 120, swing: 0, sel: 0, param: 0, pattern: 0, mutes: 0, cells: presetCells(),
  voices: VOICES.map(() => ({level: 80, tune: 0, decay: 50})),
});
function restore(saved) {
  const s = defaults();
  if (!saved || typeof saved !== 'object') return s;
  const int = (value, min, max, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  s.bpm = int(saved.bpm, 40, 240, 120); s.swing = int(saved.swing, 0, SWING.length - 1, 0);
  s.sel = int(saved.sel, 0, TRACKS - 1, 0); s.param = int(saved.param, 0, PARAMS.length - 1, 0);
  s.pattern = int(saved.pattern, 0, PATTERNS - 1, 0); s.mutes = int(saved.mutes, 0, (1 << TRACKS) - 1, 0);
  if (typeof saved.cells === 'string' && saved.cells.length === s.cells.length) {
    for (let i = 0; i < s.cells.length; i++) s.cells[i] = int(saved.cells[i], 0, 2, 0);
  }
  if (Array.isArray(saved.voices)) saved.voices.slice(0, TRACKS).forEach((v, i) => {
    if (Array.isArray(v)) s.voices[i] = {level: int(v[0], 0, 100, 80), tune: int(v[1], -12, 12, 0), decay: int(v[2], 0, 100, 50)};
  });
  return s;
}
const snapshot = () => ({
  bpm: state.bpm, swing: state.swing, sel: state.sel, param: state.param, pattern: state.pattern, mutes: state.mutes,
  cells: state.cells.join(''), voices: state.voices.map(v => [v.level, v.tune, v.decay]),
});

let state = defaults(), ready = false, disposed = false;
const ui = {cursor: 0, queued: -1, playing: false, playhead: -1, hitAt: new Float64Array(TRACKS).fill(-1e9), lit: new Uint8Array(TRACKS)};
const held = new Set(), steps = [];
let dirty = true, monitorDirty = true, monitorBusy = false;
const invalidate = () => { dirty = true; monitorDirty = true; };

/* ---------- diagnostics (in memory; written to App data off the signal path) ---------- */
const diag = {handler: [], toFrame: [], hitRender: [], frames: [], bursts: [], eventKeys: {}, late: 0, lastFrame: 0, changed: false};
let burst = null, pendingPaint = [], diagTimer = 0;
const capped = (list, value) => { list.push(value); if (list.length > 4000) list.shift(); diag.changed = true; };
function percentiles(list) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b), at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const r = v => Math.round(v * 1000) / 1000;
  return {n: sorted.length, p50: r(at(0.5)), p95: r(at(0.95)), p99: r(at(0.99)), max: r(sorted.at(-1))};
}
function contextMode() { try { return VrchApp.context.mode; } catch (_) { return null; } }
function saveDiag() {
  if (!diag.changed || disposed) return;
  diag.changed = false;
  const value = {
    mode: contextMode(), eventKeys: diag.eventKeys, stepLateFramesMax: diag.late,
    outputLatency: engine?.ctx.outputLatency ?? null, baseLatency: engine?.ctx.baseLatency ?? null,
    handlerMs: percentiles(diag.handler), eventToFrameMs: percentiles(diag.toFrame),
    hitToRenderMs: percentiles(diag.hitRender), frameIntervalMs: percentiles(diag.frames), bursts: diag.bursts.slice(-20),
  };
  VrchApp.data.get('diag').then(old => VrchApp.data.set('diag', value, {expectedVersion: old.version})).catch(() => {});
}

/* ---------- audio engine ---------- */
let engine = null, opening = null, audioEpoch = 0, hitSeq = 0;
const hitsInFlight = new Map();
const post = message => engine?.node.port.postMessage(message);
function syncEngine() {
  post({type: 'cells', value: state.cells});
  post({type: 'tempo', value: state.bpm});
  post({type: 'swing', value: SWING[state.swing][1]});
  post({type: 'mutes', value: state.mutes});
  state.voices.forEach((v, track) => post({type: 'voice', track, ...v}));
  post({type: 'pattern', index: state.pattern, now: true});
}
function openAudio() {
  if (engine) return Promise.resolve(engine);
  if (opening) return opening;
  const epoch = ++audioEpoch;
  opening = (async () => {
    const ctx = new AudioContext({sampleRate: SR, latencyHint: 'interactive'});
    let output = null;
    try {
      void ctx.resume().catch(() => {});
      output = await VrchApp.audio.openOutput({channels: 1});
      if (epoch !== audioEpoch || disposed) throw Object.assign(new Error('stale'), {code: 'stale'});
      const destination = await output.createNode(ctx);
      await ctx.audioWorklet.addModule('engine.js');
      if (epoch !== audioEpoch || disposed) throw Object.assign(new Error('stale'), {code: 'stale'});
      const node = new AudioWorkletNode(ctx, 'drum808-engine', {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1]});
      node.port.onmessage = onEngine;
      node.onprocessorerror = () => { closeAudio(); status('Audio stopped. Press Start to retry.', true); };
      node.connect(destination);
      engine = {ctx, output, node};
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
  ui.playing = false; ui.playhead = -1; steps.length = 0;
  invalidate();
  if (!old) return;
  old.node.port.postMessage({type: 'stop'});
  old.node.disconnect();
  void Promise.allSettled([old.output.close(), old.ctx.state === 'closed' ? null : old.ctx.close()]);
}
function audioError(error) {
  if (error?.code === 'stale' || disposed) return;
  ui.playing = false; invalidate();
  const code = error?.code || error?.name;
  status(['capability_denied', 'io_not_authorized', 'permission_denied', 'NotAllowedError'].includes(code)
    ? 'Allow audio in Menu, then press Start.' : 'Audio unavailable. Press Start to retry.', true);
}
// Performance time at which a rendered frame is heard, for display only.
function audibleAt(frame) {
  const ctx = engine.ctx, ts = ctx.getOutputTimestamp();
  if (ts.performanceTime > 0) return ts.performanceTime + (frame / SR - ts.contextTime) * 1000 + HOST_LATENCY_MS;
  return performance.now() + (frame / SR - ctx.currentTime + (ctx.outputLatency || 0)) * 1000 + HOST_LATENCY_MS;
}
function onEngine({data: m}) {
  if (!engine) return;
  if (m.type === 'step') {
    m.due = audibleAt(m.frame);
    steps.push(m);
    // A throttled or hidden page must not let the display queue grow.
    if (steps.length > 64) steps.shift();
    diag.late = Math.max(diag.late, m.late);
  } else if (m.type === 'hit') {
    const sent = hitsInFlight.get(m.id);
    hitsInFlight.delete(m.id);
    if (sent) capped(diag.hitRender, (m.frame / SR - sent.ctxTime) * 1000);
  }
}

/* ---------- actions (all synchronous, in memory) ---------- */
let saveTimer = 0, saveChain = Promise.resolve();
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const value = snapshot();
    saveChain = saveChain.then(async () => {
      const old = await VrchApp.data.get('state');
      await VrchApp.data.set('state', value, {expectedVersion: old.version});
    }).catch(() => status('Settings could not be saved', true));
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
function moveCursor(step) { ui.cursor = wrap(step, STEPS); invalidate(); }
function cycleStep(step) {
  const i = cellIndex(state.pattern, state.sel, step), value = (state.cells[i] + 1) % 3;
  state.cells[i] = value; ui.cursor = step;
  post({type: 'cell', index: i, value}); invalidate(); persist();
}
function chooseParam(index) { state.param = wrap(index, PARAMS.length); invalidate(); persist(); }
function adjustParam(delta) {
  const p = PARAMS[state.param], v = state.voices[state.sel];
  const value = Math.max(p.min, Math.min(p.max, v[p.key] + delta * p.step));
  if (value === v[p.key]) return;
  v[p.key] = value; post({type: 'voice', track: state.sel, ...v}); invalidate(); persist();
}
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
  ui.playing = false; ui.playhead = -1; steps.length = 0;
  post({type: 'stop'});
  if (ui.queued >= 0) { state.pattern = ui.queued; ui.queued = -1; post({type: 'pattern', index: state.pattern, now: true}); persist(); }
  status('Stopped'); invalidate();
}
function togglePlay() {
  if (ui.playing) { stopPlayback(); return; }
  ui.playing = true; invalidate();
  const start = () => { if (!ui.playing) return; post({type: 'start'}); status('Playing'); };
  if (engine) { void engine.ctx.resume().catch(() => {}); start(); return; }
  status('Starting…');
  openAudio().then(start, audioError);
}
function hit() {
  const track = state.sel;
  ui.hitAt[track] = performance.now();
  const send = () => {
    const id = ++hitSeq;
    hitsInFlight.set(id, {ctxTime: engine.ctx.currentTime});
    if (hitsInFlight.size > 64) hitsInFlight.delete(hitsInFlight.keys().next().value);
    post({type: 'hit', track, id});
  };
  if (engine) send(); else openAudio().then(send, audioError);
}

/* ---------- controls ---------- */
VrchApp.controls.onEvent(event => {
  if (!ready) return;
  const t0 = performance.now();
  if (!diag.eventKeys[event.type]) { diag.eventKeys[event.type] = Object.keys(event).join(','); diag.changed = true; }
  const c = event.control;
  if (event.type === 'rotate') {
    const d = Math.trunc(Number(event.delta) || 0);
    if (!d) return;
    if (c === 'E1') setTempo(state.bpm + d);
    else if (c === 'E2') selectVoice(state.sel + d);
    else if (c === 'E3') moveCursor(ui.cursor + d);
    else if (c === 'E4') adjustParam(d);
    // Group rotation bursts (events < 60 ms apart) to measure burst-to-release.
    if (!burst) burst = {control: c, events: 0, delta: 0, startMs: t0, spanMs: 0};
    burst.events++; burst.delta += d; burst.spanMs = Math.round((t0 - burst.startMs) * 10) / 10; burst.releaseAt = t0;
  } else if (event.type === 'down') {
    if (held.has(c)) return;
    held.add(c);
    if (c === 'E1') cycleSwing();
    else if (c === 'E2') toggleMute();
    else if (c === 'E3') cycleStep(ui.cursor);
    else if (c === 'E4') chooseParam(state.param + 1);
    else if (c === 'K2') togglePlay();
    else if (c === 'K3') hit();
    else if (c === 'K4') nextPattern();
  } else if (event.type === 'up' || event.type === 'cancel') {
    held.delete(c);
    return;
  }
  capped(diag.handler, performance.now() - t0);
  pendingPaint.push(t0);
});

/* ---------- view ---------- */
const view = {patterns: [], voices: [], params: [], steps: [], playText: null};
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function press(el, action) {
  el.addEventListener('pointerdown', event => {
    if (!ready) return;
    event.preventDefault();
    if (engine && engine.ctx.state === 'suspended') void engine.ctx.resume().catch(() => {});
    action();
  });
}
function build() {
  for (let p = 0; p < PATTERNS; p++) {
    const b = document.createElement('button');
    b.textContent = PATTERN_NAMES[p]; b.setAttribute('aria-label', 'Pattern ' + PATTERN_NAMES[p]);
    press(b, () => choosePattern(p)); $('patterns').append(b); view.patterns.push(b);
  }
  VOICES.forEach(([id, name], t) => {
    const b = document.createElement('button');
    b.className = 'voice'; b.textContent = id; b.setAttribute('aria-label', name);
    press(b, () => selectVoice(t)); $('voices').append(b); view.voices.push(b);
  });
  PARAMS.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'param';
    b.innerHTML = `<span>${p.name}</span><strong></strong><i class="bar"></i>`;
    press(b, () => chooseParam(i)); $('params').append(b); view.params.push(b);
  });
  for (let s = 0; s < STEPS; s++) {
    const b = document.createElement('button');
    b.className = 'step g' + Math.floor(s / 4);
    b.innerHTML = `<i class="led"></i><span>${s + 1}</span>`;
    b.setAttribute('aria-label', 'Step ' + (s + 1));
    press(b, () => cycleStep(s)); $('steps').append(b); view.steps.push(b);
  }
  press($('swing'), cycleSwing);
  press($('play'), togglePlay);
  press($('hit'), hit);
  press($('next'), nextPattern);
}
const toggle = (el, name, on) => { if (el.classList.contains(name) !== on) el.classList.toggle(name, on); };
function render() {
  $('bpm').textContent = state.bpm;
  $('swing').querySelector('strong').textContent = SWING[state.swing][0];
  view.patterns.forEach((b, p) => { toggle(b, 'current', p === state.pattern); toggle(b, 'queued', p === ui.queued); });
  view.voices.forEach((b, t) => { toggle(b, 'selected', t === state.sel); toggle(b, 'muted', !!((state.mutes >> t) & 1)); });
  const v = state.voices[state.sel];
  $('voiceName').textContent = VOICES[state.sel][1];
  $('voiceState').textContent = (state.mutes >> state.sel) & 1 ? 'Muted' : 'Pattern ' + PATTERN_NAMES[state.pattern] + (ui.queued >= 0 ? ' → ' + PATTERN_NAMES[ui.queued] : '');
  PARAMS.forEach((p, i) => {
    const b = view.params[i], value = v[p.key];
    b.querySelector('strong').textContent = p.key === 'tune' && value > 0 ? '+' + value : value;
    b.querySelector('.bar').style.width = ((value - p.min) / (p.max - p.min) * 100).toFixed(1) + '%';
    toggle(b, 'active', i === state.param);
  });
  view.steps.forEach((b, s) => {
    const value = state.cells[cellIndex(state.pattern, state.sel, s)];
    toggle(b, 'on', value > 0); toggle(b, 'accent', value === 2); toggle(b, 'cursor', s === ui.cursor);
  });
  $('play').innerHTML = (ui.playing ? 'Stop' : 'Start') + ' <small>K2</small>';
  toggle($('play'), 'on', ui.playing);
}
function updateMonitor() {
  if (!monitorDirty || monitorBusy) return;
  monitorDirty = false; monitorBusy = true;
  const item = (label, value) => ({label, value: String(value)}), p = PARAMS[state.param], v = state.voices[state.sel][p.key];
  VrchApp.monitor.set({
    E1: item('BPM', state.bpm), E2: item('Voice', VOICES[state.sel][0]), E3: item('Step', ui.cursor + 1),
    E4: item(p.name, p.key === 'tune' && v > 0 ? '+' + v : v), K2: item(ui.playing ? 'Stop' : 'Start', ''),
    K3: item('Hit', ''), K4: item('Pattern', PATTERN_NAMES[ui.queued >= 0 ? ui.queued : state.pattern]),
  }).catch(() => {}).finally(() => { monitorBusy = false; });
}
function frame(now) {
  if (disposed) return;
  if (diag.lastFrame) capped(diag.frames, now - diag.lastFrame);
  diag.lastFrame = now;
  // Steps are shown when they are heard, not when they are rendered.
  while (steps.length && steps[0].due <= now) {
    const m = steps.shift();
    if (!ui.playing) continue;
    ui.playhead = m.step;
    for (let t = 0; t < TRACKS; t++) if ((m.mask >> t) & 1) ui.hitAt[t] = now;
    if (m.pattern !== state.pattern) {
      state.pattern = m.pattern;
      if (ui.queued === m.pattern) ui.queued = -1;
      invalidate(); persist();
    }
  }
  if (dirty) { dirty = false; render(); }
  view.steps.forEach((b, s) => toggle(b, 'play', s === ui.playhead));
  for (let t = 0; t < TRACKS; t++) {
    const lit = now - ui.hitAt[t] < 90 ? 1 : 0;
    if (lit !== ui.lit[t]) { ui.lit[t] = lit; toggle(view.voices[t], 'lit', !!lit); }
  }
  for (const t0 of pendingPaint) capped(diag.toFrame, now - t0);
  pendingPaint.length = 0;
  if (burst && now - burst.releaseAt > 60) {
    burst.releaseMs = Math.round((now - burst.releaseAt) * 10) / 10;
    delete burst.startMs; delete burst.releaseAt;
    diag.bursts.push(burst); if (diag.bursts.length > 50) diag.bursts.shift();
    burst = null; diag.changed = true;
  }
  updateMonitor();
  requestAnimationFrame(frame);
}
function layout() {
  let height = innerHeight, inset = 0;
  try { const c = VrchApp.context; height = c.viewport?.height || innerHeight; inset = c.safeInsets?.left || 0; } catch (_) {}
  document.documentElement.classList.toggle('tall', height >= 460);
  document.documentElement.style.setProperty('--inset-left', inset + 'px');
}

addEventListener('error', event => status('Error: ' + (event.message || 'unknown'), true));
addEventListener('resize', layout);
addEventListener('pagehide', () => { disposed = true; clearTimeout(saveTimer); clearInterval(diagTimer); closeAudio(); }, {once: true});
build(); layout(); render();
VrchApp.ready().then(async () => {
  try { const saved = await VrchApp.data.get('state'); state = restore(saved?.value); status('Stopped'); }
  catch (_) { status('Saved settings unavailable', true); }
  ready = true; layout(); invalidate();
  requestAnimationFrame(frame);
  diagTimer = setInterval(saveDiag, 3000);
  // Warm the engine up front so the first hit or Start has no setup delay.
  openAudio().catch(audioError);
}).catch(() => status('App could not start. Reopen it.', true));
