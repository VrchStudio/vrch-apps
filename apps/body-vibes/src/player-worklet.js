class BodyStems extends AudioWorkletProcessor {
  constructor(options){
    super();this.c=options.processorOptions.sound;this.startSeconds=options.processorOptions.startSeconds||0;
    this.tracks=[null,null,null];this.length=0;this.position=0;this.loaded=0;this.gains=new Float64Array(3);this.targets=new Float64Array(3);this.levels=new Float64Array(3);this.filters=new Float64Array(12);this.brightness=.5;this.cutoff=3262.5;this.lease=0;this.counter=0;
    this.focus=new Float64Array(2);this.focusTargets=new Float64Array(2);
    this.focusAlpha=1-Math.exp(-1/(sampleRate*this.c.focusSeconds));
    this.room=[.0297,.0371,.0411,.0437].map(t=>new Float64Array(Math.round(t*sampleRate)));
    this.roomIndices=[0,0,0,0];this.roomDamped=new Float64Array(4);this.roomRead=new Float64Array(4);this.wetLevel=0;
    this.envelopes=new Float64Array(3);this.volumes=new Float64Array(3);
    this.fadeInStep=1/(sampleRate*this.c.fadeInSeconds);this.fadeOutStep=1/(sampleRate*this.c.fadeOutSeconds);
    this.attack=1-Math.exp(-1/(sampleRate*this.c.attackSeconds));this.release=1-Math.exp(-1/(sampleRate*this.c.releaseSeconds));
    this.port.onmessage=({data})=>{
      if(data.type==='track'){
        const channels=data.channels;
        if(!Number.isInteger(data.index)||data.index<0||data.index>2||this.tracks[data.index]||channels.length!==2||!channels[0].length||channels[0].length!==channels[1].length||data.sampleRate!==sampleRate||(this.length&&channels[0].length!==this.length)){
          this.port.postMessage({error:'Track alignment failed'});return;
        }
        this.tracks[data.index]=channels;this.length=channels[0].length;this.loaded++;
        if(this.loaded===3){this.start=Math.min(this.length-1,Math.round(this.startSeconds*sampleRate));this.position=this.start;this.port.postMessage({ready:true,duration:this.length/sampleRate});}
      }
      if(data.type==='voices'){
        for(const [i,key]of ['bass','synth','vocal'].entries())this.targets[i]=Math.max(0,Math.min(1,data[key]||0));
        for(const [i,key]of ['bassFocus','synthFocus'].entries())this.focusTargets[i]=Number.isFinite(data[key])?Math.max(0,Math.min(1,data[key])):0;
        this.brightness=Number.isFinite(data.brightness)?Math.max(0,Math.min(1,data.brightness)):.5;this.lease=currentTime+Math.max(0,Math.min(this.c.leaseSeconds,(data.leaseMs||0)/1000));
      }
      if(data.type==='stop')this.lease=0;
    };
  }
  process(inputs,outputs){
    const out=outputs[0];if(this.loaded!==3)return true;
    const valid=currentTime<this.lease;let running=false;
    this.wetLevel=0;
    for(let j=0;j<3;j++){this.levels[j]=0;if((valid&&this.targets[j]>0)||this.envelopes[j]>0)running=true;}
    this.cutoff+=(350+this.brightness*this.brightness*11650-this.cutoff)*.1;const coefficient=1-Math.exp(-Math.PI*2*this.cutoff/sampleRate);
    for(let i=0;i<out[0].length;i++){
      // A separate entry/exit envelope makes transitions audible without
      // making hand-height volume adjustment sluggish. Reversals continue
      // from the current envelope; repeated pose messages never restart it.
      for(let j=0;j<3;j++){
        const target=valid?this.targets[j]:0;
        if(target>0){
          if(this.envelopes[j]===0)this.volumes[j]=target;
          else this.volumes[j]+=(target-this.volumes[j])*(target>this.volumes[j]?this.attack:this.release);
          this.envelopes[j]=Math.min(1,this.envelopes[j]+this.fadeInStep);
        }else this.envelopes[j]=Math.max(0,this.envelopes[j]-this.fadeOutStep);
        const e=this.envelopes[j];this.gains[j]=this.volumes[j]*e*e*(3-2*e);
      }
      for(let j=0;j<2;j++)this.focus[j]+=((valid?this.focusTargets[j]:0)-this.focus[j])*this.focusAlpha;
      let sendLeft=0,sendRight=0,dryLeft=0,dryRight=0;
      const edge=Math.min(1,(this.position-this.start+1)/(sampleRate*.01),(this.length-this.position)/(sampleRate*.01));
      for(let ch=0;ch<out.length;ch++){
        let mix=0;
        for(let j=0;j<3;j++){
          let value=running?this.tracks[j][ch][this.position]:0;
          const f=j*4+ch*2;this.filters[f]+=(value-this.filters[f])*coefficient;this.filters[f+1]+=(this.filters[f]-this.filters[f+1])*coefficient;value=this.filters[f+1];
          value*=this.gains[j];
          const focus=j<2?this.focus[j]:0,wet=value*focus*this.c.reverbSend;
          if(ch===0)sendLeft+=wet;else sendRight+=wet;
          value*=1+focus*this.c.focusBoost;this.levels[j]+=value*value;mix+=value;
        }
        if(ch===0)dryLeft=mix*edge;else dryRight=mix*edge;
      }
      // Four unequal delays with an orthogonal feedback matrix form a diffuse
      // stereo room. Damping removes highs on each return; no audio allocations.
      const r=this.roomRead,d=this.roomDamped;
      for(let j=0;j<4;j++){r[j]=this.room[j][this.roomIndices[j]];d[j]+=(r[j]-d[j])*this.c.reverbDamping;}
      const feedback=this.c.reverbFeedback*.5;
      this.room[0][this.roomIndices[0]]=sendLeft*edge*.5+(d[0]+d[1]+d[2]+d[3])*feedback;
      this.room[1][this.roomIndices[1]]=sendRight*edge*.5+(d[0]-d[1]+d[2]-d[3])*feedback;
      this.room[2][this.roomIndices[2]]=sendLeft*edge*.5+(d[0]+d[1]-d[2]-d[3])*feedback;
      this.room[3][this.roomIndices[3]]=sendRight*edge*.5+(d[0]-d[1]-d[2]+d[3])*feedback;
      for(let j=0;j<4;j++)this.roomIndices[j]=(this.roomIndices[j]+1)%this.room[j].length;
      const wetLeft=(r[0]+r[1])*.5,wetRight=(r[2]+r[3])*.5;
      this.wetLevel+=wetLeft*wetLeft+wetRight*wetRight;
      for(let ch=0;ch<out.length;ch++){
        const value=((ch===0?dryLeft:dryRight)+(ch===0?wetLeft:wetRight))*this.c.masterGain;
        // Leave normal dry levels untouched; round off only added effect peaks.
        const magnitude=Math.abs(value);out[ch][i]=magnitude<=.95?value:Math.sign(value)*(.95+.05*Math.tanh((magnitude-.95)/.05));
      }
      if(running){this.position++;if(this.position>=this.length){this.position=this.start;this.filters.fill(0);}}
    }
    if(++this.counter>=18){this.counter=0;this.port.postMessage({bassFocus:this.focus[0],synthFocus:this.focus[1],reverbLevel:Math.sqrt(this.wetLevel/(out[0].length*2)),bass:this.gains[0],synth:this.gains[1],vocal:this.gains[2],levels:Array.from(this.levels,(v,i)=>Math.min(1,Math.sqrt(v/(out[0].length*2))/this.c.levelReferences[i])),brightness:this.brightness,cutoff:this.cutoff,position:this.position/sampleRate,duration:this.length/sampleRate,playing:running});}
    return true;
  }
}
registerProcessor('body-stems',BodyStems);
