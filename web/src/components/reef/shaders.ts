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
float fbm2(vec3 p) {
  return 0.5 * vnoise(p) + 0.25 * vnoise(p * 2.03 + 7.1);
}
// Water caustics (after Dave Hoskins / joltz0r), calibrated: the formula expects coordinates around -250 — fed small
// world coordinates it saturates everywhere and its ridges invert into sharp dark flakes drifting over a flat bright
// floor. Returns a soft 0..1 pattern of bright filaments.
float caustic(vec2 q, float t) {
  vec2 p = q - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    float sx = sin(i.x + tt), cy = cos(i.y + tt);
    sx = abs(sx) < 1e-3 ? 1e-3 : sx;
    cy = abs(cy) < 1e-3 ? 1e-3 : cy;
    c += 1.0 / max(length(vec2(p.x / (sx / inten), p.y / (cy / inten))), 1e-3);
  }
  c = clamp(c / 4.0, 0.0, 4.0);
  c = 1.17 - pow(c, 1.4);
  return clamp(pow(clamp(abs(c), 0.0, 1.2), 8.0), 0.0, 1.5);
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

/** Output: sanitised (a NaN/Inf pixel would be smeared into a dark blob by the bloom mip chain), then colour space. */
export const OUT = /* glsl */ `
  gl_FragColor = clamp(gl_FragColor, vec4(0.0), vec4(32.0));
  gl_FragColor = (gl_FragColor.r == gl_FragColor.r && gl_FragColor.g == gl_FragColor.g && gl_FragColor.b == gl_FragColor.b && gl_FragColor.a == gl_FragColor.a) ? gl_FragColor : vec4(0.0);
  #include <colorspace_fragment>
`;

// ---------------------------------------------------------------- tree (instanced Bézier tubes)

/**
 * The water current, a smooth function of the *undisplaced* world position (so a twig and the point of the stem it
 * grows from always move together — junctions never tear). Amplitude grows with height: the crown sways, the
 * trunk barely moves.
 */
export const CURRENT = /* glsl */ `
uniform float uTime;
uniform float uSway;
vec3 current(vec3 p) {
  float h = clamp(p.y / 8.0, 0.0, 1.5);
  float a = uSway * h * h;
  return a * vec3(
    sin(uTime * 0.52 + p.y * 0.42 + p.x * 0.31) + 0.3 * sin(uTime * 1.07 + p.y * 0.9 + p.z * 0.5),
    0.0,
    cos(uTime * 0.41 + p.y * 0.37 + p.z * 0.29) + 0.3 * cos(uTime * 0.93 + p.y * 0.8 + p.x * 0.4));
}
`;

/**
 * One instance = one branch segment (an experiment's limb, a twig or a surface root): a cubic Bézier evaluated
 * here from per-instance control points, so tweening a branch never rebuilds geometry. The template's
 * position = (t along the curve, angle around it, cap phase: <0 base cap, >0 tip cap).
 *
 * Every animation is a timestamp compared with uNow (growth, bleaching, colour change, death) — the CPU only
 * uploads when something structural changes or a spring is moving.
 */
