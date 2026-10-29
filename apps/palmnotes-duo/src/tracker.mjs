// Same immutable package resolver/worker bootstrap as the Shader Editor App.
export function createTracker(onResult, onError) {
  const packageRoot = new URL('.', import.meta.url).href;
  function resolveResource(path) {
    const base = new URL(packageRoot), url = new URL(String(path).replace(/^\/(?!\/)/, ''), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password) throw Error('Invalid tracking asset');
    return url.href;
  }
  const code = 'const packageRoot=' + JSON.stringify(packageRoot) + ';self.VrchLandmarkResolveResource=' + resolveResource.toString() + ';importScripts(self.VrchLandmarkResolveResource("scripts/vrch_pages_landmark_worker.js"));';
  const url = URL.createObjectURL(new Blob([code], {type: 'text/javascript'}));
  const worker = new Worker(url);
  let closed = false, busy = false, sequence = 0, rejectReady;
  const ready = new Promise((resolve, reject) => {
    rejectReady = reject;
    worker.onmessage = ({data}) => {
      if (closed) return;
      if (data.type === 'ready') { clearTimeout(timer); resolve(); }
      if (data.type === 'result') { busy = false; onResult(data); }
      if (data.type === 'error') { busy = false; clearTimeout(timer); reject(Error(data.message)); onError(Error(data.message)); }
    };
    worker.onerror = event => { clearTimeout(timer); reject(Error(event.message)); onError(Error(event.message)); };
  });
  const timer = setTimeout(() => { rejectReady(Error('Tracking startup timed out')); }, 30000);
  worker.postMessage({type: 'init', kind: 'hand', generation: 1, maximumTracks: 2, delegate: 'CPU',
    bundleUrl: resolveResource('vendor/mediapipe/tasks-vision-1.0.1/vision_bundle.js'),
    wasmBaseUrl: resolveResource('vendor/mediapipe/tasks-vision-1.0.1/wasm'),
    modelUrl: resolveResource('models/mediapipe/hand_landmarker-lite-v1.task')});
  return {
    ready,
    async frame(canvas, timestamp, sourceRevision) {
      if (busy || closed) return;
      busy = true;
      try {
        const bitmap = await createImageBitmap(canvas);
        if (closed) { bitmap.close(); return; }
        worker.postMessage({type: 'frame', generation: 1, bitmap, timestamp, sourceRevision, frameId: ++sequence}, [bitmap]);
      } catch (error) { busy = false; if (!closed) onError(error); }
    },
    close() { if (closed) return; closed = true; clearTimeout(timer); rejectReady(Object.assign(Error('Cancelled'), {cancelled: true})); worker.terminate(); URL.revokeObjectURL(url); }
  };
}
