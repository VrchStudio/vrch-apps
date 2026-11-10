// engine.js: the audio thread. It runs signal.js at 48 kHz, sends x to the left speaker and y to the right, and posts
// the very same samples to the page, so the picture is drawn from what is heard.
//
// IN   {type: 'begin', s, p}   start sounding from signal state s with settings p (until then it stays silent)
//      {type: 'set', p}        new settings
// OUT  speaker samples, and {type: 'pcm', frame, samples} messages: BLOCK frames of interleaved left/right, where
//      "frame" counts samples since the audio clock started. Every few blocks also carry the signal state "s".
const BLOCK = 384, STATE_EVERY = 4;
class ScopeEngine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = XYSignal.settings(); this.s = null;
    this.xy = new Float32Array(256);
    this.block = new Float32Array(BLOCK * 2); this.fill = 0; this.start = 0; this.count = 0; this.snapshot = null;
    this.port.onmessage = ({data: m}) => {
      if (m.type === 'set') Object.assign(this.p, m.p);
      else if (m.type === 'begin') { Object.assign(this.p, m.p); this.s = XYSignal.copy(m.s); this.fill = 0; this.port.postMessage({type: 'began', frame: currentFrame}); }
    };
  }
  process(_, outputs) {
    const left = outputs[0][0], right = outputs[0][1] || left, n = left.length;
    if (!this.s) return true;
    if (this.xy.length < n * 2) this.xy = new Float32Array(n * 2);
    if (!this.fill && this.count % STATE_EVERY === 0) { const {amp, ...state} = this.s; this.snapshot = state; }
    XYSignal.render(this.s, this.p, this.xy, n);
    for (let i = 0; i < n; i++) {
      const l = this.xy[2 * i] * XYSignal.LEVEL, r = this.xy[2 * i + 1] * XYSignal.LEVEL;
      left[i] = l; right[i] = r;
      if (!this.fill) this.start = currentFrame + i;
      this.block[2 * this.fill] = l; this.block[2 * this.fill + 1] = r;
      if (++this.fill === BLOCK) {
        this.port.postMessage({type: 'pcm', frame: this.start, samples: this.block, s: this.snapshot}, [this.block.buffer]);
        this.block = new Float32Array(BLOCK * 2); this.fill = 0; this.count++; this.snapshot = null;
      }
    }
    return true;
  }
}
registerProcessor('scope-engine', ScopeEngine);
