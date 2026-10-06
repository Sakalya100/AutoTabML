/**
 * GLSL for the reef. Every material is a ShaderMaterial on the shared `uTime` uniform, so the scene animates
 * without per-frame CPU work beyond a handful of uniform writes.
 */

export const NOISE = /* glsl */ `
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x), mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x), mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; }
  return s;
}
// Tileable water caustics (after Dave Hoskins / joltz0r).
float caustic(vec2 p, float t) {
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(abs(c), 1.4);
  return min(pow(abs(c), 8.0), 4.0);
}
`;

/** Exponential-squared depth fog toward the abyss, lifted toward teal near the light. */
export const FOG = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogDensity;
vec3 applyFog(vec3 col, float depth) {
  float f = 1.0 - exp(-uFogDensity * uFogDensity * depth * depth);
  return mix(col, uFogColor, clamp(f, 0.0, 1.0));
}
`;

export const OUT = /* glsl */ `
  #include <colorspace_fragment>
`;

// ---------------------------------------------------------------- branch

export const branchVert = /* glsl */ `
attribute vec3 aCenter;
uniform float uTime;
uniform float uGrow;
uniform float uSeed;
uniform float uSway;
varying float vT;
varying float vAround;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec3 vWorld;
void main() {
  vT = uv.x;
  vAround = uv.y;
  // Collapse everything past the growth front; the front itself tapers to a bud.
  float front = smoothstep(uGrow + 0.001, uGrow - 0.09, vT);
  vec3 p = aCenter + (position - aCenter) * front;
  // Gentle current: displacement grows toward the tip.
  float sway = uSway * vT * vT;
  p.x += sin(uTime * 0.55 + aCenter.y * 0.7 + uSeed * 6.28) * sway;
  p.z += cos(uTime * 0.43 + aCenter.y * 0.6 + uSeed * 4.1) * sway;
  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorld = world.xyz;
  vec4 mv = viewMatrix * world;
  vViewPos = mv.xyz;
  vNormalV = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}
`;

export const branchFrag = /* glsl */ `
uniform float uTime;
uniform float uGrow;
uniform float uSeed;
uniform vec3 uColor;
uniform vec3 uTipColor;
uniform float uGlow;
uniform float uDissolve;
uniform float uHighlight;
uniform float uDim;
uniform float uEmber;
uniform float uBleach;
varying float vT;
varying float vAround;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec3 vWorld;
${NOISE}
${FOG}
void main() {
  if (vT > uGrow) discard;
  float n = fbm(vWorld * 5.0 + uSeed * 13.0);
  float ember = 0.0;
  if (uDissolve > 0.0) {
    // Burn from the tip down: the threshold is higher toward the tip.
    float th = uDissolve * (0.55 + 0.75 * vT);
    float d = n - th;
    if (d < 0.0) discard;
    ember = smoothstep(0.05, 0.0, d) * uEmber;
  }
  vec3 V = normalize(-vViewPos);
  float fres = pow(1.0 - abs(dot(normalize(vNormalV), V)), 2.2);
  vec3 base = mix(uColor, uTipColor, smoothstep(0.35, 1.0, vT));
  // Polyp texture: faint rings and noise.
  float rings = 0.85 + 0.15 * sin(vT * 90.0 + n * 6.0);
  vec3 col = base * (0.16 + 0.55 * fres) * rings;
  col *= mix(0.45, 1.0, smoothstep(0.0, 0.6, vT));
  // Bioluminescent pulse travelling base -> tip.
  float ph = fract(vT * 0.9 - uTime * 0.32 + uSeed);
  float pulse = exp(-pow((ph - 0.5) * 10.0, 2.0));
  col += base * pulse * uGlow * 1.35;
  // The growth front glows.
  col += uTipColor * exp(-pow((uGrow - vT) * 22.0, 2.0)) * uGlow * 1.8 * step(uGrow, 0.995);
  // Bleached coral: once withered, a discard stays as a skeletal, faintly luminous ashen-violet branch (no pulse).
  vec3 ash = vec3(0.42, 0.40, 0.62);
  vec3 bleached = ash * (0.16 + 0.7 * fres) * (0.9 + 0.1 * rings) + ash * 0.1;
  col = mix(col, bleached, uBleach);
  col += vec3(1.0, 0.55, 0.32) * ember * 1.6;
  col += base * uHighlight * (0.55 + 0.6 * fres);
  col *= uDim;
  col = applyFog(col, length(vViewPos));
  gl_FragColor = vec4(col, 1.0);
  ${OUT}
}
`;

// ---------------------------------------------------------------- glow sphere (tips, halo, pearl glow)

export const glowVert = /* glsl */ `
varying vec3 vNormalV;
varying vec3 vViewPos;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  vNormalV = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}
`;

export const glowFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uCore;
uniform float uPower;
varying vec3 vNormalV;
varying vec3 vViewPos;
${FOG}
void main() {
  vec3 V = normalize(-vViewPos);
  float ndv = abs(dot(normalize(vNormalV), V));
  float rim = pow(1.0 - ndv, uPower);
  float a = clamp(rim + uCore * pow(ndv, 3.0), 0.0, 1.0) * uIntensity;
  vec3 col = applyFog(uColor * a, length(vViewPos));
  gl_FragColor = vec4(col, a);
  ${OUT}
}
`;

