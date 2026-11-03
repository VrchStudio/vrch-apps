(() => {
  'use strict';

  const sdk = VrchApp;
  const $ = (id) => document.getElementById(id);
  const preview = sdk.context.mode === 'preview';
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const SAVE_KEY = 'song';

  const PPQ = 24;
  const BAR = PPQ * 4;          // 96 ticks
  const COLS = 16;              // 16th grid
  const COL = BAR / COLS;       // 6 ticks
  const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const LENGTHS = [3, 6, 12, 24];

  const song = {
    bpm: 120,
    bars: 8,
    loop: true,
    vol: 0.8,
    tracks: Array.from({ length: 6 }, (_, i) => ({
      name: '轨道 ' + (i + 1),
      bank: 0,
      program: 0,
      mute: false,
      vol: 1,
      notes: []
    }))
  };
  song.tracks[5].bank = 128;
  song.tracks[5].program = 0;
  song.tracks[5].name = '鼓组';

  const ui = { view: 'arrange', track: 0, bar: 0, len: COL, vel: 100, octave: 2 };

  let bank = null;
  let phase = 'idle';
  let engine = null;
  let epoch = 0;
  let version;
  let saveTimer = 0;
  let pushTimer = 0;
  let monitorTimer = 0;
  const meter = { level: 0, voices: 0, tick: -1 };
  let playing = false;

  const track = () => song.tracks[ui.track];
  const presetName = (t) => {
    if (!bank) return '—';
    const p = bank.presets.find((x) => x.bank === t.bank && x.program === t.program);
    return p ? p.name : '—';
  };
  const layerCache = new Map();
  const layersFor = (t) => {
    const k = t.bank + ':' + t.program;
    if (!layerCache.has(k)) {
      const p = bank.presets.find((x) => x.bank === t.bank && x.program === t.program);
      layerCache.set(k, p ? p.layers : []);
    }
    return layerCache.get(k);
  };

  /* ── audio ─────────────────────────────────────────────────────────── */
  function pushSong() {
    if (!engine) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      engine.node.port.postMessage({
        type: 'song',
        bpm: song.bpm,
        bars: song.bars,
        loop: song.loop,
        tracks: song.tracks.map((t) => ({
          layers: layersFor(t),
          mute: t.mute,
          vol: t.vol,
          notes: t.notes.map((n) => ({ t: n.t, d: n.d, m: n.m, v: n.v }))
        }))
      });
    }, 40);
  }

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
      e.node = new AudioWorkletNode(e.ctx, 'gm-studio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      e.out = await sdk.audio.openOutput({ channels: 2 });
      e.outNode = await e.out.createNode(e.ctx);
      e.node.connect(e.outNode);
      e.node.port.onmessage = ({ data }) => {
        if (engine !== e || !data || data.type !== 'meter') return;
        meter.level = Math.max(meter.level, data.level || 0);
        meter.voices = data.voices || 0;
        if (typeof data.tick === 'number') meter.tick = data.tick;
      };
      if (token !== epoch) return;
      engine = e;
      phase = 'live';
      e.node.port.postMessage({ type: 'bank', pcm: bank.pcm.buffer }, [bank.pcm.buffer]);
      pushSong();
      e.node.port.postMessage({ type: 'params', vol: song.vol });
      renderGate();
      setStatus('就绪 · 点 ▶ 播放');
    } catch (error) {
      phase = 'error';
      const code = error.code || error.name;
      $('gate-msg').textContent = code === 'interaction_required' ? '点“开始”启用声音。' : '声音无法启动，点重试。';
      $('gate-btn').textContent = '重试';
      $('gate-btn').disabled = false;
      renderGate();
    }
  }

  function transport(next) {
    playing = next;
    if (engine) engine.node.port.postMessage({ type: 'transport', playing });
    render();
  }

  function seekBar(bar) {
    ui.bar = clamp(bar, 0, song.bars - 1);
    if (engine) engine.node.port.postMessage({ type: 'transport', tick: ui.bar * BAR, playing });
    render();
  }

  /* ── view: arrangement ─────────────────────────────────────────────── */
  function renderArrange() {
    const barNow = meter.tick >= 0 ? Math.floor(meter.tick / BAR) : -1;
    let html = '<div class="arr"><div class="arr-head"><span class="trk">轨道</span>';
    for (let b = 0; b < song.bars; b++) {
      html += `<span class="bar${b === barNow ? ' now' : ''}" data-bar="${b}">${b + 1}</span>`;
    }
    html += '</div>';

    song.tracks.forEach((t, i) => {
      html += `<div class="arr-row${i === ui.track ? ' sel' : ''}" data-track="${i}">`;
      html += `<span class="trk"><b>${t.name}</b><em>${presetName(t)}</em></span>`;
      for (let b = 0; b < song.bars; b++) {
        const n = t.notes.filter((x) => x.t >= b * BAR && x.t < (b + 1) * BAR);
        const on = n.length ? ' on' : '';
        html += `<span class="cell${on}${b === barNow ? ' now' : ''}" data-track="${i}" data-bar="${b}">${n.length ? '<i></i>' : ''}</span>`;
      }
      html += '</div>';
    });
    html += '</div>';
    $('view').innerHTML = html;
  }

  /* ── view: piano roll ──────────────────────────────────────────────── */
  // put the visible 24-semitone window over this track's notes
  function centerRoll() {
    const t = track();
    const barNotes = t.notes.filter((n) => n.t >= ui.bar * BAR && n.t < (ui.bar + 1) * BAR);
    const pool = barNotes.length ? barNotes : t.notes;
    if (!pool.length) return;
    const avg = pool.reduce((a, n) => a + n.m, 0) / pool.length;
    ui.octave = clamp(Math.round((avg - 47) / 12), 0, 6);
  }

  function setView(v) {
    ui.view = v;
    if (v === 'roll') centerRoll();
    render();
  }

  function renderRoll() {
    const t = track();
    const base = ui.octave * 12 + 36;
    const rows = 24;
    let html = '<div class="roll">';
    html += '<div class="roll-head">';
    html += '<button class="xp-btn" data-act="prevbar">◀</button>';
    html += `<span class="roll-title">${t.name} · 第 ${ui.bar + 1} 小节</span>`;
    html += '<button class="xp-btn" data-act="nextbar">▶</button>';
    html += '</div>';
    html += '<div class="roll-tools">';
    LENGTHS.forEach((l) => {
      const label = l === 3 ? '1/32' : l === 6 ? '1/16' : l === 12 ? '1/8' : '1/4';
      html += `<button class="xp-btn${ui.len === l ? ' on' : ''}" data-len="${l}">${label}</button>`;
    });
    html += '<button class="xp-btn" data-act="oct-">八度−</button>';
    html += '<button class="xp-btn" data-act="oct+">八度+</button>';
    html += '</div>';

    html += '<div class="grid">';
    for (let r = 0; r < rows; r++) {
      const midi = base + (rows - 1 - r);
      const black = [1, 3, 6, 8, 10].includes(midi % 12);
      html += `<div class="grow${black ? ' black' : ''}">`;
      html += `<span class="key" data-midi="${midi}">${NOTE[midi % 12]}${Math.floor(midi / 12) - 1}</span>`;
      for (let col = 0; col < COLS; col++) {
        const tick = ui.bar * BAR + col * COL;
        const hit = t.notes.find((n) => n.m === midi && tick >= n.t && tick < n.t + n.d);
        html += `<span class="cell${hit ? (hit.t === tick ? ' note' : ' tail') : ''}${col % 4 === 0 ? ' beat' : ''}" data-t="${tick}" data-m="${midi}"></span>`;
      }
      html += '</div>';
    }
    html += '</div></div>';
    $('view').innerHTML = html;
    const g = $('view').querySelector('.grid');
    if (g) {
      // centre the view on the notes this bar already has
      const barNotes = t.notes.filter((n) => n.t >= ui.bar * BAR && n.t < (ui.bar + 1) * BAR);
      const avg = barNotes.length
        ? barNotes.reduce((a, n) => a + n.m, 0) / barNotes.length
        : ui.octave * 12 + 48;
      const row = (rows - 1) - (Math.round(avg) - base);
      g.scrollTop = Math.max(0, row * 15 - g.clientHeight / 2 + 24);
    }
  }

  /* ── view: instruments ─────────────────────────────────────────────── */
  function renderInst() {
    const t = track();
    const drums = t.bank === 128;
    const list = bank.presets.filter((p) => (drums ? p.bank === 128 : p.bank === 0));
    let html = '<div class="inst">';
    html += `<div class="inst-head"><b>${t.name}</b> 的音色<span class="grow"></span>`;
    html += `<button class="xp-btn${drums ? ' on' : ''}" data-act="drums">鼓组</button></div>`;
    html += '<div class="inst-list">';
    list.forEach((p) => {
      const on = p.program === t.program ? ' sel' : '';
      html += `<div class="irow${on}" data-prog="${p.program}"><span class="n">${String(p.program + 1).padStart(3, '0')}</span><span class="t">${p.name}</span></div>`;
    });
    html += '</div></div>';
    $('view').innerHTML = html;
  }

  /* ── render ────────────────────────────────────────────────────────── */
  function render() {
    if (!bank) return;
    $('tempo').innerHTML = `<b>${song.bpm}</b><small>BPM</small>`;
    $('loop').classList.toggle('on', song.loop);
    $('play').textContent = playing ? '❚❚' : '▶';
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === ui.view));

    if (ui.view === 'arrange') renderArrange();
    else if (ui.view === 'roll') renderRoll();
    else renderInst();

    const pos = meter.tick >= 0 ? meter.tick : ui.bar * BAR;
    $('pos').textContent = (Math.floor(pos / BAR) + 1) + '.' + (Math.floor((pos % BAR) / PPQ) + 1);

    const t = track();
    setStatus(`${t.name} · ${presetName(t)} · ${t.notes.length} 音符 · 复音 ${meter.voices}`);
    renderMonitor();
  }

  function renderMonitor() {
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      try {
        const t = track();
        const pending = sdk.monitor.set({
          E1: { label: '轨道', value: String(ui.track + 1) },
          E2: { label: '速度', value: String(song.bpm) },
          E3: { label: '力度', value: String(ui.vel) },
          E4: { label: '长度', value: String(ui.len) + 't' },
          K2: { label: playing ? '停止' : '播放' },
          K3: { label: '窗口', value: ui.view === 'arrange' ? '编曲' : ui.view === 'roll' ? '钢琴窗' : '音色' },
          K4: { label: '静音', pressed: t.mute }
        });
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch (_) { /* optional */ }
    }, 40);
  }

  function renderGate() {
    $('gate').hidden = phase === 'live';
    if (phase === 'starting') { $('gate-btn').disabled = true; return; }
    $('gate-btn').disabled = false;
  }

  function setStatus(text) { $('status').textContent = text; }

  /* ── editing ───────────────────────────────────────────────────────── */
  function addNote(tick, midi) {
    const t = track();
    const len = Math.min(ui.len, BAR - (tick % BAR));
    if (t.notes.some((n) => n.m === midi && tick >= n.t && tick < n.t + n.d)) return;
    t.notes.push({ t: tick, d: len, m: midi, v: ui.vel });
    t.notes.sort((a, b) => a.t - b.t);
    pushSong();
    save();
    render();
  }

  function removeNoteAt(tick, midi) {
    const t = track();
    const i = t.notes.findIndex((n) => n.m === midi && tick >= n.t && tick < n.t + n.d);
    if (i < 0) return false;
    t.notes.splice(i, 1);
    pushSong();
    save();
    render();
    return true;
  }

  function previewNote(midi) {
    if (!engine || phase !== 'live') return;
    engine.node.port.postMessage({ type: 'note', on: true, midi, vel: ui.vel || 100, track: ui.track });
  }

  function setProgram(program, drums) {
    const t = track();
    t.bank = drums ? 128 : 0;
    t.program = program;
    if (drums) t.name = '鼓组';
    pushSong();
    save();
    render();
  }

  /* ── input ─────────────────────────────────────────────────────────── */
  function handleViewClick(ev) {
    const el = ev.target.closest('[data-act],[data-len],[data-bar],[data-t],[data-midi],[data-prog]');
    if (!el) return;

    if (el.dataset.act) {
      const a = el.dataset.act;
      if (a === 'prevbar') seekBar(ui.bar - 1);
      else if (a === 'nextbar') seekBar(ui.bar + 1);
      else if (a === 'oct-') { ui.octave = clamp(ui.octave - 1, 0, 6); render(); }
      else if (a === 'oct+') { ui.octave = clamp(ui.octave + 1, 0, 6); render(); }
      else if (a === 'drums') setProgram(0, track().bank !== 128);
      return;
    }
    if (el.dataset.len) { ui.len = Number(el.dataset.len); render(); return; }
    if (el.dataset.prog !== undefined) { setProgram(Number(el.dataset.prog), track().bank === 128); return; }
    if (el.dataset.midi !== undefined) { previewNote(Number(el.dataset.midi)); return; }

    if (el.dataset.t !== undefined && el.dataset.m !== undefined) {
      const tick = Number(el.dataset.t);
      const midi = Number(el.dataset.m);
      if (!removeNoteAt(tick, midi)) {
        addNote(tick, midi);
        previewNote(midi);
      }
      return;
    }

    if (el.dataset.bar !== undefined) {
      const b = Number(el.dataset.bar);
      if (el.dataset.track !== undefined) {
        ui.track = Number(el.dataset.track);
        ui.bar = b;
        setView('roll');
      } else {
        seekBar(b);
      }
    }
  }

  function handleControl(e) {
    if (e.type === 'rotate') {
      if (e.control === 'E1') { ui.track = (ui.track + (e.delta > 0 ? 1 : -1) + 6) % 6; render(); }
      else if (e.control === 'E2') { song.bpm = clamp(song.bpm + e.delta * 2, 40, 240); pushSong(); save(); render(); }
      else if (e.control === 'E3') { ui.vel = clamp(ui.vel + e.delta * 4, 1, 127); render(); }
      else if (e.control === 'E4') {
        const i = LENGTHS.indexOf(ui.len);
        const n = clamp((i < 0 ? 1 : i) + (e.delta > 0 ? 1 : -1), 0, LENGTHS.length - 1);
        ui.len = LENGTHS[n];
        render();
      }
      return;
    }
    if (e.type === 'down') {
      if (e.control === 'K2') { if (!engine) { void start(); return; } transport(!playing); }
      else if (e.control === 'K3') {
        setView(ui.view === 'arrange' ? 'roll' : ui.view === 'roll' ? 'inst' : 'arrange');
      } else if (e.control === 'K4') { track().mute = !track().mute; pushSong(); save(); render(); }
      else if (e.control === 'E1') { ui.track = 0; render(); }
      else if (e.control === 'E2') { song.bpm = 120; pushSong(); save(); render(); }
      else if (e.control === 'E3') { ui.vel = 100; render(); }
      else if (e.control === 'E4') { ui.len = COL; render(); }
    }
  }

  /* ── persistence ───────────────────────────────────────────────────── */
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const result = await sdk.data.set(SAVE_KEY, {
          bpm: song.bpm, bars: song.bars, loop: song.loop, vol: song.vol,
          tracks: song.tracks.map((t) => ({ name: t.name, bank: t.bank, program: t.program, mute: t.mute, notes: t.notes }))
        }, { expectedVersion: version });
        version = result.version;
      } catch (_) { /* best effort */ }
    }, 800);
  }

  async function load() {
    try {
      const result = await sdk.data.get(SAVE_KEY);
      version = result.version;
      const v = result.value;
      if (!v || !Array.isArray(v.tracks)) return;
      if (Number.isFinite(v.bpm)) song.bpm = v.bpm;
      if (Number.isFinite(v.bars)) song.bars = clamp(v.bars, 1, 16);
      if (typeof v.loop === 'boolean') song.loop = v.loop;
      if (Number.isFinite(v.vol)) song.vol = v.vol;
      v.tracks.slice(0, 6).forEach((t, i) => {
        const dst = song.tracks[i];
        if (!dst) return;
        if (t.name) dst.name = t.name;
        if (Number.isFinite(t.bank)) dst.bank = t.bank;
        if (Number.isFinite(t.program)) dst.program = t.program;
        if (typeof t.mute === 'boolean') dst.mute = t.mute;
        if (Array.isArray(t.notes)) {
          dst.notes = t.notes
            .filter((n) => n && Number.isFinite(n.t) && Number.isFinite(n.m))
            .map((n) => ({ t: n.t | 0, d: Math.max(3, n.d | 0), m: n.m | 0, v: clamp(n.v | 0 || 100, 1, 127) }));
        }
      });
    } catch (_) { /* first run */ }
  }

  /* ── boot ──────────────────────────────────────────────────────────── */
  async function boot() {
    await load();
    setStatus('正在载入 gm.sf2…');
    try {
      const res = await fetch('gm.sf2');
      const buf = await res.arrayBuffer();
      bank = Bank.build(SF2.parse(buf));
      setStatus('载入完成 · ' + bank.presets.length + ' 个预设');
    } catch (error) {
      setStatus('载入失败：' + error.message);
      return;
    }
    if (!song.tracks.some((t) => t.notes.length)) seedSong();

    $('view').addEventListener('click', handleViewClick);
    document.querySelectorAll('#tabs button').forEach((b) => {
      b.addEventListener('click', () => setView(b.dataset.view));
    });
    $('play').addEventListener('click', () => { if (!engine) { void start(); return; } transport(!playing); });
    $('stop').addEventListener('click', () => { transport(false); seekBar(0); });
    $('loop').addEventListener('click', () => { song.loop = !song.loop; pushSong(); save(); render(); });

    sdk.controls.onEvent(handleControl);
    render();
    renderGate();
    requestAnimationFrame(tickUi);
    sdk.audio.onAvailable(() => {
      if (!preview && (phase === 'live' || phase === 'error')) { transport(false); void start(); }
    });
    await sdk.ready();
    if (!preview) void start();
  }

  /* a small demo so the app is not empty on first run */
  function seedSong() {
    const chords = [
      [60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62],
      [60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]
    ];
    const piano = song.tracks[0];
    piano.program = 0;
    chords.forEach((c, b) => {
      c.forEach((m) => piano.notes.push({ t: b * BAR, d: PPQ * 2, m, v: 92 }));
    });
    const bass = song.tracks[1];
    bass.program = 32;
    chords.forEach((c, b) => {
      bass.notes.push({ t: b * BAR, d: PPQ * 2, m: c[0] - 12, v: 100 });
      bass.notes.push({ t: b * BAR + PPQ * 2, d: PPQ, m: c[0] - 12, v: 84 });
      bass.notes.push({ t: b * BAR + PPQ * 3, d: PPQ, m: c[0] - 5, v: 84 });
    });
    const drum = song.tracks[5];
    drum.bank = 128;
    drum.program = 0;
    for (let b = 0; b < 8; b++) {
      for (let beat = 0; beat < 4; beat++) {
        const t = b * BAR + beat * PPQ;
        drum.notes.push({ t, d: 3, m: 36, v: 110 });
        if (beat % 2 === 1) drum.notes.push({ t, d: 3, m: 38, v: 96 });
        drum.notes.push({ t, d: 2, m: 42, v: 70 });
      }
    }
  }

  function tickUi() {
    meter.level *= 0.9;
    $('meter').firstElementChild.style.width = Math.round(clamp(meter.level) * 100) + '%';
    if (meter.tick >= 0) {
      const pos = meter.tick;
      const bar = Math.floor(pos / BAR) + 1;
      const beat = Math.floor((pos % BAR) / PPQ) + 1;
      $('pos').textContent = bar + '.' + beat;
      if (ui.view === 'arrange') {
        const barNow = Math.floor(pos / BAR);
        document.querySelectorAll('.arr .bar').forEach((el) => el.classList.toggle('now', Number(el.dataset.bar) === barNow));
        document.querySelectorAll('.arr .cell').forEach((el) => el.classList.toggle('now', Number(el.dataset.bar) === barNow));
      }
    }
    requestAnimationFrame(tickUi);
  }

  addEventListener('pagehide', () => { if (engine) engine.node.port.postMessage({ type: 'allOff' }); });
  void boot();
})();
