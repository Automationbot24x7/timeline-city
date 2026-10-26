// Night-globe fly-in for the TimeLine renderer (three.js, WebGL2).
// NASA Black Marble 2016 "Earth at night" (public domain; credits in render/assets/earth/CREDITS.md):
// whole Earth at night with a thin blue atmosphere rim and a faint star field, then a curving dive that tilts
// to a low pass towards the target with the horizon in view (for Delhi: up the Gangetic plain, the Himalaya on
// the horizon), noses down onto the city's glow, where the lights resolve into the city's real streets
// (OpenStreetMap layers from geo.json, when given). The land is moonlit (the map's own relief and snow), the
// lights are points on it: a lit region never reads as a silhouette map, and no frame looks square-on at a
// whole region from mid altitude.
//
//   import * as THREE from 'three'   // import map: "three": ".../node_modules/three/build/three.module.js" (+ three.core.js beside it)
//   import { createGlobe } from './three/globe.js'
//   const globe = createGlobe(THREE, renderer, { textureUrl: 'assets/earth/earth_night_8k.jpg', target: { lat, lon },
//     city: { bbox: GEO.bbox, roads: GEO.layers.roads, water: GEO.layers.water, green: GEO.layers.green, line: GEO.line.coords, lineColor: GEO.line.color } })
//   await globe.ready
//   globe.renderAt(progress, w, h)   // draws into renderer.domElement (w x h); then ctx2d.drawImage(renderer.domElement, 0, 0)
//   globe.dispose()                  // after the opening: frees ~450 MB of textures and targets
//
// Deterministic: every frame is a pure function of `progress` (0..1). No clock, no unseeded randomness.
// Tested by test/fixtures/globe-render.mjs (+ globe-harness.html): stills, previews, --check (identical pixels).
// Never draws borders, country names or any text: overlays belong to the 2D renderer.
// Units: 1 world unit = 1 Earth radius; Earth centred at the origin, lon/lat on three's SphereGeometry
// UV convention (u = (lon + 180) / 360, v = (lat + 90) / 180, north up in the image).

const R_KM = 6371.0088
const D2R = Math.PI / 180

/** Regional 500 m crops (Black Marble 2016 tile C1), resolved next to the global texture.
 *  bounds = [west, south, east, north] degrees; fadeKm = [camera altitude where the patch starts to
 *  show, altitude where it is fully on]; only patches that contain the target are loaded. */
export const EARTH_PATCHES = [
  { file: 'earth_night_south_asia.jpg', bounds: [60, 5, 90, 37], fadeKm: [9000, 4000], featherDeg: 1.6 },
  { file: 'earth_night_delhi.jpg', bounds: [74.2, 25.6, 80.2, 31.6], fadeKm: [1400, 600], featherDeg: 0.45 },
]

export const EARTH_CREDIT = 'Earth at night: NASA Earth Observatory (Black Marble)'

// ---------- small math (plain doubles; the GPU only sees the final camera)
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v)
const lerp = (a, b, u) => a + (b - a) * u
const smoother = (u) => ((u = clamp(u)), u * u * u * (u * (u * 6 - 15) + 10))

function hermite(p, keys) {
  let i = 0
  while (i < keys.length - 2 && p > keys[i + 1].p) i++
  const a = keys[i]
  const b = keys[i + 1]
  const dp = b.p - a.p
  const t = clamp((p - a.p) / dp)
  const t2 = t * t
  const t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  const f = (v0, v1, m0, m1) => h00 * v0 + h10 * dp * m0 + h01 * v1 + h11 * dp * m1
  return Array.isArray(a.v) ? a.v.map((_, k) => f(a.v[k], b.v[k], a.m[k], b.m[k])) : f(a.v, b.v, a.m, b.m)
}

/** Unit vector (Earth radii) for lat/lon on the SphereGeometry UV convention. */
function llVec(lat, lon, r = 1) {
  const φ = lat * D2R
  const λ = lon * D2R
  return [r * Math.cos(φ) * Math.cos(λ), r * Math.sin(φ), -r * Math.cos(φ) * Math.sin(λ)]
}
function enu(lat, lon) {
  const φ = lat * D2R
  const λ = lon * D2R
  return {
    up: [Math.cos(φ) * Math.cos(λ), Math.sin(φ), -Math.cos(φ) * Math.sin(λ)],
    east: [-Math.sin(λ), 0, -Math.cos(λ)],
    north: [-Math.sin(φ) * Math.cos(λ), Math.cos(φ), Math.sin(φ) * Math.sin(λ)],
  }
}
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s]

/** Great-circle destination from (lat, lon) along bearing (deg) for distKm. */
function destination(lat, lon, brg, distKm) {
  const δ = distKm / R_KM
  const θ = brg * D2R
  const φ1 = lat * D2R
  const λ1 = lon * D2R
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: φ2 / D2R, lon: ((((λ2 / D2R + 540) % 360) + 360) % 360) - 180 }
}
/** C1 cubic through keys [{p, v}]: Catmull-Rom tangents, or Fritsch-Carlson (monotone, no overshoot). */
function spline(keys, monotone = false) {
  const n = keys.length
  const d = keys.slice(0, -1).map((k, i) => (keys[i + 1].v - k.v) / (keys[i + 1].p - k.p))
  const m = keys.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : (d[i - 1] + d[i]) / 2))
  if (monotone)
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        m[i] = m[i + 1] = 0
        continue
      }
      const a = m[i] / d[i]
      const b = m[i + 1] / d[i]
      if (a < 0) m[i] = 0
      if (b < 0) m[i + 1] = 0
      const s = a * a + b * b
      if (s > 9) {
        const τ = 3 / Math.sqrt(s)
        m[i] = τ * a * d[i]
        m[i + 1] = τ * b * d[i]
      }
    }
  const ks = keys.map((k, i) => ({ p: k.p, v: k.v, m: m[i] }))
  return (p) => hermite(clamp(p, keys[0].p, keys[n - 1].p), ks)
}

