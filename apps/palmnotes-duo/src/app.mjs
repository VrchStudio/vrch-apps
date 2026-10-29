import {recognize, NoteGate} from './gesture.mjs';
import {createTracker} from './tracker.mjs';
import {Tone} from './tone.mjs';

const sdk = globalThis.VrchApp, $ = id => document.getElementById(id);
const preview = sdk.context.mode === 'preview';
let config, gate, phase = 'idle', current = null, epoch = 0, closed = false;
let settings = {volume: 70, voice: 'soft', melodyHand: 'left'}, retained = {}, version = 0;
let canSave = false, saving = false, edit = 0, savedEdit = 0, saveTimer;
let landmarks = [], lastResult = -Infinity, count = null, octave = null, soundingKey = null, raw = null, hands = {}, bits = {}, gesture = 'none', melodyGesture = 'none';
let previewPending = null, previewEndsAt = 0, watchdog, errorText = '', frames = 0, inferenceMs = 0, mappingRevision = 0;
const pressed = new Set(), source = document.createElement('canvas'), ctx = $('camera').getContext('2d');
const sourceCtx = source.getContext('2d');
if(preview)document.body.classList.add('is-preview');

function message(title = '', detail = '') {
  $('message').hidden = !title;
  $('message').querySelector('b').textContent = title;
  $('message').querySelector('span').textContent = detail;
}

function renderNote(value) {
  soundingKey = value;
  const sound = config.sounds.find(n => n.id === value);
  count = sound?.note ?? (value === 0 ? 0 : null); octave = sound?.octave ?? null;
  const note = config.notes.find(n => n.id === count);
  $('count').textContent = note?.label || '—';
  $('note').textContent = note?.name || 'Rest';
  $('note-hint').textContent = sound?.pitch || 'No sound';
  document.querySelector('.instrument').style.setProperty('--note-color', note?.color || 'var(--paper)');
  [...$('registers').children].forEach((element,i) => element.classList.toggle('is-sounding', sound?.octave === config.registers[i].octave));
  [...$('notes').children].forEach((element, i) => {
    element.classList.toggle('is-sounding', i + 1 === count);
    if (preview) element.setAttribute('aria-pressed', String(i + 1 === count));
  });
}

function render() {
  $('status').textContent = preview ? 'NOTE PREVIEW' : ({idle: 'READY', starting: 'LOADING', live: 'LIVE', error: 'STOPPED'})[phase];
  const voice = config.voices.find(v => v.id === settings.voice);
  const role=config.handRoles.find(r=>r.id===settings.melodyHand);
  if (phase === 'error') message('Let’s try again.', errorText);
  else if (phase === 'starting') message('Getting ready…', 'Preparing hand tracking');
  else if (phase === 'idle') message(preview ? 'Hear the seven notes.' : 'Play with your hands.', preview ? 'Choose Listen, then tap a note below.' : role.hint + ' Press K2 to begin.');
  else message();
  $('tracking').textContent = preview ? 'SOUND PREVIEW' : phase === 'live' ? 'SHOW BOTH HANDS' : '';
  void sdk.monitor.set({K2: {label: preview ? '' : phase === 'live' ? 'Stop' : 'Start'}, E1: {label: 'Volume', value: settings.volume + '%'}, E2: {label: 'Tone', value: voice.name}, K3: {label: 'Note hand', value: role.monitor}}).catch(() => {});
}

function tone(value, leaseMs = config.tracking.staleMs) {
  if (current) {
    const selected=config.sounds.find(n=>n.id===value);
    current.frequency = selected?.frequency || 0;
    if(selected)current.octave=selected.octave;
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
      value.synth.set({frequency: remaining > 0 ? value.frequency : 0, leaseMs: remaining, level: settings.volume / 100, voice: settings.voice, octave: value.octave});
      const samples = new Float32Array(960); value.synth.render(samples);
      const result = await value.output.write(samples);
      if (result.dropped) throw Error('Audio could not keep up');
    }
  } catch (error) { fail(value, error, preview ? 'Choose Listen in Apps, then tap a note.' : 'Sound stopped. Check output in Menu, then Retry.'); }
}

