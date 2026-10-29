export const visiblePoint=(p,threshold=.6)=>Number.isFinite(p?.[0])&&Number.isFinite(p?.[1])&&p[3]>=threshold&&p[0]>.01&&p[0]<.99&&p[1]>.01&&p[1]<.99;
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
export class BodyInstrument {
  constructor(config){
    this.c=config;this.toneSensitivity=1;this.vocalId=0;this.lastSeen=-Infinity;this.seen=false;this.combo=false;this.fired=false;this.filtered=null;this.previousTime=0;this.overheadSince=null;this.neutralSince=null;
    this.focusTime=0;this.volumeHeights=[null,null];this.vocalTop=[false,false];this.active=[false,false];this.since=[null,null];this.armSeen=[-Infinity,-Infinity];this.baseSpan=null;this.trackingSpan=null;this.leanTime=0;this.toneSpan=null;this.toneSeen=-Infinity;this.toneCalibrated=false;this.toneYaw=0;this.baseYaw=0;
    this.state={mode:'FRAME',bass:0,synth:0,bassFocus:0,synthFocus:0,brightness:.5,vocalId:0,vocal:0,progress:0,bassPending:false,synthPending:false};
  }
  silence(mode){Object.assign(this.state,{mode,bass:0,synth:0,bassFocus:0,synthFocus:0,vocal:0,progress:0,bassPending:false,synthPending:false});this.active=[false,false];this.since=[null,null];}
  lose(mode='FRAME'){

    this.vocalTop=[false,false];this.armSeen=[-Infinity,-Infinity];this.filtered=null;this.overheadSince=null;this.neutralSince=null;this.combo=false;this.fired=false;
    if(mode==='FRAME'){this.volumeHeights=[null,null];if(!this.toneCalibrated){this.baseSpan=null;this.state.brightness=.5;}this.trackingSpan=null;this.toneSpan=null;this.toneSeen=-Infinity;}
    this.silence(mode);return this.snapshot();
  }
  canCalibrateTone(now){return this.toneSpan!==null&&now-this.toneSeen<=this.c.staleMs;}
  calibrateTone(now){
    if(!this.canCalibrateTone(now))return false;
    this.baseSpan=this.toneSpan;this.baseYaw=this.toneYaw;
    this.toneCalibrated=true;this.leanTime=now;this.state.brightness=.5;return true;
  }
  setToneSensitivity(value){if(Number.isFinite(value)&&value>0)this.toneSensitivity=value;}
  tone(span,now,yaw){
    this.toneSeen=now;this.toneSpan=span;this.toneYaw=yaw;
    // Head size tracks forward/back movement independently of raised arms.
    if(this.baseSpan===null){this.baseSpan=span;this.baseYaw=yaw;this.leanTime=now;this.state.brightness=.5;return;}
    if(Math.abs(yaw-this.baseYaw)>this.c.toneYawTolerance){this.leanTime=now;return;}
    const ratio=Math.log(span/this.baseSpan)*this.toneSensitivity,offset=Math.sign(ratio)*Math.max(0,Math.abs(ratio)-this.c.leanDeadzoneLog);
    const target=clamp(.5+offset/(2*this.c.leanRangeLog),0,1),dt=Math.max(0,now-this.leanTime);this.leanTime=now;
    this.state.brightness+=(target-this.state.brightness)*(1-Math.exp(-dt/this.c.leanSmoothingMs));
  }
  focus(points,observed,span,aspect,now){
    const c=this.c,head=[0,2,5,7,8].filter(i=>visiblePoint(points[i],c.visibility));
    const center=head.length?head.reduce((a,i)=>[a[0]+points[i][0]/head.length,a[1]+points[i][1]/head.length],[0,0]):null;
    const alpha=1-Math.exp(-Math.min(100,Math.max(0,now-this.focusTime))/c.focusSmoothingMs);this.focusTime=now;
    for(const [i,key]of ['bassFocus','synthFocus'].entries()){
      let target=0;
      if(center&&observed[i]&&this.active[i]){
        const p=points[15+i],distance=Math.hypot((p[0]-center[0])*aspect,p[1]-center[1])/span;
        target=clamp((c.focusFar-distance)/(c.focusFar-c.focusNear),0,1);
        target=target*target*(3-2*target);
      }
      this.state[key]+=(target-this.state[key])*alpha;
    }
  }
  update(points,now,aspect=1){
    const c=this.c,visible=i=>visiblePoint(points?.[i],c.visibility);
    if(now-this.lastSeen>c.staleMs&&this.filtered)this.lose();
    const shoulders=[11,12].map(visible);
    if(shoulders.every(Boolean)){
      const span=Math.max(.07,Math.hypot((points[11][0]-points[12][0])*aspect,points[11][1]-points[12][1]));
      this.trackingSpan=span;
    }
    // Arm raises change shoulder width, so tone uses only visible head points.
    // Hold on head turns/occlusion instead of treating a narrower face as depth.
    const ears=[7,8].map(i=>points?.[i]);
    if(visible(0)&&ears.every(p=>visiblePoint(p,c.visibility))){
      const dx=(ears[0][0]-ears[1][0])*aspect,dy=ears[0][1]-ears[1][1],headSpan=Math.hypot(dx,dy);
      const nx=(points[0][0]-(ears[0][0]+ears[1][0])/2)*aspect,ny=points[0][1]-(ears[0][1]+ears[1][1])/2;
      if(headSpan>0)this.tone(headSpan,now,(nx*dx+ny*dy)/(headSpan*headSpan));
      else{this.toneSpan=null;this.toneSeen=-Infinity;}
    }else{this.toneSpan=null;this.toneSeen=-Infinity;}
    // Once vocals are confirmed, moving closer can carry the wrists out of
    // the top of the image. Keep that pose while the head and shoulders remain
    // tracked; a visible lowered wrist, another edge, or body loss still exits.
    if(this.fired&&(!visible(15)||!visible(16))&&visible(11)&&visible(12)){
      const span=Math.max(.07,Math.hypot((points[11][0]-points[12][0])*aspect,points[11][1]-points[12][1]));
      const head=[0,2,5,7,8].filter(visible).map(i=>points[i][1]);
      const top=head.length?Math.max(...head)+span*c.headTopOffset:null;
      const held=top!==null&&[15,16].every((index,i)=>{
        const p=points[index];
        if(visible(index)){this.vocalTop[i]=p[1]>=c.vocalTopEdge;return p[1]>top;}
        if(Number.isFinite(p?.[0])&&(p[0]<=.01||p[0]>=.99))return false;
        if(Number.isFinite(p?.[1])&&p[1]<=.01)return false;
        if(Number.isFinite(p?.[1])&&p[1]>=.99)this.vocalTop[i]=true;
        return this.vocalTop[i];
      });
      if(held){
        this.lastSeen=now;
        this.silence('VOCAL');this.state.vocal=1;this.state.progress=1;
        return this.snapshot();
      }
    }
    const observed=[[11,15],[12,16]].map((pair,i)=>pair.every(index=>visiblePoint(points?.[index],this.active[i]?c.trackingVisibility:c.visibility)));
    observed.forEach((valid,i)=>{if(valid)this.armSeen[i]=now;});
    // Keep an already playing arm through brief confidence drops. Each arm has
    // its own deadline; fresh frames from the other side cannot keep it alive.
    const arms=observed.map((valid,i)=>valid||(this.active[i]&&now-this.armSeen[i]<=c.trackingGraceMs));
    if(!arms.some(Boolean)){if(shoulders.every(Boolean))this.lastSeen=now;return this.lose(shoulders.some(Boolean)?'HANDS':'FRAME');}
    const distance=(a,b)=>Math.hypot((points[a][0]-points[b][0])*aspect,points[a][1]-points[b][1]);
    let span=this.trackingSpan;
    if(shoulders.every(Boolean)){
      span=this.trackingSpan;
    }else if(span===null){
      // A visible upper arm supplies an initial scale when the opposite side is cropped.
      const estimates=[[11,13],[12,14]].filter(pair=>pair.every(visible)).map(([a,b])=>distance(a,b)*1.4);
      if(!estimates.length)for(let i=0;i<2;i++)if(arms[i])estimates.push(distance(11+i,15+i)*.7);
      span=Math.max(.07,estimates.reduce((a,b)=>a+b,0)/estimates.length);this.trackingSpan=span;
    }
    const both=observed.every(Boolean);
    for(let i=0;i<2;i++){
      if(!arms[i]){this.active[i]=false;this.since[i]=null;}
    }
    if(observed.some(Boolean))this.lastSeen=now;this.seen=true;
    const raw=arms.map((valid,i)=>!valid?null:observed[i]?(points[15+i][1]-points[11+i][1])/span:this.filtered[i]);
    const dt=this.filtered?Math.max(.001,(now-this.previousTime)/1000):0,previous=this.filtered||raw;
    this.filtered=raw.map((x,i)=>x===null?null:previous[i]===null?x:previous[i]+(x-previous[i])*(dt?1-Math.exp(-dt*1000/c.smoothingMs):1));this.previousTime=now;
    const speeds=this.filtered.map((v,i)=>v!==null&&previous[i]!==null&&dt?Math.abs(v-previous[i])/dt:Infinity);
    const head=[0,2,5,7,8].filter(visible).map(i=>points[i][1]);
    // Pose landmarks stop at the eyes/ears: estimate the crown above them in
    // shoulder-width units. Coordinates increase upwards in this tracker.
    const headTop=head.length?Math.max(...head)+span*c.headTopOffset:null;
    // Calibrate each arm's 100% level to the same point just below the
    // crown. Retain it when the face or opposite side is briefly hidden.
    if(headTop!==null){
      for(let i=0;i<2;i++)if(visible(11+i)){
        const full=(headTop-points[11+i][1])/span-c.fullVolumeBelowHead;
        if(full>c.raise){
          if(this.volumeHeights[i]===null)this.volumeHeights[i]=full;
          else this.volumeHeights[i]+=(full-this.volumeHeights[i])*(dt?1-Math.exp(-dt*1000/c.smoothingMs):1);
        }
      }
    }
    const overhead=both&&headTop!==null&&[15,16].every(i=>points[i][1]>headTop+span*(this.fired?0:c.overheadMargin));
    if(overhead){
      this.combo=true;this.overheadSince??=now;
      if(!this.fired&&now-this.overheadSince>=c.vocalHoldMs){this.fired=true;this.vocalId++;}
      if(this.fired||!this.active.some(Boolean)){
        this.silence(this.fired?'VOCAL':'VOCAL_HOLD');
        if(this.fired)this.vocalTop=[15,16].map(i=>points[i][1]>=c.vocalTopEdge);
        this.state.vocal=this.fired?1:0;
        this.state.progress=clamp((now-this.overheadSince)/c.vocalHoldMs,0,1);
        return this.snapshot();
      }
    }else{
      // Top-edge continuation is handled above; other exits clear the latch.
      this.combo=false;this.fired=false;this.vocalTop=[false,false];this.overheadSince=null;this.state.progress=0;
    }
    const movingTogether=both&&raw.every(h=>h>c.rest)&&Math.max(...speeds)>c.stableSpeed;
    for(let i=0;i<2;i++){
      if(!arms[i]){this.active[i]=false;this.since[i]=null;continue;}
      const raised=this.filtered[i]>(this.active[i]?c.release:c.raise);
      if(!raised){this.active[i]=false;this.since[i]=null;continue;}
      if(!this.active[i]){
        if(overhead){this.since[i]=null;continue;}
        if(this.since[i]===null||speeds[i]>c.stableSpeed||movingTogether)this.since[i]=now;
        if(now-this.since[i]>=c.singleHoldMs)this.active[i]=true;
      }
    }
    // Head-relative full volume leaves a plateau before the vocal gesture.
    const full=this.volumeHeights.map(h=>h??c.maxHeight);
    this.state.bass=this.active[0]?clamp(.15+.85*(this.filtered[0]-c.raise)/(full[0]-c.raise),.12,1):0;
    this.state.synth=this.active[1]?.15+.85*clamp((this.filtered[1]-c.raise)/(full[1]-c.raise),0,1):0;
    this.state.bassPending=!this.active[0]&&this.since[0]!==null;
    this.state.synthPending=!this.active[1]&&this.since[1]!==null;
    this.state.vocal=0;
    this.focus(points,observed,span,aspect,now);
    this.state.mode=this.active[0]&&this.active[1]?'MIX':this.active[0]?'BASS':this.active[1]?'SYNTH':this.state.bassPending&&this.state.synthPending?'MIX_HOLD':this.state.bassPending?'BASS_HOLD':this.state.synthPending?'SYNTH_HOLD':'IDLE';
    return this.snapshot();
  }
  tick(now){if(now-this.lastSeen>this.c.staleMs)return this.lose();return this.snapshot();}
  snapshot(){return {...this.state,vocalId:this.vocalId,toneSensitivity:this.toneSensitivity};}
}
