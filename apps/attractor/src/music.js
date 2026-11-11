// music.js: the App's sound, and what the figure follows in it.
//
// Three sources. Music: the App's own pieces, one after another. Input: the host's audio input (microphone or line
// in), heard but never played back or kept. Silent: nothing, and the figure is left alone.
//
// The figure follows the music from the first frame. Each piece comes with its loudness worked out ahead of time
// (tracks.js), and a clock runs through it until sound is allowed to play, which a browser grants only after a touch
// or a key; from then the piece is heard from where the clock was. Muted, it plays on at no level, so the figure
// keeps time and the sound returns in step.
(() => {
  'use strict';
  const BLOCK_S = 0.02;          // the loudness is known for every 20 ms
  const HOST_LATENCY_S = 0.03;   // the host plays this much after the App
  const RETRY_MS = 3000;         // sound that could not start is tried again no sooner than this
  const FADE_S = 0.6, START_FADE_S = 0.5, STOP_FADE_S = 0.4;   // sound never starts or stops abruptly
  const stale = () => Object.assign(Error('stale'), {code: 'stale'});
  const unpack = text => Uint8Array.from(atob(text), ch => ch.charCodeAt(0));

  class Player {
    // tracks: tracks.js. onLevels([low, middle, high]): 20 ms of sound, as loudness in three bands.
    // onSection(): the piece has moved on to its next section. onChange(): something to show has changed.
    constructor({sdk, tracks, onLevels, onSection = () => {}, onChange = () => {}}) {
      this.sdk = sdk; this.tracks = tracks.map(track => ({...track, levels: unpack(track.levels)}));
      this.onLevels = onLevels; this.onSection = onSection; this.onChange = onChange;
      this.source = 'silent'; this.index = 0; this.muted = false; this.hidden = false;
      this.anchor = {offset: 0, at: performance.now()};   // the silent clock: this far into the piece at this moment
      this.block = -1; this.section = -1;
      this.output = null; this.opening = null; this.epoch = 0; this.retryAt = 0; this.sounds = new Map();
      this.input = null; this.ears = {lo: 0, mid: 0}; this.said = '';
    }
    get audible() { return !!this.output?.playing; }
    // The music can be heard right now, also in the moment a piece starts again and "audible" is not yet true.
    get sounding() { const output = this.output; return !!output && !output.audio.paused && output.gain.gain.value > 0.001; }
    get listening() { return !!this.input?.port; }
    get title() { return this.tracks[this.index]?.title || ''; }
    get track() { return this.tracks[this.index]; }
    duration(index) { return this.tracks[index]?.duration || 180; }

    /* ---------- the clock and what the figure follows ---------- */
    // How far into the piece, in seconds, at performance time "now".
    position(now) {
      const output = this.output;
      if (output?.playing) return Math.max(0, output.audio.currentTime - output.latency);
      return Math.max(0, this.anchor.offset + (now - this.anchor.at) / 1000);
    }
    // The silent clock moves to the next piece at the end of this one.
    advance(now) {
      if (this.output?.playing) return;
      for (let guard = 0; this.position(now) >= this.duration(this.index) && guard < 8; guard++) {
        const end = this.anchor.at + (this.duration(this.index) - this.anchor.offset) * 1000;
        this.setTrack((this.index + 1) % this.tracks.length, 0, end);
      }
    }
    setTrack(index, offset = 0, at = performance.now()) {
      this.index = index; this.anchor = {offset, at}; this.block = -1; this.section = -1;
      this.onChange();
    }
    // Each frame: hand on the 20 ms pieces of the music that have gone by since the last frame.
    follow(now) {
      if (this.source !== 'music' || this.hidden) return;
      this.advance(now);
      const track = this.track, position = this.position(now), block = Math.floor(position / BLOCK_S);
      let section = -1;
      for (let i = 0; i < track.sections.length; i++) if (track.sections[i] <= position) section = i;
      if (section !== this.section) { const on = this.section >= -1 && section > this.section && this.block >= 0; this.section = section; if (on) this.onSection(); }
      if (block === this.block) return;
      // (After a jump, or a long gap, only the newest piece counts.)
      for (let i = block - this.block > 0 && block - this.block <= 12 ? this.block + 1 : block; i <= block; i++) {
        const at = 3 * i;
        if (at + 2 < track.levels.length) this.onLevels([0, 1, 2].map(band => 0.5 * (track.levels[at + band] / 255) ** 2));
      }
      this.block = block;
    }
    // Seconds until the next beat of the piece, counted from its first.
    beat() { return 60 / (this.track.bpm || 120); }

    /* ---------- sound out ---------- */
    level() { return this.muted ? 0 : 1; }
    // An approach from wherever the level is now, so a fade can turn round halfway.
    fade(output, target, seconds) {
      const gain = output.gain.gain, now = output.ctx.currentTime, from = gain.value;
      gain.cancelScheduledValues(now); gain.setValueAtTime(from, now);
      gain.setTargetAtTime(target, now, seconds / 4); gain.setValueAtTime(target, now + seconds);
    }
    setMuted(muted) {
      this.muted = muted === true;
      if (this.output) this.fade(this.output, this.level(), FADE_S);
      this.onChange();
    }
    // A piece as something an audio element can play. (An App's frame cannot hand its own files to Web Audio by
    // address, so the file is read and played from memory.)
    sound(index) {
      if (!this.sounds.has(index)) {
        const pending = fetch(this.tracks[index].file).then(response => {
          if (!response.ok) throw Error('music ' + response.status);
          return response.blob();
        }).then(blob => URL.createObjectURL(blob));
        pending.catch(() => { if (this.sounds.get(index) === pending) this.sounds.delete(index); });
        this.sounds.set(index, pending);
      }
      return this.sounds.get(index);
    }
    // Sound starts once it is allowed. Called at the start and at every touch and key; tries are spaced out.
    wake() {
      if (this.source !== 'music' || this.output || this.opening || this.hidden || performance.now() < this.retryAt) return;
      this.retryAt = performance.now() + RETRY_MS;
      void this.play().catch(() => {});
    }
    async play() {
      const epoch = ++this.epoch;
      this.opening = (async () => {
        const ctx = new AudioContext({sampleRate: 48000, latencyHint: 'playback', sinkId: {type: 'none'}});
        let handle = null, output = null;
        try {
          void ctx.resume().catch(() => {});
          handle = await this.sdk.audio.openOutput({channels: 2});
          if (epoch !== this.epoch) throw stale();
          const sink = await handle.createNode(ctx);
          if (epoch !== this.epoch) throw stale();
          const audio = new Audio(); audio.preload = 'auto';
          const source = ctx.createMediaElementSource(audio), gain = ctx.createGain();
          gain.gain.value = 0;
          source.connect(gain).connect(sink);
          output = this.output = {ctx, handle, audio, source, gain, url: null, index: -1, playing: false,
            latency: (ctx.baseLatency || 0) + (ctx.outputLatency || 0) + HOST_LATENCY_S};
          audio.addEventListener('ended', () => { if (this.output === output) this.ended(output); });
          handle.onError(() => { if (this.output === output) { this.stopOutput(); this.onChange(); } });
          await this.startAt(performance.now());
        } catch (error) {
          if (output && this.output === output) this.stopOutput();
          else if (!output) await Promise.allSettled([handle?.close(), ctx.close()]);
          throw error;
        } finally {
          if (epoch === this.epoch) this.opening = null;
          this.onChange();
        }
      })();
      return this.opening;
    }
    // Plays the current piece from where the clock is (or from "offset").
    async startAt(now, offset = null) {
      const output = this.output;
      if (!output) return;
      if (offset == null) { this.advance(now); offset = this.position(now); }
      const index = this.index, url = await this.sound(index);
      if (this.output !== output || this.index !== index) return;
      const audio = output.audio;
      output.playing = false;
      if (output.url !== url) { audio.src = url; output.url = url; }
      audio.currentTime = Math.min(offset + (performance.now() - now) / 1000, this.duration(index)); output.index = index;
      await audio.play();
      if (this.output !== output || output.url !== url) return;
      output.playing = !this.hidden;
      this.fade(output, this.level(), START_FADE_S);
      this.onChange();
    }
    // The next piece follows the end of this one.
    ended(output) {
      output.playing = false;
      this.setTrack((output.index + 1) % this.tracks.length, 0, performance.now());
      void this.startAt(performance.now(), 0).catch(() => { if (this.output === output) { this.stopOutput(); this.onChange(); } });
    }
    // fade: leaving the music lets it die away; an error or closing stops it at once.
    stopOutput(fade = false) {
      const output = this.output;
      this.output = null; this.epoch++; this.opening = null;
      if (!output) return;
      // The clock carries on from the same place.
      if (output.playing) this.anchor = {offset: Math.max(0, output.audio.currentTime - output.latency), at: performance.now()};
      if (fade && output.playing && output.gain.gain.value > 0.001) {
        output.playing = false; this.fade(output, 0, STOP_FADE_S);
        setTimeout(() => this.closeOutput(output), STOP_FADE_S * 1000 + 60);
        return;
      }
      this.closeOutput(output);
    }
    closeOutput(output) {
      try { output.audio.pause(); output.audio.removeAttribute('src'); output.audio.load(); output.source.disconnect(); } catch (_) { /* gone */ }
      void Promise.allSettled([output.handle.close(), output.ctx.state === 'closed' ? null : output.ctx.close()]);
    }
    // A chosen piece plays from its start.
    choose(index) {
      if (!this.tracks[index]) return;
      this.setTrack(index, 0, performance.now());
      if (this.output) void this.startAt(performance.now(), 0).catch(() => {});
    }

    /* ---------- the audio input ---------- */
    // One block of what the input hears, as loudness in three bands: below 200 Hz, up to 2 kHz, and above.
    hear(samples) {
      let lo = this.ears.lo, mid = this.ears.mid, low = 0, middle = 0, high = 0;
      for (let i = 0; i < samples.length; i++) {
        const x = samples[i];
        lo += 0.0258 * (x - lo); mid += 0.2303 * (x - mid);
        low += lo * lo; middle += (mid - lo) * (mid - lo); high += (x - mid) * (x - mid);
      }
      this.ears.lo = lo; this.ears.mid = mid;
      this.onLevels([low, middle, high].map(sum => Math.sqrt(sum / Math.max(1, samples.length))));
    }
    closeInput() {
      const session = this.input; this.input = null;
      if (!session) return;
      session.cancelled = true;
      if (session.port) void Promise.resolve(session.port.close()).catch(() => {});
    }
    async openInput() {
      this.closeInput();
      const session = this.input = {cancelled: false, port: null};
      try {
        const port = await this.sdk.audio.openInput({channels: 1});
        if (session.cancelled) { void Promise.resolve(port.close()).catch(() => {}); return; }
        session.port = port; this.ears = {lo: 0, mid: 0};
        port.onData(samples => { if (this.input === session) this.hear(samples); });
        port.onError(() => { if (this.input === session) { this.closeInput(); this.source = 'silent'; this.said = 'Audio input stopped.'; this.onChange(); } });
      } catch (error) {
        if (this.input !== session) return;
        const code = error?.code || error?.name, refused = ['permission_required', 'permission_denied', 'capability_denied', 'io_not_authorized', 'NotAllowedError'].includes(code);
        // Asked once: choosing the input again asks again.
        this.closeInput(); this.source = 'silent'; this.said = refused ? 'Audio input is not allowed.' : 'No audio input.';
      } finally { this.onChange(); }
    }

    /* ---------- choosing ---------- */
    async setSource(source) {
      if (!['music', 'input', 'silent'].includes(source) || source === this.source) return;
      this.source = source; this.said = '';
      if (source !== 'music') this.stopOutput(true);
      if (source !== 'input') this.closeInput();
      this.block = -1;
      this.onChange();
      if (source === 'music') { this.retryAt = 0; this.wake(); }
      if (source === 'input') await this.openInput();
    }
    // The page is hidden or shown again: sound and clock stop and go on together.
    pause(hidden) {
      if (hidden === this.hidden) return;
      const now = performance.now();
      if (hidden) this.anchor = {offset: this.position(now), at: now}; else this.anchor.at = now;
      this.hidden = hidden;
      const output = this.output;
      if (!output) return;
      if (hidden) { output.playing = false; output.audio.pause(); void output.ctx.suspend().catch(() => {}); }
      else { void output.ctx.resume().catch(() => {}); void this.startAt(now).catch(() => {}); }
    }
    dispose() {
      this.stopOutput(); this.closeInput();
      for (const pending of this.sounds.values()) void pending.then(url => URL.revokeObjectURL(url), () => {});
      this.sounds.clear();
    }
  }
  window.MusicPlayer = Player;
})();
