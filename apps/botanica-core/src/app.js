(() => {
  'use strict';

  const sdk = window.VrchApp;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const SAVE_KEY = 'botanica-engine';
  const NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const PROGS = ['Royal Road', 'Hope', 'Sunbeam', 'Lydian Float', 'Canon', 'Tide', 'Just Spring', 'Environmental'];
  const MAJ = [0, 2, 4, 5, 7, 9, 11];
  const MIN = [0, 2, 3, 5, 7, 8, 10];
  const MODES = ['major', 'minor'];
  const scale = () => (state.mode ? MIN : MAJ);
  const pct = (v) => Math.round(v * 100) + '%';
  const SECTIONS = {
    dawn: { en: 'DAWN', jp: '黎明', lvl: 0.3 }, bloom: { en: 'BLOOM', jp: '開花', lvl: 0.62 }, canopy: { en: 'CANOPY', jp: '林冠', lvl: 1 },
    glitch: { en: 'GLITCH', jp: '故障', lvl: 0.75 }, petal: { en: 'PETAL FALL', jp: '落英', lvl: 0.35 },
  };

  /* ── parameters ───────────────────────────────────────────────────── */
  const PARAMS = {
    timbre: { label: 'TIMBRE', min: 0, max: 1, def: 0.15, fmt: (v) => (v < 0.22 ? 'Felt piano' : v < 0.4 ? 'Felt·glass' : v < 0.6 ? 'Glass' : v < 0.78 ? 'Glass·box' : 'Music box') },
    bright: { label: 'BRIGHT', min: 0, max: 1, def: 0.55, fmt: pct },
    soft: { label: 'SOFT', min: 0, max: 1, def: 0.5, fmt: pct },
    sustain: { label: 'SUSTAIN', min: 0, max: 1, def: 0.5, fmt: (v) => (0.45 + Math.pow(v, 1.4) * 7.5).toFixed(1) + ' s' },
    glitch: { label: 'GLITCH', min: 0, max: 1, def: 0.35, fmt: pct },
    grain: { label: 'GRAIN', min: 0, max: 1, def: 0.3, fmt: pct },
    freeze: { label: 'FREEZE', min: 0, max: 1, def: 0.3, fmt: pct },
    crush: { label: 'CRUSH', min: 0, max: 1, def: 0.2, fmt: pct },
    keys: { label: 'KEYS', min: 0, max: 1, def: 0.8, fmt: pct },
    voice: { label: 'VOICE', min: 0, max: 1, def: 0.6, fmt: pct },
    foley: { label: 'FOLEY', min: 0, max: 1, def: 0.6, fmt: pct },
    beat: { label: 'BEAT', min: 0, max: 1, def: 0.6, fmt: pct },
    shimmer: { label: 'SHIMMER', min: 0, max: 1, def: 0.5, fmt: pct },
    echo: { label: 'ECHO', min: 0, max: 1, def: 0.35, fmt: pct },
    ambience: { label: 'AMBIENCE', min: 0, max: 1, def: 0.5, fmt: pct },
    bass: { label: 'BASS', min: 0, max: 1, def: 0.6, fmt: pct },
    bpm: { label: 'TEMPO', min: 40, max: 180, def: 92, int: true, fmt: (v) => v + ' bpm' },
    energy: { label: 'ENERGY', min: 0, max: 1, def: 0.6, fmt: pct },
    evolve: { label: 'EVOLVE', min: 0, max: 1, def: 0.5, fmt: pct },
    seed: { label: 'SEED', min: 1, max: 99, def: 7, int: true, fmt: (v) => '#' + String(v).padStart(2, '0') },
    key: { label: 'KEY', min: 0, max: 11, def: 0, int: true, fmt: (v) => NOTE[v] + ' ' + MODES[state.mode] },
    mode: { label: 'SCALE', min: 0, max: 1, def: 0, int: true, fmt: (v) => MODES[v] },
    prog: { label: 'CHORDS', min: 0, max: PROGS.length - 1, def: 0, int: true, fmt: (v) => PROGS[v] },
    melody: { label: 'MELODY', min: 0, max: 1, def: 0.6, fmt: pct },
    volume: { label: 'VOLUME', min: 0, max: 1, def: 0.8, fmt: pct },
  };
  const SOUND = ['timbre', 'bright', 'soft', 'sustain', 'glitch', 'grain', 'freeze', 'crush', 'keys', 'voice', 'foley', 'beat', 'shimmer', 'echo', 'ambience', 'bass', 'volume'];
  const SEQ = ['bpm', 'energy', 'evolve', 'seed', 'key', 'mode', 'prog', 'melody'];
  const PAGES = [
    { title: 'BLOOM', keys: ['timbre', 'bright', 'soft', 'sustain'] },
    { title: 'GLITCH', keys: ['glitch', 'grain', 'freeze', 'crush'] },
    { title: 'LAYERS', keys: ['keys', 'voice', 'foley', 'beat'] },
    { title: 'AIR', keys: ['shimmer', 'echo', 'ambience', 'bass'] },
    { title: 'FORM', keys: ['bpm', 'energy', 'evolve', 'seed'] },
    { title: 'HARMONY', keys: ['key', 'prog', 'melody', 'volume'] },
  ];

  /* ── specimens (presets) ──────────────────────────────────────────── */
  const SP = (name, jp, p, s, v) => ({ name, jp, p, s, v });
  const SPECIMENS = [
    SP('Dewfall', '露', { timbre: 0.08, bright: 0.5, soft: 0.65, sustain: 0.6, glitch: 0.3, grain: 0.25, freeze: 0.25, crush: 0.25, keys: 0.85, voice: 0.45, foley: 0.75, beat: 0.45, shimmer: 0.5, echo: 0.35, ambience: 0.65, bass: 0.5 },
      { bpm: 86, energy: 0.45, evolve: 0.5, prog: 0, melody: 0.55 }, { count: 5, notch: 1, round: 0.5, hue: 0.0 }),
    SP('Glass Bloom', '玻璃花', { timbre: 0.5, bright: 0.7, soft: 0.4, sustain: 0.75, glitch: 0.35, grain: 0.5, freeze: 0.5, crush: 0.1, keys: 0.8, voice: 0.5, foley: 0.5, beat: 0.35, shimmer: 0.85, echo: 0.45, ambience: 0.45, bass: 0.45 },
      { bpm: 74, energy: 0.35, evolve: 0.45, prog: 3, melody: 0.5 }, { count: 7, notch: 0, round: 0.1, hue: 0.3 }),
    SP('Petal Rush', '花吹雪', { timbre: 0.3, bright: 0.7, soft: 0.25, sustain: 0.4, glitch: 0.75, grain: 0.4, freeze: 0.2, crush: 0.35, keys: 0.85, voice: 0.9, foley: 0.6, beat: 0.95, shimmer: 0.45, echo: 0.3, ambience: 0.25, bass: 0.8 },
      { bpm: 160, energy: 0.92, evolve: 0.65, prog: 1, melody: 0.8 }, { count: 6, notch: 1, round: 0.4, hue: 0.55 }),
    SP('Moss Garden', '苔庭', { timbre: 0.85, bright: 0.45, soft: 0.8, sustain: 0.8, glitch: 0.12, grain: 0.3, freeze: 0.35, crush: 0.1, keys: 0.7, voice: 0.3, foley: 0.7, beat: 0, shimmer: 0.7, echo: 0.5, ambience: 0.9, bass: 0.35 },
      { bpm: 62, energy: 0.12, evolve: 0.3, prog: 7, melody: 0.35 }, { count: 9, notch: 0, round: 0.8, hue: 0.15 }),
    SP('Lightgrain', '光粒', { timbre: 0.4, bright: 0.55, soft: 0.7, sustain: 0.7, glitch: 0.3, grain: 0.85, freeze: 0.75, crush: 0.2, keys: 0.7, voice: 0.6, foley: 0.45, beat: 0.25, shimmer: 0.75, echo: 0.4, ambience: 0.55, bass: 0.45 },
      { bpm: 70, energy: 0.3, evolve: 0.4, prog: 5, melody: 0.45 }, { count: 8, notch: 0, round: 0.2, hue: 0.7 }),
    SP('Butterfly.exe', '蝶', { timbre: 0.6, bright: 0.65, soft: 0.3, sustain: 0.45, glitch: 0.95, grain: 0.55, freeze: 0.4, crush: 0.65, keys: 0.8, voice: 0.7, foley: 0.6, beat: 0.8, shimmer: 0.5, echo: 0.45, ambience: 0.3, bass: 0.7 },
      { bpm: 140, energy: 0.75, evolve: 0.8, prog: 4, melody: 0.7 }, { count: 6, notch: 0.5, round: 0.2, hue: 0.85 }),
    SP('Spring Choir', '春の声', { timbre: 0.2, bright: 0.6, soft: 0.55, sustain: 0.6, glitch: 0.35, grain: 0.35, freeze: 0.45, crush: 0.15, keys: 0.7, voice: 1, foley: 0.5, beat: 0.6, shimmer: 0.7, echo: 0.35, ambience: 0.5, bass: 0.6 },
      { bpm: 108, energy: 0.6, evolve: 0.5, prog: 2, melody: 0.55 }, { count: 10, notch: 0.3, round: 0.6, hue: 0.45 }),
    SP('Komorebi', '木漏れ日', { timbre: 0.15, bright: 0.62, soft: 0.45, sustain: 0.5, glitch: 0.45, grain: 0.35, freeze: 0.3, crush: 0.3, keys: 0.85, voice: 0.7, foley: 0.8, beat: 0.8, shimmer: 0.55, echo: 0.35, ambience: 0.55, bass: 0.75 },
      { bpm: 126, energy: 0.72, evolve: 0.55, prog: 6, melody: 0.7 }, { count: 5, notch: 1, round: 0.4, hue: 0.1 }),
  ];

  const state = { specimen: 0, page: 0, playing: false };
  for (const k in PARAMS) state[k] = PARAMS[k].def;
  Object.assign(state, SPECIMENS[0].p, SPECIMENS[0].s);

  let engine = null, phase = 'idle', epoch = 0, version, saveTimer = 0, noticeTimer = 0, monitorTimer = 0, flashTimer = 0;
  let viz = null, vizError = '', dirty = true;
  let lastBeat = 0, retryTimer = 0, retries = 0, recovering = false;
  let section = null, form = [], lens = [], secIdx = 0, secBar = 0, secStep = 0;
  const meters = new Float32Array(8), meterT = new Float32Array(8);
  const METER_SCALE = [0.2, 0.16, 0.1, 0.12, 0.12, 0.045, 1.2, 0.03];
  const encAcc = [0, 0, 0, 0];
  const litPads = new Map();

  /* ── helpers ──────────────────────────────────────────────────────── */
  function notice(text, keep = false) {
    clearTimeout(noticeTimer);
    const el = $('notice'); el.textContent = text; el.hidden = !text;
    if (text && !keep) noticeTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }
  function flash(text) {
    const el = $('flash'); el.textContent = text; el.classList.add('show');
    clearTimeout(flashTimer); flashTimer = setTimeout(() => el.classList.remove('show'), 1000);
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const value = { v: 2, specimen: state.specimen, page: state.page, playing: state.playing };
      for (const k in PARAMS) value[k] = state[k];
      try { const r = await sdk.data.set(SAVE_KEY, value, version === undefined ? {} : { expectedVersion: version }); version = r.version; }
      catch (_) { try { version = (await sdk.data.get(SAVE_KEY)).version; } catch (__) { /* best effort */ } }
    }, 800);
  }
  const post = (m) => { if (engine) engine.node.port.postMessage(m); };
  const soundParams = () => { const p = {}; for (const k of SOUND) p[k] = state[k]; return p; };
  const seqParams = () => { const s = { on: state.playing }; for (const k of SEQ) s[k] = state[k]; return s; };
  const pushSound = () => post({ type: 'p', p: soundParams() });
  const pushSeq = () => post({ type: 'seq', s: seqParams() });
  const label = (k) => PARAMS[k].label.charAt(0) + PARAMS[k].label.slice(1).toLowerCase();

  function setValue(k, v, quiet = false) {
    const spec = PARAMS[k];
    v = clamp(spec.int ? Math.round(v) : v, spec.min, spec.max);
    if (v === state[k]) return;
    state[k] = v;
    if (SOUND.includes(k)) pushSound();
    if (SEQ.includes(k)) pushSeq();
    if (k === 'key' || k === 'mode') buildPads();
    if (!quiet) flash(k === 'mode' ? `Key · ${PARAMS.key.fmt(state.key)}` : `${label(k)} · ${spec.fmt(v)}`);
    syncViz(); dirty = true; save();
  }
  const toggleMode = () => setValue('mode', state.mode ? 0 : 1);

  /* ── audio ────────────────────────────────────────────────────────── */
  async function release(e) {
    if (!e) return;
    try { e.node?.disconnect(); e.outNode?.disconnect(); } catch (_) { /* gone */ }
    await Promise.allSettled([e.out?.close(), e.ctx?.close()]);
  }
  async function stop() { ++epoch; const old = engine; engine = null; phase = 'idle'; dirty = true; await release(old); }
  async function start() {
    if (phase === 'starting' || phase === 'live') return;
    const token = ++epoch, e = {};
    phase = 'starting'; dirty = true;
    try {
      e.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive', sinkId: { type: 'none' } });
      if (!e.ctx.audioWorklet) throw Object.assign(new Error('no worklet'), { code: 'unsupported_environment' });
      await e.ctx.resume();
      if (e.ctx.state !== 'running') throw Object.assign(new Error('gesture'), { code: 'interaction_required' });
      await e.ctx.audioWorklet.addModule(new URL('dsp.js', location.href).href);
      e.node = new AudioWorkletNode(e.ctx, 'botanica-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      e.out = await sdk.audio.openOutput({ channels: 2 });
      e.outNode = await e.out.createNode(e.ctx);
      e.node.connect(e.outNode);
      e.node.port.onmessage = ({ data }) => { if (engine === e) onEngine(data); };
      e.node.onprocessorerror = () => { if (engine === e) void recover(); };
      if (token !== epoch) { await release(e); return; }
      engine = e; phase = 'live'; lastBeat = performance.now(); retries = 0; clearTimeout(retryTimer);
      pushSound(); pushSeq();
      e.ctx.onstatechange = () => {
        if (engine !== e || e.ctx.state === 'running') return;
        e.ctx.resume().catch(() => {});
        setTimeout(() => { if (engine === e && e.ctx.state !== 'running') void recover(); }, 600);
      };
      notice(vizError, !!vizError); dirty = true;
    } catch (error) {
      await release(e);
      if (token !== epoch) return;
      phase = 'error'; dirty = true;
      const code = error.code || error.name;
      if (code !== 'unsupported_environment') scheduleRetry();
      notice(code === 'audio_device_unavailable' ? 'Choose an available OUT in the K1 Menu, then tap the garden.'
        : code === 'unsupported_environment' ? 'Audio is unavailable here. Launch on the device.' : 'Tap the garden to start audio.', true);
    }
  }
  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (phase !== 'live') void start(); }, Math.min(8000, 700 * Math.pow(2, retries++)));
  }
  // rebuild the audio engine and carry on playing (worklet error, stalled output, suspended context)
  async function recover() {
    if (recovering) return;
    recovering = true;
    notice('Audio reconnecting…');
    try { await stop(); await start(); } finally { recovering = false; }
    if (phase !== 'live') scheduleRetry();
  }
  function ensureAudio() { if (phase !== 'live') void start(); }

  function onEngine(d) {
    if (!d) return;
    if (d.type === 'm') {
      lastBeat = performance.now();
      if (viz) viz.setLevel(d.lv);
      for (let i = 0; i < 8; i++) meterT[i] = Math.min(1, (d.L[i] || 0) / METER_SCALE[i]);
      secBar = d.bar; secStep = d.step;
      return;
    }
    if (viz) viz.event(d);
    if (d.type === 's') {
      section = d.name; form = d.form; lens = d.lens || []; secIdx = d.i; secBar = 0;
      buildForm(); syncViz(); dirty = true;
    } else if (d.type === 'n' && (d.l === 'k' || d.l === 'c')) {
      const pc = ((d.m - state.key) % 12 + 12) % 12, deg = scale().indexOf(pc);
      if (deg >= 0) litPads.set(deg, performance.now());
    }
  }

  /* ── playing ──────────────────────────────────────────────────────── */
  const padMidi = (i) => 12 * 6 + state.key + (i < 7 ? scale()[i] : 12);
  function setPlaying(on) {
    ensureAudio();
    state.playing = on;
    if (!on) { section = null; form = []; buildForm(); }
    pushSeq(); flash(on ? 'Garden growing' : 'Garden resting');
    syncViz(); dirty = true;
  }
  function selectSpecimen(i) {
    state.specimen = (i + SPECIMENS.length) % SPECIMENS.length;
    const sp = SPECIMENS[state.specimen];
    Object.assign(state, sp.p, sp.s);
    pushSound(); pushSeq();
    syncViz(); flash(`${sp.name} · ${sp.jp}`);
    dirty = true; save();
  }
  function setPage(i) { state.page = (i + PAGES.length) % PAGES.length; dirty = true; save(); }

  function syncViz() {
    if (!viz) return;
    const sp = SPECIMENS[state.specimen].v;
    const lvl = state.playing && section ? SECTIONS[section].lvl : 0.42;
    viz.setParams({
      count: sp.count, notch: sp.notch, round: sp.round, hue: sp.hue + state.key / 12,
      open: 0.55 + lvl * 0.6 + state.bright * 0.2, len: 0.5 + state.sustain * 0.22,
      droop: 0.12 + (section === 'petal' ? 0.5 : 0) + (1 - state.soft) * 0.1,
      sway: 0.15 + state.ambience * 0.45 + state.bpm / 180 * 0.2, root: state.bass,
      layer3: state.shimmer, iri: 0.3 + state.timbre * 0.6 + state.glitch * 0.1, alpha: 0.75 + state.bright * 0.55,
      wire: 0.25 + state.glitch * 0.35 + state.crush * 0.25, dissolve: state.grain * 0.7 + state.freeze * 0.1,
      decay: 0.5 + state.echo * 0.25 + state.freeze * 0.12, bloomK: 0.45 + state.shimmer * 0.75,
      grow: 0.2 + lvl * 0.6 + state.bass * 0.25, motes: 0.1 + state.ambience * 0.9, fly: state.voice,
      spin: (0.05 + state.bpm / 180 * 0.25) * (state.playing ? 1 : 0.4),
      aber: 0.0015 + state.crush * 0.004 + state.glitch * 0.002, pix: state.crush > 0.5 ? 1 + (state.crush - 0.5) * 3 : 1,
    });
  }

  /* ── controls ─────────────────────────────────────────────────────── */
  function handleControl(e) {
    const ei = ['E1', 'E2', 'E3', 'E4'].indexOf(e.control);
    if (ei >= 0) {
      const key = PAGES[state.page].keys[ei], spec = PARAMS[key];
      if (e.type === 'rotate') {
        if (spec.int) {
          encAcc[ei] += e.delta;
          const steps = Math.trunc(encAcc[ei] / 2);
          if (steps) { encAcc[ei] -= steps * 2; setValue(key, state[key] + steps); }
        } else setValue(key, state[key] + (e.delta / 160) * (spec.max - spec.min));
      } else if (e.type === 'down') {
        if (key === 'key') { toggleMode(); return; }
        const sp = SPECIMENS[state.specimen];
        setValue(key, key in sp.p ? sp.p[key] : key in sp.s ? sp.s[key] : spec.def, true);
        flash(`${label(key)} restored`);
      }
      return;
    }
    if (e.type !== 'down') return;
    if (e.control === 'K2') { ensureAudio(); selectSpecimen(state.specimen + 1); }
    else if (e.control === 'K3') setPage(state.page + 1);
    else if (e.control === 'K4') setPlaying(!state.playing);
  }

  /* ── build & wire ─────────────────────────────────────────────────── */
  function buildPads() {
    const pads = $('pads');
    if (!pads.children.length) {
      pads.innerHTML = Array.from({ length: 8 }, (_, i) => `<button class="pad" type="button" data-i="${i}"></button>`).join('');
      for (const b of pads.children) {
        const i = Number(b.dataset.i);
        let id = 0;
        b.addEventListener('pointerdown', (ev) => {
          ev.preventDefault(); b.setPointerCapture(ev.pointerId); ensureAudio();
          id = 100000 + i * 1000 + ((performance.now() | 0) % 1000);
          post({ type: 'on', id, midi: padMidi(i), vel: 0.8 });
          b.classList.add('on');
        });
        const up = () => { if (id) { post({ type: 'off', id }); id = 0; } b.classList.remove('on'); };
        b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
      }
    }
    for (const b of pads.children) { const m = padMidi(Number(b.dataset.i)); b.textContent = NOTE[m % 12]; }
  }
  function buildForm() {
    const el = $('form');
    if (!form.length) { el.innerHTML = '<div class="seg on"><span>STANDBY · PRESS K4 TO GROW</span></div>'; return; }
    el.innerHTML = form.map((n, i) => `<div class="seg${i === secIdx ? ' on' : i < secIdx ? ' done' : ''}" style="flex-grow:${(lens[i] || 1) + (i === secIdx ? 6 : 0)}"><i></i><span>${i === secIdx ? SECTIONS[n].en : ''}</span></div>`).join('');
  }
  function build() {
    $('tabs').innerHTML = PAGES.map((p, i) => `<button class="tab" type="button" data-page="${i}">${p.title}</button>`).join('');
    $('cells').innerHTML = [0, 1, 2, 3].map((i) => `<div class="cell" id="p${i}"><span class="enc">E${i + 1}</span><span class="lab"></span><span class="val"></span><span class="bar"><i></i></span></div>`).join('');
    $('presets').innerHTML = SPECIMENS.map((s, i) => `<button class="pre" type="button" data-i="${i}"><b>${s.name.toUpperCase()}</b><span>${s.jp}</span></button>`).join('');
    $('layers').innerHTML = ['KEYS', 'PAD', 'VOICE', 'BASS', 'BEAT', 'FOLEY', 'GLITCH', 'AIR'].map((n, i) => `<b>${n}</b><u><i id="m${i}"></i></u>`).join('');
    buildPads(); buildForm();
  }
  function wire() {
    for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => setPage(Number(t.dataset.page)));
    for (const b of document.querySelectorAll('.pre')) b.addEventListener('click', () => { ensureAudio(); selectSpecimen(Number(b.dataset.i)); });
    $('play').addEventListener('click', () => setPlaying(!state.playing));
    $('stage').addEventListener('click', (ev) => { if (ev.target === $('stage') && phase !== 'live') void start(); });
    for (let i = 0; i < 4; i++) {
      const cell = $('p' + i);
      let sx = 0, sy = 0, sv = 0, key = '', moved = false;
      cell.addEventListener('pointerdown', (ev) => { cell.setPointerCapture(ev.pointerId); sx = ev.clientX; sy = ev.clientY; key = PAGES[state.page].keys[i]; sv = state[key]; moved = false; cell.classList.add('touch'); });
      cell.addEventListener('pointermove', (ev) => {
        if (!cell.hasPointerCapture(ev.pointerId)) return;
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 8) moved = true;
        const spec = PARAMS[key];
        setValue(key, sv + (((ev.clientX - sx) - (ev.clientY - sy)) / 140) * (spec.max - spec.min));
      });
      const end = () => cell.classList.remove('touch');
      cell.addEventListener('pointerup', () => { end(); if (key === 'key' && !moved) toggleMode(); });
      cell.addEventListener('pointercancel', end);
    }
  }

  /* ── rendering (coalesced per animation frame) ────────────────────── */
  function render() {
    const page = PAGES[state.page];
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.page === String(state.page));
    page.keys.forEach((key, i) => {
      const cell = $('p' + i), spec = PARAMS[key], v = state[key];
      cell.querySelector('.lab').textContent = spec.label;
      cell.querySelector('.val').textContent = spec.fmt(v);
      cell.querySelector('.bar i').style.transform = `scaleX(${((v - spec.min) / (spec.max - spec.min || 1)).toFixed(3)})`;
    });
    for (const b of document.querySelectorAll('.pre')) b.classList.toggle('on', Number(b.dataset.i) === state.specimen);
    const sp = SPECIMENS[state.specimen];
    if (!DEBUG) $('specNo').textContent = `SPECIMEN ${String(state.specimen + 1).padStart(2, '0')} / ${String(SPECIMENS.length).padStart(2, '0')}`;
    $('specName').textContent = sp.name; $('specJp').textContent = sp.jp;
    $('meta').textContent = `${NOTE[state.key]}${state.mode ? 'm' : ''} · ${PROGS[state.prog].toUpperCase()} · ${state.bpm} BPM`;
    const S = section && state.playing ? SECTIONS[section] : null;
    $('sectName').textContent = phase !== 'live' ? (phase === 'starting' ? 'WAKING' : 'TAP TO WAKE') : S ? S.en : 'STANDBY';
    $('sectJp').textContent = S ? S.jp : '待機';
    $('play').classList.toggle('on', state.playing);
    $('playTxt').textContent = state.playing ? 'GROWING' : 'GROW';
    monitor();
  }
  function monitor() {
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      const values = {};
      PAGES[state.page].keys.forEach((key, i) => { values['E' + (i + 1)] = { label: PARAMS[key].label, value: PARAMS[key].fmt(state[key]) }; });
      values.K2 = { label: 'Specimen', value: SPECIMENS[state.specimen].name };
      values.K3 = { label: 'Page', value: PAGES[state.page].title };
      values.K4 = { label: 'Grow', pressed: state.playing };
      try { void sdk.monitor.set(values).catch(() => {}); } catch (_) { /* unavailable */ }
    }, 40);
  }

  const meterEls = [];
  let segFill = null, segIdxShown = -1;
  const DEBUG = false; let dbgAt = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (DEBUG && viz && t - dbgAt > 1000) { dbgAt = t; $('specNo').textContent = `${viz.fps.toFixed(0)} FPS · x${viz.scale.toFixed(2)}`; }
    if (dirty) { dirty = false; render(); }
    for (let i = 0; i < 8; i++) {
      meters[i] += (meterT[i] - meters[i]) * 0.25; meterT[i] *= 0.92;
      const el = meterEls[i] || (meterEls[i] = $('m' + i));
      el.style.transform = `scaleX(${meters[i].toFixed(3)})`;
    }
    if (form.length) {
      if (segIdxShown !== secIdx) { segFill = $('form').children[secIdx]?.querySelector('i'); segIdxShown = secIdx; }
      if (segFill) segFill.style.transform = `scaleX(${Math.min(1, (secBar * 16 + secStep) / (16 * (lens[secIdx] || 1))).toFixed(3)})`;
    } else segIdxShown = -1;
    if (litPads.size) {
      const pads = $('pads').children;
      for (const [i, at] of litPads) {
        const b = pads[i]; if (!b) { litPads.delete(i); continue; }
        if (t - at < 130) b.classList.add('lit'); else { b.classList.remove('lit'); litPads.delete(i); }
      }
    }
    if (viz) {
      try { viz.frame(t); } catch (err) { viz = null; vizError = '3D view: ' + String(err && err.message || err).slice(0, 160); notice(vizError, true); }
    }
  }
  function applyViewport() {
    let vp = null, inset = 0;
    try { vp = sdk.context.viewport; inset = sdk.context.safeInsets?.left || 0; } catch (_) { /* default */ }
    const h = (vp && vp.height) || innerHeight;
    document.documentElement.classList.toggle('tall', h >= 470);
    document.documentElement.style.setProperty('--inset-left', inset + 'px');
    if (viz) viz.resize();
  }

  /* ── lifecycle ────────────────────────────────────────────────────── */
  async function load() {
    try {
      const r = await sdk.data.get(SAVE_KEY);
      version = r.version;
      const v = r.value;
      if (v && v.v === 2) {
        for (const k in PARAMS) if (Number.isFinite(v[k])) state[k] = clamp(PARAMS[k].int ? Math.round(v[k]) : v[k], PARAMS[k].min, PARAMS[k].max);
        if (Number.isFinite(v.specimen)) state.specimen = clamp(v.specimen | 0, 0, SPECIMENS.length - 1);
        if (Number.isFinite(v.page)) state.page = clamp(v.page | 0, 0, PAGES.length - 1);
        if (typeof v.playing === 'boolean') state.playing = v.playing;
      }
    } catch (_) { /* first run */ }
  }
  async function init() {
    build(); wire();
    try { viz = window.BotanicaViz.create($('gl')); } catch (err) { viz = null; vizError = '3D view: ' + String(err && err.message || err).slice(0, 160); }
    if (!viz && !vizError) vizError = '3D view unavailable on this screen; sound still works.';
    if (vizError) notice(vizError, true);
    await load();
    buildPads(); syncViz(); dirty = true;
    applyViewport();
    new ResizeObserver(() => applyViewport()).observe(document.body);
    requestAnimationFrame(frame);
    setInterval(() => { if (phase === 'live' && !recovering && performance.now() - lastBeat > 2000) void recover(); }, 1000);
    sdk.controls.onEvent(handleControl);
    sdk.audio.onAvailable(() => { if (phase === 'live' || phase === 'error') void stop().then(start); });
    await sdk.ready();
    void start();
  }
  addEventListener('pagehide', () => { void stop(); });
  void init();
})();
