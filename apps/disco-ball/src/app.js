'use strict';
/* Disco Ball UI and controls. Sparkle timing and sound run in engine.js on the
 * audio thread; this side keeps state, sends intent, and draws the ball once
 * per animation frame, flashing each tile when its note is heard. */
const $ = id => document.getElementById(id);
const SR = 48000, TILES = 32;
const RATES = ['1/4', '1/8', '1/16'];
const SCALES = [
  ['Major', [0, 2, 4, 7, 9]],
  ['Minor', [0, 3, 5, 7, 10]],
  ['Whole-tone', [0, 2, 4, 6, 8, 10]],
  ['Blues', [0, 3, 5, 6, 7, 10]],
];
const PALETTES = ['Silver', 'Rainbow', 'Sunset', 'Ocean', 'Disco', 'Neon'];
const NEON = [315, 180, 95, 28, 265]; // magenta, cyan, lime, orange, violet
const TIMBRES = ['Bell', 'Pluck', 'Glass', 'Funk', 'Strings', 'Guzheng'];
// The App audio port forwards 20 ms blocks to the host, so sound leaves the
// device a little after the context renders it. Used only to align the display.
const HOST_LATENCY_MS = 30;

const GROOVES = ['Disco', 'Techno', 'Euro', 'Off'];
const defaults = () => ({bpm: 118, rate: 1, density: 2, scale: 0, palette: 1, energy: 50, drive: 30, timbre: 0, groove: 0, acid: 0});
function restore(saved) {
  const s = defaults();
  if (!saved || typeof saved !== 'object') return s;
  const int = (value, min, max, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  s.bpm = int(saved.bpm, 40, 240, 118); s.rate = int(saved.rate, 0, RATES.length - 1, 1);
  s.density = int(saved.density, 1, 6, 2); s.scale = int(saved.scale, 0, SCALES.length - 1, 0);
  s.palette = int(saved.palette, 0, PALETTES.length - 1, 1); s.energy = int(saved.energy, 0, 100, 50);
  s.drive = int(saved.drive, 0, 100, 30); s.timbre = int(saved.timbre, 0, TIMBRES.length - 1, 0);
  // Older saves stored a beat on/off flag; map it onto the groove styles.
  s.groove = int(saved.groove, 0, GROOVES.length - 1, int(saved.beat, 0, 1, 1) ? 0 : 2);
  s.acid = int(saved.acid, 0, 1, 0);
  return s;
}

// Output role: a picture-only instance (Playground's output, a second screen) mirrors the controlling instance through
// VrchApp.output with the same messages as the laptop link: state (published), sparks, beats and gongs (events).
// It plays no sound, opens no link, reads no controls, saves nothing and shows only the ball.
const isOutput = (() => { try { return VrchApp.context?.role === 'output'; } catch (_) { return false; } })();
const relay = VrchApp.output || null;
document.documentElement.dataset.role = isOutput ? 'output' : 'control';
let state = defaults(), ready = false, disposed = false;
const ui = {playing: false, glowAt: -1e9, glowHue: 275, gongAt: -1e9, k3At: 0};
const sparkleHue = tile => { litHue[tile] = state.palette === 5 ? NEON[(Math.random() * NEON.length) | 0] : Math.random() * 360; };
const held = new Set(), sparks = [];
let dirty = true, monitorDirty = true, monitorBusy = false;
const invalidate = () => { dirty = true; monitorDirty = true; if (!isLaptop) pushState(); };

/* ---------- ball geometry ---------- */
// A truncated icosahedron, the soccer-ball pattern of the real mirror ball:
// 12 pentagons around the icosahedron's vertices plus 20 hexagons on its
// faces. Everything is precomputed once; each frame only rotates and
// projects the points. Faces 0-11 are the pentagons.
const normals = new Float32Array(TILES * 3);
const freqs = new Float32Array(TILES);
const hue = new Float32Array(TILES);       // longitude, for the Rainbow palette
const litAt = new Float64Array(TILES).fill(-1e9);
const litHue = new Float32Array(TILES); // per-flash hue for the Disco and Neon palettes
const depth = new Float32Array(TILES);
const order = new Uint16Array(TILES);
const PT0 = new Uint16Array(TILES);        // each tile's first point (its centre)
const SIDES = new Uint8Array(TILES);
let base = null, proj = null;              // point positions and their projections
function buildBall() {
  const G = (1 + Math.sqrt(5)) / 2;
  const norm = v => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const V = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) V.push(norm([0, a, b * G]), norm([a, b * G, 0]), norm([b * G, 0, a]));
  const near = i => V.map((_, j) => j).filter(j => j !== i && dot(V[i], V[j]) > 0.3);
  const cut = (i, j) => norm([(2 * V[i][0] + V[j][0]) / 3, (2 * V[i][1] + V[j][1]) / 3, (2 * V[i][2] + V[j][2]) / 3]);
  const faces = [];
  for (let i = 0; i < 12; i++) faces.push(near(i).map(j => cut(i, j)));
  for (let i = 0; i < 12; i++) for (const j of near(i)) if (j > i) for (const k of near(j)) {
    if (k > j && near(i).includes(k)) faces.push([cut(i, j), cut(j, i), cut(j, k), cut(k, j), cut(k, i), cut(i, k)]);
  }
  const pts = [];
  faces.forEach((corners, i) => {
    const c = norm(corners.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]));
    const u = norm([-c[2], 0, c[0]]);
    const w = [c[1] * u[2] - c[2] * u[1], c[2] * u[0] - c[0] * u[2], c[0] * u[1] - c[1] * u[0]];
    const angle = p => {
      const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      return Math.atan2(dot(d, w), dot(d, u));
    };
    corners.sort((p, q) => angle(p) - angle(q));
    normals[i * 3] = c[0]; normals[i * 3 + 1] = c[1]; normals[i * 3 + 2] = c[2];
    hue[i] = (Math.atan2(c[2], c[0]) * 180 / Math.PI + 360) % 360;
    SIDES[i] = corners.length;
    PT0[i] = pts.length / 3;
    pts.push(c[0], c[1], c[2]);
    for (const p of corners) {
      // Pull each corner toward the centre for the grout line between facets.
      const q = norm([c[0] + 0.94 * (p[0] - c[0]), c[1] + 0.94 * (p[1] - c[1]), c[2] + 0.94 * (p[2] - c[2])]);
      pts.push(q[0], q[1], q[2]);
    }
  });
  base = Float32Array.from(pts);
  proj = new Float32Array(pts.length / 3 * 2);
}
function buildFreqs() {
  const steps = SCALES[state.scale][1], span = steps.length * 3; // three octaves
  for (let i = 0; i < TILES; i++) {
    const t = (normals[i * 3 + 1] + 1) / 2; // -1..1 -> 0..1, top of the ball is high
    const d = Math.min(span - 1, Math.floor(t * span));
    freqs[i] = 220 * Math.pow(2, Math.floor(d / steps.length) + steps[d % steps.length] / 12);
  }
  post({type: 'freqs', value: Float32Array.from(freqs)});
}

