'use strict';
/* The eight shapes. One entry per drum voice. To change how one drum looks, edit its entry here and
 * nothing else.
 *
 *   id       two-letter name. engine.js plays the voices in this same order.
 *   name     full name
 *   color    which of the palette's four shape colours it takes, 0-3 (the palettes are in stage.js)
 *   lane     resting height in the picture: 0 is the top, 1 the bottom. Tune moves the voice up and down from here.
 *   seconds  how long one hit rings at Decay 50, taken from the voice's sound in engine.js. Decay scales it.
 *   draw(g, p)
 *            paints one hit. The stage calls it on every frame from the moment the hit is heard until its trace has
 *            faded a bar later, and once per step for the still picture. g is a CanvasRenderingContext2D whose
 *            fillStyle and strokeStyle are already this hit's flat colour: paint with fill and stroke only. Keep
 *            the function under 40 lines. p holds:
 *
 *     p.x, p.y      the hit's place in pixels: x is its step, y is the voice's lane moved by Tune
 *     p.u           size unit in pixels, about one step wide. Multiply every length by it.
 *     p.level       how loud the hit still is: 1 at the hit, falling to 0 as the sound dies away. At 0 only the trace
 *                   is left, and the still picture is drawn at 0.
 *     p.t           seconds since the hit (a large number for the still picture)
 *     p.size        1 for a normal hit, 1.25 for an accent; a little more for a moment when the voice is selected
 *     p.step        the step, 0-15
 *     p.left, p.right   the left and right edges of the picture in pixels, for shapes that cross it
 *     p.rand(n)     a fixed number from 0 to 1 for this voice, this step and n: the same on every loop and on every
 *                   screen. Use it wherever a shape should look scattered; never use the browser's random numbers.
 *
 * The stage picks the colour (brighter for an accent, fading with the trace) and keeps the picture the same on the
 * device and on the big screen. Two rules keep the picture safe to watch: flat colour only, and no voice larger than
 * the kick. The browser test in tests/ measures the flashing area at 240 BPM with every step filled. */
