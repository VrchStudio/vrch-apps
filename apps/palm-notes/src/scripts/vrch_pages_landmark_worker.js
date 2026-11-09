/* Shared landmark processor for the Worker and isolated WebKit page fallback. */
'use strict';

const VRCH_LANDMARK_WORKER = {
    ready: false,
    initializing: null,
    landmarker: null,
    lastTimestamp: -1,
    generation: 0,
    kind: null,
    maximumTracks: 1,
    delegate: null,
    canvas: null,
};

const VRCH_LANDMARK_IN_PAGE = typeof document !== 'undefined';

function postResult(message) {
    if (VRCH_LANDMARK_IN_PAGE) self.parent.postMessage(message, self.location.origin);
    else self.postMessage(message);
}

async function loadVisionBundle(url) {
    if (!VRCH_LANDMARK_IN_PAGE) { importScripts(url); return; }
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Could not load the tracking library.'));
        document.head.appendChild(script);
    });
}

function createAnalysisCanvas() {
    const canvas = VRCH_LANDMARK_IN_PAGE ? document.createElement('canvas')
        : (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : null);
    let gl = null;
    try { gl = canvas && canvas.getContext('webgl2'); } catch (_) {}
    if (!gl) throw Object.assign(new Error('Tracking needs a WebGL2 image-processing context.'), {
        code: VRCH_LANDMARK_IN_PAGE ? 'tracking-webgl-unavailable' : 'worker-webgl-unavailable',
    });
    return canvas;
}

const ANALYZER_OPTIONS = Object.freeze({
    hand: {
        constructorName: 'HandLandmarker',
        resultKey: 'landmarks',
        worldResultKey: 'worldLandmarks',
    },
    face: {
        constructorName: 'FaceLandmarker',
        resultKey: 'faceLandmarks',
        worldResultKey: null,
    },
    pose: {
        constructorName: 'PoseLandmarker',
        resultKey: 'landmarks',
        worldResultKey: 'worldLandmarks',
    },
});

function assertSameOrigin(url, label) {
    // An opaque Apps worker supplies its immutable package resource boundary.
    // Ordinary Viewer workers retain the same-origin policy below.
    if (typeof self.VrchLandmarkResolveResource === 'function') return self.VrchLandmarkResolveResource(url);
    const parsed = new URL(url, self.location.href);
    if (parsed.origin !== self.location.origin) {
        throw new Error(`${label || 'resource'} must be served from the Viewer origin`);
    }
    return parsed.href;
}

function serializeError(error, code) {
    const kind = VRCH_LANDMARK_WORKER.kind || 'landmark';
    return {
        code: code || (error && error.code) || `${kind}-analysis-failed`,
        message: (error && error.message) ? error.message : String(error || `Unknown ${kind} analysis error`),
    };
}

function taskOptions(kind, maximumTracks, modelAssetBuffer, delegate) {
    const common = {
        canvas: VRCH_LANDMARK_WORKER.canvas,
        baseOptions: { modelAssetBuffer: modelAssetBuffer, delegate: delegate },
        runningMode: 'VIDEO',
    };
    if (kind === 'hand') {
        return Object.assign(common, {
            numHands: Math.max(1, Math.min(2, maximumTracks)),
            minHandDetectionConfidence: 0.45,
            minHandPresenceConfidence: 0.45,
            minTrackingConfidence: 0.45,
        });
    }
    if (kind === 'face') {
        return Object.assign(common, {
            numFaces: Math.max(1, Math.min(2, maximumTracks)),
            minFaceDetectionConfidence: 0.45,
            minFacePresenceConfidence: 0.45,
            minTrackingConfidence: 0.45,
            outputFaceBlendshapes: false,
            outputFacialTransformationMatrixes: false,
        });
    }
    return Object.assign(common, {
        numPoses: Math.max(1, Math.min(2, maximumTracks)),
        minPoseDetectionConfidence: 0.45,
        minPosePresenceConfidence: 0.45,
        minTrackingConfidence: 0.45,
        outputSegmentationMasks: false,
    });
}

function postModelProgress(kind, stage, loadedBytes, totalBytes) {
    const loaded = Math.max(0, Number(loadedBytes) || 0);
    const total = Math.max(0, Number(totalBytes) || 0);
    postResult({
        type: 'model-progress',
        generation: VRCH_LANDMARK_WORKER.generation,
        kind: kind,
        stage: stage,
        loadedBytes: loaded,
        totalBytes: total || null,
        progress: total > 0 ? Math.max(0, Math.min(1, loaded / total)) : null,
    });
}

