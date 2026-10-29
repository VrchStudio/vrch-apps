import {BodyInstrument,visiblePoint} from './motion.mjs';
import {createTracker} from './tracker.mjs';
const sdk=globalThis.VrchApp,$=id=>document.getElementById(id);
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
addEventListener('resize',()=>{resize();layoutCamera();});
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
async function release(){player?.port.postMessage({type:'stop'});tracker?.close();await Promise.allSettled([camera?.close(),output?.close(),ac?.close()]);}
function fail(error){if(closed||phase==='error')return;console.error('BODY VIBES',error);phase='error';audio={bass:0,synth:0,vocal:0};void release();prompt('Let’s reconnect.','Check camera and sound in Menu, then Reload.');$('tracking').textContent='STOPPED';for(const key of ['bass','synth','vocal']){$(key).classList.remove('active');$(key+'-value').textContent='OFF';$(key+'-meter').style.width='0';}}
async function start(){
  try{
    await sdk.ready();resize();layoutCamera();const response=await fetch(new URL('instrument.json',import.meta.url));if(!response.ok)throw Error('Instrument unavailable');config=await response.json();instrument=new BodyInstrument(config.gestures);
    sensitivity=config.controls.toneSensitivity.default;instrument.setToneSensitivity(sensitivity/100);renderSensitivity();void loadSensitivity();
    for(const key of ['bass','synth','vocal'])document.documentElement.style.setProperty('--'+key,config.colors[key]);
    if(sdk.context.mode==='preview'){phase='preview';prompt('Your body is the instrument.','Launch on the device to play with your arms.');return;}
    tracker=createTracker(result,fail);const trackingReady=tracker.ready;trackingReady.catch(()=>{});
    prompt('Make some room.','Allow camera and sound when asked.');
    camera=await sdk.camera.open({width:640,height:480,frameRate:24});if(closed||phase==='error'){await release();return;}camera.onError(fail);
    output=await sdk.audio.openOutput({channels:2});if(closed||phase==='error'){await release();return;}output.onError(fail);
    ac=new AudioContext({sampleRate:48000,latencyHint:'interactive'});await ac.audioWorklet.addModule(new URL('player-worklet.js',import.meta.url));
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
    if(closed||phase==='error'){await release();return;}phase='live';
    camera.onFrame(frame=>{
      if(closed||phase!=='live'||document.hidden)return;
      const now=performance.now();if(now-lastFrame<45)return;lastFrame=now;
      const w=frame.displayWidth||frame.width,h=frame.displayHeight||frame.height;
      if(source.width!==w||source.height!==h){source.width=w;source.height=h;}
      sc.drawImage(frame,0,0,w,h);void tracker.frame(source,now,1);
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
    if(!closed)void sdk.monitor.set({E1:{label:sensitivitySaveIssue?'Not saved':config.controls.toneSensitivity.label,value:sensitivity+'%'},K2:{label:'Calibrate'}}).catch(()=>{});
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
$('calibrate-tone').addEventListener('click',startCalibration);
sdk.controls.onEvent(event=>{
  if(event.type==='rotate'&&event.control==='E1'){adjustSensitivity(event.delta);return;}
  if(event.control!=='K2')return;
  if(event.type==='up'||event.type==='cancel')calibrationKeyDown=false;
  else if(event.type==='down'&&!calibrationKeyDown){calibrationKeyDown=true;startCalibration();}
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
  renderCalibration(now);if(phase==='error')return;
  const v=instrument?(phase==='live'?instrument.tick(now):instrument.snapshot()):null;
  if(phase==='live'){if(v.mode!==lastAppliedMode&&['FRAME','RESET'].includes(v.mode))apply(v,now);renderIndicators(v);}
  ctx.fillStyle='#111';ctx.fillRect(0,0,width,height);
  if(!config||!lastFrame)return;
  const availableHeight=Math.max(1,cameraArea.bottom-cameraArea.top);
  const scale=Math.min(width/source.width,availableHeight/source.height),sw=source.width*scale,sh=source.height*scale,x=(width-sw)/2,y=cameraArea.top+(availableHeight-sh)/2;
  cameraRect={x,y,width:sw,height:sh,sourceWidth:source.width,sourceHeight:source.height};
  const xy=p=>[x+p[0]*sw,y+(1-p[1])*sh];
  // The SDK already applies the shared Device camera rotation and mirror.
  ctx.save();ctx.globalAlpha=.8;ctx.drawImage(source,x,y,sw,sh);ctx.restore();
  const energy=Math.max(...(audio.levels||[0,0,0]));visualTime+=delta*(.15+energy);
  if(energy>.015){const tone=v?.brightness??.5;ctx.globalAlpha=(.18+energy*.28)*(.6+.4*tone);ctx.lineWidth=1.5;
    for(let ring=0;ring<4;ring++){ctx.strokeStyle=audio.vocal>.02?config.colors.vocal:audio.bass>.015&&audio.synth>.015?(ring%2?config.colors.bass:config.colors.synth):audio.bass>.015?config.colors.bass:config.colors.synth;ctx.beginPath();for(let k=0;k<=70;k++){const a=k/70*Math.PI*2,r=50+ring*15+Math.sin(a*3+visualTime*3+ring)*energy*13;const px=width/2+Math.cos(a)*r*1.4,py=y+sh*.5+Math.sin(a)*r*.6;k?ctx.lineTo(px,py):ctx.moveTo(px,py);}ctx.stroke();}ctx.globalAlpha=1;}
  if(visiblePoint(points[0])&&v){
    for(const [i,key,color]of [[15,'bassFocus',config.colors.bass],[16,'synthFocus',config.colors.synth]]){
      const focus=audio[key]||0;if(focus<.025||!visiblePoint(points[i]))continue;
      ctx.globalAlpha=.15+focus*.65;ctx.strokeStyle=color;ctx.lineWidth=1+focus*3;
      ctx.beginPath();ctx.moveTo(...xy(points[0]));ctx.lineTo(...xy(points[i]));ctx.stroke();
      ctx.beginPath();ctx.arc(...xy(points[i]),7+focus*9,0,Math.PI*2);ctx.stroke();
    }
    ctx.globalAlpha=1;
  }
  ctx.lineWidth=2.5;ctx.lineCap='round';
  for(const [a,b]of edges){if(!visiblePoint(points[a])||!visiblePoint(points[b]))continue;ctx.strokeStyle=audio.vocal>.02?config.colors.vocal:[13,15].includes(b)?config.colors.bass:[14,16].includes(b)?config.colors.synth:config.colors.idle;ctx.beginPath();ctx.moveTo(...xy(points[a]));ctx.lineTo(...xy(points[b]));ctx.stroke();}
  for(const i of [0,11,12,13,14,15,16,23,24]){if(!visiblePoint(points[i]))continue;ctx.fillStyle=i===15?config.colors.bass:i===16?config.colors.synth:'#eee8df';ctx.beginPath();ctx.arc(...xy(points[i]),i===0?5:i>=15?4:2.5,0,Math.PI*2);ctx.fill();}
}
globalThis.BodyVibesDiagnostics={snapshot:()=>({phase,gesture:instrument?.snapshot(),audio:{...audio},viewport:{width,height},cameraRect:cameraRect?{...cameraRect}:null,audioState:ac?.state,metrics:structuredClone(metrics)})};
addEventListener('pagehide',()=>{closed=true;clearTimeout(sensitivitySaveTimer);clearTimeout(sensitivityMonitorTimer);void release();},{once:true});
document.addEventListener('visibilitychange',()=>{if(document.hidden){calibrationKeyDown=false;instrument?.lose();player?.port.postMessage({type:'stop'});}});
requestAnimationFrame(draw);void start();
