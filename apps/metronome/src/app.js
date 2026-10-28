'use strict';
const $=id=>document.getElementById(id);
const defaults={bpm:120,beats:4,division:1,sound:0};
const sounds=['Click','Wood','Beep'];
let settings={...defaults},epoch=0,run=null,disposed=false,saveTimer,saveChain=Promise.resolve(),taps=[],monitorDirty=true,monitorBusy=false;
const held=new Set();
window.metronome={ready:false,state:'off',settings,beat:0};
function normalize(value){const n=(key,min,max)=>Math.max(min,Math.min(max,Math.round(Number(value?.[key])||defaults[key])));return {bpm:n('bpm',40,240),beats:n('beats',1,8),division:n('division',1,4),sound:n('sound',0,2)};}
function render(){
  $('bpm').textContent=settings.bpm;$('tempo').value=settings.bpm;
  $('meter').querySelector('strong').textContent=settings.beats;
  $('division').querySelector('strong').textContent=settings.division+'×';
  $('sound').querySelector('strong').textContent=sounds[settings.sound];
  if($('beats').children.length!==settings.beats){$('beats').replaceChildren(...Array.from({length:settings.beats},(_,i)=>{const el=document.createElement('span');el.className='beat';el.textContent=i+1;return el;}));}
  const active=metronome.state==='playing'||metronome.state==='starting';
  $('toggle').innerHTML=(active?'Stop':'Start')+' <small>K2</small>';
  $('toggle').setAttribute('aria-pressed',String(active));
  monitorDirty=true;
}
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
function persist(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>{const value={...settings};saveChain=saveChain.then(async()=>{const old=await VrchApp.data.get('settings');await VrchApp.data.set('settings',value,{expectedVersion:old.version});}).catch(()=>status('Settings could not be saved',true));},250);}
function update(changes){if(!metronome.ready)return;settings=normalize({...settings,...changes});metronome.settings=settings;run?.source?.port.postMessage({type:'config',value:settings});render();persist();}
function beat(value){metronome.beat=value?.beat||0;for(const [i,el] of [...$('beats').children].entries()){el.classList.toggle('active',!!value&&i===value.beat);el.classList.toggle('sub',!!value&&!value.main);}if(value)$('beats').setAttribute('aria-label','Beat '+(value.beat+1)+' of '+settings.beats);}
async function cleanup(current){if(!current)return;current.source?.port.postMessage({type:'stop'});current.source?.disconnect();await Promise.allSettled([current.output?.close(),current.context.state==='closed'?null:current.context.close()]);}
function stop(){++epoch;const old=run;run=null;metronome.state='off';beat(null);render();status('Stopped');void cleanup(old);}
async function start(){
  if(!metronome.ready||disposed)return;
  const version=++epoch,current={context:new AudioContext({sampleRate:48000})};run=current;metronome.state='starting';render();status('Starting…');
  const stale=()=>version!==epoch||disposed;
  try{
    await current.context.resume();
    if(stale()){await cleanup(current);return;}
    current.output=await VrchApp.audio.openOutput({channels:1});
    if(stale()){await cleanup(current);return;}
    const destination=await current.output.createNode(current.context);
    await current.context.audioWorklet.addModule('clock.js');
    if(stale()){await cleanup(current);return;}
    current.source=new AudioWorkletNode(current.context,'metronome-clock',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[1]});
    current.source.onprocessorerror=()=>{if(!stale()){stop();metronome.state='error';status('Audio stopped. Try Start again.',true);}};
    current.source.port.onmessage=({data})=>{if(!stale())current.latest=data;};
    current.source.connect(destination);current.source.port.postMessage({type:'config',value:settings});current.source.port.postMessage({type:'start'});
    metronome.state='playing';render();status(current.output.silent?'Preview muted':'Playing');
  }catch(error){
    await cleanup(current);
    if(stale())return;
    run=null;metronome.state='error';render();beat(null);
    const code=error.code||error.name;
    status(['capability_denied','io_not_authorized','permission_denied','NotAllowedError'].includes(code)?'Allow audio in Menu, then retry.':'Audio unavailable. Try Start again.',true);
  }
}
function toggle(){if(metronome.state==='starting'||metronome.state==='playing')stop();else void start();}
function reset(){taps=[];run?.source?.port.postMessage({type:'reset'});beat(null);if(metronome.state!=='playing')status('Stopped');}
function tap(){const now=performance.now();if(taps.length&&now-taps.at(-1)>2000)taps=[];taps.push(now);if(taps.length>6)taps.shift();if(taps.length>1){update({bpm:60000/((now-taps[0])/(taps.length-1))});run?.source?.port.postMessage({type:'reset'});if(metronome.state!=='playing')status('Stopped');}else if(metronome.state!=='playing')status('Tap again');}
function cycle(key,delta=1){const max=key==='beats'?8:key==='division'?4:3,min=key==='sound'?0:1;update({[key]:((settings[key]-min+delta)%max+max)%max+min});}
$('slower').onclick=()=>update({bpm:settings.bpm-1});$('faster').onclick=()=>update({bpm:settings.bpm+1});$('tempo').oninput=e=>update({bpm:e.target.value});
$('meter').onclick=()=>cycle('beats');$('division').onclick=()=>cycle('division');$('sound').onclick=()=>cycle('sound');
$('toggle').onclick=toggle;$('tap').onclick=tap;$('reset').onclick=reset;
VrchApp.controls.onEvent(event=>{
  if(!metronome.ready)return;
  if(event.type==='rotate'){const delta=Math.trunc(Number(event.delta)||0);if(event.control==='E1')update({bpm:settings.bpm+delta});else if(event.control==='E2')cycle('beats',delta);else if(event.control==='E3')cycle('division',delta);else if(event.control==='E4')cycle('sound',delta);}
  if(event.type==='down'&&!held.has(event.control)){held.add(event.control);if(event.control==='K2')toggle();if(event.control==='K3')tap();if(event.control==='K4')reset();}
  if(event.type==='up'||event.type==='cancel')held.delete(event.control);
});
function frame(){
  if(disposed)return;
  if(run?.latest){beat(run.latest);run.latest=null;}
  if(metronome.ready&&monitorDirty&&!monitorBusy){monitorDirty=false;monitorBusy=true;const item=(label,value)=>({label,value:String(value)});VrchApp.monitor.set({E1:item('BPM',settings.bpm),E2:item('Beats',settings.beats),E3:item('Split',settings.division+'x'),E4:item('Sound',sounds[settings.sound]),K2:item(metronome.state==='playing'?'Stop':'Start',''),K3:item('Tap',''),K4:item('Reset','')}).catch(()=>{}).finally(()=>monitorBusy=false);}
  requestAnimationFrame(frame);
}
VrchApp.ready().then(async()=>{
  try{const saved=await VrchApp.data.get('settings');settings=normalize(saved.value);metronome.settings=settings;status('Stopped');}catch(_){status('Saved settings unavailable',true);}
  metronome.ready=true;for(const id of ['toggle','tap','reset'])$(id).disabled=false;render();requestAnimationFrame(frame);
}).catch(()=>status('App could not start. Reopen it.',true));
addEventListener('pagehide',()=>{disposed=true;clearTimeout(saveTimer);stop();},{once:true});
render();
