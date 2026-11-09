/* Botanica Core — holographic garden renderer (WebGL 1).
 *
 * TouchDesigner-style pipeline:
 *   scene (additive glass petals, wireframe, point cloud, crystals, butterflies,
 *   water mirror with ripples, motes, sparks)
 *   → feedback trails → bloom (¼ res) → composite (datamosh glitch, chromatic
 *   aberration, pixel crush, scanlines, komorebi rays).
 * Geometry is static; motion lives in shaders driven by ~40 uniforms.
 * Render scale adapts to the measured frame time, within options.maxPixels (a large output screen). */
(() => {
  'use strict';

  const COMMON = `
precision highp float;
uniform mat4 uProj, uView;
uniform float uTime, uCount, uOpen, uLen, uDroop, uSway, uSpin, uRoot, uLayer3, uPulse, uMirror, uWater, uDissolve, uJitter, uNotch, uRound;
uniform float uHit[12];
const float PI = 3.14159265;
vec3 rotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
vec2 arc(float a, float b, float u) {
  if (abs(b) < 0.001) return vec2(cos(a), sin(a)) * u;
  return vec2(sin(a + b * u) - sin(a), cos(a) - cos(a + b * u)) / b;
}
float h11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
vec3 blade(float u, float v, float len, float width, float open, float droop, float cup, float flutter, float notch) {
  float ue = u * (1.0 - notch * 0.14 * exp(-pow((v - 0.5) * 7.0, 2.0)) * smoothstep(0.55, 1.0, u));
  float hw = width * pow(max(sin(PI * pow(ue, 0.68 + uRound * 0.25)), 0.0), 0.75 + uRound * 0.3);
  float s = (v * 2.0 - 1.0) * hw;
  vec2 c = arc(PI * 0.5 - open, -droop, ue) * len;
  return vec3(c.x, c.y + cup * s * s / max(len, 0.05) + flutter, s);
}
vec3 stemAt(float t) {
  float sw = uSway * 0.08 * sin(uTime * 0.7);
  return vec3(0.06 * t * t + sw * sin(t * 1.5708), uWater + (0.02 - uWater) * t, 0.03 * t * t + sw * 0.5 * sin(t * 1.5708));
}
vec3 posAt(vec4 a, float u, float v) {
  float kind = a.w, idx = a.z;
  vec3 head = stemAt(1.0);
  if (kind < 2.5) {
    float layer = kind, n = uCount;
    float vis = step(idx, n - 0.5);
    if (layer > 1.5) vis *= uLayer3;
    float theta = (idx + 0.5 * mod(layer, 2.0)) / n * 6.28318 + uSpin * (1.0 - 0.3 * layer) + layer * 0.37;
    float hit = uHit[int(idx)];
    float len = uLen * (0.58 + 0.3 * layer) * (1.0 + 0.16 * hit) * vis;
    float width = len * clamp(2.2 / n, 0.16, 0.5) * (1.0 + 0.1 * layer);
    float open = uOpen * (0.5 + 0.32 * layer) + layer * 0.14 + hit * 0.14;
    float droop = uDroop * (0.5 + 0.5 * layer) + 0.2;
    float flutter = uSway * 0.05 * sin(uTime * 2.7 + idx * 1.7 + layer * 2.0) * u * len;
    vec3 b = blade(u, v, len, width, open, droop, 0.5, flutter, uNotch);
    b.x += 0.03; b.y -= 0.025 * layer;
    return head + rotY(b, theta);
  }
  if (kind < 3.5) {
    float t = 0.38 + idx * 0.22;
    float len = 0.55 * (0.75 + uRoot * 0.5) * (1.0 - idx * 0.25);
    float flutter = uSway * 0.06 * sin(uTime * 2.1 + idx * 2.0) * u * len;
    vec3 b = blade(u, v, len, len * 0.26, 1.1, 0.95, 0.3, flutter, 0.0);
    return stemAt(t) + rotY(b, idx * 3.14159 + 0.6);
  }
  if (kind < 4.5) {
    float r = 0.018 * (1.0 + uRoot * 1.2) * (1.0 - 0.4 * u);
    float ang = v * 6.28318;
    return stemAt(u) + vec3(cos(ang) * r, 0.0, sin(ang) * r);
  }
  float rc = (0.05 + 0.03 * uOpen) * (1.0 + uPulse * 0.35);
  float th = u * PI, ph = v * 6.28318;
  return head + vec3(0.0, 0.03, 0.0) + rc * vec3(sin(th) * cos(ph), cos(th) * 0.75, sin(th) * sin(ph));
}
vec3 place(vec3 p) {
  if (uJitter > 0.0) p.x += (h11(floor(p.y * 30.0) + floor(uTime * 24.0)) - 0.5) * uJitter * 0.08;
  if (uMirror > 0.5) p.y = 2.0 * uWater - p.y;
  return p;
}`;

  const FLOWER_VS = COMMON + `
attribute vec4 aP;
uniform float uPointMode;
varying vec3 vN; varying vec3 vW; varying vec2 vUV; varying float vKind; varying float vHit; varying float vDepth;
void main() {
  float u = aP.x, v = aP.y, e = 0.02;
  vec3 p = posAt(aP, u, v);
  vec3 du = posAt(aP, min(u + e, 1.0), v) - posAt(aP, max(u - e, 0.0), v);
  vec3 dv = posAt(aP, u, min(v + e, 1.0)) - posAt(aP, u, max(v - e, 0.0));
  vec3 n = cross(du, dv);
  vN = length(n) > 1e-7 ? normalize(n) : vec3(0.0, 1.0, 0.0);
  if (uPointMode > 0.5 && uDissolve > 0.0) {
    float s = h11(aP.x * 13.1 + aP.y * 71.7 + aP.z * 3.3 + aP.w * 17.0);
    vec3 dir = normalize(vec3(h11(s * 9.1) - 0.5, h11(s * 3.7) - 0.2, h11(s * 5.3) - 0.5));
    float k = uDissolve * (0.4 + 0.6 * s);
    p += dir * k * (0.35 + 0.25 * sin(uTime * 0.6 + s * 6.0)) + vec3(0.0, k * 0.25 * fract(uTime * 0.1 + s), 0.0);
  }
  vDepth = p.y - uWater;
  if (uMirror > 0.5) vN.y = -vN.y;
  p = place(p);
  vW = p; vUV = vec2(u, v); vKind = aP.w;
  vHit = aP.w < 2.5 ? uHit[int(aP.z)] : (aP.w > 4.5 ? uPulse : 0.0);
  gl_Position = uProj * uView * vec4(p, 1.0);
  float sh = h11(aP.x * 91.0 + aP.y * 37.0 + aP.z * 11.0 + aP.w);
  gl_PointSize = uPointMode * (1.2 + 2.4 * sh * sh + vHit * 3.0 + uDissolve * 1.5) * (uProj[1][1] * 2.2) / gl_Position.w;
}`;

  const FLOWER_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec3 uEye, uTint, uAccent, uCore;
uniform float uTime, uIri, uAlpha, uMode, uHue, uMirror, uScanY, uWire;
varying vec3 vN; varying vec3 vW; varying vec2 vUV; varying float vKind; varying float vHit; varying float vDepth;
void main() {
  vec3 N = normalize(vN), V = normalize(uEye - vW);
  float fr = pow(1.0 - abs(dot(N, V)), 1.6);
  float film = fr * 1.35 + vUV.x * 0.55 + vUV.y * 0.2 + uTime * 0.025 + uHue;
  vec3 iri = 0.55 + 0.45 * cos(6.28318 * (film + vec3(0.0, 0.33, 0.67)));
  vec3 base = vKind > 2.5 && vKind < 4.5 ? mix(uAccent, vec3(0.55, 1.0, 0.75), 0.55) : uTint;
  vec3 col = mix(base, iri * base * 1.4 + iri * 0.25, uIri);
  float scan = exp(-pow((vW.y - uScanY) * 9.0, 2.0));
  float contour = 1.0 - smoothstep(0.0, 0.08, abs(fract(vW.y * 9.0 - uTime * 0.35) - 0.5) * 2.0);
  float a;
  if (uMode < 0.5) {            // glass faces
    a = (0.012 + 0.26 * fr * fr) * uAlpha;
    a += contour * 0.018 * uAlpha + scan * 0.08 * uAlpha;
    if (vKind > 4.5) { col = mix(uCore, vec3(1.0), 0.2); a = (0.05 + 0.18 * fr + vHit * 0.22) * uAlpha; }
    col += uAccent * (1.0 - smoothstep(0.0, 0.35, vUV.x)) * 0.2 * (vKind < 2.5 ? 1.0 : 0.0);
  } else if (uMode < 1.5) {     // wireframe
    a = (0.05 + 0.16 * fr + scan * 0.45) * uWire;
    col = mix(uAccent, iri, 0.35) + vec3(0.2);
  } else {                      // points
    vec2 pc = gl_PointCoord - 0.5;
    a = smoothstep(0.5, 0.0, length(pc)) * (0.18 + scan * 0.5) * uAlpha;
    col = mix(vec3(1.0), iri, 0.4);
  }
  col += vHit * mix(uAccent, vec3(1.0), 0.5) * 0.6;
  if (uMirror > 0.5) a *= 0.32 * exp(-max(vDepth, 0.0) * 1.6);
  gl_FragColor = vec4(col * a, 1.0);
}`;

  const CRYSTAL_VS = `
precision highp float;
attribute vec4 aC; attribute vec3 aN;
uniform mat4 uProj, uView;
uniform vec4 uCP[13]; uniform vec4 uCR[13];
uniform float uMirror, uWater, uGrow;
varying vec3 vN; varying vec3 vW; varying float vH; varying float vId; varying float vDepth;
vec3 rot(vec3 p, vec4 r) {
  float c = cos(r.z), s = sin(r.z); p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  c = cos(r.x); s = sin(r.x); p = vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
  c = cos(r.y); s = sin(r.y); p = vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
  return p;
}
void main() {
  int id = int(aC.w);
  vec4 cp = uCP[id], cr = uCR[id];
  vec3 lp = aC.xyz * vec3(1.0, cr.w, 1.0);
  vec3 p = cp.xyz + rot(lp * cp.w, cr);
  vN = rot(aN, cr);
  vDepth = p.y - uWater;
  if (uMirror > 0.5) { p.y = 2.0 * uWater - p.y; vN.y = -vN.y; }
  vW = p; vH = aC.y; vId = aC.w;
  gl_Position = uProj * uView * vec4(p, 1.0);
}`;
  const CRYSTAL_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec3 uEye, uTint, uAccent;
uniform float uTime, uHue, uMode, uAlpha, uMirror, uGlow;
varying vec3 vN; varying vec3 vW; varying float vH; varying float vId; varying float vDepth;
void main() {
  vec3 N = normalize(vN), V = normalize(uEye - vW);
  float fr = pow(1.0 - abs(dot(N, V)), 1.3);
  vec3 iri = 0.55 + 0.45 * cos(6.28318 * (fr * 1.6 + vH * 0.4 + vId * 0.13 + uHue + uTime * 0.03 + vec3(0.0, 0.33, 0.67)));
  float facet = 0.5 + 0.5 * sin(dot(N, vec3(3.0, 5.0, 7.0)) * 3.0);
  vec3 col = mix(uTint, iri, 0.7) * (0.5 + 0.5 * facet);
  float a = uMode < 0.5 ? (0.05 + 0.5 * fr) * uAlpha : (0.35 + 0.4 * vH) * uAlpha * 1.3;
  if (uMode > 0.5) col = mix(uAccent, vec3(1.0), 0.4);
  col *= 1.0 + uGlow * 0.8;
  if (uMirror > 0.5) a *= 0.3 * exp(-max(vDepth, 0.0) * 2.0);
  gl_FragColor = vec4(col * a, 1.0);
}`;

  const WATER_VS = `
precision highp float;
attribute vec2 aQ;
uniform mat4 uProj, uView; uniform float uWater;
varying vec2 vXZ;
void main() { vXZ = aQ * 3.2; gl_Position = uProj * uView * vec4(vXZ.x, uWater, vXZ.y, 1.0); }`;
  const WATER_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec4 uRip[8];
uniform float uTime, uBass, uGrid;
uniform vec3 uTint, uAccent;
varying vec2 vXZ;
void main() {
  float r = length(vXZ);
  float fade = smoothstep(3.2, 0.4, r);
  float ring = 1.0 - smoothstep(0.0, 0.035, abs(fract(r * 2.5) - 0.5) * 2.0 * 0.5 + 0.0);
  float ang = atan(vXZ.y, vXZ.x);
  float spoke = 1.0 - smoothstep(0.0, 0.03, abs(fract(ang / 6.28318 * 24.0) - 0.5) * 2.0 * 0.4);
  float grid = (ring * 0.6 + spoke * 0.25 * smoothstep(0.2, 1.0, r)) * uGrid;
  float rip = 0.0;
  for (int i = 0; i < 8; i++) {
    vec4 R = uRip[i];
    float age = uTime - R.z;
    if (age > 0.0 && age < 3.0) {
      float d = length(vXZ - R.xy);
      float w = d - age * 0.75;
      rip += exp(-w * w * 160.0) * exp(-age * 1.4) * R.w + exp(-pow(w + 0.08, 2.0) * 300.0) * exp(-age * 2.0) * R.w * 0.4;
    }
  }
  float caust = pow(0.5 + 0.5 * sin(vXZ.x * 7.0 + uTime * 0.8 + sin(vXZ.y * 5.0 - uTime * 0.6) * 1.5) * sin(vXZ.y * 6.0 - uTime * 0.5), 6.0) * 0.12;
  float center = exp(-r * r * 3.0) * (0.12 + uBass * 0.4);
  vec3 col = uTint * (grid * 0.22 + caust + center) + mix(uAccent, vec3(1.0), 0.4) * rip;
  gl_FragColor = vec4(col * fade, 1.0);
}`;

  const FLY_VS = `
precision highp float;
attribute vec4 aF;           // corner x, corner y, side, id
uniform mat4 uProj, uView;
uniform float uTime, uVox, uJitter, uFlyOn;
varying vec2 vUV; varying float vId; varying float vSide;
float h11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
void main() {
  float id = aF.w, side = aF.z;
  float t = uTime * (0.18 + 0.05 * id) + id * 2.1;
  vec3 c = vec3(sin(t) * (0.95 + 0.25 * id), -0.25 + 0.28 * sin(t * 1.7 + id) + 0.08 * id, cos(t * 0.8) * (0.75 + 0.2 * id));
  vec3 vel = vec3(cos(t), 0.6 * cos(t * 1.7 + id), -0.8 * sin(t * 0.8));
  float head = atan(vel.x, vel.z);
  float flap = sin(uTime * (7.0 + uVox * 9.0) + id * 3.0) * (0.75 + uVox * 0.35);
  vec2 q = vec2(aF.x, aF.y);
  vec3 p = vec3(q.x * side, 0.0, q.y) * 0.16 * (0.8 + 0.2 * id);
  float ang = flap * side;
  p = vec3(p.x * cos(ang), abs(p.x) * sin(ang) * 1.0, p.z);
  float ch = cos(head), sh = sin(head);
  p = vec3(ch * p.x + sh * p.z, p.y, -sh * p.x + ch * p.z);
  if (uJitter > 0.0) c.x += (h11(floor(uTime * 20.0) + id) - 0.5) * uJitter * 0.3;
  vUV = q; vId = id; vSide = side;
  gl_Position = uProj * uView * vec4(c + p, 1.0) * uFlyOn;
}`;
  const FLY_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float uTime, uHue, uAlpha;
uniform vec3 uAccent;
varying vec2 vUV; varying float vId; varying float vSide;
void main() {
  vec2 q = vUV;               // x 0..1 (out from body), y -1..1 (front/back)
  float fw = length((q - vec2(0.48, 0.42)) / vec2(0.5, 0.48));
  float hw = length((q - vec2(0.38, -0.45)) / vec2(0.36, 0.42));
  float d = min(fw, hw);
  if (d > 1.0) discard;
  float edge = smoothstep(0.75, 1.0, d);
  float vein = 1.0 - smoothstep(0.0, 0.06, abs(fract(atan(q.y, q.x + 0.05) * 3.0) - 0.5));
  vec3 iri = 0.55 + 0.45 * cos(6.28318 * (d * 0.8 + vId * 0.3 + uHue + uTime * 0.05 + vec3(0.0, 0.33, 0.67)));
  vec3 col = iri * (0.18 + edge * 0.9 + vein * 0.12) + uAccent * edge * 0.3;
  gl_FragColor = vec4(col * uAlpha, 1.0);
}`;

  const PART_VS = `
precision highp float;
attribute vec4 aS;           // seed x, seed y, seed z, kind (0 mote, 1 spark)
uniform mat4 uProj, uView;
uniform float uTime, uMotes, uLevel, uWater, uFreeze;
varying float vA; varying float vK;
void main() {
  vec3 p; float size, a;
  if (aS.w < 0.5) {
    float on = step(aS.x, uMotes);
    float t = uTime * (1.0 - uFreeze * 0.9);
    float ang = aS.y * 6.28318 + t * (0.05 + aS.z * 0.12);
    float r = 0.3 + aS.z * 1.9;
    float y = fract(aS.y * 3.7 + t * 0.025 * (0.5 + aS.x));
    p = vec3(cos(ang) * r, uWater + y * 2.8, sin(ang) * r * 0.85);
    size = on * (1.0 + aS.z * 2.2) * (1.0 + uLevel);
    a = on * sin(y * 3.14159) * (0.3 + 0.7 * fract(aS.y * 13.1 + t * 0.3));
  } else {
    p = aS.xyz; size = 2.0 + aS.w * 0.0; a = 1.0;
  }
  gl_Position = uProj * uView * vec4(p, 1.0);
  gl_PointSize = size * (uProj[1][1] * 2.2) / gl_Position.w * 1.4;
  vA = a; vK = aS.w;
}`;
  const PART_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec3 uGlowCol;
uniform float uSparkA;
varying float vA; varying float vK;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d) * vA;
  gl_FragColor = vec4(uGlowCol * a, 1.0);
}`;
  const SPARK_VS = `
