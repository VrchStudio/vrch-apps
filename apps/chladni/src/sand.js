// sand.js: how the sand moves and how plate and sand are drawn, and nothing else. How the plate vibrates is in
// modes.js; this file only asks it for the amplitude at a place and for where the rim is.
//
// How the sand moves (the "step" shader below, run once for every grain, 60 times a second):
//   a grain jumps a short way in a random direction. The jump is as long as the plate shakes where the grain is
//   (the amplitude there, times "reach"), plus a tiny "shake" that never stops. So sand cannot stay where the plate
//   moves and gathers on the lines where it stands still. A grain that would leave the plate is sent back in.
//   Three things can throw sand about: "toss" (a hand shaking the whole plate), "thrown" (one throw of every grain)
//   and "flicks" (a tap at one place).
// How it is drawn:
//   every grain is a small soft dot of its own shade, drawn into a hidden picture the size of the plate that keeps
//   three numbers for every pixel: the shade of the sand there, how much of the pixel sand covers, and how thick it
//   lies. The "lay" shader then paints the plate and lays the sand on it: thin sand lets the plate show through,
//   thick sand takes the "thick" colour.
// To change what the sand looks like, edit the "dot" and "lay" shaders; to change how it moves, the "step" shader.
//
// Sand.create(canvas, Modes) gives:
//   resize(width, height, ratio)  the canvas in CSS pixels and the screen's pixel ratio
//   draw(view, steps)             move the sand "steps" times, then draw. view:
//                                   from, to   [n, m] of the mode it is leaving and the mode it is going to
//                                   blend      0 (all "from") to 1 (all "to")
//                                   shape      0 for the first plate in modes.js, 1 for the second, between for a mix
//                                   reach, shake, toss   lengths as a share of the plate's width
//                                   colours    {plate, light, thin, thick} each [red, green, blue] 0 to 1, and glint
//   scatter(seed)                 throw every grain
//   flick(x, y)                   knock the sand away from one place (x, y: 0 to 1 across the plate, y upwards)
//   place(clientX, clientY)       where on the plate a point of the page is, or null beside the plate
//   measure()                     {grains, amplitude}: how many grains, and the mean amplitude where they lie
//   fewer()                       drop to the next lower number of grains; false when there is none
(() => {
  'use strict';
  const COUNTS = [20000, 40000, 80000];   // grains, chosen by how many pixels the plate has
  const SIDES = [520, 900];               // a plate narrower than 520 pixels takes the first count, than 900 the second
  const FILL = 0.94;                      // the plate's width as a share of the shorter side of the screen
  const GRAIN = 0.0031;                   // a grain's width as a share of the plate's, with 40,000 grains
  const THROW = 0.085, THROW_STEPS = 18;  // a scatter: the first jump, and how many steps it lasts
  const FLICK = 0.02, FLICK_STEPS = 14, FLICK_WIDE = 0.12, FLICKS = 4;   // a tap: the first jump, how long, how wide, how many at once
  const FADE = 0.8;                       // each step of a throw or flick is this much of the one before
  const THICK = 12;                       // this many grains on one pixel count as fully thick

  const HASH = [
    'float hash(uint v) { v ^= v >> 16; v *= 0x7feb352du; v ^= v >> 15; v *= 0x846ca68bu; v ^= v >> 16; return float(v >> 8) / 16777216.0; }',
  ].join('\n');
  // The plate, from modes.js: rim(t) is where the edge is, amplitudeAt(p) how hard the plate shakes at p.
  function plateSource(Modes) {
    const plates = Modes.plates, lines = ['const float PI = 3.14159265358979;', 'uniform float weights[' + plates.length + '];', 'uniform vec4 modes;', 'uniform float blend;'];
    plates.forEach((plate, i) => {
      lines.push('float rim_' + i + '(float t) {\n' + plate.rim + '\n}');
      lines.push('float amplitude_' + i + '(vec2 p, vec2 c, float n, float m) {\n' + plate.amplitude + '\n}');
    });
    lines.push('float rim(float t) {', '  float r = 0.0;');
    plates.forEach((_, i) => lines.push('  if (weights[' + i + '] > 0.0) r += weights[' + i + '] * rim_' + i + '(t);'));
    lines.push('  return r;', '}', 'float plate(vec2 p, vec2 c, float n, float m) {', '  float a = 0.0;');
    plates.forEach((_, i) => lines.push('  if (weights[' + i + '] > 0.0) a += weights[' + i + '] * amplitude_' + i + '(p, c, n, m);'));
    lines.push('  return a;', '}',
      'float amplitudeAt(vec2 p) {',
      '  vec2 d = p - 0.5 + 1e-6;',
      '  float r = length(d), t = atan(d.y, d.x);',
      '  vec2 c = vec2(min(r / rim(t), 1.0), t);',
      '  float a = plate(p, c, modes.z, modes.w);',
      '  if (blend < 1.0) a = mix(plate(p, c, modes.x, modes.y), a, blend);',
      '  return a;',
      '}');
    return lines.join('\n');
  }
  const STEP = [
    'in vec2 p;',
    'uniform float reach, shake, toss, size;',
    'uniform uint turn;',
    'uniform vec2 thrown;             // a scatter: how far this step, and its seed',
    'uniform vec4 flicks[' + FLICKS + '];          // taps: x, y, how far this step, how wide',
    'out vec2 q;',
    'out float shade;',
    'void main() {',
    '  uint id = uint(gl_VertexID);',
    '  float angle = 2.0 * PI * hash(id * 747796405u + turn * 2891336453u);',
    '  vec2 way = vec2(cos(angle), sin(angle));',
    '  q = p + (reach * abs(amplitudeAt(p)) + shake + toss * hash(id * 3u + turn * 277803737u + 5u)) * way;',
    '  if (thrown.x > 0.0) {',
    '    uint seed = uint(thrown.y);',
    '    float flung = 2.0 * PI * hash(id * 2654435761u + seed);',
    '    q += thrown.x * (0.25 + 0.75 * hash(id * 40503u + seed * 7u + 1u)) * vec2(cos(flung), sin(flung));',
    '  }',
    '  for (int i = 0; i < ' + FLICKS + '; i++) {',
    '    if (flicks[i].z <= 0.0) continue;',
    '    float near = max(0.0, 1.0 - distance(p, flicks[i].xy) / flicks[i].w);',
    '    if (near <= 0.0) continue;',
    '    // A tap throws sand off its line sideways, to one side or the other, so that it runs back to where it lay',
    '    // (sideways is the way the amplitude grows), and each grain a little its own way as well.',
    '    vec2 rise = vec2(amplitudeAt(p + vec2(0.004, 0.0)) - amplitudeAt(p - vec2(0.004, 0.0)), amplitudeAt(p + vec2(0.0, 0.004)) - amplitudeAt(p - vec2(0.0, 0.004)));',
    '    uint tap = id * 668265263u + uint(flicks[i].x * 4096.0) * 31u + uint(flicks[i].y * 4096.0) * 4099u;',
    '    float own = 2.0 * PI * hash(tap);',
    '    vec2 aside = length(rise) > 1e-5 ? normalize(rise) * (hash(tap + 7u) < 0.5 ? -1.0 : 1.0) : vec2(cos(own), sin(own));',
    '    q += flicks[i].z * near * (aside + 0.35 * vec2(cos(own), sin(own)));',
    '  }',
    '  // The rim sends a grain back in.',
    '  vec2 d = q - 0.5 + 1e-6;',
    '  float r = length(d), edge = rim(atan(d.y, d.x));',
    '  if (r > edge) q = 0.5 + d * (max(2.0 * edge - r, 0.0) / r);',
    '  shade = 0.45 + 0.55 * hash(id * 9781u + 3u);',
    '  gl_Position = vec4(q * 2.0 - 1.0, 0.0, 1.0);',
    '  gl_PointSize = size * (0.75 + 0.5 * hash(id * 6007u + 11u));',
    '}',
  ].join('\n');
  // One grain: a soft dot. Red carries its shade, green that it is there, alpha how much of the pixel it takes.
  const DOT = [
    'in float shade;',
    'out vec4 o;',
    'void main() {',
    '  vec2 d = gl_PointCoord - 0.5;',
    '  o = vec4(shade, 1.0, 0.0, 0.9 * clamp(1.6 - 6.4 * dot(d, d), 0.0, 1.0));',
    '}',
  ].join('\n');
  // For measure(): every grain adds the amplitude where it lies to one of a few pixels, which are then read back.
  const WEIGH = [
    'in vec2 p;',
    'uniform int wide;',
    'out float level;',
    'void main() {',
    '  level = abs(amplitudeAt(p)) * 6.0 + hash(uint(gl_VertexID) * 1597334677u + 77u);',
    '  gl_Position = vec4((vec2(float(gl_VertexID % wide), float((gl_VertexID / wide) % wide)) + 0.5) / float(wide) * 2.0 - 1.0, 0.0, 1.0);',
    '  gl_PointSize = 1.0;',
    '}',
  ].join('\n');
  const WEIGHED = 'in float level;\nout vec4 o;\nvoid main() { o = vec4(floor(level) / 255.0, 0.0, 0.0, 1.0); }';
  const WHOLE = 'void main() { gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.0, 1.0); }';
  // The plate with the sand on it. Beside the plate the screen is black.
  const LAY = [
    'uniform sampler2D sand;',
    'uniform vec2 origin;             // the plate\'s lower left corner on the screen, in pixels',
    'uniform float side;              // and its width in pixels',
    'uniform vec3 plateColour, lightColour, thinColour, thickColour;',
    'uniform float glint;             // how bright the rim catches the light',
    'out vec4 o;',
    'float speck(vec2 v) { return fract(sin(dot(v, vec2(12.9898, 78.233))) * 43758.5453); }',
    'float cloud(vec2 v) {',
    '  vec2 i = floor(v), f = fract(v);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(speck(i), speck(i + vec2(1.0, 0.0)), f.x), mix(speck(i + vec2(0.0, 1.0)), speck(i + vec2(1.0, 1.0)), f.x), f.y);',
    '}',
    'void main() {',
    '  vec2 p = (gl_FragCoord.xy - origin) / side, d = p - 0.5 + 1e-6;',
    '  float r = length(d), inside = (rim(atan(d.y, d.x)) - r) * side, on = clamp(inside + 0.5, 0.0, 1.0);',
    '  if (on <= 0.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }',
    '  // The plate: lit from the upper left, faintly brushed, with a rim that catches a little light.',
    '  float lit = clamp(0.5 + dot(d, vec2(-0.55, 0.7)), 0.0, 1.0);',
    '  float brushed = cloud(vec2(p.x * 5.0, p.y * side * 0.5)) - 0.5, fine = speck(gl_FragCoord.xy) - 0.5;',
    '  vec3 metal = mix(plateColour, lightColour, lit) * (1.0 + 0.1 * brushed + 0.05 * fine);',
    '  metal += lightColour * glint * (1.0 - smoothstep(0.5, 3.0, inside));',
    '  // The sand.',
    '  vec4 s = texture(sand, p);',
    '  float cover = s.g, shade = s.r / max(s.g, 0.004), thick = clamp(s.a * ' + (THICK / 5).toFixed(1) + ', 0.0, 1.0);',
    '  float shadow = texture(sand, p + vec2(1.4, -1.4) / side).g * (1.0 - cover);',
    '  vec3 grains = mix(thinColour, thickColour, thick) * (0.62 + 0.38 * shade);',
    '  o = vec4(mix(metal * (1.0 - 0.4 * shadow), grains, cover) * on, 1.0);',
    '}',
  ].join('\n');

  function create(canvas, Modes) {
    const gl = canvas.getContext('webgl2', {antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance'});
    if (!gl) throw new Error('WebGL 2 is not available.');
    const PLATE = plateSource(Modes), plates = Modes.plates.length, MOST = COUNTS[COUNTS.length - 1];
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
    const step = program([HASH, PLATE, STEP].join('\n'), DOT, ['q']);
    const weigh = program([HASH, PLATE, WEIGH].join('\n'), WEIGHED);
    const lay = program(WHOLE, [PLATE, LAY].join('\n'));

    // Every grain starts somewhere on the square, the same places every time (no dice are thrown here).
    const places = new Float32Array(MOST * 2);
    let dice = 0x9e3779b9;
    for (let i = 0; i < places.length; i++) { dice ^= dice << 13; dice ^= dice >>> 17; dice ^= dice << 5; places[i] = (dice >>> 8) / 16777216; }
    const buffers = [gl.createBuffer(), gl.createBuffer()], arrays = [gl.createVertexArray(), gl.createVertexArray()], feedback = gl.createTransformFeedback();
    for (let i = 0; i < 2; i++) {
      gl.bindVertexArray(arrays[i]); gl.bindBuffer(gl.ARRAY_BUFFER, buffers[i]); gl.bufferData(gl.ARRAY_BUFFER, places, gl.DYNAMIC_COPY);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const texture = (width, height) => {
      const made = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, made); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
      const frame = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, frame); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, made, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return {made, frame, width, height};
    };
    let sandPicture = null, scale = null, wide = 0;
    let width = 0, height = 0, side = 0, origin = [0, 0], tier = 0, capped = COUNTS.length - 1, grains = COUNTS[0];
    let now = 0, turn = 0, last = null;
    let thrown = null;        // {seed, left}
    const flicks = [];        // {x, y, left}

    function resize(cssWidth, cssHeight, ratio) {
      const w = Math.max(1, Math.round(cssWidth * ratio)), h = Math.max(1, Math.round(cssHeight * ratio));
      if (w === width && h === height) return;
      width = w; height = h; canvas.width = w; canvas.height = h;
      side = Math.max(16, Math.min(2048, Math.floor(Math.min(w, h) * FILL)));
      origin = [Math.round((w - side) / 2), Math.round((h - side) / 2)];
      tier = Math.min(capped, side < SIDES[0] ? 0 : side < SIDES[1] ? 1 : 2); grains = COUNTS[tier];
      if (sandPicture) { gl.deleteTexture(sandPicture.made); gl.deleteFramebuffer(sandPicture.frame); }
      sandPicture = texture(side, side);
    }
    function fewer() {
      if (tier === 0) return false;
      capped = tier = tier - 1; grains = COUNTS[tier];
      return true;
    }
    const weights = shape => { const list = new Float32Array(plates), at = Math.max(0, Math.min(plates - 1, shape)), low = Math.min(plates - 2, Math.floor(at)); if (plates === 1) list[0] = 1; else { list[low] = 1 - (at - low); list[low + 1] = at - low; } return list; };
    function plateUniforms(to, view) {
      gl.uniform1fv(to.at.weights, weights(view.shape));
      if (to.at.modes) gl.uniform4f(to.at.modes, view.from[0], view.from[1], view.to[0], view.to[1]);
      if (to.at.blend) gl.uniform1f(to.at.blend, view.blend);
    }
    function draw(view, steps) {
      if (!sandPicture) return;
      last = view;
      const size = Math.max(1.4, side * GRAIN * Math.sqrt(40000 / grains));
      gl.bindFramebuffer(gl.FRAMEBUFFER, sandPicture.frame); gl.viewport(0, 0, side, side);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND); gl.blendColor(0, 0, 0, 1 / THICK); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.CONSTANT_ALPHA, gl.ONE);
      gl.useProgram(step.made); plateUniforms(step, view);
      gl.uniform1f(step.at.size, size);
      const moves = Math.max(0, Math.min(3, steps | 0));
      for (let i = 0; i < Math.max(1, moves); i++) {
        const moving = moves > 0, list = new Float32Array(FLICKS * 4);
        if (moving) {
          turn = (turn + 1) >>> 0;
          flicks.forEach((flick, n) => { list.set([flick.x, flick.y, FLICK * FADE ** (FLICK_STEPS - flick.left), FLICK_WIDE], n * 4); flick.left--; });
          while (flicks.length && flicks[0].left <= 0) flicks.shift();
        }
        gl.uniform1f(step.at.reach, moving ? view.reach : 0); gl.uniform1f(step.at.shake, moving ? view.shake : 0); gl.uniform1f(step.at.toss, moving ? view.toss : 0);
        gl.uniform1ui(step.at.turn, turn);
        gl.uniform2f(step.at.thrown, moving && thrown ? THROW * FADE ** (THROW_STEPS - thrown.left) : 0, thrown ? thrown.seed : 0);
        gl.uniform4fv(step.at.flicks, list);
        if (moving && thrown && --thrown.left <= 0) thrown = null;
        gl.bindVertexArray(arrays[now]);
        if (moving) {
          // All but the last move of a frame are worked out without being drawn.
          if (i < moves - 1) gl.enable(gl.RASTERIZER_DISCARD);
          gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback); gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffers[1 - now]);
          gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, grains); gl.endTransformFeedback();
          gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null); gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
          gl.disable(gl.RASTERIZER_DISCARD);
          now = 1 - now;
        } else gl.drawArrays(gl.POINTS, 0, grains);
      }
      gl.bindVertexArray(null); gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, width, height);
      gl.useProgram(lay.made); plateUniforms(lay, view);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sandPicture.made); gl.uniform1i(lay.at.sand, 0);
      gl.uniform2f(lay.at.origin, origin[0], origin[1]); gl.uniform1f(lay.at.side, side);
      const c = view.colours;
      gl.uniform3fv(lay.at.plateColour, c.plate); gl.uniform3fv(lay.at.lightColour, c.light); gl.uniform3fv(lay.at.thinColour, c.thin); gl.uniform3fv(lay.at.thickColour, c.thick);
      gl.uniform1f(lay.at.glint, c.glint);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    function measure() {
      if (!last) return {grains, amplitude: 0};
      const across = Math.ceil(Math.sqrt(grains / 40));
      if (across !== wide) { if (scale) { gl.deleteTexture(scale.made); gl.deleteFramebuffer(scale.frame); } scale = texture(across, across); wide = across; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, scale.frame); gl.viewport(0, 0, wide, wide);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(weigh.made); plateUniforms(weigh, last); gl.uniform1i(weigh.at.wide, wide);
      gl.bindVertexArray(arrays[now]); gl.drawArrays(gl.POINTS, 0, grains); gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      const read = new Uint8Array(wide * wide * 4);
      gl.readPixels(0, 0, wide, wide, gl.RGBA, gl.UNSIGNED_BYTE, read);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      let sum = 0;
      for (let i = 0; i < read.length; i += 4) sum += read[i];
      // (Each grain added 6 times its amplitude plus a number between 0 and 1, rounded down: on average 6 times its amplitude.)
      return {grains, amplitude: sum / grains / 6};
    }
    function place(clientX, clientY) {
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      const x = ((clientX - box.left) / box.width * width - origin[0]) / side, y = ((box.bottom - clientY) / box.height * height - origin[1]) / side;
      return x < 0 || y < 0 || x > 1 || y > 1 ? null : [x, y];
    }
    return {
      resize, draw, measure, place, fewer,
      scatter(seed) { thrown = {seed: (Math.abs(Math.round(seed)) % 1000000) + 1, left: THROW_STEPS}; },
      flick(x, y) { if (flicks.length >= FLICKS) flicks.shift(); flicks.push({x, y, left: FLICK_STEPS}); },
      get grains() { return grains; },
      get side() { return side; },
      get size() { return [width, height]; },
      get lost() { return gl.isContextLost(); },
    };
  }
  window.Sand = {create};
})();
