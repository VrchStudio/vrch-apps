const sub = (a, b) => a.map((v, i) => v - b[i]);
const length = a => Math.hypot(...a);
const distance = (a, b) => length(sub(a, b));
function angle(a, b, c) {
  const u = sub(a, b), v = sub(c, b), denominator = length(u) * length(v);
  return denominator > 1e-10 ? Math.acos(Math.max(-1, Math.min(1, u.reduce((n, x, i) => n + x * v[i], 0) / denominator))) * 180 / Math.PI : 0;
}

// World-space angles/distances are invariant under hand side, display mirroring,
// scale and rigid rotation. Handedness score is NOT a landmark-quality score.
export function fingers(track, config, previous = []) {
  const p = track?.world_landmarks;
  if (!Array.isArray(p) || p.length !== 21 || p.some(v => !Array.isArray(v) || v.length < 3 || !v.slice(0, 3).every(Number.isFinite))) return null;
  const width = distance(p[5], p[17]);
  if (width < 1e-5) return null;
  const state = [];
  const threshold = i => previous[i] ? config.jointOff : config.jointOn;
  // Require abduction as well as straight thumb joints. A straight thumb folded
  // across the palm must not add one to a fist or a four-finger gesture.
  state[0] = angle(p[1], p[2], p[3]) > threshold(0) - 10 &&
    angle(p[2], p[3], p[4]) > (previous[0] ? config.thumbOff : config.thumbOn) &&
    distance(p[4], p[5]) / width > (previous[0] ? config.thumbSpreadOff : config.thumbSpreadOn) &&
    distance(p[4], p[17]) > distance(p[2], p[17]) * 1.12;
  [5, 9, 13, 17].forEach((base, i) => {
    state[i + 1] = angle(p[base], p[base + 1], p[base + 2]) > threshold(i + 1) &&
      angle(p[base + 1], p[base + 2], p[base + 3]) > threshold(i + 1) &&
      distance(p[0], p[base + 3]) > distance(p[0], p[base + 1]) * 1.08;
  });
  return state;
}

export function recognize(track, config, previous = {}, aspect = 1) {
  const bits = fingers(track, config, previous.bits);
  if (!bits) return {bits: [], fingerCount: null, note: null, gesture: 'none'};
  const p = track.world_landmarks, fingerCount = bits.filter(Boolean).length;
  const worldPinch = distance(p[4], p[8]) / Math.max(distance(p[5], p[17]), distance(p[0], p[9]));
  const points = track.landmarks;
  // Side views can badly overestimate fingertip depth. Use observed image
  // contact plus a broad depth bound, normalized by palm length/width rather
  // than a foreshortened palm width alone. Correct image aspect before measuring.
  const image = Array.isArray(points) && points.length === 21 && points.every(v => Number.isFinite(v[0]) && Number.isFinite(v[1]))
    ? points.map(v => [v[0] * aspect, v[1]]) : null;
  const scale = image && Math.max(distance(image[5], image[17]), distance(image[0], image[9]));
  const pinch = scale > 1e-6 ? distance(image[4], image[8]) / scale : worldPinch;
  // Special shapes take priority over counting. Re remains index+middle;
  // Mi can use index+middle+ring, keeping it distinct from an OK ring.
  const ok = !bits[1] && bits[2] && bits[3] && bits[4] &&
    worldPinch < config.pinchDepthMax && pinch < (previous.gesture === 'ok' ? config.pinchOff : config.pinchOn);
  const shaka = bits[0] && !bits[1] && !bits[2] && !bits[3] && bits[4];
  return {bits, fingerCount, note: ok ? 7 : shaka ? 6 : fingerCount, gesture: ok ? 'ok' : shaka ? 'shaka' : 'count'};
}

export class NoteGate {
  constructor(config) { this.config = config; this.reset(); }
  reset() { this.value = null; this.pending = null; this.since = 0; this.samples = 0; this.last = -Infinity; }
  update(count, timestamp) {
    if (timestamp - this.last > this.config.staleMs) this.reset();
    this.last = timestamp;
    if (count === null || count === 0) {
      this.value = count; this.pending = null; this.samples = 0; return this.value;
    }
    if (count === this.value) { this.pending = null; this.samples = 0; return this.value; }
    if (count !== this.pending) { this.pending = count; this.since = timestamp; this.samples = 1; }
    else this.samples++;
    if (this.samples >= this.config.minimumSamples && timestamp - this.since >= this.config.settleMs) {
      this.value = count; this.pending = null; this.samples = 0;
    }
    return this.value;
  }
  expire(now) { if (now - this.last > this.config.staleMs) this.reset(); return this.value; }
}
