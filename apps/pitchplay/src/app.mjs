import {rangePointer} from './controls.mjs';
import {normalizeSettings, dspSettings, voiceDefaults} from './voice-settings.mjs';

const sdk = globalThis.VrchApp, $ = id => document.getElementById(id);
const preview = sdk.context.mode === 'preview';
let config, state, stored = {}, version = 0, canSave = false;
let phase = 'idle', audioIssue = '', graph = null, candidate = null, epoch = 0, wantsAudio = false;
let meter = {input: 0, output: 0, frames: 0}, saveTimer, monitorTimer;
let edit = 0, savedEdit = 0, saving = false, animation, lastMeter = 0, closed = false;
const pressed = new Set();
const voiceEdits = new Map();
const diagnostics = {starts: 0, releases: 0, meterMessages: 0, maxMeterGapMs: 0};

function notice(message) {
  $('notice').textContent = message; $('notice').hidden = !message;
  $('levels').hidden = Boolean(message);
}

function scheduleSave() {
  edit++;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
}

async function save() {
  if (saving || !canSave || closed) return;
  saving = true;
  try {
    while (savedEdit !== edit) {
      const currentEdit = edit, value = {...stored, ...state};
      const result = await sdk.data.set('voice-settings', value, {expectedVersion: version});
      version = result.version; stored = value; savedEdit = currentEdit;
    }
  } catch (_) {
    canSave = false;
    notice('Settings not saved. Reload in Menu.');
  } finally { saving = false; }
}

function voiceIndex() { return config.voices.findIndex(voice => voice.id === state.voice); }
function parameterText(p) {
  const value = state[p.id];
  if (p.neutral) return value === 0 ? p.neutral : (value < 0 ? p.negative : p.positive) + ' ' + Math.abs(value) + '%';
  return value + '%';
}
function primaryAction() {
  const key = phase === 'live' ? (state.bypass ? 'original' : 'compare') : phase === 'waiting' ? 'waiting' : phase === 'starting' ? 'cancel' : phase === 'error' ? 'retry' : preview ? 'demo' : 'start';
  return config.actions[key];
}

function monitor() {
  clearTimeout(monitorTimer);
  monitorTimer = setTimeout(() => {
    if (closed) return;
    void sdk.monitor.set({
      ...Object.fromEntries(config.parameters.map(p=>[p.control,{label:p.label,value:parameterText(p)}])),
      K2: {label: primaryAction().monitor, pressed: phase === 'live' && state.bypass},
      K3: {label: 'Prev voice'}, K4: {label: 'Next voice'}
    }).catch(() => {});
  }, 32);
}

function updateGraph() { graph?.node.port.postMessage({type: 'settings', value: dspSettings(config, state)}); }

function render() {
  const selected = voiceIndex();
  for (const [index, button] of [...$('voices').children].entries()) button.setAttribute('aria-pressed', String(index === selected));
  for (const p of config.parameters) {
    $(p.id).value = String(state[p.id]);
    $(p.id + '-value').textContent = parameterText(p);
    $(p.id).setAttribute('aria-valuetext', parameterText(p));
  }
  if (phase === 'live') $('primary').setAttribute('aria-pressed', String(state.bypass));
  else $('primary').removeAttribute('aria-pressed');
  const action = primaryAction();
  $('primary-hint').textContent = phase === 'error' ? audioIssue || action.hint : action.hint;
  $('primary').querySelector('b').textContent = action.text;
  $('primary').disabled = false;
  $('status').textContent = phase === 'waiting' ? 'TAP START' : phase === 'starting' ? 'STARTING' : phase === 'error' ? 'STOPPED' : phase === 'live' ? (state.bypass ? 'ORIGINAL' : preview ? 'DEMO' : 'LIVE') : preview ? 'PREVIEW' : 'READY';
  $('audio').hidden = phase !== 'live';
  $('audio').textContent = preview ? 'STOP DEMO' : 'STOP';
  monitor();
}

function change(values) {
  Object.assign(state, values);
  for (const p of config.parameters) state[p.id] = Math.max(p.min, Math.min(p.max, state[p.id]));
  voiceEdits.set(state.voice, {pitch:state.pitch,size:state.size,texture:state.texture});
  updateGraph(); render(); scheduleSave();
}

