// formulas.js: every formula the App can draw, and nothing else. One entry in the list is one formula.
//
// To add a formula, append an entry:
//   id       short lower-case name (a-z, 0-9, -). Saved settings and share links carry it: never change it later.
//   name     shown beside K2.
//   text     the lines shown on the device screen.
//   range    lowest and highest value of each of the four letters a, b, c, d.
//   view     half the width of the square that is always in the picture: (0, 0) is its centre and it reaches from
//            -view to +view both ways. It is fixed, so the figure never rescales while a knob turns.
//   centre   optional [x, y] (or [x, y, z]): the middle of that square when it is not (0, 0).
//   step     one step of the formula: a GLSL ES 3.0 expression for the next point (a vec2) from the current point p
//            (p.x, p.y) and the letters a, b, c, d. Write whole numbers with a decimal point (2.0, not 2).
//   with     optional helper values, each 'name = expression', worked out in order before step and usable in it.
//   sway     optional [a, b, c, d], each 0 to 1: how much of the show's sway, and of what sound adds, each letter
//            takes (1 if left out). Some letters of some formulas cannot move far before the figure falls in on
//            itself (a letter that sets how fast the points close in, mostly): give those a small share.
//   presets  six [a, b, c, d] sets with two decimals, inside the range (six fill two rows in Figures). The first
//            opens with the formula.
//            Look at each one on the screen: it should stay inside the square and not collapse to a few points.
//
// A formula in three dimensions that moves smoothly (a flow) has, instead of step:
//   flow     the rate of change of the point: a vec3 expression of p (p.x, p.y, p.z) and the letters.
//   dt       how much of its time one step covers.
//   steps    optional: how many such steps each drawing takes (1 if left out). More makes the figure follow the
//            knobs sooner; it costs as many times the work.
//   thread   how much of its time the line it is drawn as covers: a flow is drawn as one long path wound into its
//            figure (thread.js follows it). About 150 turns of the figure look right. Left out, the flow is drawn
//            as a cloud of separate points.
//   strands  optional, 1 to 6: that many paths, each "thread" long, started in different directions. For a figure
//            that comes in several alike, where one path would find only one of them.
// z points up.
//
// A flow's expressions are also read by thread.js: keep to numbers, + - * /, brackets, the letters, p.x p.y p.z, the
// helper names, and sin cos tan abs sign sqrt exp log floor fract pow mod min max atan.
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
    sway: [1, 1, 0.5, 0.5],
    presets: [
      [1.49, -2.28, 2.36, -2.13],
      [-2.0, -2.0, -1.2, 2.0],
      [-1.19, -2.29, -2.48, 1.76],
      [-2.82, 1.24, -0.75, -2.45],
      [1.98, 0.95, 1.1, 1.92],
      [-0.78, -1.85, 2.2, 1.73],
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
    ],
  },
  {
    id: 'mira',
    name: 'Gumowski-Mira',
    text: ['f(x) = a·x + 2d(1 − a)·x²/(1 + x²)', 'x ← y + 0.01b(1 − 0.1c·y²)·y + f(x)', 'y ← f(new x) − x'],
    range: [-3, 3],
    view: 13,
    centre: [1.7, -1.4],
    with: ['u = p.y + 0.01 * b * (1.0 - 0.1 * c * p.y * p.y) * p.y + a * p.x + 2.0 * d * (1.0 - a) * p.x * p.x / (1.0 + p.x * p.x)'],
    step: 'vec2(u, a * u + 2.0 * d * (1.0 - a) * u * u / (1.0 + u * u) - p.x)',
    sway: [0.1, 1, 1, 1],
    presets: [
      [-0.48, 0.9, 0.5, 1.0],
      [-0.2, 0.8, 0.5, 1.0],
      [-0.13, 0.85, 0.36, 1.29],
      [-0.22, 2.35, 0.61, 1.37],
      [-0.43, 0.32, 2.1, 1.3],
      [-0.26, 1.35, 0.23, 1.07],
    ],
  },
  {
    id: 'ikeda',
    name: 'Ikeda',
    text: ['t = 0.4b − 6c/(1 + x² + y²)', 'x ← a + d(x·cos t − y·sin t)', 'y ← d(x·sin t + y·cos t)'],
    range: [-3, 3],
    view: 1.9,
    centre: [0.8, -0.5],
    with: ['t = 0.4 * b - 6.0 * c / (1.0 + p.x * p.x + p.y * p.y)'],
    step: 'vec2(a + d * (p.x * cos(t) - p.y * sin(t)), d * (p.x * sin(t) + p.y * cos(t)))',
    sway: [0.1, 0.3, 0.1, 0.03],
    presets: [
      [1.0, 1.0, 1.0, 0.9],
      [1.24, 1.24, 1.72, 0.85],
      [1.35, 1.39, 1.9, 0.82],
      [1.09, 1.34, 1.51, 0.83],
      [0.93, 1.86, 1.67, 0.86],
      [1.37, 1.33, 1.69, 0.78],
    ],
  },
  {
    id: 'lorenz',
    name: 'Lorenz',
    text: ['x′ = 10a(y − x)', 'y′ = x(28b − z) − d·y', 'z′ = x·y − (8/3)c·z'],
    range: [-3, 3],
    view: 36,
    centre: [0, 0, 32],
    flow: 'vec3(10.0 * a * (p.y - p.x), p.x * (28.0 * b - p.z) - d * p.y, p.x * p.y - 2.6666667 * c * p.z)',
    dt: 0.01,
    steps: 4,
    thread: 110,
    presets: [
      [1.0, 1.0, 1.0, 1.0],
      [1.97, 0.91, 0.66, 0.65],
      [1.37, 1.27, 0.68, 1.38],
      [0.69, 1.22, 0.6, 1.04],
      [0.82, 1.33, 0.94, 1.04],
      [1.6, 1.0, 1.0, 1.0],
    ],
  },
  {
    id: 'aizawa',
    name: 'Aizawa',
    text: ['x′ = (z − b)x − 3.5d·y', 'y′ = 3.5d·x + (z − b)y', 'z′ = c + a·z − z³/3 − (x² + y²)(1 + z/4) + z·x³/10'],
    range: [-3, 3],
    view: 2.0,
    centre: [0, 0, 0.3],
    flow: 'vec3((p.z - b) * p.x - 3.5 * d * p.y, 3.5 * d * p.x + (p.z - b) * p.y, c + a * p.z - p.z * p.z * p.z / 3.0 - (p.x * p.x + p.y * p.y) * (1.0 + 0.25 * p.z) + 0.1 * p.z * p.x * p.x * p.x)',
    dt: 0.02,
    steps: 3,
    thread: 260,
    presets: [
      [0.95, 0.7, 0.6, 1.0],
      [1.08, 0.83, 0.43, 1.1],
      [1.09, 0.72, 0.67, 1.38],
      [1.02, 0.59, 0.8, 1.53],
      [0.77, 0.46, 0.66, 1.26],
      [1.14, 0.65, 0.83, 0.63],
    ],
  },
  {
    id: 'thomas',
    name: 'Thomas',
    text: ['x′ = sin(b·y) − 0.2a·x', 'y′ = sin(c·z) − 0.2a·y', 'z′ = sin(d·x) − 0.2a·z'],
    range: [-3, 3],
    view: 7.4,
    flow: 'vec3(sin(b * p.y) - 0.2 * a * p.x, sin(c * p.z) - 0.2 * a * p.y, sin(d * p.x) - 0.2 * a * p.z)',
    dt: 0.08,
    thread: 420,
    strands: 6,
    presets: [
      [1.04, 1.0, 1.0, 1.0],
      [0.6, 1.0, 1.0, 1.0],
      [0.73, 1.09, 1.09, 1.35],
      [0.65, 0.77, 1.38, 0.99],
      [0.68, 0.93, 1.59, 0.82],
      [0.82, 1.19, 1.45, 1.39],
    ],
  },
];
