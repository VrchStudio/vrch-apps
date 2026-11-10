import {BodyInstrument,visiblePoint} from './motion.mjs';
import {createTracker} from './tracker.mjs';
import {createPictureSender,createPictureReceiver} from './picture-relay.mjs';
const sdk=globalThis.VrchApp,$=id=>document.getElementById(id);
// Output role: a picture-only instance (Playground's output, a second screen) draws the camera picture, the body and
// the sound rings from the controlling instance (VrchApp.output). It plays no sound, opens no camera, reads no
// controls, saves nothing and shows no text.
const isOutput=sdk.context?.role==='output',relay=sdk.output||null;document.documentElement.dataset.role=isOutput?'output':'control';
const POSE_POINTS=[0,11,12,13,14,15,16,23,24];
const canvas=$('stage'),ctx=canvas.getContext('2d'),source=document.createElement('canvas'),sc=source.getContext('2d');
const edges=[[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24]];
let config,instrument,width=480,height=432,points=[],camera,output,ac,player,tracker,sink,phase='loading',closed=false,lastFrame=0,visualTime=0,previousTime=0;
let calibrationKeyDown=false;
let sensitivity=50,sensitivityVersion=0,sensitivityEdit=0,sensitivitySavedEdit=0,sensitivityReady=false,sensitivitySaving=false,sensitivitySaveIssue=false,sensitivitySaveTimer,sensitivityMonitorTimer;
let calibrationFeedbackUntil=0;
let cameraArea={top:36,bottom:320},cameraRect=null;
let audio={bass:0,synth:0,vocal:0,frequency:0},lastMode='',lastResult=0,lastAppliedMode='';
const metrics={frames:0,latency:[],inference:[],intervals:[],changes:[]};
function prompt(title,subtitle){$('prompt').hidden=!title;$('headline').textContent=title;$('hint').textContent=subtitle;}
function resize(){const viewport=sdk.context.viewport;width=viewport.width||innerWidth;height=viewport.height||innerHeight;const dpr=Math.min(devicePixelRatio,2);canvas.width=width*dpr;canvas.height=height*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);}
function layoutCamera(){
  cameraArea={top:document.querySelector('header').getBoundingClientRect().bottom+6,bottom:document.querySelector('footer').getBoundingClientRect().top-8};
  document.querySelector('main').style.setProperty('--camera-center',(cameraArea.top+cameraArea.bottom)/2+'px');
}
const layoutObserver=new ResizeObserver(layoutCamera);
layoutObserver.observe(document.querySelector('header'));layoutObserver.observe(document.querySelector('footer'));
addEventListener('resize',()=>{if(isOutput)return;resize();layoutCamera();});
function apply(value,now,frameTime=now){
  const lost=['FRAME','HANDS','RESET'].includes(value.mode);
  player?.port.postMessage(lost?{type:'stop'}:{type:'voices',...value,leaseMs:Math.max(0,config.gestures.staleMs-(now-frameTime))});lastAppliedMode=value.mode;
  if(lastMode!==value.mode){metrics.changes.push({at:now,mode:value.mode,vocalId:value.vocalId});if(metrics.changes.length>100)metrics.changes.shift();lastMode=value.mode;}
}
function result(data){
  if(closed||phase!=='live'||document.hidden)return;
  const now=performance.now(),age=now-data.capturedAtMs;
  metrics.frames++;metrics.latency.push(age);metrics.inference.push(data.durationMs);if(lastResult)metrics.intervals.push(now-lastResult);lastResult=now;
  for(const key of ['latency','inference','intervals'])if(metrics[key].length>600)metrics[key].shift();
  if(age>config.gestures.staleMs){points=[];apply(instrument.lose(),now);return;}
  points=data.tracks?.[0]?.landmarks||[];apply(instrument.update(points,now,source.width/source.height),now,data.capturedAtMs);
}
async function release(){
  const parts={player,tracker,camera,output,ac};player=tracker=camera=output=ac=sink=null;
  parts.player?.port.postMessage({type:'stop'});parts.tracker?.close();
  await Promise.allSettled([parts.camera?.close(),parts.output?.close(),parts.ac?.close()]);
}
// Opening links must not ask for the camera before the visitor acts: the App waits in 'ready' until K2.
function failureText(error){
  if(error?.code==='permission_required')return ['Camera blocked.','Allow the camera, then press K2 to try again.'];
  if(error?.code==='interaction_required')return ['Sound is waiting.','Press K2 to start.'];
  if(error?.code==='camera_unavailable'||error?.code==='camera_closed')return ['No camera picture.','Connect a camera, then press K2 to try again.'];
  return ['Let’s try again.','Check camera and sound in Menu, then press K2.'];
}
function fail(error){if(closed||phase==='error'||phase==='preview')return;if(error?.code!=='camera_closed'&&error?.code!=='permission_required')console.error('BODY VIBES',error);phase='error';audio={bass:0,synth:0,vocal:0};void release();prompt(...failureText(error));renderSensitivity();$('tracking').textContent='STOPPED';for(const key of ['bass','synth','vocal']){$(key).classList.remove('active');$(key+'-value').textContent='OFF';$(key+'-meter').style.width='0';}}
async function start(){
  try{
    await sdk.ready();resize();layoutCamera();const response=await fetch(new URL('instrument.json',import.meta.url));if(!response.ok)throw Error('Instrument unavailable');config=await response.json();instrument=new BodyInstrument(config.gestures);
    sensitivity=config.controls.toneSensitivity.default;instrument.setToneSensitivity(sensitivity/100);renderSensitivity();void loadSensitivity();
    for(const key of ['bass','synth','vocal'])document.documentElement.style.setProperty('--'+key,config.colors[key]);
    // A browser Preview that hands this App its own camera plays like the device; without one it stays a preview.
    if(sdk.context.mode==='preview'&&!await sdk.camera.devices().then(()=>true,()=>false)){phase='preview';prompt('Your body is the instrument.','Launch on the device to play with your arms.');return;}
    phase='ready';prompt('Your body is the instrument.','Press K2 to begin.');renderSensitivity();
  }catch(error){fail(error);}
}
async function begin(){
  if(closed||!config||!['ready','error'].includes(phase))return;
  phase='starting';lastFrame=0;lastResult=0;points=[];audio={bass:0,synth:0,vocal:0,frequency:0};instrument.lose?.();renderSensitivity();
  $('tracking').textContent='HALF BODY';
  try{
    tracker=createTracker(result,fail);const trackingReady=tracker.ready;trackingReady.catch(()=>{});
    prompt('Make some room.','Allow camera and sound when asked.');
    // Sound first, while the K2 press still counts as the visitor's action; the camera can take seconds to open.
    output=await sdk.audio.openOutput({channels:2});if(closed||phase==='error'){await release();return;}output.onError(fail);
    camera=await sdk.camera.open({width:640,height:480,frameRate:24});if(closed||phase==='error'){await release();return;}camera.onError(fail);
    ac=new AudioContext({sampleRate:48000,latencyHint:'interactive',sinkId:{type:'none'}});await ac.audioWorklet.addModule(new URL('player-worklet.js',import.meta.url));
    if(closed||phase==='error'){await release();return;}
    player=new AudioWorkletNode(ac,'body-stems',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2],processorOptions:{sound:config.sound,startSeconds:config.track.startSeconds}});
    let loadedResolve,loadedReject;const loaded=new Promise((resolve,reject)=>{loadedResolve=resolve;loadedReject=reject;});loaded.catch(()=>{});
    player.port.onmessage=({data})=>{if(data.error){const error=Error(data.error);loadedReject(error);fail(error);}else if(data.ready){loadedResolve();}else audio=data;};
    sink=await output.createNode(ac);player.connect(sink);await ac.resume();prompt('Loading music.','Preparing the three parts of your song…');
    for(let index=0;index<config.track.sources.length;index++){
      const asset=await fetch(new URL(config.track.sources[index].path,import.meta.url));if(!asset.ok)throw Error('Stem unavailable');
      const decoded=await ac.decodeAudioData(await asset.arrayBuffer());if(closed||phase==='error'){await release();return;}
      if(decoded.numberOfChannels!==2)throw Error('Stereo stem required');
      const channels=[decoded.getChannelData(0).slice(),decoded.getChannelData(1).slice()];
      player.port.postMessage({type:'track',index,channels,sampleRate:decoded.sampleRate},channels.map(c=>c.buffer));
    }
    await loaded;await trackingReady;
    if(closed||phase==='error'){await release();return;}phase='live';renderSensitivity();
    camera.onFrame(frame=>{
      if(closed||phase!=='live'||document.hidden)return;
      const now=performance.now();if(now-lastFrame<45)return;lastFrame=now;
      const w=frame.displayWidth||frame.width,h=frame.displayHeight||frame.height;
      if(source.width!==w||source.height!==h){source.width=w;source.height=h;}
      sc.drawImage(frame,0,0,w,h);void tracker.frame(source,now,1);offerPicture(source,now);
    });
  }catch(error){fail(error);}
}
function normalizeSensitivity(value){
  const c=config.controls.toneSensitivity;
  return typeof value==='number'&&Number.isFinite(value)?Math.max(c.min,Math.min(c.max,Math.round(value/c.step)*c.step)):c.default;
}
function renderSensitivity(){
  clearTimeout(sensitivityMonitorTimer);
  sensitivityMonitorTimer=setTimeout(()=>{
    if(!closed&&config)void sdk.monitor.set({E1:{label:sensitivitySaveIssue?'Not saved':config.controls.toneSensitivity.label,value:sensitivity+'%'},K2:{label:phase==='live'?'Calibrate':phase==='ready'||phase==='error'?'Start':''}}).catch(()=>{});
  },32);
}
async function loadSensitivity(){
  try{
    const saved=await sdk.data.get('tone-sensitivity');if(closed)return;
    sensitivityVersion=saved.version;sensitivityReady=true;
    if(!sensitivityEdit){sensitivity=normalizeSensitivity(saved.value);instrument.setToneSensitivity(sensitivity/100);renderSensitivity();}
    else void saveSensitivity();
  }catch(error){sensitivitySaveIssue=true;renderSensitivity();console.warn('Tone sensitivity not loaded',error);}
}
async function saveSensitivity(){
  if(!sensitivityReady||sensitivitySaving||closed)return;
  sensitivitySaving=true;
  try{
    while(sensitivitySavedEdit!==sensitivityEdit&&!closed){
      const edit=sensitivityEdit,value=sensitivity;
      const saved=await sdk.data.set('tone-sensitivity',value,{expectedVersion:sensitivityVersion});
      sensitivityVersion=saved.version;sensitivitySavedEdit=edit;
    }
    sensitivitySaveIssue=false;
  }catch(error){sensitivitySaveIssue=true;console.warn('Tone sensitivity not saved',error);}
  finally{sensitivitySaving=false;renderSensitivity();}
}
function adjustSensitivity(delta){
  if(!config||closed||document.hidden||!Number.isFinite(delta)||!delta)return;
  const value=normalizeSensitivity(sensitivity+Math.trunc(delta)*config.controls.toneSensitivity.step);if(value===sensitivity)return;
  sensitivity=value;instrument.setToneSensitivity(value/100);sensitivityEdit++;renderSensitivity();
  clearTimeout(sensitivitySaveTimer);sensitivitySaveTimer=setTimeout(saveSensitivity,400);
}
function renderCalibration(now){
  const button=$('calibrate-tone');
  button.disabled=phase!=='live'||document.hidden||!instrument?.canCalibrateTone(now);
  button.textContent=now<calibrationFeedbackUntil?'[ ZERO SET ]':'[ CALIBRATE ]';
}
function startCalibration(){
  const now=performance.now();if(closed||document.hidden||phase!=='live'||!instrument?.calibrateTone(now))return;
  calibrationFeedbackUntil=now+1200;apply(instrument.snapshot(),now,lastResult);renderCalibration(now);
}
if(!isOutput)$('calibrate-tone').addEventListener('click',startCalibration);
if(!isOutput)sdk.controls.onEvent(event=>{
  if(event.type==='rotate'&&event.control==='E1'){adjustSensitivity(event.delta);return;}
  if(event.control!=='K2')return;
  if(event.type==='up'||event.type==='cancel')calibrationKeyDown=false;
  else if(event.type==='down'&&!calibrationKeyDown){calibrationKeyDown=true;if(phase==='ready'||phase==='error')void begin();else startCalibration();}
});
addEventListener('blur',()=>{calibrationKeyDown=false;});
function renderIndicators(v){
  const bassPending=v.bassPending,synthPending=v.synthPending,vocalPending=['BOTH','VOCAL_READY','VOCAL_HOLD'].includes(v.mode);
  const bassOn=audio.bass>.015,synthOn=audio.synth>.015,vocalOn=audio.vocal>.02;
  $('bass-value').textContent=bassOn?Math.round(audio.bass*100)+'%':bassPending?'HOLD':'OFF';
  $('synth-value').textContent=synthOn?Math.round(audio.synth*100)+'%':synthPending?'HOLD':'OFF';
  $('vocal-value').textContent=vocalOn?'ON':v.mode==='RESET'?'RESET':vocalPending?'HOLD':'READY';
  for(const [key,on,level]of [['bass',bassOn,audio.levels?.[0]||0],['synth',synthOn,audio.levels?.[1]||0],['vocal',vocalOn,audio.levels?.[2]||0]]){$(key).classList.toggle('active',on);$(key+'-meter').style.width=Math.min(100,Math.max(0,level*100))+'%';}
  const tone=v.brightness??.5;$('tone-value').textContent=tone<.35?'DARK':tone>.65?'BRIGHT':'WARM';$('tone-position').style.left=(tone*100)+'%';
  $('tracking').textContent=['FRAME','HANDS'].includes(v.mode)?'HALF BODY · FINDING':'HALF BODY · LIVE';
  if(v.mode==='FRAME')prompt('Show your playing arm.','Keep its shoulder and hand in the picture.');
  else if(v.mode==='HANDS')prompt('Show your playing hand.','Keep its shoulder visible too.');
  else prompt('','');
}
function draw(now){
  requestAnimationFrame(draw);const delta=Math.min(.05,(now-previousTime)/1000||0);previousTime=now;
  renderCalibration(now);shareLive();if(phase==='error')return;
  const v=instrument?(phase==='live'?instrument.tick(now):instrument.snapshot()):null;
  if(phase==='live'){if(v.mode!==lastAppliedMode&&['FRAME','RESET'].includes(v.mode))apply(v,now);renderIndicators(v);}
  ctx.fillStyle='#111';ctx.fillRect(0,0,width,height);
  if(!config||!lastFrame)return;
  const availableHeight=Math.max(1,cameraArea.bottom-cameraArea.top);
  const scale=Math.min(width/source.width,availableHeight/source.height),sw=source.width*scale,sh=source.height*scale,x=(width-sw)/2,y=cameraArea.top+(availableHeight-sh)/2;
  cameraRect={x,y,width:sw,height:sh,sourceWidth:source.width,sourceHeight:source.height};
  paint(ctx,cameraRect,source,points,v?.brightness??.5,audio,1,width/2,delta);
  if(phase==='live')sharePose(v,now);
}
// Draws the camera picture, sound rings, hand links and body into rect; k scales strokes for a larger picture.
function paint(g,rect,picture,pts,tone,sound,k,cx,delta){
  const {x,y,width:sw,height:sh}=rect,xy=p=>[x+p[0]*sw,y+(1-p[1])*sh],colors=config.colors;
  if(picture){g.save();g.globalAlpha=.8;g.drawImage(picture,x,y,sw,sh);g.restore();}
  const energy=Math.max(...(sound.levels||[0,0,0]));visualTime+=delta*(.15+energy);
  if(energy>.015){g.globalAlpha=(.18+energy*.28)*(.6+.4*tone);g.lineWidth=1.5*k;
    for(let ring=0;ring<4;ring++){g.strokeStyle=sound.vocal>.02?colors.vocal:sound.bass>.015&&sound.synth>.015?(ring%2?colors.bass:colors.synth):sound.bass>.015?colors.bass:colors.synth;g.beginPath();for(let i=0;i<=70;i++){const a=i/70*Math.PI*2,r=(50+ring*15+Math.sin(a*3+visualTime*3+ring)*energy*13)*k;const px=cx+Math.cos(a)*r*1.4,py=y+sh*.5+Math.sin(a)*r*.6;i?g.lineTo(px,py):g.moveTo(px,py);}g.stroke();}g.globalAlpha=1;}
  if(visiblePoint(pts[0])){
    for(const [i,key,color]of [[15,'bassFocus',colors.bass],[16,'synthFocus',colors.synth]]){
      const focus=sound[key]||0;if(focus<.025||!visiblePoint(pts[i]))continue;
      g.globalAlpha=.15+focus*.65;g.strokeStyle=color;g.lineWidth=(1+focus*3)*k;
      g.beginPath();g.moveTo(...xy(pts[0]));g.lineTo(...xy(pts[i]));g.stroke();
      g.beginPath();g.arc(...xy(pts[i]),(7+focus*9)*k,0,Math.PI*2);g.stroke();
    }
    g.globalAlpha=1;
  }
  g.lineWidth=2.5*k;g.lineCap='round';
  for(const [a,b]of edges){if(!visiblePoint(pts[a])||!visiblePoint(pts[b]))continue;g.strokeStyle=sound.vocal>.02?colors.vocal:[13,15].includes(b)?colors.bass:[14,16].includes(b)?colors.synth:colors.idle;g.beginPath();g.moveTo(...xy(pts[a]));g.lineTo(...xy(pts[b]));g.stroke();}
  for(const i of [0,11,12,13,14,15,16,23,24]){if(!visiblePoint(pts[i]))continue;g.fillStyle=i===15?colors.bass:i===16?colors.synth:'#eee8df';g.beginPath();g.arc(...xy(pts[i]),(i===0?5:i>=15?4:2.5)*k,0,Math.PI*2);g.fill();}
}
// ---- Output role ------------------------------------------------------------------------------------------------
const round=value=>Math.round((Number(value)||0)*1e4)/1e4;
const offerPicture=isOutput?()=>{}:createPictureSender(relay);
let sharedLive=null,sentPose=0;
function shareLive(){
  const live=phase==='live';if(isOutput||!relay||live===sharedLive)return;sharedLive=live;
  try{relay.publish({live});}catch(_){}
}
function sharePose(v,now){
  shareLive();if(isOutput||!relay||document.hidden||now-sentPose<33)return;sentPose=now;
  const p=POSE_POINTS.map(i=>{const q=points[i];return Array.isArray(q)?[round(q[0]),round(q[1]),round(q[3])]:null;});
  try{relay.send({t:'pose',p,b:round(v?.brightness??.5),s:{levels:(audio.levels||[0,0,0]).map(round),bass:round(audio.bass),synth:round(audio.synth),vocal:round(audio.vocal),bassFocus:round(audio.bassFocus),synthFocus:round(audio.synthFocus)}});}catch(_){}
}
async function startOutput(){
  const stats=globalThis.bodyVibesOutput={followed:0,poses:0,pictures:0,drawn:0};
  const backdrop=document.createElement('canvas');backdrop.width=32;backdrop.height=24;
  const pictures=createPictureReceiver(picture=>{stats.pictures++;stats.pictureSize=[picture.width,picture.height];backdrop.getContext('2d').drawImage(picture,0,0,backdrop.width,backdrop.height);});
  let live=false,pose=[],poseAt=0,tone=.5,sound={levels:[0,0,0],bass:0,synth:0,vocal:0},previous=0,shown=0;
  const fit=()=>{const w=innerWidth||1,h=innerHeight||1,dpr=Math.min(devicePixelRatio||1,2,Math.sqrt(1920*1080/(w*h)));canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(canvas.width/w,0,0,canvas.height/h,0,0);width=w;height=h;};
  fit();addEventListener('resize',fit);
  try{const response=await fetch(new URL('instrument.json',import.meta.url));if(!response.ok)throw Error('Instrument unavailable');config=await response.json();await sdk.ready();}catch(_){return;}
  relay?.onMessage(({kind,data}={})=>{
    if(!data||typeof data!=='object')return;
    if(kind==='state'){live=data.live===true;stats.followed++;if(!live){pose=[];pictures.clear();sound={levels:[0,0,0],bass:0,synth:0,vocal:0};}return;}
    if(pictures.take(data))return;
    if(data.t==='pose'&&Array.isArray(data.p)){
      pose=[];POSE_POINTS.forEach((index,i)=>{const q=data.p[i];if(Array.isArray(q)&&q.length===3&&q.every(Number.isFinite))pose[index]=[q[0],q[1],0,q[2]];});
      poseAt=performance.now();tone=Number.isFinite(data.b)?Math.max(0,Math.min(1,data.b)):.5;stats.poses++;stats.visible=pose.filter(q=>visiblePoint(q)).length;
      const s=data.s||{},n=v=>Number.isFinite(v)?Math.max(0,Math.min(1.5,v)):0;
      sound={levels:Array.isArray(s.levels)?s.levels.slice(0,3).map(n):[0,0,0],bass:n(s.bass),synth:n(s.synth),vocal:n(s.vocal),bassFocus:n(s.bassFocus),synthFocus:n(s.synthFocus)};
    }
  });
  const frame=now=>{
    requestAnimationFrame(frame);const delta=Math.min(.05,(now-previous)/1000||0);previous=now;
    ctx.fillStyle='#111';ctx.fillRect(0,0,width,height);
    // The picture fades in when it arrives and out when the device stops sending it.
    const fresh=live&&pictures.at&&now-pictures.at<1500;shown+=((fresh?1:0)-shown)*Math.min(1,delta*6);
    if(now-poseAt>600){pose=[];sound={...sound,levels:sound.levels.map(v=>v*.9)};}
    if(!pictures.at||shown<.01)return;
    const pw=pictures.canvas.width,ph=pictures.canvas.height,scale=Math.min(width/pw,height/ph),sw=pw*scale,sh=ph*scale;
    const rect={x:(width-sw)/2,y:(height-sh)/2,width:sw,height:sh};
    ctx.save();ctx.globalAlpha=.35*shown;ctx.imageSmoothingQuality='high';
    const cover=Math.max(width/pw,height/ph);ctx.drawImage(backdrop,(width-pw*cover)/2,(height-ph*cover)/2,pw*cover,ph*cover);ctx.restore();
    ctx.save();ctx.globalAlpha=shown;paint(ctx,rect,pictures.canvas,pose,tone,sound,Math.max(1,sh/300),width/2,delta);ctx.restore();stats.drawn++;
  };
  requestAnimationFrame(frame);
}
globalThis.BodyVibesDiagnostics={snapshot:()=>({phase,gesture:instrument?.snapshot(),audio:{...audio},viewport:{width,height},cameraRect:cameraRect?{...cameraRect}:null,audioState:ac?.state,metrics:structuredClone(metrics)})};
addEventListener('pagehide',()=>{closed=true;clearTimeout(sensitivitySaveTimer);clearTimeout(sensitivityMonitorTimer);void release();},{once:true});
document.addEventListener('visibilitychange',()=>{if(document.hidden){calibrationKeyDown=false;instrument?.lose();player?.port.postMessage({type:'stop'});}});
if(isOutput)void startOutput();else{requestAnimationFrame(draw);void start();}
