import {recognize, NoteGate} from './gesture.mjs';
import {createTracker} from './tracker.mjs';
import {Tone} from './tone.mjs';

const sdk = globalThis.VrchApp, $ = id => document.getElementById(id);
const preview = sdk.context.mode === 'preview';
let config, gate, phase = 'idle', current = null, epoch = 0, closed = false;
let settings = {rotation: 0, mirror: true, volume: 70, voice: 'soft'}, retained = {}, version = 0;
let canSave = false, saving = false, edit = 0, savedEdit = 0, saveTimer;
let bits = [], landmarks = [], lastResult = -Infinity, count = null, raw = null, fingerCount = null, gesture = 'none';
let previewPending = null, previewEndsAt = 0, watchdog, errorText = '', frames = 0, inferenceMs = 0, orientationRevision = 0;
const pressed = new Set(), source = document.createElement('canvas'), ctx = $('camera').getContext('2d');
const sourceCtx = source.getContext('2d');
const voiceMenu = VrchPagesLiveConsoleActionPopover.createActionPopoverController({document, window});

function message(title = '', detail = '') {
  $('message').hidden = !title;
  $('message').querySelector('b').textContent = title;
  $('message').querySelector('span').textContent = detail;
}

function renderNote(value) {
  count = value;
  const note = config.notes.find(n => n.id === value);
  $('count').textContent = value === null ? '—' : note?.label || String(value);
  $('note').textContent = note?.name || 'Rest';
  $('note-hint').textContent = note?.pitch || 'No sound';
  document.querySelector('.instrument').style.setProperty('--note-color', note?.color || 'var(--paper)');
  [...$('notes').children].forEach((element, i) => {
    element.classList.toggle('is-sounding', i + 1 === value);
    if (preview) element.setAttribute('aria-pressed', String(i + 1 === value));
  });
}

function render() {
  $('status').textContent = preview ? 'NOTE PREVIEW' : ({idle: 'READY', starting: 'LOADING', live: 'LIVE', error: 'STOPPED'})[phase];
  $('start').textContent = phase === 'live' ? 'STOP' : phase === 'starting' ? 'CANCEL' : phase === 'error' ? 'RETRY' : 'START';
  $('start').hidden = preview;
  $('rotate').textContent = settings.rotation + '°';
  $('mirror').setAttribute('aria-pressed', String(settings.mirror));
  $('rotate').hidden = $('mirror').hidden = preview;
  const voice = config.voices.find(v => v.id === settings.voice);
  $('voice').textContent = 'TONE: ' + voice.name.toUpperCase();
  $('voice').setAttribute('aria-label', 'Tone: ' + voice.name);
  $('volume').value = settings.volume;
  $('volume-value').textContent = settings.volume + '%';
  if (phase === 'error') message('Let’s try again.', errorText);
  else if (phase === 'starting') message('Getting ready…', 'Preparing hand tracking');
  else if (phase === 'idle') message(preview ? 'Try the seven notes.' : 'Your hand. Your melody.', preview ? 'Choose Listen, then tap a note below.' : 'Press Start, then show one hand.');
  else message();
  $('tracking').textContent = preview ? 'SOUND ONLY · NO CAMERA' : phase === 'live' ? 'SHOW ONE WHOLE HAND' : 'ONE HAND · SEVEN NOTES';
  void sdk.monitor.set({K2: {label: preview ? '' : phase === 'live' ? 'Stop' : 'Start'}, K3: {label: preview ? '' : 'Rotate', value: preview ? '' : settings.rotation + '°'}, K4: {label: preview ? '' : 'Mirror', pressed: !preview && settings.mirror}, E1: {label: 'Volume', value: settings.volume + '%'}, E2: {label: 'Tone', value: voice.name}}).catch(() => {});
}

function tone(value, leaseMs = config.tracking.staleMs) {
  if (current) {
    current.frequency = config.notes.find(n => n.id === value)?.frequency || 0;
    current.deadline = performance.now() + leaseMs;
  }
  renderNote(value);
}

