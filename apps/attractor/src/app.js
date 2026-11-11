// app.js: the App around the picture. Knobs and keys, touch, the text on the device screen, the Figures and Player
// panels and the speaker, the show, saved settings, the share link and the large output live here. The formulas are in formulas.js;
// how they are drawn is in picture.js (and thread.js for a flow's line); the music is in music.js and tracks.js.
(() => {
  'use strict';
  const sdk = window.VrchApp, FORMULAS = window.Formulas, Picture = window.Picture, TRACKS = window.Tracks || [];
  let context = {};
  try { context = sdk.context; } catch (_) { /* defaults */ }
  // Output role: a picture-only instance (a large or second screen). It reads no controls, saves nothing, makes and
  // hears no sound and shows no text. The controlling instance tells it the formula, letters and view, and it
  // gathers the same points itself.
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
  const HOLD_MS = 500;                    // a key held this long does its second job
  const DRIFT = 7;                        // each letter sways this far (hundredths) either way,
  const DRIFT_SECONDS = [23, 31, 41, 53]; // each at its own pace
  const TURN_SECONDS = 40;                // a spinning figure turns once in this time
  const DEPTH = 0.6;                      // how deep a map is drawn, as a share of its width
  const TILT = 1;                         // the view tilts this far up or down at most (radians)
  const PUSH = 12;                        // sound moves a letter this far at most (hundredths)
  const KICK = 6;                         // and a sudden swell knocks d this far, then lets it come back
  const ROOM = 1.06;                      // on an output wider than tall the figure is drawn this much larger, to fill the height
  const STRING_MS = 800;                  // while its letters move, a flow's line is strung again no sooner than this, on a beat if there is one,
  const STRING_LONGEST_MS = 1500;         // and no later than this
  // The show: the figure performs by itself. It turns and tilts, the letters sway, sound moves them, and every so
  // often it slides to the next figure of the formula, or moves on to the next formula and colours.
  const SHOW_ORDER = ['dejong', 'lorenz', 'clifford', 'aizawa', 'svensson', 'thomas', 'dream', 'mira', 'ikeda'];
  const SHOW_SCENES = 3;                  // figures of one formula before the show moves to the next formula
  const SHOW_GLIDE_MS = 4000;             // in the show the letters slide this long to the next figure
  const SHOW_SHORTEST_MS = 9000;          // a scene lasts at least this long;
  const SHOW_BEATS = 48;                  // with music it ends where the piece changes, or after this many beats;
  const SHOW_SCENE_MS = 20000;            // without music it lasts this long
  const SWAY = 0.3;                       // in the show the view tilts this far up and down (radians),
  const SWAY_SECONDS = 67;                // once in this time
  const ZOOM = 1.5;                       // on an output the show draws the figure up to this much larger, past the edges,
  const ZOOM_SECONDS = 53;                // and back to whole once in this time
  const ZOOM_EASE_MS = 1500;              // when the show stops the figure comes back to whole in this time

  /* ---------- settings ---------- */
  // Letters are whole hundredths (149 is 1.49), so a hundred small turns add up exactly.
  // glide: the letters are sliding from "from" (since "at", for "ms") to p. drift: when the sway began, or 0.
  // show: when the show began, or 0. zoom: the show has stopped, and the figure is coming back from this size since
  // "at". view: where the figure is seen from. spin: it keeps turning, since "at", one way (1) or the other (-1).
  // Times are on the wall clock, so the output moves with the device.
  const hundredths = list => list.map(v => Math.round(v * 100));
  const motion = {formula: 0, p: hundredths(FORMULAS[0].presets[0]), glide: null, drift: 0, show: 0, zoom: null, view: {yaw: 0, pitch: 0, spin: null}};
  let palette = 0, textShown = true, preset = 0;
  const coarse = [false, false, false, false];
  // What sound adds to the letters (hundredths), and until when it counts. The device works it out from what it
  // hears; an output is sent it.
  const heard = [0, 0, 0, 0];
  let heardUntil = 0;
  const limits = () => FORMULAS[motion.formula].range.map(v => Math.round(v * 100));
  // The letters at a moment, before drift and sound are added.
  function settled(at) {
    const g = motion.glide;
    if (!g) return motion.p;
    const u = clamp((at - g.at) / (g.ms || GLIDE_MS), 0, 1), ease = u * u * (3 - 2 * u);
    return motion.p.map((v, i) => g.from[i] + (v - g.from[i]) * ease);
  }
  const gliding = at => !!motion.glide && at < motion.glide.at + (motion.glide.ms || GLIDE_MS);
  // calm: how much of the sway and of what sound adds is let through (0 to 1). These figures live at the edge of
  // falling in on themselves, and a letter moved a little too far leaves a few dots: the device watches the figure
  // while it performs, and when it thins out the sway is calmed, at once and for as long as this figure stays.
  const calm = {now: 1, to: 1, most: 1, askedAt: 0, seen: 0, renewedAt: 0};
  // (And each letter takes only the share of it that its formula allows.)
  const share = i => calm.now * ((FORMULAS[motion.formula].sway || [])[i] ?? 1);
  const swayed = (list, at) => { const [lo, hi] = limits(), seconds = (at - motion.drift) / 1000; return list.map((v, i) => clamp(v + share(i) * DRIFT * Math.sin(2 * Math.PI * seconds / DRIFT_SECONDS[i]), lo, hi)); };
  const hearing = at => at < heardUntil && heard.some(v => v !== 0);   // (a still figure follows no sound)
  function lettersAt(at) {
    const [lo, hi] = limits();
    let list = settled(at);
    if (motion.drift) list = swayed(list, at);
    if (hearing(at)) list = list.map((v, i) => clamp(v + share(i) * heard[i], lo, hi));
    return list;
  }
  // The letters the picture is drawn with. A map takes them as they are. A flow is drawn as a line, and the far end
  // of that line lands somewhere else for the smallest change of a letter: followed frame by frame it would only
  // blur. So while its letters move by themselves the line is strung again in steps, on the beat, and stands clear
  // in between. A knob in the hand is followed at once. An output is told the letters the device strung.
  let strung = null, beat = false, handsAt = 0, drawn = motion.p;
  function drawnAt(at) {
    const now = lettersAt(at);
    if (isOutput) return strung && strung.formula === motion.formula && at < strung.until ? strung.list : now;
    if (!FORMULAS[motion.formula].flow) { strung = {formula: motion.formula, list: now, at}; return now; }
    const since = strung && strung.formula === motion.formula ? at - strung.at : Infinity;
    const byItself = (!!motion.drift || gliding(at) || hearing(at)) && at - handsAt > 300;
    if (!byItself || since >= STRING_LONGEST_MS || (beat && since >= STRING_MS)) { strung = {formula: motion.formula, list: now, at}; beat = false; }
    return strung.list;
  }
  // The view at a moment, as picture.js takes it: across, down, away, how large the figure is drawn, and how deep a
  // map is. On the device a turned figure is drawn smaller so that it stays inside the picture. An output is mostly
  // wider than tall: there the figure fills the height, a turned figure only shrinks for the side that has no room,
  // and in the show it slowly grows past the edges and comes back.
  const yawAt = at => { const s = motion.view.spin; return motion.view.yaw + (s ? s.dir * 2 * Math.PI * (at - s.at) / 1000 / TURN_SECONDS : 0); };
  const pitchAt = at => clamp(motion.view.pitch + (motion.show ? SWAY * Math.sin(2 * Math.PI * (at - motion.show) / 1000 / SWAY_SECONDS) : 0), -TILT, TILT);
  function zoomAt(at) {
    if (motion.show) return 1 + (ZOOM - 1) * (0.5 - 0.5 * Math.cos(2 * Math.PI * (at - motion.show) / 1000 / ZOOM_SECONDS));
    const z = motion.zoom, u = z ? clamp((at - z.at) / ZOOM_EASE_MS, 0, 1) : 1;
    return z ? z.from + (1 - z.from) * u * u * (3 - 2 * u) : 1;
  }
  // How an output shows the figure. Whole: the one figure. Three: it and, at its sides, the same figure seen from
  // two other sides, smaller and fainter. Mirror: it and its mirror image side by side, overlapping, and again
  // where there is room. Close: so near that it fills the longer side and runs past the shorter one.
  // The device's own screen always shows the one whole figure.
  const LAYOUTS = ['Whole', 'Three', 'Mirror', 'Close'];
  let arrange = 0;
  let room = null;   // an output: how much wider and taller the stage is than its shorter side, and how much larger the figure may be
  function lookAt(at) {
    const formula = FORMULAS[motion.formula], yaw = yawAt(at), pitch = pitchAt(at), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const deep = formula.flow ? 1 : formula.deep ?? DEPTH;
    const from = angle => { const c = Math.cos(angle), s = Math.sin(angle); return [c, 0, s, sp * s, cp, -sp * c, -cp * s, sp, cp * c]; };
    const c = Math.cos(yaw), s = Math.sin(yaw), main = from(yaw);
    const wide = formula.flow ? 1 : Math.abs(c) + deep * Math.abs(s), tall = formula.flow ? Math.abs(sp) + Math.abs(cp) : Math.abs(sp * s) + Math.abs(cp) + deep * Math.abs(sp * c);
    if (!room) return [...main, 1 / Math.max(1, wide, tall), deep];
    const whole = Math.min(room[0] * room[2] / wide, room[1] * room[2] / tall), zoom = zoomAt(at);
    // Along the longer side of the screen, which runs from -1 to 1, a figure drawn at size 1 reaches "unit" each way.
    const across = room[0] >= room[1], unit = Picture.FIT / Math.max(room[0], room[1]), place = v => across ? [v, 0] : [0, v];
    if (arrange === 1) {
      // The figure in the middle, as large as leaves room for two at its sides.
      let size = whole, small = (0.98 / (unit * size) - 0.92) / 1.92;
      if (small < 0.55) { small = 0.55; size = 0.98 / (unit * (0.92 * 1.55 + 0.55)); }
      small = Math.min(small, 0.85); size *= 1 + 0.3 * (zoom - 1);
      const reach = unit * size, off = 0.92 * reach * (1 + small), count = small < 0.72 ? 0.25 : 0.5;
      const sides = [-1, 1].flatMap(way => { const m = from(yaw + way * 2 * Math.PI / 3); return [...m.slice(0, 6), small, ...place(way * off), count]; });
      return [...main, size, deep, 0, 0, 1, 2, ...sides];
    }
    if (arrange === 2) {
      // Each figure is the mirror image of its neighbours: one pair, or two where the screen is wide enough.
      let size = whole * (1 + 0.3 * (zoom - 1)), reach = unit * size, step = 0.6 * reach;
      if (step + reach > 1.02) { size *= 1.02 / (step + reach); reach = unit * size; step = 0.6 * reach; }
      const flipped = across ? [-main[0], -main[1], -main[2], main[3], main[4], main[5]] : [main[0], main[1], main[2], -main[3], -main[4], -main[5]];
      const copies = [[...flipped, 1, ...place(step), 1]];
      if (3 * step + 0.8 * reach <= 1) copies.push([...main.slice(0, 6), 1, ...place(3 * step), 0.5], [...flipped, 1, ...place(-3 * step), 0.5]);
      return [...main, size, deep, ...place(-step), 1, copies.length, ...copies.flat()];
    }
    if (arrange === 3) {
      // (A figure does not quite fill the square it is given: a little closer still, and it reaches the edges.)
      const size = Math.max(whole, 1.15 * Math.max(room[0] / wide, room[1] / tall) * (1 + 0.4 * (zoom - 1)));
      return [...main, size, deep, 0, 0, Math.min(6, (size / whole) ** 2), 0];
    }
    return [...main, whole * zoom, deep];
  }
  let dragging = false;
  const inMotion = at => !!motion.drift || gliding(at) || hearing(at) || !!motion.view.spin || dragging || (!!room && !!motion.zoom && at < motion.zoom.at + ZOOM_EASE_MS);
  const presetNow = () => FORMULAS[motion.formula].presets.findIndex(set => hundredths(set).every((v, i) => v === motion.p[i]));
  const valid = (list, lo, hi) => Array.isArray(list) && list.length === 4 && list.every(v => Number.isFinite(v) && v >= lo && v <= hi);
  const degrees = radians => Math.round(radians * 180 / Math.PI);

  /* ---------- the picture ---------- */
  // told: an output draws nothing until the device has said which figure to draw.
  let picture = null, firstFrameAt = null, twoMillionAt = null, lastNow = -1, told = !isOutput, aim = null;
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
    const box = $('stage'), w = box.clientWidth, h = box.clientHeight, side = Math.min(w, h);
    room = isOutput && side > 0 ? [w / side, h / side, Math.min(ROOM, Math.max(w, h) / side)] : null;
    if (picture) picture.resize(w, h, devicePixelRatio || 1);
  }
  function step(now) {
    const at = epoch();
    if (motion.glide && !gliding(at)) motion.glide = null;
    // An output hears of a dragged view some twenty times a second and eases towards it.
    if (aim) { const v = motion.view; v.yaw += (aim.yaw - v.yaw) * 0.35; v.pitch += (aim.pitch - v.pitch) * 0.35; if (Math.abs(aim.yaw - v.yaw) + Math.abs(aim.pitch - v.pitch) < 1e-4) { v.yaw = aim.yaw; v.pitch = aim.pitch; aim = null; } }
    if (!isOutput) { if (player) player.follow(now); direct(at); watch(at); }
    drawn = drawnAt(at);
    const letters = drawn.map(v => v / 100);
    let added = 0;
    if (picture && told) {
      try { picture.set(motion.formula, letters, inMotion(at) || !!aim, lookAt(at)); picture.frame(now); added = picture.added; }
      catch (error) { console.error(error); picture = null; $('notice').hidden = false; }
      if (picture && firstFrameAt === null && picture.points > 0) firstFrameAt = performance.now();
      if (picture && twoMillionAt === null && picture.points >= 2e6) twoMillionAt = performance.now();
    }
    log.push([now, added]);
    while (log.length > 2 && now - log[0][0] > 1000) log.shift();
    if (isOutput) return;
    write(letters); send(); sendLine();
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
      quality: picture ? Math.round(picture.quality * 100) / 100 : 0,
      lined: picture ? picture.lined : false, fit: Math.round(lookAt(epoch())[9] * 1000) / 1000, copies: lookAt(epoch())[14] || 0,
    };
  }

  /* ---------- text on the device screen ---------- */
  let wrote = '', said = '', saidTimer = 0;
  const two = v => (Math.round(v * 100) / 100).toFixed(2);
  // A short message under the text, gone after a few seconds.
  function say(text, keep = false) {
    clearTimeout(saidTimer);
    said = text;
    if (text && !keep) saidTimer = setTimeout(() => { said = ''; }, 4500);
  }
  function write(letters) {
    const flagged = !!picture && picture.collapsed === true && picture.mode === 'still';
    // (With the text hidden only a message shows: the picture is left clear.)
    const status = [textShown && player && player.source === 'music' && !player.muted ? player.title : '', textShown && player && player.source === 'input' && player.listening ? 'listening' : '', said].filter(Boolean).join(' · ');
    const next = [motion.formula, textShown, flagged, status, letters.map(two).join(' '), picture ? picture.points : 0].join('|');
    if (next === wrote) return;
    wrote = next;
    const formula = FORMULAS[motion.formula];
    $('corner').hidden = !textShown && !status && !flagged;
    $('text').hidden = !textShown;
    $('lines').textContent = formula.text.join('\n');
    $('letters').textContent = 'abcd'.split('').map((name, i) => name + '=' + two(letters[i])).join('  ');
    $('count').textContent = 'n = ' + (picture ? picture.points : 0).toLocaleString('en-US');
    $('status').textContent = status; $('status').hidden = !status;
    $('flag').hidden = !flagged;
  }
  let monitorTimer = 0;
  function label() {
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      const formula = FORMULAS[motion.formula], on = presetNow(), values = {};
      'abcd'.split('').forEach((name, i) => { values['E' + (i + 1)] = {label: name, value: two(motion.p[i] / 100) + (coarse[i] ? ' ×10' : '')}; });
      if (panel) values.E1 = {label: 'Choose', value: ''};
      values.K2 = {label: 'Next', value: (on < 0 ? '–' : on + 1) + '/' + formula.presets.length};
      values.K3 = {label: panel === 'figures' ? 'Close' : 'Figures', value: '', pressed: panel === 'figures'};
      values.K4 = {label: panel === 'player' ? 'Close' : 'Player', value: '', pressed: panel === 'player'};
      try { void sdk.monitor.set(values).catch(() => {}); } catch (_) { /* unavailable */ }
    }, 40);
  }

  /* ---------- saved settings, the share link and the output ---------- */
  let version, saveTimer = 0, shareTimer = 0, publishTimer = 0, shared = '', sent = '', sentLine = '';
  // What the show and the sound were set to when the App last closed. A share link opens its one figure still
  // without changing how the App opens by itself, unless the show is then set by hand.
  const kept = {show: 'auto', source: TRACKS.length ? 'music' : 'silent', track: 0, muted: false};
  const lent = {show: false};
  function restore(value) {
    if (!value || value.v !== 1) return;
    const index = FORMULAS.findIndex(f => f.id === value.formula);
    if (index >= 0) {
      const [lo, hi] = FORMULAS[index].range.map(v => Math.round(v * 100));
      if (valid(value.p, lo, hi)) { motion.formula = index; motion.p = value.p.map(Math.round); }
    }
    if (Number.isInteger(value.palette) && value.palette >= 0 && value.palette < PALETTES.length) palette = value.palette;
    if (Number.isFinite(value.yaw) && Number.isFinite(value.pitch)) { motion.view.yaw = value.yaw; motion.view.pitch = clamp(value.pitch, -TILT, TILT); }
    if (value.spin === 1 || value.spin === -1) motion.view.spin = {at: epoch(), dir: value.spin};
    textShown = value.text !== false;
    if (['auto', 'hold', 'still'].includes(value.show)) kept.show = value.show;
    if (['music', 'input', 'silent'].includes(value.source) && (value.source !== 'music' || TRACKS.length)) kept.source = value.source;
    if (Number.isInteger(value.track) && TRACKS[value.track]) kept.track = value.track;
    if (Number.isInteger(value.layout) && LAYOUTS[value.layout]) arrange = value.layout;
    kept.muted = value.muted === true;
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const value = {v: 1, formula: FORMULAS[motion.formula].id, p: motion.p, palette, text: textShown, yaw: yawAt(epoch()) % (2 * Math.PI), pitch: motion.view.pitch, spin: motion.view.spin ? motion.view.spin.dir : 0,
        layout: arrange, show: lent.show ? kept.show : show.mode, source: player ? player.source : kept.source, track: player ? player.index : kept.track, muted: player ? player.muted : kept.muted};
      try { version = (await sdk.data.set('state', value, version === undefined ? {} : {expectedVersion: version})).version; }
      catch (_) { try { version = (await sdk.data.get('state')).version; } catch (__) { /* best effort */ } }
    }, 800);
  }
  // Share link: v2.<formula id>.<a x 100>.<b x 100>.<c x 100>.<d x 100>.<colours>.<turn in degrees>.<tilt in degrees>.
  // (v1 had no view.) A link the App cannot read is ignored and it opens as saved.
  const SHARE = /^v[12]\.([a-z0-9-]{1,24})\.(-?\d{1,3})\.(-?\d{1,3})\.(-?\d{1,3})\.(-?\d{1,3})\.(\d)(?:\.(\d{1,3})\.(-?\d{1,2}))?$/;
  const shareState = () => ['v2', FORMULAS[motion.formula].id, ...motion.p, palette, ((degrees(motion.view.yaw) % 360) + 360) % 360, degrees(motion.view.pitch)].join('.');
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
  // A link shows one figure: it opens still, seen as it was shared.
  function applyShare(share) {
    const m = SHARE.exec(typeof share?.state === 'string' ? share.state : '');
    if (!m) return false;
    const index = FORMULAS.findIndex(f => f.id === m[1]), p = m.slice(2, 6).map(Number), colours = Number(m[6]);
    if (index < 0 || colours >= PALETTES.length) return false;
    const [lo, hi] = FORMULAS[index].range.map(v => Math.round(v * 100));
    if (!valid(p, lo, hi)) return false;
    motion.formula = index; motion.p = p; motion.glide = null; motion.drift = 0; palette = colours;
    motion.view = {yaw: (Number(m[7]) || 0) * Math.PI / 180, pitch: clamp((Number(m[8]) || 0) * Math.PI / 180, -TILT, TILT), spin: null};
    return true;
  }
  function publish() {
    if (isOutput || !relay) return;
    clearTimeout(publishTimer); publishTimer = 0;
    try { relay.publish({v: 1, f: FORMULAS[motion.formula].id, p: motion.p, g: motion.glide, drift: motion.drift, s: motion.show, z: motion.zoom, l: arrange, c: palette, w: [motion.view.yaw, motion.view.pitch, motion.view.spin]}); } catch (_) { /* no output */ }
  }
  // What sound adds goes to the output as it changes, frame by frame.
  function send() {
    if (!relay) return;
    const now = hearing(epoch()) ? heard.join() : '';
    if (now === sent) return;
    sent = now;
    try { relay.send({v: 1, o: now ? heard.slice() : [0, 0, 0, 0]}); } catch (_) { /* no output */ }
  }
  // The letters the device draws with go to the output as they change, so that both show the very same figure:
  // a flow's line strung with the same letters, and a sway calmed by the same amount.
  function sendLine() {
    if (!relay) return;
    const now = strung ? strung.formula + ':' + strung.list.join() : '';
    if (now === sentLine) return;
    sentLine = now;
    if (strung) try { relay.send({v: 1, f: FORMULAS[strung.formula].id, l: strung.list}); } catch (_) { /* no output */ }
  }
  function follow({kind, data} = {}) {
    if (!data || data.v !== 1) return;
    if (kind === 'event') {
      if (valid(data.o, -100, 100)) { for (let i = 0; i < 4; i++) heard[i] = data.o[i]; heardUntil = epoch() + 400; }
      const line = FORMULAS.findIndex(f => f.id === data.f);
      if (line >= 0 && valid(data.l, -1000, 1000)) strung = {formula: line, list: data.l, at: epoch(), until: epoch() + 2500};
      return;
    }
    if (kind !== 'state') return;
    const index = FORMULAS.findIndex(f => f.id === data.f);
    if (index < 0) return;
    const [lo, hi] = FORMULAS[index].range.map(v => Math.round(v * 100));
    if (!valid(data.p, lo, hi)) return;
    const first = !told;
    motion.formula = index; motion.p = data.p; told = true;
    motion.glide = data.g && valid(data.g.from, lo, hi) && Number.isFinite(data.g.at) ? {from: data.g.from, at: data.g.at, ms: Number.isFinite(data.g.ms) ? clamp(data.g.ms, 100, 20000) : GLIDE_MS} : null;
    motion.drift = Number.isFinite(data.drift) ? data.drift : 0;
    motion.show = Number.isFinite(data.s) ? data.s : 0;
    arrange = Number.isInteger(data.l) && LAYOUTS[data.l] ? data.l : 0;
    motion.zoom = data.z && Number.isFinite(data.z.from) && Number.isFinite(data.z.at) ? {from: clamp(data.z.from, 1, ZOOM), at: data.z.at} : null;
    if (Array.isArray(data.w) && Number.isFinite(data.w[0]) && Number.isFinite(data.w[1])) {
      const spin = data.w[2] && Number.isFinite(data.w[2].at) && Math.abs(data.w[2].dir) === 1 ? {at: data.w[2].at, dir: data.w[2].dir} : null, to = {yaw: data.w[0], pitch: clamp(data.w[1], -TILT, TILT)};
      if (spin || first) { motion.view = {...to, spin}; aim = null; } else { motion.view.spin = null; aim = to; }
    }
    if (Number.isInteger(data.c) && data.c >= 0 && data.c < PALETTES.length && data.c !== palette) { palette = data.c; if (picture) picture.colours(PALETTES[palette].stops); }
  }
  // Something changed: the labels, the saved copy, the share link and the output all follow.
  function changed() { label(); saveSoon(); shareSoon(); publish(); }

  /* ---------- the figure follows sound ---------- */
  // music.js hands over the sound 20 ms at a time, as loudness in three bands (low, middle, high), whether it comes
  // from the App's music or the audio input. Each band's swell and fall sways a, b and c; a sudden swell in any band
  // knocks d, which then returns.
  let player = null;
  const fresh = () => ({bands: [0, 1, 2].map(() => ({top: 0, level: 0, mean: 0, last: 0})), since: 99, knocks: 0, kick: 0});
  let ears = fresh();
  const tidy = v => Math.abs(v) < 0.05 ? 0 : Math.round(v * 10) / 10;
  function hear(loud) {
    if (show.mode === 'still') return;
    let rise = 0;
    for (let i = 0; i < 3; i++) {
      const band = ears.bands[i];
      band.top = Math.max(loud[i], band.top * 0.9975);   // the loudest of the last few seconds: quiet and loud sound move the figure alike
      const now = band.top > 0.0005 ? loud[i] / band.top : 0;
      rise += Math.max(0, now - band.last); band.last = now;
      band.level += (now - band.level) * (now > band.level ? 0.35 : 0.08);
      band.mean += (band.level - band.mean) * 0.01;
      heard[i] = tidy(clamp(2 * PUSH * (band.level - band.mean), -PUSH, PUSH));
    }
    ears.since++;
    if (rise > 0.5 && ears.since >= 9) { ears.since = 0; ears.knocks++; ears.kick += ears.knocks % 2 ? KICK : -KICK; beat = true; }
    ears.kick *= 0.94;
    heard[3] = tidy(ears.kick);
    heardUntil = epoch() + 300;
  }
  function deaf() { ears = fresh(); heardUntil = 0; for (let i = 0; i < 4; i++) heard[i] = 0; }
  // The sound has changed in some way: the speaker, the panel and the labels follow.
  let source = 'silent';
  function soundChanged() {
    if (player.source !== source) { source = player.source; deaf(); }
    if (player.said) { say(player.said); player.said = ''; }
    renderSpeaker(); renderPanel(); label();
  }
  function setSource(next) {
    void player.setSource(next);
    saveSoon();
  }

  /* ---------- the show ---------- */
  // Three ways to be. auto: the figure performs by itself (it turns and tilts, its letters sway, sound moves them)
  // and goes on to new figures. hold: it performs, and stays on this figure. still: it rests, and sharpens.
  // A knob turned or a figure chosen during auto holds: the show never changes what a hand has just set.
  // scene: how many figures the show has shown. changedAt: when the last one began. due: the music has moved on,
  // so the next figure may come. next: where each formula was left.
  const show = {mode: 'still', scene: 0, changedAt: 0, due: false, next: {}};
  const ORDER = [...SHOW_ORDER.map(id => FORMULAS.findIndex(f => f.id === id)).filter(i => i >= 0), ...FORMULAS.map((f, i) => i).filter(i => !SHOW_ORDER.includes(FORMULAS[i].id))];
  function setMode(next) {
    const at = epoch(), was = show.mode !== 'still', will = next !== 'still';
    show.mode = next;
    if (will && !was) { motion.show = at; motion.zoom = null; setDrift(true); setSpin(motion.view.spin?.dir || 1); }
    if (!will && was) { motion.view.pitch = pitchAt(at); motion.zoom = {from: zoomAt(at), at}; motion.show = 0; setDrift(false); setSpin(0); deaf(); }
    if (next === 'auto') { show.changedAt = at; show.due = false; }
  }
  function chooseMode(next) { lent.show = false; if (next !== show.mode) setMode(next); renderPanel(); changed(); }
  // A hand has set something: the show leaves it be.
  function hold() { if (show.mode === 'auto') { lent.show = false; setMode('hold'); renderPanel(); } }
  // Twice a second while the figure performs: has it thinned out to a few dots? Then less sway, at once, and no
  // more than a good part of that for as long as this figure stays. Otherwise the sway comes back little by little.
  const THIN = 40;                // a figure that fills fewer of the 4096 cells than this has fallen in on itself
  const RENEW_MS = 6000;          // while it performs, the figure's points start afresh this often,
  const RENEW_SOONEST_MS = 1500;  // or this soon after the last time when it has thinned out
  function watch(at) {
    calm.now += (calm.to - calm.now) * 0.2;
    if (show.mode === 'still' || !picture || at - calm.askedAt < 500) return;
    calm.askedAt = at;
    const touched = picture.sample();
    if (touched === null) return;
    calm.seen = touched;
    // Points that a figure has lost for good come back when all start afresh: now and then anyway, and at once when
    // the figure has thinned out.
    if (at - calm.renewedAt > (touched < THIN ? RENEW_SOONEST_MS : RENEW_MS)) { calm.renewedAt = at; picture.renew(); }
    if (touched < THIN) { if (calm.to > 0.05) { calm.most = Math.max(0.05, 0.6 * calm.to); calm.to = 0.5 * calm.most; } }
    else calm.to = Math.min(calm.most, calm.to + 0.04);
  }
  // Another figure: the sway may come back in full.
  const anew = () => { calm.most = 1; };
  // Each frame: is it time for the next figure?
  function direct(at) {
    if (show.mode !== 'auto' || dragging) return;
    const since = at - show.changedAt, longest = player && player.source === 'music' ? SHOW_BEATS * player.beat() * 1000 : SHOW_SCENE_MS;
    if (!(since >= longest || (show.due && since >= SHOW_SHORTEST_MS))) return;
    show.scene++; show.changedAt = at; show.due = false;
    const formula = FORMULAS[motion.formula], on = presetNow();
    if (show.scene % SHOW_SCENES === 0 && ORDER.length > 1) {
      show.next[motion.formula] = ((on < 0 ? preset : on) + 1) % formula.presets.length;
      const to = ORDER[(ORDER.indexOf(motion.formula) + 1) % ORDER.length];
      goFormula(to, show.next[to] || 0);
      palette = (palette + 1) % PALETTES.length;
      if (picture) picture.colours(PALETTES[palette].stops);
    } else glideTo(((on < 0 ? preset : on) + 1) % formula.presets.length, SHOW_GLIDE_MS);
    renderPanel(); label(); shareSoon(); publish();
  }

  /* ---------- controls ---------- */
  const held = {}, turnedAt = [0, 0, 0, 0], twirl = [0, 0, 0, 0];
  // One detent is 0.01, or 0.10 after a press. A sustained fast spin (several detents under 40 ms apart) covers more
  // ground; a slow turn is always one step.
  function turn(knob, detents) {
    const now = performance.now(), gap = now - turnedAt[knob], [lo, hi] = limits();
    turnedAt[knob] = now;
    twirl[knob] = gap < 40 ? twirl[knob] + 1 : 0;
    const size = (coarse[knob] ? 10 : 1) * (twirl[knob] >= 8 ? 4 : twirl[knob] >= 4 ? 2 : 1);
    if (motion.glide) { motion.p = settled(epoch()).map(Math.round); motion.glide = null; }
    motion.p = motion.p.slice();
    motion.p[knob] = clamp(motion.p[knob] + detents * size, lo, hi);
    handsAt = epoch(); anew();
    hold(); renderPanel(); changed();
  }
  function glideTo(index, ms) {
    const formula = FORMULAS[motion.formula], at = epoch();
    preset = index; anew();
    motion.glide = {from: settled(at).slice(), at, ms};
    motion.p = hundredths(formula.presets[preset]);
  }
  function goFormula(index, first) {
    motion.formula = index; preset = first % FORMULAS[index].presets.length; anew();
    motion.p = hundredths(FORMULAS[index].presets[preset]); motion.glide = null;
  }
  // Chosen by hand: a preset of this formula (the letters glide there), or another formula at its first preset.
  function choosePreset(index) { hold(); glideTo(index, GLIDE_MS); renderPanel(); changed(); }
  function chooseFormula(index) { hold(); if (index !== motion.formula) goFormula(index, 0); renderPanel(); changed(); }
  // K2: the next figure. After a formula's last preset comes the next formula's first.
  function nextFigure() {
    const formula = FORMULAS[motion.formula], on = presetNow(), next = (on < 0 ? preset : on) + 1;
    if (next < formula.presets.length) choosePreset(next); else chooseFormula((motion.formula + 1) % FORMULAS.length);
  }
  function chooseColours(index) {
    palette = index;
    if (picture) picture.colours(PALETTES[palette].stops);
    renderPanel(); changed();
  }
  // Spin: the figure keeps turning. Drift: each letter sways a little around where it stands. Turning either off
  // leaves things where they are.
  function setSpin(dir) {
    const at = epoch();
    motion.view.yaw = yawAt(at) % (2 * Math.PI);
    motion.view.spin = dir ? {at, dir} : null;
  }
  function setDrift(on) {
    const at = epoch();
    if (!on && motion.drift) { motion.p = swayed(settled(at), at).map(Math.round); motion.glide = null; }
    motion.drift = on ? motion.drift || at : 0;
  }
  // Keys act when they are let go. With a panel open, E1 moves through its choices and a press of E1 takes one.
  const KEYS = {K2: nextFigure, K3: () => openPanel(panel === 'figures' ? null : 'figures'), K4: () => openPanel(panel === 'player' ? null : 'player')};
  function onControl(event) {
    const control = event.control, knob = ['E1', 'E2', 'E3', 'E4'].indexOf(control);
    if (player) player.wake();
    if (event.type === 'rotate') {
      const detents = Math.trunc(Number(event.delta) || 0);
      if (!detents || knob < 0) return;
      if (panel && knob === 0) panelStep(detents); else turn(knob, detents);
    } else if (event.type === 'down') {
      if (held[control]) return;
      held[control] = true;
      if (knob < 0) return;
      if (panel && knob === 0) panelPress(); else { coarse[knob] = !coarse[knob]; label(); }
    } else if (event.type === 'up' || event.type === 'cancel') {
      if (!held[control]) return;
      held[control] = false;
      if (event.type === 'up' && KEYS[control]) KEYS[control]();
    }
  }
  // Touch: a tap opens Player; a drag turns the figure; letting go while still moving sets it spinning.
  function touch() {
    const stage = $('stage');
    let finger = null;
    stage.addEventListener('pointerdown', event => {
      // (A new touch always starts afresh: the end of the one before may never have arrived.)
      dragging = false;
      finger = {id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, at: performance.now(), movedAt: 0, speed: 0, spun: 0};
      try { stage.setPointerCapture(event.pointerId); } catch (_) { /* a pointer sent by the host */ }
      if (player) player.wake();
    });
    addEventListener('pointermove', event => {
      if (!finger || event.pointerId !== finger.id) return;
      if (!dragging && Math.hypot(event.clientX - finger.x, event.clientY - finger.y) < 6) return;
      const now = performance.now(), perPixel = Math.PI / Math.max(120, Math.min(stage.clientWidth, stage.clientHeight));
      if (!dragging) { dragging = true; finger.spun = motion.view.spin?.dir || 0; setSpin(0); finger.lastX = event.clientX; finger.lastY = event.clientY; finger.movedAt = now; }
      const dx = event.clientX - finger.lastX, dy = event.clientY - finger.lastY;
      finger.speed = 0.6 * finger.speed + 0.4 * dx / Math.max(1, now - finger.movedAt);
      finger.lastX = event.clientX; finger.lastY = event.clientY; finger.movedAt = now;
      motion.view.yaw += dx * perPixel; motion.view.pitch = clamp(motion.view.pitch + dy * perPixel, -TILT, TILT);
      if (!publishTimer) publishTimer = setTimeout(publish, 50);
    });
    const lift = event => {
      if (!finger || event.pointerId !== finger.id) return;
      const was = finger, now = performance.now();
      finger = null;
      if (!dragging) { if (event.type === 'pointerup' && now - was.at < 500 && !panel) openPanel('player'); return; }
      dragging = false;
      // Thrown, it spins the way it was thrown; while it performs it goes on turning as it was.
      if (event.type === 'pointerup' && now - was.movedAt < 150 && Math.abs(was.speed) > 0.3) setSpin(Math.sign(was.speed));
      else if (show.mode !== 'still') setSpin(was.spun || 1);
      changed();
    };
    addEventListener('pointerup', lift); addEventListener('pointercancel', lift);
  }

  /* ---------- the panels and the speaker ---------- */
  // Two panels, built from the shared VRCH styles like the ones in Visuals Player. K3 opens Figures (the formula,
  // its presets, the colours, the text on the picture); K4 or a tap on the picture opens Player (what the figure
  // follows, the piece, the show). E1 moves through the choices and a press of E1 takes one; a touch does the same.
  let panel = null, cursor = null;
  function rows(name) {
    if (name === 'figures') {
      const formula = FORMULAS[motion.formula], on = presetNow();
      return [
        {row: 'formula', label: 'Formula', note: '', options: FORMULAS.map((f, i) => ({id: String(i), label: f.name, current: i === motion.formula})), pick: id => chooseFormula(Number(id))},
        {row: 'preset', label: 'Preset', note: formula.name, options: formula.presets.map((set, i) => ({id: String(i), label: String(i + 1), current: i === on})), pick: id => choosePreset(Number(id))},
        {row: 'colours', label: 'Colours', note: '', options: PALETTES.map((p, i) => ({id: String(i), label: p.name, current: i === palette})), pick: id => chooseColours(Number(id))},
        ...(relay ? [{row: 'output', label: 'Output', note: '', options: LAYOUTS.map((name, i) => ({id: String(i), label: name, current: i === arrange})), pick: id => { arrange = Number(id); renderPanel(); changed(); }}] : []),
        {row: 'text', label: 'Formula Text', note: '', options: [{id: 'on', label: 'Show', current: textShown}, {id: 'off', label: 'Hide', current: !textShown}], pick: id => { textShown = id === 'on'; renderPanel(); saveSoon(); }},
      ];
    }
    const source = player.source, note = source === 'music' ? (player.audible || player.muted ? '' : 'Starts when you play') : source === 'input' ? (player.listening ? '' : 'Connecting') : '';
    return [
      {row: 'sound', label: 'Sound', note, options: [...(TRACKS.length ? [{id: 'music', label: 'Music', current: source === 'music'}] : []), {id: 'input', label: 'Mic / Line in', current: source === 'input'}, {id: 'silent', label: 'Silent', current: source === 'silent'}], pick: id => setSource(id)},
      ...(TRACKS.length && source !== 'input' ? [{row: 'track', label: 'Track', note: '', options: TRACKS.map((track, i) => ({id: String(i), label: track.title, current: source === 'music' && i === player.index})), pick: id => { player.choose(Number(id)); setSource('music'); }}] : []),
      {row: 'show', label: 'Show', note: '', options: [{id: 'auto', label: 'Auto', current: show.mode === 'auto'}, {id: 'hold', label: 'Hold', current: show.mode === 'hold'}, {id: 'still', label: 'Still', current: show.mode === 'still'}], pick: id => chooseMode(id)},
    ];
  }
  const panelBody = () => $(panel === 'figures' ? 'figuresBody' : 'playerBody');
  const cursorButton = () => cursor ? panelBody().querySelector('[data-row="' + cursor.row + '"] [data-value="' + cursor.value + '"]') : null;
  // The device keeps input focus on the host, so the cursor is drawn with a class as well as focused.
  function showCursor(scroll = false) {
    const current = cursorButton();
    for (const button of panelBody().querySelectorAll('.is-cursor')) if (button !== current) button.classList.remove('is-cursor');
    if (!current) return;
    current.classList.add('is-cursor'); current.focus({preventScroll: true});
    if (scroll) current.scrollIntoView({block: 'nearest'});
  }
  // The open panel: rows of shared grid buttons, built from the state as it is each time it changes.
  function renderPanel() {
    if (isOutput || !player || !panel) return;
    const built = rows(panel).map(r => {
      const wrap = document.createElement('div'), head = document.createElement('div'), name = document.createElement('span'), note = document.createElement('span'), group = document.createElement('div');
      wrap.className = 'scene-param-row player-row'; wrap.dataset.row = r.row;
      head.className = 'scene-param-row__heading'; name.className = 'scene-param-row__label'; name.textContent = r.label;
      note.className = 'scene-param-row__value'; note.textContent = r.note;
      head.append(name, note);
      group.className = 'ui-grid-btn-group ui-grid-btn-group--settings'; group.setAttribute('role', 'group');
      for (const option of r.options) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'ui-grid-btn'; button.textContent = option.label; button.dataset.value = option.id;
        button.classList.toggle('is-active', !!option.current); button.setAttribute('aria-pressed', String(!!option.current));
        button.addEventListener('click', () => { if (player) player.wake(); cursor = {row: r.row, value: option.id}; r.pick(option.id); renderPanel(); });
        group.append(button);
      }
      wrap.append(head, group);
      return wrap;
    });
    panelBody().replaceChildren(...built);
    if (!cursorButton()) { const first = panelBody().querySelector('.is-active') || panelBody().querySelector('button'); cursor = first ? {row: first.closest('.player-row').dataset.row, value: first.dataset.value} : null; }
    showCursor();
  }
  function openPanel(name) {
    if (isOutput || !player) return;
    panel = name; cursor = null;
    for (const id of ['figures', 'player']) { const dialog = $(id); dialog.hidden = id !== name; dialog.classList.toggle('is-visible', id === name); }
    document.body.dataset.open = name || '';
    renderPanel(); label();
  }
  function panelStep(detents) {
    const items = [...panelBody().querySelectorAll('button:not(:disabled)')];
    if (!items.length) return;
    const at = items.indexOf(cursorButton()), next = items[((at < 0 ? 0 : at + Math.sign(detents)) + items.length) % items.length];
    cursor = {row: next.closest('.player-row').dataset.row, value: next.dataset.value};
    showCursor(true);
  }
  function panelPress() { cursorButton()?.click(); }
  // The speaker is always there. With Music it mutes and unmutes with a fade; with Silent or Mic / Line in (nothing
  // is played back) it shows as muted, and a tap brings the music back. Until sound is allowed it waits, and a tap
  // starts it.
  function renderSpeaker() {
    const button = $('speaker');
    if (isOutput || !player || !TRACKS.length) { button.hidden = true; return; }
    const wanted = player.source === 'music' && !player.muted;
    button.hidden = false;
    button.dataset.on = String(wanted && player.audible); button.dataset.state = wanted && !player.audible ? 'starting' : '';
    button.setAttribute('aria-pressed', String(!wanted));
    button.setAttribute('aria-label', player.source !== 'music' ? 'Play music' : player.muted ? 'Unmute' : 'Mute');
    button.firstElementChild.className = 'fas ' + (wanted ? 'fa-volume-high' : 'fa-volume-xmark');
  }
  function speakerTapped(event) {
    event.stopPropagation();
    if (!player) return;
    if (player.source !== 'music') { player.setMuted(false); setSource('music'); }
    else if (!player.muted && !player.audible) { player.retryAt = 0; player.wake(); }
    else { player.setMuted(!player.muted); saveSoon(); }
  }

  /* ---------- checks ---------- */
  window.__attractor = {
    role: isOutput ? 'output' : 'control',
    get firstFrameAt() { return firstFrameAt; },
    get twoMillionAt() { return twoMillionAt; },
    state: () => {
      const at = epoch(), letters = isOutput ? drawn : lettersAt(at);
      return {formula: FORMULAS[motion.formula].id, a: letters[0] / 100, b: letters[1] / 100, c: letters[2] / 100, d: letters[3] / 100, palette: PALETTES[palette].name,
        show: isOutput ? (motion.show ? 'on' : 'still') : show.mode, scene: show.scene, textVisible: !isOutput && textShown,
        source: player ? player.source : 'silent', track: player && player.source === 'music' ? player.title : null, muted: player ? player.muted : false, audible: player ? player.audible : false,
        listening: player ? player.source === 'input' && player.listening : false, panel, layout: LAYOUTS[arrange], calm: Math.round(calm.now * 100) / 100, touched: calm.seen,
        spin: motion.view.spin ? motion.view.spin.dir : 0, turn: Math.round(yawAt(at) * 1800 / Math.PI) / 10, tilt: Math.round(pitchAt(at) * 1800 / Math.PI) / 10};
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
    const linked = applyShare(context.share);
    if (linked) lent.show = true;
    player = new window.MusicPlayer({sdk, tracks: TRACKS, onLevels: hear, onSection: () => { show.due = true; }, onChange: soundChanged});
    player.index = kept.track; player.muted = kept.muted;
    setMode(linked ? 'still' : kept.show);
    build(); label();
    // The first points at once, before the first animation frame: a host may keep the App hidden until it is ready.
    step(performance.now());
    touch();
    $('speaker').addEventListener('click', speakerTapped);
    for (const id of ['figures', 'player']) {
      $(id + 'Close').addEventListener('click', () => openPanel(null));
      // A touch beside the sheet closes it.
      $(id).addEventListener('click', event => { if (event.target === $(id)) openPanel(null); });
    }
    document.addEventListener('visibilitychange', () => player.pause(document.hidden));
    sdk.controls.onEvent(onControl);
    await sdk.ready();
    void player.setSource(kept.source);
    soundChanged();
    requestAnimationFrame(frame);
    setInterval(publish, 1000); publish(); shareSoon();
  }
  addEventListener('pagehide', () => { clearTimeout(saveTimer); if (player) player.dispose(); }, {once: true});
  void init();
})();
