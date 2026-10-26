// TimeLine renderer: window.drawFrame(t) paints second t of the film onto <canvas id="c">.
// A pure function of t and the injected data (TIMELINE, GEO, ASSET_BASE, SITE_INFO, PROJECT):
// no wall clock, no requestAnimationFrame, seeded randomness only.
// Map zoom is web-mercator with 512 px tiles (MapLibre convention) on a 1920 px wide frame.
// Look: a night ride on a glowing line, warm gold type; the train runs in a tunnel bore with wall
// lamps (PROJECT.underground) and the map turns to dawn light once it surfaces (PROJECT.dawn).
;(() => {
  'use strict'
  const q = new URLSearchParams(location.search)
  const PORTRAIT = (q.get('aspect') || '16:9') === '9:16'
  const W = PORTRAIT ? 1080 : 1920
  const H = PORTRAIT ? 1920 : 1080
  const canvas = document.getElementById('c')
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext('2d', { alpha: false, willReadFrequently: q.get('cpu') === '1' })
  // 3D map layer (three.js, render/three/city.js) under this 2D overlay; ?map=2d keeps the flat night map.
  // The WebGL canvas is drawn into this canvas each frame, so capture stays one canvas.
  const WANT3D = q.get('map') !== '2d'
  let CITY = null // createCity(...) once the 3D layer is up
  let GLOBE = null // createGlobe(...) (render/three/globe.js) for the fly-in from space
  let GLC = null // the WebGL canvas
  let ST3D = null // station id -> {lon, lat} on the 3D line

  // ---------- math
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v)
  const lerp = (a, b, u) => a + (b - a) * u
  const smooth = (u) => ((u = clamp(u)), u * u * u * (u * (u * 6 - 15) + 10))
  const easeOut = (u) => 1 - Math.pow(1 - clamp(u), 3)
  const easeInOut = (u) => ((u = clamp(u)), u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)
  const ramp = (t, a, b) => clamp((t - a) / (b - a))
  const env = (t, a, b, din, dout) => smooth(ramp(t, a, a + din)) * (1 - smooth(ramp(t, b - dout, b)))
  const rng = (seed) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0), seed / 4294967296)
  const hashStr = (s) => [...String(s)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261)
  const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  const area = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const hexRGB = (hex) => {
    const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16)
    return [n >> 16, (n >> 8) & 255, n & 255]
  }
  const rgba = (hex, a) => `rgba(${hexRGB(hex).join(',')},${a})`
  const reEsc = (s) => String(s).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')
  // blend two hex colours (u = 0..1) -> rgba string
  const mixHex = (a, b, u, alpha = 1) => {
    const A = hexRGB(a)
    const B = hexRGB(b)
    return `rgba(${A.map((v, i) => Math.round(lerp(v, B[i], u))).join(',')},${alpha})`
  }

  // ---------- look: a night ride in warm gold; the city wakes to dawn when the train surfaces
  const U = PORTRAIT ? 1.22 : 1 // type scale: phones show 9:16 small
  const COL = {
    bg: '#07070b',
    bgGlow: '#1f1925', // warm aubergine centre of the night
    green: '#3c5233', // olive, drawn at low alpha
    greenDawn: '#66915a',
    water: '#0c3940',
    waterDawn: '#3a8592',
    waterLine: '#1f7a82',
    road: '#dccbb0',
    boundary: 'rgba(226,206,170,0.24)',
    amber: '#f2a43a',
    amberHi: '#ffd28e',
    gold: '#e9b44c', // type accents (the line itself keeps its own colour)
    ink: '#f7efe1',
    inkDim: 'rgba(247,239,225,0.68)',
    halo: 'rgba(7,6,9,0.86)',
  }
  const FONT = { serif: '"TL Serif", Georgia, serif', sans: '"TL Sans", "Segoe UI", sans-serif', deva: '"TL Deva", "Nirmala UI", sans-serif' }
  const font = (w, px, fam, style = '') => `${style} ${w} ${Math.round(px)}px ${fam}`.trim()
  const XF = 0.8 // crossfade seconds

  // layout: fractions of the frame unless px
  const LAY = PORTRAIT
    ? {
        focus: [0.08, 0.36, 0.92, 0.68], // where the camera puts its subject
        overview: [0.15, 0.49, 0.85, 0.97],
        overviewEnd: [0.2, 0.62, 0.8, 0.985], // below the end card's credits
        card: { x: 72, kicker: 268, year: 470, yearPx: 210, kickPx: 30 },
        strip: { x0: 72, x1: W - 72, y: 600, kick: 568 },
        chip: { x: 72, y: 676, align: 'left' },
        attrib: { x: W - 72, y: 176, align: 'right' },
        badge: { x: 72, y: 176, align: 'left' }, // "AI-generated" (first seconds)
        aiLabel: { x: W - 72, y: 214, align: 'right' }, // "AI illustration" on image scenes
        // Shorts/Reels draw their like/comment/share column at x >= ~950: keep subtitles left of it
        sub: { px: 56, lh: 74, bottom: H - 476, maxW: W - 2 * 64 - 120, x: (W - 120) / 2 },
        pip: { x: W - 72 - 320, y: 250, w: 320, h: 320 },
        title: { x: W / 2, y: 470, align: 'center', px: 124 },
        uiRects: [[0, 0, W, 720], [0, H - 600, W, H]],
      }
    : {
        focus: [0.33, 0.2, 0.95, 0.8],
        overview: [0.6, 0.08, 0.95, 0.76],
        overviewEnd: [0.66, 0.1, 0.97, 0.86],
        card: { x: 96, kicker: 122, year: 276, yearPx: 168, kickPx: 24 },
        strip: { x0: W - 96 - 500, x1: W - 96, y: 126, kick: 94 },
        chip: { x: W - 96, y: H - 54, align: 'right' },
        attrib: { x: 96, y: H - 44, align: 'left' },
        badge: { x: 96, y: 62, align: 'left' },
        aiLabel: { x: 96, y: H - 78, align: 'left' },
        sub: { px: 44, lh: 58, bottom: H - 102, maxW: 1240, x: W / 2 },
        pip: { x: W - 96 - 440, y: 186, w: 440, h: 270 },
        title: { x: 150, y: 470, align: 'left', px: 128 },
        uiRects: [[0, 0, 700, 330], [W - 640, 0, W, 190], [300, H - 200, W, H]], // bottom: subtitles + citation chip
      }

  // ---------- projection (world units = mercator px at zoom Z0, origin near the line)
  const TILE = 512
  const Z0 = 12
  const WORLD = TILE * 2 ** Z0
  let OX = 0
  let OY = 0
  const mx = (lon) => ((lon + 180) / 360) * WORLD - OX
  const my = (lat) => {
    const s = Math.sin((lat * Math.PI) / 180)
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD - OY
  }
  const P = (c) => [mx(c[0]), my(c[1])]
  let UNITS_PER_KM = 60

  // ---------- state built by init()
  let T, GEO, DUR, FPS, SCENES, ST, SITES, LINEPTS, CUM, LEN, PATHS, OVERVIEW, OVERVIEW_END, YAMUNA_LABELS, BG, BG_DAWN, SUN, VIGNETTE, GRAIN, PIP, CUES, INFO, PROJ
  let YAMUNA_RINGS = [] // every OSM line named Yamuna (lon/lat), for the 3D map's river labels
  let YAMUNA3D = null
  let UG = null // underground span {s0, s1} along the ride (world units), from PROJECT.underground
  let LAMPS = [] // tunnel lamps along UG
  let DAWN_T = Infinity // film time the train surfaces / reaches daylight
  let GLOW = '#ffc21a' // outer glow: the line colour warmed toward amber
  const stationById = new Map()

  // ---------- geometry helpers
  function geomRings(geom) {
    if (!geom) return []
    if (geom.type === 'Polygon') return geom.coordinates
    if (geom.type === 'MultiPolygon') return geom.coordinates.flat(1)
    if (geom.type === 'LineString') return [geom.coordinates]
    if (geom.type === 'MultiLineString') return geom.coordinates
    return []
  }
  function addRings(path, rings, close) {
    if (!path) return
    for (const r of rings) {
      r.forEach((c, i) => {
        const [x, y] = P(c)
        i ? path.lineTo(x, y) : path.moveTo(x, y)
      })
      if (close) path.closePath()
    }
  }
  const isArea = (geom) => geom && (geom.type === 'Polygon' || geom.type === 'MultiPolygon')

  // centripetal Catmull-Rom through the OSM vertices (OSM maps this track with long straights)
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
    const seg = CUM[i + 1] - CUM[i] || 1
    const u = (s - CUM[i]) / seg
    const a = LINEPTS[i]
    const b = LINEPTS[i + 1] || a
    return [lerp(a[0], b[0], u), lerp(a[1], b[1], u)]
  }
  function tangentAt(s) {
    const a = pointAt(s - 3)
    const b = pointAt(s + 3)
    return Math.atan2(b[1] - a[1], b[0] - a[0])
  }
  function linePath(s0, s1) {
    const p = new Path2D()
    if (s1 <= s0) return p
    const a = pointAt(s0)
    p.moveTo(a[0], a[1])
    for (let i = arcIndex(s0) + 1; i < LINEPTS.length && CUM[i] < s1; i++) p.lineTo(LINEPTS[i][0], LINEPTS[i][1])
    const b = pointAt(s1)
    p.lineTo(b[0], b[1])
    return p
  }
  function nearestS(pt) {
    let best = 0
    let bd = Infinity
    for (let i = 0; i < LINEPTS.length; i++) {
      const d = (LINEPTS[i][0] - pt[0]) ** 2 + (LINEPTS[i][1] - pt[1]) ** 2
      if (d < bd) (bd = d), (best = i)
    }
    return CUM[best]
  }

  // ---------- camera: state = { fx, fy, z, ax, ay }: world point (fx,fy) sits at screen (ax,ay)
  const scaleOf = (z) => 2 ** (z - Z0)
  function camOf(st, w = W, h = H) {
    const s = scaleOf(st.z)
    return { x: st.fx - (st.ax - w / 2) / s, y: st.fy - (st.ay - h / 2) / s, z: st.z, s }
  }
  function fitState(pts, rect, { zMax = 16.5, zMin = 10.5, padPx = 60 } = {}) {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [x, y] of pts) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y))
    const rw = (rect[2] - rect[0]) * W - 2 * padPx
    const rh = (rect[3] - rect[1]) * H - 2 * padPx
    const z = clamp(Z0 + Math.log2(Math.min(rw / Math.max(x1 - x0, 1e-3), rh / Math.max(y1 - y0, 1e-3))), zMin, zMax)
    return { fx: (x0 + x1) / 2, fy: (y0 + y1) / 2, z, ax: ((rect[0] + rect[2]) / 2) * W, ay: ((rect[1] + rect[3]) / 2) * H }
  }
  // eased blend with a gentle zoom-out arc on long moves (van Wijk-lite)
  function mixState(a, b, e) {
    if (e <= 0) return a
    if (e >= 1) return b
    const dpx = Math.hypot(a.fx - b.fx, a.fy - b.fy) * scaleOf(Math.min(a.z, b.z))
    const bump = clamp(Math.log2(dpx / (0.7 * Math.min(W, H))), 0, 1.4) * Math.sin(Math.PI * e)
    return { fx: lerp(a.fx, b.fx, e), fy: lerp(a.fy, b.fy, e), z: lerp(a.z, b.z, e) - bump, ax: lerp(a.ax, b.ax, e), ay: lerp(a.ay, b.ay, e) }
  }
  const pushed = (st, dz) => ({ ...st, z: st.z + dz })

  // ---------- init
  function init() {
    T = window.TIMELINE
    GEO = window.GEO
    if (!T || !GEO) throw new Error('renderer: window.TIMELINE and window.GEO must be injected before load')
    DUR = T.duration
    FPS = T.fps || 30
    INFO = window.SITE_INFO || T.site_info || {}
    PROJ = { city: GEO.meta?.boundary?.name || '', line: GEO.line.name, network: GEO.line.network || '', ...(T.project || {}), ...(window.PROJECT || {}) }

    // origin at the line's centre keeps Path2D coordinates small
    const lons = GEO.line.coords.map((c) => c[0])
    const lats = GEO.line.coords.map((c) => c[1])
    const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2
    const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2
    OX = mx(lon0)
    OY = my(lat0)
    UNITS_PER_KM = WORLD / (40075.017 * Math.cos((lat0 * Math.PI) / 180))

    // ridden line
    LINEPTS = smoothLine(GEO.line.coords.map(P), 0.5)
    CUM = [0]
    for (let i = 1; i < LINEPTS.length; i++) CUM.push(CUM[i - 1] + Math.hypot(LINEPTS[i][0] - LINEPTS[i - 1][0], LINEPTS[i][1] - LINEPTS[i - 1][1]))
    LEN = CUM.at(-1)

    // stations snapped to the smoothed line
    ST = GEO.stations.map((st, i) => {
      const s = i === 0 ? 0 : i === GEO.stations.length - 1 ? LEN : nearestS(P(st.on_line || [st.lon, st.lat]))
      const [x, y] = pointAt(s)
      return { ...st, i, s, x, y, story: false, end: i === 0 || i === GEO.stations.length - 1 }
    })
    ST.forEach((st) => stationById.set(st.id, st))

    // base-map paths
    PATHS = { greenDense: new Path2D(), greenPark: new Path2D(), water: new Path2D(), river: new Path2D(), canal: new Path2D(), roads: { motorway: new Path2D(), trunk: new Path2D(), primary: new Path2D() }, boundary: new Path2D(), others: [], sitesPoly: new Path2D(), sitesApprox: new Path2D(), sitesLine: new Path2D(), heritagePoly: new Path2D(), heritageLine: new Path2D() }
    const L = GEO.layers || {}
    for (const f of L.green?.features || []) addRings(['park', 'golf'].includes(f.properties?.kind) ? PATHS.greenPark : PATHS.greenDense, geomRings(f.geometry), true)
    let yamuna = null
    YAMUNA_RINGS = []
    for (const f of L.water?.features || []) {
      if (isArea(f.geometry)) addRings(PATHS.water, geomRings(f.geometry), true)
      else {
        const kind = f.properties?.kind
        addRings(kind === 'river' ? PATHS.river : PATHS.canal, geomRings(f.geometry), false)
        if (kind === 'river' && /yamuna/i.test(f.properties?.name || '')) {
          const rings = geomRings(f.geometry)
          YAMUNA_RINGS.push(...rings)
          const longest = rings.reduce((a, r) => (r.length > (a?.length || 0) ? r : a), null)
          if (longest && longest.length > (yamuna?.length || 0)) yamuna = longest
        }
      }
    }
    for (const f of L.roads?.features || []) {
      const k = f.properties?.highway
      addRings(PATHS.roads[k] || PATHS.roads.primary, geomRings(f.geometry), false)
    }
    for (const f of L.other_lines?.features || []) {
      const p = new Path2D()
      addRings(p, geomRings(f.geometry), false)
      PATHS.others.push({ path: p, color: f.properties?.color || '#888', current: !!f.properties?.current })
    }
    PATHS.others.sort((a, b) => a.current - b.current)
    PATHS.lineFull = linePath(0, LEN)

    // river name along the Yamuna centreline, every ~5 km
    YAMUNA_LABELS = []
    if (yamuna) {
      const pts = yamuna.map(P)
      let acc = 0
      for (let i = 1; i < pts.length; i++) {
        acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
        if (acc > 5 * UNITS_PER_KM) {
          acc = 0
          const a = pts[Math.max(0, i - 2)]
          const b = pts[Math.min(pts.length - 1, i + 2)]
          let ang = Math.atan2(b[1] - a[1], b[0] - a[0])
          if (ang > Math.PI / 2) ang -= Math.PI
          if (ang < -Math.PI / 2) ang += Math.PI
          YAMUNA_LABELS.push({ x: pts[i][0], y: pts[i][1], ang, ll: yamuna[i], la: yamuna[Math.max(0, i - 2)], lb: yamuna[Math.min(pts.length - 1, i + 2)] })
        }
      }
    }

    // heritage sites: footprints only for sites the film names; the rest are a faint field of dots
    // (OSM's list also holds museums, parks and shops: only historic/heritage-tagged ones count)
    const referenced = new Set(T.scenes.flatMap((s) => s.plan?.map?.focus_site_ids || []))
    const isHeritage = (s) => {
      const k = s.tags || {}
      return !!(k.historic || k.heritage || k['heritage:operator'] || k.castle_type || k.tomb) && !/tussaud|wax/i.test(s.name || '')
    }
    SITES = new Map()
    const dots = []
    for (const s of GEO.sites || []) {
      const poly = s.polygon ? s.polygon.map(P) : null
      const line = s.line ? s.line.map(P) : null
      const ref = referenced.has(s.id)
      const her = !ref && isHeritage(s)
      // approximate footprints (a hull of surviving walls, geo.json `approximate: true`) are drawn dashed
      if (poly) addRings(ref ? (s.approximate ? PATHS.sitesApprox : PATHS.sitesPoly) : her ? PATHS.heritagePoly : null, [s.polygon], true)
      else if (line) addRings(ref ? PATHS.sitesLine : her ? PATHS.heritageLine : null, [s.line], false)
      const [x, y] = P([s.lon, s.lat])
      if (her && !poly && !line) dots.push([x, y])
      let r = 0
      for (const [px, py] of poly || line || []) r = Math.max(r, Math.hypot(px - x, py - y))
      SITES.set(s.id, { ...s, x, y, poly, line, r })
    }
    PATHS.siteDots = dots
    const lc = hexRGB(LINE())
    GLOW = `#${lc.map((v, i) => Math.round(lerp(v, [255, 150, 30][i], 0.35)).toString(16).padStart(2, '0')).join('')}`

    buildSchedule()
    buildTunnel()
    buildLabels()
    buildCues()
    buildCanvases()
  }

  // ---------- scenes, train schedule, cameras
  const IMG_KINDS = new Set(['illustration', 'personal', 'title', 'end'])
  // "c. 1303" -> {pre 'c.', num 1303}; "1912-1931" -> suffix "– 1931" (an en dash: a hyphen reads as a
  // minus sign); lo/hi = the era as signed years (BC/BCE negative) for range checks
  function parseYear(y) {
    const m = String(y || '').match(/^(.*?)(\d{3,4})(.*)$/)
    if (!m) return null
    const suf = m[3].trim().replace(/^[-–—]\s*/, '– ')
    const sign = /\bB\.?\s?C/i.test(suf) ? -1 : 1
    const hi = suf.match(/\d{3,4}/)
    return { pre: m[1].trim(), num: +m[2], suf, lo: sign * +m[2], hi: sign * (hi ? +hi[0] : +m[2]) }
  }
  const inEra = (yp, era, slack = 25) => !!(yp && era && yp.lo >= Math.min(era.lo, era.hi) - slack && yp.hi <= Math.max(era.lo, era.hi) + slack)
  // point-in-polygon (world units)
  function inside(x, y, poly) {
    let c = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]
      const [xj, yj] = poly[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) c = !c
    }
    return c
  }
  function buildSchedule() {
    SCENES = T.scenes.map((s, i) => {
      const plan = s.plan || {}
      const os = plan.on_screen || {}
      return { ...s, i, D: s.end - s.start, plan, map: plan.map || null, headline: (os.headline || '').trim(), year: (os.year || '').trim(), img: null, imgKind: IMG_KINDS.has(s.kind) }
    })
    for (const sc of SCENES) {
      for (const id of [sc.map?.train_to, sc.map?.focus_station]) if (stationById.has(id)) stationById.get(id).story = true
      sc.yearP = parseYear(sc.year)
      // the card shows the year big: "Partition, 1947" above a giant 1947 says it twice
      if (sc.yearP && sc.headline) sc.headline = sc.headline.replace(new RegExp(`[\\s,:·–—-]+${sc.yearP.num}$`), '').trim() || sc.headline
      sc.card =(sc.kind === 'map' || sc.kind === 'illustration' || sc.kind === 'personal') && (sc.headline || sc.year)
      // landmark painting on a map scene (timeline `image` + `reveal`, written by timing from the
      // plan's `landmark`): crossfades in full-bleed once the train has arrived
      sc.land = sc.kind === 'map' && sc.image && Number.isFinite(+sc.reveal) ? { src: sc.image, reveal: +sc.reveal, img: null } : null
    }

    // train: travels between stations, eased, timed by distance
    const firstTo = SCENES.find((s) => stationById.has(s.map?.train_to))
    let cur = firstTo ? stationById.get(firstTo.map.train_to).s : 0
    for (const sc of SCENES) {
      sc.trainFrom = cur
      const to = stationById.get(sc.map?.train_to)
      if (to && Math.abs(to.s - cur) > 1) {
        const km = Math.abs(to.s - cur) / UNITS_PER_KM
        const dur = clamp(1.6 + 0.5 * km, 2.4, Math.max(2.4, Math.min(8.5, 0.6 * sc.D)))
        const t0 = sc.start + 0.3
        sc.travel = { t0, t1: t0 + dur, s0: cur, s1: to.s, from: ST.find((x) => Math.abs(x.s - cur) < 1) || null, to }
        cur = to.s
      }
      sc.trainTo = cur
    }

    // overview of the whole ride
    const ride = LINEPTS.filter((_, i) => i % 20 === 0).concat([LINEPTS.at(-1)])
    OVERVIEW = fitState(ride, LAY.overview, { zMax: 13, padPx: 40 })
    OVERVIEW_END = fitState(ride, LAY.overviewEnd, { zMax: 13, padPx: 40 })

    // per-scene shots
    const lastMap = SCENES.filter((s) => s.kind === 'map' && s.map).at(-1)
    for (const sc of SCENES) {
      const m = sc.map
      if (sc.kind !== 'map' || !m) continue
      const zPlan = clamp(+m.zoom || 14.2, 11, 16.5)
      const st = stationById.get(m.focus_station) || stationById.get(m.train_to) || ST.find((x) => Math.abs(x.s - sc.trainTo) < 1)
      const pts = [st ? [st.x, st.y] : pointAt(sc.trainTo)]
      sc.focusSites = (m.focus_site_ids || []).map((id) => SITES.get(id)).filter((s) => s && (!st || Math.hypot(s.x - st.x, s.y - st.y) < 4 * UNITS_PER_KM))
      for (const s of sc.focusSites) {
        pts.push([s.x, s.y])
        for (const p of s.poly || s.line || []) pts.push(p)
      }
      sc.focusStation = st || null
      sc.focus = fitState(pts, LAY.focus, { zMax: zPlan, padPx: PORTRAIT ? 70 : 110 })
      // the ride's last stop is the climax: after arriving, close in on its sites' footprints
      const fp = sc.focusSites.flatMap((s) => s.poly || s.line || [])
      if (sc === lastMap && fp.length) {
        const close = fitState([...fp, ...sc.focusSites.map((s) => [s.x, s.y])], LAY.focus, { zMax: 16.5, zMin: sc.focus.z, padPx: PORTRAIT ? 60 : 90 })
        if (close.z > sc.focus.z + 0.6) sc.close = close
      }
      if (sc.travel) {
        const a = pointAt(sc.travel.s0)
        const b = pointAt(sc.travel.s1)
        sc.travelShot = fitState([a, b], LAY.focus, { zMax: Math.min(zPlan, 14.4), padPx: PORTRAIT ? 90 : 120 })
      }
    }
    // chain cameras so each scene starts where the previous one ended
    let prevEnd = OVERVIEW
    for (const sc of SCENES) {
      sc.camStart = prevEnd
      prevEnd = sceneState(sc, sc.end)
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
  // ---------- tunnel + dawn. PROJECT.underground: true | [from, to] | {from, to}; each end is km along
  // the ride, a station name/id, or omitted (= ride start / end). `from` is the first underground
  // station (inside the tunnel); `to` (alias `first_surface`) is the FIRST STATION ABOVE GROUND: the
  // train surfaces just before it. Or name `last_underground`: the train surfaces just after it.
  // Dawn breaks as the train surfaces (or arrives, with no tunnel).
  function stationRef(v) {
    const k = String(v).trim().toLowerCase()
    return ST.find((st) => st.id === v || st.name.toLowerCase() === k || (st.alt_names || []).some((a) => String(a).toLowerCase() === k))
  }
  function buildTunnel() {
    const spec = PROJ.underground
    const kmToS = (km) => clamp((+km / (GEO.line.length_km || LEN / UNITS_PER_KM)) * LEN, 0, LEN)
    const end = (v, isTo) => {
      if (v == null || v === '') return isTo ? LEN : 0
      if (Number.isFinite(+v)) return kmToS(v)
      const st = stationRef(v)
      if (!st) return isTo ? LEN : 0
      if (!isTo || st.i === 0) return st.s
      return lerp(ST[st.i - 1].s, st.s, 0.6) // portal between the previous station and this one
    }
    UG = null
    if (spec === true) UG = { s0: 0, s1: LEN }
    else if (Array.isArray(spec) || (spec && typeof spec === 'object')) {
      const [a, b] = Array.isArray(spec) ? spec : [spec.from ?? spec.from_km, spec.to ?? spec.first_surface ?? spec.to_km]
      const s0 = end(a, false)
      let s1 = end(b, true)
      const last = !Array.isArray(spec) && spec.last_underground != null && stationRef(spec.last_underground)
      if (last) s1 = last.i < ST.length - 1 ? lerp(last.s, ST[last.i + 1].s, 0.4) : LEN
      if (s1 - s0 > 1) UG = { s0, s1 }
    }
    LAMPS = []
    if (UG) {
      const step = 0.16 * UNITS_PER_KM
      for (let s = UG.s0 + step / 2; s < UG.s1 - step / 3; s += step) {
        const [x, y] = pointAt(s)
        LAMPS.push({ s, x, y, ang: tangentAt(s) + Math.PI / 2 })
      }
    }
    // first film time the train passes the daylight point
    DAWN_T = Infinity
    if (PROJ.dawn === false) return
    const sp = UG && UG.s1 < LEN - 1 ? UG.s1 : LEN - 0.5
    for (const sc of SCENES) {
      const tr = sc.travel
      if (!tr || Math.min(tr.s0, tr.s1) > sp || Math.max(tr.s0, tr.s1) < sp) continue
      let lo = tr.t0
      let hi = tr.t1
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2
        ;(trainS(mid) - sp) * Math.sign(tr.s1 - tr.s0) < 0 ? (lo = mid) : (hi = mid)
      }
      DAWN_T = hi
      break
    }
    // when the narration announces the daylight a little before the train surfaces ("The train now comes
    // up into daylight"), the sky starts to pale on those words so picture and voice agree
    PREDAWN_T = Infinity
    if (Number.isFinite(DAWN_T)) {
      const cue = (T.cues || []).find((c) => c.start < DAWN_T && c.start > DAWN_T - 12 && /\b(daylight|daybreak|dawn|sunrise|sunlight|surfaces?|comes? up)\b/i.test(c.text || ''))
      if (cue) PREDAWN_T = cue.start
    }
  }
  let PREDAWN_T = Infinity
  const dawnAt = (t) => Math.max(0.42 * smooth(ramp(t, PREDAWN_T, PREDAWN_T + 3.4)), smooth(ramp(t, DAWN_T - 0.3, DAWN_T + 3.2)))

  function sceneState(sc, t) {
    const A = sc.camStart
    const s = sc.start
    if (sc.kind === 'title' || (sc.kind === 'end' && !sc.focus)) {
      const O = pushed(sc.kind === 'end' ? OVERVIEW_END : OVERVIEW, 0.22 * ramp(t, s, sc.end))
      return sc.i === 0 ? O : mixState(A, O, smooth(ramp(t, s, s + Math.min(3.5, sc.D * 0.6))))
    }
    if (!sc.focus) return pushed(A, 0.12 * ramp(t, s, sc.end)) // illustration/personal: hold, slow push
    const tr = sc.travel
    const arrive = tr ? tr.t1 : s
    let F = pushed(sc.focus, 0.24 * smooth(ramp(t, arrive, sc.end + 1)))
    if (sc.close) F = mixState(F, sc.close, smooth(ramp(t, arrive + 1, Math.max(arrive + 3, sc.end - 0.4))))
    if (tr) {
      const p = pointAt(trainS(t))
      const Tsh = { ...sc.travelShot, fx: lerp(sc.travelShot.fx, p[0], 0.3), fy: lerp(sc.travelShot.fy, p[1], 0.3) }
      const w1 = smooth(ramp(t, s, s + Math.min(2.2, (tr.t1 - s) * 0.75)))
      const w2 = smooth(ramp(t, tr.t1 - 0.9, tr.t1 + 1.9))
      return mixState(mixState(A, Tsh, w1), F, w2)
    }
    return mixState(A, F, smooth(ramp(t, s, s + flyTime(sc))))
  }
  const flyTime = (sc) => clamp(sc.D * 0.45, 2.2, 3.8)
  function sceneIndexAt(t) {
    for (let i = SCENES.length - 1; i >= 0; i--) if (t >= SCENES[i].start) return i
    return 0
  }

  // ---------- labels: station label sides + zoom thresholds (collisions depend only on zoom)
  const ST_EN = () => font(600, 23 * U, FONT.sans)
  const ST_HI = () => font(500, 20 * U, FONT.deva)
  function buildLabels() {
    g.save()
    const off = 15 * U
    for (const st of ST) {
      g.font = ST_EN()
      const wEn = g.measureText(st.name).width
      g.font = ST_HI()
      const wHi = st.name_local ? g.measureText(st.name_local).width : 0
      st.lw = Math.max(wEn, wHi)
      // pick the side whose box crosses the line least (at zoom 14)
      const s14 = scaleOf(14)
      let best = null
      for (const side of [1, -1]) {
        const box = side > 0 ? [off, -24 * U, off + st.lw, 30 * U] : [-off - st.lw, -24 * U, -off, 30 * U]
        let hits = 0
        for (let i = 0; i < LINEPTS.length; i += 4) {
          const px = (LINEPTS[i][0] - st.x) * s14
          const py = (LINEPTS[i][1] - st.y) * s14
          if (px > box[0] - 6 && px < box[2] + 6 && py > box[1] - 6 && py < box[3] + 6) hits++
        }
        if (!best || hits < best.hits) best = { side, hits, box }
      }
      st.side = best.side
      st.box = best.box
    }
    // Priority order: ends, story stations, then the rest. Screen gaps grow with zoom while label
    // sizes stay fixed, so each pair collides below a critical zoom. A label shows from the
    // lowest zoom at which it never meets a higher-priority label that is visible.
    const ZS = []
    for (let z = 10; z <= 17.5; z += 0.05) ZS.push(z)
    const crit = (a, ab, b, bb) => {
      for (let k = ZS.length - 1; k >= 0; k--) {
        const s = scaleOf(ZS[k])
        if (overlaps([a.x * s + ab[0], a.y * s + ab[1], a.x * s + ab[2], a.y * s + ab[3]], [b.x * s + bb[0], b.y * s + bb[1], b.x * s + bb[2], b.y * s + bb[3]])) return ZS[k] + 0.05
      }
      return 10
    }
    const order = [...ST].sort((a, b) => (b.end * 2 + b.story) - (a.end * 2 + a.story) || a.s - b.s)
    const placed = []
    const dot = [-8, -8, 8, 8]
    for (const st of order) {
      let z = 10
      for (const o of ST) if (o !== st) z = Math.max(z, crit(st, st.box, o, dot))
      for (const o of placed) {
        const zc = crit(st, st.box, o, o.box)
        if (zc > o.minZ) z = Math.max(z, zc)
      }
      st.minZ = z
      placed.push(st)
    }
    // focus-site label placement per scene, at that scene's settled camera
    for (const sc of SCENES) {
      if (!sc.focusSites?.length) continue
      const cam = camOf(sc.close || pushed(sc.focus, 0.12))
      const toS = (x, y) => [(x - cam.x) * cam.s + W / 2, (y - cam.y) * cam.s + H / 2]
      const blocks = [...LAY.uiRects]
      for (const o of ST) {
        const [x, y] = toS(o.x, o.y)
        blocks.push([x - 9, y - 9, x + 9, y + 9])
        if (labelAlpha(o, cam.z) > 0.3) blocks.push([x + o.box[0], y + o.box[1], x + o.box[2], y + o.box[3]])
      }
      // keep site names off the glowing line
      for (let k = 0; k < LINEPTS.length; k += 2) {
        const [x, y] = toS(LINEPTS[k][0], LINEPTS[k][1])
        if (x > -20 && y > -20 && x < W + 20 && y < H + 20) blocks.push([x - 8, y - 8, x + 8, y + 8])
      }
      sc.siteLabels = []
      const markers = sc.focusSites.map((site) => {
        const [sx, sy] = toS(site.x, site.y)
        return { id: site.id, box: [sx - 10, sy - 10, sx + 10, sy + 10] }
      })
      // other sites' footprints (screen bboxes), so a name never sits on a neighbour's outline
      const prints = sc.focusSites.filter((s) => s.poly).map((s) => {
        const p = s.poly.map(([x, y]) => toS(x, y))
        return { site: s, box: [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))] }
      })
      for (const site of sc.focusSites) {
        const [sx, sy] = toS(site.x, site.y)
        const name = siteName(site)
        // a precinct around the scene's own monument ("Qutb complex" around "Qutb Minar") glows unlabelled;
        // a city around other sites (Shahjahanabad around the Red Fort) keeps its name
        const words = (s) => new Set(siteName(s).toLowerCase().split(/[^a-zÀ-￿]+/).filter((w) => w.length > 2 && !/^(the|and|complex|precinct|area|park)$/.test(w)))
        const mine = words(site)
        if (site.poly && sc.focusSites.some((o) => o !== site && inside(o.x, o.y, site.poly) && [...words(o)].some((w) => mine.has(w)))) {
          sc.siteLabels.push({ site, hidden: true })
          continue
        }
        // a year inside the card's era would only repeat it; any other year stays, so a site from
        // another era never borrows the card's date
        const yTxt = INFO[site.id]?.year || siteYear(site)
        const year = yTxt && !(sc.yearP && inEra(parseYear(yTxt), sc.yearP)) ? yTxt : ''
        g.font = siteNameFont()
        const wN = g.measureText(name).width
        g.font = siteYearFont()
        g.letterSpacing = '0.12em'
        const wY = year ? g.measureText(year).width : 0
        g.letterSpacing = '0px'
        const bw = Math.max(wN, wY) + 8
        const bh = (year ? 64 : 40) * U
        const rPx = site.r * cam.s
        const rr = Math.max(14, Math.min(rPx * 0.55, 90) + 8)
        const cands = []
        // big footprints carry their name inside
        if (rPx > bw * 0.55 + 10) cands.push({ box: [sx - bw / 2, sy - bh / 2, sx + bw / 2, sy + bh / 2], cost: 0, leader: false, inside: true })
        for (const rad of [rr, rr + 50, rr + 110, rr + 180]) {
          for (const [dx, dy] of [[1, 0], [-1, 0], [0.7, -0.7], [0.7, 0.7], [-0.7, -0.7], [-0.7, 0.7], [0, -1], [0, 1]]) {
            const ax = sx + dx * rad
            const ay = sy + dy * rad
            const x0 = dx > 0.3 ? ax : dx < -0.3 ? ax - bw : ax - bw / 2
            const y0 = dy > 0.3 ? ay : dy < -0.3 ? ay - bh : ay - bh / 2
            cands.push({ box: [x0, y0, x0 + bw, y0 + bh], cost: rad * 2 + (dx < 0 ? 15 : 0), leader: rad > rr + 1 })
          }
        }
        let best = null
        for (const c of cands) {
          let cost = c.cost
          const box = c.box
          if (box[0] < 24 || box[2] > W - 24 || box[1] < 24 || box[3] > H - 24) cost += 1e6
          for (const b of blocks) cost += area(box, b) * 4
          for (const m of markers) if (m.id !== site.id) cost += area(box, m.box) * 4
          for (const f of prints) if (f.site !== site && !inside(site.x, site.y, f.site.poly)) cost += area(box, f.box) * 2
          if (!best || cost < best.cost) best = { ...c, cost }
        }
        blocks.push(best.box)
        sc.siteLabels.push({ site, name, year, dx: best.box[0] - sx, dy: best.box[1] - sy, w: bw, h: bh, leader: best.leader, inside: !!best.inside })
      }
    }
    g.restore()
  }
  const siteNameFont = () => font(500, 33 * U, FONT.serif, 'italic')
  const siteYearFont = () => font(600, 17 * U, FONT.sans)
  function siteName(site) {
    const raw = String(site.display_name || INFO[site.id]?.label || site.name || '') // display_name: project footprints file
    const city = String(PROJ.city || '').toLowerCase()
    let out = raw
    for (const suf of [`, new ${city}`, `, ${city}`, ` of new ${city}`, ` of ${city}`]) if (city && out.toLowerCase().endsWith(suf)) out = out.slice(0, -suf.length)
    return out.charAt(0).toUpperCase() + out.slice(1)
  }
  function siteYear(site) {
    const d = site.tags?.start_date || ''
    const m = d.match(/^(\d{3,4})/)
    return m ? m[1] : ''
  }
  const labelAlpha = (st, z) => smooth(ramp(z, st.minZ - 0.02, st.minZ + 0.3))

  // ---------- subtitles: lines that fit this frame's measure. Prefer the timing stage's breaks;
  // else a balanced, punctuation-aware split into 1-2 lines; 3 only if 2 cannot fit (9:16).
  const ORPHAN = /^(a|an|the|and|or|but|of|to|in|i|my|his|her|its|at|for|on|by|with|from)$/i
  function buildCues() {
    const maxW = LAY.sub.maxW - 48
    CUES = (T.cues || []).map((c) => {
      const given = (c.lines || String(c.text || '').split('\n')).map((l) => l.trim()).filter(Boolean)
      const words = given.join(' ').split(/\s+/)
      // a cue that fits comfortably on one line stays on one line ("Sit down, traveller.")
      g.font = font(500, LAY.sub.px, FONT.sans)
      if (g.measureText(words.join(' ')).width <= 0.8 * maxW) return { ...c, px: LAY.sub.px, lines: [words.join(' ')] }
      let best = null
      for (let px = LAY.sub.px; px >= LAY.sub.px * 0.84; px -= 2) {
        g.font = font(500, px, FONT.sans)
        const shrink = (LAY.sub.px - px) * 0.012
        if (given.length <= 2 && given.every((l) => g.measureText(l).width <= maxW)) {
          const cost = shrink - 0.1
          if (!best || cost < best.cost) best = { cost, px, lines: given }
        }
        for (const n of [1, 2, 3]) {
          const r = splitLines(words, n, maxW)
          if (!r) continue
          const cost = r.cost + shrink + (n === 3 ? 0.45 : 0)
          if (!best || cost < best.cost) best = { cost, px, lines: r.lines }
        }
      }
      if (!best) {
        g.font = font(500, LAY.sub.px * 0.84, FONT.sans)
        best = { px: LAY.sub.px * 0.84, lines: greedy(words, maxW) }
      }
      return { ...c, px: best.px, lines: best.lines }
    })
  }
  // exact split of words into n lines (DP), cost = width imbalance + bad-break penalties
  function splitLines(words, n, maxW) {
    const N = words.length
    if (n > N) return null
    const width = (i, j) => g.measureText(words.slice(i, j).join(' ')).width
    const memo = new Map()
    const go = (i, k) => {
      const key = i * 8 + k
      if (memo.has(key)) return memo.get(key)
      let res = null
      if (k === 1) {
        const w = width(i, N)
        res = w <= maxW ? { cost: 0, ws: [w], cuts: [] } : null
      } else {
        for (let j = i + 1; j <= N - k + 1; j++) {
          const w = width(i, j)
          if (w > maxW) break
          const rest = go(j, k - 1)
          if (!rest) continue
          const last = words[j - 1]
          const pen = (/[,;:.!?—–]$/.test(last) ? -0.3 : 0) + (ORPHAN.test(last) ? 0.35 : 0)
          const cost = rest.cost + pen
          const cand = { cost, ws: [w, ...rest.ws], cuts: [j, ...rest.cuts] }
          const imb = (x) => (Math.max(...x.ws) - Math.min(...x.ws)) / maxW
          if (!res || cost + imb(cand) < res.cost + imb(res)) res = cand
        }
      }
      memo.set(key, res)
      return res
    }
    const r = go(0, n)
    if (!r) return null
    const lines = []
    let i = 0
    for (const j of [...r.cuts, N]) lines.push(words.slice(i, j).join(' ')), (i = j)
    return { lines, cost: r.cost + (Math.max(...r.ws) - Math.min(...r.ws)) / maxW + (n === 1 ? -0.05 : 0) }
  }
  function greedy(words, maxW) {
    const lines = []
    let cur = ''
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w
      if (g.measureText(next).width > maxW && cur) lines.push(cur), (cur = w)
      else cur = next
    }
    if (cur) lines.push(cur)
    return lines
  }

  // ---------- canvases made once: background, vignette, grain tiles, PiP buffer
  function buildCanvases() {
    const mk = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h })
    BG = mk(W, H)
    let c = BG.getContext('2d')
    c.fillStyle = COL.bg
    c.fillRect(0, 0, W, H)
    let gr = c.createRadialGradient(W * 0.6, H * 0.45, 0, W * 0.6, H * 0.45, Math.hypot(W, H) * 0.6)
    gr.addColorStop(0, rgba(COL.bgGlow, 0.95))
    gr.addColorStop(1, rgba(COL.bgGlow, 0))
    c.fillStyle = gr
    c.fillRect(0, 0, W, H)

    // dawn: a real morning: cool blue in the west warming to a peach horizon in the east (the right
    // edge of a north-up map), kept mid-dark so the light type and the gold line still read
    BG_DAWN = mk(W, H)
    c = BG_DAWN.getContext('2d')
    gr = c.createLinearGradient(0, H * 0.3, W, 0)
    gr.addColorStop(0, '#26324a')
    gr.addColorStop(0.5, '#363c52')
    gr.addColorStop(0.82, '#5e4f5c')
    gr.addColorStop(1, '#8a6a5a')
    c.fillStyle = gr
    c.fillRect(0, 0, W, H)
    SUN = mk(W, H)
    c = SUN.getContext('2d')
    const sx = W * 1.08
    const sy = H * (PORTRAIT ? 0.18 : 0.12)
    gr = c.createRadialGradient(sx, sy, 0, sx, sy, Math.hypot(W, H) * 0.75)
    gr.addColorStop(0, 'rgba(255,214,160,0.78)')
    gr.addColorStop(0.32, 'rgba(244,166,118,0.24)')
    gr.addColorStop(1, 'rgba(120,90,130,0)')
    c.fillStyle = gr
    c.fillRect(0, 0, W, H)

    VIGNETTE = mk(W, H)
    c = VIGNETTE.getContext('2d')
    const diag = Math.hypot(W, H) / 2
    gr = c.createRadialGradient(W / 2, H / 2, diag * 0.42, W / 2, H / 2, diag * 1.02)
    gr.addColorStop(0, 'rgba(0,0,0,0)')
    gr.addColorStop(0.6, 'rgba(0,0,0,0.22)')
    gr.addColorStop(1, 'rgba(0,0,0,0.62)')
    c.fillStyle = gr
    c.fillRect(0, 0, W, H)

    GRAIN = []
    const r = rng(7)
    for (let k = 0; k < 6; k++) {
      const tile = mk(256, 256)
      const tc = tile.getContext('2d')
      const id = tc.createImageData(256, 256)
      for (let i = 0; i < id.data.length; i += 4) {
        const v = 128 + (r() + r() + r() - 1.5) * 70
        id.data[i] = id.data[i + 1] = id.data[i + 2] = v
        id.data[i + 3] = 255
      }
      tc.putImageData(id, 0, 0)
      GRAIN.push(g.createPattern(tile, 'repeat'))
    }
    PIP = mk(LAY.pip.w, LAY.pip.h)
  }

  // ---------- map drawing (any context/size; used for the main frame and the PiP)
  function drawMap(c, cam, w, h, o) {
    const s = cam.s
    const px = 1 / s
    const zf = clamp(2 ** ((cam.z - 13.5) * 0.4), 0.7, 1.7)
    const d = o.dawn || 0
    const world = () => c.setTransform(s, 0, 0, s, w / 2 - cam.x * s, h / 2 - cam.y * s)
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.globalAlpha = 1
    c.globalCompositeOperation = 'source-over'
    if (o.bg) {
      c.drawImage(o.bg, 0, 0)
      if (d > 0.001) (c.globalAlpha = d), c.drawImage(BG_DAWN, 0, 0), (c.globalAlpha = 1)
    } else (c.fillStyle = mixHex(COL.bg, '#1d1b22', d)), c.fillRect(0, 0, w, h)
    if (!o.mini) drawGrid(c, cam, w, h)
    world()
    c.lineJoin = 'round'
    c.lineCap = 'round'
    c.fillStyle = mixHex(COL.green, COL.greenDawn, d, lerp(0.5, 0.36, d))
    c.fill(PATHS.greenDense, 'evenodd')
    c.fillStyle = mixHex(COL.green, COL.greenDawn, d, lerp(0.36, 0.28, d))
    c.fill(PATHS.greenPark, 'evenodd')
    c.fillStyle = mixHex(COL.water, COL.waterDawn, d)
    c.fill(PATHS.water, 'evenodd')
    c.strokeStyle = mixHex(COL.waterLine, '#5fa6ad', d)
    c.globalAlpha = 0.9
    c.lineWidth = 2.4 * zf * px
    c.stroke(PATHS.river)
    c.globalAlpha = 0.45
    c.lineWidth = 1.1 * zf * px
    c.stroke(PATHS.canal)
    c.strokeStyle = COL.road
    for (const [k, lw, a] of [['primary', 1, 0.07], ['trunk', 1.4, 0.09], ['motorway', 2, 0.12]]) {
      c.globalAlpha = a * (1 + 0.8 * d)
      c.lineWidth = lw * zf * px
      c.stroke(PATHS.roads[k])
    }
    c.globalAlpha = 1
    // administrative boundaries (national or state) are never drawn
    for (const ol of PATHS.others) {
      if (ol.current) continue // the ridden line's own unridden ends: drawn below with the ride
      c.globalAlpha = 0.26
      c.strokeStyle = ol.color
      c.lineWidth = 2.2 * zf * px
      c.stroke(ol.path)
    }
    c.globalAlpha = 1
    // dawn light from the east, under the line and labels
    if (d > 0.001 && !o.mini) {
      c.setTransform(1, 0, 0, 1, 0, 0)
      c.globalCompositeOperation = 'screen'
      c.globalAlpha = d
      c.drawImage(SUN, 0, 0)
      c.globalCompositeOperation = 'source-over'
      c.globalAlpha = 1
      world()
    }
    // other heritage footprints as quiet context; the film's own sites a little stronger until their scene
    c.strokeStyle = 'rgba(255,200,130,0.16)'
    c.lineWidth = 1 * px
    c.stroke(PATHS.heritagePoly)
    c.setLineDash([4 * px, 4 * px])
    c.stroke(PATHS.heritageLine)
    c.setLineDash([])
    c.fillStyle = 'rgba(242,164,58,0.1)'
    c.fill(PATHS.sitesPoly)
    c.strokeStyle = 'rgba(255,200,130,0.34)'
    c.stroke(PATHS.sitesPoly)
    c.setLineDash([4 * px, 4 * px])
    c.stroke(PATHS.sitesLine)
    c.fillStyle = 'rgba(242,164,58,0.05)'
    c.fill(PATHS.sitesApprox)
    c.setLineDash([9 * px, 7 * px])
    c.strokeStyle = 'rgba(255,200,130,0.3)'
    c.stroke(PATHS.sitesApprox)
    c.setLineDash([])

    // the rest of the line (beyond the ride), faint in its colour
    for (const ol of PATHS.others) {
      if (!ol.current) continue
      c.globalAlpha = 0.3
      c.strokeStyle = LINE()
      c.lineWidth = 2.2 * zf * px
      c.stroke(ol.path)
    }
    // the ride: casing, tunnel bore, faint route ahead, glowing ridden part
    const sT = o.trainS
    const reveal = o.reveal ?? 1
    const sMax = LEN * reveal
    c.globalAlpha = 1
    c.strokeStyle = 'rgba(0,0,0,0.55)'
    c.lineWidth = 9 * zf * px
    c.stroke(reveal < 1 ? linePath(0, sMax) : PATHS.lineFull)
    const lampA = o.mini ? 0 : smooth(ramp(cam.z, 12.4, 13.3))
    if (UG && UG.s0 < sMax) {
      const bore = linePath(UG.s0, Math.min(UG.s1, sMax))
      c.strokeStyle = rgba(COL.gold, lerp(0.16, 0.34, lampA))
      c.lineWidth = 16 * zf * px
      c.stroke(bore)
      c.strokeStyle = 'rgba(9,8,11,0.94)'
      c.lineWidth = 12.5 * zf * px
      c.stroke(bore)
    }
    const routeGlow = o.routeGlow || 0
    c.strokeStyle = LINE()
    c.globalAlpha = lerp(0.42, 0.75, routeGlow)
    c.lineWidth = 2.6 * zf * px
    c.stroke(linePath(sT, sMax))
    const ridden = linePath(0, Math.min(sT, sMax))
    const ahead = routeGlow > 0.01 ? linePath(sT, sMax) : null
    c.globalCompositeOperation = 'lighter'
    const gk = 1 - 0.3 * d // less bloom in daylight
    for (const [lw, a] of [[40, 0.03], [22, 0.065], [12, 0.15], [6, 0.42]]) {
      c.strokeStyle = lw > 15 ? GLOW : LINE()
      c.lineWidth = lw * zf * px
      c.globalAlpha = a * gk
      c.stroke(ridden)
      if (ahead) (c.globalAlpha = a * routeGlow * 0.75), c.stroke(ahead)
    }
    c.globalCompositeOperation = 'source-over'
    c.globalAlpha = 1
    c.strokeStyle = '#fff4c4'
    c.lineWidth = 2.2 * zf * px
    c.stroke(ridden)

    // tunnel lamps: small lights on alternating walls of the bore, flaring as the train passes
    if (LAMPS.length && lampA > 0.01) {
      const off = 7.2 * zf * px
      const r = 1.5 * zf * px
      const kmU = UNITS_PER_KM
      const dim = new Path2D()
      const lit = []
      c.globalCompositeOperation = 'lighter'
      LAMPS.forEach((lp, k) => {
        if (lp.s > sMax) return
        const side = k & 1 ? 1 : -1
        const x = lp.x + Math.cos(lp.ang) * off * side
        const y = lp.y + Math.sin(lp.ang) * off * side
        const near = Math.exp(-(((lp.s - sT) / (0.32 * kmU)) ** 2))
        if (near > 0.04) lit.push([x, y, near])
        else dim.moveTo(x + r, y), dim.arc(x, y, r, 0, Math.PI * 2)
      })
      c.fillStyle = '#ffd9a0'
      c.globalAlpha = lampA * 0.38
      c.fill(dim)
      for (const [x, y, near] of lit) {
        const R = (3 + 9 * near) * zf * px
        const gr = c.createRadialGradient(x, y, 0, x, y, R)
        gr.addColorStop(0, 'rgba(255,236,200,1)')
        gr.addColorStop(0.25, 'rgba(255,200,120,0.55)')
        gr.addColorStop(1, 'rgba(255,170,80,0)')
        c.globalAlpha = lampA * (0.4 + 0.6 * near)
        c.fillStyle = gr
        c.fillRect(x - R, y - R, 2 * R, 2 * R)
      }
      c.globalCompositeOperation = 'source-over'
      c.globalAlpha = 1
    }

    // focus sites: footprints draw themselves in, then hold a warm glow
    for (const f of o.focus || []) {
      if (f.a <= 0.01) continue
      const site = f.site
      if (!site.poly && !site.line) continue
      if (!site.path) {
        site.path = new Path2D()
        addRingsW(site.path, site.poly || site.line, !!site.poly)
        site.perim = 0
        const pts = site.poly || site.line
        for (let k = 1; k < pts.length; k++) site.perim += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1])
      }
      const p = site.path
      const draw = f.u ?? 1
      c.globalAlpha = f.a
      if (site.approximate && site.poly) {
        // an approximate extent (hull of surviving walls): dashed outline, light fill, no glow
        c.fillStyle = `rgba(242,164,58,${0.1 * smooth(ramp(draw, 0.35, 1))})`
        c.fill(p)
        c.setLineDash([10 * px, 8 * px])
        c.lineDashOffset = -site.perim * (1 - draw)
        c.strokeStyle = rgba(COL.amberHi, 0.85 * smooth(ramp(draw, 0, 0.5)))
        c.lineWidth = 2 * px
        c.stroke(p)
        c.setLineDash([])
        c.lineDashOffset = 0
        continue
      }
      if (site.poly) {
        c.fillStyle = `rgba(242,164,58,${0.4 * smooth(ramp(draw, 0.35, 1))})`
        c.fill(p)
        c.globalCompositeOperation = 'lighter'
        c.strokeStyle = 'rgba(255,180,90,0.32)'
        c.lineWidth = 8 * px
        c.stroke(p)
        c.globalCompositeOperation = 'source-over'
      }
      if (site.poly || site.line) {
        if (draw < 1) c.setLineDash([site.perim * draw, site.perim + 1])
        c.strokeStyle = COL.amberHi
        c.lineWidth = (site.poly ? 1.8 : 2.6) * px
        c.stroke(p)
        c.setLineDash([])
      }
    }
    c.globalAlpha = 1
    c.setTransform(1, 0, 0, 1, 0, 0)

    const toS = (x, y) => [(x - cam.x) * s + w / 2, (y - cam.y) * s + h / 2]
    // tunnel portal: where the bore ends, a cap and a brief flare as the train comes up into the light
    if (UG && UG.s1 < LEN - 1 && UG.s1 <= sMax && !o.mini) {
      const [qx, qy] = toS(...pointAt(UG.s1))
      const ang = tangentAt(UG.s1) + Math.PI / 2
      const L = 10 * zf
      c.strokeStyle = rgba(COL.gold, 0.85)
      c.lineWidth = 2.4
      c.beginPath()
      c.moveTo(qx - Math.cos(ang) * L, qy - Math.sin(ang) * L)
      c.lineTo(qx + Math.cos(ang) * L, qy + Math.sin(ang) * L)
      c.stroke()
      const fl = env(o.t, DAWN_T - 0.2, DAWN_T + 1.8, 0.2, 1.4)
      if (fl > 0.01) {
        const R = 120 * U
        c.globalCompositeOperation = 'lighter'
        const gr = c.createRadialGradient(qx, qy, 0, qx, qy, R)
        gr.addColorStop(0, `rgba(255,236,190,${0.6 * fl})`)
        gr.addColorStop(0.3, `rgba(255,190,110,${0.22 * fl})`)
        gr.addColorStop(1, 'rgba(255,170,90,0)')
        c.fillStyle = gr
        c.fillRect(qx - R, qy - R, 2 * R, 2 * R)
        c.globalCompositeOperation = 'source-over'
      }
    }
    // a faint field of the city's other heritage sites
    if (!o.mini) {
      c.fillStyle = 'rgba(242,170,80,0.42)'
      const dp = new Path2D()
      const r = 1.8 * clamp(zf, 0.8, 1.3)
      for (const [x, y] of PATHS.siteDots) {
        const [sx, sy] = toS(x, y)
        if (sx < -5 || sy < -5 || sx > w + 5 || sy > h + 5) continue
        dp.moveTo(sx + r, sy)
        dp.arc(sx, sy, r, 0, Math.PI * 2)
      }
      c.fill(dp)
    }
    // river label
    if (!o.mini && cam.z > 11.2) {
      c.font = font(500, 22 * U, FONT.serif, 'italic')
      c.letterSpacing = '0.5em'
      c.fillStyle = d > 0.5 ? 'rgba(150,210,214,0.6)' : 'rgba(110,190,196,0.55)'
      const edge = (v, lo, hi) => smooth(ramp(v, lo, lo + 60)) * smooth(ramp(hi - v, 0, 60))
      c.textAlign = 'center'
      const shown = []
      for (const l of YAMUNA_LABELS) {
        const [sx, sy] = toS(l.x, l.y)
        // one name per screenful, faded (not popped) by spacing and frame edges
        let a = edge(sx, 60, w - 60) * edge(sy, 60, h - 60)
        for (const [x, y, b] of shown) a *= 1 - b * (1 - smooth(ramp(Math.hypot(x - sx, y - sy), 560, 760)))
        if (a < 0.01) continue
        shown.push([sx, sy, a])
        c.globalAlpha = a
        c.save()
        c.translate(sx, sy)
        c.rotate(l.ang)
        c.fillText('YAMUNA', 0, -12)
        c.restore()
      }
      c.globalAlpha = 1
      c.letterSpacing = '0px'
    }

    // focus-site lanterns: a breathing warm glow (no expanding rings) and a small lozenge for point sites
    for (const f of o.focus || []) {
      if (f.a <= 0.01) continue
      const [sx, sy] = toS(f.site.x, f.site.y)
      const base = f.site.r * s
      if (base > 160) continue
      const br = 0.88 + 0.12 * Math.sin((o.t - f.t0) * 2.1 + f.site.x)
      const R = (f.primary ? 74 : 54) * U * br * (o.mini ? 0.6 : 1)
      c.globalCompositeOperation = 'lighter'
      const gr = c.createRadialGradient(sx, sy, 0, sx, sy, R)
      gr.addColorStop(0, rgba(COL.amber, (f.primary ? 0.5 : 0.36) * f.a))
      gr.addColorStop(0.35, rgba(COL.amber, 0.12 * f.a))
      gr.addColorStop(1, rgba(COL.amber, 0))
      c.fillStyle = gr
      c.fillRect(sx - R, sy - R, 2 * R, 2 * R)
      c.globalCompositeOperation = 'source-over'
      if (base < 28) {
        const k = (f.primary ? 11 : 9) * U * (0.5 + 0.5 * easeOut((f.u ?? 1) * 1.5))
        c.globalAlpha = f.a
        c.save()
        c.translate(sx, sy)
        c.rotate(Math.PI / 4)
        c.fillStyle = COL.amberHi
        c.fillRect(-k / 2, -k / 2, k, k)
        c.strokeStyle = 'rgba(30,16,4,0.85)'
        c.lineWidth = 1.6
        c.strokeRect(-k / 2, -k / 2, k, k)
        c.restore()
      }
    }
    c.globalAlpha = 1

    // stations
    const dotK = clamp(2 ** ((cam.z - 14) * 0.3), 0.75, 1.3) * (o.mini ? 0.8 : 1)
    for (const st of ST) {
      const [sx, sy] = toS(st.x, st.y)
      if (sx < -60 || sy < -60 || sx > w + 60 || sy > h + 60) continue
      if (st.s > sMax + 1) continue
      const passed = st.s <= sT + 1
      const r = (st.end ? 7.5 : st.story ? 6.5 : 5) * dotK
      if (o.focusStation === st) {
        c.globalCompositeOperation = 'lighter'
        const gr = c.createRadialGradient(sx, sy, 0, sx, sy, 34 * dotK)
        gr.addColorStop(0, rgba(GLOW, 0.45 * o.focusA))
        gr.addColorStop(1, rgba(GLOW, 0))
        c.fillStyle = gr
        c.fillRect(sx - 40, sy - 40, 80, 80)
        c.globalCompositeOperation = 'source-over'
      }
      c.beginPath()
      c.arc(sx, sy, r, 0, Math.PI * 2)
      c.fillStyle = passed ? LINE() : COL.bg
      c.fill()
      c.lineWidth = 2.2 * dotK
      c.strokeStyle = passed ? '#fff8d8' : rgba(LINE(), 0.85)
      c.stroke()
    }

    // arrival: a platform bar across the line flashes as the train stops
    if (o.arrival) {
      const [sx, sy] = toS(o.arrival.x, o.arrival.y)
      const u = o.arrival.u
      const ang = tangentAt(o.arrival.s) + Math.PI / 2
      const L = (16 + 14 * easeOut(u)) * U * dotK
      c.globalCompositeOperation = 'lighter'
      c.globalAlpha = (1 - u) ** 1.6
      c.strokeStyle = '#fff3cf'
      c.lineCap = 'round'
      for (const [lw, a] of [[14, 0.18], [5, 0.9]]) {
        c.globalAlpha = a * (1 - u) ** 1.6
        c.lineWidth = lw * U
        c.beginPath()
        c.moveTo(sx - Math.cos(ang) * L, sy - Math.sin(ang) * L)
        c.lineTo(sx + Math.cos(ang) * L, sy + Math.sin(ang) * L)
        c.stroke()
      }
      c.globalCompositeOperation = 'source-over'
      c.globalAlpha = 1
    }

    // train with comet trail
    drawTrain(c, toS, o, dotK)

    // labels
    if (!o.mini) {
      drawStationLabels(c, toS, cam, w, h, o)
      drawSiteLabels(c, toS, o)
    } else if (o.focusStation) {
      const st = o.focusStation
      const [sx, sy] = toS(st.x, st.y)
      c.textAlign = 'left'
      text(c, st.name, sx + 14, sy - 2, font(600, 20 * U, FONT.sans), COL.ink, 4)
      if (st.name_local) text(c, st.name_local, sx + 14, sy + 22 * U, font(500, 17 * U, FONT.deva), COL.inkDim, 4)
    }
  }
  function drawGrid(c, cam, w, h) {
    const s = cam.s
    let sp = 2 ** Math.ceil(Math.log2(48 / s)) // world spacing whose screen gap is 48..96 px
    for (const [k, a] of [[1, 0.075], [0.5, 0.075 * smooth((sp * s * 0.5 - 26) / 22)]]) {
      const step = sp * k
      if (a < 0.004) continue
      const x0 = Math.floor((cam.x - w / 2 / s) / step) * step
      const y0 = Math.floor((cam.y - h / 2 / s) / step) * step
      c.fillStyle = `rgba(170,190,215,${a})`
      for (let x = x0; x <= cam.x + w / 2 / s; x += step) {
        const sx = Math.round((x - cam.x) * s + w / 2)
        for (let y = y0; y <= cam.y + h / 2 / s; y += step) c.fillRect(sx - 1, Math.round((y - cam.y) * s + h / 2) - 1, 2, 2)
      }
    }
  }
  function addRingsW(path, pts, close) {
    pts.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)))
    if (close) path.closePath()
  }
  const LINE = () => GEO.line.color || '#FFDF00'
  function text(c, str, x, y, f, fill, halo = 5) {
    c.font = f
    c.lineJoin = 'round'
    c.miterLimit = 2
    if (halo) {
      c.strokeStyle = COL.halo
      c.lineWidth = halo
      c.strokeText(str, x, y)
    }
    c.fillStyle = fill
    c.fillText(str, x, y)
  }

  function drawTrain(c, toS, o, k) {
    const sT = o.trainS
    const v = Math.abs(trainS(o.t + 0.05) - trainS(o.t - 0.05)) / 0.1 / UNITS_PER_KM // km per film-second
    const [tx, ty] = toS(...pointAt(sT))
    // comet trail behind the train
    const dir = SCENES.find((sc) => sc.travel && o.t >= sc.travel.t0 && o.t <= sc.travel.t1)
    const sign = dir ? Math.sign(dir.travel.s1 - dir.travel.s0) : 1
    const trail = clamp(v * 0.55, 0, 1.6) * UNITS_PER_KM
    if (trail > 1) {
      c.globalCompositeOperation = 'lighter'
      const N = 18
      let prev = toS(...pointAt(sT))
      for (let i = 1; i <= N; i++) {
        const p = toS(...pointAt(sT - sign * (trail * i) / N))
        const u = i / N
        c.globalAlpha = 0.55 * (1 - u) ** 1.6
        c.strokeStyle = i < 4 ? '#fffbe8' : i < 9 ? LINE() : GLOW
        c.lineWidth = (12 - 9 * u) * k
        c.beginPath()
        c.moveTo(prev[0], prev[1])
        c.lineTo(p[0], p[1])
        c.stroke()
        prev = p
      }
      c.globalAlpha = 1
      c.globalCompositeOperation = 'source-over'
    }
    // glow
    c.globalCompositeOperation = 'lighter'
    const R = (o.mini ? 26 : 46) * k
    const gr = c.createRadialGradient(tx, ty, 0, tx, ty, R)
    gr.addColorStop(0, rgba(LINE(), 0.6))
    gr.addColorStop(0.35, rgba(GLOW, 0.2))
    gr.addColorStop(1, rgba(GLOW, 0))
    c.fillStyle = gr
    c.fillRect(tx - R, ty - R, 2 * R, 2 * R)
    c.globalCompositeOperation = 'source-over'
    // pill along the tangent
    const ang = tangentAt(sT)
    const len = 30 * k * (o.mini ? 0.75 : 1)
    const wid = 11 * k * (o.mini ? 0.8 : 1)
    c.save()
    c.translate(tx, ty)
    c.rotate(ang)
    c.beginPath()
    c.roundRect(-len / 2, -wid / 2, len, wid, wid / 2)
    c.fillStyle = '#fffdf2'
    c.shadowColor = rgba(LINE(), 0.9)
    c.shadowBlur = 14
    c.fill()
    c.shadowBlur = 0
    c.lineWidth = 2
    c.strokeStyle = LINE()
    c.stroke()
    c.restore()
  }

  function drawStationLabels(c, toS, cam, w, h, o) {
    for (const st of ST) {
      if (st.s > LEN * (o.reveal ?? 1) + 1) continue
      let a = labelAlpha(st, cam.z) * (st.story || st.end ? 1 : o.minorA ?? 1)
      if (o.focusStation === st) a = Math.max(a, o.focusA)
      a *= o.labelA ?? 1
      if (a < 0.02) continue
      const [sx, sy] = toS(st.x, st.y)
      if (sx < -400 || sy < -100 || sx > w + 400 || sy > h + 100) continue
      // fade near the top/bottom edges instead of clipping; vanish under the strip, subtitles and chips
      a *= smooth(ramp(sy, 20 * U, 70 * U)) * smooth(ramp(h - sy, 20 * U, 70 * U))
      const lb = [sx + st.box[0], sy + st.box[1], sx + st.box[2], sy + st.box[3]]
      for (const r of o.avoid || []) if (overlaps(lb, r)) a *= 1 - r[4]
      if (a < 0.02) continue
      const focus = o.focusStation === st
      c.globalAlpha = a * (focus || st.story || st.end ? 1 : 0.78)
      c.textAlign = st.side > 0 ? 'left' : 'right'
      // slide back inside the frame rather than clip at the edge (continuous as the camera moves)
      const x = st.side > 0 ? Math.min(sx + 15 * U, w - 14 - st.lw) : Math.max(sx - 15 * U, 14 + st.lw)
      text(c, st.name, x, sy - 3 * U, ST_EN(), focus ? '#ffffff' : COL.ink, 5)
      if (st.name_local) text(c, st.name_local, x, sy + 22 * U, ST_HI(), focus ? COL.amberHi : COL.inkDim, 5)
    }
    c.globalAlpha = 1
  }
  function drawSiteLabels(c, toS, o) {
    for (const f of o.focus || []) {
      const lab = f.label
      if (!lab || lab.hidden || f.a <= 0.02) continue
      const a = f.a * smooth(ramp(o.t, f.t0 + 0.3, f.t0 + 1.1))
      const [sx, sy] = toS(f.site.x, f.site.y)
      const x0 = sx + lab.dx
      const y0 = sy + lab.dy
      c.globalAlpha = a
      if (lab.leader) {
        const cx = clamp(sx, x0, x0 + lab.w)
        const cy = clamp(sy, y0, y0 + lab.h)
        c.strokeStyle = 'rgba(255,214,144,0.6)'
        c.lineWidth = 1.4
        c.beginPath()
        const d = Math.hypot(cx - sx, cy - sy) || 1
        c.moveTo(sx + ((cx - sx) / d) * 8, sy + ((cy - sy) / d) * 8)
        c.lineTo(cx, cy)
        c.stroke()
      }
      const right = lab.dx + lab.w / 2 < 0
      c.textAlign = lab.inside ? 'center' : right ? 'right' : 'left'
      const tx = lab.inside ? x0 + lab.w / 2 : right ? x0 + lab.w - 4 : x0 + 4
      text(c, lab.name, tx, y0 + 30 * U, siteNameFont(), COL.amberHi, 6)
      if (lab.year) {
        c.letterSpacing = '0.12em'
        text(c, lab.year, tx, y0 + 56 * U, siteYearFont(), COL.amber, 5)
        c.letterSpacing = '0px'
      }
    }
    c.globalAlpha = 1
  }

  // ---------- per-frame state helpers
  function focusList(t) {
    const out = new Map()
    SCENES.forEach((sc, i) => {
      if (!sc.focusSites?.length) return
      if (t < sc.start - 1 || t > sc.end + 1.5) return
      // a site lights up as the narration names it (timing's mentions), else once the camera has settled
      const settle = sc.travel ? sc.travel.t1 - 0.4 : sc.start + flyTime(sc) * 0.7
      const said = new Map((sc.mentions || []).map((m) => [m.site_id, m.t]))
      const next = SCENES[i + 1]
      const keeps = (id) => next?.focusSites?.some((s) => s.id === id) && !next.travel
      for (const lab of sc.siteLabels) {
        const id = lab.site.id
        let t0 = said.has(id) ? clamp(said.get(id) - 0.3, sc.start + 0.6, Math.max(sc.start + 0.6, sc.end - 1.5)) : settle
        // the painted landmark is lit (and tagged) before its painting arrives, so the inset card shows it
        if (sc.land && id === sc.plan?.landmark?.site_id) t0 = Math.min(t0, Math.max(settle, landReveal(sc) - 0.8))
        const tEnd = keeps(id) ? next.end : sc.end + (next && next.imgKind ? 0.4 : 0)
        const a = env(t, t0, tEnd, 0.9, 0.7)
        const u = easeInOut(ramp(t, t0, t0 + 1.6))
        if (a > (out.get(id)?.a || 0)) out.set(id, { site: lab.site, a, t0, u, label: lab, primary: lab === sc.siteLabels[0] })
      }
    })
    return [...out.values()]
  }
  function arrivalAt(t) {
    for (const sc of SCENES) {
      const tr = sc.travel
      if (tr && t >= tr.t1 && t < tr.t1 + 1.6) return { x: tr.to.x, y: tr.to.y, s: tr.to.s, u: (t - tr.t1) / 1.6, st: tr.to }
    }
    return null
  }
  function imageLayers(t) {
    const out = []
    for (const sc of SCENES) {
      if (!sc.imgKind || !sc.img) continue
      if (t < sc.start - XF || t > sc.end + XF) continue
      const next = SCENES[sc.i + 1]
      const ain = sc.i === 0 ? 1 : smooth(ramp(t, sc.start - XF / 2, sc.start + XF / 2))
      let aout = !next ? 1 : next.imgKind && next.img ? (t < sc.end + XF / 2 ? 1 : 0) : 1 - smooth(ramp(t, sc.end - XF / 2, sc.end + XF / 2))
      // the opening painting gives way early to the Earth at night under the title (fly-in from space)
      if (sc.i === 0 && GLOBE && GL_T && !(next?.imgKind && next.img)) aout = 1 - smooth(ramp(t, GL_T.show, GL_T.show + 1.4))
      const a = Math.min(ain, aout)
      if (a > 0.001) out.push({ sc, a })
    }
    return out
  }
  function drawImageLayer(c, sc, a, t) {
    const img = sc.img
    const u = clamp((t - (sc.start - XF)) / (sc.D + 2 * XF))
    const h = hashStr(sc.id)
    const zoomIn = h & 1
    const k = zoomIn ? lerp(1.03, 1.13, u) : lerp(1.13, 1.03, u)
    const dirX = h & 2 ? 1 : -1
    const iw = img.naturalWidth
    const ih = img.naturalHeight
    const base = Math.max(W / iw, H / ih)
    const sw = W / (base * k)
    const sh = H / (base * k)
    const slackX = iw - sw
    const slackY = ih - sh
    const px = PORTRAIT ? lerp(0.5 - 0.32 * dirX, 0.5 + 0.32 * dirX, easeInOut(u)) : lerp(0.5 - 0.18 * dirX, 0.5 + 0.18 * dirX, u)
    const py = h & 4 ? lerp(0.45, 0.55, u) : lerp(0.55, 0.45, u)
    c.globalAlpha = a
    c.imageSmoothingQuality = 'high'
    c.drawImage(img, slackX * px, slackY * py, sw, sh, 0, 0, W, H)
    if (sc.kind === 'personal') {
      c.globalCompositeOperation = 'soft-light'
      c.fillStyle = 'rgba(255,170,90,0.35)'
      c.fillRect(0, 0, W, H)
      c.globalCompositeOperation = 'source-over'
    }
    // soft vignette + bottom shade so subtitles always read
    const gr = c.createLinearGradient(0, H * 0.55, 0, H)
    gr.addColorStop(0, 'rgba(0,0,0,0)')
    gr.addColorStop(1, 'rgba(0,0,0,0.55)')
    c.fillStyle = gr
    c.fillRect(0, H * 0.55, W, H * 0.45)
    c.drawImage(VIGNETTE, 0, 0)
    c.globalAlpha = 1
  }

  // ---------- landmark paintings on map scenes: from `reveal` (never before the train has arrived)
  // the painting crossfades in full-bleed with a slow Ken Burns; the 3D view continues in the inset card
  const landReveal = (sc) => Math.max(sc.land.reveal, (sc.travel ? sc.travel.t1 : sc.start) + 0.6)
  function landmarkLayers(t) {
    const out = []
    for (const sc of SCENES) {
      if (!sc.land?.img) continue
      const r = landReveal(sc)
      if (r > sc.end - 1.2 || t < r || t > sc.end + XF) continue
      const next = SCENES[sc.i + 1]
      const ain = smooth(ramp(t, r, r + 0.9))
      // into an image scene the next painting crossfades over this one; into a map scene the 3D returns
      const aout = next && next.imgKind && next.img ? (t < next.start + XF / 2 ? 1 : 0) : 1 - smooth(ramp(t, sc.end - XF / 2, sc.end + XF / 2))
      const a = Math.min(ain, aout)
      if (a > 0.001) out.push({ sc, a, r })
    }
    return out
  }
  function drawLandLayer(c, L, t) {
    const { sc, a, r } = L
    const img = sc.land.img
    const u = clamp((t - r) / (sc.end + XF - r))
    const hh = hashStr(sc.id + 'land')
    const k = lerp(1.04, 1.13, easeInOut(u))
    const dirX = hh & 2 ? 1 : -1
    const iw = img.naturalWidth
    const ih = img.naturalHeight
    const base = Math.max(W / iw, H / ih)
    const sw = W / (base * k)
    const sh = H / (base * k)
    const px = PORTRAIT ? lerp(0.5 - 0.22 * dirX, 0.5 + 0.22 * dirX, easeInOut(u)) : lerp(0.5 - 0.12 * dirX, 0.5 + 0.12 * dirX, u)
    const py = hh & 4 ? lerp(0.46, 0.54, u) : lerp(0.54, 0.46, u)
    c.globalAlpha = a
    c.imageSmoothingQuality = 'high'
    c.drawImage(img, (iw - sw) * px, (ih - sh) * py, sw, sh, 0, 0, W, H)
    const gr = c.createLinearGradient(0, H * 0.55, 0, H)
    gr.addColorStop(0, 'rgba(0,0,0,0)')
    gr.addColorStop(1, 'rgba(0,0,0,0.55)')
    c.fillStyle = gr
    c.fillRect(0, H * 0.55, W, H * 0.45)
    c.drawImage(VIGNETTE, 0, 0)
    c.globalAlpha = 1
  }

  // ---------- 3D map: globe fly-in, the city, and the markers/labels drawn here in 2D from city.project()
  let GL_T = null // globe timing {show, p0, p1, x0, x1} (film seconds)
  const globeA = (t) => (!GLOBE || !GL_T || t > GL_T.x1 ? 0 : t < GL_T.x0 ? 1 : 1 - smooth(ramp(t, GL_T.x0, GL_T.x1)))
  function draw3D(t, o) {
    const gA = globeA(t)
    if (gA > 0) {
      GLOBE.renderAt(GL_T.progress(t), W, H)
      g.drawImage(GLC, 0, 0)
    }
    if (gA >= 1) return
    CITY.renderAt(t, W, H, { focus: o.focus, dawn: o.dawn })
    g.globalAlpha = 1 - gA
    g.drawImage(GLC, 0, 0)
    // dawn: warm light from the low sun over the frame (screen), under the markers and labels
    if (o.dawn > 0.001) {
      g.globalCompositeOperation = 'screen'
      g.globalAlpha = o.dawn * 0.35 * (1 - gA)
      g.drawImage(SUN, 0, 0)
      g.globalCompositeOperation = 'source-over'
    }
    g.globalAlpha = 1
    const markA = (1 - gA) * smooth(ramp(CITY.cameraAt(t).d, 14000, 7000))
    if (markA > 0.01) overlays3D(g, t, o, markA)
  }
  const P3 = (lon, lat, alt = 0) => CITY.project(lon, lat, alt)
  function overlays3D(c, t, o, A) {
    const sT = o.trainS
    const cam = CITY.cameraAt(t)
    // stations: dots in screen space (crisp at any distance), names to the right
    const dots = []
    for (const st of ST) {
      const ll = ST3D.get(st.id)
      const p = P3(ll.lon, ll.lat, 0)
      if (!p.visible) continue
      const major = st.end || st.story
      const far = major ? smooth(ramp(p.dist, 15000, 8000)) : smooth(ramp(p.dist, 6500, 3800))
      const a = A * far * smooth(ramp(cam.d, major ? 12000 : 5200, major ? 7000 : 3600))
      if (a < 0.02) continue
      dots.push({ st, p, a, major })
    }
    const k = (p) => clamp((2600 / Math.max(p.dist, 1)) ** 0.22, 0.8, 1.2)
    for (const { st, p, a, major } of dots) {
      const passed = st.s <= sT + 1
      const r = (st.end ? 7 : major ? 6.2 : 4.6) * U * k(p)
      c.globalAlpha = a
      if (o.focusStation === st && o.focusA > 0.01) {
        c.globalCompositeOperation = 'lighter'
        const gr = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, 38 * U)
        gr.addColorStop(0, rgba(GLOW, 0.28 * o.focusA))
        gr.addColorStop(1, rgba(GLOW, 0))
        c.fillStyle = gr
        c.fillRect(p.x - 40 * U, p.y - 40 * U, 80 * U, 80 * U)
        c.globalCompositeOperation = 'source-over'
      }
      c.beginPath()
      c.arc(p.x, p.y, r, 0, Math.PI * 2)
      c.fillStyle = passed ? LINE() : '#14161c'
      c.fill()
      c.lineWidth = 2.2 * U * k(p)
      c.strokeStyle = passed ? '#fff8d8' : rgba(LINE(), 0.9)
      c.stroke()
    }
    // arrival: a bright ring swells and fades as the train stops
    const arr = arrivalAt(t)
    if (arr) {
      const ll = ST3D.get(arr.st.id)
      const p = P3(ll.lon, ll.lat, 0)
      if (p.visible) {
        const R = (14 + 46 * easeOut(arr.u)) * U
        c.globalAlpha = A * (1 - arr.u) ** 1.5
        c.strokeStyle = '#fff3cf'
        c.lineWidth = 3 * U
        c.beginPath()
        c.ellipse(p.x, p.y, R, R * 0.62, 0, 0, Math.PI * 2)
        c.stroke()
      }
    }
    // station names (focus station brighter); labels fade under the UI instead of overlapping it
    for (const { st, p, a, major } of dots) {
      const focus = o.focusStation === st
      if (!major && !focus && a < 0.05) continue
      let la = a * (o.labelA ?? 1) * (major ? 1 : (o.minorA ?? 1) * 0.85)
      if (focus) la = Math.max(la, A * o.focusA)
      c.font = ST_EN()
      const lw = Math.max(c.measureText(st.name).width, st.lw || 0)
      // names sit right of the dot, or left of it near the right edge of the frame
      const left = p.x + 16 * U * k(p) + lw > W - 24
      const lx = left ? p.x - 16 * U * k(p) : p.x + 16 * U * k(p)
      const box = left ? [lx - lw - 8, p.y - 28 * U, lx + 4, p.y + 30 * U] : [lx - 4, p.y - 28 * U, lx + lw + 8, p.y + 30 * U]
      for (const r of o.avoid || []) if (overlaps(box, r)) la *= 1 - r[4]
      la *= smooth(ramp(p.y, 20 * U, 70 * U)) * smooth(ramp(H - p.y, 20 * U, 70 * U))
      if (la < 0.02) continue
      c.globalAlpha = la
      c.textAlign = left ? 'right' : 'left'
      text(c, st.name, lx, p.y - 3 * U, ST_EN(), focus ? '#ffffff' : COL.ink, 5)
      if (st.name_local) text(c, st.name_local, lx, p.y + 22 * U, ST_HI(), focus ? COL.amberHi : COL.inkDim, 5)
    }
    c.globalAlpha = 1
    drawRiver3D(c, cam, A, o.avoid)
    drawSiteTags(c, t, o, A)
  }
  // the river's name along its course, one per screenful, faded at the frame edges
  function drawRiver3D(c, cam, A, avoid = []) {
    const k = A * smooth(ramp(cam.d, 16000, 9000))
    // label points every ~3 km along every line OSM names Yamuna
    if (!YAMUNA3D) {
      YAMUNA3D = []
      for (const r of YAMUNA_RINGS) {
        let acc = -1.5 * UNITS_PER_KM
        const pts = r.map(P)
        for (let i = 1; i < pts.length; i++) {
          acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
          if (acc > 3 * UNITS_PER_KM) {
            acc = 0
            YAMUNA3D.push({ ll: r[i], la: r[Math.max(0, i - 2)], lb: r[Math.min(r.length - 1, i + 2)] })
          }
        }
      }
    }
    if (k < 0.02 || !YAMUNA3D.length) return
    c.font = font(500, 22 * U, FONT.serif, 'italic')
    c.letterSpacing = '0.5em'
    c.textAlign = 'center'
    c.fillStyle = 'rgba(120,196,202,0.62)'
    const edge = (v, lo, hi) => smooth(ramp(v, lo, lo + 80)) * smooth(ramp(hi - v, 0, 80))
    const shown = []
    for (const l of YAMUNA3D) {
      const p = P3(l.ll[0], l.ll[1], 0)
      if (!p.visible) continue
      const pa = P3(l.la[0], l.la[1], 0)
      const pb = P3(l.lb[0], l.lb[1], 0)
      let ang = Math.atan2(pb.y - pa.y, pb.x - pa.x)
      if (ang > Math.PI / 2) ang -= Math.PI
      if (ang < -Math.PI / 2) ang += Math.PI
      let a = k * edge(p.x, 80, W - 80) * edge(p.y, 120, H - 120)
      const bx = [p.x - 110 * U, p.y - 34 * U, p.x + 110 * U, p.y + 14 * U]
      for (const r of avoid) if (overlaps(bx, r)) a *= 1 - r[4]
      for (const [x, y, b] of shown) a *= 1 - b * (1 - smooth(ramp(Math.hypot(x - p.x, y - p.y), 560, 760)))
      if (a < 0.02) continue
      shown.push([p.x, p.y, a])
      c.globalAlpha = a
      c.save()
      c.translate(p.x, p.y)
      c.rotate(ang)
      c.fillText('YAMUNA', 0, -10)
      c.restore()
    }
    c.globalAlpha = 1
    c.letterSpacing = '0px'
  }
  // the narrated landmark's name on a small dark tag, on a stem above its glowing roof
  function drawSiteTags(c, t, o, A, { mini = false } = {}) {
    const tags = []
    for (const f of o.focus || []) {
      const lab = f.label
      if (!lab || lab.hidden || f.a <= 0.02) continue
      const a = A * f.a * smooth(ramp(t, f.t0 + 0.3, f.t0 + 1.1))
      if (a < 0.02) continue
      const an = CITY.siteAnchor(f.site.id)
      if (!an) continue
      const p = P3(an.lon, an.lat, an.alt)
      if (!p.visible) continue
      tags.push({ f, lab, a, p })
    }
    tags.sort((x, y) => y.p.y - x.p.y)
    const placed = []
    for (const { lab, a, p } of tags) {
      const s = mini ? 0.72 : 1
      const nameF = font(500, 30 * U * s, FONT.serif, 'italic')
      const yearF = font(650, 15 * U * s, FONT.sans)
      c.font = nameF
      const wN = c.measureText(lab.name).width
      c.font = yearF
      c.letterSpacing = '0.16em'
      const wY = lab.year && !mini ? c.measureText(lab.year).width : 0
      c.letterSpacing = '0px'
      const padX = 16 * U * s
      const bw = Math.max(wN, wY) + 2 * padX
      const bh = (lab.year && !mini ? 70 : 46) * U * s
      const stem = (mini ? 18 : 40) * U
      let x0 = clamp(p.x - bw / 2, 24, (mini ? LAY.pip.w : W) - 24 - bw)
      let y0 = p.y - stem - bh
      // stack instead of overlapping a tag placed already
      for (const b of placed) if (overlaps([x0, y0, x0 + bw, y0 + bh], b)) y0 = b[1] - bh - 10 * U
      const box = [x0, y0, x0 + bw, y0 + bh]
      placed.push(box)
      let aa = a
      if (!mini) for (const r of o.avoid || []) if (overlaps(box, r)) aa *= 1 - 0.85 * r[4]
      if (aa < 0.02) continue
      c.globalAlpha = aa
      // stem + anchor
      c.strokeStyle = 'rgba(255,214,144,0.85)'
      c.lineWidth = 1.6 * U * s
      c.beginPath()
      c.moveTo(p.x, p.y - 3)
      c.lineTo(clamp(p.x, x0 + 10, x0 + bw - 10), y0 + bh)
      c.stroke()
      c.fillStyle = COL.amberHi
      c.beginPath()
      c.arc(p.x, p.y, 3.4 * U * s, 0, Math.PI * 2)
      c.fill()
      // tag
      c.fillStyle = 'rgba(12,11,15,0.86)'
      c.shadowColor = 'rgba(0,0,0,0.5)'
      c.shadowBlur = 18
      c.beginPath()
      c.roundRect(x0, y0, bw, bh, 7 * U * s)
      c.fill()
      c.shadowBlur = 0
      c.strokeStyle = 'rgba(255,214,144,0.42)'
      c.lineWidth = 1
      c.stroke()
      c.textAlign = 'left'
      c.font = nameF
      c.fillStyle = COL.ink
      c.fillText(lab.name, x0 + padX, y0 + (lab.year && !mini ? 34 : 32) * U * s)
      if (lab.year && !mini) {
        c.font = yearF
        c.letterSpacing = '0.16em'
        c.fillStyle = COL.amber
        c.fillText(lab.year.toUpperCase(), x0 + padX, y0 + 58 * U)
        c.letterSpacing = '0px'
      }
    }
    c.globalAlpha = 1
  }
  // the 3D view in the inset card: during a landmark painting (centred on the landmark) or an
  // illustration that names a station (centred on it)
  function drawInset3D(c, t, a, target, o) {
    // 9:16: a long year ("5th century") would run under the card: the inset drops below the citation chip
    const { x, y, w, h } = o.low ? { ...LAY.pip, y: LAY.chip.y + 54 } : LAY.pip
    const view = CITY.insetView(t, target)
    const r = CITY.renderAt(t, w, h, { view, focus: o.focus, dawn: o.dawn })
    c.save()
    c.globalAlpha = a
    c.shadowColor = 'rgba(0,0,0,0.6)'
    c.shadowBlur = 30
    c.beginPath()
    c.roundRect(x, y, w, h, 18)
    c.fillStyle = '#000'
    c.fill()
    c.shadowBlur = 0
    c.clip()
    c.drawImage(GLC, r.sx, r.sy, r.sw, r.sh, x, y, w, h)
    c.translate(x, y)
    if (o.station) {
      const ll = ST3D.get(o.station.id)
      const p = P3(ll.lon, ll.lat, 0)
      if (p.visible) {
        c.beginPath()
        c.arc(p.x, p.y, 5.5 * U, 0, Math.PI * 2)
        c.fillStyle = o.station.s <= o.trainS + 1 ? LINE() : '#14161c'
        c.fill()
        c.lineWidth = 2
        c.strokeStyle = '#fff8d8'
        c.stroke()
        c.textAlign = 'left'
        const lx = Math.min(p.x + 14, w - 14 - (o.station.lw || 120))
        text(c, o.station.name, lx, p.y - 2, font(600, 20 * U, FONT.sans), COL.ink, 4)
        if (o.station.name_local) text(c, o.station.name_local, lx, p.y + 22 * U, font(500, 17 * U, FONT.deva), COL.inkDim, 4)
      }
    }
    if (o.tags) drawSiteTags(c, t, { focus: o.tags }, 1, { mini: true })
    c.restore()
    c.globalAlpha = a
    c.strokeStyle = 'rgba(255,255,255,0.22)'
    c.lineWidth = 1.5
    c.beginPath()
    c.roundRect(x, y, w, h, 18)
    c.stroke()
    c.globalAlpha = 1
  }

  // ---------- overlays
  function drawYearCard(c, t, i) {
    const sc = SCENES[i]
    // the card belongs to the scene under t; neighbours decide whether parts persist or roll
    const parts = (s) => (s?.card ? s : null)
    const cur = parts(sc)
    const prev = parts(SCENES[i - 1])
    const next = parts(SCENES[i + 1])
    if (!cur) return // a card fades out at the end of its own scene
    const { x } = LAY.card
    const fIn = (same) => (same ? 1 : smooth(ramp(t, sc.start + 0.2, sc.start + 1.0)))
    const fOut = (same) => (same ? 1 : 1 - smooth(ramp(t, sc.end - 0.5, sc.end - 0.05)))
    const hA = fIn(prev?.headline === cur.headline) * fOut(next?.headline === cur.headline)
    // a new year crossfades from the last one (never counting through years nobody claimed)
    const change = !!(cur.year && prev?.year && prev.year !== cur.year)
    const yA = cur.year ? (change || prev?.year === cur.year ? 1 : fIn(false)) * (next?.year ? 1 : fOut(false)) : 0
    const cardA = Math.max(hA, yA)
    if (cardA < 0.01) return
    // backing shade
    c.globalAlpha = cardA
    // top band shade: reads on bright illustrations without a visible blob
    const bandH = LAY.card.year + LAY.card.yearPx * 0.9
    const gr = c.createLinearGradient(0, 0, 0, bandH)
    gr.addColorStop(0, 'rgba(2,4,8,0.5)')
    gr.addColorStop(0.55, 'rgba(2,4,8,0.3)')
    gr.addColorStop(1, 'rgba(2,4,8,0)')
    c.fillStyle = gr
    c.fillRect(0, 0, W, bandH)
    // kicker: rule + headline
    if (cur.headline) {
      const rise = (1 - hA) * 10
      c.globalAlpha = hA
      c.fillStyle = COL.gold
      c.fillRect(x, LAY.card.kicker - LAY.card.kickPx * 0.36 + rise, 46 * U, 2.5)
      c.font = font(650, LAY.card.kickPx, FONT.sans)
      c.letterSpacing = '0.24em'
      c.textAlign = 'left'
      c.fillStyle = COL.gold
      c.fillText(cur.headline.toUpperCase(), x + 62 * U, LAY.card.kicker + rise)
      c.letterSpacing = '0px'
    }
    if (cur.year && yA > 0.01) {
      const u = change ? easeInOut(ramp(t, sc.start + 0.15, sc.start + 0.75)) : 1
      // forward in time the old year lifts away, backward (the rewind south of New Delhi) it sinks
      const dir = change && prev.yearP && cur.yearP ? Math.sign(cur.yearP.lo - prev.yearP.lo) || 1 : 1
      const shift = LAY.card.yearPx * 0.2
      const rise = (1 - yA) * 14
      if (u < 1) drawYear(c, prev, yA * (1 - u), rise - dir * shift * u)
      drawYear(c, cur, yA * u, rise + dir * shift * (1 - u))
    }
    c.globalAlpha = 1
  }
  function yearUnderInset(sc) {
    if (!PORTRAIT || !sc.year) return false
    if (sc.yearWide === undefined) {
      // the drawn width, as drawYear sets it: small italic prefix, the number at full size
      const yP = sc.yearP
      g.font = font(500, LAY.card.yearPx * 0.42, FONT.serif, 'italic')
      const pre = yP?.pre ? g.measureText(yP.pre).width + LAY.card.yearPx * 0.14 + 4 : 0
      g.font = font(500, LAY.card.yearPx, FONT.serif)
      sc.yearWide = LAY.card.x + pre + g.measureText(yP ? String(yP.num) : sc.year).width > LAY.pip.x - 16
    }
    return sc.yearWide
  }
  // one year on the card: optional prefix ("c.") and suffix ("– 1931") in small italics
  function drawYear(c, s, a, dy) {
    if (a < 0.01) return
    const yP = s.yearP
    const yPx = LAY.card.yearPx
    const yb = LAY.card.year + dy
    let xx = LAY.card.x - 4
    c.textAlign = 'left'
    c.globalAlpha = a
    if (yP?.pre) {
      c.font = font(500, yPx * 0.42, FONT.serif, 'italic')
      c.fillStyle = COL.inkDim
      c.fillText(yP.pre, xx + 4, yb)
      xx += 4 + c.measureText(yP.pre).width + yPx * 0.14 // a clear gap: "c." must not touch the year
    }
    const main = yP ? String(yP.num) : s.year
    c.font = font(500, yPx, FONT.serif)
    c.fillStyle = COL.ink
    c.shadowColor = 'rgba(0,0,0,0.5)'
    c.shadowBlur = 24
    c.fillText(main, xx, yb)
    c.shadowBlur = 0
    const wm = c.measureText(main).width
    if (yP?.suf) {
      c.font = font(500, yPx * 0.42, FONT.serif, 'italic')
      c.fillStyle = COL.inkDim
      c.fillText(yP.suf, xx + wm + yPx * 0.08, yb)
    }
  }

  const stripRect = () => {
    const { x0, x1, y, kick } = LAY.strip
    return [x0 - 24, kick - 30 * U, x1 + 24, y + 46 * U]
  }
  function drawStrip(c, t, a, sT) {
    if (a < 0.01) return
    const { x0, x1, y, kick } = LAY.strip
    const X = (s) => lerp(x0, x1, s / LEN)
    c.globalAlpha = a
    c.fillStyle = 'rgba(4,7,12,0.62)'
    c.shadowColor = 'rgba(0,0,0,0.45)'
    c.shadowBlur = 24
    c.beginPath()
    c.roundRect(x0 - 24, kick - 30 * U, x1 - x0 + 48, y - kick + 30 * U + 46 * U, 14)
    c.fill()
    c.shadowBlur = 0
    c.strokeStyle = 'rgba(255,255,255,0.07)'
    c.lineWidth = 1
    c.stroke()
    c.font = font(650, 17 * U, FONT.sans)
    c.letterSpacing = '0.24em'
    c.textAlign = PORTRAIT ? 'left' : 'right'
    c.fillStyle = COL.gold
    const label = `${PROJ.line || ''}${PROJ.network ? ' · ' + PROJ.network : ''}`.toUpperCase()
    c.fillText(label, PORTRAIT ? x0 : x1, kick)
    c.letterSpacing = '0px'
    c.lineCap = 'round'
    // the tunnel: a bored channel under the underground stretch, a cap where the train surfaces
    if (UG) {
      const ux0 = X(UG.s0)
      const ux1 = X(UG.s1)
      c.fillStyle = 'rgba(9,8,11,0.95)'
      c.strokeStyle = rgba(COL.gold, 0.45)
      c.lineWidth = 1
      c.beginPath()
      c.roundRect(ux0 - 9, y - 8, ux1 - ux0 + 18, 16, 8)
      c.fill()
      c.stroke()
      if (UG.s1 < LEN - 1) {
        c.fillStyle = rgba(COL.gold, 0.85)
        c.fillRect(ux1 + 8, y - 9, 2, 18)
      }
      c.font = font(600, 12 * U, FONT.sans)
      c.letterSpacing = '0.26em'
      c.textAlign = 'center'
      c.fillStyle = rgba(COL.gold, 0.62)
      c.fillText('UNDERGROUND', (ux0 + ux1) / 2, y + 30 * U)
      c.letterSpacing = '0px'
    }
    c.strokeStyle = rgba(LINE(), 0.28)
    c.lineWidth = 3
    c.beginPath()
    c.moveTo(x0, y)
    c.lineTo(x1, y)
    c.stroke()
    c.globalCompositeOperation = 'lighter'
    c.strokeStyle = rgba(LINE(), 0.25 * a)
    c.lineWidth = 10
    c.beginPath()
    c.moveTo(x0, y)
    c.lineTo(X(sT), y)
    c.stroke()
    c.globalCompositeOperation = 'source-over'
    c.strokeStyle = LINE()
    c.lineWidth = 3
    c.beginPath()
    c.moveTo(x0, y)
    c.lineTo(X(sT), y)
    c.stroke()
    for (const st of ST) {
      const passed = st.s <= sT + 1
      const r = st.end || st.story ? 5.5 : 3.6
      c.beginPath()
      c.arc(X(st.s), y, r, 0, Math.PI * 2)
      c.fillStyle = passed ? LINE() : COL.bg
      c.fill()
      c.lineWidth = 1.8
      c.strokeStyle = passed ? '#fff6cc' : rgba(LINE(), 0.7)
      c.stroke()
    }
    // train marker
    const tx = X(sT)
    c.globalCompositeOperation = 'lighter'
    const gr = c.createRadialGradient(tx, y, 0, tx, y, 26)
    gr.addColorStop(0, rgba(LINE(), 0.6))
    gr.addColorStop(1, rgba(LINE(), 0))
    c.fillStyle = gr
    c.fillRect(tx - 26, y - 26, 52, 52)
    c.globalCompositeOperation = 'source-over'
    c.beginPath()
    c.roundRect(tx - 11, y - 5, 22, 10, 5)
    c.fillStyle = '#fffdf2'
    c.fill()
    // ends
    c.font = font(500, 16 * U, FONT.sans)
    c.fillStyle = COL.inkDim
    c.textAlign = 'left'
    c.fillText(ST[0].name, x0, y + 30 * U)
    c.textAlign = 'right'
    c.fillText(ST.at(-1).name, x1, y + 30 * U)
    c.globalAlpha = 1
  }

  // the subtitle on screen at t: [[x0, y0, x1, y1, alpha, cue]] or [] (also keeps map labels clear).
  // One cue at a time: back-to-back cues (gap < 0.3 s) hard-cut at the next cue's start, as broadcast
  // subtitles do; only a cue that follows / precedes a real pause fades (in 0.08 s, out 0.18 s).
  const JOIN = 0.3
  function subtitleBoxes(t) {
    let hit = null
    for (let k = 0; k < CUES.length; k++) {
      const cue = CUES[k]
      const joinIn = k > 0 && cue.start - CUES[k - 1].end < JOIN
      const next = CUES[k + 1]
      const joinOut = next && next.start - cue.end < JOIN
      const t0 = joinIn ? cue.start : cue.start - 0.04
      const t1 = joinOut ? next.start : cue.end + 0.18
      if (t < t0 || t >= t1) continue
      const a = (joinIn ? 1 : smooth(ramp(t, cue.start - 0.04, cue.start + 0.04))) * (joinOut ? 1 : 1 - smooth(ramp(t, cue.end, cue.end + 0.18)))
      if (a >= 0.01 && (!hit || a > hit.a)) hit = { cue, a }
    }
    if (!hit) return []
    const { cue, a } = hit
    if (!cue.box) {
      g.font = font(500, cue.px, FONT.sans)
      const lh = LAY.sub.lh * (cue.px / LAY.sub.px)
      const n = cue.lines.length
      const bw = Math.max(...cue.lines.map((l) => g.measureText(l).width)) + 52
      const top = LAY.sub.bottom - (n - 1) * lh - cue.px * 0.95 - 4
      cue.box = [LAY.sub.x - bw / 2, top, LAY.sub.x + bw / 2, top + (n - 1) * lh + cue.px * 1.45]
    }
    return [[...cue.box, a, cue]]
  }
  function drawSubtitles(c, t) {
    for (const [x0, y0, x1, y1, a, cue] of subtitleBoxes(t)) {
      c.font = font(500, cue.px, FONT.sans)
      const lh = LAY.sub.lh * (cue.px / LAY.sub.px)
      const n = cue.lines.length
      c.globalAlpha = a
      c.fillStyle = 'rgba(4,6,10,0.56)'
      c.shadowColor = 'rgba(0,0,0,0.55)'
      c.shadowBlur = 30
      c.beginPath()
      c.roundRect(x0, y0, x1 - x0, y1 - y0, 16)
      c.fill()
      c.shadowBlur = 0
      c.textAlign = 'center'
      c.fillStyle = '#ffffff'
      cue.lines.forEach((l, k) => c.fillText(l, LAY.sub.x, LAY.sub.bottom - (n - 1 - k) * lh))
    }
    c.globalAlpha = 1
  }

  // chip layout depends only on the citation (memoised): label, position, box for label avoidance
  function chipLayout(ci) {
    if (ci.layout) return ci.layout
    let { x, y, align } = LAY.chip
    // 9:16 end card: its title sits where the chip lives, so the chip goes just above the title
    const own = SCENES.find((s) => s.id === ci.scene) || SCENES[sceneIndexAt(ci.start + 0.01)]
    if (PORTRAIT && own?.kind === 'end') y = Math.round(H * 0.36 - 150 * U)
    g.save()
    g.font = font(500, 18 * U, FONT.sans)
    // never wider than the safe area: drop trailing publishers ("A · B · C" -> "A · B …")
    const maxW = (PORTRAIT ? W - 144 : 860) - 52 * U
    let label = String(ci.text || '')
    const parts = label.split(' · ')
    while (parts.length > 1 && g.measureText(label).width > maxW) label = `${parts.slice(0, -1).join(' · ')} …`, parts.pop()
    const tw = Math.min(g.measureText(label).width, maxW)
    g.restore()
    const bw = tw + 52 * U
    const bh = 36 * U
    const x0 = align === 'right' ? x - bw : x
    ci.layout = { label, maxW, x0, y, bw, bh, box: [x0 - 8, y - bh / 2 - 8, x0 + bw + 8, y + bh / 2 + 8] }
    return ci.layout
  }
  const chipA = (ci, t) => (t < ci.start - 0.5 || t > ci.end + 0.5 ? 0 : env(t, ci.start + 0.4, ci.end, 0.5, 0.4))
  const chipBoxes = (t) => (T.citations || []).map((ci) => [...chipLayout(ci).box, chipA(ci, t)]).filter((b) => b[4] > 0.01)
  function drawChip(c, t) {
    for (const ci of T.citations || []) {
      const a = chipA(ci, t)
      if (a < 0.01) continue
      const { label, maxW, x0, y, bw, bh } = chipLayout(ci)
      c.font = font(500, 18 * U, FONT.sans)
      c.globalAlpha = a
      c.fillStyle = 'rgba(6,9,14,0.66)'
      c.beginPath()
      c.roundRect(x0, y - bh / 2, bw, bh, bh / 2)
      c.fill()
      c.strokeStyle = 'rgba(255,214,144,0.28)'
      c.lineWidth = 1
      c.stroke()
      // small book glyph
      c.fillStyle = COL.amber
      c.save()
      c.translate(x0 + 20 * U, y)
      c.rotate(Math.PI / 4)
      c.fillRect(-4 * U, -4 * U, 8 * U, 8 * U)
      c.restore()
      c.textAlign = 'left'
      c.fillStyle = 'rgba(246,240,229,0.9)'
      c.fillText(label, x0 + 36 * U, y + 6 * U, maxW)
    }
    c.globalAlpha = 1
  }

  // four-point sparkle, the usual "AI" glyph
  function sparkle(c, x, y, r) {
    c.beginPath()
    c.moveTo(x, y - r)
    c.quadraticCurveTo(x, y, x + r, y)
    c.quadraticCurveTo(x, y, x, y + r)
    c.quadraticCurveTo(x, y, x - r, y)
    c.quadraticCurveTo(x, y, x, y - r)
    c.fill()
  }
  // disclosure: an "AI-generated" pill over the opening seconds, "AI illustration" on every image scene
  function drawDisclosure(c, t, imgA) {
    const pill = (label, { x, y, align }, a, framed) => {
      if (a < 0.01) return
      c.font = font(600, 15 * U, FONT.sans)
      c.letterSpacing = '0.2em'
      const tw = c.measureText(label).width
      c.letterSpacing = '0px'
      const bh = 34 * U
      const bw = tw + 50 * U
      const x0 = align === 'right' ? x - bw : x
      c.globalAlpha = a
      if (framed) {
        c.fillStyle = 'rgba(8,7,10,0.62)'
        c.beginPath()
        c.roundRect(x0, y - bh / 2, bw, bh, bh / 2)
        c.fill()
        c.strokeStyle = rgba(COL.gold, 0.55)
        c.lineWidth = 1.2
        c.stroke()
      } else {
        c.shadowColor = 'rgba(0,0,0,0.85)'
        c.shadowBlur = 8
      }
      const gx = framed ? x0 + 20 * U : x0 + 7 * U
      c.fillStyle = COL.gold
      sparkle(c, gx, y, 7 * U)
      c.font = font(600, 15 * U, FONT.sans)
      c.letterSpacing = '0.2em'
      c.textAlign = 'left'
      c.fillStyle = 'rgba(247,239,225,0.92)'
      c.fillText(label, gx + 14 * U, y + 5.5 * U)
      c.letterSpacing = '0px'
      c.shadowBlur = 0
      c.globalAlpha = 1
    }
    pill('AI-GENERATED', LAY.badge, smooth(ramp(t, 0.15, 0.6)) * (1 - smooth(ramp(t, 3.0, 3.6))), true)
    pill('AI ILLUSTRATION', LAY.aiLabel, imgA * 0.9, false)
  }

  function drawAttribution(c, t) {
    const { x, y, align } = LAY.attrib
    c.font = font(500, 15 * U, FONT.sans)
    c.textAlign = align
    const osm = 'Map data © OpenStreetMap contributors'
    // the Earth-at-night credit while the globe is on screen (it hands the corner to the OSM credit)
    const gA = GLOBE && GL_T ? smooth(ramp(t, GL_T.show, GL_T.show + 1)) * globeA(t) : 0
    if (gA > 0.01) {
      c.globalAlpha = 0.62 * gA
      text(c, 'Earth at night: NASA', x, y, c.font, COL.ink, 3)
    }
    // OSM attribution guidelines for video: ~4 s when the map first shows, ~3 s each time it returns after
    // a painting or the globe, then it fades; never over a painting (the end credits carry the full line)
    const oA = osmCreditA(t)
    if (oA > 0.01) {
      c.globalAlpha = 0.62 * oA
      text(c, osm, x, y, c.font, COL.ink, 3)
    }
    c.globalAlpha = 1
  }
  // how much of the frame is the open 3D/2D map (no painting over it, no globe), sampled per frame
  const mapVis = (t) => {
    let im = 0
    for (const l of imageLayers(t)) im = Math.max(im, l.a)
    if (CITY) for (const l of landmarkLayers(t)) im = Math.max(im, l.a)
    const end = SCENES.find((s) => s.kind === 'end')
    if (end && t >= end.start - XF) im = 1
    return (1 - im) * (1 - globeA(t))
  }
  let OSM_SHOWS = null
  function osmCreditA(t) {
    if (!OSM_SHOWS) {
      // the map "shows" when it becomes fully open again (after the title, the globe or a painting)
      OSM_SHOWS = []
      let prev = 0
      for (let f = 0; f <= Math.ceil(DUR * FPS); f++) {
        const v = mapVis(f / FPS)
        if (v >= 0.97 && prev < 0.97) OSM_SHOWS.push(f / FPS)
        prev = v
      }
    }
    let a = 0
    OSM_SHOWS.forEach((o, k) => (a = Math.max(a, env(t, o, o + (k === 0 ? 4 : 3), 0.5, 0.8))))
    return a > 0.001 ? a * mapVis(t) : 0
  }

  function drawTitleCard(c, sc, t) {
    const a = env(t, sc.start, sc.end + XF / 2, 0.01, XF)
    if (a < 0.01) return
    const { x, y, align, px } = LAY.title
    const s0 = sc.start
    // shade on the text side
    c.globalAlpha = a
    const gr = PORTRAIT ? c.createLinearGradient(0, 0, 0, H * 0.62) : c.createLinearGradient(0, 0, W * 0.62, 0)
    gr.addColorStop(0, 'rgba(2,4,8,0.78)')
    gr.addColorStop(0.7, 'rgba(2,4,8,0.35)')
    gr.addColorStop(1, 'rgba(2,4,8,0)')
    c.fillStyle = gr
    c.fillRect(0, 0, PORTRAIT ? W : W * 0.62, PORTRAIT ? H * 0.62 : H)
    c.textAlign = align
    // kicker
    const k = smooth(ramp(t, s0 + 0.4, s0 + 1.3))
    c.globalAlpha = a * k
    c.font = font(650, 24 * U, FONT.sans)
    c.letterSpacing = '0.32em'
    c.fillStyle = COL.gold
    const kick = [PROJ.city, PROJ.line].filter(Boolean).join('  ·  ').toUpperCase()
    c.fillText(kick, x, y - px * 0.95)
    c.letterSpacing = '0px'
    // title words rise in, one by one
    const title = T.title || sc.headline || ''
    const lines = splitTitle(title)
    c.font = font(400, px, FONT.serif)
    lines.forEach((line, li) => {
      const words = line.split(' ')
      const widths = words.map((w) => c.measureText(w + ' ').width)
      const total = widths.reduce((s, v) => s + v, 0) - c.measureText(' ').width
      let xx = align === 'center' ? x - total / 2 : x
      c.textAlign = 'left'
      words.forEach((w, wi) => {
        const d = s0 + 0.8 + (li * 2 + wi) * 0.22
        const u = easeOut(ramp(t, d, d + 1.1))
        c.globalAlpha = a * u
        c.fillStyle = COL.ink
        c.shadowColor = 'rgba(0,0,0,0.6)'
        c.shadowBlur = 30
        c.fillText(w, xx, y + li * px * 1.02 + (1 - u) * 22)
        c.shadowBlur = 0
        xx += widths[wi]
      })
    })
    c.textAlign = align
    const yy = y + (lines.length - 1) * px * 1.02
    // rule with a station dot
    const ru = easeInOut(ramp(t, s0 + 1.8, s0 + 2.8))
    const rw = 420 * U
    const rx = align === 'center' ? x - rw / 2 : x
    c.globalAlpha = a
    c.fillStyle = COL.gold
    c.fillRect(align === 'center' ? x - (rw / 2) * ru : rx, yy + 46 * U, rw * ru, 2.5)
    c.beginPath()
    c.arc(align === 'center' ? x : rx + rw * ru, yy + 47 * U, 6 * ru, 0, Math.PI * 2)
    c.fill()
    // route
    const ra = smooth(ramp(t, s0 + 2.4, s0 + 3.3))
    c.globalAlpha = a * ra
    const first = ST[0]
    const last = ST.at(-1)
    c.font = font(400, 30 * U, FONT.sans)
    c.fillStyle = 'rgba(246,240,229,0.82)'
    c.fillText(`${first.name}  →  ${last.name}`, x, yy + 102 * U)
    if (first.name_local && last.name_local) {
      c.font = font(500, 25 * U, FONT.deva)
      c.fillStyle = COL.inkDim
      c.fillText(`${first.name_local}  →  ${last.name_local}`, x, yy + 146 * U)
    }
    c.globalAlpha = 1
  }
  function splitTitle(s) {
    const words = s.split(' ')
    if (words.length < 3) return [s]
    const i = s.indexOf(', ')
    if (i > 0) return [s.slice(0, i + 1), s.slice(i + 2)]
    const h = Math.ceil(words.length / 2)
    return [words.slice(0, h).join(' '), words.slice(h).join(' ')]
  }

  // credits wait for the last word: the closing line keeps the title and image to itself
  const voiceEnd = (sc) => (sc.voice ? sc.start + sc.voice.start + sc.voice.duration : sc.start + Math.min(sc.D * 0.35, 3))
  const creditsA = (sc, t) => smooth(ramp(t, voiceEnd(sc) + 0.4, voiceEnd(sc) + 1.4))
  function drawEndCard(c, sc, t) {
    const a = env(t, sc.start + 0.3, DUR + 10, 1.2, 1)
    if (a < 0.01) return
    const cx = W / 2
    const cy = PORTRAIT ? H * 0.36 : H * 0.4
    c.globalAlpha = a
    const gr = c.createRadialGradient(cx, cy, 0, cx, cy, PORTRAIT ? 760 : 900)
    gr.addColorStop(0, 'rgba(2,4,8,0.72)')
    gr.addColorStop(1, 'rgba(2,4,8,0)')
    c.fillStyle = gr
    c.fillRect(0, 0, W, H)
    c.textAlign = 'center'
    c.font = font(500, (PORTRAIT ? 104 : 104) * U * (PORTRAIT ? 0.82 : 1), FONT.serif)
    c.fillStyle = COL.ink
    c.shadowColor = 'rgba(0,0,0,0.6)'
    c.shadowBlur = 30
    const title = T.title || ''
    const lines = PORTRAIT ? splitTitle(title) : [title]
    const tpx = (PORTRAIT ? 104 * 0.82 : 104) * U
    lines.forEach((l, i) => c.fillText(l, cx, cy + i * tpx))
    c.shadowBlur = 0
    let y = cy + (lines.length - 1) * tpx + 48 * U
    c.fillStyle = COL.gold
    c.fillRect(cx - 120 * U, y, 240 * U, 2.5)
    y += 62 * U
    const b = creditsA(sc, t)
    // the maker's own line (project.yaml `dedication`), in his words, once the city has finished speaking
    if (T.dedication) {
      c.globalAlpha = a * b
      c.font = font(500, 34 * U, FONT.serif, 'italic')
      c.fillStyle = COL.ink
      for (const l of wrapText(c, T.dedication, PORTRAIT ? W - 160 : 1200)) {
        c.fillText(l, cx, y)
        y += 46 * U
      }
      y += 22 * U
    }
    // a soft dark scrim under the credit lines: they sit over the bright end painting (a gold dawn sky)
    {
      const nL = (T.credits || []).length
      const top = y - 34 * U
      const hgt = (T.repo_url ? 38 : 0) * U + 46 * U + nL * 32 * U + 30 * U
      const rw = (PORTRAIT ? W * 0.62 : 760 * U)
      c.save()
      c.globalAlpha = a * b * 0.62
      c.translate(cx, top + hgt / 2)
      c.scale(1, hgt / 2 / rw)
      const sg = c.createRadialGradient(0, 0, 0, 0, 0, rw)
      sg.addColorStop(0, 'rgba(8,10,16,0.85)')
      sg.addColorStop(0.6, 'rgba(8,10,16,0.55)')
      sg.addColorStop(1, 'rgba(8,10,16,0)')
      c.fillStyle = sg
      c.fillRect(-rw, -rw, 2 * rw, 2 * rw)
      c.restore()
    }
    c.shadowColor = 'rgba(0,0,0,0.75)'
    c.shadowBlur = 10 * U
    c.globalAlpha = a * b
    c.font = font(600, 22 * U, FONT.sans)
    c.letterSpacing = '0.24em'
    c.fillStyle = COL.gold
    c.fillText('MADE WITH TIMELINE · OPEN SOURCE', cx, y)
    c.letterSpacing = '0px'
    if (T.repo_url) {
      y += 38 * U
      c.font = font(500, 22 * U, FONT.sans)
      c.fillStyle = COL.ink
      c.fillText(String(T.repo_url).replace(/^https?:\/\//, ''), cx, y)
    }
    y += 46 * U
    c.font = font(400, (PORTRAIT ? 22 : 20) * U, FONT.sans)
    c.fillStyle = COL.ink
    c.globalAlpha = a * b * 0.88
    for (const line of T.credits || []) {
      c.fillText(line, cx, y)
      y += (PORTRAIT ? 34 : 32) * U
    }
    c.shadowBlur = 0
    c.globalAlpha = 1
  }
  function wrapText(c, s, maxW) {
    const out = ['']
    for (const w of String(s).split(/\s+/)) {
      const cand = out.at(-1) ? `${out.at(-1)} ${w}` : w
      if (out.at(-1) && c.measureText(cand).width > maxW) out.push(w)
      else out[out.length - 1] = cand
    }
    return out
  }

  // the station an illustration scene names ("Malviya Nagar, up the line"), or null: the inset map
  // only appears when it points at something the narration says
  function pipStation(sc) {
    if (sc.pipSt !== undefined) return sc.pipSt
    const text = String(sc.plan?.narration || '').replace(/<#[\d.\s]+#>/g, ' ')
    let best = null
    for (const st of ST) {
      for (const n of [st.name, ...(st.alt_names || [])]) {
        const m = new RegExp('\\b' + reEsc(n) + '\\b', 'i').exec(text)
        if (m && (!best || m.index < best.i)) best = { st, i: m.index }
      }
    }
    return (sc.pipSt = best?.st || null)
  }
  function drawPip(c, t, sc, sT, a) {
    const st = pipStation(sc)
    if (a < 0.01 || !st) return
    const { x, y, w, h } = LAY.pip
    // the station sits left of centre so its label (drawn to the right) fits inside the inset
    const cam = { x: st.x + (0.16 * w) / scaleOf(13.6), y: st.y, z: 13.6, s: scaleOf(13.6) }
    const pc = PIP.getContext('2d')
    drawMap(pc, cam, w, h, { trainS: sT, t, mini: true, focusStation: st, focusA: 0.7 + 0.3 * Math.sin((t - sc.start) * 3), dawn: dawnAt(t) })
    pc.setTransform(1, 0, 0, 1, 0, 0)
    c.globalAlpha = a
    c.save()
    c.shadowColor = 'rgba(0,0,0,0.6)'
    c.shadowBlur = 30
    c.beginPath()
    c.roundRect(x, y, w, h, 18)
    c.fillStyle = '#000'
    c.fill()
    c.shadowBlur = 0
    c.clip()
    c.drawImage(PIP, x, y)
    c.restore()
    c.globalAlpha = a
    c.strokeStyle = 'rgba(255,255,255,0.22)'
    c.lineWidth = 1.5
    c.beginPath()
    c.roundRect(x, y, w, h, 18)
    c.stroke()
    c.globalAlpha = 1
  }

  // ---------- frame
  function drawFrame(t) {
    t = clamp(t, 0, DUR)
    const i = sceneIndexAt(t)
    const sc = SCENES[i]
    const st = sceneState(sc, t)
    const cam = camOf(st)
    const sT = trainS(t)
    const layers = imageLayers(t)
    const lands = CITY ? landmarkLayers(t) : []
    const covered = layers.some((l) => l.a >= 0.999) || lands.some((l) => l.a >= 0.999)
    const imgA = Math.max(layers.reduce((m, l) => Math.max(m, l.a), 0), lands.reduce((m, l) => Math.max(m, l.a), 0))

    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalAlpha = 1
    g.globalCompositeOperation = 'source-over'
    const dawn = dawnAt(t)
    const firstMap = SCENES.find((s) => s.kind === 'map')
    const endSc = SCENES.find((s) => s.kind === 'end')
    const stripA = firstMap ? smooth(ramp(t, firstMap.start + 0.3, firstMap.start + 1.3)) * (1 - smooth(ramp(t, (endSc?.start ?? DUR + 9) - 0.6, (endSc?.start ?? DUR + 9) + 0.2))) * (1 - imgA) : 0
    if (!covered) {
      const focusSc = sc.kind === 'map' ? sc : null
      const titleSc = SCENES[0]?.kind === 'title' && !SCENES[0].img ? SCENES[0] : null
      const reveal = titleSc ? easeInOut(ramp(t, titleSc.start + 0.4, titleSc.start + 3.6)) : 1
      // the title lights the whole route; it settles to "ahead" once the ride begins
      const routeGlow = titleSc ? smooth(ramp(t, titleSc.start + 1.2, titleSc.start + 3.8)) * (1 - smooth(ramp(t, titleSc.end - 0.6, titleSc.end + 1.6))) : 0
      const mo = {
        bg: BG,
        trainS: sT,
        t,
        reveal,
        dawn,
        routeGlow,
        avoid: [...subtitleBoxes(t), ...chipBoxes(t), [...stripRect(), stripA], [...LAY.uiRects[0], sc.card ? env(t, sc.start, sc.end, 0.6, 0.5) : 0]],
        focus: focusList(t),
        focusStation: focusSc?.focusStation || null,
        focusA: focusSc ? smooth(ramp(t, (focusSc.travel?.t1 ?? focusSc.start) - 0.3, (focusSc.travel?.t1 ?? focusSc.start) + 0.6)) : 0,
        arrival: arrivalAt(t),
        labelA: sc.kind === 'end' ? 1 - 0.85 * creditsA(sc, t) : 1,
        minorA: sc.kind === 'title' || sc.kind === 'end' ? 0 : ['title', 'end'].includes(SCENES[i - 1]?.kind) ? smooth(ramp(t, sc.start + 0.5, sc.start + 2)) : 1,
      }
      if (CITY) draw3D(t, mo)
      else drawMap(g, cam, W, H, mo)
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.globalAlpha = (1 - 0.65 * dawn) * (CITY ? 0.75 : 1) // daylight opens the frame up
      g.drawImage(VIGNETTE, 0, 0)
      g.globalAlpha = 1
    } else {
      g.fillStyle = '#000'
      g.fillRect(0, 0, W, H)
    }
    // landmark paintings, with the 3D view carrying on in the inset card
    for (const l of lands) {
      drawLandLayer(g, l, t)
      const site = l.sc.focusSites?.[0]
      const an = site && CITY.siteAnchor(site.id)
      const insetA = l.a * env(t, l.r + 0.5, l.sc.end + XF, 0.6, 0.6)
      if (insetA > 0.01) {
        const focus = focusList(t)
        drawInset3D(g, t, insetA, an ? { lon: an.lon, lat: an.lat, d: clamp(an.r * 7 + 650, 700, 2200) } : null, { focus, dawn, trainS: sT, tags: focus.filter((f) => f.site.id === site?.id), low: yearUnderInset(l.sc) })
      }
    }
    for (const l of layers) drawImageLayer(g, l.sc, l.a, t)

    // title / end cards (title also overlaps into the next scene while it fades)
    for (const s of SCENES) {
      if (s.kind === 'title' && t >= s.start && t <= s.end + XF) drawTitleCard(g, s, t)
      if (s.kind === 'end' && t >= s.start) drawEndCard(g, s, t)
    }
    // picture-in-picture map during illustrations
    if (sc.kind === 'illustration' && sc.img) {
      const pa = env(t, sc.start + 0.9, sc.end - 0.2, 0.6, 0.5)
      const pst = pipStation(sc)
      if (CITY && pst && pa > 0.01) drawInset3D(g, t, pa, { ...ST3D.get(pst.id), d: 1500 }, { dawn, trainS: sT, station: pst })
      else if (!CITY) drawPip(g, t, sc, sT, pa)
    }
    drawStrip(g, t, stripA, sT)
    drawYearCard(g, t, i)
    drawChip(g, t)
    drawSubtitles(g, t)
    drawAttribution(g, t)

    // grain + fades
    const f = Math.round(t * FPS)
    const r = rng(f * 9973 + 1)
    g.save()
    g.globalCompositeOperation = 'overlay'
    g.globalAlpha = 0.07
    g.translate(-Math.floor(r() * 256), -Math.floor(r() * 256))
    g.fillStyle = GRAIN[f % GRAIN.length]
    g.fillRect(0, 0, W + 256, H + 256)
    g.restore()
    const black = Math.max(1 - smooth(ramp(t, 0, 0.9)), smooth(ramp(t, DUR - 1.4, DUR - 0.05)))
    if (black > 0.001) {
      g.globalAlpha = black
      g.fillStyle = '#000'
      g.fillRect(0, 0, W, H)
      g.globalAlpha = 1
    }
    drawDisclosure(g, t, imgA * (1 - black))
  }

  async function loadImages() {
    const base = window.ASSET_BASE || ''
    const load = async (src) => {
      const img = new Image()
      img.src = /^(file|https?|data):/.test(src) ? src : base + src
      try {
        await img.decode()
        return img
      } catch {
        console.warn('renderer: image failed', img.src)
        return null
      }
    }
    await Promise.all([
      ...SCENES.filter((s) => s.image && s.imgKind).map(async (s) => (s.img = await load(s.image))),
      ...SCENES.filter((s) => s.land).map(async (s) => (s.land.img = await load(s.land.src))),
    ])
  }

  // three.js city (+ globe when render/three/globe.js is served); any failure falls back to the 2D map
  async function init3D() {
    const THREE = await import('three')
    const { createCity } = await import('./three/city.js')
    GLC = document.createElement('canvas')
    GLC.width = W
    GLC.height = H
    const renderer = new THREE.WebGLRenderer({ canvas: GLC, antialias: false, alpha: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(1)
    renderer.setSize(W, H, false)
    let detail = null
    if (window.DETAIL_URL) {
      try {
        detail = await (await fetch(window.DETAIL_URL)).json()
      } catch (e) {
        console.warn('renderer: geo_detail failed', e.message)
      }
    }
    // the opening painting holds for the first line ("Sit down, traveller."), then gives way to the Earth
    // at night under the title: the dive runs through the rest of the title scene, lands over Delhi as the
    // narration says "the city you are riding into", and hands over to the 3D city as the first map scene starts
    const firstMap = SCENES.find((s) => s.kind === 'map' && s.map)
    let createGlobe = null
    let patches = []
    if (window.GLOBE_URL && firstMap) {
      try {
        ;({ createGlobe, EARTH_PATCHES: patches = [] } = await import(window.GLOBE_URL))
      } catch (e) {
        console.warn('renderer: globe unavailable', e.message)
      }
    }
    const start = stationById.get(firstMap?.map?.focus_station) || stationById.get(firstMap?.map?.train_to) || ST[0]
    if (createGlobe) {
      const title = SCENES[0]?.imgKind && SCENES[0].img ? SCENES[0] : null
      const firstCue = title && (T.cues || []).find((c) => c.scene === title.id)
      const show = title ? clamp(firstCue ? firstCue.end + 0.1 : title.start + 2.2, title.start + 1.6, Math.max(title.start + 1.6, title.end - 3.4)) : firstMap.start - 0.2
      GLOBE = createGlobe(THREE, renderer, { textureUrl: window.GLOBE_TEXTURE || 'assets/earth/earth_night_8k.jpg', target: { lat: start.lat, lon: start.lon } })
      await GLOBE.ready
      // hand over while the Earth-at-night texture is still crisp (~260 km up): the city's own ground
      // carries the same lights from there and dissolves them into the streets as it descends
      const alt = (p) => GLOBE.poseAt(p).altKm
      let lo = 0
      let hi = 1
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2
        alt(mid) > 260 ? (lo = mid) : (hi = mid)
      }
      const x0 = firstMap.start + 0.05
      GL_T = { show, pH: hi, x0, x1: x0 + 0.6 }
      GL_T.progress = (t) => clamp((GL_T.pH * (t - show)) / (x0 - show))
      // the globe's zoom speed at the hand-over (ln metres per second), matched by the city's dive
      GL_T.rate = ((Math.log(alt(hi - 0.004)) - Math.log(alt(hi))) / 0.004) * (hi / (x0 - show))
      GL_T.pose = GLOBE.poseAt(hi)
    }
    const pose = GL_T?.pose
    // the city's ground glows with the same Black Marble lights from altitude, so the hand-over is seamless
    const texUrl = new URL(window.GLOBE_TEXTURE || 'assets/earth/earth_night_8k.jpg', document.baseURI)
    const patch = GLOBE && patches.filter((p) => start.lon >= p.bounds[0] && start.lon <= p.bounds[2] && start.lat >= p.bounds[1] && start.lat <= p.bounds[3]).sort((a, b) => (a.bounds[2] - a.bounds[0]) - (b.bounds[2] - b.bounds[0]))[0]
    CITY = createCity(THREE, renderer, {
      geo: GEO,
      detail,
      timeline: T,
      aspect: PORTRAIT ? '9:16' : '16:9',
      synthetic: !!window.CITY_SYNTHETIC,
      layout: { focus: LAY.focus },
      hooks: {
        dawnAt,
        globe: !!GLOBE,
        lights: patch ? { url: new URL(patch.file, texUrl).href, bounds: patch.bounds } : null,
        intro: GL_T ? { t0: GL_T.x0, rate: GL_T.rate } : null,
        // the city's first view = the globe's pose at the hand-over
        space: pose ? { lon: pose.lon, lat: pose.lat, d: pose.rangeKm * 1000, p: pose.tilt, b: pose.bearing } : null,
      },
    })
    await CITY.ready
    ST3D = new Map(ST.map((st) => [st.id, CITY.stationAt(st.id)]))
    console.log(`renderer: 3D city ready (${JSON.stringify(CITY.stats)}${GLOBE ? ', globe' : ''})`)
  }

  window.timelineReady = (async () => {
    const faces = ['500 40px "TL Serif"', 'italic 500 40px "TL Serif"', '400 40px "TL Sans"', '500 40px "TL Sans"', '600 40px "TL Sans"', '650 40px "TL Sans"', '500 40px "TL Deva"']
    await Promise.all(faces.map((f) => document.fonts.load(f, f.includes('Deva') ? 'चाँदनी चौक' : 'Aa1')))
    await document.fonts.ready
    init()
    await loadImages()
    if (WANT3D) {
      try {
        await init3D()
      } catch (e) {
        console.error('renderer: 3D map unavailable, using the 2D map:', e.stack || e.message)
        CITY = null
        GLOBE = null
      }
    }
    window.drawFrame = drawFrame
    // read-only introspection for dev scripts
    window.TIMELINE_DEBUG = { stations: () => ST.map(({ id, name, s, minZ, side, story }) => ({ id, name, s, minZ, side, story })), camera: (t) => (CITY ? CITY.cameraAt(t) : sceneState(SCENES[sceneIndexAt(t)], t)), trainS, city: () => CITY?.stats || null }
    window.TIMELINE_INFO = { width: W, height: H, fps: FPS, duration: DUR, frames: Math.round(DUR * FPS), map: CITY ? '3d' : '2d', globe: !!GLOBE }
    return window.TIMELINE_INFO
  })()
})()
