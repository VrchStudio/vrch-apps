'use strict';
/* The stage: turns the pattern and its hits into the picture. The device screen and the big output both run
 * this file, so they show the same thing.
 *
 * Time runs left to right: each of the 16 steps has a fixed place (two rows of eight on an upright screen), and Swing
 * moves the off-beat places later by the same share it delays their sound. Every voice has a lane; Tune moves it.
 * A hit is drawn at its step from the moment it is heard: large while it rings, then a trace that fades within a bar.
 * While stopped, the picture is every trace of the current pattern.
 *
 * The picture depends only on the pattern, the settings, the hits and the time, never on chance, so the same loop
 * draws the same frames. Hits arrive stamped with their time on the audio clock; origin places that clock on the
 * screen's (performance.now() at audio time 0, latency included). */

// One ground, a second ground for every other beat, four flat shape colours and a neutral for the time ruler.
// No gradients, no glow.
const PALETTES = [
  {id: 'night', bg: '#111216', panel: '#1a1c23', grid: '#3a3d48', ink: '#f3ecd9', colors: ['#ff4a2b', '#f3ecd9', '#2f6dff', '#ffc41a']},
  {id: 'paper', bg: '#f0e9d9', panel: '#e5dcc8', grid: '#bfb6a1', ink: '#17171a', colors: ['#e5342a', '#17171a', '#1f52d6', '#f2b416']},
  {id: 'pool', bg: '#2438c9', panel: '#1d2fb0', grid: '#5669e6', ink: '#f7f0de', colors: ['#ff6a3d', '#f7f0de', '#0c123c', '#ffd43a']},
];

