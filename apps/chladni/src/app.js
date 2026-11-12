// app.js: the instrument around the plate. Knobs and keys, the labels on the device, saved settings, the share link
// and the large output live here. How the plate vibrates is in modes.js, how the sand moves and looks in sand.js,
// the note in tone.js and listening in ear.js.
(() => {
  'use strict';
  const sdk = window.VrchApp, Modes = window.Modes, Sand = window.Sand;
  let context = {};
  try { context = sdk.context; } catch (_) { /* defaults */ }
  // Output role: a picture-only instance (a large or second screen) shows the same plate. It makes no sound, reads
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
  const LOW = Modes.lowest, HIGH = Modes.highest, PLATES = Modes.plates, LAST = (PLATES.length - 1) * 100;
  // n and m: the mode. kn and km: a second mode kept sounding with it (0 and 0: none). drive: how hard the plate
  // shakes, in percent. shape: 0 is the first plate in modes.js, 100 the second, and so on. palette: index into
  // PALETTES. output: index into OUTPUTS.
  const DEFAULTS = {n: 3, m: 5, kn: 0, km: 0, drive: 60, shape: 0, palette: 0, output: 0};
  // What a large output shows: the plate repeated over the whole screen, one or two to the shorter side, every other
  // one turned over so that the figure runs on from plate to plate; or the one plate. The device shows the one plate.
  const OUTPUTS = [{name: 'Tiles', rows: 1}, {name: 'Small tiles', rows: 2}, {name: 'Plate', rows: 0}];
  const DRIVE_STEP = 5, SHAPE_STEP = 5;
  const state = {...DEFAULTS};
  // plate and light: the plate in shade and in light. thin and thick: sand lying thin and piled up.
  const PALETTES = [
    {name: 'Sand', plate: [0.05, 0.05, 0.055], light: [0.125, 0.125, 0.13], thin: [0.74, 0.68, 0.56], thick: [0.98, 0.94, 0.83], glint: 0.55},
    {name: 'Night', plate: [0.025, 0.06, 0.15], light: [0.07, 0.15, 0.31], thin: [0.62, 0.71, 0.85], thick: [0.95, 0.98, 1], glint: 0.5},
    {name: 'Brass', plate: [0.55, 0.41, 0.17], light: [0.9, 0.76, 0.43], thin: [0.2, 0.15, 0.09], thick: [0.045, 0.035, 0.025], glint: 0.3},
  ];
  // Figures to start from: n, m, shape, and for two modes at once the kept n and m as well.
  const PRESETS = [[3, 5, 0], [4, 7, 0], [6, 3, 100], [1, 4, 200], [6, 9, 0], [4, 1, 300], [2, 6, 0, 3, 5], [2, 5, 100], [2, 2, 200], [2, 4, 50]];
  const REACH = 0.3;            // at full drive a grain where the plate shakes hardest jumps this far, divided by the pitch number below
  const FARTHEST = 0.07;        // but never farther than this in one step (lengths are shares of the plate's width)
  const SHAKE = 0.0064;         // the tiny shake that never stops while the plate is driven, divided by the same number,
  const SHAKIEST = 0.0022;      // and never more than this: simple figures get broad lines, busy ones fine lines
  const TOSS = 0.03;            // a hand shaking the plate (K3 held) moves every grain up to this far a step, wherever it lies
  const STEP_MS = 1000 / 60;    // the sand moves 60 times a second, whatever the screen does
  const TURN_MS = 300, PRESET_MS = 900, JUMP_MS = 600, SHAPE_MS = 220, COLOUR_MS = 500;
  const LOWEST_HZ = 55, OCTAVES = 3;
  // The pitch rises with n*n + m*m, as a plate's does, pressed together so that n and m from 1 to 12 take three
  // octaves from 55 Hz (to 440 Hz); beyond 12 it goes on rising in the same way.
  const pitchNumber = (n, m) => n * n + m * m;
  const SPAN = Math.log2(pitchNumber(12, 12) / pitchNumber(1, 1));
  const hertzOf = (n, m) => LOWEST_HZ * 2 ** (OCTAVES * Math.log2(pitchNumber(n, m) / pitchNumber(1, 1)) / SPAN);
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = hertz => { const key = Math.round(69 + 12 * Math.log2(hertz / 440)); return NOTES[((key % 12) + 12) % 12] + (Math.floor(key / 12) - 1); };

  /* ---------- what is on its way ---------- */
  // The plate does not switch: it leaves one mode for the next over a short time, the shape slides, colours fade.
  const moving = {from: [state.n, state.m], to: [state.n, state.m], at: 0, ms: 1,
    shape: {from: state.shape, to: state.shape, at: 0, ms: 1},
    colours: {from: PALETTES[state.palette], to: PALETTES[state.palette], at: 0, ms: 1},
    // The kept mode comes and goes: how much of it there is runs from "from" to "to".
    kept: {n: 1, m: 1, from: 0, to: 0, at: 0, ms: 1}};
  const part = (at, ms, now) => clamp((now - at) / ms, 0, 1);
  const keptAt = now => mix(moving.kept.from, moving.kept.to, smooth(part(moving.kept.at, moving.kept.ms, now)));
  const blendAt = now => smooth(part(moving.at, moving.ms, now));
  const shapeAt = now => mix(moving.shape.from, moving.shape.to, smooth(part(moving.shape.at, moving.shape.ms, now)));
  function coloursAt(now) {
    const c = moving.colours, u = smooth(part(c.at, c.ms, now)), each = key => c.from[key].map((v, i) => mix(v, c.to[key][i], u));
    return {plate: each('plate'), light: each('light'), thin: each('thin'), thick: each('thick'), glint: mix(c.from.glint, c.to.glint, u)};
  }
  let changedAt = null, tunedAt = null;
  // ms 0: at once (a first look, nothing to leave).
  function arrive(ms, colourMs = COLOUR_MS) {
    const now = performance.now();
    if (moving.to[0] !== state.n || moving.to[1] !== state.m) {
      // (Sand shows where the plate stood a moment ago, never the plate itself: which of the two it leaves cannot be seen.)
      if (blendAt(now) >= 0.5) moving.from = moving.to;
      moving.to = [state.n, state.m]; moving.at = now; moving.ms = Math.max(1, ms);
      if (!ms) moving.from = moving.to;
      changedAt = now;
    }
    const k = moving.kept, want = state.kn ? 1 : 0;
    if (k.to !== want || (want && (k.n !== state.kn || k.m !== state.km))) {
      moving.kept = {n: want ? state.kn : k.n, m: want ? state.km : k.m, from: ms ? keptAt(now) : want, to: want, at: now, ms: Math.max(1, ms)};
      changedAt = now;
    }
    if (moving.shape.to !== state.shape) moving.shape = {from: ms ? shapeAt(now) : state.shape, to: state.shape, at: now, ms: Math.max(1, ms === TURN_MS ? SHAPE_MS : ms)};
    if (moving.colours.to !== PALETTES[state.palette]) moving.colours = {from: ms ? {...coloursAt(now)} : PALETTES[state.palette], to: PALETTES[state.palette], at: now, ms: Math.max(1, ms ? colourMs : 0)};
  }

  /* ---------- the note ---------- */
  // mode: 'off' (silent), 'sound' (the note is heard) or 'listen' (the audio input chooses the note; the App is silent).
  let tone = null, ear = null, mode = 'off';
  // The plate's overtones, between two plates a mix of theirs.
  function overtones(shape) {
    const at = clamp(shape / 100, 0, PLATES.length - 1), low = Math.min(PLATES.length - 2, Math.floor(at)), u = at - low;
    if (PLATES.length === 1) return PLATES[0].overtones;
    return PLATES[low].overtones.map((pair, i) => [mix(pair[0], PLATES[low + 1].overtones[i][0], u), mix(pair[1], PLATES[low + 1].overtones[i][1], u)]);
  }
  const hertz = () => hertzOf(state.n, state.m);
  function tune() {
    if (!tone) return;
    tone.set({hertz: hertz(), second: state.kn ? hertzOf(state.kn, state.km) : 0, drive: state.drive / 100, overtones: overtones(state.shape)});
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
  const STEPS = Math.floor(12 * Math.log2(hertzOf(HIGH, HIGH) / LOWEST_HZ));
  const SUNG = [];
  for (let step = 0; step <= STEPS; step++) {
    let best = null, off = Infinity;
    // (n is never above m here; of two modes equally near, the first found is taken.)
    for (let m = LOW; m <= HIGH; m++) for (let n = LOW; n <= m; n++) { const far = Math.abs(12 * Math.log2(hertzOf(n, m) / LOWEST_HZ) - step); if (far < off) { off = far; best = [n, m]; } }
    SUNG.push(best);
  }
  let heard = null, pending = null;   // the semitone the plate follows, and one heard once that has yet to be heard again
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
    const [n, m] = SUNG[step];
    if (n !== state.n || m !== state.m) { state.n = n; state.m = m; changed(); } else label();
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
    if (!sand && !isOutput) notice('This browser cannot draw the plate.', true);
    layout();
  }
  function layout() {
    let inset = 0;
    try { inset = sdk.context.safeInsets?.left || 0; } catch (_) { /* default */ }
    document.documentElement.style.setProperty('--inset-left', inset + 'px');
    const box = $('stage');
    if (sand) sand.resize(box.clientWidth, box.clientHeight, Math.min(2, devicePixelRatio || 1), isOutput ? OUTPUTS[state.output].rows : 0);
  }
  function view(now) {
    // (With two modes the finer figure sets how far a grain may jump.)
    const drive = state.drive / 100, pace = Math.sqrt(Math.max(pitchNumber(state.n, state.m), state.kn ? pitchNumber(state.kn, state.km) : 0));
    return {from: moving.from, to: moving.to, blend: blendAt(now), kept: [moving.kept.n, moving.kept.m, keptAt(now)], shape: shapeAt(now) / 100,
      reach: shaking ? 0 : Math.min(FARTHEST, REACH * drive / pace), shake: Math.min(SHAKIEST, SHAKE / pace) * Math.min(1, drive * 10), toss: shaking ? TOSS : 0, colours: coloursAt(now)};
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
    // away). Above that, fewer grains would buy little: what costs time then is painting the pixels.
    if (now - checkedAt >= 1000) {
      slowFor = now - checkedAt < 1500 && firstFrameAt < now - 2000 && fps() < 30 ? slowFor + 1 : 0;
      checkedAt = now;
      if (slowFor >= 3) { slowFor = 0; sand.fewer(); }
    }
  }

  /* ---------- labels ---------- */
  const presetNow = () => PRESETS.findIndex(set => set[0] === state.n && set[1] === state.m && set[2] === state.shape && (set[3] || 0) === state.kn && (set[4] || 0) === state.km);
  // On a plate: its name. Between two: how far towards the next.
  const shapeName = () => { const at = Math.floor(state.shape / 100), past = state.shape - at * 100; return past ? past + '% ' + PLATES[at + 1].name : PLATES[at].name; };
  let monitorTimer = 0, outputShown = 0;
  function label() {
    if (isOutput) return;
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      const on = presetNow();
      const values = {
        // (With a mode kept, each knob shows its own number and the kept one.)
        E1: {label: 'n', value: state.kn ? state.n + ' + ' + state.kn : String(state.n), pressed: !!state.kn}, E2: {label: 'm', value: state.km ? state.m + ' + ' + state.km : String(state.m)},
        // (For a moment after E3 is pressed its label says what the output now shows.)
        E3: performance.now() < outputShown ? {label: 'Output', value: OUTPUTS[state.output].name} : {label: 'Drive', value: state.drive + '%'}, E4: {label: 'Shape', value: shapeName()},
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
  // Takes what is valid from "value" (n, m, kn, km, drive, shape, palette, output) and leaves the rest as it is.
  function take(value) {
    if (!value) return;
    if (whole(value.n, LOW, HIGH)) state.n = value.n;
    if (whole(value.m, LOW, HIGH)) state.m = value.m;
    if ((whole(value.kn, LOW, HIGH) && whole(value.km, LOW, HIGH)) || (value.kn === 0 && value.km === 0)) { state.kn = value.kn; state.km = value.km; }
    if (whole(value.drive, 0, 100)) state.drive = value.drive;
    if (whole(value.shape, 0, LAST)) state.shape = value.shape;
    if (whole(value.palette, 0, PALETTES.length - 1)) state.palette = value.palette;
    if (whole(value.output, 0, OUTPUTS.length - 1)) state.output = value.output;
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { version = (await sdk.data.set('state', {v: 1, ...state}, version === undefined ? {} : {expectedVersion: version})).version; }
      catch (_) { try { version = (await sdk.data.get('state')).version; } catch (__) { /* best effort */ } }
    }, 800);
  }
  // Share link: v2.<n>.<m>.<drive>.<shape>.<palette>.<kept n>.<kept m> (0.0: one mode). v1 had no kept mode and two
  // plates. A link the App cannot read is ignored and it opens as saved.
  const SHARE = /^v([12])\.(\d{1,2})\.(\d{1,2})\.(\d{1,3})\.(\d{1,3})\.(\d)(?:\.(\d{1,2})\.(\d{1,2}))?$/;
  const shareState = () => ['v2', state.n, state.m, state.drive, state.shape, state.palette, state.kn, state.km].join('.');
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
    if (!found || (found[1] === '1') !== (found[7] === undefined)) return;
    const [n, m, drive, shape, palette, kn, km] = found.slice(2).map(text => Number(text || 0));
    const kept = (whole(kn, LOW, HIGH) && whole(km, LOW, HIGH)) || (kn === 0 && km === 0);
    if (whole(n, LOW, HIGH) && whole(m, LOW, HIGH) && whole(drive, 0, 100) && whole(shape, 0, found[1] === '1' ? 100 : LAST) && whole(palette, 0, PALETTES.length - 1) && kept) take({n, m, kn, km, drive, shape, palette});
  }
  function publish() {
    if (isOutput || !relay) return;
    try { relay.publish({v: 1, n: state.n, m: state.m, kn: state.kn, km: state.km, drive: state.drive, shape: state.shape, palette: state.palette, output: state.output, shaking, ms: glide}); } catch (_) { /* no output */ }
  }
  function send(event) {
    if (isOutput || !relay) return;
    try { relay.send({v: 1, ...event}); } catch (_) { /* no output */ }
  }
  function follow({kind, data} = {}) {
    if (!data || data.v !== 1) return;
    if (kind === 'event') {
      if (!sand) return;
      if (data.e === 'scatter' && Number.isFinite(data.seed)) sand.scatter(data.seed);
      if (data.e === 'flick' && Number.isFinite(data.x) && Number.isFinite(data.y)) sand.flick(clamp(data.x, 0, 1), clamp(data.y, 0, 1));
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
  // Something changed: the plate goes there in "ms", and the note, the labels, the saved copy, the share link and
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
  function flick(x, y) {
    if (sand) sand.flick(x, y);
    send({e: 'flick', x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000});
  }
  function shake(on) {
    if (shaking === on) return;
    shaking = on; label(); publish();
  }
  function nextPreset() {
    const [n, m, shape, kn = 0, km = 0] = PRESETS[(presetNow() + 1) % PRESETS.length];
    state.n = n; state.m = m; state.shape = shape; state.kn = kn; state.km = km;
    changed(PRESET_MS);
  }
  const TURNS = {
    E1: detents => { state.n = clamp(state.n + detents, LOW, HIGH); },
    E2: detents => { state.m = clamp(state.m + detents, LOW, HIGH); },
    E3: detents => { state.drive = clamp(state.drive + detents * DRIVE_STEP, 0, 100); },
    E4: detents => { state.shape = clamp(state.shape + detents * SHAPE_STEP, 0, LAST); },
  };
  const PRESSES = {
    // Keep: the mode as it stands goes on sounding while the knobs find a second one; pressed again it is let go.
    E1: () => { [state.kn, state.km] = state.kn ? [0, 0] : [state.n, state.m]; changed(); },
    E2: () => { state.palette = (state.palette + 1) % PALETTES.length; changed(); },
    // What a large output shows. (Without one there is nothing to choose.)
    E3: () => { if (!relay) return; state.output = (state.output + 1) % OUTPUTS.length; outputShown = performance.now() + 1600; setTimeout(label, 1650); changed(); },
    // Between two plates: to the nearer one. On a plate: to the next, and from the last back to the first.
    E4: () => { const near = Math.round(state.shape / 100) * 100; state.shape = state.shape !== near ? near : near === LAST ? 0 : near + 100; changed(JUMP_MS); },
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
      // K3 held keeps the plate shaking; let go, the sand gathers.
      if (control === 'K3') shake(false);
    }
  }
  // A tap knocks the sand away from under the finger; a finger drawn across the plate ploughs through it.
  function touch() {
    const stage = $('stage');
    let finger = null;
    const knock = (event, first) => {
      const at = sand ? sand.place(event.clientX, event.clientY) : null, now = performance.now();
      if (!at || (!first && now - finger.at < 70 && Math.hypot(at[0] - finger.x, at[1] - finger.y) < 0.05)) return;
      finger.at = now; finger.x = at[0]; finger.y = at[1];
      flick(at[0], at[1]);
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
      second: state.kn ? Math.round(hertzOf(state.kn, state.km) * 100) / 100 : 0, audible: tone ? tone.audible : false, listening: ear ? ear.listening : false,
      side: sand ? sand.side : 0, size: sand ? sand.size : [0, 0], origin: sand ? sand.origin : [0, 0], tiles: sand ? sand.tiles : 0, changedAt, tunedAt};
  };
  window.__chladni = {
    role: isOutput ? 'output' : 'control',
    get firstFrameAt() { return firstFrameAt; },
    state: () => ({n: state.n, m: state.m, drive: state.drive / 100, shape: state.shape / 100, palette: PALETTES[state.palette].name, output: OUTPUTS[state.output].name,
      kept: state.kn ? [state.kn, state.km] : null, sound: mode === 'sound', listen: mode === 'listen', heard: heard === null ? null : noteName(LOWEST_HZ * 2 ** (heard / 12)), shaking, preset: presetNow() + 1,
      shapeNow: Math.round(shapeAt(performance.now())) / 100, note: noteName(hertz())}),
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
    try { const saved = await sdk.data.get('state'); version = saved.version; if (saved.value?.v === 1) take(saved.value); } catch (_) { /* first run */ }
    applyShare(context.share);
    arrive(0);
    tone = new window.Tone({sdk, onChange: toneChanged});
    ear = new window.Ear({sdk, onPitch, onChange: earChanged});
    build(); label();
    // The plate and its sand at once, before the first animation frame: a host may keep the App hidden until it is ready.
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
