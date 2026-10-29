(() => {
  'use strict';

  const sdk = VrchApp;
  const $ = (id) => document.getElementById(id);
  const preview = sdk.context.mode === 'preview';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lib = window.WavescapeTables;
  const SAVE_KEY = 'wavescape';

  /* ── factory patches ──────────────────────────────────────────────────
   * Every patch carries its own pattern, written one token per 16th:
   * '.' rest, '-' tie (hold the previous step), notes joined by '+'.     */
  const ENV = (a, d, s, r) => ({ a, d, s, r });
  const BASE = {
    wave1: 0, wave2: 0, position: 0, posRandom: 0, posEnv: 0, posLfo: 0,
    spread: 0.2, layerMix: 0, mixEnv: 0, mixLfo: 0, range: 1, l2oct: 0,
    pitchLfo: 0, shaper: 0, wsEnv: 0, wsLfo: 0,
    cutoff: 0.8, res: 0.15, fenv: 0, flfo: 0, ftype: 0, kybd: 0.5, hpf: 0, drive: 0,
    level: 0.8, porta: 0.2, portaOn: false, poly: true,
    envO: ENV(0.2, 0.5, 0.6, 0.4), envF: ENV(0.05, 0.4, 0.5, 0.3), envA: ENV(0.02, 0.4, 0.8, 0.35),
    lfoRate: 0.4, lfoWave: 0, lfoDelay: 0, lfoKeyTrg: false, lfoAmp: 0,
    delay: 0.15, delayTime: 0.35, delayFb: 0.35, reverb: 0.25, reverbTime: 0.5, chorus: 0
  };
  const patch = (name, o) => ({ name, ...structuredClone(BASE), ...o });

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function midi(name) {
    const m = /^([A-G]#?)(-?\d)$/.exec(name);
    return m ? NOTE_NAMES.indexOf(m[1]) + 12 * (Number(m[2]) + 1) : 60;
  }
  function pattern(text, { gate = 0.5, vel = 100, bpm = 110, shuffle = 0 } = {}) {
    const tokens = text.trim().split(/\s+/);
    const steps = [];
    for (let i = 0; i < 64; i++) {
      const t = tokens[i % tokens.length];
      if (i >= tokens.length || t === '.') steps.push(emptyStep());
      else if (t === '-') steps.push({ on: true, notes: (steps[i - 1] || emptyStep()).notes.slice(), vel, gate: 1, tie: true });
      else steps.push({ on: true, notes: t.split('+').map(midi), vel, gate, tie: false });
    }
    return { bpm, shuffle, length: tokens.length, steps };
  }
  function emptyStep() { return { on: false, notes: [], vel: 100, gate: 0.5, tie: false }; }

  const FACTORY = [
    { patch: patch('GLASS PAD', { wave1: 12, wave2: 4, position: 40, layerMix: 0.35, posLfo: 0.35, lfoRate: 0.25, mixLfo: 0.3,
      envA: ENV(0.55, 0.6, 0.85, 0.65), envO: ENV(0.6, 0.7, 0.4, 0.6), posEnv: 0.25, cutoff: 0.72, chorus: 1, reverb: 0.6, reverbTime: 0.8, delay: 0.2 }),
      seq: pattern('E3+G3+B3+D4 - - - - - - - C3+E3+G3+B3 - - - - - - - G3+B3+D4+F#4 - - - - - - - D3+F#3+A3+C4 - - - - - - -', { bpm: 84 }) },
    { patch: patch('VOX SWEEP', { wave1: 4, wave2: 3, position: 10, posEnv: 0.75, envO: ENV(0.05, 0.55, 0.2, 0.4), layerMix: 0.3, ftype: 0, cutoff: 0.66, res: 0.3,
      envA: ENV(0.02, 0.5, 0.7, 0.3), chorus: 2, delay: 0.25, delayTime: 0.38 }),
      seq: pattern('E3 . G3 . B3 . . A3 . G3 . E3 . D3 . .', { bpm: 104, gate: 0.7 }) },
    { patch: patch('PWM BASS', { wave1: 1, wave2: 0, position: 30, posLfo: 0.4, lfoRate: 0.3, l2oct: -1, layerMix: 0.4, range: 1, poly: false, portaOn: true, porta: 0.15,
      cutoff: 0.42, res: 0.35, fenv: 0.55, envF: ENV(0.01, 0.35, 0.15, 0.2), envA: ENV(0.005, 0.3, 0.75, 0.15), delay: 0, reverb: 0.08 }),
      seq: pattern('E2 . E2 E3 . E2 G2 . E2 . A2 . B2 . D3 B2', { bpm: 118, gate: 0.45, shuffle: 0.2 }) },
    { patch: patch('SYNC LEAD', { wave1: 2, wave2: 0, position: 20, posEnv: 0.7, envO: ENV(0.02, 0.6, 0.3, 0.4), wave2pos: 0, layerMix: 0.2, poly: false, portaOn: true, porta: 0.22,
      cutoff: 0.78, res: 0.2, pitchLfo: 0.15, lfoRate: 0.55, lfoDelay: 0.3, delay: 0.3, delayTime: 0.42, delayFb: 0.4, reverb: 0.3 }),
      seq: pattern('B3 - - G3 - E3 - - F#3 - G3 - A3 - B3 . D4 - - B3 - A3 - - G3 - F#3 - E3 - - .', { bpm: 112, gate: 0.85 }) },
    { patch: patch('FORMANT ARP', { wave1: 3, wave2: 6, position: 60, posLfo: 0.6, lfoWave: 1, lfoRate: 0.35, layerMix: 0.25, cutoff: 0.75,
      envA: ENV(0.005, 0.35, 0.2, 0.25), delay: 0.35, delayTime: 0.28, delayFb: 0.45, reverb: 0.3 }),
      seq: pattern('E3 B3 G3 E4 B3 G3 D4 B3 E3 B3 G3 E4 C4 A3 F#3 D4', { bpm: 124, gate: 0.4 }) },
    { patch: patch('BELL KEYS', { wave1: 11, wave2: 12, position: 50, posEnv: 0.5, envO: ENV(0.01, 0.4, 0.1, 0.5), layerMix: 0.3, cutoff: 0.82,
      envA: ENV(0.005, 0.62, 0.0, 0.6), delay: 0.3, delayTime: 0.5, reverb: 0.45, reverbTime: 0.7, chorus: 1 }),
      seq: pattern('E4+B4 . . . . . G4 . . . B3+F#4 . . . D4 . C4+G4 . . . . . E4 . . . D4+A4 . . . B3 .', { bpm: 96, gate: 0.3 }) },
    { patch: patch('DIGI PLUCK', { wave1: 10, wave2: 9, position: 64, posRandom: 0.5, layerMix: 0.2, cutoff: 0.55, fenv: 0.5, res: 0.3,
      envF: ENV(0.0, 0.3, 0.1, 0.2), envA: ENV(0.003, 0.3, 0.0, 0.25), delay: 0.3, delayTime: 0.3, delayFb: 0.4 }),
      seq: pattern('E3 . E4 B3 . G3 . D4 E3 . F#4 B3 . A3 . G3', { bpm: 128, gate: 0.3, shuffle: 0.3 }) },
    { patch: patch('CHIP ARP', { wave1: 14, wave2: 1, position: 20, layerMix: 0.15, posLfo: 0.3, lfoRate: 0.7, lfoWave: 3, cutoff: 0.9, res: 0,
      envA: ENV(0.001, 0.25, 0.4, 0.08), delay: 0.2, delayTime: 0.2, reverb: 0.15, spread: 0 }),
      seq: pattern('E4 G4 B4 E5 B4 G4 E4 B3 C4 E4 G4 C5 D4 F#4 A4 D5', { bpm: 140, gate: 0.5 }) },
    { patch: patch('FOLD BASS', { wave1: 8, wave2: 0, position: 30, posEnv: 0.5, envO: ENV(0.0, 0.35, 0.1, 0.2), shaper: 0.25, wsEnv: 0.4, range: 0, poly: false,
      cutoff: 0.5, res: 0.25, fenv: 0.4, envF: ENV(0.0, 0.3, 0.2, 0.2), envA: ENV(0.003, 0.4, 0.7, 0.12), drive: 1, delay: 0, reverb: 0.05 }),
      seq: pattern('E2 . . E2 . . G2 . E2 . . E2 . D2 . B1', { bpm: 100, gate: 0.6, shuffle: 0.15 }) },
    { patch: patch('NOISE SCAPE', { wave1: 15, wave2: 12, position: 20, posLfo: 0.7, lfoWave: 5, lfoRate: 0.15, layerMix: 0.5, mixLfo: 0.6, ftype: 1, cutoff: 0.7, res: 0.3, level: 1,
      flfo: 0.3, envA: ENV(0.75, 0.7, 0.9, 0.75), reverb: 0.75, reverbTime: 0.9, delay: 0.3, delayTime: 0.7, delayFb: 0.55 }),
      seq: pattern('E3+B3 - - - - - - - - - - - - - - - D3+A3 - - - - - - - - - - - - - - -', { bpm: 70 }) },
    { patch: patch('STRING PAD', { wave1: 13, wave2: 6, position: 50, posLfo: 0.25, lfoRate: 0.2, layerMix: 0.4, cutoff: 0.78, spread: 0.6, level: 0.95,
      envA: ENV(0.5, 0.6, 0.9, 0.6), chorus: 2, reverb: 0.5, reverbTime: 0.7 }),
      seq: pattern('E3+G3+B3 - - - - - - - A2+C3+E3 - - - - - - - C3+E3+G3 - - - - - - - B2+D3+F#3 - - - - - - -', { bpm: 90 }) },
    { patch: patch('FM PERC', { wave1: 9, wave2: 11, position: 90, posEnv: -0.6, envO: ENV(0.0, 0.25, 0.0, 0.2), layerMix: 0.3, cutoff: 0.85,
      envA: ENV(0.001, 0.3, 0.0, 0.2), delay: 0.35, delayTime: 0.25, delayFb: 0.5, reverb: 0.2 }),
      seq: pattern('E3 . . B3 . . E4 . . G3 . . D4 . A3 .', { bpm: 120, gate: 0.25, shuffle: 0.25 }) }
  ];

  /* ── parameters and pages ─────────────────────────────────────────── */
  const pct = (v) => String(Math.round(v * 100));
  const bip = (v) => String(Math.round(v * 50));
  const PARAMS = {
    position: { label: 'POSITION', min: 0, max: 127, fmt: (v) => String(Math.round(v)) },
    layerMix: { label: 'LAYER MIX', min: 0, max: 1, fmt: pct },
    wave1: { label: 'LAYER1 WAVE', min: 0, max: 15, int: true, fmt: (v) => 'T.' + String(v + 1).padStart(2, '0'), names: true },
    wave2: { label: 'LAYER2 WAVE', min: 0, max: 15, int: true, fmt: (v) => 'T.' + String(v + 1).padStart(2, '0'), names: true },
    shaper: { label: 'WAVE SHAPER', min: 0, max: 1, fmt: pct },
    spread: { label: 'SPREAD', min: 0, max: 1, fmt: pct },
    range: { label: 'RANGE', min: 0, max: 3, int: true, fmt: (v) => ["16'", "8'", "4'", "2'"][v], led: (v) => ['16', '8', '4', '2'][v] },
    l2oct: { label: 'LAYER2 OCT', min: -2, max: 0, int: true, fmt: (v) => String(v) },
    posEnv: { label: 'POSITION ENV', min: -1, max: 1, fmt: bip, bi: true },
    posLfo: { label: 'POSITION LFO', min: -1, max: 1, fmt: bip, bi: true },
    posRandom: { label: 'POS RANDOM', min: 0, max: 1, fmt: pct },
    pitchLfo: { label: 'PITCH LFO', min: 0, max: 1, fmt: pct },
    mixEnv: { label: 'MIX ENV', min: -1, max: 1, fmt: bip, bi: true },
    mixLfo: { label: 'MIX LFO', min: -1, max: 1, fmt: bip, bi: true },
    wsEnv: { label: 'W.S ENV', min: -1, max: 1, fmt: bip, bi: true },
    wsLfo: { label: 'W.S LFO', min: 0, max: 1, fmt: pct },
    cutoff: { label: 'FREQ', min: 0, max: 1, fmt: pct },
    res: { label: 'RES', min: 0, max: 1, fmt: pct },
    fenv: { label: 'ENV', min: -1, max: 1, fmt: bip, bi: true },
    ftype: { label: 'TYPE', min: 0, max: 6, int: true, fmt: (v) => lib.FILTER_TYPES[v], led: (v) => ['LP24', 'LP12', 'HP24', 'HP12', 'BP24', 'BP12', 'Uint'][v] },
    flfo: { label: 'LFO', min: 0, max: 1, fmt: pct },
    kybd: { label: 'KYBD', min: 0, max: 1, fmt: pct },
    hpf: { label: 'HPF', min: 0, max: 1, fmt: pct },
    drive: { label: 'DRIVE', min: 0, max: 3, int: true, fmt: (v) => String(v) },
    'env.a': { label: 'ATTACK', min: 0, max: 1, fmt: pct },
    'env.d': { label: 'DECAY', min: 0, max: 1, fmt: pct },
    'env.s': { label: 'SUSTAIN', min: 0, max: 1, fmt: pct },
    'env.r': { label: 'RELEASE', min: 0, max: 1, fmt: pct },
    level: { label: 'LEVEL', min: 0, max: 1, fmt: pct },
    porta: { label: 'PORTAMENTO', min: 0, max: 1, fmt: pct },
    portaOn: { label: 'PORTA ON', min: 0, max: 1, int: true, bool: true, fmt: (v) => (v ? 'ON' : 'OFF') },
    poly: { label: 'SOLO/POLY', min: 0, max: 1, int: true, bool: true, fmt: (v) => (v ? 'POLY' : 'SOLO'), led: (v) => (v ? 'PoLy' : 'SoLo') },
    lfoRate: { label: 'RATE', min: 0, max: 1, fmt: pct },
    lfoWave: { label: 'WAVE', min: 0, max: 5, int: true, fmt: (v) => lib.LFO_WAVES[v], led: (v) => ['SinE', 'tri', 'SAU', 'Sqr', 'S-H', 'rnd'][v] },
    lfoDelay: { label: 'DELAY TIME', min: 0, max: 1, fmt: pct },
    lfoAmp: { label: 'AMP', min: 0, max: 1, fmt: pct },
    delay: { label: 'DELAY', min: 0, max: 1, fmt: pct },
    delayTime: { label: 'TIME', min: 0, max: 1, fmt: pct },
    delayFb: { label: 'FEEDBACK', min: 0, max: 1, fmt: pct },
    chorus: { label: 'CHORUS', min: 0, max: 2, int: true, fmt: (v) => ['OFF', 'I', 'II'][v], led: (v) => ['oFF', 'Ch1', 'Ch2'][v] },
    reverb: { label: 'REVERB', min: 0, max: 1, fmt: pct },
    reverbTime: { label: 'REV TIME', min: 0, max: 1, fmt: pct },
    bpm: { label: 'TEMPO', min: 40, max: 220, int: true, seq: true, fmt: (v) => String(v) },
    shuffle: { label: 'SHUFFLE', min: 0, max: 0.9, seq: true, fmt: (v) => String(Math.round(v * 100)) },
    length: { label: 'LENGTH', min: 1, max: 64, int: true, seq: true, fmt: (v) => String(v) },
    arpType: { label: 'ARP TYPE', min: 0, max: 3, int: true, arp: true, fmt: (v) => ['UP', 'DOWN', 'UP/DN', 'RAND'][v], led: (v) => ['UP', 'dn', 'Ud', 'rnd'][v] },
    arpOct: { label: 'ARP OCT', min: 1, max: 3, int: true, arp: true, fmt: (v) => String(v) },
    arpRate: { label: 'ARP RATE', min: 0, max: 3, int: true, arp: true, fmt: (v) => ['1/8', '1/16', '1/8T', '1/32'][v], led: (v) => ['8', '16', '8t', '32'][v] }
  };
  const PAGES = [
    { sec: 'LFO', title: 'LFO', keys: ['lfoRate', 'lfoWave', 'lfoDelay', 'lfoAmp'] },
    { sec: 'OSC', title: 'OSC 1', keys: ['position', 'layerMix', 'wave1', 'wave2'] },
    { sec: 'OSC', title: 'OSC 2', keys: ['shaper', 'spread', 'range', 'l2oct'] },
    { sec: 'MOD', title: 'MOD 1', keys: ['posEnv', 'posLfo', 'posRandom', 'pitchLfo'] },
    { sec: 'MOD', title: 'MOD 2', keys: ['mixEnv', 'mixLfo', 'wsEnv', 'wsLfo'] },
    { sec: 'FILTER', title: 'FILTER 1', keys: ['cutoff', 'res', 'fenv', 'ftype'] },
    { sec: 'FILTER', title: 'FILTER 2', keys: ['flfo', 'kybd', 'hpf', 'drive'] },
    { sec: 'ENV', title: 'ENVELOPE', keys: ['env.a', 'env.d', 'env.s', 'env.r'] },
    { sec: 'AMP', title: 'AMP', keys: ['level', 'porta', 'portaOn', 'poly'] },
    { sec: 'FX', title: 'EFFECTS 1', keys: ['delay', 'delayTime', 'delayFb', 'chorus'] },
    { sec: 'FX', title: 'EFFECTS 2', keys: ['reverb', 'reverbTime', null, null] },
    { sec: 'SEQ', title: 'SEQUENCER', keys: ['bpm', 'shuffle', 'length', null] },
    { sec: 'SEQ', title: 'ARPEGGIO', keys: ['arpType', 'arpOct', 'arpRate', null] }
  ];
  const SECTIONS = ['LFO', 'OSC', 'MOD', 'FILTER', 'ENV', 'AMP', 'FX', 'SEQ'];
  const ENV_SEL = ['OSC', 'FILTER', 'AMP', 'ALL'];

  /* ── state ─────────────────────────────────────────────────────────── */
  const state = {
    patchIndex: 0,
    patches: FACTORY.map((f) => structuredClone(f.patch)),
    seqs: FACTORY.map((f) => structuredClone(f.seq)),
    page: 1,
    mode: 'NOTE',
    envSel: 3,
    octave: 4,
    arp: { arpType: 0, arpOct: 1, arpRate: 1 },
    seqPage: 0
  };
  let version = 0, saveTimer = 0, noticeTimer = 0, monitorTimer = 0;
  let engine = null, phase = 'idle', epoch = 0;
  let playing = false, hold = false;
  let lastNote = 52;
  let ledText = '', ledUntil = 0;
  const meter = { step: -1, peak: 0, pos: 0, mix: 0, voices: 0 };
  const downNotes = new Set();
  const tableCache = new Map();
  const drawCache = new Map();

  const P = () => state.patches[state.patchIndex];
  const S = () => state.seqs[state.patchIndex];

  /* ── helpers ───────────────────────────────────────────────────────── */
  function notice(text, keep = false) {
    clearTimeout(noticeTimer);
    const el = $('notice');
    el.textContent = text;
    el.hidden = !text;
    if (text && !keep) noticeTimer = setTimeout(() => { el.hidden = true; }, 3800);
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const value = { v: 1, patchIndex: state.patchIndex, patches: state.patches, seqs: state.seqs, envSel: state.envSel, arp: state.arp, page: state.page };
        const r = await sdk.data.set(SAVE_KEY, value, { expectedVersion: version });
        version = r.version;
      } catch (_) { /* best effort */ }
    }, 800);
  }
  function post(msg) { if (engine) engine.node.port.postMessage(msg); }
  function pushPatch() { post({ type: 'patch', patch: P() }); }
  function pushSeq() { post({ type: 'seq', seq: S() }); }
  function pushArp() {
    post({ type: 'arp', arp: { on: state.mode === 'ARP', type: state.arp.arpType, oct: state.arp.arpOct, rate: state.arp.arpRate, hold } });
  }

  /** current value of a parameter key, wherever it lives */
  function getValue(key) {
    const p = P();
    if (key.startsWith('env.')) {
      const k = key[4];
      return p[['envO', 'envF', 'envA'][state.envSel === 3 ? 2 : state.envSel]][k];
    }
    if (PARAMS[key].seq) return S()[key];
    if (PARAMS[key].arp) return state.arp[key];
    const v = p[key];
    return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  }
  function setValue(key, value) {
    const spec = PARAMS[key];
    let v = clamp(value, spec.min, spec.max);
    if (spec.int) v = Math.round(v);
    const p = P();
    if (key.startsWith('env.')) {
      const k = key[4];
      const targets = state.envSel === 3 ? ['envO', 'envF', 'envA'] : [['envO', 'envF', 'envA'][state.envSel]];
      for (const t of targets) p[t][k] = v;
      pushPatch();
    } else if (spec.seq) {
      S()[key] = v;
      pushSeq();
      if (key === 'length') buildSteps();
    } else if (spec.arp) {
      state.arp[key] = v;
      pushArp();
    } else {
      p[key] = spec.bool ? !!v : v;
      pushPatch();
      if (key === 'wave1' || key === 'wave2') ensureTables([p.wave1, p.wave2]);
    }
    showValue(key);
    save();
  }
  function showValue(key) {
    const spec = PARAMS[key];
    const v = getValue(key);
    setLed(spec.led ? spec.led(v) : spec.fmt(v), 1400);
    if (key === 'wave1' || key === 'wave2') notice(`${spec.label}: ${lib.TABLES[v].name}`);
  }
  function setLed(text, ms) { ledText = text; ledUntil = performance.now() + ms; drawLed(); }

  /* ── wavetables: built on this thread, posted to the worklet ───────── */
  let buildQueue = Promise.resolve();
  function ensureTables(list) {
    for (const t of list) {
      buildQueue = buildQueue.then(async () => {
        if (!tableCache.has(t)) {
          await new Promise((r) => setTimeout(r, 0));
          tableCache.set(t, lib.buildTable(t));
        }
        if (engine && !engine.sent.has(t)) {
          engine.node.port.postMessage({ type: 'table', index: t, mips: tableCache.get(t) });
          engine.sent.add(t);
        }
      });
    }
    return buildQueue;
  }

  /* ── audio ─────────────────────────────────────────────────────────── */
  async function release(e) {
    if (!e) return;
    try { e.node?.disconnect(); e.outNode?.disconnect(); } catch (_) { /* gone */ }
    await Promise.allSettled([e.out?.close(), e.ctx?.close()]);
  }
  async function stop() {
    ++epoch;
    const old = engine;
    engine = null;
    phase = 'idle';
    render();
    await release(old);
  }
  async function start() {
    if (phase === 'starting' || phase === 'live') return;
    const token = ++epoch;
    const e = { sent: new Set() };
    phase = 'starting';
    render();
    try {
      e.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive', sinkId: { type: 'none' } });
      if (!e.ctx.audioWorklet) throw Object.assign(new Error('no worklet'), { code: 'unsupported_environment' });
      await e.ctx.resume();
      if (e.ctx.state !== 'running') throw Object.assign(new Error('gesture'), { code: 'interaction_required' });
      await e.ctx.audioWorklet.addModule(new URL('dsp.js', location.href).href);
      e.node = new AudioWorkletNode(e.ctx, 'wavescape', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      e.out = await sdk.audio.openOutput({ channels: 2 });
      e.outNode = await e.out.createNode(e.ctx);
      e.node.connect(e.outNode);
      e.node.port.onmessage = ({ data }) => {
        if (engine !== e || !data || data.type !== 'meter') return;
        Object.assign(meter, data);
      };
      if (token !== epoch) { await release(e); return; }
      engine = e;
      phase = 'live';
      pushPatch(); pushSeq(); pushArp();
      post({ type: 'transport', play: playing });
      // the current patch's tables first, then the rest in the background
      const p = P();
      await ensureTables([p.wave1, p.wave2]);
      void ensureTables(lib.TABLES.map((_, i) => i));
      e.ctx.onstatechange = () => { if (engine === e && e.ctx.state !== 'running') void fail(); };
      render();
    } catch (error) {
      await release(e);
      if (token !== epoch) return;
      phase = 'error';
      render();
      const code = error.code || error.name;
      notice(code === 'audio_device_unavailable' ? 'Choose an available OUT in the K1 Menu, then tap START.'
        : code === 'unsupported_environment' ? 'Audio is unavailable here. Launch on the device.'
          : code === 'interaction_required' ? 'Tap START to begin audio.'
            : 'Audio did not start. Tap START to retry.', true);
    }
  }
  async function fail() { await stop(); phase = 'error'; render(); notice('Audio paused. Tap START to resume.', true); }

  /* ── notes, modes, transport ───────────────────────────────────────── */
  function noteOn(n) {
    if (phase !== 'live') { void start(); }
    lastNote = n;
    downNotes.add(n);
    post({ type: 'note', on: true, note: n, vel: 100 });
    setLed(NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1), 700);
  }
  function noteOff(n) {
    downNotes.delete(n);
    // HOLD in NOTE mode sustains notes until HOLD is released
    if (hold && state.mode === 'NOTE') return;
    post({ type: 'note', on: false, note: n });
  }
  function setMode(m) {
    if (state.mode === m) return;
    for (const n of [...downNotes]) noteOff(n);
    state.mode = m;
    pushArp();
    buildSteps();
    render();
  }
  function togglePlay() {
    if (phase !== 'live') void start();
    playing = !playing;
    post({ type: 'transport', play: playing });
    setLed(playing ? 'PLAY' : 'StoP', 800);
    render();
  }
  function setHold(on) {
    hold = on;
    if (!on && state.mode === 'NOTE') for (let n = 0; n < 128; n++) if (!downNotes.has(n)) post({ type: 'note', on: false, note: n });
    pushArp();
    render();
  }
  function selectPatch(i) {
    state.patchIndex = (i + state.patches.length) % state.patches.length;
    state.seqPage = 0;
    post({ type: 'panic' });
    pushPatch(); pushSeq();
    const p = P();
    void ensureTables([p.wave1, p.wave2]);
    setLed('P.' + String(state.patchIndex + 1).padStart(2, '0'), 1200);
    buildSteps();
    render();
    save();
  }
  function restorePatch() {
    state.patches[state.patchIndex] = structuredClone(FACTORY[state.patchIndex].patch);
    state.seqs[state.patchIndex] = structuredClone(FACTORY[state.patchIndex].seq);
    pushPatch(); pushSeq();
    buildSteps(); render(); save();
    notice('Patch restored to factory.');
  }
  function setPage(i) {
    state.page = (i + PAGES.length) % PAGES.length;
    renderControls();
    renderSections();
    monitor();
    save();
  }
  function randomize() {
    // a random line in E minor over the pattern's length (two octaves)
    const scale = [0, 2, 3, 5, 7, 8, 10];
    const s = S();
    for (let i = 0; i < s.length; i++) {
      const on = Math.random() < 0.65;
      const deg = scale[(Math.random() * scale.length) | 0] + (Math.random() < 0.3 ? 12 : 0);
      s.steps[i] = { on, notes: [52 + deg], vel: 70 + ((Math.random() * 57) | 0), gate: 0.3 + Math.random() * 0.5, tie: false };
    }
    pushSeq(); buildSteps(); save();
    setLed('rnd', 700);
  }

  /* ── 7-segment display ─────────────────────────────────────────────── */
  //   segments: a b c d e f g (bit 0..6)
  const SEG = {
    0: 0x3f, 1: 0x06, 2: 0x5b, 3: 0x4f, 4: 0x66, 5: 0x6d, 6: 0x7d, 7: 0x07, 8: 0x7f, 9: 0x6f,
    A: 0x77, B: 0x7c, C: 0x39, D: 0x5e, E: 0x79, F: 0x71, G: 0x3d, H: 0x76, I: 0x06, J: 0x1e, K: 0x76,
    L: 0x38, M: 0x37, N: 0x54, O: 0x5c, P: 0x73, Q: 0x67, R: 0x50, S: 0x6d, T: 0x78, U: 0x3e, V: 0x3e,
    W: 0x3e, X: 0x76, Y: 0x6e, Z: 0x5b, '-': 0x40, '_': 0x08, "'": 0x02, ' ': 0, '#': 0x63, '/': 0x52
  };
  function drawLed() {
    const c = $('led');
    const g = c.getContext('2d');
    const w = c.width, h = c.height;
    g.fillStyle = '#2a0805';
    g.fillRect(0, 0, w, h);
    const now = performance.now();
    let text = now < ledUntil ? ledText : idleLed();
    // dots attach to the previous character
    const chars = [];
    for (const ch of text.toUpperCase()) {
      if (ch === '.' && chars.length) chars[chars.length - 1].dp = true;
      else chars.push({ ch, dp: false });
    }
    while (chars.length < 4) chars.unshift({ ch: ' ', dp: false });
    const cells = chars.slice(-4);
    const cw = w / 4, sh = h * 0.72, sw = cw * 0.5, t = Math.max(2, h * 0.075);
    cells.forEach((cell, i) => {
      const bits = SEG[cell.ch] ?? 0;
      const x0 = i * cw + cw * 0.22, y0 = (h - sh) / 2;
      const segs = [
        [x0 + t * 0.6, y0, sw - t * 1.2, t], [x0 + sw - t, y0 + t * 0.6, t, sh / 2 - t * 0.8],
        [x0 + sw - t, y0 + sh / 2 + t * 0.2, t, sh / 2 - t * 0.8], [x0 + t * 0.6, y0 + sh - t, sw - t * 1.2, t],
        [x0, y0 + sh / 2 + t * 0.2, t, sh / 2 - t * 0.8], [x0, y0 + t * 0.6, t, sh / 2 - t * 0.8],
        [x0 + t * 0.6, y0 + sh / 2 - t / 2, sw - t * 1.2, t]
      ];
      segs.forEach((s, k) => {
        g.fillStyle = bits & (1 << k) ? '#ff3a22' : 'rgba(255,58,34,0.08)';
        g.save();
        g.translate(s[0] + s[2] / 2, s[1] + s[3] / 2);
        g.transform(1, 0, -0.08, 1, 0, 0);
        g.fillRect(-s[2] / 2, -s[3] / 2, s[2], s[3]);
        g.restore();
      });
      g.fillStyle = cell.dp ? '#ff3a22' : 'rgba(255,58,34,0.08)';
      g.fillRect(x0 + sw + t * 0.3, y0 + sh - t, t, t);
    });
  }
  function idleLed() {
    if (playing && state.mode === 'SEQ' && meter.step >= 0) return 'S' + String(meter.step + 1).padStart(3, ' ');
    return 'P.' + String(state.patchIndex + 1).padStart(2, '0');
  }

  /* ── panel: sections, controls ─────────────────────────────────────── */
  function renderSections() {
    const nav = $('sections');
    nav.innerHTML = '';
    const cur = PAGES[state.page].sec;
    for (const sec of SECTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sec' + (sec === cur ? ' on' : '');
      b.textContent = sec;
      b.addEventListener('click', () => {
        // first tap: the section's first page; tapping again flips its pages
        const pages = PAGES.map((p, i) => [p, i]).filter(([p]) => p.sec === sec).map(([, i]) => i);
        const at = pages.indexOf(state.page);
        setPage(at < 0 ? pages[0] : pages[(at + 1) % pages.length]);
      });
      nav.appendChild(b);
    }
  }

  function renderControls() {
    const page = PAGES[state.page];
    $('pageTitle').textContent = page.title + (page.sec === 'ENV' ? ' · ' + ENV_SEL[state.envSel] : '');
    const root = $('controls');
    root.innerHTML = '';
    page.keys.forEach((key, i) => {
      const cell = document.createElement('div');
      cell.className = 'ctl';
      if (!key) { cell.classList.add('empty'); root.appendChild(cell); return; }
      const spec = PARAMS[key];
      const knob = spec.int;
      cell.innerHTML = `<span class="enc">E${i + 1}</span><span class="lab">${spec.label}</span>` +
        (knob ? '<span class="knob"><i></i></span>' : '<span class="fader"><span class="ticks"></span><span class="cap"></span></span>') +
        '<span class="val"></span>';
      cell.dataset.key = key;
      // drag vertically to change; tap a knob to step it
      let startY = 0, startV = 0, moved = false;
      cell.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        cell.setPointerCapture(ev.pointerId);
        startY = ev.clientY; startV = getValue(key); moved = false;
      });
      cell.addEventListener('pointermove', (ev) => {
        if (!cell.hasPointerCapture(ev.pointerId)) return;
        const dy = startY - ev.clientY;
        if (Math.abs(dy) > 3) moved = true;
        if (!moved) return;
        const span = spec.max - spec.min;
        setValue(key, startV + (dy / (knob ? 60 : 110)) * (knob ? Math.max(4, span) * 0.6 : span));
        updateControls();
      });
      cell.addEventListener('pointerup', () => {
        if (!moved && knob) {
          const v = getValue(key);
          setValue(key, v >= spec.max ? spec.min : v + 1);
          updateControls();
        } else if (!moved) showValue(key);
      });
      root.appendChild(cell);
    });
    if (page.sec === 'ENV') {
      const sel = document.createElement('button');
      sel.type = 'button';
      sel.className = 'envsel';
      sel.textContent = 'ENV SELECT · ' + ENV_SEL[state.envSel];
      sel.addEventListener('click', () => { state.envSel = (state.envSel + 1) % 4; renderControls(); save(); });
      root.appendChild(sel);
    }
    updateControls();
  }

  function updateControls() {
    for (const cell of $('controls').querySelectorAll('.ctl[data-key]')) {
      const key = cell.dataset.key;
      const spec = PARAMS[key];
      const v = getValue(key);
      const k = (v - spec.min) / (spec.max - spec.min || 1);
      const cap = cell.querySelector('.cap');
      if (cap) cap.style.bottom = `calc(${(k * 100).toFixed(1)}% - ${(k * 12).toFixed(1)}px)`;
      const knob = cell.querySelector('.knob i');
      if (knob) knob.style.transform = `rotate(${-135 + k * 270}deg)`;
      cell.querySelector('.val').textContent = spec.names ? lib.TABLES[v].name : spec.fmt(v);
    }
  }

  /* ── the 16 buttons ────────────────────────────────────────────────── */
  const BTN_COLORS = ['white', 'lblue', 'lblue', 'dblue', 'dblue', 'red', 'red', 'orange',
    'white', 'white', 'white', 'white', 'white', 'white', 'lblue', 'dblue'];
  let pressTimer = 0;
  function buildSteps() {
    const row = $('steps');
    row.innerHTML = '';
    const labels = $('stepLabels');
    labels.innerHTML = '';
    for (let i = 0; i < 16; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pad ' + BTN_COLORS[i];
      b.innerHTML = '<i class="lamp"></i>';
      b.dataset.i = i;
      wirePad(b, i);
      row.appendChild(b);
      const l = document.createElement('span');
      if (state.mode === 'SEQ') {
        const n = state.seqPage * 16 + i;
        l.textContent = String(n + 1);
        l.className = n < S().length ? '' : 'dim';
      } else {
        l.textContent = i < 13 ? NOTE_NAMES[i % 12] : ['−OCT', '+OCT', S_POLY()][i - 13];
      }
      labels.appendChild(l);
    }
    updatePads();
  }
  const S_POLY = () => (P().poly ? 'POLY' : 'SOLO');

  function wirePad(b, i) {
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      b.setPointerCapture(ev.pointerId);
      b.classList.add('down');
      if (state.mode === 'SEQ') {
        clearTimeout(pressTimer);
        b.dataset.long = '';
        pressTimer = setTimeout(() => { b.dataset.long = '1'; openStep(state.seqPage * 16 + i); }, 450);
        return;
      }
      if (i < 13) { const n = 12 * (state.octave + 1) + i; b.dataset.note = n; noteOn(n); }
      else if (i === 13) { state.octave = Math.max(1, state.octave - 1); setLed('oct' + state.octave, 700); }
      else if (i === 14) { state.octave = Math.min(7, state.octave + 1); setLed('oct' + state.octave, 700); }
      else { P().poly = !P().poly; pushPatch(); save(); buildSteps(); setLed(P().poly ? 'PoLy' : 'SoLo', 800); }
    });
    const up = () => {
      b.classList.remove('down');
      if (state.mode === 'SEQ') {
        clearTimeout(pressTimer);
        if (b.dataset.long !== '1') toggleStep(state.seqPage * 16 + i);
        b.dataset.long = '';
        return;
      }
      if (b.dataset.note) { noteOff(Number(b.dataset.note)); delete b.dataset.note; }
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  }

  function toggleStep(n) {
    const s = S();
    if (n >= s.length) { s.length = n + 1; buildSteps(); }
    const st = s.steps[n];
    st.on = !st.on;
    if (st.on && !st.notes.length) st.notes = [lastNote];
    if (st.on) setLed(NOTE_NAMES[st.notes[0] % 12] + (Math.floor(st.notes[0] / 12) - 1), 700);
    pushSeq(); updatePads(); save();
  }

  function updatePads() {
    const pads = $('steps').children;
    const s = S();
    for (let i = 0; i < pads.length; i++) {
      const b = pads[i];
      let lit = false, beat = false;
      if (state.mode === 'SEQ') {
        const n = state.seqPage * 16 + i;
        lit = n < s.length && s.steps[n].on;
        beat = playing && meter.step === n;
      } else if (i < 13) {
        lit = downNotes.has(12 * (state.octave + 1) + i);
      } else if (i === 15) lit = !P().poly;
      b.classList.toggle('lit', lit);
      b.classList.toggle('beat', beat);
    }
  }

  /* ── step editor (long-press a step) ───────────────────────────────── */
  let editStep = -1;
  let editOct = 3;
  function openStep(n) {
    const s = S();
    if (n >= s.length) { s.length = n + 1; pushSeq(); buildSteps(); }
    editStep = n;
    const st = s.steps[n];
    if (st.notes.length) editOct = Math.floor(Math.min(...st.notes) / 12) - 1;
    $('stepEditor').hidden = false;
    renderEditor();
  }
  function renderEditor() {
    const st = S().steps[editStep];
    $('edTitle').textContent = `STEP ${editStep + 1}`;
    const kb = $('edKeys');
    kb.innerHTML = '';
    for (let i = 0; i < 25; i++) {
      const n = 12 * (editOct + 1) + i;
      const k = document.createElement('button');
      k.type = 'button';
      k.className = 'key' + ([1, 3, 6, 8, 10].includes(i % 12) ? ' black' : '') + (st.notes.includes(n) ? ' on' : '');
      k.title = NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
      k.addEventListener('click', () => {
        if (st.notes.includes(n)) st.notes = st.notes.filter((x) => x !== n);
        else if (st.notes.length < 8) st.notes.push(n);
        st.on = st.notes.length > 0;
        if (st.on) lastNote = n;
        post({ type: 'note', on: true, note: n, vel: st.vel });
        setTimeout(() => post({ type: 'note', on: false, note: n }), 180);
        pushSeq(); renderEditor(); updatePads(); save();
      });
      kb.appendChild(k);
    }
    $('edOct').textContent = 'C' + editOct;
    $('edGate').value = Math.round(st.gate * 100);
    $('edVel').value = st.vel;
    $('edTie').classList.toggle('on', !!st.tie);
    $('edNotes').textContent = st.notes.length ? st.notes.slice().sort((a, b) => a - b)
      .map((x) => NOTE_NAMES[x % 12] + (Math.floor(x / 12) - 1)).join(' ') : 'REST';
  }
  function wireEditor() {
    $('edClose').addEventListener('click', () => { $('stepEditor').hidden = true; editStep = -1; updatePads(); });
    $('edDown').addEventListener('click', () => { editOct = Math.max(0, editOct - 1); renderEditor(); });
    $('edUp').addEventListener('click', () => { editOct = Math.min(6, editOct + 1); renderEditor(); });
    $('edGate').addEventListener('input', (e) => { S().steps[editStep].gate = e.target.value / 100; pushSeq(); save(); });
    $('edVel').addEventListener('input', (e) => { S().steps[editStep].vel = Number(e.target.value); pushSeq(); save(); });
    $('edTie').addEventListener('click', () => { const st = S().steps[editStep]; st.tie = !st.tie; pushSeq(); renderEditor(); save(); });
    $('edClear').addEventListener('click', () => { S().steps[editStep] = emptyStep(); pushSeq(); renderEditor(); updatePads(); save(); });
  }

  /* ── wavetable view ────────────────────────────────────────────────── */
  const wt = $('wt');
  const wg = wt.getContext('2d');
  function frames(t) {
    if (!drawCache.has(t)) {
      const list = [];
      for (let f = 0; f < 20; f++) list.push(lib.frameWave(t, f / 19, 64));
      drawCache.set(t, list);
    }
    return drawCache.get(t);
  }
  function drawTable() {
    const r = wt.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (wt.width !== Math.round(r.width * dpr) || wt.height !== Math.round(r.height * dpr)) {
      wt.width = Math.round(r.width * dpr); wt.height = Math.round(r.height * dpr);
    }
    const W = r.width, H = r.height;
    wg.setTransform(dpr, 0, 0, dpr, 0, 0);
    wg.fillStyle = '#101214';
    wg.fillRect(0, 0, W, H);
    const p = P();
    // show the layer that dominates the mix; the other faintly behind it
    const live = phase === 'live' && meter.voices > 0;
    const pos = live ? meter.pos : p.position;
    const mix = live ? meter.mix : p.layerMix;
    const tMain = mix > 0.5 ? p.wave2 : p.wave1;
    const fr = frames(tMain);
    const n = fr.length;
    const dx = W * 0.012, dy = -H * 0.022;
    const ww = W * 0.68, hh = H * 0.16;
    const x0 = W * 0.08, y0 = H * 0.82;
    const cur = (pos / 127) * (n - 1);
    for (let f = n - 1; f >= 0; f--) {
      const ox = x0 + f * dx, oy = y0 + f * dy;
      const near = Math.abs(f - cur) < 0.5;
      wg.strokeStyle = near ? '#ff7a1a' : `rgba(220,226,232,${0.18 + 0.5 * (1 - f / n)})`;
      wg.lineWidth = near ? 2 : 1;
      wg.beginPath();
      const w = fr[f];
      for (let i = 0; i < w.length; i++) {
        const x = ox + (i / (w.length - 1)) * ww, y = oy - w[i] * hh;
        if (i) wg.lineTo(x, y); else wg.moveTo(x, y);
      }
      wg.stroke();
    }
    // the exact current frame, interpolated, drawn bold
    const f0 = Math.min(n - 2, Math.floor(cur)), ff = cur - f0;
    wg.strokeStyle = '#ff7a1a';
    wg.lineWidth = 2.2;
    wg.beginPath();
    for (let i = 0; i < 64; i++) {
      const v = fr[f0][i] * (1 - ff) + fr[f0 + 1][i] * ff;
      const x = x0 + cur * dx + (i / 63) * ww, y = y0 + cur * dy - v * hh;
      if (i) wg.lineTo(x, y); else wg.moveTo(x, y);
    }
    wg.stroke();
    wg.fillStyle = '#c8ced4';
    wg.font = '600 9px "Helvetica Neue", Arial, sans-serif';
    wg.fillText(`${mix > 0.5 ? 'L2' : 'L1'} ${lib.TABLES[tMain].name}`, 8, 13);
    wg.textAlign = 'right';
    wg.fillText(`POS ${Math.round(pos)}`, W - 8, 13);
    wg.textAlign = 'left';
    // level meter along the bottom
    const lvl = Math.min(1, meter.peak * 1.3);
    wg.fillStyle = '#ff3a22';
    wg.fillRect(8, H - 5, (W - 16) * lvl, 2);
  }

  /* ── render ────────────────────────────────────────────────────────── */
  function render() {
    $('patchName').textContent = String(state.patchIndex + 1).padStart(2, '0') + ' ' + P().name;
    for (const m of ['NOTE', 'ARP', 'SEQ']) $('m' + m).classList.toggle('lit', state.mode === m);
    $('start').classList.toggle('lit', playing);
    $('hold').classList.toggle('lit', hold);
    $('rnd').hidden = state.mode !== 'SEQ';
    $('seqPage').hidden = state.mode !== 'SEQ';
    $('seqPage').textContent = `PAGE ${state.seqPage + 1}/${Math.max(1, Math.ceil(S().length / 16))}`;
    $('audioState').textContent = phase === 'live' ? '' : phase === 'starting' ? 'STARTING…' : 'TAP START FOR AUDIO';
    renderSections();
    updatePads();
    monitor();
  }
  function monitor() {
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      const values = {};
      PAGES[state.page].keys.forEach((key, i) => {
        if (!key) return;
        const spec = PARAMS[key];
        const v = getValue(key);
        values['E' + (i + 1)] = { label: spec.label, value: spec.names ? lib.TABLES[v].name : spec.fmt(v) };
      });
      values.K2 = { label: playing ? 'Stop' : 'Start', pressed: playing };
      values.K3 = { label: 'Page', value: PAGES[state.page].title };
      values.K4 = { label: 'Patch', value: P().name };
      void sdk.monitor.set(values).catch(() => {});
    }, 40);
  }

  let lastStep = -2;
  function frame() {
    drawTable();
    if (meter.step !== lastStep) {
      lastStep = meter.step;
      // follow the playhead across 16-step pages
      if (state.mode === 'SEQ' && playing && meter.step >= 0 && $('stepEditor').hidden) {
        const pg = Math.floor(meter.step / 16);
        if (pg !== state.seqPage) { state.seqPage = pg; buildSteps(); render(); }
      }
      updatePads();
    }
    drawLed();
    requestAnimationFrame(frame);
  }

  /* ── hardware controls ─────────────────────────────────────────────── */
  const encAcc = [0, 0, 0, 0];
  function handleControl(e) {
    const ei = ['E1', 'E2', 'E3', 'E4'].indexOf(e.control);
    if (ei >= 0) {
      const key = PAGES[state.page].keys[ei];
      if (!key) return;
      const spec = PARAMS[key];
      if (e.type === 'rotate') {
        if (spec.int) {
          encAcc[ei] += e.delta;
          const steps = Math.trunc(encAcc[ei] / 2);
          if (steps) { encAcc[ei] -= steps * 2; setValue(key, getValue(key) + steps); }
        } else {
          setValue(key, getValue(key) + (e.delta / 160) * (spec.max - spec.min));
        }
        updateControls();
        monitor();
      } else if (e.type === 'down') {
        // press: back to the patch's stored value
        const f = FACTORY[state.patchIndex];
        let v;
        if (key.startsWith('env.')) v = f.patch[['envO', 'envF', 'envA'][state.envSel === 3 ? 2 : state.envSel]][key[4]];
        else if (spec.seq) v = f.seq[key];
        else if (spec.arp) v = { arpType: 0, arpOct: 1, arpRate: 1 }[key];
        else v = typeof f.patch[key] === 'boolean' ? (f.patch[key] ? 1 : 0) : f.patch[key];
        setValue(key, v);
        updateControls();
        monitor();
      }
      return;
    }
    if (e.type !== 'down') return;
    if (e.control === 'K2') togglePlay();
    else if (e.control === 'K3') setPage(state.page + 1);
    else if (e.control === 'K4') selectPatch(state.patchIndex + 1);
  }

  function wireButtons() {
    for (const m of ['NOTE', 'ARP', 'SEQ']) $('m' + m).addEventListener('click', () => setMode(m));
    $('start').addEventListener('click', togglePlay);
    $('hold').addEventListener('click', () => setHold(!hold));
    // PATCH: tap for next, hold to restore the factory version
    let patchTimer = 0, patchLong = false;
    $('patch').addEventListener('pointerdown', () => {
      patchLong = false;
      patchTimer = setTimeout(() => { patchLong = true; restorePatch(); }, 700);
    });
    $('patch').addEventListener('pointerup', () => { clearTimeout(patchTimer); if (!patchLong) selectPatch(state.patchIndex + 1); });
    $('seqPage').addEventListener('click', () => {
      const pages = Math.max(1, Math.ceil(S().length / 16));
      state.seqPage = (state.seqPage + 1) % Math.max(pages + (S().length < 64 ? 1 : 0), 1);
      buildSteps(); render();
    });
    $('rnd').addEventListener('click', randomize);
    $('led').addEventListener('click', () => { if (phase !== 'live') void start(); });
    wireEditor();
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */
  async function load() {
    try {
      const r = await sdk.data.get(SAVE_KEY);
      version = r.version;
      const v = r.value;
      if (v && v.v === 1 && Array.isArray(v.patches) && v.patches.length === FACTORY.length) {
        state.patches = v.patches.map((p, i) => ({ ...structuredClone(FACTORY[i].patch), ...p }));
        if (Array.isArray(v.seqs) && v.seqs.length === FACTORY.length) state.seqs = v.seqs;
        state.patchIndex = clamp(v.patchIndex | 0, 0, FACTORY.length - 1);
        if (Number.isInteger(v.envSel)) state.envSel = clamp(v.envSel, 0, 3);
        if (v.arp) state.arp = { ...state.arp, ...v.arp };
        if (Number.isInteger(v.page)) state.page = clamp(v.page, 0, PAGES.length - 1);
      }
    } catch (_) { /* first run */ }
  }

  async function init() {
    wireButtons();
    buildSteps();
    renderControls();
    render();
    requestAnimationFrame(frame);
    await load();
    buildSteps();
    renderControls();
    render();
    sdk.controls.onEvent(handleControl);
    sdk.audio.onAvailable(() => { if (phase === 'live' || phase === 'error') void stop().then(start); });
    await sdk.ready();
    void start();
  }
  addEventListener('pagehide', () => { void stop(); });
  void init();
})();