export const treeVert = /* glsl */ `
attribute vec4 aP0;   // xyz, r0
attribute vec4 aP1;   // xyz, r1
attribute vec4 aP2;   // xyz, flare
attribute vec4 aP3;   // xyz, seed
attribute vec4 aGrow; // start, duration, from, to
attribute vec4 aLife; // dieAt, bleachAt, arc0, arcLen
attribute vec4 aCol0; // rgb from, colourAt
attribute vec4 aCol1; // rgb to, kind (0 living, 1 discard, 2 crash, 3 running, 4 root)
attribute vec2 aFx;   // glow, highlight
uniform float uNow;
uniform float uPx;    // pixels per world unit at distance 1
uniform float uMinPx; // minimum on-screen radius (device px)
${CURRENT}
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vViewPos;
varying float vArc;
varying float vAround;
varying float vFront;
varying float vGrowing;
varying vec3 vCol;
varying float vBleach;
varying float vDie;
varying float vKind;
varying vec2 vFx;
varying float vSeed;
varying float vR;

vec3 bez(float t) {
  float u = 1.0 - t;
  return u * u * u * aP0.xyz + 3.0 * u * u * t * aP1.xyz + 3.0 * u * t * t * aP2.xyz + t * t * t * aP3.xyz;
}
vec3 bezD(float t) {
  float u = 1.0 - t;
  return 3.0 * u * u * (aP1.xyz - aP0.xyz) + 6.0 * u * t * (aP2.xyz - aP1.xyz) + 3.0 * t * t * (aP3.xyz - aP2.xyz);
}
float easeOut(float x) { float k = 1.0 - x; return 1.0 - k * k * k; }

void main() {
  float t = position.x;
  float ang = position.y;
  float cap = position.z;

  float k = aGrow.y > 0.0 ? clamp((uNow - aGrow.x) / aGrow.y, 0.0, 1.0) : 1.0;
  float g = mix(aGrow.z, aGrow.w, easeOut(k));
  float die = clamp((uNow - aLife.x) / 0.9, 0.0, 1.0);
  g *= 1.0 - smoothstep(0.0, 1.0, die); // retract toward the base while dissolving

  float te = cap < 0.0 ? 0.0 : (cap > 0.0 ? g : min(t, g));
  vec3 c = bez(te);
  vec3 chord = aP3.xyz - aP0.xyz;
  vec3 T = bezD(te);
  T = dot(T, T) > 1e-10 ? normalize(T) : normalize(chord + vec3(0.0, 1e-5, 0.0));
  // A per-instance reference normal (the curve's bending plane), then Gram-Schmidt: a near-parallel-transport frame.
  vec3 ref = cross(chord, aP1.xyz + aP2.xyz - 2.0 * aP0.xyz);
  vec3 alt = cross(chord, abs(chord.y) > 0.9 * length(chord) ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0));
  ref = dot(ref, ref) > 1e-6 * dot(chord, chord) * dot(chord, chord) ? ref : alt;
  vec3 B = ref - dot(ref, T) * T;
  B = dot(B, B) > 1e-12 ? normalize(B) : normalize(cross(T, vec3(0.31, 0.0, 0.95)));
  vec3 N = cross(B, T);

  float r = mix(aP0.w, aP1.w, te) * (1.0 + aP2.w * exp(-te * 9.0));
  r *= 1.0 - 0.6 * die;

  // Sway the centreline as a function of where it is (continuous across junctions).
  vec3 cw = c + current(c);
  vec4 cv = viewMatrix * vec4(cw, 1.0);
  float depth = max(-cv.z, 0.1);
  // Never thinner than ~uMinPx on screen (no shimmering hairlines under bloom); nothing at all before birth.
  float born = smoothstep(0.0, 0.015, g);
  r = max(r, uMinPx * depth / uPx * born) * born;

  vec3 radial = N * cos(ang) + B * sin(ang);
  vec3 nrm = radial;
  vec3 off = radial * r;
  if (cap != 0.0) {
    float ph = abs(cap) * 1.5707963;
    float sg = sign(cap);
    off = radial * r * cos(ph) + T * sg * r * sin(ph);
    nrm = normalize(radial * cos(ph) + T * sg * sin(ph));
  }
  vec4 world = modelMatrix * vec4(cw + off, 1.0);
  vWorld = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * nrm);
  vec4 mv = viewMatrix * world;
  vViewPos = mv.xyz;
  vArc = aLife.z + te * aLife.w;
  vAround = ang / 6.2831853;
  vFront = (g - te) * aLife.w;
  vGrowing = (1.0 - step(0.999, g)) * born;
  vCol = mix(aCol0.rgb, aCol1.rgb, smoothstep(0.0, 1.0, clamp((uNow - aCol0.w) / 1.4, 0.0, 1.0)));
  vBleach = smoothstep(0.0, 1.0, clamp((uNow - aLife.y) / 2.6, 0.0, 1.0));
  vDie = die;
  vKind = aCol1.w;
  vFx = aFx;
  vSeed = aP3.w;
  vR = r;
  gl_Position = projectionMatrix * mv;
}
`;

