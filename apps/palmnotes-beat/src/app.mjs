import {createPictureSender,createPictureReceiver} from './picture-relay.mjs';
import {instrument} from './instrument.mjs';
import {Round,readScore} from './score.mjs';
import {createView} from './view.mjs';

const sdk=globalThis.VrchApp, $=id=>document.getElementById(id);
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const wrap=(i,len)=>(i%len+len)%len;
async function json(path){const response=await fetch(new URL(path,import.meta.url));if(!response.ok)throw Error(path);return response.json();}

async function boot(){
  const config=await json('instrument.json'), paint=createView(config);
  await sdk.ready();
  if(sdk.context?.role==='output'){
    document.documentElement.dataset.output='';
    let state=null, received=0;
    const camera=$('camera'),ctx=camera.getContext('2d');
    const receiver=createPictureReceiver(frame=>{
      if(!state?.camera)return;
      if(camera.width!==frame.width||camera.height!==frame.height){camera.width=frame.width;camera.height=frame.height;}
      ctx.drawImage(frame,0,0);camera.hidden=false;document.body.dataset.picture='on';
    });
    sdk.output.onMessage(({kind,data})=>{
      if(kind==='event' && state?.camera){receiver.take(data);return;}
      if(kind!=='state'||!data?.title)return;
      state=data;received=performance.now();
      if(!state.camera){receiver.clear();camera.hidden=true;delete document.body.dataset.picture;}
      paint(data,data.beat);
    });
    function show(now){if(state?.moving)paint(state,state.beat+Math.min(350,now-received)*state.bpm/60000);requestAnimationFrame(show);}
    requestAnimationFrame(show);return;
  }
  const songs=(await json('scores.json')).map(readScore);
  const settings={volume:70,voice:'soft',melodyHand:'left'};
  let follow=true;
  let index=0,bpm=songs[0].bpm,phase='idle',error='',round=null,finished=false,manual=false;
  let readyHands=false,sounding=null,octave=0,held=null,trace=[],lastPublish=-Infinity,dirty=true;
  let voiceChosen=false, revision=0,saved={},saveQueue=Promise.resolve(),saveTimer,closed=false;
  try{
    const data=await sdk.data.get('settings');saved=data?.value||{};revision=data?.version||0;
    if(Number.isFinite(saved.volume))settings.volume=clamp(saved.volume,0,100);
    if(config.voices.some(v=>v.id===saved.voice)){settings.voice=saved.voice;voiceChosen=true;}
    if(saved.melodyHand==='right')settings.melodyHand='right';
  }catch{}
  function save(){
    clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveQueue=saveQueue.then(async()=>{
      const next={...saved,...settings};const result=await sdk.data.set('settings',next,{expectedVersion:revision});revision=result.version;saved=next;
    }).catch(()=>{$('instruction').textContent='Settings could not be saved.';});},250);
  }
  const busy=()=>phase==='starting'||phase==='live';
  const sides=()=>settings.melodyHand==='left'?'Play with your left hand':'Play with your right hand';
  function beginCount(){round=new Round(songs[index],bpm,performance.now()+(follow?0:4)*60000/bpm,follow);dirty=true;controls();}
  // Earlier SDKs can relay pictures but do not report whether an output is attached.
  let outputVisible=typeof sdk.output?.onPresence!=='function', hasPicture=false;
  const offerPicture=createPictureSender(sdk.output,{maxWidth:640,intervalMs:65});
  sdk.output?.onPresence?.(({active})=>{outputVisible=active;});
  const audio=instrument(config,settings,{
    hitTime:()=>round?.hitAt ?? -Infinity,
    onPicture(canvas){
      if(!hasPicture){hasPicture=true;$('camera').hidden=false;document.body.dataset.picture='on';dirty=true;}
      if(outputVisible)offerPicture(canvas);
    },
    onState(next,reason){phase=next;error=reason;dirty=true;if(!busy()&&!finished)round=null;controls();},
    onHands(result){
      const other=settings.melodyHand==='left'?'right':'left';
      readyHands=result.hands?.[other]?.octave!=null;
      if(readyHands && !round && phase==='live')beginCount();
    },
    onNote(sound,onset){
      sounding=sound;dirty=true;
      const now=performance.now();
      if(!round || !sound || finished)return;
      const before=round.hits;
      round.strike(sound.note,sound.octave,onset,now);
      if(round.hits>before)round.hitAt=now;
      if(round.beat(onset)>=-.25){
        trace.push([Math.max(0,round.beat(onset)),sound.note,sound.octave]);if(trace.length>36)trace.shift();
      }
    }
  });
  function controls(){
    const active=busy();$('library').disabled=active;
    if(!active || manual){hasPicture=false;$('camera').hidden=true;delete document.body.dataset.picture;}
    $('start').textContent=active?'Stop':finished?'Play again':'Start camera';
    $('practice').hidden=active;$('padrow').hidden=!active||!manual;
    $('octave').textContent=['Low','Mid','High'][octave+1]+' ↕';
    let instruction=sides()+' · '+(follow?'at your own pace':'match the beat');
    if(active && manual)instruction='Hold a note to play. Release to stop.';
    if(active && !manual)instruction=round?'Close and reopen your hand to repeat a note.':'Can’t see yourself? Stop → S1 → Camera to check the source.';
    $('instruction').textContent=error || instruction;
    const voice=config.voices.find(v=>v.id===settings.voice);
    void sdk.monitor.set({E1:{label:'Volume',value:settings.volume+'%'},E2:{label:'Voice',value:voice.name},
      E3:{label:active?'':'Song',value:active?'':String(index+1)},E4:{label:active?'':'Tempo',value:active?'':String(bpm)},
      K2:{label:active?'Stop':'Start'},K3:{label:active?'':'Swap'},K4:{label:active?'':'Songs'}}).catch(()=>{});
  }
  function stop(){held=null;readyHands=false;sounding=null;void audio.stop();}
  async function start(tap){
    if(busy()){finished=false;stop();return;}
    $('book').close();round=null;finished=false;trace=[];octave=0;manual=tap;held=null;error='';readyHands=false;
    if(await audio.start(!tap) && tap)beginCount();
  }
  function pick(i){
    if(busy())return;index=wrap(i,songs.length);bpm=songs[index].bpm;if(!voiceChosen)settings.voice=songs[index].title==='Jingle Bells'?'bell':'soft';
    round=null;finished=false;trace=[];
    dirty=true;controls();drawBook();
  }
  function drawBook(){
    for(const button of $('modes').children)button.setAttribute('aria-pressed',String((button.dataset.mode==='follow')===follow));
    const rows=songs.map((song,i)=>{const b=document.createElement('button');b.textContent=song.title;b.setAttribute('aria-pressed',String(i===index));b.onclick=()=>{pick(i);$('book').close();};return b;});
    $('songs').replaceChildren(...rows);
    if($('book').open)rows[index].scrollIntoView({block:'nearest'});
  }
  function book(){if(busy())return;if($('book').open)$('book').close();else{drawBook();$('book').showModal();}}
  for(const button of $('modes').children)button.onclick=()=>{follow=button.dataset.mode==='follow';round=null;finished=false;trace=[];dirty=true;drawBook();controls();};
  $('library').onclick=book;$('close').onclick=()=>$('book').close();
  $('start').onclick=()=>void start(false);$('practice').onclick=()=>void start(true);
  $('file').onchange=async()=>{
    const file=$('file').files[0];$('file').value='';if(!file)return;
    try{
      if(file.size>256*1024)throw Error('Choose a score under 256 KB.');
      const song=readScore(JSON.parse(await file.text()));
      songs.push(song);pick(songs.length-1);
      try{await sdk.files.put('score-'+song.title+'.json',file);$('fileStatus').textContent='Imported '+song.title;}
      catch{$('fileStatus').textContent='Ready to play this session. The host could not save the file.';}
    }catch(e){$('fileStatus').textContent=e instanceof SyntaxError?'Check the JSON syntax.':e.message;}
  };
  async function restore(){
    let cursor=null;
    do{const page=await sdk.files.list(cursor);
      for(const row of page.items){if(!row.name.startsWith('score-'))continue;
        try{const file=await sdk.files.get(row.id);songs.push(readScore(JSON.parse(await file.data.text())));}catch{}}
      cursor=page.cursor;
    }while(cursor);
    drawBook();
  }
  await restore().catch(()=>{});
  const pressed=new Set();
  sdk.controls.onEvent(e=>{
    if(e.type==='rotate' && Number.isFinite(e.delta)){
      const step=Math.trunc(e.delta);
      if(e.control==='E1'){settings.volume=clamp(settings.volume+step*2,0,100);save();}
      if(e.control==='E2'){voiceChosen=true;const i=config.voices.findIndex(v=>v.id===settings.voice);settings.voice=config.voices[wrap(i+step,config.voices.length)].id;save();}
      if(!busy() && e.control==='E3')pick(index+step);
      if(!busy() && e.control==='E4'){round=null;finished=false;trace=[];bpm=clamp(bpm+step,30,180);dirty=true;}
      controls();return;
    }
    if(e.type==='up'||e.type==='cancel')pressed.delete(e.control);
    if(e.type!=='down'||pressed.has(e.control))return;pressed.add(e.control);
    if(e.control==='K2')void start(false);
    if(e.control==='K3'&&!busy()){settings.melodyHand=settings.melodyHand==='left'?'right':'left';save();dirty=true;controls();}
    if(e.control==='K4')book();
  });
  function pad(n,token){if(!manual||phase!=='live'||held===token)return;held=token;audio.play(n,octave,performance.now(),300);}
  function lift(token){if(held!==null && (token===undefined||held===token)){held=null;audio.play(0,0,performance.now(),0);}}
  $('octave').onclick=()=>{lift();octave=octave===1?-1:octave+1;controls();};
  for(const note of config.notes){
    const b=document.createElement('button');b.textContent=note.name;b.style.setProperty('--c',note.color);b.setAttribute('aria-label','Play '+note.name);
    b.onpointerdown=e=>{e.preventDefault();b.setPointerCapture(e.pointerId);pad(note.id,e.pointerId);};
    b.onlostpointercapture=b.onpointerup=b.onpointercancel=e=>lift(e.pointerId);
    b.onkeydown=e=>{if((e.key===' '||e.key==='Enter')&&!e.repeat){e.preventDefault();pad(note.id,e.code);}};
    b.onkeyup=e=>lift(e.code);$('pads').append(b);
  }
  addEventListener('keydown',e=>{if(!manual||phase!=='live'||e.repeat||!(/^[1-7]$/.test(e.key)))return;pad(+e.key,e.code);});
  addEventListener('keyup',e=>lift(e.code));
  addEventListener('blur',()=>{pressed.clear();lift();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden && busy()){finished=false;stop();}});
  addEventListener('pagehide',()=>{closed=true;clearTimeout(saveTimer);audio.close();});
  function snapshot(now){
    const score=songs[index], beat=round?round.beat(now):0;
    const cursor=round?.cursor??0;
    let i=cursor;
    while(i<score.notes.length && (round?.results.has(i) || score.notes[i].at+.4<beat))i++;
    const target=score.notes[Math.min(i,score.notes.length-1)];
    const cards=[];
    for(let j=Math.max(0,cursor-2);j<score.notes.length;j++){
      const note=score.notes[j];if(note.at-beat>2.3)break;if(note.at-beat<-.8)continue;
      cards.push({...note,dense:note.duration<.3 || score.notes[j-1]?.duration<.3,state:round?.results.has(j)?(round.results.get(j)?'hit':'miss'):'',
        repeat:note.n>0 && score.notes[j-1]?.n===note.n && score.notes[j-1]?.oct===note.oct});
    }
    const end=Math.max(8,Math.ceil(Math.max(0,Math.min(beat,score.beats)-.01)/8)*8);
    const phrase=trace.filter(p=>p[0]>=end-8 && p[0]<=end).map(([t,n,o])=>[(t-end+8)/8,n,o]);
    let status='Ready',feedback='Play at the beat line';
    if(phase==='starting')status=manual?'Starting audio…':hasPicture?'Camera on · starting audio':'Waiting for camera…';
    if(phase==='error')status='Could not start';
    if(phase==='live' && !round){status='Show both hands';feedback=settings.melodyHand==='left'?'Make a fist with your right hand to begin':'Make a fist with your left hand to begin';}
    if(round && beat<0){status=follow?'Play the first note':'Get ready · '+Math.ceil(-beat);feedback='Get your first shape ready';}
    if(round && beat>=0){
      status='Bar '+Math.min(Math.floor(beat/score.bar)+1,Math.ceil(score.beats/score.bar));
      feedback=now-round.feedbackAt<550?round.feedback:sounding?'Played '+config.notes[sounding.note-1].name:'Follow the beat';
      if(feedback==='Try again' && sounding)feedback+=' · '+config.notes[sounding.note-1].name;
      if(follow && now-round.feedbackAt>550 && target && beat===target.at)feedback='Your turn · '+config.notes[target.n-1]?.name;
      if(!manual && !readyHands)feedback='Show both hands · fist or thumb for octave';
    }
    if(finished){status='Song complete';feedback=round.hits+' of '+score.total+' notes played';}
    return {camera:busy()&&!manual,manual:busy()&&manual,playing:busy(),title:score.title,bpm,hand:settings.melodyHand,beat,played:sounding?config.notes[sounding.note-1].name:'',moving:!!round&&!finished&&(!follow||beat<(target?.at??Infinity)||round.results.has(target?.index)),finished,target,repeat:!!target?.n && score.notes[i-1]?.n===target.n && score.notes[i-1]?.oct===target.oct,cards,trace:phrase,status,feedback,
      hits:round?.hits??0,total:score.total,combo:round?.combo??0,best:round?.best??0};
  }
  let lastFrame=-Infinity;
  function frame(now){
    if(closed)return;requestAnimationFrame(frame);
    if(!dirty && (now-lastFrame<32||!busy()))return;lastFrame=now;
    if(held!==null && sounding && manual)audio.play(sounding.note,sounding.octave,now,300);
    if(round&&!finished){
      // Allow a captured hand transition to settle before expiring its scoring window.
      round.advance(now-(manual?0:config.tracking.staleMs+config.tracking.settleMs));
      if(round.done(now)){finished=true;stop();}
    }
    const state=snapshot(now);paint(state,state.beat);
    for(let i=0;i<$('pads').children.length;i++)$('pads').children[i].classList.toggle('on',sounding?.note===i+1);
    if(dirty||now-lastPublish>=160){sdk.output?.publish(state);lastPublish=now;}
    dirty=false;
  }
  controls();requestAnimationFrame(frame);
}
boot().catch(error=>{document.getElementById('status').textContent='Could not load · '+error.message;});
