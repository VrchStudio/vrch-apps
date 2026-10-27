'use strict';
const $ = id => document.getElementById(id);
const controlIds = ['E1', 'E2', 'E3', 'E4', 'K1', 'K2', 'K3', 'K4'];
const readings = Object.fromEntries(controlIds.map(id => [id, {value:0, presses:0, pressed:false, turned:false, lastTurn:0, released:false, activeUntil:0,pressure:null,pressurePeak:0,pressureIntermediate:false,pressureReleased:false,pressureInterrupted:false}]));
const tiles = Object.fromEntries(controlIds.map(id => [id, document.querySelector('[data-control="'+id+'"]')]));
const pointers = new Map();
let activeTab = 'controls';
let dirty = true, monitorDirty = true, saving = false, saveQueue = Promise.resolve(), disposed = false;
let input = null, inputEpoch = 0, output = null, outputEpoch = 0, audioContext = null, musicSource = null;
const recordingLimit = 30;
let recording = null, recordingFrames = 0, recordingRate = 48000, recordingChannels = 2, outputKind = 'music';
let musicStartedAt = 0, musicDuration = 12, peakHold = 0, peakHeldAt = 0, lastFrame = 0, lastInputAt = 0;
window.check = {events:[],touches:0,audio:{blocks:0,peak:0,maxPeak:0,started:null,outputBlocks:0,tonesPlayed:0,inputState:'off',outputState:'off'},mode:VrchApp.context.mode,errors:[],counts:{}};
function errorText(error, area) {
  if(error.name==='NotAllowedError')return area==='output'?'Audio playback is blocked by the browser. Update device software and retry.':'Audio input is blocked. Check Device Access and retry.';
  if (['capability_denied','capability_not_allowed','io_not_authorized','permission_denied'].includes(error.code || error.name)) return 'Audio access was denied. Reopen the App and retry.';
  if (error.code === 'permission_required') return 'Allow Apps audio input in Device Access, then retry.';
  if (error.code === 'interaction_required') return check.mode === 'preview' && area === 'output' ? 'Enable Listen to preview in More options.' : 'Tap again to enable audio.';
  if (error.code === 'preview_io_disabled') return area === 'output' ? 'Enable Listen to preview, then retry.' : 'Try audio on the device.';
  if (['device_unavailable','audio_unavailable','NotFoundError'].includes(error.code || error.name)) return 'No audio device available. Connect one and retry.';
  return area === 'input' ? 'Input unavailable. Check the device and retry.' : 'Output unavailable. Check the device and retry.';
}
function recordError(error) { check.errors.push(error.code || error.message || String(error)); if (check.errors.length > 20) check.errors.shift(); }
function persistCheck() {
  if (check.mode !== 'device' || !check.ready || saving || disposed) return;
  saving = true;
  setTimeout(() => {
    saving = false;
    if (disposed) return;
    const snapshot = structuredClone({events:check.events.slice(-100),counts:check.counts,touches:check.touches,visits:check.visits,errors:check.errors,audio:check.audio,pressure:Object.fromEntries(controlIds.filter(id=>id[0]==='K').map(id=>[id,{value:readings[id].pressure,peak:readings[id].pressurePeak,intermediate:readings[id].pressureIntermediate,released:readings[id].pressureReleased}])),at:Date.now()});
    saveQueue = saveQueue.then(async () => {
      const old = await VrchApp.data.get('hardware-check');
      await VrchApp.data.set('hardware-check', {...(old.value || {}), ...snapshot}, {expectedVersion:old.version});
    }).catch(error => {recordError(error); $('status').textContent = 'Readings could not be saved';});
  }, 500);
}
function onControl(event) {
  if(systemTest.isOpen()){systemTest.handle(event);return;}
  const state = readings[event.control];
  if (!state) return;
  if (event.type === 'pressure') {
    if (!/^K[1-4]$/.test(event.control) || typeof event.value !== 'number' || !Number.isFinite(event.value) || event.value < 0 || event.value > 1) return;
    state.pressure = event.value;
    if (!event.value) {
      if (state.pressurePeak > 0 && !state.pressureInterrupted) state.pressureReleased = true;
      state.pressureInterrupted = false;
    } else {
      state.pressurePeak = Math.max(state.pressurePeak, event.value);
      if (event.value > .05 && event.value < .95) state.pressureIntermediate = true;
    }
  }
  if (event.type === 'cancel' && state.pressure !== null) {state.pressure = 0;state.pressureInterrupted = true;}
  if (event.type !== 'pressure') {
    const handled = activeTab==='camera' ? cameraTest.handle(event) : activeTab==='imu' ? imuTest.handle(event) : false;
    if (handled && event.type !== 'cancel') return;
  }
  check.events.push({...event,at:Date.now()}); if (check.events.length > 1000) check.events.shift();
  const key = event.control+':'+event.type; check.counts[key] = (check.counts[key] || 0) + 1;
  if (event.type === 'rotate') {const delta=Number(event.delta)||0;state.value += delta;if(delta)state.lastTurn=delta;state.turned = true;state.activeUntil = performance.now()+180;}
  if (event.type === 'down') {if (!state.pressed) state.presses++;state.pressed = true;}
  if (event.type === 'up' || event.type === 'cancel') {state.pressed = false;if (event.type === 'up' && state.presses) state.released = true;}
  dirty = monitorDirty = true; persistCheck();
}
VrchApp.controls.onEvent(onControl);
function renderControls(now) {
  for (const id of controlIds) {
    const state = readings[id], tile = tiles[id];
    tile.classList.toggle('is-pressed', state.pressed);
    tile.classList.toggle('is-tested', state.released && (id[0] !== 'E' || state.turned));
    tile.classList.toggle('is-active', state.activeUntil > now);
    if (id[0] === 'E') {
      const value = tile.querySelector('.value'), text = (state.value > 0 ? '+' : '')+state.value;
      value.textContent = text;value.style.fontSize = Math.min(innerWidth <= 380 ? 36 : innerHeight >= 520 ? 48 : 44,(tile.clientWidth-20)/(Math.max(2,text.length)*.64))+'px';
      const turn=state.lastTurn ? (state.lastTurn>0?'+':'−')+Math.abs(state.lastTurn) : '';
      tile.querySelector('.turn-state').textContent=turn ? 'Turn '+turn : '';
      tile.querySelector('.press-state').textContent = state.pressed ? 'HELD' : '';
      tile.querySelector('.reading').textContent = state.presses ? state.presses+' press'+(state.presses === 1 ? '' : 'es') : state.turned ? 'Turned · press' : 'Turn / press';
    } else {
      const supported = state.pressure !== null;
      tile.querySelector('.key-count').textContent = supported ? Math.round(state.pressure*100)+'%' : id === 'K1' ? '' : state.presses;
      tile.querySelector('.reading').textContent = id === 'K1' ? 'Menu' : state.pressed ? 'Held' : state.released ? 'Released' : 'Press key';
      const meter = tile.querySelector('.pressure-meter');
      meter.hidden = !supported;
      meter.setAttribute('aria-valuenow',String(Math.round((state.pressure||0)*100)));
      meter.firstElementChild.style.width = ((state.pressure||0)*100)+'%';
      tile.classList.toggle('is-pressure-tested', state.pressureIntermediate && state.pressureReleased);
      tile.title = supported ? 'Pressure '+Math.round(state.pressure*100)+'% · peak '+Math.round(state.pressurePeak*100)+'% · '+state.presses+' presses' : '';

    }
  }
}
let monitorBusy = false;
function renderMonitor() {
  if (!check.ready || !monitorDirty || monitorBusy || disposed) return;
  monitorDirty = false; monitorBusy = true;
  const values = systemTest.isOpen()?systemTest.monitor():activeTab==='camera'?cameraTest.monitor():activeTab==='imu'?imuTest.monitor():Object.fromEntries(controlIds.filter(id=>id!=='K1').map(id => [id, {label:id,value:readings[id].pressure!==null?Math.round(readings[id].pressure*100)+'%':String(id[0] === 'E' ? readings[id].value : readings[id].presses),pressed:readings[id].pressed}]));
  VrchApp.monitor.set(values).catch(recordError).finally(() => {monitorBusy = false;});
}
function frame(now) {
  if (disposed) return;
  if (dirty || Object.values(readings).some(s => s.activeUntil)) {
    renderControls(now); dirty = false;
    for (const s of Object.values(readings)) if (s.activeUntil && s.activeUntil <= now) s.activeUntil = 0;
  }
  renderMonitor();
  if (now-lastFrame >= 30) {
    lastFrame = now;
    if (input) {renderMeter(now);renderRecording();if(now-lastInputAt>2000)void stopInput(new Error('No audio frames. Retry recording.'));}
    if (output && audioContext) renderMusicProgress(Math.min(musicDuration,Math.max(0,audioContext.currentTime-musicStartedAt)));
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
function tab(name) {
  activeTab=name;monitorDirty=true;
  for(const state of Object.values(readings))state.pressed=false;dirty=true;
  for (const id of ['controls','audio','touch','camera','imu']) {$(id+'Panel').hidden = id !== name;$(id+'Tab').setAttribute('aria-pressed',String(id === name));}
  if(name==='camera')cameraTest.enter();else void cameraTest.leave();
  if(name==='imu')imuTest.enter();else imuTest.leave();
}
$('controlsTab').onclick = () => tab('controls');
$('audioTab').onclick = () => tab('audio');
$('touchTab').onclick = () => tab('touch');
const imuTest=createImuTest(()=>{monitorDirty=true;});
$('imuTab').onclick=()=>tab('imu');
const cameraTest=createCameraTest(()=>{monitorDirty=true;});
$('cameraTab').onclick = () => tab('camera');
const systemTest=createSystemTest(()=>{monitorDirty=true;});
$('systemInfo').onclick=()=>systemTest.enter();
function point(event) {
  const r = $('touchPad').getBoundingClientRect();
  return {x:Math.max(0,Math.min(r.width,event.clientX-r.x)),y:Math.max(0,Math.min(r.height,event.clientY-r.y))};
}
function showPoint(p) {
  const pad = $('touchPad'), layer = $('touchPoints');
  for (const marker of [...layer.children]) if (!pointers.has(Number(marker.dataset.pointer))) marker.remove();
  for (const [id, position] of pointers) {
    let marker = layer.querySelector('[data-pointer="'+id+'"]');
    if (!marker) {marker=document.createElement('span');marker.className='touch-point';marker.dataset.pointer=String(id);marker.textContent=position.label;layer.append(marker);}
    Object.assign(marker.style,{left:position.x+'px',top:position.y+'px'});
  }
  $('touchCoordinates').textContent = (p.label ? '#'+p.label+'  ' : '')+'X '+Math.round(p.x)+'  Y '+Math.round(p.y);
  $('touches').textContent = check.touches+' touch'+(check.touches === 1 ? '' : 'es');
  $('touchHint').textContent = pointers.size ? pointers.size+' contact'+(pointers.size === 1 ? '' : 's') : 'Touch released';
  pad.classList.toggle('is-down',pointers.size > 0);
}
$('touchPad').addEventListener('pointerdown', event => {
  if (event.button > 0) return;
  event.preventDefault();$('touchPad').focus({preventScroll:true});
  const p = point(event);let label=1;while([...pointers.values()].some(value=>value.label===label))label++;p.label=label;pointers.set(event.pointerId,p);check.touches++;showPoint(p);persistCheck();
  if (event.isTrusted) try {$('touchPad').setPointerCapture(event.pointerId);} catch (_) {}
});
document.addEventListener('pointermove',event => {if (pointers.has(event.pointerId)) {const p={...point(event),label:pointers.get(event.pointerId).label};pointers.set(event.pointerId,p);showPoint(p);}});
for (const type of ['pointerup','pointercancel']) document.addEventListener(type,event => {
  if (!pointers.has(event.pointerId)) return;
  const p=pointers.get(event.pointerId);pointers.delete(event.pointerId);showPoint(p);persistCheck();
});
$('touchPad').addEventListener('click',event => {
  if (event.detail !== 0 || event.pointerType) return;
  const r=$('touchPad').getBoundingClientRect();check.touches++;showPoint({x:r.width/2,y:r.height/2});persistCheck();
});
function db(value) {return value > .001 ? Math.max(-60,20*Math.log10(value)) : -60;}
function renderMeter(now) {
  if (now-lastInputAt > 250) check.audio.peak = 0;
  const level = db(check.audio.peak);
  if (check.audio.peak >= peakHold || now-peakHeldAt > 1200) {peakHold=check.audio.peak;peakHeldAt=now;}
  $('inputValue').textContent = level <= -60 ? '< −60 dBFS' : level.toFixed(1)+' dBFS';
  $('inputMeter').setAttribute('aria-valuenow',String(level));
  $('inputMeter').firstElementChild.style.width = ((level+60)/60*100)+'%';
  $('inputMeter').lastElementChild.style.left = 'calc('+((db(peakHold)+60)/60*100)+'% - 2px)';
  $('inputMeter').classList.toggle('is-clipping',check.audio.peak >= .99);
  if (check.audio.peak >= .99) $('inputState').textContent = 'Clipping. Lower the input level.';
  else $('inputState').textContent = input.silent ? 'Preview input is silent. Test on the device.' : now-lastInputAt > 2000 ? 'No audio frames. Stop and retry input.' : check.audio.blocks === 0 ? 'Waiting for input…' : level <= -60 ? 'Listening · no signal' : 'Listening · signal detected';
}
function renderRecording() {
  const seconds=recordingFrames/recordingRate;
  $('recordTime').textContent=input?seconds.toFixed(1)+' / '+recordingLimit+' s':seconds?seconds.toFixed(1)+' s':'Up to '+recordingLimit+' s';
  $('replayButton').disabled=!!input||check.audio.inputState==='starting'||check.audio.outputState==='starting'||!recordingFrames;
  check.audio.recordedSeconds=seconds;check.audio.recordedChannels=recordingChannels;
}
function clearRecording() {recording=null;recordingFrames=0;renderRecording();}
function syncAudioStarted() {check.audio.started = input || output ? (check.audio.started || Date.now()) : null;}
async function stopInput(error=null) {
  ++inputEpoch; const current=input;input=null;check.audio.inputState='off';check.audio.peak=0;peakHold=0;peakHeldAt=0;syncAudioStarted();
  $('inputButton').disabled=false;$('inputButton').textContent='Record';$('inputValue').textContent='— dBFS';
  $('inputState').textContent=error?(error.message==='No audio frames. Retry recording.'?error.message:errorText(error,'input')):recordingFrames?'Recording ready.':'No recording yet.';$('inputState').classList.toggle('is-error',!!error);if(error){recordError(error);check.audio.inputState='error';}renderRecording();
  $('inputMeter').firstElementChild.style.width='0%';$('inputMeter').lastElementChild.style.left='0';$('inputMeter').classList.remove('is-clipping');$('inputMeter').setAttribute('aria-valuenow','-60');
  if (current) await current.close().catch(recordError);persistCheck();
}
async function startInput() {
  const closing=stopMusic();const epoch=++inputEpoch;$('inputButton').disabled=true;$('inputButton').textContent='Starting…';check.audio.inputState='starting';
  renderRecording();$('inputState').textContent='Opening audio input…';$('inputState').classList.remove('is-error');
  try {
    await closing;if(epoch!==inputEpoch||disposed)return;
    const opened = await VrchApp.audio.openInput({channels:2,echoCancellation:false});
    if (epoch !== inputEpoch || disposed) {await opened.close();return;}
    recordingRate=opened.sampleRate;recordingChannels=opened.channels;recording=new Float32Array(recordingLimit*recordingRate*recordingChannels);recordingFrames=0;
    input=opened;lastInputAt=performance.now();check.audio.inputState='active';check.audio.blocks=0;check.audio.peak=0;peakHold=0;peakHeldAt=0;syncAudioStarted();
    opened.onData(samples => {if (input !== opened) return;lastInputAt=performance.now();let peak=0;for (let i=0;i<samples.length;i++)peak=Math.max(peak,Math.abs(samples[i]));check.audio.blocks++;check.audio.peak=peak;check.audio.maxPeak=Math.max(check.audio.maxPeak,peak);const count=Math.min(samples.length,recording.length-recordingFrames*recordingChannels);recording.set(samples.subarray(0,count),recordingFrames*recordingChannels);recordingFrames+=count/recordingChannels;if(recordingFrames*recordingChannels===recording.length)void stopInput();});
    opened.onError(error=>{if(input===opened)void stopInput(error);});
    $('inputButton').textContent='Stop';$('inputButton').disabled=false;persistCheck();
  } catch (error) {
    if (epoch !== inputEpoch || disposed) return;
    recordError(error);check.audio.inputState='error';$('inputState').textContent=errorText(error,'input');$('inputState').classList.add('is-error');$('inputButton').disabled=false;$('inputButton').textContent='Retry';renderRecording();persistCheck();
  }
}
$('inputButton').onclick=() => input ? stopInput() : startInput();
function renderMusicProgress(seconds) {
  if(outputKind==='recording'){ $('recordTime').textContent=seconds.toFixed(1)+' / '+musicDuration.toFixed(1)+' s';return; }
  $('outputProgress').firstElementChild.style.width=(seconds/musicDuration*100)+'%';
  $('outputProgress').setAttribute('aria-valuenow',seconds.toFixed(1));
  $('musicTime').textContent=seconds > 0 ? Math.floor(seconds)+' / '+Math.round(musicDuration)+' s' : Math.round(musicDuration)+' seconds';
}
async function stopMusic(completed=false) {
  ++outputEpoch;
  const current=output,context=audioContext,source=musicSource;output=null;audioContext=null;musicSource=null;
  if (source) {source.onended=null;try {source.stop();} catch (_) {}source.disconnect();}
  check.audio.outputState='off';syncAudioStarted();$('inputButton').disabled=false;$('replayButton').textContent='Play recording';renderRecording();$('outputButton').disabled=false;$('outputButton').textContent='Play music';
  if(outputKind==='recording'){$('inputState').textContent=completed?'Playback complete.':'Recording ready.';renderRecording();}
  else {renderMusicProgress(completed?musicDuration:0);$('outputState').textContent=completed?'Music complete. Play again to retest.':'Melody, chords and bass.';}
  $('outputState').classList.remove('is-error');
  await Promise.all([current?.close().catch(recordError),context?.close().catch(recordError)]);persistCheck();
}
async function playMusic(kind='music') {
  const closing=stopMusic(),captureClosing=stopInput();const epoch=++outputEpoch;let opened,context;outputKind=kind;
  if(kind==='recording'&&!recordingFrames)return;
  $('outputButton').disabled=true;$('outputButton').textContent='Starting…';$('outputState').textContent='Opening audio output…';$('outputState').classList.remove('is-error');check.audio.outputState='starting';$('inputButton').disabled=true;renderRecording();
  if(kind==='recording'){$('replayButton').textContent='Starting…';$('inputState').textContent='Opening audio output…';$('inputState').classList.remove('is-error');$('outputButton').textContent='Play music';$('outputState').textContent='Melody, chords and bass.';}
  try {
    await Promise.all([closing,captureClosing]);if(epoch!==outputEpoch||disposed)return;
    context = new AudioContext({sampleRate:48000,sinkId:{type:'none'}});audioContext=context;await context.resume();
    opened = await VrchApp.audio.openOutput({channels:kind==='recording'?recordingChannels:1});
    if (epoch !== outputEpoch || disposed) {await opened.close();await context.close();return;}
    const destination = await opened.createNode(context);
    if (epoch !== outputEpoch || disposed) {await opened.close();await context.close();return;}
    let buffer;
    if(kind==='recording'){
      buffer=context.createBuffer(recordingChannels,recordingFrames,recordingRate);
      for(let channel=0;channel<recordingChannels;channel++){
        const target=buffer.getChannelData(channel);
        for(let frame=0;frame<recordingFrames;frame++)target[frame]=recording[frame*recordingChannels+channel];
      }
    }else{
      const response=await fetch('assets/test-music.wav');
      if(!response.ok)throw new Error('Music could not be loaded.');
      buffer=await context.decodeAudioData(await response.arrayBuffer());
    }
    if (epoch !== outputEpoch || disposed) {await opened.close();await context.close();return;}
    output=opened;const source=context.createBufferSource();musicSource=source;source.buffer=buffer;
    musicDuration=buffer.duration;musicStartedAt=context.currentTime+.04;
    source.connect(destination);source.start(musicStartedAt);
    source.onended=() => {if (output===opened) void stopMusic(true);};
    opened.onError(error=>{if(output===opened){void stopMusic();recordError(error);$(kind==='recording'?'inputState':'outputState').textContent=errorText(error,'output');}});
    check.audio.outputState='active';if(kind==='music')check.audio.tonesPlayed++;syncAudioStarted();$('inputButton').disabled=false;
    $('outputButton').textContent=kind==='music'?'Stop music':'Play music';$('outputButton').disabled=false;renderRecording();$('replayButton').textContent=kind==='recording'?'Stop playback':'Play recording';renderMusicProgress(0);
    if(kind==='recording')$('inputState').textContent=opened.silent?'Preview is muted. Enable Listen to preview.':'Playing recording.';
    if(kind==='music')$('outputState').textContent=opened.silent?'Preview is muted. Enable Listen to preview.':'Playing melody, chords and bass.';persistCheck();
  } catch (error) {
    await opened?.close().catch(()=>{});await context?.close().catch(()=>{});
    if (epoch !== outputEpoch || disposed) return;
    output=null;audioContext=null;musicSource=null;syncAudioStarted();recordError(error);check.audio.outputState='error';
    $('outputState').textContent=errorText(error,'output');$('outputState').classList.add('is-error');$('outputButton').disabled=false;$('outputButton').textContent='Retry music';$('inputButton').disabled=false;$('replayButton').textContent='Play recording';renderRecording();if(kind==='recording'){$('inputState').textContent=errorText(error,'output');$('inputState').classList.add('is-error');$('outputButton').textContent='Play music';$('outputState').textContent='Melody, chords and bass.';$('outputState').classList.remove('is-error');}persistCheck();
  }
}
$('outputButton').onclick=() => output&&outputKind==='music'?stopMusic():playMusic();
$('replayButton').onclick=()=>output&&outputKind==='recording'?stopMusic():playMusic('recording');
window.stopAudio=() => Promise.all([stopInput(),stopMusic()]);
$('reset').onclick=async () => {
  imuTest.reset();
  await Promise.all([stopAudio(),cameraTest.stop()]);clearRecording();$('inputState').textContent='No recording yet.';
  for (const state of Object.values(readings)) Object.assign(state,{value:0,presses:0,pressed:false,turned:false,lastTurn:0,released:false,activeUntil:0,pressure:state.pressure===null?null:0,pressurePeak:0,pressureIntermediate:false,pressureReleased:false,pressureInterrupted:true});
  check.events=[];check.counts={};check.touches=0;check.errors=[];check.audio.blocks=0;check.audio.peak=0;check.audio.maxPeak=0;check.audio.outputBlocks=0;check.audio.tonesPlayed=0;
  pointers.clear();peakHold=0;$('touches').textContent='0 touches';$('touchCoordinates').textContent='';$('touchHint').textContent='Tap or drag anywhere here';$('touchPad').classList.remove('is-down');
  $('touchPoints').replaceChildren();
  dirty=monitorDirty=true;persistCheck();
};
addEventListener('pagehide',() => {disposed=true;systemTest.close();imuTest.close();void stopAudio();clearRecording();void cameraTest.stop();});
VrchApp.ready().then(async () => {
  const previous=await VrchApp.data.get('visits');check.visits=(Number(previous.value)||0)+1;
  await VrchApp.data.set('visits',check.visits,{expectedVersion:previous.version});
  check.ready=true;$('status').textContent=check.mode==='device'?'Device · live input':'Preview · virtual controls';
  monitorDirty=true;persistCheck();
}).catch(error => {recordError(error);$('status').textContent='App could not start. Reopen to retry.';});
