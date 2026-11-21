/* Visuals Player sound. Three sources: the built-in songs, the host audio input (microphone or line in, as chosen in the
   host's Device audio settings) and Silent. The songs are original pieces synthesised in a worker a little ahead of
   where they play (beats/songs.js, with the Drum 808 App's own drums), together with the audio features of that very
   sound, so the picture follows exactly what is heard. Music starts sounding as soon as the App opens; where the browser
   waits for a first interaction, and while Silent, a clock plays the songs without output for the picture to follow.
   Mic / Line in features come from the input through the shared VrchImageAudio.computeSceneSignalSample, as in Live Console. */
(() => {
  'use strict';
  const {SR, FFT, MIN_DB, MAX_DB, Spectrum, SongFeatures} = VisualsSpectrum;
  const HOST_LATENCY_S = 0.03, RETRY_MS = 3000, READ_MS = 12, LEAD_S = 0.12, AHEAD_S = 16, PLAYHEAD_MS = 400, KEEP_S = 1;
  // Sound never starts or stops abruptly: muting, unmuting, starting and leaving Music fade the level.
  const FADE_S = 0.6, START_FADE_S = 0.5, STOP_FADE_S = 0.4;
  const WORKER_FILES = ['scripts/vrch_pages_image_audio_reactivity.js', 'spectrum.js', 'beats/drum808-engine.js', 'beats/songs.js', 'beats/worker.js'];
  const stale = () => Object.assign(Error('stale'), {code: 'stale'});
  const loudness = features => Number(features?.v2_raw_energy ?? features?.rms) || 0;

  // The songs render in a classic Worker made from this package's own scripts: an opaque frame cannot start one from a
  // package URL. The blob URL is released once the worker has reported that it is running.
  async function songWorker() {
    const texts = await Promise.all(WORKER_FILES.map(file => fetch(file).then(response => {
      if (!response.ok) throw Error(file + ' HTTP ' + response.status);
      return response.text();
    })));
    const [analysis, spectrum, engine, songs, worker] = texts;
    const source = ['self.window = self; self.sampleRate = ' + SR + '; self.currentFrame = 0;',
      'class AudioWorkletProcessor { constructor() { this.port = {postMessage() {}, onmessage: null}; } }',
      'function registerProcessor(name, processor) { self.VisualsDrum808 = processor; }',
      analysis, spectrum, '(() => {\n' + engine + '\n})();', songs, worker].join('\n;\n');
    const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
    try { return {worker: new Worker(url), url}; } catch (error) { URL.revokeObjectURL(url); throw error; }
  }

  class VisualsMusic {
    // tracks: [{id, title, duration, bpm, sections: [seconds]}]; external: an output surface that follows a controller.
    constructor({sdk, tracks, external = false, onChange = () => {}, onSection = () => {}, onAdvance = () => {}}) {
      this.sdk = sdk; this.tracks = tracks; this.external = external === true; this.onChange = onChange; this.onSection = onSection; this.onAdvance = onAdvance;
      this.source = 'music'; this.index = 0; this.spectrum = new Spectrum();
      // The silent clock: the song position 'offset' at performance time 'at' (null: held at 'offset' until the sound is ready).
      this.anchor = {offset: 0, at: performance.now()};
      this.output = null; this.opening = null; this.epoch = 0; this.retryAt = 0; this.error = null;
      this.input = null; this.relayed = null; this.held = null; this.lastFeatures = null; this.lastAt = -1; this.readAt = -Infinity; this.reads = 0; this.section = -1; this.hidden = false;
      this.muted = false; this.poked = false; this.retries = 0; this.retryTimer = 0;
      // Rendering: the worker, its current job (where it plays from and which songs it has reached) and the features and
      // sound it has sent. A song's features are the same whichever job rendered them, so they are kept across jobs.
      this.worker = null; this.workerStart = null; this.job = null; this.jobs = 0; this.stores = new Map(); this.chunks = []; this.playheadAt = -Infinity;
    }

    get audible() { return !!this.output?.playing; }
    get title() { return this.tracks[this.index]?.title || ''; }
    state() { return {source: this.source, index: this.index, title: this.title, audible: this.audible, muted: this.muted, level: this.output ? Math.round(this.output.gain.gain.value * 1000) / 1000 : 0, position: this.position(performance.now()), error: this.error?.code || null}; }

    // Muted, the song keeps playing at no level, so unmuting fades it back in time with the picture.
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
    duration(index) { return this.tracks[index]?.duration || 120; }

    // ---- Rendering -----------------------------------------------------------------------------------------------
    ensureWorker() {
      if (this.workerStart) return this.workerStart;
      this.workerStart = songWorker().then(({worker, url}) => {
        this.worker = worker;
        worker.onmessage = ({data}) => {
          if (data?.type === 'ready') URL.revokeObjectURL(url);
          else if (data?.type === 'chunk') this.receive(data);
        };
        worker.onerror = event => { URL.revokeObjectURL(url); this.error = Object.assign(Error(event.message || 'Music unavailable.'), {code: 'music_unavailable'}); this.onChange(this.state()); };
        return worker;
      });
      this.workerStart.catch(error => { this.error = Object.assign(error, {code: 'music_unavailable'}); this.workerStart = null; this.onChange(this.state()); });
      return this.workerStart;
    }
    store(index) {
      if (!this.stores.has(index)) this.stores.set(index, new SongFeatures(this.duration(index)));
      // Only the playing song and the next one are kept.
      const keep = new Set([this.index, (this.index + 1) % this.tracks.length, index]);
      for (const key of this.stores.keys()) if (!keep.has(key)) this.stores.delete(key);
      return this.stores.get(index);
    }
    // A new job plays 'index' from 'offset'; its sound is kept only by a controller.
    startJob(index, offset) {
      const job = this.job = {id: ++this.jobs, song: index, offset, bases: new Map([[index, -offset]]), covered: new Map(), last: index};
      this.chunks = [];
      void this.ensureWorker().then(worker => {
        if (this.job === job) worker.postMessage({type: 'start', job: job.id, song: index, offset, audio: !this.external, ahead: AHEAD_S});
      }, () => {});
      return job;
    }
    // Whether the current job reaches 'index' at 'offset', or will shortly.
    covers(index, offset) {
      const job = this.job;
      if (!job) return false;
      const range = job.covered.get(index);
      if (!range) return index === job.song || index === (job.last + 1) % this.tracks.length;
      return offset >= range[0] - 0.05 && offset <= range[1] + AHEAD_S;
    }
    receive(chunk) {
      const job = this.job;
      if (!job || chunk.job !== job.id) return;
      const from = chunk.start / SR, to = from + chunk.frames / SR, base = chunk.stream - from;
      job.bases.set(chunk.song, base); job.last = chunk.song;
      const range = job.covered.get(chunk.song);
      job.covered.set(chunk.song, range ? [Math.min(range[0], from), Math.max(range[1], to)] : [from, to]);
      if (this.stores.has(chunk.song) || chunk.song === this.index || chunk.song === (this.index + 1) % this.tracks.length) this.store(chunk.song).add(chunk.first, new Uint8Array(chunk.features));
      if (!chunk.left) return;
      const entry = {song: chunk.song, stream: chunk.stream, end: chunk.stream + chunk.frames / SR, left: new Float32Array(chunk.left), right: new Float32Array(chunk.right), node: null};
      this.chunks.push(entry);
      const output = this.output;
      if (output?.waiting) { if (this.ready(this.position(performance.now()))) this.begin(output); }
      else if (output?.playing) this.schedule(output, entry);
    }
    // Tells the worker how far the music has played, so it keeps a few seconds rendered ahead.
    report(now) {
      const job = this.job;
      if (!job || !this.worker || now - this.playheadAt < PLAYHEAD_MS) return;
      const base = job.bases.get(this.index);
      if (base == null) return;
      this.playheadAt = now;
      const stream = base + this.position(now);
      this.worker.postMessage({type: 'playhead', job: job.id, stream});
      // Sound already played is let go.
      if (this.chunks.length && this.chunks[0].end < stream - KEEP_S) this.chunks = this.chunks.filter(entry => entry.end >= stream - KEEP_S);
    }

    // ---- Time ----------------------------------------------------------------------------------------------------
    // Song position in seconds at performance time 'now': what is heard while sound plays, else the silent clock.
    position(now) {
      const output = this.output;
      if (output?.playing) {
        const base = this.job?.bases.get(this.index) ?? 0;
        return Math.max(0, output.s0 + (output.ctx.currentTime - output.t0) - output.latency - base);
      }
      if (this.anchor.at == null) return this.anchor.offset;
      return Math.max(0, this.anchor.offset + (now - this.anchor.at) / 1000);
    }
    // Moves on to the next song at the end of the current one; the job is already rendering it.
    advance(now) {
      let guard = 0;
      const from = this.index;
      while (this.position(now) >= this.duration(this.index) && guard++ < 8) {
        const next = (this.index + 1) % this.tracks.length, base = this.job?.bases.get(this.index);
        if (this.job && base != null && !this.job.bases.has(next)) this.job.bases.set(next, base + this.duration(this.index));
        if (this.output?.playing) { this.index = next; this.section = -1; continue; }
        const end = this.anchor.at == null ? now : this.anchor.at + (this.duration(this.index) - this.anchor.offset) * 1000;
        this.index = next; this.section = -1; this.anchor = {offset: 0, at: end};
      }
      if (this.index !== from) { this.store(this.index); this.onChange(this.state()); this.onAdvance(this.index); }
    }
    setTrack(index, offset = 0, at = performance.now(), announce = true) {
      this.index = index; this.anchor = {offset, at}; this.section = -1;
      this.store(index);
      if (!this.covers(index, offset)) this.startJob(index, offset);
      if (announce) this.onChange(this.state());
    }

    // Audio features for the picture at performance time 'now' (null while nothing can be read yet).
    features(now) {
      if (now === this.lastAt) return this.lastFeatures;
      this.lastAt = now;
      if (this.source === 'input') {
        if (this.relayed || !this.input?.analyser) { this.lastFeatures = this.relayed; return this.lastFeatures; }
        // One analyser reading per display refresh, for the picture and the output relay alike.
        if (!this.lastFeatures || now - this.readAt >= READ_MS || now < this.readAt) {
          this.lastFeatures = this.spectrum.readAnalyser(this.input.analyser); this.readAt = now; this.reads++;
          this.hold(this.lastFeatures);
        }
        return this.lastFeatures;
      }
      this.advance(now);
      const position = this.position(now);
      if (!this.covers(this.index, position)) this.startJob(this.index, position);
      this.report(now);
      const features = this.stores.get(this.index)?.at(position) || null;
      if (features) this.watchSections(position);
      this.lastFeatures = features;
      return features;
    }
    // The picture's features: with Mic / Line in, the loudest reading since the picture last drew. The input is read
    // every display refresh, but a picture drawing fewer frames than that would otherwise miss short hits between them.
    picture(now) {
      const features = this.features(now);
      if (this.source !== 'input' || !this.held) return features;
      const held = this.held; this.held = null;
      return held;
    }
    hold(features) { if (features && (!this.held || loudness(features) >= loudness(this.held))) this.held = features; }
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

    // ---- Sound ---------------------------------------------------------------------------------------------------
    // Sound starts when the App opens. Where the browser needs a gesture first, the next interaction ('force') starts it,
    // also one that arrives while an attempt is still failing; other failures retry by themselves, further apart each time.
    wake(force = false) {
      if (this.external || this.source !== 'music' || this.output || this.hidden) return;
      if (this.opening) { if (force) this.poked = true; return; }
      if ((!force || this.error?.code !== 'interaction_required') && performance.now() < this.retryAt) return;
      clearTimeout(this.retryTimer);
      this.retryAt = performance.now() + RETRY_MS; this.poked = false;
      void this.play().then(() => { this.retries = 0; }, error => {
        if (error?.code === 'stale') return;
        if (this.poked) { this.poked = false; this.retryAt = 0; this.wake(true); return; }
        if (this.error?.code === 'interaction_required') return;
        this.retryTimer = setTimeout(() => { this.retryAt = 0; this.wake(); }, Math.min(8000, 1000 * 2 ** this.retries++));
      });
    }
    async play() {
      const epoch = ++this.epoch;
      this.opening = (async () => {
        const ctx = new AudioContext({sampleRate: SR, latencyHint: 'playback', sinkId: {type: 'none'}});
        let handle = null, output = null;
        try {
          const resumed = ctx.resume();
          handle = await this.sdk.audio.openOutput({channels: 2});
          if (epoch !== this.epoch) throw stale();
          const sink = await handle.createNode(ctx);
          if (epoch !== this.epoch) throw stale();
          // A context the browser keeps suspended until a gesture plays nothing; say so instead of drifting from the picture.
          await Promise.race([resumed, new Promise(resolve => setTimeout(resolve, 400))]);
          if (ctx.state !== 'running') throw Object.assign(Error('Sound needs a tap.'), {name: 'NotAllowedError'});
          const gain = ctx.createGain();
          gain.gain.value = 0; gain.connect(sink);
          output = this.output = {ctx, handle, gain, nodes: new Set(), playing: false, waiting: false, t0: 0, s0: 0,
            latency: (ctx.baseLatency || 0) + (ctx.outputLatency || 0) + HOST_LATENCY_S};
          handle.onError(error => { if (this.output === output) { this.error = error; this.stopOutput(); this.onChange(this.state()); } });
          this.error = null;
          this.startAt(performance.now());
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
    // Plays from where the picture is (or from 'offset'), as soon as that part of the song is rendered.
    startAt(now, offset = null) {
      const output = this.output;
      if (!output) return;
      this.silence(output);
      if (offset == null) { this.advance(now); offset = this.position(now); }
      output.playing = false;
      if (!this.covers(this.index, offset)) this.startJob(this.index, offset);
      // Until that part of the song is rendered the clock holds still, so the sound starts where the picture is.
      const ready = this.ready(offset);
      this.anchor = {offset, at: ready ? now : null};
      output.waiting = true;
      if (ready) this.begin(output);
    }
    // Whether the sound at 'offset' into the current song has arrived.
    ready(offset) {
      const base = this.job?.bases.get(this.index);
      if (base == null) return false;
      const at = base + offset;
      return this.chunks.some(entry => entry.stream <= at + 0.02 && entry.end > at);
    }
    // The heard position continues from the silent clock; the sound starts a moment later at the matching point.
    begin(output) {
      const now = performance.now(), offset = this.position(now), base = this.job?.bases.get(this.index);
      if (base == null || this.output !== output || this.hidden) return;
      output.waiting = false;
      output.t0 = output.ctx.currentTime + LEAD_S; output.s0 = base + offset + LEAD_S + output.latency;
      output.playing = true;
      for (const entry of this.chunks) this.schedule(output, entry);
      this.fade(output, this.level(), START_FADE_S);
      this.onChange(this.state());
    }
    schedule(output, entry) {
      const ctx = output.ctx, at = output.t0 + (entry.stream - output.s0), length = entry.left.length / SR;
      const start = Math.max(at, ctx.currentTime + 0.005), skip = start - at;
      if (skip >= length || entry.node) return;
      const buffer = ctx.createBuffer(2, entry.left.length, SR);
      buffer.copyToChannel(entry.left, 0); buffer.copyToChannel(entry.right, 1);
      const node = entry.node = ctx.createBufferSource();
      node.buffer = buffer; node.connect(output.gain); node.start(start, skip);
      output.nodes.add(node);
      node.onended = () => { output.nodes.delete(node); if (entry.node === node) entry.node = null; node.disconnect(); };
    }
    // Stops every scheduled part of the song (their chunks can be scheduled again).
    silence(output) {
      for (const node of output.nodes) { try { node.onended = null; node.stop(); node.disconnect(); } catch (_) {} }
      output.nodes.clear();
      for (const entry of this.chunks) entry.node = null;
    }
    // fade: leaving Music lets the sound die away; errors and closing stop it at once.
    stopOutput(fade = false) {
      const output = this.output;
      this.output = null; this.epoch++; this.opening = null;
      if (!output) return;
      // The picture carries on from the same position on the silent clock.
      if (output.playing) { const now = performance.now(); this.anchor = {offset: Math.max(0, output.s0 + (output.ctx.currentTime - output.t0) - output.latency - (this.job?.bases.get(this.index) ?? 0)), at: now}; }
      else if (this.anchor.at == null) this.anchor = {offset: this.anchor.offset, at: performance.now()};
      if (fade && output.playing && output.gain.gain.value > 0.001) {
        output.playing = false; this.fade(output, 0, STOP_FADE_S);
        setTimeout(() => this.closeOutput(output), STOP_FADE_S * 1000 + 60);
        return;
      }
      output.playing = false;
      this.closeOutput(output);
    }
    closeOutput(output) {
      this.silence(output);
      try { output.gain.disconnect(); } catch (_) {}
      void Promise.allSettled([output.handle.close(), output.ctx.state === 'closed' ? null : output.ctx.close()]);
    }

    // Plays a chosen song from its start.
    choose(index) {
      if (!this.tracks[index]) return;
      if (this.output) this.silence(this.output);
      this.index = index; this.section = -1; this.anchor = {offset: 0, at: performance.now()};
      this.store(index); this.startJob(index, 0);
      if (this.output) this.startAt(performance.now(), 0);
      this.onChange(this.state());
    }
    next() { this.choose((this.index + 1) % this.tracks.length); }

    async setSource(source) {
      if (!['music', 'input', 'silent'].includes(source)) return;
      const same = source === this.source;
      this.source = source; this.error = null; this.relayed = null; this.held = null;
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
      const session = this.input; this.input = null; this.held = null;
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

    // An output surface: the controller's song position, or its live input features.
    follow({source, index, offset, at}) {
      if (['music', 'input', 'silent'].includes(source)) { if (source !== 'input') this.relayed = this.held = null; this.source = source; }
      if (Number.isInteger(index) && this.tracks[index] && Number.isFinite(offset) && Number.isFinite(at)) {
        const now = performance.now(), local = at - performance.timeOrigin;
        if (index !== this.index || Math.abs(this.position(now) - (offset + (now - local) / 1000)) > 0.08) this.setTrack(index, offset, local, false);
      }
    }
    relay(features) { this.relayed = features && typeof features === 'object' ? features : null; this.hold(this.relayed); }
    timing() {
      const now = performance.now();
      return {source: this.source, index: this.index, offset: this.position(now), at: performance.timeOrigin + now};
    }

    pause(hidden) {
      this.hidden = hidden;
      const output = this.output;
      if (!output) { if (!hidden) this.wake(); return; }
      if (hidden) {
        if (output.playing || output.waiting) this.anchor = {offset: this.position(performance.now()), at: performance.now()};
        output.playing = false; output.waiting = false; this.silence(output); void output.ctx.suspend().catch(() => {});
      } else {
        void output.ctx.resume().catch(() => {});
        this.startAt(performance.now());
      }
    }
    dispose() {
      this.stopOutput(); this.closeInput();
      this.worker?.terminate(); this.worker = null; this.job = null; this.chunks = []; this.stores.clear();
    }
  }
  window.VisualsMusic = VisualsMusic;
})();
