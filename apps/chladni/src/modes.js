// modes.js: how the plate vibrates, and nothing else. One entry in the list is one plate.
//
// The plate lies in a square that reaches from 0 to 1 both ways; its centre is (0.5, 0.5). A mode is two whole
// numbers n and m (from "lowest" to "highest" below). For every place on the plate a mode gives one number, the amplitude: how hard the plate
// shakes there, between -1 and 1. Where it is 0 the plate stands still, and that is where the sand ends up.
// These are tidy formulas chosen for their figures; they are not a model of a real metal plate.
//
// To add a plate, append an entry:
//   id         short lower-case name (a-z, 0-9, -).
//   name       shown beside the SHAPE knob when the plate is fully this one.
//   rim        how far the edge is from the centre, looking along the angle t (radians, 0 points right, turning
//              anticlockwise). The body of a GLSL ES 3.0 function "float rim(float t)". 0.5 reaches the middle of a
//              side of the square. Every direction must give one distance, so the plate cannot have dents.
//   amplitude  the body of a GLSL ES 3.0 function "float amplitude(vec2 p, vec2 c, float n, float m)" that returns
//              the amplitude, between -1 and 1, at one place. The place comes in two ways; use either:
//                p      p.x and p.y, each 0 to 1 across the square
//                c      c.x: how far out from the centre, 0 at the centre and 1 on the rim; c.y: the angle
//              PI is defined. Write whole numbers with a decimal point (2.0, not 2). Keep to one statement a
//              line: "float name = ...;", "if (...) return ...;" or "return ...;" (the tests read them that way).
//   overtones  what the plate sounds like: the pitches that ring above the note, each as a multiple of the note's
//              frequency, and how loud each is beside the note (0 to 1). Three pairs.
//
// SHAPE moves from one plate to the next in the order of this list. On the way the rim, the amplitude and the
// overtones are each a mix of the two neighbours, so there is no jump anywhere. Saved settings and share links
// count plates by their place in the list: add new ones at the end.
window.Modes = {
  lowest: 1,
  highest: 24,
  plates: [
    {
      // The classic square plate with free edges: two ways of bending, one taken from the other. With n equal to m the
      // two are the same and would leave nothing, so the one alone is used.
      id: 'square',
      name: 'square',
      rim: 'return 0.5 / max(abs(cos(t)), abs(sin(t)));',
      amplitude: [
        'if (n == m) return cos(n * PI * p.x) * cos(n * PI * p.y);',
        'return 0.5 * (cos(n * PI * p.x) * cos(m * PI * p.y) - cos(m * PI * p.x) * cos(n * PI * p.y));',
      ].join('\n'),
      overtones: [[2.0, 0.22], [2.92, 0.12], [5.4, 0.05]],
    },
    {
      // A round plate: n lines straight through the centre and m rings around it.
      id: 'round',
      name: 'round',
      rim: 'return 0.5;',
      amplitude: 'return cos(n * c.y) * cos(m * PI * c.x);',
      overtones: [[1.59, 0.2], [2.3, 0.14], [3.6, 0.06]],
    },
    {
      // A six-sided plate with free edges, flat sides above and below. Three waves, a third of a turn apart, laid
      // over each other: the figure has the plate's own six-fold shape. X runs across the plate (1 is the length of
      // a side), Y up it (1 is from the centre to a flat side). With n above m the figure changes sides across the
      // upright line through the centre; otherwise it is the same on both.
      id: 'hexagon',
      name: 'hexagon',
      rim: 'return 0.4330127 / max(abs(sin(t)), max(abs(cos(t - PI / 6.0)), abs(cos(t + PI / 6.0))));',
      amplitude: [
        'float X = 2.0 * (p.x - 0.5);',
        'float Y = (p.y - 0.5) / 0.4330127;',
        'float l = -n - m;',
        'float u = 2.0 * PI * X / 3.0;',
        'if (n > m) return (cos(PI * l * Y) * sin((m - n) * u) + cos(PI * m * Y) * sin((n - l) * u) + cos(PI * n * Y) * sin((l - m) * u)) / 3.0;',
        'return (cos(PI * l * Y) * cos((m - n) * u) + cos(PI * m * Y) * cos((n - l) * u) + cos(PI * n * Y) * cos((l - m) * u)) / 3.0;',
      ].join('\n'),
      overtones: [[1.73, 0.2], [2.65, 0.12], [4.1, 0.05]],
    },
    {
      // A three-sided plate with free edges, point up: the same three waves, on one of the six triangles a hexagon
      // is made of. Its sides are 0.98 long; X runs across (1 is a side), Y down from the point (1 at the base).
      id: 'triangle',
      name: 'triangle',
      rim: [
        'float below = 0.4243524 / max(-sin(t), 0.0001);',
        'float right = 0.2121762 / max(0.8660254 * cos(t) + 0.5 * sin(t), 0.0001);',
        'float left = 0.2121762 / max(-0.8660254 * cos(t) + 0.5 * sin(t), 0.0001);',
        'return min(below, min(right, left));',
      ].join('\n'),
      amplitude: [
        'float X = (p.x - 0.5) / 0.98;',
        'float Y = (0.9243524 - p.y) / 0.8487049;',
        'float l = -n - m;',
        'float u = 2.0 * PI * X / 3.0;',
        'if (n > m) return (cos(PI * l * Y) * sin((m - n) * u) + cos(PI * m * Y) * sin((n - l) * u) + cos(PI * n * Y) * sin((l - m) * u)) / 3.0;',
        'return (cos(PI * l * Y) * cos((m - n) * u) + cos(PI * m * Y) * cos((n - l) * u) + cos(PI * n * Y) * cos((l - m) * u)) / 3.0;',
      ].join('\n'),
      overtones: [[1.53, 0.22], [2.31, 0.13], [3.06, 0.06]],
    },
  ],
};