// ---------------------------------------------------------------- water surface (seen from below)

export const surfaceVert = /* glsl */ `
varying vec3 vWorld;
varying vec3 vViewPos;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mv = viewMatrix * world;
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

export const surfaceFrag = /* glsl */ `
uniform float uTime;
uniform float uReveal;
uniform float uPulse;
uniform vec3 uColor;
uniform vec3 uCenter;
varying vec3 vWorld;
varying vec3 vViewPos;
${NOISE}
${FOG}
void main() {
  vec2 p = vWorld.xz - uCenter.xz;
  float r = length(p);
  float c = caustic(p * 0.32 + 20.0, uTime * 0.35);
  float c2 = caustic(p * 0.18 + 3.0, uTime * 0.22 + 1.7);
  float ripple = 0.0;
  if (uPulse > 0.0 && uPulse < 6.0) {
    float front = uPulse * 4.2;
    ripple = exp(-pow((r - front) * 1.4, 2.0)) * (1.0 - uPulse / 6.0) * (0.6 + 0.4 * sin(r * 6.0 - uPulse * 10.0));
  }
  float haze = mix(0.38, 1.0, uReveal);
  float sun = exp(-r * r * 0.012);
  vec3 col = uColor * (0.04 + 0.16 * c + 0.1 * c2) * haze;
  col += uColor * sun * mix(0.08, 0.22, uReveal);
  col += uColor * ripple * 0.9 * uReveal;
  float edge = 1.0 - smoothstep(10.0, 34.0, r);
  // Snell's window: from below, the sky only shows within ~48 degrees of vertical; beyond it the surface mirrors
  // the dark water, so grazing views stay dim and the light pools overhead.
  float up = abs(normalize(vWorld - cameraPosition).y);
  float window = mix(0.24, 1.0, smoothstep(0.3, 0.75, up));
  float a = clamp((0.35 + 0.65 * uReveal) * edge * window, 0.0, 1.0);
  col = applyFog(col, length(vViewPos) * mix(1.25, 0.7, uReveal));
  gl_FragColor = vec4(col * a, a);
  ${OUT}
}
`;

// ---------------------------------------------------------------- seabed

export const seabedFrag = /* glsl */ `
uniform float uTime;
uniform vec3 uSand;
uniform vec3 uLight;
uniform float uLightAmt;
varying vec3 vWorld;
varying vec3 vViewPos;
${NOISE}
${FOG}
void main() {
  vec2 p = vWorld.xz;
  float r = length(p);
  float dunes = fbm(vec3(p * 0.35, 0.0)) * 0.6 + fbm(vec3(p * 2.2, 1.0)) * 0.25;
  float c = caustic(p * 0.42 + 9.0, uTime * 0.3);
  vec3 col = uSand * (0.25 + 0.8 * dunes);
  col += uLight * c * 0.12 * uLightAmt * exp(-r * 0.11);
  // Bioluminescent glow pooled under the reef root.
  col += vec3(0.02, 0.16, 0.14) * exp(-r * r * 0.5) * 0.6;
  col = applyFog(col, length(vViewPos));
  gl_FragColor = vec4(col, 1.0);
  ${OUT}
}
`;

// ---------------------------------------------------------------- abyss backdrop

export const backdropVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const backdropFrag = /* glsl */ `
uniform vec3 uAbyss;
uniform vec3 uDeep;
uniform vec3 uLight;
uniform float uTime;
varying vec3 vDir;
${NOISE}
void main() {
  float h = vDir.y;
  vec3 col = mix(uAbyss, uDeep, smoothstep(-0.35, 0.75, h));
  // The sun as seen through water: a soft disc overhead, slightly shimmering.
  float sun = pow(max(h, 0.0), 6.0);
  col += uLight * sun * (0.32 + 0.06 * sin(uTime * 0.7));
  col += uDeep * 0.25 * fbm(vDir * 3.0 + vec3(0.0, uTime * 0.02, 0.0)) * smoothstep(-0.2, 0.5, h);
  gl_FragColor = vec4(col, 1.0);
  ${OUT}
}
`;

// ---------------------------------------------------------------- god rays (open cone, additive)

export const raysVert = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vViewPos;
varying vec3 vNormalV;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mv = viewMatrix * world;
  vViewPos = mv.xyz;
  vNormalV = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}
`;