function rest() { gate.reset(); landmarks = []; raw = null; hands = {}; bits = {}; $('hands').textContent = 'LEFT — · RIGHT —'; gesture = 'none'; melodyGesture = 'none'; lastResult = -Infinity; tone(null, 0); }

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
  if (current !== value || phase !== 'live' || result.sourceRevision !== mappingRevision) return;
  const now = performance.now(), age = now - result.capturedAtMs;
  inferenceMs = result.durationMs; frames++;
  if (age > config.tracking.staleMs) { rest(); return; }
  const detected = recognize(result.tracks, {...config.tracking,melodyHand:settings.melodyHand}, {bits,melodyGesture}, result.sourceWidth / result.sourceHeight, config.sounds);
  ({hands, bits, gesture, melodyGesture} = detected); raw = detected.key;
  landmarks = Object.values(hands).map(hand => hand.landmarks);
  lastResult = result.capturedAtMs;
  const valueCount = gate.update(raw, result.capturedAtMs);
  tone(valueCount, config.tracking.staleMs - Math.max(0, age));
  const noteSide=settings.melodyHand, controlSide=noteSide==='left'?'right':'left';
  const noteHand=hands[noteSide], controlHand=hands[controlSide];
  $('hands').textContent = noteSide.toUpperCase() + ' ' + (config.notes.find(n=>n.id===noteHand?.note)?.name || '—') + ' · ' + controlSide.toUpperCase() + ' ' + (config.registers.find(r=>r.octave===controlHand?.octave)?.label || '—');
  $('tracking').textContent = raw === null ? 'SHOW BOTH HANDS' : gesture === 'octave' ? 'OCTAVE: FIST / THUMB UP / DOWN' : '';
}

function draw(frame, value) {
  if (current !== value || phase !== 'live') return;
  const width=frame.width, height=frame.height;
  if (source.width !== width || source.height !== height) {source.width=width;source.height=height;$('camera').width=width;$('camera').height=height;}
  sourceCtx.drawImage(frame,0,0);
  ctx.save();
  ctx.drawImage(source, 0, 0);
  if (performance.now() - lastResult <= config.tracking.staleMs) for (const hand of landmarks) {
    const melody=hands[settings.melodyHand]?.landmarks===hand;
    ctx.strokeStyle = melody ? config.notes.find(n=>n.id===count)?.color || '#ededed' : '#ededed';
    ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = Math.max(2, width / 250);
    const point = i => [hand[i][0] * width, (1 - hand[i][1]) * height];
    ctx.beginPath(); for (const [a, b] of config.connections) { ctx.moveTo(...point(a)); ctx.lineTo(...point(b)); } ctx.stroke();
    for (const i of [4,8,12,16,20]) { ctx.beginPath(); ctx.arc(...point(i), width / 100, 0, 2 * Math.PI); ctx.fill(); }
  }
  ctx.restore();
  void value.tracker.frame(source, performance.now(), mappingRevision);
}

async function start() {
  if (closed || phase === 'starting' || phase === 'live') return;
  const token = ++epoch, value = {released: new Set(), frequency: 0, octave: 0, deadline: 0, synth: new Tone(48000, config.sound, config.voices)};
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
  const roleChanged='melodyHand' in values && values.melodyHand!==settings.melodyHand;
  settings = {...settings, ...values};
  if (roleChanged) { mappingRevision++; rest(); }
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
  } catch (_) { canSave = false; $('hint').hidden=false; $('hint').textContent = 'Settings not saved. Reload in Menu.'; }
  finally { saving = false; }
}

async function audition(n) {
  previewPending = n;
  if (phase !== 'live') await start();
  if (previewPending !== null && phase === 'live') {
    const selected = previewPending; previewPending = null;
    previewEndsAt = performance.now() + config.sound.previewMs;
    tone(config.sounds.find(n=>n.note===selected&&n.octave===0).id, config.sound.previewMs); message('Note preview', 'No camera recognition in Preview');
  }
}

