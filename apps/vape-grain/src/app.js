(() => {
  'use strict';

  const sdk = VrchApp;
  const $ = (id) => document.getElementById(id);
  const preview = sdk.context.mode === 'preview';
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

  const MACROS = [
    { id: 'grain', enc: 'E1' },
    { id: 'air', enc: 'E2' },
    { id: 'tone', enc: 'E3' },
    { id: 'space', enc: 'E4' }
  ];
  // Each preset is its own instrument: the four knobs keep their positions but
  // change meaning, exactly like the macro page of a hardware synth.
  const PRESETS = [
    { name: 'DRIFT', hue: 320, note: 'warm drifting pad · 76', labels: ['GRAIN', 'AIR', 'TONE', 'SPACE'] },
    { name: 'GLASS', hue: 185, note: 'glass shimmer · 70', labels: ['GRAIN', 'AIR', 'TONE', 'SHIMMER'] },
    { name: 'PULSE', hue: 265, note: 'pulsing chord · 84', labels: ['GRAIN', 'MOTION', 'TONE', 'SPACE'] },
    { name: 'CHOIR', hue: 45, note: 'formant choir · 72', labels: ['VOWEL', 'AIR', 'TONE', 'SPACE'] },
    { name: 'TIDE', hue: 215, note: 'deep sub swell · 66', labels: ['GRAIN', 'AIR', 'TONE', 'SPACE'] },
    { name: 'DUST', hue: 25, note: 'lo-fi tape haze · 80', labels: ['WOW', 'AIR', 'TONE', 'SPACE'] },
    { name: 'AURORA', hue: 140, note: 'shimmer arpeggio · 90', labels: ['GRAIN', 'ARP', 'TONE', 'SHIMMER'] },
    { name: 'HYPER', hue: 330, note: 'supersaw pump · 160', labels: ['GRAIN', 'AIR', 'BRIGHT', 'PUMP'] },
    { name: 'CLOUD', hue: 290, note: 'cloud rap haze · 135', labels: ['GRAIN', 'AIR', 'TONE', 'SPACE'] }
  ];
  const DEFAULTS = { grain: 0.42, air: 0.5, tone: 0.5, space: 0.55 };
  const SAVE_KEY = 'vape-grain';

  const state = { preset: 0, macros: { ...DEFAULTS } };
  let version = 0;
  let saveTimer = 0;
  let noticeTimer = 0;
  let phase = 'idle';
  let engine = null;
  let epoch = 0;
  let monitorTimer = 0;
  let muted = false;
  let hintHidden = false;

  const meter = { env: 0, cloud: 0, grains: 0, peak: 0, listening: false };
  const display = { env: 0, cloud: 0 };

  /* ── small UI helpers ──────────────────────────────────────────────── */
  function notice(text, keep = false) {
    clearTimeout(noticeTimer);
    const el = $('notice');
    el.textContent = text;
    el.hidden = !text;
    if (text && !keep) noticeTimer = setTimeout(() => { el.hidden = true; }, 4200);
  }

  function accent() {
    const hue = PRESETS[state.preset].hue;
    document.documentElement.style.setProperty('--accent', `hsl(${hue} 92% 72%)`);
    document.documentElement.style.setProperty('--accent-dim', `hsl(${hue} 60% 38%)`);
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const result = await sdk.data.set(SAVE_KEY, { preset: state.preset, macros: { ...state.macros } }, { expectedVersion: version });
        version = result.version;
      } catch (_) {
        /* saving is best effort; audio never waits for it */
      }
    }, 700);
  }

  /* ── audio ─────────────────────────────────────────────────────────── */
  const meters = new Map();

  function pushMacros() {
    if (engine) engine.node.port.postMessage({ type: 'macros', value: { ...state.macros } });
  }

  function pushPreset() {
    if (engine) engine.node.port.postMessage({ type: 'preset', index: state.preset });
  }

  // K3, the on-screen K3 and the stage each hold a steady "breath" while
  // pressed; it lasts until every one of them is released.
  const holders = new Set();

  function pushHold() {
    if (engine) engine.node.port.postMessage({ type: 'hold', on: holders.size > 0 });
  }

  function hold(source, on) {
    if (on) {
      if (phase !== 'live') {
        if (phase !== 'starting') start();
        return;
      }
      holders.add(source);
      display.env = Math.max(display.env, 0.85);
      if (!hintHidden) { hintHidden = true; $('hint').classList.add('off'); }
    } else if (!holders.delete(source)) {
      return;
    }
    pushHold();
    monitor();
  }

  function setMuted(value) {
    muted = value;
    if (engine) engine.node.port.postMessage({ type: 'mute', on: muted });
    if (muted) display.env = 0;
    render();
  }

  /* Chord beds are synthesised here in short slices (dsp.js is also loaded as
   * a plain script for this) and posted to the worklet, so the audio thread
   * never spends a block on synthesis. The current preset is built first. */
  const bedCache = new Map();

  async function sendBeds(e, token) {
    const lib = window.VapeGrainBeds;
    if (!lib) return;
    const sr = e.ctx.sampleRate;
    const sent = new Set();
    while (sent.size < PRESETS.length) {
      if (token !== epoch) return;
      const index = sent.has(state.preset) ? PRESETS.findIndex((_, i) => !sent.has(i)) : state.preset;
      const key = sr + ':' + index;
      let buf = bedCache.get(key);
      if (!buf) {
        const job = lib.createBedJob(lib.PRESETS[index], sr);
        while (!lib.stepBedJob(job, 150000)) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (token !== epoch) return;
        }
        buf = job.buf;
        bedCache.set(key, buf);
      }
      e.node.port.postMessage({ type: 'bed', index, buf });
      sent.add(index);
    }
  }

  async function release(e) {
    if (!e) return;
    try {
      e.inNode?.disconnect();
      e.node?.disconnect();
      e.outNode?.disconnect();
    } catch (_) { /* already gone */ }
    await Promise.allSettled([e.in?.close(), e.out?.close(), e.ctx?.close()]);
  }

  async function stop() {
    ++epoch;
    const old = engine;
    engine = null;
    phase = 'idle';
    meter.env = meter.cloud = 0;
    render();
    await release(old);
  }

  async function start() {
    if (phase === 'starting' || phase === 'live') return;
    const token = ++epoch;
    const e = {};
    phase = 'starting';
    render();
    try {
      e.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      if (!e.ctx.audioWorklet) throw Object.assign(new Error('no worklet'), { code: 'unsupported_environment' });
      await e.ctx.resume();
      if (e.ctx.state !== 'running') throw Object.assign(new Error('gesture'), { code: 'interaction_required' });

      await e.ctx.audioWorklet.addModule(new URL('dsp.js', location.href).href);
      e.node = new AudioWorkletNode(e.ctx, 'vape-grain', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { demo: preview, preset: state.preset, macros: { ...state.macros } }
      });

      e.out = await sdk.audio.openOutput({ channels: 2 });
      e.outNode = await e.out.createNode(e.ctx);
      e.node.connect(e.outNode);

      if (!preview) {
        // The host's echo cancellation also suppresses noise, and a steady
        // exhale is noise to it: it fades within a second and every breath
        // becomes a one-shot. The SDK offers no separate noise-suppression
        // switch, so the raw microphone is opened with processing off.
        const attempts = [
          { channels: 1, echoCancellation: false },
          { channels: 2, echoCancellation: false }
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
        meter.env = data.env;
        meter.cloud = data.cloud;
        meter.grains = data.grains;
        meter.peak = data.peak;
        meter.listening = data.listening;
        if (data.env > 0.2 && !hintHidden) { hintHidden = true; $('hint').classList.add('off'); }
      };

      if (token !== epoch) { await release(e); return; }
      engine = e;
      phase = 'live';
      pushMacros();
      pushPreset();
      pushHold();
      void sendBeds(e, token);
      e.ctx.onstatechange = () => {
        if (engine === e && e.ctx.state !== 'running') fail('Audio paused. Choose Start to resume.');
      };
      render();
    } catch (error) {
      await release(e);
      if (token !== epoch) return;
      phase = 'error';
      render();
      const code = error.code || error.name;
      notice(
        code === 'permission_required' ? 'Allow audio input in Device Access, then Retry.'
          : code === 'audio_device_unavailable' ? 'Choose an available IN and OUT in the K1 Menu, then Retry.'
            : code === 'unsupported_environment' ? 'Audio is unavailable in this preview. Launch on the device.'
              : 'Audio did not start. Check the input in the K1 Menu, then Retry.',
        true
      );
    }
  }

  async function fail(message) {
    await stop();
    phase = 'error';
    render();
    notice(message, true);
  }

  /* ── rendering ─────────────────────────────────────────────────────── */
  function render() {
    const p = PRESETS[state.preset];
    $('preset').textContent = p.name;
    const live = phase === 'live';
    const label = !live ? (phase === 'starting' ? 'STARTING' : phase === 'error' ? 'NO AUDIO' : 'READY')
      : muted ? 'MUTED'
        : meter.env > 0.35 ? 'EXHALE'
          : meter.cloud > 0.05 ? 'TAIL'
            : preview ? 'DEMO' : 'LISTENING';
    const stateEl = $('state');
    stateEl.className = 'state' + (live && !muted ? ' live' : '');
    stateEl.querySelector('em').textContent = label;

    $('k4').setAttribute('aria-pressed', String(muted));
    $('start').hidden = live || phase === 'starting';
    $('start').textContent = phase === 'error' ? 'RETRY' : preview ? 'START' : 'START';

    accent();
    monitor();
  }

  function monitor() {
    clearTimeout(monitorTimer);
    const labels = PRESETS[state.preset].labels;
    monitorTimer = setTimeout(() => {
      const values = {};
      MACROS.forEach((m, i) => {
        values[m.enc] = { label: labels[i], value: Math.round(state.macros[m.id] * 100) + '%' };
      });
      values.K2 = { label: 'Preset', value: PRESETS[state.preset].name };
      values.K3 = { label: 'Hold', pressed: holders.has('K3') };
      values.K4 = { label: muted ? 'Muted' : 'Mute', pressed: muted };
      void sdk.monitor.set(values).catch(() => {});
    }, 40);
  }

  function buildMacros() {
    const root = $('macros');
    const labels = PRESETS[state.preset].labels;
    root.innerHTML = '';
    MACROS.forEach((m, i) => {
      const cell = document.createElement('div');
      cell.className = 'macro';
      cell.id = 'macro-' + m.id;
      cell.innerHTML = `<span class="tag">${m.enc}</span><span class="val">0</span>` +
        `<span class="lab">${labels[i]}</span><i class="fill"></i>`;
      root.append(cell);
    });
  }

  function updateMacros() {
    const labels = PRESETS[state.preset].labels;
    MACROS.forEach((m, i) => {
      const cell = $('macro-' + m.id);
      const v = state.macros[m.id];
      cell.querySelector('.val').textContent = Math.round(v * 100);
      cell.querySelector('.fill').style.width = (v * 100).toFixed(1) + '%';
      cell.querySelector('.lab').textContent = labels[i];
    });
  }

  function change(id, delta) {
    state.macros[id] = clamp(state.macros[id] + delta);
    pushMacros();
    updateMacros();
    save();
  }

  function cyclePreset(direction = 1) {
    state.preset = (state.preset + direction + PRESETS.length) % PRESETS.length;
    pushPreset();
    updateMacros();
    save();
    render();
    notice(PRESETS[state.preset].name + ' — ' + PRESETS[state.preset].note);
  }

  /* ── canvas: a stick figure with a vape, OP-1 style ──────────────────
   * Flat line drawing on black: white strokes, the preset colour for the vape
   * LED and the vapour, which is drawn as outlined circles. The figure lifts
   * the vape to its mouth while you breathe and blows clouds as the sound
   * rings out.                                                            */
  const canvas = $('canvas');
  const g = canvas.getContext('2d');
  let W = 480, H = 300, dpr = 1;
  const particles = [];
  let mouthAcc = 0;
  let tipAcc = 0;
  let lastFrame = 0;
  let lift = 0;
  const INK = '#f2f2f2';
  const DIM = '#3a3a3a';

  function resizeCanvas() {
    const rect = $('stage').getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, rect.width);
    H = Math.max(1, rect.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const lerp = (a, b, k) => a + (b - a) * k;
  const ease = (k) => k * k * (3 - 2 * k);

  /** Joint positions for this frame, in canvas pixels. */
  function pose(t) {
    const u = Math.min(W / 420, H / 290);
    const groundY = H * 0.86;
    const cx = W * 0.36;
    const k = ease(lift);
    const bob = Math.sin(t * 1.6) * 1.2 * u;
    const hip = { x: cx, y: groundY - 64 * u };
    const shoulder = { x: cx - 3 * u * k, y: hip.y - 62 * u + bob };
    const head = { x: shoulder.x + 3 * u - 2 * u * k, y: shoulder.y - 25 * u - 1.5 * u * k };
    const r = 15 * u;
    const mouth = { x: head.x + r * 0.86, y: head.y + r * 0.38 };
    const hand = {
      x: lerp(shoulder.x + 18 * u, mouth.x + 9 * u, k),
      y: lerp(shoulder.y + 38 * u, mouth.y + 1 * u, k)
    };
    const elbow = {
      x: lerp(shoulder.x + 12 * u, shoulder.x + 24 * u, k),
      y: lerp(shoulder.y + 22 * u, shoulder.y + 20 * u, k)
    };
    const angle = lerp(-1.75, 0, k);
    return { u, groundY, hip, shoulder, head, r, mouth, hand, elbow, angle };
  }

  function line(points, width) {
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
    g.stroke();
  }

  function drawGround(P) {
    const { u, groundY } = P;
    g.fillStyle = DIM;
    for (let x = 10; x < W - 6; x += 7 * Math.max(1, u)) g.fillRect(x, groundY, 1.5, 1.5);
    g.fillStyle = '#555';
    for (const fx of [0.08, 0.92]) g.fillRect(W * fx, groundY - 4, 1, 9);
  }

  function drawFigure(t, P, hue) {
    const { u, groundY, hip, shoulder, head, r, hand, elbow, angle } = P;
    const w = Math.max(1.5, 2.2 * u);
    g.strokeStyle = INK;
    g.lineCap = 'round';
    g.lineJoin = 'round';

    // legs and feet
    line([hip, { x: hip.x - 5 * u, y: hip.y + 32 * u }, { x: hip.x - 12 * u, y: groundY }], w);
    line([hip, { x: hip.x + 6 * u, y: hip.y + 32 * u }, { x: hip.x + 13 * u, y: groundY }], w);
    line([{ x: hip.x - 12 * u, y: groundY }, { x: hip.x - 4 * u, y: groundY }], w);
    line([{ x: hip.x + 13 * u, y: groundY }, { x: hip.x + 21 * u, y: groundY }], w);

    // torso, neck, free arm swinging a little
    line([hip, shoulder], w);
    line([shoulder, { x: head.x - r * 0.15, y: head.y + r }], w);
    const sway = Math.sin(t * 1.3) * 2 * u;
    line([shoulder, { x: shoulder.x - 9 * u + sway * 0.4, y: shoulder.y + 27 * u },
      { x: shoulder.x - 6 * u + sway, y: shoulder.y + 52 * u }], w);

    // head
    g.lineWidth = w;
    g.beginPath();
    g.arc(head.x, head.y, r, 0, Math.PI * 2);
    g.stroke();

    // eye: blinks now and then, closes contentedly while drawing on the vape
    const ex = head.x + r * 0.42;
    const ey = head.y - r * 0.18;
    const blink = (t % 3.7) < 0.12;
    g.fillStyle = INK;
    if (lift > 0.6) {
      g.lineWidth = Math.max(1, 1.6 * u);
      g.beginPath();
      g.arc(ex, ey - 1 * u, 3 * u, 0.15 * Math.PI, 0.85 * Math.PI);
      g.stroke();
    } else if (blink) {
      g.fillRect(ex - 3 * u, ey, 6 * u, Math.max(1, 1.4 * u));
    } else {
      g.beginPath();
      g.arc(ex, ey, Math.max(1.3, 2 * u), 0, Math.PI * 2);
      g.fill();
    }

    // vape: a small rounded bar in the preset colour, LED at the far end
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const back = { x: hand.x - dx * 9 * u, y: hand.y - dy * 9 * u };
    const front = { x: hand.x + dx * 19 * u, y: hand.y + dy * 19 * u };
    g.strokeStyle = `hsl(${hue} 85% 66%)`;
    line([back, front], Math.max(3, 5.5 * u));
    g.strokeStyle = '#000';
    line([{ x: hand.x + dx * 4 * u, y: hand.y + dy * 4 * u }, { x: hand.x + dx * 12 * u, y: hand.y + dy * 12 * u }], Math.max(1, 1.6 * u));
    const glow = 0.25 + display.env * 0.75;
    g.fillStyle = `hsla(${hue}, 100%, 75%, ${glow})`;
    g.beginPath();
    g.arc(front.x, front.y, Math.max(1.5, 2.6 * u), 0, Math.PI * 2);
    g.fill();
    if (display.env > 0.05) {
      g.strokeStyle = `hsla(${hue}, 100%, 75%, ${display.env * 0.6})`;
      g.lineWidth = 1;
      g.beginPath();
      g.arc(front.x, front.y, (4 + display.env * 5) * u, 0, Math.PI * 2);
      g.stroke();
    }

    // arm holding the vape (drawn last, over the bar)
    g.strokeStyle = INK;
    line([shoulder, elbow, hand], w);
    return front;
  }

  function spawn(x, y, u, kind) {
    if (particles.length >= 180) return;
    const big = kind === 'cloud';
    particles.push({
      x, y, kind,
      vx: (big ? 26 + Math.random() * 30 : 6 + Math.random() * 10) * u,
      vy: -(big ? 10 + Math.random() * 22 : 14 + Math.random() * 16) * u,
      age: 0,
      life: big ? 2.4 + Math.random() * 2.2 : 0.9 + Math.random() * 0.8,
      r0: (big ? 3 + Math.random() * 5 : 0.8 + Math.random() * 1.2) * u,
      grow: big ? 2.6 + Math.random() * 2 : 1,
      seed: Math.random() * 100,
      filled: !big || Math.random() < 0.18
    });
  }

  function stepParticles(dt, P, tip) {
    // vapour leaves the mouth while the sound plays; sparks rise from the LED
    // while the breath is coming in
    mouthAcc += (lift > 0.4 ? 0 : 1) * 26 * display.cloud * dt + 10 * display.cloud * dt;
    while (mouthAcc >= 1) { mouthAcc -= 1; spawn(P.mouth.x + 2 * P.u, P.mouth.y, P.u, 'cloud'); }
    tipAcc += 22 * display.env * dt;
    while (tipAcc >= 1) { tipAcc -= 1; spawn(tip.x, tip.y, P.u, 'spark'); }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) { particles.splice(i, 1); continue; }
      p.vx *= Math.exp(-dt * 0.35);
      p.vy -= 4 * P.u * dt;
      p.x += (p.vx + Math.sin(p.age * 2.1 + p.seed) * 8 * P.u) * dt;
      p.y += p.vy * dt;
    }
  }

  function drawParticles(hue) {
    for (const p of particles) {
      const k = p.age / p.life;
      const a = Math.sin(Math.PI * Math.min(1, k * 1.2)) * (p.kind === 'cloud' ? 0.85 : 0.9);
      if (a <= 0.01) continue;
      const rad = p.r0 * (1 + (p.grow - 1) * k);
      g.globalAlpha = a;
      g.beginPath();
      g.arc(p.x, p.y, rad, 0, Math.PI * 2);
      if (p.filled) {
        g.fillStyle = p.kind === 'cloud' ? `hsl(${hue} 85% 70%)` : INK;
        g.fill();
      } else {
        g.strokeStyle = `hsl(${hue} 85% 70%)`;
        g.lineWidth = 1.4;
        g.stroke();
      }
    }
    g.globalAlpha = 1;
  }

  function paint(now) {
    // Size is re-read every frame: the player can mount the page before its
    // iframe has a layout, and a 1 px backing store would render nothing.
    const rect = $('stage').getBoundingClientRect();
    if (Math.abs(rect.width - W) > 0.5 || Math.abs(rect.height - H) > 0.5) resizeCanvas();

    const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0.016;
    lastFrame = now;

    display.env += (meter.env - display.env) * Math.min(1, dt * 9);
    display.cloud += (meter.cloud - display.cloud) * Math.min(1, dt * 4);
    // the vape comes up quickly with the breath and goes down slowly after it
    const liftTarget = display.env > 0.08 ? 1 : 0;
    lift += (liftTarget - lift) * Math.min(1, dt * (liftTarget > lift ? 7 : 2.2));
    const hue = PRESETS[state.preset].hue;
    const t = now / 1000;

    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);

    const P = pose(t);
    drawGround(P);
    const tip = drawFigure(t, P, hue);
    stepParticles(dt, P, tip);
    drawParticles(hue);

    // input level: a row of OP-1 style segments under the ground line
    const lvl = Math.min(1, Math.max(meter.peak * 1.6, display.env * 0.7));
    const n = 24;
    const segW = (W * 0.5) / n;
    for (let i = 0; i < n; i++) {
      g.fillStyle = i / n < lvl ? `hsl(${hue} 85% 66%)` : '#1c1c1c';
      g.fillRect(W * 0.25 + i * segW, H - 12, segW - 2, 3);
    }
  }

  function draw(now) {
    try {
      paint(now);
    } catch (error) {
      notice('Render error: ' + (error && error.message ? error.message : error), true);
      return;
    }
    requestAnimationFrame(draw);
  }

  /* ── input ─────────────────────────────────────────────────────────── */
  function handleControl(e) {
    if (e.type === 'rotate') {
      const m = MACROS.find((x) => x.enc === e.control);
      if (m) change(m.id, e.delta / 120);
      return;
    }
    if (e.type === 'down') {
      const m = MACROS.find((x) => x.enc === e.control);
      if (m) {
        state.macros[m.id] = DEFAULTS[m.id];
        pushMacros(); updateMacros(); save();
        const cell = $('macro-' + m.id);
        cell.classList.add('touched');
        setTimeout(() => cell.classList.remove('touched'), 220);
        return;
      }
      if (e.control === 'K2') cyclePreset(1);
      if (e.control === 'K3') hold('K3', true);
      if (e.control === 'K4') setMuted(true);
    }
    if (e.type === 'up' || e.type === 'cancel') {
      if (e.control === 'K3') hold('K3', false);
      if (e.control === 'K4') setMuted(false);
    }
  }

  function wireTouch() {
    const stage = $('stage');
    stage.addEventListener('pointerdown', (ev) => {
      if (ev.target === $('start')) return;
      ev.preventDefault();
      stage.setPointerCapture(ev.pointerId);
      hold('stage', true);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      stage.addEventListener(type, () => hold('stage', false));
    }
    $('start').addEventListener('click', (ev) => {
      ev.stopPropagation();
      start();
    });
    $('preset').addEventListener('click', () => cyclePreset(1));

    const k2 = $('k2'), k3 = $('k3'), k4 = $('k4');
    k2.addEventListener('click', () => cyclePreset(1));
    k3.addEventListener('pointerdown', (ev) => { ev.preventDefault(); k3.setPointerCapture(ev.pointerId); hold('k3', true); });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      k3.addEventListener(type, () => hold('k3', false));
    }
    k4.addEventListener('pointerdown', (ev) => { ev.preventDefault(); k4.setPointerCapture(ev.pointerId); setMuted(true); });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      k4.addEventListener(type, () => setMuted(false));
    }
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */
  async function load() {
    try {
      const result = await sdk.data.get(SAVE_KEY);
      version = result.version;
      const value = result.value;
      if (value) {
        if (Number.isInteger(value.preset)) state.preset = clamp(value.preset, 0, PRESETS.length - 1);
        if (value.macros) {
          for (const m of MACROS) {
            if (Number.isFinite(value.macros[m.id])) state.macros[m.id] = clamp(value.macros[m.id]);
          }
        }
      }
    } catch (_) { /* first run */ }
  }

  async function init() {
    buildMacros();
    updateMacros();
    resizeCanvas();
    new ResizeObserver(resizeCanvas).observe($('stage'));
    wireTouch();
    sdk.controls.onEvent(handleControl);
    render();
    requestAnimationFrame(draw);
    await load();
    updateMacros();
    render();

    sdk.audio.onAvailable(() => {
      if (!preview && (phase === 'live' || phase === 'error')) void stop().then(start);
    });

    await sdk.ready();
    if (!preview) void start();
  }

  addEventListener('pagehide', () => { void stop(); });

  void init();
})();