/* ---------- audio engine ---------- */
let engine = null, opening = null, audioEpoch = 0;
const post = message => engine?.node.port.postMessage(message);
function syncEngine() {
  post({type: 'freqs', value: Float32Array.from(freqs)});
  post({type: 'tempo', value: state.bpm});
  post({type: 'rate', value: state.rate});
  post({type: 'density', value: state.density});
  post({type: 'energy', value: state.energy / 100});
  post({type: 'drive', value: state.drive / 100});
  post({type: 'timbre', value: state.timbre});
  post({type: 'beat', value: state.groove !== 3});
  post({type: 'style', value: Math.min(state.groove, 2)});
  post({type: 'acid', value: !!state.acid});
  sendVisible(true);
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
      const node = new AudioWorkletNode(ctx, 'discoball-engine', {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1]});
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
  ui.playing = false; sparks.length = 0;
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
  m.due = audibleAt(m.frame);
  sparks.push(m);
  if (sparks.length > 128) sparks.shift();
}

/* ---------- actions (all synchronous, in memory) ---------- */
let saveTimer = 0, saveChain = Promise.resolve();
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const value = {...state};
    saveChain = saveChain.then(async () => {
      const old = await VrchApp.data.get('state');
      await VrchApp.data.set('state', value, {expectedVersion: old.version});
    }).catch(() => status('Settings could not be saved', true));
  }, 300);
}
const wrap = (value, size) => ((value % size) + size) % size;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function setTempo(bpm) {
  const value = clamp(Math.round(bpm), 40, 240);
  if (value === state.bpm) return;
  state.bpm = value; post({type: 'tempo', value}); invalidate(); persist();
}
function cycleRate() { state.rate = wrap(state.rate + 1, RATES.length); post({type: 'rate', value: state.rate}); status('Sparkle rate ' + RATES[state.rate]); invalidate(); persist(); }
function setDensity(d) {
  const value = clamp(d, 1, 6);
  if (value === state.density) return;
  state.density = value; post({type: 'density', value}); invalidate(); persist();
}
function cycleScale() { state.scale = wrap(state.scale + 1, SCALES.length); buildFreqs(); invalidate(); persist(); }
function setEnergy(e) {
  const value = clamp(e, 0, 100);
  if (value === state.energy) return;
  state.energy = value; post({type: 'energy', value: value / 100}); invalidate(); persist();
}
function cyclePalette() { state.palette = wrap(state.palette + 1, PALETTES.length); status(PALETTES[state.palette] + ' colors'); invalidate(); persist(); }
function setDrive(v) {
  const value = clamp(v, 0, 100);
  if (value === state.drive) return;
  state.drive = value; post({type: 'drive', value: value / 100}); invalidate(); persist();
}
function cycleTimbre() { state.timbre = wrap(state.timbre + 1, TIMBRES.length); post({type: 'timbre', value: state.timbre}); invalidate(); persist(); }
function cycleGroove() {
  state.groove = wrap(state.groove + 1, GROOVES.length);
  post({type: 'style', value: Math.min(state.groove, 2)});
  post({type: 'beat', value: state.groove !== 3});
  status(state.groove === 3 ? 'Groove off' : GROOVES[state.groove] + ' groove');
  invalidate(); persist();
}
function stopPlayback() {
  ui.playing = false; sparks.length = 0;
  post({type: 'stop'});
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
function toggleAcid() {
  state.acid = state.acid ? 0 : 1;
  post({type: 'acid', value: !!state.acid});
  status(state.acid ? 'Acid bass on' : 'Acid bass off');
  invalidate(); persist();
}
function burst() {
  const send = () => post({type: 'burst'});
  if (engine) send(); else openAudio().then(() => { sendVisible(true); send(); }, audioError);
}
function tapTile(tile) {
  const send = () => post({type: 'tap', tile});
  if (engine) send(); else openAudio().then(send, audioError);
}

/* ---------- device ↔ laptop sync ---------- */
/* On the device this broadcasts state and tile flashes on App data channel 1,
 * fire-and-forget off the signal path. On a laptop it mirrors them over the
 * same channel (ws://device:8001/json?channel=1): remote state and sparks
 * drive the ball, sound stays on the device, and local input is ignored
 * while the link is live. */
const isLaptop = (() => { try { return VrchApp.context.mode === 'laptop'; } catch (_) { return false; } })();
let sock = null, connecting = false, linked = false, lastRemote = 0, syncTimer = 0, statePush = 0;
function sendSync(obj) {
  if (!isOutput && !isLaptop && relay) { try { if (obj.t === 'state') relay.publish({...obj, at: Date.now()}); else relay.send(obj); } catch (_) {} }
  if (!sock) return;
  if (isLaptop) { if (sock.readyState === 1) { try { sock.send(JSON.stringify(obj)); } catch (_) {} } }
  else void sock.send(obj).catch(() => { sock = null; });
}
function pushState() {
  clearTimeout(statePush);
  statePush = setTimeout(() => sendSync({t: 'state', ...state, playing: ui.playing, angle}), 80);
}
function applyRemote(m) {
  const now = performance.now();
  if (m.t === 'spark' && Array.isArray(m.tiles)) {
    m.tiles.forEach((tile, k) => {
      if (!Number.isInteger(tile) || tile < 0 || tile >= TILES) return;
      litAt[tile] = now;
      if (Number.isFinite(m.hues?.[k])) litHue[tile] = m.hues[k]; else sparkleHue(tile);
    });
  } else if (m.t === 'beat') {
    ui.glowAt = now; ui.glowHue = (ui.glowHue + 47) % 360;
  } else if (m.t === 'gong') {
    ui.gongAt = now;
  } else if (m.t === 'state') {
    const scaleBefore = state.scale;
    state = restore(m);
    if (state.scale !== scaleBefore) buildFreqs();
    if (typeof m.angle === 'number' && Number.isFinite(m.angle)) {
      // An output shares the controller's clock: it carries the angle forward to now and follows it closely.
      const ahead = isOutput && Number.isFinite(m.at) ? m.angle + (0.08 + state.energy / 100 * 0.55) * clamp((Date.now() - m.at) / 1000, 0, 5) : m.angle;
      if (Math.abs(ahead - angle) > (isOutput ? 0.05 : 0.25)) angle = ahead;
    }
    ui.playing = !!m.playing;
    status(m.playing ? 'Linked · Playing' : 'Linked · Stopped');
    invalidate();
  }
}
function onRemote(m) {
  if (!isLaptop || !m || typeof m !== 'object') return;
  lastRemote = performance.now();
  if (!linked) { linked = true; stopPlayback(); invalidate(); }
  applyRemote(m);
}
async function connectSync() {
  if (sock || connecting) return;
  connecting = true;
  try {
    if (isLaptop) {
      const w = new WebSocket(window.VRCH_SYNC_URL || 'ws://localhost:8001/json?channel=1');
      w.onmessage = ({data}) => { let m; try { m = JSON.parse(data); } catch (_) { return; } onRemote(m); };
      w.onclose = () => { if (sock === w) sock = null; };
      w.onerror = () => {};
      sock = w;
    } else {
      const s = await VrchApp.websocket.open({channel: 1, format: 'json'});
      s.onMessage(onRemote);
      s.onError(() => { if (sock === s) sock = null; });
      sock = s;
      pushState();
    }
  } catch (error) {
    sock = null;
    if (!isLaptop) status('Link: ' + (error?.message || error?.code || 'failed'), true);
  } finally {
    connecting = false;
  }
}

/* ---------- controls ---------- */
VrchApp.controls.onEvent(event => {
  if (!ready) return;
  if (isOutput || (isLaptop && linked)) return;
  const c = event.control;
  if (event.type === 'rotate') {
    const d = Math.trunc(Number(event.delta) || 0);
    if (!d) return;
    if (c === 'E1') setTempo(state.bpm + d);
    else if (c === 'E2') setDensity(state.density + d);
    else if (c === 'E3') setEnergy(state.energy + d * 2);
    else if (c === 'E4') setDrive(state.drive + d * 2);
  } else if (event.type === 'down') {
    if (held.has(c)) return;
    held.add(c);
    if (c === 'E1') cycleRate();
    else if (c === 'E2') cycleScale();
    else if (c === 'E3') cyclePalette();
    else if (c === 'E4') cycleTimbre();
    else if (c === 'K2') togglePlay();
    else if (c === 'K3') ui.k3At = performance.now();
    else if (c === 'K4') cycleGroove();
  } else if (event.type === 'up' || event.type === 'cancel') {
    held.delete(c);
    if (c === 'K3' && event.type === 'up') {
      // Short press bursts; a hold toggles the acid bass layer.
      if (performance.now() - (ui.k3At || 0) < 450) burst(); else toggleAcid();
    }
  }
});

/* ---------- view ---------- */
const canvas = $('ball'), ctx2d = canvas.getContext('2d');
let W = 0, H = 0, CX = 0, CY = 0, R = 0, angle = 0, lastNow = 0, shimmerNow = 0, gongBoost = 0;
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function press(el, action) {
  el.addEventListener('pointerdown', event => {
    if (!ready || isOutput) return;
    if (isLaptop && linked) return;
    event.preventDefault();
    if (engine && engine.ctx.state === 'suspended') void engine.ctx.resume().catch(() => {});
    action();
  });
}
function layout() {
  let inset = 0;
  try { inset = VrchApp.context.safeInsets?.left || 0; } catch (_) {}
  document.documentElement.style.setProperty('--inset-left', inset + 'px');
  // The output can be a full 1080p or 4K screen: its canvas stays within 1920x1080 pixels.
  const stage = $('stage'), area = Math.max(1, stage.clientWidth * stage.clientHeight);
  const dpr = Math.min(2, devicePixelRatio || 1, isOutput ? Math.sqrt(1920 * 1080 / area) : Infinity);
  W = Math.max(1, Math.round(stage.clientWidth * dpr));
  H = Math.max(1, Math.round(stage.clientHeight * dpr));
  canvas.width = W; canvas.height = H;
  CX = W / 2; CY = H * 0.46; R = Math.min(W, H) * 0.405;
  dirty = true;
}

// Rotate + project every point. Returns nothing; fills proj/depth.
function transform() {
  const tilt = 0.33, cy = Math.cos(angle), sy = Math.sin(angle), cx = Math.cos(tilt), sx = Math.sin(tilt);
  const n = base.length / 3;
  for (let k = 0; k < n; k++) {
    const x = base[k * 3], y = base[k * 3 + 1], z = base[k * 3 + 2];
    const rx = x * cy + z * sy, rz = -x * sy + z * cy;
    const ry = y * cx - rz * sx;
    proj[k * 2] = CX + rx * R;
    proj[k * 2 + 1] = CY - ry * R;
  }
  for (let i = 0; i < TILES; i++) {
    const b = PT0[i] * 3;
    const rz = -base[b] * sy + base[b + 2] * cy;
    depth[i] = base[b + 1] * sx + rz * cx;
  }
}

let visTimer = 0;
function sendVisible(force) {
  if (!engine && !force) return;
  const list = [];
  for (let i = 0; i < TILES; i++) if (depth[i] > 0.1) list.push(i);
  post({type: 'visible', value: Uint16Array.from(list)});
}

function tileColor(i, flash, nz) {
  // Base: brushed mirror facet shaded by its normal; pentagons a shade deeper.
  const lightness = (30 + 46 * Math.max(0, nz) + 18 * Math.max(0, (nz - 0.82) / 0.18)) * (SIDES[i] === 5 ? 0.78 : 1);
  // An iridescent sheen drifts across the idle mirror facets.
  let h = 248 + 42 * Math.sin(shimmerNow * 0.0005 + nz * 2.6 + hue[i] * 0.03), s = 22, l = lightness;
  if (gongBoost > 0.02) {
    // A golden wash while the gong rings.
    h += (45 - h) * 0.45 * gongBoost; s += (62 - s) * 0.5 * gongBoost; l = Math.min(94, l + 24 * gongBoost);
  }
  if (flash > 0.01) {
    const p = state.palette;
    let fh = 0, fs = 0;
    if (p === 1) { fh = (hue[i] + 360) % 360; fs = 95; }
    else if (p === 2) { fh = 18 + 30 * ((normals[i * 3 + 1] + 1) / 2); fs = 100; }
    else if (p === 3) { fh = 190 + 40 * ((normals[i * 3 + 1] + 1) / 2); fs = 100; }
    else if (p === 4) { fh = litHue[i]; fs = 96; }
    else if (p === 5) { fh = litHue[i]; fs = 100; }
    h = p === 0 ? h : fh; s = p === 0 ? s : fs;
    s = s + (0 - s) * (1 - flash) * 0.2;
    l = l + (92 - l) * flash;
  }
  return `hsl(${h.toFixed(0)},${s.toFixed(0)}%,${l.toFixed(1)}%)`;
}

function render(now) {
  ctx2d.clearRect(0, 0, W, H);
  // A soft pulse of light behind the ball on each kick.
  shimmerNow = now;
  gongBoost = Math.exp(-(now - ui.gongAt) / 600);
  // Techno hits harder and snaps faster, visually too.
  const techno = state.groove === 1;
  const pulse = Math.exp(-(now - ui.glowAt) / (techno ? 110 : 180)) * (techno ? 1.4 : 1);
  if (pulse > 0.02) {
    const g = ctx2d.createRadialGradient(CX, CY, R * 0.2, CX, CY, R * 1.65);
    g.addColorStop(0, `hsla(${ui.glowHue.toFixed(0)},85%,64%,${Math.min(0.6, 0.36 * pulse).toFixed(3)})`);
    g.addColorStop(1, `hsla(${ui.glowHue.toFixed(0)},85%,64%,0)`);
    ctx2d.fillStyle = g;
    ctx2d.fillRect(0, 0, W, H);
  }
  // Hanging wire and ambient halo.
  ctx2d.strokeStyle = 'rgba(200,200,230,0.35)';
  ctx2d.lineWidth = Math.max(1, R * 0.012);
  ctx2d.beginPath(); ctx2d.moveTo(CX, 0); ctx2d.lineTo(CX, CY - R * 0.98); ctx2d.stroke();
  const halo = ctx2d.createRadialGradient(CX, CY, R * 0.9, CX, CY, R * 1.25);
  halo.addColorStop(0, 'rgba(180,170,255,0.10)');
  halo.addColorStop(1, 'rgba(180,170,255,0)');
  ctx2d.fillStyle = halo;
  ctx2d.beginPath(); ctx2d.arc(CX, CY, R * 1.25, 0, 7); ctx2d.fill();
  ctx2d.fillStyle = '#05050a';
  ctx2d.beginPath(); ctx2d.arc(CX, CY, R * 1.004, 0, 7); ctx2d.fill();

  // Facets, back to front so foreshortened rim tiles sit underneath.
  let count = 0;
  for (let i = 0; i < TILES; i++) if (depth[i] > 0.02) order[count++] = i;
  const sorted = order.subarray(0, count);
  sorted.sort((a, b) => depth[a] - depth[b]);
  ctx2d.lineWidth = Math.max(1, R * 0.009);
  ctx2d.strokeStyle = 'rgba(8,8,14,0.85)';
  const tail = state.groove === 1 ? 140 : 240; // techno flashes strobe-short
  for (let s = 0; s < count; s++) {
    const i = sorted[s], p0 = PT0[i] * 2, sides = SIDES[i];
    const flash = Math.exp(-(now - litAt[i]) / tail);
    ctx2d.fillStyle = tileColor(i, flash > 0.01 ? flash : 0, depth[i]);
    ctx2d.beginPath();
    ctx2d.moveTo(proj[p0 + 2], proj[p0 + 3]);
    for (let k = 2; k <= sides; k++) ctx2d.lineTo(proj[p0 + k * 2], proj[p0 + k * 2 + 1]);
    ctx2d.closePath();
    ctx2d.fill(); ctx2d.stroke();
    if (flash > 0.25) {
      // A short glint ray through freshly lit facets.
      ctx2d.save();
      ctx2d.globalAlpha = (flash - 0.25) * 0.5;
      const g = ctx2d.createRadialGradient(proj[p0], proj[p0 + 1], 0, proj[p0], proj[p0 + 1], R * 0.42);
      g.addColorStop(0, '#ffffff'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx2d.fillStyle = g;
      ctx2d.beginPath(); ctx2d.arc(proj[p0], proj[p0 + 1], R * 0.42, 0, 7); ctx2d.fill();
      ctx2d.restore();
    }
  }
}

function renderHud() {
  $('chipScale').querySelector('strong').textContent = SCALES[state.scale][0];
  $('chipVoice').querySelector('strong').textContent = TIMBRES[state.timbre];
  $('chipBeat').querySelector('strong').textContent = GROOVES[state.groove];
  $('chipBeat').classList.toggle('off', state.groove === 3);
  $('chipPlay').querySelector('strong').textContent = ui.playing ? 'Stop' : 'Start';
  $('chipPlay').classList.toggle('on', ui.playing);
}
function updateMonitor() {
  if (!monitorDirty || monitorBusy) return;
  monitorDirty = false; monitorBusy = true;
  const item = (label, value) => ({label, value: String(value)});
  VrchApp.monitor.set({
    E1: item('BPM', state.bpm), E2: item('Density', state.density),
    E3: item('Energy', state.energy),
    E4: item('Drive', state.drive), K2: item(ui.playing ? 'Stop' : 'Start', ''),
    K3: item('Burst', state.acid ? 'Acid' : ''), K4: item('Groove', GROOVES[state.groove]),
  }).catch(() => {}).finally(() => { monitorBusy = false; });
}

function frame(now) {
  if (disposed) return;
  const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
  lastNow = now;
  if (isLaptop && linked && now - lastRemote > 5000) { linked = false; status('Standalone — press Space'); invalidate(); }
  angle += (0.08 + state.energy / 100 * 0.55) * dt; // the ball spins faster with the energy knob
  transform();
  // Flashes land when their notes are heard, not when they are rendered.
  while (sparks.length && sparks[0].due <= now) {
    const m = sparks.shift();
    if (m.type === 'beat') { ui.glowAt = now; ui.glowHue = (ui.glowHue + 47) % 360; if (!isLaptop) sendSync({t: 'beat'}); continue; }
    if (m.type === 'gong') { ui.gongAt = now; if (!isLaptop) sendSync({t: 'gong'}); continue; }
    for (const tile of m.tiles) { litAt[tile] = now; sparkleHue(tile); }
    if (!isLaptop) sendSync({
      t: 'spark', tiles: m.tiles, hues: m.tiles.map(t => Math.round(litHue[t])),
      ys: m.tiles.map(t => normals[t * 3 + 1]),
      phis: m.tiles.map(t => (Math.atan2(normals[t * 3 + 2], normals[t * 3]) + 2 * Math.PI) % (2 * Math.PI)),
    });
  }
  render(now);
  if (dirty) { dirty = false; if (!isOutput) renderHud(); }
  if (!isOutput) updateMonitor();
  requestAnimationFrame(frame);
}

/* ---------- touch ---------- */
canvas.addEventListener('pointerdown', event => {
  if (!ready || isOutput) return;
  if (isLaptop && linked) return;
  event.preventDefault();
  if (engine && engine.ctx.state === 'suspended') void engine.ctx.resume().catch(() => {});
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (W / rect.width);
  const y = (event.clientY - rect.top) * (H / rect.height);
  let bestTile = -1, bestDist = Math.pow(R * 0.22, 2);
  for (let i = 0; i < TILES; i++) {
    if (depth[i] <= 0.05) continue;
    const dx = proj[PT0[i] * 2] - x, dy = proj[PT0[i] * 2 + 1] - y, d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; bestTile = i; }
  }
  if (bestTile >= 0) tapTile(bestTile); else burst();
});

addEventListener('error', event => status('Error: ' + (event.message || 'unknown'), true));
addEventListener('resize', layout);
addEventListener('pagehide', () => {
  disposed = true; clearTimeout(saveTimer); clearInterval(visTimer); clearInterval(syncTimer); clearTimeout(statePush);
  try { sock?.close(); } catch (_) {}
  closeAudio();
}, {once: true});
buildBall();
press($('chipScale'), cycleScale);
press($('chipVoice'), cycleTimbre);
press($('chipBeat'), cycleGroove);
press($('chipPlay'), togglePlay);
layout();
if (isOutput) VrchApp.ready().then(() => {
  ready = true; layout();
  relay?.onMessage(({data} = {}) => { if (data && typeof data === 'object') applyRemote(data); });
  requestAnimationFrame(frame);
}).catch(() => {});
else VrchApp.ready().then(async () => {
  try { const saved = await VrchApp.data.get('state'); state = restore(saved?.value); status('Stopped'); }
  catch (_) { status('Saved settings unavailable', true); }
  buildFreqs();
  ready = true; layout(); invalidate();
  requestAnimationFrame(frame);
  // The engine only lights what the person can see right now.
  visTimer = setInterval(() => sendVisible(false), 150);
  // Keep the laptop link alive: reconnect, and heartbeat the full state.
  connectSync();
  syncTimer = setInterval(() => { connectSync(); if (!isLaptop) sendSync({t: 'state', ...state, playing: ui.playing, angle}); }, 2000);
  // Warm the engine up front so the first tap or Start has no setup delay.
  openAudio().catch(audioError);
}).catch(() => status('App could not start. Reopen it.', true));