export const treeFrag = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vViewPos;
varying float vArc;
varying float vAround;
varying float vFront;
varying float vGrowing;
varying vec3 vCol;
varying float vBleach;
varying float vDie;
varying float vKind;
varying vec2 vFx;
varying float vSeed;
varying float vR;
${NOISE}
${FOG}
void main() {
  if (vDie > 0.0 && vnoise(vWorld * 9.0 + vSeed * 7.0) < vDie * 1.08) discard;
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = abs(dot(N, V));
  // Bark / coral tissue: longitudinal ridges warped by noise, plus fine grain.
  float wn = vnoise(vec3(vAround * 7.0, vArc * 2.4, vSeed * 17.0));
  float ridge = 0.5 + 0.5 * sin(vAround * 6.2831853 * 5.0 + wn * 4.0 + vArc * 0.6);
  float grain = vnoise(vWorld * 22.0);
  vec3 tint = vCol;
  // Dark living tissue whose light comes from within: a deep body, a luminous rim, glowing grooves.
  vec3 body = mix(vec3(0.004, 0.012, 0.018), tint * 0.07, 0.6);
  vec3 albedo = body * (0.55 + 0.45 * ridge + 0.25 * grain);
  float sky = 0.5 + 0.5 * N.y;          // light from the surface
  float rim = pow(clamp(1.0 - ndv, 0.0, 1.0), 2.2);      // back-lit edge, subsurface-ish
  float thin = exp(-vR * 9.0);          // thin tissue transmits more light
  float groove = smoothstep(0.78, 1.0, 1.0 - ridge) * (0.6 + 0.4 * wn);
  vec3 col = albedo * (0.16 + 0.55 * sky) + tint * rim * (1.05 + 0.7 * thin) + tint * (thin * 0.14 + groove * 0.05);
  // A slow bioluminescent pulse climbing from the root (arc length is continuous across junctions).
  float wave = 0.5 + 0.5 * sin(vArc * 0.75 - uTime * 1.05);
  float pulse = pow(wave, 8.0);
  col += tint * pulse * vFx.x * (0.32 + 0.6 * rim + 0.4 * groove);
  // The growth front glows softly; a running experiment's bud breathes.
  float bud = vKind > 2.5 && vKind < 3.5 ? 0.8 + 0.2 * sin(uTime * 3.2) : 1.0;
  col += mix(tint, vec3(1.0), 0.4) * exp(-vFront * vFront * 30.0) * vGrowing * 0.9 * bud;
  // Bleached (discarded): dry, pale, unlit tissue.
  vec3 bone = vec3(0.5, 0.49, 0.56);
  vec3 dry = bone * (0.07 + 0.22 * sky) * (0.75 + 0.4 * ridge) + bone * rim * 0.28;
  col = mix(col, dry, vBleach);
  // Crash: a charred stub with dim ember cracks.
  if (vKind > 1.5 && vKind < 2.5) {
    float crack = smoothstep(0.6, 0.72, vnoise(vWorld * 16.0 + vSeed * 3.0));
    col = vec3(0.035, 0.03, 0.035) * (0.6 + sky) + vec3(1.0, 0.34, 0.16) * crack * (0.45 + 0.2 * sin(uTime * 1.6 + vSeed * 20.0));
  }
  col += tint * vFx.y * (0.18 + 0.55 * rim);
  col = applyFog(col, length(vViewPos));
  gl_FragColor = vec4(col, 1.0);
  ${OUT}
}
`;

/**
 * Leaves / polyps: instanced quads billboarded around their twig direction. Additive, soft and translucent; they bud,
 * flutter in the current, and — on a discarded branch — fall, tumbling and fading, as it withers.
 */
export const leafVert = /* glsl */ `
attribute vec4 aAnchor; // xyz, size
attribute vec4 aDir;    // xyz, seed
attribute vec4 aLeafT;  // bornAt, fallAt, dieAt, colourAt
attribute vec3 aLCol0;
attribute vec3 aLCol1;
uniform float uNow;
uniform float uPx;
${CURRENT}
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vDepth;
void main() {
  float age = uNow - aLeafT.x;
  float grow = smoothstep(0.0, 0.75, age);
  vec3 p = aAnchor.xyz;
  p += current(p);
  vec3 dir = aDir.xyz;
  float alpha = smoothstep(0.0, 0.35, age);
  float f = uNow - aLeafT.y;
  if (f > 0.0) {
    // Leaf fall: slow sink, a swirl in the current, a gentle tumble, a long fade.
    float s = min(f, 2.0);
    p.y -= 0.16 * f + 0.025 * f * f;
    p.x += sin(f * 1.3 + aDir.w * 20.0) * 0.28 * s;
    p.z += cos(f * 1.1 + aDir.w * 13.0) * 0.28 * s;
    p.y = max(p.y, 0.03);
    dir = normalize(mix(dir, vec3(sin(f * 1.7 + aDir.w * 9.0), -0.4, cos(f * 1.3 + aDir.w * 5.0)), smoothstep(0.0, 1.5, f)));
    alpha *= 1.0 - smoothstep(1.0, 4.2, f);
  }
  alpha *= 1.0 - clamp((uNow - aLeafT.z) / 0.6, 0.0, 1.0);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vec3 dv = (viewMatrix * vec4(dir, 0.0)).xyz;
  vec2 ax = length(dv.xy) > 1e-4 ? normalize(dv.xy) : vec2(0.0, 1.0);
  float fl = sin(uTime * 1.9 + aDir.w * 31.0) * 0.16;
  ax = vec2(ax.x * cos(fl) - ax.y * sin(fl), ax.x * sin(fl) + ax.y * cos(fl));
  vec2 ay = vec2(-ax.y, ax.x);
  float depth = max(-mv.z, 0.1);
  float size = aAnchor.w * grow;
  // Sub-pixel leaves shimmer: keep at least ~2.5px and trade the extra area for alpha.
  float px = size * uPx / depth;
  float minSize = 2.5 * depth / uPx;
  alpha *= clamp(px / 2.5, 0.0, 1.0);
  size = max(size, minSize * step(0.001, grow));
  // Seen end-on, a leaf foreshortens toward a round polyp.
  float fs = clamp(length(dv.xy) / max(length(dv), 1e-4), 0.45, 1.0);
  vec2 q = vec2(position.x * size * fs, position.y * size * 0.42);
  mv.xy += ax * q.x + ay * q.y;
  vUv = position.xy;
  vColor = mix(aLCol0, aLCol1, smoothstep(0.0, 1.0, clamp((uNow - aLeafT.w) / 1.6, 0.0, 1.0)));
  vAlpha = alpha;
  vDepth = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

export const leafFrag = /* glsl */ `
uniform float uFogDensity;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vDepth;
void main() {
  float u = clamp(vUv.x, 0.0, 1.0);
  float v = vUv.y;
  float w = pow(max(sin(3.14159 * u), 0.0), 0.7) * (1.0 - 0.3 * u) + 1e-3;
  float body = smoothstep(w, w * 0.45, abs(v));
  float vein = exp(-v * v * 70.0) * (1.0 - u) * 0.55;
  float hu = u - 0.18;
  float heart = exp(-hu * hu * 40.0) * 0.45;
  float fog = exp(-uFogDensity * uFogDensity * vDepth * vDepth);
  float a = body * (0.75 + vein + heart) * vAlpha * fog;
  gl_FragColor = vec4(vColor * a, a);
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
  float rim = pow(clamp(1.0 - ndv, 0.0, 1.0), uPower);
  float a = clamp(rim + uCore * pow(clamp(ndv, 0.0, 1.0), 3.0), 0.0, 1.0) * uIntensity;
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
    float dr = (r - front) * 1.4;
    ripple = exp(-dr * dr) * (1.0 - uPulse / 6.0) * (0.6 + 0.4 * sin(r * 6.0 - uPulse * 10.0));
  }
  float haze = mix(0.38, 1.0, uReveal);
  float sun = exp(-r * r * 0.012);
  vec3 col = uColor * (0.62 + 0.3 * c + 0.16 * c2) * haze;
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
  float dunes = fbm2(vec3(p * 0.35, 0.0)) * 0.8 + vnoise(vec3(p * 2.2, 1.0)) * 0.16;
  float c = caustic(p * 0.42 + 9.0, uTime * 0.3);
  vec3 col = uSand * (0.25 + 0.8 * dunes);
  // The light pool under the opening above, with caustic filaments drifting across it.
  col += uLight * (0.55 + 0.25 * c) * uLightAmt * exp(-r * 0.11);
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
  col += uDeep * 0.25 * fbm2(vDir * 3.0 + vec3(0.0, uTime * 0.02, 0.0)) * 1.25 * smoothstep(-0.2, 0.5, h);
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
    col = uOuter * ribs * (0.35 + 0.65 * pow(clamp(1.0 - ndv, 0.0, 1.0), 1.5));
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
  col = mix(col, irid(ndv * 0.8 + 0.2 + uTime * 0.02), pow(clamp(1.0 - ndv, 0.0, 1.0), 2.0) * 0.45);
  col += spec * 0.8 + uColor * uGlow * 0.6;
  col = applyFog(col, length(vViewPos));
  gl_FragColor = vec4(col, 1.0);
  ${OUT}
}
`;