/** Altitude (km) where render/renderer.js hands the opening over to the 3D city (its bisection uses 260). */
export const HANDOVER_KM = 260

/**
 * The fly-in as a pure function of progress. Defaults: from the whole Earth (the target's continent in view,
 * north up, the target well off centre) the view curves in from the east-south-east, tilting towards the
 * horizon and turning to head west-north-west: for Delhi a low pass up the Gangetic plain with the Himalaya on
 * the horizon to the right. It then noses down onto the target and reaches HANDOVER_KM (the renderer hands over
 * to the 3D city there) at p = keys[k].p of the key with that altitude. No frame looks straight down on a whole
 * region from mid altitude (a lit region seen square-on from there reads as a silhouette map).
 * keys: [{ p, distKm, brg (deg, look point from the target), altKm, tilt, bearing }] (opts.keys replaces them).
 * (A portrait frame shows more sky above the horizon of the tilted pass: there it sits behind the title.)
 */
export function globePath(target, opts = {}) {
  const keys = opts.keys || [
    { p: 0.0, distKm: 3300, brg: 116, altKm: 22000, tilt: 0, bearing: 0 },
    { p: 0.41, distKm: 1550, brg: 118, altKm: 6400, tilt: 24, bearing: -30 },
    { p: 0.63, distKm: 640, brg: 120, altKm: 1650, tilt: 54, bearing: -50 },
    { p: 0.79, distKm: 200, brg: 121, altKm: 600, tilt: 63, bearing: -57 },
    { p: 0.85, distKm: 60, brg: 121, altKm: 390, tilt: 55, bearing: -58.5 },
    { p: 0.9, distKm: 0, brg: 121, altKm: HANDOVER_KM, tilt: 42, bearing: -59 },
    { p: 1.0, distKm: 0, brg: 121, altKm: 110, tilt: 36, bearing: -59 },
  ]
  const ch = (f, mono) => spline(keys.map((k) => ({ p: k.p, v: f(k) })), mono)
  const lnAlt = ch((k) => Math.log(k.altKm), true)
  const dist = ch((k) => k.distKm, true)
  const brg = ch((k) => k.brg)
  const tilt = ch((k) => k.tilt)
  const bearing = ch((k) => k.bearing)
  const fov = opts.fov ?? 30
  function poseAt(progress) {
    const p = clamp(progress)
    const altKm = Math.exp(lnAlt(p))
    const dKm = Math.max(0, dist(p))
    const look = dKm > 1e-6 ? destination(target.lat, target.lon, brg(p), dKm) : { ...target }
    const t = clamp(tilt(p), 0, 80)
    return { lat: look.lat, lon: look.lon, altKm, rangeKm: altKm / Math.cos(t * D2R), tilt: t, bearing: bearing(p), fov, progress: p }
  }
  return { poseAt, keys }
}

/** Seeded PRNG (mulberry32). */
function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- shaders
const FULLSCREEN_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`

const EARTH_VS = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vN = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`

