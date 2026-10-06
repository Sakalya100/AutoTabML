/**
 * GLSL for the survey world. Rules learned on the reef: no pow() on values that can be negative (NaN on some GPUs),
 * every division guarded, outputs in linear HDR (the composer tone-maps with AgX at the end).
 */

export const NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm3(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.3;
    a *= 0.5;
  }
  return s * 1.14;
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.3;
    a *= 0.5;
  }
  return s;
}
`;

/** Shared heightfield sampling: two RG half-float textures (previous / current probe set) blended by uMix. */
export const FIELD = /* glsl */ `
uniform sampler2D uFieldA;
uniform sampler2D uFieldB;
uniform float uMix;
uniform vec4 uWin; // minX, minZ, size, res
vec2 fieldUV(vec2 xz) {
  vec2 t = clamp((xz - uWin.xy) / uWin.z, 0.0, 1.0);
  return (t * (uWin.w - 1.0) + 0.5) / uWin.w;
}
vec2 fieldAt(vec2 xz) {
  vec2 uv = fieldUV(xz);
  return mix(texture2D(uFieldA, uv).rg, texture2D(uFieldB, uv).rg, uMix);
}
`;

export const terrainVert = /* glsl */ `
${FIELD}
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vMask;
void main() {
  vec2 xz = uWin.xy + position.xz * uWin.z;
  vec2 f = fieldAt(xz);
  float e = uWin.z / max(uWin.w - 1.0, 1.0);
  float hx = fieldAt(xz + vec2(e, 0.0)).x - fieldAt(xz - vec2(e, 0.0)).x;
  float hz = fieldAt(xz + vec2(0.0, e)).x - fieldAt(xz - vec2(0.0, e)).x;
  vNormalW = normalize(vec3(-hx, 2.0 * e, -hz));
  vMask = f.y;
  // Unrevealed ground settles a little lower, so the survey edge reads as a lip of uncovered land.
  float h = f.x - (1.0 - smoothstep(0.0, 0.5, f.y)) * 0.35;
  vWorld = vec3(xz.x, h, xz.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

export const terrainFrag = /* glsl */ `
${NOISE}
uniform float uTime;
uniform vec3 uLightDir;
uniform vec3 uMoon;
uniform vec3 uBasaltLo;
uniform vec3 uBasaltHi;
uniform vec3 uContour;
uniform vec3 uSignal;
uniform vec3 uVoid;
uniform vec3 uContourSpec; // base height, step, opacity scale
uniform vec4 uSonar;       // x, z, t0, speed
uniform vec3 uPointer;     // x, z, charge
uniform vec4 uLand;        // x, z, t0, strength
uniform vec4 uBead;        // x, y, z, radius
uniform float uFog;
uniform float uReveal;     // global intro reveal 0..1
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vMask;

float ring(float d, float r, float w) { float x = (d - r) / w; return exp(-x * x); }

void main() {
  if (vMask < 0.004) discard;
  vec3 n = normalize(vNormalW);
  vec3 P = vWorld;

  // Rough basalt: triplanar grain at two scales (abs() before powers: never pow a negative).
  vec3 an = abs(n);
  vec3 w = an * an * an * an;
  w /= max(w.x + w.y + w.z, 1e-4);
  float g1 = vnoise(P.yz * 7.0) * w.x + vnoise(P.xz * 7.0) * w.y + vnoise(P.xy * 7.0) * w.z;
  float g2 = vnoise(P.yz * 31.0) * w.x + vnoise(P.xz * 31.0) * w.y + vnoise(P.xy * 31.0) * w.z;
  float g3 = vnoise(P.yz * 97.0) * w.x + vnoise(P.xz * 97.0) * w.y + vnoise(P.xy * 97.0) * w.z;
  float strata = vnoise(vec2(P.y * 14.0, (P.x + P.z) * 0.8));
  float grain = g1 * 0.32 + g2 * 0.3 + g3 * 0.23 + strata * 0.15;
  vec3 albedo = mix(uBasaltLo, uBasaltHi, clamp(grain * 1.3 - 0.18, 0.0, 1.0));
  albedo *= 0.85 + 0.3 * smoothstep(0.0, 6.0, P.y);

  // One raking cold moon, a faint sky fill, and a soft contact shadow under the mercury.
  vec3 L = normalize(uLightDir);
  float ndl = max(dot(n, L), 0.0);
  float wrap = max((dot(n, L) + 0.25) / 1.25, 0.0);
  vec3 V = normalize(cameraPosition - P);
  vec3 H = normalize(L + V);
  float nh = max(dot(n, H), 0.0);
  float spec = nh * nh;
  spec = spec * spec; spec = spec * spec; spec = spec * spec; // nh^16
  vec2 sh = P.xz - (uBead.xz - L.xz / max(L.y, 0.2) * uBead.w * 0.6);
  float shadow = 1.0 - 0.6 * exp(-dot(sh, sh) / max(uBead.w * uBead.w * 2.2, 1e-3)) * step(0.0, uBead.w);
  vec3 sky = mix(vec3(0.010, 0.012, 0.016), vec3(0.045, 0.06, 0.08), n.y * 0.5 + 0.5);
  vec3 col = albedo * (uMoon * (0.25 * wrap + 0.85 * ndl) * shadow + sky) + uMoon * spec * 0.05 * ndl;

  // Analytic isolines on real score values: major every 5th.
  float hc = (P.y - uContourSpec.x) / max(uContourSpec.y, 1e-4);
  float fw = max(fwidth(hc), 1e-4);
  float fr = fract(hc);
  float dl = min(fr, 1.0 - fr);
  float idx = floor(hc + 0.5);
  float major = 1.0 - step(0.5, abs(mod(idx, 5.0)));
  float line = 1.0 - smoothstep(0.0, fw * mix(0.85, 1.5, major), dl);
  line *= 1.0 - smoothstep(0.3, 0.7, fw); // grazing angles: fade instead of moiré
  float lineA = mix(0.055, 0.15, major) * uContourSpec.z;

  // Sonar: a ring front plus a lit wake behind it that fades over ~3 s.
  float age = uTime - uSonar.z;
  float alive = step(0.0, age) * (1.0 - smoothstep(2.2, 3.4, age));
  float r = age * uSonar.w;
  float dS = length(P.xz - uSonar.xy);
  float front = ring(dS, r, 0.28) * alive;
  float wake = (1.0 - smoothstep(r - 0.05, r, dS)) * exp(-max(r - dS, 0.0) * 0.28) * alive;
  // Charging: contours gather around the pointer before release.
  float dP = length(P.xz - uPointer.xy);
  float gather = uPointer.z * exp(-dP * dP / (0.4 + uPointer.z * 4.0));
  // A probe landing sends one soft ripple through the ground.
  float la = uTime - uLand.z;
  float landR = ring(length(P.xz - uLand.xy), la * 5.5, 0.35) * uLand.w * step(0.0, la) * (1.0 - smoothstep(0.4, 1.3, la));

  float boost = wake * 1.6 + front * 2.4 + gather * 2.2 + landR * 1.2;
  col += uContour * line * lineA * (1.0 + boost);
  col += uSignal * (front * 0.55 + landR * 0.25 + gather * 0.18) * (0.35 + line);

  // Survey edge: revealed ground fades into the void with a faint bone lip at the frontier.
  float m = smoothstep(0.02, 0.7, vMask) * uReveal;
  float fm = max(fwidth(vMask), 1e-4);
  float lip = (1.0 - smoothstep(0.0, fm * 1.1, abs(vMask - 0.16))) * 0.09;
  col = mix(uVoid, col, m) + uContour * lip * uReveal;

  float dist = length(cameraPosition - P);
  float fogF = 1.0 - exp(-dist * dist * uFog * uFog);
  col = mix(col, uVoid, clamp(fogF, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}
`;

export const mistVert = /* glsl */ `
${FIELD}
uniform float uY;
varying vec3 vWorld;
varying vec2 vF;
void main() {
  vec2 xz = uWin.xy + position.xz * uWin.z;
  vF = fieldAt(xz);
  vWorld = vec3(xz.x, uY, xz.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

export const mistFrag = /* glsl */ `
${NOISE}
uniform float uTime;
uniform float uHug;
uniform float uOpacity;
uniform vec3 uColor;
uniform float uSeed;
varying vec3 vWorld;
varying vec2 vF;
void main() {
  float d = vWorld.y - vF.x; // height of this sheet above the ground
  float hug = smoothstep(0.0, 0.05, d) * exp(-max(d, 0.0) / max(uHug, 1e-3));
  float pre = hug * smoothstep(0.05, 0.6, vF.y) * uOpacity;
  if (pre < 0.002) discard; // most of the sheet: skip the noise entirely
  vec2 p = vWorld.xz * 0.55 + vec2(uTime * 0.035, -uTime * 0.02) + uSeed;
  float n = fbm3(p + 0.8 * vnoise(p * 0.7 - uTime * 0.02));
  float a = pre * smoothstep(0.25, 0.75, n);
  float near = smoothstep(0.15, 1.6, length(cameraPosition - vWorld));
  a *= near;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * (0.7 + 0.6 * n), a);
}
`;

export const cloudVert = /* glsl */ `
uniform float uY;
uniform vec3 uCenter;
uniform float uSize;
varying vec3 vWorld;
void main() {
  vec2 xz = uCenter.xz + (position.xz - 0.5) * uSize;
  vWorld = vec3(xz.x, uY, xz.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

export const cloudFrag = /* glsl */ `
${NOISE}
uniform float uTime;
uniform float uOpacity;
uniform vec3 uColor;
uniform vec3 uCenter;
uniform float uSize;
uniform float uSeed;
uniform vec3 uLightDir;
varying vec3 vWorld;
void main() {
  float r0 = length(vWorld.xz - uCenter.xz) / (uSize * 0.5);
  if (uOpacity < 0.002 || r0 > 1.0) discard;
  vec2 p = vWorld.xz * 0.16 + uSeed;
  vec2 q = vec2(fbm3(p + uTime * 0.008), fbm3(p + 5.2 - uTime * 0.006));
  float n = fbm(p + 1.8 * q);
  float cover = smoothstep(0.47, 0.72, n);
  // fake top light from the density gradient, so the deck has relief under the moon
  float n2 = fbm3(p + 1.8 * q + normalize(uLightDir.xz) * 0.08) * 0.877 + 0.06;
  float lit = clamp(0.55 + (n2 - n) * 9.0, 0.2, 1.2);
  float r = length(vWorld.xz - uCenter.xz) / (uSize * 0.5);
  float edge = 1.0 - smoothstep(0.55, 1.0, r);
  float near = smoothstep(0.25, 2.8, length(cameraPosition - vWorld));
  float a = cover * edge * near * uOpacity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * lit, a);
}
`;

export const beamVert = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
varying float vH;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vH = uv.y;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const beamFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vW;
varying float vH;
void main() {
  vec3 V = normalize(cameraPosition - vW);
  float facing = abs(dot(normalize(vN), V));
  float core = facing * facing * facing;
  float fall = (1.0 - vH);
  float a = core * fall * fall * uOpacity;
  gl_FragColor = vec4(uColor * a * 2.4, a);
}
`;

/** Mercury wobble, injected into MeshPhysicalMaterial. */
export const WOBBLE_HEAD = /* glsl */ `
uniform float uTime;
uniform float uWobble;
`;
export const WOBBLE_BEGIN = /* glsl */ `
vec3 transformed = vec3(position);
float wob = sin(position.x * 6.0 + uTime * 2.3) * sin(position.y * 5.0 + uTime * 1.9) * sin(position.z * 7.0 - uTime * 2.6);
transformed += normal * wob * uWobble;
`;
