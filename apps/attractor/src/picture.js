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

  const QUAD = [
    '#version 300 es',
    'void main() {',
    '  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
    '}'].join('\n');
  // One step for one point. STEP is the formula. "count" goes to the pixel: one point, and its colour side.
  // The colour side follows x (left to right): halves, chosen by chance, keep the sum exact in a half float.
  const STEP_VS = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'layout(location = 0) in vec2 p;',
    'uniform vec4 k;      // a, b, c, d',
    'uniform vec4 frame;  // x scale, y scale, colour scale, jitter',
    'uniform uint tick;',
    'out vec2 q;',
    'out vec2 count;',
    'void main() {',
    '  float a = k.x, b = k.y, c = k.z, d = k.w;',
    '  uint h = uint(gl_VertexID) * 747796405u + tick * 2891336453u + 12345u;',
    '  h = (h ^ (h >> 16)) * 2246822519u;',
    '  h = (h ^ (h >> 13)) * 3266489917u;',
    '  h ^= h >> 16;',
    '  vec2 nudge = vec2(float(h & 1023u), float((h >> 10) & 1023u)) / 1023.0 - 0.5;',
    '  q = STEP + nudge * frame.w;',
    '  float side = clamp((0.75 * q.x + 0.25 * p.x) * frame.z + 0.5, 0.0, 1.0);',
    '  count = vec2(1.0, floor(side * 2.0 + float(h >> 20) / 4096.0) * 0.5);',
    '  gl_Position = vec4(q.x * frame.x, q.y * frame.y, 0.0, 1.0);',
    '  gl_PointSize = 1.0;',
    '}'].join('\n');
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
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * px;',
    '  vec2 v = vec2(0.0);',
    '  if (gains.w < 1.0) v += (soft(live, uv) * gains.x + textureLod(live, uv, halo.z).rg * halo.x) * (1.0 - gains.w);',
    '  if (gains.w > 0.0) v += (soft(sum, uv) * gains.y + soft(work, uv) * gains.z + textureLod(sum, uv, halo.z).rg * halo.y) * gains.w;',
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

    const fadeProgram = link(QUAD, FADE_FS), addProgram = link(QUAD, ADD_FS), showProgram = link(QUAD, SHOW_FS);
    const addAt = at(addProgram, ['a', 'b', 'k']), showAt = at(showProgram, ['live', 'sum', 'work', 'gains', 'halo', 'px', 'stops']);
    const steppers = [];
    function stepper(index) {
      if (!steppers[index]) {
        const program = link(STEP_VS.replace('STEP', formulas[index].step), STEP_FS, ['q']);
        steppers[index] = {program, ...at(program, ['k', 'frame', 'tick'])};
      }
      return steppers[index];
    }

    // Fixed seeds: the still picture always starts from the same points.
    const seeds = new Float32Array(BATCH * 2);
    for (let i = 0, h = 20261111; i < seeds.length; i++) { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; seeds[i] = (h / 4294967296 - 0.5) * 3; }
    const buffers = [gl.createBuffer(), gl.createBuffer()], arrays = [gl.createVertexArray(), gl.createVertexArray()], empty = gl.createVertexArray();
    for (let i = 0; i < 2; i++) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[i]); gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.DYNAMIC_COPY);
      gl.bindVertexArray(arrays[i]); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const cells = target(gl.RGBA8, 64, 64, 1), seen = new Uint8Array(64 * 64 * 4);

    let W = 0, H = 0, side = 0, cap = CAP_MIN, liveMost = 0;
    let live = null, sum = null, work = null;
    let formula = 0, letters = [0, 0, 0, 0], moving = false, changedAt = 0, started = false;
    let mode = 'still', done = false, warm = 0, tick = 0, current = 0;
    let nLive = 0, nStill = 0, pending = 0, summed = 0, collapsed = null, dirty = true;
    let rate = 2, base = 16.7, last = 0, added = 0;
    const stops = new Float32Array(15).fill(1);

    const quad = () => { gl.bindVertexArray(empty); gl.drawArrays(gl.TRIANGLES, 0, 3); };
    const bind = (unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t.tex); };

    // "count" batches take a step. They are drawn into "into", or only stepped when it is null.
    function run(count, into, scaleX, scaleY) {
      const s = stepper(formula), view = formulas[formula].view;
      gl.useProgram(s.program);
      gl.uniform4f(s.k, letters[0], letters[1], letters[2], letters[3]);
      gl.uniform4f(s.frame, scaleX, scaleY, 0.6 / view, JITTER * view);
      if (into) { gl.bindFramebuffer(gl.FRAMEBUFFER, into.fbo); gl.viewport(0, 0, into.w, into.h); } else gl.enable(gl.RASTERIZER_DISCARD);
      for (let i = 0; i < count; i++) {
        gl.uniform1ui(s.tick, tick++);
        gl.bindVertexArray(arrays[current]);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffers[1 - current]);
        gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, BATCH); gl.endTransformFeedback();
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
        current = 1 - current;
      }
      if (!into) gl.disable(gl.RASTERIZER_DISCARD);
    }
    // y runs down the screen, as on paper and in the usual pictures of these formulas.
    function draw(count, into) {
      const view = formulas[formula].view;
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      run(count, into, side * FIT / (W * view), -side * FIT / (H * view));
    }
    // How many of 64 x 64 cells one batch touches: very few means the figure has collapsed to some points.
    function census() {
      const view = formulas[formula].view;
      wipe(cells); gl.disable(gl.BLEND);
      run(1, cells, 1 / view, -1 / view);
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
    // The letters rest: begin the still picture from the seeds.
    function rest() {
      mode = 'still'; done = false; warm = WARM; tick = 0; nStill = 0; pending = 0; summed = 0;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[current]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, seeds); gl.bindBuffer(gl.ARRAY_BUFFER, null);
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
      // Size in CSS pixels and the screen's pixel ratio. The longer side is drawn at 1080 pixels at most.
      resize(width, height, ratio) {
        let w = Math.round(width * ratio), h = Math.round(height * ratio);
        if (w < 16 || h < 16) return;
        const shrink = Math.min(1, 1080 / Math.min(w, h), 2560 / Math.max(w, h));
        w = Math.round(w * shrink); h = Math.round(h * shrink);
        if (w === W && h === H) return;
        W = w; H = h; canvas.width = w; canvas.height = h; side = Math.min(w, h);
        cap = Math.round(clamp(side * side * PER_PIXEL, CAP_MIN, CAP_MAX) / BATCH) * BATCH;
        liveMost = side * side * LIVE_PER_PIXEL;
        const levels = blurs ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
        free(live); free(sum); free(work);
        live = target(format, w, h, levels); sum = target(format, w, h, levels); work = target(format, w, h, 1);
        wipe(live); nLive = 0; dirty = true;
        if (started) rest();
      },
      // The formula (its place in the list) and the four letters now. "inMotion": they are still on their way.
      set(index, values, inMotion) {
        moving = inMotion;
        if (started && index === formula && values.every((v, i) => v === letters[i])) return;
        const first = !started;
        formula = index; letters = values.slice(); changedAt = performance.now(); started = true;
        if (!W) return;
        if (first) rest(); else if (mode === 'still') wake();
      },
      colours(list) { stops.set(list); dirty = true; },
      // One frame. Returns whether anything was drawn.
      frame(now) {
        added = 0;
        if (!W || !started) return false;
        const dt = last ? Math.min(100, now - last) : 16.7;
        last = now; pace(dt);
        if (mode === 'live') {
          const keep = Math.exp(-dt / GLOW_MS), count = clamp(Math.round(rate), 1, Math.max(1, Math.ceil(liveMost * (1 - keep) / BATCH)));
          gl.bindFramebuffer(gl.FRAMEBUFFER, live.fbo); gl.viewport(0, 0, W, H);
          gl.enable(gl.BLEND); gl.blendColor(keep, keep, keep, keep); gl.blendFunc(gl.ZERO, gl.CONSTANT_COLOR);
          gl.useProgram(fadeProgram); quad();
          draw(count, live);
          nLive = nLive * keep + count * BATCH; added = count * BATCH;
          blur(live);
          if (!moving && performance.now() - changedAt > REST_MS) rest();
        } else if (!done) {
          let folded = false;
          for (let left = Math.max(1, Math.round(rate)); left > 0 && !done; left--) {
            if (warm > 0) { run(1, null, 0, 0); if (--warm === 0) census(); continue; }
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
      get rate() { return rate; },
      get lost() { return gl.isContextLost(); },
    };
  }
  window.Picture = {create, BATCH};
})();
