import {MATERIALS} from './model.mjs';
import {createVisual} from './visual.mjs';
const $=id=>document.getElementById(id),preview=VrchApp.context.mode!=='device';
const settings={material:0,sensitivity:1.25,fill:.45,body:.5},keys=new Set();
let context,node,output,initializing=null,disposed=false,muted=false,grip=false,epoch=0,ready=false,edited=false,saveTimer,saveQueue=Promise.resolve(),monitorDirty=true,monitorBusy=false,snapshot=null,lastStats=0,lastStamp=null,stamps=[],polling=false;
window.shaker={settings,state:'starting',samples:0,errors:[],acks:[],snapshot:null,muted:false,grip:false};
const post=value=>node?.port.postMessage(value);
const visual=createVisual($('view'));
let lastMotion=null,audioError='',hintTimer=0;
const tune=$('settings');
$('closeSettings').onclick=()=>tune.close();
$('tune').onclick=()=>{setGrip(false);tune.showModal();};
tune.addEventListener('close',()=>$('tune').focus());
tune.addEventListener('keydown',event=>{if(event.key==='Escape')tune.close();});
tune.addEventListener('click',event=>{if(event.target!==tune)return;const r=tune.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)tune.close();});
function notice(){let text='';if(audioError)text=audioError;else if(context?.state==='suspended')text='Tap the chamber to enable sound';else if(shaker.state==='missing')text='No motion sensor · tap to play';else if(shaker.state==='read-error')text='Motion unavailable · tap to play';$('notice').textContent=text;$('notice').hidden=!text;}
function hint(){if(hintTimer)return;$('hint').textContent=grip?'Hold it. Feel it.':preview?'Tap to play':'Shake to play';$('hintDetail').textContent=grip?'Release to let it ring':preview?'Your touch sets it in motion':'or tap anywhere';}
function state(value,text){shaker.state=value;if($('state').textContent!==text)$('state').textContent=text;notice();}
function configure(){post({type:'settings',value:settings});document.querySelectorAll('[data-material]').forEach((b,i)=>b.setAttribute('aria-pressed',String(i===settings.material)));for(const name of ['sensitivity','fill','body'])$(name).value=Math.round(settings[name]*100);$('sensitivityValue').textContent=settings.sensitivity.toFixed(2)+'×';$('fillValue').textContent=Math.round(settings.fill*100)+'%';$('bodyValue').textContent=Math.round(settings.body*100)+'%';monitorDirty=true;}
function persist(){edited=true;clearTimeout(saveTimer);saveTimer=setTimeout(()=>{const value={...settings};saveQueue=saveQueue.then(async()=>{const old=await VrchApp.data.get('settings');await VrchApp.data.set('settings',{...(old.value||{}),...value},{expectedVersion:old.version});}).catch(()=>state('save-error','Settings not saved'));},400);}
function change(name,value){settings[name]=Math.max(name==='sensitivity'?.4:name==='fill'?.1:0,Math.min(name==='sensitivity'?3:name==='fill'?.9:name==='material'?3:1,value));if(name==='material')settings.material=Math.round(settings.material);configure();persist();}
for(const [i,m] of MATERIALS.entries()){const b=document.createElement('button');b.textContent=m.name;b.dataset.material=i;b.onclick=()=>change('material',i);$('materials').append(b);}
for(const name of ['sensitivity','fill','body'])$(name).oninput=e=>change(name,Number(e.target.value)/100);
function setGrip(value){grip=value;shaker.grip=value;post({type:'grip',value});$('grip').setAttribute('aria-pressed',String(value));hint();monitorDirty=true;}
$('grip').onpointerdown=e=>{e.preventDefault();if(e.isTrusted)$('grip').setPointerCapture(e.pointerId);setGrip(true);};for(const type of ['pointerup','pointercancel','lostpointercapture'])$('grip').addEventListener(type,()=>setGrip(false));
$('grip').onkeydown=e=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();setGrip(true);}};$('grip').onkeyup=()=>setGrip(false);addEventListener('blur',()=>{keys.clear();setGrip(false);});
async function tap(){const opening=start();if(context?.state==='suspended')void context.resume().catch(()=>{});await opening;if(disposed)return;post({type:'tap'});clearTimeout(hintTimer);$('hint').textContent='Let it shake.';$('hintDetail').textContent='';hintTimer=setTimeout(()=>{hintTimer=0;if(!disposed)hint();},800);}
$('view').onpointerdown=tap;
$('view').onkeydown=event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();void tap();}};
async function sound(){if(!node||context.state!=='running'){await start();await context?.resume().catch(()=>{});}else{muted=!muted;shaker.muted=muted;post({type:'mute',value:muted});}audioState();}
$('sound').onclick=sound;
function audioState(){const running=!!node&&context?.state==='running';$('sound').textContent=running?(muted?'Unmute':'Mute'):'Enable';$('sound').setAttribute('aria-label',running?(muted?'Unmute sound':'Mute sound'):'Enable sound');$('sound').setAttribute('aria-pressed',String(muted));monitorDirty=true;notice();}
async function start(){
 if(disposed||node)return;if(initializing)return initializing;
 initializing=(async()=>{let opened,c;
  try{
   c=new AudioContext({sampleRate:48000,latencyHint:'interactive',sinkId:{type:'none'}});context=c;c.onstatechange=audioState;void c.resume().catch(()=>{});
   await c.audioWorklet.addModule(new URL('sound.mjs',import.meta.url));
   opened=await VrchApp.audio.openOutput({channels:1});
   const destination=await opened.createNode(c);
   if(disposed){await opened.close();await c.close();return;}
   output=opened;node=new AudioWorkletNode(c,'shaker-lab',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[1]});
   node.port.onmessage=({data})=>{snapshot=data;shaker.snapshot=data;visual.update(data);lastStats=performance.now();};node.connect(destination);configure();if(lastMotion)post({type:'motion',...lastMotion});audioError='';
   void c.resume().catch(()=>{});audioState();
   if(preview)state('preview','Preview');hint();
  }catch(error){shaker.errors.push(error.code||error.message);await opened?.close().catch(()=>{});await c?.close().catch(()=>{});context=node=output=null;audioError=error.code==='preview_io_disabled'?'Enable Listen to preview for sound':'Sound unavailable · tap to retry';if(preview)state('audio-off','Sound unavailable');audioState();}
  finally{initializing=null;}
 })();return initializing;
}
async function poll(){polling=true;const run=++epoch;
 while(!disposed&&run===epoch){
  try{
   const value=await VrchApp.imu.read();if(disposed||run!==epoch)break;
   if(value.state!=='valid'){lastMotion=null;post({type:'missing'});state(value.state==='not_ready'?'missing':'read-error',value.state==='not_ready'?'No IMU · tap to play':'Motion unavailable · retrying');$('rate').textContent='';await new Promise(r=>setTimeout(r,800));continue;}
   const stamp=BigInt(value.completed_ns);if(lastStamp!==null&&stamp<=lastStamp)throw Error('Motion timestamp did not advance');lastStamp=stamp;
   stamps.push(stamp);if(stamps.length>30)stamps.shift();shaker.samples++;lastMotion={accel:value.accel.xyz,gyro:value.gyro.xyz};post({type:'motion',...lastMotion});
   state('live',muted?'Motion live · muted':context?.state==='running'?'Motion live':'Sound unavailable');
   if(stamps.length>1)$('rate').textContent=Math.round((stamps.length-1)*1e9/Number(stamp-stamps[0]))+' Hz';
  }catch(error){if(disposed||run!==epoch)break;lastMotion=null;post({type:'missing'});state('read-error','Motion unavailable · retrying');$('rate').textContent='';stamps=[];lastStamp=null;await VrchApp.imu.close().catch(()=>{});await new Promise(r=>setTimeout(r,800));}
 }
 polling=false;
}
VrchApp.controls.onEvent(event=>{
 if(event.type==='rotate'){const names=['material','sensitivity','fill','body'],index=Number(event.control.slice(1))-1;if(index>=0&&index<4)change(names[index],settings[names[index]]+event.delta*(index===0?1:index===1?.05:.02));return;}
 if(event.type==='up'||event.type==='cancel'){keys.delete(event.control);if(event.control==='K3')setGrip(false);return;}
 if(event.type!=='down'||keys.has(event.control))return;keys.add(event.control);
 if(event.control==='K2')void sound();if(event.control==='K3')setGrip(true);if(event.control==='K4')void tap();
});
function monitor(){if(!ready||!monitorDirty||monitorBusy||disposed)return;monitorDirty=false;monitorBusy=true;VrchApp.monitor.set({E1:{label:'Material',value:MATERIALS[settings.material].name},E2:{label:'Sense',value:settings.sensitivity.toFixed(2)+'×'},E3:{label:'Fill',value:Math.round(settings.fill*100)+'%'},E4:{label:'Body',value:Math.round(settings.body*100)+'%'},K2:{label:'Sound',value:muted?'Off':'On'},K3:{label:'Grip',value:grip?'Held':'Hold',pressed:grip},K4:{label:'Tap',value:'Shake'}}).catch(()=>{}).finally(()=>monitorBusy=false);}
function frame(now){if(disposed)return;monitor();visual.draw(now,{material:settings.material,grip,muted,motion:lastMotion?.accel});if(snapshot){const level=muted?'Muted':snapshot.peak>.008?'Rattling':'Settled';if($('level').textContent!==level)$('level').textContent=level;}requestAnimationFrame(frame);}
configure();requestAnimationFrame(frame);
VrchApp.ready().then(async()=>{const old=await VrchApp.data.get('settings');if(!edited&&old.value){for(const name of Object.keys(settings))if(Number.isFinite(old.value[name]))settings[name]=old.value[name];configure();}ready=true;monitorDirty=true;hint();if(!preview&&!polling)void poll();await start();}).catch(()=>state('error','App unavailable · reopen'));
VrchApp.audio.onAvailable(()=>{if(!node)void start();});
addEventListener('pagehide',()=>{disposed=true;++epoch;clearTimeout(saveTimer);clearTimeout(hintTimer);visual.destroy();post({type:'close'});node?.disconnect();void VrchApp.imu.close().catch(()=>{});void output?.close().catch(()=>{});void context?.close().catch(()=>{});});
