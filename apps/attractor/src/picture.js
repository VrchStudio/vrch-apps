// picture.js: turns a formula into a picture of where its points land.
//
// A batch of points lives in a vertex buffer. Drawing it runs one step of the formula on every point in the vertex
// shader. Transform feedback keeps where each point landed, ready for its next step, and the same pass adds one count
// to the pixel it landed on. Counts gather in half-float textures; the last pass turns counts into light on a log
// scale, so thin threads and dense bands both show.
//
// Two pictures are kept.
//   live   while a letter is changing: counts fade (afterglow) as new points arrive, so the figure bends smoothly.
//   still  once the letters rest: a fresh start from fixed seeds, with no fading. Points gather until the picture
//          is finished, and then nothing more is drawn. The same formula, letters and size always give the same
//          picture.
// The screen cross-fades from live to still, so no frame is ever cleared.
//
// A half float holds whole numbers exactly only up to 2048. The still picture therefore gathers a short run of
// points in "work" and adds each run, scaled down, to "sum"; the live picture is kept below that by its fading.
//
// A formula is a map (each step gives the next point) or a flow in three dimensions (each step moves the point a
// little along its rate of change). Every figure is seen in space and can be turned: a map's third direction is where
// the point was one step before. While the view turns the picture is the live one; at rest it gathers and sharpens.
//
// A flow is drawn as a line. Its points do not start scattered: thread.js follows one path of the flow and hands
// over points in order along it, and here they creep along that path a fraction of the gap between them at each
// drawing, so the gaps fill and the picture shows the path itself. When a letter changes the path is followed
// again. (Left to run freely, points on a flow drift apart and the picture becomes a cloud.)
//
// A slow graphics chip spends most of a frame filling pixels, not stepping points. When frames stay late with the
// fewest points a frame, the picture is drawn at fewer pixels and scaled up by the browser.
(() => {
  'use strict';
  const BATCH = 50000;        // points that take a step together
  const WARM = 16;            // steps a fresh point takes before it is drawn
  const PER_PIXEL = 24;       // a finished picture has this many points for each pixel of the view square,
  const CAP_MIN = 6e6;        // but never fewer than this
  const CAP_MAX = 20e6;       // or more than this
  const LIVE_PER_PIXEL = 4;   // the most the fading picture holds
  const GLOW_MS = 220;        // how long the afterglow lasts
  const REST_MS = 250;        // letters unchanged for this long: start the still picture
  const MAX_RATE = 64;        // most batches in one frame
  const FIT = 0.94;           // the view square takes this share of the shorter side
  const HALO = 0.12;          // soft light around dense parts
  const JITTER = 1e-4;        // each step is nudged by this share of the view, so points that fell together part again
  const FEW = 24;             // a figure that touches fewer of the 64 x 64 cells than this has collapsed
  const SEED = 0.6;           // fresh points start within this share of the view around its middle
  const FAR = 16;             // a point this many views from the middle is lost and starts again
  const FLOW_WARM = 240;      // steps a fresh point of a flow takes to reach the figure
  const THREAD_MS = 5;        // a frame spends this long at most on following a flow's line
  const THREAD_STEP = 0.618;  // points on the line move this share of the gap between them at each drawing, so the gaps fill evenly
  const THREAD_AGAIN = 15000; // points left on the line this long are put back on it: small errors grow along a flow
  const LATE_MS = 20;         // a frame longer than this is late
  const LATE_FRAMES = 90;     // this many late frames: draw fewer pixels,
  const COARSER = 0.85;       // by this factor each time,
  const COARSEST = 0.6;       // down to this share of the full size

  const QUAD = [
    '#version 300 es',
    'void main() {',
    '  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
    '}'].join('\n');
  // One step for one point of a formula. "rule" is the formula itself: the next point of a map, or the rate of change
  // of a flow, which then moves by one Runge-Kutta step. A point that is lost, or no longer a number, starts again
  // near the middle. "count" goes to the pixel: one point, and its colour side. The colour side follows the point
  // from left to right (a flow adds its depth); halves, chosen by chance, keep the sum exact in a half float.
  function stepShader(formula) {
    const flow = !!formula.flow;
    return [
      '#version 300 es',
      'precision highp float;',
      'precision highp int;',
      'layout(location = 0) in vec3 point;',
      'uniform vec4 k;      // a, b, c, d',
      'uniform vec4 frame;  // x scale, y scale, colour scale, jitter',
      'uniform vec4 home;   // the middle of the view, and the size of the cube fresh points start in',
      'uniform vec4 start;  // for a first step from the seeds: the size of the box they fill, and 1',
      'uniform vec3 ax, ay, az;  // the view: which way is across, down and away',
      'uniform vec2 space;  // how deep a map is drawn, and the square of how far is lost',
      ...(flow ? ['uniform vec2 pace;   // a flow: how much of its time one step covers, and how many steps'] : []),
      'uniform uint tick;',
      'out vec3 q;',
      'out vec2 count;',
      'vec3 rule(vec3 p, float a, float b, float c, float d) {',
      ...(formula.with || []).map(line => '  float ' + line + ';'),
      '  return ' + (flow ? formula.flow : 'vec3(' + formula.step + ', 0.0)') + ';',
      '}',
      'void main() {',
      '  float a = k.x, b = k.y, c = k.z, d = k.w;',
      '  vec3 p = start.w > 0.5 ? home.xyz + point * start.xyz : point;',
      '  uint h = uint(gl_VertexID) * 747796405u + tick * 2891336453u + 12345u;',
      '  h = (h ^ (h >> 16)) * 2246822519u;',
      '  h = (h ^ (h >> 13)) * 3266489917u;',
      '  h ^= h >> 16;',
      '  vec3 nudge = vec3(float(h & 1023u), float((h >> 10) & 1023u), ' + (flow ? 'float((h >> 20) & 1023u)' : '511.5') + ') / 1023.0 - 0.5;',
      ...(flow ? [
        '  float dt = pace.x;',
        '  vec3 n = p;',
        '  for (int i = 0; i < int(pace.y); i++) {',
        '    vec3 k1 = rule(n, a, b, c, d), k2 = rule(n + 0.5 * dt * k1, a, b, c, d);',
        '    vec3 k3 = rule(n + 0.5 * dt * k2, a, b, c, d), k4 = rule(n + dt * k3, a, b, c, d);',
        '    n += dt / 6.0 * (k1 + 2.0 * k2 + 2.0 * k3 + k4);',
        '  }',
        '  q = n + nudge * frame.w;',
      ] : ['  q = rule(p, a, b, c, d) + nudge * frame.w;']),
      '  vec3 r = q - home.xyz, was = p - home.xyz;',
      '  float away = dot(r, r);',
      '  if (isnan(away) || isinf(away) || away >= space.y) { r = nudge * home.w; q = home.xyz + r; was = r; }',
      ...(flow ? [
        '  vec3 at = vec3(r.x, -r.z, r.y);   // z is up',
        '  vec2 spot = vec2(dot(at, ax), dot(at, ay));',
        '  float side = 0.6 * spot.x + 0.4 * dot(at, az);',
      ] : [
        '  vec3 at = vec3(r.xy, was.x * space.x);',
        '  vec2 spot = vec2(dot(at, ax), dot(at, ay));',
        '  float side = 0.75 * r.x + 0.25 * was.x;',
      ]),
      '  side = clamp(side * frame.z + 0.5, 0.0, 1.0);',
      '  count = vec2(1.0, floor(side * 2.0 + float(h >> 20) / 4096.0) * 0.5);',
      '  gl_Position = vec4(spot.x * frame.x, spot.y * frame.y, 0.0, 1.0);',
      '  gl_PointSize = 1.0;',
      '}'].join('\n');
  }
  const STEP_FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 count;',
    'out vec4 o;',
    'void main() { o = vec4(count, 0.0, 0.0); }'].join('\n');
  const FADE_FS = [
    '#version 300 es',
    'precision highp float;',
    'out vec4 o;',
    'void main() { o = vec4(0.0); }'].join('\n');
  // sum += work * k, and the same sum written out as a live picture.
  const ADD_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D a, b;',
    'uniform vec2 k;',
    'out vec4 o;',
    'void main() {',
    '  ivec2 at = ivec2(gl_FragCoord.xy);',
    '  o = texelFetch(a, at, 0) * k.x + texelFetch(b, at, 0) * k.y;',
    '}'].join('\n');
  // A picture copied to another size.
  const COPY_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D a;',
    'uniform vec3 k;   // 1 / width, 1 / height, scale',
    'out vec4 o;',
    'void main() { o = textureLod(a, gl_FragCoord.xy * k.xy, 0.0) * k.z; }'].join('\n');
  // Counts to light. v.r is the density (1 = points spread evenly over the view square), v.g / v.r the colour side.
  const SHOW_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D live, sum, work;',
    'uniform vec4 gains;   // live, sum, work, share of the still picture',
    'uniform vec3 halo;    // live, sum, blur level',
    'uniform vec2 px;',
    'uniform vec3 stops[5];',
    'out vec4 o;',
    'const float GAIN = 1.0, TOP = 300.0;',
    '// Four taps between pixels: a small tent that takes the grain off.',
    'vec2 soft(sampler2D s, vec2 uv) {',
    '  vec2 h = px * 0.5;',
    '  return 0.25 * (textureLod(s, uv + h, 0.0).rg + textureLod(s, uv - h, 0.0).rg',
    '    + textureLod(s, uv + vec2(h.x, -h.y), 0.0).rg + textureLod(s, uv + vec2(-h.x, h.y), 0.0).rg);',
    '}',
    '// The soft light comes from a small, blurred copy. Four taps half a cell apart, and its faintest part fading',
    '// out early, or the cells of the copy show as steps where the light ends.',
    'vec2 glow(sampler2D s, vec2 uv) {',
    '  vec2 h = px * exp2(halo.z) * 0.5;',
    '  vec2 g = 0.25 * (textureLod(s, uv + h, halo.z).rg + textureLod(s, uv - h, halo.z).rg',
    '    + textureLod(s, uv + vec2(h.x, -h.y), halo.z).rg + textureLod(s, uv + vec2(-h.x, h.y), halo.z).rg);',
    '  return g;',
    '}',
    'vec2 faint(vec2 g) { return g * (g.r / (g.r + 0.05)); }',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * px;',
    '  vec2 v = vec2(0.0);',
    '  if (gains.w < 1.0) v += (soft(live, uv) * gains.x + faint(glow(live, uv) * halo.x)) * (1.0 - gains.w);',
    '  if (gains.w > 0.0) v += (soft(sum, uv) * gains.y + soft(work, uv) * gains.z + faint(glow(sum, uv) * halo.y)) * gains.w;',
    '  float light = clamp(log(1.0 + GAIN * v.r) / log(1.0 + GAIN * TOP), 0.0, 1.0);',
    '  float u = clamp(v.g / max(v.r, 1e-6) * 2.0 - 1.0, -1.0, 1.0);',
    '  float t = (0.5 + 0.5 * sign(u) * pow(abs(u), 0.5)) * 4.0;',
    '  int i = int(min(t, 3.0));',
    '  vec3 colour = mix(stops[i], stops[i + 1], t - float(i)) * pow(light, 1.1);',
    '  float white = clamp((light - 0.66) / 0.34, 0.0, 1.0);',
    '  colour = mix(colour, vec3(1.0), white * white);',
    '  float grain = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));',
    '  o = vec4(pow(colour, vec3(1.0 / 2.2)) + (grain - 0.5) / 255.0, 1.0);',
    '}'].join('\n');

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Returns null where the browser cannot draw this way (no WebGL 2, or no half-float render target).
  function create(canvas, formulas) {
    const gl = canvas.getContext('webgl2', {antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance'});
    if (!gl) return null;
    const full = gl.getExtension('EXT_color_buffer_float'), half = gl.getExtension('EXT_color_buffer_half_float');
    if (!full && !half) return null;

    function shader(type, source) {
      const s = gl.createShader(type);
      gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    }
    function link(vs, fs, varyings) {
      const p = gl.createProgram();
      gl.attachShader(p, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
      if (varyings) gl.transformFeedbackVaryings(p, varyings, gl.SEPARATE_ATTRIBS);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'program');
      return p;
    }
    const at = (program, names) => Object.fromEntries(names.map(name => [name, gl.getUniformLocation(program, name)]));
    function target(format, w, h, levels) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, levels, format, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : format === gl.RGBA8 ? gl.NEAREST : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, format === gl.RGBA8 ? gl.NEAREST : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return {tex, fbo, w, h, levels, complete};
    }
    function free(t) { if (t) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); } }
    function wipe(t) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.viewport(0, 0, t.w, t.h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    function blur(t) { if (t.levels > 1) { gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.generateMipmap(gl.TEXTURE_2D); } }

    // Two channels of half floats; four where a browser renders only to RGBA. Blur levels where it can make them.
    let format = 0, blurs = true;
    for (const candidate of [gl.RG16F, gl.RGBA16F]) {
      const t = target(candidate, 8, 8, 4);
      while (gl.getError()) ;
      if (t.complete) { format = candidate; gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.generateMipmap(gl.TEXTURE_2D); blurs = gl.getError() === gl.NO_ERROR; }
      free(t);
      if (format) break;
    }
    if (!format) return null;

    const fadeProgram = link(QUAD, FADE_FS), addProgram = link(QUAD, ADD_FS), copyProgram = link(QUAD, COPY_FS), showProgram = link(QUAD, SHOW_FS);
    const addAt = at(addProgram, ['a', 'b', 'k']), copyAt = at(copyProgram, ['a', 'k']), showAt = at(showProgram, ['live', 'sum', 'work', 'gains', 'halo', 'px', 'stops']);
    const steppers = [];
    function stepper(index) {
      if (!steppers[index]) {
        const program = link(stepShader(formulas[index]), STEP_FS, ['q']);
        steppers[index] = {program, ...at(program, ['k', 'frame', 'home', 'start', 'ax', 'ay', 'az', 'space', 'pace', 'tick'])};
      }
      return steppers[index];
    }
    const middle = formula => [0, 1, 2].map(i => (formula.centre || [])[i] || 0);

    // Fixed seeds, -0.5 to 0.5 each way: the still picture always starts from the same points. They stay in a buffer
    // of their own that is only ever read; the points on their way live in two others that take turns.
    const seeds = new Float32Array(BATCH * 3);
    for (let i = 0, h = 20261111; i < seeds.length; i++) { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; seeds[i] = h / 4294967296 - 0.5; }
    const buffers = [gl.createBuffer(), gl.createBuffer(), gl.createBuffer()], arrays = [gl.createVertexArray(), gl.createVertexArray(), gl.createVertexArray()], empty = gl.createVertexArray();
    for (let i = 0; i < 3; i++) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[i]); gl.bufferData(gl.ARRAY_BUFFER, seeds, i < 2 ? gl.DYNAMIC_COPY : gl.STATIC_DRAW);
      gl.bindVertexArray(arrays[i]); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
    // A flow's line: points in order along one path (thread.js), in a buffer of their own that is only read.
    const Thread = window.Thread || null, line = gl.createBuffer(), lineArray = gl.createVertexArray(), linePoints = new Float32Array(BATCH * 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, line); gl.bufferData(gl.ARRAY_BUFFER, linePoints, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(lineArray); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const cells = target(gl.RGBA8, 64, 64, 1), seen = new Uint8Array(64 * 64 * 4);

    // quality: the share of the full size a moving picture is drawn at. fine: drawing at the full size all the same,
    // which the still picture always does (it is in no hurry, and it is the one that is looked at).
    let W = 0, H = 0, side = 0, cap = CAP_MIN, liveMost = 0, asked = null, quality = 1, fine = false, late = 0, drew = 0, slow = 16.7;
    let live = null, sum = null, work = null;
    // look: the view as nine numbers (across, down, away), then how much smaller the turned figure is drawn, then
    // how deep a map is.
    const FRONT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0];
    let formula = 0, letters = [0, 0, 0, 0], look = FRONT, moving = false, changedAt = 0, started = false;
    // afresh: the next step starts from the seeds (1) or from the flow's line (2) instead of where the points are.
    // thread: the line of the flow being drawn. letters: the ones it was followed with. on: the points are on it.
    let mode = 'still', done = false, warm = 0, tick = 0, current = 0, afresh = 0, thread = null;
    let nLive = 0, nStill = 0, pending = 0, summed = 0, collapsed = null, dirty = true;
    let rate = 2, base = 16.7, last = 0, added = 0;
    const stops = new Float32Array(15).fill(1);

    const quad = () => { gl.bindVertexArray(empty); gl.drawArrays(gl.TRIANGLES, 0, 3); };
    const bind = (unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t.tex); };

    // "count" batches take a step. They are drawn into "into", or only stepped when it is null.
    function run(count, into, scaleX, scaleY, from = look) {
      const s = stepper(formula), view = formulas[formula].view, centre = middle(formulas[formula]);
      const flow = formulas[formula].flow, onLine = !!thread && thread.on && thread.formula === formula;
      gl.useProgram(s.program);
      gl.uniform4f(s.k, letters[0], letters[1], letters[2], letters[3]);
      gl.uniform4f(s.frame, scaleX, scaleY, 0.6 / view, onLine ? 0 : JITTER * view);
      gl.uniform4f(s.home, centre[0], centre[1], centre[2], 2 * SEED * view);
      gl.uniform3f(s.ax, from[0], from[1], from[2]); gl.uniform3f(s.ay, from[3], from[4], from[5]); gl.uniform3f(s.az, from[6], from[7], from[8]);
      gl.uniform2f(s.space, from[10], (FAR * view) ** 2);
      // Points on the line creep along it; points on their own take the formula's full steps.
      if (flow) { if (onLine) gl.uniform2f(s.pace, THREAD_STEP * gap(formulas[formula]), 1); else gl.uniform2f(s.pace, formulas[formula].dt, Math.max(1, Math.round(formulas[formula].steps || 1))); }
      if (into) { gl.bindFramebuffer(gl.FRAMEBUFFER, into.fbo); gl.viewport(0, 0, into.w, into.h); } else gl.enable(gl.RASTERIZER_DISCARD);
      for (let i = 0; i < count; i++) {
        gl.uniform1ui(s.tick, tick++);
        gl.uniform4f(s.start, 2 * SEED * view, 2 * SEED * view, flow ? 2 * SEED * view : 0, afresh === 1 ? 1 : 0);
        gl.bindVertexArray(afresh === 2 ? lineArray : arrays[afresh === 1 ? 2 : current]);
        afresh = 0;
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffers[1 - current]);
        gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, BATCH); gl.endTransformFeedback();
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
        current = 1 - current;
      }
      if (!into) gl.disable(gl.RASTERIZER_DISCARD);
    }
    // y runs down the screen, as on paper and in the usual pictures of these formulas.
    function draw(count, into) {
      const view = formulas[formula].view / look[9];
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      run(count, into, side * FIT / (W * view), -side * FIT / (H * view));
    }
    // How many of 64 x 64 cells one batch touches, seen from the front: very few means the figure has collapsed to
    // some points. (Not asked of a flow.)
    function census() {
      const view = formulas[formula].view;
      wipe(cells); gl.disable(gl.BLEND);
      run(1, cells, 1 / view, -1 / view, FRONT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, cells.fbo);
      gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, seen);
      let touched = 0;
      for (let i = 0; i < seen.length; i += 4) if (seen[i]) touched++;
      collapsed = touched < FEW;
    }
    function add(into, first, second, k1, k2, blend) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, into.fbo); gl.viewport(0, 0, into.w, into.h);
      if (blend) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); } else gl.disable(gl.BLEND);
      gl.useProgram(addProgram); bind(0, first); bind(1, second);
      gl.uniform1i(addAt.a, 0); gl.uniform1i(addAt.b, 1); gl.uniform2f(addAt.k, k1, k2);
      quad();
    }
    // work joins sum, scaled so a finished sum is the density itself.
    function fold() {
      add(sum, work, work, side * side / cap, 0, true);
      wipe(work); summed += pending; pending = 0;
    }
    // Every point back to its seed, spread around the middle of this formula's view: the next step starts from them.
    // (A flow whose line is known starts from the line instead.)
    function scatter() { afresh = lined() ? 2 : 1; if (thread) thread.on = afresh === 2; }
    const sameLetters = list => !!list && list.every((v, i) => v === letters[i]);
    // A flow's line is one path or a few strands, each "thread" of the flow's time long; "gap" is the time between
    // one point and the next along it.
    const strands = f => clamp(Math.round(f.strands || 1), 1, 6), gap = f => f.thread * strands(f) / BATCH;
    const threads = () => !!Thread && !!formulas[formula].flow && formulas[formula].thread > 0 && !!Thread.rule(formulas[formula]);
    // The line for these very letters has been followed.
    const lined = () => !!thread && thread.formula === formula && thread.ready && sameLetters(thread.letters);
    // Nothing more to wait for before a still picture: the line is there, or this flow has none (it runs away).
    const threadSettled = () => !threads() || (!!thread && thread.formula === formula && !thread.job && sameLetters(thread.letters));
    // Each frame of a flow: follow its line for the letters as they are now, a little at a time. When one is done
    // the points go onto it: while the letters move that is every few frames, so the line bends with them.
    function tend(now) {
      if (!threads()) { thread = null; return; }
      if (!thread || thread.formula !== formula) thread = {formula, letters: null, asked: null, job: null, ready: false, on: false, at: 0};
      if (!thread.job && !sameLetters(thread.letters)) {
        thread.asked = letters.slice();
        thread.job = Thread.path(formulas[formula], thread.asked, BATCH, gap(formulas[formula]), linePoints, strands(formulas[formula]));
      }
      if (thread.job) {
        const result = thread.job.run(THREAD_MS);
        if (result === 'more') return;
        thread.job = null; thread.letters = thread.asked; thread.ready = result === 'done';
        if (!thread.ready) { if (thread.on) { thread.on = false; afresh = 1; } return; }
        gl.bindBuffer(gl.ARRAY_BUFFER, line); gl.bufferData(gl.ARRAY_BUFFER, linePoints, gl.DYNAMIC_DRAW); gl.bindBuffer(gl.ARRAY_BUFFER, null);
        thread.at = now;
        if (mode === 'still') { if (sameLetters(thread.letters)) rest(); } else { afresh = 2; thread.on = true; }
      } else if (thread.ready && thread.on && mode === 'live' && now - thread.at > THREAD_AGAIN) { afresh = 2; thread.at = now; }
    }
    // The letters rest: begin the still picture from the seeds.
    function rest() {
      mode = 'still'; done = false; warm = formulas[formula].flow ? (lined() ? 0 : FLOW_WARM) : WARM; tick = 0; nStill = 0; pending = 0; summed = 0;
      if (formulas[formula].flow) collapsed = null;
      scatter();
      wipe(sum); wipe(work);
    }
    // A letter moved: the picture on screen becomes the fading one and bends from there.
    function wake() {
      if (share() >= 0.5 && nStill > 0) {
        const n = Math.min(nStill, liveMost);
        add(live, sum, work, n * cap / (nStill * side * side), n / nStill, false);
        nLive = n;
      }
      mode = 'live'; done = false;
    }
    // How much of the screen is the still picture: it takes over as it gathers as many points as the fading one had.
    function share() {
      if (mode !== 'still') return 0;
      if (nLive <= 0) return 1;
      const u = clamp(nStill / Math.max(0.5 * nLive, 3 * BATCH), 0, 1);
      return u * u * (3 - 2 * u);
    }
    // The longest run of batches this frame: fewer after a late frame, more while frames come on time.
    function pace(dt) {
      base = Math.min(base * 1.002, Math.max(dt, 4));
      rate = dt > base * 1.4 ? Math.max(1, rate * 0.7) : Math.min(MAX_RATE, rate * 1.05 + 0.1);
      // Late on average while the picture moves (single frames come in whole refreshes of the screen), with only one
      // batch of points in the frame before: fewer pixels.
      slow += (dt - slow) * 0.05;
      if (mode !== 'live' || slow <= LATE_MS) late = Math.max(0, late - 2); else if (drew <= 1) late++;
      if (late >= LATE_FRAMES && quality > COARSEST) { late = 0; quality = Math.max(COARSEST, quality * COARSER); size(true); }
    }
    // The picture's size in pixels, from the size asked for and the quality. keep: carry the live picture over.
    function size(keep) {
      let w = Math.round(asked[0] * asked[2]), h = Math.round(asked[1] * asked[2]);
      const shrink = Math.min(1, 1080 / Math.min(w, h), 2560 / Math.max(w, h)) * (fine ? 1 : quality);
      w = Math.max(16, Math.round(w * shrink)); h = Math.max(16, Math.round(h * shrink));
      if (w === W && h === H) return;
      const before = live, was = side;
      W = w; H = h; canvas.width = w; canvas.height = h; side = Math.min(w, h);
      cap = Math.round(clamp(side * side * PER_PIXEL, CAP_MIN, CAP_MAX) / BATCH) * BATCH;
      liveMost = side * side * LIVE_PER_PIXEL;
      const levels = blurs ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
      free(sum); free(work);
      live = target(format, w, h, levels); sum = target(format, w, h, levels); work = target(format, w, h, 1);
      wipe(live); wipe(sum); wipe(work); dirty = true;
      if (keep && before && mode === 'live') {
        // A pixel now covers more of the figure, so it holds more of the points.
        gl.bindFramebuffer(gl.FRAMEBUFFER, live.fbo); gl.viewport(0, 0, w, h); gl.disable(gl.BLEND);
        gl.useProgram(copyProgram); bind(0, before); gl.uniform1i(copyAt.a, 0); gl.uniform3f(copyAt.k, 1 / w, 1 / h, (was / side) ** 2);
        quad(); nLive = Math.min(nLive, liveMost); blur(live);
      } else { nLive = 0; if (started) rest(); }
      free(before);
    }
    function show() {
      const square = side * side, part = share();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.disable(gl.BLEND);
      gl.useProgram(showProgram); bind(0, live); bind(1, sum); bind(2, work);
      gl.uniform1i(showAt.live, 0); gl.uniform1i(showAt.sum, 1); gl.uniform1i(showAt.work, 2);
      gl.uniform4f(showAt.gains, nLive > 0 ? square / nLive : 0, nStill > 0 ? cap / nStill : 0, nStill > 0 ? square / nStill : 0, part);
      gl.uniform3f(showAt.halo, blurs && nLive > 0 ? HALO * square / nLive : 0, blurs && summed > 0 ? HALO * cap / summed : 0, Math.max(0, Math.log2(side / 64)));
      gl.uniform2f(showAt.px, 1 / W, 1 / H);
      gl.uniform3fv(showAt.stops, stops);
      quad();
    }

    return {
      // Size in CSS pixels and the screen's pixel ratio. The shorter side is drawn at 1080 pixels at most.
      resize(width, height, ratio) {
        if (width * ratio < 16 || height * ratio < 16) return;
        asked = [width, height, ratio];
        size(false);
      },
      // The formula (its place in the list), the four letters and the view now. "inMotion": they are still changing.
      set(index, values, inMotion, view = FRONT) {
        moving = inMotion;
        const same = started && index === formula && values.every((v, i) => v === letters[i]) && view.every((v, i) => v === look[i]);
        if (same && !(inMotion && mode === 'still')) return;
        const first = !started;
        if (!same) {
          const other = index !== formula;
          formula = index; letters = values.slice(); look = view.slice(); changedAt = performance.now();
          // Points arriving from another formula would all enter a flow by the same path and take long to spread.
          if (other) { collapsed = null; if (W && !first && formulas[index].flow) scatter(); }
        }
        started = true;
        if (!W) return;
        if (first) rest();
        if (mode === 'still' && (!first || inMotion)) wake();
      },
      colours(list) { stops.set(list); dirty = true; },
      // One frame. Returns whether anything was drawn.
      frame(now) {
        added = 0;
        if (!W || !started) return false;
        const dt = last ? Math.min(100, now - last) : 16.7;
        last = now; pace(dt);
        tend(now);
        // Moving again after a still picture drawn finer than a moving one is: back to the coarser size.
        if (fine && mode === 'live') { fine = false; size(true); }
        if (mode === 'live') {
          const keep = Math.exp(-dt / GLOW_MS), count = clamp(Math.round(rate), 1, Math.max(1, Math.ceil(liveMost * (1 - keep) / BATCH)));
          gl.bindFramebuffer(gl.FRAMEBUFFER, live.fbo); gl.viewport(0, 0, W, H);
          gl.enable(gl.BLEND); gl.blendColor(keep, keep, keep, keep); gl.blendFunc(gl.ZERO, gl.CONSTANT_COLOR);
          gl.useProgram(fadeProgram); quad();
          draw(count, live);
          nLive = nLive * keep + count * BATCH; added = count * BATCH; drew = count;
          blur(live);
          if (!moving && performance.now() - changedAt > REST_MS && threadSettled()) {
            if (quality < 1) { fine = true; size(true); }
            rest();
          }
        } else if (!done) {
          let folded = false;
          // (Warming a flow draws nothing, so several steps fit in a frame.)
          const flow = !!formulas[formula].flow;
          for (let left = Math.max(flow && warm > 0 ? 4 : 1, Math.round(rate)); left > 0 && !done; left--) {
            if (warm > 0) { run(1, null, 0, 0); if (--warm === 0 && !flow) census(); continue; }
            draw(1, work);
            nStill += BATCH; pending += BATCH; added += BATCH;
            if (pending >= side * side || nStill >= cap) { fold(); folded = true; }
            if (nStill >= cap) done = true;
          }
          if (folded) blur(sum);
        } else if (!dirty) return false;
        show(); dirty = false;
        return true;
      },
      get points() { return mode === 'live' ? Math.round(nLive) : nStill; },
      get added() { return added; },
      get stopped() { return mode === 'still' && done; },
      get collapsed() { return collapsed; },
      get mode() { return mode; },
      get cap() { return cap; },
      get size() { return [W, H]; },
      get quality() { return quality; },
      get lined() { return !!thread && thread.on && thread.formula === formula; },
      get rate() { return rate; },
      get lost() { return gl.isContextLost(); },
    };
  }
  window.Picture = {create, BATCH};
})();
