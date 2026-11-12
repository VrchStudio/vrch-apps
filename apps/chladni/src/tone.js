// tone.js: the note the plate hums. It is made of plain sine waves: the note itself twice, a hair apart, so that it
// slowly beats like a bowed plate; three quieter overtones above it, taken from the plate in modes.js; and a breath
// of bow noise. A second note can sound with it, made the same way. Nothing here knows about sand: the App tells it
// the pitch, how hard the plate is driven and which overtones the plate has.
//
// new Tone({sdk, onChange})   onChange() is called whenever "audible" or "problem" may have changed
//   ready()     open the sound, silent, so that the note can start cleanly at once (a stream that has only just
//               opened runs dry for a moment now and then)
//   on()        open the sound if need be and fade the note in (about 30 ms)
//   off()       fade it out; the sound stays ready
//   set(note)   {hertz, second, drive (0 to 1), overtones: [[multiple, level], ...]}; the note slides there in about
//               30 ms. second: the pitch of a second note sounding with it, or 0 for none
//   close()     give the sound back
//   audible     true while the note can be heard
//   problem     null, 'menu' (sound has to be allowed in Menu) or 'failed'
(() => {
  'use strict';
  const RATE = 48000;
  const CEILING = 0.5;      // nothing louder than -6 dBFS leaves the App: the device's line out adds 6 dB
  const GLIDE = 0.01;       // every change approaches its goal with this time constant: there in about 30 ms
  const APART = 0.17;       // the two copies of the note are this many hertz above and below it
  const BOW = 0.1;          // bow noise at full drive, beside a note of 1 (before its narrow window, which lets little through)
  const WAVER = 0.035;      // the loudness wavers by this share, 5 times a second
  const stale = () => Object.assign(new Error('stale'), {code: 'stale'});

  window.Tone = class {
    constructor({sdk, onChange}) {
      this.sdk = sdk; this.onChange = onChange || (() => {});
      this.note = {hertz: 110, second: 0, drive: 0.6, overtones: [[2, 0.2], [3, 0.1], [5, 0.05]]};
      this.other = 165;   // where the second note last was: it fades in and out there
      this.wanted = false; this.voice = null; this.opening = null; this.epoch = 0; this.problem = null;
    }
    get audible() { return !!this.voice && this.wanted && this.voice.ctx.state === 'running'; }
    // How much of each of the two notes there is: one alone is whole, two together are a little less each.
    shares(note) { return note.second ? [0.62, 0.62] : [1, 0]; }
    // How loud it all may be so that its peaks stay under the ceiling whatever the waves do.
    level(note) {
      const shares = this.shares(note);
      const most = (shares[0] + shares[1]) * (1 + note.overtones.reduce((sum, pair) => sum + pair[1], 0) * (0.5 + 0.9 * note.drive)) + BOW * note.drive;
      // Low notes are heard less: they are played a little louder, high notes a little softer.
      const even = Math.max(0.75, Math.min(1.35, (165 / note.hertz) ** 0.3));
      return Math.min(0.27 * even * (0.55 + 0.45 * note.drive), 0.97 * CEILING / (most * (1 + WAVER)));
    }
    open() {
      if (this.voice) return Promise.resolve(this.voice);
      if (this.opening) return this.opening;
      const mine = ++this.epoch;
      this.opening = (async () => {
        let ctx = null, output = null;
        try {
          ctx = new AudioContext({sampleRate: RATE, latencyHint: 'interactive', sinkId: {type: 'none'}});
          void ctx.resume().catch(() => {});
          output = await this.sdk.audio.openOutput({channels: 2});
          const destination = await output.createNode(ctx);
          if (mine !== this.epoch) throw stale();
          const gain = value => { const node = ctx.createGain(); node.gain.value = value; return node; };
          const sine = () => { const node = ctx.createOscillator(); node.type = 'sine'; return node; };
          const merge = ctx.createChannelMerger(2), body = gain(0), master = gain(0), centre = gain(1);
          centre.connect(merge, 0, 0); centre.connect(merge, 0, 1);
          // One note: its two copies and its overtones, behind three taps (left, right, middle) that set how much of it there is.
          // Left and right each get more of one copy, so the slow beat moves between the ears.
          const voices = [0, 1].map(() => {
            const taps = [gain(0), gain(0), gain(0)], pair = [sine(), sine()];
            taps[0].connect(merge, 0, 0); taps[1].connect(merge, 0, 1); taps[2].connect(centre);
            pair.forEach((wave, side) => { const near = gain(0.62), far = gain(0.38); wave.connect(near).connect(taps[side]); wave.connect(far).connect(taps[1 - side]); });
            const over = this.note.overtones.map(() => { const wave = sine(), loud = gain(0); wave.connect(loud).connect(taps[2]); return {wave, loud}; });
            return {taps, pair, over};
          });
          // Bow noise: two seconds of hiss, the same every time, heard through a narrow window above the note.
          const hiss = ctx.createBuffer(1, RATE * 2, RATE), samples = hiss.getChannelData(0);
          let dice = 0x2545f491;
          for (let i = 0; i < samples.length; i++) { dice ^= dice << 13; dice ^= dice >>> 17; dice ^= dice << 5; samples[i] = (dice >>> 8) / 8388608 - 1; }
          const bow = ctx.createBufferSource(), band = ctx.createBiquadFilter(), breath = gain(0);
          bow.buffer = hiss; bow.loop = true; band.type = 'bandpass'; band.Q.value = 2.5;
          bow.connect(band).connect(breath).connect(centre);
          const waver = sine(), depth = gain(0);
          waver.frequency.value = 5; waver.connect(depth).connect(body.gain);
          // The last stage lets nothing past the ceiling, whatever came before.
          const guard = ctx.createWaveShaper(), curve = new Float32Array(1025);
          for (let i = 0; i < curve.length; i++) curve[i] = Math.max(-CEILING, Math.min(CEILING, i / 512 - 1));
          guard.curve = curve;
          merge.connect(body).connect(master).connect(guard).connect(destination);
          for (const wave of [...voices.flatMap(v => [...v.pair, ...v.over.map(o => o.wave)]), bow, waver]) wave.start();
          const voice = this.voice = {ctx, output, voices, band, breath, body, depth, master};
          output.onError(() => { if (this.voice === voice) { this.shut(); this.wanted = false; this.problem = 'failed'; this.onChange(); } });
          this.tune(0);
          return voice;
        } catch (error) {
          await Promise.allSettled([output?.close(), ctx?.close()]);
          throw error;
        } finally { if (mine === this.epoch) this.opening = null; }
      })();
      return this.opening;
    }
    // Everything moves towards the note: at once (glide 0, before anything is heard) or sliding.
    tune(glide = GLIDE) {
      const voice = this.voice, note = this.note;
      if (!voice) return;
      const at = voice.ctx.currentTime, to = (param, value) => { if (glide) param.setTargetAtTime(value, at, glide); else param.setValueAtTime(value, at); };
      const shares = this.shares(note);
      if (note.second) this.other = note.second;
      voice.voices.forEach((one, i) => {
        const hertz = i ? this.other : note.hertz;
        to(one.pair[0].frequency, hertz - APART); to(one.pair[1].frequency, hertz + APART);
        one.over.forEach((part, k) => {
          const [multiple, loud] = note.overtones[k] || [1, 0];
          // (An overtone the ear would find shrill is turned down.)
          to(part.wave.frequency, hertz * multiple); to(part.loud.gain, loud * (0.5 + 0.9 * note.drive) * Math.min(1, 1800 / (hertz * multiple)));
        });
        for (const tap of one.taps) to(tap.gain, shares[i]);
      });
      to(voice.band.frequency, Math.min(6000, note.hertz * 7)); to(voice.breath.gain, BOW * note.drive);
      const level = this.level(note);
      to(voice.body.gain, level); to(voice.depth.gain, level * WAVER);
    }
    set(note) {
      this.note = {hertz: note.hertz, second: note.second || 0, drive: note.drive, overtones: note.overtones.map(pair => pair.slice())};
      this.tune();
    }
    ready() { if (!this.voice && !this.opening) void this.open().catch(() => {}); }
    async on() {
      this.wanted = true; this.problem = null;
      try {
        const voice = await this.open();
        await voice.ctx.resume();   // where a browser wants a key or a tap first, this waits for it
        if (this.voice !== voice || !this.wanted) return;
        voice.master.gain.setTargetAtTime(1, voice.ctx.currentTime, GLIDE);
      } catch (error) {
        if (error?.code === 'stale') return;
        this.wanted = false;
        this.problem = ['capability_denied', 'io_not_authorized', 'permission_denied'].includes(error?.code || error?.name) ? 'menu' : 'failed';
      }
      this.onChange();
    }
    off() {
      this.wanted = false;
      if (this.voice) this.voice.master.gain.setTargetAtTime(0, this.voice.ctx.currentTime, GLIDE);
      this.onChange();
    }
    shut() {
      const old = this.voice;
      this.voice = null; this.epoch++; this.opening = null;
      if (old) void Promise.allSettled([old.output.close(), old.ctx.state === 'closed' ? null : old.ctx.close()]);
    }
    close() { this.wanted = false; this.shut(); }
  };
})();