precision highp float;
attribute vec4 aK;           // x y z life
uniform mat4 uProj, uView;
varying float vL;
void main() {
  gl_Position = uProj * uView * vec4(aK.xyz, 1.0);
  gl_PointSize = (1.5 + aK.w * 4.0) * (uProj[1][1] * 2.2) / gl_Position.w * 1.4 * step(0.001, aK.w);
  vL = aK.w;
}`;
  const SPARK_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec3 uGlowCol;
varying float vL;
void main() { float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(mix(uGlowCol, vec3(1.0), 0.5) * smoothstep(0.5, 0.0, d) * vL, 1.0); }`;

  const POST_VS = `
attribute vec2 aQ; varying vec2 vUV;
void main() { vUV = aQ * 0.5 + 0.5; gl_Position = vec4(aQ, 0.0, 1.0); }`;
  const TRAIL_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uScene, uPrev; uniform float uDecay; uniform vec2 uDrift;
varying vec2 vUV;
void main() {
  vec3 s = texture2D(uScene, vUV).rgb;
  vec3 p = texture2D(uPrev, (vUV - 0.5) * 0.997 + 0.5 + uDrift).rgb * uDecay;
  gl_FragColor = vec4(max(s, p), 1.0);
}`;
  const DOWN_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uImg; uniform vec2 uTex;
varying vec2 vUV;
void main() {
  vec3 c = texture2D(uImg, vUV + uTex * vec2(-1.0, -1.0)).rgb + texture2D(uImg, vUV + uTex * vec2(1.0, -1.0)).rgb
         + texture2D(uImg, vUV + uTex * vec2(-1.0, 1.0)).rgb + texture2D(uImg, vUV + uTex * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  gl_FragColor = vec4(max(c - 0.2, 0.0) * 1.2, 1.0);
}`;
  const BLUR_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uImg; uniform vec2 uDir;
