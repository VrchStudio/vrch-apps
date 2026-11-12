// sand.js (cube): how the sand moves in the box and how box and sand are drawn, and nothing else. How the air rings is
// in modes.js; this file only asks it for the mix at a place.
//
// How the sand moves (the "step" shader, run once for every grain, 60 times a second):
//   a grain jumps a short way in a random direction. The jump is a share ("near") of how far it is from the nearest
//   surface where the air stands still (worked out as the amplitude there divided by how fast it changes), plus a tiny
//   "shake" that never stops. So a grain cannot stay where the air moves and comes to rest on those surfaces; and grains
//   in a quiet corner, far from any still surface, still find their way. A grain that would leave the box bounces off
//   its wall. "toss" (a hand shaking the box), "thrown" (one throw of every grain) and "rays" (a tap, which knocks the
//   sand away from the line it makes through the box) throw sand about.
// How it is drawn:
//   seen through a camera, every grain is a small soft dot of light, brighter where many lie together, brighter and
//   warmer once it has come to rest, dimmer the farther away it is. Behind the sand the far walls of the box show, in
//   faint lines, where the still surfaces meet them: on every wall a flat figure, as on a plate.
// To change how the sand moves, edit "step"; how it looks, "grain"; the box, "walls" and "edges".
//
// Sand.create(canvas, Modes) gives:
//   resize(width, height, ratio)  the canvas in CSS pixels and the screen's pixel ratio
//   look(view)                    where the camera is: 0 circling the box, 1 along its long diagonal, 2 facing a side.
//                                 It glides there
//   draw(view, steps)             move the sand "steps" times, then draw. view:
//                                   from, to   [n, m, l] of the mode it is leaving and the mode it is going to
//                                   blend      0 (all "from") to 1 (all "to")
//                                   kept       [n, m, l, share]: a second mode ringing with the first
//                                   odd        the weave (see modes.js)
//                                   near, farthest, shake, toss   how far grains jump: near is a share of the way to
//                                              the nearest still surface, never more than farthest; the others lengths
//                                              as a share of the box's width
//                                   colours    {plate, light, thin, thick}: the room, the box, sand moving and sand at rest
//   scatter(seed)                 throw every grain
//   flick(from, way)              knock the sand away from a line through the box: a point on it and its direction,
//                                 both in the box's own measure (0 to 1)
//   ray(clientX, clientY)         the line through the box under a point of the page, as {from, way}, or null when it
//                                 misses the box
//   measure()                     {grains, amplitude}: how many grains, and the mean amplitude where they lie
//   fewer()                       drop to the next lower number of grains; false when there is none
(() => {
  'use strict';
  const COUNTS = [30000, 60000, 100000];  // grains, chosen by how many pixels the picture has
  const SIDES = [520, 900];               // a picture narrower than 520 pixels takes the first count, than 900 the second
  const GRAIN = 0.0042;                   // a grain's width as a share of the box's, with 60,000 grains
  const GLOW = 0.62;                      // how bright one grain is, with 60,000 grains
  const THROW = 0.085, THROW_STEPS = 18;  // a scatter: the first jump, and how many steps it lasts
  const RAY = 0.03, RAY_STEPS = 14, RAY_WIDE = 0.11, RAYS = 4;   // a tap: the first jump, how long, how wide, how many at once
  const FADE = 0.8;                       // each step of a throw or a tap is this much of the one before
  const FOV = 32;                         // the camera's field of view, top to bottom, in degrees
  const ROOM = 0.9;                       // the camera keeps a ball this wide around the centre in sight (the box's
                                          // corners are 0.87 out)
  // Views: how high the camera looks from (degrees above the floor), from which way (degrees, when it stands still),
  // how far (1: the box just fits), turns a minute.
  const VIEWS = [
    {elevation: 22, angle: -90, distance: 1.0, turns: 1.0},
    {elevation: 35.264, angle: 45, distance: 1.0, turns: 0},
    {elevation: 0, angle: -90, distance: 0.96, turns: 0},
  ];
  const GLIDE = 0.25;                     // the camera covers most of the way to a new view in about three times this (seconds)

  const HASH = 'float hash(uint v) { v ^= v >> 16; v *= 0x7feb352du; v ^= v >> 15; v *= 0x846ca68bu; v ^= v >> 16; return float(v >> 8) / 16777216.0; }';
  // The air in the box, from modes.js: fieldAt(p) is the mix at p (w) and how fast it changes (xyz); still(f) roughly
  // how far p is from the nearest surface where the air stands still.
  function fieldSource(Modes) {
    return [
      'const float PI = 3.14159265358979;',
      'uniform vec3 modeFrom, modeTo;',
      'uniform float blend, odd;',
      'uniform vec4 kept;',
      Modes.wave,
      'vec4 fieldAt(vec3 p) {',
      '  vec4 a = wave(p, modeTo, odd);',
      '  if (blend < 1.0) a = mix(wave(p, modeFrom, odd), a, blend);',
      '  // Two modes at once: the air moves as both added together (a little less of each, to stay as lively as one).',
      '  if (kept.w > 0.0) a = mix(a, 0.62 * (a + wave(p, kept.xyz, odd)), kept.w);',
      '  return a;',
      '}',
      'float still(vec4 f) { return abs(f.w) / (length(f.xyz) + 1e-4); }',
    ].join('\n');
  }
  const STEP = [
    'in vec3 p;',
    'uniform float near, farthest, shake, toss;',
    'uniform uint turn;',
    'uniform vec2 thrown;             // a scatter: how far this step, and its seed',
    'uniform vec4 rayFrom[' + RAYS + '];         // taps: a point on the line, and how far this step',
    'uniform vec4 rayWay[' + RAYS + '];          // and the line\'s direction, and how wide it reaches',
    'out vec3 q;',
    '// A direction, any way at all.',
    'vec3 anyway(uint seed) {',
    '  float z = 2.0 * hash(seed) - 1.0, a = 2.0 * PI * hash(seed * 7u + 3u), r = sqrt(max(0.0, 1.0 - z * z));',
    '  return vec3(r * cos(a), r * sin(a), z);',
    '}',
    'void main() {',
    '  uint id = uint(gl_VertexID);',
    '  float jump = min(farthest, near * still(fieldAt(p))) + shake + toss * hash(id * 3u + turn * 277803737u + 5u);',
    '  q = p + jump * anyway(id * 747796405u + turn * 2891336453u);',
    '  if (thrown.x > 0.0) {',
    '    uint seed = uint(thrown.y);',
    '    q += thrown.x * (0.25 + 0.75 * hash(id * 40503u + seed * 7u + 1u)) * anyway(id * 2654435761u + seed);',
    '  }',
    '  for (int i = 0; i < ' + RAYS + '; i++) {',
    '    if (rayFrom[i].w <= 0.0) continue;',
    '    vec3 rel = p - rayFrom[i].xyz, off = rel - rayWay[i].xyz * dot(rel, rayWay[i].xyz);',
    '    float apart = length(off), close = max(0.0, 1.0 - apart / rayWay[i].w);',
    '    if (close <= 0.0) continue;',
    '    // Away from the line, and each grain a little its own way as well.',
    '    q += rayFrom[i].w * close * (off / max(apart, 1e-4) + 0.35 * anyway(id * 668265263u + uint(i) * 4099u + 9u));',
    '  }',
    '  // The walls send a grain back in.',
    '  q = abs(q); q = 1.0 - abs(1.0 - q); q = clamp(q, 0.0, 1.0);',
    '  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);',
    '  gl_PointSize = 1.0;',
    '}',
  ].join('\n');
  const NOTHING = 'out vec4 o;\nvoid main() { o = vec4(0.0); }';
  // For measure(): every grain adds the amplitude where it lies to one of a few pixels, which are then read back.
  const WEIGH = [
    'in vec3 p;',
    'uniform int wide;',
    'out float level;',
    'void main() {',
    '  level = clamp(abs(fieldAt(p).w), 0.0, 1.0) * 6.0 + hash(uint(gl_VertexID) * 1597334677u + 77u);',
    '  gl_Position = vec4((vec2(float(gl_VertexID % wide), float((gl_VertexID / wide) % wide)) + 0.5) / float(wide) * 2.0 - 1.0, 0.0, 1.0);',
    '  gl_PointSize = 1.0;',
    '}',
  ].join('\n');
  const WEIGHED = 'in float level;\nout vec4 o;\nvoid main() { o = vec4(floor(level) / 255.0, 0.0, 0.0, 1.0); }';
  // A grain: a soft dot of light. Sand at rest takes the "thick" colour, sand on the move the "thin" one, dimmer.
  const GRAIN_PLACE = [
    'in vec3 p;',
    'uniform mat4 camera;',
    'uniform float size, glow, nearest, farthest;',
    'uniform vec3 thinColour, thickColour;',
    'out vec3 tint;',
    'void main() {',
    '  uint id = uint(gl_VertexID);',
    '  float rest = 1.0 - smoothstep(0.004, 0.03, still(fieldAt(p)));',
    '  vec4 clip = camera * vec4(p - 0.5, 1.0);',
    '  gl_Position = clip;',
    '  gl_PointSize = max(1.0, size * (0.75 + 0.5 * hash(id * 6007u + 11u)) / clip.w);',
    '  float far = mix(1.0, 0.32, smoothstep(nearest, farthest, clip.w));',
    '  float shade = 0.45 + 0.55 * hash(id * 9781u + 3u);',
    '  tint = mix(thinColour, thickColour, rest) * mix(0.4, 1.0, rest) * shade * far * glow;',
    '}',
  ].join('\n');
  const GRAIN_PAINT = [
    'in vec3 tint;',
    'out vec4 o;',
    'void main() {',
    '  vec2 d = gl_PointCoord - 0.5;',
    '  float a = clamp(1.6 - 6.4 * dot(d, d), 0.0, 1.0);',
    '  if (a <= 0.01) discard;',
    '  o = vec4(tint * a, 1.0);',
    '}',
  ].join('\n');
  // The six walls; only those whose inside faces the camera are drawn, with faint lines where the still surfaces meet them.
  const WALLS = [
    'layout(location = 0) in vec3 p;',
    'layout(location = 1) in vec3 facing;',
    'uniform mat4 camera;',
    'out vec3 here, outward;',
    'void main() {',
    '  here = p; outward = facing;',
    '  gl_Position = camera * vec4(p - 0.5, 1.0);',
    '}',
  ].join('\n');
  const WALLS_PAINT = [
    'in vec3 here, outward;',
    'uniform vec3 eye, plateColour, lightColour;',
    'out vec4 o;',
    'void main() {',
    '  if (dot(outward, eye - (here - 0.5)) > 0.0) discard;   // a wall between the camera and the sand stays clear',
    '  float d = still(fieldAt(here)), line = 1.0 - smoothstep(0.0015, 0.008, d);',
    '  // Lighter towards the middle of each wall, so the corners of the room read.',
    '  vec3 a = abs(here - 0.5) * 2.0, across = a * (1.0 - abs(outward));',
    '  float middle = 1.0 - 0.5 * max(across.x, max(across.y, across.z));',
    '  o = vec4(plateColour + lightColour * (0.035 + 0.05 * middle + 0.3 * line), 1.0);',
    '}',
  ].join('\n');
  const EDGES = 'in vec3 p;\nuniform mat4 camera;\nvoid main() { gl_Position = camera * vec4(p - 0.5, 1.0); }';
  const EDGES_PAINT = 'uniform vec3 lightColour;\nout vec4 o;\nvoid main() { o = vec4(lightColour * 0.55, 1.0); }';

  // Small sums for the camera (4x4 matrices in the column order WebGL reads).
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function lookAt(eye, at, up) {
    const z = unit([eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]]), x = unit(cross(up, z)), y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1];
  }
  function times(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; out[c * 4 + r] = s; }
    return out;
  }

  function create(canvas, Modes) {
    const gl = canvas.getContext('webgl2', {antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance'});
    if (!gl) throw new Error('WebGL 2 is not available.');
    const FIELD = fieldSource(Modes), MOST = COUNTS[COUNTS.length - 1];
    function program(vertex, fragment, feedback) {
      const made = gl.createProgram();
      for (const [type, text] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, '#version 300 es\nprecision highp float;\nprecision highp int;\n' + text); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        gl.attachShader(made, shader);
      }
      gl.bindAttribLocation(made, 0, 'p');
      if (feedback) gl.transformFeedbackVaryings(made, feedback, gl.SEPARATE_ATTRIBS);
      gl.linkProgram(made);
      if (!gl.getProgramParameter(made, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(made));
      const at = {};
      for (let i = 0, n = gl.getProgramParameter(made, gl.ACTIVE_UNIFORMS); i < n; i++) { const name = gl.getActiveUniform(made, i).name.replace(/\[0\]$/, ''); at[name] = gl.getUniformLocation(made, name); }
      return {made, at};
    }
    const where = (to, name) => to.at[name] || null;
    const step = program([HASH, FIELD, STEP].join('\n'), NOTHING, ['q']);
    const weigh = program([HASH, FIELD, WEIGH].join('\n'), WEIGHED);
    const grain = program([HASH, FIELD, GRAIN_PLACE].join('\n'), GRAIN_PAINT);
    const walls = program(WALLS, [FIELD, WALLS_PAINT].join('\n'));
    const edges = program(EDGES, EDGES_PAINT);

    // Every grain starts somewhere in the box, the same places every time (no dice are thrown here).
    const places = new Float32Array(MOST * 3);
    let dice = 0x9e3779b9;
    for (let i = 0; i < places.length; i++) { dice ^= dice << 13; dice ^= dice >>> 17; dice ^= dice << 5; places[i] = (dice >>> 8) / 16777216; }
    const buffers = [gl.createBuffer(), gl.createBuffer()], arrays = [gl.createVertexArray(), gl.createVertexArray()], feedback = gl.createTransformFeedback();
    for (let i = 0; i < 2; i++) {
      gl.bindVertexArray(arrays[i]); gl.bindBuffer(gl.ARRAY_BUFFER, buffers[i]); gl.bufferData(gl.ARRAY_BUFFER, places, gl.DYNAMIC_COPY);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    }
    // The walls: two triangles each, every corner with the wall's outward direction. The edges: twelve lines.
    const wallList = [];
    for (let axis = 0; axis < 3; axis++) for (const side of [0, 1]) {
      const u = (axis + 1) % 3, v = (axis + 2) % 3, facing = [0, 0, 0];
      facing[axis] = side ? 1 : -1;
      const corner = (a, b) => { const c = [0, 0, 0]; c[axis] = side; c[u] = a; c[v] = b; return c.concat(facing); };
      wallList.push(...corner(0, 0), ...corner(1, 0), ...corner(1, 1), ...corner(0, 0), ...corner(1, 1), ...corner(0, 1));
    }
    const edgeList = [];
    for (let axis = 0; axis < 3; axis++) for (const a of [0, 1]) for (const b of [0, 1]) {
      const u = (axis + 1) % 3, v = (axis + 2) % 3, from = [0, 0, 0], to = [0, 0, 0];
      from[u] = to[u] = a; from[v] = to[v] = b; to[axis] = 1;
      edgeList.push(...from, ...to);
    }
    const wallArray = gl.createVertexArray(), edgeArray = gl.createVertexArray();
    gl.bindVertexArray(wallArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(wallList), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(edgeArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(edgeList), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const texture = (width, height) => {
      const made = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, made); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
      const frame = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, frame); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, made, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return {made, frame, width, height};
    };
    let scale = null, wide = 0;
    let width = 0, height = 0, tier = 0, capped = COUNTS.length - 1, grains = COUNTS[0];
    let now = 0, turn = 0, last = null;
    let thrown = null;        // {seed, left}
    const rays = [];          // {from, way, left}
    const camera = {view: 0, elevation: VIEWS[0].elevation, distance: VIEWS[0].distance, angle: VIEWS[0].angle * Math.PI / 180, at: null};
    let seen = null;          // what the camera saw last, for ray()

    function resize(cssWidth, cssHeight, ratio) {
      const w = Math.max(1, Math.round(cssWidth * ratio)), h = Math.max(1, Math.round(cssHeight * ratio));
      if (w === width && h === height) return;
      canvas.width = w; canvas.height = h;
      width = w; height = h;
      const side = Math.min(w, h);
      tier = Math.min(capped, side < SIDES[0] ? 0 : side < SIDES[1] ? 1 : 2); grains = COUNTS[tier];
    }
    function look(view) {
      camera.view = Math.max(0, Math.min(VIEWS.length - 1, view | 0));
      // Before the first picture there is nothing to glide from.
      if (camera.at === null) { const v = VIEWS[camera.view]; camera.elevation = v.elevation; camera.distance = v.distance; camera.angle = v.angle * Math.PI / 180; }
    }
    function fewer() {
      if (tier === 0) return false;
      capped = tier = tier - 1; grains = COUNTS[tier];
      return true;
    }
    function fieldUniforms(to, view) {
      gl.uniform3f(where(to, 'modeFrom'), view.from[0], view.from[1], view.from[2]);
      gl.uniform3f(where(to, 'modeTo'), view.to[0], view.to[1], view.to[2]);
      gl.uniform1f(where(to, 'blend'), view.blend);
      gl.uniform1f(where(to, 'odd'), view.odd);
      gl.uniform4f(where(to, 'kept'), view.kept[0], view.kept[1], view.kept[2], view.kept[3]);
    }
    // Moves the camera on to "seconds" and returns its matrix.
    function aim(seconds) {
      const elapsed = camera.at === null ? 0 : Math.max(0, Math.min(0.25, seconds - camera.at));
      camera.at = seconds;
      const want = VIEWS[camera.view], k = 1 - Math.exp(-elapsed / GLIDE);
      camera.elevation += (want.elevation - camera.elevation) * k;
      camera.distance += (want.distance - camera.distance) * k;
      if (want.turns) camera.angle = (camera.angle + 2 * Math.PI * want.turns / 60 * elapsed) % (2 * Math.PI);
      else { const home = want.angle * Math.PI / 180, off = Math.atan2(Math.sin(camera.angle - home), Math.cos(camera.angle - home)); camera.angle -= off * k; }
      const aspect = width / height, fovy = FOV * Math.PI / 180, tan = Math.tan(fovy / 2);
      const half = Math.min(fovy / 2, Math.atan(tan * aspect)), far = ROOM / Math.sin(half) * camera.distance;
      const e = camera.elevation * Math.PI / 180, a = camera.angle;
      const eye = [far * Math.cos(e) * Math.cos(a), far * Math.cos(e) * Math.sin(a), far * Math.sin(e)];
      // "Up" on the screen is the way the camera would rise: never along the line of sight, even straight from above.
      const from = lookAt(eye, [0, 0, 0], [-Math.sin(e) * Math.cos(a), -Math.sin(e) * Math.sin(a), Math.cos(e)]);
      seen = {eye, tan, aspect, right: [from[0], from[4], from[8]], up: [from[1], from[5], from[9]], ahead: [-from[2], -from[6], -from[10]]};
      return {matrix: times(perspective(fovy, aspect, 0.05, 20), from), eye, far, perPixel: height / (2 * tan)};
    }
    function draw(view, steps) {
      if (!width) return;
      last = view;
      // 1. The sand moves: worked out on the graphics card, nothing drawn.
      const moves = Math.max(0, Math.min(3, steps | 0));
      if (moves) {
        gl.useProgram(step.made); fieldUniforms(step, view);
        gl.enable(gl.RASTERIZER_DISCARD);
        for (let i = 0; i < moves; i++) {
          turn = (turn + 1) >>> 0;
          const from = new Float32Array(RAYS * 4), way = new Float32Array(RAYS * 4);
          rays.forEach((ray, n) => { from.set([...ray.from, RAY * FADE ** (RAY_STEPS - ray.left)], n * 4); way.set([...ray.way, RAY_WIDE], n * 4); ray.left--; });
          while (rays.length && rays[0].left <= 0) rays.shift();
          gl.uniform1f(where(step, 'near'), view.near); gl.uniform1f(where(step, 'farthest'), view.farthest);
          gl.uniform1f(where(step, 'shake'), view.shake); gl.uniform1f(where(step, 'toss'), view.toss);
          gl.uniform1ui(where(step, 'turn'), turn);
          gl.uniform2f(where(step, 'thrown'), thrown ? THROW * FADE ** (THROW_STEPS - thrown.left) : 0, thrown ? thrown.seed : 0);
          gl.uniform4fv(where(step, 'rayFrom'), from); gl.uniform4fv(where(step, 'rayWay'), way);
          if (thrown && --thrown.left <= 0) thrown = null;
          gl.bindVertexArray(arrays[now]);
          gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback); gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffers[1 - now]);
          gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, grains); gl.endTransformFeedback();
          gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null); gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
          now = 1 - now;
        }
        gl.disable(gl.RASTERIZER_DISCARD);
      }
      // 2. The box and its sand, seen through the camera.
      const shot = aim(performance.now() / 1000), c = view.colours;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, width, height);
      gl.clearColor(c.plate[0], c.plate[1], c.plate[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(walls.made); fieldUniforms(walls, view);
      gl.uniformMatrix4fv(where(walls, 'camera'), false, shot.matrix); gl.uniform3fv(where(walls, 'eye'), shot.eye);
      gl.uniform3fv(where(walls, 'plateColour'), c.plate); gl.uniform3fv(where(walls, 'lightColour'), c.light);
      gl.bindVertexArray(wallArray); gl.drawArrays(gl.TRIANGLES, 0, 36);
      gl.useProgram(edges.made);
      gl.uniformMatrix4fv(where(edges, 'camera'), false, shot.matrix); gl.uniform3fv(where(edges, 'lightColour'), c.light);
      gl.bindVertexArray(edgeArray); gl.drawArrays(gl.LINES, 0, 24);
      // The grains add their light together.
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(grain.made); fieldUniforms(grain, view);
      gl.uniformMatrix4fv(where(grain, 'camera'), false, shot.matrix);
      gl.uniform1f(where(grain, 'size'), GRAIN * Math.sqrt(60000 / grains) * shot.perPixel);
      gl.uniform1f(where(grain, 'glow'), GLOW * Math.sqrt(60000 / grains));
      gl.uniform1f(where(grain, 'nearest'), shot.far - 0.87); gl.uniform1f(where(grain, 'farthest'), shot.far + 0.87);
      gl.uniform3fv(where(grain, 'thinColour'), c.thin); gl.uniform3fv(where(grain, 'thickColour'), c.thick);
      gl.bindVertexArray(arrays[now]); gl.drawArrays(gl.POINTS, 0, grains);
      gl.bindVertexArray(null); gl.disable(gl.BLEND);
    }
    function measure() {
      if (!last) return {grains, amplitude: 0};
      const across = Math.ceil(Math.sqrt(grains / 40));
      if (across !== wide) { if (scale) { gl.deleteTexture(scale.made); gl.deleteFramebuffer(scale.frame); } scale = texture(across, across); wide = across; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, scale.frame); gl.viewport(0, 0, wide, wide);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(weigh.made); fieldUniforms(weigh, last); gl.uniform1i(where(weigh, 'wide'), wide);
      gl.bindVertexArray(arrays[now]); gl.drawArrays(gl.POINTS, 0, grains); gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      const read = new Uint8Array(wide * wide * 4);
      gl.readPixels(0, 0, wide, wide, gl.RGBA, gl.UNSIGNED_BYTE, read);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, width, height);
      let sum = 0;
      for (let i = 0; i < read.length; i += 4) sum += read[i];
      // (Each grain added 6 times its amplitude plus a number between 0 and 1, rounded down: on average 6 times its amplitude.)
      return {grains, amplitude: sum / grains / 6};
    }
    // The line from the camera through this point of the page, in the box's own measure, if it passes through the box.
    function ray(clientX, clientY) {
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height || !seen) return null;
      const x = ((clientX - box.left) / box.width * 2 - 1) * seen.tan * seen.aspect, y = (1 - (clientY - box.top) / box.height * 2) * seen.tan;
      const way = unit([0, 1, 2].map(i => seen.ahead[i] + x * seen.right[i] + y * seen.up[i])), from = seen.eye.map(v => v + 0.5);
      let enter = -Infinity, leave = Infinity;
      for (let i = 0; i < 3; i++) {
        if (Math.abs(way[i]) < 1e-9) { if (from[i] < 0 || from[i] > 1) return null; continue; }
        const a = -from[i] / way[i], b = (1 - from[i]) / way[i];
        enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
      }
      return enter < leave && leave > 0 ? {from, way} : null;
    }
    return {
      resize, look, draw, measure, ray, fewer,
      scatter(seed) { thrown = {seed: (Math.abs(Math.round(seed)) % 1000000) + 1, left: THROW_STEPS}; },
      flick(from, way) { if (rays.length >= RAYS) rays.shift(); rays.push({from: from.slice(0, 3), way: unit(way), left: RAY_STEPS}); },
      get grains() { return grains; },
      get size() { return [width, height]; },
      get view() { return camera.view; },
      get lost() { return gl.isContextLost(); },
    };
  }
  window.Sand = {create};
})();
