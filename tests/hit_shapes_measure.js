// Measuring code that hit_shapes_browser.cjs runs inside the App, beside its stage.js and shapes.js.
// simulate: a second stage on its own canvas, fed a pattern's steps directly and drawn at exact times.
window.simulate = ({width, height, rows, theme = 0, style = 0, bpm = 120, swing = 0, mutes = 0, tune = {}, decay = {}, loops = 4, playing = true}) => {
  const canvas = document.createElement('canvas'), sim = createStage(canvas, {readback: true}), cells = new Uint8Array(SHAPES.length * 16);
  SHAPES.forEach(({id}, v) => [...(rows[id] || '')].forEach((mark, s) => { cells[v * 16 + s] = mark === 'X' ? 2 : mark === 'x' ? 1 : 0; }));
  sim.resize(width, height, 1);
  sim.set({cells, bpm, swing, mutes, theme, style, sel: -1, playing, tune: SHAPES.map(({id}) => tune[id] || 0), decay: SHAPES.map(({id}) => decay[id] ?? 50)});
  const stepMs = 15000 / bpm, steps = [];
  for (let n = 0; playing && n < loops * 16; n++) {
    const s = n % 16;
    let mask = 0, accents = 0;
    SHAPES.forEach((_, v) => { const value = (mutes >> v) & 1 ? 0 : cells[v * 16 + s]; if (value) mask |= 1 << v; if (value === 2) accents |= 1 << v; });
    steps.push({step: s, mask, accents, time: (n + (s & 1 ? swing : 0)) * stepMs, first: n === 0});
  }
  const g = canvas.getContext('2d');
  // The picture at one moment on the audio clock. Steps reach the stage as they would while playing, a little ahead of
  // being heard, so ask for moments in increasing order.
  return {sim, canvas, stepMs, pixels(time) {
    while (steps.length && steps[0].time <= time + 60) sim.step(steps.shift());
    sim.origin = 0; sim.render(time - 8);
    return g.getImageData(0, 0, canvas.width, canvas.height).data;
  }};
};
// Pixels that are (nearly) one palette colour at full strength, their bounding box and centre.
window.blob = (data, width, hex, slack = 40) => {
  const want = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  let count = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, sy = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i] - want[0]) + Math.abs(data[i + 1] - want[1]) + Math.abs(data[i + 2] - want[2]) > slack) continue;
    const x = (i / 4) % width, y = Math.floor(i / 4 / width);
    count++; sy += y; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return {count, width: x1 - x0 + 1, height: y1 - y0 + 1, centerY: count ? sy / count : 0, share: count / (data.length / 4)};
};
const luminance = (data, out) => {
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  for (let i = 0, k = 0; i < data.length; i += 4, k++) out[k] = 0.2126 * lin(data[i]) + 0.7152 * lin(data[i + 1]) + 0.0722 * lin(data[i + 2]);
  return out;
};
// Flashing, measured over one second of the picture at 60 frames a second.
//   fast     share of the picture that flashes more than three times in the second, counted as WCAG 2.3.1 does: a flash
//            is a pair of opposing changes in relative luminance of at least 10% (darker side below 0.8)
//   bursts   how many separate moments in the second change a quarter of the picture or more by 10% within 67 ms
//   largest  the largest share of the picture changed within 67 ms
window.flashing = options => {
  const run = simulate({...options, loops: 6}), barMs = run.stepMs * 16, from = 3 * barMs, frames = 60, span = 4;
  const history = [];
  let extreme = null, direction = null, changes = null, largest = 0, bursts = 0, over = false;
  for (let f = 0; f <= frames; f++) {
    const now = luminance(run.pixels(from + f * 1000 / 60), new Float32Array(run.canvas.width * run.canvas.height));
    history.push(now);
    if (history.length > span + 1) history.shift();
    if (!extreme) { extreme = now.slice(); direction = new Int8Array(now.length); changes = new Uint8Array(now.length); continue; }
    const before = history[0];
    let moved = 0;
    for (let i = 0; i < now.length; i++) {
      if (Math.abs(now[i] - before[i]) >= 0.1) moved++;
      const delta = now[i] - extreme[i];
      if (direction[i] >= 0 && delta <= -0.1 && now[i] < 0.8) { changes[i]++; direction[i] = -1; extreme[i] = now[i]; }
      else if (direction[i] <= 0 && delta >= 0.1 && extreme[i] < 0.8) { changes[i]++; direction[i] = 1; extreme[i] = now[i]; }
      else if ((direction[i] > 0 && delta > 0) || (direction[i] < 0 && delta < 0)) extreme[i] = now[i];
    }
    const share = moved / now.length;
    largest = Math.max(largest, share);
    if (share >= 0.25 && !over) bursts++;
    over = share >= 0.25;
  }
  let fast = 0;
  for (let i = 0; i < changes.length; i++) if (changes[i] > 6) fast++;
  return {fast: fast / changes.length, bursts, largest};
};
