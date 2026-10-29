// Voicing analysis uses the existing delayed-original buffer's time budget.
// A 32 ms past window describes its centre, 16 ms before the current input.
// Its decision is available before that centre reaches the 48 ms output delay.
// No audio is queued here, and no words are gated off.
const SIZE = 256, ANALYSIS_RATE = 8000;
const clamp = value => Math.max(0, Math.min(1, value));
export class SpeechClarity {
  constructor(rate, channels, latency) {
    this.decimation = Math.round(rate / ANALYSIS_RATE);
    this.analysisDelay = Math.round(SIZE * this.decimation / 2);
    this.latency = latency;
    this.lowAlpha = 1 - Math.exp(-2 * Math.PI * 3000 / rate);
    this.dcAlpha = 1 - Math.exp(-2 * Math.PI * 70 / rate);
    this.smoothing = 1 - Math.exp(-1 / (rate * .002));
    this.channels = Array.from({length: channels}, () => ({low:0, low2:0, dc:0,
      clock:0, update:0, count:0, position:0, periodicity:0, blend:1,
      history:new Float64Array(SIZE), decisions:new Float32Array(latency).fill(1)}));
  }
  reset() {
    for (const c of this.channels) {
      for (const key of ['low','low2','dc','clock','update','count','position']) c[key]=0;
      c.periodicity=0; c.blend=1; c.history.fill(0); c.decisions.fill(1);
    }
  }
  analyze(c) {
    let best=0, energy=0;
    for (const value of c.history) energy+=value*value;
    if (energy < 1e-10) { c.periodicity=0; return; }
    // Normalized autocorrelation distinguishes periodic vowels from aperiodic
    // consonants. Include low voices and high voice/instrument test tones.
    for (let lag=8;lag<=114;lag++) {
      let cross=0, power=0;
      for (let i=lag;i<SIZE;i++) {
        const a=c.history[(c.position+i)%SIZE], b=c.history[(c.position+i-lag)%SIZE];
        cross+=a*b; power+=a*a+b*b;
      }
      if (power>1e-12) best=Math.max(best,2*cross/power);
    }
    c.periodicity=best;
  }
  push(channel, sample, position, robot=0) {
    const c=this.channels[channel];
    c.low+=this.lowAlpha*(sample-c.low); c.low2+=this.lowAlpha*(c.low-c.low2);
    c.dc+=this.dcAlpha*(c.low2-c.dc);
    if (++c.clock===this.decimation) {
      c.clock=0; c.history[c.position]=c.low2-c.dc; c.position=(c.position+1)%SIZE;
      ++c.count;
      if (++c.update===32) { c.update=0; if(c.count>=SIZE)this.analyze(c); }
    }
    const decision=c.decisions[position];
    // A robotic carrier must also dominate irregular/breathy voiced speech.
    // Reserve its original path for clearly aperiodic consonants.
    const unvoiced=1-clamp((c.periodicity-(.4-.2*robot))/(.35-.05*robot));
    c.decisions[(position+this.latency-this.analysisDelay)%this.latency]=unvoiced;
    c.blend+=this.smoothing*(decision-c.blend);
    return c.blend;
  }
}
