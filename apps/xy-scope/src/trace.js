// trace.js: how the beam is drawn.
//
// IN   create(canvas, {view, maxPixels}) once, then on every frame
//      draw(points, count, look)
//        points   Float32Array of x,y pairs in figure units: -1..1 is a full-size figure, the canvas shows -view..view
//        count    how many pairs to draw; the beam carries on from the last point of the previous call
//        look     {colour: [r, g, b], glow: seconds the phosphor keeps its light, dt: seconds since the last draw}
// OUT  one beam on a black screen, added up like light: brighter where it moves slowly, fading like phosphor.
//      Nothing else is drawn here: no text, no scale, no grid.
//
// To remix: the beam's width, halo and brightness are the constants below; the colour curve is in SHOW. Each segment is
// a small rectangle whose shader works out how long the beam's round spot lingered over every pixel it covers.
(() => {
  'use strict';
  const RATE = 48000;       // points per second of signal
  const SPOT = 0.0026;      // beam spot size (sigma), as a fraction of the canvas' short side
  const HALO = 0.22;        // share of the light in a soft halo four spots wide
  const BRIGHT = 60;        // overall brightness
  const MAX_SEGMENTS = 4096;

  const VERT_BEAM = 'attribute vec2 a_a,a_b,a_corner;uniform vec2 u_unit,u_half;uniform float u_reach;varying vec3 v;' +
    'void main(){vec2 A=a_a*u_unit,B=a_b*u_unit,d=B-A;float len=length(d);vec2 dir=len>1e-4?d/len:vec2(1.,0.);' +
    'float along=mix(-u_reach,len+u_reach,a_corner.x),across=a_corner.y*u_reach;' +
    'v=vec3(along,across,len);gl_Position=vec4((A+dir*along+vec2(-dir.y,dir.x)*across)/u_half,0.,1.);}';
  const PRECISION = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';
  // Light left on a pixel by a round (Gaussian) spot that slides evenly along the segment. The total is the same for
  // every segment, so a short segment (a slow beam) is brighter than a long one.
  const FRAG_BEAM = PRECISION + 'uniform float u_sigma,u_energy,u_halo;varying vec3 v;' +
    'float erf(float x){float s=sign(x),a=abs(x);x=1.+(.278393+(.230389+.078108*(a*a))*a)*a;x*=x;return s-s/(x*x);}' +
    'float beam(float sigma){float k=.70710678/sigma;' +
    'if(v.z<.02)return exp(-(v.x*v.x+v.y*v.y)*k*k)/(6.2831853*sigma*sigma);' +
    'return exp(-v.y*v.y*k*k)*(erf(v.x*k)-erf((v.x-v.z)*k))/(2.*v.z*2.5066283*sigma);}' +
    'void main(){gl_FragColor=vec4(u_energy*(beam(u_sigma)*(1.-u_halo)+beam(u_sigma*4.)*u_halo),0.,0.,1.);}';
  const VERT_FULL = 'attribute vec2 a_corner;varying vec2 uv;void main(){uv=a_corner*.5+.5;gl_Position=vec4(a_corner,0.,1.);}';
  // Phosphor: what was lit keeps a share of its light each frame.
  const FRAG_FADE = PRECISION + 'uniform sampler2D u_light;uniform float u_keep,u_floor;varying vec2 uv;' +
    'void main(){gl_FragColor=vec4(max(texture2D(u_light,uv).r*u_keep-u_floor,0.),0.,0.,1.);}';
  // SHOW: stored light to colour. Faint light takes the phosphor colour; strong light burns towards white.
  const FRAG_SHOW = PRECISION + 'uniform sampler2D u_light;uniform vec3 u_colour;uniform float u_gain;varying vec2 uv;' +
    'void main(){float i=texture2D(u_light,uv).r*u_gain;gl_FragColor=vec4(min(u_colour*(1.-exp(-i))+vec3(1.-exp(-i*.1)),1.),1.);}';

  function createGL(canvas, options) {
    const attributes = {alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance'};
    let gl = canvas.getContext('webgl2', attributes), second = !!gl;
    if (!gl) gl = canvas.getContext('webgl', attributes);
    if (!gl) return null;
    const view = options.view, maxPixels = options.maxPixels;
    let beam, fade, show, quads, corners, indices, targets = [], current = 0, float = false, lost = false, last = null;
    const data = new Float32Array(MAX_SEGMENTS * 24);

    function program(vertex, fragment) {
      const p = gl.createProgram();
      for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
        const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'shader');
        gl.attachShader(p, shader);
      }
      gl.bindAttribLocation(p, 0, 'a_corner'); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'program');
      const uniforms = {}, count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) { const name = gl.getActiveUniform(p, i).name; uniforms[name] = gl.getUniformLocation(p, name); }
      return {p, u: uniforms, a: name => gl.getAttribLocation(p, name)};
    }
    function target(width, height, wantFloat) {
      const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
      for (const [name, value] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, name, value);
      if (wantFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, width, height, 0, gl.RED, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const frame = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, frame);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      return complete ? {texture, frame} : (gl.deleteFramebuffer(frame), gl.deleteTexture(texture), null);
    }
    function build() {
      for (const t of targets) { gl.deleteFramebuffer(t.frame); gl.deleteTexture(t.texture); }
      targets = []; float = false;
      // Half-float light keeps faint strokes and long afterglow smooth; 8-bit is the fallback.
      if (second && (gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))) {
        const a = target(canvas.width, canvas.height, true), b = a && target(canvas.width, canvas.height, true);
        if (a && b) { targets = [a, b]; float = true; }
      }
      if (!float) targets = [target(canvas.width, canvas.height, false), target(canvas.width, canvas.height, false)];
      if (!targets[0] || !targets[1]) throw new Error('framebuffer');
      current = 0; last = null;
    }
    function setup() {
      beam = program(VERT_BEAM, FRAG_BEAM); fade = program(VERT_FULL, FRAG_FADE); show = program(VERT_FULL, FRAG_SHOW);
      quads = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quads); gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
      corners = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, corners); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const order = new Uint16Array(MAX_SEGMENTS * 6);
      for (let i = 0; i < MAX_SEGMENTS; i++) order.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
      indices = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, order, gl.STATIC_DRAW);
      gl.disable(gl.DEPTH_TEST);
      build();
    }
    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 3), cssWidth = canvas.clientWidth || 1, cssHeight = canvas.clientHeight || 1;
      const scale = Math.min(ratio, Math.sqrt(maxPixels / (cssWidth * cssHeight)));
      const width = Math.max(2, Math.round(cssWidth * scale)), height = Math.max(2, Math.round(cssHeight * scale));
      if (width === canvas.width && height === canvas.height) return;
      canvas.width = width; canvas.height = height;
      if (!lost) build();
    }
    function full(prog, texture) {
      gl.useProgram(prog.p); gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(prog.u.u_light, 0);
    }
    function draw(points, count, look) {
      if (lost) return;
      const width = canvas.width, height = canvas.height, short = Math.min(width, height), unit = short / (2 * view);
      const sigma = Math.max(0.8, SPOT * short), reach = sigma * 10, glow = Math.max(look.glow, 1 / 240);
      const from = targets[current], to = targets[1 - current];
      gl.viewport(0, 0, width, height); gl.bindFramebuffer(gl.FRAMEBUFFER, to.frame); gl.disable(gl.BLEND);
      full(fade, from.texture);
      gl.uniform1f(fade.u.u_keep, Math.exp(-look.dt / glow)); gl.uniform1f(fade.u.u_floor, float ? 0 : 0.6 / 255);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      let segments = 0;
      for (let i = Math.max(0, count - MAX_SEGMENTS); i < count; i++) {
        const bx = points[2 * i], by = points[2 * i + 1], ax = last ? last[0] : bx, ay = last ? last[1] : by;
        for (let corner = 0, at = segments * 24; corner < 4; corner++, at += 6) {
          data[at] = ax; data[at + 1] = ay; data[at + 2] = bx; data[at + 3] = by; data[at + 4] = corner & 1; data[at + 5] = corner & 2 ? 1 : -1;
        }
        (last ||= [0, 0])[0] = bx; last[1] = by; segments++;
      }
      if (segments) {
        gl.useProgram(beam.p); gl.bindBuffer(gl.ARRAY_BUFFER, quads); gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, segments * 24));
        const a = beam.a('a_a'), b = beam.a('a_b');
        gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(b); gl.vertexAttribPointer(b, 2, gl.FLOAT, false, 24, 8);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 16);
        gl.uniform2f(beam.u.u_unit, unit, unit); gl.uniform2f(beam.u.u_half, width / 2, height / 2);
        gl.uniform1f(beam.u.u_reach, reach); gl.uniform1f(beam.u.u_sigma, sigma); gl.uniform1f(beam.u.u_halo, HALO);
        // A resting figure is equally bright whatever the afterglow: the longer the glow, the less each pass adds.
        gl.uniform1f(beam.u.u_energy, BRIGHT * unit * sigma / (RATE * glow) * (float ? 1 : 0.125));
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices); gl.drawElements(gl.TRIANGLES, segments * 6, gl.UNSIGNED_SHORT, 0);
        gl.disable(gl.BLEND); gl.disableVertexAttribArray(a); gl.disableVertexAttribArray(b);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      full(show, to.texture);
      gl.uniform3f(show.u.u_colour, look.colour[0], look.colour[1], look.colour[2]); gl.uniform1f(show.u.u_gain, float ? 1 : 8);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      current = 1 - current;
    }
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { try { setup(); lost = false; } catch (_) { /* stays dark */ } });
    setup(); resize();
    return {draw, resize, get kind() { return (second ? 'webgl2' : 'webgl') + (float ? '-float' : ''); }};
  }

  // Without WebGL: plain lines that fade. The beam is evenly bright.
  function create2D(canvas, options) {
    const context = canvas.getContext('2d', {alpha: false});
    let last = null;
    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2), width = Math.max(2, Math.round((canvas.clientWidth || 1) * ratio)), height = Math.max(2, Math.round((canvas.clientHeight || 1) * ratio));
      if (width !== canvas.width || height !== canvas.height) { canvas.width = width; canvas.height = height; last = null; }
    }
    function draw(points, count, look) {
      const width = canvas.width, height = canvas.height, unit = Math.min(width, height) / (2 * options.view);
      context.globalCompositeOperation = 'source-over'; context.fillStyle = 'rgba(0,0,0,' + (1 - Math.exp(-look.dt / Math.max(look.glow, 1 / 240))).toFixed(3) + ')'; context.fillRect(0, 0, width, height);
      if (!count) return;
      context.globalCompositeOperation = 'lighter'; context.lineWidth = Math.max(1, SPOT * 2 * Math.min(width, height)); context.lineJoin = context.lineCap = 'round';
      context.strokeStyle = 'rgb(' + look.colour.map(v => Math.round(Math.min(1, v) * 255)).join(',') + ')';
      context.beginPath();
      const first = last || [points[0], points[1]]; context.moveTo(width / 2 + first[0] * unit, height / 2 - first[1] * unit);
      for (let i = 0; i < count; i++) context.lineTo(width / 2 + points[2 * i] * unit, height / 2 - points[2 * i + 1] * unit);
      context.stroke(); last = [points[2 * count - 2], points[2 * count - 1]];
    }
    resize();
    return {draw, resize, kind: '2d'};
  }

  globalThis.XYTrace = {
    // Returns the drawing surface; "canvas" is the element in use (a fresh one if WebGL had to be given up).
    create(canvas, {view = 1.5, maxPixels = 1920 * 1080} = {}) {
      let trace = null;
      try { trace = createGL(canvas, {view, maxPixels}); } catch (_) { trace = null; }
      if (trace) return Object.assign(trace, {canvas});
      if (!canvas.getContext('2d')) { const fresh = canvas.cloneNode(false); canvas.replaceWith(fresh); canvas = fresh; }
      return Object.assign(create2D(canvas, {view}), {canvas});
    },
  };
})();
