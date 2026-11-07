/* Camera input for Visuals Player. Frames come from the host camera bridge (VrchApp.camera): the App never holds a
   MediaStream or a browser permission. Body tracking runs in the shared landmark worker, loaded only from this package;
   the worker refuses every request outside it, so the picture and the landmarks stay in this browser. */
(() => {
  'use strict';
  const packageRoot = new URL('.', document.baseURI).href;
  function resolveResource(path) {
    const base = new URL(packageRoot);
    const url = new URL(String(path).replace(/^\/(?!\/)/, ''), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password) {
      throw Error('Tracking assets must come from this App package.');
    }
    return url.href;
  }
  // A classic Worker from this package's own script, created from a blob so it also starts in an opaque frame.
  function PackageWorker(url) {
    const script = 'const packageRoot=' + JSON.stringify(packageRoot) + ';\n' +
      'self.VrchLandmarkResolveResource=' + resolveResource.toString() + ';\n' +
      'importScripts(self.VrchLandmarkResolveResource(' + JSON.stringify(url) + '));';
    const objectUrl = URL.createObjectURL(new Blob([script], {type: 'text/javascript'}));
    try {
      const worker = new Worker(objectUrl);
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => { terminate(); URL.revokeObjectURL(objectUrl); };
      return worker;
    } catch (error) { URL.revokeObjectURL(objectUrl); throw error; }
  }
  // The package carries only the WebAssembly SIMD build of the tracking runtime.
  const simd = (() => {
    try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); }
    catch (_) { return false; }
  })();
  const RELAY_WIDTH = 256, RELAY_HEIGHT = 192, RELAY_LIMIT = 15000;

  class VisualsCamera {
    constructor({sdk, onFrame = () => {}, onEnded = () => {}}) {
      this.sdk = sdk; this.onFrame = onFrame; this.onEnded = onEnded;
      this.handle = null; this.canvas = document.createElement('canvas'); this.context = this.canvas.getContext('2d');
      this.relayCanvas = null; this.relayBusy = false; this.frames = 0; this.session = 0;
    }
    get on() { return !!this.handle; }
    async open() {
      const session = ++this.session;
      // 15 frames a second: the visuals draw at 20-30 and body tracking reads 10, so more only costs power.
      const handle = await this.sdk.camera.open({width: 640, height: 480, frameRate: 15});
      if (session !== this.session) { void handle.close().catch(() => {}); throw Object.assign(Error('Camera stopped.'), {code: 'camera_closed'}); }
      this.handle = handle; this.frames = 0;
      handle.onFrame(frame => this.draw(frame));
      handle.onError(error => { if (this.handle === handle) { this.handle = null; this.onEnded(error); } });
      return handle;
    }
    // A selfie view: the picture is mirrored so hands move the way the visitor expects.
    draw(frame) {
      if (!this.handle) return;
      const width = frame.displayWidth || frame.width, height = frame.displayHeight || frame.height;
      const scale = Math.min(1, 640 / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      const context = this.context;
      context.setTransform(-1, 0, 0, 1, w, 0);
      context.drawImage(frame, 0, 0, w, h);
      context.setTransform(1, 0, 0, 1, 0, 0);
      this.frames++;
      this.onFrame(this.canvas);
    }
    // A small JPEG of the current picture for a picture-only output, within the 16 KiB output message limit.
    async relayFrame() {
      if (!this.handle || this.relayBusy || !this.frames) return null;
      this.relayBusy = true;
      try {
        if (!this.relayCanvas) { this.relayCanvas = document.createElement('canvas'); this.relayCanvas.width = RELAY_WIDTH; this.relayCanvas.height = RELAY_HEIGHT; }
        this.relayCanvas.getContext('2d').drawImage(this.canvas, 0, 0, RELAY_WIDTH, RELAY_HEIGHT);
        for (const quality of [0.6, 0.4, 0.25]) {
          const blob = await new Promise(resolve => this.relayCanvas.toBlob(resolve, 'image/jpeg', quality));
          if (!blob) return null;
          const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
          if (url.length <= RELAY_LIMIT) return url;
        }
        return null;
      } catch (_) { return null; } finally { this.relayBusy = false; }
    }
    close() {
      this.session++;
      const handle = this.handle; this.handle = null;
      if (handle) void handle.close().catch(() => {});
    }
  }
  // Draws relayed output frames into a canvas that the output's effects read.
  class RelayPicture {
    constructor() { this.canvas = document.createElement('canvas'); this.canvas.width = RELAY_WIDTH; this.canvas.height = RELAY_HEIGHT; this.busy = false; this.pending = null; this.frames = 0; }
    async show(url, onDrawn) {
      if (typeof url !== 'string' || !url.startsWith('data:image/jpeg;base64,')) return;
      this.pending = url;
      if (this.busy) return;
      this.busy = true;
      try {
        while (this.pending) {
          const next = this.pending; this.pending = null;
          const image = new Image(); image.src = next;
          try { await image.decode(); } catch (_) { continue; }
          this.canvas.getContext('2d').drawImage(image, 0, 0, this.canvas.width, this.canvas.height);
          this.frames++;
          onDrawn(this.canvas);
        }
      } finally { this.busy = false; }
    }
  }
  window.VisualsCamera = Object.freeze({
    Camera: VisualsCamera, RelayPicture, simd, resolveResource,
    analysisOptions: Object.freeze({WorkerCtor: PackageWorker, PageWorkerCtor: null, resolveResourceUrl: resolveResource, cacheWorkers: true}),
  });
})();