async function initialize() {
  config = await (await fetch(new URL('instrument.json', import.meta.url))).json(); gate = new NoteGate(config.tracking);
  for (const note of config.notes) {
    const element = document.createElement(preview ? 'button' : 'div');
    element.className = preview ? 'scale-note key' : 'scale-note'; element.style.setProperty('--color', note.color);
    const number = document.createElement('b'), name = document.createElement('span');
    number.textContent = note.label; element.title = note.gesture; name.textContent = note.name; element.append(number, name);
    if (preview) {
      element.setAttribute('aria-label', 'Preview ' + note.name);
      element.onpointerdown = event => { event.preventDefault(); void audition(note.id); };
      element.onkeydown = event => { if ([' ', 'Enter'].includes(event.key) && !event.repeat) { event.preventDefault(); void audition(note.id); } };
    }
    $('notes').append(element);
  }
  for (const register of config.registers) {const el=document.createElement('span');el.textContent=register.display;el.title=register.gesture+' · '+register.label;$('registers').append(el);}
  if (preview) {$('hint').hidden=false; $('hint').textContent = 'Tap a note to hear a short preview';}
  try {
    const data = await sdk.data.get('settings'); retained = data?.value || {}; version = data?.version || 0;
    settings = {volume: Number.isFinite(retained.volume) ? Math.max(0, Math.min(100, retained.volume)) : 70,
      voice: config.voices.some(v => v.id === retained.voice) ? retained.voice : config.voices[0].id,
      melodyHand: config.handRoles.some(r=>r.id===retained.melodyHand)?retained.melodyHand:config.tracking.melodyHand};
    canSave = true;
  } catch (_) { $('hint').hidden=false; $('hint').textContent = 'Settings unavailable. Reload to restore them.'; }
  const primary = () => phase === 'live' || phase === 'starting' ? stop() : start();
  const rotateVoice = delta => {
    const index = config.voices.findIndex(v => v.id === settings.voice), length = config.voices.length;
    change({voice: config.voices[((index + Math.trunc(delta)) % length + length) % length].id});
  };
  sdk.audio.onAvailable(() => { if (preview && phase === 'live') void stop(); });
  sdk.controls.onEvent(event => {
    if (event.type === 'rotate' && event.control === 'E1' && Number.isFinite(event.delta)) change({volume: Math.max(0, Math.min(100, settings.volume + event.delta * 2))});
    if (event.type === 'rotate' && event.control === 'E2' && Number.isFinite(event.delta)) rotateVoice(event.delta);
    if (event.type === 'up' || event.type === 'cancel') pressed.delete(event.control);
    if (event.type === 'down' && !pressed.has(event.control)) {
      pressed.add(event.control);
      if (event.control === 'E2') rotateVoice(1);
      if (event.control === 'K3') change({melodyHand:settings.melodyHand==='left'?'right':'left'});
      if (!preview && event.control === 'K2') void primary();
    }
  });
  watchdog = setInterval(() => {
    if (phase !== 'live') return;
    if (preview) { if (previewEndsAt && performance.now() >= previewEndsAt) { previewEndsAt = 0; tone(null, 0); } }
    else if (performance.now() - lastResult > config.tracking.staleMs) {
      rest(); $('tracking').textContent = 'SHOW BOTH HANDS';
    }
  }, 50);
  renderNote(null); await sdk.ready(); render();
}

addEventListener('blur', () => { pressed.clear(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && config) void stop(); });
addEventListener('pagehide', () => { closed = true; clearTimeout(saveTimer); clearInterval(watchdog); if (config) void stop(); });
Object.defineProperty(globalThis, 'PalmNotesDuo', {value: Object.freeze({get state() { return {phase, count, octave, soundingKey, raw, gesture, hands: Object.fromEntries(Object.entries(hands).map(([side,hand]) => [side,{note:hand.note,octave:hand.octave,gesture:hand.gesture,bits:hand.bits}])), frames, inferenceMs, settings: {...settings}, preview}; }})});
initialize().catch(() => { message('Unable to open PalmNotes Duo.', 'Reload in Menu.'); });