const createStage = (() => {
  const STEPS = 16, TINTS = 16;
  const ACCENT = 1.25; // an accent is this much larger
  const REST = [0.9, 1], HIT = [1.04, 1.14]; // colour strength of a trace and of a ringing hit: [normal, accent]
  const LOOK_MS = 8;   // a frame is seen a little after it is drawn: draw hits due within half a frame
  const CUT_MS = 40;   // a voice that is struck again, or a choked open hat, lets go of its old shape this fast
  // A voice struck again sooner than this swells less, in proportion: shapes that repeat more than three times a
  // second stay small, so no large part of the picture ever flashes quickly.
  const CALM_MS = 334;
  const TUNE_STEP = 0.0075; // one semitone moves a voice by this share of the row height
  const smooth = (a, b, x) => { const k = Math.max(0, Math.min(1, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
  const voiceOf = id => SHAPES.findIndex(shape => shape.id === id);

  function hash(a, b, c) {
    let h = Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663) ^ Math.imul(c + 1, 83492791);
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  }
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  // Each colour at strengths 0.5 to 1.5: below 1 it leans toward the ground, at 1 it is the plain colour, above 1 it
  // is a little lighter. A shape is always one flat, opaque colour.
  const tables = PALETTES.map(palette => {
    const bg = rgb(palette.bg);
    return [...palette.colors, palette.ink].map(color => {
      const c = rgb(color);
      return Array.from({length: 2 * TINTS + 1}, (_, i) => {
        const k = i / TINTS - 1; // -1 .. 1 for strengths 0.5 .. 1.5
        return 'rgb(' + c.map((v, n) => Math.round(k < 0 ? v + (bg[n] - v) * -k * 0.5 : v + (255 - v) * k * 0.5)).join(',') + ')';
      });
    });
  });

  // Rows of steps chosen so a step's cell is as close to square as the screen allows; u keeps every shape's share of
  // the picture the same on any screen, so nothing stretches and a circle stays a circle.
  function measure(W, H, inset = 0) {
    const rows = W / H < 1.066 ? 2 : 1, cols = STEPS / rows, bandH = H / rows;
    const u = Math.min(Math.sqrt(W * H / 144), bandH / 7, W / cols * 1.3);
    const pad = Math.max(u * 0.35, W * 0.02, inset);
    return {rows, cols, bandH, u, pad, cw: (W - 2 * pad) / cols};
  }

  // readback: the canvas will be read pixel by pixel (tests), so the browser keeps one rasterizer for it throughout.
  return function createStage(canvas, {maxPixels = Infinity, readback = false} = {}) {
    const g = canvas.getContext('2d', {alpha: false, willReadFrequently: readback});
    const model = {
      cells: new Uint8Array(SHAPES.length * STEPS), bpm: 120, swing: 0, mutes: 0,
      tune: SHAPES.map(() => 0), decay: SHAPES.map(() => 50), theme: 0, sel: 0, playing: false,
    };
    const records = SHAPES.map(() => []); // each voice's hits, oldest first
    const stepLog = [], hitLog = [], batch = [];
    const CH = voiceOf('CH'), OH = voiceOf('OH');
    let W = 1, H = 1, L = measure(1, 1), scale = 1, lastT = 0, selAt = -1e9, voice = 0, step = 0;
    const p = {x: 0, y: 0, u: 1, level: 0, t: 0, size: 1, step: 0, left: 0, right: 1, rand: n => hash(voice, step, n)};
    // heard[v]: milliseconds since voice v was last heard, as of the last frame (Infinity when silent).
    const stage = {origin: 0, frames: 0, firstFrameAt: 0, playStep: -1, model, heard: SHAPES.map(() => Infinity)};

    // inset: CSS pixels at the left edge that take no touch on the device; the steps keep clear of it on both sides.
    stage.resize = (width, height, ratio = 1, inset = 0) => {
      scale = Math.min(ratio, Math.sqrt(maxPixels / Math.max(1, width * height)));
      W = Math.max(1, Math.round(width * scale)); H = Math.max(1, Math.round(height * scale));
      canvas.width = W; canvas.height = H;
      L = measure(W, H, inset * scale);
    };
    // Where the 16 steps sit, in CSS pixels, so the device's step pads can line up under them.
    stage.columns = () => ({rows: L.rows, pad: L.pad / scale, width: L.cw / scale});
    stage.color = (color, theme = model.theme) => PALETTES[theme].colors[color];
    // One voice's shape at rest, centred on a small canvas: the device's voice buttons.
    stage.glyph = (target, v) => {
      const c = target.getContext('2d'), u = target.height * 0.38;
      c.clearRect(0, 0, target.width, target.height);
      c.fillStyle = c.strokeStyle = stage.color(SHAPES[v].color);
      voice = v; step = 0;
      SHAPES[v].draw(c, {x: target.width / 2, y: target.height / 2 + (v === CH ? u * 0.28 : 0), u, level: 0, t: 1000, size: 1, step: 0, left: 0, right: target.width, rand: p.rand});
    };

    stage.set = next => {
      if (next.sel !== undefined && next.sel !== model.sel) selAt = lastT;
      for (const key of Object.keys(next)) {
        if (key === 'cells') model.cells.set(next.cells); else model[key] = next[key];
      }
    };
    stage.reset = () => { records.forEach(list => { list.length = 0; }); stepLog.length = 0; stage.playStep = -1; };

    function add(v, record) {
      const list = records[v], keep = record.time - 2 * 240000 / model.bpm - 2000;
      while (list.length && list[0].time < keep) list.shift();
      record.punch = 1;
      for (let i = list.length - 1; i >= 0 && !record.silent; i--) {
        if (list[i].silent) continue;
        record.punch = Math.max(0.2, Math.min(1, (record.time - list[i].time) / CALM_MS));
        break;
      }
      list.push(record);
      if (record.silent) return;
      hitLog.push({voice: v, record});
      if (hitLog.length > 64) hitLog.shift();
    }
    // The sequencer reached a step. first marks the first step after Start: the pattern's traces are laid down as if
    // the bar before had been played, so the picture carries on from the still one instead of emptying.
    stage.step = ({step: s, mask, accents, time, first}) => {
      if (first) {
        stage.reset();
        const stepMs = 15000 / model.bpm;
        for (let v = 0; v < SHAPES.length; v++) for (let k = 0; k < STEPS; k++) {
          const value = model.cells[v * STEPS + k];
          if (value) add(v, {time: time - (STEPS - k) * stepMs, pos: k, cell: k, accent: value === 2, silent: true, manual: false, drawnAt: 0, heardAt: 0});
        }
      }
      stepLog.push({time, step: s});
      if (stepLog.length > 48) stepLog.shift();
      for (let v = 0; v < SHAPES.length; v++) {
        if ((mask >> v) & 1) add(v, {time, pos: s, cell: s, accent: !!((accents >> v) & 1), silent: false, manual: false, drawnAt: 0, heardAt: 0});
      }
    };
    // A hit by hand. While playing it lands where the bar is at that moment; while stopped, in the middle (pos -1).
    stage.strike = ({voice: v, time, pos}) => {
      if (pos === undefined) {
        pos = -1;
        for (let i = stepLog.length - 1; model.playing && i >= 0; i--) {
          const at = stepLog[i];
          if (at.time > time) continue;
          const length = 15000 / model.bpm * (at.step & 1 ? 1 - model.swing : 1 + model.swing);
          pos = at.step + Math.min(0.999, (time - at.time) / length);
          break;
        }
      }
      add(v, {time, pos, cell: -1, accent: false, silent: false, manual: true, drawnAt: 0, heardAt: 0});
      return pos;
    };
    stage.hits = () => hitLog.map(({voice: v, record}) => ({
      voice: SHAPES[v].id, step: record.pos < 0 ? -1 : Math.floor(record.pos), accent: record.accent, manual: record.manual,
      audioTime: record.heardAt || record.time + stage.origin, drawnAt: record.drawnAt || null,
    }));

    function place(v, pos) {
      const row = pos < 0 ? 0 : Math.floor(pos / L.cols) % L.rows, s = Math.max(0, Math.floor(pos)), odd = s & 1;
      p.x = pos < 0 ? W / 2 : L.pad + (s % L.cols + 0.5 + (odd ? model.swing : 0) + (pos - s) * (odd ? 1 - model.swing : 1 + model.swing)) * L.cw;
      p.y = (row + SHAPES[v].lane - model.tune[v] * TUNE_STEP) * L.bandH;
      p.u = L.u; p.left = 0; p.right = W; p.step = s;
      voice = v; step = s;
    }
    // strength: how bright the flat colour is (1 is the plain colour); fade: 1 down to 0 as a trace leaves.
    function paint(v, strength, fade) {
      g.globalAlpha = fade;
      g.fillStyle = g.strokeStyle = tables[model.theme][SHAPES[v].color][Math.round((Math.max(0.5, Math.min(1.5, strength)) - 0.5) * 2 * TINTS)];
      SHAPES[v].draw(g, p);
    }

    // The frame of the poster: every other beat on a second ground, the ruler's resting ticks, and the playhead.
    function grid() {
      const palette = PALETTES[model.theme], lane = SHAPES[CH < 0 ? 0 : CH].lane;
      for (let row = 0; row < L.rows; row++) {
        const top = row * L.bandH, base = top + L.bandH * lane;
        g.fillStyle = palette.panel;
        for (let beat = (row + 1) % 2; beat < L.cols / 4; beat += 2) {
          const x0 = Math.round(beat ? L.pad + beat * 4 * L.cw : 0), x1 = Math.round(beat + 1 < L.cols / 4 ? L.pad + (beat + 1) * 4 * L.cw : W);
          g.fillRect(x0, Math.round(top), x1 - x0, Math.round(top + L.bandH) - Math.round(top));
        }
        g.fillStyle = palette.grid;
        for (let c = 0; c < L.cols; c++) {
          const s = row * L.cols + c, x = L.pad + (c + 0.5 + (s & 1 ? model.swing : 0)) * L.cw, h = L.u * (s % 4 ? 0.2 : 0.34);
          g.fillRect(x - L.u * 0.04, base - h, L.u * 0.08, h);
        }
      }
      if (!model.playing || stage.playStep < 0) return;
      place(CH < 0 ? 0 : CH, stage.playStep);
      const side = L.u * 0.18, base = (Math.floor(stage.playStep / L.cols) + lane) * L.bandH;
      g.fillStyle = palette.ink;
      g.fillRect(p.x - side / 2, base + L.u * 0.1, side, side);
    }

    // A muted voice leaves the picture: only a hit by hand, which still sounds, is drawn.
    function drawVoice(v, t, muted) {
      const shape = SHAPES[v], list = records[v], selected = v === model.sel;
      const pop = selected ? 0.25 * Math.exp(-Math.max(0, t - selAt) / 160) : 0;
      const length = shape.seconds * Math.pow(2, (model.decay[v] - 50) / 25) * 1000, barMs = 240000 / model.bpm;
      stage.heard[v] = Infinity;
      if (!model.playing && !muted) {
        for (let s = 0; s < STEPS; s++) {
          const value = model.cells[v * STEPS + s];
          if (!value) continue;
          const breath = Math.sin(t / 700 + s * 0.4); // a slow, slight swell that travels along the bar
          place(v, s);
          p.level = 0; p.t = 1000; p.size = (value === 2 ? ACCENT : 1) * (1 + pop) * (1 + 0.02 * breath);
          paint(v, value === 2 ? REST[1] : REST[0], 1);
        }
      }
      // Newest first: only a voice's latest hit rings (the one before lets go), and a step struck again replaces its trace.
      let newer = 0, cutAt = Infinity, seen = 0;
      batch.length = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        const record = list[i];
        if (record.time > t) continue;
        let level = 0;
        if (!record.silent && newer < 2) {
          level = record.punch * Math.max(0, 1 - (t - record.time) / length);
          if (newer) level *= Math.max(0, 1 - (t - cutAt) / CUT_MS);
          if (v === OH && CH >= 0) { // a closed hat chokes the open hat, in the picture as in the sound
            const choke = records[CH].find(hit => hit.time > record.time && hit.time <= t && !hit.silent);
            if (choke) level *= Math.max(0, 1 - (t - choke.time) / CUT_MS);
          }
        }
        if (!record.silent) { newer++; cutAt = record.time; }
        if (!record.silent && newer === 1) stage.heard[v] = t - record.time;
        if (muted && !record.manual) continue;
        if (!record.drawnAt) { record.drawnAt = stage.now; record.heardAt = record.time + stage.origin; }
        const age = (t - record.time) / barMs, again = record.cell >= 0 && (seen >> record.cell) & 1;
        if (record.cell >= 0) seen |= 1 << record.cell;
        const trace = model.playing || record.manual ? (again || age >= 1 ? 0 : 1 - smooth(0.8, 1, age)) : level > 0 ? 1 : 0;
        if (level <= 0 && trace <= 0) continue;
        // A trace rests a shade under the plain colour (an accent nearer to it); a hit is at full strength while it rings.
        const k = record.accent ? 1 : 0, strength = REST[k] + (HIT[k] - REST[k]) * Math.pow(level, 0.6);
        if (trace >= 0.02 || level > 0) batch.push(record, level, strength, level > 0 ? Math.max(trace, Math.min(1, level * 8)) : trace);
      }
      for (let i = batch.length - 4; i >= 0; i -= 4) {
        const record = batch[i];
        place(v, record.pos);
        p.level = batch[i + 1]; p.t = (t - record.time) / 1000; p.size = (record.accent ? ACCENT : 1) * (1 + pop);
        paint(v, batch[i + 2], batch[i + 3]);
      }
    }

    // Draw the picture as it is at screen time now (a performance.now() value).
    stage.render = now => {
      const t = now - stage.origin + LOOK_MS;
      lastT = t; stage.now = now;
      stage.playStep = -1;
      for (let i = stepLog.length - 1; i >= 0; i--) if (stepLog[i].time <= t) { stage.playStep = stepLog[i].step; break; }
      g.fillStyle = PALETTES[model.theme].bg;
      g.fillRect(0, 0, W, H);
      g.lineCap = 'butt'; g.lineJoin = 'miter';
      grid();
      // Later voices in shapes.js are drawn over earlier ones, and the selected voice over them all.
      for (let v = 0; v < SHAPES.length; v++) if (v !== model.sel) drawVoice(v, t, !!((model.mutes >> v) & 1));
      if (model.sel >= 0 && model.sel < SHAPES.length) drawVoice(model.sel, t, !!((model.mutes >> model.sel) & 1));
      g.globalAlpha = 1;
      stage.frames++;
      if (!stage.firstFrameAt) stage.firstFrameAt = performance.now();
    };
    return stage;
  };
})();
