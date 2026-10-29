/* Use the shared analyzer in the App's existing opaque sandbox and asset scope. */
(() => {
  'use strict';
  const packageRoot = new URL('.', location.href).href;
  function resolveResource(path) {
    const base = new URL(packageRoot);
    const url = new URL(String(path).replace(/^\/(?!\/)/, ''), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password) {
      throw Error('Tracking assets must come from this App package.');
    }
    return url.href;
  }
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
  window.ShaderAnalysis = Object.freeze({
    resolveResource,
    options: Object.freeze({WorkerCtor: PackageWorker, PageWorkerCtor: null, resolveResourceUrl: resolveResource, cacheWorkers: false}),
  });
})();