const EARTH_FS = /* glsl */ `
uniform sampler2D uGlobal;
uniform sampler2D uPatch0;
uniform sampler2D uPatch1;
uniform vec4 uB0;  // west, south, east, north (deg)
uniform vec4 uB1;
uniform vec2 uW0;  // feather (deg), weight
uniform vec2 uW1;
uniform vec3 uCam;
uniform vec3 uSun;
uniform float uLightGain;   // gain on the lights (points: no emissive boost of whole lit regions)
uniform float uLightCurve;  // exponent on the separated light (sRGB 0..1): high keeps a dense plain's diffuse glow low
uniform vec3 uLightCol;     // linear colour of the lights (warm sodium); the brightest cores go whiter
uniform float uMoon;        // brightness of the moonlit land
uniform vec3 uMoonTint;     // its tint (sRGB multiplier, cool)
uniform float uNearLook;    // 0..1: towards the hand-over the lights go back to the emissive look the 3D city matches
uniform float uBase;        // (near look) gain on the whole image
uniform float uBoost;       // (near look) extra emissive gain on city lights
uniform float uLand;        // (near look) gain on the dim part
uniform vec3 uAtmo;
uniform vec3 uWarm;
uniform float uRim;
uniform float uHaze;    // aerial haze strength (fades out near the ground)
uniform float uGrade;   // 0 far .. 1 near the ground: lights graded to warm amber, dimmer, so roads read on top
uniform sampler2D uOver;  // city layers raster: r = roads, g = green (~0.43) / water (1.0), b = the ridden line
uniform vec4 uOB;
uniform vec2 uOW;
uniform vec3 uRoadCol;
uniform vec3 uLineCol;
uniform vec3 uWaterCol;
uniform float uRoadGain;
uniform float uLineGain;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vWorld;

uniform vec2 uSizeG;
uniform vec2 uSize0;
uniform vec2 uSize1;
uniform float uSmooth;  // 0..1: cubic B-spline sampling when the imagery is magnified (no texel blocks)
uniform float uLod;     // 0..1: how far down the mip chain the B-spline reads (a softer glow near the ground)
uniform float uNear;    // brightness of the warm city haze near the ground
uniform vec3 uHazeLo;   // haze colour for dim light / for full light (warm glow far up, slate night at the end)
uniform vec3 uHazeHi;
uniform vec4 uFocus;    // target lon, lat, road fade start / end (km): streets fade out radially, never at the data's bbox

float edgeWeight(vec4 b, vec2 w, float lon, float lat) {
  float d = min(min(lon - b.x, b.z - lon), min(lat - b.y, b.w - lat));
  return smoothstep(0.0, w.x, d) * w.y;
}
vec4 bsplineW(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x;
  float y = s.y - 4.0 * s.x;
  float z = s.z - 4.0 * s.y + 6.0 * s.x;
  return vec4(x, y, z, 6.0 - x - y - z) / 6.0;
}
vec3 bicubic(sampler2D tex, vec2 uv, vec2 size0, float lod) {
  vec2 size = size0 / exp2(lod);
  vec2 st = uv * size - 0.5;
  vec2 f = fract(st);
  st -= f;
  vec4 xc = bsplineW(f.x);
  vec4 yc = bsplineW(f.y);
  vec4 c = st.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 off = (c + vec4(xc.yw, yc.yw) / s) / size.xxyy;
  vec3 s0 = textureLod(tex, off.xz, lod).rgb;
  vec3 s1 = textureLod(tex, off.yz, lod).rgb;
  vec3 s2 = textureLod(tex, off.xw, lod).rgb;
  vec3 s3 = textureLod(tex, off.yw, lod).rgb;
  float sx = s.x / (s.x + s.y);
  float sy = s.z / (s.z + s.w);
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}
// near the ground the VIIRS pixels (~742 m, gridded at 500 m) would show as blocks: there the image is
// read as a smooth B-spline from a coarser mip (lod), i.e. a soft glow; the real streets bring the detail
vec3 sampleImg(sampler2D tex, vec2 uv, vec2 size, float lod) {
  vec3 a = texture2D(tex, uv).rgb;   // sampled unconditionally: derivatives stay valid
  vec3 b = bicubic(tex, uv, size, lod);
  return mix(a, b, uSmooth);
}
vec3 patchMix(vec3 c, sampler2D tex, vec2 size, float lod, vec4 b, vec2 w, float lon, float lat) {
  vec2 uv = vec2((lon - b.x) / (b.z - b.x), (lat - b.y) / (b.w - b.y));
  return mix(c, sampleImg(tex, uv, size, lod), edgeWeight(b, w, lon, lat));
}

void main() {
  float lon = vUv.x * 360.0 - 180.0;
  float lat = vUv.y * 180.0 - 90.0;
  vec3 c = sampleImg(uGlobal, vUv, uSizeG, 0.0);
  c = patchMix(c, uPatch0, uSize0, uLod, uB0, uW0, lon, lat);
  c = patchMix(c, uPatch1, uSize1, 2.6 * uLod, uB1, uW1, lon, lat);

  float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float lit = smoothstep(0.035, 0.55, L);
  // The Black Marble colour maps are blue land (its own relief and snow, r ~ 0.55 b in sRGB) under warm/white
  // lights: split them, so all land reads as land at night (moonlit), however dark its lights, and the lights
  // read as points of light on it rather than one glowing shape. The ocean is one flat navy in these maps.
  vec3 s = pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
  float aL = clamp((s.r - 0.55 * s.b) / 0.67, 0.0, 1.0);   // 0 .. 0.69 (a saturated white core)
  float m = mix(clamp(s.b - 0.6 * aL, 0.0, 1.0), 0.15, smoothstep(0.25, 0.6, aL));  // under a city: a plain
  float landK = smoothstep(0.012, 0.035, length(s - vec3(0.02, 0.02, 0.059)));
  // forest and farmland stay a dim slate (never black), deserts paler, snow and ice silver
  float mg = 0.11 + 0.14 * smoothstep(0.06, 0.30, m) + 0.15 * smoothstep(0.24, 0.37, m);
  vec3 moon = pow(mg * uMoonTint, vec3(2.2)) * uMoon;
  float aw = pow(smoothstep(0.03, 0.69, aL), uLightCurve);
  vec3 lights = aw * mix(uLightCol, vec3(1.0, 0.86, 0.66), aw * aw) * uLightGain;
  vec3 col = mix(c, moon, landK) + lights;
  // near the hand-over: the emissive look the 3D city's own ground lights are matched to (warm pools, soft edges)
  vec3 nearCol = (c * mix(uLand, uBase, lit) + c * uBoost * lit * lit) * mix(vec3(1.0), vec3(1.06, 0.98, 0.86), lit);
  col = mix(col, nearCol, uNearLook);
  // near the ground the lights fill the frame: a dim amber haze (by light level) under the real streets
  // (a deep blue-grey night ground everywhere, as in the 3D city, plus a warm glow that rises with the light)
  float Lh = pow(clamp(L, 0.0, 1.0), 1.7);
  float g0 = smoothstep(0.015, 0.06, L);
  vec3 ground = mix(c * 0.75 * min(1.0, 0.016 / max(L, 1e-4)), vec3(0.014, 0.018, 0.032), g0); // never brighter than the relief
  vec3 haze = mix(uHazeLo, uHazeHi, clamp(L * 1.15, 0.0, 1.0)) * Lh * uNear;
  col = mix(col, ground + haze, uGrade);

  // real city layers (OpenStreetMap via geo.json) fade in for the last stretch of the dive
  vec2 ouv = vec2((lon - uOB.x) / (uOB.z - uOB.x), (lat - uOB.y) / (uOB.w - uOB.y));
  vec3 o = texture2D(uOver, ouv).rgb;
  float ok = edgeWeight(uOB, uOW, lon, lat);
  float water = smoothstep(0.75, 0.95, o.g) * ok;
  float green = smoothstep(0.3, 0.5, o.g) * (1.0 - smoothstep(0.75, 0.95, o.g)) * ok;
  col *= 1.0 - water * 0.88 - green * 0.45;
  col += uWaterCol * water;
  vec2 dk = vec2((lon - uFocus.x) * cos(radians(lat)), lat - uFocus.y) * 111.2;
  float focus = 1.0 - smoothstep(uFocus.z, uFocus.w, length(dk));
  col += uRoadCol * o.r * ok * focus * uRoadGain * (0.45 + 0.55 * lit);
  col += uLineCol * o.b * ok * uLineGain;

  // atmosphere seen from above: fresnel rim towards the limb, bluer, a touch warmer on the sun side
  vec3 V = normalize(uCam - vWorld);
  float mu = clamp(dot(vN, V), 0.0, 1.0);
  float rim = pow(1.0 - mu, 4.0);
  float sunSide = pow(max(dot(vN, uSun), 0.0), 3.0);
  vec3 atmo = mix(uAtmo, uWarm, sunSide * 0.55);
  col = col * (1.0 - rim * 0.65 * uHaze) + atmo * (rim * uRim + pow(1.0 - mu, 12.0) * uRim * 1.6) * uHaze;
  gl_FragColor = vec4(col, 1.0);
}`

