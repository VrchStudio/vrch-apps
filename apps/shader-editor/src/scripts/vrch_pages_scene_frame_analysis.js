/* VRCH decoded-frame analysis controller: latest-frame-only hand, face and body landmarks. */
(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VrchSceneFrameAnalysis = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root) {
  'use strict';

  const HAND_CONNECTIONS = Object.freeze([
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
  ]);

  // Semantic priority keeps low point counts readable: wrist and fingertips
  // first, followed by the finger joints from palm to tip.
  const HAND_NODE_INDICES = Object.freeze([
    0, 4, 8, 12, 16, 20,
    1, 5, 9, 13, 17,
    2, 6, 10, 14, 18,
    3, 7, 11, 15, 19
  ]);

  // The landmarker keeps all 478 points available in the float texture, but
  // the base tracker draws a deliberately sparse semantic wireframe. Dense
  // nodes turn into an unreadable blob at the 256px overlay resolution.
  const FACE_LOOPS = Object.freeze([
    [10, 297, 284, 389, 454, 361, 397, 400, 152, 176, 172, 132, 234, 162, 54, 67, 10],
    [33, 158, 133, 153, 33],
    [362, 387, 263, 373, 362],
    [61, 37, 267, 291, 314, 84, 61],
    [168, 6, 1, 2]
  ]);

  const FACE_CONNECTIONS = Object.freeze(FACE_LOOPS.reduce((output, loop) => {
    for (let index = 1; index < loop.length; index += 1) output.push([loop[index - 1], loop[index]]);
    return output;
  }, []));

  // Stable semantic priority: low counts keep the face readable instead of
  // taking an arbitrary prefix of MediaPipe's landmark order.
  const FACE_NODE_INDICES = Object.freeze([
    1, 33, 133, 362, 263, 61, 291, 10, 152, 234, 454, 168,
    158, 153, 387, 373, 37, 267, 314, 84, 297, 284, 389, 361,
    397, 400, 176, 172, 132, 162, 54, 67, 6, 2
  ]);

  const POSE_CONNECTIONS = Object.freeze([
    [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8],
    [9, 10], [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
    [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
    [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
    [24, 26], [26, 28], [28, 30], [30, 32], [28, 32]
  ]);

  // Torso and major limb joints remain visible at low counts. Hands, feet and
  // facial detail are added progressively as Tracked Points increases.
  const POSE_NODE_INDICES = Object.freeze([
    11, 12, 23, 24, 13, 14, 15, 16,
    25, 26, 27, 28, 0, 17, 18, 19, 20, 21, 22,
    29, 30, 31, 32, 7, 8, 9, 10, 1, 4, 2, 5, 3, 6
  ]);

  const ANALYZERS = Object.freeze({
    hand: Object.freeze({
      kind: 'hand', topology: 'vrch.hand-landmarks@1', maximumTracks: 2,
      minimumLandmarks: 21, maximumLandmarks: 21, textureWidth: 32,
      modelUrl: 'models/mediapipe/hand_landmarker-lite-v1.task',
      connections: HAND_CONNECTIONS, nodeIndices: HAND_NODE_INDICES,
      minimumVisibleNodes: 6, defaultVisibleNodes: 21, defaultLineWidth: 1, defaultNodeSize: 1, defaultTrailLength: 0.7,
      overlayLineDefault: 3.12, overlayLineMaximum: 9.6,
      overlayNodeDefault: 3.64, overlayNodeMaximum: 11.2, overlayTrailWidth: 2.25
    }),
    face: Object.freeze({
      kind: 'face', topology: 'vrch.face-landmarks@1', maximumTracks: 1,
      minimumLandmarks: 468, maximumLandmarks: 478, textureWidth: 512,
      // The locally repacked Lite model returns 478 values but does not
      // preserve the Face Landmarker topology. Use the official task bundle
      // whose landmark indices match FACE_LOOPS and the public ABI.
      modelUrl: 'models/mediapipe/face_landmarker-float16-v1.task',
      connections: FACE_CONNECTIONS, nodeIndices: FACE_NODE_INDICES,
      minimumVisibleNodes: 4, defaultVisibleNodes: 18, defaultLineWidth: 1, defaultNodeSize: 0.9, defaultTrailLength: 0.65,
      overlayLineDefault: 1.5, overlayLineMaximum: 2.5,
      overlayNodeDefault: 2, overlayNodeMaximum: 3.65, overlayTrailWidth: 1.25
    }),
    pose: Object.freeze({
      kind: 'pose', topology: 'vrch.pose-landmarks@1', maximumTracks: 1,
      minimumLandmarks: 33, maximumLandmarks: 33, textureWidth: 64,
      modelUrl: 'models/mediapipe/pose_landmarker-lite-float16-v1.task',
      connections: POSE_CONNECTIONS, nodeIndices: POSE_NODE_INDICES,
      minimumVisibleNodes: 8, defaultVisibleNodes: 33, defaultLineWidth: 1, defaultNodeSize: 1, defaultTrailLength: 0.75,
      overlayLineDefault: 3.12, overlayLineMaximum: 9.6,
      overlayNodeDefault: 3.64, overlayNodeMaximum: 11.2, overlayTrailWidth: 1.75
    })
  });

  const DEFAULTS = Object.freeze({
    targetHz: 15,
    // Measured on vrch-110 (CM5, 4x A76, V3D) at the product 360x360 render size:
    // 0.8 raises hand/face/body update rates and cuts face and one-hand latency
    // without changing p95 frame time. 0.5 left the worker idle for a full
    // inference period after every result.
    maxDutyCycle: 0.8,
    staleTtlMs: 250,
    trackRetentionMs: 2500,
    historyMs: 600,
    overlaySize: 256,
    maxInputDimension: 192,
    preferredDelegate: 'CPU',
    workerUrl: '/scripts/vrch_pages_landmark_worker.js?v=20261020-shader-tracking-a2',
    pageHostUrl: '/vrch_landmark_host.html?v=20261020-shader-tracking-a2',
    bundleUrl: '/vendor/mediapipe/tasks-vision-1.0.1/vision_bundle.js',
    wasmBaseUrl: '/vendor/mediapipe/tasks-vision-1.0.1/wasm/'
  });

  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function nowMs() {
    return root.performance && typeof root.performance.now === 'function' ? root.performance.now() : Date.now();
  }

  function modelLoadPresentation(status) {
    const load = status && status.model_load;
    if (!load || status.state !== 'loading') return { visible: false };
    const names = { hand: 'Hand', face: 'Face', pose: 'Body' };
    const name = names[status.kind] || 'Tracking';
    const progress = load.progress == null ? null : Math.max(0, Math.min(1, Number(load.progress) || 0));
    if (load.stage === 'downloading') {
      return {
        visible: true,
        title: `Loading ${name} Model`,
        detail: progress == null ? 'Downloading' : `${Math.round(progress * 100)}%`,
        progress: progress
      };
    }
    if (load.stage === 'initializing') {
      return { visible: true, title: `Starting ${name} Tracking`, detail: 'Almost Ready', progress: null };
    }
    return { visible: true, title: `Preparing ${name} Tracking`, detail: 'Loading', progress: null };
  }

  function createModelLoadOverlay(container) {
    if (!container || !root.document || typeof root.document.createElement !== 'function') return null;
    const overlay = root.document.createElement('div');
    overlay.className = 'ui-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.pointerEvents = 'none';
    overlay.innerHTML = '<div class="ui-overlay__box"><div class="overlayOne"></div><div class="overlayTwo"></div><div class="ui-overlay__progress ui-overlay__progress--quiet" role="progressbar" aria-label="Model loading progress" aria-valuemin="0" aria-valuemax="100"><span class="ui-overlay__progress-bar"></span></div></div>';
    container.appendChild(overlay);
    return {
      element: overlay,
      title: overlay.querySelector('.overlayOne'),
      detail: overlay.querySelector('.overlayTwo'),
      progress: overlay.querySelector('.ui-overlay__progress'),
      progressBar: overlay.querySelector('.ui-overlay__progress-bar')
    };
  }

  function renderModelLoadOverlay(view, status) {
    if (!view || !view.element) return;
    const presentation = modelLoadPresentation(status);
    view.element.classList.toggle('show', !!presentation.visible);
    view.element.setAttribute('aria-hidden', String(!presentation.visible));
    if (!presentation.visible) return;
    if (view.title) view.title.textContent = presentation.title;
    if (view.detail) view.detail.textContent = presentation.detail;
    const determinate = presentation.progress != null;
    if (view.progress) {
      if (determinate) view.progress.setAttribute('aria-valuenow', String(Math.round(presentation.progress * 100)));
      else view.progress.removeAttribute('aria-valuenow');
    }
    if (view.progressBar) {
      if (determinate) {
        view.progressBar.style.animation = 'none';
        view.progressBar.style.left = '0';
        view.progressBar.style.width = `${Math.round(presentation.progress * 100)}%`;
      } else {
        view.progressBar.style.removeProperty('animation');
        view.progressBar.style.removeProperty('left');
        view.progressBar.style.removeProperty('width');
      }
    }
  }

  function parameterGeometry(control, controlDefault, geometryDefault, geometryMaximum) {
    const value = Math.max(0, Math.min(2, Number(control) || 0));
    const pivot = Math.max(0.001, Math.min(1.999, Number(controlDefault) || 1));
    if (value <= pivot) return geometryDefault * (value / pivot);
    return geometryDefault + (geometryMaximum - geometryDefault) * ((value - pivot) / (2 - pivot));
  }

  function analysisRequirement(definition) {
    return ((definition && definition.analysis_requirements) || []).find((item) => item && ANALYZERS[item.kind]) || null;
  }

  // A visual that reads only the scalar summary (centre, confidence, speed)
  // has no per-track output, so it needs one track. MediaPipe runs its palm
  // detector on every frame while fewer hands than requested are tracked;
  // asking for one hand lets the tracker stay in its cheaper tracking mode.
  function trackLimit(definition, descriptor) {
    if (!descriptor || descriptor.maximumTracks <= 1) return descriptor ? descriptor.maximumTracks : 1;
    const prefix = 'tracking.' + descriptor.kind;
    const perTrack = ((definition && definition.signals) || []).some((signal) => signal && (signal.id === prefix + '-overlay' || signal.id === prefix + '-landmarks'));
    return perTrack ? descriptor.maximumTracks : 1;
  }

  function absoluteSameOrigin(path) {
    const url = new URL(path, root.location && root.location.href ? root.location.href : 'http://localhost/');
    if (root.location && url.origin !== root.location.origin) throw new Error('Frame-analysis assets must use the Viewer origin.');
    return url.href;
  }

  // Some WebKit runtimes expose Worker/WASM but no Worker WebGL. Keep that
  // fallback's MediaPipe globals and resources isolated in a disposable frame.
  class PageAnalysisWorker {
    constructor(url) {
      this.frame = root.document.createElement('iframe');
      this.frame.hidden = true;
      this.frame.title = 'Tracking processor';
      this.queue = [];
      this.loaded = false;
      this.origin = new URL(url).origin;
      this.listener = (event) => {
        if (this.frame && event.source === this.frame.contentWindow && event.origin === this.origin && this.onmessage) this.onmessage(event);
      };
      root.addEventListener('message', this.listener);
      this.frame.onload = () => {
        if (!this.frame) return;
        if (typeof this.frame.contentWindow.onmessage !== 'function') {
          if (this.onerror) this.onerror({ message: 'Could not initialize the tracking processor.' });
          return;
        }
        this.loaded = true;
        this.queue.splice(0).forEach(([message, transfer]) => this.postMessage(message, transfer));
      };
      this.frame.onerror = () => { if (this.onerror) this.onerror({ message: 'Could not load the tracking processor.' }); };
      this.frame.src = url;
      (root.document.body || root.document.documentElement).appendChild(this.frame);
    }

    postMessage(message, transfer) {
      if (!this.frame) return;
      if (!this.loaded) { this.queue.push([message, transfer]); return; }
      this.frame.contentWindow.postMessage(message, this.origin, transfer || []);
    }

    terminate() {
      root.removeEventListener('message', this.listener);
      this.queue.splice(0).forEach(([message]) => { if (message.bitmap && message.bitmap.close) message.bitmap.close(); });
      if (this.frame) this.frame.remove();
      this.frame = null;
    }
  }

  function landmarkTextureTracks(tracks, analyzer) {
    const limited = (tracks || []).slice(0, analyzer.maximumTracks);
    if (analyzer.kind !== 'hand') return limited;
    const rows = Array.from({ length: analyzer.maximumTracks }, () => null);
    const deferred = [];
    limited.forEach((track) => {
      const handedness = normalizeHandedness(track && track.handedness);
      const rowIndex = handedness === 'Left' ? 0 : (handedness === 'Right' ? 1 : -1);
      if (rowIndex >= 0 && rowIndex < rows.length && !rows[rowIndex]) rows[rowIndex] = track;
      else deferred.push(track);
    });
    deferred.sort((left, right) => trackCentroid(left)[0] - trackCentroid(right)[0]);
    deferred.forEach((track) => {
      const rowIndex = rows.findIndex((row) => !row);
      if (rowIndex >= 0) rows[rowIndex] = track;
    });
    return rows;
  }

  function makeLandmarkTexture(tracks, descriptor, target) {
    const analyzer = descriptor && descriptor.textureWidth ? descriptor : ANALYZERS.hand;
    const width = analyzer.textureWidth;
    const height = analyzer.maximumTracks;
    const output = target && target.data instanceof Float32Array && target.data.length === width * height * 4
      ? target
      : { data: new Float32Array(width * height * 4), width: width, height: height };
    const data = output.data;
    data.fill(0);
    landmarkTextureTracks(tracks, analyzer).forEach((track, trackIndex) => {
      if (!track) return;
      (track.landmarks || []).slice(0, analyzer.maximumLandmarks).forEach((point, pointIndex) => {
        const offset = (trackIndex * width + pointIndex) * 4;
        data[offset] = Number(point[0]) || 0;
        data[offset + 1] = Number(point[1]) || 0;
        data[offset + 2] = Number(point[2]) || 0;
        data[offset + 3] = Number.isFinite(Number(point[3])) ? Number(point[3]) : (Number(track.confidence) || 0);
      });
    });
    return output;
  }

  function normalizeRotation(value) {
    const rotation = Number(value) || 0;
    return [0, 90, 180, 270].includes(rotation) ? rotation : 0;
  }

  function normalizeHandedness(value) {
    const handedness = String(value || '').toLowerCase();
    if (handedness === 'left') return 'Left';
    if (handedness === 'right') return 'Right';
    return 'Unknown';
  }

  function trackCentroid(track) {
    const points = (track && track.landmarks) || [];
    if (!points.length) return [0.5, 0.5];
    let x = 0;
    let y = 0;
    points.forEach((point) => {
      x += Number(point[0]) || 0;
      y += Number(point[1]) || 0;
    });
    return [x / points.length, y / points.length];
  }

  // Body landmarks 15/16 are the wrists and 17-22 the pinky, index and thumb
  // knuckles. Their visibility-weighted mean places each hand from the same
  // body inference, so visuals that only follow hand positions do not need
  // the separate, slower two-hand model.
  const POSE_HAND_POINTS = Object.freeze([Object.freeze([15, 17, 19, 21]), Object.freeze([16, 18, 20, 22])]);
  const POSE_HAND_MIN_VISIBILITY = 0.5;

  function poseHands(track) {
    const points = (track && track.landmarks) || [];
    return POSE_HAND_POINTS.map((indices) => {
      let weight = 0;
      let x = 0;
      let y = 0;
      indices.forEach((index) => {
        const point = points[index];
        if (!point) return;
        const visibility = Math.max(0, Math.min(1, Number.isFinite(Number(point[3])) ? Number(point[3]) : 0));
        weight += visibility;
        x += (Number(point[0]) || 0) * visibility;
        y += (Number(point[1]) || 0) * visibility;
      });
      const visibility = weight / indices.length;
      return visibility >= POSE_HAND_MIN_VISIBILITY ? { x: x / weight, y: y / weight, visibility: visibility } : null;
    });
  }

  function transformPoint(point, mirrored, rotation) {
    let x = Math.max(0, Math.min(1, Number(point && point[0]) || 0));
    let y = Math.max(0, Math.min(1, Number(point && point[1]) || 0));
    if (rotation === 90) [x, y] = [y, 1 - x];
    else if (rotation === 180) [x, y] = [1 - x, 1 - y];
    else if (rotation === 270) [x, y] = [1 - y, x];
    if (mirrored) x = 1 - x;
    return [x, y, Number(point && point[2]) || 0, Number.isFinite(Number(point && point[3])) ? Number(point[3]) : 1];
  }

  class FrameAnalysisController {
    constructor(options) {
      const input = options || {};
      this.runtime = input.runtime || null;
      this.config = Object.assign({}, DEFAULTS, input.config || {});
      this.WorkerCtor = input.WorkerCtor || root.Worker;
      this.resolveResourceUrl = input.resolveResourceUrl || absoluteSameOrigin;
      this.cacheWorkers = input.cacheWorkers !== false;
      this.PageWorkerCtor = input.PageWorkerCtor === null ? null : input.PageWorkerCtor || (root.document ? PageAnalysisWorker : null);
      this.workerWebGlUnavailable = false;
      this.createBitmap = input.createImageBitmap || root.createImageBitmap;
      this.onStatus = typeof input.onStatus === 'function' ? input.onStatus : null;
      // Analyzer models are page-session resources, not visual-instance
      // resources. Keep one initialized worker per kind so switching visuals
      // never re-fetches or re-initializes a model that this page has used.
      this.workerCache = new Map();
      this.activeWorkerRecord = null;
      this.pendingFrame = null;
      this.pendingDrainTimer = null;
      this.suspended = false;
      this.generation = 0;
      this.frameId = 0;
      this.lastSubmittedAt = -Infinity;
      this.lastOfferedAt = -Infinity;
      this.lastResultAt = 0;
      this.lastTracks = [];
      this.lastResult = null;
      this.landmarkTexture = null;
      this.lastCentroid = null;
      this.lastHands = null;
      this.activeTracks = [];
      this.nextTrackId = 1;
      this.trails = [];
      this.requirement = null;
      this.sceneId = null;
      this.descriptor = null;
      this.trackLimit = 1;
      this.sourceSlot = null;
      this.sourceRevision = 0;
      this.sourceGeneration = null;
      this.staleTimer = null;
      this.status = this._makeStatus('idle', 0, null);
      this.overlayCanvas = input.overlayCanvas || this._makeCanvas(this.config.overlaySize);
      this.overlayContext = this.overlayCanvas && this.overlayCanvas.getContext ? this.overlayCanvas.getContext('2d', { alpha: true }) : null;
      this._clearOutput(false);
    }

    _makeCanvas(size) {
      if (!root.document || typeof root.document.createElement !== 'function') return null;
      const canvas = root.document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      return canvas;
    }

    _makeStatus(state, trackCount, error, latest, durationMs) {
      const kind = this.descriptor ? this.descriptor.kind : null;
      const workerRecord = this.activeWorkerRecord;
      const modelLoad = workerRecord && !workerRecord.ready ? {
        stage: workerRecord.loadStage || 'preparing',
        loaded_bytes: Math.max(0, Number(workerRecord.loadedBytes) || 0),
        total_bytes: Math.max(0, Number(workerRecord.totalBytes) || 0) || null,
        progress: workerRecord.loadProgress != null && Number.isFinite(Number(workerRecord.loadProgress))
          ? Math.max(0, Math.min(1, Number(workerRecord.loadProgress)))
          : null
      } : null;
      return {
        state: state,
        kind: kind,
        source_slot: this.sourceSlot,
        source_generation: latest ? latest.source_generation : this.sourceGeneration,
        frame_id: latest ? latest.frame_id : null,
        captured_at_ms: latest ? latest.captured_at_ms : null,
        completed_at_ms: latest ? latest.completed_at_ms : null,
        tracks: trackCount || 0,
        hands: kind === 'hand' ? (trackCount || 0) : 0,
        duration_ms: durationMs == null ? null : durationMs,
        delegate: this.activeWorkerRecord ? this.activeWorkerRecord.delegate : null,
        execution: this.activeWorkerRecord ? this.activeWorkerRecord.execution : null,
        model_load: modelLoad,
        error: error || null
      };
    }

    _notifyStatus() {
      if (!this.onStatus) return;
      try { this.onStatus(clone(this.status)); } catch (_) {}
    }

    _setStatus(status) {
      this.status = status;
      this._notifyStatus();
      return status;
    }

    setRuntime(runtime) {
      this.runtime = runtime || null;
      if (this.runtime && this.lastTracks.length) this._publish(this.lastTracks, 0);
    }

    refreshOverlay() {
      if (this.suspended) return false;
      const descriptor = this.descriptor;
      if (!descriptor || !this.overlayConsumed || !this.lastTracks.length || !this.overlayCanvas) return false;
      this._drawOverlay(this.lastTracks, nowMs(), false);
      if (this.runtime && typeof this.runtime.setSignalTexture === 'function') {
        this.runtime.setSignalTexture('tracking.' + descriptor.kind + '-overlay', this.overlayCanvas);
      }
      return true;
    }

    _visualParameter(key, fallback, minimum, maximum) {
      const active = this.runtime && this.runtime.active;
      const params = active && active.instance && active.instance.params;
      const value = Number(params && params[key]);
      if (!Number.isFinite(value)) return fallback;
      return Math.max(minimum, Math.min(maximum, value));
    }

    sync(definition, sourceBindingState) {
      const previousDescriptor = this.descriptor;
      // The 2D overlay costs a GPU raster per result; draw it only for a Visual
      // that samples it (tracking.<kind>-overlay), not for scalar-only Visuals.
      this.overlayConsumed = false;
      const requirement = analysisRequirement(definition);
      const nextDescriptor = requirement ? ANALYZERS[requirement.kind] : null;
      const binding = sourceBindingState && sourceBindingState.source_bindings ? sourceBindingState.source_bindings : { 0: 'A', 1: 'B' };
      const inputIndex = requirement ? Math.max(0, Math.min(1, Number(requirement.source_input) || 0)) : 0;
      const nextSlot = requirement ? (binding[inputIndex] === 'B' ? 'B' : 'A') : null;
      const nextTrackLimit = requirement ? trackLimit(definition, nextDescriptor) : 1;
      const changed = nextSlot !== this.sourceSlot || nextTrackLimit !== this.trackLimit || JSON.stringify(requirement) !== JSON.stringify(this.requirement);
      if (!requirement) {
        if (this.requirement) {
          this.generation += 1;
          this._clearPending();
          this._clearOutput(true);
          this._deactivateWorker();
        }
        this.requirement = null;
        this.sceneId = null;
        this.descriptor = null;
        this.trackLimit = 1;
        this.sourceSlot = null;
        this._setStatus(this._makeStatus('idle', 0, null));
        return false;
      }
      if (changed) {
        this.generation += 1;
        this.sourceRevision += 1;
        this.sourceGeneration = null;
        this.lastOfferedAt = -Infinity;
        if (this.activeWorkerRecord) this.activeWorkerRecord.nextSubmitAt = -Infinity;
        this._clearPending();
        this._clearOutput(true);
        if (previousDescriptor && (previousDescriptor.kind !== nextDescriptor.kind || nextTrackLimit !== this.trackLimit)) this._deactivateWorker();
      }
      const retryFailed = changed || this.sceneId !== (definition.scene_id || null);
      this.sceneId = definition.scene_id || null;
      this.requirement = clone(requirement);
      this.descriptor = nextDescriptor;
      this.overlayConsumed = ((definition && definition.signals) || []).some((signal) => signal && signal.type === 'texture' && signal.id === 'tracking.' + nextDescriptor.kind + '-overlay');
      this.trackLimit = nextTrackLimit;
      this.sourceSlot = nextSlot;
      if (!this.landmarkTexture || changed) this.landmarkTexture = makeLandmarkTexture([], this.descriptor);
      if (!this.trails.length || changed) this.trails = Array.from({ length: this.descriptor.maximumTracks }, () => []);
      if (!this.suspended) this._ensureWorker(retryFailed);
      if (!this.suspended && this.activeWorkerRecord && this.activeWorkerRecord.error) {
        this._setStatus(this._makeStatus('error', 0, this.activeWorkerRecord.error));
        return true;
      }
      if (changed) {
        this._setStatus(this._makeStatus(this.suspended ? 'suspended' : (this.activeWorkerRecord && this.activeWorkerRecord.ready ? 'ready' : 'loading'), 0, null));
      } else {
        this.status.kind = this.descriptor.kind;
        this.status.source_slot = this.sourceSlot;
        if (this.suspended) this.status.state = 'suspended';
        else if ((!this.activeWorkerRecord || !this.activeWorkerRecord.ready) && this.status.state !== 'error') this.status.state = 'loading';
        this.status.model_load = this._makeStatus(this.status.state, this.status.tracks, this.status.error).model_load;
        this._notifyStatus();
      }
      return true;
    }

    _ensureWorker(retryFailed) {
      if (!this.descriptor) return;
      const workerKey = this.descriptor.kind + ':' + this.trackLimit;
      let cached = this.workerCache.get(workerKey);
      if (cached && cached.error && retryFailed) {
        this._dropWorkerRecord(cached);
        cached = null;
      }
      if (cached) {
        this.activeWorkerRecord = cached;
        return;
      }
      const record = {
        kind: this.descriptor.kind,
        key: workerKey,
        worker: null,
        error: null,
        execution: this.workerWebGlUnavailable ? 'page' : 'worker',
        ready: false,
        busy: false,
        delegate: null,
        loadStage: 'preparing',
        loadedBytes: 0,
        totalBytes: null,
        loadProgress: null,
        nextSubmitAt: -Infinity
      };
      this.workerCache.set(record.key, record);
      this.activeWorkerRecord = record;
      if (!this.WorkerCtor) {
        this._failWorkerRecord(record, 'worker-unavailable', 'Frame analysis needs Web Worker support.');
        return;
      }
      try {
        const worker = record.execution === 'page'
          ? new this.PageWorkerCtor(this.resolveResourceUrl(this.config.pageHostUrl))
          : new this.WorkerCtor(this.resolveResourceUrl(this.config.workerUrl));
        record.worker = worker;
        worker.onmessage = (event) => this._onWorkerMessage(record, event && event.data ? event.data : {});
        worker.onerror = (event) => this._onWorkerError(record, event);
        worker.postMessage({
          type: 'init',
          kind: record.kind,
          generation: this.generation,
          maximumTracks: this.trackLimit,
          delegate: this.config.preferredDelegate,
          bundleUrl: this.resolveResourceUrl(this.config.bundleUrl),
          wasmBaseUrl: this.resolveResourceUrl(this.config.wasmBaseUrl),
          modelUrl: this.resolveResourceUrl(this.config.modelUrl || '/' + this.descriptor.modelUrl.replace(/^\/+/, ''))
        });
      } catch (error) {
        this._failWorkerRecord(record, 'worker-init-failed', error.message || String(error));
      }
    }

    _deactivateWorker() {
      if (this.activeWorkerRecord && (!this.cacheWorkers || this.activeWorkerRecord.error)) this._dropWorkerRecord(this.activeWorkerRecord);
      this.activeWorkerRecord = null;
      this._clearPending();
    }

    _dropWorkerRecord(record) {
      if (!record) return;
      if (record.worker) { try { record.worker.terminate(); } catch (_) {} }
      if (this.workerCache.get(record.key) === record) this.workerCache.delete(record.key);
      if (this.activeWorkerRecord === record) this.activeWorkerRecord = null;
      record.worker = null;
      record.ready = false;
      record.busy = false;
      record.delegate = null;
      record.nextSubmitAt = -Infinity;
    }

    _disposeWorker() {
      Array.from(this.workerCache.values()).forEach((record) => this._dropWorkerRecord(record));
      this.workerCache.clear();
      this.activeWorkerRecord = null;
      this._clearPending();
    }

    _onWorkerError(record, event) {
      if (this.workerCache.get(record.key) !== record || record.error) return;
      this._failWorkerRecord(record, 'worker-error', event && event.message ? event.message : 'Landmark analysis worker failed.');
    }

    _failWorkerRecord(record, code, message) {
      const isActive = this.activeWorkerRecord === record;
      this._dropWorkerRecord(record);
      record.error = { code: code || record.kind + '-analysis-failed', message: message || 'Landmark analysis failed.' };
      // Retain the failure, not the Worker: sync runs on every video frame.
      // A different visual or a resumed consumer can explicitly retry it.
      this.workerCache.set(record.key, record);
      if (isActive) {
        this.activeWorkerRecord = record;
        this._clearPending();
        this._clearOutput(true);
        this._fail(record.error.code, record.error.message);
      }
    }

    async offerFrame(sourceSlot, source, metadata) {
      if (this.suspended) return false;
      if (!this.requirement || sourceSlot !== this.sourceSlot || !source || !this.createBitmap) return false;
      if (this.activeWorkerRecord && this.activeWorkerRecord.error) return false;
      const metadataGeneration = Number(metadata && metadata.source_generation);
      if (Number.isInteger(metadataGeneration) && metadataGeneration >= 0) {
        if (this.sourceGeneration !== null && metadataGeneration !== this.sourceGeneration) {
          this.invalidateSource(sourceSlot, metadataGeneration, 'source-generation-changed');
        } else {
          this.sourceGeneration = metadataGeneration;
        }
      }
      const now = Number(metadata && metadata.timestamp) || nowMs();
      const minimumInterval = 1000 / Math.max(1, Number(this.config.targetHz) || 20);
      if (now - this.lastOfferedAt < minimumInterval) return false;
      this.lastOfferedAt = now;
      const generation = this.generation, sourceRevision = this.sourceRevision;
      let bitmap;
      const sourceWidth = Math.max(1, Number(source.videoWidth || source.naturalWidth || source.width) || 1);
      const sourceHeight = Math.max(1, Number(source.videoHeight || source.naturalHeight || source.height) || 1);
      const maxInputDimension = Math.max(64, Number(this.config.maxInputDimension) || 192);
      const resizeScale = Math.min(1, maxInputDimension / Math.max(sourceWidth, sourceHeight));
      try {
        bitmap = resizeScale < 1
          ? await this.createBitmap.call(root, source, {
              resizeWidth: Math.max(1, Math.round(sourceWidth * resizeScale)),
              resizeHeight: Math.max(1, Math.round(sourceHeight * resizeScale)),
              resizeQuality: 'low'
            })
          : await this.createBitmap.call(root, source);
      } catch (error) {
        if (this.suspended || this.generation !== generation || this.sourceRevision !== sourceRevision) return false;
        this._fail('frame-clone-failed', error.message || String(error));
        return false;
      }
      if (this.suspended || this.generation !== generation || this.sourceRevision !== sourceRevision) {
        bitmap.close();
        return false;
      }
      const frame = {
        bitmap: bitmap,
        sourceSlot: sourceSlot,
        timestamp: now,
        frameId: ++this.frameId,
        sourceRevision: this.sourceRevision,
        sourceGeneration: this.sourceGeneration === null ? this.sourceRevision : this.sourceGeneration,
        sourceWidth: sourceWidth,
        sourceHeight: sourceHeight,
        mirrored: !!(metadata && metadata.mirrored),
        rotation: normalizeRotation(metadata && metadata.rotation),
        generation: this.generation
      };
      const record = this.activeWorkerRecord;
      if (!record || record.busy || !record.ready || nowMs() < record.nextSubmitAt) {
        this._queuePending(frame);
        return true;
      }
      this._submit(frame);
      return true;
    }

    _submit(frame) {
      if (this.suspended) {
        if (frame && frame.bitmap && typeof frame.bitmap.close === 'function') frame.bitmap.close();
        return;
      }
      const record = this.activeWorkerRecord;
      if (!record || !record.worker || !record.ready || !frame) return;
      record.busy = true;
      this.lastSubmittedAt = frame.timestamp;
      this._setStatus(this._makeStatus('running', this.lastTracks.length, null, this.lastResult));
      record.worker.postMessage(Object.assign({ type: 'frame' }, frame), [frame.bitmap]);
    }

    _queuePending(frame) {
      if (this.pendingFrame && this.pendingFrame.bitmap && typeof this.pendingFrame.bitmap.close === 'function') this.pendingFrame.bitmap.close();
      this.pendingFrame = frame;
      this._schedulePendingDrain();
    }

    _schedulePendingDrain() {
      if (this.suspended) return;
      const record = this.activeWorkerRecord;
      if (!this.pendingFrame || !record || !record.ready || record.busy || this.pendingDrainTimer) return;
      const waitMs = Math.max(0, record.nextSubmitAt - nowMs());
      if (waitMs <= 0) {
        this._drainPending();
        return;
      }
      this.pendingDrainTimer = setTimeout(() => {
        this.pendingDrainTimer = null;
        this._drainPending();
      }, Math.max(1, Math.ceil(waitMs)));
    }

    _drainPending() {
      if (this.suspended) return;
      const record = this.activeWorkerRecord;
      if (!this.pendingFrame || !record || !record.ready || record.busy) return;
      if (nowMs() < record.nextSubmitAt) {
        this._schedulePendingDrain();
        return;
      }
      const frame = this.pendingFrame;
      this.pendingFrame = null;
      this._submit(frame);
    }

    _onWorkerMessage(record, payload) {
      if (this.workerCache.get(record.key) !== record || record.error) return;
      if (payload.type === 'model-progress') {
        if (payload.kind && payload.kind !== record.kind) return;
        record.loadStage = ['preparing', 'downloading', 'initializing'].includes(payload.stage) ? payload.stage : 'preparing';
        record.loadedBytes = Math.max(0, Number(payload.loadedBytes) || 0);
        record.totalBytes = Math.max(0, Number(payload.totalBytes) || 0) || null;
        record.loadProgress = payload.progress != null && Number.isFinite(Number(payload.progress))
          ? Math.max(0, Math.min(1, Number(payload.progress)))
          : null;
        if (this.activeWorkerRecord === record) this._setStatus(this._makeStatus('loading', 0, null));
        return;
      }
      if (payload.type === 'ready') {
        if (payload.kind && payload.kind !== record.kind) return;
        record.ready = true;
        record.delegate = payload.delegate || null;
        record.loadStage = 'ready';
        record.loadProgress = 1;
        if (this.activeWorkerRecord !== record) return;
        this._setStatus(this._makeStatus(this.suspended ? 'suspended' : 'ready', 0, null));
        if (!this.suspended) this._drainPending();
        return;
      }
      if (payload.type === 'error') {
        record.busy = false;
        const isActive = this.activeWorkerRecord === record;
        if (!record.ready && record.execution === 'worker' && payload.code === 'worker-webgl-unavailable' && this.PageWorkerCtor) {
          this.workerWebGlUnavailable = true;
          this._dropWorkerRecord(record);
          if (isActive && !this.suspended) {
            this._ensureWorker();
            const error = this.activeWorkerRecord && this.activeWorkerRecord.error;
            this._setStatus(this._makeStatus(error ? 'error' : 'loading', 0, error));
          }
          return;
        }
        if (!record.ready) {
          // Init belongs to the model, not the source frame generation. A
          // source reconnect during loading must not swallow its failure.
          this._failWorkerRecord(record, payload.code, payload.message);
          return;
        }
        if (!isActive) return;
        if (Number(payload.generation) === this.generation) this._fail(payload.code, payload.message);
        this._drainPending();
        return;
      }
      if (payload.type !== 'result') return;
      record.busy = false;
      const durationMs = Math.max(0, Number(payload.durationMs) || 0);
      const maxDutyCycle = Math.max(0.1, Math.min(record.execution === 'page' ? 0.3 : 1, Number(this.config.maxDutyCycle) || 0.5));
      record.nextSubmitAt = nowMs() + durationMs * (1 / maxDutyCycle - 1);
      if (this.activeWorkerRecord !== record) return;
      if (this.suspended) return;
      if (this.descriptor && payload.kind === this.descriptor.kind && Number(payload.generation) === this.generation && payload.sourceSlot === this.sourceSlot && Number(payload.sourceRevision) === this.sourceRevision) {
        this.lastResultAt = nowMs();
        const transformed = (Array.isArray(payload.tracks) ? payload.tracks : []).map((track) => Object.assign({}, track, {
          landmarks: (track.landmarks || []).map((point) => transformPoint(point, !!payload.mirrored, normalizeRotation(payload.rotation)))
        }));
        this.lastTracks = this._assignTracks(transformed, this.lastResultAt);
        // The worker clock has a different time origin; completion is the
        // moment the result reaches this thread, in the capture clock domain.
        this.lastResult = this._makeResult(Object.assign({}, payload, { completedAtMs: this.lastResultAt }), this.lastTracks);
        this._publish(this.lastTracks, durationMs, this.lastResult);
      }
      this._drainPending();
    }

    _assignTracks(tracks, now) {
      const descriptor = this.descriptor;
      const retentionMs = Math.max(Number(this.config.staleTtlMs) || 250, Number(this.config.trackRetentionMs) || 2500);
      const recent = this.activeTracks.filter((track) => now - track.last_seen_at <= retentionMs);
      const used = new Set();
      const next = (tracks || []).slice(0, descriptor.maximumTracks).map((track) => {
        const centroid = trackCentroid(track);
        const handedness = descriptor.kind === 'hand' ? normalizeHandedness(track && track.handedness) : 'Unknown';
        let match = null;
        let bestCost = Infinity;
        recent.forEach((candidate) => {
          if (used.has(candidate.track_id)) return;
          const handednessPenalty = candidate.handedness === 'Unknown' || handedness === 'Unknown' || candidate.handedness === handedness ? 0 : 0.25;
          const cost = Math.hypot(centroid[0] - candidate.centroid[0], centroid[1] - candidate.centroid[1]) + handednessPenalty;
          if (cost < bestCost) { bestCost = cost; match = candidate; }
        });
        const trackId = match && bestCost <= 0.5 ? match.track_id : descriptor.kind + '-' + this.nextTrackId++;
        used.add(trackId);
        return Object.assign({}, track, { track_id: trackId, handedness: handedness, _centroid: centroid });
      });
      const current = next.map((track) => ({
        track_id: track.track_id,
        handedness: track.handedness,
        centroid: track._centroid,
        last_seen_at: now
      }));
      this.activeTracks = current.concat(recent.filter((track) => !used.has(track.track_id))).slice(0, descriptor.maximumTracks * 2);
      return next.map((track) => {
        const output = Object.assign({}, track);
        delete output._centroid;
        return output;
      });
    }

    _makeResult(payload, tracks) {
      const descriptor = this.descriptor;
      const completedAt = Number(payload.completedAtMs);
      const duration = Math.max(0, Number(payload.durationMs) || 0);
      const capturedAt = Math.max(0, Number(payload.capturedAtMs == null ? payload.timestamp : payload.capturedAtMs) || 0);
      return {
        schema_version: 1,
        analyzer: descriptor.kind,
        topology: descriptor.topology,
        source_slot: this.sourceSlot,
        source_generation: Math.max(0, Number(payload.sourceGeneration == null ? this.sourceGeneration : payload.sourceGeneration) || 0),
        frame_id: Math.max(1, Number(payload.frameId) || 1),
        captured_at_ms: capturedAt,
        completed_at_ms: Math.max(capturedAt, Number.isFinite(completedAt) ? completedAt : capturedAt + duration),
        duration_ms: duration,
        input: {
          width: Math.max(1, Math.round(Number(payload.sourceWidth) || 1)),
          height: Math.max(1, Math.round(Number(payload.sourceHeight) || 1)),
          mirrored: !!payload.mirrored,
          rotation: normalizeRotation(payload.rotation)
        },
        tracks: (tracks || []).filter((track) => {
          const length = Array.isArray(track.landmarks) ? track.landmarks.length : 0;
          return length >= descriptor.minimumLandmarks && length <= descriptor.maximumLandmarks;
        }).map((track) => ({
          track_id: track.track_id,
          handedness: normalizeHandedness(track.handedness),
          confidence: Math.max(0, Math.min(1, Number(track.confidence) || 0)),
          landmarks: track.landmarks.map((point) => ({
            x: Math.max(0, Math.min(1, Number(point[0]) || 0)),
            y: Math.max(0, Math.min(1, Number(point[1]) || 0)),
            z: Number(point[2]) || 0,
            visibility: Math.max(0, Math.min(1, Number.isFinite(Number(point[3])) ? Number(point[3]) : 1))
          }))
        }))
      };
    }

    _publish(tracks, durationMs, result) {
      const descriptor = this.descriptor;
      if (!descriptor) return;
      const now = nowMs();
      if (this.overlayConsumed) this._drawOverlay(tracks, now);
      let confidence = 0;
      let centroid = null;
      let count = 0;
      (tracks || []).forEach((track) => {
        confidence = Math.max(confidence, Number(track.confidence) || 0);
        (track.landmarks || []).forEach((point) => {
          if (!centroid) centroid = [0, 0];
          centroid[0] += Number(point[0]) || 0;
          centroid[1] += Number(point[1]) || 0;
          count += 1;
        });
      });
      if (centroid && count) { centroid[0] /= count; centroid[1] /= count; }
      const elapsed = Math.max(1, now - (this.lastCentroid ? this.lastCentroid.at : now));
      const speed = centroid && this.lastCentroid
        ? Math.min(1, Math.hypot(centroid[0] - this.lastCentroid.x, centroid[1] - this.lastCentroid.y) / (elapsed / 1000) / 3)
        : 0;
      // A single missed inference must not erase motion continuity. Keep the
      // last observed centroid until the normal stale/source-reset path clears
      // it, so the next valid result can still report bounded movement.
      if (centroid) this.lastCentroid = { x: centroid[0], y: centroid[1], at: now };
      const prefix = 'tracking.' + descriptor.kind;
      if (this.runtime) {
        const values = {};
        values[prefix + '.center_x'] = centroid ? centroid[0] : 0;
        values[prefix + '.center_y'] = centroid ? centroid[1] : 0;
        values[prefix + '.confidence'] = confidence;
        values[prefix + '.speed'] = speed;
        if (descriptor.kind === 'pose') Object.assign(values, this._poseHandValues(tracks, now));
        this.runtime.setExternalSignals(values);
        if (this.overlayConsumed) this.runtime.setSignalTexture(prefix + '-overlay', this.overlayCanvas);
        this.landmarkTexture = makeLandmarkTexture(tracks, descriptor, this.landmarkTexture);
        this.runtime.setSignalTexture(prefix + '-landmarks', this.landmarkTexture);
      }
      const latest = result || this.lastResult;
      this._setStatus(this._makeStatus('ready', tracks.length, null, latest, durationMs));
      if (this.staleTimer) clearTimeout(this.staleTimer);
      const maxDutyCycle = Math.max(0.1, Math.min(1, Number(this.config.maxDutyCycle) || 0.5));
      const expectedCycleMs = Math.max(durationMs / maxDutyCycle, 1000 / Math.max(1, Number(this.config.targetHz) || 15));
      const staleAfterMs = Math.max(Number(this.config.staleTtlMs) || 250, expectedCycleMs * 2.25);
      this.staleTimer = setTimeout(() => {
        this._clearOutput(true);
        this._setStatus(this._makeStatus('stale', 0, null));
      }, staleAfterMs);
    }

    // Hands centre: visibility-weighted midpoint of the visible hands. While
    // the body stays tracked but both hands leave view, the centre holds its
    // last position so a fading visual does not sweep toward the corner.
    // Speed follows the faster hand that was visible in both results, so a
    // hand entering or leaving view does not read as a jump. Each hand also
    // has its own position (the subject's left / right): x holds while that
    // hand is out of view and y falls to 0, so a per-hand effect (a raised
    // peak) settles in place instead of sliding away.
    _poseHandValues(tracks, now) {
      const hands = tracks && tracks.length ? poseHands(tracks[0]) : [null, null];
      let weight = 0;
      let x = 0;
      let y = 0;
      let visibility = 0;
      hands.forEach((hand) => {
        if (!hand) return;
        weight += hand.visibility;
        x += hand.x * hand.visibility;
        y += hand.y * hand.visibility;
        visibility = Math.max(visibility, hand.visibility);
      });
      const previous = this.lastHands;
      const elapsed = Math.max(1, now - (previous ? previous.at : now));
      let speed = 0;
      if (previous) {
        hands.forEach((hand, index) => {
          const before = previous.hands[index];
          if (!hand || !before) return;
          speed = Math.max(speed, Math.min(1, Math.hypot(hand.x - before.x, hand.y - before.y) / (elapsed / 1000) / 3));
        });
      }
      const center = weight ? [x / weight, y / weight] : (previous && previous.center) || null;
      const held = hands.map((hand, index) => hand ? [hand.x, hand.y] : (previous && previous.held[index]) || null);
      this.lastHands = { hands: hands, held: held, center: center, at: now };
      const values = {
        'tracking.pose.hands_x': center ? center[0] : 0,
        'tracking.pose.hands_y': center ? center[1] : 0,
        'tracking.pose.hands_confidence': visibility,
        'tracking.pose.hands_speed': speed
      };
      ['left', 'right'].forEach((side, index) => {
        values['tracking.pose.' + side + '_hand_x'] = held[index] ? held[index][0] : 0;
        values['tracking.pose.' + side + '_hand_y'] = hands[index] ? hands[index].y : 0;
      });
      return values;
    }

    _drawOverlay(tracks, now, recordTrail) {
      const descriptor = this.descriptor;
      const ctx = this.overlayContext;
      const canvas = this.overlayCanvas;
      if (!descriptor || !ctx || !canvas) return;
      const width = canvas.width;
      const height = canvas.height;
      const lineControl = this._visualParameter('line_width', descriptor.defaultLineWidth || 1, 0, 2);
      const nodeControl = this._visualParameter('node_size', descriptor.defaultNodeSize, 0, 2);
      const trailWidthControl = this._visualParameter('trail_width', 1, 0, 2);
      const trailLengthControl = this._visualParameter('trail_length', descriptor.defaultTrailLength, 0, 1.5);
      const lineWidth = parameterGeometry(lineControl, descriptor.defaultLineWidth || 1, descriptor.overlayLineDefault, descriptor.overlayLineMaximum);
      const nodeRadius = parameterGeometry(nodeControl, descriptor.defaultNodeSize, descriptor.overlayNodeDefault, descriptor.overlayNodeMaximum);
      const trailWidth = descriptor.overlayTrailWidth * trailWidthControl;
      const visibleNodeCount = Math.round(this._visualParameter(
        'point_count',
        descriptor.defaultVisibleNodes,
        descriptor.minimumVisibleNodes,
        descriptor.nodeIndices.length
      ));
      const nodeIndices = descriptor.nodeIndices.slice(0, visibleNodeCount);
      ctx.clearRect(0, 0, width, height);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      (tracks || []).slice(0, descriptor.maximumTracks).forEach((track, trackIndex) => {
        const points = track.landmarks || [];
        if (recordTrail !== false) {
          const snapshot = {};
          descriptor.nodeIndices.forEach((pointIndex) => {
            const point = points[pointIndex];
            if (point) snapshot[pointIndex] = [point[0], point[1]];
          });
          this.trails[trackIndex].push({ points: snapshot, at: now });
        }
        const configuredHistoryMs = Number(this.requirement && this.requirement.history_ms) || this.config.historyMs;
        const historyMs = configuredHistoryMs * (trailLengthControl / descriptor.defaultTrailLength);
        this.trails[trackIndex] = this.trails[trackIndex].filter((point) => now - point.at <= historyMs);
        const trail = this.trails[trackIndex];
        if (trailWidth > 0 && trailLengthControl > 0 && trail.length > 1) {
          ctx.strokeStyle = 'rgba(0,0,255,0.72)';
          ctx.lineWidth = trailWidth;
          nodeIndices.forEach((pointIndex) => {
            let started = false;
            ctx.beginPath();
            trail.forEach((frame) => {
              const point = frame.points && frame.points[pointIndex];
              if (!point) return;
              const x = point[0] * width;
              const y = (1 - point[1]) * height;
              if (!started) ctx.moveTo(x, y); else ctx.lineTo(x, y);
              started = true;
            });
            if (started) ctx.stroke();
          });
        }
        if (lineWidth > 0) {
          ctx.strokeStyle = 'rgba(255,0,0,0.94)';
          ctx.lineWidth = lineWidth;
          descriptor.connections.forEach((connection) => {
            const a = points[connection[0]];
            const b = points[connection[1]];
            if (!a || !b) return;
            ctx.beginPath();
            ctx.moveTo(a[0] * width, (1 - a[1]) * height);
            ctx.lineTo(b[0] * width, (1 - b[1]) * height);
            ctx.stroke();
          });
        }
        if (nodeRadius > 0) {
          ctx.fillStyle = 'rgba(0,255,0,0.98)';
          nodeIndices.forEach((pointIndex) => {
            const point = points[pointIndex];
            if (!point) return;
            ctx.beginPath();
            ctx.arc(point[0] * width, (1 - point[1]) * height, nodeRadius, 0, Math.PI * 2);
            ctx.fill();
          });
        }
      });
    }

    _clearOutput(clearRuntime) {
      const descriptor = this.descriptor;
      if (this.overlayContext && this.overlayCanvas) this.overlayContext.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
      this.lastTracks = [];
      this.lastResult = null;
      this.lastCentroid = null;
      this.lastHands = null;
      this.activeTracks = [];
      this.trails = descriptor ? Array.from({ length: descriptor.maximumTracks }, () => []) : [];
      if (clearRuntime && this.runtime && descriptor) {
        const prefix = 'tracking.' + descriptor.kind;
        if (this.runtime.signalBus && typeof this.runtime.signalBus.clearExternalValues === 'function') this.runtime.signalBus.clearExternalValues(prefix + '.');
        this.runtime.setSignalTexture(prefix + '-overlay', null);
        this.runtime.setSignalTexture(prefix + '-landmarks', null);
      }
      if (this.staleTimer) { clearTimeout(this.staleTimer); this.staleTimer = null; }
    }

    _clearPending() {
      if (this.pendingDrainTimer) { clearTimeout(this.pendingDrainTimer); this.pendingDrainTimer = null; }
      if (this.pendingFrame && this.pendingFrame.bitmap && typeof this.pendingFrame.bitmap.close === 'function') this.pendingFrame.bitmap.close();
      this.pendingFrame = null;
    }

    _fail(code, message) {
      const kind = this.descriptor ? this.descriptor.kind : 'landmark';
      this._setStatus(this._makeStatus('error', 0, {
        code: code || kind + '-analysis-failed',
        message: message || (kind.charAt(0).toUpperCase() + kind.slice(1) + ' analysis failed.')
      }));
    }

    invalidateSource(sourceSlot, sourceGeneration, reason) {
      if (!this.requirement || sourceSlot !== this.sourceSlot) return false;
      this.generation += 1;
      this.sourceRevision += 1;
      this.sourceGeneration = Number.isInteger(Number(sourceGeneration)) && Number(sourceGeneration) >= 0 ? Number(sourceGeneration) : null;
      this.lastOfferedAt = -Infinity;
      if (this.activeWorkerRecord) this.activeWorkerRecord.nextSubmitAt = -Infinity;
      this._clearPending();
      this._clearOutput(true);
      if (this.activeWorkerRecord && this.activeWorkerRecord.error) {
        this._setStatus(this._makeStatus('error', 0, this.activeWorkerRecord.error));
        return true;
      }
      this._setStatus(this._makeStatus('unavailable', 0, reason ? {
        code: String(reason),
        message: 'The selected analysis source is unavailable.'
      } : null));
      return true;
    }

    getStatus() {
      return clone(this.status);
    }

    getLatestResult() {
      return this.lastResult ? clone(this.lastResult) : null;
    }

    setSuspended(value) {
      const next = !!value;
      if (next === this.suspended) return false;
      this.suspended = next;
      this.generation += 1;
      this.lastOfferedAt = -Infinity;
      this._clearPending();
      if (next) {
        this._clearOutput(true);
        this._setStatus(this._makeStatus(this.requirement ? 'suspended' : 'idle', 0, null));
        return true;
      }
      if (!this.requirement) {
        this._setStatus(this._makeStatus('idle', 0, null));
        return true;
      }
      this._ensureWorker(true);
      const error = this.activeWorkerRecord && this.activeWorkerRecord.error;
      this._setStatus(this._makeStatus(error ? 'error' : (this.activeWorkerRecord && this.activeWorkerRecord.ready ? 'ready' : 'loading'), 0, error));
      return true;
    }

    dispose() {
      this.suspended = true;
      this.generation += 1;
      this._clearPending();
      this._clearOutput(true);
      this._disposeWorker();
    }
  }

  return Object.freeze({
    FrameAnalysisController: FrameAnalysisController,
    ANALYZERS: ANALYZERS,
    HAND_CONNECTIONS: HAND_CONNECTIONS,
    FACE_CONNECTIONS: FACE_CONNECTIONS,
    POSE_CONNECTIONS: POSE_CONNECTIONS,
    makeLandmarkTexture: makeLandmarkTexture,
    modelLoadPresentation: modelLoadPresentation,
    createModelLoadOverlay: createModelLoadOverlay,
    renderModelLoadOverlay: renderModelLoadOverlay
  });
});