export const raysFrag = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vViewPos;
varying vec3 vNormalV;
${NOISE}
void main() {
  float a = vUv.x * 6.2831;
  float shafts = vnoise(vec3(a * 3.0, uTime * 0.12, 0.0)) * vnoise(vec3(a * 7.0 + 3.0, uTime * 0.2, 1.0));
  shafts = smoothstep(0.28, 0.75, shafts);
  float vfade = smoothstep(0.0, 0.85, vUv.y) * (1.0 - smoothstep(0.92, 1.0, vUv.y));
  float edgeOn = abs(dot(normalize(vNormalV), normalize(-vViewPos)));
  float soft = smoothstep(0.0, 0.6, edgeOn);
  float i = shafts * vfade * soft * uIntensity;
  gl_FragColor = vec4(uColor * i, i);
  ${OUT}
}
`;

// ---------------------------------------------------------------- particles

export const snowVert = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uPixel;
uniform vec3 uBox;
uniform vec3 uOrigin;
varying float vAlpha;
void main() {
  vec3 p = aSeed.xyz * uBox;
  p.y = mod(p.y - uTime * (0.06 + aSeed.w * 0.12), uBox.y);
  p.x += sin(uTime * 0.3 + aSeed.w * 30.0) * 0.35;
  p.z += cos(uTime * 0.23 + aSeed.w * 17.0) * 0.35;
  p += uOrigin;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  gl_PointSize = uPixel * (0.6 + aSeed.w * 1.6) * (12.0 / max(d, 1.0));
  vAlpha = (0.25 + 0.55 * aSeed.w) * smoothstep(42.0, 6.0, d) * smoothstep(0.0, 1.5, d);
  gl_Position = projectionMatrix * mv;
}
`;

export const pointFrag = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  float a = smoothstep(0.25, 0.0, d) * vAlpha;
  gl_FragColor = vec4(uColor * a, a);
  ${OUT}
}
`;

export const colorPointFrag = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  float core = smoothstep(0.25, 0.0, d);
  float a = core * core * vAlpha;
  gl_FragColor = vec4(vColor * a * 1.6, a);
  ${OUT}
}
`;

/** Streams of data-profile particles drifting along curved paths into the root. */
export const nutrientVert = /* glsl */ `
attribute vec3 aStart;
attribute vec3 aCtrl;
attribute vec2 aPhase; // x: phase, y: speed jitter
attribute vec3 aColor;
uniform float uTime;
uniform float uIntensity;
uniform float uPixel;
uniform vec3 uRoot;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float s = fract(aPhase.x + uTime * (0.05 + 0.035 * aPhase.y));
  float u = 1.0 - s;
  vec3 p = u * u * aStart + 2.0 * u * s * aCtrl + s * s * uRoot;
  p.y += sin(s * 9.0 + aPhase.x * 20.0) * 0.12;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  gl_PointSize = uPixel * (1.2 + 1.6 * (1.0 - s)) * (12.0 / max(d, 1.0));
  vAlpha = uIntensity * sin(3.14159 * s) * smoothstep(0.0, 0.08, s);
  vColor = aColor;
  gl_Position = projectionMatrix * mv;
}
`;

