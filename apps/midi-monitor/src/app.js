'use strict';
const sdk = window.VrchApp;
const $ = id => document.getElementById(id);
const selected = {input:null, output:null};
const voices = new Map(), sustain = new Set();
let listening = true, openingAudio;
let audio, frame, received = 0, last, testing = false;
const names = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const parameters = [
  {control:'E1', label:'Channel', min:1, max:16, value:1},
  {control:'E2', label:'Note', min:0, max:127, value:60},
  {control:'E3', label:'Velocity', min:1, max:127, value:96},
  {control:'E4', label:'CC1', min:0, max:127, value:127}
];
const [sendChannel, sendNote, sendVelocity, sendCC] = parameters;
const actions = {K2:'listen', K3:'testNote', K4:'testCC'};
const heldKeys = new Set();
let controlsReady = false, monitorFrame = 0, publishing = false;

function noteName(number) {
  return names[number % 12] + (Math.floor(number / 12) - 1);
}
function displayParameter(parameter) {
  return parameter === sendNote ? noteName(parameter.value) : String(parameter.value);
}
function refreshMonitor() {
  if (!controlsReady || monitorFrame || publishing) return;
  monitorFrame = requestAnimationFrame(async () => {
    monitorFrame = 0;
    const values = Object.fromEntries(parameters.map(p => [p.control, {label:p.label, value:displayParameter(p)}]));
    values.K2 = {label:'Listen', pressed:listening};
    values.K3 = {label:'Send note', pressed:testing};
    values.K4 = {label:'Send CC1', pressed:heldKeys.has('K4')};
    publishing = true;
    monitorDirty = false;
    try { await sdk.monitor.set(values); }
    catch (error) { console.warn('MIDI Monitor controls:', error.message); }
    finally { publishing = false; if (monitorDirty) refreshMonitor(); }
  });
}
let monitorDirty = false;
function monitorChanged() {
  monitorDirty = true;
  refreshMonitor();
}
function setParameter(parameter, value) {
  const next = Math.max(parameter.min, Math.min(parameter.max, Math.trunc(value)));
  if (!Number.isFinite(next)) return;
  parameter.value = next;
  parameter.slider.value = String(next);
  parameter.readout.textContent = displayParameter(parameter);
  parameter.slider.setAttribute('aria-valuetext', displayParameter(parameter));
  monitorChanged();
}
for (const parameter of parameters) {
  const cell = document.createElement('div');
  cell.className = 'parameter';
  const title = document.createElement('label');
  title.className = 'parameter-title';
  const key = document.createElement('kbd');
  key.textContent = parameter.control;
  title.append(key, parameter.label);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = parameter.min; slider.max = parameter.max;
  slider.id = 'send-' + parameter.control;
  title.htmlFor = slider.id;
  slider.oninput = () => setParameter(parameter, slider.valueAsNumber);
  const readout = document.createElement('output');
  readout.htmlFor.add(slider.id);
  parameter.slider = slider;
  parameter.readout = readout;
  cell.append(title, readout, slider);
  $('parameters').append(cell);
  setParameter(parameter, parameter.value);
}
function onControl({control, type, delta}) {
  if (type === 'rotate') {
    const parameter = parameters.find(item => item.control === control);
    if (parameter && Number.isFinite(delta)) setParameter(parameter, parameter.value + delta);
    return;
  }
  const id = actions[control];
  if (!id) return;
  if (type === 'down' && !heldKeys.has(control)) {
    heldKeys.add(control);
    if (!$(id).disabled) $(id).click();
  } else if (type === 'up' || type === 'cancel') heldKeys.delete(control);
  monitorChanged();
}
function silence(key) {
  const voice = voices.get(key);
  if (!voice) return;
  voices.delete(key);
  const now = voice.osc.context.currentTime;
  voice.gain.gain.setTargetAtTime(0, now, .006);
  voice.osc.stop(now + .04);
}
function silenceAll() {
  for (const key of voices.keys()) silence(key);
  sustain.clear();
}
function play(status, data, value) {
  if (!audio?.node) return;
  const channel = status & 15, type = status >> 4, key = channel * 128 + data;
  if (type === 11) {
    if (data === 64) {
      if (value >= 64) sustain.add(channel);
      else {
        sustain.delete(channel);
        for (const [id, voice] of voices) if ((id >> 7) === channel && voice.released) silence(id);
      }
    }
    return;
  }
  if (type === 8 || !value) {
    const voice = voices.get(key);
    if (voice && sustain.has(channel)) voice.released = true;
    else silence(key);
    return;
  }
  silence(key);
  if (voices.size >= 32) silence(voices.keys().next().value);
  const ctx = audio.ctx, osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.setPeriodicWave(audio.wave); osc.frequency.value = 440 * 2 ** ((data - 69) / 12);
  // Soft pad hits can arrive at velocities 1–5. Keep them audible while preserving accents.
  const level = .045 + .36 * Math.sqrt(value / 127);
  gain.gain.value = 0; gain.gain.setTargetAtTime(level, ctx.currentTime, .003);
  osc.connect(gain).connect(audio.master);
  osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  voices.set(key, {osc, gain, released:false}); osc.start();
}
function render() {
  frame = 0;
  const [status, data, value] = last, type = status >> 4;
  const off = type === 8 || (type === 9 && !value);
  $('kind').textContent = type === 11 ? 'Control change' : off ? 'Note off' : 'Note on';
  $('note').textContent = type === 11 ? 'CC ' + data : noteName(data);
  $('valueLabel').textContent = type === 11 ? 'Value' : 'Velocity';
  $('value').textContent = value;
  $('meter').firstElementChild.style.width = (off ? 0 : value / 127 * 100) + '%';
  document.querySelector('.signal').style.backgroundColor = 'rgb(' + (24 + (off ? 0 : value)) + ',24,' + (24 + (off ? 0 : Math.round(value * .4))) + ')';
  $('channel').textContent = 'Channel ' + ((status & 15) + 1);
  $('raw').textContent = Array.from(last, b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
  $('count').textContent = received + ' received';
}
function clearInputReadings() {
  cancelAnimationFrame(frame);
  frame = 0;
  last = null;
  received = 0;
  $('kind').textContent = 'Input';
  $('note').textContent = '—';
  $('valueLabel').textContent = 'Velocity';
  $('value').textContent = '—';
  $('meter').firstElementChild.style.width = '';
  document.querySelector('.signal').style.backgroundColor = '';
  $('channel').textContent = 'Channel —';
  $('raw').textContent = '—';
  $('count').textContent = '0 received';
}
function onMessage(bytes) {
  received++; last = bytes;
  play(...bytes);
  if (!frame) frame = requestAnimationFrame(render);
}
function ports() {
  for (const direction of ['input','output'])
    $(direction).querySelector('span').textContent = selected[direction]?.name || 'Choose port';
  const available = selected.output?.state === 'open';
  $('testNote').disabled = !available || testing;
  $('testCC').disabled = !available;
  monitorChanged();
}
async function choose(direction, automatic = false) {
  try {
    if (direction === 'input' && listening) void startListening();
    const handle = automatic ? await sdk.midi.openDefaultPort({direction}) : await sdk.midi.requestPort({direction});
    if (!handle) return;
    selected[direction] = handle;
    if (direction === 'input') {
      silenceAll();
      clearInputReadings();
      handle.onMessage(bytes => { if (selected.input === handle) onMessage(bytes); });
    }
    handle.onStateChange(({state}) => {
      if (selected[direction] !== handle) return;
      if (direction === 'input' && state !== 'open') silenceAll();
      if (state === 'closed') {
        selected[direction] = null;
        if (direction === 'input') clearInputReadings();
      }
      ports();
    });
    $('status').textContent = ''; ports();
  } catch (error) { $('status').textContent = error.message; }
}
function showListening() {
  $('listen').setAttribute('aria-pressed', String(listening));
  $('listen').querySelector('span').textContent = listening ? 'Listen on' : 'Listen';
  monitorChanged();
}
async function closeAudio(current) {
  try { await current?.port?.close(); }
  finally { await current?.ctx.close(); }
}
async function openAudio() {
  const ctx = new AudioContext({sampleRate:48000, latencyHint:'interactive', sinkId:{type:'none'}});
  let port;
  try {
    const started = ctx.resume();
    // A muted AudioContext feeds the SDK; the host owns physical output routing.
    port = await sdk.audio.openOutput({channels:1});
    const node = await port.createNode(ctx);
    await started;
    const master = ctx.createDynamicsCompressor();
    master.threshold.value = -10; master.knee.value = 6; master.ratio.value = 4;
    master.connect(node);
    const harmonics = Float32Array.of(0, 1, .8, .65, .52, .42, .28, .18, .12);
    const wave = ctx.createPeriodicWave(new Float32Array(harmonics.length), harmonics);
    if (!listening) { await closeAudio({port, ctx}); return; }
    audio = {ctx, port, node, master, wave};
    port.onError(error => {
      if (audio?.port !== port) return;
      silenceAll(); audio = null;
      void ctx.close().catch(() => {});
      listening = false; showListening();
      $('status').textContent = error.message;
    });
  } catch (error) { await closeAudio({port, ctx}).catch(() => {}); throw error; }
}
function startListening() {
  if (audio || openingAudio || !listening) return;
  openingAudio = openAudio().catch(error => {
    listening = false; showListening();
    $('status').textContent = error.message;
  }).finally(() => { openingAudio = null; });
}
function toggleListen() {
  listening = !listening;
  showListening();
  if (listening) startListening();
  else if (audio) {
    silenceAll();
    const current = audio; audio = null;
    void closeAudio(current).catch(error => { $('status').textContent = error.message; });
  }
}
async function test(note) {
  const handle = selected.output;
  if (handle?.state !== 'open' || (note && testing)) return;
  const channel = sendChannel.value - 1;
  const pitch = sendNote.value;
  try {
    if (note) {
      testing = true; ports();
      await handle.send(Uint8Array.of(0x90 | channel, pitch, sendVelocity.value));
      await new Promise(resolve=>setTimeout(resolve,250));
      await handle.send(Uint8Array.of(0x80 | channel, pitch, 0));
    } else await handle.send(Uint8Array.of(0xb0 | channel, 1, sendCC.value));
    $('status').textContent = 'Submitted locally · ' + handle.name;
  } catch (error) { $('status').textContent = error.message; }
  finally { if(note) testing=false; ports(); }
}
$('input').onclick=()=>choose('input'); $('output').onclick=()=>choose('output');
$('listen').onclick=toggleListen; $('testNote').onclick=()=>test(true); $('testCC').onclick=()=>test(false);
addEventListener('pagehide', () => {
  listening = false;
  silenceAll();
  if (audio) { const current = audio; audio = null; void closeAudio(current).catch(() => {}); }
});
sdk.ready().then(async ()=>{
  sdk.controls.onEvent(onControl);
  controlsReady = true;
  monitorChanged();
  if (!sdk.midi || (sdk.context.mode === 'preview' && !navigator.requestMIDIAccess)) { $('status').textContent='Web MIDI is unavailable. Open this App in a browser with Web MIDI support.'; return; }
  $('listen').disabled = false;
  for (const direction of ['input', 'output']) {
    if (sdk.context.mode === 'device' && sdk.midi.openDefaultPort) await choose(direction, true);
  }
  $('input').disabled = $('output').disabled = false;
}).catch(error=>{ $('status').textContent=error.message; });
