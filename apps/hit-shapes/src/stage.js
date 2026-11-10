'use strict';
/* The stage: turns the pattern and its hits into the picture. The device screen and the big output both run this file,
 * so they show the same thing.
 *
 * Every hit is drawn with its voice's shape from shapes.js, from the moment it is heard: large while it rings, then a
 * trace. Where the hit sits, and what becomes of its trace, is the style's business. There are three, and the player
 * can change between them at any time, even mid-bar:
 *
 *   Score   one bar, time left to right (two rows on an upright screen), every voice on its own lane. A trace stays
 *           until the end of its bar, and over eight bars the lanes close into one line of signs and open again.
 *   Orbit   the bar is a dial, step 1 at twelve o'clock, every voice on its own ring. A trace rides its ring for four
 *           bars, neighbouring rings turning opposite ways, and over sixteen bars the dial opens (the traces fan
 *           out along their rings) and closes again.
 *   Weave   each bar is a row, and as each row is finished the cloth moves up one, like cloth off a loom, so the last
 *           several bars stay in view: a change of pattern, a mute or a turn of Tune is a visible seam, and every other four-bar phrase
 *           is woven on the opposite grounds.
 *
 * In every style Swing moves the off-beat places later by the share it delays their sound, Tune moves a voice
 * along its own axis, and a kick shoves everything near it aside for a moment. The voices' Tune and Decay also add up
 * to two things the whole picture does: it leans (Score and Weave slope, Orbit's rings rise or sink off the hub) as
 * the voices are tuned up or down, and with longer decays every shape is larger and traces stay longer. While stopped, the picture is the current pattern laid out in the style.
 *
 * The picture depends only on the pattern, the settings, the hits and the time, never on chance, so the same playing
 * draws the same frames. Hits arrive stamped with their time on the audio clock; origin places that clock on the
 * screen's (performance.now() at audio time 0, latency included). */

// One ground, a second ground for every other beat, four flat shape colours and a neutral for the time ruler.
// No gradients, no glow.
const PALETTES = [
  {id: 'night', bg: '#111216', panel: '#1a1c23', grid: '#3a3d48', ink: '#f3ecd9', colors: ['#ff4a2b', '#f3ecd9', '#2f6dff', '#ffc41a']},
  {id: 'paper', bg: '#f0e9d9', panel: '#e5dcc8', grid: '#bfb6a1', ink: '#17171a', colors: ['#e5342a', '#17171a', '#1f52d6', '#f2b416']},
  {id: 'pool', bg: '#2438c9', panel: '#1d2fb0', grid: '#5669e6', ink: '#f7f0de', colors: ['#ff6a3d', '#f7f0de', '#0c123c', '#ffd43a']},
];
const STYLES = ['Score', 'Orbit', 'Weave'];

