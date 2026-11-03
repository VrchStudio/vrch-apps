(() => {
  'use strict';

  const sdk = VrchApp;
  const $ = (id) => document.getElementById(id);
  const SAVE = 'wakegate';
  const KEYS = ['E1', 'K2', 'K3', 'K4'];
  const SYM = { E1: '◇', K2: '▲', K3: '●', K4: '■' };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad2 = (n) => String(n).padStart(2, '0');
  const ri = (n) => Math.floor(Math.random() * n);

  /* ── state ─────────────────────────────────────────────────────────── */
  const st = { hour: 7, minute: 0, enabled: false, volume: 0.7, gates: 3, lastWake: null };

  let version = 0, saveTimer = 0;
  let dueAt = 0, testAt = 0;

  let ringing = false, gateIdx = 0, gateTotal = 3;
  let seq = [], step = 0, showUntil = 0, seqHidden = false;
  let m = { a: 0, b: 0, c: 0, target: 0, val: 0 };
  const hold = { win: 50, tol: 6, val: 50, start: 0, ms: 0 };
  const pressed = new Set();
  let intensity = 1, penaltyUntil = 0, ringStart = 0, attempts = 0, lastInputAt = 0;

  let audio = null, audioWanted = null;

  /* ── helpers ───────────────────────────────────────────────────────── */
  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + pad2(s % 60);
  }
  function fmtSpan(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + pad2(ss) + 's' : ss + 's';
  }
  function shuffle(a) {
    const b = a.slice();
    for (let i = b.length - 1; i > 0; i--) { const j = ri(i + 1); [b[i], b[j]] = [b[j], b[i]]; }
    return b;
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const value = {
          v: 1, hour: st.hour, minute: st.minute, enabled: st.enabled,
          volume: st.volume, gates: st.gates, lastWake: st.lastWake
        };
        const r = await sdk.data.set(SAVE, value, { expectedVersion: version });
        version = r.version;
      } catch (_) { /* best effort */ }
    }, 500);
  }

  /* ── audio ─────────────────────────────────────────────────────────── */
  function ensureAudio() {
    if (audio) {
      if (audio.ctx.state !== 'running') void audio.ctx.resume().catch(() => {});
      return Promise.resolve(audio);
    }
    if (audioWanted) return audioWanted;
    audioWanted = (async () => {
      let ctx = null, out = null, outNode = null;
      try {
        ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive', sinkId: { type: 'none' } });
        await ctx.resume();
        out = await sdk.audio.openOutput({ channels: 2 });
        outNode = await out.createNode(ctx);
        const master = ctx.createGain();
        master.gain.value = 0;
        master.connect(outNode);
        audio = { ctx, master, out };
        return audio;
      } catch (err) {
        try { outNode?.disconnect(); } catch (_) { /* startup did not finish */ }
        await Promise.allSettled([out?.close(), ctx?.close()]);
        console.warn('audio unavailable', err);
        audioWanted = null;
        return null;
      }
    })();
    return audioWanted;
  }

  function beep(freq, dur, type, amp) {
    if (!audio) return;
    try {
      const { ctx, master } = audio;
      const t = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp || 0.2, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (_) { /* ignore */ }
  }

  /* ── ring voice: annoyed hardcore loop ─────────────────────────────── */
  const HC = { bpm: [158, 170, 184], root: 55 };
  const curveCache = new Map();
  let noiseBuf = null;
  let hcStep = 0, hcNext = 0;

  function driveCurve(k) {
    const key = Math.round(k * 2) / 2;
    const hit = curveCache.get(key);
    if (hit) return hit;
    const n = 1024;
    const c = new Float32Array(n);
    const norm = 1 / Math.tanh(key);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(key * x) * norm;
    }
    curveCache.set(key, c);
    return c;
  }

  function shaper(drive) {
    const w = audio.ctx.createWaveShaper();
    w.curve = driveCurve(drive);
    w.oversample = '2x';
    return w;
  }

  function noiseSrc() {
    const { ctx } = audio;
    if (!noiseBuf) {
      const n = Math.floor(ctx.sampleRate * 1.5);
      noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      let seed = 22222;
      for (let i = 0; i < n; i++) {
        seed = (seed * 16807) % 2147483647;
        d[i] = seed / 1073741823.5 - 1;
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    return src;
  }

  /** distorted four-on-the-floor kick */
  function kick(t, lvl) {
    const { ctx, master } = audio;
    const o = ctx.createOscillator();
    const sh = shaper(3 + lvl * 2);
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(190 + lvl * 24, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.1);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.85, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(sh);
    sh.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + 0.32);

    const n = noiseSrc(), hp = ctx.createBiquadFilter(), ng = ctx.createGain();
    hp.type = 'highpass';
    hp.frequency.value = 1400;
    ng.gain.setValueAtTime(0.3, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.018);
    n.connect(hp);
    hp.connect(ng);
    ng.connect(master);
    n.start(t);
    n.stop(t + 0.03);
  }

  /** clipped snare with a short body */
  function snare(t, lvl) {
    const { ctx, master } = audio;
    const n = noiseSrc(), bp = ctx.createBiquadFilter(), sh = shaper(4 + lvl), g = ctx.createGain();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 1.1;
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    n.connect(bp);
    bp.connect(sh);
    sh.connect(g);
    g.connect(master);
    n.start(t);
    n.stop(t + 0.17);

    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(230, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.07);
    og.gain.setValueAtTime(0.24, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(og);
    og.connect(master);
    o.start(t);
    o.stop(t + 0.1);
  }

  function hat(t, open, lvl) {
    const { ctx, master } = audio;
    const n = noiseSrc(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
    hp.type = 'highpass';
    hp.frequency.value = 8200;
    g.gain.setValueAtTime((open ? 0.17 : 0.1) + lvl * 0.02, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.1 : 0.03));
    n.connect(hp);
    hp.connect(g);
    g.connect(master);
    n.start(t);
    n.stop(t + (open ? 0.11 : 0.04));
  }

  /** dissonant detuned saw stab, the hook that refuses to resolve */
  function stab(t, freqs, lvl) {
    const { ctx, master } = audio;
    const sh = shaper(6 + lvl * 1.5);
    const lp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    lp.type = 'lowpass';
    lp.Q.value = 9;
    lp.frequency.setValueAtTime(4600, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.15);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.19);
    lp.connect(g);
    g.connect(master);
    for (const f of freqs) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.94, t + 0.17);
      o.connect(sh);
      o.start(t);
      o.stop(t + 0.21);
    }
    sh.connect(lp);
  }

  /** saw bass tucked behind the kick */
  function bass(t, f, lvl) {
    const { ctx, master } = audio;
    const o = ctx.createOscillator(), sh = shaper(5);
    const lp = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f, t);
    lp.type = 'lowpass';
    lp.frequency.value = 520 + lvl * 220;
    lp.Q.value = 6;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.34, t + 0.035);
    g.gain.exponentialRampToValueAtTime(0.004, t + 0.12);
    o.connect(sh);
    sh.connect(lp);
    lp.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + 0.14);
  }

  function screech(t, lvl) {
    const { ctx, master } = audio;
    const o = ctx.createOscillator(), sh = shaper(9), g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(1800, t);
    o.frequency.exponentialRampToValueAtTime(380, t + 0.2);
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(sh);
    sh.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + 0.24);
  }

  /** one 16-step bar of hardcore, lvl 1-3 */
  function playStep(i, t, lvl) {
    if (!audio) return;
    const bar = i % 16;
    if (bar % 4 === 0) {
      kick(t, lvl);
      bass(t, bar >= 8 ? HC.root * 1.06 : HC.root, lvl);
    }
    if (bar === 4 || bar === 12) snare(t, lvl);
    if (bar % 4 === 2) {
      hat(t, true, lvl);
      stab(t, bar >= 8 ? [246.94, 261.63, 369.99] : [220, 233.08, 311.13], lvl);
    } else if (lvl >= 2 && bar % 2 === 1) {
      hat(t, false, lvl);
    }
    if (lvl === 3 && bar === 15) screech(t, lvl);
  }

  function resetMusic() {
    hcStep = 0;
    hcNext = 0;
  }

  function scheduleMusic() {
    if (!ringing || !audio) return;
    const { ctx } = audio;
    if (ctx.state !== 'running') { void ctx.resume().catch(() => {}); return; }
    const bpm = HC.bpm[Math.min(3, intensity) - 1];
    const sixteenth = 60 / bpm / 4;
    if (!hcNext || hcNext < ctx.currentTime - 0.1) hcNext = ctx.currentTime + 0.05;
    while (hcNext < ctx.currentTime + 0.14) {
      playStep(hcStep, hcNext, intensity);
      hcNext += sixteenth;
      hcStep = (hcStep + 1) % 16;
    }
  }

  async function armAudio() {
    await ensureAudio();
    if (!audio) return;
    const { ctx, master } = audio;
    await ctx.resume().catch(() => {});
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(Math.max(0, master.gain.value), t);
    master.gain.linearRampToValueAtTime(st.volume * (0.55 + 0.15 * intensity), t + 0.3);
    resetMusic();
  }

  function silence() {
    if (!audio) return;
    try {
      const { ctx, master } = audio;
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(Math.max(0, master.gain.value), ctx.currentTime);
      master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.12);
    } catch (_) { /* ignore */ }
  }

  /* ── rendering ─────────────────────────────────────────────────────── */
  function renderSet() {
    $('setView').hidden = false;
    $('ringView').hidden = true;
    $('ringView').classList.remove('alert');
    $('alarmTime').textContent = pad2(st.hour) + ':' + pad2(st.minute);
    $('alarmTime').classList.toggle('off', !st.enabled);
    $('setStatus').classList.toggle('on', st.enabled);
    $('statusText').textContent = st.enabled ? 'Alarm enabled' : 'Alarm disabled';
    $('rv1').textContent = pad2(st.hour);
    $('rv2').textContent = pad2(st.minute);
    $('rv3').textContent = Math.round(st.volume * 100) + '%';
    $('rv4').textContent = st.gates + ' gates';
    $('lastWake').textContent = st.lastWake
      ? 'Last wake ' + new Date(st.lastWake.at).toTimeString().slice(0, 5) + ' · Duration ' +
        fmtDur(st.lastWake.secs * 1000) + ' · Errors ' + st.lastWake.attempts + ''
      : '';
    if (testAt) $('countdown').textContent = 'Test rings in ' + Math.max(0, Math.ceil((testAt - Date.now()) / 1000)) + ' seconds';
    updateMonitor();
  }

  function gauge(i, label, inner) {
    return '<div class="gauge"><div class="lab"><span>' + label + '</span><span id="gv' + i + '"></span></div>' +
      '<div class="track"><div class="fill" id="gf' + i + '"></div>' + (inner || '') + '</div></div>';
  }

  function renderTask() {
    const now = Date.now();
    const g = $('gauges');
    $('ringView').classList.toggle('alert', intensity >= 2);
    $('gateLabel').textContent = 'Gate ' + gateIdx + ' / ' + gateTotal;

    if (gateIdx === 1) {
      $('taskMain').className = 'task';
      if (now < showUntil) {
        $('taskMain').textContent = seq.map((k) => SYM[k]).join('  ');
        $('taskSub').textContent = 'Remember this order: ' + Math.ceil((showUntil - now) / 1000) + 's remaining';
      } else {
        $('taskMain').textContent = seq.map((_, i) => (i < step ? '✓' : '?')).join('  ');
        $('taskSub').textContent = 'Press key ' + (step + 1) + ' in the sequence';
      }
      g.innerHTML = '';
      $('ringHint').textContent = '◇ E1　▲ K2　● K3　■ K4';
    } else if (gateIdx === 2) {
      $('taskMain').className = 'task';
      $('taskMain').textContent = m.a + ' × ' + m.b + ' + ' + m.c + ' = ?';
      $('taskSub').textContent = 'Turn E1, then press E1 · Now ' + m.val;
      g.innerHTML = '';
      $('ringHint').textContent = 'Multiply before adding. A wrong answer restarts the gate.';
    } else {
      $('taskMain').className = 'task small';
      $('taskMain').textContent = 'Hold K2 + K4';
      $('taskSub').textContent = 'Keep E2 at ' + hold.win + ' ± ' + hold.tol + ' for 6 seconds';
      const left = clamp(hold.win - hold.tol, 0, 100);
      const width = clamp(2 * hold.tol, 1, 100);
      const band = '<span class="band" style="left:' + left + '%;width:' + width + '%"></span>';
      g.innerHTML = gauge(0, 'Hold time', '') + gauge(1, 'E2 position', band + '<span class="mark" id="gm1"></span>');
      $('ringHint').textContent = 'Releasing either key resets the gate.';
    }
    updateMonitor();
  }

  function dyn(now) {
    $('ringTimer').textContent = fmtDur(now - ringStart);
    const p = $('penalty');
    if (penaltyUntil > now) {
      p.hidden = false;
      p.textContent = 'Try again in ' + Math.ceil((penaltyUntil - now) / 1000) + ' seconds';
    } else {
      p.hidden = true;
    }

    if (gateIdx === 3) {
      const f = $('gf0'), v = $('gv0'), mark = $('gm1'), v1 = $('gv1');
      if (f) f.style.width = clamp(hold.ms / 6000, 0, 1) * 100 + '%';
      if (v) v.textContent = (hold.ms / 1000).toFixed(1) + ' s';
      if (mark) mark.style.left = hold.val + '%';
      if (v1) v1.textContent = Math.round(hold.val) + ' / Target ' + hold.win;
    }

    if (gateIdx === 1 && !seqHidden && now >= showUntil) { seqHidden = true; renderTask(); }
  }

  function updateMonitor() {
    try {
      const v = {};
      if (!ringing) {
        v.E1 = { label: 'Hour', value: pad2(st.hour) };
        v.E2 = { label: 'Minute', value: pad2(st.minute) };
        v.E3 = { label: 'Volume', value: Math.round(st.volume * 100) + '%' };
        v.E4 = { label: 'Gates', value: st.gates + '' };
        v.K2 = { label: st.enabled ? 'Disable' : 'Enable', pressed: st.enabled };
        v.K3 = { label: '10s test' };
        v.K4 = { label: 'Audition' };
      } else if (gateIdx === 1) {
        v.E1 = { label: SYM.E1, value: 'Order' };
        v.K2 = { label: SYM.K2 };
        v.K3 = { label: SYM.K3 };
        v.K4 = { label: SYM.K4 };
      } else if (gateIdx === 2) {
        v.E1 = { label: 'Answer', value: String(m.val) };
      } else {
        v.E2 = { label: 'Position', value: String(Math.round(hold.val)) };
        v.K2 = { label: 'Hold', pressed: pressed.has('K2') };
        v.K4 = { label: 'Hold', pressed: pressed.has('K4') };
      }
      void sdk.monitor.set(v).catch(() => {});
    } catch (_) { /* ignore */ }
  }

  /* ── alarm lifecycle ───────────────────────────────────────────────── */
  function nextDue() {
    if (!st.enabled) return 0;
    const d = new Date();
    d.setHours(st.hour, st.minute, 0, 0);
    let t = d.getTime();
    if (t <= Date.now()) t += 86400000;
    return t;
  }

  async function startRing() {
    if (ringing) return;
    ringing = true;
    testAt = 0;
    ringStart = Date.now();
    intensity = 1;
    penaltyUntil = 0;
    attempts = 0;
    lastInputAt = Date.now();
    gateTotal = clamp(st.gates, 1, 3);
    seqHidden = false;
    $('setView').hidden = true;
    $('ringView').hidden = false;
    beginGate(1);
    await armAudio();
    if (!audio) $('ringHint').textContent = 'No audio output. Choose OUT in the K1 Menu.';
  }

  function beginGate(n) {
    gateIdx = n;
    pressed.clear();
    seqHidden = false;
    if (n === 1) {
      seq = shuffle(KEYS).slice(0, 3);
      step = 0;
      showUntil = Math.max(Date.now(), penaltyUntil) + 2800;
    } else if (n === 2) {
      m.a = 3 + ri(7);
      m.b = 3 + ri(7);
      m.c = 1 + ri(9);
      m.target = m.a * m.b + m.c;
      let v = m.target, guard = 0;
      while (Math.abs(v - m.target) < 6 && guard++ < 40) {
        v = clamp(m.target + (ri(2) ? 1 : -1) * (6 + ri(14)), 0, 120);
      }
      m.val = v;
    } else {
      hold.win = 32 + ri(37);
      hold.tol = 6;
      hold.val = clamp(hold.win + (ri(2) ? 1 : -1) * (10 + ri(14)), 0, 100);
      hold.start = 0;
      hold.ms = 0;
    }
    renderTask();
  }

  function pass() {
    beep(1320, 0.16, 'sine', 0.22);
    if (gateIdx >= gateTotal) { finish(); return; }
    beginGate(gateIdx + 1);
  }

  function fail() {
    attempts++;
    penaltyUntil = Date.now() + 8000;
    intensity = Math.min(3, intensity + 1);
    beep(140, 0.3, 'sawtooth', 0.3);
    beginGate(gateIdx);
    if (audio) {
      const t = audio.ctx.currentTime;
      audio.master.gain.cancelScheduledValues(t);
      audio.master.gain.setValueAtTime(Math.max(0, audio.master.gain.value), t);
      audio.master.gain.linearRampToValueAtTime(st.volume * (0.55 + 0.15 * intensity), t + 0.2);
    }
    $('ringView').classList.add('alert');
  }

  function finish() {
    const secs = Math.round((Date.now() - ringStart) / 1000);
    ringing = false;
    gateIdx = 0;
    silence();
    st.lastWake = { at: Date.now(), secs, attempts };
    dueAt = nextDue();
    save();
    renderSet();
  }

  function tickHold(now) {
    if (now < penaltyUntil) { hold.start = 0; hold.ms = 0; return; }
    if (!(pressed.has('K2') && pressed.has('K4'))) { hold.start = 0; hold.ms = 0; return; }
    if (!hold.start) hold.start = now;
    hold.ms = now - hold.start;
    if (Math.abs(hold.val - hold.win) > hold.tol) { fail(); return; }
    if (hold.ms >= 6000) pass();
  }

  /* ── input ─────────────────────────────────────────────────────────── */
  const acc = {};
  function detent(e) {
    const k = e.control;
    acc[k] = (acc[k] || 0) + e.delta;
    const steps = Math.trunc(acc[k] / 2);
    acc[k] -= steps * 2;
    return steps;
  }

  function onEvent(e) {
    void ensureAudio();
    if (e.type === 'down' || e.type === 'rotate') lastInputAt = Date.now();
    if (e.type === 'rotate') { onRotate(e); return; }
    if (e.type === 'up') {
      if (e.control === 'K2' || e.control === 'K4') pressed.delete(e.control);
      return;
    }
    if (e.type !== 'down') return;

    if (ringing) {
      if (Date.now() < penaltyUntil) return;
      if (gateIdx === 1) gate1Press(e.control);
      else if (gateIdx === 2) gate2Press(e.control);
      else if (gateIdx === 3 && (e.control === 'K2' || e.control === 'K4')) {
        pressed.add(e.control);
        updateMonitor();
      }
    } else {
      onSetKey(e.control);
    }
  }

  function gate1Press(k) {
    if (Date.now() < showUntil) return;
    if (k !== seq[step]) { fail(); return; }
    step++;
    beep(1180, 0.1, 'sine', 0.16);
    if (step >= seq.length) pass(); else renderTask();
  }

  function gate2Press(k) {
    if (k !== 'E1') return;
    if (m.val === m.target) pass(); else fail();
  }

  function onRotate(e) {
    if (!ringing) { setRotate(e); return; }
    if (Date.now() < penaltyUntil) return;
    const d = detent(e);
    if (!d) return;
    if (gateIdx === 2 && e.control === 'E1') {
      m.val = clamp(m.val + d, 0, 150);
      $('taskSub').textContent = 'Turn E1, then press E1 · Now ' + m.val;
      updateMonitor();
    } else if (gateIdx === 3 && e.control === 'E2') {
      hold.val = clamp(hold.val + d * 1.2, 0, 100);
    }
  }

  function setRotate(e) {
    const d = Math.round(e.delta);
    if (!d) return;
    if (e.control === 'E1') st.hour = (st.hour + d + 24) % 24;
    else if (e.control === 'E2') st.minute = (st.minute + d + 60) % 60;
    else if (e.control === 'E3') st.volume = clamp(st.volume + d * 0.02, 0.1, 1);
    else if (e.control === 'E4') st.gates = clamp(st.gates + Math.sign(d), 1, 3);
    dueAt = nextDue();
    save();
    renderSet();
  }

  function onSetKey(k) {
    if (k === 'K2') {
      st.enabled = !st.enabled;
      dueAt = nextDue();
      save();
      renderSet();
    } else if (k === 'K3') {
      testAt = Date.now() + 10000;
      renderSet();
    } else if (k === 'K4') {
      void previewTone();
    }
  }

  async function previewTone() {
    await ensureAudio();
    if (!audio) return;
    try {
      const { ctx, master } = audio;
      await ctx.resume().catch(() => {});
      const t0 = ctx.currentTime + 0.04;
      const sixteenth = 60 / HC.bpm[0] / 4;
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(st.volume * 0.55, ctx.currentTime);
      for (let i = 0; i < 16; i++) playStep(i, t0 + i * sixteenth, 1);
      master.gain.setTargetAtTime(0, t0 + 16 * sixteenth + 0.05, 0.06);
    } catch (_) { /* ignore */ }
  }

  /* ── main loop ─────────────────────────────────────────────────────── */
  function updateCountdown(now) {
    const el = $('countdown');
    if (testAt) {
      el.textContent = 'Test rings in ' + Math.max(0, Math.ceil((testAt - now) / 1000)) + ' seconds';
      return;
    }
    if (!st.enabled) { el.textContent = '—'; return; }
    el.textContent = 'Alarm in ' + fmtSpan(dueAt - now);
  }

  function tick() {
    const now = Date.now();
    $('clock').textContent = pad2(new Date().getHours()) + ':' + pad2(new Date().getMinutes());
    if (ringing) {
      dyn(now);
      if (now - lastInputAt > 20000) {
        lastInputAt = now;
        if (intensity < 3) {
          intensity++;
          if (audio) {
            const t = audio.ctx.currentTime;
            audio.master.gain.cancelScheduledValues(t);
            audio.master.gain.setValueAtTime(Math.max(0, audio.master.gain.value), t);
            audio.master.gain.linearRampToValueAtTime(st.volume * (0.55 + 0.15 * intensity), t + 0.3);
          }
          $('ringView').classList.add('alert');
        }
      }
      if (gateIdx === 3) tickHold(now);
    } else {
      const at = testAt || dueAt;
      if (at && now >= at) { void startRing(); return; }
      updateCountdown(now);
    }
  }

  function fit() {
    document.body.classList.toggle('compact', window.innerHeight < 455);
  }

  /* ── boot ──────────────────────────────────────────────────────────── */
  async function load() {
    try {
      const r = await sdk.data.get(SAVE);
      version = r.version;
      const v = r.value;
      if (v && v.v === 1) {
        st.hour = clamp(v.hour | 0, 0, 23);
        st.minute = clamp(v.minute | 0, 0, 59);
        st.enabled = !!v.enabled;
        st.volume = clamp(Number(v.volume) || 0.7, 0.1, 1);
        st.gates = clamp((v.gates | 0) || 3, 1, 3);
        st.lastWake = v.lastWake || null;
      }
    } catch (_) { /* first run */ }
  }

  async function init() {
    fit();
    addEventListener('resize', fit);
    renderSet();
    await load();
    dueAt = nextDue();
    renderSet();
    sdk.controls.onEvent(onEvent);
    addEventListener('pagehide', () => silence());
    setInterval(scheduleMusic, 60);
    setInterval(tick, 100);
    await sdk.ready();
  }

  void init();
})();
