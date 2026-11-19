// Camera picture for the output role (a picture-only instance on Playground's output or a second screen).
// VrchApp.output messages are limited to 16 KiB, so each JPEG travels as a data URL in parts and the output keeps
// only the newest complete picture. The picture keeps the camera's own size (up to maxWidth), since the output shows
// it large; a larger picture than the parts allow drops to a lower quality. Nothing is stored; the controlling
// instance stops sending while it is hidden.
const PART = 15000, MAX_PARTS = 16, PREFIX = 'data:image/jpeg;base64,';

export function createPictureSender(relay, {maxWidth = 960, qualities = [0.82, 0.68, 0.5], intervalMs = 40} = {}) {
  const small = document.createElement('canvas');
  let busy = false, last = 0, id = 0;
  const encode = quality => new Promise(resolve => small.toBlob(resolve, 'image/jpeg', quality))
    .then(blob => blob && new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); }));
  return function offer(source, now = performance.now()) {
    if (!relay || busy || document.hidden || now - last < intervalMs || !source?.width || !source?.height) return;
    busy = true; last = now;
    const scale = Math.min(1, maxWidth / source.width);
    const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale));
    if (small.width !== width || small.height !== height) { small.width = width; small.height = height; }
    small.getContext('2d').drawImage(source, 0, 0, width, height);
    (async () => {
      for (const quality of qualities) {
        const url = await encode(quality);
        if (typeof url !== 'string' || !url.startsWith(PREFIX)) return;
        if (url.length > PART * MAX_PARTS) continue;
        const parts = Math.ceil(url.length / PART), frame = ++id;
        for (let i = 0; i < parts; i++) relay.send({t: 'picture', id: frame, i, n: parts, d: url.slice(i * PART, (i + 1) * PART)});
        return;
      }
    })().catch(() => {}).finally(() => { busy = false; });
  };
}


export function createPictureReceiver(onPicture) {
  const canvas = document.createElement('canvas');
  let current = null, parts = [], got = 0, decoding = false, pending = null, at = 0, count = 0;
  async function show(url) {
    pending = url;
    if (decoding) return;
    decoding = true;
    try {
      while (pending) {
        const next = pending; pending = null;
        const image = new Image(); image.src = next;
        try { await image.decode(); } catch (_) { continue; }
        if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) { canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; }
        canvas.getContext('2d').drawImage(image, 0, 0);
        at = performance.now(); count++; onPicture?.(canvas);
      }
    } finally { decoding = false; }
  }
  return {
    canvas,
    get at() { return at; },
    get count() { return count; },
    clear() { at = 0; current = null; parts = []; got = 0; },
    take(data) {
      if (data?.t !== 'picture' || !Number.isInteger(data.id) || !Number.isInteger(data.n) || data.n < 1 || data.n > MAX_PARTS
        || !Number.isInteger(data.i) || data.i < 0 || data.i >= data.n || typeof data.d !== 'string') return false;
      if (data.id !== current || parts.length !== data.n) { current = data.id; parts = new Array(data.n); got = 0; }
      if (parts[data.i] === undefined) { parts[data.i] = data.d; got++; }
      if (got === data.n) {
        const url = parts.join(''); current = null; parts = []; got = 0;
        if (url.startsWith(PREFIX)) void show(url);
      }
      return true;
    }
  };
}