async function fetchModelAsset(kind, modelUrl) {
    postModelProgress(kind, 'downloading', 0, 0);
    let response;
    try {
        response = await fetch(modelUrl, { cache: 'default', credentials: 'same-origin' });
    } catch (error) {
        throw Object.assign(new Error(`Could not download the ${kind} tracking model.`), {
            code: `${kind}-model-download-failed`,
            cause: error,
        });
    }
    if (!response.ok) {
        throw Object.assign(new Error(`Could not download the ${kind} tracking model (HTTP ${response.status}).`), {
            code: `${kind}-model-download-failed`,
        });
    }

    const headerTotal = Number.parseInt(response.headers.get('content-length') || '', 10);
    const totalBytes = Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : 0;
    if (!response.body || typeof response.body.getReader !== 'function') {
        const bytes = new Uint8Array(await response.arrayBuffer());
        postModelProgress(kind, 'downloading', bytes.byteLength, totalBytes || bytes.byteLength);
        return bytes;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let loadedBytes = 0;
    let lastReportedBytes = 0;
    let lastReportedAt = performance.now();
    while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value || 0);
        if (!chunk.byteLength) continue;
        chunks.push(chunk);
        loadedBytes += chunk.byteLength;
        const now = performance.now();
        if (loadedBytes - lastReportedBytes >= 64 * 1024 || now - lastReportedAt >= 100) {
            postModelProgress(kind, 'downloading', loadedBytes, totalBytes);
            lastReportedBytes = loadedBytes;
            lastReportedAt = now;
        }
    }
    const bytes = new Uint8Array(loadedBytes);
    let offset = 0;
    chunks.forEach((chunk) => {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    });
    postModelProgress(kind, 'downloading', loadedBytes, totalBytes || loadedBytes);
    return bytes;
}

async function initialize(payload) {
    if (VRCH_LANDMARK_WORKER.ready) return;
    if (VRCH_LANDMARK_WORKER.initializing) return VRCH_LANDMARK_WORKER.initializing;
    VRCH_LANDMARK_WORKER.initializing = (async () => {
        const kind = String(payload.kind || '');
        const adapter = ANALYZER_OPTIONS[kind];
        if (!adapter) throw new Error(`Unsupported landmark analyzer: ${kind || 'missing'}`);
        VRCH_LANDMARK_WORKER.kind = kind;
        VRCH_LANDMARK_WORKER.generation = Number(payload.generation) || 0;
        postModelProgress(kind, 'preparing', 0, 0);
        const bundleUrl = assertSameOrigin(payload.bundleUrl, 'MediaPipe bundle');
        const wasmBaseUrl = assertSameOrigin(payload.wasmBaseUrl, 'MediaPipe WASM');
        const modelUrl = assertSameOrigin(payload.modelUrl, `${kind} model`);
        VRCH_LANDMARK_WORKER.canvas = createAnalysisCanvas();
        await loadVisionBundle(bundleUrl);
        const Constructor = self.Vision && self.Vision[adapter.constructorName];
        if (!self.Vision || !self.Vision.FilesetResolver || !Constructor) {
            throw new Error(`MediaPipe ${adapter.constructorName} did not initialize`);
        }
        const [fileset, modelAsset] = await Promise.all([
            self.Vision.FilesetResolver.forVisionTasks(wasmBaseUrl.replace(/\/$/, '')),
            fetchModelAsset(kind, modelUrl),
        ]);
        postModelProgress(kind, 'initializing', modelAsset.byteLength, modelAsset.byteLength);
        VRCH_LANDMARK_WORKER.maximumTracks = Math.max(1, Math.min(2, Number(payload.maximumTracks) || 1));
        const preferredDelegate = String(payload.delegate || '').toUpperCase() === 'CPU' ? 'CPU' : 'GPU';
        try {
            VRCH_LANDMARK_WORKER.landmarker = await Constructor.createFromOptions(
                fileset,
                taskOptions(kind, VRCH_LANDMARK_WORKER.maximumTracks, modelAsset.slice(), preferredDelegate),
            );
            VRCH_LANDMARK_WORKER.delegate = preferredDelegate;
        } catch (error) {
            if (preferredDelegate !== 'GPU') throw error;
            VRCH_LANDMARK_WORKER.landmarker = await Constructor.createFromOptions(
                fileset,
                taskOptions(kind, VRCH_LANDMARK_WORKER.maximumTracks, modelAsset.slice(), 'CPU'),
            );
            VRCH_LANDMARK_WORKER.delegate = 'CPU';
        }
        VRCH_LANDMARK_WORKER.ready = true;
        postResult({ type: 'ready', generation: VRCH_LANDMARK_WORKER.generation, kind, delegate: VRCH_LANDMARK_WORKER.delegate });
    })();
    try {
        await VRCH_LANDMARK_WORKER.initializing;
    } finally {
        VRCH_LANDMARK_WORKER.initializing = null;
    }
}

