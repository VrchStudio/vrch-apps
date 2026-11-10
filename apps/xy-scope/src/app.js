// app.js: the instrument around the signal. Knobs and keys, the labels on the device screen, saved settings, the share
// link and the large output live here. How a sample is made is in signal.js; how the beam is drawn is in trace.js.
(() => {
  'use strict';
  const sdk = window.VrchApp, Signal = window.XYSignal;
  let context = {};
  try { context = sdk.context; } catch (_) { /* defaults */ }
  // Output role: a picture-only instance (a large or second screen) draws the same beam. It makes no sound, reads no
  // controls, saves nothing and shows no text; the controlling instance tells it the settings and where the signal is.
  const isOutput = context.role === 'output', relay = sdk.output || null;
  document.documentElement.dataset.role = isOutput ? 'output' : 'control';
  if (context.name) document.title = context.name;

  const SR = Signal.SR, PER_MS = SR / 1000, LEVEL = Signal.LEVEL;
  const marks = {script: performance.now()};
  // Sound is heard later than the engine makes it: the host carries it in 20 ms blocks and the audio device adds its
  // own delay. The picture waits the same time, less the frame a screen takes to show what was drawn.
  const AUDIO_LATENCY_MS = 60, SCREEN_LATENCY_MS = 16, DISPLAY_DELAY_MS = AUDIO_LATENCY_MS - SCREEN_LATENCY_MS;
  const MAX_POINTS = 4096, RING = 16384, HISTORY = SR / 2;
  const $ = id => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const epoch = t => performance.timeOrigin + t;

  /* ---------- settings ---------- */
  const RATIOS = [[1, 1, 'Unison'], [5, 4, 'Maj 3rd'], [4, 3, 'Fourth'], [3, 2, 'Fifth'], [5, 3, 'Maj 6th'], [7, 4, 'Harm 7th'], [2, 1, 'Octave'], [5, 2, 'Oct + 3rd'], [3, 1, 'Oct + 5th'], [4, 1, '2 Octaves']];
  const COLOURS = [['Green', [0.2, 1, 0.45]], ['Amber', [1, 0.6, 0.12]], ['Ice', [0.35, 0.75, 1]], ['Pink', [1, 0.08, 0.58]]];
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // pitch: MIDI note of X (A1..A4). ratio: index into RATIOS; free: any ratio ("value") instead. glow and shape in percent.
  const DEFAULTS = {pitch: 45, ratio: 3, free: false, value: 1.5, drift: 0.1, shape: 0, spin: 0, decay: 1.5, glow: 35, colour: 0, page: 0};
  const LIMITS = {pitch: [33, 69, 1], ratio: [0, RATIOS.length - 1, 1], value: [1, 4, 0.001], drift: [-2, 2, 0.01], shape: [0, 100, 1], spin: [-1, 1, 0.01], decay: [0.2, 6, 0.001], glow: [0, 100, 1], colour: [0, COLOURS.length - 1, 1], page: [0, 1, 1]};
  const tidy = (key, v) => { const [lo, hi, grain] = LIMITS[key]; return clamp(Number((Math.round(v / grain) * grain).toFixed(3)), lo, hi); };
  const state = {...DEFAULTS};
  let holding = false, striking = false;

  function settings() {
    const [num, den] = RATIOS[state.ratio];
    return {freq: 440 * 2 ** ((state.pitch - 69) / 12), ratio: state.free ? state.value : num / den, num: state.free ? 0 : num, den: state.free ? 0 : den,
      drift: state.drift, shape: state.shape / 100, spin: state.spin, decay: state.decay, hold: holding ? 1 : 0, strike: striking ? 1 : 0};
  }
  const glowSeconds = percent => 0.02 * 100 ** (percent / 100);   // 20 ms .. 2 s
  const signed = (v, digits) => (v > 0 ? '+' : '') + (Math.abs(v) < 0.5 / 10 ** digits ? 0 : v).toFixed(digits);
  const fast = d => d * Math.max(1, Math.abs(d));                 // a quick turn covers more ground
  let colourTurn = 0;
  const CONTROLS = {
    pitch: {label: 'Pitch', text: () => NOTES[state.pitch % 12] + (Math.floor(state.pitch / 12) - 1), turn: d => set('pitch', state.pitch + d), press: () => set('pitch', DEFAULTS.pitch)},
    ratio: {label: 'Ratio', text: () => state.free ? state.value.toFixed(3) : RATIOS[state.ratio][0] + ':' + RATIOS[state.ratio][1] + ' ' + RATIOS[state.ratio][2],
      turn: d => state.free ? set('value', state.value + 0.002 * fast(d)) : set('ratio', state.ratio + d), press: toggleFree},
    drift: {label: 'Drift', text: () => signed(state.drift, 2) + ' Hz', turn: d => set('drift', state.drift + 0.01 * fast(d)), press: () => set('drift', 0)},
    shape: {label: 'Shape', text: () => state.shape + '%', turn: d => set('shape', state.shape + 2 * d), press: () => set('shape', 0)},
    spin: {label: 'Spin', text: () => signed(state.spin, 2) + ' /s', turn: d => set('spin', state.spin + 0.01 * fast(d)), press: () => set('spin', 0)},
    decay: {label: 'Decay', text: () => state.decay.toFixed(state.decay < 1 ? 2 : 1) + ' s', turn: d => set('decay', state.decay * 1.06 ** d), press: () => set('decay', DEFAULTS.decay)},
    glow: {label: 'Glow', text: () => state.glow + '%', turn: d => set('glow', state.glow + 2 * d), press: () => set('glow', DEFAULTS.glow)},
    colour: {label: 'Colour', text: () => COLOURS[state.colour][0], press: () => {},
      turn: d => { colourTurn += d; const steps = Math.trunc(colourTurn / 2); if (steps) { colourTurn -= steps * 2; set('colour', ((state.colour + steps) % COLOURS.length + COLOURS.length) % COLOURS.length); } }},
  };
  const PAGES = [{name: 'Tone', keys: ['pitch', 'ratio', 'drift', 'shape']}, {name: 'Motion', keys: ['spin', 'decay', 'glow', 'colour']}];

  function set(key, value) {
    value = tidy(key, value);
    if (value === state[key]) return;
    state[key] = value; changed();
  }
  // Free: the ratio leaves the whole numbers, starting from where it was; back again it snaps to the nearest.
  function toggleFree() {
    if (state.free) { let best = 0; RATIOS.forEach(([n, d], i) => { if (Math.abs(n / d - state.value) < Math.abs(RATIOS[best][0] / RATIOS[best][1] - state.value)) best = i; }); state.ratio = best; }
    else state.value = tidy('value', RATIOS[state.ratio][0] / RATIOS[state.ratio][1]);
    state.free = !state.free; changed();
  }
  // A setting changed: the engine, the labels, the saved copy, the share link and the output all follow.
  function changed() { push(); dirty = true; saveSoon(); shareSoon(); publish(); }
  // Hold or strike changed: sound and picture follow; nothing is saved.
  function gate() { push(); dirty = true; publish(); if (holding || striking) void engage(); }
  const push = () => engine?.node.port.postMessage({type: 'set', p: settings()});

  /* ---------- the picture ---------- */
  // sig is the page's own copy of the signal. It draws the figure while nothing sounds yet; once the engine sounds, the
  // beam follows the samples the engine sent to the speakers instead.
  const points = new Float32Array(MAX_POINTS * 2), scratch = new Float32Array(MAX_POINTS * 2);
  let trace = null, sig = Signal.create(), source = 'analytic', owed = 0, lastNow = 0, dirty = true, firstFrameAt = null;
  const drawLog = [];   // [page time, engine frame drawn up to] of recent frames, for timing checks
  const bare = s => { const {amp, ...rest} = s; return rest; };
  const revive = s => Object.assign(Signal.create(), s, {shape: -1});
  function advance(s, p, samples) {
    for (let left = samples; left > 0; left -= MAX_POINTS) Signal.render(s, p, scratch, Math.min(left, MAX_POINTS));
  }
  // The figure at full size, as if held: what is shown before any sound.
  const preview = p => ({...p, hold: 1, strike: 0});
  function own(dt, p) {
    owed += dt * SR;
    const count = Math.min(Math.floor(owed), MAX_POINTS);
    owed = Math.min(owed - count, 1);
    if (count) Signal.render(sig, p, points, count);
    return count;
  }
  // What was drawn, kept for half a second in speaker units, for the checks in window.__xy.
  const history = new Float32Array(HISTORY * 2);
  let historyAt = 0, historyFill = 0, lastCount = 0;
  function show(count, dt, colour, glow) {
    for (let i = 0; i < count; i++) {
      history[2 * historyAt] = points[2 * i] * LEVEL; history[2 * historyAt + 1] = points[2 * i + 1] * LEVEL;
      historyAt = (historyAt + 1) % HISTORY;
    }
    historyFill = Math.min(HISTORY, historyFill + count); lastCount = count;
    trace.draw(points, count, {colour: COLOURS[colour][1], glow: glowSeconds(glow), dt});
    if (count && firstFrameAt === null) firstFrameAt = performance.now();
  }

  /* ---------- sound ---------- */
  // The engine posts the samples it sends to the speakers. ring keeps the newest third of a second by frame number;
  // base says when a frame was made on the page's clock (frame / 48 + base, in ms), taken from the promptest arrivals.
  const ring = new Float32Array(RING * 2);
  let engine = null, opening = null, audioEpoch = 0, engaging = false, have = 0, drawn = 0, base = null, snapshot = null, lastBlockAt = 0, noticeTimer = 0;
  function notice(text, keep = false) {
    clearTimeout(noticeTimer);
    const el = $('notice'); el.textContent = text; el.hidden = !text;
    if (text && !keep) noticeTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }
  function openAudio() {
    if (engine) return Promise.resolve(engine);
    if (opening) return opening;
    const mine = ++audioEpoch;
    opening = (async () => {
      const ctx = new AudioContext({sampleRate: SR, latencyHint: 'interactive', sinkId: {type: 'none'}});
      let output = null;
      try {
        void ctx.resume().catch(() => {});
        output = await sdk.audio.openOutput({channels: 2});
        const destination = await output.createNode(ctx);
        await ctx.audioWorklet.addModule('signal.js');
        await ctx.audioWorklet.addModule('engine.js');
        if (mine !== audioEpoch) throw Object.assign(new Error('stale'), {code: 'stale'});
        const node = new AudioWorkletNode(ctx, 'scope-engine', {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2]});
        const opened = {ctx, output, node, began: null};
        node.port.onmessage = ({data}) => { if (engine === opened) onEngine(opened, data); };
        node.onprocessorerror = () => { if (engine === opened) audioLost(); };
        output.onError(() => { if (engine === opened) audioLost(); });
        node.connect(destination);
        engine = opened; push();
        return opened;
      } catch (error) {
        await Promise.allSettled([output?.close(), ctx.close()]);
        throw error;
      } finally { opening = null; }
    })();
    return opening;
  }
  function closeAudio() {
    const old = engine;
    engine = null; ++audioEpoch; source = 'analytic'; base = null; snapshot = null;
    if (!old) return;
    try { old.node.disconnect(); } catch (_) { /* gone */ }
    void Promise.allSettled([old.output.close(), old.ctx.state === 'closed' ? null : old.ctx.close()]);
  }
  function audioLost() {
    closeAudio(); holding = false; striking = false; dirty = true; publish();
    notice('Sound stopped. Press K2 to retry.', true);
  }
  // First sound. The engine starts from where the figure on screen will be when its first samples are shown, so the
  // picture carries on without a jump.
  async function engage() {
    if (engaging || (engine && engine.began !== null)) return;
    engaging = true;
    try {
      const opened = await openAudio();
      await opened.ctx.resume();   // where a browser wants a key or a tap first, this waits for it
      if (engine !== opened || opened.began !== null) return;
      const start = Signal.copy(sig), p = settings();
      advance(start, preview(p), Math.round((DISPLAY_DELAY_MS + 4) * PER_MS));
      start.hold = 0; start.strike = 0;
      opened.began = -1;
      opened.node.port.postMessage({type: 'begin', s: start, p});
      notice('');
    } catch (error) {
      if (error?.code === 'stale') return;
      holding = false; striking = false; dirty = true;
      const code = error?.code || error?.name;
      notice(['capability_denied', 'io_not_authorized', 'permission_denied'].includes(code) ? 'Allow audio in Menu, then press K2.' : 'Sound unavailable. Press K2 to retry.', true);
    } finally { engaging = false; }
  }
  function onEngine(from, m) {
    if (m.type === 'began') { from.began = m.frame; return; }
    if (m.type !== 'pcm') return;
    const frames = m.samples.length / 2;
    for (let i = 0; i < frames; i++) { const at = ((m.frame + i) % RING) * 2; ring[at] = m.samples[2 * i]; ring[at + 1] = m.samples[2 * i + 1]; }
    have = m.frame + frames; lastBlockAt = performance.now();
    const made = lastBlockAt - have / PER_MS;
    base = base === null ? made : Math.min(made, base + 0.02);
    if (m.s) snapshot = {frame: m.frame, s: m.s};
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (now <= lastNow) return;   // a host may run animation callbacks twice in one frame
    const dt = clamp((now - lastNow) / 1000, 0, 0.1); lastNow = now;
    if (dirty) { dirty = false; render(); }
    let count = 0;
    if (engine && engine.began >= 0 && base !== null) {
      const heard = Math.floor((now - base - DISPLAY_DELAY_MS) * PER_MS);   // the frame leaving the speaker now
      if (source === 'analytic' && heard >= engine.began) { source = 'audio'; drawn = Math.max(engine.began, heard - Math.round(dt * SR)); publish(); shareSoon(); }
      if (source === 'audio') {
        const to = Math.min(heard, have);
        for (let f = Math.max(drawn, have - RING, to - MAX_POINTS); f < to; f++, count++) {
          const at = (f % RING) * 2;
          points[2 * count] = ring[at] / LEVEL; points[2 * count + 1] = ring[at + 1] / LEVEL;
        }
        drawn = Math.max(drawn, to);
        drawLog.push([now, drawn]); if (drawLog.length > 600) drawLog.shift();
        if (now - lastBlockAt > 1500) audioLost();
      }
    }
    if (source === 'analytic') count = own(dt, preview(settings()));
    show(count, dt, state.colour, state.glow);
  }

  /* ---------- the large output ---------- */
  // The controlling instance publishes its settings (to take effect at "at") and the signal as it stands at "sAt", both
  // on the shared wall clock. The output runs the same signal.js from there, so both screens show one figure.
  function publish() {
    if (isOutput || !relay) return;
    const audio = source === 'audio';
    if (audio && !snapshot) return;
    const now = epoch(performance.now());
    const message = {v: 1, p: settings(), preview: !audio, colour: state.colour, glow: state.glow, at: now + (audio ? DISPLAY_DELAY_MS : 0),
      s: audio ? snapshot.s : bare(sig), sAt: audio ? epoch(snapshot.frame / PER_MS + base + DISPLAY_DELAY_MS) : epoch(lastNow)};
    try { relay.publish(message); } catch (_) { /* no output */ }
  }
  const queue = [];
  let following = null, arriving = null;
  function follow({kind, data} = {}) {
    if (kind !== 'state' || !data || data.v !== 1 || !data.p || !data.s) return;
    queue.push(data); if (queue.length > 64) queue.shift();
  }
  function outputFrame(now) {
    requestAnimationFrame(outputFrame);
    if (now <= lastNow) return;
    const dt = clamp((now - lastNow) / 1000, 0, 0.1), wall = epoch(now); lastNow = now;
    while (queue.length && queue[0].at <= wall) { following = queue.shift(); arriving = following; }
    if (!following) { show(0, dt, 0, 0); return; }
    const p = following.preview ? preview(following.p) : following.p;
    if (arriving && arriving.sAt <= wall) {
      sig = revive(arriving.s);
      advance(sig, p, clamp(Math.round((wall - arriving.sAt) * PER_MS), 0, SR * 5));
      arriving = null; owed = 0;
    }
    show(own(dt, p), dt, clamp(following.colour | 0, 0, COLOURS.length - 1), clamp(Number(following.glow) || 0, 0, 100));
  }

  /* ---------- saved settings and the share link ---------- */
  let version, saveTimer = 0, shareTimer = 0, shared = '';
  function restore(value) {
    if (!value || value.v !== 1) return;
    for (const key in LIMITS) if (Number.isFinite(value[key])) state[key] = tidy(key, value[key]);
    state.free = value.free === true;
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { version = (await sdk.data.set('state', {v: 1, ...state}, version === undefined ? {} : {expectedVersion: version})).version; }
      catch (_) { try { version = (await sdk.data.get('state')).version; } catch (__) { /* best effort */ } }
    }, 800);
  }
  // Share link: v1.<pitch>.<ratio: r + list index, or f + ratio x 1000>.<drift x 100>.<shape>.<spin x 100>.<glow>.<colour>.<tumble x 100>
  // A link the App cannot read is ignored and it opens as saved.
  const SHARE = /^v1\.(\d{2})\.(r\d|f\d{4})\.(-?\d{1,3})\.(\d{1,3})\.(-?\d{1,3})\.(\d{1,3})\.(\d)\.(\d{1,2})$/;
  function shareState() {
    const tumble = source === 'audio' && snapshot ? snapshot.s.tumble : sig.tumble;
    return ['v1', state.pitch, state.free ? 'f' + Math.round(state.value * 1000) : 'r' + state.ratio, Math.round(state.drift * 100), state.shape,
      Math.round(state.spin * 100), state.glow, state.colour, Math.floor((tumble - Math.floor(tumble)) * 100)].join('.');
  }
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
    const free = m[2][0] === 'f', ratio = Number(m[2].slice(1));
    if (free ? ratio < 1000 || ratio > 4000 : ratio >= RATIOS.length) return;
    if (Number(m[7]) >= COLOURS.length) return;
    Object.assign(state, {pitch: tidy('pitch', Number(m[1])), free, drift: tidy('drift', m[3] / 100), shape: tidy('shape', Number(m[4])),
      spin: tidy('spin', m[5] / 100), glow: tidy('glow', Number(m[6])), colour: Number(m[7])});
    if (free) state.value = ratio / 1000; else state.ratio = ratio;
    sig.tumble = Number(m[8]) / 100;
  }

  /* ---------- controls ---------- */
  const downAt = {};
  function setHold(on) { if (holding !== on) { holding = on; gate(); } }
  function setStrike(on) { if (striking !== on) { striking = on; gate(); } }
  function onControl(event) {
    const control = event.control, encoder = ['E1', 'E2', 'E3', 'E4'].indexOf(control);
    if (event.type === 'rotate') {
      const d = Math.trunc(Number(event.delta) || 0);
      if (d && encoder >= 0) CONTROLS[PAGES[state.page].keys[encoder]].turn(d);
    } else if (event.type === 'down') {
      if (control in downAt) return;
      downAt[control] = performance.now();
      if (encoder >= 0) CONTROLS[PAGES[state.page].keys[encoder]].press();
      else if (control === 'K2') setHold(!holding);
      else if (control === 'K3') setStrike(true);
    } else if (event.type === 'up' || event.type === 'cancel') {
      const held = performance.now() - (downAt[control] ?? 0);
      delete downAt[control];
      if (control === 'K3') setStrike(false);
      else if (control === 'K4' && event.type === 'up' && held < 600) set('page', 1 - state.page);
    }
  }
  function build() {
    $('pages').innerHTML = PAGES.map((page, i) => '<button class="tab" type="button" data-page="' + i + '">' + page.name + '</button>').join('');
    $('cells').innerHTML = [0, 1, 2, 3].map(i => '<div class="cell" data-i="' + i + '"><span class="lab"></span><span class="val"></span></div>').join('');
    for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => set('page', Number(tab.dataset.page)));
    $('hold').addEventListener('click', () => setHold(!holding));
    // Pressing the picture strikes, like K3.
    let striker = null;
    $('stage').addEventListener('pointerdown', event => { if (striker === null) { striker = event.pointerId; setStrike(true); } });
    // A value: drag to turn it, tap to press it.
    let drag = null;
    for (const cell of document.querySelectorAll('.cell')) cell.addEventListener('pointerdown', event => {
      if (drag) return;
      drag = {id: event.pointerId, cell, key: PAGES[state.page].keys[Number(cell.dataset.i)], x: event.clientX, y: event.clientY, moved: false, turned: 0};
      cell.classList.add('touch');
    });
    addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const travel = (event.clientX - drag.x) - (event.clientY - drag.y), steps = Math.trunc(travel / 8) - drag.turned;
      if (Math.abs(travel) > 8) drag.moved = true;
      if (steps) { drag.turned += steps; CONTROLS[drag.key].turn(steps); }
    });
    const release = event => {
      if (striker === event.pointerId) { striker = null; setStrike(false); }
      if (drag && event.pointerId === drag.id) {
        drag.cell.classList.remove('touch');
        if (!drag.moved && event.type === 'pointerup') CONTROLS[drag.key].press();
        drag = null;
      }
    };
    addEventListener('pointerup', release); addEventListener('pointercancel', release);
  }
  let monitorTimer = 0;
  function render() {
    const page = PAGES[state.page];
    for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('on', Number(tab.dataset.page) === state.page);
    document.querySelectorAll('.cell').forEach((cell, i) => {
      const control = CONTROLS[page.keys[i]];
      cell.querySelector('.lab').textContent = control.label; cell.querySelector('.val').textContent = control.text();
    });
    $('hold').classList.toggle('on', holding);
    document.documentElement.style.setProperty('--beam', 'rgb(' + COLOURS[state.colour][1].map(v => Math.round(40 + v * 215)).join(',') + ')');
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      const values = {};
      page.keys.forEach((key, i) => { values['E' + (i + 1)] = {label: CONTROLS[key].label, value: CONTROLS[key].text()}; });
      values.K2 = {label: 'Hold', pressed: holding}; values.K3 = {label: 'Strike', pressed: striking}; values.K4 = {label: 'Page', value: page.name};
      try { void sdk.monitor.set(values).catch(() => {}); } catch (_) { /* unavailable */ }
    }, 40);
  }
  function layout() {
    let inset = 0, bars = false;
    try { const now = sdk.context; inset = now.safeInsets?.left || 0; bars = now.viewport?.monitorHeight > 0; } catch (_) { /* default */ }
    document.documentElement.style.setProperty('--inset-left', inset + 'px');
    // While the host shows its E/K bars the values and keys are labelled there: the screen is left to the beam.
    document.documentElement.classList.toggle('bars', bars);
    trace.resize();
  }

  /* ---------- checks ---------- */
  // Frequency of one channel of the drawn history, from its upward zero crossings.
  function pitchOf(channel) {
    let first = -1, last = -1, crossings = 0, before = 0;
    for (let i = 0; i < historyFill; i++) {
      const value = history[2 * ((historyAt - historyFill + i + HISTORY) % HISTORY) + channel];
      if (i && before < 0 && value >= 0) { const at = i - value / (value - before); if (first < 0) first = at; last = at; crossings++; }
      before = value;
    }
    return crossings > 1 ? (crossings - 1) * SR / (last - first) : 0;
  }
  function rmsOf(channel) {
    let sum = 0;
    for (let i = 0; i < lastCount; i++) { const value = history[2 * ((historyAt - lastCount + i + HISTORY) % HISTORY) + channel]; sum += value * value; }
    return lastCount ? Math.sqrt(sum / lastCount) : 0;
  }
  window.__xy = {
    role: isOutput ? 'output' : 'control',
    get firstFrameAt() { return firstFrameAt; },
    get trace() { return trace?.kind; },
    state: () => ({mode: 'synth', pitchHz: settings().freq, ratio: settings().ratio, free: state.free, drift: state.drift, shape: state.shape / 100, spin: state.spin,
      decay: state.decay, glow: state.glow / 100, colour: COLOURS[state.colour][0], holding, page: PAGES[state.page].name}),
    probe: () => ({source, samples: lastCount, fx: pitchOf(0), fy: pitchOf(1), rmsL: rmsOf(0), rmsR: rmsOf(1)}),
    timing: () => ({displayDelayMs: DISPLAY_DELAY_MS, audioLatencyMs: AUDIO_LATENCY_MS, base, have, drawn, began: engine ? engine.began : null, context: engine ? engine.ctx.state : null, marks: {...marks, first: firstFrameAt}, frames: drawLog.slice()}),
    signal: () => bare(isOutput || source !== 'audio' || !snapshot ? sig : snapshot.s),
  };

  /* ---------- start ---------- */
  async function init() {
    trace = window.XYTrace.create($('beam'));
    marks.trace = performance.now();
    new ResizeObserver(layout).observe($('stage'));
    if (isOutput) {
      layout(); show(0, 1 / 60, 0, 0);
      await sdk.ready();
      relay?.onMessage(follow);
      requestAnimationFrame(now => { lastNow = now; requestAnimationFrame(outputFrame); });
      return;
    }
    build();
    try { const saved = await sdk.data.get('state'); version = saved.version; restore(saved.value); } catch (_) { /* first run */ }
    marks.loaded = performance.now();
    applyShare(context.share);
    layout(); render();
    // One full figure at once, before the first animation frame.
    show(own(0.05, preview(settings())), 1 / 60, state.colour, state.glow);
    sdk.controls.onEvent(onControl);
    sdk.audio.onAvailable(() => { if (!engine) void openAudio().catch(() => {}); });
    await sdk.ready();
    requestAnimationFrame(now => { lastNow = now; requestAnimationFrame(frame); });
    setInterval(publish, 1000); publish(); shareSoon();
    // Have the engine ready, silent, so the first key sounds at once. Before the visitor acts a browser may refuse
    // sound; that is not an error: the first key opens it again.
    openAudio().catch(() => {});
  }
  addEventListener('pagehide', () => { clearTimeout(saveTimer); closeAudio(); }, {once: true});
  void init();
})();
