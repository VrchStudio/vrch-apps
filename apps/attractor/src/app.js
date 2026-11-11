// app.js: the App around the picture. Knobs and keys, touch, the text on the device screen, saved settings, the share
// link, the large output, and what sound does (the figure following music or the audio input, and the formula
// played) live here. The formulas are in formulas.js; how they are drawn is in picture.js; how they sound is in
// voice.js.
(() => {
  'use strict';
  const sdk = window.VrchApp, FORMULAS = window.Formulas, Picture = window.Picture;
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
  const MUSIC = 'music/ambient.mp3';
  const SOURCES = ['off', 'music', 'input'];

  /* ---------- settings ---------- */
  // Letters are whole hundredths (149 is 1.49), so a hundred small turns add up exactly.
  // glide: the letters are sliding from "from" (since "at") to p. drift: when the sway began, or 0.
  // view: where the figure is seen from. spin: it keeps turning, since "at", one way (1) or the other (-1).
  // Times are on the wall clock, so the output moves with the device.
  const hundredths = list => list.map(v => Math.round(v * 100));
  const motion = {formula: 0, p: hundredths(FORMULAS[0].presets[0]), glide: null, drift: 0, view: {yaw: 0, pitch: 0, spin: null}};
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
    const u = clamp((at - g.at) / GLIDE_MS, 0, 1), ease = u * u * (3 - 2 * u);
    return motion.p.map((v, i) => g.from[i] + (v - g.from[i]) * ease);
  }
  const swayed = (list, at) => { const [lo, hi] = limits(), seconds = (at - motion.drift) / 1000; return list.map((v, i) => clamp(v + DRIFT * Math.sin(2 * Math.PI * seconds / DRIFT_SECONDS[i]), lo, hi)); };
  const hearing = at => at < heardUntil && heard.some(v => v !== 0);
  function lettersAt(at) {
    const [lo, hi] = limits();
    let list = settled(at);
    if (motion.drift) list = swayed(list, at);
    if (hearing(at)) list = list.map((v, i) => clamp(v + heard[i], lo, hi));
    return list;
  }
  // The view at a moment, as picture.js takes it: across, down, away, how much smaller the turned figure is drawn
  // (so it stays inside the picture), and how deep a map is.
  const yawAt = at => { const s = motion.view.spin; return motion.view.yaw + (s ? s.dir * 2 * Math.PI * (at - s.at) / 1000 / TURN_SECONDS : 0); };
  function lookAt(at) {
    const formula = FORMULAS[motion.formula], yaw = yawAt(at), c = Math.cos(yaw), s = Math.sin(yaw), cp = Math.cos(motion.view.pitch), sp = Math.sin(motion.view.pitch);
    const deep = formula.flow ? 1 : formula.deep ?? DEPTH;
    const wide = formula.flow ? 1 : Math.abs(c) + deep * Math.abs(s), tall = formula.flow ? Math.abs(sp) + Math.abs(cp) : Math.abs(sp * s) + Math.abs(cp) + deep * Math.abs(sp * c);
    return [c, 0, s, sp * s, cp, -sp * c, -cp * s, sp, cp * c, 1 / Math.max(1, wide, tall), deep];
  }
  let dragging = false;
  const inMotion = at => !!motion.drift || (!!motion.glide && at < motion.glide.at + GLIDE_MS) || hearing(at) || !!motion.view.spin || dragging;
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
    const box = $('stage');
    if (picture) picture.resize(box.clientWidth, box.clientHeight, devicePixelRatio || 1);
  }
  function step(now) {
    const at = epoch();
    if (motion.glide && at >= motion.glide.at + GLIDE_MS) motion.glide = null;
    // An output hears of a dragged view some twenty times a second and eases towards it.
    if (aim) { const v = motion.view; v.yaw += (aim.yaw - v.yaw) * 0.35; v.pitch += (aim.pitch - v.pitch) * 0.35; if (Math.abs(aim.yaw - v.yaw) + Math.abs(aim.pitch - v.pitch) < 1e-4) { v.yaw = aim.yaw; v.pitch = aim.pitch; aim = null; } }
    if (!isOutput) listen();
    const letters = lettersAt(at).map(v => v / 100);
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
    write(letters); tell(letters); send();
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
    const status = [sounding ? 'sound on' : '', source === 'music' && music.node ? 'music' : '', source === 'input' ? 'listening' : '', said].filter(Boolean).join(' · ');
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
  const moving = () => (motion.view.spin ? 1 : 0) + (motion.drift ? 2 : 0);
  function label() {
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      const formula = FORMULAS[motion.formula], on = presetNow(), values = {};
      'abcd'.split('').forEach((name, i) => { values['E' + (i + 1)] = {label: name, value: two(motion.p[i] / 100) + (coarse[i] ? ' ×10' : '')}; });
      values.K2 = {label: 'Preset', value: (on < 0 ? '–' : on + 1) + '/' + formula.presets.length, pressed: sounding};
      values.K3 = {label: ['Colour', 'Spin', 'Drift', 'Spin+Drift'][moving()], value: PALETTES[palette].name, pressed: moving() > 0};
      values.K4 = {label: formula.name, pressed: source !== 'off'};
      try { void sdk.monitor.set(values).catch(() => {}); } catch (_) { /* unavailable */ }
    }, 40);
  }

  /* ---------- saved settings, the share link and the output ---------- */
  let version, saveTimer = 0, shareTimer = 0, publishTimer = 0, shared = '', sent = '';
  function restore(value) {
    if (!value || value.v !== 1) return;
    const index = FORMULAS.findIndex(f => f.id === value.formula);
    if (index >= 0) {
      const [lo, hi] = FORMULAS[index].range.map(v => Math.round(v * 100));
      if (valid(value.p, lo, hi)) { motion.formula = index; motion.p = value.p.map(Math.round); }
    }
    if (Number.isInteger(value.palette) && value.palette >= 0 && value.palette < PALETTES.length) palette = value.palette;
    if (value.drift === true) motion.drift = epoch();
    if (Number.isFinite(value.yaw) && Number.isFinite(value.pitch)) { motion.view.yaw = value.yaw; motion.view.pitch = clamp(value.pitch, -TILT, TILT); }
    if (value.spin === 1 || value.spin === -1) motion.view.spin = {at: epoch(), dir: value.spin};
    textShown = value.text !== false;
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const value = {v: 1, formula: FORMULAS[motion.formula].id, p: motion.p, palette, drift: !!motion.drift, text: textShown, yaw: yawAt(epoch()) % (2 * Math.PI), pitch: motion.view.pitch, spin: motion.view.spin ? motion.view.spin.dir : 0};
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
  function applyShare(share) {
    const m = SHARE.exec(typeof share?.state === 'string' ? share.state : '');
    if (!m) return;
    const index = FORMULAS.findIndex(f => f.id === m[1]), p = m.slice(2, 6).map(Number), colours = Number(m[6]);
    if (index < 0 || colours >= PALETTES.length) return;
    const [lo, hi] = FORMULAS[index].range.map(v => Math.round(v * 100));
    if (!valid(p, lo, hi)) return;
    // A link shows one figure: it opens at rest, seen as it was shared.
    motion.formula = index; motion.p = p; motion.glide = null; motion.drift = 0; palette = colours;
    motion.view = {yaw: (Number(m[7]) || 0) * Math.PI / 180, pitch: clamp((Number(m[8]) || 0) * Math.PI / 180, -TILT, TILT), spin: null};
  }
  function publish() {
    if (isOutput || !relay) return;
    clearTimeout(publishTimer); publishTimer = 0;
    try { relay.publish({v: 1, f: FORMULAS[motion.formula].id, p: motion.p, g: motion.glide, drift: motion.drift, c: palette, w: [motion.view.yaw, motion.view.pitch, motion.view.spin]}); } catch (_) { /* no output */ }
  }
  // What sound adds goes to the output as it changes, frame by frame.
  function send() {
    if (!relay) return;
    const now = hearing(epoch()) ? heard.join() : '';
    if (now === sent) return;
    sent = now;
    try { relay.send({v: 1, o: now ? heard.slice() : [0, 0, 0, 0]}); } catch (_) { /* no output */ }
  }
  function follow({kind, data} = {}) {
    if (!data || data.v !== 1) return;
    if (kind === 'event') {
      if (valid(data.o, -100, 100)) { for (let i = 0; i < 4; i++) heard[i] = data.o[i]; heardUntil = epoch() + 400; }
      return;
    }
    if (kind !== 'state') return;
    const index = FORMULAS.findIndex(f => f.id === data.f);
    if (index < 0) return;
    const [lo, hi] = FORMULAS[index].range.map(v => Math.round(v * 100));
    if (!valid(data.p, lo, hi)) return;
    const first = !told;
    motion.formula = index; motion.p = data.p; told = true;
    motion.glide = data.g && valid(data.g.from, lo, hi) && Number.isFinite(data.g.at) ? {from: data.g.from, at: data.g.at} : null;
    motion.drift = Number.isFinite(data.drift) ? data.drift : 0;
    if (Array.isArray(data.w) && Number.isFinite(data.w[0]) && Number.isFinite(data.w[1])) {
      const spin = data.w[2] && Number.isFinite(data.w[2].at) && Math.abs(data.w[2].dir) === 1 ? {at: data.w[2].at, dir: data.w[2].dir} : null, to = {yaw: data.w[0], pitch: clamp(data.w[1], -TILT, TILT)};
      if (spin || first) { motion.view = {...to, spin}; aim = null; } else { motion.view.spin = null; aim = to; }
    }
    if (Number.isInteger(data.c) && data.c >= 0 && data.c < PALETTES.length && data.c !== palette) { palette = data.c; if (picture) picture.colours(PALETTES[palette].stops); }
  }
  // Something changed: the labels, the saved copy, the share link and the output all follow.
  function changed() { label(); saveSoon(); shareSoon(); publish(); }

  /* ---------- one audio context for everything the App plays ---------- */
  // The host plays the sound: this context renders to nowhere and hands its samples to the host's output. It opens
  // when the formula or the music is first played and closes when neither is.
  let rig = null, rigOpening = null, rigEpoch = 0;
  function openRig() {
    if (rig) return Promise.resolve(rig);
    if (rigOpening) return rigOpening;
    const mine = ++rigEpoch;
    rigOpening = (async () => {
      let ctx = null, output = null;
      try {
        ctx = new AudioContext({sampleRate: 48000, latencyHint: 'interactive', sinkId: {type: 'none'}});
        void ctx.resume().catch(() => {});
        output = await sdk.audio.openOutput({channels: 2});
        const destination = await output.createNode(ctx);
        await ctx.audioWorklet.addModule('voice.js');
        if (mine !== rigEpoch) throw Object.assign(new Error('stale'), {code: 'stale'});
        const opened = {ctx, output, destination};
        output.onError(() => { if (rig === opened) rigLost(); });
        rig = opened;
        return opened;
      } catch (error) {
        await Promise.allSettled([output?.close(), ctx?.close()]);
        throw error;
      } finally { rigOpening = null; }
    })();
    return rigOpening;
  }
  function closeRig() {
    const old = rig;
    rig = null; ++rigEpoch; voice = null; music.node = null;
    if (!old) return;
    void Promise.allSettled([old.output.close(), old.ctx.state === 'closed' ? null : old.ctx.close()]);
  }
  const closeRigIfIdle = () => { if (rig && !voice && !music.node) closeRig(); };
  function rigLost() {
    closeRig(); sounding = false;
    if (source === 'music') source = 'off';
    say('Sound stopped. Hold K2 or K4 to try again.'); label();
  }

  /* ---------- sound: the formula played ---------- */
  // Off until K2 is held. voice.js follows one point through the formula on the audio thread.
  let sounding = false, voice = null;
  // The audio thread hears of the formula and the letters whenever they change.
  function tell(letters) {
    if (!voice) return;
    if (voice.formula !== motion.formula) {
      const {step: rule, flow, dt, view, centre, hear: speed} = FORMULAS[motion.formula];
      voice.formula = motion.formula;
      voice.node.port.postMessage({type: 'formula', formula: {with: FORMULAS[motion.formula].with, step: rule, flow, dt, view, centre, hear: speed}});
    }
    const key = letters.join();
    if (key !== voice.letters) { voice.letters = key; voice.node.port.postMessage({type: 'letters', k: letters}); }
  }
  function setSound(on) {
    sounding = on; say(''); label();
    if (on) {
      openRig().then(opened => {
        if (!sounding || rig !== opened || voice) return;
        const node = new AudioWorkletNode(opened.ctx, 'voice', {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2]});
        node.onprocessorerror = () => { if (rig === opened) rigLost(); };
        node.connect(opened.destination);
        voice = {node, formula: -1, letters: ''};
        tell(lettersAt(epoch()).map(v => v / 100)); node.port.postMessage({type: 'on', on: true});
      }).catch(error => { if (error?.code !== 'stale' && sounding) { sounding = false; say('Sound could not start. Hold K2 to try again.'); label(); } });
    } else if (voice) {
      const old = voice;
      old.node.port.postMessage({type: 'on', on: false});   // fades out, then lets go
      setTimeout(() => { if (voice === old && !sounding) { try { old.node.disconnect(); } catch (_) { /* gone */ } voice = null; closeRigIfIdle(); } }, 200);
    }
  }

  /* ---------- the figure follows sound ---------- */
  // Off until K4 is held: then the App's own music, then the audio input, then off again. The input opens only
  // while it is the source; nothing it hears is played back or kept. What is heard is split in three (low, middle,
  // high). Each part's swell and fall sways a, b and c; a sudden swell in any part knocks d, which then returns.
  let source = 'off';
  const fresh = () => ({lo: 0, mid: 0, bands: [0, 1, 2].map(() => ({top: 0, level: 0, mean: 0, last: 0})), since: 99, knocks: 0, kick: 0});
  let ears = fresh();
  const tidy = v => Math.abs(v) < 0.05 ? 0 : Math.round(v * 10) / 10;
  // One block of sound (mono, 48 kHz, about 20 ms).
  function hear(samples) {
    let lo = ears.lo, mid = ears.mid, low = 0, middle = 0, high = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      lo += 0.0258 * (x - lo); mid += 0.2303 * (x - mid);   // below 200 Hz, and below 2 kHz
      low += lo * lo; middle += (mid - lo) * (mid - lo); high += (x - mid) * (x - mid);
    }
    ears.lo = lo; ears.mid = mid;
    const loud = [low, middle, high].map(sum => Math.sqrt(sum / Math.max(1, samples.length)));
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
    if (rise > 0.5 && ears.since >= 9) { ears.since = 0; ears.knocks++; ears.kick += ears.knocks % 2 ? KICK : -KICK; }
    ears.kick *= 0.94;
    heard[3] = tidy(ears.kick);
    heardUntil = epoch() + 300;
  }
  function deaf() { ears = fresh(); heardUntil = 0; for (let i = 0; i < 4; i++) heard[i] = 0; }

  // The audio input.
  const input = {port: null, epoch: 0};
  function closeInput() {
    const old = input.port;
    input.port = null; ++input.epoch;
    if (old) void Promise.resolve(old.close()).catch(() => {});
  }
  async function openInput() {
    const mine = ++input.epoch;
    try {
      const port = await sdk.audio.openInput({channels: 1});
      if (mine !== input.epoch || source !== 'input') { void Promise.resolve(port.close()).catch(() => {}); return; }
      input.port = port;
      port.onData(samples => { if (input.port === port) hear(samples); });
      port.onError(() => { if (input.port === port) { closeInput(); deaf(); source = 'off'; say('Audio input stopped.'); label(); } });
    } catch (error) {
      if (mine !== input.epoch) return;
      const code = error?.code || error?.name, refused = ['permission_required', 'permission_denied', 'capability_denied', 'io_not_authorized', 'NotAllowedError'].includes(code);
      // Asked once: holding K4 round to the input again asks again.
      source = 'off'; say(refused ? 'Audio input is not allowed.' : 'No audio input.'); label();
    }
  }

  // The App's own music: one piece, looped. It is read and unpacked before any sound is opened, played through the
  // host like the formula, and the figure is moved by the very samples being played.
  // (A copy of the App without the piece goes straight to the audio input.)
  const music = {samples: null, loading: null, missing: false, node: null, gain: null, began: 0, fed: 0, block: new Float32Array(960), epoch: 0};
  function loadMusic() {
    music.loading ||= (async () => {
      const response = await fetch(MUSIC);
      if (!response.ok) throw new Error('no music');
      music.samples = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(await response.arrayBuffer());
    })().catch(error => { music.loading = null; throw error; });
    return music.loading;
  }
  async function startMusic() {
    const mine = ++music.epoch;
    try {
      if (!music.samples) say('Loading music…', true);
      await loadMusic();
      const opened = await openRig();
      if (mine !== music.epoch || source !== 'music' || rig !== opened) { closeRigIfIdle(); return; }
      const node = new AudioBufferSourceNode(opened.ctx, {buffer: music.samples, loop: true}), gain = new GainNode(opened.ctx, {gain: 0});
      node.connect(gain).connect(opened.destination);
      gain.gain.linearRampToValueAtTime(0.9, opened.ctx.currentTime + 1.5);
      node.start();
      Object.assign(music, {node, gain, began: opened.ctx.currentTime, fed: 0});
      say(''); label();
    } catch (error) {
      if (mine !== music.epoch || error?.code === 'stale') return;
      if (!music.samples) { music.missing = true; say(''); setSource('input'); return; }
      source = 'off'; say('Music could not start. Hold K4 to try again.'); label();
    }
  }
  function stopMusic() {
    ++music.epoch;
    const {node, gain} = music, at = rig;
    music.node = null; music.gain = null;
    if (!node || !at) return;
    try { gain.gain.cancelScheduledValues(at.ctx.currentTime); gain.gain.setTargetAtTime(0, at.ctx.currentTime, 0.08); } catch (_) { /* closing */ }
    setTimeout(() => { try { node.stop(); node.disconnect(); gain.disconnect(); } catch (_) { /* gone */ } if (rig === at) closeRigIfIdle(); }, 400);
  }
  // Each frame: hear the music played since the last one (about 70 ms ago is what is being heard now).
  function listen() {
    if (!music.node || !rig || !music.samples) return;
    const until = rig.ctx.currentTime - music.began - 0.07, left = music.samples.getChannelData(0), right = music.samples.numberOfChannels > 1 ? music.samples.getChannelData(1) : left;
    if (until - music.fed > 0.2) music.fed = until - 0.04;   // after a pause, do not catch up on everything missed
    while (music.fed + 0.02 <= until) {
      let from = Math.round(music.fed * 48000) % left.length;
      for (let i = 0; i < 960; i++, from++) { if (from >= left.length) from = 0; music.block[i] = 0.5 * (left[from] + right[from]); }
      hear(music.block); music.fed += 0.02;
    }
  }
  function setSource(next) {
    if (next === source) return;
    if (source === 'music') stopMusic();
    if (source === 'input') closeInput();
    source = next; deaf(); say('');
    if (source === 'music') void startMusic();
    if (source === 'input') void openInput();
    label();
  }

  /* ---------- controls ---------- */
  const held = {}, timers = {}, turnedAt = [0, 0, 0, 0], twirl = [0, 0, 0, 0];
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
  // K3 held: still, spin, drift, both.
  function nextMoving() {
    const next = (moving() + 1) % 4;
    setSpin(next & 1 ? motion.view.spin?.dir || 1 : 0); setDrift(!!(next & 2));
    changed();
  }
  // A key acts when it is let go; held for half a second it does its second job instead.
  const TAPS = {K2: nextPreset, K3: nextColours, K4: nextFormula};
  const nextSource = () => { const next = SOURCES[(SOURCES.indexOf(source) + 1) % SOURCES.length]; setSource(next === 'music' && music.missing ? 'input' : next); };
  const HOLDS = {K2: () => setSound(!sounding), K3: nextMoving, K4: nextSource};
  function onControl(event) {
    const control = event.control, knob = ['E1', 'E2', 'E3', 'E4'].indexOf(control);
    if (event.type === 'rotate') {
      const detents = Math.trunc(Number(event.delta) || 0);
      if (detents && knob >= 0) turn(knob, detents);
    } else if (event.type === 'down') {
      if (held[control]) return;
      held[control] = true;
      if (knob >= 0) { coarse[knob] = !coarse[knob]; label(); }
      else if (HOLDS[control]) timers[control] = setTimeout(() => { timers[control] = 0; HOLDS[control](); }, HOLD_MS);
    } else if (event.type === 'up' || event.type === 'cancel') {
      if (!held[control]) return;
      held[control] = false;
      if (timers[control]) { clearTimeout(timers[control]); timers[control] = 0; if (event.type === 'up') TAPS[control](); }
    }
  }
  // Touch: a tap shows or hides the text; a drag turns the figure; letting go while still moving sets it spinning.
  function touch() {
    const stage = $('stage');
    let finger = null;
    stage.addEventListener('pointerdown', event => {
      // (A new touch always starts afresh: the end of the one before may never have arrived.)
      dragging = false;
      finger = {id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, at: performance.now(), movedAt: 0, speed: 0};
      try { stage.setPointerCapture(event.pointerId); } catch (_) { /* a pointer sent by the host */ }
    });
    addEventListener('pointermove', event => {
      if (!finger || event.pointerId !== finger.id) return;
      if (!dragging && Math.hypot(event.clientX - finger.x, event.clientY - finger.y) < 6) return;
      const now = performance.now(), perPixel = Math.PI / Math.max(120, Math.min(stage.clientWidth, stage.clientHeight));
      if (!dragging) { dragging = true; setSpin(0); finger.lastX = event.clientX; finger.lastY = event.clientY; finger.movedAt = now; }
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
      if (!dragging) { if (event.type === 'pointerup' && now - was.at < 500) { textShown = !textShown; saveSoon(); } return; }
      dragging = false;
      if (event.type === 'pointerup' && now - was.movedAt < 150 && Math.abs(was.speed) > 0.3) setSpin(Math.sign(was.speed));
      changed();
    };
    addEventListener('pointerup', lift); addEventListener('pointercancel', lift);
  }

  /* ---------- checks ---------- */
  window.__attractor = {
    role: isOutput ? 'output' : 'control',
    get firstFrameAt() { return firstFrameAt; },
    get twoMillionAt() { return twoMillionAt; },
    state: () => {
      const at = epoch(), letters = lettersAt(at);
      return {formula: FORMULAS[motion.formula].id, a: letters[0] / 100, b: letters[1] / 100, c: letters[2] / 100, d: letters[3] / 100, palette: PALETTES[palette].name,
        drift: !!motion.drift, textVisible: !isOutput && textShown, sound: sounding, listening: source === 'input', source,
        spin: motion.view.spin ? motion.view.spin.dir : 0, turn: Math.round(yawAt(at) * 1800 / Math.PI) / 10, tilt: Math.round(motion.view.pitch * 1800 / Math.PI) / 10};
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
    touch();
    sdk.controls.onEvent(onControl);
    await sdk.ready();
    requestAnimationFrame(frame);
    setInterval(publish, 1000); publish(); shareSoon();
  }
  addEventListener('pagehide', () => { clearTimeout(saveTimer); closeInput(); closeRig(); }, {once: true});
  void init();
})();