// Exactly two 20ms blocks are in flight. Playback ACKs provide the sole audio
// clock; there is no second AudioContext, interval pump or model-frame clock.
// If the UI freezes, the host drains at most 40ms and then emits silence. After
// recovery we check the wall-clock lease before generating any further sound.
async function pump(value) {
  try {
    while (current === value && !closed) {
      const now = performance.now(), remaining = Math.max(0, value.deadline - now);
      // Once the host queue has drained, resume from silence rather than
      // replaying the pre-stall envelope as a short stray note.
      if (now - value.lastGenerated > value.bufferMs) value.synth.envelope = 0;
      value.lastGenerated = now;
      value.synth.set({frequency: remaining > 0 ? value.frequency : 0, leaseMs: remaining, level: settings.volume / 100, voice: settings.voice});
      const samples = new Float32Array(960); value.synth.render(samples);
      const result = await value.output.write(samples);
      if (result.dropped) throw Error('Audio could not keep up');
    }
  } catch (error) { fail(value, error, preview ? 'Choose Listen in Apps, then tap a note.' : 'Sound stopped. Check output in Menu, then Retry.'); }
}

function rest() { gate.reset(); bits = []; landmarks = []; raw = null; fingerCount = null; gesture = 'none'; lastResult = -Infinity; tone(null, 0); }

async function release(value) {
  if (!value) return;
  value.tracker?.close(); value.unsubscribe?.();
  // A pending request can finish after cancellation. Repeated release closes
  // newly acquired handles, while the Set prevents duplicate close calls.
  await Promise.allSettled(['camera', 'output'].map(async key => {
    const resource = value[key];
    if (!resource || value.released.has(resource)) return;
    value.released.add(resource); await resource.close();
  }));
}

async function stop() {
  voiceMenu.close();
  ++epoch; previewPending = null; previewEndsAt = 0;
  const value = current; rest(); current = null; phase = 'idle'; errorText = '';
  ctx.clearRect(0, 0, $('camera').width, $('camera').height);
  if (!closed) render();
  await release(value);
}

function fail(value, error, fallback) {
  if (current !== value || closed) return;
  const stopped = stop(), token = epoch;
  void stopped.then(() => {
    if (closed || current || token !== epoch) return;
    phase = 'error'; errorText = error.code === 'permission_required' ? 'Allow the camera, then Retry.' : error.code === 'preview_io_disabled' ? 'Choose Listen in Apps, then tap a note.' : fallback;
    render();
  });
}

function receive(value, result) {
  if (current !== value || phase !== 'live' || result.sourceRevision !== orientationRevision) return;
  const now = performance.now(), age = now - result.capturedAtMs;
  inferenceMs = result.durationMs; frames++;
  if (age > config.tracking.staleMs) { rest(); return; }
  const track = result.tracks[0];
  const detected = recognize(track, config.tracking, {bits, gesture}, result.sourceWidth / result.sourceHeight);
  ({bits, fingerCount, gesture} = detected); raw = detected.note;
  landmarks = track?.landmarks || [];
  lastResult = result.capturedAtMs;
  const valueCount = gate.update(raw, result.capturedAtMs);
  tone(valueCount, config.tracking.staleMs - Math.max(0, age));
  $('tracking').textContent = raw === null ? 'SHOW ONE WHOLE HAND' : raw === 0 ? 'FIST · REST' : valueCount !== raw ? 'HOLD YOUR GESTURE' : raw === 6 ? 'THUMB + PINKY · LA' : raw === 7 ? 'OK · SI' : fingerCount + (fingerCount === 1 ? ' FINGER' : ' FINGERS') + ' · PLAYING';
}

