// modes.js (cube): how the air in the box rings, and nothing else.
//
// The box reaches from 0 to 1 every way; its centre is (0.5, 0.5, 0.5). A mode is three whole numbers n, m and l: how
// many half waves fit across the box each way. One standing wave is cos(n PI x) cos(m PI y) cos(l PI z); its walls stand
// still in the right way for a closed box, and its pitch depends only on n*n + m*m + l*l. So the same three numbers in
// any order ring at the same pitch, and the box can ring with any mix of those six waves at once. The weave says which
// mix: the three "turning" orders (n m l, m l n, l n m) always count once; the three "swapped" orders (m n l, n l m,
// l m n) count "odd" times each. Where the mix is 0 the air stands still and the sand gathers: on curved surfaces in the
// box, as on a plate it gathers on lines. (With two of the numbers alike the swapped orders are the turning ones over
// again, and the weave makes no difference.)
//
// To add a weave, append an entry:
//   id         short lower-case name (a-z, 0-9, -).
//   name       shown beside l when the weave is fully this one.
//   odd        how much each swapped order counts beside a turning one: 1 all alike, 0 left out, below 0 against.
//   overtones  what the box sounds like: three pairs of a pitch above the note (a multiple of its frequency) and how
//              loud it is beside the note (0 to 1).
// E4 pressed moves from one weave to the next in the order of this list, gliding; saved settings count weaves by their
// place in the list: add new ones at the end.
window.Modes = {
  lowest: 1,          // n and m
  highest: 8,         // n, m and l
  thirdLowest: 0,     // l may be 0: then that way the wave does not change at all
  weaves: [
    {id: 'even', name: 'even', odd: 1, overtones: [[2.0, 0.22], [2.92, 0.12], [5.4, 0.05]]},
    {id: 'twist', name: 'twist', odd: 0, overtones: [[1.59, 0.2], [2.3, 0.14], [3.6, 0.06]]},
    {id: 'counter', name: 'counter', odd: -0.5, overtones: [[1.73, 0.2], [2.65, 0.12], [4.1, 0.05]]},
  ],
  // GLSL ES 3.0. wave(p, k, odd): at the place p (each of x, y, z 0 to 1) the mix for the mode k = (n, m, l) with the
  // given weave. w is the amplitude, about -1 to 1; x, y and z how fast it changes each way (the sand uses this to tell
  // how far away the still surface is). PI is defined.
  wave: [
    '// One standing wave: cos(a PI x) cos(b PI y) cos(c PI z), with how fast it changes each way. A, B and C carry the',
    '// cosines of one number along x, y and z; SA, SB and SC how fast those change.',
    'vec4 one(vec3 A, vec3 SA, vec3 B, vec3 SB, vec3 C, vec3 SC) {',
    '  return vec4(SA.x * B.y * C.z, A.x * SB.y * C.z, A.x * B.y * SC.z, A.x * B.y * C.z);',
    '}',
    'vec4 wave(vec3 p, vec3 k, float odd) {',
    '  vec3 cn = cos(PI * k.x * p), cm = cos(PI * k.y * p), cl = cos(PI * k.z * p);',
    '  vec3 sn = -PI * k.x * sin(PI * k.x * p), sm = -PI * k.y * sin(PI * k.y * p), sl = -PI * k.z * sin(PI * k.z * p);',
    '  vec4 turning = one(cn, sn, cm, sm, cl, sl) + one(cm, sm, cl, sl, cn, sn) + one(cl, sl, cn, sn, cm, sm);',
    '  if (k.x == k.y || k.y == k.z || k.x == k.z) return turning / 1.5;',
    '  vec4 swapped = one(cm, sm, cn, sn, cl, sl) + one(cn, sn, cl, sl, cm, sm) + one(cl, sl, cm, sm, cn, sn);',
    '  return (turning + odd * swapped) / (1.5 * (1.0 + abs(odd)));',
    '}',
  ].join('\n'),
};
