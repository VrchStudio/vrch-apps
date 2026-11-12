// app.js (cube): the instrument around the box. Knobs and keys, the labels on the device, saved settings, the share
// link, the camera's view and the large output live here. How the air in the box rings is in modes.js, how the sand
// moves and how box and sand are drawn in sand.js, the note in tone.js and listening in ear.js.
(() => {
  'use strict';
  const sdk = window.VrchApp, Modes = window.Modes, Sand = window.Sand;
  let context = {};
  try { context = sdk.context; } catch (_) { /* defaults */ }
  // Output role: a picture-only instance (a large or second screen) shows the same box. It makes no sound, reads
  // no controls, saves nothing and shows no text. The controlling instance tells it the settings and every throw
  // and tap; it then moves its own sand, so the figure is the same while single grains differ.
  const isOutput = context.role === 'output', relay = sdk.output || null;
  document.documentElement.dataset.role = isOutput ? 'output' : 'control';
  if (context.name) document.title = context.name;
  const $ = id => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const smooth = u => u * u * (3 - 2 * u);
  const mix = (a, b, u) => a + (b - a) * u;

  /* ---------- settings ---------- */
  const LOW = Modes.lowest, HIGH = Modes.highest, THIRD = Modes.thirdLowest, WEAVES = Modes.weaves, LAST = (WEAVES.length - 1) * 100;
  // n, m and l: the mode. kn, km and kl: a second mode kept ringing with it (all 0: none). drive: how hard the box
  // rings, in percent. weave: 0 is the first weave in modes.js, 100 the second, and so on. palette: index into
  // PALETTES. output: index into OUTPUTS (the view).
  const DEFAULTS = {n: 1, m: 2, l: 3, kn: 0, km: 0, kl: 0, drive: 60, weave: 0, palette: 0, output: 0};
  // Where the camera looks from: circling the box, along its long diagonal (corner to corner), or facing a side. The
  // device and a large output show the same view.
  const OUTPUTS = [{name: 'Orbit'}, {name: 'Diagonal'}, {name: 'Face'}];
  const DRIVE_STEP = 5;
  const state = {...DEFAULTS};
  // plate: the room around the box. light: the box's walls and edges. thin and thick: sand on the move and at rest.
  const PALETTES = [
    {name: 'Sand', plate: [0.018, 0.018, 0.022], light: [0.42, 0.4, 0.37], thin: [0.5, 0.42, 0.3], thick: [1.0, 0.9, 0.7]},
    {name: 'Night', plate: [0.008, 0.016, 0.05], light: [0.3, 0.4, 0.65], thin: [0.25, 0.36, 0.6], thick: [0.78, 0.9, 1.0]},
    {name: 'Ember', plate: [0.03, 0.012, 0.006], light: [0.55, 0.3, 0.16], thin: [0.55, 0.16, 0.04], thick: [1.0, 0.68, 0.3]},
  ];
  // Figures to start from: n, m, l, weave, and for two modes at once the kept n, m and l as well.
  const PRESETS = [[1, 2, 3, 0], [1, 2, 0, 0], [2, 3, 0, 100], [1, 2, 4, 0], [1, 1, 3, 0], [1, 2, 2, 0], [1, 3, 4, 100], [1, 1, 1, 0], [1, 2, 3, 200], [3, 4, 5, 100]];
  const NEAR = 0.5;             // at full drive a grain jumps this share of the way to the nearest still surface,
  const FARTHEST = 0.07;        // but never farther than this in one step (lengths are shares of the box's width)
  const SHAKE = 0.0036;         // the tiny shake that never stops while the box rings, divided by the pitch number below,
  const SHAKIEST = 0.0022;      // and never more than this: simple figures get thick sheets, busy ones thin sheets
  const TOSS = 0.03;            // a hand shaking the box (K3 held) moves every grain up to this far a step, wherever it lies
  const STEP_MS = 1000 / 60;    // the sand moves 60 times a second, whatever the screen does
  const TURN_MS = 300, PRESET_MS = 900, WEAVE_MS = 700, COLOUR_MS = 500;
  const LOWEST_HZ = 55, OCTAVES = 3;
  // The pitch rises with n*n + m*m + l*l, as a closed box of air's does (its square root), pressed together so that
  // (1, 1, 0) to (8, 8, 8) take three octaves from 55 Hz (to 440 Hz).
  const pitchNumber = (n, m, l) => n * n + m * m + l * l;
  const SPAN = Math.log2(pitchNumber(HIGH, HIGH, HIGH) / pitchNumber(1, 1, 0));
  const hertzOf = (n, m, l) => LOWEST_HZ * 2 ** (OCTAVES * Math.log2(pitchNumber(n, m, l) / pitchNumber(1, 1, 0)) / SPAN);
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = hertz => { const key = Math.round(69 + 12 * Math.log2(hertz / 440)); return NOTES[((key % 12) + 12) % 12] + (Math.floor(key / 12) - 1); };

  /* ---------- what is on its way ---------- */
  // The box does not switch: it leaves one mode for the next over a short time, the weave slides, colours fade.
  const here = () => [state.n, state.m, state.l];
  const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  const moving = {from: here(), to: here(), at: 0, ms: 1,
    weave: {from: state.weave, to: state.weave, at: 0, ms: 1},
    colours: {from: PALETTES[state.palette], to: PALETTES[state.palette], at: 0, ms: 1},
    // The kept mode comes and goes: how much of it there is runs from "from" to "to".
    kept: {mode: [1, 1, 1], from: 0, to: 0, at: 0, ms: 1}};
  const part = (at, ms, now) => clamp((now - at) / ms, 0, 1);
  const keptAt = now => mix(moving.kept.from, moving.kept.to, smooth(part(moving.kept.at, moving.kept.ms, now)));
  const blendAt = now => smooth(part(moving.at, moving.ms, now));
  const weaveAt = now => mix(moving.weave.from, moving.weave.to, smooth(part(moving.weave.at, moving.weave.ms, now)));
  // How much the swapped orders count (see modes.js), between two weaves a mix.
  const oddOf = weave => { const at = clamp(weave / 100, 0, WEAVES.length - 1), low = Math.min(WEAVES.length - 2, Math.floor(at)); return WEAVES.length === 1 ? WEAVES[0].odd : mix(WEAVES[low].odd, WEAVES[low + 1].odd, at - low); };
  function coloursAt(now) {
    const c = moving.colours, u = smooth(part(c.at, c.ms, now)), each = key => c.from[key].map((v, i) => mix(v, c.to[key][i], u));
    return {plate: each('plate'), light: each('light'), thin: each('thin'), thick: each('thick')};
  }
  let changedAt = null, tunedAt = null;
  // ms 0: at once (a first look, nothing to leave).
  function arrive(ms, colourMs = COLOUR_MS) {
    const now = performance.now();
    if (!same(moving.to, here())) {
      // (Sand shows where the air stood still a moment ago: which of the two modes it leaves cannot be seen.)
      if (blendAt(now) >= 0.5) moving.from = moving.to;
      moving.to = here(); moving.at = now; moving.ms = Math.max(1, ms);
      if (!ms) moving.from = moving.to;
      changedAt = now;
    }
    const k = moving.kept, want = state.kn ? 1 : 0, keep = [state.kn, state.km, state.kl];
    if (k.to !== want || (want && !same(k.mode, keep))) {
      moving.kept = {mode: want ? keep : k.mode, from: ms ? keptAt(now) : want, to: want, at: now, ms: Math.max(1, ms)};
      changedAt = now;
    }
    if (moving.weave.to !== state.weave) moving.weave = {from: ms ? weaveAt(now) : state.weave, to: state.weave, at: now, ms: Math.max(1, ms === TURN_MS ? WEAVE_MS : ms)};
    if (moving.colours.to !== PALETTES[state.palette]) moving.colours = {from: ms ? {...coloursAt(now)} : PALETTES[state.palette], to: PALETTES[state.palette], at: now, ms: Math.max(1, ms ? colourMs : 0)};
  }

  /* ---------- the note ---------- */
  // mode: 'off' (silent), 'sound' (the note is heard) or 'listen' (the audio input chooses the note; the App is silent).
  let tone = null, ear = null, mode = 'off';
  // The box's overtones, between two weaves a mix of theirs.
  function overtones(weave) {
    const at = clamp(weave / 100, 0, WEAVES.length - 1), low = Math.min(WEAVES.length - 2, Math.floor(at)), u = at - low;
    if (WEAVES.length === 1) return WEAVES[0].overtones;
    return WEAVES[low].overtones.map((pair, i) => [mix(pair[0], WEAVES[low + 1].overtones[i][0], u), mix(pair[1], WEAVES[low + 1].overtones[i][1], u)]);
  }
  const hertz = () => hertzOf(state.n, state.m, state.l);
  function tune() {
    if (!tone) return;
    tone.set({hertz: hertz(), second: state.kn ? hertzOf(state.kn, state.km, state.kl) : 0, drive: state.drive / 100, overtones: overtones(state.weave)});
    tunedAt = performance.now();
  }
  let noticeTimer = 0;
  function notice(text, keep = false) {
    clearTimeout(noticeTimer);
    const el = $('notice'); el.textContent = text; el.hidden = !text;
    if (text && !keep) noticeTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }
  function toneChanged() {
    if (tone.problem) { if (mode === 'sound') mode = 'off'; notice(tone.problem === 'menu' ? 'Allow audio in Menu, then press K2.' : 'Sound unavailable. Press K2 to retry.', true); }
    label();
  }
  let listenTimer = 0;
  function setMode(next) {
    if (next === mode) return;
    const was = mode;
    mode = next; notice(''); clearTimeout(listenTimer);
    if (was === 'listen') { ear.close(); heard = null; pending = null; }
    if (next === 'sound') { tune(); void tone.on(); } else if (was === 'sound') tone.off();
    // The input is asked for once K2 has rested on Listen: passing it on the way to Off asks for nothing.
    if (next === 'listen') listenTimer = setTimeout(() => { if (mode === 'listen') void ear.open(); }, LISTEN_AFTER_MS);
    label();
  }

  /* ---------- listening: the note that is heard chooses the mode ---------- */
  // Heard pitches are taken a semitone at a time, from A1 (55 Hz) up; every semitone has the mode whose own pitch is
  // nearest. Pitches outside that range are moved into it by octaves.
  const LISTEN_AFTER_MS = 900, STICK = 0.65;   // a held note has to move this far (in semitones) from its own before another is taken
  const STEPS = Math.floor(12 * Math.log2(hertzOf(HIGH, HIGH, HIGH) / LOWEST_HZ));
  const SUNG = [];
  for (let step = 0; step <= STEPS; step++) {
    let best = null, off = Infinity;
    // (n is never above m here; of two modes equally near, the first found is taken.)
    for (let l = THIRD; l <= HIGH; l++) for (let m = LOW; m <= HIGH; m++) for (let n = LOW; n <= m; n++) {
      const far = Math.abs(12 * Math.log2(hertzOf(n, m, l) / LOWEST_HZ) - step);
      if (far < off) { off = far; best = [n, m, l]; }
    }
    SUNG.push(best);
  }
  let heard = null, pending = null;   // the semitone the box follows, and one heard once that has yet to be heard again
  function onPitch(hertz) {
    if (mode !== 'listen') return;
    if (!hertz) { pending = null; return; }   // silence: the figure stays
    let at = 12 * Math.log2(hertz / LOWEST_HZ);
    while (at < -0.5) at += 12;
    while (at >= STEPS + 0.5) at -= 12;
    const step = heard !== null && Math.abs(at - heard) < STICK ? heard : clamp(Math.round(at), 0, STEPS);
    if (step === heard) { pending = null; return; }
    // (A note is followed once it has been heard twice running: a crack or a breath between notes is not.)
    if (pending !== step) { pending = step; return; }
    heard = step; pending = null;
    const sung = SUNG[step];
    if (!same(sung, here())) { [state.n, state.m, state.l] = sung; changed(); } else label();
  }
  function earChanged() {
    if (ear.problem && mode === 'listen') {
      mode = 'off'; heard = null; pending = null;
      notice(ear.problem === 'refused' ? 'Audio input is not allowed.' : ear.problem === 'missing' ? 'No audio input.' : 'Audio input stopped.');
    }
    label();
  }

  /* ---------- the picture ---------- */
  let sand = null, firstFrameAt = null, lastNow = null, owed = 0, told = !isOutput, shaking = false, slowFor = 0, checkedAt = 0;
  const frames = [];
  function build() {
    try { sand = Sand.create($('picture'), Modes); } catch (error) { sand = null; console.error(error); }
    if (!sand && !isOutput) notice('This browser cannot draw the box.', true);
    layout();
  }
  function layout() {
    let inset = 0;
    try { inset = sdk.context.safeInsets?.left || 0; } catch (_) { /* default */ }
    document.documentElement.style.setProperty('--inset-left', inset + 'px');
    const box = $('stage');
    if (sand) { sand.resize(box.clientWidth, box.clientHeight, Math.min(2, devicePixelRatio || 1)); sand.look(state.output); }
  }
  function view(now) {
    // (With two modes the finer figure sets how small the shake is.)
    const drive = state.drive / 100, pace = Math.sqrt(Math.max(pitchNumber(state.n, state.m, state.l), state.kn ? pitchNumber(state.kn, state.km, state.kl) : 0, 1));
    return {from: moving.from, to: moving.to, blend: blendAt(now), kept: [...moving.kept.mode, keptAt(now)], odd: oddOf(weaveAt(now)),
      near: shaking ? 0 : NEAR * drive, farthest: FARTHEST, shake: Math.min(SHAKIEST, SHAKE / pace) * Math.min(1, drive * 10), toss: shaking ? TOSS : 0, colours: coloursAt(now)};
  }
  function fps() { return frames.length > 1 ? Math.round((frames.length - 1) * 10000 / (frames[frames.length - 1] - frames[0])) / 10 : 0; }
  function frame(now) {
    requestAnimationFrame(frame);
    if (!sand || !told || now === lastNow) return;
    // The sand keeps its own time: as many moves as 60ths of a second have passed, three at most in one frame.
    owed += lastNow === null ? 1 : (now - lastNow) / STEP_MS;
    lastNow = now;
    const steps = Math.min(3, Math.floor(owed + 0.25));
    owed = owed - steps > 3 ? 0 : Math.max(0, owed - steps);
    sand.draw(view(now), steps);
    if (firstFrameAt === null) firstFrameAt = now;
    frames.push(now); while (frames[0] < now - 1000) frames.shift();
    // A screen that cannot keep 30 frames a second gets fewer grains (seen over three seconds, not while the page was
    // away).
    if (now - checkedAt >= 1000) {
      slowFor = now - checkedAt < 1500 && firstFrameAt < now - 2000 && fps() < 30 ? slowFor + 1 : 0;
      checkedAt = now;
      if (slowFor >= 3) { slowFor = 0; sand.fewer(); }
    }
  }

  /* ---------- labels ---------- */
  const presetNow = () => PRESETS.findIndex(set => set[0] === state.n && set[1] === state.m && set[2] === state.l && set[3] === state.weave && (set[4] || 0) === state.kn && (set[5] || 0) === state.km && (set[6] || 0) === state.kl);
  // On a weave: its name. Between two: how far towards the next.
  const weaveName = () => { const at = Math.floor(state.weave / 100), past = state.weave - at * 100; return past ? past + '% ' + WEAVES[at + 1].name : WEAVES[at].name; };
  let monitorTimer = 0, outputShown = 0;
  function label() {
    if (isOutput) return;
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      const on = presetNow(), kept = (own, other) => state.kn ? own + ' + ' + other : String(own);
      const values = {
        // (With a mode kept, each knob shows its own number and the kept one.)
        E1: {label: 'n', value: kept(state.n, state.kn), pressed: !!state.kn}, E2: {label: 'm', value: kept(state.m, state.km)},
        // (For a moment after E3 is pressed its label says which view the camera now takes.)
        E3: performance.now() < outputShown ? {label: 'View', value: OUTPUTS[state.output].name} : {label: 'Drive', value: state.drive + '%'},
        E4: {label: 'l', value: kept(state.l, state.kl) + ' · ' + weaveName()},
        K2: mode === 'listen' ? {label: 'Listen', value: heard === null ? '' : noteName(LOWEST_HZ * 2 ** (heard / 12)), pressed: true}
          : {label: 'Sound', value: mode === 'sound' ? 'on · ' + noteName(hertz()) : 'off', pressed: mode === 'sound'},
        K3: {label: 'Scatter', value: '', pressed: shaking},
        K4: {label: 'Preset', value: (on < 0 ? '–' : on + 1) + '/' + PRESETS.length},
      };
      try { void sdk.monitor.set(values).catch(() => {}); } catch (_) { /* unavailable */ }
    }, 40);
  }

  /* ---------- saved settings, the share link and the output ---------- */
  let version, saveTimer = 0, shareTimer = 0, shared = '', glide = TURN_MS;
  const whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  // Takes what is valid from "value" (n, m, l, kn, km, kl, drive, weave, palette, output) and leaves the rest as it is.
  function take(value) {
    if (!value) return;
    if (whole(value.n, LOW, HIGH)) state.n = value.n;
    if (whole(value.m, LOW, HIGH)) state.m = value.m;
    if (whole(value.l, THIRD, HIGH)) state.l = value.l;
    if ((whole(value.kn, LOW, HIGH) && whole(value.km, LOW, HIGH) && whole(value.kl, THIRD, HIGH)) || (value.kn === 0 && value.km === 0 && value.kl === 0)) { state.kn = value.kn; state.km = value.km; state.kl = value.kl; }
    if (whole(value.drive, 0, 100)) state.drive = value.drive;
    if (whole(value.weave, 0, LAST)) state.weave = value.weave;
    if (whole(value.palette, 0, PALETTES.length - 1)) state.palette = value.palette;
    if (whole(value.output, 0, OUTPUTS.length - 1)) state.output = value.output;
  }
  // Saved as version 2: the plate's settings (version 1) mean something else and are not taken.
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { version = (await sdk.data.set('state', {v: 2, ...state}, version === undefined ? {} : {expectedVersion: version})).version; }
      catch (_) { try { version = (await sdk.data.get('state')).version; } catch (__) { /* best effort */ } }
    }, 800);
  }
  // Share link: c1.<n>.<m>.<l>.<drive>.<weave>.<palette>.<kept n>.<kept m>.<kept l> (0.0.0: one mode). A link the App
  // cannot read is ignored and it opens as saved.
  const SHARE = /^c1\.(\d{1,2})\.(\d{1,2})\.(\d{1,2})\.(\d{1,3})\.(\d{1,3})\.(\d)\.(\d{1,2})\.(\d{1,2})\.(\d{1,2})$/;
  const shareState = () => ['c1', state.n, state.m, state.l, state.drive, state.weave, state.palette, state.kn, state.km, state.kl].join('.');
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
    const found = SHARE.exec(typeof share?.state === 'string' ? share.state : '');
    if (!found) return;
    const [n, m, l, drive, weave, palette, kn, km, kl] = found.slice(1).map(Number);
    take({n, m, l, drive, weave, palette, kn, km, kl});
  }
  function publish() {
    if (isOutput || !relay) return;
    try { relay.publish({v: 2, n: state.n, m: state.m, l: state.l, kn: state.kn, km: state.km, kl: state.kl, drive: state.drive, weave: state.weave, palette: state.palette, output: state.output, shaking, ms: glide}); } catch (_) { /* no output */ }
  }
  function send(event) {
    if (isOutput || !relay) return;
    try { relay.send({v: 2, ...event}); } catch (_) { /* no output */ }
  }
  const three = list => Array.isArray(list) && list.length === 3 && list.every(Number.isFinite);
  function follow({kind, data} = {}) {
    if (!data || data.v !== 2) return;
    if (kind === 'event') {
      if (!sand) return;
      if (data.e === 'scatter' && Number.isFinite(data.seed)) sand.scatter(data.seed);
      if (data.e === 'flick' && three(data.from) && three(data.way)) sand.flick(data.from, data.way);
      return;
    }
    if (kind !== 'state') return;
    const shown = state.output;
    take(data);
    if (state.output !== shown) layout();
    shaking = data.shaking === true;
    arrive(told ? clamp(Number(data.ms) || TURN_MS, 100, 5000) : 0);
    told = true;
  }
  // Something changed: the box goes there in "ms", and the note, the labels, the saved copy, the share link and
  // the output all follow.
  function changed(ms = TURN_MS) { glide = ms; arrive(ms); tune(); label(); saveSoon(); shareSoon(); publish(); }

  /* ---------- knobs, keys and touch ---------- */
  let throws = 0;
  function scatter() {
    // (The seed only has to differ from throw to throw; the output gets the same one.)
    const seed = (++throws * 7919 + Math.round(performance.now())) % 1000000;
    if (sand) sand.scatter(seed);
    send({e: 'scatter', seed});
  }
  const round = list => list.map(v => Math.round(v * 10000) / 10000);
  function flick(line) {
    if (sand) sand.flick(line.from, line.way);
    send({e: 'flick', from: round(line.from), way: round(line.way)});
  }
  function shake(on) {
    if (shaking === on) return;
    shaking = on; label(); publish();
  }
  function nextPreset() {
    const [n, m, l, weave, kn = 0, km = 0, kl = 0] = PRESETS[(presetNow() + 1) % PRESETS.length];
    Object.assign(state, {n, m, l, weave, kn, km, kl});
    changed(PRESET_MS);
  }
  const TURNS = {
    E1: detents => { state.n = clamp(state.n + detents, LOW, HIGH); },
    E2: detents => { state.m = clamp(state.m + detents, LOW, HIGH); },
    E3: detents => { state.drive = clamp(state.drive + detents * DRIVE_STEP, 0, 100); },
    E4: detents => { state.l = clamp(state.l + detents, THIRD, HIGH); },
  };
  const PRESSES = {
    // Keep: the mode as it stands goes on ringing while the knobs find a second one; pressed again it is let go.
    E1: () => { [state.kn, state.km, state.kl] = state.kn ? [0, 0, 0] : [state.n, state.m, state.l]; changed(); },
    E2: () => { state.palette = (state.palette + 1) % PALETTES.length; changed(); },
    // The view: circling, along the diagonal or facing a side, on the device and on a large output alike.
    E3: () => { state.output = (state.output + 1) % OUTPUTS.length; outputShown = performance.now() + 1600; setTimeout(label, 1650); layout(); changed(); },
    // The weave: to the next, and from the last back to the first; the surfaces bend from one to the other.
    E4: () => { const near = Math.round(state.weave / 100) * 100; state.weave = state.weave !== near ? near : near === LAST ? 0 : near + 100; changed(WEAVE_MS); },
    K2: () => setMode(mode === 'off' ? 'sound' : mode === 'sound' ? 'listen' : 'off'),
    K3: () => { scatter(); shake(true); },
    K4: nextPreset,
  };
  const down = {};
  function onControl(event) {
    const control = event.control;
    // The first knob or key opens the sound, silent, so that K2 finds it ready.
    tone.ready();
    if (event.type === 'rotate') {
      const detents = Math.trunc(Number(event.delta) || 0);
      if (!detents || !TURNS[control]) return;
      TURNS[control](detents); changed();
    } else if (event.type === 'down') {
      if (down[control] || !PRESSES[control]) return;
      down[control] = true; PRESSES[control]();
    } else if (event.type === 'up' || event.type === 'cancel') {
      down[control] = false;
      // K3 held keeps the box shaking; let go, the sand gathers.
      if (control === 'K3') shake(false);
    }
  }
  // A tap knocks the sand away from the line it makes through the box; a finger drawn across ploughs through it.
  function touch() {
    const stage = $('stage');
    let finger = null;
    const knock = (event, first) => {
      const now = performance.now();
      if (!first && now - finger.at < 70 && Math.hypot(event.clientX - finger.x, event.clientY - finger.y) < 18) return;
      const line = sand ? sand.ray(event.clientX, event.clientY) : null;
      if (!line) return;
      finger.at = now; finger.x = event.clientX; finger.y = event.clientY;
      flick(line);
    };
    stage.addEventListener('pointerdown', event => {
      finger = {id: event.pointerId, at: 0, x: 0, y: 0};
      try { stage.setPointerCapture(event.pointerId); } catch (_) { /* a pointer sent by the host */ }
      knock(event, true);
    });
    addEventListener('pointermove', event => { if (finger && event.pointerId === finger.id) knock(event, false); });
    const lift = event => { if (finger && event.pointerId === finger.id) finger = null; };
    addEventListener('pointerup', lift); addEventListener('pointercancel', lift);
  }

  /* ---------- checks ---------- */
  const stats = () => {
    const measured = sand ? sand.measure() : {grains: 0, amplitude: 0};
    return {fps: fps(), grains: measured.grains, amplitude: Math.round(measured.amplitude * 10000) / 10000, hertz: Math.round(hertz() * 100) / 100,
      second: state.kn ? Math.round(hertzOf(state.kn, state.km, state.kl) * 100) / 100 : 0, audible: tone ? tone.audible : false, listening: ear ? ear.listening : false,
      size: sand ? sand.size : [0, 0], view: OUTPUTS[state.output].name, mode: here(), weave: weaveName(), changedAt, tunedAt};
  };
  window.__chladni = {
    role: isOutput ? 'output' : 'control',
    get firstFrameAt() { return firstFrameAt; },
    state: () => ({n: state.n, m: state.m, l: state.l, drive: state.drive / 100, weave: weaveName(), palette: PALETTES[state.palette].name, view: OUTPUTS[state.output].name,
      kept: state.kn ? [state.kn, state.km, state.kl] : null, sound: mode === 'sound', listen: mode === 'listen', heard: heard === null ? null : noteName(LOWEST_HZ * 2 ** (heard / 12)), shaking, preset: presetNow() + 1,
      note: noteName(hertz())}),
    stats,
  };
  // The numbers an observer of the running App can read from its log.
  const report = () => console.debug('sand ' + JSON.stringify(stats()));

  /* ---------- start ---------- */
  async function init() {
    const canvas = $('picture');
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); sand = null; });
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
    try { const saved = await sdk.data.get('state'); version = saved.version; if (saved.value?.v === 2) take(saved.value); } catch (_) { /* first run */ }
    applyShare(context.share);
    arrive(0);
    tone = new window.Tone({sdk, onChange: toneChanged});
    ear = new window.Ear({sdk, onPitch, onChange: earChanged});
    build(); label();
    // The box and its sand at once, before the first animation frame: a host may keep the App hidden until it is ready.
    if (sand) { sand.draw(view(performance.now()), 0); firstFrameAt = performance.now(); }
    touch();
    sdk.controls.onEvent(onControl);
    await sdk.ready();
    // (Labels set before the host is ready are lost on the device: they are set again now.)
    label();
    requestAnimationFrame(frame);
    setInterval(publish, 1000); publish(); shareSoon();
  }
  addEventListener('pagehide', () => { clearTimeout(saveTimer); clearTimeout(listenTimer); if (tone) tone.close(); if (ear) ear.close(); }, {once: true});
  void init();
})();