/** One-shot bursts: crash sparks and the motes shed by a withering branch. */
export const burstVert = /* glsl */ `
attribute vec3 aDir;
attribute vec2 aRnd;
uniform float uAge;
uniform float uLife;
uniform float uSpeed;
uniform float uRise;
uniform float uPixel;
uniform vec3 uColorA;
uniform vec3 uColorB;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float life = uLife * (0.6 + 0.4 * aRnd.x);
  float k = clamp(uAge / life, 0.0, 1.0);
  // Drag: fast out, slow drift.
  float travel = (1.0 - exp(-uAge * 3.0)) / 3.0 * uSpeed * (0.5 + aRnd.y);
  vec3 p = position + aDir * travel + vec3(0.0, uRise * uAge * (0.4 + aRnd.x), 0.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uPixel * (1.0 - k * 0.6) * (1.0 + aRnd.y) * (12.0 / max(-mv.z, 1.0));
  vAlpha = (1.0 - k) * (1.0 - k) * step(0.0, uAge);
  vColor = mix(uColorA, uColorB, k);
  gl_Position = projectionMatrix * mv;
}
`;

// ---------------------------------------------------------------- shell (nacre) and pearl

export const shellFrag = /* glsl */ `
uniform float uTime;
uniform vec3 uOuter;
uniform float uOpen;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec3 vLocal;
${FOG}
vec3 irid(float t) { return 0.5 + 0.5 * cos(6.2831 * (t + vec3(0.0, 0.33, 0.67))); }
void main() {
  vec3 V = normalize(-vViewPos);
  vec3 N = normalize(vNormalV);
  float ndv = abs(dot(N, V));
  float az = atan(vLocal.z, vLocal.x);
  float ribs = 0.75 + 0.25 * smoothstep(-0.3, 1.0, sin(az * 22.0));
  vec3 col;
  if (gl_FrontFacing) {
    col = uOuter * ribs * (0.35 + 0.65 * pow(1.0 - ndv, 1.5));
  } else {
    // Mother-of-pearl inside, only lit once the shell opens.
    col = mix(vec3(0.75, 0.78, 0.9), irid(ndv * 1.3 + uTime * 0.03), 0.35) * (0.25 + 0.75 * uOpen) * (0.5 + 0.5 * ndv);
  }
  col = applyFog(col, length(vViewPos));
  gl_FragColor = vec4(col, 1.0);
  ${OUT}
}
`;

export const shellVert = /* glsl */ `
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec3 vLocal;
void main() {
  vLocal = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  vNormalV = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}
`;

export const pearlFrag = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform float uGlow;
varying vec3 vNormalV;
varying vec3 vViewPos;
${FOG}
vec3 irid(float t) { return 0.5 + 0.5 * cos(6.2831 * (t + vec3(0.0, 0.33, 0.67))); }
void main() {
  vec3 V = normalize(-vViewPos);
  vec3 N = normalize(vNormalV);
  float ndv = max(dot(N, V), 0.0);
  vec3 L = normalize(vec3(0.3, 1.0, 0.4));
  float diff = 0.45 + 0.55 * max(dot(N, normalize((viewMatrix * vec4(L, 0.0)).xyz)), 0.0);
  float spec = pow(max(dot(reflect(-V, N), normalize((viewMatrix * vec4(L, 0.0)).xyz)), 0.0), 40.0);
  vec3 col = uColor * diff;
  col = mix(col, irid(ndv * 0.8 + 0.2 + uTime * 0.02), pow(1.0 - ndv, 2.0) * 0.45);
  col += spec * 0.8 + uColor * uGlow * 0.6;
  col = applyFog(col, length(vViewPos));
  gl_FragColor = vec4(col, 1.0);
  ${OUT}
}
`;
