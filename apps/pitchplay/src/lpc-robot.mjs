// Low-voice LPC synthesis. Analysis uses past samples only; the 12 kHz lattice
// has no frame queue. Bounded, interpolated reflection coefficients keep its
// time-varying all-pole filter stable while the excitation stays electronic.
const ORDER=20,SIZE=240;
export class LpcRobot {
  constructor(rate,channels){
    this.rate=rate/4;this.lowAlpha=1-Math.exp(-2*Math.PI*4200/rate);
    this.smooth=1-Math.exp(-1/(this.rate*.008));
    this.channels=Array.from({length:channels},()=>({low1:0,low2:0,previous:0,clock:0,position:0,count:0,update:0,phase:0,gain:0,targetGain:0,deemphasis:0,older:0,newer:0,buffer:new Float64Array(SIZE),correlation:new Float64Array(ORDER+1),a:new Float64Array(ORDER+1),scratch:new Float64Array(ORDER+1),target:new Float64Array(ORDER+1),k:new Float64Array(ORDER+1),backward:new Float64Array(ORDER+1)}));
  }
  reset(){for(const c of this.channels){for(const value of Object.values(c))if(value instanceof Float64Array)value.fill(0);for(const key of ['low1','low2','previous','clock','position','count','update','phase','gain','targetGain','deemphasis','older','newer'])c[key]=0;}}
  analyze(c){
    const r=c.correlation,a=c.a,scratch=c.scratch;r.fill(0);a.fill(0);a[0]=1;
    for(let lag=0;lag<=ORDER;lag++)for(let i=lag;i<SIZE;i++)r[lag]+=c.buffer[(c.position+i)%SIZE]*c.buffer[(c.position+i-lag)%SIZE];
    // A small noise floor and bandwidth expansion avoid narrow formant ringing.
    r[0]*=1.002;let error=r[0];
    if(error<1e-10){c.target.fill(0);c.targetGain=0;return;}
    for(let order=1;order<=ORDER;order++){
      let value=r[order];for(let i=1;i<order;i++)value+=a[i]*r[order-i];
      const k=Math.max(-.97,Math.min(.97,-value/error));c.target[order]=k*.995;
      scratch.set(a);for(let i=1;i<order;i++)a[i]=scratch[i]+k*scratch[order-i];a[order]=k;
      error*=1-k*k;if(error<r[0]*1e-8)error=r[0]*1e-8;
    }
    c.targetGain=Math.sqrt(error/SIZE);
  }
  process(channel,source,frequency){
    const c=this.channels[channel];c.low1+=this.lowAlpha*(source-c.low1);c.low2+=this.lowAlpha*(c.low1-c.low2);
    if(++c.clock===4){
      c.clock=0;const sample=c.low2-.92*c.previous;c.previous=c.low2;
      c.buffer[c.position]=sample;c.position=(c.position+1)%SIZE;++c.count;
      if(++c.update>=120&&c.count>=SIZE){c.update=0;this.analyze(c);}
      c.gain+=this.smooth*(c.targetGain-c.gain);
      c.phase+=frequency/this.rate;let excitation=0;
      if(c.phase>=1){c.phase-=Math.floor(c.phase);excitation=c.gain*Math.sqrt(this.rate/frequency);}
      let value=excitation;
      for(let i=ORDER;i>=1;i--){c.k[i]+=this.smooth*(c.target[i]-c.k[i]);const previous=c.backward[i-1];value-=c.k[i]*previous;c.backward[i]=previous+c.k[i]*value;}
      c.backward[0]=value;c.deemphasis=value+.92*c.deemphasis;
      c.older=c.newer;c.newer=c.deemphasis;
    }
    return c.older+(c.newer-c.older)*c.clock/4;
  }
}