const SHAPES = [
  {
    id: 'BD', name: 'Bass Drum', color: 0, lane: 0.66, seconds: 1.0,
    // The biggest sound is the biggest shape: a solid disc that swells from its centre and sinks back.
    draw(g, p) {
      const swell = Math.min(1, p.t / 0.03);
      const r = p.u * p.size * (1.1 + 0.95 * p.level * swell);
      g.beginPath();
      g.arc(p.x, p.y, r, 0, 2 * Math.PI);
      g.fill();
    },
  },
  {
    id: 'SD', name: 'Snare Drum', color: 1, lane: 0.47, seconds: 0.28,
    // A thick bar cuts across the picture from one side, then pulls back to a stub at its step. The snare's noise
    // is the crumbs along its edges, thrown outward by the hit.
    draw(g, p) {
      const thick = p.u * p.size * (0.42 + 0.14 * p.level), stub = p.u * p.size * 1.3;
      const reach = p.level * p.level, cut = Math.min(1, p.t / 0.045);
      let x0 = p.x - stub - (p.x - stub - p.left) * reach, x1 = p.x + stub + (p.right - p.x - stub) * reach;
      if (p.step % 8 < 4) x1 = x0 + (x1 - x0) * cut; else x0 = x1 - (x1 - x0) * cut;
      g.fillRect(x0, p.y - thick / 2, x1 - x0, thick);
      for (let n = 0; n < 12; n++) {
        const r = p.u * p.size * (0.05 + 0.045 * p.rand(n)), side = n % 2 ? 1 : -1;
        const x = p.x + ((n >> 1) - 2.5 + (p.rand(n + 10) - 0.5) * 0.5) * p.u * p.size * 0.44;
        const away = thick / 2 + r + p.u * (0.07 + 0.9 * p.rand(n + 20) * p.level);
        g.beginPath();
        g.arc(x, p.y + side * away, r, 0, 2 * Math.PI);
        g.fill();
      }
    },
  },
  {
    id: 'CH', name: 'Closed Hat', color: 1, lane: 0.955, seconds: 0.09,
    // The hats draw the ruler of time along the bottom: one thin tick per step, kicked upward by a hit.
    draw(g, p) {
      const w = p.u * 0.2, h = p.u * p.size * (0.56 + 0.9 * p.level);
      g.fillRect(p.x - w / 2, p.y - h, w, h);
    },
  },
  {
    id: 'OH', name: 'Open Hat', color: 2, lane: 0.19, seconds: 0.5,
    // Open means it lasts: a ring stays at the step while a second ring spreads outward and thins with the sound.
    draw(g, p) {
      const r = p.u * p.size * 0.62;
      g.lineWidth = p.u * p.size * 0.2;
      g.beginPath();
      g.arc(p.x, p.y, r, 0, 2 * Math.PI);
      g.stroke();
      if (p.level <= 0) return;
      g.lineWidth = p.u * p.size * 0.16 * p.level;
      g.beginPath();
      g.arc(p.x, p.y, r + p.u * p.size * (0.3 + 0.9 * (1 - p.level)), 0, 2 * Math.PI);
      g.stroke();
    },
  },
  {
    id: 'CP', name: 'Hand Clap', color: 3, lane: 0.33, seconds: 0.35,
    // A clap is a few bursts of noise about 10 ms apart, so its squares arrive one after another.
    draw(g, p) {
      const side = p.u * p.size * (0.36 + 0.14 * p.level), gap = p.u * p.size * 0.46;
      for (let n = 0; n < 4; n++) {
        if (p.t < n * 0.0095) break;
        const x = p.x + (n - 1.5) * gap, y = p.y + (n % 2 ? -1 : 1) * gap * 0.35 + (p.rand(n) - 0.5) * gap * 0.3;
        g.fillRect(x - side / 2, y - side / 2, side, side);
      }
    },
  },
  {
    id: 'LT', name: 'Low Tom', color: 2, lane: 0.57, seconds: 0.7,
    // Pitch is height: a triangle drops onto its lane and bounces a little.
    draw(g, p) {
      const bounce = p.u * 1.1 * Math.abs(Math.cos(p.t * 22)) * Math.exp(-p.t * 9);
      const s = p.u * p.size * (1.5 + 0.5 * p.level), h = s * 0.87, y = p.y - bounce;
      g.beginPath();
      g.moveTo(p.x, y - h * 0.6);
      g.lineTo(p.x + s / 2, y + h * 0.4);
      g.lineTo(p.x - s / 2, y + h * 0.4);
      g.closePath();
      g.fill();
    },
  },
  {
    id: 'RS', name: 'Rim Shot', color: 0, lane: 0.36, seconds: 0.06,
    // The shortest sound is the shortest shape: a slash that is thick for an instant and then only a hairline.
    draw(g, p) {
      const half = p.u * p.size * 0.7;
      g.lineWidth = p.u * p.size * (0.1 + 0.22 * p.level);
      g.beginPath();
      g.moveTo(p.x - half, p.y + half);
      g.lineTo(p.x + half, p.y - half);
      g.stroke();
    },
  },
  {
    id: 'CB', name: 'Cowbell', color: 3, lane: 0.42, seconds: 0.32,
    // The cowbell is two square waves: two rectangles, one solid and one outlined, set apart at the hit and sliding
    // back over each other.
    draw(g, p) {
      const w = p.u * p.size * (0.8 + 0.26 * p.level), h = w * 0.6, shift = p.u * p.size * (0.14 + 0.3 * p.level);
      g.fillRect(p.x - w / 2 - shift, p.y - h / 2 - shift * 0.6, w, h);
      g.lineWidth = p.u * p.size * 0.09;
      g.strokeRect(p.x - w / 2 + shift, p.y - h / 2 + shift * 0.6, w, h);
    },
  },
];
