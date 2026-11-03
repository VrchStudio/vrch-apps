(() => {
  'use strict';

  const sdk = VrchApp;
  const $ = (id) => document.getElementById(id);
  const preview = sdk.context.mode === 'preview';
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const SAVE_KEY = 'settings';

  /* ── content ───────────────────────────────────────────────────────── */
  const SOUNDS = [
    { id: 'B', zh: '动', role: '底鼓 Kick', group: 'B',
      tip: '双唇轻闭，像说“不”但不出声：嘴里憋一点气，嘴唇猛地弹开，发出短促低沉的“噗”。' },
    { id: 'Pf', zh: '次', role: '军鼓 Snare', group: 'S',
      tip: '先发 P：双唇闭紧弹开，紧接着上齿抵下唇吐气“夫”，连成一个有爆破感的“噗夫”。' },
    { id: 'K', zh: '咔', role: 'K 军鼓 Rim', group: 'S',
      tip: '舌根顶住上颚后部，不出声地说“k”，用气猛地冲开，声音清脆短促，像舌头打响指。' },
    { id: 't', zh: '嚓', role: '闭镲 Hi-hat', group: 'H',
      tip: '舌尖抵住上齿后面，轻轻说“t”但不出声，只留下清脆的气声，越短越好。' },
    { id: 'ts', zh: '嚓—', role: '开镲 Open hat', group: 'H',
      tip: '说“t”后马上接一个拉长的“s”：“ts——”，牙齿合拢让气流嘶嘶作响，约半拍长。' }
  ];
  // Must match DEFAULT_PROTOS in dsp.js: share of energy in 5 bands
  const DEFAULT_PROTOS = [
    [0.50, 0.25, 0.12, 0.08, 0.05],
    [0.14, 0.20, 0.28, 0.22, 0.16],
    [0.06, 0.14, 0.36, 0.30, 0.14],
    [0.03, 0.06, 0.14, 0.32, 0.45],
    [0.03, 0.06, 0.13, 0.30, 0.48]
  ];
  const BAND_NAMES = ['低', '中低', '中', '中高', '高'];
  const KITS = ['经典', '808', '低保真', '人声'];
  const MODES = [
    { id: 'transform', name: '变身' },
    { id: 'lab', name: '单音' },
    { id: 'rhythm', name: '节奏' }
  ];
  const PATTERNS = [
    { name: '动次打次', en: 'Boots & Cats', bpm: 80, steps: 'B . t . Pf . t . B . t . Pf . t .',
      tip: '最经典的入门节奏：动 嚓 次 嚓。先慢慢来，每个声音都清楚了再加速。' },
    { name: '嘻哈基础', en: 'Hip-hop', bpm: 85, steps: 'B . t . Pf . t B B . t . Pf . t .',
      tip: '第二拍前多了一个连续的“动动”，注意第二个底鼓要落在拍子上。' },
    { name: '十六分镲', en: 'Hat Groove', bpm: 75, steps: 'B t t t Pf t t t B t t B Pf t t t',
      tip: '镲片要非常轻、非常短，舌尖只碰一下。底鼓和军鼓保持响亮。' },
    { name: 'K 军鼓律动', en: 'K-Snare Funk', bpm: 90, steps: 'B . t K . t B . B . t K . t . t',
      tip: 'K 军鼓落在反拍上，带来放克的弹跳感。K 要用舌根发，不要用嗓子。' },
    { name: '开镲节奏', en: 'Open Hats', bpm: 100, steps: 'B . ts . Pf . ts . B . ts . Pf . ts .',
      tip: '“ts——”要在下一个声音之前收住，长度大约半拍。' }
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
      e.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
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
        if (engine === e && e.ctx.state !== 'running') fail('声音已暂停，点“开始”继续。');
      };
      renderGate();
      render();
    } catch (error) {
      await release(e);
      if (token !== epoch) return;
      const code = error.code || error.name;
      fail(code === 'permission_required' ? '请在 Device Access 中允许音频输入，然后点重试。'
        : code === 'audio_device_unavailable' ? '请在 K1 菜单里选择可用的输入和输出，然后点重试。'
          : code === 'interaction_required' ? '点“开始”启用声音。'
            : '声音无法启动，点重试。');
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
    $('gate-btn').textContent = '重试';
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
    if (mode() === 'lab') { lab.waiting = true; setStatus(`听完示范后，模仿“${SOUNDS[sound].id}”`); }
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
    setStatus(score >= 75 ? '很像了！再来几次让它更稳定。'
      : score >= 45 ? `接近了。听起来有点像“${like.id}”，按 K4 对比一下。`
        : `听起来更像“${like.id} ${like.zh}”，再听一遍示范。`);
    render();
  }

  function playAB() {
    if (!engine || !lab.take) { setStatus('先模仿一次，再按 K4 对比。'); return; }
    const copy = lab.take.audio.slice();
    send({ type: 'ab', audio: copy, sound: state.sound }, [copy.buffer]);
    setStatus('先播放你的声音，再播放示范。');
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
        if (idx % 4 === 0) setStatus(`预备… ${4 - idx / 4}`);
      } else {
        if (rhythm.status !== 'play') { rhythm.status = 'play'; render(); }
        rhythm.step = (idx - 16) % 16;
        setStatus(`跟着拍子来！第 ${idx < 32 ? 1 : 2} / 2 小节`);
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
    if (miss) tips.push(`漏了 ${miss} 个`);
    if (wrong) tips.push(`${wrong} 个声音不对`);
    if (extra) tips.push(`多了 ${extra} 个`);
    if (rhythm.offset !== null && Math.abs(rhythm.offset) > 25) tips.push(`整体偏${rhythm.offset < 0 ? '快' : '慢'} ${Math.abs(rhythm.offset)} 毫秒`);
    setStatus(tips.length ? tips.join('，') + '。按 K4 再来一次。' : '完美！试试把速度调快一点（E2）。');
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
    if (m === 'transform') return preview ? '预览里没有麦克风：点鼓垫试听。' : '对着麦克风说“动 次 嚓”，变成鼓声。建议戴耳机。';
    if (m === 'lab') return '按 K3 听示范，然后对着麦克风模仿。';
    return '按 K3 听示范，按 K4 开始练习（先数 4 拍）。';
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

    $('kit-name').textContent = '鼓组 · ' + KITS[state.kit];
    $('tf-sub').textContent = `原声 ${Math.round(state.mix * 100)}%  灵敏度 ${Math.round(state.sens * 100)}%  音量 ${Math.round(state.vol * 100)}%`;
    $('metro-btn').classList.toggle('on', metro);
    $('metro-btn').textContent = metro ? `■ 节拍器 ${state.bpm}` : `♩ 节拍器 ${state.bpm}`;
    $('v-transform').classList.toggle('muted', muted);

    const s = SOUNDS[state.sound];
    document.querySelectorAll('#chips button').forEach((b, i) => b.classList.toggle('on', i === state.sound));
    $('lab-title').innerHTML = `<b>${s.id}</b> ${s.zh} <small>${s.role}</small>`;
    $('lab-tip').textContent = s.tip;
    $('match').textContent = lab.score === null ? '--' : lab.score + '%';
    $('match').className = lab.score === null ? '' : lab.score >= 75 ? 'good' : lab.score >= 45 ? 'ok' : 'bad';
    $('match-sub').textContent = lab.take ? `像“${SOUNDS[lab.take.cls].id}” · ${Math.round(lab.take.dur * 1000)} ms` : '相似度';
    const target = DEFAULT_PROTOS[state.sound];
    for (let i = 0; i < 5; i++) {
      $('bt' + i).style.height = Math.round(target[i] * 160) + '%';
      $('bu' + i).style.height = lab.take ? Math.round(lab.take.fp[i] * 160) + '%' : '0%';
    }

    const pat = PATTERNS[state.pattern];
    $('pat-name').innerHTML = `${pat.name} <small>${pat.en}</small>`;
    const best = state.best[state.pattern];
    $('pat-sub').textContent = `${state.bpm} BPM${best ? ` · 最佳 ${best}` : ''}`;
    for (let i = 0; i < 16; i++) {
      const cell = $('c' + i);
      const code = pat.codes[i];
      cell.querySelector('b').textContent = code >= 0 ? SOUNDS[code].id : '·';
      cell.classList.toggle('rest', code < 0);
      cell.classList.toggle('beat', i % 4 === 0);
      const dots = cell.querySelectorAll('i');
      for (let bar = 0; bar < 2; bar++) dots[bar].className = rhythm.results ? (rhythm.results[i][bar] || '') : '';
    }
    $('rh-score').textContent = rhythm.score === null ? '' : rhythm.score + '分';
    $('rh-tip').textContent = pat.tip;
    $('rdemo-btn').textContent = rhythm.status === 'demo' ? '■ 停止示范' : '▶ 示范';
    $('rdemo-btn').classList.toggle('on', rhythm.status === 'demo');
    const practicing = rhythm.status === 'count' || rhythm.status === 'play';
    $('practice-btn').textContent = practicing ? '■ 停止' : '● 练习';
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
    if (phase === 'starting') { $('gate-msg').textContent = '正在启动声音…'; $('gate-btn').disabled = true; }
    else $('gate-btn').disabled = false;
    if (phase === 'idle') { $('gate-msg').textContent = preview ? '预览里没有麦克风，可以试听示范和鼓声。' : '点“开始”启用麦克风和声音。'; $('gate-btn').textContent = '开始'; }
  }

  function renderMonitor() {
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      const m = mode();
      const v = {
        E3: { label: '灵敏度', value: Math.round(state.sens * 100) + '%' },
        E4: { label: '音量', value: Math.round(state.vol * 100) + '%' },
        K2: { label: '模式', value: MODES[state.mode].name }
      };
      if (m === 'transform') {
        v.E1 = { label: '鼓组', value: KITS[state.kit] };
        v.E2 = { label: '原声', value: Math.round(state.mix * 100) + '%' };
        v.K3 = { label: '节拍器', pressed: metro };
        v.K4 = { label: muted ? '已静音' : '静音', pressed: muted };
      } else if (m === 'lab') {
        v.E1 = { label: '声音', value: SOUNDS[state.sound].id };
        v.E2 = { label: '', value: '' };
        v.K3 = { label: '听示范' };
        v.K4 = { label: '对比' };
      } else {
        v.E1 = { label: '节奏', value: PATTERNS[state.pattern].name };
        v.E2 = { label: '速度', value: String(state.bpm) };
        v.K3 = { label: '示范', pressed: rhythm.status === 'demo' };
        v.K4 = { label: '练习', pressed: rhythm.status === 'count' || rhythm.status === 'play' };
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