function pointArray(point, kind) {
    const visibilityValue = point && point.visibility;
    const presenceValue = point && point.presence;
    const poseVisibility = visibilityValue !== undefined && visibilityValue !== null && Number.isFinite(Number(visibilityValue))
        ? Number(visibilityValue)
        : (presenceValue !== undefined && presenceValue !== null && Number.isFinite(Number(presenceValue)) ? Number(presenceValue) : 1);
    return [
        Math.max(0, Math.min(1, Number(point && point.x) || 0)),
        1 - Math.max(0, Math.min(1, Number(point && point.y) || 0)),
        Number(point && point.z) || 0,
        kind === 'pose' ? Math.max(0, Math.min(1, poseVisibility)) : 1,
    ];
}

function compactResult(result) {
    const kind = VRCH_LANDMARK_WORKER.kind;
    const adapter = ANALYZER_OPTIONS[kind];
    const landmarkSets = (result && result[adapter.resultKey]) || [];
    const worldSets = adapter.worldResultKey && result ? (result[adapter.worldResultKey] || []) : [];
    const handednessSets = kind === 'hand' && result ? (result.handedness || result.handednesses || []) : [];
    const tracks = [];
    for (let index = 0; index < Math.min(VRCH_LANDMARK_WORKER.maximumTracks, landmarkSets.length); index += 1) {
        const landmarks = (landmarkSets[index] || []).map((point) => pointArray(point, kind));
        const categories = handednessSets[index] || [];
        const best = categories[0] || {};
        let confidence = Number(best.score);
        if (!Number.isFinite(confidence) && landmarks.length) {
            confidence = kind === 'pose'
                ? landmarks.reduce((sum, point) => sum + point[3], 0) / landmarks.length
                : 1;
        }
        tracks.push({
            landmarks,
            world_landmarks: (worldSets[index] || []).map((point) => [
                Number(point && point.x) || 0,
                Number(point && point.y) || 0,
                Number(point && point.z) || 0,
            ]),
            handedness: kind === 'hand' ? String(best.categoryName || best.displayName || '') : 'Unknown',
            confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
        });
    }
    return tracks;
}

async function processFrame(payload) {
    const bitmap = payload.bitmap;
    const started = performance.now();
    try {
        if (!VRCH_LANDMARK_WORKER.ready || !VRCH_LANDMARK_WORKER.landmarker) {
            throw Object.assign(new Error('Landmark analyzer is not ready'), { code: 'landmark-analysis-not-ready' });
        }
        let timestamp = Number(payload.timestamp);
        if (!Number.isFinite(timestamp)) timestamp = performance.now();
        // MediaPipe converts the JavaScript millisecond value to its internal
        // integer timestamp. Sub-millisecond increments can collapse to the
        // same packet time after that conversion and permanently fault the
        // graph, so keep a full millisecond of monotonic headroom.
        timestamp = Math.max(VRCH_LANDMARK_WORKER.lastTimestamp + 1, Math.ceil(timestamp));
        VRCH_LANDMARK_WORKER.lastTimestamp = timestamp;
        const result = VRCH_LANDMARK_WORKER.landmarker.detectForVideo(bitmap, timestamp);
        const completedAt = performance.now();
        postResult({
            type: 'result',
            kind: VRCH_LANDMARK_WORKER.kind,
            delegate: VRCH_LANDMARK_WORKER.delegate,
            generation: Number(payload.generation) || 0,
            frameId: payload.frameId,
            sourceSlot: payload.sourceSlot,
            sourceRevision: Number(payload.sourceRevision) || 0,
            sourceGeneration: Math.max(0, Number(payload.sourceGeneration) || 0),
            capturedAtMs: Math.max(0, Number(payload.timestamp) || 0),
            completedAtMs: completedAt,
            mirrored: !!payload.mirrored,
            rotation: [0, 90, 180, 270].includes(Number(payload.rotation)) ? Number(payload.rotation) : 0,
            sourceWidth: Number(payload.sourceWidth) || Number(bitmap && bitmap.width) || 0,
            sourceHeight: Number(payload.sourceHeight) || Number(bitmap && bitmap.height) || 0,
            durationMs: completedAt - started,
            tracks: compactResult(result),
        });
    } catch (error) {
        postResult(Object.assign({
            type: 'error',
            kind: VRCH_LANDMARK_WORKER.kind,
            generation: Number(payload.generation) || 0,
            frameId: payload.frameId,
        }, serializeError(error)));
    } finally {
        if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    }
}

self.onmessage = (event) => {
    if (VRCH_LANDMARK_IN_PAGE && (event.source !== self.parent || event.origin !== self.location.origin)) return;
    const payload = event && event.data ? event.data : {};
    if (payload.type === 'init') {
        initialize(payload).catch((error) => {
            postResult(Object.assign(
                { type: 'error', generation: Number(payload.generation) || 0 },
                serializeError(error, error && error.code ? error.code : `${String(payload.kind || 'landmark')}-analysis-init-failed`),
            ));
        });
        return;
    }
    if (payload.type === 'frame') processFrame(payload);
};
