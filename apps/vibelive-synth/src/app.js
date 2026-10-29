// VibeLive Synth — device half.
//
// The VRCH device is the instrument: this App owns the UI, the encoders/keys
// and the audio clock. The MacBook (run_synth.py --vrch ...) owns the AI: it
// renders each 4-bar loop with Stable Audio 3 and turns vibes into patches
// with Ollama. Both meet on the device's vrch-ws relay (json channel CHANNEL).
//
// Nothing on the beat path waits for the network. The Mac ships finished loops
// (Ogg Opus, padded with their own wrap-around audio); each is decoded here,
// cropped to the exact loop length and scheduled on this 48 kHz AudioContext:
// every loop plays with loop=true from a shared grid origin, and a new loop is
// blended in at the next beat (or loop, for shuffle) with a constant-time
// equal-power crossfade, so the 16-beat grid never drifts or loses a beat.
// Knob moves are sent as intent; the Mac re-renders and the result fades in.
//
// Holding K2 records the room (VrchApp audio input) into a second,
// loop-length layer that plays from the same grid origin, so a take loops in
// time with every generated loop; E4 crossfades between the two. On release the
// take also goes to the Mac, whose renders from then on rewrite what is heard:
// the loop and take at the BLEND mix.
'use strict';
(() => {
  const CHANNEL = 7;             // keep in sync with config.yaml vrch.channel and app.json
  const SR = 48000;
  const XF = 0.5;                // crossfade length (s) = one beat at 120 BPM
  const LEAD = 0.06;             // minimum scheduling lead (s)
  const SLOTS = 8;
  const MAC_TIMEOUT = 2500;      // ms without a Mac frame before the link shows offline
  const REC_MIN = 0.15;          // s; a shorter hold is a slip and keeps the previous take
  const REC_PEAK = 0.89;         // limiter ceiling for a take: the Mac's loop peak level
  const REC_MAX_GAIN = 250;      // at most +48 dB to bring a take up to the loop's loudness
  const REC_EDGE = 0.01;         // s; fade at a take's edges so it never clicks
  const REC_LATENCY = 0.04;      // s; estimated mic-to-onData delay, for placing a take on the grid
  const WAVE_BINS = 512;         // waveform resolution (min/max pairs per loop)
  const PRESETS = [
    'punchy boom bap drums with deep sub bass',
    'rainy 3am tape synthwave',
    'warm lo-fi jazz piano with vinyl crackle',
    'driving minimal techno, rolling bassline',
    'dusty afrobeat percussion and horns',
    'dreamy ambient pads and soft bells',
  ];

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const now = () => performance.now();

  // ───────────────────────── state ─────────────────────────
  const S = {
    keywords: [], weights: {}, variation: 0.5, seed: 0, shuffle: false,
    generating: false, genProgress: 0, swapPending: false, lastGenMs: 0,
    llmEnabled: true, macSeen: 0, sel: 0, muted: false, ideaBusy: 0, presetIdx: 0, blend: 0.5,
  };
  const lastOn = {};             // keyword -> weight before it was muted
  const touched = {};            // control key -> time of the last local edit
  const touch = (k) => { touched[k] = now(); lastEditAt = now(); };
  const recently = (k) => now() - (touched[k] || 0) < 800;

  // ───────────────────────── toast ─────────────────────────
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 1600);
  }

  // ───────────────────────── link to the Mac ─────────────────────────
  let chan = null, opening = false;
  const outbox = new Map();      // coalesced control messages, latest value per key
  let flushTimer = 0;

  function send(msg) {
    if (!chan) return;
    chan.send(JSON.stringify({src: 'app', v: 1, ...msg})).catch(() => {});
  }
  // A hello resets the Mac's view of this App, so a take still playing here is
  // re-sent right behind it (not fresh: the Mac adopts it without re-rendering).
  function sendHello() {
    send({type: 'hello', playing: P.curId});
    sendTake(false);
  }
  function sendCoalesced(key, msg) {
    outbox.set(key, msg);
    if (!flushTimer) flushTimer = setTimeout(() => {
      flushTimer = 0;
      for (const m of outbox.values()) send(m);
      outbox.clear();
    }, 70);
  }
  async function openLink() {
    if (chan || opening) return;
    opening = true;
    try {
      const h = await VrchApp.websocket.open({channel: CHANNEL, format: 'json'});
      chan = h;
      h.onMessage(onMessage);
      h.onError(() => { if (chan === h) chan = null; setTimeout(openLink, 2000); });
      sendHello();
    } catch (e) {
      toast('relay: ' + (e.code || e.message));
      setTimeout(openLink, 3000);
    } finally {
      opening = false;
    }
  }

  function onMessage(m) {
    if (m instanceof ArrayBuffer) { onLoopFrame(m); return; }
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch (_) { return; } }
    if (!m || typeof m !== 'object' || m.src !== 'mac') return;
    S.macSeen = now();
    switch (m.type) {
      case 'hello': sendHello(); break;
      case 'state': applyState(m.data || {}); break;
      case 'ack': if (m.ok === false) toast(m.label || 'not applied'); break;
      case 'idea_result': onIdeaResult(m); break;
      case 'cancel': cancelLoop(m.id); break;
    }
  }

  // ───────────────────────── audio engine ─────────────────────────
  let ctx = null, master = null, limiter = null, output = null, baseBus = null, recBus = null;
  const P = {t0: 0, loopSec: 8, beatSec: 0.5, beats: 16, curId: 0, cur: null, next: null, queued: null, timer: 0};
  const FADE_IN = new Float32Array(128), FADE_OUT = new Float32Array(128);
  for (let i = 0; i < 128; i++) {
    const t = i / 127;
    FADE_IN[i] = Math.sin(t * Math.PI / 2);
    FADE_OUT[i] = Math.cos(t * Math.PI / 2);
  }

  async function initAudio() {
    ctx = new AudioContext({sampleRate: SR, latencyHint: 'interactive', sinkId: {type: 'none'}});
    master = ctx.createGain();
    // Loop and take crossfade at equal power, so coincident peaks can sum past
    // full scale; this near brick-wall compressor keeps the real output clean.
    limiter = new DynamicsCompressorNode(ctx, {threshold: -1, knee: 0, ratio: 20, attack: 0.002, release: 0.12});
    master.connect(limiter);
    baseBus = ctx.createGain();          // generated loops
    recBus = ctx.createGain();           // the recorded take; silent until there is one
    recBus.gain.value = 0;
    baseBus.connect(master);
    recBus.connect(master);
    await connectOutput();
    VrchApp.audio.onAvailable(() => { if (!output) connectOutput(); if (!R.input) openMic(); });
  }
  async function connectOutput() {
    try {
      output = await VrchApp.audio.openOutput({channels: 2});
      const node = await output.createNode(ctx);
      limiter.connect(node);
      output.onError((e) => { output = null; toast('audio: ' + (e.code || e.message)); });
    } catch (e) {
      output = null;
      toast('audio output: ' + (e.code || e.message));
    }
  }
  function resumeAudio() {
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  function voice(buf, bus = baseBus) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = ctx.createGain();
    src.connect(g);
    g.connect(bus);
    return {src, g};
  }
  function retire(v) {
    try { v.src.stop(); } catch (_) {}
    v.src.disconnect();
    v.g.disconnect();
  }

  function playLoop(id, buf, at) {
    if (id === P.curId || (P.next && P.next.id === id)) return;
    if (!P.cur) {
      const v = voice(buf);
      P.t0 = ctx.currentTime + 0.1;
      v.src.start(P.t0, 0);
      P.cur = v;
      P.curId = id;
      send({type: 'playing', id});
      return;
    }
    if (P.next) {
      if (ctx.currentTime < P.next.ts) abortNext();      // not audible yet: replace it
      else { P.queued = {id, buf, at}; return; }        // mid-crossfade: go right after it
    }
    scheduleSwap(id, buf, at);
  }

  // Both loops run on the same grid phase; only their gains move, so the
  // crossfade consumes no grid time (same scheme as SequencerFeeder on the Mac).
  function scheduleSwap(id, buf, at) {
    const t = ctx.currentTime;
    const q = at === 'loop' ? P.loopSec : at === 'bar' ? P.beatSec * 4 : P.beatSec;
    const ts = P.t0 + Math.ceil((t + LEAD - P.t0) / q) * q;
    const offset = (((ts - P.t0) % P.loopSec) + P.loopSec) % P.loopSec;
    const v = voice(buf);
    v.g.gain.setValueAtTime(0, t);
    v.g.gain.setValueCurveAtTime(FADE_IN, ts, XF);
    v.src.start(ts, offset);
    const old = P.cur;
    old.g.gain.cancelScheduledValues(t);
    old.g.gain.setValueAtTime(1, t);
    old.g.gain.setValueCurveAtTime(FADE_OUT, ts, XF);
    P.next = {id, src: v.src, g: v.g, ts, old};
    P.timer = setTimeout(promote, (ts + XF - ctx.currentTime) * 1000 + 40);
  }
  function promote() {
    const n = P.next;
    if (!n) return;
    retire(n.old);
    P.cur = {src: n.src, g: n.g};
    P.curId = n.id;
    P.next = null;
    send({type: 'playing', id: n.id});
    if (P.queued) {
      const q = P.queued;
      P.queued = null;
      scheduleSwap(q.id, q.buf, q.at);
    }
  }
  function abortNext() {
    const n = P.next;
    clearTimeout(P.timer);
    retire(n);
    const t = ctx.currentTime;
    n.old.g.gain.cancelScheduledValues(t);
    n.old.g.gain.setValueAtTime(1, t);
    P.next = null;
  }
  function cancelLoop(id) {
    cancelled.add(id);
    if (cancelled.size > 64) cancelled.delete(cancelled.values().next().value);
    if (P.queued && P.queued.id === id) P.queued = null;
    if (P.next && P.next.id === id && ctx.currentTime < P.next.ts) abortNext();
  }
  function setMuted(on) {
    if (!ctx) return;
    S.muted = on;
    master.gain.setTargetAtTime(on ? 0 : 1, ctx.currentTime, 0.02);
    updateMonitor();
  }

  // ───────────────────────── loop transport ─────────────────────────
  // One binary frame per loop: "VLS1" | u32 BE header length | header JSON | audio.
  const cancelled = new Set();
  let decoding = 0, lastEditAt = 0;

  function onLoopFrame(ab) {
    const u8 = new Uint8Array(ab);
    if (u8.length < 8 || u8[0] !== 86 || u8[1] !== 76 || u8[2] !== 83 || u8[3] !== 49) return;   // "VLS1"
    const hlen = new DataView(ab).getUint32(4);
    let meta;
    try { meta = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hlen))); } catch (_) { return; }
    if (!meta || meta.src !== 'mac' || meta.type !== 'loop') return;
    S.macSeen = now();
    const id = meta.id;
    if (!id || id === P.curId || (P.next && P.next.id === id) || cancelled.has(id)) return;
    decodeLoop(id, meta, ab.slice(8 + hlen));
  }
  async function decodeLoop(id, meta, audio) {
    const t0 = now();
    decoding++;
    let buf;
    try {
      buf = await ctx.decodeAudioData(audio);
    } catch (err) {
      send({type: 'decoded', id, error: String(err && err.message || err)});
      toast('could not decode a loop');
      return;
    } finally {
      decoding--;
    }
    const {frames, pad, at} = meta;
    // Crop the exact loop out of the padded render; the pad also absorbs any
    // codec edge, so a decoder that trims slightly differently stays in range.
    const off = clamp(pad, 0, Math.max(0, buf.length - frames));
    const loop = new AudioBuffer({length: frames, numberOfChannels: 2, sampleRate: SR});
    for (let c = 0; c < 2; c++) {
      loop.copyToChannel(buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)).subarray(off, off + frames), c);
    }
    send({type: 'decoded', id, length: buf.length, expected: frames + 2 * pad,
          ms: Math.round(now() - t0), since_edit_ms: lastEditAt ? Math.round(now() - lastEditAt) : null});
    if (cancelled.has(id)) return;
    if (R.buf && R.buf.length !== frames) clearTake('loop length changed — take cleared');
    if (R.live && R.live.L !== frames) R.live = null;
    P.loopSec = frames / SR;
    P.beatSec = 60 / (meta.bpm || 120);
    P.beats = meta.beats || 16;
    keepPeaks(id, wavePeaks(loop));
    playLoop(id, loop, at);
  }

  // ───────────────────────── recording ─────────────────────────
  // A take is a loop-length buffer: each mic block is written where the
  // playhead was when it was heard, wrapping at the loop end, so the take
  // plays back in place and stays on the grid through every loop swap. The
  // microphone stays open, but only a K2 hold (or a waveform touch-hold)
  // keeps its blocks.
  const R = {input: null, opening: false, live: null, buf: null, voice: null, peaks: null, db: null,
             take: null};          // take: the processed mono take {data, pos0, n}, kept to (re)send to the Mac
  const phaseAt = (t) => (((t - P.t0) % P.loopSec) + P.loopSec) % P.loopSec;
  const dbfs = (v) => (v > 1e-6 ? Math.round(20 * Math.log10(v)) : -120);

  async function openMic() {
    if (R.input || R.opening) return;
    R.opening = true;
    try {
      // No echo cancellation by default: it is voice-call processing that ducks
      // the mic whenever the loop plays (~8–10 dB measured on vrch-130), so a
      // take also hears the speaker. Device > Audio can still turn it on.
      const h = await VrchApp.audio.openInput({channels: 2, echoCancellation: false});
      R.input = h;
      h.onData(onMicData);
      h.onError((e) => {
        if (R.input === h) R.input = null;
        R.live = null;
        toast('microphone: ' + (e.code || e.message));
        render();
      });
    } catch (e) {
      toast('microphone: ' + (e.code || e.message));
    } finally {
      R.opening = false;
    }
  }

  function recStart() {
    if (R.live) return;
    if (!ctx || !P.cur) { toast('recording starts once a loop is playing'); return; }
    if (!R.input) { openMic(); toast('microphone not ready — try again'); return; }
    resumeAudio();
    const L = Math.round(P.loopSec * SR);
    R.live = {L, data: new Float32Array(L), pos0: -1, n: 0, peak: 0,
              min: new Float32Array(WAVE_BINS), max: new Float32Array(WAVE_BINS), hit: new Uint8Array(WAVE_BINS)};
    render();
  }

  // One interleaved 20 ms block per call. Blocks are written back to back from
  // the first one's grid position, so arrival jitter never tears the take. The
  // onboard mic is mono, wired to one side of a stereo input, so the take is
  // summed to mono: the dead side costs no level and the take plays centered.
  function onMicData(samples) {
    const t = R.live;
    if (!t || !ctx) return;
    const nch = Math.max(1, R.input.channels | 0);
    const frames = Math.floor(samples.length / nch);
    if (t.pos0 < 0) t.pos0 = Math.round(phaseAt(ctx.currentTime - frames / SR - REC_LATENCY) * SR) % t.L;
    const m = Math.min(frames, t.L - t.n), d = t.data;
    for (let i = 0; i < m; i++) {
      const v = nch > 1 ? samples[i * nch] + samples[i * nch + 1] : samples[i * nch];
      const p = (t.pos0 + t.n + i) % t.L, k = Math.floor(p * WAVE_BINS / t.L);
      d[p] = v;
      if (v < t.min[k]) t.min[k] = v; else if (v > t.max[k]) t.max[k] = v;
      t.hit[k] = 1;
      const a = v < 0 ? -v : v;
      if (a > t.peak) t.peak = a;
    }
    t.n += m;
    if (t.n >= t.L) recStop();
  }

  function recStop() {
    const t = R.live;
    if (!t) return;
    R.live = null;
    if (t.n >= REC_MIN * SR) commitTake(t);
    render();
  }

  // RMS of the louder half of the take's 20 ms blocks, so pauses between words
  // don't pull its loudness down.
  function activeRms(d, pos0, n, L) {
    const blocks = [];
    for (let s = 0; s < n; s += 960) {
      const m = Math.min(960, n - s);
      let e = 0;
      for (let i = 0; i < m; i++) { const v = d[(pos0 + s + i) % L]; e += v * v; }
      blocks.push(e / m);
    }
    blocks.sort((a, b) => b - a);
    const k = Math.max(1, blocks.length >> 1);
    let sum = 0;
    for (let i = 0; i < k; i++) sum += blocks[i];
    return Math.sqrt(sum / k);
  }

  // Offline peak limiter: the gain never lets |x| pass REC_PEAK, easing in
  // ~2 ms ahead of a peak (backward pass) and recovering over ~60 ms after it
  // (forward pass), so loud syllables are held at the ceiling instead of clipping.
  function limitTake(d, pos0, n, L) {
    const g = new Float32Array(n);
    const att = 1 - Math.exp(-1 / (0.002 * SR)), rel = 1 - Math.exp(-1 / (0.06 * SR));
    let s = 1;
    for (let i = n - 1; i >= 0; i--) {
      const a = Math.abs(d[(pos0 + i) % L]);
      s = Math.min(a > REC_PEAK ? REC_PEAK / a : 1, s + (1 - s) * att);
      g[i] = s;
    }
    s = 1;
    for (let i = 0; i < n; i++) {
      s = Math.min(g[i], s + (1 - s) * rel);
      d[(pos0 + i) % L] *= s;
    }
  }

  function commitTake(t) {
    const {L, pos0, n, data} = t;
    // Level the take to the loop it plays against, then limit its peaks.
    const target = peaks.get(P.curId)?.rms || 0.1;
    const gain = Math.min(target / Math.max(activeRms(data, pos0, n, L), 1e-7), REC_MAX_GAIN);
    for (let i = 0; i < n; i++) data[(pos0 + i) % L] *= gain;
    limitTake(data, pos0, n, L);
    const edge = Math.max(1, Math.min(Math.round(REC_EDGE * SR), n >> 1));
    for (let i = 0; i < edge; i++) {
      data[(pos0 + i) % L] *= i / edge;
      data[(pos0 + n - 1 - i) % L] *= i / edge;
    }
    const min = new Float32Array(WAVE_BINS), max = new Float32Array(WAVE_BINS);
    for (let i = 0; i < n; i++) {
      const p = (pos0 + i) % L, v = data[p], k = Math.floor(p * WAVE_BINS / L);
      if (v < min[k]) min[k] = v; else if (v > max[k]) max[k] = v;
    }
    const buf = new AudioBuffer({length: L, numberOfChannels: 2, sampleRate: SR});
    buf.copyToChannel(data, 0);
    buf.copyToChannel(data, 1);
    // Start in phase with the grid and swap any previous take with a short fade.
    const v = voice(buf, recBus), ts = ctx.currentTime + LEAD;
    v.g.gain.setValueAtTime(0, ctx.currentTime);
    v.g.gain.setTargetAtTime(1, ts, 0.015);
    v.src.start(ts, phaseAt(ts));
    const old = R.voice;
    if (old) {
      old.g.gain.setTargetAtTime(0, ts, 0.015);
      setTimeout(() => retire(old), (ts - ctx.currentTime) * 1000 + 200);
    }
    R.voice = v;
    R.buf = buf;
    R.db = dbfs(t.peak);           // the mic's own peak, before the boost
    R.peaks = {min, max, hit: t.hit};
    R.take = {data, pos0, n};
    applyBlend();
    const sent = sendTake(true), db = Math.round(20 * Math.log10(gain));
    const level = gain >= REC_MAX_GAIN ? `+${db} dB max` : `${db >= 0 ? '+' : ''}${db} dB`;
    toast(`${n >= L ? 'full-loop take' : 'take'} blended · ${level} · ${sent ? 'rewriting on Mac' : 'Mac offline'}`);
  }

  // The take travels as JSON — the Apps host JSON-encodes whatever an App sends
  // on a json channel — carrying just the recorded region as 8-bit mu-law in
  // base64 (synth/remote.py parse_take): ~0.5 MB for a full loop, inside the
  // SDK's send queue and the relay's message cap. The Mac writes it back at pos0.
  const MU = 255, LOG1P_MU = Math.log1p(MU);
  function sendTake(fresh) {
    if (!chan || !R.take) return false;
    const {data, pos0, n} = R.take, L = data.length;
    const q = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      const v = clamp(data[(pos0 + i) % L], -1, 1);
      q[i] = Math.round(Math.sign(v) * Math.log1p(MU * Math.abs(v)) / LOG1P_MU * 127);
    }
    const u8 = new Uint8Array(q.buffer);
    let bin = '';
    for (let i = 0; i < n; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    const msg = {src: 'app', v: 1, type: 'take', sr: SR, frames: L, pos0, n, blend: S.blend, fresh,
                 codec: 'mulaw8', data: btoa(bin)};
    chan.send(JSON.stringify(msg)).catch(() => toast('could not send the take to the Mac'));
    return true;
  }

  function clearTake(msg) {
    if (R.voice) retire(R.voice);
    R.voice = R.buf = R.peaks = R.db = R.take = null;
    applyBlend();
    send({type: 'clear_take'});
    if (msg) toast(msg);
  }

  // Equal-power crossfade: 0 = loop only, 1 = take only. With no take the
  // loop stays at full level whatever the knob says.
  function blendGains() {
    const b = R.buf ? S.blend : 0;
    return [Math.cos(b * Math.PI / 2), R.buf ? Math.sin(b * Math.PI / 2) : 0];
  }
  function applyBlend() {
    if (!ctx) return;
    const [gb, gr] = blendGains();
    baseBus.gain.setTargetAtTime(gb, ctx.currentTime, 0.03);
    recBus.gain.setTargetAtTime(gr, ctx.currentTime, 0.03);
  }
  function setBlend(v) {
    S.blend = Math.round(clamp(v, 0, 1) * 100) / 100;
    applyBlend();
    sendCoalesced('blend', {type: 'set_blend', value: S.blend});   // the Mac's next rewrite base
    flash('cell-blend');
    render();
  }

  // ───────────────────────── waveform ─────────────────────────
  // The transport is the loop's own waveform (orange, brighter once played)
  // with the take on top (teal), the playhead, and a thin bar while the Mac
  // renders. Peaks are computed once per loop; each frame is a few filled paths.
  const W = {canvas: null, g: null, w: 0, h: 0, dpr: 1};
  const C = {loop: 'rgba(255,106,26,0.4)', played: '#ff6a1a', take: 'rgba(41,199,182,0.8)', live: '#29c7b6',
             span: 'rgba(41,199,182,0.08)', head: '#e8e6e1', rec: '#ff4d4d', mid: '#2a2d32'};
  const peaks = new Map();       // loop id -> {min, max}

  function wavePeaks(buf) {
    const n = buf.length, a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
    const min = new Float32Array(WAVE_BINS), max = new Float32Array(WAVE_BINS);
    let ss = 0;
    for (let k = 0; k < WAVE_BINS; k++) {
      let lo = 0, hi = 0;
      for (let i = Math.floor(k * n / WAVE_BINS), e = Math.floor((k + 1) * n / WAVE_BINS); i < e; i++) {
        const v = (a[i] + b[i]) * 0.5;
        ss += v * v;
        if (v < lo) lo = v; else if (v > hi) hi = v;
      }
      min[k] = lo;
      max[k] = hi;
    }
    return {min, max, rms: Math.sqrt(ss / Math.max(1, n))};   // rms: the loudness a take is levelled to
  }
  function keepPeaks(id, p) {
    peaks.set(id, p);
    for (const k of peaks.keys()) {
      if (peaks.size <= 6) break;
      if (k !== P.curId && k !== id) peaks.delete(k);
    }
  }
  function sizeWave() {
    const c = W.canvas;
    if (!c) return;
    W.dpr = devicePixelRatio || 1;
    W.w = Math.max(1, Math.round(c.clientWidth * W.dpr));
    W.h = Math.max(1, Math.round(c.clientHeight * W.dpr));
    if (c.width !== W.w) c.width = W.w;
    if (c.height !== W.h) c.height = W.h;
  }
  function bars(p, scale, from, to, hit) {
    const mid = W.h / 2, amp = (W.h / 2 - W.dpr) * scale, cw = W.w / WAVE_BINS;
    for (let k = from; k < to; k++) {
      if (hit && !hit[k]) continue;
      W.g.rect(k * cw, mid - p.max[k] * amp, cw + 0.5, Math.max(W.dpr, (p.max[k] - p.min[k]) * amp));
    }
  }
  function drawWave(ph) {
    const g = W.g;
    if (!g) return;
    g.clearRect(0, 0, W.w, W.h);
    const live = R.live, take = live || R.peaks, [gb, gr] = blendGains();
    if (take) {                  // where the take sits, even at blend 0
      g.fillStyle = C.span;
      g.beginPath();
      for (let k = 0; k < WAVE_BINS; k++) if (take.hit[k]) g.rect(k * W.w / WAVE_BINS, 0, W.w / WAVE_BINS + 0.5, W.h);
      g.fill();
    }
    g.fillStyle = C.mid;
    g.fillRect(0, Math.floor(W.h / 2), W.w, Math.max(1, Math.round(W.dpr)));
    const base = peaks.get(P.curId);
    if (base) {
      const head = P.cur ? Math.min(WAVE_BINS, Math.floor(ph / P.loopSec * WAVE_BINS)) : 0;
      g.fillStyle = C.played; g.beginPath(); bars(base, gb, 0, head); g.fill();
      g.fillStyle = C.loop; g.beginPath(); bars(base, gb, head, WAVE_BINS); g.fill();
    }
    if (take) {                  // live: preview at the level the take will be normalized to
      const scale = live ? Math.min(REC_PEAK / Math.max(live.peak, 1e-5), REC_MAX_GAIN) : Math.max(gr, 0.15);
      g.fillStyle = live ? C.live : C.take;
      g.beginPath(); bars(take, scale, 0, WAVE_BINS, take.hit); g.fill();
    }
    if (P.cur) {
      g.fillStyle = live ? C.rec : C.head;
      g.fillRect(Math.round(ph / P.loopSec * W.w - W.dpr / 2), 0, Math.max(1, Math.round(1.5 * W.dpr)), W.h);
    }
    if (S.generating) {
      g.fillStyle = C.played;
      g.fillRect(0, W.h - 2 * W.dpr, Math.max(0.05, S.genProgress) * W.w, 2 * W.dpr);
    }
  }

  // ───────────────────────── Mac state -> UI ─────────────────────────
  function applyState(d) {
    const kws = Array.isArray(d.keywords) ? d.keywords.slice(0, SLOTS) : S.keywords;
    const changed = kws.join('\u0001') !== S.keywords.join('\u0001');
    S.keywords = kws;
    for (const k of kws) {
      const w = d.weights && typeof d.weights[k] === 'number' ? d.weights[k] : 1;
      if (!recently('w:' + k)) S.weights[k] = w;
    }
    if (!recently('var') && typeof d.variation === 'number') S.variation = d.variation;
    if (!recently('seed') && typeof d.seed === 'number') S.seed = d.seed;
    if (!recently('shuffle') && typeof d.shuffle === 'boolean') S.shuffle = d.shuffle;
    S.generating = !!d.is_generating;
    S.genProgress = d.gen_progress || 0;
    S.swapPending = !!d.swap_pending;
    S.lastGenMs = d.last_gen_ms || 0;
    S.llmEnabled = d.llm_enabled !== false;
    if (changed) S.sel = clamp(S.sel, 0, Math.max(0, kws.length - 1));
    render();
  }
  function onIdeaResult(m) {
    S.ideaBusy = 0;
    const llm = m.llm || {};
    if (llm.ok) toast(`vibe loaded (${Math.round((llm.elapsed_ms || 0) / 100) / 10} s)`);
    else toast(llm.error ? `default patch: ${llm.error}` : 'default patch loaded');
    render();
  }

  // ───────────────────────── edits (local first, then intent) ─────────────────────────
  const selKw = () => S.keywords[S.sel];
  function setWeight(kw, v) {
    if (!kw) return;
    v = Math.round(clamp(v, 0, 1) * 100) / 100;
    S.weights[kw] = v;
    if (v > 0) lastOn[kw] = v;
    touch('w:' + kw);
    sendCoalesced('w:' + kw, {type: 'set_weight', keyword: kw, value: v});
    render();
  }
  function toggleMuteSel() {
    const kw = selKw();
    if (!kw) return;
    const w = S.weights[kw] ?? 1;
    setWeight(kw, w > 0 ? 0 : (lastOn[kw] || 1));
  }
  function setVariation(v) {
    S.variation = Math.round(clamp(v, 0, 1) * 100) / 100;
    touch('var');
    sendCoalesced('var', {type: 'set_denoise', value: S.variation});
    flash('cell-var');
    render();
  }
  function reroll() {
    S.seed += 1;
    touch('seed');
    outbox.delete('seed');
    send({type: 'reroll'});
    flash('cell-seed');
    render();
  }
  function toggleShuffle() {
    S.shuffle = !S.shuffle;
    touch('shuffle');
    send({type: 'set_shuffle', value: S.shuffle});
    toast(S.shuffle ? 'shuffle on — evolving every loop' : 'shuffle off — looping');
    render();
  }
  function vibe() {
    if (!chan || now() - S.macSeen > MAC_TIMEOUT) { toast('Mac is offline'); return; }
    if (!S.llmEnabled) { toast('vibe needs Ollama on the Mac (started with --no-llm)'); return; }
    if (S.ideaBusy && now() - S.ideaBusy < 90000) { toast('still asking for a vibe…'); return; }
    const input = $('idea');
    let text = input.value.trim();
    if (!text) {
      text = PRESETS[S.presetIdx % PRESETS.length];
      S.presetIdx++;
      input.value = text;
    }
    if (kb) kb.hide();
    input.blur();
    S.ideaBusy = now();
    send({type: 'idea', value: text});
    saveIdea(text);
    toast('asking the Mac for “' + text.slice(0, 40) + '”');
    render();
  }

  // The App data store is versioned: a write must name the version it replaces
  // (0 for a new key), so keep the last known one and re-read it on a conflict.
  let ideaVersion = 0;
  async function saveIdea(text) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await VrchApp.data.set('idea', text, {expectedVersion: ideaVersion});
        ideaVersion = r && typeof r.version === 'number' ? r.version : ideaVersion + 1;
        return;
      } catch (_) {
        try {
          const cur = await VrchApp.data.get('idea');
          ideaVersion = (cur && cur.version) || 0;
        } catch (__) {
          return;
        }
      }
    }
  }

  // ───────────────────────── UI ─────────────────────────
  const slots = [];
  function buildBank() {
    const bank = $('bank');
    for (let i = 0; i < SLOTS; i++) {
      const el = document.createElement('div');
      el.className = 'slot empty';
      el.innerHTML = `<span class="n">${i + 1}</span><span class="name"></span><span class="w"><i></i></span><span class="v"></span>`;
      bank.appendChild(el);
      const s = {el, name: el.querySelector('.name'), bar: el.querySelector('.w'), fill: el.querySelector('.w i'),
                 val: el.querySelector('.v')};
      slots.push(s);
      const fromX = (x) => {
        const r = s.bar.getBoundingClientRect();
        return clamp((x - r.left) / r.width, 0, 1);
      };
      let drag = false;
      el.addEventListener('pointerdown', (ev) => {
        resumeAudio();
        if (i >= S.keywords.length) return;
        S.sel = i;
        if (ev.target === s.bar || s.bar.contains(ev.target)) {
          drag = true;
          try { s.bar.setPointerCapture(ev.pointerId); } catch (_) {}
          setWeight(S.keywords[i], fromX(ev.clientX));
        }
        render();
      });
      el.addEventListener('pointermove', (ev) => { if (drag) setWeight(S.keywords[i], fromX(ev.clientX)); });
      const end = () => { drag = false; };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    }
  }
  function flash(id) {
    const el = $(id);
    el.classList.add('flash');
    clearTimeout(el.flashTimer);
    el.flashTimer = setTimeout(() => el.classList.remove('flash'), 350);
  }

  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderNow(); });
  }
  function renderNow() {
    for (let i = 0; i < SLOTS; i++) {
      const s = slots[i], kw = S.keywords[i];
      if (!kw) {
        s.el.className = 'slot empty';
        s.name.textContent = '—';
        s.fill.style.width = '0';
        s.val.textContent = '';
        continue;
      }
      const w = S.weights[kw] ?? 1;
      s.el.className = 'slot' + (i === S.sel ? ' sel' : '') + (w <= 0 ? ' muted' : '');
      s.name.textContent = kw;
      s.fill.style.width = (w * 100) + '%';
      s.val.textContent = w.toFixed(2);
    }
    $('r-var').textContent = S.variation.toFixed(2);
    $('r-seed').textContent = String(S.seed);
    $('r-blend').textContent = S.blend.toFixed(2);
    $('blend-arc').style.strokeDasharray = `${(S.blend * 75).toFixed(1)} 100`;
    $('cell-blend').classList.toggle('idle', !R.buf);
    $('rec-badge').classList.toggle('hidden', !R.live);
    $('wave-box').classList.toggle('rec', !!R.live);
    const sh = $('r-shuffle');
    sh.textContent = S.shuffle ? 'on' : 'off';
    sh.classList.toggle('on', S.shuffle);
    $('vibe-btn').disabled = !!S.ideaBusy || !S.llmEnabled;
    $('r-status').textContent = statusText();
    updateMonitor();
  }
  function statusText() {
    const online = chan && now() - S.macSeen < MAC_TIMEOUT;
    if (R.live) return `rec ${(R.live.n / SR).toFixed(1)}/${Math.round(P.loopSec)} s · mic ${dbfs(R.live.peak)} dB`;
    if (S.muted) return 'output muted (K4)';
    if (!online) return P.cur ? 'Mac offline — looping' : 'waiting for Mac';
    if (S.ideaBusy) return 'asking for a vibe…';
    if (S.generating) return 'rendering on Mac…';
    if (decoding) return 'decoding loop…';
    if (P.next && ctx) {
      const s = P.next.ts - ctx.currentTime;
      return s > 0 ? `new loop in ${s.toFixed(1)} s` : 'fading in new loop';
    }
    if (S.swapPending) return 'loop on its way…';
    if (!P.cur) return 'waiting for first loop';
    if (R.buf) return `looping · mic peak ${R.db} dB`;
    return S.lastGenMs ? `looping · render ${Math.round(S.lastGenMs)} ms` : 'looping';
  }

  let monitorQueued = false, monitorLast = '';
  function updateMonitor() {
    if (monitorQueued) return;
    monitorQueued = true;
    setTimeout(() => {
      monitorQueued = false;
      const kw = selKw() || '—';
      const w = S.weights[kw] ?? 0;
      const vals = {
        E1: {label: 'Sound', value: kw.length > 9 ? kw.slice(0, 8) + '…' : kw},
        E2: {label: 'Weight', value: w.toFixed(2)},
        E3: {label: 'Variation', value: S.variation.toFixed(2)},
        E4: {label: 'Blend', value: R.buf ? S.blend.toFixed(2) : '—'},
        K2: {label: 'Record', value: R.live ? '● rec' : R.buf ? 'take' : 'hold'},
        K3: {label: kb && kb.isOpen() ? 'Send' : 'Vibe', value: S.ideaBusy ? '…' : ''},
        K4: {label: 'Mute', value: S.muted ? 'muted' : ''},
      };
      const key = JSON.stringify(vals);
      if (key === monitorLast) return;
      monitorLast = key;
      VrchApp.monitor.set(vals).catch(() => {});
    }, 60);
  }

  let lastBeat = -1;
  function tick() {
    let ph = 0;
    if (P.cur && ctx) {
      ph = phaseAt(ctx.currentTime);
      const beat = Math.min(P.beats - 1, Math.floor(ph / P.beatSec));
      if (beat !== lastBeat) {
        lastBeat = beat;
        $('phrase').innerHTML = `BAR <b>${Math.floor(beat / 4) + 1}/${P.beats / 4}</b> · BEAT <b>${String(beat + 1).padStart(2, '0')}/${P.beats}</b>`;
      }
    }
    drawWave(ph);
    requestAnimationFrame(tick);
  }

  function housekeeping() {
    const online = chan && now() - S.macSeen < MAC_TIMEOUT;
    const chip = $('link-chip');
    chip.textContent = online ? 'MAC ●' : 'MAC ○';
    chip.classList.toggle('off', !online);
    if (S.ideaBusy && now() - S.ideaBusy > 90000) S.ideaBusy = 0;
    $('audio-gate').classList.toggle('hidden', !ctx || ctx.state === 'running' || !P.cur);
    render();
  }

  function applyViewport() {
    let vp = null, inset = 0;
    try { vp = VrchApp.context.viewport; inset = VrchApp.context.safeInsets?.left || 0; } catch (_) {}
    const h = (vp && vp.height) || innerHeight;
    document.documentElement.classList.toggle('tall', h >= 470);
    document.documentElement.style.setProperty('--inset-left', inset + 'px');
    sizeWave();
  }

  // ───────────────────────── input wiring ─────────────────────────
  let kb = null;                 // on-screen keyboard for the vibe box (keyboard.js)
  function wireInputs() {
    VrchApp.controls.onEvent((e) => {
      resumeAudio();
      if (e.type === 'rotate') {
        const d = e.delta | 0;
        if (!d) return;
        if (e.control === 'E1') { S.sel = clamp(S.sel + d, 0, Math.max(0, S.keywords.length - 1)); render(); }
        else if (e.control === 'E2') { const kw = selKw(); if (kw) setWeight(kw, (S.weights[kw] ?? 1) + d * 0.05); }
        else if (e.control === 'E3') setVariation(S.variation + d * 0.05);
        else if (e.control === 'E4') setBlend(S.blend + d * 0.05);
      } else if (e.type === 'down') {
        if (e.control === 'E1') toggleMuteSel();
        else if (e.control === 'E2') { const kw = selKw(); if (kw) setWeight(kw, 1); }
        else if (e.control === 'E3') setVariation(0.5);
        else if (e.control === 'E4') reroll();
        else if (e.control === 'K2') recStart();
        else if (e.control === 'K3') vibe();
        else if (e.control === 'K4') setMuted(!S.muted);
      } else if (e.type === 'up' || e.type === 'cancel') {
        // K2 is the hold-to-record key: S1, the side key, belongs to the Apps
        // shell and never reaches an App. A cancelled hold keeps what it caught.
        if (e.control === 'K2') recStop();
      }
    });
    $('cell-shuffle').addEventListener('pointerdown', () => { resumeAudio(); toggleShuffle(); });
    const wave = $('wave-box');
    wave.addEventListener('pointerdown', (ev) => {
      resumeAudio();
      if (kb && kb.isOpen()) return;     // that tap only puts the keyboard away
      try { wave.setPointerCapture(ev.pointerId); } catch (_) {}
      recStart();
    });
    wave.addEventListener('pointerup', recStop);
    wave.addEventListener('pointercancel', recStop);
    const knob = $('cell-blend');
    let knobDrag = null;
    knob.addEventListener('pointerdown', (ev) => {
      resumeAudio();
      knobDrag = {x: ev.clientX, y: ev.clientY, v: S.blend};
      try { knob.setPointerCapture(ev.pointerId); } catch (_) {}
    });
    knob.addEventListener('pointermove', (ev) => {
      if (knobDrag) setBlend(knobDrag.v + ((ev.clientX - knobDrag.x) - (ev.clientY - knobDrag.y)) / 160);
    });
    knob.addEventListener('pointerup', () => { knobDrag = null; });
    knob.addEventListener('pointercancel', () => { knobDrag = null; });
    $('vibe-btn').addEventListener('pointerdown', (ev) => { ev.preventDefault(); resumeAudio(); vibe(); });
    const input = $('idea');
    kb = VibeKeyboard.create({
      input, host: $('kb'), presets: PRESETS, onSubmit: vibe,
      onToggle: (on) => { $('app').classList.toggle('kb-open', on); updateMonitor(); },
    });
    input.addEventListener('pointerdown', () => {
      resumeAudio();
      kb.show();
      setTimeout(() => input.focus(), 0);
    });
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); vibe(); } });
    // Tapping the transport area while typing puts the keyboard away.
    for (const sel of ['.top', '.transport', '.readout']) {
      document.querySelector(sel).addEventListener('pointerdown', () => { if (kb.isOpen()) { kb.hide(); input.blur(); } });
    }
    $('audio-gate').addEventListener('pointerdown', resumeAudio);
    addEventListener('resize', applyViewport);
  }

  // ───────────────────────── boot ─────────────────────────
  (async () => {
    W.canvas = $('wave');
    W.g = W.canvas.getContext('2d');
    if (typeof ResizeObserver === 'function') new ResizeObserver(sizeWave).observe(W.canvas);
    applyViewport();
    buildBank();
    wireInputs();
    render();
    requestAnimationFrame(tick);
    setInterval(housekeeping, 400);
    try { await VrchApp.ready(); } catch (_) {}
    applyViewport();
    await initAudio();
    openMic();
    try {
      const saved = await VrchApp.data.get('idea');
      if (saved && typeof saved.value === 'string') $('idea').value = saved.value;
      ideaVersion = (saved && saved.version) || 0;
    } catch (_) {}
    openLink();
  })();
})();
