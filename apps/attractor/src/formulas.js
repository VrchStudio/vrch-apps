// formulas.js: every formula the App can draw, and nothing else. One entry in the list is one formula.
//
// To add a formula, append an entry:
//   id       short lower-case name (a-z, 0-9, -). Saved settings and share links carry it: never change it later.
//   name     shown beside K4.
//   text     the two lines shown on the device screen.
//   range    lowest and highest value of each of the four letters a, b, c, d.
//   view     half the width of the square that is always in the picture: (0, 0) is its centre and it reaches from
//            -view to +view both ways. It is fixed, so the figure never rescales while a knob turns.
//   step     one step of the formula: a GLSL ES 3.0 expression for the next point (a vec2) from the current point p
//            (p.x, p.y) and the letters a, b, c, d. Write whole numbers with a decimal point (2.0, not 2).
//   presets  six or more [a, b, c, d] sets with two decimals, inside the range. The first opens with the formula.
//            Look at each one on the screen: it should stay inside the square and not collapse to a few points.
// Then run the repository's unit tests (python3 -m unittest discover -s tests): they step every preset and fail on
// one that collapses or leaves the square.
window.Formulas = [
  {
    id: 'dejong',
    name: 'De Jong',
    text: ['x ← sin(a·y) − cos(b·x)', 'y ← sin(c·x) − cos(d·y)'],
    range: [-3, 3],
    view: 2.1,
    step: 'vec2(sin(a * p.y) - cos(b * p.x), sin(c * p.x) - cos(d * p.y))',
    presets: [
      [1.49, -2.28, 2.36, -2.13],
      [-2.0, -2.0, -1.2, 2.0],
      [-1.19, -2.29, -2.48, 1.76],
      [-2.82, 1.24, -0.75, -2.45],
      [1.98, 0.95, 1.1, 1.92],
      [-0.78, -1.85, 2.2, 1.73],
      [-0.83, -1.64, 1.66, -0.94],
    ],
  },
  {
    id: 'clifford',
    name: 'Clifford',
    text: ['x ← sin(a·y) + c·cos(a·x)', 'y ← sin(b·x) + d·cos(b·y)'],
    range: [-3, 3],
    view: 2.5,
    step: 'vec2(sin(a * p.y) + c * cos(a * p.x), sin(b * p.x) + d * cos(b * p.y))',
    presets: [
      [-1.4, 1.6, 1.0, 0.7],
      [1.7, 1.7, 0.6, 1.2],
      [-1.18, -1.45, 1.26, 1.29],
      [-1.41, 1.45, -1.26, 1.36],
      [1.44, 1.77, -0.9, -1.43],
      [-1.32, -1.29, -1.4, 0.88],
      [1.15, -1.19, 1.14, 1.37],
    ],
  },
  {
    id: 'svensson',
    name: 'Svensson',
    text: ['x ← d·sin(a·x) − sin(b·y)', 'y ← c·cos(a·x) + cos(b·y)'],
    range: [-3, 3],
    view: 2.65,
    step: 'vec2(d * sin(a * p.x) - sin(b * p.y), c * cos(a * p.x) + cos(b * p.y))',
    presets: [
      [1.5, -1.8, 1.6, 0.9],
      [1.4, 1.56, 1.4, -1.5],
      [0.96, -2.03, 1.49, 1.26],
      [-1.53, -1.4, -1.12, 1.02],
      [1.53, 0.96, -1.41, -1.12],
      [1.44, 1.77, -0.9, -1.43],
      [-1.83, -1.85, -0.59, -0.58],
    ],
  },
  {
    id: 'dream',
    name: 'Fractal Dream',
    text: ['x ← sin(b·y) + c·sin(b·x)', 'y ← sin(a·x) + d·sin(a·y)'],
    range: [-3, 3],
    view: 2.5,
    step: 'vec2(sin(b * p.y) + c * sin(b * p.x), sin(a * p.x) + d * sin(a * p.y))',
    presets: [
      [-1.41, 1.45, -1.26, 1.36],
      [1.24, -2.47, 1.31, -0.92],
      [-2.98, 1.74, 1.17, -0.67],
      [-1.71, -2.54, -0.35, 1.32],
      [-2.99, -1.42, -1.05, -0.81],
      [1.06, 2.9, -0.72, 1.41],
      [-1.49, -2.39, 0.82, -0.78],
    ],
  },
];