const HALO_VS = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`

// glow by the ray's closest approach to the planet: a thin bright limb plus a soft outer halo
const HALO_FS = /* glsl */ `
uniform vec3 uCam;
uniform vec3 uSun;
uniform vec3 uAtmo;
uniform vec3 uWarm;
uniform float uShell;   // shell radius - 1
uniform float uI;       // intensity
varying vec3 vWorld;
void main() {
  vec3 rd = normalize(vWorld - uCam);
  float tca = dot(-uCam, rd);
  vec3 pc = tca > 0.0 ? uCam + rd * tca : uCam;
  float b = length(pc);
  float h = max(b - 1.0, 0.0);
  float g = 0.8 * exp(-h / 0.0032) + 0.3 * exp(-h / 0.011) + 0.1 * exp(-h / 0.03);
  g *= 1.0 - smoothstep(uShell * 0.55, uShell, h);
  float sunSide = pow(max(dot(normalize(pc), uSun), 0.0), 2.0);
  vec3 col = mix(uAtmo, uWarm, sunSide * smoothstep(0.03, 0.0, h) * 0.8) * (1.0 + sunSide * 1.4);
  gl_FragColor = vec4(col * g * uI, 1.0);
}`

const STAR_VS = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
uniform float uScale;
varying vec3 vColor;
void main() {
  vColor = aColor;
  gl_PointSize = aSize * uScale;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`
const STAR_FS = /* glsl */ `
uniform float uFade;
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float a = exp(-dot(d, d) * 18.0);
  gl_FragColor = vec4(vColor * a * uFade, 1.0);
}`