function draw(frame, value) {
  if (current !== value || phase !== 'live') return;
  const sideways = settings.rotation % 180 !== 0;
  const width = sideways ? frame.height : frame.width, height = sideways ? frame.width : frame.height;
  if (source.width !== width || source.height !== height) { source.width = width; source.height = height; $('camera').width = width; $('camera').height = height; }
  sourceCtx.save(); sourceCtx.translate(width / 2, height / 2); sourceCtx.rotate(settings.rotation * Math.PI / 180);
  sourceCtx.drawImage(frame, -frame.width / 2, -frame.height / 2); sourceCtx.restore();
  ctx.save();
  if (settings.mirror) { ctx.translate(width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(source, 0, 0);
  if (landmarks.length === 21 && performance.now() - lastResult <= config.tracking.staleMs) {
    ctx.strokeStyle = config.notes.find(n => n.id === count)?.color || '#ededed';
    ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = Math.max(2, width / 250);
    const point = i => [landmarks[i][0] * width, (1 - landmarks[i][1]) * height];
    ctx.beginPath(); for (const [a, b] of config.connections) { ctx.moveTo(...point(a)); ctx.lineTo(...point(b)); } ctx.stroke();
    for (const i of [4,8,12,16,20]) { ctx.beginPath(); ctx.arc(...point(i), width / 100, 0, 2 * Math.PI); ctx.fill(); }
  }
  ctx.restore();
  void value.tracker.frame(source, performance.now(), orientationRevision);
}

async function start() {
  if (closed || phase === 'starting' || phase === 'live') return;
  const token = ++epoch, value = {released: new Set(), frequency: 0, deadline: 0, synth: new Tone(48000, config.sound, config.voices)};
  const check = () => { if (closed || token !== epoch) throw Object.assign(Error('Cancelled'), {cancelled: true}); };
  current = value; phase = 'starting'; render();
  let step = 'Sound unavailable. Check output in Menu, then Retry.';
  try {
    value.output = await sdk.audio.openOutput({channels: 1}); check();
    value.bufferMs = 2 * value.output.blockFrames / value.output.sampleRate * 1000;
    value.lastGenerated = performance.now();
    value.output.onError(error => fail(value, error, 'Sound stopped. Check output in Menu, then Retry.'));
    void pump(value); void pump(value);
    if (!preview) {
      step = 'Hand tracking could not start. Retry.';
      value.tracker = createTracker(result => receive(value, result), error => fail(value, error, 'Hand tracking stopped. Retry.'));
      await value.tracker.ready; check();
      step = 'Connect a camera, then Retry.';
      value.camera = await sdk.camera.open({width: 640, height: 480, frameRate: 30}); check();
      value.camera.onError(error => fail(value, error, 'Camera stopped. Reconnect it, then Retry.'));
      value.unsubscribe = value.camera.onFrame(frame => draw(frame, value));
    }
    phase = 'live'; render();
  } catch (error) {
    // Closing output rejects pending writes. Detach first so those secondary
    // errors cannot replace the original camera/model failure or cancel Retry.
    if (current === value) current = null;
    await release(value);
    if (error.cancelled || token !== epoch || closed) return;
    current = null; previewPending = null; phase = 'error';
    errorText = error.code === 'permission_required' ? 'Allow the camera, then Retry.' : preview ? 'Choose Listen in Apps, then tap a note.' : step;
    render();
  }
}

function change(values) {
  settings = {...settings, ...values};
  if ('rotation' in values) { orientationRevision++; rest(); }
  render(); edit++; clearTimeout(saveTimer); saveTimer = setTimeout(save, 350);
}

async function save() {
  if (!canSave || saving || closed) return;
  saving = true;
  try {
    while (savedEdit !== edit) {
      const target = edit, value = {...retained, ...settings};
      const result = await sdk.data.set('settings', value, {expectedVersion: version});
      version = result.version; retained = value; savedEdit = target;
    }
  } catch (_) { canSave = false; $('hint').textContent = 'Settings not saved. Reload in Menu.'; }
  finally { saving = false; }
}

async function audition(n) {
  previewPending = n;
  if (phase !== 'live') await start();
  if (previewPending !== null && phase === 'live') {
    const selected = previewPending; previewPending = null;
    previewEndsAt = performance.now() + config.sound.previewMs;
    tone(selected, config.sound.previewMs); message('Note preview', 'No camera recognition in Preview');
  }
}

async function initialize() {
  config = await (await fetch(new URL('instrument.json', import.meta.url))).json(); gate = new NoteGate(config.tracking);
  for (const note of config.notes) {
    const element = document.createElement(preview ? 'button' : 'div');
    element.className = 'key'; element.style.setProperty('--color', note.color);
    const number = document.createElement('b'), name = document.createElement('span');
    number.textContent = note.label; element.title = note.gesture; name.textContent = note.name; element.append(number, name);
    if (preview) {
      element.setAttribute('aria-label', 'Preview ' + note.name);
      element.onpointerdown = event => { event.preventDefault(); void audition(note.id); };
      element.onkeydown = event => { if ([' ', 'Enter'].includes(event.key) && !event.repeat) { event.preventDefault(); void audition(note.id); } };
    }
    $('notes').append(element);
  }
  if (preview) $('hint').textContent = 'Tap a note to hear a short preview';
  try {
    const data = await sdk.data.get('settings'); retained = data?.value || {}; version = data?.version || 0;
    settings = {rotation: [0,90,180,270].includes(retained.rotation) ? retained.rotation : 0,
      mirror: typeof retained.mirror === 'boolean' ? retained.mirror : true,
      volume: Number.isFinite(retained.volume) ? Math.max(0, Math.min(100, retained.volume)) : 70,
      voice: config.voices.some(v => v.id === retained.voice) ? retained.voice : config.voices[0].id};
    canSave = true;
  } catch (_) { $('hint').textContent = 'Settings unavailable. Reload to restore them.'; }
  const primary = () => phase === 'live' || phase === 'starting' ? stop() : start();
  $('start').onclick = primary;
  $('rotate').onclick = () => change({rotation: (settings.rotation + 90) % 360});
  $('mirror').onclick = () => change({mirror: !settings.mirror});
  $('voice').onclick = () => voiceMenu.open($('voice'), config.voices.map(voice => ({...voice, label: voice.name, current: voice.id === settings.voice, currentIconClass: ' '})), {className: 'ui-action-popover--touch', align: 'right', minWidth: 205, onSelect: voice => change({voice: voice.id})});
  const rotateVoice = delta => {
    const index = config.voices.findIndex(v => v.id === settings.voice), length = config.voices.length;
    voiceMenu.close(); change({voice: config.voices[((index + Math.trunc(delta)) % length + length) % length].id});
  };
  $('volume').oninput = () => change({volume: Number($('volume').value)});
  sdk.audio.onAvailable(() => { if (preview && phase === 'live') void stop(); });
  sdk.controls.onEvent(event => {
    if (event.type === 'rotate' && event.control === 'E1' && Number.isFinite(event.delta)) change({volume: Math.max(0, Math.min(100, settings.volume + event.delta * 2))});
    if (event.type === 'rotate' && event.control === 'E2' && Number.isFinite(event.delta)) rotateVoice(event.delta);
    if (event.type === 'up' || event.type === 'cancel') pressed.delete(event.control);
    if (event.type === 'down' && !pressed.has(event.control)) {
      pressed.add(event.control);
      if (event.control === 'E2') rotateVoice(1);
      if (!preview && event.control === 'K2') void primary();
      if (!preview && event.control === 'K3') $('rotate').click();
      if (!preview && event.control === 'K4') $('mirror').click();
    }
  });
  watchdog = setInterval(() => {
    if (phase !== 'live') return;
    if (preview) { if (previewEndsAt && performance.now() >= previewEndsAt) { previewEndsAt = 0; tone(null, 0); } }
    else if (performance.now() - lastResult > config.tracking.staleMs) {
      rest(); $('tracking').textContent = 'SHOW ONE WHOLE HAND';
    }
  }, 50);
  renderNote(null); await sdk.ready(); render(); $('start').disabled = false;
}

addEventListener('blur', () => { pressed.clear(); });
addEventListener('keydown', event => {
  if (event.key === 'Escape' && voiceMenu.isOpen()) {
    event.preventDefault(); event.stopPropagation(); voiceMenu.close({restoreFocus: true});
  }
}, true);
document.addEventListener('visibilitychange', () => { if (document.hidden && config) void stop(); });
addEventListener('pagehide', () => { closed = true; clearTimeout(saveTimer); clearInterval(watchdog); if (config) void stop(); });
Object.defineProperty(globalThis, 'PalmNotes', {value: Object.freeze({get state() { return {phase, count, raw, fingerCount, gesture, bits: [...bits], frames, inferenceMs, settings: {...settings}, preview}; }})});
initialize().catch(() => { message('Unable to open PalmNotes.', 'Reload in Menu.'); });
