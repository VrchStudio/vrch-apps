(() => {
  'use strict';

  const sdk = VrchApp;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lib = window.PetalFM;
  const SAVE_KEY = 'petal-fm';

  /* ── voices ───────────────────────────────────────────────────────────
   * Recreations in the spirit of the classic factory voices. Each operator
   * (OP1 … OP6) is [coarse, fine, detune, level, R1, R2, R3, R4,
   * L1, L2, L3, L4, velocity sensitivity, rate scaling]; coarse 0 = 0.5.
   * alg is 1-32 here; lfo is [speed, delay, pitch depth, amp depth, wave]. */
  const V = (name, alg, fb, ops, lfo = [35, 0, 0, 0, 0], transpose = 0) => ({ name, alg, fb, ops, lfo, transpose });
  const PRESETS = [
    V('E.PIANO 1', 5, 6, [
      [1, 0, 3, 99, 96, 25, 25, 67, 99, 75, 0, 0, 2, 3], [14, 0, 0, 58, 95, 50, 35, 78, 99, 75, 0, 0, 7, 3],
      [1, 0, 0, 99, 95, 20, 20, 50, 99, 95, 0, 0, 2, 3], [1, 0, 0, 89, 95, 29, 20, 50, 99, 95, 0, 0, 6, 3],
      [1, 0, -2, 99, 95, 20, 20, 50, 99, 95, 0, 0, 0, 3], [1, 0, 2, 79, 95, 29, 20, 50, 99, 95, 0, 0, 6, 3]], [34, 33, 0, 0, 4]),
    V('BASS 1', 16, 6, [
      [0, 0, 0, 99, 99, 40, 30, 70, 99, 80, 70, 0, 2, 2], [1, 0, 0, 86, 99, 55, 30, 70, 99, 60, 0, 0, 4, 2],
      [1, 0, 0, 80, 99, 60, 30, 70, 99, 50, 0, 0, 3, 2], [3, 0, 0, 70, 99, 70, 30, 70, 99, 40, 0, 0, 3, 2],
      [1, 0, 0, 75, 99, 50, 30, 70, 99, 70, 50, 0, 2, 2], [5, 0, 0, 60, 99, 80, 30, 70, 99, 30, 0, 0, 3, 2]], undefined, -12),
    V('BRASS 1', 22, 7, [
      [1, 0, 0, 99, 72, 76, 99, 71, 99, 88, 96, 0, 2, 1], [1, 0, 0, 85, 62, 51, 29, 71, 82, 95, 96, 0, 3, 1],
      [1, 0, -3, 97, 77, 76, 82, 71, 99, 98, 98, 0, 1, 1], [1, 0, 3, 97, 77, 36, 41, 71, 99, 98, 98, 0, 1, 1],
      [1, 0, 0, 95, 77, 36, 41, 71, 99, 98, 98, 0, 1, 1], [1, 0, 1, 82, 49, 99, 28, 68, 98, 98, 91, 0, 3, 1]], [37, 0, 5, 0, 4]),
    V('STRINGS 1', 2, 7, [
      [1, 0, 2, 99, 45, 24, 20, 41, 99, 85, 70, 0, 1, 0], [1, 0, -2, 80, 75, 71, 35, 72, 99, 76, 0, 0, 2, 0],
      [1, 0, -2, 99, 44, 45, 20, 41, 99, 85, 70, 0, 1, 0], [3, 0, 0, 62, 98, 98, 36, 72, 99, 57, 51, 0, 2, 0],
      [1, 0, 3, 78, 86, 64, 46, 24, 99, 93, 84, 0, 1, 0], [14, 0, 0, 58, 53, 19, 20, 60, 99, 92, 0, 0, 1, 0]], [30, 40, 6, 0, 4]),
    V('TUB BELLS', 5, 6, [
      [1, 0, 0, 95, 95, 33, 71, 25, 99, 0, 32, 0, 2, 2], [3, 50, 0, 78, 98, 12, 71, 28, 99, 0, 32, 0, 2, 2],
      [1, 0, 2, 95, 95, 33, 71, 25, 99, 0, 32, 0, 2, 2], [3, 50, 1, 78, 98, 12, 71, 28, 99, 0, 32, 0, 2, 2],
      [2, 0, -3, 90, 76, 78, 71, 70, 99, 0, 0, 0, 2, 2], [2, 0, 0, 70, 98, 91, 0, 28, 99, 0, 0, 0, 6, 2]]),
    V('MARIMBA', 5, 0, [
      [1, 0, 0, 99, 95, 37, 30, 57, 99, 0, 0, 0, 2, 3], [3, 0, 0, 72, 99, 72, 30, 70, 99, 0, 0, 0, 4, 3],
      [4, 0, 0, 85, 95, 62, 30, 57, 99, 0, 0, 0, 3, 3], [10, 0, 0, 60, 99, 80, 30, 70, 99, 0, 0, 0, 4, 3],
      [1, 0, 3, 80, 95, 45, 30, 57, 99, 0, 0, 0, 2, 3], [7, 0, 0, 55, 99, 85, 30, 70, 99, 0, 0, 0, 4, 3]]),
    V('HARPSICH 1', 5, 7, [
      [1, 0, 0, 99, 95, 28, 27, 47, 99, 90, 0, 0, 1, 3], [3, 0, 0, 82, 95, 30, 25, 50, 99, 85, 0, 0, 2, 3],
      [1, 0, -3, 99, 95, 28, 27, 47, 99, 90, 0, 0, 1, 3], [5, 0, 0, 80, 95, 32, 25, 50, 99, 80, 0, 0, 2, 3],
      [2, 0, 2, 90, 95, 28, 27, 47, 99, 90, 0, 0, 1, 3], [8, 0, 0, 72, 95, 36, 25, 50, 99, 75, 0, 0, 2, 3]]),
    V('CLAV 1', 3, 5, [
      [1, 0, 0, 99, 95, 40, 30, 80, 99, 70, 0, 0, 2, 3], [1, 0, 0, 88, 95, 55, 30, 80, 99, 40, 0, 0, 4, 3],
      [3, 0, 0, 75, 95, 65, 30, 80, 99, 30, 0, 0, 4, 3], [3, 0, 0, 85, 95, 45, 30, 80, 99, 60, 0, 0, 2, 3],
      [1, 0, 0, 80, 95, 60, 30, 80, 99, 40, 0, 0, 4, 3], [5, 0, 0, 70, 95, 70, 30, 80, 99, 30, 0, 0, 4, 3]]),
    V('FLUTE 1', 5, 7, [
      [1, 0, 0, 99, 60, 50, 40, 60, 99, 95, 90, 0, 2, 1], [1, 0, 0, 72, 70, 50, 40, 60, 99, 90, 85, 0, 3, 1],
      [2, 0, 0, 70, 60, 50, 40, 60, 99, 90, 85, 0, 1, 1], [1, 0, 0, 50, 70, 50, 40, 60, 99, 80, 70, 0, 1, 1],
      [1, 0, 0, 55, 80, 50, 40, 60, 99, 70, 60, 0, 1, 1], [7, 0, 0, 75, 90, 50, 40, 60, 99, 70, 60, 0, 1, 1]], [35, 50, 4, 0, 4]),
    V('ORGAN 1', 32, 0, [
      [0, 0, 0, 94, 99, 99, 99, 80, 99, 99, 99, 0, 0, 0], [1, 0, 0, 99, 99, 99, 99, 80, 99, 99, 99, 0, 0, 0],
      [2, 0, 2, 90, 99, 99, 99, 80, 99, 99, 99, 0, 0, 0], [3, 0, -2, 86, 99, 99, 99, 80, 99, 99, 99, 0, 0, 0],
      [4, 0, 0, 84, 99, 99, 99, 80, 99, 99, 99, 0, 0, 0], [8, 0, 0, 80, 99, 99, 99, 80, 99, 99, 99, 0, 0, 0]], [55, 0, 3, 0, 4]),
    V('VIBE 1', 5, 3, [
      [1, 0, 0, 99, 96, 40, 30, 40, 99, 60, 0, 0, 2, 2], [4, 0, 0, 70, 99, 60, 30, 50, 99, 0, 0, 0, 3, 2],
      [1, 0, 2, 95, 96, 40, 30, 40, 99, 60, 0, 0, 2, 2], [1, 0, 0, 60, 99, 55, 30, 50, 99, 40, 0, 0, 3, 2],
      [3, 0, 0, 82, 96, 50, 30, 40, 99, 0, 0, 0, 2, 2], [7, 0, 0, 55, 99, 70, 30, 50, 99, 0, 0, 0, 3, 2]], [52, 0, 0, 40, 4]),
    V('SYN-LEAD 1', 18, 7, [
      [1, 0, 0, 99, 99, 40, 30, 60, 99, 90, 85, 0, 1, 1], [1, 0, 3, 82, 99, 30, 30, 60, 99, 90, 85, 0, 2, 1],
      [1, 0, -3, 80, 99, 35, 30, 60, 99, 85, 80, 0, 2, 1], [2, 0, 0, 75, 99, 45, 30, 60, 99, 80, 70, 0, 2, 1],
      [1, 0, 0, 70, 99, 50, 30, 60, 99, 75, 60, 0, 2, 1], [3, 0, 0, 60, 99, 60, 30, 60, 99, 70, 50, 0, 2, 1]], [40, 30, 8, 0, 4])
  ];

  /* ── chords (Orchid-style) ─────────────────────────────────────────── */
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const TYPES = ['DIM', 'MIN', 'MAJ', 'SUS'];
  const EXTS = ['6', 'm7', 'M7', '9'];
  const EXT_SEMI = { 6: 9, m7: 10, M7: 11, 9: 14 };
  const SCALES = { MAJ: [0, 2, 4, 5, 7, 9, 11], MIN: [0, 2, 3, 5, 7, 8, 10] };
  const MODES = ['CHORD', 'STRUM', 'SLOP', 'ARP', 'HARP'];

  /** notes and a name for a root pitch class with the given buttons */
  function buildChord(pc, types, exts) {
    let base, suffix;
    const has = (t) => types.has(t);
    if (!types.size && !exts.size) {
      if (!state.keyMode) return { iv: [0], name: NOTE_NAMES[pc] };
      // KEY mode: the diatonic chord of this root in the chosen key
      const scale = SCALES[state.scale].map((s) => (s + state.key) % 12);
      const deg = scale.indexOf(pc);
      if (deg < 0) { base = [0, 4, 7]; suffix = ''; }
      else {
        const pick = (k) => (scale[(deg + k) % 7] - pc + 12) % 12;
        base = [0, pick(2), pick(4)];
        suffix = base[1] === 3 ? (base[2] === 6 ? 'dim' : 'm') : base[2] === 8 ? 'aug' : '';
      }
      return { iv: base, name: NOTE_NAMES[pc] + suffix };
    }
    if (has('MAJ') && has('MIN')) { base = [0, 4, 8]; suffix = 'aug'; }
    else if (has('MAJ') && has('SUS')) { base = [0, 2, 7]; suffix = 'sus2'; }
    else if (has('DIM') && has('MAJ')) { base = [0, 4, 6]; suffix = '(b5)'; }
    else if (has('DIM')) { base = [0, 3, 6]; suffix = 'dim'; }
    else if (has('MIN')) { base = [0, 3, 7]; suffix = 'm'; }
    else if (has('SUS')) { base = [0, 5, 7]; suffix = 'sus4'; }
    else { base = [0, 4, 7]; suffix = ''; }
    const iv = base.slice();
    let ext = '';
    if (exts.has('6')) { iv.push(9); ext = has('DIM') ? '' : '6'; if (has('DIM')) suffix = 'dim7'; }
    if (exts.has('m7')) { iv.push(10); ext = has('DIM') ? '' : '7'; if (has('DIM')) suffix = 'm7b5'; }
    if (exts.has('M7')) { iv.push(11); ext = 'maj7'; }
    if (exts.has('9')) { iv.push(14); ext = ext === '7' ? '9' : ext === 'maj7' ? 'maj9' : ext ? ext + '/9' : 'add9'; }
    return { iv, name: NOTE_NAMES[pc] + suffix + ext };
  }

  /** chord notes in MIDI, inverted by the VOICING amount */
  function voice(pc, iv) {
    const root = 12 * (state.octave + 1) + pc;
    let notes = iv.map((x) => root + x).sort((a, b) => a - b);
    let v = state.voicing;
    while (v > 0) { const lo = notes.shift(); notes.push(lo + 12); notes.sort((a, b) => a - b); v--; }
    while (v < 0) { const hi = notes.pop(); notes.unshift(hi - 12); notes.sort((a, b) => a - b); v++; }
    return { notes, bass: 12 * (state.octave - 1) + pc };
  }

  /* ── parameters and pages ──────────────────────────────────────────── */
  const pct = (v) => String(Math.round(v * 100));
  const PARAMS = {
    voicing: { label: 'VOICING', min: -6, max: 6, int: true, fmt: (v) => (v > 0 ? '+' : '') + v },
    bass: { label: 'BASS', min: 0, max: 1, fmt: pct },
    mode: { label: 'PLAY MODE', min: 0, max: 4, int: true, fmt: (v) => MODES[v] },
    rate: { label: 'STRUM RATE', min: 0, max: 1, fmt: pct },
    bpm: { label: 'BPM', min: 40, max: 240, int: true, fmt: (v) => String(v) },
    div: { label: 'DIVISION', min: 0, max: 5, int: true, fmt: (v) => ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'][v] },
    swing: { label: 'SWING', min: 0, max: 0.6, fmt: pct },
    key: { label: 'KEY', min: 0, max: 11, int: true, fmt: (v) => NOTE_NAMES[v] },
    scaleIdx: { label: 'SCALE', min: 0, max: 1, int: true, fmt: (v) => ['MAJOR', 'MINOR'][v] },
    octave: { label: 'OCTAVE', min: 2, max: 6, int: true, fmt: (v) => String(v) },
    velocity: { label: 'VELOCITY', min: 0.2, max: 1, fmt: pct },
    alg: { label: 'ALGORITHM', min: 1, max: 32, int: true, voice: true, fmt: (v) => String(v) },
    fb: { label: 'FEEDBACK', min: 0, max: 7, int: true, voice: true, fmt: (v) => String(v) },
    bright: { label: 'BRIGHT', min: -20, max: 20, int: true, voice: true, fmt: (v) => (v > 0 ? '+' : '') + v },
    decay: { label: 'DECAY', min: -30, max: 30, int: true, voice: true, fmt: (v) => (v > 0 ? '+' : '') + v },
    chorus: { label: 'CHORUS', min: 0, max: 1, fmt: pct },
    delay: { label: 'DELAY', min: 0, max: 1, fmt: pct },
    reverb: { label: 'REVERB', min: 0, max: 1, fmt: pct },
    volume: { label: 'VOLUME', min: 0, max: 1, fmt: pct }
  };
  const PAGES = [
    { title: 'PLAY', keys: ['voicing', 'bass', 'mode', 'bpm'] },
    { title: 'TEMPO', keys: ['bpm', 'div', 'swing', 'rate'] },
    { title: 'KEY', keys: ['key', 'scaleIdx', 'octave', 'velocity'] },
    { title: 'VOICE', keys: ['alg', 'fb', 'bright', 'decay'] },
    { title: 'EFFECT', keys: ['chorus', 'delay', 'reverb', 'volume'] }
  ];

  /* ── state ─────────────────────────────────────────────────────────── */
  const state = {
    preset: 0, page: 0,
    voicing: 0, bass: 0.45, mode: 0, rate: 0.5, bpm: 100, div: 3, swing: 0,
    key: 4, scale: 'MIN', octave: 4, velocity: 0.85, keyMode: true,
    chorus: 0.35, delay: 0.15, reverb: 0.3, volume: 0.8,
    edits: PRESETS.map(() => ({ alg: null, fb: null, bright: 0, decay: 0 }))
  };
  let version = 0, saveTimer = 0, noticeTimer = 0, monitorTimer = 0;
  let engine = null, phase = 'idle', epoch = 0;
  let hold = false;
  let chordName = '';
  let soundingKey = -1;
  const heldTypes = new Set(), heldExts = new Set();
  const latchTypes = new Set(), latchExts = new Set();
  const meter = { peak: 0, levels: [0, 0, 0, 0, 0, 0], voices: 0 };

  /** the patch actually played: the preset with this session's edits */
  function patch() {
    const p = PRESETS[state.preset], e = state.edits[state.preset];
    const alg = (e.alg ?? p.alg) - 1;
    const carriers = new Set();
    lib.ALGORITHMS[alg].forEach((f, j) => { if ((f & 3) === 0) carriers.add(5 - j); });
    const ops = p.ops.map((op, i) => {
      const o = op.slice();
      if (!carriers.has(i)) o[3] = clamp(o[3] + e.bright, 0, 99);   // modulators: brightness
      else for (const r of [5, 6, 7]) o[r] = clamp(o[r] - e.decay, 0, 99);  // carriers: decay/release
      return o;
    });
    return { name: p.name, alg, fb: e.fb ?? p.fb, ops, lfo: p.lfo, transpose: p.transpose };
  }

  function getValue(key) {
    if (key === 'scaleIdx') return state.scale === 'MAJ' ? 0 : 1;
    if (PARAMS[key].voice) {
      const e = state.edits[state.preset], p = PRESETS[state.preset];
      if (key === 'alg') return e.alg ?? p.alg;
      if (key === 'fb') return e.fb ?? p.fb;
      return e[key];
    }
    return state[key];
  }
  function setValue(key, value) {
    const spec = PARAMS[key];
    let v = clamp(value, spec.min, spec.max);
    if (spec.int) v = Math.round(v);
    if (key === 'scaleIdx') state.scale = v ? 'MIN' : 'MAJ';
    else if (spec.voice) { state.edits[state.preset][key] = v; pushPatch(); }
    else state[key] = v;
    if (['bass', 'mode', 'rate', 'bpm', 'div', 'swing'].includes(key)) pushPerf();
    if (['chorus', 'delay', 'reverb', 'volume'].includes(key)) pushFx();
    flash(`${spec.label} ${spec.fmt(getValue(key))}`);
    render();
    save();
  }

  /* ── helpers ───────────────────────────────────────────────────────── */
  function notice(text, keep = false) {
    clearTimeout(noticeTimer);
    const el = $('notice');
    el.textContent = text; el.hidden = !text;
    if (text && !keep) noticeTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }
  let lcdFlash = '', lcdUntil = 0;
  function flash(text) { lcdFlash = text; lcdUntil = performance.now() + 1300; renderLcd(); }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const { preset, page, voicing, bass, mode, rate, bpm, div, swing, key, scale, octave, velocity, keyMode, chorus, delay, reverb, volume, edits } = state;
        const r = await sdk.data.set(SAVE_KEY, { v: 1, preset, page, voicing, bass, mode, rate, bpm, div, swing, key, scale, octave, velocity, keyMode, chorus, delay, reverb, volume, edits }, { expectedVersion: version });
        version = r.version;
      } catch (_) { /* best effort */ }
    }, 800);
  }
  const post = (m) => { if (engine) engine.node.port.postMessage(m); };
  const pushPatch = () => post({ type: 'patch', patch: patch() });
  const pushPerf = () => post({ type: 'perf', perf: { mode: state.mode, rate: state.rate, bass: state.bass, bpm: state.bpm, div: state.div, swing: state.swing } });
  const pushFx = () => post({ type: 'fx', fx: { chorus: state.chorus, delay: state.delay, reverb: state.reverb, volume: state.volume } });

  /* ── audio ─────────────────────────────────────────────────────────── */
  async function release(e) {
    if (!e) return;
    try { e.node?.disconnect(); e.outNode?.disconnect(); } catch (_) { /* gone */ }
    await Promise.allSettled([e.out?.close(), e.ctx?.close()]);
  }
  async function stop() { ++epoch; const old = engine; engine = null; phase = 'idle'; render(); await release(old); }
  async function start() {
    if (phase === 'starting' || phase === 'live') return;
    const token = ++epoch;
    const e = {};
    phase = 'starting'; render();
    try {
      e.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      if (!e.ctx.audioWorklet) throw Object.assign(new Error('no worklet'), { code: 'unsupported_environment' });
      await e.ctx.resume();
      if (e.ctx.state !== 'running') throw Object.assign(new Error('gesture'), { code: 'interaction_required' });
      await e.ctx.audioWorklet.addModule(new URL('dsp.js', location.href).href);
      e.node = new AudioWorkletNode(e.ctx, 'petal-fm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      e.out = await sdk.audio.openOutput({ channels: 2 });
      e.outNode = await e.out.createNode(e.ctx);
      e.node.connect(e.outNode);
      e.node.port.onmessage = ({ data }) => { if (engine === e && data && data.type === 'meter') Object.assign(meter, data); };
      if (token !== epoch) { await release(e); return; }
      engine = e; phase = 'live';
      pushPatch(); pushPerf(); pushFx();
      e.ctx.onstatechange = () => { if (engine === e && e.ctx.state !== 'running') void fail(); };
      render();
    } catch (error) {
      await release(e);
      if (token !== epoch) return;
      phase = 'error'; render();
      const code = error.code || error.name;
      notice(code === 'audio_device_unavailable' ? 'Choose an available OUT in the K1 Menu, then tap the display.'
        : code === 'unsupported_environment' ? 'Audio is unavailable here. Launch on the device.'
          : 'Tap the display to start audio.', true);
    }
  }
  async function fail() { await stop(); phase = 'error'; render(); notice('Audio paused. Tap the display to resume.', true); }

  /* ── playing ───────────────────────────────────────────────────────── */
  function activeSets() {
    const anyHeld = heldTypes.size || heldExts.size;
    return anyHeld ? [heldTypes, heldExts] : [latchTypes, latchExts];
  }
  function playKey(pc) {
    if (phase !== 'live') void start();
    const [types, exts] = activeSets();
    const c = buildChord(pc, types, exts);
    const { notes, bass } = voice(pc, c.iv);
    chordName = c.name;
    soundingKey = pc;
    post({ type: 'chord', notes, bass, vel: state.velocity });
    renderLcd(); renderKeys();
  }
  function releaseKey(pc) {
    if (soundingKey !== pc || hold) return;
    soundingKey = -1;
    post({ type: 'release' });
    renderKeys();
  }
  function setHold(on) {
    hold = on;
    if (!on && soundingKey >= 0) { soundingKey = -1; post({ type: 'release' }); }
    render();
  }
  function selectPreset(i) {
    state.preset = (i + PRESETS.length) % PRESETS.length;
    pushPatch();
    flash(`VOICE ${String(state.preset + 1).padStart(2, '0')}`);
    render(); save();
  }
  function setPage(i) { state.page = (i + PAGES.length) % PAGES.length; render(); save(); }

  /* ── rendering ─────────────────────────────────────────────────────── */
  function renderLcd() {
    const p = PRESETS[state.preset];
    const now = performance.now();
    const line1 = `INT${String(state.preset + 1).padStart(2, '0')} ${p.name}`.padEnd(16).slice(0, 16);
    let line2;
    if (now < lcdUntil) line2 = lcdFlash;
    else if (phase !== 'live') line2 = phase === 'starting' ? 'STARTING AUDIO' : 'TOUCH TO START';
    else if (chordName) line2 = `${chordName}  ${state.mode >= 3 ? state.bpm + 'BPM' : MODES[state.mode]}`;
    else line2 = `ALG ${String(getValue('alg')).padStart(2, '0')} KEY ${NOTE_NAMES[state.key]}${state.scale === 'MIN' ? 'm' : ''}`;
    $('lcd1').textContent = line1;
    $('lcd2').textContent = line2.padEnd(16).slice(0, 16);
  }

  function renderParams() {
    const page = PAGES[state.page];
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.page === String(state.page));
    page.keys.forEach((key, i) => {
      const cell = $('p' + i);
      const spec = PARAMS[key];
      const v = getValue(key);
      cell.querySelector('.lab').textContent = spec.label;
      cell.querySelector('.val').textContent = spec.fmt(v);
      const k = (v - spec.min) / (spec.max - spec.min || 1);
      cell.querySelector('.bar i').style.width = (k * 100).toFixed(1) + '%';
      cell.dataset.key = key;
    });
  }

  function renderKeys() {
    for (const k of document.querySelectorAll('.k')) k.classList.toggle('on', Number(k.dataset.pc) === soundingKey);
    const [types, exts] = activeSets();
    for (const b of document.querySelectorAll('.cb')) {
      const id = b.dataset.id;
      const held = heldTypes.has(id) || heldExts.has(id);
      const latched = latchTypes.has(id) || latchExts.has(id);
      b.classList.toggle('held', held);
      b.classList.toggle('latched', latched && !held);
      b.classList.toggle('dim', !(types.has(id) || exts.has(id)) && (types.size + exts.size) > 0);
    }
    // the key's diatonic chords appear under the keys in KEY mode
    const scale = SCALES[state.scale].map((s) => (s + state.key) % 12);
    for (const k of document.querySelectorAll('.k')) {
      const pc = Number(k.dataset.pc);
      k.classList.toggle('inkey', state.keyMode && scale.includes(pc));
    }
  }

  function render() {
    renderLcd(); renderParams(); renderKeys();
    for (const b of document.querySelectorAll('.pre')) b.classList.toggle('on', Number(b.dataset.i) === state.preset);
    $('hold').classList.toggle('on', hold);
    $('keymode').classList.toggle('on', state.keyMode);
    $('keymode').textContent = state.keyMode ? `KEY ${NOTE_NAMES[state.key]}${state.scale === 'MIN' ? 'm' : ''}` : 'KEY OFF';
    for (const b of document.querySelectorAll('.mode')) b.classList.toggle('on', Number(b.dataset.m) === state.mode);
    drawAlgorithm();
    monitor();
  }

  function monitor() {
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      const values = {};
      PAGES[state.page].keys.forEach((key, i) => {
        values['E' + (i + 1)] = { label: PARAMS[key].label, value: PARAMS[key].fmt(getValue(key)) };
      });
      values.K2 = { label: 'Voice', value: PRESETS[state.preset].name };
      values.K3 = { label: 'Page', value: PAGES[state.page].title };
      values.K4 = { label: 'Hold', pressed: hold };
      void sdk.monitor.set(values).catch(() => {});
    }, 40);
  }

  /* ── algorithm diagram ─────────────────────────────────────────────── */
  function graph(alg) {
    const flags = lib.ALGORITHMS[alg];
    const src = { 1: [], 2: [] };
    const mods = [[], [], [], [], [], []];       // mods[op] = modulating ops
    const carriers = [];
    let fbFrom = -1, fbTo = -1;
    flags.forEach((f, j) => {
      const op = 5 - j;
      const inb = (f >> 4) & 3;
      if (inb) mods[op] = src[inb].slice();
      if (f & 0x80) fbFrom = op;
      if (f & 0x40) fbTo = op;
      const ob = f & 3;
      if (ob === 0) carriers.push(op);
      else src[ob] = f & 4 ? src[ob].concat(op) : [op];
    });
    return { mods, carriers: carriers.sort((a, b) => a - b), fbFrom, fbTo };
  }
  function drawAlgorithm() {
    const c = $('alg');
    const r = c.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height;
    g.clearRect(0, 0, W, H);
    const { mods, carriers, fbFrom, fbTo } = graph(getValue('alg') - 1);
    // place: carriers on the bottom row, modulators stacked above
    const pos = {};
    let col = 0;
    const depth = (op) => 1 + Math.max(0, ...mods[op].map(depth));
    const place = (op, row) => {
      if (pos[op]) return pos[op].x;
      const xs = mods[op].map((m) => place(m, row + 1));
      const x = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : col++;
      pos[op] = { x, row };
      return x;
    };
    for (const cop of carriers) place(cop, 0);
    const cols = Math.max(1, col);
    const rows = Math.max(...carriers.map(depth));
    const bw = Math.min(20, (W - 8) / cols - 4), bh = Math.min(13, (H - 10) / rows - 4);
    const X = (x) => 4 + ((x + 0.5) / cols) * (W - 8);
    const Y = (row) => H - 6 - row * ((H - 10) / rows) - bh / 2;
    g.strokeStyle = '#9fd3c7'; g.lineWidth = 1.2;
    for (let op = 0; op < 6; op++) for (const m of mods[op]) {
      if (!pos[op] || !pos[m]) continue;
      g.beginPath(); g.moveTo(X(pos[m].x), Y(pos[m].row) + bh / 2); g.lineTo(X(pos[op].x), Y(pos[op].row) - bh / 2); g.stroke();
    }
    // carriers join along the bottom
    g.beginPath();
    g.moveTo(X(pos[carriers[0]].x), H - 3); g.lineTo(X(pos[carriers[carriers.length - 1]].x), H - 3);
    for (const cop of carriers) { g.moveTo(X(pos[cop].x), Y(0) + bh / 2); g.lineTo(X(pos[cop].x), H - 3); }
    g.stroke();
    if (fbFrom >= 0 && pos[fbFrom] && pos[fbTo]) {
      const a = pos[fbFrom], b = pos[fbTo];
      const xr = X(Math.max(a.x, b.x)) + bw / 2 + 4;
      g.beginPath();
      g.moveTo(X(a.x) + bw / 2, Y(a.row)); g.lineTo(xr, Y(a.row)); g.lineTo(xr, Y(b.row) - bh / 2 - 3);
      g.lineTo(X(b.x), Y(b.row) - bh / 2 - 3); g.lineTo(X(b.x), Y(b.row) - bh / 2);
      g.stroke();
    }
    g.font = '700 8px "Helvetica Neue", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let op = 0; op < 6; op++) {
      const p = pos[op];
      if (!p) continue;
      const lvl = phase === 'live' ? Math.min(1, meter.levels[op] * 1.4) : 0;
      g.fillStyle = carriers.includes(op) ? '#2f6f63' : '#1d3b35';
      g.fillRect(X(p.x) - bw / 2, Y(p.row) - bh / 2, bw, bh);
      g.fillStyle = `rgba(166, 255, 226, ${lvl})`;
      g.fillRect(X(p.x) - bw / 2, Y(p.row) - bh / 2, bw, bh);
      g.strokeStyle = '#9fd3c7';
      g.strokeRect(X(p.x) - bw / 2, Y(p.row) - bh / 2, bw, bh);
      g.fillStyle = '#e8fff8';
      g.fillText(String(op + 1), X(p.x), Y(p.row) + 0.5);
    }
  }

  /* ── input ─────────────────────────────────────────────────────────── */
  const encAcc = [0, 0, 0, 0];
  function handleControl(e) {
    const ei = ['E1', 'E2', 'E3', 'E4'].indexOf(e.control);
    if (ei >= 0) {
      const key = PAGES[state.page].keys[ei];
      const spec = PARAMS[key];
      if (e.type === 'rotate') {
        if (spec.int) {
          encAcc[ei] += e.delta;
          const steps = Math.trunc(encAcc[ei] / 2);
          if (steps) { encAcc[ei] -= steps * 2; setValue(key, getValue(key) + steps); }
        } else setValue(key, getValue(key) + (e.delta / 160) * (spec.max - spec.min));
      } else if (e.type === 'down') {
        const defaults = { voicing: 0, bass: 0.45, mode: 0, rate: 0.5, bpm: 100, div: 3, swing: 0, key: 4, scaleIdx: 1, octave: 4, velocity: 0.85,
          bright: 0, decay: 0, chorus: 0.35, delay: 0.15, reverb: 0.3, volume: 0.8 };
        if (key === 'alg') setValue(key, PRESETS[state.preset].alg);
        else if (key === 'fb') setValue(key, PRESETS[state.preset].fb);
        else setValue(key, defaults[key]);
      }
      return;
    }
    if (e.type !== 'down') return;
    if (e.control === 'K2') selectPreset(state.preset + 1);
    else if (e.control === 'K3') setPage(state.page + 1);
    else if (e.control === 'K4') setHold(!hold);
  }

  function wire() {
    // chord buttons: hold while pressing a key (as on the Orchid), or tap to
    // latch a selection that stays until it is tapped again
    for (const b of document.querySelectorAll('.cb')) {
      const id = b.dataset.id;
      const isType = TYPES.includes(id);
      let downAt = 0, usedWhileHeld = false;
      b.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        b.setPointerCapture(ev.pointerId);
        downAt = performance.now();
        usedWhileHeld = false;
        (isType ? heldTypes : heldExts).add(id);
        b.dataset.used = '';
        renderKeys();
      });
      const up = () => {
        (isType ? heldTypes : heldExts).delete(id);
        if (b.dataset.used !== '1' && performance.now() - downAt < 350) {
          const set = isType ? latchTypes : latchExts;
          if (set.has(id)) set.delete(id); else set.add(id);
        }
        renderKeys();
      };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    }
    for (const k of document.querySelectorAll('.k')) {
      const pc = Number(k.dataset.pc);
      k.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        k.setPointerCapture(ev.pointerId);
        // a chord button held during this press is being used, not latched
        for (const b of document.querySelectorAll('.cb.held')) b.dataset.used = '1';
        playKey(pc);
      });
      const up = () => releaseKey(pc);
      k.addEventListener('pointerup', up);
      k.addEventListener('pointercancel', up);
    }
    for (const b of document.querySelectorAll('.pre')) b.addEventListener('click', () => selectPreset(Number(b.dataset.i)));
    for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => setPage(Number(t.dataset.page)));
    for (const b of document.querySelectorAll('.mode')) b.addEventListener('click', () => setValue('mode', Number(b.dataset.m)));
    $('hold').addEventListener('click', () => setHold(!hold));
    $('keymode').addEventListener('click', () => { state.keyMode = !state.keyMode; render(); save(); });
    $('clear').addEventListener('click', () => { latchTypes.clear(); latchExts.clear(); renderKeys(); });
    // TAP: the average of the last few taps sets the BPM
    const taps = [];
    $('tap').addEventListener('pointerdown', () => {
      const now = performance.now();
      if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
      taps.push(now);
      if (taps.length > 5) taps.shift();
      if (taps.length >= 2) {
        const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
        setValue('bpm', 60000 / avg);
      } else flash('TAP AGAIN');
    });
    $('lcd').addEventListener('click', () => { if (phase !== 'live') void start(); });
    // drag a parameter cell sideways or vertically to change it
    for (let i = 0; i < 4; i++) {
      const cell = $('p' + i);
      let sx = 0, sy = 0, sv = 0;
      cell.addEventListener('pointerdown', (ev) => { cell.setPointerCapture(ev.pointerId); sx = ev.clientX; sy = ev.clientY; sv = getValue(cell.dataset.key); });
      cell.addEventListener('pointermove', (ev) => {
        if (!cell.hasPointerCapture(ev.pointerId)) return;
        const key = cell.dataset.key, spec = PARAMS[key];
        const d = (ev.clientX - sx) - (ev.clientY - sy);
        setValue(key, sv + (d / 120) * (spec.max - spec.min));
      });
    }
  }

  function build() {
    $('presets').innerHTML = PRESETS.map((p, i) => `<button class="pre ${['c', 'c', 'm', 'm', 'b', 'b'][i % 6]}" type="button" data-i="${i}"><b>${i + 1}</b><span>${p.name}</span></button>`).join('');
    const white = [0, 2, 4, 5, 7, 9, 11], black = [1, 3, 6, 8, 10];
    $('keys').innerHTML = white.map((pc, i) => `<button class="k w" type="button" data-pc="${pc}" style="left:${(i / 7 * 100).toFixed(3)}%"><span>${NOTE_NAMES[pc]}</span></button>`).join('') +
      black.map((pc) => {
        const at = { 1: 1, 3: 2, 6: 4, 8: 5, 10: 6 }[pc];
        return `<button class="k bk" type="button" data-pc="${pc}" style="left:calc(${(at / 7 * 100).toFixed(3)}% - 6.5%)"></button>`;
      }).join('');
    $('cbTypes').innerHTML = TYPES.map((t) => `<button class="cb t" type="button" data-id="${t}">${t}</button>`).join('');
    $('cbExts').innerHTML = EXTS.map((t) => `<button class="cb x" type="button" data-id="${t}">${t === 'M7' ? 'MAJ7' : t === 'm7' ? 'MIN7' : t === '6' ? '6TH' : '9TH'}</button>`).join('');
    $('modes').innerHTML = MODES.map((m, i) => `<button class="mode" type="button" data-m="${i}">${m}</button>`).join('');
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */
  async function load() {
    try {
      const r = await sdk.data.get(SAVE_KEY);
      version = r.version;
      const v = r.value;
      if (v && v.v === 1) {
        for (const k of ['preset', 'page', 'voicing', 'bass', 'mode', 'rate', 'bpm', 'div', 'swing', 'key', 'octave', 'velocity', 'chorus', 'delay', 'reverb', 'volume']) {
          if (Number.isFinite(v[k])) state[k] = v[k];
        }
        if (v.scale === 'MAJ' || v.scale === 'MIN') state.scale = v.scale;
        if (typeof v.keyMode === 'boolean') state.keyMode = v.keyMode;
        if (Array.isArray(v.edits) && v.edits.length === PRESETS.length) state.edits = v.edits;
        state.preset = clamp(state.preset | 0, 0, PRESETS.length - 1);
        state.page = clamp(state.page | 0, 0, PAGES.length - 1);
      }
    } catch (_) { /* first run */ }
  }
  function frame() {
    if (phase === 'live' && meter.voices) drawAlgorithm();
    if (lcdUntil && performance.now() > lcdUntil) { lcdUntil = 0; renderLcd(); }
    requestAnimationFrame(frame);
  }
  async function init() {
    build(); wire(); render();
    await load(); render();
    new ResizeObserver(() => drawAlgorithm()).observe($('alg'));
    requestAnimationFrame(frame);
    sdk.controls.onEvent(handleControl);
    sdk.audio.onAvailable(() => { if (phase === 'live' || phase === 'error') void stop().then(start); });
    await sdk.ready();
    void start();
  }
  addEventListener('pagehide', () => { void stop(); });
  void init();
})();
