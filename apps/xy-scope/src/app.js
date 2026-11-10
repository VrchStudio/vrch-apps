// app.js: the instrument around the signal. Knobs and keys, the labels on the device screen, saved settings, the share
// link and the large output live here. How a sample is made is in signal.js; how the beam is drawn is in trace.js.
(() => {
  'use strict';
  const sdk = window.VrchApp, Signal = window.XYSignal;
  const Scope = window.XYScope;
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
  const RATIOS = [[1, 1, 'Unison'], [5, 4, 'Third'], [4, 3, 'Fourth'], [3, 2, 'Fifth'], [5, 3, 'Sixth'], [7, 4, 'Seventh'], [2, 1, 'Octave'], [5, 2, 'Tenth'], [3, 1, 'Twelfth'], [4, 1, '2 Octaves']];
  const COLOURS = [['Green', [0.2, 1, 0.45]], ['Amber', [1, 0.6, 0.12]], ['Ice', [0.35, 0.75, 1]], ['Pink', [1, 0.08, 0.58]]];
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const VIEWS = ['Wave', 'XY', 'Spectrum'];
  // pitch: MIDI note of X (A1..A4). ratio: index into RATIOS; free: any ratio ("value") instead. glow and shape in percent.
  // Input mode: view (index into VIEWS), the Wave time window in ms, display gain in dB, or auto to fit the signal.
  const DEFAULTS = {pitch: 45, ratio: 3, free: false, value: 1.5, drift: 0.1, shape: 0, spin: 0, decay: 1.5, glow: 35, colour: 0, page: 0, view: 0, window: 20, gain: 0, auto: true};
  const LIMITS = {pitch: [33, 69, 1], ratio: [0, RATIOS.length - 1, 1], value: [1, 4, 0.001], drift: [-2, 2, 0.01], shape: [0, 100, 1], spin: [-1, 1, 0.01], decay: [0.2, 6, 0.001], glow: [0, 100, 1], colour: [0, COLOURS.length - 1, 1], page: [0, 1, 1],
    view: [0, VIEWS.length - 1, 1], window: [5, 100, 0.1], gain: [-12, 66, 1.5]};
  const tidy = (key, v) => { const [lo, hi, grain] = LIMITS[key]; return clamp(Number((Math.round(v / grain) * grain).toFixed(3)), lo, hi); };
  const state = {...DEFAULTS};
  // mode: 'synth' makes the signal; 'input' shows the device's audio input instead. Every start is in synth mode.
  let holding = false, striking = false, mode = 'synth', frozen = false;

  function settings() {
    const [num, den] = RATIOS[state.ratio];
    return {freq: 440 * 2 ** ((state.pitch - 69) / 12), ratio: state.free ? state.value : num / den, num: state.free ? 0 : num, den: state.free ? 0 : den,
      drift: state.drift, shape: state.shape / 100, spin: state.spin, decay: state.decay, hold: holding ? 1 : 0, strike: striking ? 1 : 0};
  }
  const glowSeconds = percent => 0.02 * 100 ** (percent / 100);   // 20 ms .. 2 s
  const signed = (v, digits) => (v > 0 ? '+' : '') + (Math.abs(v) < 0.5 / 10 ** digits ? 0 : v).toFixed(digits);
  const fast = d => d * Math.max(1, Math.abs(d));                 // a quick turn covers more ground
  const around = (key, steps, count) => set(key, ((state[key] + steps) % count + count) % count);
  let colourTurn = 0, viewTurn = 0, shownGain = 1;
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
      turn: d => { colourTurn += d; const steps = Math.trunc(colourTurn / 2); if (steps) { colourTurn -= steps * 2; around('colour', steps, COLOURS.length); } }},
    window: {label: 'Window', text: () => state.view ? '-' : state.window.toFixed(state.window < 10 ? 1 : 0) + ' ms', turn: d => set('window', state.window * 1.12 ** d), press: () => set('window', DEFAULTS.window)},
    // Turning leaves auto from the gain being shown; pressing returns to auto.
    gain: {label: 'Gain', text: () => state.auto ? 'Auto' : signed(state.gain, 1) + ' dB', press: () => { state.auto = true; changed(); },
      turn: d => { state.gain = tidy('gain', (state.auto ? 20 * Math.log10(shownGain) : state.gain) + 1.5 * d); state.auto = false; changed(); }},
    view: {label: 'View', text: () => VIEWS[state.view], press: () => {},
      turn: d => { viewTurn += d; const steps = Math.trunc(viewTurn / 2); if (steps) { viewTurn -= steps * 2; around('view', steps, VIEWS.length); } }},
  };
  const PAGES = [{name: 'Tone', keys: ['pitch', 'ratio', 'drift', 'shape']}, {name: 'Motion', keys: ['spin', 'decay', 'glow', 'colour']}];
  const INPUT_PAGE = {name: 'Input', keys: ['window', 'gain', 'view', 'glow']};
  const page = () => mode === 'input' ? INPUT_PAGE : PAGES[state.page];

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
  // stroke: {fresh, rate} for a picture that is not the running signal (see trace.js); those are not kept.
  function show(count, dt, colour, glow, stroke) {
    for (let i = 0; i < count && !stroke; i++) {
      history[2 * historyAt] = points[2 * i] * LEVEL; history[2 * historyAt + 1] = points[2 * i + 1] * LEVEL;
      historyAt = (historyAt + 1) % HISTORY;
    }
    if (!stroke) historyFill = Math.min(HISTORY, historyFill + count);
    lastCount = count;
    trace.draw(points, count, {colour: COLOURS[colour][1], glow: glowSeconds(glow), dt, fresh: !!stroke?.fresh, rate: stroke?.rate});
    if (count && firstFrameAt === null) firstFrameAt = performance.now();
    if (gaps.length < 2000) { gaps.push(dt * 1000); busy += performance.now() - lastNow; }
  }
  // Every five seconds one console line of measured numbers, for whoever observes the App (apps_observe reads an
  // App's console output): frames a second, the gaps between frames, time spent per frame, and what is being drawn.
  const gaps = [];
  let busy = 0;
  function report() {
    if (gaps.length < 2) { gaps.length = 0; busy = 0; return; }
    const sorted = gaps.slice(1).sort((a, b) => a - b), total = sorted.reduce((a, b) => a + b, 0), round = v => Math.round(v * 10) / 10, canvas = trace.canvas;
    const line = {role: isOutput ? 'output' : 'control', fps: round(1000 * sorted.length / total), gapP95: round(sorted[Math.floor(sorted.length * 0.95)]), gapMax: round(sorted[sorted.length - 1]),
      busyMs: round(busy / gaps.length), trace: trace.kind, canvas: [canvas.width, canvas.height], dpr: window.devicePixelRatio, mode: isOutput ? following?.mode || null : mode, ...window.__xy.probe()};
    for (const key of ['fx', 'fy', 'peakHz', 'tunerHz']) if (key in line) line[key] = Math.round(line[key] * 100) / 100;
    for (const key of ['rmsL', 'rmsR', 'wander']) if (key in line) line[key] = Math.round(line[key] * 1e4) / 1e4;
    if (!isOutput && engine) Object.assign(line, {engine: engine.ctx.state, firstMs: Math.round(firstFrameAt || 0), glMs: Math.round(marks.trace - marks.script)});
    console.debug('scope ' + JSON.stringify(line));
    gaps.length = 0; busy = 0;
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
      let ctx = null, output = null;
      try {
        ctx = new AudioContext({sampleRate: SR, latencyHint: 'interactive', sinkId: {type: 'none'}});
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
        await Promise.allSettled([output?.close(), ctx?.close()]);
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

  /* ---------- input mode: the pocket oscilloscope ---------- */
  // The audio input opens only when the visitor switches to input mode and closes on leaving it. Nothing heard here
  // is sent to the speakers: listening is left to the device's own audio routing.
  const HEARD = 32768, COLUMNS = 256, SWEEP = 2048;
  const heardRing = new Float32Array(HEARD * 2), mono = new Float32Array(HEARD), levels = new Float32Array(COLUMNS), sweep = new Float32Array(SWEEP * 2);
  let input = null, inputEpoch = 0, inputWaits = false, heard = 0, heardDrawn = 0, listen = 0, loudest = 0, analyser = null;
  let sweepCount = 0, sweepPairs = false, tuned = '', tunedHz = 0, steady = 0, tunerTurn = 0, peakHz = 0, wander = 0;
  async function openInput() {
    const mine = ++inputEpoch;
    inputWaits = false;
    try {
      const opened = await sdk.audio.openInput({channels: 2, echoCancellation: false});   // echo cancelling would change the wave
      if (mine !== inputEpoch || mode !== 'input') { void Promise.resolve(opened.close()).catch(() => {}); return; }
      input = opened; heard = 0; heardDrawn = 0;
      opened.onData(samples => {
        if (input !== opened || frozen) return;
        for (let i = 0, frames = samples.length / 2; i < frames; i++) { const at = ((heard + i) % HEARD) * 2; heardRing[at] = samples[2 * i]; heardRing[at + 1] = samples[2 * i + 1]; }
        heard += samples.length / 2;
      });
      opened.onError(() => { if (input === opened) { input = null; inputWaits = true; notice('Audio input stopped. Hold K4 for synth.', true); } });
      notice('');
    } catch (error) {
      if (mine !== inputEpoch || mode !== 'input') return;
      const code = error?.code || error?.name, refused = ['permission_required', 'permission_denied', 'capability_denied', 'io_not_authorized', 'NotAllowedError'].includes(code);
      // A missing device is waited for; a refusal is not asked again until the visitor switches to input once more.
      inputWaits = !refused;
      notice((refused ? 'Audio input is not allowed.' : 'No audio input.') + ' Hold K4 for synth.', true);
    }
  }
  function closeInput() {
    const old = input;
    input = null; ++inputEpoch; inputWaits = false;
    if (old) void Promise.resolve(old.close()).catch(() => {});
  }
  function setMode(next) {
    if (next === mode) return;
    mode = next; frozen = false; sweepCount = 0; tuned = ''; $('tuner').textContent = ''; steady = 0; loudest = 0;
    if (mode === 'input') { holding = false; striking = false; push(); void openInput(); }
    else { closeInput(); notice(''); }
    dirty = true; publish();
  }
  function setFrozen(on) { if (frozen !== on) { frozen = on; dirty = true; publish(); } }
  // The newest "count" samples of the louder channel, with any constant offset removed, into mono[]. Returns how many.
  // The offset is a mean that fades in and out over the stretch (a Hann window): a plain mean of a tone that does not
  // fit the stretch a whole number of times would move with the tone's phase and make a steady wave shimmer.
  function tail(count) {
    count = Math.min(count, heard, HEARD);
    const step = 2 * Math.PI / (count || 1), turnC = Math.cos(step), turnS = Math.sin(step);
    let left = 0, right = 0, sumL = 0, sumR = 0, weights = 0, c = Math.cos(step / 2), s = Math.sin(step / 2);
    for (let i = 0, f = heard - count; i < count; i++, f++) {
      const at = (f % HEARD) * 2, l = heardRing[at], r = heardRing[at + 1], weight = 1 - c, next = c * turnC - s * turnS;
      left += l * l; right += r * r; sumL += l * weight; sumR += r * weight; weights += weight; s = s * turnC + c * turnS; c = next;
    }
    if (listen ? left > right * 2 : right > left * 2) listen = 1 - listen;
    const mean = (listen ? sumR : sumL) / (weights || 1);
    for (let i = 0, f = heard - count; i < count; i++, f++) mono[i] = heardRing[(f % HEARD) * 2 + listen] - mean;
    return count;
  }
  const fit = v => clamp(v, -1.42, 1.42);
  // One frame of the input picture into points[]. Wave and Spectrum are a fresh stroke across the screen each frame;
  // XY runs on through every new sample, left across and right up.
  function inputPicture(dt) {
    if (!frozen && heard) {
      // Display gain: auto fits the recent peak to nine tenths of full size and lets go slowly.
      let peak = 0;
      for (let f = Math.max(0, heard - 2400); f < heard; f++) { const at = (f % HEARD) * 2; peak = Math.max(peak, Math.abs(heardRing[at]), Math.abs(heardRing[at + 1])); }
      loudest = Math.max(peak, loudest * Math.exp(-dt / 0.8));
      shownGain = state.auto ? clamp(0.9 / Math.max(loudest, 1e-5), 0.9, 400) : 10 ** (state.gain / 20);
      if (++tunerTurn % 4 === 0) tune();
      if (state.view === 1) {
        let count = 0;
        for (let f = Math.max(heardDrawn, heard - MAX_POINTS, 0); f < heard; f++, count++) { const at = (f % HEARD) * 2; points[2 * count] = fit(heardRing[at] * shownGain); points[2 * count + 1] = fit(heardRing[at + 1] * shownGain); }
        heardDrawn = heard;
        if (count) { sweepCount = Math.min(count, SWEEP); sweepPairs = true; sweep.set(points.subarray((count - sweepCount) * 2, count * 2)); send('x', points, count * 2); }
        return {count, stroke: {fresh: false}};
      }
      heardDrawn = heard;
      if (state.view === 0) {
        const length = Math.round(state.window * PER_MS), count = tail(length + 2400);
        if (count > length + 2) {
          let start = Scope.trigger(mono, count, length);
          if (start < 0) start = count - length - 1;
          const n = Math.min(length, SWEEP), stride = length / n;
          let moved = 0;
          for (let k = 0; k < n; k++) {
            const at = start + k * stride, i = Math.min(Math.floor(at), count - 2), mix = at - i, value = fit((mono[i] * (1 - mix) + mono[i + 1] * mix) * shownGain);
            moved += Math.abs(value - sweep[k]); sweep[k] = value;
          }
          wander = sweepCount === n && !sweepPairs ? moved / n : 1; sweepCount = n; sweepPairs = false; send('w', sweep, n);
        }
      } else {
        analyser ||= Scope.spectrum();
        if (tail(analyser.size) === analyser.size) {
          peakHz = analyser.read(mono, levels, COLUMNS);
          // -84 dB at the bottom of the screen, 0 dB at the top; a set gain lifts the whole curve.
          for (let c = 0; c < COLUMNS; c++) sweep[c] = clamp((levels[c] + (state.auto ? 0 : state.gain) + 84) / 84 * 2.4 - 1.2, -1.25, 1.3);
          sweepCount = COLUMNS; sweepPairs = false; send('s', sweep, COLUMNS);
        }
      }
    }
    return {count: lay(), stroke: {fresh: true}};
  }
  // The kept sweep into points[]: heights spread across this screen's width, or the kept XY points as they are.
  function lay() {
    if (sweepPairs) { points.set(sweep.subarray(0, sweepCount * 2)); return sweepCount; }
    const span = trace.extent()[0] * 0.94;
    for (let k = 0; k < sweepCount; k++) { points[2 * k] = sweepCount > 1 ? span * (2 * k / (sweepCount - 1) - 1) : 0; points[2 * k + 1] = sweep[k]; }
    return sweepCount;
  }
  // Tuner: a note name and how far off it is, once a clear pitch has held for a few readings.
  function tune() {
    const count = tail(3400);
    let power = 0;
    for (let i = 0; i < count; i++) power += mono[i] * mono[i];
    const found = count && power / count > 4e-6 ? Scope.pitch(mono, count) : {hz: 0, clear: 0};
    if (found.clear > 0.85 && tunedHz && Math.abs(1200 * Math.log2(found.hz / tunedHz)) < 40) { steady++; tunedHz += (found.hz - tunedHz) * 0.4; }
    else { steady = found.clear > 0.85 ? 1 : 0; tunedHz = found.clear > 0.85 ? found.hz : 0; }
    const named = steady >= 3 ? Scope.note(tunedHz) : null, text = named ? named.name + ' ' + signed(Math.round(named.cents), 0) + ' ct' : '';
    if (text !== tuned) { tuned = text; $('tuner').textContent = text; }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (now <= lastNow) return;   // a host may run animation callbacks twice in one frame
    const dt = clamp((now - lastNow) / 1000, 0, 0.1); lastNow = now;
    if (dirty) { dirty = false; render(); }
    if (mode === 'input') { const picture = inputPicture(dt); show(picture.count, dt, state.colour, state.glow, picture.count ? {...picture.stroke, rate: picture.stroke.fresh ? picture.count / dt : SR} : picture.stroke); return; }
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
    if (mode === 'input') {
      try { relay.publish({v: 1, mode: 'input', colour: state.colour, glow: state.glow, frozen, at: epoch(performance.now())}); } catch (_) { /* no output */ }
      return;
    }
    const audio = source === 'audio';
    if (audio && !snapshot) return;
    const now = epoch(performance.now());
    const message = {v: 1, mode: 'synth', p: settings(), preview: !audio, colour: state.colour, glow: state.glow, at: now + (audio ? DISPLAY_DELAY_MS : 0),
      s: audio ? snapshot.s : bare(sig), sAt: audio ? epoch(snapshot.frame / PER_MS + base + DISPLAY_DELAY_MS) : epoch(lastNow)};
    try { relay.publish(message); } catch (_) { /* no output */ }
  }
  // Input pictures go to the output as they are drawn: heights, or XY pairs, packed 15 bits to a character.
  const CODES = new Uint16Array(1024), PACKED = 4800;
  function send(kind, values, count) {
    if (isOutput || !relay) return;
    let text = '';
    for (let from = Math.max(0, count - PACKED); from < count; from += 1024) {
      const n = Math.min(1024, count - from);
      for (let i = 0; i < n; i++) CODES[i] = 32 + Math.round((clamp(values[from + i], -1.5, 1.5) + 1.5) / 3 * 32767);
      text += String.fromCharCode.apply(null, CODES.subarray(0, n));
    }
    try { relay.send({v: 1, k: kind, d: text}); } catch (_) { /* no output */ }
  }
  const unpack = (text, i) => (text.charCodeAt(i) - 32) / 32767 * 3 - 1.5;
  const queue = [], inbox = [];
  let following = null, arriving = null;
  function follow({kind, data} = {}) {
    if (!data || data.v !== 1) return;
    if (kind === 'state' && (data.mode === 'input' || data.p && data.s)) { queue.push(data); if (queue.length > 64) queue.shift(); }
    else if (kind === 'event' && typeof data.d === 'string' && data.d.length <= PACKED) {
      if (data.k === 'x') { if (inbox.length < 8) inbox.push(data.d); }
      else if (data.k === 'w' || data.k === 's') {
        sweepCount = Math.min(data.d.length, SWEEP); sweepPairs = false;
        for (let i = 0; i < sweepCount; i++) sweep[i] = unpack(data.d, i);
      }
    }
  }
  function outputFrame(now) {
    requestAnimationFrame(outputFrame);
    if (now <= lastNow) return;
    const dt = clamp((now - lastNow) / 1000, 0, 0.1), wall = epoch(now); lastNow = now;
    while (queue.length && queue[0].at <= wall) {
      const next = queue.shift();
      if (next.mode !== following?.mode) { sweepCount = 0; inbox.length = 0; }
      following = next; arriving = next.mode === 'input' ? null : next;
    }
    if (!following) { show(0, dt, 0, 0); return; }
    const colour = clamp(following.colour | 0, 0, COLOURS.length - 1), glow = clamp(Number(following.glow) || 0, 0, 100);
    if (following.mode === 'input') {
      // XY points run on as they arrive; a Wave or Spectrum sweep (or a frozen picture) is drawn afresh every frame.
      let count = 0, fresh = true;
      if (inbox.length) {
        fresh = false;
        for (const text of inbox.splice(0)) for (let i = 0; i + 1 < text.length && count < MAX_POINTS; i += 2, count++) { points[2 * count] = unpack(text, i); points[2 * count + 1] = unpack(text, i + 1); }
        sweepCount = Math.min(count, SWEEP); sweepPairs = true; sweep.set(points.subarray((count - sweepCount) * 2, count * 2));
      } else if (!sweepPairs || following.frozen) count = lay();
      show(count, dt, colour, glow, {fresh, rate: fresh && count ? count / dt : SR});
      return;
    }
    const p = following.preview ? preview(following.p) : following.p;
    if (arriving && arriving.sAt <= wall) {
      sig = revive(arriving.s);
      advance(sig, p, clamp(Math.round((wall - arriving.sAt) * PER_MS), 0, SR * 5));
      arriving = null; owed = 0;
    }
    show(own(dt, p), dt, colour, glow);
  }

  /* ---------- saved settings and the share link ---------- */
  let version, saveTimer = 0, shareTimer = 0, shared = '';
  function restore(value) {
    if (!value || value.v !== 1) return;
    for (const key in LIMITS) if (Number.isFinite(value[key])) state[key] = tidy(key, value[key]);
    state.free = value.free === true;
    state.auto = value.auto !== false;
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
  let modeTimer = 0;
  function setHold(on) { if (holding !== on) { holding = on; gate(); } }
  function setStrike(on) { if (striking !== on) { striking = on; gate(); } }
  // K2: hold the tone, or in input mode freeze the picture.
  const second = () => mode === 'input' ? setFrozen(!frozen) : setHold(!holding);
  function onControl(event) {
    const control = event.control, encoder = ['E1', 'E2', 'E3', 'E4'].indexOf(control);
    if (event.type === 'rotate') {
      const d = Math.trunc(Number(event.delta) || 0);
      if (d && encoder >= 0) CONTROLS[page().keys[encoder]].turn(d);
    } else if (event.type === 'down') {
      if (control in downAt) return;
      downAt[control] = performance.now();
      if (encoder >= 0) CONTROLS[page().keys[encoder]].press();
      else if (control === 'K2') second();
      else if (control === 'K3' && mode === 'synth') setStrike(true);
      // K4 held: the other mode. A short press turns the page (on release).
      else if (control === 'K4') modeTimer = setTimeout(() => { modeTimer = 0; setMode(mode === 'input' ? 'synth' : 'input'); }, 600);
    } else if (event.type === 'up' || event.type === 'cancel') {
      delete downAt[control];
      if (control === 'K3') setStrike(false);
      else if (control === 'K4' && modeTimer) { clearTimeout(modeTimer); modeTimer = 0; if (event.type === 'up' && mode === 'synth') set('page', 1 - state.page); }
    }
  }
  function build() {
    $('pages').innerHTML = PAGES.map((page, i) => '<button class="tab" type="button" data-page="' + i + '">' + page.name + '</button>').join('');
    $('cells').innerHTML = [0, 1, 2, 3].map(i => '<div class="cell" data-i="' + i + '"><span class="lab"></span><span class="val"></span></div>').join('');
    for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => set('page', Number(tab.dataset.page)));
    $('hold').addEventListener('click', second);
    $('mode').addEventListener('click', () => setMode(mode === 'input' ? 'synth' : 'input'));
    // Pressing the picture strikes, like K3.
    let striker = null;
    $('stage').addEventListener('pointerdown', event => { if (striker === null && mode === 'synth') { striker = event.pointerId; setStrike(true); } });
    // A value: drag to turn it, tap to press it.
    let drag = null;
    for (const cell of document.querySelectorAll('.cell')) cell.addEventListener('pointerdown', event => {
      if (drag) return;
      drag = {id: event.pointerId, cell, key: page().keys[Number(cell.dataset.i)], x: event.clientX, y: event.clientY, moved: false, turned: 0};
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
    const shown = page(), listening = mode === 'input';
    document.documentElement.dataset.mode = mode;
    for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('on', Number(tab.dataset.page) === state.page);
    document.querySelectorAll('.cell').forEach((cell, i) => {
      const control = CONTROLS[shown.keys[i]];
      cell.querySelector('.lab').textContent = control.label; cell.querySelector('.val').textContent = control.text();
    });
    $('mode').textContent = listening ? 'Input' : 'Synth';
    $('hold').textContent = listening ? 'Freeze' : 'Hold'; $('hold').classList.toggle('on', listening ? frozen : holding);
    document.documentElement.style.setProperty('--beam', 'rgb(' + COLOURS[state.colour][1].map(v => Math.round(40 + v * 215)).join(',') + ')');
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      const values = {};
      shown.keys.forEach((key, i) => { values['E' + (i + 1)] = {label: CONTROLS[key].label, value: CONTROLS[key].text()}; });
      values.K2 = listening ? {label: 'Freeze', pressed: frozen} : {label: 'Hold', pressed: holding};
      values.K3 = listening ? {label: ''} : {label: 'Strike', pressed: striking};
      values.K4 = listening ? {label: 'Hold', value: 'Synth'} : {label: 'Page', value: shown.name};
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
  // Frequency from upward zero crossings of read(0..count-1).
  function crossingsOf(read, count) {
    let first = -1, last = -1, crossings = 0, before = 0;
    for (let i = 0; i < count; i++) {
      const value = read(i);
      if (i && before < 0 && value >= 0) { const at = i - value / (value - before); if (first < 0) first = at; last = at; crossings++; }
      before = value;
    }
    return crossings > 1 ? (crossings - 1) * SR / (last - first) : 0;
  }
  // One channel of the drawn history (the last half second), and of what the input heard.
  const pitchOf = channel => crossingsOf(i => history[2 * ((historyAt - historyFill + i + HISTORY) % HISTORY) + channel], historyFill);
  const heardCount = () => Math.min(heard, HISTORY);
  const heardPitch = channel => crossingsOf(i => heardRing[((heard - heardCount() + i) % HEARD) * 2 + channel], heardCount());
  function heardRms(channel) {
    const count = Math.min(heard, 960);
    let sum = 0;
    for (let f = heard - count; f < heard; f++) { const value = heardRing[(f % HEARD) * 2 + channel]; sum += value * value; }
    return count ? Math.sqrt(sum / count) : 0;
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
    state: () => ({mode, pitchHz: settings().freq, ratio: settings().ratio, free: state.free, drift: state.drift, shape: state.shape / 100, spin: state.spin,
      decay: state.decay, glow: state.glow / 100, colour: COLOURS[state.colour][0], holding, page: PAGES[state.page].name,
      ...(mode === 'input' ? {view: VIEWS[state.view], windowMs: state.window, gain: state.auto ? 'auto' : state.gain, frozen, listening: !!input} : {})}),
    // In input mode: what the input heard (fx, fy, rms per channel), the spectrum's loudest frequency, the tuner's
    // reading, and how much the Wave sweep moved since the frame before (0 = standing still).
    probe: () => !isOutput && mode === 'input'
      ? {source: 'input', samples: lastCount, fx: heardPitch(0), fy: heardPitch(1), rmsL: heardRms(0), rmsR: heardRms(1), peakHz, tuner: tuned, tunerHz: steady >= 3 ? tunedHz : 0, wander, notice: $('notice').hidden ? '' : $('notice').textContent}
      : {source, samples: lastCount, fx: pitchOf(0), fy: pitchOf(1), rmsL: rmsOf(0), rmsR: rmsOf(1)},
    timing: () => ({displayDelayMs: DISPLAY_DELAY_MS, audioLatencyMs: AUDIO_LATENCY_MS, base, have, drawn, began: engine ? engine.began : null, context: engine ? engine.ctx.state : null, marks: {...marks, first: firstFrameAt}, frames: drawLog.slice()}),
    signal: () => bare(isOutput || source !== 'audio' || !snapshot ? sig : snapshot.s),
  };

  /* ---------- start ---------- */
  async function init() {
    trace = window.XYTrace.create($('beam'));
    marks.trace = performance.now();
    new ResizeObserver(layout).observe($('stage'));
    setInterval(report, 5000);
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
    sdk.audio.onAvailable(() => {
      if (!engine) void openAudio().catch(() => {});
      if (mode === 'input' && !input && inputWaits) void openInput();
    });
    await sdk.ready();
    requestAnimationFrame(now => { lastNow = now; requestAnimationFrame(frame); });
    setInterval(publish, 1000); publish(); shareSoon();
    // Have the engine ready, silent, so the first key sounds at once. Before the visitor acts a browser may refuse
    // sound; that is not an error: the first key opens it again.
    openAudio().catch(() => {});
  }
  addEventListener('pagehide', () => { clearTimeout(saveTimer); closeInput(); closeAudio(); }, {once: true});
  void init();
})();
