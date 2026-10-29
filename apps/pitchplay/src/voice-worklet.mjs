import {createVoiceEngine} from './pitch-core.mjs';

class PitchPlayProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = null;
    this.lastMeter = 0;
    this.pcm = options.processorOptions?.mode === 'pcm';
    this.input = [new Float32Array(960), new Float32Array(960)];
    this.output = [new Float32Array(960), new Float32Array(960)];
    this.port.onmessage = ({data}) => {
      if (data?.type === 'settings') this.engine?.set(data.value);
      if (this.engine && this.pcm && data?.type === 'pcm' && data.samples instanceof Float32Array && data.samples.length === 1920) {
        for (let i = 0; i < 960; i++) { this.input[0][i] = data.samples[i * 2]; this.input[1][i] = data.samples[i * 2 + 1]; }
        this.engine.process(this.input, this.output);
        const samples = new Float32Array(1920);
        for (let i = 0; i < 960; i++) { samples[i * 2] = this.output[0][i]; samples[i * 2 + 1] = this.output[1][i]; }
        this.port.postMessage({type: 'pcm', samples}, [samples.buffer]);
        this.meter();
      }
    };
    createVoiceEngine(sampleRate, 2).then(engine => {
      engine.warm(); this.engine = engine;
      this.port.postMessage({type: 'ready', latencyFrames: engine.latency});
    }).catch(() => this.port.postMessage({type: 'error', message: 'Voice engine unavailable.'}));
  }
  meter() {
    if (this.engine.frames - this.lastMeter >= sampleRate / 20) {
      this.lastMeter = this.engine.frames;
      this.port.postMessage({type: 'meter', input: this.engine.inputPeak, output: this.engine.outputPeak,
        frames: this.engine.frames, limited: this.engine.clipped,
        robotMode: this.engine.target.robot > 0 ? (this.engine.robotVoice.lowVoice ? 'lpc' : 'bands') : null,
        robotCarrierHz: this.engine.robotVoice.frequency});
      this.engine.inputPeak = 0; this.engine.outputPeak = 0;
    }
  }
  process(inputs, outputs) {
    if (this.engine && !this.pcm) { this.engine.process(inputs[0] || [], outputs[0]); this.meter(); }
    return true;
  }
}
registerProcessor('pitchplay-voice', PitchPlayProcessor);