// soft-threshold bright pass with a 4-tap box downsample (full -> half resolution)
const BRIGHT_FS = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
void main() {
  vec3 c = 0.25 * (texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb
                 + texture2D(tSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb);
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  rq = rq * rq / (4.0 * uKnee + 1e-5);
  float w = max(rq, br - uThreshold) / max(br, 1e-5);
  gl_FragColor = vec4(c * w, 1.0);
}`
// dual-filter (Kawase) down / up sampling
const DOWN_FS = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 o = uTexel;
  vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
  s += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb;
  s += texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb;
  s += texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb;
  s += texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb;
  gl_FragColor = vec4(s / 8.0, 1.0);
}`
const UP_FS = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tBase;
uniform vec2 uTexel;
uniform float uBaseW;
varying vec2 vUv;
void main() {
  vec2 o = uTexel;
  vec3 s = texture2D(tSrc, vUv + vec2(-2.0 * o.x, 0.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(2.0 * o.x, 0.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(0.0, -2.0 * o.y)).rgb;
  s += texture2D(tSrc, vUv + vec2(0.0, 2.0 * o.y)).rgb;
  s += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb * 2.0;
  s += texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb * 2.0;
  s += texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb * 2.0;
  s += texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb * 2.0;
  gl_FragColor = vec4(s / 12.0 + texture2D(tBase, vUv).rgb * uBaseW, 1.0);
}`
// scene + bloom, highlight soft-clip (shadows untouched), vignette, sRGB encode, fixed-pattern dither
const COMPOSITE_FS = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uExposure;
uniform float uVignette;
uniform vec2 uAspect;
varying vec2 vUv;
vec3 softclip(vec3 x) {
  const float k = 0.62;
  vec3 over = max(x - k, 0.0);
  return min(x, vec3(k)) + (1.0 - k) * (1.0 - exp(-over / (1.0 - k)));
}
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 c = texture2D(tScene, vUv).rgb + texture2D(tBloom, vUv).rgb * uBloom;
  c = softclip(c * uExposure);
  vec2 q = (vUv - 0.5) * uAspect;
  c *= 1.0 - uVignette * smoothstep(0.35, 1.05, length(q));
  c = toSRGB(c);
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}`

/**
 * createGlobe(THREE, renderer, opts) ->
 *   { ready: Promise<info>, renderAt(progress, w, h) -> pose, poseAt(progress) -> pose (alias cameraAt),
 *     project(lon, lat, altKm = 0) -> {x, y, visible} (pixels of the last renderAt), dispose(), credit }
 *   pose = { lat, lon (the ground point at screen centre), altKm (camera height), rangeKm, tilt (deg from
 *            straight down), bearing (deg, view direction), fov (deg on the frame's short side), progress }
 * opts: textureUrl (global equirectangular night image, required), target {lat, lon} (required),
 *       city { bbox [s, w, n, e], roads, water, green (GeoJSON FeatureCollections), line [[lon, lat]...], lineColor }
 *         (geo.json's layers + line: the real streets the lights resolve into; never pass the boundary layer),
 *       patches 'auto' | [] | [{url, bounds, fadeKm, featherDeg}],
 *       keys [{p, distKm, brg, altKm, tilt, bearing}] (the camera path, see globePath),
 *       fov (deg on the frame's short side, default 30), exposure, bloom {strength, threshold, knee},
 *       starSeed.
 * Renders with its own HalfFloat MSAA target + bloom chain and writes sRGB to the canvas (renderer.toneMapping and
 * outputColorSpace are not used); restores the renderer's render target, autoClear and clear colour afterwards.
 */
export function createGlobe(THREE, renderer, opts = {}) {
  const target = { lat: opts.target?.lat ?? 28.6139, lon: opts.target?.lon ?? 77.209 }
  const fovShort = opts.fov ?? 30
  const bloomOpt = { strength: 1, threshold: 0, knee: 0.35, ...opts.bloom } // strength scales the altitude model; threshold adds to it
  const exposure = opts.exposure ?? 1.0

  // ---------- camera path (pure function of progress)
  const { poseAt } = globePath(target, { ...opts, fov: fovShort })
  const start = poseAt(0)
  const end = poseAt(1)

  // ---------- scene
  const earthScene = new THREE.Scene()
  const starScene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(fovShort, 16 / 9, 0.01, 10)
  const starCam = new THREE.PerspectiveCamera(fovShort, 16 / 9, 0.1, 200)

  const sun = new THREE.Vector3(...llVec(start.lat - 8, start.lon + 105)).normalize() // just behind the eastern limb at the start
  const atmo = new THREE.Color(0.24, 0.5, 1.0)
  const warm = new THREE.Color(1.0, 0.62, 0.32)
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
  black.needsUpdate = true

  const earthUniforms = {
    uGlobal: { value: black },
    uPatch0: { value: black },
    uPatch1: { value: black },
    uB0: { value: new THREE.Vector4(0, 0, 1, 1) },
    uB1: { value: new THREE.Vector4(0, 0, 1, 1) },
    uW0: { value: new THREE.Vector2(1, 0) },
    uW1: { value: new THREE.Vector2(1, 0) },
    uCam: { value: new THREE.Vector3() },
    uSun: { value: sun },
    uLightGain: { value: 1.5 },
    uLightCurve: { value: 2.6 },
    uLightCol: { value: new THREE.Color(1.0, 0.68, 0.38) },
    uMoon: { value: 1 },
    uNearLook: { value: 0 },
    uBase: { value: 0.85 },
    uBoost: { value: 0.15 },
    uLand: { value: 1.1 },
    uMoonTint: { value: new THREE.Vector3(0.84, 0.92, 1.1) },
    uAtmo: { value: atmo },
    uWarm: { value: warm },
    uRim: { value: 0.2 },
    uHaze: { value: 1 },
    uGrade: { value: 0 },
    uOver: { value: black },
    uOB: { value: new THREE.Vector4(0, 0, 1, 1) },
    uOW: { value: new THREE.Vector2(1, 0) },
    uRoadCol: { value: new THREE.Color(1.0, 0.58, 0.22) },
    uLineCol: { value: new THREE.Color(opts.city?.lineColor || '#FFDF00') },
    uWaterCol: { value: new THREE.Color(0.006, 0.03, 0.035) },
    uRoadGain: { value: 0 },
    uLineGain: { value: 0 },
    uSizeG: { value: new THREE.Vector2(1, 1) },
    uSize0: { value: new THREE.Vector2(1, 1) },
    uSize1: { value: new THREE.Vector2(1, 1) },
    uSmooth: { value: 0 },
    uLod: { value: 0 },
    uNear: { value: 0.05 },
    uHazeLo: { value: new THREE.Color() },
    uHazeHi: { value: new THREE.Color() },
    uFocus: { value: new THREE.Vector4(target.lon, target.lat, 13, 24) },
  }
  const earthMat = new THREE.ShaderMaterial({ vertexShader: EARTH_VS, fragmentShader: EARTH_FS, uniforms: earthUniforms })
  const earthGeo = new THREE.SphereGeometry(1, 512, 256)
  earthScene.add(new THREE.Mesh(earthGeo, earthMat))

  const SHELL = 0.075
  const haloUniforms = {
    uCam: { value: new THREE.Vector3() },
    uSun: { value: sun },
    uAtmo: { value: atmo },
    uWarm: { value: warm },
    uShell: { value: SHELL },
    uI: { value: 0.36 },
  }
  const haloMat = new THREE.ShaderMaterial({
    vertexShader: HALO_VS,
    fragmentShader: HALO_FS,
    uniforms: haloUniforms,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const haloGeo = new THREE.SphereGeometry(1 + SHELL, 256, 128)
  earthScene.add(new THREE.Mesh(haloGeo, haloMat))

  // stars: deterministic, faint, a hint of a galactic band
  const rand = prng(opts.starSeed ?? 20161205)
  const N = 9000
  const pos = new Float32Array(N * 3)
  const size = new Float32Array(N)
  const colr = new Float32Array(N * 3)
  const band = new THREE.Vector3(0.35, 0.82, -0.45).normalize() // pole of the band's great circle
  const tmp = new THREE.Vector3()
  for (let i = 0; i < N; i++) {
    let x, y, z
    const inBand = rand() < 0.42
    for (;;) {
      z = rand() * 2 - 1
      const a = rand() * Math.PI * 2
      const r = Math.sqrt(1 - z * z)
      x = r * Math.cos(a)
      y = r * Math.sin(a)
      if (!inBand) break
      tmp.set(x, y, z)
      const off = Math.abs(tmp.dot(band))
      if (rand() < Math.exp(-((off / 0.16) ** 2))) break
    }
    pos.set([x * 100, y * 100, z * 100], i * 3)
    const m = Math.pow(rand(), inBand ? 9 : 6) // most stars faint, a few bright
    size[i] = 1.6 + m * 2.6
    const b = (inBand ? 0.05 : 0.07) + m * 0.85
    const tint = rand()
    const c = tint < 0.25 ? [0.78, 0.85, 1.0] : tint > 0.88 ? [1.0, 0.86, 0.68] : [0.95, 0.95, 1.0]
    colr.set([c[0] * b, c[1] * b, c[2] * b], i * 3)
  }
  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(colr, 3))
  const starMat = new THREE.ShaderMaterial({
    vertexShader: STAR_VS,
    fragmentShader: STAR_FS,
    uniforms: { uScale: { value: 1 }, uFade: { value: 1 } },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  })
  starScene.add(new THREE.Points(starGeo, starMat))

  // ---------- post: bloom chain + composite
  const postScene = new THREE.Scene()
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const triGeo = new THREE.BufferGeometry()
  triGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
  triGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2))
  const quad = new THREE.Mesh(triGeo)
  quad.frustumCulled = false
  postScene.add(quad)
  const mkPost = (fs, uniforms) => new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false })
  const brightMat = mkPost(BRIGHT_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: bloomOpt.threshold }, uKnee: { value: bloomOpt.knee } })
  const downMat = mkPost(DOWN_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } })
  const upMat = mkPost(UP_FS, { tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uBaseW: { value: 1 } })
  const compMat = mkPost(COMPOSITE_FS, {
    tScene: { value: null },
    tBloom: { value: null },
    uBloom: { value: bloomOpt.strength },
    uExposure: { value: exposure },
    uVignette: { value: 0.32 },
    uAspect: { value: new THREE.Vector2(1, 1) },
  })
  const LEVELS = 6
  let rts = null
  function ensureTargets(w, h) {
    if (rts && rts.w === w && rts.h === h) return rts
    disposeTargets()
    const opt = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false }
    const scene = new THREE.WebGLRenderTarget(w, h, { ...opt, depthBuffer: true, samples: 4 })
    const down = []
    const up = []
    let lw = w
    let lh = h
    for (let i = 0; i < LEVELS; i++) {
      lw = Math.max(1, Math.round(lw / 2))
      lh = Math.max(1, Math.round(lh / 2))
      down.push(new THREE.WebGLRenderTarget(lw, lh, opt))
      up.push(new THREE.WebGLRenderTarget(lw, lh, opt))
    }
    rts = { w, h, scene, down, up }
    return rts
  }
  function disposeTargets() {
    if (!rts) return
    rts.scene.dispose()
    for (const t of [...rts.down, ...rts.up]) t.dispose()
    rts = null
  }
  const pass = (mat, target) => {
    quad.material = mat
    renderer.setRenderTarget(target)
    renderer.render(postScene, postCam)
  }

  // ---------- textures
  const loader = new THREE.TextureLoader()
  const baseUrl = new URL(opts.textureUrl || 'assets/earth/earth_night_8k.jpg', document.baseURI)
  const inside = (b) => target.lon >= b[0] && target.lon <= b[2] && target.lat >= b[1] && target.lat <= b[3]
  const patchDefs = (opts.patches === undefined || opts.patches === 'auto' ? EARTH_PATCHES.map((d) => ({ ...d, url: new URL(d.file, baseUrl).href })) : opts.patches)
    .filter((d) => inside(d.bounds))
    .slice(0, 2)
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy?.() || 1)
  const prep = (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = maxAniso
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = true
    renderer.initTexture?.(tex)
    return tex
  }
  const textures = []
  let isReady = false
  const ready = (async () => {
    const [global, ...patches] = await Promise.all([loader.loadAsync(baseUrl.href), ...patchDefs.map((d) => loader.loadAsync(d.url))])
    textures.push(prep(global), ...patches.map(prep))
    earthUniforms.uGlobal.value = global
    earthUniforms.uSizeG.value.set(global.image.width, global.image.height)
    patches.forEach((tex, i) => {
      const d = patchDefs[i]
      earthUniforms[`uPatch${i}`].value = tex
      earthUniforms[`uB${i}`].value.set(...d.bounds)
      earthUniforms[`uSize${i}`].value.set(tex.image.width, tex.image.height)
    })
    // compile every program once (first frame stays as fast as the rest)
    renderer.compile(earthScene, camera)
    renderer.compile(starScene, starCam)
    for (const m of [brightMat, downMat, upMat, compMat]) {
      quad.material = m
      renderer.compile(postScene, postCam)
    }
    const over = opts.city ? rasterCity(opts.city, maxAniso) : null
    if (over) {
      textures.push(over.texture)
      earthUniforms.uOver.value = over.texture
      earthUniforms.uOB.value.set(...over.bounds)
      earthUniforms.uOW.value.set(over.featherDeg, 1)
    }
    isReady = true
    return { patches: patchDefs.map((d) => d.url), width: global.image?.width, height: global.image?.height, city: over && over.size }
  })()

  /** Rasterises real city layers (geo.json: OSM roads, water, green, the ridden line) into one data texture.
   *  r = roads (core + soft glow), g = green 0.43 / water 1.0 (max), b = the line (core + glow). Never boundaries. */
  function rasterCity(city, aniso) {
    const [s, w, n, e] = city.bbox
    const kmEW = (e - w) * 111.32 * Math.cos(((s + n) / 2) * D2R)
    const kmNS = (n - s) * 110.57
    const MAX = 4096
    const cw = kmEW >= kmNS ? MAX : Math.round((MAX * kmEW) / kmNS)
    const ch = kmEW >= kmNS ? Math.round((MAX * kmNS) / kmEW) : MAX
    const pk = cw / kmEW // px per km
    const cv = document.createElement('canvas')
    cv.width = cw
    cv.height = ch
    // willReadFrequently keeps this canvas on the CPU rasteriser: GPU canvases may rasterise the blur
    // differently from page to page, and the film's worker pages must produce identical frames
    const g = cv.getContext('2d', { willReadFrequently: true })
    g.fillStyle = '#000'
    g.fillRect(0, 0, cw, ch)
    const X = (lon) => ((lon - w) / (e - w)) * cw
    const Y = (lat) => ((n - lat) / (n - s)) * ch
    const trace = (ring, close) => {
      ring.forEach(([lon, lat], i) => (i ? g.lineTo(X(lon), Y(lat)) : g.moveTo(X(lon), Y(lat))))
      if (close) g.closePath()
    }
    const feats = (fc) => fc?.features || (Array.isArray(fc) ? fc : [])
    const linesOf = (f) => {
      const gm = f.geometry || {}
      return gm.type === 'LineString' ? [gm.coordinates] : gm.type === 'MultiLineString' ? gm.coordinates : []
    }
    const polysOf = (f) => {
      const gm = f.geometry || {}
      return gm.type === 'Polygon' ? [gm.coordinates] : gm.type === 'MultiPolygon' ? gm.coordinates : []
    }
    const fillPolys = (fc, style) => {
      g.fillStyle = style
      for (const f of feats(fc))
        for (const poly of polysOf(f)) {
          g.beginPath()
          for (const ring of poly) trace(ring, true)
          g.fill('evenodd')
        }
    }
    const stroke = (lines, style, km, blurKm = 0) => {
      g.filter = blurKm ? `blur(${(blurKm * pk).toFixed(2)}px)` : 'none'
      g.strokeStyle = style
      g.lineWidth = Math.max(1, km * pk)
      g.beginPath()
      for (const l of lines) trace(l, false)
      g.stroke()
    }
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.globalCompositeOperation = 'lighten' // per-channel max: water wins over green
    fillPolys(city.green, 'rgb(0,110,0)')
    fillPolys(city.water, 'rgb(0,255,0)')
    stroke(feats(city.water).flatMap(linesOf), 'rgb(0,255,0)', 0.05)
    g.globalCompositeOperation = 'lighter' // roads and line add into their own channels
    const roads = feats(city.roads)
    const cls = (f) => {
      const h = f.properties?.highway || f.properties?.cls || ''
      return /motorway|trunk|major/.test(h) ? 0 : /primary/.test(h) ? 1 : 2
    }
    const byCls = [0, 1, 2].map((k) => roads.filter((f) => cls(f) === k).flatMap(linesOf))
    stroke(byCls.flat(), 'rgb(46,0,0)', 0.5, 0.35)
    stroke(byCls[0], 'rgb(230,0,0)', 0.075)
    stroke(byCls[1], 'rgb(180,0,0)', 0.055)
    stroke(byCls[2], 'rgb(110,0,0)', 0.04)
    if (city.line?.length) {
      stroke([city.line], 'rgb(0,0,120)', 0.55, 0.3)
      stroke([city.line], 'rgb(0,0,255)', 0.085)
    }
    g.filter = 'none'
    g.globalCompositeOperation = 'source-over'
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.NoColorSpace
    tex.anisotropy = aniso
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.generateMipmaps = true
    renderer.initTexture?.(tex)
    return { texture: tex, bounds: [w, s, e, n], featherDeg: Math.min(e - w, n - s) * 0.06, size: [cw, ch] }
  }

  // ---------- camera setup for a pose
  const tmpV = new THREE.Vector3()
  function placeCamera(pose, w, h) {
    const aspect = w / h
    const fovY = aspect >= 1 ? fovShort : (2 * Math.atan(Math.tan((fovShort * D2R) / 2) / aspect)) / D2R
    const T = llVec(pose.lat, pose.lon)
    const { up, east, north } = enu(pose.lat, pose.lon)
    const b = pose.bearing * D2R
    const τ = pose.tilt * D2R
    const horiz = add(scale(north, Math.cos(b)), east, Math.sin(b))
    const r = pose.rangeKm / R_KM
    const C = add(T, add(scale(up, Math.cos(τ)), horiz, -Math.sin(τ)), r)
    const camUp = add(scale(up, Math.sin(τ)), horiz, Math.cos(τ))
    camera.fov = fovY
    camera.aspect = aspect
    camera.near = Math.max(0.25 * pose.altKm, 2) / R_KM
    camera.far = Math.hypot(...C) + 1 + SHELL + 0.1
    camera.position.set(...C)
    camera.up.set(...camUp)
    camera.lookAt(tmpV.set(...T))
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)
    starCam.fov = fovY
    starCam.aspect = aspect
    starCam.position.set(0, 0, 0)
    starCam.quaternion.copy(camera.quaternion)
    starCam.updateProjectionMatrix()
    starCam.updateMatrixWorld(true)
    return { fovY, C }
  }

  let last = null
  function renderAt(progress, w, h) {
    w = Math.round(w)
    h = Math.round(h)
    const size = renderer.getSize(new THREE.Vector2())
    if (size.x !== w || size.y !== h) renderer.setSize(w, h, false)
    const dbs = renderer.getDrawingBufferSize(new THREE.Vector2())
    const W = dbs.x
    const H = dbs.y
    const pose = poseAt(progress)
    const { fovY, C } = placeCamera(pose, W, H)
    last = { pose, w, h, fovY }

    const prevTarget = renderer.getRenderTarget()
    const prevAuto = renderer.autoClear
    const prevClear = renderer.getClearColor(new THREE.Color())
    const prevAlpha = renderer.getClearAlpha()
    renderer.autoClear = false
    renderer.setClearColor(0x000000, 1)
    if (!isReady) {
      renderer.setRenderTarget(null)
      renderer.clear()
    } else {
      const t = ensureTargets(W, H)
      earthUniforms.uCam.value.set(...C)
      haloUniforms.uCam.value.set(...C)
      // exposure model by altitude: far away the lights are pin-points (boost + bloom); close in they
      // fill the frame, so gain and bloom drop and the lights grade to amber under the real road network
      const la = Math.log(pose.altKm)
      const farK = smoother((la - Math.log(2500)) / (Math.log(9000) - Math.log(2500)))
      const nearK = smoother((Math.log(1800) - la) / (Math.log(1800) - Math.log(160)))
      // (unchanged above the renderer's ~260 km hand-over; below it the near-white NCR core is fully graded by
      // 150 km, so the blurred light field reads as amber pools on a dark ground, not a beige overcast)
      const gradeK = Math.max(smoother((Math.log(450) - la) / (Math.log(450) - Math.log(90))), smoother((Math.log(260) - la) / (Math.log(260) - Math.log(150))))
      // the glow dims to a slate night while the streets come up: the lights resolve into streets
      const nightK = smoother((Math.log(250) - la) / (Math.log(250) - Math.log(40)))
      // (dim light grades to the city's cool slate, full light to a warm sodium pool: no beige overcast)
      earthUniforms.uNear.value = lerp(0.22, 0.04, nightK)
      earthUniforms.uHazeLo.value.setRGB(lerp(0.35, 0.07, nightK), lerp(0.12, 0.085, nightK), lerp(0.05, 0.12, nightK))
      earthUniforms.uHazeHi.value.setRGB(lerp(1.0, 0.8, nightK), lerp(0.48, 0.46, nightK), lerp(0.14, 0.24, nightK))
      const cityK = smoother((Math.log(700) - la) / (Math.log(700) - Math.log(110)))
      // lights stay points of light on moonlit land: a modest gain (a little more far away, where a town is a
      // pixel), a steep curve on the dim diffuse glow, little bloom
      earthUniforms.uLightGain.value = lerp(lerp(1.2, 1.6, farK), 1.0, nearK)
      earthUniforms.uLightCurve.value = lerp(2.7, 2.3, nearK)
      // (the land a touch brighter from far away, where the vignette and the small disc would sink it)
      earthUniforms.uMoon.value = lerp(lerp(1.0, 1.6, farK), 0.9, nearK)
      // from ~700 km down the lights blend back to the emissive look the city's ground lights are matched to
      const nearLook = smoother((Math.log(700) - la) / (Math.log(700) - Math.log(290)))
      earthUniforms.uNearLook.value = nearLook
      earthUniforms.uBoost.value = lerp(lerp(0.9, 2.4, farK), 0.15, nearK)
      earthUniforms.uBase.value = lerp(1.2, 0.85, nearK)
      earthUniforms.uLand.value = lerp(1.35, 1.1, nearK)
      earthUniforms.uGrade.value = gradeK
      earthUniforms.uSmooth.value = smoother((Math.log(650) - la) / (Math.log(650) - Math.log(380)))
      // the 500 m crop shows its 2-texel speckle as squares from ~300 km down: read it softer from a coarser mip
      // (at the renderer's ~260 km hand-over the Delhi crop is read at lod ~0.4, at 35 km at lod 2.6 (~3 km): a glow pool)
      earthUniforms.uLod.value = smoother((Math.log(520) - la) / (Math.log(520) - Math.log(50)))
      earthUniforms.uRoadGain.value = 0.95 * cityK
      earthUniforms.uOW.value.y = smoother((Math.log(450) - la) / (Math.log(450) - Math.log(110)))
      earthUniforms.uLineGain.value = 1.6 * smoother((Math.log(220) - la) / (Math.log(220) - Math.log(45)))
      compMat.uniforms.uBloom.value = bloomOpt.strength * lerp(lerp(lerp(0.3, 0.42, farK), 0.18, nearK), lerp(lerp(0.55, 0.85, farK), 0.22, nearK), nearLook)
      brightMat.uniforms.uThreshold.value = bloomOpt.threshold + lerp(lerp(0.7, 0.8, nearK), lerp(0.55, 0.75, nearK), nearLook)
      // the rim belongs to the far view and to the horizon of a tilted view; near the ground it would only grey the lights
      const skyK = smoother((pose.tilt - 35) / 22)
      earthUniforms.uHaze.value = Math.max(clamp((pose.altKm - 150) / 2500), 0.55 * skyK * clamp((pose.altKm - 250) / 250))
      starMat.uniforms.uScale.value = Math.min(W, H) / 1080
      starMat.uniforms.uFade.value = Math.max(clamp((pose.altKm - 300) / 3000), 0.6 * skyK)
      // patches fade in with altitude
      patchDefs.forEach((d, i) => {
        const [far, near] = d.fadeKm
        earthUniforms[`uW${i}`].value.set(d.featherDeg, smoother((far - pose.altKm) / (far - near)))
      })

      renderer.setRenderTarget(t.scene)
      renderer.clear(true, true, true)
      renderer.render(starScene, starCam)
      renderer.clearDepth()
      renderer.render(earthScene, camera)

      brightMat.uniforms.tSrc.value = t.scene.texture
      brightMat.uniforms.uTexel.value.set(1 / W, 1 / H)
      pass(brightMat, t.down[0])
      for (let i = 1; i < LEVELS; i++) {
        downMat.uniforms.tSrc.value = t.down[i - 1].texture
        downMat.uniforms.uTexel.value.set(0.5 / t.down[i - 1].width, 0.5 / t.down[i - 1].height)
        pass(downMat, t.down[i])
      }
      let src = t.down[LEVELS - 1]
      for (let i = LEVELS - 2; i >= 0; i--) {
        upMat.uniforms.tSrc.value = src.texture
        upMat.uniforms.tBase.value = t.down[i].texture
        upMat.uniforms.uTexel.value.set(0.5 / src.width, 0.5 / src.height)
        pass(upMat, t.up[i])
        src = t.up[i]
      }
      compMat.uniforms.tScene.value = t.scene.texture
      compMat.uniforms.tBloom.value = t.up[0].texture
      compMat.uniforms.uAspect.value.set(W >= H ? W / H : 1, W >= H ? 1 : H / W)
      pass(compMat, null)
    }
    renderer.setRenderTarget(prevTarget)
    renderer.autoClear = prevAuto
    renderer.setClearColor(prevClear, prevAlpha)
    return last.pose
  }

  /** Screen position (pixels in the last renderAt's w x h) of lon/lat (altKm above ground). */
  function project(lon, lat, altKm = 0) {
    if (!last) return { x: 0, y: 0, visible: false }
    const P = llVec(lat, lon, 1 + altKm / R_KM)
    const C = camera.position
    const toCam = [C.x - P[0], C.y - P[1], C.z - P[2]]
    const facing = toCam[0] * P[0] + toCam[1] * P[1] + toCam[2] * P[2] > 0 // above the horizon from the camera
    const v = tmpV.set(...P).project(camera)
    const x = ((v.x + 1) / 2) * last.w
    const y = ((1 - v.y) / 2) * last.h
    return { x, y, visible: facing && v.z > -1 && v.z < 1 && x >= 0 && x <= last.w && y >= 0 && y <= last.h }
  }

  function dispose() {
    disposeTargets()
    for (const t of textures) t.dispose()
    black.dispose()
    for (const g of [earthGeo, haloGeo, starGeo, triGeo]) g.dispose()
    for (const m of [earthMat, haloMat, starMat, brightMat, downMat, upMat, compMat]) m.dispose()
  }

  return { ready, renderAt, poseAt, project, cameraAt: poseAt, dispose, credit: EARTH_CREDIT, target, end }
}
