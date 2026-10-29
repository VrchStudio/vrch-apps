/* Controller-local, non-authoritative Scene preview mirror. */
(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VrchSceneMirror = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root) {
  'use strict';
  const THREE = root.THREE;
  const SceneEffect = root.VrchSceneRuntime && root.VrchSceneRuntime.SceneEffect;
  const FrameAnalysis = root.VrchSceneFrameAnalysis;
  const FrameAnalysisController = FrameAnalysis && FrameAnalysis.FrameAnalysisController;

  function fixtureCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 320;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#122030'); gradient.addColorStop(0.45, '#c8704f'); gradient.addColorStop(1, '#e7d7ab');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 0.32;
    for (let y = 0; y < canvas.height; y += 40) for (let x = 0; x < canvas.width; x += 40) {
      ctx.fillStyle = ((x / 40 + y / 40) % 2) ? '#fff' : '#000';
      ctx.fillRect(x, y, 40, 40);
    }
    ctx.globalAlpha = 1;
    return canvas;
  }

  function waitForVideoFrame(video, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let frameRequested = false;
      let frameCallback = 0;
      const timeout = root.setTimeout(() => finish(new Error('Camera did not produce a video frame.')), timeoutMs);
      const events = ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'resize'];
      const cleanup = () => {
        root.clearTimeout(timeout);
        events.forEach((name) => video.removeEventListener(name, ready));
        video.removeEventListener('error', failed);
        if (frameCallback && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frameCallback);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve();
      };
      const ready = () => {
        if (settled || video.readyState < 2 || video.videoWidth < 1 || video.videoHeight < 1) return;
        if (typeof video.requestVideoFrameCallback !== 'function') { finish(); return; }
        if (frameRequested) return;
        frameRequested = true;
        frameCallback = video.requestVideoFrameCallback(() => finish());
      };
      const failed = () => finish(new Error('Camera video is unavailable.'));
      events.forEach((name) => video.addEventListener(name, ready));
      video.addEventListener('error', failed, { once: true });
      ready();
    });
  }

  class SceneMirror {
    constructor(options = {}) {
      if (!THREE || !SceneEffect) throw new Error('Scene mirror dependencies are unavailable.');
      this.container = options.container;
      this.onState = typeof options.onState === 'function' ? options.onState : () => {};
      this.onMediaState = typeof options.onMediaState === 'function' ? options.onMediaState : () => {};
      this.onAnalysisState = typeof options.onAnalysisState === 'function' ? options.onAnalysisState : () => {};
      this.renderer = null; this.scene = null; this.camera = null; this.effect = null;
      this.running = false; this.raf = 0; this.resizeRaf = 0; this.resizeObserver = null;
      this.lastSize = { width: 0, height: 0 };
      this.disposed = false;
      this.fixture = fixtureCanvas();
      this.externalSources = null;
      this.externalSourceGenerations = { A: 0, B: 0 };
      this.sourceBindings = options.sourceBindings || { 0: 'A', 1: 'A' };
      this.analysisOptions = options.analysisOptions || {};
      this.audioProvider = null;
      this.cameraStream = null;
      this.cameraVideo = null;
      this.microphoneStream = null;
      this.audioContext = null;
      this.audioAnalyser = null;
      this.audioFrequencyData = null;
      this.audioTimeData = null;
      this.frameAnalysis = null;
      this.analysisStatusView = null;
      this.analysisSourceGeneration = 0;
      this.analysisFrameId = 0;
      this.analysisRuntime = {
        active: null,
        signalBus: null,
        getSourceBindingState: () => ({ source_bindings: this.sourceBindings, source_a_channel: '1', source_b_channel: '2', revision: 0 }),
        setExternalSignals: (values) => {
          if (this.effect && this.effect.signalBus && typeof this.effect.signalBus.setExternalValues === 'function') this.effect.signalBus.setExternalValues(values || {});
        },
        setSignalTexture: (signalId, source) => this.effect ? this.effect.setSignalTexture(signalId, source) : false
      };
      this._init();
    }

    _init() {
      const canvas = document.createElement('canvas');
      canvas.className = 'scene-mirror__canvas';
      canvas.setAttribute('aria-label', 'Approximate local scene preview');
      const previous = this.container.querySelector('.scene-mirror__canvas');
      if (previous) previous.remove();
      this.container.prepend(canvas);
      if (FrameAnalysis && typeof FrameAnalysis.createModelLoadOverlay === 'function') {
        this.analysisStatusView = FrameAnalysis.createModelLoadOverlay(this.container);
      }
      this.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, alpha: true, powerPreference: 'low-power' });
      if (!this.renderer.capabilities.isWebGL2) throw new Error('Local preview requires WebGL2.');
      this.renderer.setPixelRatio(Math.min(1.5, root.devicePixelRatio || 1));
      this.scene = new THREE.Scene();
      this.camera = new THREE.Camera();
      this._resizeNow();
      if (root.ResizeObserver) {
        this.resizeObserver = new ResizeObserver(() => this._queueResize());
        this.resizeObserver.observe(this.container);
      }
    }

    _queueResize() {
      if (this.disposed || this.resizeRaf) return;
      this.resizeRaf = requestAnimationFrame(() => {
        this.resizeRaf = 0;
        this._resizeNow();
      });
    }

    _resizeNow() {
      if (this.disposed || !this.renderer || !this.container) return false;
      const rect = this.container.getBoundingClientRect();
      const width = Math.round(Number(this.container.clientWidth) || rect.width || 0);
      const height = Math.round(Number(this.container.clientHeight) || rect.height || 0);
      if (width < 1 || height < 1) return false;
      if (width === this.lastSize.width && height === this.lastSize.height) return false;
      this.lastSize = { width, height };
      this.renderer.setSize(width, height, false);
      return true;
    }

    show(definition, instance, trusted) {
      this.onState('loading');
      this.running = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      if (this.effect) this.effect.dispose();
      try {
        this._resizeNow();
        this.effect = new SceneEffect({ scene: this.scene, camera: this.camera, renderer: this.renderer, definition: definition, instance: instance, trusted: trusted === true, displayMode: 'crop' });
        const source = this.cameraVideo || this.fixture;
        this.effect.setSources([this.externalSources?.[0] || source, this.externalSources?.[1] || source]);
        this.analysisRuntime.active = { definition: definition, instance: instance };
        this.analysisRuntime.signalBus = this.effect.signalBus;
        if (FrameAnalysisController) {
          if (!this.frameAnalysis) this.frameAnalysis = new FrameAnalysisController({
            ...this.analysisOptions,
            runtime: this.analysisRuntime,
            onStatus: (status) => {
              if (FrameAnalysis && typeof FrameAnalysis.renderModelLoadOverlay === 'function') {
                FrameAnalysis.renderModelLoadOverlay(this.analysisStatusView, status);
              }
              try { this.onAnalysisState(status); } catch (_) {}
            }
          });
          this.frameAnalysis.setRuntime(this.analysisRuntime);
          this.frameAnalysis.sync(definition, this.analysisRuntime.getSourceBindingState());
        }
        this.running = true;
        this._frame();
        this.onState('visible');
        return true;
      } catch (error) {
        this.effect = null;
        this.onState('unavailable', error);
        return false;
      }
    }

    // Host media stays outside the mirror. Null slots use the sample image.
    setSources(sourceA, sourceB) {
      [sourceA, sourceB].forEach((source, index) => {
        if ((source || null) === (this.externalSources?.[index] || null)) return;
        const slot = index ? 'B' : 'A';
        this.externalSourceGenerations[slot]++;
        this.frameAnalysis?.invalidateSource(slot, this.analysisSourceGeneration + this.externalSourceGenerations[slot], 'preview-source-changed');
      });
      this.externalSources = sourceA || sourceB ? [sourceA, sourceB] : null;
      if (this.effect) this.effect.setSources([sourceA || this.fixture, sourceB || this.fixture]);
    }

    setAudioProvider(provider) { this.audioProvider = provider; }

    patchInstance(instance) {
      if (!this.effect || !this.renderer) return false;
      this.effect.setInstance(instance);
      if (this.analysisRuntime.active) this.analysisRuntime.active.instance = instance;
      if (this.frameAnalysis && typeof this.frameAnalysis.refreshOverlay === 'function') this.frameAnalysis.refreshOverlay();
      this.renderer.render(this.scene, this.camera);
      return true;
    }

    _emitMediaState(kind, state, error) {
      try { this.onMediaState({ kind: kind, state: state, error: error || null }); } catch (_) {}
    }

    async setCameraEnabled(enabled) {
      if (!enabled) {
        if (this.cameraStream) this.cameraStream.getTracks().forEach((track) => track.stop());
        this.cameraStream = null;
        if (this.cameraVideo) { this.cameraVideo.pause(); this.cameraVideo.srcObject = null; }
        this.cameraVideo = null;
        if (this.effect) this.effect.setData(this.fixture, this.fixture);
        this.analysisSourceGeneration += 1;
        this.analysisFrameId = 0;
        if (this.frameAnalysis && typeof this.frameAnalysis.invalidateSource === 'function') {
          this.frameAnalysis.invalidateSource('A', this.analysisSourceGeneration, 'preview-source-changed');
        }
        this._emitMediaState('camera', 'off');
        return false;
      }
      if (this.cameraStream && this.cameraVideo) return true;
      this._emitMediaState('camera', 'starting');
      let stream = null;
      let video = null;
      try {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') throw new Error('Camera media input is unavailable.');
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        if (this.disposed) { stream.getTracks().forEach((track) => track.stop()); return false; }
        if (!stream.getVideoTracks().length) throw new Error('Camera stream has no video track.');
        video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;
        video.srcObject = stream;
        await video.play();
        await waitForVideoFrame(video);
        if (this.disposed) { video.pause(); video.srcObject = null; stream.getTracks().forEach((track) => track.stop()); return false; }
        this.cameraStream = stream;
        this.cameraVideo = video;
        if (this.effect) this.effect.setData(video, video);
        this.analysisSourceGeneration += 1;
        this.analysisFrameId = 0;
        if (this.frameAnalysis && typeof this.frameAnalysis.invalidateSource === 'function') {
          this.frameAnalysis.invalidateSource('A', this.analysisSourceGeneration, 'preview-source-changed');
        }
        const track = stream.getVideoTracks()[0];
        if (track) track.addEventListener('ended', () => this.setCameraEnabled(false), { once: true });
        this._emitMediaState('camera', 'on');
        return true;
      } catch (error) {
        if (video) { video.pause(); video.srcObject = null; }
        if (stream) stream.getTracks().forEach((track) => track.stop());
        await this.setCameraEnabled(false);
        this._emitMediaState('camera', 'error', error);
        throw error;
      }
    }

    async setMicrophoneEnabled(enabled) {
      if (!enabled) {
        if (this.microphoneStream) this.microphoneStream.getTracks().forEach((track) => track.stop());
        this.microphoneStream = null;
        if (this.audioContext) await this.audioContext.close().catch(() => {});
        this.audioContext = null;
        this.audioAnalyser = null;
        this.audioFrequencyData = null;
        this.audioTimeData = null;
        this._emitMediaState('microphone', 'off');
        return false;
      }
      if (this.microphoneStream && this.audioAnalyser) return true;
      this._emitMediaState('microphone', 'starting');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
        if (this.disposed) { stream.getTracks().forEach((track) => track.stop()); return false; }
        const AudioContextCtor = root.AudioContext || root.webkitAudioContext;
        if (!AudioContextCtor) throw new Error('Web Audio is unavailable.');
        const context = new AudioContextCtor();
        await context.resume();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0;
        context.createMediaStreamSource(stream).connect(analyser);
        this.microphoneStream = stream;
        this.audioContext = context;
        this.audioAnalyser = analyser;
        this.audioFrequencyData = new Uint8Array(analyser.frequencyBinCount);
        this.audioTimeData = new Uint8Array(analyser.fftSize);
        const track = stream.getAudioTracks()[0];
        if (track) track.addEventListener('ended', () => this.setMicrophoneEnabled(false), { once: true });
        this._emitMediaState('microphone', 'on');
        return true;
      } catch (error) {
        await this.setMicrophoneEnabled(false);
        this._emitMediaState('microphone', 'error', error);
        throw error;
      }
    }

    _audioData() {
      if (this.audioProvider) return this.audioProvider();
      const analyser = this.audioAnalyser;
      if (!analyser || !this.audioFrequencyData || !this.audioTimeData) return null;
      analyser.getByteFrequencyData(this.audioFrequencyData);
      analyser.getByteTimeDomainData(this.audioTimeData);
      const bins = this.audioFrequencyData;
      const band = (from, to) => {
        let sum = 0;
        const start = Math.max(0, Math.floor(bins.length * from));
        const end = Math.max(start + 1, Math.floor(bins.length * to));
        for (let index = start; index < end; index += 1) sum += bins[index];
        return sum / Math.max(1, end - start) / 255;
      };
      let squareSum = 0;
      this.audioTimeData.forEach((sample) => { const value = (sample - 128) / 128; squareSum += value * value; });
      let weighted = 0; let magnitude = 0;
      bins.forEach((value, index) => { weighted += value * index; magnitude += value; });
      return {
        raw_low: band(0, 0.1), raw_mid: band(0.1, 0.4), raw_high: band(0.4, 1),
        rms: Math.sqrt(squareSum / Math.max(1, this.audioTimeData.length)),
        centroid: magnitude ? weighted / magnitude / Math.max(1, bins.length - 1) : 0
      };
    }

    captureThumbnail(options = {}) {
      if (!this.effect || !this.renderer || !this.running) return '';
      const restoreCamera = this.cameraVideo;
      const restoreSources = this.externalSources;
      try {
        this._resizeNow();
        if (restoreCamera || restoreSources) this.effect.setData(this.fixture, this.fixture);
        this.effect.render(performance.now() * 0.001, null, null);
        this.renderer.render(this.scene, this.camera);
        const source = this.renderer.domElement;
        const output = document.createElement('canvas');
        output.width = Math.max(160, Math.min(640, Number(options.width) || 480));
        output.height = Math.max(90, Math.min(360, Number(options.height) || 270));
        const context = output.getContext('2d', { alpha: false });
        if (!context) return '';
        context.fillStyle = '#050607';
        context.fillRect(0, 0, output.width, output.height);
        context.drawImage(source, 0, 0, output.width, output.height);
        const webp = output.toDataURL('image/webp', Math.max(0.5, Math.min(0.92, Number(options.quality) || 0.78)));
        return /^data:image\/webp;base64,/.test(webp) ? webp : output.toDataURL('image/png');
      } catch (_) {
        return '';
      } finally {
        if (this.effect && (restoreCamera || restoreSources)) this.effect.setSources([restoreSources?.[0] || restoreCamera || this.fixture, restoreSources?.[1] || restoreCamera || this.fixture]);
      }
    }

    getAnalysisStatus() {
      return this.frameAnalysis && typeof this.frameAnalysis.getStatus === 'function'
        ? this.frameAnalysis.getStatus()
        : { state: 'idle', source_slot: null, hands: 0, duration_ms: null, error: null };
    }

    hide() {
      this.running = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      if (this.effect) this.effect.dispose();
      this.effect = null;
      this.analysisRuntime.active = null;
      this.analysisRuntime.signalBus = null;
      if (this.frameAnalysis) this.frameAnalysis.sync(null, this.analysisRuntime.getSourceBindingState());
      this.setCameraEnabled(false).catch(() => {});
      this.setMicrophoneEnabled(false).catch(() => {});
      if (this.renderer) this.renderer.clear(true, true, true);
      this.onState('waiting');
    }

    _frame() {
      if (!this.running || this.disposed) return;
      this.raf = requestAnimationFrame(() => this._frame());
      if (!this.effect || !this.renderer || document.hidden) return;
      if (this.cameraVideo) this.effect.sourceTextures.forEach((texture) => { if (texture) texture.needsUpdate = true; });
      if (this.frameAnalysis) {
        const slot = this.frameAnalysis.sourceSlot || 'A';
        const source = this.externalSources?.[slot === 'B' ? 1 : 0] || this.cameraVideo || this.fixture;
        this.frameAnalysis.offerFrame(slot, source, {
          timestamp: performance.now(),
          frame_id: ++this.analysisFrameId,
          source_generation: this.analysisSourceGeneration + this.externalSourceGenerations[slot],
          mirrored: false,
          rotation: 0
        }).catch(() => {});
      }
      this.effect.render(performance.now() * 0.001, null, this._audioData());
      this.renderer.render(this.scene, this.camera);
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.running = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      if (this.resizeRaf) cancelAnimationFrame(this.resizeRaf);
      this.raf = 0; this.resizeRaf = 0;
      if (this.resizeObserver) this.resizeObserver.disconnect();
      if (this.cameraStream) this.cameraStream.getTracks().forEach((track) => track.stop());
      if (this.microphoneStream) this.microphoneStream.getTracks().forEach((track) => track.stop());
      if (this.audioContext) this.audioContext.close().catch(() => {});
      this.cameraStream = null; this.cameraVideo = null; this.microphoneStream = null; this.audioContext = null; this.audioAnalyser = null;
      if (this.effect) this.effect.dispose();
      if (this.frameAnalysis) this.frameAnalysis.dispose();
      if (this.analysisStatusView && this.analysisStatusView.element) this.analysisStatusView.element.remove();
      if (this.renderer) this.renderer.dispose();
      this.effect = null; this.frameAnalysis = null; this.analysisStatusView = null; this.renderer = null;
      if (this.container) {
        const canvas = this.container.querySelector('.scene-mirror__canvas');
        if (canvas) canvas.remove();
      }
    }
  }
  return Object.freeze({ SceneMirror: SceneMirror });
});
