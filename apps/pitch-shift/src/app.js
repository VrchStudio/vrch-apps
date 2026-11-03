(() => {
  'use strict';

  const sdk = VrchApp;
  const $ = (id) => document.getElementById(id);
  const preview = sdk.context.mode === 'preview';
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const SAVE_KEY = 'settings';

  const RANGE = 12;                    // ±12 semitones (one octave each way)
  const PRESETS = [
    { st: 0, name: '原声' },
    { st: 12, name: '+12' },
    { st: 7, name: '+7' },
    { st: -12, name: '−12' },
    { st: -5, name: '−5' }
  ];
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const INTERVAL = {
    0: '原声', 1: '小二度', 2: '大二度', 3: '小三度', 4: '大三度', 5: '四度', 6: '三全音',
    7: '五度', 8: '小六度', 9: '大六度', 10: '小七度', 11: '大七度', 12: '八度'
  };
  const DEFAULTS = { st: 0, fine: 0, mix: 1, vol: 0.75, bypass: false };
  const state = { ...DEFAULTS };

  let phase = 'idle';
  let engine = null;
  let epoch = 0;
  let version;
  let saveTimer = 0;
  let monitorTimer = 0;
  let compare = false;                 // K4 held
  let dragging = false;
  let keyInfo = null;
  const meter = { inp: 0 };

  const signed = (v) => (v > 0 ? '+' + v : v === 0 ? '0' : '−' + Math.abs(v));
  const signedCents = (v) => (v > 0 ? '+' + v + '¢' : v === 0 ? '0¢' : '−' + Math.abs(v) + '¢');

  function intervalName(st) {
    if (st === 0) return '原声';
    const a = Math.abs(st);
    const dir = st > 0 ? '高' : '低';
    const oct = Math.floor(a / 12);
    const rest = a % 12;
    if (oct === 0) return dir + INTERVAL[rest];
    const head = oct === 1 ? '八度' : oct === 2 ? '两个八度' : `${oct} 个八度`;
    return rest === 0 ? dir + head : `${dir}${head}+${INTERVAL[rest]}`;
  }

  /* ── audio engine ──────────────────────────────────────────────────── */
  function pushParams() {
    if (!engine) return;
    engine.node.port.postMessage({
      type: 'params',
      p: {
        st: state.st + state.fine / 100,
        mix: state.mix,
        vol: state.vol,
        bypass: state.bypass,
        compare
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
      e.node = new AudioWorkletNode(e.ctx, 'pitch-shift', {
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
        if (engine !== e || !data) return;
        if (data.type === 'meter') meter.inp = Math.max(meter.inp, data.inp);
        else if (data.type === 'key') { keyInfo = data; renderKey(); }
      };
      if (token !== epoch) { await release(e); return; }
      engine = e;
      phase = 'live';
      pushParams();
      e.ctx.onstatechange = () => {
        if (engine === e && e.ctx.state !== 'running') fail('声音已暂停，点“开始”继续。');
      };
      renderGate();
      render();
      setStatus(defaultStatus());
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
    $('gate-btn').disabled = false;
    renderGate();
    render();
  }

  /* ── state changes ─────────────────────────────────────────────────── */
  function setPitch(st) {
    const next = clamp(Math.round(st), -RANGE, RANGE);
    if (next === state.st) { save(); render(); return; }
    state.st = next;
    state.fine = clamp(state.fine, fineFloor(), fineCeil());
    pushParams();
    save();
    render();
  }

  // the octave limits apply to the total shift, semitones plus cents
  function fineFloor() { return Math.max(-50, (-RANGE - state.st) * 100); }
  function fineCeil() { return Math.min(50, (RANGE - state.st) * 100); }

  function setMix(v) {
    state.mix = clamp(v);
    pushParams();
    save();
    render();
  }

  function setFine(cents) {
    const next = clamp(Math.round(cents), fineFloor(), fineCeil());
    if (next === state.fine) { save(); render(); return; }
    state.fine = next;
    pushParams();
    save();
    render();
  }

  function setVol(v) {
    state.vol = clamp(v);
    pushParams();
    save();
    render();
  }

  function toggleBypass() {
    state.bypass = !state.bypass;
    pushParams();
    save();
    setStatus(state.bypass ? '旁通：只听原声。再按 K2 回到变调。' : defaultStatus());
    render();
  }

  function nextPreset() {
    let i = PRESETS.findIndex((p) => p.st === state.st);
    i = (i + 1) % PRESETS.length;
    setPitch(PRESETS[i].st);
    setStatus(`预设：${PRESETS[i].name}（${intervalName(PRESETS[i].st)}）`);
  }

  function defaultStatus() {
    if (state.bypass) return '旁通中。按 K2 回到变调。';
    return 'E1 调音高 · E2 混合 · K3 预设 · K4 按住对比原声';
  }

  /* ── persistence ───────────────────────────────────────────────────── */
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const result = await sdk.data.set(SAVE_KEY, {
          st: state.st, fine: state.fine, mix: state.mix, vol: state.vol, bypass: state.bypass
        }, { expectedVersion: version });
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
      if (Number.isFinite(v.st)) state.st = clamp(Math.round(v.st), -RANGE, RANGE);
      if (Number.isFinite(v.fine)) state.fine = clamp(Math.round(v.fine), -50, 50);
      if (Number.isFinite(v.mix)) state.mix = clamp(v.mix);
      if (Number.isFinite(v.vol)) state.vol = clamp(v.vol);
      if (typeof v.bypass === 'boolean') state.bypass = v.bypass;
    } catch (_) { /* first run */ }
  }

  /* ── controls ──────────────────────────────────────────────────────── */
  function handleControl(e) {
    if (e.type === 'rotate') {
      if (e.control === 'E1') setPitch(state.st + e.delta);
      else if (e.control === 'E2') setMix(state.mix + e.delta * 0.02);
      else if (e.control === 'E3') setFine(state.fine + e.delta * 2);
      else if (e.control === 'E4') setVol(state.vol + e.delta * 0.02);
      return;
    }
    if (e.type === 'down') {
      if (!engine && (e.control === 'K2' || e.control === 'K3' || e.control === 'K4')) { void start(); return; }
      if (e.control === 'E1') { setPitch(0); setStatus('音高回到原声。'); }
      else if (e.control === 'E2') { setMix(1); setStatus('混合回到 100%。'); }
      else if (e.control === 'E3') { setFine(0); setStatus('微调回到 0 音分。'); }
      else if (e.control === 'E4') { setVol(0.75); setStatus('音量回到 75%。'); }
      else if (e.control === 'K2') toggleBypass();
      else if (e.control === 'K3') nextPreset();
      else if (e.control === 'K4') { compare = true; pushParams(); setStatus('对比：正在听原声…松开 K4 回到变调。'); render(); }
      return;
    }
    if (e.type === 'up' || e.type === 'cancel') {
      if (e.control === 'K4' && compare) {
        compare = false;
        pushParams();
        setStatus(defaultStatus());
        render();
      }
    }
  }

  /* ── view ──────────────────────────────────────────────────────────── */
  function setStatus(text) { $('status').textContent = text; }

  function build() {
    $('presets').innerHTML = PRESETS.map((p, i) => `<button data-preset="${i}">${p.name}</button>`).join('');
    $('chroma').innerHTML = NOTE_NAMES.map((n) => `<div class="chroma-bar"><i></i><span>${n}</span></div>`).join('');
  }

  /* Detected key of the input, and where the current shift takes it. */
  function renderKey() {
    const nameEl = $('keyname');
    const metaEl = $('keymeta');
    const bars = document.querySelectorAll('.chroma-bar');
    if (!keyInfo || keyInfo.root < 0) {
      nameEl.textContent = '—';
      nameEl.className = '';
      metaEl.textContent = keyInfo && keyInfo.weak ? '单音或噪声，听不清调性' : '等待音乐';
      for (const bar of bars) {
        bar.querySelector('i').style.height = '0%';
        bar.classList.remove('tonic');
      }
      return;
    }

    const minor = keyInfo.minor ? ' 小调' : ' 大调';
    nameEl.textContent = NOTE_NAMES[keyInfo.root] + minor;
    nameEl.className = 'on';

    let meta = '置信 ' + Math.round(keyInfo.r * 100) + '%';
    // relative major/minor share their notes; say so instead of pretending
    if (typeof keyInfo.margin === 'number' && keyInfo.margin < 0.05 &&
        typeof keyInfo.altRoot === 'number' && keyInfo.altRoot >= 0) {
      meta += ' · 也像 ' + NOTE_NAMES[keyInfo.altRoot] + (keyInfo.altMinor ? ' 小调' : ' 大调');
    }
    const shift = Math.round(state.st + state.fine / 100);
    if (shift !== 0) {
      const outRoot = (((keyInfo.root + shift) % 12) + 12) % 12;
      meta += ' · 输出 ' + NOTE_NAMES[outRoot] + minor;
    }
    metaEl.textContent = meta;

    let max = 0;
    for (let i = 0; i < 12; i++) max = Math.max(max, keyInfo.chroma[i] || 0);
    bars.forEach((bar, i) => {
      const v = (keyInfo.chroma[i] || 0) / (max || 1);
      bar.querySelector('i').style.height = Math.round(v * 100) + '%';
      bar.classList.toggle('tonic', i === keyInfo.root);
    });
  }

  function render() {
    const st = state.st;
    const el = $('st');
    el.textContent = signed(st);
    el.className = st === 0 ? 'zero' : st < 0 ? 'flat' : '';
    $('interval').textContent = state.fine === 0 ? intervalName(st) : intervalName(st) + ' ' + signedCents(state.fine);
    $('ratio').textContent = '×' + Math.pow(2, (st + state.fine / 100) / 12).toFixed(3);
    $('knob').style.left = (50 + (st / RANGE) * 50) + '%';

    document.querySelectorAll('#presets button').forEach((b, i) =>
      b.classList.toggle('on', PRESETS[i].st === st));

    const rows = document.querySelectorAll('.meter');
    const vals = [
      Math.round(state.mix * 100) + '%',
      (state.fine > 0 ? '+' : state.fine < 0 ? '−' : '') + Math.abs(state.fine) + '¢',
      Math.round(state.vol * 100) + '%'
    ];
    const fills = [state.mix, (state.fine + 50) / 100, state.vol];
    rows.forEach((row, i) => {
      row.querySelector('b').style.width = Math.round(clamp(fills[i]) * 100) + '%';
      row.querySelector('em').textContent = vals[i];
    });

    $('flag-bypass').hidden = !state.bypass;
    $('flag-hold').hidden = !compare;
    renderKey();
    renderMonitor();
  }

  function renderGate() {
    const show = phase !== 'live';
    $('gate').hidden = !show;
    if (phase === 'starting') {
      $('gate-msg').textContent = '正在启动声音…';
      $('gate-btn').disabled = true;
      return;
    }
    $('gate-btn').disabled = false;
    if (phase === 'idle') {
      $('gate-btn').textContent = '开始';
      $('gate-msg').textContent = preview ? '预览里没有麦克风，请在设备上打开这个 App。' : '点“开始”启用音频输入和输出。';
    }
  }

  function renderMonitor() {
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      try {
        const pending = sdk.monitor.set({
          E1: { label: '音高', value: signed(state.st) + ' st' },
          E2: { label: '混合', value: Math.round(state.mix * 100) + '%' },
          E3: { label: '微调', value: signedCents(state.fine) },
          E4: { label: '音量', value: Math.round(state.vol * 100) + '%' },
          K2: { label: '旁通', pressed: state.bypass },
          K3: { label: '预设' },
          K4: { label: '对比', pressed: compare }
        });
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch (_) { /* monitor is optional */ }
    }, 40);
  }

  function drawMeter() {
    meter.inp *= 0.9;
    $('lvl-in').style.width = Math.round(clamp(Math.sqrt(meter.inp) * 1.5) * 100) + '%';
    requestAnimationFrame(drawMeter);
  }

  /* ── touch ─────────────────────────────────────────────────────────── */
  function wireTouch() {
    $('presets').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-preset]');
      if (!b) return;
      if (!engine) { void start(); }
      const p = PRESETS[Number(b.dataset.preset)];
      setPitch(p.st);
      setStatus(`预设：${p.name}（${intervalName(p.st)}）`);
    });

    const bar = $('pitchbar');
    const pitchAt = (ev) => {
      const r = bar.getBoundingClientRect();
      const t = clamp((ev.clientX - r.left) / Math.max(1, r.width));
      return Math.round(t * RANGE * 2 - RANGE);
    };
    bar.addEventListener('pointerdown', (ev) => {
      if (!engine) { void start(); return; }
      dragging = true;
      try { bar.setPointerCapture(ev.pointerId); } catch (_) { /* older engine */ }
      setPitch(pitchAt(ev));
      setStatus(`音高 ${signed(state.st)}（${intervalName(state.st)}）`);
      ev.preventDefault();
    });
    bar.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      setPitch(pitchAt(ev));
      setStatus(`音高 ${signed(state.st)}（${intervalName(state.st)}）`);
    });
    const end = () => { dragging = false; };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);

    $('gate-btn').addEventListener('click', () => { void start(); });
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
      if (!preview && (phase === 'live' || phase === 'error')) void stop().then(() => start());
    });
    await sdk.ready();
    if (!preview) void start();
  }

  addEventListener('pagehide', () => { void stop(); });
  void init();
})();
