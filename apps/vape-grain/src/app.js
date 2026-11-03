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

  const state = { preset: 0, macros: { ...DEFAULTS }, figure: 'cat' };
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
        const result = await sdk.data.set(SAVE_KEY, { preset: state.preset, macros: { ...state.macros }, figure: state.figure }, { expectedVersion: version });
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
      // the chord bed, then the single-E note the player reads
      for (const type of ['bed', 'note']) {
        const key = sr + ':' + index + ':' + type;
        let buf = bedCache.get(key);
        if (!buf) {
          const job = lib.createBedJob(lib.PRESETS[index], sr, type === 'note');
          while (!lib.stepBedJob(job, 150000)) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (token !== epoch) return;
          }
          buf = job.buf;
          bedCache.set(key, buf);
        }
        e.node.port.postMessage({ type, index, buf });
      }
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
      e.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive', sinkId: { type: 'none' } });
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
              : 'Audio did not start. Choose Retry.',
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
    $('figure').textContent = state.figure === 'cat' ? 'CAT' : 'MAN';
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

  function toggleFigure() {
    state.figure = state.figure === 'cat' ? 'stick' : 'cat';
    particles.length = 0;
    render();
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

  /* ── canvas: a kitten with a vape ─────────────────────────────────────
   * Unfilled line art in the manner of a Teenage Engineering screen: one
   * line weight, circles and straight lines, filling the stage, the
   * preset colour only on the vape's LED and the vapour. The kitten sits,
   * lifts the vape to its mouth while you breathe (eyes flat, LED lit) and
   * blows rings as the sound rings out.                                    */
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

  /** Key points of the figure for this frame, in canvas pixels. A close-up:
   *  head and shoulders fill the stage, the torso runs off the bottom. */
  function pose(t) {
    const u = Math.min(W / 480, H / 320);
    const k = ease(lift);
    // the kitten spans about x -112..70 and y -70..152 in its own units;
    // scale it to fill the stage, sitting on the bottom edge
    const S = Math.min(H / 236, W / 196);
    const bob = Math.sin(t * 1.8) * 1.2;
    // drawing space: origin at the centre of the head, one unit = S pixels
    const ox = W / 2 + 21 * S, oy = H - 4 - 152 * S + bob * S;
    const local = (x, y) => ({ x: ox + x * S, y: oy + y * S });
    const mouthL = { x: 0, y: 20 };
    const handL = { x: lerp(18, 24, k), y: lerp(116, 21, k) };
    const elbowL = { x: lerp(34, 54, k), y: lerp(96, 60, k) };
    const angle = lerp(-Math.PI / 2, -Math.PI, k);
    return { u, S, k, ox, oy, local, mouthL, handL, elbowL, angle, mouth: local(mouthL.x, mouthL.y) };
  }

  /** A line-art capsule: two parallel outlines with black between them. */
  function tube(draw, width, lw) {
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = INK;
    g.lineWidth = width;
    g.beginPath(); draw(); g.stroke();
    g.strokeStyle = '#000';
    g.lineWidth = width - 2 * lw;
    g.beginPath(); draw(); g.stroke();
  }

  /** Rounded rectangle path (no reliance on ctx.roundRect). */
  function rrect(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* A geometric kitten, OP-1 style: circles, straight lines and one line
   * weight, drawn in head-centred units. */
  function drawFigure(t, P, hue) {
    const { S, k, ox, oy, mouthL, handL, elbowL, angle } = P;
    const lw = 1.5;
    const accent = `hsl(${hue} 85% 66%)`;
    g.save();
    g.translate(ox, oy);
    g.scale(S, S);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = INK;
    g.lineWidth = lw;
    g.fillStyle = '#000';

    // while vaping (and blowing it out) the kitten sways side to side,
    // pivoting on where it sits
    const swayAmt = Math.max(k, Math.min(1, display.cloud * 1.5));
    const rock = Math.sin(t * 2.4) * 0.07 * swayAmt;
    const pivot = { x: 0, y: 152 };
    const rot = (x, y) => {
      const c = Math.cos(rock), s = Math.sin(rock), dx = x - pivot.x, dy = y - pivot.y;
      return { x: pivot.x + dx * c - dy * s, y: pivot.y + dx * s + dy * c };
    };
    g.translate(pivot.x, pivot.y);
    g.rotate(rock);
    g.translate(-pivot.x, -pivot.y);

    // tail: a quarter circle and a half circle, swinging slowly
    const sw = Math.sin(t * 1.4) * 0.18;
    g.save();
    g.translate(-52, 148);
    g.rotate(-sw);
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(-30, 0, 30, 0, -Math.PI / 2, true);
    g.arc(-30, -45, 15, Math.PI / 2, -Math.PI / 2, false);
    g.stroke();
    g.restore();

    // sitting body: arched back into a round haunch, chest dropping to the
    // front paws; filled black so the tail tucks in behind it
    g.beginPath();
    g.moveTo(-18, 52);
    g.bezierCurveTo(-36, 64, -58, 94, -58, 122);
    g.bezierCurveTo(-58, 144, -48, 152, -34, 152);
    g.lineTo(10, 152);
    g.bezierCurveTo(12, 112, 30, 86, 18, 52);
    g.closePath();
    g.fill();
    g.stroke();
    // thigh line across the haunch
    g.beginPath();
    g.moveTo(-30, 98);
    g.bezierCurveTo(-52, 106, -52, 140, -36, 150);
    g.stroke();
    // hind paw
    g.beginPath(); g.ellipse(-44, 150, 12, 4, 0, Math.PI, 0); g.stroke();
    // standing front leg in front of the haunch, with a paw and two toes
    g.beginPath(); g.rect(-21, 94, 15, 56); g.fill();
    g.beginPath(); g.moveTo(-21, 98); g.lineTo(-21, 148); g.moveTo(-6, 102); g.lineTo(-6, 148); g.stroke();
    g.beginPath(); g.ellipse(-13, 149, 10, 4.5, 0, Math.PI, 0); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(-16, 146); g.lineTo(-16, 150); g.moveTo(-10, 146); g.lineTo(-10, 150); g.stroke();
    // chest fluff
    g.beginPath();
    g.moveTo(-8, 60); g.lineTo(-4, 70); g.lineTo(0, 62); g.lineTo(4, 72); g.lineTo(8, 62); g.lineTo(11, 70);
    g.moveTo(-2, 78); g.lineTo(2, 86); g.lineTo(6, 78);
    g.stroke();
    // neck
    g.beginPath();
    g.moveTo(-14, 36); g.quadraticCurveTo(-15, 46, -18, 54);
    g.moveTo(14, 36); g.quadraticCurveTo(15, 46, 18, 54);
    g.stroke();

    // head: a classic cartoon cat silhouette, wider than tall, ears grown
    // out of the outline, a flat brow between them and tufted cheeks; one
    // ear flicks now and then
    const flick = (t % 5.3) < 0.2 ? Math.sin((t % 5.3) * 45) * 4 : 0;
    g.beginPath();
    g.moveTo(0, 40);
    g.quadraticCurveTo(-34, 42, -50, 26);
    g.lineTo(-62, 22);
    g.lineTo(-53, 14);
    g.quadraticCurveTo(-58, -6, -50, -22);
    g.lineTo(-58, -68);
    g.lineTo(-24, -38);
    g.quadraticCurveTo(0, -44, 24, -38);
    g.lineTo(58 + flick, -68);
    g.lineTo(50, -22);
    g.quadraticCurveTo(58, -6, 53, 14);
    g.lineTo(62, 22);
    g.lineTo(50, 26);
    g.quadraticCurveTo(34, 42, 0, 40);
    g.closePath();
    g.fill();
    g.stroke();
    // inner ears and three tabby stripes on the brow
    g.beginPath();
    g.moveTo(-47, -30); g.lineTo(-52, -56); g.lineTo(-32, -38);
    g.moveTo(47, -30); g.lineTo(52 + flick * 0.8, -56); g.lineTo(32, -38);
    g.moveTo(-8, -40); g.lineTo(-7, -30);
    g.moveTo(0, -41); g.lineTo(0, -28);
    g.moveTo(8, -40); g.lineTo(7, -30);
    g.stroke();

    // eyes: dots that blink; flat dashes while drawing on the vape
    const blink = (t % 3.9) < 0.12;
    for (const ex of [-20, 20]) {
      if (k > 0.6 || blink) {
        g.beginPath(); g.moveTo(ex - 6, 0); g.lineTo(ex + 6, 0); g.stroke();
      } else {
        g.beginPath(); g.arc(ex + 2 * k, 1, 5, 0, Math.PI * 2); g.stroke();
        g.fillStyle = INK;
        g.beginPath(); g.arc(ex + 1 + 2 * k, 1.5, 2, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#000';
      }
    }

    // nose, mouth, whiskers
    g.beginPath(); g.moveTo(-3.5, 11); g.lineTo(3.5, 11); g.lineTo(0, 15); g.closePath(); g.stroke();
    const m = mouthL;
    if (k > 0.5) {
      g.beginPath(); g.arc(m.x, m.y + 1, 2.5, 0, Math.PI * 2); g.stroke();
    } else if (display.cloud > 0.12) {
      g.beginPath(); g.arc(m.x, m.y + 1, 3.5, 0, Math.PI * 2); g.stroke();
    } else {
      g.beginPath();
      g.moveTo(0, 15); g.lineTo(0, 18);
      g.arc(-3.5, 18, 3.5, 0, Math.PI);
      g.moveTo(7, 18); g.arc(3.5, 18, 3.5, 0, Math.PI);
      g.stroke();
    }
    const wv = Math.sin(t * 3) * 1.2;
    g.beginPath();
    for (const s of [-1, 1]) {
      for (const dy of [-4, 2, 8]) {
        g.moveTo(s * 30, 14 + dy * 0.4);
        g.lineTo(s * 66, 10 + dy * 1.6 + wv);
      }
    }
    g.stroke();

    // the raised front leg: a capsule from the shoulder via the elbow
    tube(() => {
      g.moveTo(16, 64);
      g.lineTo(elbowL.x, elbowL.y);
      g.lineTo(handL.x, handL.y);
    }, 14, lw);

    // vape: a rounded-rectangle device with a mouthpiece and an LED dot in
    // the preset colour, OP-1 style
    g.strokeStyle = INK;
    g.lineWidth = lw;
    g.save();
    g.translate(handL.x, handL.y);
    g.rotate(angle);
    // device body runs along -x from the paw, mouthpiece along +x
    rrect(-30, -6, 34, 12, 6); g.fill(); g.stroke();
    rrect(4, -3, 14, 6, 3); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(-14, -6); g.lineTo(-14, 6); g.stroke();
    g.fillStyle = `hsla(${hue}, 100%, 70%, ${0.3 + display.env * 0.7})`;
    g.beginPath(); g.arc(-22, 0, 2.4, 0, Math.PI * 2); g.fill();
    if (display.env > 0.05) {
      g.strokeStyle = accent;
      g.globalAlpha = display.env * 0.7;
      g.lineWidth = 1;
      g.beginPath(); g.arc(-22, 0, 5 + display.env * 6, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
      g.strokeStyle = INK;
      g.lineWidth = lw;
    }
    g.restore();
    const ledL = { x: handL.x + Math.cos(angle) * -22, y: handL.y + Math.sin(angle) * -22 };

    // paw wrapped round the device
    g.fillStyle = '#000';
    g.strokeStyle = INK;
    g.beginPath(); g.arc(handL.x, handL.y, 7.5, 0, Math.PI * 2); g.fill(); g.stroke();
    g.beginPath();
    g.moveTo(handL.x - 2.5, handL.y - 7); g.lineTo(handL.x - 2.5, handL.y - 3);
    g.moveTo(handL.x + 2.5, handL.y - 7); g.lineTo(handL.x + 2.5, handL.y - 3);
    g.stroke();
    g.restore();
    // vapour leaves the swaying mouth
    const mw = rot(mouthL.x, mouthL.y);
    P.mouth = P.local(mw.x, mw.y);
    const lw2 = rot(ledL.x, ledL.y);
    return P.local(lw2.x, lw2.y);
  }

  /* ── the stick figure (OP-1 style) ─────────────────────────────────── */

  /** Stick figure joint positions for this frame, in canvas pixels. */
  function poseStick(t) {
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

  function drawStick(t, P, hue) {
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
      if (p.kind === 'cloud') {
        // line-art puff: an outline ring
        g.strokeStyle = `hsla(${hue}, 70%, 88%, 0.9)`;
        g.lineWidth = 1.2;
        g.stroke();
      } else {
        g.fillStyle = '#fff';
        g.fill();
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
    const liftTarget = display.env > 0.15 ? 1 : 0;
    lift += (liftTarget - lift) * Math.min(1, dt * (liftTarget > lift ? 7 : 2.2));
    const hue = PRESETS[state.preset].hue;
    const t = now / 1000;

    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);

    // the cat or the stick figure, switched with a long K2 or the bar button
    let P, tip;
    if (state.figure === 'stick') {
      P = poseStick(t);
      drawGround(P);
      tip = drawStick(t, P, hue);
    } else {
      P = pose(t);
      tip = drawFigure(t, P, hue);
    }
    stepParticles(dt, P, tip);
    drawParticles(hue);

    // input level: a row of OP-1 style segments in the lower right corner
    const lvl = Math.min(1, Math.max(meter.peak * 1.6, display.env * 0.7));
    const n = 16;
    const segW = (W * 0.26) / n;
    for (let i = 0; i < n; i++) {
      g.fillStyle = i / n < lvl ? `hsl(${hue} 85% 66%)` : '#1c1c1c';
      g.fillRect(W * 0.7 + i * segW, H - 12, segW - 2, 3);
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
  const K2_LONG_MS = 600;
  let k2Timer = 0;
  let k2Long = false;

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
      if (e.control === 'K2') {
        // short press: next preset (on release); hold: switch cat / stick figure
        clearTimeout(k2Timer);
        k2Long = false;
        k2Timer = setTimeout(() => { k2Long = true; toggleFigure(); }, K2_LONG_MS);
      }
      if (e.control === 'K3') hold('K3', true);
      if (e.control === 'K4') setMuted(true);
    }
    if (e.type === 'up' || e.type === 'cancel') {
      if (e.control === 'K2' && k2Timer) {
        clearTimeout(k2Timer);
        k2Timer = 0;
        if (!k2Long && e.type === 'up') cyclePreset(1);
      }
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
    $('figure').addEventListener('click', toggleFigure);

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
        if (value.figure === 'stick' || value.figure === 'cat') state.figure = value.figure;
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
