(() => {
  'use strict';

  const sdk = VrchApp;
  const $ = (id) => document.getElementById(id);
  const preview = sdk.context.mode === 'preview';
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const SAVE_KEY = 'settings';

  /* ── content ───────────────────────────────────────────────────────── */
  const SOUNDS = [
    { id: 'B', zh: 'boom', role: 'Kick', group: 'B',
      tip: 'Close your lips, build a little pressure, then pop them open for a short, low B sound. Do not voice it.' },
    { id: 'Pf', zh: 'pff', role: 'Snare', group: 'S',
      tip: 'Pop a P with closed lips, then blow an F with your upper teeth against your lower lip: Pf.' },
    { id: 'K', zh: 'ka', role: 'Rim', group: 'S',
      tip: 'Press the back of your tongue against your palate, then release a short, crisp unvoiced K.' },
    { id: 't', zh: 'tss', role: 'Closed hat', group: 'H',
      tip: 'Place your tongue behind your upper teeth and release a very short, unvoiced T.' },
    { id: 'ts', zh: 'tsss', role: 'Open hat', group: 'H',
      tip: 'Follow T with a sustained S through closed teeth: ts. Keep it about half a beat long.' }
  ];
  // Must match DEFAULT_PROTOS in dsp.js: share of energy in 5 bands
  const DEFAULT_PROTOS = [
    [0.50, 0.25, 0.12, 0.08, 0.05],
    [0.14, 0.20, 0.28, 0.22, 0.16],
    [0.06, 0.14, 0.36, 0.30, 0.14],
    [0.03, 0.06, 0.14, 0.32, 0.45],
    [0.03, 0.06, 0.13, 0.30, 0.48]
  ];
  const BAND_NAMES = ['Low', 'Low-mid', 'Mid', 'High-mid', 'High'];
  const KITS = ['Classic', '808', 'Lo-fi', 'Vocal'];
  const MODES = [
    { id: 'transform', name: 'Transform' },
    { id: 'lab', name: 'Sound Lab' },
    { id: 'rhythm', name: 'Rhythm' }
  ];
  const PATTERNS = [
    { name: 'Boots & Cats', en: 'Boots & Cats', bpm: 80, steps: 'B . t . Pf . t . B . t . Pf . t .',
      tip: 'Start with B, t, Pf, t. Practice slowly and make each sound clear before speeding up.' },
    { name: 'Hip-hop', en: 'Hip-hop', bpm: 85, steps: 'B . t . Pf . t B B . t . Pf . t .',
      tip: 'Play the extra pair of kicks before beat two. Keep the second kick on the beat.' },
    { name: 'Hat Groove', en: 'Hat Groove', bpm: 75, steps: 'B t t t Pf t t t B t t B Pf t t t',
      tip: 'Keep hats light and short. Let the kick and snare stay loud.' },
    { name: 'K-Snare Funk', en: 'K-Snare Funk', bpm: 90, steps: 'B . t K . t B . B . t K . t . t',
      tip: 'Offbeat K snares add bounce. Use the back of your tongue, not your voice.' },
    { name: 'Open Hats', en: 'Open Hats', bpm: 100, steps: 'B . ts . Pf . ts . B . ts . Pf . ts .',
      tip: 'End each open hat before the next sound, after about half a beat.' }
  ].map((p) => ({ ...p, codes: p.steps.split(' ').map((s) => SOUNDS.findIndex((x) => x.id === s)) }));

  const DEFAULTS = { mode: 0, kit: 0, mix: 0, sens: 0.6, vol: 0.8, sound: 0, pattern: 0 };
  const state = { ...DEFAULTS, bpm: PATTERNS[0].bpm, protos: {}, best: {} };

  /* ── runtime ───────────────────────────────────────────────────────── */
  let phase = 'idle';
  let engine = null;
  let epoch = 0;
  let version;
  let saveTimer = 0;
  let monitorTimer = 0;
  let muted = false;
  let metro = false;
  let k2Down = false;
  const meter = { inp: 0, out: 0, thr: 0 };
  const lab = { take: null, score: null, waiting: true };
  const rhythm = { status: 'idle', step: -1, results: null, score: null, offset: null };

  const mode = () => MODES[state.mode].id;
  const send = (msg, transfer) => { if (engine) engine.node.port.postMessage(msg, transfer || []); };

  function protosFor() {
    return DEFAULT_PROTOS.map((d, i) => (Array.isArray(state.protos[i]) && state.protos[i].length === 5 ? state.protos[i] : d));
  }

  function pushParams() {
    if (!engine) return;
    const ctx = engine.ctx;
    const comp = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + 0.012;
    send({
      type: 'params',
      p: { mode: mode(), kit: state.kit, mix: state.mix, sens: state.sens, vol: state.vol, comp, muted },
      protos: protosFor()
    });
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const value = {
          mode: state.mode, kit: state.kit, mix: state.mix, sens: state.sens, vol: state.vol,
          sound: state.sound, pattern: state.pattern, bpm: state.bpm, protos: state.protos, best: state.best
        };
        const result = await sdk.data.set(SAVE_KEY, value, { expectedVersion: version });
        version = result.version;
      } catch (_) { /* best effort; audio never waits for storage */ }
    }, 700);
  }

  async function load() {
    try {
      const result = await sdk.data.get(SAVE_KEY);
      version = result.version;
      const v = result.value;
      if (!v) return;
      const int = (x, n, d) => (Number.isInteger(x) ? clamp(x, 0, n - 1) : d);
      const num = (x, d) => (Number.isFinite(x) ? clamp(x) : d);
      state.mode = int(v.mode, MODES.length, 0);
      state.kit = int(v.kit, KITS.length, 0);
      state.sound = int(v.sound, SOUNDS.length, 0);
      state.pattern = int(v.pattern, PATTERNS.length, 0);
      state.mix = num(v.mix, DEFAULTS.mix);
      state.sens = num(v.sens, DEFAULTS.sens);
      state.vol = num(v.vol, DEFAULTS.vol);
      state.bpm = Number.isFinite(v.bpm) ? clamp(Math.round(v.bpm), 50, 140) : PATTERNS[state.pattern].bpm;
      if (v.protos && typeof v.protos === 'object') state.protos = v.protos;
      if (v.best && typeof v.best === 'object') state.best = v.best;
    } catch (_) { /* first run */ }
  }

  /* ── audio engine ──────────────────────────────────────────────────── */
  async function start() {
    if (phase === 'starting' || phase === 'live') return;
    const token = ++epoch;
    const e = {};
    phase = 'starting';
    renderGate();
    try {
      e.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive', sinkId: { type: 'none' } });
      if (!e.ctx.audioWorklet) throw Object.assign(new Error('no worklet'), { code: 'unsupported_environment' });
      await e.ctx.resume();
      if (e.ctx.state !== 'running') throw Object.assign(new Error('gesture'), { code: 'interaction_required' });
      await e.ctx.audioWorklet.addModule(new URL('dsp.js', location.href).href);
      e.node = new AudioWorkletNode(e.ctx, 'beatbox-coach', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2]
      });
      e.out = await sdk.audio.openOutput({ channels: 2 });
      e.outNode = await e.out.createNode(e.ctx);
      e.node.connect(e.outNode);
      if (!preview) {
        // Echo cancellation keeps our own drums and clicks on the speaker from re-triggering detection
        const attempts = [{ channels: 1, echoCancellation: true }, { channels: 1, echoCancellation: false }, { channels: 2, echoCancellation: false }];
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
      e.node.port.onmessage = ({ data }) => { if (engine === e && data) onEngine(data); };
      if (token !== epoch) { await release(e); return; }
      engine = e;
      phase = 'live';
      pushParams();
      if (metro && mode() === 'transform') send({ type: 'seq', kind: 'metro', bpm: state.bpm, steps: [] });
      e.ctx.onstatechange = () => {
        if (engine === e && e.ctx.state !== 'running') fail('Audio paused. Tap Start to resume.');
      };
      renderGate();
      render();
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
    rhythm.status = rhythm.status === 'result' ? 'result' : 'idle';
    renderGate();
    render();
  }

  function onEngine(d) {
    if (d.type === 'meter') { meter.inp = Math.max(meter.inp, d.inp); meter.out = d.out; meter.thr = d.thr; return; }
    if (d.type === 'hit') { flash(d.cls); return; }
    if (d.type === 'take') { onTake(d); return; }
    if (d.type === 'step') { onStep(d.idx); return; }
    if (d.type === 'practice') { onPractice(d.hits); }
  }

  /* ── transform ─────────────────────────────────────────────────────── */
  const padTimers = new Map();
  function flash(cls) {
    const pad = document.querySelector(`.pad[data-sound="${cls}"]`);
    if (!pad) return;
    pad.classList.add('hit');
    clearTimeout(padTimers.get(cls));
    padTimers.set(cls, setTimeout(() => pad.classList.remove('hit'), 140));
  }

  function setMetro(on) {
    metro = on;
    send(on ? { type: 'seq', kind: 'metro', bpm: state.bpm, steps: [] } : { type: 'stop' });
    render();
  }

  /* ── sound lab ─────────────────────────────────────────────────────── */
  function dist(a, b) {
    let d = 0;
    for (let i = 0; i < 5; i++) d += (a[i] - b[i]) ** 2;
    return Math.sqrt(d);
  }

  function playDemo(sound, muteMic) {
    if (!engine) return;
    send({ type: 'trigger', sound, demo: true, mute: !!muteMic });
    if (mode() === 'lab') { lab.waiting = true; setStatus(`Listen, then imitate ${SOUNDS[sound].id}`); }
  }

  function onTake(d) {
    const target = state.sound;
    const sound = SOUNDS[target];
    let score = clamp(1 - dist(d.fp, DEFAULT_PROTOS[target]) / 0.45) * 100;
    if (sound.group === 'H') {
      const wantLong = sound.id === 'ts';
      if (wantLong !== d.dur > 0.09) score *= 0.6;
    }
    if (SOUNDS[d.cls].group !== sound.group) score = Math.min(score, 45);
    score = Math.round(score);
    lab.take = d;
    lab.score = score;
    lab.waiting = false;
    // learn this player's version of the sound so live recognition fits their mouth
    if (d.cls === target || score >= 45) {
      const old = state.protos[target];
      state.protos[target] = Array.isArray(old) ? old.map((v, i) => v * 0.6 + d.fp[i] * 0.4) : d.fp.slice();
      pushParams();
      save();
    }
    const like = SOUNDS[d.cls];
    setStatus(score >= 75 ? 'Great match! Repeat it for consistency.'
      : score >= 45 ? `Close! It sounds like ${like.id}. Press K4 to compare.`
        : `It sounds more like ${like.id}. Listen to the demo again.`);
    render();
  }

  function playAB() {
    if (!engine || !lab.take) { setStatus('Imitate a sound first, then press K4 to compare.'); return; }
    const copy = lab.take.audio.slice();
    send({ type: 'ab', audio: copy, sound: state.sound }, [copy.buffer]);
    setStatus('Your recording plays first, then the demo.');
  }

  /* ── rhythm ────────────────────────────────────────────────────────── */
  function stopRhythm() {
    send({ type: 'stop' });
    if (rhythm.status === 'demo' || rhythm.status === 'count' || rhythm.status === 'play') rhythm.status = 'idle';
    rhythm.step = -1;
  }

  function toggleRhythmDemo() {
    if (!engine) return;
    if (rhythm.status === 'demo') { stopRhythm(); render(); return; }
    stopRhythm();
    rhythm.status = 'demo';
    send({ type: 'seq', kind: 'demo', bpm: state.bpm, steps: PATTERNS[state.pattern].codes });
    render();
  }

  function togglePractice() {
    if (!engine) return;
    if (rhythm.status === 'count' || rhythm.status === 'play') { stopRhythm(); render(); return; }
    stopRhythm();
    rhythm.status = 'count';
    rhythm.results = null;
    rhythm.score = null;
    send({ type: 'seq', kind: 'practice', bpm: state.bpm, steps: [] });
    render();
  }

  function onStep(idx) {
    if (rhythm.status === 'demo') { rhythm.step = idx; renderPlayhead(); return; }
    if (rhythm.status === 'count' || rhythm.status === 'play') {
      if (idx < 16) {
        rhythm.status = 'count';
        rhythm.step = -1;
        if (idx % 4 === 0) setStatus(`Get ready... ${4 - idx / 4}`);
      } else {
        if (rhythm.status !== 'play') { rhythm.status = 'play'; render(); }
        rhythm.step = (idx - 16) % 16;
        setStatus(`Follow the beat! Bar ${idx < 32 ? 1 : 2} / 2`);
      }
      renderPlayhead();
    }
  }

  function onPractice(hits) {
    const pat = PATTERNS[state.pattern];
    const stepMs = 60000 / state.bpm / 4;
    const used = new Set();
    const results = Array.from({ length: 16 }, () => [null, null]);
    let total = 0, points = 0, offSum = 0, offN = 0;
    for (let bar = 0; bar < 2; bar++) {
      for (let s = 0; s < 16; s++) {
        const code = pat.codes[s];
        if (code < 0) continue;
        total++;
        const at = bar * 16 + s;
        let best = -1, bd = 0.45;
        hits.forEach((h, i) => {
          const d = Math.abs(h.pos - at);
          if (!used.has(i) && d < bd) { bd = d; best = i; }
        });
        if (best < 0) { results[s][bar] = 'miss'; continue; }
        used.add(best);
        const ms = (hits[best].pos - at) * stepMs;
        offSum += ms; offN++;
        const right = SOUNDS[hits[best].cls].group === SOUNDS[code].group;
        const r = !right ? 'wrong' : Math.abs(ms) <= 45 ? 'good' : 'ok';
        results[s][bar] = r;
        points += r === 'good' ? 1 : r === 'ok' ? 0.7 : 0.35;
      }
    }
    const extra = hits.filter((h, i) => !used.has(i) && h.pos > -0.5 && h.pos < 31.5).length;
    const score = Math.round(clamp((points - extra * 0.5) / Math.max(1, total)) * 100);
    rhythm.results = results;
    rhythm.score = score;
    rhythm.offset = offN ? Math.round(offSum / offN) : null;
    rhythm.extra = extra;
    rhythm.status = 'result';
    rhythm.step = -1;
    const best = state.best[state.pattern] || 0;
    if (score > best) { state.best[state.pattern] = score; save(); }
    const wrong = results.flat().filter((r) => r === 'wrong').length;
    const miss = results.flat().filter((r) => r === 'miss').length;
    const tips = [];
    if (miss) tips.push(`${miss} missed`);
    if (wrong) tips.push(`${wrong} wrong sounds`);
    if (extra) tips.push(`${extra} extra`);
    if (rhythm.offset !== null && Math.abs(rhythm.offset) > 25) tips.push(`Overall ${rhythm.offset < 0 ? 'early' : 'late'} by ${Math.abs(rhythm.offset)} ms`);
    setStatus(tips.length ? tips.join(', ') + '. Press K4 to retry.' : 'Perfect! Try a faster tempo with E2.');
    render();
  }

  /* ── controls ──────────────────────────────────────────────────────── */
  function setMode(i) {
    if (i === state.mode) return;
    if (metro) { metro = false; }
    send({ type: 'stop' });
    rhythm.status = rhythm.status === 'result' ? 'result' : 'idle';
    rhythm.step = -1;
    state.mode = i;
    lab.waiting = true;
    pushParams();
    save();
    setStatus(defaultStatus());
    render();
  }

  function selectPattern(i) {
    stopRhythm();
    state.pattern = (i + PATTERNS.length) % PATTERNS.length;
    state.bpm = PATTERNS[state.pattern].bpm;
    rhythm.results = null; rhythm.score = null; rhythm.status = 'idle';
    setStatus(defaultStatus());
    save();
    render();
  }

  function setBpm(v) {
    state.bpm = clamp(Math.round(v), 50, 140);
    if (rhythm.status === 'demo') send({ type: 'seq', kind: 'demo', bpm: state.bpm, steps: PATTERNS[state.pattern].codes });
    if (metro) send({ type: 'seq', kind: 'metro', bpm: state.bpm, steps: [] });
    save();
    render();
  }

  function handleControl(e) {
    const m = mode();
    if (e.type === 'rotate') {
      const dir = Math.sign(e.delta);
      if (e.control === 'E1') {
        if (m === 'transform') { state.kit = (state.kit + dir + KITS.length) % KITS.length; pushParams(); }
        else if (m === 'lab') { state.sound = (state.sound + dir + SOUNDS.length) % SOUNDS.length; lab.take = null; lab.score = null; setStatus(defaultStatus()); }
        else selectPattern(state.pattern + dir);
      } else if (e.control === 'E2') {
        if (m === 'transform') { state.mix = clamp(state.mix + e.delta * 0.02); pushParams(); }
        else if (m === 'rhythm') setBpm(state.bpm + e.delta);
      } else if (e.control === 'E3') { state.sens = clamp(state.sens + e.delta * 0.02); pushParams(); }
      else if (e.control === 'E4') { state.vol = clamp(state.vol + e.delta * 0.02); pushParams(); }
      save();
      render();
      return;
    }
    if (e.type === 'down') {
      if (e.control === 'E2') {
        if (m === 'transform') { state.mix = DEFAULTS.mix; pushParams(); }
        else if (m === 'rhythm') setBpm(PATTERNS[state.pattern].bpm);
      } else if (e.control === 'E3') { state.sens = DEFAULTS.sens; pushParams(); }
      else if (e.control === 'E4') { state.vol = DEFAULTS.vol; pushParams(); }
      else if (e.control === 'K2') k2Down = true;
      else if (e.control === 'K3') {
        if (!engine) { void start(); return; }
        if (m === 'transform') setMetro(!metro);
        else if (m === 'lab') playDemo(state.sound, true);
        else toggleRhythmDemo();
      } else if (e.control === 'K4') {
        if (!engine) { void start(); return; }
        if (m === 'transform') { muted = true; pushParams(); }
        else if (m === 'lab') playAB();
        else togglePractice();
      }
      save();
      render();
      return;
    }
    if (e.type === 'up' || e.type === 'cancel') {
      if (e.control === 'K2') {
        if (k2Down && e.type === 'up') setMode((state.mode + 1) % MODES.length);
        k2Down = false;
      }
      if (e.control === 'K4' && muted) { muted = false; pushParams(); render(); }
    }
  }

  function wireTouch() {
    $('tabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-mode]');
      if (b) setMode(Number(b.dataset.mode));
    });
    $('pads').addEventListener('pointerdown', (ev) => {
      const p = ev.target.closest('.pad');
      if (!p || !engine) return;
      const cls = Number(p.dataset.sound);
      send({ type: 'trigger', sound: cls, demo: false });
      flash(cls);
    });
    $('chips').addEventListener('click', (ev) => {
      const c = ev.target.closest('[data-sound]');
      if (!c) return;
      state.sound = Number(c.dataset.sound);
      lab.take = null; lab.score = null;
      setStatus(defaultStatus());
      save();
      render();
    });
    document.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      if (!engine) { void start(); return; }
      const act = b.dataset.act;
      if (act === 'metro') setMetro(!metro);
      if (act === 'demo') playDemo(state.sound, true);
      if (act === 'ab') playAB();
      if (act === 'rdemo') toggleRhythmDemo();
      if (act === 'practice') togglePractice();
      render();
    });
    $('gate-btn').addEventListener('click', () => { void start(); });
  }

  /* ── view ──────────────────────────────────────────────────────────── */
  function defaultStatus() {
    const m = mode();
    if (m === 'transform') return preview ? 'No microphone in preview. Tap a pad to listen.' : 'Say B, Pf, t into the mic to play drums. Use headphones.';
    if (m === 'lab') return 'K3 Demo · Listen, then imitate into the mic.';
    return 'K3 Demo · K4 Practice with a four-beat count-in.';
  }

  function setStatus(text) { $('status').textContent = text; }

  function build() {
    $('tabs').innerHTML = MODES.map((m, i) => `<button data-mode="${i}">${m.name}</button>`).join('');
    $('pads').innerHTML = SOUNDS.slice(0, 4).map((s, i) =>
      `<div class="pad" data-sound="${i}"><b>${s.id}</b><span>${s.zh}</span><small>${s.role}</small></div>`).join('');
    $('chips').innerHTML = SOUNDS.map((s, i) => `<button data-sound="${i}"><b>${s.id}</b> ${s.zh}</button>`).join('');
    $('bars').innerHTML = BAND_NAMES.map((n, i) =>
      `<div class="band"><div class="cols"><i class="t" id="bt${i}"></i><i class="u" id="bu${i}"></i></div><span>${n}</span></div>`).join('');
    $('grid').innerHTML = Array.from({ length: 16 }, (_, i) =>
      `<div class="cell" id="c${i}"><b></b><span><i></i><i></i></span></div>`).join('');
  }

  function render() {
    const m = mode();
    document.querySelectorAll('#tabs button').forEach((b, i) => b.classList.toggle('on', i === state.mode));
    for (const md of MODES) $('v-' + md.id).hidden = md.id !== m;

    $('kit-name').textContent = 'Kit · ' + KITS[state.kit];
    $('tf-sub').textContent = `Dry ${Math.round(state.mix * 100)}%  Sens ${Math.round(state.sens * 100)}%  Vol ${Math.round(state.vol * 100)}%`;
    $('metro-btn').classList.toggle('on', metro);
    $('metro-btn').textContent = metro ? `■ Click ${state.bpm}` : `♩ Click ${state.bpm}`;
    $('v-transform').classList.toggle('muted', muted);

    const s = SOUNDS[state.sound];
    document.querySelectorAll('#chips button').forEach((b, i) => b.classList.toggle('on', i === state.sound));
    $('lab-title').innerHTML = `<b>${s.id}</b> ${s.zh} <small>${s.role}</small>`;
    $('lab-tip').textContent = s.tip;
    $('match').textContent = lab.score === null ? '--' : lab.score + '%';
    $('match').className = lab.score === null ? '' : lab.score >= 75 ? 'good' : lab.score >= 45 ? 'ok' : 'bad';
    $('match-sub').textContent = lab.take ? `Like ${SOUNDS[lab.take.cls].id} · ${Math.round(lab.take.dur * 1000)} ms` : 'Match';
    const target = DEFAULT_PROTOS[state.sound];
    for (let i = 0; i < 5; i++) {
      $('bt' + i).style.height = Math.round(target[i] * 160) + '%';
      $('bu' + i).style.height = lab.take ? Math.round(lab.take.fp[i] * 160) + '%' : '0%';
    }

    const pat = PATTERNS[state.pattern];
    $('pat-name').innerHTML = pat.name;
    const best = state.best[state.pattern];
    $('pat-sub').textContent = `${state.bpm} BPM${best ? ` · Best ${best}` : ''}`;
    for (let i = 0; i < 16; i++) {
      const cell = $('c' + i);
      const code = pat.codes[i];
      cell.querySelector('b').textContent = code >= 0 ? SOUNDS[code].id : '·';
      cell.classList.toggle('rest', code < 0);
      cell.classList.toggle('beat', i % 4 === 0);
      const dots = cell.querySelectorAll('i');
      for (let bar = 0; bar < 2; bar++) dots[bar].className = rhythm.results ? (rhythm.results[i][bar] || '') : '';
    }
    $('rh-score').textContent = rhythm.score === null ? '' : rhythm.score + ' pts';
    $('rh-tip').textContent = pat.tip;
    $('rdemo-btn').textContent = rhythm.status === 'demo' ? '■ Stop demo' : '▶ Demo';
    $('rdemo-btn').classList.toggle('on', rhythm.status === 'demo');
    const practicing = rhythm.status === 'count' || rhythm.status === 'play';
    $('practice-btn').textContent = practicing ? '■ Stop' : '● Practice';
    $('practice-btn').classList.toggle('on', practicing);
    renderPlayhead();
    renderMonitor();
  }

  function renderPlayhead() {
    for (let i = 0; i < 16; i++) $('c' + i).classList.toggle('now', i === rhythm.step);
  }

  function renderGate() {
    const show = phase !== 'live';
    $('gate').hidden = !show;
    if (phase === 'starting') { $('gate-msg').textContent = 'Starting audio...'; $('gate-btn').disabled = true; }
    else $('gate-btn').disabled = false;
    if (phase === 'idle') { $('gate-msg').textContent = preview ? 'No microphone in preview. Listen to demos and drum sounds.' : 'Tap Start to enable the microphone and audio.'; $('gate-btn').textContent = 'Start'; }
  }

  function renderMonitor() {
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      const m = mode();
      const v = {
        E3: { label: 'Sensitivity', value: Math.round(state.sens * 100) + '%' },
        E4: { label: 'Volume', value: Math.round(state.vol * 100) + '%' },
        K2: { label: 'Mode', value: MODES[state.mode].name }
      };
      if (m === 'transform') {
        v.E1 = { label: 'Kit', value: KITS[state.kit] };
        v.E2 = { label: 'Original', value: Math.round(state.mix * 100) + '%' };
        v.K3 = { label: 'Click', pressed: metro };
        v.K4 = { label: muted ? 'Muted' : 'Mute', pressed: muted };
      } else if (m === 'lab') {
        v.E1 = { label: 'Sound', value: SOUNDS[state.sound].id };
        v.E2 = { label: '', value: '' };
        v.K3 = { label: 'Demo' };
        v.K4 = { label: 'Compare' };
      } else {
        v.E1 = { label: 'Rhythm', value: PATTERNS[state.pattern].name };
        v.E2 = { label: 'Speed', value: String(state.bpm) };
        v.K3 = { label: 'Demo', pressed: rhythm.status === 'demo' };
        v.K4 = { label: 'Practice', pressed: rhythm.status === 'count' || rhythm.status === 'play' };
      }
      void sdk.monitor.set(v).catch(() => {});
    }, 40);
  }

  function drawMeter() {
    meter.inp *= 0.9;
    $('lvl-in').style.width = Math.round(clamp(Math.sqrt(meter.inp) * 1.4) * 100) + '%';
    $('lvl-thr').style.left = Math.round(clamp(Math.sqrt(meter.thr) * 1.4) * 100) + '%';
    requestAnimationFrame(drawMeter);
  }

  async function init() {
    build();
    wireTouch();
    sdk.controls.onEvent(handleControl);
    await load();
    setStatus(defaultStatus());
    render();
    renderGate();
    requestAnimationFrame(drawMeter);
    sdk.audio.onAvailable(() => {
      if (!preview && (phase === 'live' || phase === 'error')) void stop().then(start);
    });
    await sdk.ready();
    if (!preview) void start();
  }

  addEventListener('pagehide', () => { void stop(); });
  void init();
})();
