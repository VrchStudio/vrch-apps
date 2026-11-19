import {recognize, NoteGate} from './gesture.mjs';
import {createTracker} from './tracker.mjs';
import {Tone} from './tone.mjs';

// Capture, landmark worker, synthesis and the host PCM pump come from PalmNotes Duo 0.2.1.
export function instrument(config,settings,{onState,onNote,onHands,onPicture,hitTime}) {
  const sdk=globalThis.VrchApp, $=id=>document.getElementById(id);
  const gate=new NoteGate(config.tracking), source=document.createElement('canvas');
  const sourceCtx=source.getContext('2d'), ctx=$('camera').getContext('2d');
  let current=null, epoch=0, closed=false, phase='idle', errorText='', mappingRevision=0;
  let hands={}, bits={}, melodyGesture='none', landmarks=[], lastResult=-Infinity, lastKey=null;
  const render=()=>onState(phase,errorText);
  function play(note,oct,at,lease=config.tracking.staleMs) {
    if(!current || phase!=='live')return;
    const sound=config.sounds.find(s=>s.note===note && s.octave===oct);
    current.frequency=sound?.frequency || 0;
    if(sound)current.octave=oct;
    current.deadline=performance.now()+lease;
    const key=sound?.id ?? null;
    if(key!==lastKey){lastKey=key;onNote(sound,at);}
  }
  function rest(){
    gate.reset();hands={};bits={};landmarks=[];melodyGesture='none';lastResult=-Infinity;
    play(0,0,performance.now(),0);lastKey=null;
  }
  async function stop(){
    epoch++;rest();const value=current;current=null;phase='idle';errorText='';
    ctx.clearRect(0,0,$('camera').width,$('camera').height);if(!closed)render();await release(value);
  }
  function fail(value,error,fallback){
    if(current!==value || closed)return;
    const pending=stop(), token=epoch;
    void pending.then(()=>{if(!closed && epoch===token){phase='error';errorText=fallback;render();}});
  }
  function receive(value,result){
    if(current!==value || phase!=='live' || result.sourceRevision!==mappingRevision)return;
    const at=result.capturedAtMs, age=performance.now()-at;
    if(age>config.tracking.staleMs){rest();return;}
    const detected=recognize(result.tracks,{...config.tracking,melodyHand:settings.melodyHand},{bits,melodyGesture},result.sourceWidth/result.sourceHeight,config.sounds);
    ({hands,bits,melodyGesture}=detected);landmarks=result.tracks.map(t=>t.landmarks).filter(p=>Array.isArray(p)&&p.length===21);
    lastResult=at;
    const key=gate.update(detected.key,at), sound=config.sounds.find(s=>s.id===key);
    onHands(detected);
    play(sound?.note,sound?.octave,sound?gate.since:at,config.tracking.staleMs-Math.max(0,age));
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
    } catch (error) { fail(value, error, 'Sound stopped. Check audio output and try again.'); }
  }

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

  function draw(frame, value) {
    if (current !== value) return;
    const captured=performance.now(), width=frame.width, height=frame.height;
    if (source.width !== width || source.height !== height) {source.width=width;source.height=height;$('camera').width=width;$('camera').height=height;}
    sourceCtx.drawImage(frame,0,0);

    ctx.save();
    ctx.drawImage(source, 0, 0);
    if (performance.now() - lastResult <= config.tracking.staleMs) for (const hand of landmarks) {
      const melody=hands[settings.melodyHand]?.landmarks===hand;
      const note=melody && config.notes.find(n=>n.id===hands[settings.melodyHand]?.note);
      const ink=note?.color || (melody?'#ffca99':'#e6fff4');
      ctx.lineJoin='round';ctx.lineCap='round';
      const point=i=>[hand[i][0]*width,(1-hand[i][1])*height];
      ctx.beginPath();
      for(const [a,b] of config.connections){ctx.moveTo(...point(a));ctx.lineTo(...point(b));}
      ctx.lineWidth=width/110;ctx.strokeStyle='#19181d99';ctx.stroke();
      ctx.lineWidth=width/260;ctx.strokeStyle=ink;ctx.stroke();
      for(const i of [4,8,12,16,20]){
        ctx.beginPath();ctx.arc(...point(i),width/125,0,Math.PI*2);ctx.fillStyle=ink;ctx.fill();
      }
      const age=performance.now()-hitTime();
      if(melody && age>=0 && age<450){
        const t=age/450,[x,y]=point(8);
        ctx.save();ctx.globalAlpha=1-t;ctx.strokeStyle=ink;ctx.lineWidth=2.6;
        for(let j=0;j<8;j++){
          const angle=Math.PI*2*j/8, r=width*(.035+.055*t);
          ctx.beginPath();ctx.moveTo(x+Math.cos(angle)*r,y+Math.sin(angle)*r);
          ctx.lineTo(x+Math.cos(angle)*(r+8),y+Math.sin(angle)*(r+8));ctx.stroke();
        }
        ctx.restore();
      }
      if(note && lastKey){
        const sound=config.sounds.find(s=>s.id===lastKey);
        if(sound){
          const label=config.notes[sound.note-1].name,[x,y]=point(0);
          const w=width*.12,h=width*.062,l=Math.min(width-w,Math.max(0,x-w/2)),top=Math.min(height-h,Math.max(0,y+6));
          ctx.fillStyle=config.notes[sound.note-1].color;ctx.fillRect(l,top,w,h);
          ctx.fillStyle='#18171b';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='bold '+Math.round(h*.72)+'px sans-serif';
          ctx.fillText(label,l+w/2,top+h/2);
        }
      }
    }
    ctx.restore();
    onPicture(ctx.canvas);
    if(value.tracker && phase==='live')void value.tracker.frame(source,captured,mappingRevision);
  }

  async function start(useCamera) {
    if (closed || phase === 'starting' || phase === 'live') return;
    const token = ++epoch, value = {released: new Set(), frequency: 0, octave: 0, deadline: 0, synth: new Tone(48000, config.sound, config.voices)};
    const check = () => { if (closed || token !== epoch) throw Object.assign(Error('Cancelled'), {cancelled: true}); };
    current = value; phase = 'starting'; render();
    let step = 'Allow audio playback and try again.';
    try {
      if(useCamera){
        step='Allow camera access, or choose Play by touch.';
        value.camera=await sdk.camera.open({width:640,height:480,frameRate:30});check();
        value.camera.onError(error=>fail(value,error,'Camera disconnected. Reconnect it and try again.'));
        value.unsubscribe=value.camera.onFrame(frame=>draw(frame,value));
        step='Hand tracking could not start. Try again.';
        value.tracker=createTracker(result=>receive(value,result),error=>fail(value,error,'Hand tracking stopped. Try again.'));
        await value.tracker.ready;check();
      }
      step='Allow audio playback and try again.';
      value.output = await sdk.audio.openOutput({channels: 1}); check();
      value.bufferMs = 2 * value.output.blockFrames / value.output.sampleRate * 1000;
      value.lastGenerated = performance.now();
      value.output.onError(error => fail(value, error, 'Sound stopped. Check audio output and try again.'));
      void pump(value); void pump(value);
      phase = 'live'; render(); return true;
    } catch (error) {
      // Closing output rejects pending writes. Detach first so those secondary
      // errors cannot replace the original camera/model failure or cancel Retry.
      if (current === value) current = null;
      await release(value);
      if (error.cancelled || token !== epoch || closed) return;
      current = null; phase = 'error';
      errorText = error.code === 'permission_required' ? 'Allow camera or audio access and try again.' : error.code === 'interaction_required' || error.code === 'preview_io_disabled' ? 'Allow audio playback and try again.' : step;
      render();
    }
  }

  const watchdog=setInterval(()=>{if(current?.tracker && Number.isFinite(lastResult) && performance.now()-lastResult>config.tracking.staleMs){rest();onHands({hands:{}});}},50);
  return {start,stop,play,close(){closed=true;clearInterval(watchdog);void stop();}};
}
