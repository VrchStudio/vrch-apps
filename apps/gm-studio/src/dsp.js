'use strict';
/* GM Studio audio engine: sample playback + step sequencer.

   The sequencer lives in the audio thread so notes land on exact sample
   positions. The page owns the song (tracks, notes, tempo) and pushes it here;
   this processor walks the transport tick by tick and fires voices. */

const SR = sampleRate;
const MAX_VOICES = 64;
const PPQ = 24;            // ticks per quarter note

class Voice {
  constructor() {
    this.active = false;
    this.layer = null;
    this.pos = 0;
    this.step = 1;
    this.env = 0;
    this.stage = 0;
    this.t = 0;
    this.released = false;
    this.gainL = 1;
    this.gainR = 1;
    this.age = 0;
    this.track = -1;
    this.noteKey = -1;
  }
}

class GmStudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pcm = null;
    this.voices = [];
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());

    /* song */
    this.tracks = [];        // { layers, mute, vol, notes: [{t,d,m,v}] }
    this.bpm = 120;
    this.bars = 8;
    this.tick = 0;           // transport position in ticks
    this.playing = false;
    this.loop = true;
    this.sounding = new Map(); // "track:note" -> [voices]

    this.vol = 0.8;
    this.volT = 0.8;
    this.age = 0;
    this.meter = 0;
    this.mN = 0;
    this.a = 1 - Math.exp(-1 / (SR * 0.02));
    this.port.onmessage = ({ data }) => this.onMessage(data);
  }

  get loopEnd() { return this.bars * 4 * PPQ; }

  onMessage(d) {
    if (!d) return;
    if (d.type === 'bank') {
      this.pcm = new Float32Array(d.pcm);
    } else if (d.type === 'song') {
      this.tracks = d.tracks || [];
      if (Number.isFinite(d.bpm)) this.bpm = d.bpm;
      if (Number.isFinite(d.bars)) this.bars = d.bars;
      if (typeof d.loop === 'boolean') this.loop = d.loop;
    } else if (d.type === 'transport') {
      if (typeof d.playing === 'boolean') {
        if (d.playing && !this.playing) { /* keep position */ }
        if (!d.playing && this.playing) this.allOff();
        this.playing = d.playing;
      }
      if (Number.isFinite(d.tick)) this.tick = d.tick;
    } else if (d.type === 'params') {
      if (Number.isFinite(d.vol)) this.volT = Math.max(0, Math.min(1.2, d.vol));
    } else if (d.type === 'note') {          // preview / live play
      const tr = this.tracks[d.track || 0];
      if (!tr) return;
      if (d.on) this.voice(tr, d.midi, d.vel | 0, -1, -1);
    } else if (d.type === 'allOff') {
      this.allOff();
    }
  }

  /* ---- voice handling ------------------------------------------------ */
  freeVoice() {
    let oldest = null;
    for (const v of this.voices) {
      if (!v.active) return v;
      if (!oldest || v.age < oldest.age) oldest = v;
    }
    return oldest;
  }

  voice(track, midi, vel, noteKey, trackIndex) {
    if (!this.pcm || !track.layers || !track.layers.length) return;
    const v127 = Math.max(1, Math.min(127, vel | 0));
    const velGain = Math.pow(v127 / 127, 1.2) * (track.vol === undefined ? 1 : track.vol);
    const out = [];
    for (const layer of track.layers) {
      if (midi < layer.keyLo || midi > layer.keyHi) continue;
      if (v127 < layer.velLo || v127 > layer.velHi) continue;
      const v = this.freeVoice();
      v.active = true;
      v.layer = layer;
      v.pos = layer.sample;
      v.env = 0;
      v.stage = 0;
      v.t = 0;
      v.released = false;
      v.age = ++this.age;
      v.track = trackIndex;
      v.noteKey = noteKey;
      const semis = (midi - layer.root) * (layer.scale / 100) + layer.coarse + layer.fine / 100;
      v.step = Math.pow(2, semis / 12) * (layer.rate / SR);
      const g = layer.gain * velGain;
      const pan = layer.pan * 0.5 + 0.5;
      v.gainL = g * Math.cos(pan * Math.PI / 2);
      v.gainR = g * Math.sin(pan * Math.PI / 2);
      out.push(v);
    }
    if (noteKey >= 0 && out.length) this.sounding.set(noteKey, out);
  }

  release(key) {
    const list = this.sounding.get(key);
    if (!list) return;
    this.sounding.delete(key);
    for (const v of list) {
      if (!v.active) continue;
      v.released = true;
      v.stage = 5;
      v.t = 0;
    }
  }

  allOff() {
    this.sounding.clear();
    for (const v of this.voices) {
      if (!v.active) continue;
      v.released = true;
      v.stage = 5;
      v.t = 0;
    }
  }

  /* ---- sequencer ----------------------------------------------------- */
  fireRange(a, b) {
    const trs = this.tracks;
    for (let ti = 0; ti < trs.length; ti++) {
      const tr = trs[ti];
      if (!tr || tr.mute || !tr.notes) continue;
      const notes = tr.notes;
      for (let ni = 0; ni < notes.length; ni++) {
        const n = notes[ni];
        const key = ti * 100000 + ni;
        if (n.t >= a && n.t < b) this.voice(tr, n.m, n.v || 100, key, ti);
        const end = n.t + (n.d || 6);
        if (end >= a && end < b) this.release(key);
      }
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || L;
    const n = L.length;

    if (this.playing && this.tracks.length) {
      const ticksPerSample = (this.bpm * PPQ) / (60 * SR);
      let a = this.tick;
      let b = a + n * ticksPerSample;
      const end = this.loopEnd;
      if (this.loop && b >= end) {
        this.fireRange(a, end);
        this.allOff();
        a = 0;
        b -= end;
        this.tick = 0;
      }
      this.fireRange(a, b);
      if (!this.loop && b >= end) {
        this.playing = false;
        this.tick = end;
      } else {
        this.tick = b;
      }
    }

    for (let i = 0; i < n; i++) {
      this.vol += (this.volT - this.vol) * this.a;
      let l = 0;
      let r = 0;
      for (const v of this.voices) {
        if (!v.active) continue;
        const ly = v.layer;
        const env = ly.env;

        if (v.stage === 0) {
          v.t += 1 / SR;
          if (v.t >= env.delay) { v.stage = 1; v.t = 0; }
        } else if (v.stage === 1) {
          v.t += 1 / SR;
          v.env = Math.min(1, v.t / env.attack);
          if (v.t >= env.attack) { v.stage = 2; v.t = 0; }
        } else if (v.stage === 2) {
          v.t += 1 / SR;
          if (v.t >= env.hold) { v.stage = 3; v.t = 0; }
        } else if (v.stage === 3) {
          v.t += 1 / SR;
          const k = Math.min(1, v.t / env.decay);
          v.env = 1 - (1 - env.sustain) * k;
          if (k >= 1) { v.stage = 4; v.t = 0; }
        } else if (v.stage === 4) {
          v.env = env.sustain;
        } else {
          v.t += 1 / SR;
          const k = v.t / env.release;
          v.env = env.sustain * Math.max(0, 1 - k);
          if (k >= 1) { v.active = false; continue; }
        }

        const p = v.pos;
        const i0 = p | 0;
        const f = p - i0;
        const sa = this.pcm[i0] || 0;
        const sb = this.pcm[i0 + 1] || 0;
        const s = sa + (sb - sa) * f;
        const g = v.env * s;
        l += g * v.gainL;
        r += g * v.gainR;

        v.pos += v.step;
        if (ly.loop) {
          if (v.pos >= ly.loopEnd) v.pos -= (ly.loopEnd - ly.loopStart);
          else if (v.pos < ly.loopStart) v.pos = ly.loopStart;
        } else if (v.pos >= ly.sampleEnd) {
          v.active = false;
        }
      }
      l *= this.vol;
      r *= this.vol;
      L[i] = Math.tanh(l);
      if (R !== L) R[i] = Math.tanh(r);
      const m = Math.abs(l) + Math.abs(r);
      if (m > this.meter) this.meter = m;
    }

    this.mN += n;
    if (this.mN >= 2048) {
      let active = 0;
      for (const v of this.voices) if (v.active) active++;
      this.port.postMessage({
        type: 'meter',
        level: Math.round(this.meter * 100) / 100,
        voices: active,
        tick: this.playing ? this.tick : -1
      });
      this.mN = 0;
      this.meter = 0;
    }
    return true;
  }
}

registerProcessor('gm-studio', GmStudio);
