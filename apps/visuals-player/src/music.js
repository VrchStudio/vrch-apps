/* Visuals Player sound. Three sources: the built-in tracks, the host audio input (microphone or line in, as chosen
   in the host's Device audio settings) and Silent. The picture follows the tracks from the first frame: until the
   first interaction allows sound, and while Silent, a clock plays them without output. Audio features always come
   from the sound itself through the shared VrchImageAudio.computeSceneSignalSample, as in Live Console. */
(() => {
  'use strict';
  const {SR, FFT, MIN_DB, MAX_DB, Spectrum, TrackFeatures} = VisualsSpectrum;
  const HOST_LATENCY_S = 0.03, RETRY_MS = 3000, KEEP_TRACKS = 2;
  // Sound never starts or stops abruptly: muting, unmuting, starting and leaving Music fade the level.
  const FADE_S = 0.6, START_FADE_S = 0.5, STOP_FADE_S = 0.4;
  const stale = () => Object.assign(Error('stale'), {code: 'stale'});

  class VisualsMusic {
    // tracks: [{id, title, file, features, duration, sections: [seconds]}]; external: an output surface that follows a controller.
    constructor({sdk, tracks, external = false, onChange = () => {}, onSection = () => {}}) {
      this.sdk = sdk; this.tracks = tracks; this.external = external === true; this.onChange = onChange; this.onSection = onSection;
      this.source = 'music'; this.index = 0; this.loaded = new Map(); this.retired = []; this.spectrum = new Spectrum();
      this.anchor = {index: 0, offset: 0, at: performance.now()};
      this.output = null; this.opening = null; this.epoch = 0; this.retryAt = 0; this.error = null;
      this.input = null; this.relayed = null; this.lastFeatures = null; this.lastAt = -1; this.section = -1; this.hidden = false;
      this.muted = false;
      this.trim();
    }

    get audible() { return !!this.output?.playing; }
    get title() { return this.tracks[this.index]?.title || ''; }
    state() { return {source: this.source, index: this.index, title: this.title, audible: this.audible, muted: this.muted, level: this.output ? Math.round(this.output.gain.gain.value * 1000) / 1000 : 0, position: this.position(performance.now()), error: this.error?.code || null}; }

    // Muted, the track keeps playing at no level, so unmuting fades it back in time with the picture.
    setMuted(muted) {
      this.muted = muted === true;
      if (this.output) this.fade(this.output, this.level(), FADE_S);
      this.onChange(this.state());
    }
    level() { return this.muted ? 0 : 1; }
    // An exponential approach from wherever the level is now, so a fade can turn around halfway.
    fade(output, target, seconds) {
      const gain = output.gain.gain, now = output.ctx.currentTime, from = gain.value;
      gain.cancelScheduledValues(now); gain.setValueAtTime(from, now);
      gain.setTargetAtTime(target, now, seconds / 4); gain.setValueAtTime(target, now + seconds);
    }

    // A track is its precomputed features (about 1 MB) and, only while sound plays, its file as a blob: the App's opaque
    // frame cannot hand its own package URL to Web Audio. Whole tracks are never decoded, so the picture follows the
    // music with the same features whether or not sound is playing.
    load(index) {
      const track = this.tracks[index];
      if (!track) return Promise.resolve(null);
      if (!this.loaded.has(index)) {
        const entry = {features: null, sound: null, pending: null};
        entry.pending = fetch(track.features).then(response => {
          if (!response.ok) throw Error('Track features HTTP ' + response.status);
          return response.arrayBuffer();
        }).then(bytes => { entry.features = new TrackFeatures(bytes); return entry; })
          .catch(error => { if (this.loaded.get(index) === entry) this.loaded.delete(index); throw error; });
        this.loaded.set(index, entry);
      }
      return this.loaded.get(index).pending;
    }
    async sound(index) {
      const entry = await this.load(index);
      if (!entry) return null;
      if (!entry.sound) {
        entry.sound = fetch(this.tracks[index].file).then(response => {
          if (!response.ok) throw Error('Track HTTP ' + response.status);
          return response.blob();
        }).then(blob => URL.createObjectURL(blob)).catch(error => { entry.sound = null; throw error; });
      }
      return entry.sound;
    }
    // Keep the current and next tracks. A dropped track's sound is released once nothing plays it.
    trim() {
      const keep = new Set(Array.from({length: Math.min(KEEP_TRACKS, this.tracks.length)}, (_, step) => (this.index + step) % this.tracks.length));
      for (const [key, entry] of [...this.loaded]) if (!keep.has(key)) { this.loaded.delete(key); if (entry.sound) this.retired.push(entry.sound); }
      this.releaseSounds();
      void this.load(this.index).then(() => this.load((this.index + 1) % this.tracks.length)).catch(() => {});
    }
    releaseSounds() {
      const playing = this.output?.url || null, retired = this.retired;
      this.retired = [];
      for (const pending of retired) void pending.then(url => { if (url === playing) this.retired.push(pending); else URL.revokeObjectURL(url); }, () => {});
    }
    duration(index) { return this.loaded.get(index)?.features?.duration || this.tracks[index]?.duration || 180; }

    // Track position in seconds at performance time 'now'.
    position(now) {
      const output = this.output;
      if (output?.playing) return Math.max(0, output.audio.currentTime - output.latency);
      return Math.max(0, this.anchor.offset + (now - this.anchor.at) / 1000);
    }
    // Moves the silent clock to the next track at the end of the current one.
    advance(now) {
      if (this.output?.playing) return;
      let guard = 0;
      while (this.position(now) >= this.duration(this.index) && guard++ < 8) {
        const end = this.anchor.at + (this.duration(this.index) - this.anchor.offset) * 1000;
        this.setTrack((this.index + 1) % this.tracks.length, 0, end);
      }
    }
    setTrack(index, offset = 0, at = performance.now(), announce = true) {
      const changed = index !== this.index;
      this.index = index; this.anchor = {index, offset, at}; this.section = -1;
      if (changed) this.trim();
      if (announce) this.onChange(this.state());
    }

    // Audio features for the picture at performance time 'now' (null while nothing can be read yet).
    features(now) {
      if (now === this.lastAt) return this.lastFeatures;
      this.lastAt = now;
      if (this.source === 'input') {
        this.lastFeatures = this.relayed || (this.input?.analyser ? this.spectrum.readAnalyser(this.input.analyser) : null);
        return this.lastFeatures;
      }
      this.advance(now);
      const features = this.loaded.get(this.index)?.features;
      if (!features) { this.lastFeatures = null; return null; }
      const position = this.position(now);
      this.watchSections(position);
      this.lastFeatures = features.at(position);
      return this.lastFeatures;
    }
    watchSections(position) {
      const sections = this.tracks[this.index]?.sections || [];
      let current = -1;
      for (let i = 0; i < sections.length; i++) if (sections[i] <= position) current = i;
      if (current !== this.section) {
        const changed = this.section >= 0 && current > this.section;
        this.section = current;
        if (changed) this.onSection({index: this.index, section: current, at: sections[current]});
      }
    }

    // Sound starts after an interaction; the host may need a moment or a later gesture, so retries are spaced.
    wake() {
      if (this.external || this.source !== 'music' || this.output || this.opening || this.hidden || performance.now() < this.retryAt) return;
      this.retryAt = performance.now() + RETRY_MS;
      void this.play().catch(() => {});
    }
    async play() {
      const epoch = ++this.epoch;
      this.opening = (async () => {
        const ctx = new AudioContext({sampleRate: SR, latencyHint: 'playback', sinkId: {type: 'none'}});
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
          handle.onError(error => { if (this.output === output) { this.error = error; this.stopOutput(); this.onChange(this.state()); } });
          this.error = null;
          await this.startAt(performance.now());
        } catch (error) {
          if (error.code !== 'stale') this.error = error?.name === 'NotAllowedError' ? Object.assign(Error('Sound needs a tap.'), {code: 'interaction_required'}) : error;
          if (output && this.output === output) this.stopOutput();
          else if (!output) await Promise.allSettled([handle?.close(), ctx.close()]);
          throw error;
        } finally {
          if (epoch === this.epoch) this.opening = null;
          this.onChange(this.state());
        }
      })();
      return this.opening;
    }
    // Plays the current track from where the picture is (or from 'offset').
    async startAt(now, offset = null) {
      const output = this.output;
      if (!output) return;
      if (offset == null) { this.advance(now); offset = this.position(now); }
      const index = this.index, url = await this.sound(index);
      if (this.output !== output || this.index !== index || !url) return;
      const at = Math.min(offset + (performance.now() - now) / 1000, this.duration(index));
      const audio = output.audio;
      output.playing = false;
      if (output.url !== url) { audio.src = url; output.url = url; this.releaseSounds(); }
      audio.currentTime = at; output.index = index;
      await audio.play();
      if (this.output !== output || output.url !== url) return;
      output.playing = !this.hidden;
      this.fade(output, this.level(), START_FADE_S);
      this.onChange(this.state());
    }
    // The next track follows the end of the current one.
    ended(output) {
      output.playing = false;
      const next = (output.index + 1) % this.tracks.length;
      this.setTrack(next, 0, performance.now(), false);
      this.onChange(this.state());
      void this.startAt(performance.now(), 0).catch(error => { if (this.output === output) { this.error = error; this.stopOutput(); this.onChange(this.state()); } });
    }
    // fade: leaving Music lets the sound die away; errors and closing stop it at once.
    stopOutput(fade = false) {
      const output = this.output;
      this.output = null; this.epoch++; this.opening = null;
      if (!output) return;
      // The picture carries on from the same position on the silent clock.
      if (output.playing) this.anchor = {index: this.index, offset: Math.max(0, output.audio.currentTime - output.latency), at: performance.now()};
      if (fade && output.playing && output.gain.gain.value > 0.001) {
        output.playing = false; this.fade(output, 0, STOP_FADE_S);
        setTimeout(() => this.closeOutput(output), STOP_FADE_S * 1000 + 60);
        return;
      }
      this.closeOutput(output);
    }
    closeOutput(output) {
      try { output.audio.pause(); output.audio.removeAttribute('src'); output.audio.load(); output.source.disconnect(); } catch (_) {}
      this.releaseSounds();
      void Promise.allSettled([output.handle.close(), output.ctx.state === 'closed' ? null : output.ctx.close()]);
    }

    // Plays a chosen track from its start.
    choose(index) {
      if (!this.tracks[index]) return;
      this.setTrack(index, 0, performance.now(), false);
      if (this.output) void this.startAt(performance.now(), 0).catch(() => {});
      this.onChange(this.state());
    }
    next() { this.choose((this.index + 1) % this.tracks.length); }

    async setSource(source) {
      if (!['music', 'input', 'silent'].includes(source)) return;
      const same = source === this.source;
      this.source = source; this.error = null; this.relayed = null;
      if (source !== 'music') this.stopOutput(true);
      if (source !== 'input') this.closeInput();
      this.onChange(this.state());
      if (source === 'music') { this.retryAt = 0; this.wake(); }
      if (source === 'input' && !this.external && !(same && this.input)) await this.openInput();
    }
    async openInput() {
      this.closeInput();
      const session = this.input = {cancelled: false};
      this.onChange(this.state());
      try {
        const handle = await this.sdk.audio.openInput({channels: 1, echoCancellation: false});
        if (session.cancelled) { void handle.close().catch(() => {}); return; }
        session.handle = handle;
        handle.onError(error => { if (this.input === session) { this.error = error; this.closeInput(); this.onChange(this.state()); } });
        const ctx = session.ctx = new AudioContext({sampleRate: SR, sinkId: {type: 'none'}});
        void ctx.resume().catch(() => {});
        const node = await handle.createNode(ctx);
        if (session.cancelled) return;
        const analyser = ctx.createAnalyser(); analyser.fftSize = FFT; analyser.smoothingTimeConstant = 0;
        analyser.minDecibels = MIN_DB; analyser.maxDecibels = MAX_DB;
        const mute = ctx.createGain(); mute.gain.value = 0;
        node.connect(analyser); analyser.connect(mute).connect(ctx.destination);
        session.analyser = analyser; session.silent = handle.silent === true;
        this.error = null;
      } catch (error) {
        if (this.input === session) { this.error = error; this.closeInput(); }
      } finally { this.onChange(this.state()); }
    }
    closeInput() {
      const session = this.input; this.input = null;
      if (!session) return;
      session.cancelled = true;
      void session.handle?.close().catch(() => {});
      void session.ctx?.close().catch(() => {});
    }
    get listening() { return !!this.input?.analyser; }
    async inputDevices() {
      try { return await this.sdk.audio.devices(); } catch (_) { return {devices: [], selected: null}; }
    }
    async selectInput(id) {
      await this.sdk.audio.selectInput(id);
      if (this.source === 'input') await this.openInput(); else await this.setSource('input');
    }

    // An output surface: the controller's track position, or its live input features.
    follow({source, index, offset, at}) {
      if (['music', 'input', 'silent'].includes(source)) { if (source !== 'input') this.relayed = null; this.source = source; }
      if (Number.isInteger(index) && this.tracks[index] && Number.isFinite(offset) && Number.isFinite(at)) {
        const now = performance.now(), local = at - performance.timeOrigin;
        if (index !== this.index || Math.abs(this.position(now) - (offset + (now - local) / 1000)) > 0.08) this.setTrack(index, offset, local, false);
      }
    }
    relay(features) { this.relayed = features && typeof features === 'object' ? features : null; }
    timing() {
      const now = performance.now();
      return {source: this.source, index: this.index, offset: this.position(now), at: performance.timeOrigin + now};
    }

    pause(hidden) {
      this.hidden = hidden;
      const output = this.output;
      if (!output) return;
      if (hidden) {
        if (output.playing) this.anchor = {index: this.index, offset: this.position(performance.now()), at: performance.now()};
        output.playing = false; output.audio.pause(); void output.ctx.suspend().catch(() => {});
      } else {
        void output.ctx.resume().catch(() => {});
        void this.startAt(performance.now()).catch(() => {});
      }
    }
    dispose() {
      this.stopOutput(); this.closeInput();
      for (const entry of this.loaded.values()) if (entry.sound) this.retired.push(entry.sound);
      this.loaded.clear(); this.releaseSounds();
    }
  }
  window.VisualsMusic = VisualsMusic;
})()