function adjust(values) { change({...values, bypass: false}); }

function chooseVoice(index, reset = false) {
  const voice = config.voices[index];
  const retained = !reset && voice.remember !== false && voiceEdits.get(voice.id);
  change({voice: voice.id, ...(retained || voiceDefaults(config,voice.id)), bypass: false});
}
function nextVoice(delta) {
  const index = voiceIndex();
  chooseVoice(index < 0 ? (delta > 0 ? 0 : config.voices.length - 1) : (index + delta % config.voices.length + config.voices.length) % config.voices.length);
}

async function release(value) {
  if (!value) return;
  value.readyReject?.(Object.assign(new Error('Cancelled'), {cancelled: true}));
  value.unsubscribe?.();
  // A cancelled start can acquire another handle after this first cleanup.
  // Close each resource once, including resources that arrive after cancellation.
  for (const key of ['source', 'inputNode', 'outputNode', 'node']) {
    const node = value[key];
    if (!node || value.released.has(node)) continue;
    value.released.add(node);
    try { if (key === 'source') node.stop(); node.disconnect(); } catch (_) {}
  }
  await Promise.allSettled(['input', 'output', 'context'].map(async key => {
    const resource = value[key];
    if (!resource || value.released.has(resource)) return;
    value.released.add(resource);
    await resource.close();
  }));
}

async function stop() {
  wantsAudio = false; ++epoch;
  const previous = graph, pending = candidate;
  graph = null; candidate = null; phase = 'idle'; audioIssue = ''; lastMeter = 0;
  meter = {input: 0, output: 0, frames: 0};
  if (!closed) render();
  await Promise.all([release(previous), release(pending)]);
  diagnostics.releases++;
}

function errorMessage(error) {
  if (preview) return 'Choose Listen to preview in Apps.';
  if (error.code === 'voice_engine_unavailable') return 'Voice engine could not start. Retry.';
  if (error.code === 'echo_cancellation_unavailable') return 'Choose another input or turn off Echo cancellation in Device → Audio.';
  if (error.code === 'echo_cancellation_sdk_required') return 'Update My Apps to enable echo control.';
  if (error.code === 'unsupported_environment') return 'Audio unavailable in this browser.';
  if (error.code === 'permission_required') return 'Allow microphone in browser.';
  return 'Choose input and output in Menu.';
}

