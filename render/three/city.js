// TimeLine 3D city layer (three.js), drawn under the 2D overlay of render/renderer.js.
//
//   createCity(THREE, renderer, { geo, detail, timeline, aspect, hooks?, layout?, synthetic? })
//     -> { ready, renderAt(t, w, h, o?), project(lon, lat, alt), cameraAt(t), insetView(t, target),
//          trainAt(t), siteAnchor(id), stationAt(id), canvas }
//
// A tilted night city of real extruded OpenStreetMap buildings (build/geo_detail.json) over the base
// layers of geo.json (water, green, roads, other lines): the ridden line is a glowing gold ribbon with a
// bright train gliding along it, the landmark being narrated is lit gold from within, and the light
// warms to dawn where the train surfaces (hooks.dawnAt). Never draws administrative boundaries.
//
// Deterministic: every frame is a pure function of t (no clock; synthetic dev buildings use a seeded RNG).
// World units are metres on a local tangent plane centred on the line: x = east, y = up, z = south.
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

// ---------- math
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v)
const lerp = (a, b, u) => a + (b - a) * u
const smooth = (u) => ((u = clamp(u)), u * u * u * (u * (u * 6 - 15) + 10))
const ramp = (t, a, b) => clamp((t - a) / (b - a))
const easeInOut = (u) => ((u = clamp(u)), u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)
const env = (t, a, b, din, dout) => smooth(ramp(t, a, a + din)) * (1 - smooth(ramp(t, b - dout, b)))
const DEG = Math.PI / 180
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180
const lerpAngle = (a, b, u) => a + wrap180(b - a) * u
const rng = (seed) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0), seed / 4294967296)
const hash1 = (n) => {
  n = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35) >>> 0
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

// ---------- look (sRGB hex; dawn values blend in where the train surfaces)
const LOOK = {
  night: {
    bg: '#18202b', // fog / far haze: deep blue-grey
    ground: '#1a212b',
    green: '#252f25',
    water: '#0d2a30',
    waterSheen: '#4f8f96',
    road: '#56606e',
    roadMajor: '#7a7468',
    wall: '#59616d',
    roof: '#959dab',
    hemiSky: '#8b9cc0',
    hemiGround: '#1c1e25',
    hemi: 1.6,
    sun: '#cbbbd8', // low lavender dusk light from the west
    sunI: 1.5,
    sunDir: [-0.62, 0.42, 0.3],
    exposure: 1.0,
    bloom: 0.5,
  },
  dawn: {
    bg: '#9c919a', // pale mauve morning haze
    ground: '#57535b',
    green: '#5a5e4e', // muted olive (ACES pushes saturation up at these levels)
    water: '#36606a',
    waterSheen: '#ffd9b0',
    road: '#958c86',
    roadMajor: '#bba68a',
    wall: '#8f857f',
    roof: '#cfc2b2',
    hemiSky: '#c4c4d4',
    hemiGround: '#4d3d35',
    hemi: 1.45,
    sun: '#ffcb98', // warm sunrise from the east, low
    sunI: 2.7,
    sunDir: [0.8, 0.26, 0.1],
    exposure: 1.0,
    bloom: 0.3,
  },
}
const GOLD = '#ffc54d'
const GOLD_HOT = '#ffe7a6'

// default subject rectangle (fractions of the frame) for each aspect
const FOCUS_RECT = { '16:9': [0.33, 0.2, 0.95, 0.8], '9:16': [0.08, 0.36, 0.92, 0.68] }

