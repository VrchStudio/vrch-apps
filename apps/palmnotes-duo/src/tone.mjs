// Pure sample engine. Playback ACKs provide its clock; the App checks wall time.
export class Tone {
  constructor(rate, sound, voices = []) {
    this.rate = rate; this.sound = sound; this.phase = 0; this.envelope = 0;
    this.frequency = 0; this.target = 0; this.remaining = 0; this.level = 0.7; this.attacks = 0;
    this.voices = voices.length ? voices : [{id: 'soft', ...sound, partials: [[1,1],[2,0.22],[3,0.08]], decayMs: 400, sustain: 1}];
    this.voice = this.voices[0]; this.age = 0; this.octave = 0;
    const size = Math.max(...this.voices.flatMap(v => v.partials.map(p => p[0])));
    this.weights = new Float64Array(size); this.targetWeights = new Float64Array(size);
    this.smoothing = 1 - Math.exp(-1 / (this.rate * 0.008));
    this.select(this.voice);
  }
  select(voice, octave = 0) {
    this.voice = voice; this.octave = octave; this.targetWeights.fill(0);
    const balance=this.sound.registerBalance;
    const gain=balance ? octave<0 ? balance.lowGain : octave>0 ? balance.highGain : balance.middleGain : 1;
    for (const [harmonic, amplitude] of voice.partials) this.targetWeights[harmonic - 1] = amplitude * voice.gain * gain;
    if (balance && octave<0) for(const [harmonic,amplitude] of balance.lowPartials) this.targetWeights[harmonic-1] += amplitude * voice.gain * gain;
  }
  set({frequency = 0, leaseMs = 0, level = this.level, voice = this.voice.id, octave = this.octave}) {
    if (frequency > 0 && this.target === 0) this.attacks++;
    if (frequency > 0 && frequency !== this.target) this.age = 0;
    const selected = this.voices.find(v => v.id === voice) || this.voices[0];
    if (selected !== this.voice) this.age = 0;
    if (selected !== this.voice || octave !== this.octave) this.select(selected, octave);
    this.target = Math.max(0, frequency); this.remaining = Math.max(0, leaseMs * this.rate / 1000);
    this.level = Math.max(0, Math.min(1, level));
    if (!this.frequency) this.frequency = this.target;
  }
  render(output) {
    for (let i = 0; i < output.length; i++) {
      if (--this.remaining <= 0) this.target = 0;
      const on = this.target > 0;
      const step = 1 / (this.rate * (on ? this.voice.attackMs : this.voice.releaseMs) / 1000);
      this.envelope = on ? Math.min(1, this.envelope + step) : Math.max(0, this.envelope - step);
      if (on) this.frequency += (this.target - this.frequency) * (1 - Math.exp(-1 / (this.rate * 0.008)));
      this.phase = (this.phase + this.frequency / this.rate) % 1;
      const p = this.phase * 2 * Math.PI;
      const decay = this.voice.sustain + (1 - this.voice.sustain) * Math.exp(-this.age / (this.rate * this.voice.decayMs / 1000));
      let value = 0;
      for (let harmonic = 0; harmonic < this.weights.length; harmonic++) {
        // Smooth actual coefficients, so even rapid preset/volume changes
        // continue from the current sound rather than restarting a crossfade.
        const partialDecay = this.voice.harmonicDecay ? Math.exp(-this.age * harmonic * this.voice.harmonicDecay / (this.rate * this.voice.decayMs / 1000)) : 1;
        this.weights[harmonic] += (this.targetWeights[harmonic] * decay * partialDecay * this.level - this.weights[harmonic]) * this.smoothing;
        value += Math.sin(p * (harmonic + 1)) * this.weights[harmonic];
      }
      output[i] = value * this.envelope;
      this.age++;
    }
  }
}
