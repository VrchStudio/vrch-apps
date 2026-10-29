// Speech envelopes shape an independent harmonic carrier. RBJ constant-peak
// band-pass sections: https://www.w3.org/TR/audio-eq-cookbook/#formulae
// No look-ahead, block buffering, playback-rate change or free-running output.
const TAU = Math.PI * 2, TABLE = 4096, BANDS = 18;
import {LpcRobot} from './lpc-robot.mjs';
export class RobotVoice {
  constructor(rate, channels) {
    this.rate = rate; this.phase = 0;
    this.lpc = new LpcRobot(rate,channels);this.frequency=140;
    this.table = new Float64Array(TABLE + 1);
    for (let i = 0; i <= TABLE; i++) for (let h = 1; h <= 48; h++) this.table[i] += Math.sin(TAU * h * i / TABLE) / h ** .85;
    const peak = Math.max(...this.table.map(Math.abs));
    for (let i = 0; i <= TABLE; i++) this.table[i] /= peak;
    this.b = new Float64Array(BANDS); this.a1 = new Float64Array(BANDS); this.a2 = new Float64Array(BANDS);
    this.lowWeights = new Float64Array(BANDS);
    for (let i = 0; i < BANDS; i++) {
      const frequency = 100 * (7500 / 100) ** (i / (BANDS - 1)), omega = TAU * frequency / rate, alpha = Math.sin(omega) / (2 * 3.1);
      this.b[i] = alpha / (1 + alpha); this.a1[i] = -2 * Math.cos(omega) / (1 + alpha); this.a2[i] = (1 - alpha) / (1 + alpha);
      this.lowWeights[i] = frequency < 250 ? .4 : 1;
    }
    this.carrier1 = new Float64Array(BANDS); this.carrier2 = new Float64Array(BANDS);
    this.carrierEnvelope = new Float64Array(BANDS); this.carrier = new Float64Array(BANDS);
    this.channels = Array.from({length: channels}, () => ({z1:new Float64Array(BANDS),z2:new Float64Array(BANDS),envelope:new Float64Array(BANDS),level:0,low:0,bodyLow:0}));
    this.attack = 1 - Math.exp(-1 / (rate * .003)); this.release = 1 - Math.exp(-1 / (rate * .035));
    this.carrierSmooth = 1 - Math.exp(-1 / (rate * .02)); this.highAlpha = 1 - Math.exp(-TAU * 3200 / rate);
    this.bodyAlpha = 1 - Math.exp(-TAU * 250 / rate);
    this.pitchBuffer = new Float64Array(256); this.pitchScores = new Float64Array(38);
    this.pitchLowAlpha = 1 - Math.exp(-TAU * 800 / rate);
    this.adaptSmooth = 1 - Math.exp(-1 / (rate * .04));
    this.pitchPosition = this.pitchCount = this.pitchClock = this.decimate = this.pitchLow = this.lowVotes = this.highVotes = this.lowMix = 0;
    this.lowVoice = false;
  }
  reset() {
    this.phase = 0;
    this.lpc.reset();
    for (const a of [this.carrier1,this.carrier2,this.carrierEnvelope,this.carrier]) a.fill(0);
    for (const c of this.channels) {c.z1.fill(0);c.z2.fill(0);c.envelope.fill(0);c.level=c.low=c.bodyLow=0;}
    this.pitchBuffer.fill(0); this.pitchScores.fill(0);
    this.pitchPosition = this.pitchCount = this.pitchClock = this.decimate = this.pitchLow = this.lowVotes = this.highVotes = this.lowMix = 0;
    this.lowVoice = false;
  }
  track(source) {
    this.pitchLow += this.pitchLowAlpha * (source-this.pitchLow);
    if (++this.decimate < 16) return;
    this.decimate = 0; this.pitchBuffer[this.pitchPosition] = this.pitchLow;
    this.pitchPosition = (this.pitchPosition+1)%256; ++this.pitchCount;
    if (++this.pitchClock < 60 || this.pitchCount < 256) return;
    this.pitchClock = 0;
    let voicedEnergy = 0; for (const value of this.pitchBuffer) voicedEnergy += value*value;
    if (voicedEnergy < 256*.000004) {this.lowVotes=this.highVotes=0;return;}
    let maximum = 0;
    for (let lag = 8; lag <= 45; lag++) {
      let cross = 0, energy = 0;
      for (let i = lag; i < 256; i++) {const a=this.pitchBuffer[(this.pitchPosition+i)%256],b=this.pitchBuffer[(this.pitchPosition+i-lag)%256];cross+=a*b;energy+=a*a+b*b;}
      const score = energy > 1e-8 ? 2*cross/energy : 0;
      this.pitchScores[lag-8] = score; maximum = Math.max(maximum,score);
    }
    for (let i = 1; i < this.pitchScores.length-1; i++) {
      const score = this.pitchScores[i];
      if (score < .75 || score < maximum*.8 || score < this.pitchScores[i-1] || score <= this.pitchScores[i+1]) continue;
      const frequency = this.rate/16/(i+8);
      if (frequency < 125) {++this.lowVotes;this.highVotes=0;}
      else if (frequency > 160) {++this.highVotes;this.lowVotes=0;}
      else this.lowVotes=this.highVotes=0;
      if (this.lowVotes >= 3) this.lowVoice = true;
      if (this.highVotes >= 3) this.lowVoice = false;
      return;
    }
  }
  tick(frequency) {
    // Low fundamentals need denser carrier harmonics to carry the vowels.
    // Hysteresis holds a robotic pitch through syllables rather than following
    // each intonation. Higher voices retain the accepted 140 Hz carrier path.
    this.lowMix += this.adaptSmooth * ((this.lowVoice?1:0)-this.lowMix);
    frequency *= 1 - .32*this.lowMix;
    this.frequency=frequency;
    this.phase = (this.phase + frequency * TABLE / this.rate) % TABLE;
    const first = Math.floor(this.phase), fraction = this.phase - first, source = this.table[first] * (1-fraction) + this.table[first+1] * fraction;
    for (let i = 0; i < BANDS; i++) {
      const value = this.b[i] * source + this.carrier1[i];
      this.carrier1[i] = -this.a1[i] * value + this.carrier2[i];
      this.carrier2[i] = -this.b[i] * source - this.a2[i] * value;
      this.carrierEnvelope[i] += this.carrierSmooth * (Math.abs(value) - this.carrierEnvelope[i]);
      this.carrier[i] = value / (this.carrierEnvelope[i] + .012);
    }
  }
  process(channel, source) {
    if (channel === 0) this.track(source);
    const c = this.channels[channel], amplitude = Math.abs(source);
    c.level += (amplitude > c.level ? this.attack : this.release) * (amplitude-c.level);
    let output = 0;
    for (let i = 0; i < BANDS; i++) {
      const value = this.b[i] * source + c.z1[i];
      c.z1[i] = -this.a1[i] * value + c.z2[i]; c.z2[i] = -this.b[i] * source - this.a2[i] * value;
      const energy = Math.abs(value);
      c.envelope[i] += (energy > c.envelope[i] ? this.attack : this.release) * (energy-c.envelope[i]);
      output += c.envelope[i] * this.carrier[i] * (1+(this.lowWeights[i]-1)*this.lowMix);
    }
    c.low += this.highAlpha * (source-c.low);
    c.bodyLow += this.bodyAlpha * (source-c.bodyLow);
    // A little unpitched high-frequency articulation keeps s/t/f consonants;
    // the voiced spectrum is rebuilt on the carrier's harmonic grid.
    const lpc=this.lpc.process(channel,source,this.frequency);
    const normal=output*.24+(source-c.low)*.22;
    const low=lpc*.9+(source-c.low)*.28;
    return c.level < .00004 ? 0 : normal+(low-normal)*this.lowMix;
  }
}