export function createCity(THREE, renderer, { geo, detail = null, timeline, aspect = '16:9', hooks = {}, layout = {}, synthetic = false } = {}) {
  if (!geo?.line?.coords?.length) throw new Error('city: geo.line.coords missing')
  const PORTRAIT = aspect === '9:16'
  const W = PORTRAIT ? 1080 : 1920
  const H = PORTRAIT ? 1920 : 1080
  // vertical fov: 30 deg on the frame's short side (as the globe), so the two views match at the hand-over
  const FOV = PORTRAIT ? (2 * Math.atan(Math.tan(15 * DEG) * (16 / 9))) / DEG : 30
  const RECT = layout.focus || FOCUS_RECT[aspect] || FOCUS_RECT['16:9']
  const V3 = THREE.Vector3
  const col = (hex) => new THREE.Color(hex)

  // ---------- local metric projection centred on the line
  const lons = geo.line.coords.map((c) => c[0])
  const lats = geo.line.coords.map((c) => c[1])
  const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2
  const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2
  const phi = lat0 * DEG
  const KX = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi)
  const KZ = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi)
  const toXZ = (lon, lat) => [(lon - lon0) * KX, -(lat - lat0) * KZ]
  const toLonLat = (x, z) => [lon0 + x / KX, lat0 - z / KZ]
  const ringXZ = (ring) => {
    const out = ring.map((c) => toXZ(c[0], c[1]))
    if (out.length > 2 && Math.hypot(out[0][0] - out.at(-1)[0], out[0][1] - out.at(-1)[1]) < 0.01) out.pop()
    return out
  }

  // ---------- the ridden line (smoothed like the 2D map) and stations
  function smoothLine(pts, step) {
    const out = [pts[0]]
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p0 = pts[i - 1] || [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]]
      const p3 = pts[i + 2] || [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]]
      const t1 = Math.pow(d(p0, p1), 0.5) || 1e-4
      const t2 = t1 + (Math.pow(d(p1, p2), 0.5) || 1e-4)
      const t3 = t2 + (Math.pow(d(p2, p3), 0.5) || 1e-4)
      const n = Math.max(1, Math.ceil(d(p1, p2) / step))
      for (let k = 1; k <= n; k++) {
        const t = t1 + ((t2 - t1) * k) / n
        const m = (a, b, ta, tb) => [(a[0] * (tb - t) + b[0] * (t - ta)) / (tb - ta), (a[1] * (tb - t) + b[1] * (t - ta)) / (tb - ta)]
        const A1 = m(p0, p1, 0, t1)
        const A2 = m(p1, p2, t1, t2)
        const A3 = m(p2, p3, t2, t3)
        const B1 = m(A1, A2, 0, t2)
        const B2 = m(A2, A3, t1, t3)
        out.push(m(B1, B2, t1, t2))
      }
    }
    return out
  }
  const RAW = geo.line.coords.map((c) => toXZ(c[0], c[1]))
  const LP = smoothLine(RAW, 4)
  const CUM = [0]
  for (let i = 1; i < LP.length; i++) CUM.push(CUM[i - 1] + Math.hypot(LP[i][0] - LP[i - 1][0], LP[i][1] - LP[i - 1][1]))
  const LEN = CUM.at(-1)
  function arcIndex(s) {
    let lo = 0
    let hi = CUM.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      CUM[mid] <= s ? (lo = mid) : (hi = mid)
    }
    return lo
  }
  function pointAt(s) {
    s = clamp(s, 0, LEN)
    const i = arcIndex(s)
    const u = (s - CUM[i]) / (CUM[i + 1] - CUM[i] || 1)
    const a = LP[i]
    const b = LP[i + 1] || a
    return [lerp(a[0], b[0], u), lerp(a[1], b[1], u)]
  }
  // compass bearing (deg, clockwise from north) of a ground vector
  const bearingOf = (dx, dz) => Math.atan2(dx, -dz) / DEG
  function headingAt(s, back = 260, ahead = 520, dir = 1) {
    const a = pointAt(s - back * dir)
    const b = pointAt(s + ahead * dir)
    return bearingOf(b[0] - a[0], b[1] - a[1])
  }
  function nearestS(p) {
    let best = 0
    let bd = Infinity
    for (let i = 0; i < LP.length; i++) {
      const d = (LP[i][0] - p[0]) ** 2 + (LP[i][1] - p[1]) ** 2
      if (d < bd) (bd = d), (best = i)
    }
    return CUM[best]
  }
  const ST = geo.stations.map((st, i) => {
    const s = i === 0 ? 0 : i === geo.stations.length - 1 ? LEN : nearestS(toXZ(...(st.on_line || [st.lon, st.lat])))
    const [x, z] = pointAt(s)
    return { ...st, i, s, x, z }
  })
  const stationById = new Map(ST.map((s) => [s.id, s]))

  // ---------- sites (heritage features) in metres
  const SITES = new Map()
  for (const s of geo.sites || []) {
    const [x, z] = toXZ(s.lon, s.lat)
    const poly = s.polygon ? ringXZ(s.polygon) : null
    let r = 0
    for (const [px, pz] of poly || []) r = Math.max(r, Math.hypot(px - x, pz - z))
    SITES.set(s.id, { ...s, x, z, poly, r })
  }

  // ---------- scenes and the train schedule (same rules as renderer.js buildSchedule)
  const SCENES = (timeline?.scenes || []).map((s, i) => ({ ...s, i, D: s.end - s.start, map: s.plan?.map || null }))
  {
    const firstTo = SCENES.find((s) => stationById.has(s.map?.train_to))
    let cur = firstTo ? stationById.get(firstTo.map.train_to).s : 0
    for (const sc of SCENES) {
      sc.trainFrom = cur
      const to = stationById.get(sc.map?.train_to)
      if (to && Math.abs(to.s - cur) > 1) {
        const km = Math.abs(to.s - cur) / 1000
        const dur = clamp(1.6 + 0.5 * km, 2.4, Math.max(2.4, Math.min(8.5, 0.6 * sc.D)))
        const t0 = sc.start + 0.3
        sc.travel = { t0, t1: t0 + dur, s0: cur, s1: to.s, km, to }
        cur = to.s
      }
      sc.trainTo = cur
    }
  }
  function trainS(t) {
    let s = SCENES[0]?.trainFrom ?? 0
    for (const sc of SCENES) {
      const tr = sc.travel
      if (!tr) continue
      if (t >= tr.t1) s = tr.s1
      else {
        if (t > tr.t0) s = lerp(tr.s0, tr.s1, smooth(ramp(t, tr.t0, tr.t1)))
        break
      }
    }
    return s
  }
  const travelAt = (t) => SCENES.find((sc) => sc.travel && t >= sc.travel.t0 - 0.5 && t <= sc.travel.t1 + 0.5)?.travel || null
  const referenced = new Set(SCENES.flatMap((s) => s.map?.focus_site_ids || []))

  // ---------- renderer state
  renderer.setPixelRatio(1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  const TONE = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping
  const scene = new THREE.Scene()
  const fog = new THREE.Fog(LOOK.night.bg, 3000, 9000)
  scene.fog = fog
  scene.background = col(LOOK.night.bg)
  const camera = new THREE.PerspectiveCamera(FOV, W / H, 5, 200000)
  const fitCam = new THREE.PerspectiveCamera(FOV, W / H, 5, 200000)

  // shared uniforms for the custom shaders (fog is done by hand so additive glows fade, not tint)
  const SU = {
    uFogColor: { value: col(LOOK.night.bg) },
    uFogNear: { value: 3000 },
    uFogFar: { value: 9000 },
    uPxK: { value: H / (2 * Math.tan((FOV * DEG) / 2)) }, // pixels per radian-ish: px = metres * uPxK / distance
    // NASA Black Marble city lights on the ground, seen from altitude (the globe hands over to this)
    uLights: { value: (() => { const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); t.needsUpdate = true; return t })() },
    uLK: { value: 0 },
    uLB: { value: new THREE.Vector4(0, 0, 1, 1) },
    uGeo: { value: new THREE.Vector4(lon0, lat0, KX, KZ) },
  }

  // ---------- lights
  const hemi = new THREE.HemisphereLight(LOOK.night.hemiSky, LOOK.night.hemiGround, LOOK.night.hemi)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(LOOK.night.sun, LOOK.night.sunI)
  sun.position.set(...LOOK.night.sunDir)
  scene.add(sun)
  scene.add(sun.target)
  // soft shadows from the low light: a shadow camera that follows the view, snapped to its texels
  const SHADOW_RES = 3072
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  sun.castShadow = true
  sun.shadow.mapSize.set(SHADOW_RES, SHADOW_RES)
  sun.shadow.bias = -0.0006
  sun.shadow.normalBias = 0.8
  sun.shadow.radius = 3
  const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(4e6, 4e6).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ color: 0x03050a, opacity: 0.3, depthWrite: false }))
  shadowCatcher.receiveShadow = true
  shadowCatcher.renderOrder = -3.5
  scene.add(shadowCatcher)
  const trainLight = new THREE.PointLight(GOLD_HOT, 0, 520, 1.1)
  scene.add(trainLight)
  const siteLight = new THREE.PointLight(GOLD, 0, 650, 1.0)
  scene.add(siteLight)

  // ---------- geometry helpers
  function geomPolys(geom) {
    // -> [[outer, ...holes]] in lon/lat
    if (!geom) return []
    if (geom.type === 'Polygon') return [geom.coordinates]
    if (geom.type === 'MultiPolygon') return geom.coordinates
    return []
  }
  function geomLines(geom) {
    if (!geom) return []
    if (geom.type === 'LineString') return [geom.coordinates]
    if (geom.type === 'MultiLineString') return geom.coordinates
    if (geom.type === 'Polygon') return geom.coordinates
    if (geom.type === 'MultiPolygon') return geom.coordinates.flat(1)
    return []
  }
  const ringArea = (r) => {
    let a = 0
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]
    return a / 2
  }
  function inside(x, z, poly) {
    let c = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i]
      const [xj, zj] = poly[j]
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-12) + xi) c = !c
    }
    return c
  }
  const segDist = (px, pz, ax, az, bx, bz) => {
    const dx = bx - ax
    const dz = bz - az
    const u = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1))
    return Math.hypot(px - ax - u * dx, pz - az - u * dz)
  }
  const lineDist = (x, z) => {
    let d = Infinity
    for (let i = 0; i < RAW.length - 1; i++) d = Math.min(d, segDist(x, z, RAW[i][0], RAW[i][1], RAW[i + 1][0], RAW[i + 1][1]))
    return d
  }

  // flat polygons (triangulated) -> one geometry
  function flatGeometry(polys, y = 0) {
    const pos = []
    const idx = []
    for (const rings of polys) {
      const rs = rings.map(ringXZ).filter((r) => r.length >= 3)
      if (!rs.length) continue
      const contour = rs[0].map(([x, z]) => new THREE.Vector2(x, z))
      const holes = rs.slice(1).map((r) => r.map(([x, z]) => new THREE.Vector2(x, z)))
      let tris
      try {
        tris = THREE.ShapeUtils.triangulateShape(contour, holes)
      } catch {
        continue
      }
      const base = pos.length / 3
      for (const v of contour) pos.push(v.x, y, v.y)
      for (const h of holes) for (const v of h) pos.push(v.x, y, v.y)
      for (const t of tris) idx.push(base + t[0], base + t[1], base + t[2])
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setIndex(idx.length > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1))
    g.computeBoundingSphere()
    return g
  }

  // ribbons: centre-line vertices pushed sideways in the vertex shader (width in metres with a
  // minimum on-screen width, so lines stay legible from 2 km and from space)
  function ribbonGeometry(lines, y = 0) {
    let nv = 0
    for (const l of lines) if (l.length >= 2) nv += l.length * 2
    const pos = new Float32Array(nv * 3)
    const off = new Float32Array(nv * 2)
    const side = new Float32Array(nv)
    const dist = new Float32Array(nv)
    const idx = []
    let v = 0
    for (const l of lines) {
      if (l.length < 2) continue
      let acc = 0
      for (let i = 0; i < l.length; i++) {
        const p = l[i]
        if (i) acc += Math.hypot(p[0] - l[i - 1][0], p[1] - l[i - 1][1])
        const a = l[Math.max(0, i - 1)]
        const b = l[Math.min(l.length - 1, i + 1)]
        // segment normals around the vertex -> miter
        const n1 = i > 0 ? norm(l[i - 1], p) : norm(p, b)
        const n2 = i < l.length - 1 ? norm(p, l[i + 1]) : n1
        let mx = n1[0] + n2[0]
        let mz = n1[1] + n2[1]
        const ml = Math.hypot(mx, mz) || 1
        mx /= ml
        mz /= ml
        const k = 1 / Math.max(0.35, mx * n1[0] + mz * n1[1])
        void a
        for (const sd of [-1, 1]) {
          pos[v * 3] = p[0]
          pos[v * 3 + 1] = y
          pos[v * 3 + 2] = p[1]
          off[v * 2] = mx * k
          off[v * 2 + 1] = mz * k
          side[v] = sd
          dist[v] = acc
          v++
        }
        if (i < l.length - 1) {
          const q = v - 2
          idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2)
        }
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aOff', new THREE.BufferAttribute(off, 2))
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
    g.setAttribute('aDist', new THREE.BufferAttribute(dist, 1))
    g.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1))
    g.computeBoundingSphere()
    return g
  }
  function norm(a, b) {
    const dx = b[0] - a[0]
    const dz = b[1] - a[1]
    const l = Math.hypot(dx, dz) || 1
    return [-dz / l, dx / l]
  }

  const FOG_GLSL = `
    uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
    float fogF(float d) { return smoothstep(uFogNear, uFogFar, d); }`
  // kind: 0 solid (soft edge), 1 gaussian glow (additive), 2 the ridden line (ridden / ahead / trail)
  function ribbonMaterial({ color, opacity = 1, halfW = 5, minPx = 1, kind = 0, dash = 0, additive = false, intensity = 1 }) {
    return new THREE.ShaderMaterial({
      uniforms: {
        ...SU,
        uColor: { value: col(color) },
        uOpacity: { value: opacity },
        uHalfW: { value: halfW },
        uMinPx: { value: minPx },
        uDash: { value: dash },
        uIntensity: { value: intensity },
        uTrainS: { value: 0 },
        uTrail: { value: 0 },
        uAhead: { value: 0.32 },
        uHot: { value: col(GOLD_HOT) },
      },
      vertexShader: `
        attribute vec2 aOff; attribute float aSide; attribute float aDist;
        uniform float uHalfW, uMinPx, uPxK;
        varying float vSide; varying float vDist; varying float vDepth;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          float mpp = distance(cameraPosition, wp.xyz) / uPxK;
          float hw = max(uHalfW, 0.5 * uMinPx * mpp);
          wp.xz += aOff * aSide * hw;
          vSide = aSide; vDist = aDist;
          vec4 mv = viewMatrix * wp;
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        ${FOG_GLSL}
        uniform vec3 uColor; uniform vec3 uHot; uniform float uOpacity, uDash, uIntensity, uTrainS, uTrail, uAhead;
        varying float vSide; varying float vDist; varying float vDepth;
        void main() {
          float e = abs(vSide);
          float a = uOpacity;
          vec3 c = uColor * uIntensity;
          #if KIND == 1
            a *= exp(-e * e * 3.2) * (1.0 - smoothstep(0.85, 1.0, e));
          #else
            a *= 1.0 - smoothstep(0.6, 1.0, e);
          #endif
          #if KIND == 2
            float ridden = step(vDist, uTrainS);
            float behind = uTrainS - vDist;
            float trail = uTrail > 1.0 ? exp(-pow(max(behind, 0.0) / uTrail, 2.0)) * ridden : 0.0;
            a *= mix(uAhead, 1.0, ridden);
            c = mix(c * mix(0.55, 1.0, ridden), uHot * uIntensity * 1.35, trail * 0.85);
          #endif
          if (uDash > 0.0 && fract(vDist / uDash) > 0.5) discard;
          float f = fogF(vDepth);
          #if ADDITIVE == 1
            a *= 1.0 - f;
          #else
            c = mix(c, uFogColor, f);
          #endif
          gl_FragColor = vec4(c, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      defines: { KIND: kind, ADDITIVE: additive ? 1 : 0 },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    })
  }
  // flat polygon material with hand-rolled fog (opaque layers on the ground)
  function flatMaterial(color, { opacity = 1, sheen = null, lights = false } = {}) {
    return new THREE.ShaderMaterial({
      defines: lights ? { LIGHTS: 1 } : {},
      uniforms: { ...SU, uColor: { value: col(color) }, uOpacity: { value: opacity }, uSheen: { value: col(sheen || color) }, uSheenK: { value: sheen ? 1 : 0 } },
      vertexShader: `
        varying float vDepth; varying vec3 vW;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          vec4 mv = viewMatrix * wp;
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        ${FOG_GLSL}
        uniform vec3 uColor; uniform vec3 uSheen; uniform float uOpacity, uSheenK;
        uniform sampler2D uLights; uniform float uLK; uniform vec4 uLB; uniform vec4 uGeo;
        varying float vDepth; varying vec3 vW;
        void main() {
          vec3 c = uColor;
          #ifdef LIGHTS
          if (uLK > 0.001) {
            float lon = uGeo.x + vW.x / uGeo.z;
            float lat = uGeo.y - vW.z / uGeo.w;
            vec2 uv = vec2((lon - uLB.x) / (uLB.z - uLB.x), (lat - uLB.y) / (uLB.w - uLB.y));
            float inb = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
            // a small tent blur: 500 m satellite texels must not read as squares when magnified
            vec2 ts = 0.8 / vec2(textureSize(uLights, 0));
            vec2 q = clamp(uv, 0.0, 1.0);
            vec3 L = 0.36 * texture2D(uLights, q).rgb + 0.16 * (texture2D(uLights, q + vec2(ts.x, ts.y)).rgb + texture2D(uLights, q + vec2(-ts.x, ts.y)).rgb + texture2D(uLights, q + vec2(ts.x, -ts.y)).rgb + texture2D(uLights, q - ts).rgb);
            // gain/tint matched to the globe's lights at the hand-over (whiter, not a blown orange blob)
            // (squared by luminance, not per channel, so the hue is not pushed to orange)
            c += L * dot(L, vec3(0.2126, 0.7152, 0.0722)) * vec3(1.0, 0.92, 0.78) * uLK * 0.6 * inb;
          }
          #endif
          if (uSheenK > 0.0) {
            // a faint sheen: brighter toward grazing angles, with a slow ripple (static: a function of position)
            vec3 v = normalize(cameraPosition - vW);
            float graze = pow(1.0 - clamp(v.y, 0.0, 1.0), 3.0);
            float rip = 0.5 + 0.5 * sin(vW.x * 0.021 + sin(vW.z * 0.013) * 2.0) * sin(vW.z * 0.017 - vW.x * 0.006);
            c = mix(c, uSheen, uSheenK * (0.10 + 0.32 * graze) * (0.65 + 0.35 * rip));
          }
          c = mix(c, uFogColor, fogF(vDepth));
          gl_FragColor = vec4(c, uOpacity);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: opacity < 1,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  }
  // soft radial glow lying on the ground (additive)
  function glowDisc(radius, color, minPx = 0) {
    const g = new THREE.PlaneGeometry(2, 2)
    g.rotateX(-Math.PI / 2)
    const m = new THREE.ShaderMaterial({
      uniforms: { ...SU, uColor: { value: col(color) }, uOpacity: { value: 0 }, uR: { value: radius }, uMinPx: { value: minPx } },
      vertexShader: `
        uniform float uR, uMinPx, uPxK;
        varying vec2 vUv; varying float vDepth;
        void main() {
          vec4 c = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float mpp = distance(cameraPosition, c.xyz) / uPxK;
          float r = max(uR, uMinPx * mpp);
          vec4 wp = c + vec4(position.x * r, 0.0, position.z * r, 0.0);
          vUv = position.xz;
          vec4 mv = viewMatrix * wp;
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        ${FOG_GLSL}
        uniform vec3 uColor; uniform float uOpacity;
        varying vec2 vUv; varying float vDepth;
        void main() {
          float d = length(vUv);
          float a = uOpacity * (exp(-d * d * 4.5) - 0.011) * (1.0 - fogF(vDepth));
          if (a <= 0.0) discard;
          gl_FragColor = vec4(uColor, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    })
    const mesh = new THREE.Mesh(g, m)
    mesh.frustumCulled = false
    return mesh
  }

  // ---------- ground and base layers (geo.json); the admin boundary layer is never drawn
  const mats = {}
  const L = geo.layers || {}
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4e6, 4e6).rotateX(-Math.PI / 2), (mats.ground = flatMaterial(LOOK.night.ground, { lights: true })))
  ground.renderOrder = -10
  scene.add(ground)
  // geo.json base layers + the corridor detail (parks, gardens, ponds) from geo_detail.json
  const greenPolys = [...(L.green?.features || []), ...(detail?.green?.features || [])].flatMap((f) => geomPolys(f.geometry))
  const green = new THREE.Mesh(flatGeometry(greenPolys), (mats.green = flatMaterial(LOOK.night.green, { lights: true })))
  green.renderOrder = -9
  scene.add(green)
  const waterPolys = [...(L.water?.features || []), ...(detail?.water?.features || [])].flatMap((f) => geomPolys(f.geometry))
  const water = new THREE.Mesh(flatGeometry(waterPolys), (mats.water = flatMaterial(LOOK.night.water, { sheen: LOOK.night.waterSheen, lights: true })))
  water.renderOrder = -8
  scene.add(water)
  const waterLines = (kind) => (L.water?.features || []).filter((f) => !/Polygon/.test(f.geometry?.type) && (kind === 'river' ? f.properties?.kind === 'river' : f.properties?.kind !== 'river')).flatMap((f) => geomLines(f.geometry).map((l) => l.map((c) => toXZ(c[0], c[1]))))
  const addRibbon = (lines, matOpts, order) => {
    if (!lines.length) return null
    const m = new THREE.Mesh(ribbonGeometry(lines), ribbonMaterial(matOpts))
    m.renderOrder = order
    m.frustumCulled = false
    scene.add(m)
    return m
  }
  mats.river = addRibbon(waterLines('river'), { color: LOOK.night.water, halfW: 45, minPx: 2.2, opacity: 1 }, -7)?.material
  mats.canal = addRibbon(waterLines('canal'), { color: LOOK.night.water, halfW: 5, minPx: 1.2, opacity: 0.9 }, -7)?.material

  // streets: geo_detail streets when present (major/minor/path/rail), plus geo.json's arterial roads
  const roadLines = (feats, pred) => feats.filter(pred).flatMap((f) => geomLines(f.geometry).map((l) => l.map((c) => toXZ(c[0], c[1]))))
  const roadsGeo = L.roads?.features || []
  const streets = detail?.streets?.features || []
  const roadMats = []
  const roadLayer = (lines, o, order, major = false) => {
    const m = addRibbon(lines, { color: major ? LOOK.night.roadMajor : LOOK.night.road, ...o }, order)
    if (m) roadMats.push({ m: m.material, major, base: o.opacity })
  }
  roadLayer(roadLines(streets, (f) => f.properties?.cls === 'path'), { halfW: 1.4, minPx: 0.5, opacity: 0.16 }, -6)
  roadLayer(roadLines(streets, (f) => f.properties?.cls === 'minor'), { halfW: 3.6, minPx: 0.8, opacity: 0.36 }, -6)
  roadLayer(roadLines(streets, (f) => f.properties?.cls === 'major'), { halfW: 7, minPx: 1.3, opacity: 0.42 }, -5, true)
  roadLayer(roadLines(roadsGeo, (f) => f.properties?.highway === 'primary'), { halfW: 7, minPx: 1.1, opacity: streets.length ? 0.3 : 0.38 }, -5, true)
  roadLayer(roadLines(roadsGeo, (f) => f.properties?.highway === 'trunk'), { halfW: 9, minPx: 1.4, opacity: 0.42 }, -5, true)
  roadLayer(roadLines(roadsGeo, (f) => f.properties?.highway === 'motorway'), { halfW: 11, minPx: 1.8, opacity: 0.5 }, -5, true)
  const rail = addRibbon(roadLines(streets, (f) => f.properties?.cls === 'rail'), { color: '#7d7a76', halfW: 2.2, minPx: 1, opacity: 0.3, dash: 26 }, -5)
  // other metro lines: faint, in their own colours (the ridden line's unridden ends in gold)
  for (const f of L.other_lines?.features || []) {
    const lines = geomLines(f.geometry).map((l) => l.map((c) => toXZ(c[0], c[1])))
    const cur = !!f.properties?.current
    const m = addRibbon(lines, { color: cur ? geo.line.color || GOLD : f.properties?.color || '#888', halfW: 5, minPx: 1.6, opacity: cur ? 0.32 : 0.22 }, -4)
    if (m) roadMats.push({ m: m.material, other: true, base: cur ? 0.32 : 0.22 })
  }
  void rail

  // ---------- buildings: merged per spatial tile (frustum-culled), vertex-coloured, Lambert-lit.
  // Each building reads as what it is: its OSM tags (geo_detail look tags), its land use (`lu`) and, for an
  // untyped building=yes, its neighbourhood (footprint, height, local building cover) pick a class; the
  // class picks a day palette (honouring building:colour / roof:colour), toned down for the night with a
  // per-building jitter, and the material adds procedural windows (a share lit by storey), floodlit civic
  // and heritage facades, a darker base and a light parapet line. Domes and pitched roofs where
  // roof:shape says so. Everything is a pure function of the data (hashes of OSM ids), never of time.
  const TILE = 640
  const CLASSES = ['other', 'res', 'bung', 'com', 'off', 'civic', 'inst', 'rel', 'hist', 'ind', 'trans', 'fill', 'util', 'hotel']
  const CI = Object.fromEntries(CLASSES.map((k, i) => [k, i]))
  const RES_WALL = ['#e9e3d5', '#e6d9c0', '#d9ccb2', '#cfc9bd', '#d4a184', '#d8b884', '#dec5bb', '#c8c6c1', '#ecebe6', '#d1bd9c', '#bfc4c9', '#e2cfae']
  const RES_ROOF = ['#bdb9b2', '#c6bcac', '#a9a39a', '#d8d5ce', '#b48f7c', '#a19d98', '#c2bab0', '#b3b6b8']
  const COOL_ROOF = ['#a9adb2', '#9ea5ad', '#b5b7b9', '#8f969e']
  // wall/roof: sRGB day albedo; lvh: storey height (m); win: [duty across, duty up, share lit, glass
  // darkening]; light: window light (sRGB) x gain; flood: floodlit facade strength
  const STYLE = {
    other: { wall: RES_WALL, roof: RES_ROOF, lvh: 3.2, win: [0.38, 0.42, 0.24, 0.3], light: '#ffc274', gain: 0.8, flood: 0 },
    res: { wall: RES_WALL, roof: RES_ROOF, lvh: 3.1, win: [0.36, 0.42, 0.26, 0.3], light: '#ffc070', gain: 0.8, flood: 0 },
    bung: { wall: ['#f0ebe1', '#e9dcc3', '#e4d6ba', '#ded7c9', '#ead9bd'], roof: ['#d6d1c6', '#cfc7b8', '#c4bcae'], lvh: 3.6, win: [0.3, 0.46, 0.28, 0.3], light: '#ffc983', gain: 0.8, flood: 0 },
    com: { wall: ['#aab3bf', '#97a3b2', '#b9bcbf', '#8fa1b5', '#b5ada3', '#c4c5c4'], roof: COOL_ROOF, lvh: 3.6, win: [0.55, 0.5, 0.3, 0.42], light: '#ffdcaa', gain: 0.85, flood: 0 },
    off: { wall: ['#8ea4ba', '#7f96ae', '#9badbc', '#a7b3be'], roof: COOL_ROOF, lvh: 3.5, win: [0.72, 0.62, 0.34, 0.55], light: '#d5e3ff', gain: 0.75, flood: 0 },
    civic: { wall: ['#e0cba6', '#dbc29c', '#e4d3b4', '#d8c09c'], base: '#a5553e', roof: ['#cfc6b6', '#c9bfae', '#d3cbbd'], lvh: 4.6, win: [0.34, 0.5, 0.18, 0.32], light: '#ffd296', gain: 0.75, flood: 0.3 },
    inst: { wall: ['#b86a4f', '#dbc5a2', '#cba27a', '#e6e0d4', '#c98a6a'], roof: ['#c4b49c', '#b8ada0', '#cbc3b5'], lvh: 4.0, win: [0.42, 0.48, 0.22, 0.32], light: '#ffdfb0', gain: 0.75, flood: 0.08 },
    rel: { wall: ['#f3efe7', '#efe4cc', '#ece8e0', '#f1e2c4'], roof: ['#ece8e0', '#e6dcc8'], lvh: 4.5, win: [0, 0, 0, 0], light: '#ffd9a0', gain: 0, flood: 0.45 },
    hist: { wall: ['#a46c5a', '#aa826e', '#9e9282', '#a89e8e'], roof: ['#a47e6c', '#a39a8c'], lvh: 4.5, win: [0, 0, 0, 0], light: '#ffd9a0', gain: 0, flood: 0.3 },
    ind: { wall: ['#908f8a', '#878b89', '#9c988f'], roof: ['#9a9da0', '#8c9196', '#a3a29c'], lvh: 6, win: [0.3, 0.25, 0.1, 0.2], light: '#e6eeff', gain: 0.7, flood: 0 },
    trans: { wall: ['#aaaeb2', '#9aa0a7'], roof: COOL_ROOF, lvh: 5, win: [0.7, 0.4, 0.5, 0.4], light: '#fff0d4', gain: 0.85, flood: 0 },
    fill: { wall: RES_WALL, roof: RES_ROOF, lvh: 3.1, win: [0.34, 0.42, 0.22, 0.3], light: '#ffc070', gain: 0.75, flood: 0 },
    util: { wall: ['#8e8a83', '#99948b'], roof: ['#9a958d', '#8d8a85'], lvh: 3.2, win: [0, 0, 0, 0], light: '#ffc274', gain: 0, flood: 0 },
    hotel: { wall: ['#e3d6c0', '#bac3cd', '#d8c5a9'], roof: COOL_ROOF, lvh: 3.2, win: [0.42, 0.5, 0.4, 0.35], light: '#ffcf8a', gain: 0.85, flood: 0.1 },
  }
  const hashStr = (s) => {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
    return hash1(h)
  }
  const lumOf = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  // day albedo -> night vertex colour: lightness compressed toward a target, saturation lifted so the
  // warm stone survives the blue moonlight
  function nightTone(hex, target, k, sat, jit) {
    const c = col(hex)
    const L = Math.max(1e-4, lumOf(c))
    const g = L
    c.r = Math.max(0, g + (c.r - g) * sat)
    c.g = Math.max(0, g + (c.g - g) * sat)
    c.b = Math.max(0, g + (c.b - g) * sat)
    const Lo = target * Math.pow(L / 0.42, k) * jit
    c.multiplyScalar(Lo / Math.max(1e-4, lumOf(c)))
    return c
  }
  const WALL_L = 0.105
  const ROOF_L = 0.25
  const pick = (arr, u) => arr[Math.min(arr.length - 1, Math.floor(u * arr.length))]

  // local building cover (share of ground under buildings within ~100 m): reads the neighbourhood
  const COVER_CELL = 40
  const coverGrid = new Map()
  const ck = (i, j) => i * 100003 + j
  function coverAt(x, z) {
    const i0 = Math.floor(x / COVER_CELL)
    const j0 = Math.floor(z / COVER_CELL)
    let s = 0
    for (let i = i0 - 2; i <= i0 + 2; i++) for (let j = j0 - 2; j <= j0 + 2; j++) s += coverGrid.get(ck(i, j)) || 0
    return s / (5 * COVER_CELL) ** 2
  }

  /** class of a building from its look tags, land use and neighbourhood */
  function classify(b, area, cover, u) {
    const p = b.p || {}
    const k = String(p.k || '')
    const use = String(p.use || '')
    const am = String(p.am || '')
    const lu = String(p.lu || '')
    if (b.fill) return lu === 'commercial' || lu === 'retail' ? 'com' : 'fill'
    if (/^(roof|toilets|construction|kiosk|container|carport|garage|garages|shed|hut|cabin|service|transformer_tower|gazebo|shelter|bunker|parking)$/.test(k) || am === 'shelter' || am === 'toilets') return 'util'
    if (p.hist || /^(ruins|fort|tomb|mausoleum|city_gate|gate|castle|monument|wall)$/.test(k)) return 'hist'
    if (/^(mosque|temple|church|cathedral|chapel|shrine|gurudwara|gurdwara|synagogue|monastery|mandir|religious)$/.test(k) || am === 'place_of_worship' || (p.rel && !am) || use === 'religious' || lu === 'religious') return 'rel'
    if (/^(hotel)$/.test(k) || /^(hotel|guest_house|hostel)$/.test(p.tour || '') || use === 'hotel') return 'hotel'
    if (p.off === 'government' || p.gov || /^(government|public|civic|courthouse|townhall|parliament)$/.test(k) || /^(townhall|courthouse|public_building|police|fire_station|post_office|library|conference_centre|community_centre|embassy)$/.test(am) || use === 'government' || p.off === 'diplomatic' || lu === 'military') return 'civic'
    if (/^(school|college|university|kindergarten|hospital|clinic|museum)$/.test(k) || /^(school|college|university|hospital|clinic|prep_school|arts_centre|theatre|planetarium|social_facility|cinema)$/.test(am) || /^(education|hospital|gathering)$/.test(use) || /^(education|institutional)$/.test(lu) || p.tour === 'museum') return 'inst'
    if (/^(industrial|warehouse|manufacture|factory|hangar|storage_tank)$/.test(k) || lu === 'industrial' || p.mm) return 'ind'
    if (/^(train_station|transportation|station)$/.test(k) || lu === 'railway') return 'trans'
    if (/^(office)$/.test(k) || use === 'office' || (p.off && p.off !== 'government')) return 'off'
    if (/^(commercial|retail|supermarket|mall)$/.test(k) || /^(commercial|retail)$/.test(use) || p.shop || /^(commercial|retail)$/.test(lu)) return b.h > 30 && u < 0.6 ? 'off' : 'com'
    if (/^(apartments|residential|house|detached|semidetached_house|terrace|bungalow|villa|dormitory)$/.test(k) || use === 'residential' || lu === 'residential') return cover < 0.14 && area > 150 && area < 2500 && b.h < 13 ? 'bung' : 'res'
    // untyped building=yes: read the neighbourhood
    if (b.h > 34) return u < 0.55 ? 'off' : 'res'
    if (area > 2500 && cover < 0.32) return u < 0.7 ? 'inst' : 'com'
    if (cover < 0.13 && area > 120 && b.h < 13) return 'bung'
    if (area > 900 && u < 0.3) return 'com'
    return 'res'
  }

  /** walls / roof / lower band colours, class and storey height of one building */
  function lookOf(b, area, cover) {
    const id = b.p?.osm_id || `${Math.round(b.ring[0][0] * 10)},${Math.round(b.ring[0][1] * 10)}`
    const u = hashStr(id)
    const u2 = hashStr(id + '#')
    const u3 = hashStr(id + '%')
    const cls = classify(b, area, cover, u)
    const S = STYLE[cls]
    const jit = 0.88 + 0.24 * u3
    const ownWall = b.p?.col
    const wallHex = ownWall || pick(S.wall, u2)
    const wall = nightTone(wallHex, WALL_L, 0.55, ownWall ? 0.95 : 1.05, jit)
    if (ownWall) wall.lerp(nightTone(pick(S.wall, u2), WALL_L, 0.55, 1.05, jit), 0.25) // honoured, softened toward the class
    const roofHex = b.p?.rcol || (cls === 'rel' || cls === 'hist' || cls === 'civic' ? pick(S.roof, u3) : pick(S.roof, (u2 * 7.31) % 1))
    const roof = nightTone(roofHex, ROOF_L, 0.5, 0.95, 0.9 + 0.2 * u)
    // a whisper of the wall's hue on concrete roofs
    if (!b.p?.rcol) roof.lerp(wall.clone().multiplyScalar(ROOF_L / Math.max(1e-4, lumOf(wall))), 0.1)
    // Lutyens: red sandstone plinth under cream sandstone (civic buildings of some size)
    let base = null
    let band = 0
    if (cls === 'civic' && !ownWall && b.h > 7 && area > 400) {
      base = nightTone(S.base, WALL_L, 0.55, 1.15, jit)
      band = Math.min(b.h * 0.3, 4.6 + 1.5 * u3)
    }
    if (b.fill) {
      wall.multiplyScalar(0.84)
      roof.multiplyScalar(0.86)
    }
    if (b.plinth) {
      // the raised courtyard under a building drawn by its parts: paving, a step darker than the roofs
      roof.lerp(groundC, 0.35)
      wall.lerp(groundC, 0.2)
    }
    const lv = +b.p?.lv
    const lvh = lv > 0 && b.h > 2 ? clamp(b.h / lv, 2.6, 6) : S.lvh * (0.94 + 0.12 * u3)
    return { cls, ci: CI[cls], wall, roof, base, band, lvh, seed: Math.floor(u3 * 255), windows: S.win[2] > 0 }
  }

  // ---------- roof shapes (approximate): domes, onions, pyramids, hipped and gabled roofs
  function centroidOf(ring) {
    let a = 0
    let cx = 0
    let cz = 0
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
      a += f
      cx += (ring[j][0] + ring[i][0]) * f
      cz += (ring[j][1] + ring[i][1]) * f
    }
    if (Math.abs(a) < 1e-6) {
      cx = cz = 0
      for (const p of ring) (cx += p[0]), (cz += p[1])
      return [cx / ring.length, cz / ring.length]
    }
    return [cx / (3 * a), cz / (3 * a)]
  }
  function obb(ring) {
    // minimum-area rectangle over the ring's edge directions: { c, ux, uz, hl, hw } (half length >= half width)
    let best = null
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      const l = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (l < 0.5) continue
      const ux = (b[0] - a[0]) / l
      const uz = (b[1] - a[1]) / l
      let s0 = Infinity
      let s1 = -Infinity
      let t0 = Infinity
      let t1 = -Infinity
      for (const p of ring) {
        const s = p[0] * ux + p[1] * uz
        const t = -p[0] * uz + p[1] * ux
        s0 = Math.min(s0, s)
        s1 = Math.max(s1, s)
        t0 = Math.min(t0, t)
        t1 = Math.max(t1, t)
      }
      const area = (s1 - s0) * (t1 - t0)
      if (!best || area < best.area) best = { area, ux, uz, s: (s0 + s1) / 2, t: (t0 + t1) / 2, hs: (s1 - s0) / 2, ht: (t1 - t0) / 2 }
    }
    if (!best) return null
    let { ux, uz, hs, ht } = best
    const c = [best.s * ux - best.t * uz, best.s * uz + best.t * ux]
    if (ht > hs) {
      // the long axis along u
      ;[ux, uz] = [-uz, ux]
      ;[hs, ht] = [ht, hs]
    }
    return { c, ux, uz, hl: hs, hw: ht, area: best.area }
  }
  /** -> { top (wall top), tris: [[x,y,z, x,y,z, x,y,z], ...] flat-shaded, smooth: {pos, nor, idx} } or null */
  function roofShapeOf(b) {
    const shape = b.p?.roof
    if (!shape || b.synthetic) return null
    const ring = b.ring
    const area = Math.abs(ringArea(ring))
    if (area < 12) return null
    const h0 = b.min_h
    const total = b.p?.h_src === 'height' // OSM height includes the roof: the walls stop below it
    const [cx, cz] = centroidOf(ring)
    if (/^(dome|onion|round)$/.test(shape)) {
      let r = Infinity
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]
        const q = ring[(i + 1) % ring.length]
        r = Math.min(r, segDist(cx, cz, a[0], a[1], q[0], q[1]))
      }
      if (!(r > 0.6)) return null
      r *= 0.97
      const onion = shape === 'onion'
      let rh = b.p.roof_h || (onion ? r * 1.6 : r * 0.95)
      let top = total ? Math.max(h0 + 1, b.h - rh) : b.h
      if (total) rh = b.h - top
      const prof = onion
        ? [[1, 0], [1.13, 0.16], [1.16, 0.3], [1.06, 0.48], [0.8, 0.66], [0.48, 0.8], [0.2, 0.9], [0.06, 0.97], [0, 1]]
        : [[1, 0], [0.97, 0.25], [0.87, 0.5], [0.71, 0.7], [0.5, 0.86], [0.26, 0.97], [0, 1]]
      const seg = 16
      const pos = []
      const nor = []
      const idx = []
      for (let k = 0; k < prof.length; k++) {
        const [pr, py] = prof[k]
        const pa = prof[Math.max(0, k - 1)]
        const pb = prof[Math.min(prof.length - 1, k + 1)]
        // profile tangent (radius, height in metres) -> outward normal in the profile plane
        const tr = (pb[0] - pa[0]) * r
        const ty = (pb[1] - pa[1]) * rh
        let nr = ty
        let ny = -tr
        const nl = Math.hypot(nr, ny) || 1
        nr /= nl
        ny /= nl
        for (let s = 0; s < seg; s++) {
          const a = (s / seg) * Math.PI * 2
          pos.push(cx + Math.cos(a) * pr * r, top + py * rh, cz + Math.sin(a) * pr * r)
          nor.push(Math.cos(a) * nr, ny, Math.sin(a) * nr)
        }
      }
      for (let k = 0; k < prof.length - 1; k++)
        for (let s = 0; s < seg; s++) {
          const a = k * seg + s
          const b2 = k * seg + ((s + 1) % seg)
          idx.push(a, a + seg, b2, b2, a + seg, b2 + seg)
        }
      return { top, smooth: { pos, nor, idx }, tris: [] }
    }
    if (/^(pyramidal|hipped|gabled|half-hipped|gambrel|mansard)$/.test(shape)) {
      const o = obb(ring)
      if (!o) return null
      const fillRatio = area / o.area
      let rh = b.p.roof_h || clamp(o.hw * (shape === 'pyramidal' ? 0.9 : 0.75), 1.2, 7)
      let top = total ? Math.max(h0 + 1, b.h - rh) : b.h
      if (total) rh = b.h - top
      const y1 = top + rh
      const tris = []
      if (shape === 'pyramidal' || fillRatio < 0.72) {
        // a pyramid over the footprint (star-shaped footprints only look right; fine for towers and kiosks)
        if (shape !== 'pyramidal' && fillRatio < 0.72) return null
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]
          const q = ring[(i + 1) % ring.length]
          tris.push([a[0], top, a[1], q[0], top, q[1], cx, y1, cz])
        }
        return { top, tris }
      }
      // a box roof on the minimum rectangle: eaves at the wall top, a ridge along the long axis
      const { c, ux, uz, hl, hw } = o
      const P = (s, t, y) => [c[0] + ux * s - uz * t, y, c[1] + uz * s + ux * t]
      const ridge = shape === 'gabled' ? hl : Math.max(0, hl - hw)
      const E = [P(-hl, -hw, top), P(hl, -hw, top), P(hl, hw, top), P(-hl, hw, top)]
      const R0 = P(-ridge, 0, y1)
      const R1 = P(ridge, 0, y1)
      const T = (a, b2, d) => tris.push([...a, ...b2, ...d])
      // the two long slopes
      T(E[0], E[1], R1)
      T(E[0], R1, R0)
      T(E[2], E[3], R0)
      T(E[2], R0, R1)
      // the ends: hips or gable walls
      T(E[1], E[2], R1)
      T(E[3], E[0], R0)
      return { top, tris, gable: shape === 'gabled' }
    }
    return null
  }

  const bldUniforms = {
    uNight: { value: 1 },
    uWin: { value: CLASSES.map((k) => new THREE.Vector4(...STYLE[k].win)) },
    uWinC: {
      value: CLASSES.map((k) => {
        const c = col(STYLE[k].light).multiplyScalar(STYLE[k].gain)
        return new THREE.Vector4(c.r, c.g, c.b, STYLE[k].flood)
      }),
    },
  }
  const bldMat = new THREE.MeshLambertMaterial({ vertexColors: true })
  bldMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, bldUniforms)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aW; attribute vec4 aB;
        varying vec2 vWin; varying vec4 vBld; varying float vY;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vWin = aW; vBld = aB; vY = position.y;`)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight; uniform vec4 uWin[${CLASSES.length}]; uniform vec4 uWinC[${CLASSES.length}];
        varying vec2 vWin; varying vec4 vBld; varying float vY;
        // a box-filtered pulse train (duty d centred in each unit cell): windows that never alias
        float pInt(float x, float d) { return floor(x) * d + clamp(fract(x) - 0.5 + 0.5 * d, 0.0, d); }
        float pulse(float x, float w, float d) { return (pInt(x + 0.5 * w, d) - pInt(x - 0.5 * w, d)) / w; }
        float h12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 cityE = vec3(0.0);
        if (vWin.x > -3.0) {
          // a wall: windows by storey, darker toward the street, a light parapet line on top
          int ci = int(vBld.x + 0.5);
          vec4 ws = uWin[ci];
          vec4 wc = uWinC[ci];
          float seed = vBld.y / 255.0;
          float lvh = max(vBld.z / 20.0, 2.4);
          float fade = vBld.w / 255.0;
          float top = vWin.y;
          float yf = clamp(vY / max(top, 1.0), 0.0, 1.0);
          float fy = max(fwidth(vY), 1e-3);
          float cap = clamp((vY - (top - 0.5)) / fy + 0.5, 0.0, 1.0);
          diffuseColor.rgb *= mix(0.5, 1.0, smoothstep(0.0, 4.5, vY)) * (0.9 + 0.14 * yf) * (1.0 + 0.32 * cap);
          if (vWin.x >= 0.0 && ws.z > 0.0) {
            vec2 g = vec2(vWin.x, vY / lvh);
            vec2 fw = max(fwidth(g), vec2(1e-4));
            vec2 cell = floor(g);
            float dx = ws.x;
            float dy = ws.y;
            float lp = ws.z * (0.3 + 1.4 * fract(seed * 7.13 + 0.17));
            #if 1
            if ((ci == ${CI.com} || ci == ${CI.hotel}) && cell.y < 0.5) { dx = 0.84; dy = 0.6; lp = 0.8; }  // shop fronts
            #endif
            float m = pulse(g.x, fw.x, dx) * pulse(g.y - 0.04, fw.y, dy);
            m *= step((cell.y + 0.54 + 0.5 * dy) * lvh, top - 0.3);   // the parapet cuts no window
            float r1 = h12(cell + seed * 113.0 + 0.5);
            float r2 = h12(cell.yx * 1.7 + seed * 71.0 + 5.3);
            float on = step(r1, lp);
            vec3 lc = mix(wc.rgb, vec3(dot(wc.rgb, vec3(0.3333))) * vec3(0.82, 0.95, 1.18), step(0.86, r2) * 0.8);
            float far = smoothstep(0.32, 0.85, max(fw.x, fw.y));
            float glass = mix(m, dx * dy, far);
            diffuseColor.rgb *= 1.0 - ws.w * glass;
            cityE = mix(m * on * (0.5 + 0.95 * r2) * lc, dx * dy * lp * 0.97 * wc.rgb, far) * uNight * fade;
          }
          // floodlit civic and heritage facades: warm light from below
          cityE += diffuseColor.rgb * wc.a * vec3(1.0, 0.84, 0.66) * (1.0 - 0.6 * yf) * uNight * fade;
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += cityE;`)
  }
  bldMat.customProgramCacheKey = () => 'city-buildings-v2'
  const tiles = new Map()
  const landmarkBld = new Map() // site id -> buildings claimed by a focus landmark
  const focusSitesAll = [...referenced].map((id) => SITES.get(id)).filter(Boolean)
  const siteFadeCentres = focusSitesAll.map((s) => [s.x, s.z])
  const claimable = focusSitesAll.filter((s) => s.poly && !s.approximate && s.tags?.historic !== 'city' && s.r < 1500)
  let buildingCount = 0

  function buildingList() {
    if (detail?.buildings?.features?.length) {
      const out = []
      for (const f of detail.buildings.features) {
        for (const rings of geomPolys(f.geometry)) {
          const ring = ringXZ(rings[0] || [])
          if (ring.length < 3) continue
          const p = f.properties || {}
          // an outline whose building:parts are mapped too is drawn by its parts, standing on a low
          // plinth of the outline (a mosque's raised courtyard, Jama Masjid: parts map only its domes)
          const h = +p.h > 0 ? +p.h : 9
          if (p.has_parts) {
            out.push({ ring, h: Math.min(h * 0.4, 5.5), min_h: 0, kind: p.k || '', sites: p.site_ids || null, name: '', p: { ...p, roof: null }, plinth: true })
            continue
          }
          out.push({ ring, h, min_h: +p.min_h > 0 ? +p.min_h : 0, kind: p.k || p.building || '', sites: p.site_ids || null, name: p.name || '', p, synthetic: !!p.synthetic })
        }
      }
      // procedural infill of under-mapped dense land use (NOT OpenStreetMap: geo_detail `fill`), a shade dimmer
      for (const f of detail.fill?.features || []) {
        for (const rings of geomPolys(f.geometry)) {
          const ring = ringXZ(rings[0] || [])
          if (ring.length < 3) continue
          const p = f.properties || {}
          out.push({ ring, h: +p.h > 0 ? +p.h : 8, min_h: 0, kind: 'fill', sites: null, name: '', fill: true, p: { lu: p.lu || 'residential' } })
        }
      }
      return out
    }
    return synthetic ? syntheticBuildings() : []
  }
  // dev only: a seeded scatter of blocks along the corridor until build/geo_detail.json exists
  function syntheticBuildings() {
    const out = []
    const r = rng(1234)
    const xs = RAW.map((p) => p[0])
    const zs = RAW.map((p) => p[1])
    const blockers = [...greenPolys, ...waterPolys].map((rs) => ringXZ(rs[0])).filter((p) => p.length > 2 && Math.abs(ringArea(p)) > 2000)
    const bb = blockers.map((p) => [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))])
    const step = 46
    for (let x = Math.min(...xs) - 1300; x < Math.max(...xs) + 1300; x += step)
      for (let z = Math.min(...zs) - 1300; z < Math.max(...zs) + 1300; z += step) {
        const cx = x + (r() - 0.5) * 12
        const cz = z + (r() - 0.5) * 12
        const near = lineDist(cx, cz) < 1200 || siteFadeCentres.some(([sx, sz]) => Math.hypot(sx - cx, sz - cz) < 800)
        if (!near || r() < 0.3) continue
        if (blockers.some((p, i) => cx > bb[i][0] && cx < bb[i][2] && cz > bb[i][1] && cz < bb[i][3] && inside(cx, cz, p))) continue
        const w = 12 + r() * 22
        const d = 12 + r() * 22
        const h = 5 + Math.pow(r(), 2.4) * 34
        out.push({ ring: [[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]], h, min_h: 0, kind: 'synthetic', p: { osm_id: `syn/${out.length}` } })
      }
    return out
  }
  const claimIds = new Set(focusSitesAll.filter((s) => !s.approximate && s.tags?.historic !== 'city').map((s) => s.id))
  function claimFor(cx, cz, ids) {
    // geo_detail tags the buildings of each plan site (site_ids); else: inside the site's outline
    for (const id of ids || []) if (claimIds.has(id)) return id
    for (const s of claimable) if (Math.abs(cx - s.x) < s.r + 5 && Math.abs(cz - s.z) < s.r + 5 && inside(cx, cz, s.poly)) return s.id
    return null
  }
  const groundC = col(LOOK.night.ground)
  // counts -> typed arrays per tile (two passes keep memory flat for 10^5 buildings)
  function addBuildingsTo(acc, b, fade, seed) {
    const ring = b.ring
    const n = ring.length
    if (b.roofShape === undefined) b.roofShape = roofShapeOf(b)
    const rs = b.roofShape
    const split = b.look?.band > 0 ? 2 : 1
    acc.list.push({ b, fade, seed })
    acc.nv += n * 4 * split + n
    acc.ni += n * 6 * split + Math.max(0, n - 2) * 3
    if (rs?.smooth) {
      acc.nv += rs.smooth.pos.length / 3
      acc.ni += rs.smooth.idx.length
    }
    if (rs?.tris) {
      acc.nv += rs.tris.length * 3
      acc.ni += rs.tris.length * 3
    }
  }
  function fillGeometry(acc, wallBase, roofBase, flood = false) {
    const pos = new Float32Array(acc.nv * 3)
    const nor = new Int8Array(acc.nv * 3)
    const cols = new Uint16Array(acc.nv * 3)
    const aw = new Float32Array(acc.nv * 2)
    const ab = new Uint8Array(acc.nv * 4)
    const idx = new Uint32Array(acc.ni)
    let v = 0
    let k = 0
    const c = new THREE.Color()
    let cur = null // the current vertex colour
    let curW = [-4, 0] // aW of the next vertices
    let curB = [0, 0, 64, 255]
    const put = (x, y, z, nx, ny, nz) => {
      pos[v * 3] = x
      pos[v * 3 + 1] = y
      pos[v * 3 + 2] = z
      nor[v * 3] = Math.round(nx * 127)
      nor[v * 3 + 1] = Math.round(ny * 127)
      nor[v * 3 + 2] = Math.round(nz * 127)
      cols[v * 3] = Math.round(clamp(cur.r) * 65535)
      cols[v * 3 + 1] = Math.round(clamp(cur.g) * 65535)
      cols[v * 3 + 2] = Math.round(clamp(cur.b) * 65535)
      aw[v * 2] = curW[0]
      aw[v * 2 + 1] = curW[1]
      ab.set(curB, v * 4)
      return v++
    }
    for (const { b, fade, seed } of acc.list) {
      const ring = b.ring
      const n = ring.length
      const ccw = ringArea(ring) > 0
      const h0 = b.min_h
      const rs = b.roofShape
      let h1 = Math.max(rs ? rs.top : b.h, h0 + 1)
      const L = b.look
      // slender towers (minars) taper toward the top
      let cx = 0
      let cz = 0
      for (const p of ring) (cx += p[0]), (cz += p[1])
      cx /= n
      cz /= n
      let rad = 0
      for (const p of ring) rad = Math.max(rad, Math.hypot(p[0] - cx, p[1] - cz))
      const taper = h1 > 6 * rad && h1 > 30 ? 0.42 : 1
      const top = (p) => (taper < 1 ? [cx + (p[0] - cx) * taper, cz + (p[1] - cz) * taper] : p)
      // colours: the floodlit landmark keeps its stone; the city dissolves into the dark ground at the corridor edge
      let wallC
      let baseC
      let roofC
      if (flood) {
        wallC = c.copy(wallBase).multiplyScalar(h1 > 40 ? 0.95 : 0.72).clone()
        baseC = c.copy(wallBase).multiplyScalar(1.15).clone()
        roofC = c.copy(roofBase).multiplyScalar(0.62).clone()
      } else if (L) {
        wallC = L.wall.clone().lerp(groundC, 0.58 * (1 - fade))
        baseC = (L.base || L.wall).clone().lerp(groundC, 0.58 * (1 - fade))
        roofC = L.roof.clone().lerp(groundC, 0.62 * (1 - fade))
      } else {
        const sh = 0.86 + 0.24 * seed
        wallC = c.copy(wallBase).multiplyScalar(sh * 0.8).clone()
        baseC = wallC
        roofC = c.copy(roofBase).multiplyScalar(0.92 + 0.16 * seed).clone()
      }
      const ciB = L ? L.ci : CI.other
      const winOK = !flood && L?.windows && !b.plinth && !b.synthetic
      curB = [ciB, L ? L.seed : Math.floor(seed * 255), Math.round(clamp((L ? L.lvh : 3.2) * 20, 0, 255)), Math.round(clamp(fade) * 255)]
      const band = flood ? 0 : L?.band > 0 ? Math.min(h0 + L.band, h1 - 1) : 0
      const levels = band > h0 + 0.3 ? [[h0, band, baseC], [band, h1, wallC]] : [[h0, h1, flood ? null : wallC]]
      for (let i = 0; i < n; i++) {
        const a = ring[i]
        const bq = ring[(i + 1) % n]
        const at = top(a)
        const bt = top(bq)
        const dx = bq[0] - a[0]
        const dz = bq[1] - a[1]
        const l = Math.hypot(dx, dz) || 1
        // outward normal in (x, z): CCW (math sense) rings -> (dz, -dx)
        const nx = ccw ? dz / l : -dz / l
        const nz = ccw ? -dx / l : dx / l
        // windows: a whole number of bays along this wall (none on short corner walls)
        const bays = winOK && taper === 1 ? Math.round(l / (L.cls === 'off' ? 3.0 : L.cls === 'bung' ? 4.6 : L.cls === 'civic' ? 4.2 : L.cls === 'ind' ? 6 : 3.5)) : 0
        for (const [ya, yb, cc] of levels) {
          const q = v
          const fa = (ya - h0) / (h1 - h0)
          const fb = (yb - h0) / (h1 - h0)
          const P = [
            [a[0], ya, a[1], 0],
            [bq[0], ya, bq[1], 1],
            [lerp(bq[0], bt[0], fb), yb, lerp(bq[1], bt[1], fb), 1],
            [lerp(a[0], at[0], fb), yb, lerp(a[1], at[1], fb), 0],
          ]
          if (fa > 0) {
            P[0][0] = lerp(a[0], at[0], fa)
            P[0][2] = lerp(a[1], at[1], fa)
            P[1][0] = lerp(bq[0], bt[0], fa)
            P[1][2] = lerp(bq[1], bt[1], fa)
          }
          for (let j = 0; j < 4; j++) {
            // flood path: the old vertical shading (base lit hotter than the top)
            cur = cc || (j < 2 ? baseC : wallC)
            curW = [bays > 0 ? P[j][3] * bays : -2, h1]
            put(P[j][0], P[j][1], P[j][2], nx, 0, nz)
          }
          // triangle (a0, b0, b1) faces (-dz, 0, dx): keep it when that is outward
          if (!ccw) idx.set([q, q + 1, q + 2, q, q + 2, q + 3], k)
          else idx.set([q, q + 2, q + 1, q, q + 3, q + 2], k)
          k += 6
        }
      }
      // roof (flat; under a dome or a pitched roof too)
      const contour = ring.map((p) => new THREE.Vector2(...top(p)))
      let tris = []
      try {
        tris = THREE.ShapeUtils.triangulateShape(contour, [])
      } catch {}
      cur = roofC
      curW = [-4, h1]
      const base = v
      for (const p of contour) put(p.x, h1, p.y, 0, 1, 0)
      for (let i = 0; i < n - 2; i++) {
        const t = tris[i]
        if (!t) {
          idx.set([base, base, base], k)
        } else {
          const A = contour[t[0]]
          const B = contour[t[1]]
          const C = contour[t[2]]
          // 3D normal y = -(2D cross in x,z): flip CCW triangles so roofs face up
          const cr = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)
          idx.set(cr > 0 ? [base + t[0], base + t[2], base + t[1]] : [base + t[0], base + t[1], base + t[2]], k)
        }
        k += 3
      }
      if (rs?.smooth) {
        const { pos: sp, nor: sn, idx: si } = rs.smooth
        const b0 = v
        for (let i = 0; i < sp.length; i += 3) put(sp[i], sp[i + 1], sp[i + 2], sn[i], sn[i + 1], sn[i + 2])
        for (const ii of si) idx[k++] = b0 + ii
      }
      if (rs?.tris) {
        for (const t of rs.tris) {
          // flat-shaded: face normal (up-facing slopes; gable ends stand vertical)
          const ux = t[3] - t[0]
          const uy = t[4] - t[1]
          const uz = t[5] - t[2]
          const wx = t[6] - t[0]
          const wy = t[7] - t[1]
          const wz = t[8] - t[2]
          let nx = uy * wz - uz * wy
          let ny = uz * wx - ux * wz
          let nz = ux * wy - uy * wx
          const nl = Math.hypot(nx, ny, nz) || 1
          nx /= nl
          ny /= nl
          nz /= nl
          let order = [0, 1, 2]
          if (ny < 0 || (Math.abs(ny) < 1e-3 && (nx * (t[0] - cx) + nz * (t[2] - cz)) < 0)) {
            nx = -nx
            ny = -ny
            nz = -nz
            order = [0, 2, 1]
          }
          const vertical = Math.abs(ny) < 0.05
          cur = vertical ? wallC : roofC
          curW = vertical ? [-2, h1] : [-4, h1]
          const b0 = v
          for (let j = 0; j < 3; j++) put(t[j * 3], t[j * 3 + 1], t[j * 3 + 2], nx, ny, nz)
          idx.set([b0 + order[0], b0 + order[1], b0 + order[2]], k)
          k += 3
        }
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true))
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3, true))
    g.setAttribute('aW', new THREE.BufferAttribute(aw, 2))
    g.setAttribute('aB', new THREE.BufferAttribute(ab, 4))
    g.setIndex(new THREE.BufferAttribute(idx, 1))
    g.computeBoundingSphere()
    return g
  }
  const treeSpots = [] // building footprints' boxes (no tree inside a building)
  {
    const list = buildingList()
    buildingCount = list.length
    // a slender named minar gets its balcony bands (Qutb Minar: storeys end at ~40, 70, 85, 94 % of its height)
    for (const b of list.slice()) {
      if (!/minar|minaret/i.test(b.name || '')) continue
      let cx = 0
      let cz = 0
      for (const p of b.ring) (cx += p[0]), (cz += p[1])
      cx /= b.ring.length
      cz /= b.ring.length
      const rad = Math.max(...b.ring.map((p) => Math.hypot(p[0] - cx, p[1] - cz)))
      if (!(b.h > 6 * rad && b.h > 30)) continue
      for (const fr of [0.4, 0.7, 0.855, 0.94]) {
        const k = (1 - 0.58 * fr) * 1.22
        list.push({ ...b, ring: b.ring.map((p) => [cx + (p[0] - cx) * k, cz + (p[1] - cz) * k]), min_h: b.h * fr - 1.6, h: b.h * fr + 0.5, name: '', p: { ...b.p, roof: null } })
      }
    }
    // neighbourhood cover first (every building's footprint at its centre)
    const meta = list.map((b) => {
      let cx = 0
      let cz = 0
      let x0 = Infinity
      let z0 = Infinity
      let x1 = -Infinity
      let z1 = -Infinity
      for (const p of b.ring) {
        cx += p[0]
        cz += p[1]
        x0 = Math.min(x0, p[0])
        z0 = Math.min(z0, p[1])
        x1 = Math.max(x1, p[0])
        z1 = Math.max(z1, p[1])
      }
      cx /= b.ring.length
      cz /= b.ring.length
      const area = Math.abs(ringArea(b.ring))
      if (!(b.min_h > 0)) {
        const key = ck(Math.floor(cx / COVER_CELL), Math.floor(cz / COVER_CELL))
        coverGrid.set(key, (coverGrid.get(key) || 0) + area)
        treeSpots.push([x0, z0, x1, z1])
      }
      return { cx, cz, area }
    })
    list.forEach((b, i) => {
      const { cx, cz, area } = meta[i]
      const claim = claimFor(cx, cz, b.sites)
      if (claim) {
        if (!landmarkBld.has(claim)) landmarkBld.set(claim, { nv: 0, ni: 0, list: [] })
        addBuildingsTo(landmarkBld.get(claim), b, 1, hash1(i))
        return
      }
      b.look = lookOf(b, area, coverAt(cx, cz))
      const dl = lineDist(cx, cz)
      const ds = Math.min(Infinity, ...siteFadeCentres.map(([x, z]) => Math.hypot(x - cx, z - cz)))
      const fade = Math.max(1 - smooth(ramp(dl, 700, 1250)), 1 - smooth(ramp(ds, 450, 850)))
      const key = `${Math.floor(cx / TILE)},${Math.floor(cz / TILE)}`
      if (!tiles.has(key)) tiles.set(key, { nv: 0, ni: 0, list: [] })
      addBuildingsTo(tiles.get(key), b, fade, hash1(i))
    })
    for (const acc of tiles.values()) {
      if (!acc.list.length) continue
      const mesh = new THREE.Mesh(fillGeometry(acc), bldMat)
      mesh.renderOrder = 0
      mesh.castShadow = mesh.receiveShadow = true
      scene.add(mesh)
    }
  }

  // ---------- trees: instanced low-poly crowns in parks, gardens and the Ridge forest, and in rows along
  // the avenues of garden suburbs (Lutyens' Delhi); deterministic (hashed grid), per tile (frustum-culled)
  const treeMats = []
  let treeCount = 0
  {
    const MAX_TREES = 90000
    const MAX_AVENUE = 22000
    // where the city is drawn: the corridor fade, on a 100 m grid
    const FG = 100
    const xs = RAW.map((p) => p[0])
    const zs = RAW.map((p) => p[1])
    const gx0 = Math.min(...xs, ...siteFadeCentres.map((s) => s[0])) - 1400
    const gz0 = Math.min(...zs, ...siteFadeCentres.map((s) => s[1])) - 1400
    const gx1 = Math.max(...xs, ...siteFadeCentres.map((s) => s[0])) + 1400
    const gz1 = Math.max(...zs, ...siteFadeCentres.map((s) => s[1])) + 1400
    const GW = Math.ceil((gx1 - gx0) / FG) + 1
    const GH = Math.ceil((gz1 - gz0) / FG) + 1
    const fadeGrid = new Float32Array(GW * GH)
    for (let j = 0; j < GH; j++)
      for (let i = 0; i < GW; i++) {
        const x = gx0 + i * FG
        const z = gz0 + j * FG
        const dl = lineDist(x, z)
        let ds = Infinity
        for (const [sx, sz] of siteFadeCentres) ds = Math.min(ds, Math.hypot(sx - x, sz - z))
        fadeGrid[j * GW + i] = Math.max(1 - smooth(ramp(dl, 700, 1250)), 1 - smooth(ramp(ds, 450, 850)))
      }
    const fadeAt = (x, z) => {
      const fi = (x - gx0) / FG
      const fj = (z - gz0) / FG
      const i = Math.floor(fi)
      const j = Math.floor(fj)
      if (i < 0 || j < 0 || i >= GW - 1 || j >= GH - 1) return 0
      const u = fi - i
      const w = fj - j
      const f = (a, b2) => fadeGrid[b2 * GW + a]
      return lerp(lerp(f(i, j), f(i + 1, j), u), lerp(f(i, j + 1), f(i + 1, j + 1), u), w)
    }
    // spatial buckets: building boxes, street segments (with their clearance), water
    const bucket = (cell) => {
      const m = new Map()
      return {
        add(x0, z0, x1, z1, item) {
          for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++)
            for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++) {
              const kk = ck(i, j)
              if (!m.has(kk)) m.set(kk, [])
              m.get(kk).push(item)
            }
        },
        at: (x, z) => m.get(ck(Math.floor(x / cell), Math.floor(z / cell))) || [],
      }
    }
    const bB = bucket(32)
    for (const s of treeSpots) bB.add(s[0] - 1.2, s[1] - 1.2, s[2] + 1.2, s[3] + 1.2, s)
    const inBuilding = (x, z) => bB.at(x, z).some((s) => x > s[0] - 1.2 && x < s[2] + 1.2 && z > s[1] - 1.2 && z < s[3] + 1.2)
    const CLEAR = { major: 10, minor: 5.2, path: 1.6, rail: 5 }
    const sB = bucket(40)
    const avenues = []
    for (const f of streets) {
      const P = f.properties || {}
      if (P.tunnel) continue
      const clear = CLEAR[P.cls] ?? 4
      for (const l of geomLines(f.geometry)) {
        const pts = l.map((c) => toXZ(c[0], c[1]))
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1]
          const b2 = pts[i]
          sB.add(Math.min(a[0], b2[0]) - clear, Math.min(a[1], b2[1]) - clear, Math.max(a[0], b2[0]) + clear, Math.max(a[1], b2[1]) + clear, { a, b: b2, clear })
        }
        if ((P.cls === 'major' || P.cls === 'minor') && !P.bridge) avenues.push({ pts, clear, major: P.cls === 'major' })
      }
    }
    for (const f of roadsGeo) {
      for (const l of geomLines(f.geometry)) {
        const pts = l.map((c) => toXZ(c[0], c[1]))
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1]
          const b2 = pts[i]
          sB.add(Math.min(a[0], b2[0]) - 10, Math.min(a[1], b2[1]) - 10, Math.max(a[0], b2[0]) + 10, Math.max(a[1], b2[1]) + 10, { a, b: b2, clear: 10 })
        }
      }
    }
    const onStreet = (x, z) => sB.at(x, z).some((s) => segDist(x, z, s.a[0], s.a[1], s.b[0], s.b[1]) < s.clear)
    const wB = bucket(200)
    for (const rs of waterPolys) {
      const ring = ringXZ(rs[0] || [])
      if (ring.length < 3) continue
      let x0 = Infinity
      let z0 = Infinity
      let x1 = -Infinity
      let z1 = -Infinity
      for (const p of ring) (x0 = Math.min(x0, p[0])), (z0 = Math.min(z0, p[1])), (x1 = Math.max(x1, p[0])), (z1 = Math.max(z1, p[1]))
      if (x1 < gx0 || x0 > gx1 || z1 < gz0 || z0 > gz1) continue
      const item = { ring, box: [x0 - 3, z0 - 3, x1 + 3, z1 + 3] }
      wB.add(Math.max(x0, gx0), Math.max(z0, gz0), Math.min(x1, gx1), Math.min(z1, gz1), item)
    }
    const inWater = (x, z) => wB.at(x, z).some((w) => x > w.box[0] && x < w.box[2] && z > w.box[1] && z < w.box[3] && inside(x, z, w.ring))
    // occupancy: one crown per 6 m cell (overlapping green layers never double the density)
    const occ = new Set()
    const OC = 6
    const free = (x, z) => {
      const i = Math.floor(x / OC)
      const j = Math.floor(z / OC)
      for (let a = i - 1; a <= i + 1; a++) for (let b2 = j - 1; b2 <= j + 1; b2++) if (occ.has(ck(a, b2))) return false
      return true
    }
    // smooth value noise (~70 m): clumps and clearings
    const vn = (x, z, s = 70) => {
      const fx = x / s
      const fz = z / s
      const i = Math.floor(fx)
      const j = Math.floor(fz)
      const u = fx - i
      const w = fz - j
      const hh = (a, b2) => hash1(ck(a, b2) ^ 0x5bd1e995)
      const su = u * u * (3 - 2 * u)
      const sw = w * w * (3 - 2 * w)
      return lerp(lerp(hh(i, j), hh(i + 1, j), su), lerp(hh(i, j + 1), hh(i + 1, j + 1), su), sw)
    }
    const TREES = [] // [x, z, crown radius, height, colour index, fade]
    const plant = (x, z, r, hgt, kind, fade) => {
      occ.add(ck(Math.floor(x / OC), Math.floor(z / OC)))
      TREES.push([x, z, r, hgt, kind, fade])
    }
    // per green kind: grid spacing (m), keep share, crown radius range, height range, palette
    const GREEN = {
      forest: [9, 0.95, 0.5, 3.2, 5, 8, 12, 0],
      wood: [9, 0.95, 0.5, 3.2, 5, 8, 12, 0],
      reserve: [9.5, 0.9, 0.6, 3, 4.8, 7, 11, 0],
      scrub: [10.5, 0.7, 0.9, 2.4, 3.8, 5, 8, 1],
      park: [12, 0.6, 1.2, 3.2, 5.4, 8, 13, 2],
      garden: [11, 0.55, 1.2, 3, 4.8, 7, 11, 2],
      cemetery: [12, 0.55, 1, 3, 4.8, 7, 11, 0],
      grass: [20, 0.3, 1.4, 3.2, 5.2, 8, 12, 2],
      golf: [22, 0.32, 1.4, 3.4, 5.6, 9, 13, 2],
    }
    const greens = [...(L.green?.features || []), ...(detail?.green?.features || [])]
      .map((f) => ({ f, kind: f.properties?.kind || 'park', polys: geomPolys(f.geometry) }))
      .filter((g) => GREEN[g.kind])
    for (const g of greens) {
      const [sp, keep, nw, r0, r1, hA, hB, pal] = GREEN[g.kind]
      for (const rings of g.polys) {
        const rs = rings.map(ringXZ).filter((r) => r.length >= 3)
        if (!rs.length) continue
        let x0 = Infinity
        let z0 = Infinity
        let x1 = -Infinity
        let z1 = -Infinity
        for (const p of rs[0]) (x0 = Math.min(x0, p[0])), (z0 = Math.min(z0, p[1])), (x1 = Math.max(x1, p[0])), (z1 = Math.max(z1, p[1]))
        x0 = Math.max(x0, gx0)
        z0 = Math.max(z0, gz0)
        x1 = Math.min(x1, gx1)
        z1 = Math.min(z1, gz1)
        if (x0 >= x1 || z0 >= z1) continue
        // scanline fill on a global grid (the same lattice for every polygon of this spacing)
        for (let z = Math.ceil(z0 / sp) * sp; z <= z1; z += sp) {
          const cr = []
          for (const r of rs)
            for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
              const [xi, zi] = r[i]
              const [xj, zj] = r[j]
              if (zi > z !== zj > z) cr.push(xi + ((z - zi) * (xj - xi)) / (zj - zi))
            }
          if (cr.length < 2) continue
          cr.sort((a, b2) => a - b2)
          for (let q = 0; q + 1 < cr.length; q += 2) {
            const xa = Math.max(cr[q], x0)
            const xb = Math.min(cr[q + 1], x1)
            for (let x = Math.ceil(xa / sp) * sp; x <= xb; x += sp) {
              const fd = fadeAt(x, z)
              if (fd < 0.04) continue
              const hk = ck(Math.round(x / sp), Math.round(z / sp)) ^ Math.imul(sp, 83492791)
              const h1 = hash1(hk)
              const h2 = hash1(hk ^ 0x68e31da4)
              const h3 = hash1(hk ^ 0x1b873593)
              const nz = vn(x, z)
              if (h1 > keep * clamp(1 - nw * 0.5 + nw * nz) || h3 > fd + 0.15) continue
              const tx = x + (h2 - 0.5) * sp * 0.8
              const tz = z + (h3 - 0.5) * sp * 0.8
              if (!free(tx, tz) || inBuilding(tx, tz) || onStreet(tx, tz) || inWater(tx, tz)) continue
              plant(tx, tz, lerp(r0, r1, h2) * (0.85 + 0.3 * nz), lerp(hA, hB, hash1(hk ^ 0x2545f491)), pal, fd)
            }
          }
        }
      }
    }
    // avenue trees: rows along the streets of leafy, low-cover neighbourhoods (Lutyens' bungalow zone)
    let nAve = 0
    for (const av of avenues) {
      const step = av.major ? 11 : 12.5
      const off = av.clear + 2.6
      let acc = 0
      for (let i = 1; i < av.pts.length && nAve < MAX_AVENUE; i++) {
        const a = av.pts[i - 1]
        const b2 = av.pts[i]
        const l = Math.hypot(b2[0] - a[0], b2[1] - a[1])
        if (l < 1) continue
        const ux = (b2[0] - a[0]) / l
        const uz = (b2[1] - a[1]) / l
        for (let s = (step - (acc % step)) % step; s < l; s += step) {
          const px = a[0] + ux * s
          const pz = a[1] + uz * s
          const fd = fadeAt(px, pz)
          if (fd < 0.1) continue
          const cv = coverAt(px, pz)
          if (cv < 0.02 || cv > 0.2) continue
          for (const sd of [-1, 1]) {
            const tx = px - uz * off * sd
            const tz = pz + ux * off * sd
            const hk = ck(Math.round(tx), Math.round(tz))
            if (hash1(hk) > 0.86 || !free(tx, tz) || inBuilding(tx, tz) || onStreet(tx, tz) || inWater(tx, tz)) continue
            plant(tx, tz, 3.4 + 1.6 * hash1(hk ^ 0x9e37), 8.5 + 3.5 * hash1(hk ^ 0x7f4a), 3, fd)
            nAve++
          }
        }
        acc += l
      }
    }
    // over the cap: thin evenly (deterministic)
    let trees = TREES
    if (trees.length > MAX_TREES) {
      const keepShare = MAX_TREES / trees.length
      trees = trees.filter((t) => hash1(ck(Math.round(t[0] * 3), Math.round(t[1] * 3)) ^ 0x3c6ef372) < keepShare)
    }
    treeCount = trees.length
    // crowns: a squashed icosahedron (flat-shaded low-poly), standing a little off the ground
    const crown = new THREE.IcosahedronGeometry(1, 0)
    crown.translate(0, 1, 0)
    const PAL = [
      ['#4a6b3e', '#55744a', '#3f6040', '#5b7247', '#486a4b'], // forest
      ['#6a7348', '#5d6a42', '#737a4c', '#62703f'], // scrub / ridge (kikar olive)
      ['#4f7442', '#5a7d4a', '#46693f', '#62804e', '#53734f'], // parks
      ['#4b6e40', '#557846', '#4f7048'], // avenues (neem, jamun)
    ].map((p) => p.map((h) => nightTone(h, 0.15, 0.5, 1.0, 1)))
    const treeMat = new THREE.MeshLambertMaterial({ flatShading: true })
    const treeU = { uTreeK: { value: 1 } }
    treeMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, treeU)
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTreeK;').replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed *= uTreeK;')
    }
    treeMat.customProgramCacheKey = () => 'city-trees'
    treeMats.push({ m: treeMat, u: treeU })
    const byTile = new Map()
    for (const t of trees) {
      const key = `${Math.floor(t[0] / TILE)},${Math.floor(t[1] / TILE)}`
      if (!byTile.has(key)) byTile.set(key, [])
      byTile.get(key).push(t)
    }
    const UP = new V3(0, 1, 0)
    const m4 = new THREE.Matrix4()
    const q0 = new THREE.Quaternion()
    const sc = new V3()
    const ps = new V3()
    const cc = new THREE.Color()
    for (const list of byTile.values()) {
      const mesh = new THREE.InstancedMesh(crown, treeMat, list.length)
      list.forEach(([x, z, r, hgt, pal, fd], i) => {
        const hk = ck(Math.round(x * 2), Math.round(z * 2))
        const k = 0.6 + 0.4 * fd
        // crown from ~30% of the height to the top; a tilt-free spin
        q0.setFromAxisAngle(UP, hash1(hk) * Math.PI * 2)
        ps.set(x, hgt * 0.3, z)
        sc.set(r * k, hgt * 0.35 * k, r * k)
        m4.compose(ps, q0, sc)
        mesh.setMatrixAt(i, m4)
        const P = PAL[pal]
        cc.copy(pick(P, hash1(hk ^ 0x51ed27)))
          .multiplyScalar(0.86 + 0.28 * hash1(hk ^ 0x2f1b))
          .lerp(groundC, 0.6 * (1 - fd))
        mesh.setColorAt(i, cc)
      })
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
      mesh.castShadow = true
      mesh.receiveShadow = false
      mesh.renderOrder = 0
      scene.add(mesh)
    }
  }

  // ---------- landmarks: the narrated site lit gold from within
  const LM = new Map()
  const stoneC = col('#8a8078')
  const stoneRoof = col('#b3a99c')
  function siteHeight(s) {
    const t = s.tags || {}
    const m = String(t.height || '').match(/[\d.]+/)
    if (m) return +m[0]
    const name = `${s.name || ''} ${t['name:en'] || ''}`
    if (/minar|minaret/i.test(name)) return 72.5
    if (t.building === 'mosque' || /masjid|mosque/i.test(name)) return 24
    if (t.castle_type === 'palace' || /bhavan|palace|mahal/i.test(name)) return 30
    if (/gate|darwaza/i.test(name)) return 16
    if (t.historic === 'tomb' || /tomb|maqbara/i.test(name)) return 20
    return 12
  }
  for (const site of focusSitesAll) {
    const t = site.tags || {}
    const lm = { site, meshes: [], mats: [], top: 8, cx: site.x, cz: site.z }
    const isArea = site.approximate || t.historic === 'city' || (!t.building && /archaeological_site|ruins/.test(t.historic || '')) || !!t['heritage:operator'] || (!t.building && t.leisure === 'park')
    const isFort = !t.building && t.castle_type !== 'palace' && (t.castle_type === 'fortress' || /^(fort|castle)$/.test(t.historic || '')) && site.r > 120
    const mkMat = (base) => {
      const m = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: col('#ffcf7a'), emissiveIntensity: 0 })
      m.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        #ifdef USE_COLOR
          totalEmissiveRadiance *= vColor.rgb * 2.2;
        #endif`)
      }
      m.customProgramCacheKey = () => 'landmark-flood'
      m.userData.base = base
      lm.mats.push(m)
      return m
    }
    const claimed = landmarkBld.get(site.id)
    if (claimed?.list.length) {
      const mesh = new THREE.Mesh(fillGeometry(claimed, stoneC, stoneRoof, true), mkMat(1))
      lm.meshes.push(mesh)
      lm.top = Math.max(...claimed.list.map((e) => e.b.h))
    }
    if (site.poly && isFort) {
      // fort walls: a thick ring wall along the outline
      const ring = site.poly.slice()
      if (Math.hypot(ring[0][0] - ring.at(-1)[0], ring[0][1] - ring.at(-1)[1]) < 0.01) ring.pop()
      const acc = { nv: 0, ni: 0, list: [] }
      const wallH = siteHeight(site) > 12 ? siteHeight(site) : 20
      const sgn = ringArea(ring) > 0 ? 1 : -1
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]
        const b = ring[(i + 1) % ring.length]
        const nn = norm(a, b)
        const th = 9 * sgn
        const q = [a, b, [b[0] + nn[0] * th, b[1] + nn[1] * th], [a[0] + nn[0] * th, a[1] + nn[1] * th]]
        addBuildingsTo(acc, { ring: ringArea(q) > 0 ? q : q.reverse(), h: wallH, min_h: 0 }, 1, 0.5)
      }
      // thin walls can glow harder than solid buildings without reading as a blob
      lm.meshes.push(new THREE.Mesh(fillGeometry(acc, stoneC, stoneRoof, true), mkMat(2.4)))
      lm.top = Math.max(lm.top, wallH)
    } else if (site.poly && !isArea && !claimed?.list.length) {
      const h = siteHeight(site)
      const acc = { nv: 0, ni: 0, list: [] }
      addBuildingsTo(acc, { ring: site.poly, h, min_h: 0 }, 1, 0.5)
      lm.meshes.push(new THREE.Mesh(fillGeometry(acc, stoneC, stoneRoof, true), mkMat(1)))
      lm.top = Math.max(lm.top, h)
    }
    if (site.poly && (isArea || isFort)) {
      // the precinct: a faint warm fill + an outline (dashed when only approximate)
      const fill = new THREE.Mesh(flatGeometry([[site.polygon]], 0), flatMaterial(GOLD, { opacity: 0 }))
      fill.material.transparent = true
      fill.material.blending = THREE.AdditiveBlending
      fill.renderOrder = -3
      lm.fill = fill
      const ring = site.poly.concat([site.poly[0]])
      const line = new THREE.Mesh(ribbonGeometry([ring]), ribbonMaterial({ color: '#ffc46a', halfW: 1.6, minPx: 1.6, opacity: 0, dash: site.approximate ? 60 : 0 }))
      line.renderOrder = -2
      line.frustumCulled = false
      lm.outline = line
      scene.add(fill, line)
    }
    for (const m of lm.meshes) {
      m.renderOrder = 1
      m.castShadow = m.receiveShadow = true
      scene.add(m)
    }
    // ground glow under the site: soft light spill
    // big precincts (a walled city, a fort) get no spill: their outline and buildings carry the light
    if (site.r < 160) {
      lm.glow = glowDisc(clamp(site.r * 1.1 + 70, 90, 260), GOLD, site.poly ? 0 : 20)
      lm.glow.position.set(site.x, 0.5, site.z)
      lm.glow.renderOrder = 5
      scene.add(lm.glow)
    }
    if (!site.poly) {
      // point site (iron pillar): its own building when mapped, else a slim lit column; and a hot core
      if (!claimed?.list.length) {
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.2, 14, 10).translate(0, 7, 0), mkMat(1))
      pin.position.set(site.x, 0, site.z)
      pin.material.vertexColors = false
      pin.material.color = col('#b6a07e')
      scene.add(pin)
      lm.meshes.push(pin)
      }
      lm.core = glowDisc(18, GOLD_HOT, 9)
      lm.core.position.set(site.x, 1, site.z)
      lm.core.renderOrder = 6
      scene.add(lm.core)
      lm.top = 14
    }
    LM.set(site.id, lm)
  }

  // ---------- the ridden line: ribbon + glow; the train
  const lineGeo = ribbonGeometry([LP], 0.3)
  const lineCore = new THREE.Mesh(lineGeo, ribbonMaterial({ color: geo.line.color || GOLD, halfW: 4.5, minPx: 3, kind: 2, intensity: 1.5 }))
  lineCore.renderOrder = 3
  lineCore.frustumCulled = false
  const lineGlow = new THREE.Mesh(lineGeo, ribbonMaterial({ color: GOLD, halfW: 18, minPx: 14, kind: 1, opacity: 0.2, additive: true, intensity: 1 }))
  lineGlow.renderOrder = 2
  lineGlow.frustumCulled = false
  // the line seen through buildings: a faint x-ray pass so the route always reads
  const lineXray = new THREE.Mesh(lineGeo, ribbonMaterial({ color: GOLD, halfW: 7, minPx: 3, kind: 2, opacity: 0.35, additive: true, intensity: 1 }))
  lineXray.material.depthFunc = THREE.GreaterDepth
  lineXray.renderOrder = 4
  lineXray.frustumCulled = false
  scene.add(lineGlow, lineCore, lineXray)
  const lineMats = [lineCore.material, lineGlow.material, lineXray.material]

  const train = new THREE.Group()
  const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(6.5, 118, 4, 14).rotateZ(Math.PI / 2), new THREE.MeshBasicMaterial({ color: col('#fff2cc').multiplyScalar(1.7), fog: false }))
  capsule.position.y = 7
  train.add(capsule)
  scene.add(train)
  const trainGlow = glowDisc(60, GOLD, 22)
  trainGlow.renderOrder = 6
  scene.add(trainGlow)

  // ---------- post: MSAA HDR target -> bloom -> tone map + sRGB
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 })
  const composer = new EffectComposer(renderer, rt)
  composer.setPixelRatio(1)
  composer.setSize(W, H)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), LOOK.night.bloom, 0.55, 0.72)
  composer.addPass(bloom)
  composer.addPass(new OutputPass())

  // ---------- camera rig: state {x, z, d, p, b, ax, ay}: ground target (x, z) at distance d, pitch p
  // (deg from straight down), compass bearing b; the target lands at (ax, ay) of the frame (lens shift)
  const _m = new THREE.Matrix4()
  const _f = new V3()
  const _r = new V3()
  const _u = new V3()
  function applyCam(cam, st, w, h) {
    const b = st.b * DEG
    const p = st.p * DEG
    _f.set(Math.sin(p) * Math.sin(b), -Math.cos(p), -Math.sin(p) * Math.cos(b))
    _r.set(Math.cos(b), 0, Math.sin(b))
    _u.copy(_f).negate().cross(_r)
    cam.position.set(st.x - _f.x * st.d, -_f.y * st.d + (st.y || 0), st.z - _f.z * st.d)
    _m.makeBasis(_r, _u, _f.clone().negate())
    cam.quaternion.setFromRotationMatrix(_m)
    cam.fov = st.fov || FOV
    cam.aspect = w / h
    cam.near = Math.max(2, st.d * 0.02)
    cam.far = st.d * 14 + 60000
    cam.setViewOffset(w, h, w / 2 - st.ax * w, h / 2 - st.ay * h, w, h)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld(true)
  }
  const _v = new V3()
  function projectWith(cam, w, h, x, y, z) {
    _v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse)
    const front = _v.z < 0
    _v.applyMatrix4(cam.projectionMatrix)
    return { x: ((_v.x + 1) / 2) * w, y: ((1 - _v.y) / 2) * h, front, depth: -(_v.z) }
  }
  // screen point -> ground (y = 0)
  const _ray = new THREE.Raycaster()
  const _plane = new THREE.Plane(new V3(0, 1, 0), 0)
  function groundAt(cam, w, h, px, py) {
    _ray.setFromCamera(new THREE.Vector2((px / w) * 2 - 1, 1 - (py / h) * 2), cam)
    const hit = new V3()
    return _ray.ray.intersectPlane(_plane, hit) ? [hit.x, hit.z] : null
  }
  // fit: the subject points (world [x, y, z]) inside the rect (fractions), at pitch p and bearing b
  function fitShot(points, rect, { p = 55, b = 0, padPx = 90, dMin = 600, dMax = 30000, w = W, h = H } = {}) {
    const ax = (rect[0] + rect[2]) / 2
    const ay = (rect[1] + rect[3]) / 2
    let tx = 0
    let tz = 0
    for (const q of points) (tx += q[0]), (tz += q[2])
    tx /= points.length
    tz /= points.length
    const box = [rect[0] * w + padPx, rect[1] * h + padPx, rect[2] * w - padPx, rect[3] * h - padPx]
    let st = { x: tx, z: tz, d: dMin, p, b, ax, ay }
    const bbox = (s) => {
      applyCam(fitCam, s, w, h)
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const q of points) {
        const r = projectWith(fitCam, w, h, q[0], q[1], q[2])
        if (!r.front) return null
        x0 = Math.min(x0, r.x)
        y0 = Math.min(y0, r.y)
        x1 = Math.max(x1, r.x)
        y1 = Math.max(y1, r.y)
      }
      return [x0, y0, x1, y1]
    }
    for (let it = 0; it < 4; it++) {
      let lo = dMin
      let hi = dMax
      for (let k = 0; k < 26; k++) {
        const mid = Math.sqrt(lo * hi)
        const bb = bbox({ ...st, d: mid })
        const fits = bb && bb[0] >= box[0] && bb[1] >= box[1] && bb[2] <= box[2] && bb[3] <= box[3]
        fits ? (hi = mid) : (lo = mid)
      }
      st = { ...st, d: hi }
      const bb = bbox(st)
      if (!bb) break
      // recentre the subject's screen box on the anchor
      const g = groundAt(fitCam, w, h, (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2)
      if (!g) break
      st = { ...st, x: lerp(st.x, g[0], 0.9), z: lerp(st.z, g[1], 0.9) }
    }
    return st
  }
  function mixState(a, b, e) {
    if (e <= 0) return a
    if (e >= 1) return b
    const move = Math.hypot(a.x - b.x, a.z - b.z) / Math.min(a.d, b.d)
    const bump = clamp(Math.log2(move / 0.9), 0, 1.6) * Math.sin(Math.PI * e)
    return {
      x: lerp(a.x, b.x, e),
      z: lerp(a.z, b.z, e),
      d: Math.exp(lerp(Math.log(a.d), Math.log(b.d), e)) * 2 ** (bump * 0.8),
      p: lerp(a.p, b.p, e),
      b: lerpAngle(a.b, b.b, e),
      ax: lerp(a.ax, b.ax, e),
      ay: lerp(a.ay, b.ay, e),
    }
  }
  const drift = (st, dt, rate = 0.9, push = 0.0) => ({ ...st, b: st.b + rate * dt, d: st.d * (1 - push) })

  // per-scene shots
  const firstMap = SCENES.find((s) => s.kind === 'map' && s.map)
  const lastMap = SCENES.filter((s) => s.kind === 'map' && s.map).at(-1)
  const START = firstMap ? stationById.get(firstMap.map.focus_station) || stationById.get(firstMap.map.train_to) || ST[0] : ST[0]
  const sp = hooks.space || {}
  const [spX, spZ] = sp.lon != null ? toXZ(sp.lon, sp.lat) : [START.x, START.z]
  const SPACE = { x: spX, z: spZ, d: sp.d || 36000, p: sp.p ?? 0, b: sp.b ?? 0, ax: 0.5, ay: 0.5 }
  const sceneBearing = (sc, st, sites) => {
    const dir = sc.travel ? Math.sign(sc.travel.s1 - sc.travel.s0) || 1 : 1
    const head = headingAt(st.s, 300, 300, dir)
    let b = head
    const big = sites.filter((s) => Math.hypot(s.x - st.x, s.z - st.z) > 160)
    if (big.length) {
      const sx = big.reduce((a, s) => a + s.x, 0) / big.length - st.x
      const sz = big.reduce((a, s) => a + s.z, 0) / big.length - st.z
      const bv = bearingOf(sx, sz)
      // 16:9 spreads station and site across the frame; 9:16 stacks them
      const cands = PORTRAIT ? [bv, bv + 180] : [bv + 90, bv - 90]
      const best = cands.reduce((m, c) => (Math.abs(wrap180(c - head)) < Math.abs(wrap180(m - head)) ? c : m))
      b = head + clamp(wrap180(best - head), -55, 55)
    }
    return b
  }
  for (const sc of SCENES) {
    const m = sc.map
    if (sc.kind !== 'map' || !m) continue
    const st = stationById.get(m.focus_station) || stationById.get(m.train_to) || ST.reduce((a, x) => (Math.abs(x.s - sc.trainTo) < Math.abs(a.s - sc.trainTo) ? x : a))
    const sites = (m.focus_site_ids || []).map((id) => SITES.get(id)).filter((s) => s && Math.hypot(s.x - st.x, s.z - st.z) < 4000)
    sc.station = st
    sc.sites = sites
    const prevMap = SCENES.slice(0, sc.i).reverse().find((x) => x.kind === 'map' && x.station)
    sc.sameStop = !sc.travel && prevMap?.station === st && sites.length > 0
    const zoom = clamp(+m.zoom || 14, 11, 17)
    const dMin = 1500 * 2 ** (14 - zoom)
    const b = sceneBearing(sc, st, sites)
    sc.bearing = b
    const pts = sc.sameStop ? [] : [[st.x, 0, st.z]]
    for (const s of sites) {
      const lm = LM.get(s.id)
      const top = lm ? lm.top : 10
      // huge precincts (a walled city) only need their middle in frame, not their whole outline
      if (s.poly && s.r < 1300) for (const q of s.poly) pts.push([q[0], 0, q[1]], [q[0], top, q[1]])
      else pts.push([s.x, 0, s.z], [s.x, top, s.z])
    }
    sc.fitFocus = (bb) => fitShot(pts, RECT, { p: 55, b: bb, padPx: PORTRAIT ? 70 : 110, dMin, dMax: 12000 })
    sc.focusShot = sc.fitFocus(b)
    // the ride's last stop is the climax: after arriving, close in low around the monument
    // (a point site, or a slender tower such as a minar)
    if (sc === lastMap || (sites.length && (!sites[0].poly || ((LM.get(sites[0].id)?.top || 0) > 50 && sites[0].r < 40)))) {
      const s0 = sites[0]
      if (s0) {
        const lm = LM.get(s0.id)
        const cpts = [[s0.x, 0, s0.z], [s0.x, (lm?.top || 14) + 10, s0.z]]
        const tower = [...LM.values()].find((l) => l.top > 50 && l.site.r < 40 && Math.hypot(l.cx - s0.x, l.cz - s0.z) < 400)
        if (tower) cpts.push([tower.cx, 0, tower.cz], [tower.cx, tower.top, tower.cz])
        sc.fitClose = (bb) => fitShot(cpts, RECT, { p: 62, b: bb, padPx: PORTRAIT ? 120 : 170, dMin: 520, dMax: 4000 })
        sc.closeShot = sc.fitClose(b - 25)
      }
    }
    if (sc.travel) {
      sc.chaseD = clamp(1000 + 170 * sc.travel.km, 1250, 3000)
    }
  }
  for (const lm of LM.values()) lm.contains = lm.site.poly ? [...LM.values()].filter((o) => o !== lm && inside(o.cx, o.cz, lm.site.poly)).map((o) => o.site.id) : []
  // when each landmark is first lit (narration mention, else arrival)
  for (const sc of SCENES) {
    const said = new Map((sc.mentions || []).map((m) => [m.site_id, m.t]))
    for (const site of sc.sites || []) {
      const lm = LM.get(site.id)
      if (!lm) continue
      const t0 = said.get(site.id) ?? (sc.travel ? sc.travel.t1 : sc.start + 1.5)
      lm.firstLit = Math.min(lm.firstLit ?? Infinity, t0)
    }
  }
  // the dive from SPACE: eased in and out alone; after the globe, it leaves at the globe's own zoom speed
  // (ease-out, n = 2: the initial ln-distance rate is 2 * span / dur)
  const introT = (sc) => {
    if (sc !== firstMap) return null
    const i = hooks.intro
    if (!i) return { t0: sc.start + 0.5, dur: 5.6 }
    const span = Math.log(SPACE.d) - Math.log(sc.focusShot?.d || 2000)
    return { t0: i.t0, dur: clamp(i.rate > 0 ? (2 * span) / i.rate : 5, 3.5, 8), out: true }
  }
  function chase(sc, t) {
    const tr = sc.travel
    const dir = Math.sign(tr.s1 - tr.s0) || 1
    const s = trainS(t)
    const lead = sc.chaseD * 0.18
    const [x, z] = pointAt(s + dir * lead)
    // heading over a window that grows with the shot, so fast hops do not whip round every curve
    const wb = Math.max(400, sc.chaseD * 0.7)
    const wa = Math.max(900, sc.chaseD * 1.6)
    let hx = 0
    let hz = 0
    for (const k of [-1, -0.5, 0, 0.5, 1]) {
      const h = headingAt(s + k * wb * 0.5 * dir, wb, wa, dir) * DEG
      hx += Math.sin(h)
      hz += Math.cos(h)
    }
    const head = Math.atan2(hx, hz) / DEG
    return { x, z, d: sc.chaseD, p: 60, b: head + (t - sc.start) * 1.2, ax: 0.5, ay: PORTRAIT ? 0.56 : 0.6 }
  }
  function sceneState(sc, t) {
    const A = sc.camStart
    const s = sc.start
    if (sc.kind !== 'map' || !sc.focusShot) return drift(A, 0) // images cover the map: hold
    const tr = sc.travel
    const arrive = tr ? tr.t1 : s
    const settle = arrive + 1.2
    let F = drift(sc.focusShot, Math.max(0, t - settle), 0.85, 0.07 * smooth(ramp(t, settle, sc.end + 1)))
    if (sc.closeShot) {
      const c0 = tr ? arrive + 0.8 : s + 0.4
      const C = drift(sc.closeShot, Math.max(0, t - c0), 2.2, 0.06 * smooth(ramp(t, c0, sc.end)))
      F = mixState(F, C, smooth(ramp(t, c0, Math.max(c0 + 3, Math.min(sc.end - 0.5, c0 + 6)))))
    }
    const intro = introT(sc)
    if (intro) {
      const u = ramp(t, intro.t0, intro.t0 + intro.dur)
      const e = intro.out ? 1 - (1 - u) ** 2 : easeInOut(u)
      const m = mixState(A, F, e)
      // tilt late in the dive, like settling into a landing; turn gently (the globe hands over without spin)
      m.p = lerp(A.p, F.p, smooth(ramp(e, 0.3, 1)))
      m.b = lerpAngle(A.b, F.b, smooth(ramp(u, 0.05, 0.95)))
      return m
    }
    if (tr) {
      const C = chase(sc, t)
      const w1 = smooth(ramp(t, s, s + Math.min(2.0, (tr.t1 - s) * 0.7)))
      const w2 = smooth(ramp(t, tr.t1 - 0.6, tr.t1 + 2.2))
      return mixState(mixState(A, C, w1), F, w2)
    }
    return mixState(A, F, smooth(ramp(t, s, s + clamp(sc.D * 0.45, 2.2, 3.8))))
  }
  // chain: each scene starts where the previous one ended
  {
    let prevEnd = SPACE
    for (const sc of SCENES) {
      // staying at the same stop: keep turning the same way rather than swinging back
      if (sc.sameStop && prevEnd) {
        const b = prevEnd.b
        if (sc.fitFocus) sc.focusShot = sc.fitFocus(b + 4)
        if (sc.fitClose) sc.closeShot = sc.fitClose(b + 6)
      }
      sc.camStart = prevEnd
      prevEnd = sceneState(sc, sc.end)
    }
  }
  function sceneIndexAt(t) {
    for (let i = SCENES.length - 1; i >= 0; i--) if (t >= SCENES[i].start) return i
    return 0
  }
  function cameraAt(t) {
    if (!SCENES.length) return { ...SPACE }
    const st = sceneState(SCENES[sceneIndexAt(t)], t)
    const [lon, lat] = toLonLat(st.x, st.z)
    return { ...st, lon, lat }
  }
  // the inset card's camera: the main camera's angle, centred on the focus (or a named station)
  function insetView(t, target) {
    const st = cameraAt(t)
    let x = st.x
    let z = st.z
    let d = st.d
    if (target) {
      ;[x, z] = target.lon != null ? toXZ(target.lon, target.lat) : [target.x, target.z]
      d = clamp(target.d || st.d * 0.8, 500, 2600)
    }
    return { ...st, x, z, d, ax: 0.5, ay: 0.55, p: Math.min(st.p, 55) || 50, fov: PORTRAIT ? 34 : 30 }
  }

  // ---------- focus glow (fallback when the renderer does not pass its own focus list)
  function focusFallback(t) {
    const out = []
    for (const sc of SCENES) {
      if (!sc.sites?.length || t < sc.start - 1 || t > sc.end + 1) continue
      const said = new Map((sc.mentions || []).map((m) => [m.site_id, m.t]))
      sc.sites.forEach((s, i) => {
        const t0 = said.has(s.id) ? said.get(s.id) - 0.3 : (sc.travel ? sc.travel.t1 : sc.start + 1.5)
        out.push({ id: s.id, a: env(t, t0, sc.end, 0.9, 0.7), t0, primary: i === 0 })
      })
    }
    return out
  }

  // ---------- per-frame update + render
  const cN = Object.fromEntries(Object.entries(LOOK.night).map(([k, v]) => [k, typeof v === 'string' ? col(v) : v]))
  const cD = Object.fromEntries(Object.entries(LOOK.dawn).map(([k, v]) => [k, typeof v === 'string' ? col(v) : v]))
  const _c = new THREE.Color()
  const mixC = (k, d) => _c.copy(cN[k]).lerp(cD[k], d)
  let lastCam = { cam: camera, w: W, h: H }
  const _sL = new V3()
  const _sF = new V3()
  const _sR = new V3()
  const _sU = new V3()
  const _sC = new V3()
  const _up = new V3(0, 1, 0)

  function update(t, st, o) {
    const dawn = o.dawn ?? hooks.dawnAt?.(t) ?? 0
    // from very high up the street web would be a tangle: it fades in on the way down
    const vec = smooth(ramp(st.d, 150000, 50000))
    const camH = st.d * Math.cos(st.p * DEG)
    // haze: far ground fades into the sky colour; from space the fog steps back
    const k = clamp(st.d / 30000)
    SU.uFogNear.value = st.d * lerp(1.05, 1.3, k)
    SU.uFogFar.value = st.d * lerp(3.1, 4.5, k) + 600
    SU.uFogColor.value.copy(mixC('bg', dawn))
    fog.color.copy(SU.uFogColor.value)
    fog.near = SU.uFogNear.value
    fog.far = SU.uFogFar.value
    scene.background.copy(SU.uFogColor.value)
    mats.ground.uniforms.uColor.value.copy(mixC('ground', dawn))
    mats.green.uniforms.uColor.value.copy(mixC('green', dawn))
    mats.water.uniforms.uColor.value.copy(mixC('water', dawn))
    mats.water.uniforms.uSheen.value.copy(mixC('waterSheen', dawn))
    for (const m of [mats.river, mats.canal]) m?.uniforms.uColor.value.copy(mixC('water', dawn))
    if (mats.canal) mats.canal.uniforms.uOpacity.value = 0.9 * vec
    for (const r of roadMats) {
      if (!r.other) r.m.uniforms.uColor.value.copy(mixC(r.major ? 'roadMajor' : 'road', dawn))
      r.m.uniforms.uOpacity.value = r.base * lerp(1, 1.25, dawn) * vec
    }
    hemi.color.copy(mixC('hemiSky', dawn))
    hemi.groundColor.copy(mixC('hemiGround', dawn))
    hemi.intensity = lerp(cN.hemi, cD.hemi, dawn)
    sun.color.copy(mixC('sun', dawn))
    sun.intensity = lerp(cN.sunI, cD.sunI, dawn)
    const sd = cN.sunDir.map((v, i) => lerp(v, cD.sunDir[i], dawn))
    {
      // shadow frustum: around the visible ground (a little beyond the target), snapped to whole
      // shadow texels in light space so building shadows do not crawl as the camera glides
      const Ld = _sL.set(...sd).normalize()
      const fwd = _sF.copy(Ld).negate()
      const right = _sR.crossVectors(fwd, _up).normalize()
      const upL = _sU.crossVectors(right, fwd)
      const E = clamp(st.d * 1.25, 450, 7000)
      const texel = (2 * E) / SHADOW_RES
      const c = _sC.set(st.x + Math.sin(st.b * DEG) * st.d * 0.35 * Math.sin(st.p * DEG), 0, st.z - Math.cos(st.b * DEG) * st.d * 0.35 * Math.sin(st.p * DEG))
      const pr = c.dot(right)
      const pu = c.dot(upL)
      c.addScaledVector(right, Math.round(pr / texel) * texel - pr).addScaledVector(upL, Math.round(pu / texel) * texel - pu)
      sun.target.position.copy(c)
      sun.position.copy(c).addScaledVector(Ld, 6000)
      sun.target.updateMatrixWorld()
      const sc = sun.shadow.camera
      sc.left = -E
      sc.right = E
      sc.top = E
      sc.bottom = -E
      sc.near = Math.max(10, 6000 - 2.2 * E - 300)
      sc.far = 6000 + 2.2 * E + 300
      sc.updateProjectionMatrix()
      shadowCatcher.material.opacity = lerp(0.34, 0.52, dawn) * (1 - smooth(ramp(st.d, 5000, 9000)))
    }
    // a warm under-glow of the city stays a little while after the satellite view has gone
    // (500 m satellite texels: most of it is gone before they magnify into blurry blocks, ~120 km up)
    const lk = 0.88 * smooth(ramp(st.d, 125000, 205000)) + 0.12 * smooth(ramp(st.d, 50000, 140000))
    SU.uLK.value = lk * (1 - dawn)
    bloom.strength = lerp(cN.bloom, cD.bloom, dawn) * (1 - 0.55 * lk)
    renderer.toneMappingExposure = 1
    // lights fade into building tint (colors baked at night; dawn brightens through the lights)
    bldMat.color.setScalar(lerp(1, 1.45, dawn))
    // windows and floodlights go out as the day comes; trees (sub-pixel from high up) shrink away on the dive
    bldUniforms.uNight.value = 1 - 0.9 * dawn
    for (const tm of treeMats) {
      const kT = 1 - smooth(ramp(st.d, 6500, 11000))
      tm.u.uTreeK.value = kT
      tm.m.visible = kT > 0.002
      tm.m.color.setScalar(lerp(1, 1.12, dawn))
    }
    void camH

    // train
    const s = trainS(t)
    const tr = travelAt(t)
    const dir = tr ? Math.sign(tr.s1 - tr.s0) || 1 : 1
    const [x, z] = pointAt(s)
    const head = headingAt(s, 30, 30, dir)
    train.position.set(x, 0, z)
    const hb = head * DEG
    train.rotation.y = Math.atan2(Math.cos(hb), Math.sin(hb)) // +x along (sin b, -cos b)
    const mpp = Math.hypot(camera.position.x - x, camera.position.y, camera.position.z - z) / SU.uPxK.value
    const sc = Math.max(1, (24 * mpp) / 131)
    capsule.scale.set(sc, Math.max(1, (9 * mpp) / 13), Math.max(1, (9 * mpp) / 13))
    capsule.position.y = 7 * Math.max(1, (9 * mpp) / 13)
    trainGlow.position.set(x, 2, z)
    const v = Math.abs(trainS(t + 0.05) - trainS(t - 0.05)) / 0.1 // m per film-second
    trainGlow.material.uniforms.uOpacity.value = lerp(0.22, 0.5, clamp(v / 900)) * lerp(1, 0.7, dawn)
    trainLight.position.set(x, 60, z)
    trainLight.intensity = 140 * lerp(1, 0.5, dawn)
    for (const m of lineMats) {
      m.uniforms.uTrainS.value = s
      m.uniforms.uTrail.value = clamp(v * 0.5, 0, 1400)
    }
    lineCore.material.uniforms.uIntensity.value = lerp(1.5, 1.3, dawn)
    lineGlow.material.uniforms.uOpacity.value = lerp(0.2, 0.12, dawn)

    // landmarks
    const focus = o.focus || focusFallback(t)
    const glowOf = new Map()
    for (const f of focus) glowOf.set(f.id ?? f.site?.id, Math.max(glowOf.get(f.id ?? f.site?.id) || 0, f.a))
    let best = null
    for (const [id, lm] of LM) {
      const a = glowOf.get(id) || 0
      const f = focus.find((q) => (q.id ?? q.site?.id) === id)
      const pulse = a > 0 ? 0.86 + 0.14 * Math.sin(((t - (f?.t0 || 0)) * 2.1) + lm.cx * 0.001) : 1
      const memory = lm.firstLit != null ? 0.14 * smooth(ramp(t, lm.firstLit + 4, lm.firstLit + 7)) : 0
      // a precinct glows at half strength while a monument inside it is lit (Qutb complex around the minar)
      const role = lm.contains.some((id) => (glowOf.get(id) || 0) > 0.05) ? 0.5 : 1
      const aE = Math.max(a * pulse * role, memory)
      for (const m of lm.mats) m.emissiveIntensity = aE * lerp(0.36, 0.22, dawn) * (m.userData.base || 1)
      if (lm.glow) lm.glow.material.uniforms.uOpacity.value = a * role * 0.24 * pulse * lerp(1, 0.5, dawn)
      if (lm.core) lm.core.material.uniforms.uOpacity.value = a * 1.4 * pulse
      if (lm.fill) lm.fill.material.uniforms.uOpacity.value = a * (lm.site.r > 600 ? 0.012 : 0.03)
      if (lm.outline) lm.outline.material.uniforms.uOpacity.value = Math.max(a, memory * 1.5) * (lm.site.r > 600 ? 0.6 : 0.8)
      if (a > 0.01 && (!best || a > best.a)) best = { lm, a, pulse }
    }
    if (best) {
      // a warm floodlight on the camera side of the monument: lit faces keep their shading
      const lm = best.lm
      const hx = camera.position.x - lm.cx
      const hz = camera.position.z - lm.cz
      const hl = Math.hypot(hx, hz) || 1
      const off = lm.site.r + 90
      siteLight.position.set(lm.cx + (hx / hl) * off, lm.top + 60, lm.cz + (hz / hl) * off)
      siteLight.distance = lm.site.r * 2.5 + 600
      siteLight.intensity = best.a * 300 * best.pulse * lerp(1, 0.55, dawn)
    } else siteLight.intensity = 0
  }

  function renderAt(t, w = W, h = H, o = {}) {
    const st = o.view || cameraAt(t)
    const inset = w !== W || h !== H || o.inset
    applyCam(camera, st, w, h)
    SU.uPxK.value = h / (2 * Math.tan(((st.fov || FOV) * DEG) / 2))
    update(t, st, o)
    renderer.toneMapping = TONE
    renderer.setRenderTarget(null)
    if (!inset) {
      renderer.setScissorTest(false)
      renderer.setViewport(0, 0, W, H)
      composer.render()
      lastCam = { cam: camera, w, h }
      return { canvas: renderer.domElement, sx: 0, sy: 0, sw: W, sh: H }
    }
    renderer.setViewport(0, 0, w, h)
    renderer.setScissor(0, 0, w, h)
    renderer.setScissorTest(true)
    renderer.render(scene, camera)
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, W, H)
    lastCam = { cam: camera, w, h }
    // WebGL's origin is bottom-left: the viewport sits at the bottom of the canvas image
    return { canvas: renderer.domElement, sx: 0, sy: renderer.domElement.height - h, sw: w, sh: h }
  }
  function project(lon, lat, alt = 0) {
    const [x, z] = toXZ(lon, lat)
    const { cam, w, h } = lastCam
    const r = projectWith(cam, w, h, x, alt, z)
    const dist = cam.position.distanceTo(new V3(x, alt, z))
    return { x: r.x, y: r.y, visible: r.front && r.x > -50 && r.y > -50 && r.x < w + 50 && r.y < h + 50, dist }
  }
  const trainAt = (t) => {
    const [x, z] = pointAt(trainS(t))
    const [lon, lat] = toLonLat(x, z)
    return { lon, lat, s: trainS(t) / LEN }
  }
  const siteAnchor = (id) => {
    const lm = LM.get(id)
    const s = SITES.get(id)
    if (!s) return null
    const [lon, lat] = toLonLat(lm?.cx ?? s.x, lm?.cz ?? s.z)
    return { lon, lat, alt: (lm?.top ?? 10) + 4, r: s.r }
  }
  const stationAt = (id) => stationById.get(id) && { lon: toLonLat(stationById.get(id).x, stationById.get(id).z)[0], lat: toLonLat(stationById.get(id).x, stationById.get(id).z)[1] }

  const ready = (async () => {
    if (hooks.lights?.url) {
      try {
        const tex = await new THREE.TextureLoader().loadAsync(hooks.lights.url)
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy?.() || 1)
        SU.uLights.value = tex
        SU.uLB.value.set(...hooks.lights.bounds)
      } catch (e) {
        console.warn('city: night lights texture failed', e.message)
      }
    }
    renderer.compile(scene, camera)
  })()
  return {
    ready,
    canvas: renderer.domElement,
    renderAt,
    project,
    cameraAt,
    insetView,
    trainAt,
    siteAnchor,
    stationAt,
    stats: { buildings: buildingCount, tiles: tiles.size, landmarks: LM.size, trees: treeCount, synthetic: !detail?.buildings?.features?.length && synthetic },
  }
}
