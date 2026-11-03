(() => {
  'use strict';

  const sdk = VrchApp;
  const $ = (id) => document.getElementById(id);
  const preview = sdk.context.mode === 'preview';
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const SAVE_KEY = 'settings';

  const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const pct = (v) => Math.round(v * 100) + '%';
  const pct2 = (v) => Math.round(v * 200) + '%';

  const DEFAULTS = {
    page: 0,
    gainDb: 36, amt: 0.5, tuneSpeed: 0.5, vol: 0.8, tuneOn: true, key: 19,
    dnOn: true, dnStrength: 0.6, dnThrDb: -55, dnDepth: 0.85, dnAttMs: 2, dnRelMs: 120,
    ottOn: true, ottThrDb: -26, ottUp: 0.7, ottDown: 0.6, ottSpeed: 0.4,
    distOn: false, drive: 0, tone: 0.5, distMix: 0.5, distBias: 0
  };
  const state = { ...DEFAULTS };

  const PAGES = [
    {
      name: 'Main', toggle: 'tuneOn', toggleName: 'Tune',
      knobs: [
        { label: 'Gain', key: 'gainDb', min: 0, max: 60, step: 3, fmt: (v) => Math.round(v) + ' dB', reset: 36 },
        { label: 'Tune', key: 'amt', min: 0, max: 1, step: 0.05, fmt: pct, reset: 0.5 },
        { label: 'Speed', key: 'tuneSpeed', min: 0, max: 1, step: 0.05, fmt: pct, reset: 0.5 },
        { label: 'Output', key: 'vol', min: 0, max: 1.2, step: 0.05, fmt: pct, reset: 0.8 }
      ]
    },
    {
      name: 'Denoise', toggle: 'dnOn', toggleName: 'Denoise',
      knobs: [
        { label: 'Amount', key: 'dnStrength', min: 0, max: 1, step: 0.05, fmt: pct, reset: 0.6 },
        { label: 'Threshold', key: 'dnThrDb', min: -80, max: -20, step: 2, fmt: (v) => Math.round(v) + ' dB', reset: -55 },
        { label: 'Depth', key: 'dnDepth', min: 0, max: 1, step: 0.05, fmt: pct, reset: 0.85 },
        { label: 'Release', key: 'dnRelMs', min: 20, max: 600, step: 20, fmt: (v) => Math.round(v) + ' ms', reset: 120 }
      ]
    },
    {
      name: 'OTT', toggle: 'ottOn', toggleName: 'OTT',
      knobs: [
        { label: 'Threshold', key: 'ottThrDb', min: -50, max: 0, step: 2, fmt: (v) => Math.round(v) + ' dB', reset: -26 },
        { label: 'Upward', key: 'ottUp', min: 0, max: 1, step: 0.05, fmt: pct, reset: 0.7 },
        { label: 'Downward', key: 'ottDown', min: 0, max: 1, step: 0.05, fmt: pct, reset: 0.6 },
        { label: 'Speed', key: 'ottSpeed', min: 0, max: 1, step: 0.05, fmt: pct, reset: 0.4 }
      ]
    },
    {
      name: 'Distortion', toggle: 'distOn', toggleName: 'Distortion',
      knobs: [
        { label: 'Drive', key: 'drive', min: 0, max: 1, step: 0.05, fmt: pct, reset: 0.35 },
        { label: 'Tone', key: 'tone', min: 0, max: 1, step: 0.05, fmt: pct, reset: 0.5 },
        { label: 'Mix', key: 'distMix', min: 0, max: 1, step: 0.05, fmt: pct, reset: 0.5 },
        { label: 'Bias', key: 'distBias', min: 0, max: 0.5, step: 0.02, fmt: pct2, reset: 0 }
      ]
    }
  ];

  const PRESETS = [
    {
      name: 'Clean', v: { gainDb: 30, amt: 0.3, tuneSpeed: 0.5, vol: 0.8, dnOn: true, dnThrDb: -55, dnDepth: 0.8,
        ottOn: true, ottThrDb: -26, ottUp: 0.4, ottDown: 0.4, distOn: false, drive: 0 }
    },
    {
      name: 'Radio', v: { gainDb: 40, amt: 0.5, tuneSpeed: 0.5, vol: 0.85, dnOn: true, dnStrength: 0.85, dnThrDb: -50, dnDepth: 0.9,
        ottOn: true, ottThrDb: -30, ottUp: 0.8, ottDown: 0.7, distOn: false, drive: 0 }
    },
    {
      name: 'Hard Tune', v: { gainDb: 36, amt: 1, tuneSpeed: 0.9, vol: 0.8, dnOn: true, dnThrDb: -55, dnDepth: 0.85,
        ottOn: true, ottThrDb: -26, ottUp: 0.5, ottDown: 0.5, distOn: false, drive: 0 }
    },
    {
      name: 'Distortion', v: { gainDb: 36, amt: 0.6, vol: 0.7, dnOn: true, dnThrDb: -55, dnDepth: 0.85,
        ottOn: true, ottThrDb: -26, ottUp: 0.7, ottDown: 0.6, distOn: true, drive: 0.7, tone: 0.6, distMix: 0.7, distBias: 0.1 }
    }
  ];

  let phase = 'idle';
  let engine = null;
  let epoch = 0;
  let version;
  let saveTimer = 0;
  let monitorTimer = 0;
  let presetIndex = -1;
  const meter = { inp: 0 };
  const tune = { f0: 0, midi: 0, target: 0, voiced: false };

  const page = () => PAGES[state.page];
  const keyName = (k) => NOTE[(k >> 1) % 12] + ((k & 1) ? ' minor' : ' major');
  const noteName = (midi) => NOTE[((Math.round(midi) % 12) + 12) % 12] + (Math.floor(Math.round(midi) / 12) - 1);

  /* ── audio ─────────────────────────────────────────────────────────── */
  function pushParams() {
    if (!engine) return;
    engine.node.port.postMessage({
      type: 'params',
      p: {
        gainDb: state.gainDb, amt: state.amt, tuneSpeed: state.tuneSpeed, vol: state.vol,
        tuneOn: state.tuneOn, key: state.key,
        dnOn: state.dnOn, dnStrength: state.dnStrength, dnThrDb: state.dnThrDb, dnDepth: state.dnDepth,
        dnAttMs: state.dnAttMs, dnRelMs: state.dnRelMs,
        ottOn: state.ottOn, ottThrDb: state.ottThrDb, ottUp: state.ottUp, ottDown: state.ottDown, ottSpeed: state.ottSpeed,
        distOn: state.distOn, drive: state.drive, tone: state.tone, distMix: state.distMix, distBias: state.distBias
      }
    });
  }

  async function start() {
    if (phase === 'starting' || phase === 'live') return;
    const token = ++epoch;
    const e = {};
    phase = 'starting';
    renderGate();
    render();
    try {
      e.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive', sinkId: { type: 'none' } });
      if (!e.ctx.audioWorklet) throw Object.assign(new Error('no worklet'), { code: 'unsupported_environment' });
      await e.ctx.resume();
      if (e.ctx.state !== 'running') throw Object.assign(new Error('gesture'), { code: 'interaction_required' });
      await e.ctx.audioWorklet.addModule(new URL('dsp.js', location.href).href);
      e.node = new AudioWorkletNode(e.ctx, 'vocal-chain', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2]
      });
      e.out = await sdk.audio.openOutput({ channels: 2 });
      e.outNode = await e.out.createNode(e.ctx);
      e.node.connect(e.outNode);
      if (!preview) {
        const attempts = [
          { channels: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          { channels: 1, echoCancellation: true },
          { channels: 2 }
        ];
        for (let i = 0; i < attempts.length && !e.in; i++) {
          try {
            e.in = await sdk.audio.openInput(attempts[i]);
          } catch (error) {
            if (error.code === 'permission_required' || i === attempts.length - 1) throw error;
          }
        }
        if (e.in.silent) throw Object.assign(new Error('silent'), { code: 'audio_device_unavailable' });
        e.inNode = await e.in.createNode(e.ctx);
        e.inNode.connect(e.node);
      }
      e.node.port.onmessage = ({ data }) => {
        if (engine !== e || !data || data.type !== 'meter') return;
        meter.inp = Math.max(meter.inp, data.inp);
        tune.voiced = !!data.voiced;
        tune.f0 = data.f0 || 0;
        tune.midi = data.midi || 0;
        tune.target = data.target || 0;
        renderTuner();
      };
      if (token !== epoch) { await release(e); return; }
      engine = e;
      phase = 'live';
      pushParams();
      e.ctx.onstatechange = () => {
        if (engine === e && e.ctx.state !== 'running') fail('Audio paused. Tap Start to resume.');
      };
      renderGate();
      render();
      setStatus(defaultStatus());
    } catch (error) {
      await release(e);
      if (token !== epoch) return;
      const code = error.code || error.name;
      fail(code === 'permission_required' ? 'Allow audio input in Device Access, then tap Retry.'
        : code === 'audio_device_unavailable' ? 'Choose available IN and OUT in the K1 Menu, then tap Retry.'
          : code === 'interaction_required' ? 'Tap Start to enable audio.'
            : 'Audio unavailable. Tap Retry.');
    }
  }

  async function release(e) {
    if (!e) return;
    try { e.inNode?.disconnect(); e.node?.disconnect(); e.outNode?.disconnect(); } catch (_) { /* gone */ }
    await Promise.allSettled([e.in?.close(), e.out?.close(), e.ctx?.close()]);
  }

  async function stop() {
    epoch++;
    const e = engine;
    engine = null;
    phase = 'idle';
    await release(e);
  }

  function fail(message) {
    const e = engine;
    engine = null;
    phase = 'error';
    void release(e);
    $('gate-msg').textContent = message;
    $('gate-btn').textContent = 'Retry';
    $('gate-btn').disabled = false;
    renderGate();
    render();
  }

  /* ── parameter editing ─────────────────────────────────────────────── */
  function setKnob(index, value) {
    const k = page().knobs[index];
    state[k.key] = clamp(value, k.min, k.max);
    presetIndex = -1;
    pushParams();
    save();
    render();
  }

  function resetKnob(index) {
    const k = page().knobs[index];
    state[k.key] = k.reset;
    presetIndex = -1;
    pushParams();
    save();
    setStatus(k.label + ' reset to default.');
    render();
  }

  function nextPage() {
    state.page = (state.page + 1) % PAGES.length;
    pushParams();
    save();
    setStatus('Page: ' + page().name);
    buildRows();
    render();
  }

  function toggleModule() {
    const p = page();
    state[p.toggle] = !state[p.toggle];
    presetIndex = -1;
    pushParams();
    save();
    setStatus(p.toggleName + (state[p.toggle] ? ' On' : ' Off'));
    render();
  }

  function nextKey() {
    state.key = (state.key + 1) % 24;
    presetIndex = -1;
    pushParams();
    save();
    setStatus('Tuning key: ' + keyName(state.key));
    render();
  }

  function applyPreset(i) {
    presetIndex = i;
    Object.assign(state, DEFAULTS, PRESETS[i].v);
    pushParams();
    save();
    setStatus('Preset: ' + PRESETS[i].name);
    buildRows();
    render();
  }

  function defaultStatus() {
    return page().name + ' · E1–E4 Parameters · K2 Page · K3 Key · K4 Toggle';
  }

  /* ── persistence ───────────────────────────────────────────────────── */
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const result = await sdk.data.set(SAVE_KEY, state, { expectedVersion: version });
        version = result.version;
      } catch (_) { /* best effort */ }
    }, 700);
  }

  async function load() {
    try {
      const result = await sdk.data.get(SAVE_KEY);
      version = result.version;
      const v = result.value;
      if (!v) return;
      for (const k of Object.keys(DEFAULTS)) {
        const d = DEFAULTS[k];
        const x = v[k];
        if (typeof d === 'number' && Number.isFinite(x)) state[k] = x;
        else if (typeof d === 'boolean' && typeof x === 'boolean') state[k] = x;
      }
      state.page = clamp(Math.round(state.page), 0, PAGES.length - 1);
      state.key = ((Math.round(state.key) % 24) + 24) % 24;
    } catch (_) { /* first run */ }
  }

  /* ── controls ──────────────────────────────────────────────────────── */
  const KNOB_INDEX = { E1: 0, E2: 1, E3: 2, E4: 3 };

  function handleControl(e) {
    const i = KNOB_INDEX[e.control];
    if (e.type === 'rotate') {
      if (i === undefined) return;
      const k = page().knobs[i];
      setKnob(i, state[k.key] + e.delta * k.step);
      return;
    }
    if (e.type === 'down') {
      if (!engine && (e.control === 'K2' || e.control === 'K3' || e.control === 'K4')) { void start(); return; }
      if (i !== undefined) { resetKnob(i); return; }
      if (e.control === 'K2') nextPage();
      else if (e.control === 'K3') nextKey();
      else if (e.control === 'K4') toggleModule();
    }
  }

  /* ── view ──────────────────────────────────────────────────────────── */
  function setStatus(text) { $('status').textContent = text; }

  function build() {
    $('tabs').innerHTML = PAGES.map((p, i) => `<button data-page="${i}">${p.name}</button>`).join('');
    $('presets').innerHTML = PRESETS.map((p, i) => `<button data-preset="${i}">${p.name}</button>`).join('');
  }

  function buildRows() {
    const p = page();
    $('rows').dataset.page = String(state.page);
    $('rows').innerHTML = p.knobs.map((k) => `
      <div class="meter">
        <span>${k.label}</span>
        <i><b></b></i>
        <em>${k.fmt(state[k.key])}</em>
      </div>`).join('');
  }

  function renderTuner() {
    const noteEl = $('note');
    const hzEl = $('hz');
    const toEl = $('to');
    if (!tune.voiced || !tune.f0) {
      noteEl.textContent = '—';
      hzEl.textContent = preview ? 'No input in preview' : 'Waiting for audio';
      toEl.textContent = '';
      toEl.className = 'off';
      return;
    }
    noteEl.textContent = noteName(tune.midi);
    hzEl.textContent = Math.round(tune.f0) + ' Hz';
    if (state.tuneOn && tune.target) {
      const semis = tune.target - tune.midi;
      toEl.textContent = '→ ' + noteName(tune.target) + (Math.abs(semis) > 0.05 ? '' : ' ✓');
      toEl.className = '';
    } else {
      toEl.textContent = 'Original';
      toEl.className = 'off';
    }
  }

  function render() {
    $('gain').textContent = String(Math.round(state.gainDb));
    $('keyshow').textContent = keyName(state.key) + (state.tuneOn ? '' : ' · Tune off');

    $('flag-tune').className = 'flag ' + (state.tuneOn ? 'on' : 'off');
    $('flag-dn').className = 'flag ' + (state.dnOn ? 'on' : 'off');
    $('flag-ott').className = 'flag ' + (state.ottOn ? 'on' : 'off');
    $('flag-dist').className = 'flag ' + (state.distOn ? 'on' : 'off');

    document.querySelectorAll('#tabs button').forEach((b, i) => b.classList.toggle('on', i === state.page));
    document.querySelectorAll('#presets button').forEach((b, i) => b.classList.toggle('on', i === presetIndex));

    const knobs = page().knobs;
    const rows = [...$('rows').children];
    if (rows.length !== knobs.length) {
      buildRows();
    } else {
      $('rows').dataset.page = String(state.page);
      rows.forEach((row, i) => {
        const k = knobs[i];
        row.querySelector('span').textContent = k.label;
        row.querySelector('b').style.width = Math.round(clamp((state[k.key] - k.min) / (k.max - k.min)) * 100) + '%';
        row.querySelector('em').textContent = k.fmt(state[k.key]);
      });
    }

    $('n-pre').classList.toggle('on', state.gainDb > 0);
    $('n-dn').classList.toggle('on', state.dnOn && state.dnDepth > 0.01);
    $('n-tune').classList.toggle('on', state.tuneOn && state.amt > 0.01);
    $('n-dist').classList.toggle('on', state.distOn && state.drive > 0.01);
    $('n-ott').classList.toggle('on', state.ottOn && (state.ottUp > 0.01 || state.ottDown > 0.01));

    renderTuner();
    renderMonitor();
  }

  function renderGate() {
    const show = phase !== 'live';
    $('gate').hidden = !show;
    if (phase === 'starting') {
      $('gate-msg').textContent = 'Starting audio...';
      $('gate-btn').disabled = true;
      return;
    }
    $('gate-btn').disabled = false;
    if (phase === 'idle') {
      $('gate-btn').textContent = 'Start';
      $('gate-msg').textContent = preview ? 'Microphone unavailable in preview. Launch on the device.'
        : 'Connect a microphone and tap Start. Headphones recommended.';
    }
  }

  function renderMonitor() {
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      try {
        const knobs = page().knobs;
        const pending = sdk.monitor.set({
          E1: { label: knobs[0].label, value: knobs[0].fmt(state[knobs[0].key]) },
          E2: { label: knobs[1].label, value: knobs[1].fmt(state[knobs[1].key]) },
          E3: { label: knobs[2].label, value: knobs[2].fmt(state[knobs[2].key]) },
          E4: { label: knobs[3].label, value: knobs[3].fmt(state[knobs[3].key]) },
          K2: { label: 'Page', value: page().name },
          K3: { label: 'Key', value: keyName(state.key) },
          K4: { label: page().toggleName, pressed: state[page().toggle] }
        });
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch (_) { /* optional */ }
    }, 40);
  }

  function drawMeter() {
    meter.inp *= 0.9;
    $('lvl-in').style.width = Math.round(clamp(Math.sqrt(meter.inp) * 1.6) * 100) + '%';
    requestAnimationFrame(drawMeter);
  }

  function wireTouch() {
    $('tabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-page]');
      if (!b) return;
      state.page = Number(b.dataset.page);
      save();
      setStatus('Page: ' + page().name);
      buildRows();
      render();
    });
    $('presets').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-preset]');
      if (!b) return;
      if (!engine) void start();
      applyPreset(Number(b.dataset.preset));
    });
    $('gate-btn').addEventListener('click', () => { void start(); });
  }

  async function init() {
    build();
    buildRows();
    wireTouch();
    sdk.controls.onEvent(handleControl);
    await load();
    buildRows();
    render();
    renderGate();
    requestAnimationFrame(drawMeter);
    sdk.audio.onAvailable(() => {
      if (!preview && (phase === 'live' || phase === 'error')) void stop().then(() => start());
    });
    await sdk.ready();
    if (!preview) void start();
  }

  addEventListener('pagehide', () => { void stop(); });
  void init();
})();