async function start() {
  if (closed || phase === 'starting' || phase === 'live') return;
  const token = ++epoch, value = {released: new Set()};
  const current = () => { if (closed || token !== epoch) throw Object.assign(new Error('Cancelled'), {cancelled: true}); };
  candidate = value; wantsAudio = true; phase = 'starting'; audioIssue = ''; render();
  try {
    value.context = new AudioContext({sampleRate: 48000, latencyHint: 'interactive'});
    if (!value.context.audioWorklet) throw Object.assign(new Error(), {code: 'unsupported_environment'});
    const resumed = value.context.resume();
    if (value.context.state !== 'running') { phase = 'waiting'; render(); }
    await resumed; current(); phase = 'starting'; render();
    await value.context.audioWorklet.addModule(new URL('voice-worklet.mjs', import.meta.url)); current();
    value.node = new AudioWorkletNode(value.context, 'pitchplay-voice', preview ? {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit'
    } : {numberOfInputs: 1, numberOfOutputs: 0, processorOptions: {mode: 'pcm'}});
    // Finish WASM compilation and warm-up before real capture starts. This
    // keeps startup work out of the live stream and makes Cancel release it.
    await new Promise((resolve, reject) => {
      const unavailable = () => Object.assign(new Error('Voice engine unavailable'), {code: 'voice_engine_unavailable'});
      const timer = setTimeout(() => reject(unavailable()), 10000);
      value.readyReject = error => { clearTimeout(timer); reject(error); };
      value.node.onprocessorerror = () => value.readyReject(unavailable());
      value.node.port.onmessage = ({data}) => {
        if (data.type === 'ready') {
          clearTimeout(timer); value.readyReject = null;
          diagnostics.latencyFrames = data.latencyFrames; resolve();
        } else if (data.type === 'error') value.readyReject(unavailable());
      };
    }); current();
    value.output = await sdk.audio.openOutput({channels: 2}); current();
    if (preview) {
      value.outputNode = await value.output.createNode(value.context); current();
      value.node.connect(value.outputNode);
      const response = await fetch(new URL('assets/vowel.wav', import.meta.url));
      if (!response.ok) throw new Error('Demo unavailable');
      const buffer = await value.context.decodeAudioData(await response.arrayBuffer()); current();
      value.source = value.context.createBufferSource(); value.source.buffer = buffer; value.source.loop = true;
      value.source.connect(value.node);
    } else {
      value.input = await sdk.audio.openInput({channels: 2, echoCancellation: true}); current();
      diagnostics.captureEchoCancellation = value.input.echoCancellation;
      if (typeof value.input.echoCancellation !== 'boolean') throw Object.assign(new Error('Echo control requires a current SDK'), {code: 'echo_cancellation_sdk_required'});
      if (value.input.silent) throw new Error('Input unavailable');
    }
    graph = value; candidate = null; phase = 'live'; lastMeter = performance.now(); diagnostics.starts++;
    value.queue = []; value.pending = 0; value.primed = false; value.lastInput = performance.now();
    const pump = () => {
      if (graph !== value || !value.primed) return;
      while (value.queue.length && value.pending < 3) {
        const samples = value.queue.shift(); value.pending++;
        void value.output.write(samples).then(result => {
          value.pending--;
          if (graph !== value) return;
          if (result.dropped) { void fail('Audio interrupted.'); return; }
          pump();
        }, () => { if (graph === value) void fail('Audio output stopped.'); });
      }
    };
    value.node.port.onmessage = ({data}) => {
      if (graph !== value) return;
      if (data.type === 'pcm') {
        value.queue.push(data.samples);
        // Two 20 ms blocks at startup give the host one block of scheduling
        // headroom. Capture and playback then share the host's sample clock;
        // the App's AudioContext only runs DSP, never a second PCM clock.
        if (value.queue.length >= 2) value.primed = true;
        if (value.queue.length > 3) { void fail('Audio could not keep up.'); return; }
        pump(); return;
      }
      if (data.type !== 'meter') return;
      const now = performance.now();
      diagnostics.maxMeterGapMs = Math.max(diagnostics.maxMeterGapMs, now - lastMeter);
      diagnostics.meterMessages++; meter = data; lastMeter = now;
      diagnostics.robotMode = data.robotMode; diagnostics.robotCarrierHz = data.robotCarrierHz;
    };
    if (!preview) value.unsubscribe = value.input.onData(samples => {
      if (graph !== value) return;
      value.lastInput = performance.now();
      value.node.port.postMessage({type: 'pcm', samples}, [samples.buffer]);
    });
    value.node.onprocessorerror = () => { if (graph === value) void fail('Audio processing stopped.'); };
    value.context.onstatechange = () => {
      if (graph === value && value.context.state !== 'running') void fail('Audio paused.');
    };
    updateGraph(); value.source?.start(); render();
  } catch (error) {
    await release(value);
    if (token !== epoch || closed) return;
    graph = null; candidate = null; phase = 'error'; audioIssue = errorMessage(error); render();
    diagnostics.lastError = error.code || error.name;
  }
}

async function fail(message) {
  await stop();
  if (closed) return;
  wantsAudio = true; phase = 'error'; audioIssue = message; render();
}

function controlAudio() {
  // Browser activation must stay synchronous in the person's actual App click.
  if (phase === 'waiting' && candidate) { void candidate.context.resume().catch(() => {}); return; }
  return phase === 'live' || phase === 'starting' ? stop() : start();
}

function primary() {
  return phase === 'live' ? change({bypass: !state.bypass}) : controlAudio();
}

function draw() {
  for (const [id, peak] of [['in-level', meter.input], ['out-level', meter.output]]) {
    const db = peak > 0 ? 20 * Math.log10(peak) : -100;
    $(id).style.transform = 'scaleX(' + Math.max(0, Math.min(1, (db + 60) / 60)) + ')';
  }
  if (phase === 'live' && performance.now() - lastMeter > 2000) void fail('Audio interrupted.');
  else if (phase === 'live' && !preview && performance.now() - graph.lastInput > 1500) void fail('Audio input stopped.');
  animation = requestAnimationFrame(draw);
}