const createStage = (() => {
  const STEPS = 16, TINTS = 16;
  const ACCENT = 1.25; // an accent is this much larger
  const REST = [0.9, 1], HIT = [1.04, 1.14]; // colour strength of a trace and of a ringing hit: [normal, accent]
  const LOOK_MS = 8;   // a frame is seen a little after it is drawn: draw hits due within half a frame
  const CUT_MS = 40;   // a voice that is struck again, or a choked open hat, lets go of its old shape this fast
  // A voice struck again sooner than this swells less, in proportion: shapes that repeat more than three times a
  // second stay small, so no large part of the picture ever flashes quickly.
  const CALM_MS = 334;
  const KEEP_BARS = 9; // hits older than this are forgotten
  // A kick shoves the other shapes away from itself: this far (in units of u) right beside it, half as far REACH away.
  // They are flung out within a few frames and drift back over the next third of a second: a recoil, not a jump, so
  // a wide shove does not change much of the picture from one frame to the next.
  const SHOVE = 0.64, REACH = 4, SHOVE_IN_MS = 35, SHOVE_MS = 180;
  const SHOVE_PEAK = (() => { const at = SHOVE_IN_MS * Math.log(1 + SHOVE_MS / SHOVE_IN_MS); return (1 - Math.exp(-at / SHOVE_IN_MS)) * Math.exp(-at / SHOVE_MS); })();
  // Kicks closer together than SHOVE_FULL_MS shove less, and closer than SHOVE_NONE_MS not at all: a full shove comes
  // at most twice a second, and nothing jitters. A crowded pattern shares the shove out: with more
  // than ROOMY steps switched on, every shape moves less in proportion.
  const SHOVE_FULL_MS = 500, SHOVE_NONE_MS = 250, ROOMY = 32;
  const recoil = ms => (1 - Math.exp(-ms / SHOVE_IN_MS)) * Math.exp(-ms / SHOVE_MS) / SHOVE_PEAK; // 0, up to 1, back to 0
  // The whole picture's answer to the knobs. lean: all voices' Tune added up, -1 to 1 (two voices turned all the way
  // are the whole of it). hold: all voices' Decay away from the middle, added up, -1 to 1 (likewise).
  const LEAN = 0.16;   // Score: how far the lanes rise or fall by the edges of the screen, in rows
  const DRAPE = 0.9;   // Weave: the same, in the cloth's rows
  const RISE = 0.2;    // Orbit: how far a ring rises off the hub, as a share of its radius
  const HOLD = 0.25;   // how much larger or smaller every shape is drawn
  const FOLD = 0.62, GROW = 0.3; // how much of the way Score's lanes close toward the middle of their row, and how much the shapes grow as they do
  const TAU = 2 * Math.PI;
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
  // The ground of the beat being played: each ground a touch nearer the ruler's neutral. Far too slight to flash.
  const lifted = PALETTES.map(palette => [palette.bg, palette.panel].map(ground => {
    const from = rgb(ground), to = rgb(palette.ink);
    return 'rgb(' + from.map((v, n) => Math.round(v + (to[n] - v) * 0.045)).join(',') + ')';
  }));

  // Where a hit falls within its bar, in steps: Swing delays the off-beats, and a hit by hand sits between steps.
  const place = (pos, swing) => { const s = Math.floor(pos), odd = s & 1; return s + (odd ? swing : 0) + (pos - s) * (odd ? 1 - swing : 1 + swing); };
  // The steps' margin and width, shared by Score and Weave so the device's pads line up under both.
  const columns = (W, cols, u, inset) => { const pad = Math.max(u * 0.35, W * 0.02, inset); return {pad, cw: (W - 2 * pad) / cols}; };

  /* ---------- the styles ----------
   * measure(W, H, inset)  the layout for a canvas size
   * spot(q, L, m, e, v, pos, age, back, tune)
   *                       where one hit is drawn: fills q.x, q.y, q.u, q.angle (the canvas is turned by it), q.left and
   *                       q.right, and returns how large it is drawn, 1 down to 0 (0: not at all). pos is its step
   *                       (below 0: a hit by hand while stopped), age how many bars ago it was heard, back how many
   *                       bars ago its bar began, tune its voice's Tune. m is the model, e this frame's clock.
   * ground(g, L, m, e, palette, lift)   everything behind the hits
   * still(L)              the ages at which the pattern is laid out while stopped
   * depth                 true when older bars lie behind newer ones; otherwise voices lie over each other in order
   * single                true when a step struck again replaces its trace
   * swell                 how much of a ringing hit's swell is shown (1 unless given): Orbit's dial is small
   * shove                 how far a kick shoves the other shapes, as a share of SHOVE (1 unless given): Score's shapes
   *                       are large and lie close, so they move less */
  const score = {
    depth: false, single: true, shove: 0.7,
    // Rows of steps chosen so a step's cell is as close to square as the screen allows; u keeps every shape's share
    // of the picture the same on any screen, so nothing stretches and a circle stays a circle.
    measure(W, H, inset) {
      const rows = W / H < 1.066 ? 2 : 1, cols = STEPS / rows, bandH = H / rows;
      const u = Math.min(Math.sqrt(W * H / 144), bandH / 7, W / cols * 1.3);
      return {W, H, rows, cols, bandH, u, ...columns(W, cols, u, inset)};
    },
    spot(q, L, m, e, v, pos, age, back, tune) {
      const s = Math.max(0, Math.floor(pos)), row = pos < 0 ? 0 : Math.floor(s / L.cols) % L.rows;
      q.x = pos < 0 ? L.W / 2 : L.pad + (place(pos, m.swing) - row * L.cols + 0.5) * L.cw;
      q.y = (row + 0.5 + (SHAPES[v].lane - 0.5) * (1 - FOLD * e.fold) - tune * 0.0075 - e.lean * LEAN * (2 * q.x / L.W - 1)) * L.bandH;
      q.u = L.u * (1 + GROW * e.fold); // closed, the signs are larger
      // Leaning, every shape is turned to lie along the slope, and the snare's bar still reaches both edges.
      q.angle = Math.atan2(-e.lean * LEAN * L.bandH * 2, L.W); q.left = -q.x - (q.angle ? L.u : 0); q.right = L.W - q.x + (q.angle ? L.u : 0);
      // A trace keeps its size until the last fifth of its bar; with short decays it lets go sooner, down to half a bar.
      const life = 1 + Math.min(0, e.hold) * 0.5;
      return age >= life ? 0 : 1 - smooth(life - 0.2, life, age);
    },
    still: () => [0],
    ground(g, L, m, e, palette, lift) {
      const lane = SHAPES[Math.max(0, voiceOf('CH'))].lane;
      const edge = beat => Math.round(beat <= 0 ? 0 : beat >= L.cols / 4 ? L.W : L.pad + beat * 4 * L.cw);
      for (let row = 0; row < L.rows; row++) {
        const top = Math.round(row * L.bandH), height = Math.round((row + 1) * L.bandH) - top, base = (row + lane) * L.bandH;
        g.fillStyle = palette.panel;
        for (let beat = (row + 1) % 2; beat < L.cols / 4; beat += 2) g.fillRect(edge(beat), top, edge(beat + 1) - edge(beat), height);
        if (e.step >= 0 && Math.floor(e.step / L.cols) % L.rows === row) {
          const beat = Math.floor(e.step % L.cols / 4);
          g.fillStyle = lift[(beat + row) % 2];
          g.fillRect(edge(beat), top, edge(beat + 1) - edge(beat), height);
        }
        g.fillStyle = palette.grid;
        for (let c = 0; c < L.cols; c++) {
          const s = row * L.cols + c, h = L.u * (s % 4 ? 0.2 : 0.34);
          g.fillRect(L.pad + (place(s, m.swing) - row * L.cols + 0.5) * L.cw - L.u * 0.04, base - h, L.u * 0.08, h);
        }
        if (e.step >= 0 && Math.floor(e.step / L.cols) % L.rows === row) {
          g.fillStyle = palette.ink;
          g.fillRect(L.pad + (place(e.step, m.swing) - row * L.cols + 0.5) * L.cw - L.u * 0.09, base + L.u * 0.1, L.u * 0.18, L.u * 0.18);
        }
      }
    },
  };

  // Each voice's ring, as a share of the dial's radius (low voices near the hub, the hats on the rim), and how far the
  // ring carries a trace round in a bar when the dial is fully open, in steps. Neighbouring rings turn opposite ways.
  const RAY = 0.5; // how much of its step a kick's ray covers
  const RINGS = {BD: [0.45, 1], LT: [0.57, -1], SD: [0.68, 0.5], CB: [0.75, -0.5], CP: [0.83, 0.5], RS: [0.89, -0.5], OH: [0.96, 0.5], CH: [1, 0]};
  const ROUND = {BD: true, OH: true}; // shapes that look the same whichever way they are turned are not turned
  const orbit = {
    depth: true, single: false, bars: 4, swell: 0.55, shove: 1.7,
    measure(W, H) {
      const R = Math.min(W, H) * 0.41;
      return {W, H, cx: W / 2, cy: H / 2, R, u: R / 5.2, far: Math.hypot(W, H)};
    },
    spot(q, L, m, e, v, pos, age, back, tune) {
      const shape = SHAPES[v], ring = RINGS[shape.id] || [1 - shape.lane * 0.5, 0.25];
      // A hit lands where the hand is; its trace then rides its ring, a little smaller with each bar that passes.
      const a = -TAU / 4 + TAU * (place(Math.max(0, pos), m.swing) + ring[1] * e.open * age) / STEPS;
      const r = (ring[0] + tune * 0.008) * L.R;
      q.x = L.cx + r * Math.cos(a); q.y = L.cy + r * Math.sin(a) - e.lean * RISE * r; q.u = L.u;
      // A shape's own "up" points away from the hub. The snare's bar lies along the radius instead, hub to rim and beyond.
      if (shape.id === 'SD') {
        const dx = Math.cos(a), dy = Math.sin(a);
        q.angle = a; q.left = -r;
        q.right = Math.min(dx > 1e-6 ? (L.W - q.x) / dx : dx < -1e-6 ? -q.x / dx : L.far, dy > 1e-6 ? (L.H - q.y) / dy : dy < -1e-6 ? -q.y / dy : L.far) + L.u;
      } else { q.angle = ROUND[shape.id] ? 0 : a + TAU / 4; q.left = -L.far; q.right = L.far; }
      // A ring that does not turn keeps only its newest trace: the older ones would sit unseen beneath it.
      const bars = this.bars + 2 * e.hold; // longer decays, longer trails: two bars to six
      if (age >= (ring[1] ? bars : 1)) return 0;
      return ring[1] ? (1 - 0.62 * Math.min(1, age / (bars - 1))) * (1 - smooth(bars - 0.75, bars, age)) : 1 - smooth(0.8, 1, age);
    },
    still: () => [0, 1, 2, 3, 4, 5], // the trails as they lie when the dial is half open
    ground(g, L, m, e, palette, lift) {
      // The four beats are the four quarters of the screen, clockwise from the top right.
      const cx = Math.round(L.cx), cy = Math.round(L.cy);
      for (let beat = 0; beat < 4; beat++) {
        const now = e.step >= 0 && Math.floor(e.step / 4) === beat;
        if (!(beat & 1) && !now) continue;
        g.fillStyle = now ? lift[beat & 1] : palette.panel;
        g.fillRect(beat < 2 ? cx : 0, beat === 0 || beat === 3 ? 0 : cy, beat < 2 ? L.W - cx : cx, beat === 0 || beat === 3 ? cy : L.H - cy);
      }
      // Every step the kick plays casts a ray from the hub to the edge of the screen, in the ruler's neutral: each
      // pattern has its own star.
      const kick = voiceOf('BD');
      for (let s = 0; kick >= 0 && !((m.mutes >> kick) & 1) && s < STEPS; s++) {
        if (!m.cells[kick * STEPS + s]) continue;
        const from = -TAU / 4 + TAU * place(s, m.swing) / STEPS, to = -TAU / 4 + TAU * place(s + RAY, m.swing) / STEPS;
        g.fillStyle = palette.grid;
        g.beginPath(); g.moveTo(cx, cy);
        g.lineTo(cx + L.far * Math.cos(from), cy + L.far * Math.sin(from)); g.lineTo(cx + L.far * Math.cos(to), cy + L.far * Math.sin(to));
        g.fill();
      }
      g.fillStyle = palette.grid;
      for (let s = 0; s < STEPS; s++) {
        const a = -TAU / 4 + TAU * place(s, m.swing) / STEPS, h = L.u * (s % 4 ? 0.2 : 0.34);
        g.save(); g.translate(L.cx + L.R * Math.cos(a), L.cy + L.R * Math.sin(a) - e.lean * RISE * L.R); g.rotate(a + TAU / 4);
        g.fillRect(-L.u * 0.04, -h, L.u * 0.08, h);
        g.restore();
      }
      g.fillStyle = palette.ink;
      g.beginPath(); g.arc(L.cx, L.cy, L.u * 0.14, 0, TAU); g.fill();
      if (e.step < 0) return;
      // The hand sweeps the bar without stopping at the steps.
      const a = -TAU / 4 + TAU * place(e.bars % 1 * STEPS, m.swing) / STEPS;
      g.save(); g.translate(L.cx, L.cy); g.rotate(a);
      g.fillRect(L.u * 0.14, -L.u * 0.03, L.R * 0.28, L.u * 0.06);
      g.restore();
    },
  };

  // Where each voice sits within its step's cell, in row heights from the row's middle: the cell reads as one sign.
  const SIGNS = {BD: 0.04, SD: -0.04, CH: 0.44, OH: -0.2, CP: -0.3, LT: 0.1, RS: -0.12, CB: 0.2};
  const weave = {
    depth: true, single: false, shove: 2.6,
    measure(W, H, inset) {
      const cols = W / H < 1.066 ? 8 : STEPS, side = columns(W, cols, Math.sqrt(W * H / 144), inset), rh = side.cw * 1.12;
      const rows = STEPS / cols; // rows per bar
      return {W, H, cols, rows, rh, barH: rh * rows, u: side.cw * 0.42, write: H - rh * 0.6, bars: Math.min(KEEP_BARS - 1, Math.ceil(H / (rh * rows)) + 1), ...side};
    },
    spot(q, L, m, e, v, pos, age, back, tune) {
      const shape = SHAPES[v], s = Math.max(0, Math.floor(pos)), row = pos < 0 ? 0 : Math.floor(s / L.cols) % L.rows;
      q.x = pos < 0 ? L.W / 2 : L.pad + (place(pos, m.swing) - row * L.cols + 0.5) * L.cw;
      // The row being written sits at the bottom. When it is full the cloth moves up one row at once: a steady crawl
      // would sweep every shape past every point of the screen, which at fast tempos is a flicker.
      q.y = L.write - (back - this.part(L, e) - row / L.rows) * L.barH + ((SIGNS[shape.id] ?? shape.lane - 0.5) - tune * 0.014 - e.lean * DRAPE * (2 * q.x / L.W - 1)) * L.rh;
      q.u = L.u; q.angle = Math.atan2(-e.lean * DRAPE * L.rh * 2, L.W); q.left = -q.x - (q.angle ? L.u : 0); q.right = L.W - q.x + (q.angle ? L.u : 0);
      return q.y < -L.rh || back >= L.bars ? 0 : 1;
    },
    still: L => Array.from({length: L.bars}, (_, k) => k),
    // How much of a bar has gone by since the cloth last moved.
    part: (L, e) => e.step < 0 ? 0 : e.bars * L.rows % 1 / L.rows,
    ground(g, L, m, e, palette, lift) {
      const edge = beat => Math.round(beat <= 0 ? 0 : beat >= L.cols / 4 ? L.W : L.pad + beat * 4 * L.cw);
      g.fillStyle = palette.panel;
      for (let beat = 1; beat < L.cols / 4; beat += 2) g.fillRect(edge(beat), 0, edge(beat + 1) - edge(beat), L.H);
      // Every other phrase of four bars is woven the other way round, so the cloth shows where the phrases turn.
      for (let phrase = Math.floor(e.bars / 4); e.step >= 0 && phrase >= 0 && e.bars - phrase * 4 - 3 < L.bars; phrase--) {
        if (!(phrase & 1)) continue;
        const top = Math.round(L.write - (e.bars - this.part(L, e) - phrase * 4) * L.barH - L.rh / 2), height = Math.round(4 * L.barH);
        for (let beat = 0; beat < L.cols / 4; beat++) {
          g.fillStyle = beat & 1 ? palette.bg : palette.panel;
          g.fillRect(edge(beat), top, edge(beat + 1) - edge(beat), height);
        }
      }
      const base = L.write + L.rh * 0.44;
      g.fillStyle = palette.grid;
      const row = e.step < 0 ? 0 : Math.floor(e.step / L.cols) % L.rows;
      for (let c = 0; c < L.cols; c++) {
        const s = row * L.cols + c, h = L.u * (s % 4 ? 0.2 : 0.34);
        g.fillRect(L.pad + (place(s, m.swing) - row * L.cols + 0.5) * L.cw - L.u * 0.04, base - h, L.u * 0.08, h);
      }
      if (e.step < 0) return;
      g.fillStyle = palette.ink;
      g.fillRect(L.pad + (place(e.step, m.swing) - row * L.cols + 0.5) * L.cw - L.u * 0.09, base + L.u * 0.1, L.u * 0.18, L.u * 0.18);
    },
  };
  const styles = [score, orbit, weave];

  // readback: the canvas will be read pixel by pixel (tests), so the browser keeps one rasterizer for it throughout.
  return function createStage(canvas, {maxPixels = Infinity, readback = false} = {}) {
    const g = canvas.getContext('2d', {alpha: false, willReadFrequently: readback});
    const model = {
      cells: new Uint8Array(SHAPES.length * STEPS), bpm: 120, swing: 0, mutes: 0,
      tune: SHAPES.map(() => 0), decay: SHAPES.map(() => 50), theme: 0, style: 0, sel: 0, playing: false,
    };
    const records = SHAPES.map(() => []); // each voice's hits, oldest first
    const stepLog = [], hitLog = [], items = [];
    const CH = voiceOf('CH'), OH = voiceOf('OH'), BD = voiceOf('BD');
    const kicks = [];
    let W = 1, H = 1, edge = 0, scale = 1, lastT = 0, selAt = -1e9, voice = 0, step = 0, bar = 0, count = 0;
    let style = score, L = score.measure(1, 1, 0);
    const p = {x: 0, y: 0, u: 1, level: 0, t: 0, size: 1, step: 0, left: 0, right: 1, rand: n => hash(voice, step, n)};
    const q = {x: 0, y: 0, u: 1, angle: 0, left: 0, right: 0};
    // This frame's place in the music. step: the step being played (-1 while stopped). bars: bars since Start, with the
    // part of the bar played so far. open: how far Orbit's rings carry their traces, 0 to 1. fold: how far Score's
    // lanes have closed, 0 to 1. lean, hold: what the voices' Tune and Decay add up to, each -1 to 1.
    const clock = {step: -1, bars: 0, open: 0.5, fold: 0, lean: 0, hold: 0};
    // heard[v]: milliseconds since voice v was last heard, as of the last frame (Infinity when silent).
    const stage = {origin: 0, frames: 0, firstFrameAt: 0, playStep: -1, model, heard: SHAPES.map(() => Infinity)};
    const lay = () => { style = styles[model.style] || score; L = style.measure(W, H, edge); };

    // inset: CSS pixels at the left edge that take no touch on the device; the steps keep clear of it on both sides.
    stage.resize = (width, height, ratio = 1, inset = 0) => {
      scale = Math.min(ratio, Math.sqrt(maxPixels / Math.max(1, width * height)));
      W = Math.max(1, Math.round(width * scale)); H = Math.max(1, Math.round(height * scale));
      canvas.width = W; canvas.height = H; edge = inset * scale;
      lay();
    };
    // Where Score's and Weave's 16 steps sit, in CSS pixels, so the device's step pads can line up under them.
    stage.columns = () => { const at = score.measure(W, H, edge); return {rows: at.rows, pad: at.pad / scale, width: at.cw / scale}; };
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
      if (next.style !== undefined) lay();
    };
    stage.reset = () => { records.forEach(list => { list.length = 0; }); stepLog.length = 0; stage.playStep = -1; bar = 0; };

    function add(v, record) {
      const list = records[v];
      while (list.length && list[0].bar < record.bar - KEEP_BARS && list[0].time < record.time - 2000) list.shift();
      record.punch = 1; record.gap = 1e9; record.tune = model.tune[v]; record.drawnAt = 0; record.heardAt = 0;
      for (let i = list.length - 1; i >= 0 && !record.silent; i--) {
        if (list[i].silent) continue;
        record.gap = record.time - list[i].time; // since this voice was last heard
        record.punch = Math.max(0.2, Math.min(1, record.gap / CALM_MS));
        break;
      }
      list.push(record);
      if (record.silent) return;
      hitLog.push({voice: v, record});
      if (hitLog.length > 64) hitLog.shift();
    }
    // The sequencer reached a step. first marks the first step after Start: the pattern's traces are laid down as if
    // the bars before had been played, so the picture carries on from the still one instead of emptying.
    // Returns the bar it belongs to, counted from Start; a follower passes the leader's count in as at.
    stage.step = ({step: s, mask, accents, time, first, bar: at}) => {
      if (first) {
        stage.reset();
        const stepMs = 15000 / model.bpm;
        for (let v = 0; v < SHAPES.length; v++) for (let back = KEEP_BARS - 1; back >= 1; back--) for (let k = 0; k < STEPS; k++) {
          const value = model.cells[v * STEPS + k];
          if (value) add(v, {time: time - (back * STEPS - k) * stepMs, bar: -back, pos: k, cell: k, accent: value === 2, silent: true, manual: false});
        }
      } else if (s === 0) bar++;
      if (Number.isInteger(at) && at >= 0) bar = at;
      stepLog.push({time, step: s, bar});
      if (stepLog.length > 48) stepLog.shift();
      for (let v = 0; v < SHAPES.length; v++) {
        if ((mask >> v) & 1) add(v, {time, bar, pos: s, cell: s, accent: !!((accents >> v) & 1), silent: false, manual: false});
      }
      return bar;
    };
    // A hit by hand. While playing it lands where the bar is at that moment; while stopped, in the middle (pos -1).
    stage.strike = ({voice: v, time, pos, bar: at}) => {
      if (pos === undefined) {
        pos = -1; at = bar;
        for (let i = stepLog.length - 1; model.playing && i >= 0; i--) {
          const from = stepLog[i];
          if (from.time > time) continue;
          const length = 15000 / model.bpm * (from.step & 1 ? 1 - model.swing : 1 + model.swing);
          pos = from.step + Math.min(0.999, (time - from.time) / length); at = from.bar;
          break;
        }
      }
      add(v, {time, bar: at ?? bar, pos, cell: -1, accent: false, silent: false, manual: true});
      return {pos, bar: at ?? bar};
    };
    stage.hits = () => hitLog.map(({voice: v, record}) => ({
      voice: SHAPES[v].id, step: record.pos < 0 ? -1 : Math.floor(record.pos), accent: record.accent, manual: record.manual,
      audioTime: record.heardAt || record.time + stage.origin, drawnAt: record.drawnAt || null,
    }));

    // Where the music is at audio time t: the step being played and the bars since Start.
    function tell(t) {
      clock.step = -1;
      for (let i = stepLog.length - 1; model.playing && i >= 0; i--) {
        const from = stepLog[i];
        if (from.time > t) continue;
        const next = stepLog[i + 1], length = next ? next.time - from.time : 15000 / model.bpm * (from.step & 1 ? 1 - model.swing : 1 + model.swing);
        clock.step = from.step; clock.bars = from.bar + (from.step + Math.min(1, (t - from.time) / length)) / STEPS;
        break;
      }
      // Orbit opens over eight bars and closes over the next eight. It starts half open, as the still picture lies.
      clock.open = clock.step < 0 ? 0.5 : (1 + Math.sin(TAU * clock.bars / 16)) / 2;
      // Score's lanes close over four bars and open over the next four.
      clock.fold = clock.step < 0 ? 0 : (1 - Math.cos(TAU * clock.bars / 8)) / 2;
      stage.playStep = clock.step;
    }

    // One thing to draw this frame. Kept and reused from frame to frame.
    function item(v, record, pos, age, back, tune, level, strength, grow, layer, order) {
      const size = style.spot(q, L, model, clock, v, pos, age, back, tune);
      const shown = level > 0 ? Math.max(size, Math.min(1, level * 8)) : size;
      if (shown < 0.02) return;
      // A hit lands at its usual size and settles into the larger or smaller trace that the Decays ask for, so long
      // decays do not make the moment of the hit any larger.
      const it = items[count] || (items[count] = {});
      count++;
      it.v = v; it.x = q.x; it.y = q.y; it.u = q.u; it.angle = q.angle; it.left = q.left; it.right = q.right;
      it.step = Math.max(0, Math.floor(pos)); it.level = level * (style.swell || 1); it.strength = strength; it.size = grow * shown * (1 + HOLD * clock.hold * (1 - level) * (1 - level));
      it.t = record ? (lastT - record.time) / 1000 : 1000; it.layer = layer; it.order = order;
      it.shove = v === BD && record && level > 0 ? Math.max(0, Math.min(1, (record.gap - SHOVE_NONE_MS) / (SHOVE_FULL_MS - SHOVE_NONE_MS))) * (record.accent ? 1 : 0.8) * recoil(it.t * 1000) * Math.min(1, level * 6) : 0;
      it.ringing = v === BD && level > 0;
    }

    // A muted voice leaves the picture: only a hit by hand, which still sounds, is drawn.
    function gather(v, t, muted) {
      const shape = SHAPES[v], list = records[v], selected = v === model.sel, over = selected ? SHAPES.length : v;
      const pop = selected ? 0.25 * Math.exp(-Math.max(0, t - selAt) / 160) : 0;
      const length = shape.seconds * Math.pow(2, (model.decay[v] - 50) / 25) * 1000, barMs = 240000 / model.bpm;
      stage.heard[v] = Infinity;
      if (!model.playing && !muted) {
        for (const back of style.still(L)) for (let s = 0; s < STEPS; s++) {
          const value = model.cells[v * STEPS + s];
          if (!value) continue;
          const breath = Math.sin(t / 700 + s * 0.4 + back); // a slow, slight swell that travels along the bar
          item(v, null, s, back, back, model.tune[v], 0, REST[value - 1], (value === 2 ? ACCENT : 1) * (1 + pop) * (1 + 0.02 * breath), -back, over * 64 + s);
        }
      }
      // Newest first: only a voice's latest hit rings (the one before lets go), and in Score a step struck again
      // replaces its trace.
      let newer = 0, cutAt = Infinity, seen = 0;
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
        const again = style.single && record.cell >= 0 && (seen >> record.cell) & 1;
        if (record.cell >= 0) seen |= 1 << record.cell;
        // While playing a hit ages with the music; a hit by hand while stopped ages with the clock; and when the
        // music has stopped, a hit still ringing finishes over the still picture.
        let age, back;
        if (clock.step >= 0) { back = clock.bars - record.bar; age = back - Math.max(0, record.pos) / STEPS; }
        else if (record.manual) { age = (t - record.time) / barMs; back = 0; if (age >= 1) continue; }
        else { if (level <= 0) continue; age = 0; back = 0; }
        if (again && level <= 0) continue;
        const k = record.accent ? 1 : 0, strength = REST[k] + (HIT[k] - REST[k]) * Math.pow(level, 0.6);
        item(v, record, record.pos, Math.max(0, age), back, clock.step >= 0 ? record.tune : model.tune[v], level, strength, (record.accent ? ACCENT : 1) * (1 + pop),
          style.depth ? record.bar : 0, over * 64 + (style.depth ? Math.max(0, record.pos) : STEPS + i));
      }
    }

    // Draw the picture as it is at screen time now (a performance.now() value).
    stage.render = now => {
      const t = now - stage.origin + LOOK_MS, palette = PALETTES[model.theme];
      lastT = t; stage.now = now;
      tell(t);
      let tuned = 0, kept = 0;
      for (let v = 0; v < SHAPES.length; v++) { tuned += model.tune[v]; kept += model.decay[v] - 50; }
      clock.lean = Math.max(-1, Math.min(1, tuned / 24)); clock.hold = Math.max(-1, Math.min(1, kept / 100));
      g.fillStyle = palette.bg;
      g.fillRect(0, 0, W, H);
      g.lineCap = 'butt'; g.lineJoin = 'miter';
      style.ground(g, L, model, clock, palette, lifted[model.theme]);
      count = 0;
      for (let v = 0; v < SHAPES.length; v++) gather(v, t, !!((model.mutes >> v) & 1));
      // Older bars lie behind newer ones; within a bar later voices in shapes.js lie over earlier ones, and the
      // selected voice over them all.
      const drawn = items.slice(0, count).sort((a, b) => a.layer - b.layer || a.order - b.order);
      // A ringing kick shoves the other shapes away from where it sits.
      kicks.length = 0;
      let on = 0;
      for (let v = 0; v < SHAPES.length; v++) for (let k = 0; !((model.mutes >> v) & 1) && k < STEPS; k++) if (model.cells[v * STEPS + k]) on++;
      const far = SHOVE * (style.shove || 1) * Math.min(1, ROOMY / Math.max(1, on));
      for (const it of drawn) if (it.shove > 0.01) kicks.push(it.x, it.y, it.shove * it.u * far, it.u * REACH);
      for (const it of kicks.length ? drawn : []) {
        if (it.ringing) continue;
        let mx = 0, my = 0;
        for (let k = 0; k < kicks.length; k += 4) {
          const dx = it.x - kicks[k], dy = it.y - kicks[k + 1], d = Math.hypot(dx, dy);
          if (d < 1) continue;
          const away = d / kicks[k + 3], f = kicks[k + 2] / (1 + away * away) / d;
          mx += dx * f; my += dy * f;
        }
        it.x += mx; it.y += my;
        if (!it.angle) { it.left -= mx; it.right -= mx; } // a shape that reaches the screen's edges still reaches them
      }
      for (const it of drawn) {
        voice = it.v; step = it.step;
        p.u = it.u; p.level = it.level; p.t = it.t; p.size = it.size; p.step = it.step;
        g.fillStyle = g.strokeStyle = tables[model.theme][SHAPES[it.v].color][Math.round((Math.max(0.5, Math.min(1.5, it.strength)) - 0.5) * 2 * TINTS)];
        if (it.angle) {
          g.save(); g.translate(it.x, it.y); g.rotate(it.angle);
          p.x = 0; p.y = 0; p.left = it.left; p.right = it.right;
          SHAPES[it.v].draw(g, p);
          g.restore();
        } else {
          p.x = it.x; p.y = it.y; p.left = it.x + it.left; p.right = it.x + it.right;
          SHAPES[it.v].draw(g, p);
        }
      }
      stage.frames++;
      if (!stage.firstFrameAt) stage.firstFrameAt = performance.now();
    };
    return stage;
  };
})();

