/* Musical time lives on the audio rendering thread, independent of UI work. */
class MetronomeClock extends AudioWorkletProcessor {
  constructor() {
    super(); this.config={bpm:120,beats:4,division:1,sound:0}; this.running=false;
    this.phase=0; this.beat=0; this.next=1; this.age=1e6; this.accent=false; this.main=true;
    this.port.onmessage=({data:m})=>{
      if(m.type==='config') {this.config=m.value;this.beat%=this.config.beats;this.next=Math.floor(this.phase*this.config.division)+1;}
      if(m.type==='start'||m.type==='reset') {this.phase=0;this.beat=0;this.next=1;if(m.type==='start')this.running=true;this.pending=this.running;}
      if(m.type==='stop') {this.running=false;this.age=1e6;}
    };
  }
  tick(main, frame) {
    this.age=0;this.main=main;this.accent=main&&this.beat===0;
    this.port.postMessage({beat:this.beat,main,frame,time:frame/sampleRate});
  }
  process(inputs,outputs) {
    const out=outputs[0][0],c=this.config,step=c.bpm/(60*sampleRate);
    for(let i=0;i<out.length;i++) {
      if(!this.running){out[i]=0;continue;}
      if(this.pending){this.pending=false;this.tick(true,currentFrame+i);}
      const t=this.age/sampleRate;
      if(t<.045){
        const f=(c.sound===0?1800:c.sound===1?650:1000)*(this.accent?1.5:1);
        const envelope=Math.min(1,t/.0008)*Math.exp(-t*(c.sound===2?110:190));
        const tone=Math.sin(2*Math.PI*f*t)+(c.sound===1?.35*Math.sin(2*Math.PI*f*2.71*t):0);
        out[i]=tone*envelope*(this.accent?.7:this.main?.46:.22);
      }else out[i]=0;
      this.age++; this.phase+=step;
      if(this.phase>=1-1e-10){this.phase-=1;this.beat=(this.beat+1)%c.beats;this.next=1;this.pending=true;}
      else if(this.phase>=this.next/c.division-1e-10){this.next++;this.tick(false,currentFrame+i+1);}
    }
    return true;
  }
}
registerProcessor('metronome-clock',MetronomeClock);