async function init() {
  config = await fetch(new URL('voices.json', import.meta.url)).then(response => {
    if (!response.ok) throw new Error('Voice presets unavailable');
    return response.json();
  });
  state = {...config.defaults};
  const icons = await fetch(new URL('assets/icons.svg', import.meta.url)).then(response => {
    if (!response.ok) throw new Error('Voice icons unavailable');
    return response.text();
  });
  const library = new DOMParser().parseFromString(icons, 'image/svg+xml').documentElement;
  library.setAttribute('class', 'icon-library'); library.setAttribute('aria-hidden', 'true');
  document.body.prepend(document.importNode(library, true));
  try {
    const result = await sdk.data.get('voice-settings');
    version = result.version;
    stored = result.value && typeof result.value === 'object' ? result.value : {};
    state = normalizeSettings(config, stored);
    voiceEdits.set(state.voice, {pitch:state.pitch,size:state.size,texture:state.texture});
    canSave = true;
  } catch (_) { notice('Saved settings unavailable. Reload in Menu.'); }
  for (const [index, voice] of config.voices.entries()) {
    const button = document.createElement('button'); button.className = 'key';
    button.dataset.voice = voice.id;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'ui-icon'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(icon.namespaceURI, 'use'); use.setAttribute('href', '#voice-' + voice.icon);
    icon.append(use);
    const name = document.createElement('b'); name.textContent = voice.name;
    button.append(icon, name); button.onclick = () => chooseVoice(index, voice.id === state.voice); $('voices').append(button);
  }
  for (const p of config.parameters) {
    for (const bound of ['min', 'max', 'step']) $(p.id)[bound] = String(p[bound]);
    document.querySelector('label[for="'+p.id+'"]').textContent=p.control+' · '+p.label.toUpperCase();
    $(p.id).oninput = () => (p.id === 'level' ? change : adjust)({[p.id]: Number($(p.id).value)});
    rangePointer($(p.id));
  }
  $('primary').onclick = primary;
  $('audio').onclick = controlAudio;
  sdk.controls.onEvent(event => {
    if (event.type === 'rotate') {
      if (!Number.isFinite(event.delta) || event.delta === 0) return;
      for (const p of config.parameters) if (event.control === p.control) {
        const increment = event.delta * (p.encoderStep || p.step);
        if (p.id === 'level') change({level: state.level + increment});
        else adjust({[p.id]: state[p.id] + increment});
      }
    } else if (event.type === 'up' || event.type === 'cancel') pressed.delete(event.control);
    else if (event.type === 'down' && !pressed.has(event.control)) {
      pressed.add(event.control);
      for (const p of config.parameters) if (event.control === p.control) {
        const value = p.id === 'texture' ? config.voices[voiceIndex()].texture : p.default;
        if (p.id === 'level') change({level:value}); else adjust({[p.id]:value});
      }
      if (event.control === 'K2') void primary();
      if (event.control === 'K3') nextVoice(-1);
      if (event.control === 'K4') nextVoice(1);
    }
  });
  let routing = Promise.resolve();
  sdk.audio.onAvailable(() => {
    if (preview || !wantsAudio || closed) return;
    routing = routing.then(async () => {
      if (!wantsAudio || closed) return;
      await stop(); await start();
    }).catch(() => {});
  });
  addEventListener('blur', () => pressed.clear());
  render(); draw();
  await sdk.ready();
  if (!preview && !closed) void start();
}

addEventListener('pagehide', () => {
  closed = true; clearTimeout(saveTimer); clearTimeout(monitorTimer);
  cancelAnimationFrame(animation); void stop();
});
Object.defineProperty(globalThis, 'PitchPlay', {value: Object.freeze({
  get state() { return {...state, phase, preview}; },
  get levels() { return {...meter}; },
  get diagnostics() { return {...diagnostics, contextState: graph?.context.state || null}; }
})});
void init().catch(() => { $('status').textContent = 'UNAVAILABLE'; notice('App could not load. Reload in Menu.'); });