varying vec2 vUV;
void main() {
  vec3 c = texture2D(uImg, vUV).rgb * 0.227;
  c += (texture2D(uImg, vUV + uDir * 1.385).rgb + texture2D(uImg, vUV - uDir * 1.385).rgb) * 0.316;
  c += (texture2D(uImg, vUV + uDir * 3.231).rgb + texture2D(uImg, vUV - uDir * 3.231).rgb) * 0.07;
  gl_FragColor = vec4(c, 1.0);
}`;
  const COMP_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uImg, uBloom;
uniform vec2 uRes;
uniform float uTime, uGlitch, uSeed, uPix, uAber, uBloomK, uDesat, uFlash, uGate;
uniform vec3 uBgTop, uBgBot, uGlow;
varying vec2 vUV;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 uv = vUV;
  if (uGlitch > 0.001) {
    float band = floor(uv.y * 26.0);
    float h = hash(vec2(band, uSeed));
    uv.x += step(1.0 - uGlitch * 0.55, h) * (hash(vec2(band + 7.0, uSeed)) - 0.5) * 0.18 * uGlitch;
    vec2 blk = floor(uv * vec2(12.0, 9.0));
    if (hash(blk + uSeed * 3.1) > 1.0 - uGlitch * 0.2) uv = (blk + vec2(hash(blk + 1.3), hash(blk + 2.7))) / vec2(12.0, 9.0);
  }
  if (uPix > 1.01) { vec2 px = uRes / uPix; uv = (floor(uv * px) + 0.5) / px; }
  vec2 d = uv - 0.5;
  float ca = uAber + uGlitch * 0.014;
  vec3 col = vec3(texture2D(uImg, uv + d * ca).r, texture2D(uImg, uv).g, texture2D(uImg, uv - d * ca).b);
  vec3 bl = texture2D(uBloom, uv).rgb;
  vec2 q = vUV - 0.5;
  vec3 bg = mix(uBgBot, uBgTop, smoothstep(0.0, 1.0, vUV.y));
  bg += uGlow * exp(-dot(q * vec2(1.3, 1.7), q * vec2(1.3, 1.7)) * 4.0) * 0.16;
  vec2 rp = vUV - vec2(0.18, 1.2);
  float ang = atan(rp.y, rp.x);
  float rays = pow(max(0.0, sin(ang * 21.0 + uTime * 0.12) * sin(ang * 8.0 - uTime * 0.05)), 5.0) * smoothstep(1.5, 0.2, length(rp));
  bg += mix(uGlow, vec3(1.0, 0.95, 0.85), 0.5) * rays * 0.05;
  vec2 gp = fract(vUV * uRes / (uRes.y / 26.0)) - 0.5;
  bg += uGlow * smoothstep(0.09, 0.0, length(gp)) * 0.03;
  vec3 c = bg + col + bl * uBloomK;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, vec3(l) * vec3(0.9, 1.0, 1.05), uDesat);
  c *= 0.965 + 0.035 * sin(vUV.y * uRes.y * 1.6);
  c += (hash(vUV * uRes + fract(uTime) * 91.0) - 0.5) * 0.022;
  c *= 1.0 - dot(q, q) * 0.55;
  c += uFlash * uGlow * 0.12;
  gl_FragColor = vec4(c * uGate, 1.0);
}`;

  /* ── math ── */
  function persp(fovy, aspect, near, far, shift) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, -shift, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  function look(e, c) {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = zz, xz = -zx; l = Math.hypot(xx, xz); xx /= l; xz /= l;
    const yx = zy * xz, yy = zz * xx - zx * xz, yz = -zy * xx;
    return new Float32Array([xx, yx, zx, 0, 0, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e[0] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
  }
  const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
  const PAL = {
    dawn:   { tint: '#bff7e6', accent: '#ffd8c4', core: '#fff1c9', glow: '#7fe8d2', top: '#0a2026', bot: '#110f22' },
    bloom:  { tint: '#ffc9e6', accent: '#cdb9ff', core: '#fff0f6', glow: '#ff9ccf', top: '#0d1529', bot: '#1c0f29' },
    canopy: { tint: '#a5f6ff', accent: '#d8ffa0', core: '#f4ffd6', glow: '#62e6ff', top: '#04161e', bot: '#0d0b26' },
    glitch: { tint: '#ff86dc', accent: '#6bfff0', core: '#ffffff', glow: '#d65cff', top: '#16061d', bot: '#03121a' },
    petal:  { tint: '#ffe3ad', accent: '#ffbccb', core: '#fff3d6', glow: '#ffb57a', top: '#16101a', bot: '#0b1522' },
  };

  /* ── geometry ── */
  function flowerMesh() {
    const verts = [], tris = [], lines = [];
    const grid = (UN, VN, z, w, lineEvery) => {
      const base = verts.length / 4;
      for (let i = 0; i <= UN; i++) for (let j = 0; j <= VN; j++) verts.push(i / UN, j / VN, z, w);
      for (let i = 0; i < UN; i++) for (let j = 0; j < VN; j++) {
        const a = base + i * (VN + 1) + j, b = a + VN + 1;
        tris.push(a, b, a + 1, a + 1, b, b + 1);
        if (j % lineEvery === 0) lines.push(a, b);
        if (i % 2 === 0) lines.push(a, a + 1);
      }
      for (let i = 0; i < UN; i++) { const a = base + i * (VN + 1) + VN; lines.push(a, a + VN + 1); }
    };
    for (let layer = 0; layer < 3; layer++) for (let p = 0; p < 12; p++) grid(12, 6, p, layer, 2);
    grid(10, 6, 0, 3, 3); grid(10, 6, 1, 3, 3);
    grid(14, 6, 0, 4, 3);
    grid(8, 10, 0, 5, 2);
    return { verts: new Float32Array(verts), tris: new Uint16Array(tris), lines: new Uint16Array(lines) };
  }
  function crystalMesh(count) {
    const face = [], edge = [];
    const ring = (y, r) => Array.from({ length: 6 }, (_, k) => [Math.cos(k / 6 * Math.PI * 2) * r, y, Math.sin(k / 6 * Math.PI * 2) * r]);
    const bot = ring(0, 1), top = ring(1, 1), tip = [0, 1.55, 0];
    const tri = (a, b, c, id) => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      for (const p of [a, b, c]) face.push(p[0], p[1], p[2], id, nx, ny, nz);
    };
    const seg = (a, b, id) => { edge.push(a[0], a[1], a[2], id, 0, 1, 0, b[0], b[1], b[2], id, 0, 1, 0); };
    for (let id = 0; id < count; id++) {
      for (let k = 0; k < 6; k++) {
        const k2 = (k + 1) % 6;
        tri(bot[k], bot[k2], top[k2], id); tri(bot[k], top[k2], top[k], id); tri(top[k], top[k2], tip, id);
        seg(bot[k], top[k], id); seg(top[k], top[k2], id); seg(top[k], tip, id);
      }
    }
    return { face: new Float32Array(face), edge: new Float32Array(edge) };
  }
  function flyMesh() {
    const v = [];
    for (let id = 0; id < 3; id++) for (const side of [-1, 1]) {
      const q = [[0, -1], [1, -1], [0, 1], [1, -1], [1, 1], [0, 1]];
      for (const [x, y] of q) v.push(x, y, side, id);
    }
    return new Float32Array(v);
  }

  function create(canvas, options = {}) {
    const maxPixels = options.maxPixels || Infinity;
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) return null;
    const compile = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const program = (vs, fs) => {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
      const u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace('[0]', '')] = gl.getUniformLocation(p, info.name); }
      const a = {};
      const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
      for (let i = 0; i < na; i++) { const info = gl.getActiveAttrib(p, i); a[info.name] = gl.getAttribLocation(p, info.name); }
      return { p, u, a };
    };
    const P = {
      flower: program(FLOWER_VS, FLOWER_FS), crystal: program(CRYSTAL_VS, CRYSTAL_FS), water: program(WATER_VS, WATER_FS),
      fly: program(FLY_VS, FLY_FS), part: program(PART_VS, PART_FS), spark: program(SPARK_VS, SPARK_FS),
      trail: program(POST_VS, TRAIL_FS), down: program(POST_VS, DOWN_FS), blur: program(POST_VS, BLUR_FS), comp: program(POST_VS, COMP_FS),
    };
    const buf = (data, target = gl.ARRAY_BUFFER, usage = gl.STATIC_DRAW) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, usage); return b; };
    const fm = flowerMesh();
    const B = {
      fv: buf(fm.verts), ft: buf(fm.tris, gl.ELEMENT_ARRAY_BUFFER), fl: buf(fm.lines, gl.ELEMENT_ARRAY_BUFFER),
      quad: buf(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])),
    };
    const NC = 13;
    const cm = crystalMesh(NC);
    B.cf = buf(cm.face); B.ce = buf(cm.edge);
    B.fly = buf(flyMesh());
    const NM = 260;
    const motes = new Float32Array(NM * 4);
    for (let i = 0; i < NM; i++) { motes[i * 4] = (i + 0.5) / NM; motes[i * 4 + 1] = Math.random(); motes[i * 4 + 2] = Math.random(); motes[i * 4 + 3] = 0; }
    B.motes = buf(motes);
    const NS = 64;
    const sparks = new Float32Array(NS * 4), sparkVel = new Float32Array(NS * 3);
    B.sparks = buf(sparks, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    let sparkHead = 0, sparksAlive = 0;

    // crystal layout
    const crystals = [];
    for (let i = 0; i < NC; i++) {
      const floating = i >= 9;
      const a = i * 2.4 + 0.3, r = floating ? 0.9 + (i - 9) * 0.12 : 0.22 + (i % 3) * 0.17 + Math.random() * 0.12;
      crystals.push({ a, r, floating, s: floating ? 0.05 + Math.random() * 0.03 : 0.045 + Math.random() * 0.06, h: floating ? 1.1 : 1.6 + Math.random() * 2.2, tilt: (Math.random() - 0.5) * 0.9, spin: Math.random() * 6, grow: 0 });
    }
    const uCP = new Float32Array(NC * 4), uCR = new Float32Array(NC * 4);

    /* ── render targets ── */
    const target = (w, h) => {
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fb, w, h };
    };
    let T = null;
    const freeTargets = () => { if (!T) return; for (const k in T) { gl.deleteTexture(T[k].tex); gl.deleteFramebuffer(T[k].fb); } T = null; };

    /* ── state ── */
    const target0 = { count: 6, open: 0.9, len: 0.62, droop: 0.25, sway: 0.3, root: 0.3, layer3: 0.6, iri: 0.6, alpha: 1, wire: 0.5,
      dissolve: 0.1, decay: 0.7, bloomK: 1.1, grow: 0.6, motes: 0.4, notch: 0.6, round: 0.3, fly: 1, spin: 0.08, hue: 0, aber: 0.002, pix: 1 };
    const cur = Object.assign({}, target0), tgt = Object.assign({}, target0);
    const col = {}, colT = {};
    for (const k of ['tint', 'accent', 'core', 'glow', 'top', 'bot']) { col[k] = hex(PAL.dawn[k]); colT[k] = col[k].slice(); }
    const hits = new Float32Array(12);
    const ripples = new Float32Array(8 * 4); let ripHead = 0;
    for (let i = 0; i < 8; i++) ripples[i * 4 + 2] = -10;
    let pulse = 0, bassGlow = 0, padGlow = 0, voxLvl = 0, level = 0, levelT = 0, wireFlash = 0, flash = 0;
    let glitch = 0, glitchUntil = 0, glitchSeed = 0, seedAt = 0, gate = 1, gateKind = -1, gateSlice = 0.1;
    let tA = 0, speed = 1, speedMode = 0, speedUntil = 0, speedDur = 1, stutStart = 0, stutSlice = 0, stutUntil = 0, desat = 0;
    let frozen = 0, frozenT = 0, crushUntil = 0, camBump = 0, spinPhase = 0;
    let scale = 1, maxScale = Math.min(1.2, window.devicePixelRatio || 1), W = 1, H = 1;
    let frames = 0, accDt = 0, lastT = 0, lost = false, fps = 0, ping = 0;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });

    function resize() {
      const r = canvas.getBoundingClientRect();
      W = Math.max(1, r.width); H = Math.max(1, r.height);
      scale = Math.min(scale, Math.sqrt(maxPixels / (W * H)));
      canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
      freeTargets();
      const w = canvas.width, h = canvas.height, bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
      T = { scene: target(w, h), trA: target(w, h), trB: target(w, h), blA: target(bw, bh), blB: target(bw, bh) };
    }
    function adapt(dt) {
      frames++; accDt += dt;
      if (frames >= 40) {
        const avg = accDt / frames; frames = 0; accDt = 0; fps = 1000 / avg;
        if (avg > 19 && scale > 0.6) { scale = Math.max(0.6, scale - 0.15); resize(); }
        else if (avg < 17.2 && scale < Math.min(maxScale, Math.sqrt(maxPixels / (W * H)))) { scale = Math.min(maxScale, scale + 0.1); resize(); }
      }
    }

    /* ── events from the engine ── */
    function spark(x, y, z, n, spread) {
      for (let k = 0; k < n; k++) {
        const i = sparkHead; sparkHead = (sparkHead + 1) % NS;
        sparks[i * 4] = x; sparks[i * 4 + 1] = y; sparks[i * 4 + 2] = z; sparks[i * 4 + 3] = 1;
        sparkVel[i * 3] = (Math.random() - 0.5) * spread; sparkVel[i * 3 + 1] = Math.random() * spread * 0.9 + 0.1; sparkVel[i * 3 + 2] = (Math.random() - 0.5) * spread;
      }
      sparksAlive = 1;
    }
    function ripple(x, z, amp, now) {
      const i = ripHead; ripHead = (ripHead + 1) % 8;
      ripples[i * 4] = x; ripples[i * 4 + 1] = z; ripples[i * 4 + 2] = now; ripples[i * 4 + 3] = amp;
    }
    const WATER = -1.45;
    function note(m, now) {
      if (m.l === 'k' || m.l === 'c') {
        const n = Math.max(1, Math.round(cur.count)), i = ((m.m | 0) % n + n) % n;
        hits[i] = Math.min(1.3, hits[i] + m.v * 0.9);
        const ang = (i / n) * Math.PI * 2 + spinPhase, rr = cur.len * 0.55;
        if (m.l === 'c' || Math.random() < 0.5) spark(0.06 + Math.sin(ang) * rr, 0.25 + cur.open * 0.15, Math.cos(ang) * rr, m.l === 'c' ? 2 : 4, 0.5);
        pulse = Math.min(1.2, pulse + m.v * 0.25);
      } else if (m.l === 'v') { voxLvl = Math.min(1, voxLvl + 0.5); pulse = Math.min(1.2, pulse + 0.35); }
      else if (m.l === 'p') { padGlow = 1; }
      else if (m.l === 'b') { bassGlow = Math.min(1, bassGlow + m.v); }
      else if (m.l === 'd') {
        if (m.k === 0 || m.k === 5) { ripple(0.06, 0.03, 0.9 * m.v, now); camBump = 1; }
        else wireFlash = 1;
      } else if (m.l === 'f') {
        if (m.k === 10) { const a = Math.random() * 6.28, r = 0.3 + Math.random() * 1.6; ripple(Math.cos(a) * r, Math.sin(a) * r, 0.6, now); spark(Math.cos(a) * r, WATER + 0.02, Math.sin(a) * r, 2, 0.25); }
        else if (m.k === 11 || m.k === 16 || m.k === 17) padGlow = Math.max(padGlow, 0.7);
        else if (m.k === 18) flash = 0.4;
      }
    }
    function glitchEv(m, now) {
      const d = Math.max(0.05, m.d || 0.2);
      glitch = Math.max(glitch, m.k === 3 ? 0.35 : 0.75); glitchUntil = now + d;
      if (m.k === 0 || m.k === 4) { stutStart = tA; stutSlice = Math.max(0.03, m.s || 0.1); stutUntil = now + d; if (m.k === 4) { gateKind = 4; gateSlice = stutSlice * 0.5; } }
      else if (m.k === 1) { speedMode = 1; speedUntil = now + d; speedDur = d; }
      else if (m.k === 2) { speedMode = 2; speedUntil = now + d; speedDur = d; }
      else if (m.k === 3) crushUntil = now + d;
    }
    function event(m) {
      const now = performance.now() / 1000;
      if (m.type === 'n') note(m, now);
      else if (m.type === 'g') glitchEv(m, now);
      else if (m.type === 'z') { frozen = m.on ? 1 : 0; if (m.on) frozenT = now + (m.d || 2); }
      else if (m.type === 's') { const p = PAL[m.name] || PAL.dawn; for (const k in colT) colT[k] = hex(p[k]); flash = 0.7; }
    }
    function setParams(p) { Object.assign(tgt, p); }
    function setLevel(x) { levelT = x; }

    /* ── frame ── */
    function bindQuad(prog) { gl.bindBuffer(gl.ARRAY_BUFFER, B.quad); gl.enableVertexAttribArray(prog.a.aQ); gl.vertexAttribPointer(prog.a.aQ, 2, gl.FLOAT, false, 0, 0); }
    function frame(tms) {
      if (lost || !T) return;
      const dt = lastT ? Math.min(100, tms - lastT) : 16; lastT = tms;
      adapt(dt);
      const now = tms / 1000, sec = dt / 1000;
      const k = 1 - Math.exp(-dt / 160);
      for (const key in tgt) cur[key] += (tgt[key] - cur[key]) * k;
      for (const key in col) for (let i = 0; i < 3; i++) col[key][i] += (colT[key][i] - col[key][i]) * k * 0.5;
      const dec = Math.exp(-dt / 300);
      for (let i = 0; i < 12; i++) hits[i] *= dec;
      pulse *= Math.exp(-dt / 250); bassGlow *= Math.exp(-dt / 350); padGlow *= Math.exp(-dt / 900); voxLvl *= Math.exp(-dt / 500);
      wireFlash *= Math.exp(-dt / 120); flash *= Math.exp(-dt / 350); camBump *= Math.exp(-dt / 140);
      level += (levelT - level) * (1 - Math.exp(-dt / 90));
      if (frozen && now > frozenT + 0.5) frozen = 0;

      // animation clock: stutter loops, tape stop slows, reverse rewinds
      if (speedMode && now > speedUntil) { speedMode = 0; }
      const sp = speedMode === 1 ? Math.max(0, 1 - (1 - (speedUntil - now) / speedDur) * 1.15) : speedMode === 2 ? -1 : 1;
      speed += (sp - speed) * 0.35;
      desat += ((speedMode === 1 ? 0.75 : 0) - desat) * 0.15;
      tA += sec * speed * (1 - frozen * 0.85);
      if (now < stutUntil) { if (tA - stutStart > stutSlice) tA = stutStart; } else gateKind = -1;
      if (now < glitchUntil) { if (now - seedAt > 0.045) { glitchSeed = Math.random() * 100; seedAt = now; } }
      else glitch *= Math.exp(-dt / 90);
      gate = gateKind === 4 && now < stutUntil ? ((((now * 1000) / (gateSlice * 1000)) | 0) % 2 ? 0.35 : 1) : 1;
      spinPhase += sec * speed * cur.spin;
      const tGlitch = Math.min(1, glitch + cur.wire * 0.0);

      // sparks
      if (sparksAlive) {
        let any = 0;
        for (let i = 0; i < NS; i++) {
          const L = sparks[i * 4 + 3]; if (L <= 0) continue; any = 1;
          sparkVel[i * 3 + 1] -= sec * 0.35;
          sparks[i * 4] += sparkVel[i * 3] * sec; sparks[i * 4 + 1] += sparkVel[i * 3 + 1] * sec; sparks[i * 4 + 2] += sparkVel[i * 3 + 2] * sec;
          sparks[i * 4 + 3] = Math.max(0, L - sec * 0.9);
        }
        sparksAlive = any;
        gl.bindBuffer(gl.ARRAY_BUFFER, B.sparks); gl.bufferSubData(gl.ARRAY_BUFFER, 0, sparks);
      }

      // crystals
      for (let i = 0; i < NC; i++) {
        const c = crystals[i];
        if (c.floating) {
          const a = c.a + tA * (0.12 + i * 0.01);
          uCP[i * 4] = Math.cos(a) * c.r; uCP[i * 4 + 1] = -0.2 + Math.sin(tA * 0.5 + i) * 0.25 + (i - 10) * 0.15; uCP[i * 4 + 2] = Math.sin(a) * c.r * 0.8;
          uCP[i * 4 + 3] = c.s * 0.7 * (0.6 + cur.grow * 0.35) * (1 + padGlow * 0.2);
          uCR[i * 4] = tA * 0.7 + i; uCR[i * 4 + 1] = 0.4; uCR[i * 4 + 2] = tA * 0.9 + i; uCR[i * 4 + 3] = c.h;
        } else {
          uCP[i * 4] = 0.06 + Math.cos(c.a) * c.r; uCP[i * 4 + 1] = WATER; uCP[i * 4 + 2] = 0.03 + Math.sin(c.a) * c.r;
          uCP[i * 4 + 3] = c.s * (0.4 + cur.grow * 0.45) * (1 + bassGlow * 0.12);
          uCR[i * 4] = Math.sin(c.a) * c.tilt; uCR[i * 4 + 1] = -Math.cos(c.a) * c.tilt; uCR[i * 4 + 2] = c.spin; uCR[i * 4 + 3] = c.h * (0.55 + cur.grow * 0.45);
        }
      }

      // camera
      const orbit = 0.4 + Math.sin(tA * 0.06) * 0.45;
      const eye = [Math.sin(orbit) * 3.7, 0.75 + Math.sin(tA * 0.13) * 0.12, Math.cos(orbit) * 3.7];
      const view = look(eye, [0.04, -0.32, 0]);
      const proj = persp(0.74 - camBump * 0.025, W / H, 0.1, 30, 0.2);
      const scanY = WATER + ((now * 0.32) % 1) * 2.6;

      /* scene → T.scene */
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.scene.fb);
      gl.viewport(0, 0, T.scene.w, T.scene.h);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);

      // water
      let pr = P.water; gl.useProgram(pr.p);
      gl.uniformMatrix4fv(pr.u.uProj, false, proj); gl.uniformMatrix4fv(pr.u.uView, false, view);
      gl.uniform1f(pr.u.uWater, WATER); gl.uniform4fv(pr.u.uRip, ripples); gl.uniform1f(pr.u.uTime, now);
      gl.uniform1f(pr.u.uBass, bassGlow); gl.uniform1f(pr.u.uGrid, 0.6 + cur.wire * 0.6);
      gl.uniform3fv(pr.u.uTint, col.tint); gl.uniform3fv(pr.u.uAccent, col.accent);
      bindQuad(pr); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // flower (mirror first, then real)
      pr = P.flower; gl.useProgram(pr.p);
      const U = pr.u;
      gl.uniformMatrix4fv(U.uProj, false, proj); gl.uniformMatrix4fv(U.uView, false, view);
      gl.uniform1f(U.uTime, tA); gl.uniform1f(U.uCount, Math.round(cur.count)); gl.uniform1f(U.uOpen, cur.open);
      gl.uniform1f(U.uLen, cur.len); gl.uniform1f(U.uDroop, cur.droop); gl.uniform1f(U.uSway, cur.sway); gl.uniform1f(U.uSpin, spinPhase);
      gl.uniform1f(U.uRoot, cur.root + bassGlow * 0.4); gl.uniform1f(U.uLayer3, cur.layer3); gl.uniform1f(U.uPulse, pulse);
      gl.uniform1f(U.uWater, WATER); gl.uniform1f(U.uDissolve, cur.dissolve + frozen * 0.15); gl.uniform1f(U.uJitter, glitch * 0.8);
      gl.uniform1f(U.uNotch, cur.notch); gl.uniform1f(U.uRound, cur.round);
      gl.uniform1fv(U.uHit, hits);
      gl.uniform3fv(U.uEye, eye); gl.uniform3fv(U.uTint, col.tint); gl.uniform3fv(U.uAccent, col.accent); gl.uniform3fv(U.uCore, col.core);
      gl.uniform1f(U.uIri, cur.iri); gl.uniform1f(U.uHue, cur.hue); gl.uniform1f(U.uScanY, scanY);
      gl.uniform1f(U.uWire, cur.wire + wireFlash * 0.6);
      gl.bindBuffer(gl.ARRAY_BUFFER, B.fv);
      gl.enableVertexAttribArray(pr.a.aP); gl.vertexAttribPointer(pr.a.aP, 4, gl.FLOAT, false, 0, 0);
      const drawFlower = (mirror) => {
        gl.uniform1f(U.uMirror, mirror);
        gl.uniform1f(U.uPointMode, 0);
        gl.uniform1f(U.uMode, 0); gl.uniform1f(U.uAlpha, cur.alpha * (1 + pulse * 0.25));
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, B.ft); gl.drawElements(gl.TRIANGLES, fm.tris.length, gl.UNSIGNED_SHORT, 0);
        gl.uniform1f(U.uMode, 1);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, B.fl); gl.drawElements(gl.LINES, fm.lines.length, gl.UNSIGNED_SHORT, 0);
        if (!mirror) { gl.uniform1f(U.uMode, 2); gl.uniform1f(U.uPointMode, 1); gl.uniform1f(U.uAlpha, 0.55 + cur.dissolve * 0.8); gl.drawArrays(gl.POINTS, 0, fm.verts.length / 4); }
      };
      drawFlower(1); drawFlower(0);
      gl.disableVertexAttribArray(pr.a.aP);

      // crystals
      pr = P.crystal; gl.useProgram(pr.p);
      gl.uniformMatrix4fv(pr.u.uProj, false, proj); gl.uniformMatrix4fv(pr.u.uView, false, view);
      gl.uniform4fv(pr.u.uCP, uCP); gl.uniform4fv(pr.u.uCR, uCR); gl.uniform1f(pr.u.uWater, WATER);
      gl.uniform3fv(pr.u.uEye, eye); gl.uniform3fv(pr.u.uTint, col.tint); gl.uniform3fv(pr.u.uAccent, col.accent);
      gl.uniform1f(pr.u.uTime, tA); gl.uniform1f(pr.u.uHue, cur.hue); gl.uniform1f(pr.u.uGlow, padGlow);
      const drawCrystals = (mirror) => {
        gl.uniform1f(pr.u.uMirror, mirror);
        gl.bindBuffer(gl.ARRAY_BUFFER, B.cf);
        gl.enableVertexAttribArray(pr.a.aC); gl.vertexAttribPointer(pr.a.aC, 4, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(pr.a.aN); gl.vertexAttribPointer(pr.a.aN, 3, gl.FLOAT, false, 28, 16);
        gl.uniform1f(pr.u.uMode, 0); gl.uniform1f(pr.u.uAlpha, 0.9);
        gl.drawArrays(gl.TRIANGLES, 0, cm.face.length / 7);
        gl.bindBuffer(gl.ARRAY_BUFFER, B.ce);
        gl.vertexAttribPointer(pr.a.aC, 4, gl.FLOAT, false, 28, 0); gl.vertexAttribPointer(pr.a.aN, 3, gl.FLOAT, false, 28, 16);
        gl.uniform1f(pr.u.uMode, 1); gl.uniform1f(pr.u.uAlpha, 0.5 + padGlow * 0.5);
        gl.drawArrays(gl.LINES, 0, cm.edge.length / 7);
      };
      drawCrystals(1); drawCrystals(0);
      gl.disableVertexAttribArray(pr.a.aC); gl.disableVertexAttribArray(pr.a.aN);

      // butterflies
      if (cur.fly > 0.02) {
        pr = P.fly; gl.useProgram(pr.p);
        gl.uniformMatrix4fv(pr.u.uProj, false, proj); gl.uniformMatrix4fv(pr.u.uView, false, view);
        gl.uniform1f(pr.u.uTime, tA); gl.uniform1f(pr.u.uVox, voxLvl); gl.uniform1f(pr.u.uJitter, glitch); gl.uniform1f(pr.u.uFlyOn, 1);
        gl.uniform1f(pr.u.uHue, cur.hue); gl.uniform1f(pr.u.uAlpha, cur.fly * (0.7 + voxLvl * 0.6)); gl.uniform3fv(pr.u.uAccent, col.accent);
        gl.bindBuffer(gl.ARRAY_BUFFER, B.fly);
        gl.enableVertexAttribArray(pr.a.aF); gl.vertexAttribPointer(pr.a.aF, 4, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 36);
        gl.disableVertexAttribArray(pr.a.aF);
      }

      // motes
      pr = P.part; gl.useProgram(pr.p);
      gl.uniformMatrix4fv(pr.u.uProj, false, proj); gl.uniformMatrix4fv(pr.u.uView, false, view);
      gl.uniform1f(pr.u.uTime, tA); gl.uniform1f(pr.u.uMotes, cur.motes); gl.uniform1f(pr.u.uLevel, Math.min(1, level * 3));
      gl.uniform1f(pr.u.uWater, WATER); gl.uniform1f(pr.u.uFreeze, frozen);
      gl.uniform3fv(pr.u.uGlowCol, [col.core[0] * 0.7 + 0.2, col.core[1] * 0.7 + 0.2, col.core[2] * 0.7 + 0.2]);
      gl.bindBuffer(gl.ARRAY_BUFFER, B.motes);
      gl.enableVertexAttribArray(pr.a.aS); gl.vertexAttribPointer(pr.a.aS, 4, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, NM);
      gl.disableVertexAttribArray(pr.a.aS);

      // sparks
      if (sparksAlive) {
        pr = P.spark; gl.useProgram(pr.p);
        gl.uniformMatrix4fv(pr.u.uProj, false, proj); gl.uniformMatrix4fv(pr.u.uView, false, view);
        gl.uniform3fv(pr.u.uGlowCol, col.accent);
        gl.bindBuffer(gl.ARRAY_BUFFER, B.sparks);
        gl.enableVertexAttribArray(pr.a.aK); gl.vertexAttribPointer(pr.a.aK, 4, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.POINTS, 0, NS);
        gl.disableVertexAttribArray(pr.a.aK);
      }
      gl.disable(gl.BLEND);

      /* feedback trails */
      ping ^= 1;
      const trOut = ping ? T.trB : T.trA, trIn = ping ? T.trA : T.trB;
      gl.bindFramebuffer(gl.FRAMEBUFFER, trOut.fb); gl.viewport(0, 0, trOut.w, trOut.h);
      pr = P.trail; gl.useProgram(pr.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.scene.tex); gl.uniform1i(pr.u.uScene, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, trIn.tex); gl.uniform1i(pr.u.uPrev, 1);
      gl.uniform1f(pr.u.uDecay, Math.min(0.97, cur.decay + frozen * 0.2));
      gl.uniform2f(pr.u.uDrift, 0, -0.0012 - frozen * 0.001);
      bindQuad(pr); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      /* bloom */
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.blA.fb); gl.viewport(0, 0, T.blA.w, T.blA.h);
      pr = P.down; gl.useProgram(pr.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, trOut.tex); gl.uniform1i(pr.u.uImg, 0);
      gl.uniform2f(pr.u.uTex, 1 / trOut.w, 1 / trOut.h);
      bindQuad(pr); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      pr = P.blur; gl.useProgram(pr.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.blB.fb);
      gl.bindTexture(gl.TEXTURE_2D, T.blA.tex); gl.uniform1i(pr.u.uImg, 0); gl.uniform2f(pr.u.uDir, 1 / T.blA.w, 0);
      bindQuad(pr); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.blA.fb);
      gl.bindTexture(gl.TEXTURE_2D, T.blB.tex); gl.uniform2f(pr.u.uDir, 0, 1 / T.blA.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      /* composite */
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
      pr = P.comp; gl.useProgram(pr.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, trOut.tex); gl.uniform1i(pr.u.uImg, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.blA.tex); gl.uniform1i(pr.u.uBloom, 1);
      gl.uniform2f(pr.u.uRes, canvas.width, canvas.height);
      gl.uniform1f(pr.u.uTime, now); gl.uniform1f(pr.u.uGlitch, tGlitch); gl.uniform1f(pr.u.uSeed, glitchSeed);
      const pixV = now < crushUntil ? 5 : cur.pix;
      gl.uniform1f(pr.u.uPix, pixV > 1.05 ? pixV * scale : 1);
      gl.uniform1f(pr.u.uAber, cur.aber); gl.uniform1f(pr.u.uBloomK, cur.bloomK * (1 + level * 0.6));
      gl.uniform1f(pr.u.uDesat, desat); gl.uniform1f(pr.u.uFlash, flash); gl.uniform1f(pr.u.uGate, gate);
      gl.uniform3fv(pr.u.uBgTop, col.top); gl.uniform3fv(pr.u.uBgBot, col.bot); gl.uniform3fv(pr.u.uGlow, col.glow);
      bindQuad(pr); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.activeTexture(gl.TEXTURE0);
    }

    resize();
    return { frame, resize, setParams, setLevel, event, get fps() { return fps; }, get scale() { return scale; } };
  }

  window.BotanicaViz = { create };
})();
