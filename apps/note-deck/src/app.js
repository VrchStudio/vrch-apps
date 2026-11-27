'use strict';
const sdk = window.VrchApp;
const el = id => document.getElementById(id);
const tones = ['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];
const scales = [
  ['Major',[0,2,4,5,7,9,11]], ['Natural Minor',[0,2,3,5,7,8,10]],
  ['Dorian',[0,2,3,5,7,9,10]], ['Phrygian',[0,1,3,5,7,8,10]],
  ['Lydian',[0,2,4,6,7,9,11]], ['Mixolydian',[0,2,4,5,7,9,10]],
  ['Locrian',[0,1,3,5,6,8,10]], ['Harmonic Minor',[0,2,3,5,7,8,11]],
  ['Melodic Minor (Ascending)',[0,2,3,5,7,9,11]], ['Major Pentatonic',[0,2,4,7,9]],
  ['Minor Pentatonic',[0,3,5,7,10]], ['Blues',[0,3,5,6,7,10]],
  ['Whole Tone',[0,2,4,6,8,10]], ['Half–Whole Diminished',[0,1,3,4,6,7,9,10]],
  ['Whole–Half Diminished',[0,2,3,5,6,8,9,11]], ['Chromatic',[0,1,2,3,4,5,6,7,8,9,10,11]]
];
const actions = {K2:['Start / Stop',100], K3:['Capture',101], K4:['Undo',102]};
const macros = Array(8).fill(64);
const touches = new Map(), voices = new Map(), pressed = new Map();
let drums = false, root = 0, scale = 0, bank = 0, output = null;
let choosing = false, ready = false, monitorPending = false, monitorDirty = false;
const clamp = (number, min, max) => Math.min(max,Math.max(min,number));
const noteName = note => tones[note % 12] + (Math.floor(note / 12) - 2);
const show = message => { el('event').textContent = message; };
let localSound = null, soundBusy = false, leaving = false;
const currentOutput = () => output?.state === 'open' ? output : null;

function performanceOutput() {
  const port = currentOutput();
  if (!port) show(output?.state === 'suspended' ? 'Not sent · Wake USB host' : sdk.context.mode === 'preview' ? 'Choose a MIDI output' : 'Not sent · Connect USB');
  return port;
}
function padVelocity(position) {
  // Give the middle of a pad a gentler slope while keeping both edges expressive.
  if (position < 0.35) return Math.round(24 + 48 * position / 0.35);
  if (position <= 0.65) return Math.round(72 + 16 * (position - 0.35) / 0.30);
  return Math.round(88 + 39 * (position - 0.65) / 0.35);
}
function send(port, status, number, value) {
  if (port?.state !== 'open') return;
  port.send(Uint8Array.of(status, number, value)).catch(error => {
    if (port === currentOutput()) show('Not sent · ' + error.message);
  });
}
function noteOn(id, pad, velocity) {
  if (touches.has(id) || (choosing && !localSound) || !el('sheet').hidden) return;
  const port = currentOutput();
  if (!port && !localSound) {
    if (sdk.context.mode === 'preview') show('Turn on Local sound to play');
    else performanceOutput();
    return;
  }
  const note = Number(pad.dataset.note);
  const voice = voices.get(note);
  if (voice) voice.count++;
  else {
    voices.set(note, {count:1, port, stopLocal:localSound?.play(note,velocity,drums)});
    send(port, 0x90, note, velocity);
  }
  touches.set(id, {pad,note,velocity});
  pad.classList.add('down');
  show(noteName(note) + ' · Vel ' + velocity);
}
function noteOff(id) {
  const hit = touches.get(id);
  if (!hit) return;
  touches.delete(id);
  if (![...touches.values()].some(other => other.pad === hit.pad)) hit.pad.classList.remove('down');
  const voice = voices.get(hit.note);
  if (--voice.count === 0) {
    voices.delete(hit.note);
    voice.stopLocal?.();
    send(voice.port, 0x80, hit.note, 0);
    if (voice.stopLocal || voice.port === currentOutput()) show(noteName(hit.note) + ' · Vel ' + hit.velocity + ' · Off');
  }
}
function keyUp(control) {
  if (!pressed.has(control)) return;
  const port = pressed.get(control);
  pressed.delete(control);
  send(port, 0xb0, actions[control][1], 0);
  syncMonitor();
}
function releasePads() {
  for (const id of touches.keys()) noteOff(id);
}
function releaseAll() {
  releasePads();
  for (const key of pressed.keys()) keyUp(key);
}
function renderPads() {
  releasePads();
  const grid = el('pads');
  grid.replaceChildren();
  grid.classList.toggle('drums', drums);
  const size = drums ? 4 : 5;
  const steps = scales[scale][1];
  for (let row = size - 1; row >= 0; row--) {
    for (let col = 0; col < size; col++) {
      const index = row * size + col;
      const note = drums ? 36 + index : 48 + root + 12 * Math.floor(index / steps.length) + steps[index % steps.length];
      const pad = document.createElement('button');
      pad.dataset.note = note;
      pad.classList.toggle('root', !drums && index % steps.length === 0);
      pad.textContent = noteName(note);
      if (drums) {
        const number = document.createElement('small');
        number.textContent = String(index + 1).padStart(2, '0');
        pad.prepend(number);
      }
      pad.setAttribute('aria-label', (drums ? 'Drum pad ' + (index + 1) + ', ' : '') + noteName(note) + ', MIDI ' + note);
      pad.onpointerdown = event => {
        if (event.button !== 0) return;
        event.preventDefault();
        pad.setPointerCapture(event.pointerId);
        const bounds = pad.getBoundingClientRect();
        const position = clamp((bounds.bottom - event.clientY) / bounds.height, 0, 1);
        noteOn(event.pointerId, pad, padVelocity(position));
      };
      pad.onpointerup = pad.onpointercancel = pad.onlostpointercapture = event => noteOff(event.pointerId);
      pad.onkeydown = event => {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        if (!event.repeat) noteOn(pad, pad, 96);
      };
      pad.onkeyup = event => {
        if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); noteOff(pad); }
      };
      pad.onblur = () => noteOff(pad);
      grid.append(pad);
    }
  }
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.setAttribute('aria-pressed', String((button.dataset.mode === 'drums') === drums));
  }
  el('drum-range').hidden = !drums;
  el('tonal').hidden = drums;
  el('tonal').textContent = tones[root] + ' ' + scales[scale][0].replace(' (Ascending)', '');
}
function syncMonitor() {
  monitorDirty = true;
  if (!ready || monitorPending) return;
  monitorPending = true;
  requestAnimationFrame(async () => {
    monitorDirty = false;
    const labels = {};
    for (let i = 0; i < 4; i++) {
      const index = 4 * bank + i;
      labels['E' + (i + 1)] = {label:'Macro ' + (index + 1), value:String(macros[index])};
    }
    for (const [control,[label]] of Object.entries(actions)) labels[control] = {label, pressed:pressed.has(control)};
    try { await sdk.monitor.set(labels); }
    catch (error) { console.warn(error.message); }
    finally { monitorPending = false; if (monitorDirty) syncMonitor(); }
  });
}
function onControl({control, type, delta}) {
  if (type === 'up' || type === 'cancel') { keyUp(control); return; }
  if (choosing) return;
  if (type === 'rotate' && /^E[1-4]$/.test(control) && Number.isFinite(delta)) {
    const port = performanceOutput();
    if (!port) return;
    const index = bank * 4 + Number(control[1]) - 1;
    macros[index] = clamp(macros[index] + Math.trunc(delta), 0, 127);
    send(port, 0xb0, 20 + index, macros[index]);
    show('Macro ' + (index + 1) + ' · CC' + (20 + index) + ' = ' + macros[index]);
    syncMonitor();
  } else if (type === 'down' && actions[control] && !pressed.has(control)) {
    const port = performanceOutput();
    if (!port) return;
    const [name, cc] = actions[control];
    pressed.set(control, port);
    send(port, 0xb0, cc, 127);
    show(name + ' · CC' + cc);
    syncMonitor();
  }
}
function releaseMidi() {
  if (!localSound) { releaseAll(); return; }
  for (const [note,voice] of voices) {
    send(voice.port,0x80,note,0);
    voice.port = null;
  }
  for (const key of pressed.keys()) keyUp(key);
}
function renderRoute() {
  const preview = ready && sdk.context.mode === 'preview';
  el('other').hidden = preview;
  el('route').disabled = el('other').disabled = !ready || choosing || !sdk.midi;
  const route = el('route');
  route.classList.toggle('needs-output', !currentOutput() && !localSound);
  if (output?.state === 'suspended') route.textContent = 'USB suspended';
  else if (!currentOutput()) route.textContent = preview ? 'MIDI output' : 'Connect USB';
  else route.textContent = output.name === 'USB to computer / tablet' ? 'USB · Ch 1' : output.name;
}
async function chooseOutput(route) {
  if (choosing) return;
  releaseMidi();
  choosing = true;
  renderRoute();
  try {
    const port = await sdk.midi.requestPort({direction:'output',route});
    if (!port) return;
    output = port;
    port.onStateChange(({state}) => {
      if (port !== output) return;
      if (state === 'open') show('Channel 1');
      else {
        releaseMidi();
        if (state === 'closed') {
          output = null;
          show('Output disconnected');
        } else show('Wake USB host');
      }
      renderRoute();
    });
    show('Channel 1');
  } catch (error) { show(error.message); }
  finally { choosing = false; renderRoute(); }
}
function renderSound() {
  const button = el('sound');
  button.disabled = soundBusy || !ready || !sdk.audio;
  button.setAttribute('aria-checked', String(!!localSound));
  renderRoute();
}
async function stopSound() {
  const previous = localSound;
  localSound = null;
  for (const voice of voices.values()) {
    voice.stopLocal?.();
    voice.stopLocal = null;
  }
  if (!currentOutput()) releasePads();
  await previous?.close();
}
el('sound').onclick = async () => {
  if (soundBusy) return;
  soundBusy = true;
  renderSound();
  try {
    if (localSound) {
      await stopSound();
      show('Local sound off');
    } else {
      const instrument = await openLocalInstrument(sdk, (failed,error) => {
        if (failed !== localSound) return;
        void stopSound();
        renderSound();
        show(error.message);
      });
      if (leaving) await instrument.close();
      else { localSound = instrument; show('Local sound on'); }
    }
  } catch (error) { show(error.message); }
  finally { soundBusy = false; renderSound(); }
};
el('route').onclick = () => chooseOutput(sdk.context.mode === 'preview' ? undefined : 'usb-to-host');
el('other').onclick = () => chooseOutput();
function updateSettings() {
  for (const [index, button] of Array.from(el('roots').children).entries()) {
    button.setAttribute('aria-pressed', String(index === root));
  }
  el('scale').value = String(scale);
  el('tones').textContent = scales[scale][1].map(interval => tones[(root + interval) % 12]).join(' · ');
}
function settings(open) {
  releasePads();
  el('sheet').hidden = !open;
  for (const peer of ['nav','#pads']) document.querySelector(peer).inert = open;
  el('tonal').setAttribute('aria-expanded', String(open));
  if (open) { updateSettings(); el('roots').children[root].focus(); }
  else el('tonal').focus();
}
tones.forEach((name, index) => {
  const button = document.createElement('button');
  button.textContent = name;
  button.onclick = () => { root = index; updateSettings(); renderPads(); };
  el('roots').append(button);
});
scales.forEach(([name], index) => el('scale').add(new Option(name, index)));
el('scale').onchange = () => { scale = Number(el('scale').value); updateSettings(); renderPads(); };
el('tonal').onclick = () => settings(true);
el('done').onclick = () => settings(false);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !el('sheet').hidden) settings(false);
});
for (const button of document.querySelectorAll('[data-mode]')) {
  button.onclick = () => {
    const nextDrums = button.dataset.mode === 'drums';
    if (drums === nextDrums) return;
    drums = nextDrums;
    renderPads();
  };
  // A second finger can switch instruments while the first is holding a pad.
  button.addEventListener('touchend', event => {
    event.preventDefault();
    const touch = event.changedTouches[0];
    if (document.elementFromPoint(touch.clientX, touch.clientY) === button) button.click();
  }, {passive:false});
}
el('bank').onclick = () => {
  bank = 1 - bank;
  el('bank').textContent = bank ? 'Macros 5–8' : 'Macros 1–4';
  syncMonitor();
};
addEventListener('blur', releaseAll);
addEventListener('pagehide', () => { leaving = true; releaseAll(); void stopSound(); });
addEventListener('pageshow', () => { leaving = false; renderSound(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
renderPads();
sdk.ready().then(() => {
  ready = true;
  if (sdk.context.mode === 'preview') {
    document.body.classList.add('preview');
    show('Turn on Local sound to play');
  }
  sdk.controls.onEvent(onControl);
  syncMonitor();
  renderSound();
}).catch(error => show(error.message));
