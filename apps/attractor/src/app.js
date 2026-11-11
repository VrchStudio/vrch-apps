// app.js: the App around the picture. Knobs and keys, the text on the device screen, saved settings, the share link
// and the large output live here. The formulas are in formulas.js; how they are drawn is in picture.js.
(() => {
  'use strict';
  const sdk = window.VrchApp, FORMULAS = window.Formulas, Picture = window.Picture;
  let context = {};
  try { context = sdk.context; } catch (_) { /* defaults */ }
  // Output role: a picture-only instance (a large or second screen). It reads no controls, saves nothing and shows no
  // text. The controlling instance tells it the formula and letters, and it gathers the same points itself.
  const isOutput = context.role === 'output', relay = sdk.output || null;
  document.documentElement.dataset.role = isOutput ? 'output' : 'control';
  if (context.name) document.title = context.name;
  const $ = id => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const epoch = () => performance.timeOrigin + performance.now();

  // Five stops from one side of the figure to the other; the densest parts turn white whatever the stop.
  const PALETTES = [
    {name: 'Ember', stops: [0.02, 0.16, 0.95, 0.22, 0.52, 1, 1, 1, 1, 1, 0.64, 0.2, 1, 0.17, 0.03]},
    {name: 'Neon', stops: [0, 0.5, 0.72, 0.15, 0.88, 0.95, 1, 1, 1, 1, 0.42, 0.85, 0.88, 0.04, 0.55]},
    {name: 'Silver', stops: [0.86, 0.78, 0.68, 0.95, 0.88, 0.78, 1, 0.95, 0.88, 0.95, 0.88, 0.78, 0.86, 0.78, 0.68]},
    {name: 'Iris', stops: [0.4, 0.1, 0.95, 0.66, 0.48, 1, 1, 1, 1, 1, 0.84, 0.38, 0.95, 0.58, 0.04]},
  ];
  const GLIDE_MS = 1500;                  // a preset change slides the letters this long
  const HOLD_MS = 500;                    // K3 held this long: drift
  const DRIFT = 7;                        // each letter sways this far (hundredths) either way,
  const DRIFT_SECONDS = [23, 31, 41, 53]; // each at its own pace

  /* ---------- settings ---------- */
  // Letters are whole hundredths (149 is 1.49), so a hundred small turns add up exactly.
  // glide: the letters are sliding from "from" (since "at") to p. drift: when the sway began, or 0.
  // Times are on the wall clock, so the output moves with the device.
  const hundredths = list => list.map(v => Math.round(v * 100));
  const motion = {formula: 0, p: hundredths(FORMULAS[0].presets[0]), glide: null, drift: 0};
  let palette = 0, textShown = true, preset = 0;
  const coarse = [false, false, false, false];
  const limits = () => FORMULAS[motion.formula].range.map(v => Math.round(v * 100));
  // The letters at a moment, before the sway is added.
  function settled(at) {
    const g = motion.glide;
    if (!g) return motion.p;
    const u = clamp((at - g.at) / GLIDE_MS, 0, 1), ease = u * u * (3 - 2 * u);
    return motion.p.map((v, i) => g.from[i] + (v - g.from[i]) * ease);
  }
  function lettersAt(at) {
    const [lo, hi] = limits(), list = settled(at);
    if (!motion.drift) return list;
    const seconds = (at - motion.drift) / 1000;
    return list.map((v, i) => clamp(v + DRIFT * Math.sin(2 * Math.PI * seconds / DRIFT_SECONDS[i]), lo, hi));
  }
  const inMotion = at => !!motion.drift || (!!motion.glide && at < motion.glide.at + GLIDE_MS);
  const presetNow = () => FORMULAS[motion.formula].presets.findIndex(set => hundredths(set).every((v, i) => v === motion.p[i]));
  const valid = (list, lo, hi) => Array.isArray(list) && list.length === 4 && list.every(v => Number.isFinite(v) && v >= lo && v <= hi);

  /* ---------- the picture ---------- */
  // told: an output draws nothing until the device has said which figure to draw.
  let picture = null, firstFrameAt = null, twoMillionAt = null, lastNow = -1, told = !isOutput;
  const log = [];   // [time, points added] of recent frames
  function build() {
    try { picture = Picture.create($('picture'), FORMULAS); } catch (error) { picture = null; console.error(error); }
    $('notice').hidden = !!picture;
    if (picture) picture.colours(PALETTES[palette].stops);
    layout();
  }
  function layout() {
    let inset = 0;
    try { inset = sdk.context.safeInsets?.left || 0; } catch (_) { /* default */ }
    document.documentElement.style.setProperty('--inset-left', inset + 'px');
    const box = $('stage');
    if (picture) picture.resize(box.clientWidth, box.clientHeight, devicePixelRatio || 1);
  }
  function step(now) {
    const at = epoch();
    if (motion.glide && at >= motion.glide.at + GLIDE_MS) motion.glide = null;
    const letters = lettersAt(at).map(v => v / 100);
    let added = 0;
    if (picture && told) {
      try { picture.set(motion.formula, letters, inMotion(at)); picture.frame(now); added = picture.added; }
      catch (error) { console.error(error); picture = null; $('notice').hidden = false; }
      if (picture && firstFrameAt === null && picture.points > 0) firstFrameAt = performance.now();
      if (picture && twoMillionAt === null && picture.points >= 2e6) twoMillionAt = performance.now();
    }
    log.push([now, added]);
    while (log.length > 2 && now - log[0][0] > 1000) log.shift();
    if (!isOutput) write(letters);
  }
  function frame(now) {
    requestAnimationFrame(frame);
    if (now === lastNow) return;   // a host may call back twice within one refresh
    lastNow = now;
    step(now);
  }
  function stats() {
    const span = log.length > 1 ? log[log.length - 1][0] - log[0][0] : 0;
    let total = 0;
    for (let i = 1; i < log.length; i++) total += log[i][1];
    return {
      fps: span > 0 ? Math.round((log.length - 1) / span * 10000) / 10 : 0,
      pointsPerFrame: log.length > 1 ? Math.round(total / (log.length - 1)) : 0,
      points: picture ? picture.points : 0,
      stopped: picture ? picture.stopped : false,
      degenerate: picture ? picture.collapsed : null,
      mode: picture ? picture.mode : 'none', cap: picture ? picture.cap : 0, size: picture ? picture.size : [0, 0],
    };
  }

  /* ---------- text on the device screen ---------- */
  let wrote = '';
  const two = v => (Math.round(v * 100) / 100).toFixed(2);
  function write(letters) {
    const flagged = !!picture && picture.collapsed === true && picture.mode === 'still';
    const next = [motion.formula, textShown, flagged, letters.map(two).join(' '), picture ? picture.points : 0].join('|');
    if (next === wrote) return;
    wrote = next;
    const formula = FORMULAS[motion.formula];
    $('text').hidden = !textShown;
    $('lines').textContent = formula.text.join('\n');
    $('letters').textContent = 'abcd'.split('').map((name, i) => name + '=' + two(letters[i])).join('  ');
    $('count').textContent = 'n = ' + (picture ? picture.points : 0).toLocaleString('en-US');
    $('flag').hidden = !flagged;
  }
  let monitorTimer = 0;
  function label() {
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      const formula = FORMULAS[motion.formula], on = presetNow(), values = {};
      'abcd'.split('').forEach((name, i) => { values['E' + (i + 1)] = {label: name, value: two(motion.p[i] / 100) + (coarse[i] ? ' ×10' : '')}; });
      values.K2 = {label: 'Preset', value: (on < 0 ? '–' : on + 1) + '/' + formula.presets.length};
      values.K3 = {label: motion.drift ? 'Drift on' : 'Colour', value: PALETTES[palette].name, pressed: !!motion.drift};
      values.K4 = {label: formula.name};
      try { void sdk.monitor.set(values).catch(() => {}); } catch (_) { /* unavailable */ }
    }, 40);
  }

  /* ---------- saved settings, the share link and the output ---------- */
  let version, saveTimer = 0, shareTimer = 0, shared = '';
  function restore(value) {
    if (!value || value.v !== 1) return;
    const index = FORMULAS.findIndex(f => f.id === value.formula);
    if (index >= 0) {
      const [lo, hi] = FORMULAS[index].range.map(v => Math.round(v * 100));
      if (valid(value.p, lo, hi)) { motion.formula = index; motion.p = value.p.map(Math.round); }
    }
    if (Number.isInteger(value.palette) && value.palette >= 0 && value.palette < PALETTES.length) palette = value.palette;
    if (value.drift === true) motion.drift = epoch();
    textShown = value.text !== false;
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const value = {v: 1, formula: FORMULAS[motion.formula].id, p: motion.p, palette, drift: !!motion.drift, text: textShown};
      try { version = (await sdk.data.set('state', value, version === undefined ? {} : {expectedVersion: version})).version; }
      catch (_) { try { version = (await sdk.data.get('state')).version; } catch (__) { /* best effort */ } }
    }, 800);
  }
  // Share link: v1.<formula id>.<a x 100>.<b x 100>.<c x 100>.<d x 100>.<colours>. A link the App cannot read is
  // ignored and it opens as saved.
  const SHARE = /^v1\.([a-z0-9-]{1,24})\.(-?\d{1,3})\.(-?\d{1,3})\.(-?\d{1,3})\.(-?\d{1,3})\.(\d)$/;
  const shareState = () => ['v1', FORMULAS[motion.formula].id, ...motion.p, palette].join('.');
  function shareSoon() {
    if (!sdk.share) return;
    clearTimeout(shareTimer);
    shareTimer = setTimeout(() => {
      const value = shareState();
      if (value === shared) return;
      shared = value;
      try { sdk.share.report({state: value}); } catch (_) { /* this host has no links */ }
    }, 400);
  }
  function applyShare(share) {
    const m = SHARE.exec(typeof share?.state === 'string' ? share.state : '');
    if (!m) return;
    const index = FORMULAS.findIndex(f => f.id === m[1]), p = m.slice(2, 6).map(Number), colours = Number(m[6]);
    if (index < 0 || colours >= PALETTES.length) return;
    const [lo, hi] = FORMULAS[index].range.map(v => Math.round(v * 100));
    if (!valid(p, lo, hi)) return;
    // A link shows one figure: it opens at rest.
    motion.formula = index; motion.p = p; motion.glide = null; motion.drift = 0; palette = colours;
  }
  function publish() {
    if (isOutput || !relay) return;
    try { relay.publish({v: 1, f: FORMULAS[motion.formula].id, p: motion.p, g: motion.glide, drift: motion.drift, c: palette}); } catch (_) { /* no output */ }
  }
  function follow({kind, data} = {}) {
    if (kind !== 'state' || !data || data.v !== 1) return;
    const index = FORMULAS.findIndex(f => f.id === data.f);
    if (index < 0) return;
    const [lo, hi] = FORMULAS[index].range.map(v => Math.round(v * 100));
    if (!valid(data.p, lo, hi)) return;
    motion.formula = index; motion.p = data.p; told = true;
    motion.glide = data.g && valid(data.g.from, lo, hi) && Number.isFinite(data.g.at) ? {from: data.g.from, at: data.g.at} : null;
    motion.drift = Number.isFinite(data.drift) ? data.drift : 0;
    if (Number.isInteger(data.c) && data.c >= 0 && data.c < PALETTES.length && data.c !== palette) { palette = data.c; if (picture) picture.colours(PALETTES[palette].stops); }
  }
  // Something changed: the labels, the saved copy, the share link and the output all follow.
  function changed() { label(); saveSoon(); shareSoon(); publish(); }

  /* ---------- controls ---------- */
  const held = {}, turnedAt = [0, 0, 0, 0], spin = [0, 0, 0, 0];
  let driftTimer = 0;
  // One detent is 0.01, or 0.10 after a press. A sustained fast spin (several detents under 40 ms apart) covers more
  // ground; a slow turn is always one step.
  function turn(knob, detents) {
    const now = performance.now(), gap = now - turnedAt[knob], [lo, hi] = limits();
    turnedAt[knob] = now;
    spin[knob] = gap < 40 ? spin[knob] + 1 : 0;
    const size = (coarse[knob] ? 10 : 1) * (spin[knob] >= 8 ? 4 : spin[knob] >= 4 ? 2 : 1);
    if (motion.glide) { motion.p = settled(epoch()).map(Math.round); motion.glide = null; }
    motion.p = motion.p.slice();
    motion.p[knob] = clamp(motion.p[knob] + detents * size, lo, hi);
    changed();
  }
  function nextPreset() {
    const formula = FORMULAS[motion.formula], on = presetNow(), at = epoch();
    preset = ((on < 0 ? preset : on) + 1) % formula.presets.length;
    motion.glide = {from: settled(at).slice(), at};
    motion.p = hundredths(formula.presets[preset]);
    changed();
  }
  function nextFormula() {
    motion.formula = (motion.formula + 1) % FORMULAS.length;
    motion.p = hundredths(FORMULAS[motion.formula].presets[0]); motion.glide = null; preset = 0;
    changed();
  }
  function nextColours() {
    palette = (palette + 1) % PALETTES.length;
    if (picture) picture.colours(PALETTES[palette].stops);
    changed();
  }
  // Drift: each letter sways a little around where it stands. Turning it off leaves the letters where they are.
  function setDrift(on) {
    const at = epoch();
    if (!on) { motion.p = lettersAt(at).map(Math.round); motion.glide = null; }
    motion.drift = on ? at : 0;
    changed();
  }
  function onControl(event) {
    const control = event.control, knob = ['E1', 'E2', 'E3', 'E4'].indexOf(control);
    if (event.type === 'rotate') {
      const detents = Math.trunc(Number(event.delta) || 0);
      if (detents && knob >= 0) turn(knob, detents);
    } else if (event.type === 'down') {
      if (held[control]) return;
      held[control] = true;
      if (knob >= 0) { coarse[knob] = !coarse[knob]; label(); }
      else if (control === 'K2') nextPreset();
      // K3 held: drift. A short press changes the colours (on release).
      else if (control === 'K3') driftTimer = setTimeout(() => { driftTimer = 0; setDrift(!motion.drift); }, HOLD_MS);
      else if (control === 'K4') nextFormula();
    } else if (event.type === 'up' || event.type === 'cancel') {
      if (!held[control]) return;
      held[control] = false;
      if (control === 'K3' && driftTimer) { clearTimeout(driftTimer); driftTimer = 0; if (event.type === 'up') nextColours(); }
    }
  }

  /* ---------- checks ---------- */
  window.__attractor = {
    role: isOutput ? 'output' : 'control',
    get firstFrameAt() { return firstFrameAt; },
    get twoMillionAt() { return twoMillionAt; },
    state: () => {
      const letters = lettersAt(epoch());
      return {formula: FORMULAS[motion.formula].id, a: letters[0] / 100, b: letters[1] / 100, c: letters[2] / 100, d: letters[3] / 100, palette: PALETTES[palette].name, drift: !!motion.drift, textVisible: !isOutput && textShown};
    },
    stats,
  };
  // The numbers an observer of the running App can read from its log.
  const report = () => console.debug('picture ' + JSON.stringify(stats()));

  /* ---------- start ---------- */
  async function init() {
    const canvas = $('picture');
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); picture = null; });
    canvas.addEventListener('webglcontextrestored', build);
    new ResizeObserver(layout).observe($('stage'));
    setInterval(report, 5000);
    if (isOutput) {
      build();
      await sdk.ready();
      relay?.onMessage(follow);
      requestAnimationFrame(frame);
      return;
    }
    try { const saved = await sdk.data.get('state'); version = saved.version; restore(saved.value); } catch (_) { /* first run */ }
    applyShare(context.share);
    build(); label();
    // The first points at once, before the first animation frame: a host may keep the App hidden until it is ready.
    step(performance.now());
    $('stage').addEventListener('click', () => { textShown = !textShown; saveSoon(); });
    sdk.controls.onEvent(onControl);
    await sdk.ready();
    requestAnimationFrame(frame);
    setInterval(publish, 1000); publish(); shareSoon();
  }
  addEventListener('pagehide', () => clearTimeout(saveTimer), {once: true});
  void init();
})();
