// geo_detail.json: the street-level city for the 3D map. Every building (extruded footprint with a
// height in metres), street, path and railway, plus small parks and water, in a corridor around the
// ridden line and around every site the film lights up. Map data (c) OpenStreetMap contributors, ODbL 1.0.
//
// Fetched as a few bbox chunks along the line (one Overpass query at a time, cached like geo.json's),
// then cut locally to the corridor: buildings by centroid, streets as runs of vertices inside it.
import { bboxOf, cleanRing, clipRing, cumulativeKm, pointInRing, project, ringAreaM2, ringCentroid, roundCoords, simplify } from './geom.mjs'
import { areaPolygons, elementLines, osmId } from './osm.mjs'
import { hash } from '../util.mjs'

export const CORRIDOR_M = 1200 // each side of the ridden line
export const SITE_M = 800 // around every site the film lights up
export const CHUNK_KM = 3 // line length per Overpass bbox
const STREET_MARGIN_M = 120 // streets run a little past the corridor edge (the 3D fog hides the cut)
const SITE_INSIDE_MAX_KM2 = 2 // buildings inside a site footprint up to this size are kept and tagged
const LEVEL_M = 3.2

const M_PER_DEG = 111_320
const RAD = Math.PI / 180
const r1 = (x) => Math.round(x * 10) / 10
const fc = (features) => ({ type: 'FeatureCollection', features })

// ---------- chunks ----------------------------------------------------------------------

/** [s, w, n, e] around [w, s, e, n] padded by m metres. */
function padBox([w, s, e, n], m) {
  const dy = m / M_PER_DEG
  const dx = m / (M_PER_DEG * Math.cos(((s + n) / 2) * RAD))
  return [s - dy, w - dx, n + dy, e + dx]
}
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
const bboxStr = (b) => b.map((v) => v.toFixed(4)).join(',')

/**
 * Overpass boxes ([s, w, n, e]): the line cut into ~CHUNK_KM pieces, each padded by the corridor;
 * a site's box joins the chunk nearest to it along the line.
 */
export function detailChunks(lineCoords, sites, { chunkKm = CHUNK_KM, corridorM = CORRIDOR_M, siteM = SITE_M } = {}) {
  const cum = cumulativeKm(lineCoords)
  const total = cum.at(-1)
  const n = Math.max(1, Math.round(total / chunkKm))
  const boxes = []
  for (let k = 0; k < n; k++) {
    const k0 = (total * k) / n
    const k1 = (total * (k + 1)) / n
    const pts = lineCoords.filter((_, i) => cum[i] >= k0 - 0.05 && cum[i] <= k1 + 0.05)
    // interpolated ends so a chunk never misses the line between two far-apart vertices
    for (const km of [k0, k1]) {
      const i = cum.findIndex((c) => c >= km)
      if (i > 0) {
        const t = (km - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)
        pts.push([lineCoords[i - 1][0] + (lineCoords[i][0] - lineCoords[i - 1][0]) * t, lineCoords[i - 1][1] + (lineCoords[i][1] - lineCoords[i - 1][1]) * t])
      } else pts.push(lineCoords[0])
    }
    boxes.push({ k0, k1, box: padBox(bboxOf(pts), corridorM + 60) })
  }
  for (const s of sites) {
    const km = project(lineCoords, [s.lon, s.lat], cum).km
    const c = boxes.find((b) => km >= b.k0 - 1e-6 && km <= b.k1 + 1e-6) || boxes.at(-1)
    c.box = union(c.box, padBox([s.lon, s.lat, s.lon, s.lat], siteM + 60))
  }
  return boxes.map((b) => b.box)
}

// ---------- queries ---------------------------------------------------------------------

export function buildingsQuery(box) {
  const bb = bboxStr(box)
  return `[out:json][timeout:240];
(
  way["building"](${bb});
  way["building:part"](${bb});
  relation["building"]["type"="multipolygon"](${bb});
  relation["building:part"]["type"="multipolygon"](${bb});
  way["man_made"~"^(tower|minaret|obelisk|observatory)$"](${bb});
  way["historic"~"^(monument|memorial|tower|city_gate)$"]["area"!="yes"](${bb});
  node["historic"~"^(monument|memorial|pillar|column|tower)$"]["height"](${bb});
  node["man_made"~"^(obelisk|tower|minaret|column)$"]["height"](${bb});
);
out geom qt;`
}

export function streetsQuery(box) {
  const bb = bboxStr(box)
  return `[out:json][timeout:240];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|unclassified|residential|living_street|service|pedestrian|footway|path|cycleway|steps|track|bridleway)$"]["area"!="yes"](${bb});
  way["railway"~"^(rail|subway|light_rail|tram|narrow_gauge|monorail)$"](${bb});
  way["leisure"~"^(park|garden|pitch|playground|golf_course|nature_reserve|recreation_ground)$"](${bb});
  way["landuse"~"^(grass|recreation_ground|forest|meadow|village_green|cemetery|orchard)$"](${bb});
  way["natural"~"^(wood|scrub|grassland|water|wetland)$"](${bb});
  way["waterway"="riverbank"](${bb});
  relation["type"="multipolygon"]["leisure"~"^(park|garden|golf_course|nature_reserve)$"](${bb});
  relation["type"="multipolygon"]["landuse"~"^(grass|recreation_ground|forest|cemetery)$"](${bb});
  relation["type"="multipolygon"]["natural"~"^(wood|scrub|water)$"](${bb});
);
out geom qt;`
}

const LANDUSE = 'residential|commercial|retail|industrial|institutional|education|religious|military|railway|construction|garages'
export function landuseQuery(box) {
  const bb = bboxStr(box)
  return `[out:json][timeout:240];
(
  way["landuse"~"^(${LANDUSE})$"](${bb});
  relation["type"="multipolygon"]["landuse"~"^(${LANDUSE})$"](${bb});
);
out geom qt;`
}

// ---------- the corridor ----------------------------------------------------------------

/** Distance test against the corridor: the ridden line (corridorM) or a site (siteM). */
export function corridor(lineCoords, sites, { corridorM = CORRIDOR_M, siteM = SITE_M } = {}) {
  const cum = cumulativeKm(lineCoords)
  const [w, s, e, n] = bboxOf(lineCoords)
  const lat0 = (s + n) / 2
  const kx = Math.cos(lat0 * RAD) * M_PER_DEG
  const pts = sites.map((x) => [x.lon, x.lat])
  const insides = sites.filter((x) => x.polygon && ringAreaM2(x.polygon) <= SITE_INSIDE_MAX_KM2 * 1e6)
  /** metres outside the corridor (<= 0 inside) */
  const outside = (p, extra = 0) => {
    // cheap reject: far outside the padded line bbox and every site
    const dxLine = Math.max(w - p[0], 0, p[0] - e) * kx
    const dyLine = Math.max(s - p[1], 0, p[1] - n) * M_PER_DEG
    let best = Math.hypot(dxLine, dyLine) - corridorM
    if (best <= extra) best = project(lineCoords, p, cum).distM - corridorM
    for (const q of pts) {
      if (best <= 0) break
      const d = Math.hypot((p[0] - q[0]) * kx, (p[1] - q[1]) * M_PER_DEG) - siteM
      if (d < best) best = d
    }
    if (best > 0) for (const x of insides) if (pointInRing(p, x.polygon)) return 0
    return best
  }
  return { outside }
}

// ---------- heights ---------------------------------------------------------------------

/** "12", "12 m", "12.5m", "40'", "40 ft" -> metres; null when unreadable. */
export function parseLength(v) {
  if (v == null) return null
  const m = String(v).replace(',', '.').match(/^\s*([\d.]+)\s*(m|metres?|meters?|ft|feet|'|)?\s*$/i)
  if (!m) return null
  const x = Number(m[1])
  if (!Number.isFinite(x)) return null
  return /^(ft|feet|')$/i.test(m[2] || '') ? x * 0.3048 : x
}
const parseLevels = (v) => {
  if (v == null) return null
  const nums = String(v).split(/[;,]/).map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x >= 0 && x < 200)
  return nums.length ? Math.max(...nums) : null
}

// typical heights (metres) by building / structure type: [min, max]; a deterministic pick in between
const TYPE_H = [
  [/^(garage|garages|shed|hut|kiosk|carport|toilets|container|cabin|service|transformer_tower|bunker|static_caravan|gatehouse|guardhouse)$/, [2.6, 3.4]],
  [/^(house|detached|semidetached_house|terrace|bungalow|farm|farm_auxiliary|villa)$/, [6.4, 9.6]],
  [/^(apartments|dormitory)$/, [12.8, 19.2]],
  [/^(residential)$/, [9.6, 12.8]],
  [/^(commercial|retail|office|bank|supermarket)$/, [9.6, 16]],
  [/^(hotel)$/, [16, 25.6]],
  [/^(industrial|warehouse|manufacture|factory|hangar|storage_tank)$/, [6.4, 9.6]],
  [/^(school|college|university|kindergarten|hospital|public|civic|government|courthouse|fire_station|police|library|museum)$/, [9.6, 16]],
  [/^(mosque|temple|church|cathedral|chapel|religious|shrine|gurudwara|gurdwara|synagogue|monastery|mandir)$/, [9.6, 14]],
  [/^(train_station|transportation|station)$/, [8, 12]],
  [/^(stadium|grandstand|sports_hall|sports_centre)$/, [14, 22]],
  [/^(ruins)$/, [3, 5]],
  [/^(construction)$/, [4, 8]],
  [/^(tomb|mausoleum)$/, [9, 12]],
  [/^(gate|city_gate)$/, [8, 12]],
]
const DEFAULT_H = [6.4, 12.8] // building=yes and anything unlisted: 2-4 storeys

const jitter = (id, [lo, hi]) => lo + (parseInt(hash(id, 6), 16) / 0xffffff) * (hi - lo)

/**
 * Height of an extruded footprint: `height`, else levels x 3.2 m (+ half a storey per roof level),
 * else a typical height for its type (deterministic per OSM id, never taller than its footprint is
 * wide x 2.5). Returns { h, min_h, src }.
 */
export function heightOf(t = {}, id, areaM2 = 100) {
  let min_h = parseLength(t.min_height)
  if (min_h == null) {
    const ml = parseLevels(t['building:min_level'])
    min_h = ml != null ? ml * LEVEL_M : 0
  }
  let h = parseLength(t.height) ?? parseLength(t['building:height'])
  let src = 'height'
  if (h == null) {
    const lv = parseLevels(t['building:levels'])
    // Simple 3D Buildings: building:levels counts from the ground, building:min_level levels are skipped
    if (lv != null && lv > 0) {
      h = (lv + 0.5 * (parseLevels(t['roof:levels']) || 0)) * LEVEL_M
      src = 'levels'
    }
  }
  if (h == null) {
    src = 'type'
    const kind = t.building && t.building !== 'yes' ? t.building : t['building:part'] && t['building:part'] !== 'yes' ? t['building:part'] : t.historic || t.man_made || 'yes'
    if (kind === 'roof') {
      return { h: 4.5, min_h: 3, src } // canopies: a lid on posts
    }
    if (/^(tower|minaret)$/.test(kind)) h = 20
    else if (/^(obelisk|monument|memorial|column|pillar)$/.test(kind)) h = 8
    else h = jitter(id, (TYPE_H.find(([re]) => re.test(kind)) || [null, DEFAULT_H])[1])
    if (/^(mosque|temple|church|shrine|religious|gurudwara|gurdwara)$/.test(kind) && areaM2 < 60) h = Math.min(h, 5)
    h = Math.min(h, Math.max(3, Math.sqrt(areaM2) * 2.5))
  }
  h = Math.max(h, min_h + 1)
  return { h: r1(h), min_h: r1(min_h), src }
}

// ---------- what a building is and looks like (OSM tags carried for the 3D city's materials) ----------

// OSM colour names (building:colour / roof:colour) -> hex; anything else must already be a hex triplet
const COLOUR = {
  white: '#f2f0ea', whitesmoke: '#f2f2f2', ivory: '#f4f0e0', cream: '#efe4c8', beige: '#e3d6b8', wheat: '#e8d4ab', linen: '#efe8dc', snow: '#f6f4f2',
  black: '#2c2c2e', grey: '#8c8c8c', gray: '#8c8c8c', darkgrey: '#5e5e5e', darkgray: '#5e5e5e', lightgrey: '#c4c4c4', lightgray: '#c4c4c4', silver: '#bcbec2', dimgray: '#696969',
  brown: '#8a6145', maroon: '#7a3328', tan: '#c9ad84', sienna: '#9c5a3c', chocolate: '#a25a2c', peru: '#c48a52',
  red: '#a8483a', darkred: '#7d2a22', firebrick: '#a8322a', indianred: '#b85a52', salmon: '#d98c78', coral: '#d97f5f', brick: '#9c4f3a', terracotta: '#b8674a',
  pink: '#dba3a3', lightpink: '#e6b8bc', rose: '#d48c96', magenta: '#a8508c', violet: '#9a7fb0', purple: '#74508a',
  orange: '#d9853f', darkorange: '#d47828', saffron: '#e3913a', gold: '#d6ac3c', golden: '#d6ac3c', yellow: '#dcc05a', lightyellow: '#ece2a8', khaki: '#cdbd86', ochre: '#c9923c',
  green: '#6d8f63', darkgreen: '#3f5e3a', olive: '#7d7b45', lightgreen: '#9fbf8f', teal: '#4f8682', turquoise: '#5aa6a0',
  blue: '#5f7fae', darkblue: '#384f7d', lightblue: '#9db7d2', navy: '#2f3f63', skyblue: '#8db6d8', cyan: '#6fb0bd', aqua: '#6fb0bd',
  sandstone: '#c9a77c', redstone: '#9c4f3a', marble: '#ece8e0', glass: '#7f95a8', copper: '#9a6a48', bronze: '#8c6a3a',
}

/** building:colour / roof:colour -> '#rrggbb' (first of a ';' list), or null. */
export function colourHex(v) {
  if (v == null) return null
  const s = String(v).split(';')[0].trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (COLOUR[s]) return COLOUR[s]
  const m = s.match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/)
  if (!m) return null
  const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1]
  return `#${h}`
}

/** A tag value worth carrying (not empty, not plain "yes"/"no"), trimmed to a sane length. */
const val = (v, keepYes = false) => {
  if (v == null) return null
  const s = String(v).split(';')[0].trim()
  if (!s || s === 'no' || (!keepYes && s === 'yes')) return null
  return s.slice(0, 40)
}

/**
 * The look-relevant OSM tags of a building, short keys (only those present): use (building:use),
 * col / rcol (building:colour / roof:colour as hex), mat (building:material), roof (roof:shape when
 * not flat), roof_h (roof:height, metres), lv (building:levels), am (amenity), rel (religion),
 * hist (historic), off (office), gov (government), tour (tourism), shop, mm (man_made).
 */
export function lookTags(t = {}) {
  const out = {}
  const put = (k, v) => v != null && (out[k] = v)
  put('use', val(t['building:use']))
  put('col', colourHex(t['building:colour'] || t.colour))
  put('rcol', colourHex(t['roof:colour']))
  put('mat', val(t['building:material']))
  const rs = val(t['roof:shape'])
  if (rs && rs !== 'flat') put('roof', rs)
  const rh = parseLength(t['roof:height'])
  if (rh != null && rh > 0 && rh < 80) put('roof_h', r1(rh))
  const lv = parseLevels(t['building:levels'])
  if (lv != null && lv > 0) put('lv', lv)
  put('am', val(t.amenity))
  put('rel', val(t.religion))
  put('hist', val(t.historic, true))
  put('off', val(t.office, true))
  put('gov', val(t.government, true))
  put('tour', val(t.tourism))
  put('shop', val(t.shop, true))
  put('mm', val(t.man_made))
  return out
}

// look tags a building:part takes from its outline when it has none of its own
const INHERIT = ['k', 'use', 'col', 'mat', 'am', 'rel', 'hist', 'off', 'gov', 'tour', 'shop']

// ---------- builders --------------------------------------------------------------------

const ringOf = (el) => areaPolygons(el)[0]?.[0] || null

/** A small octagon (radius r metres) for a monument OSM maps only as a point. */
function octagon([lon, lat], r) {
  const kx = Math.cos(lat * RAD) * M_PER_DEG
  const ring = []
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    ring.push([+(lon + (Math.cos(a) * r) / kx).toFixed(6), +(lat + (Math.sin(a) * r) / M_PER_DEG).toFixed(6)])
  }
  ring.push(ring[0].slice())
  return ring
}

/**
 * Buildings (and extruded structures) inside the corridor as Polygon features (outer ring only).
 * properties: h, min_h (metres), h_src ('height'|'levels'|'type'), and when present: k (building
 * type other than "yes"; a part's building:part type), part (a building:part), has_parts (an outline
 * whose parts are listed too: draw the parts, not the outline), site_ids (sites the film lights up
 * that this building belongs to, most specific first), name (named monuments only), synthetic (a
 * point monument given a small footprint), the look tags of lookTags() (use, col, rcol, mat, roof,
 * roof_h, lv, am, rel, hist, off, gov, tour, shop, mm), and lu (added by buildLanduse).
 */
export function buildBuildings(docs, { outside, sites }) {
  const seen = new Set()
  const out = []
  const parts = []
  const siteByOsm = new Map(sites.filter((s) => s.osm_id).map((s) => [s.osm_id, s]))
  const sitePolys = sites.filter((s) => s.polygon && ringAreaM2(s.polygon) <= SITE_INSIDE_MAX_KM2 * 1e6).sort((a, b) => ringAreaM2(a.polygon) - ringAreaM2(b.polygon))
  const stats = { height: 0, levels: 0, type: 0, dropped_small: 0, dropped_outside: 0 }
  for (const doc of docs) {
    for (const el of doc.elements) {
      const id = osmId(el)
      if (seen.has(id)) continue
      seen.add(id)
      const t = el.tags || {}
      let ring
      let synthetic = false
      if (el.type === 'node') {
        const site = siteByOsm.get(id)
        // a point monument: only those the film lights up get a (small) footprint
        if (!site) continue
        ring = octagon([el.lon, el.lat], Math.max(0.6, Math.min(3, (parseLength(t.diameter) || 0.8) / 2)))
        synthetic = true
      } else {
        const raw = ringOf(el)
        if (!raw) continue
        const area = ringAreaM2(raw)
        if (area < 8) {
          stats.dropped_small++
          continue
        }
        const c = ringCentroid(raw)
        if (outside(c) > 0) {
          stats.dropped_outside++
          continue
        }
        ring = cleanRing(raw, area > 2000 ? 1 : 0.5)
        if (!ring) {
          stats.dropped_small++
          continue
        }
      }
      const area = ringAreaM2(ring)
      const { h, min_h, src } = heightOf(t, id, area)
      stats[src]++
      const props = { h, min_h, h_src: src }
      // a building:part's own type ("commercial", "tower") stands in for the building type
      const kind = t.building && t.building !== 'yes' ? t.building : !t.building && t['building:part'] && t['building:part'] !== 'yes' ? t['building:part'] : null
      if (kind) props.k = kind
      if (t['building:part'] && !t.building) {
        props.part = true
        parts.push({ ring, props })
      }
      Object.assign(props, lookTags(t))
      const c = ringCentroid(ring)
      const ids = []
      if (siteByOsm.has(id)) ids.push(siteByOsm.get(id).id)
      for (const s of sitePolys) if (!ids.includes(s.id) && pointInRing(c, s.polygon)) ids.push(s.id)
      if (ids.length) props.site_ids = ids
      if ((t.wikidata || t.historic) && t.name) props.name = t['name:en'] || t.name
      if (synthetic) props.synthetic = true
      props.osm_id = id
      out.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } })
    }
  }
  // outlines that contain building:parts: flag them so a renderer draws the parts instead; a part
  // takes its outline's type and look tags where it has none of its own (North Block's parts are
  // still a government building)
  if (parts.length) {
    const outlines = out.filter((f) => !f.properties.part)
    const boxes = outlines.map((f) => bboxOf(f.geometry.coordinates[0]))
    for (const p of parts) {
      const c = ringCentroid(p.ring)
      let host = null
      outlines.forEach((f, i) => {
        const b = boxes[i]
        if (c[0] >= b[0] && c[0] <= b[2] && c[1] >= b[1] && c[1] <= b[3] && pointInRing(c, f.geometry.coordinates[0])) {
          f.properties.has_parts = true
          if (!host || ringAreaM2(f.geometry.coordinates[0]) < ringAreaM2(host.geometry.coordinates[0])) host = f
        }
      })
      if (host) for (const k of INHERIT) if (p.props[k] == null && host.properties[k] != null) p.props[k] = host.properties[k]
    }
  }
  return { features: out, stats }
}

const MAJOR = /^(motorway|trunk|primary|secondary)(_link)?$/
const MINOR = /^(tertiary|tertiary_link|unclassified|residential|living_street|service)$/
const PATH = /^(pedestrian|footway|path|cycleway|steps|track|bridleway)$/

function streetClass(t) {
  if (t.railway) return 'rail'
  const hw = t.highway || ''
  if (MAJOR.test(hw)) return 'major'
  if (MINOR.test(hw)) {
    if (hw === 'service' && /^(parking_aisle|driveway|drive-through)$/.test(t.service || '')) return null
    return 'minor'
  }
  if (PATH.test(hw)) {
    if (/^(sidewalk|crossing|traffic_island)$/.test(t.footway || '')) return null // drawn with their road
    return 'path'
  }
  return null
}

/** Runs of a polyline that stay inside the corridor (+ margin), one vertex past each end. */
function corridorRuns(coords, outside, marginM) {
  const inside = coords.map((p) => outside(p, marginM) <= marginM)
  const runs = []
  let run = null
  for (let i = 0; i < coords.length; i++) {
    const keep = inside[i] || inside[i - 1] || inside[i + 1]
    if (keep) {
      if (!run) runs.push((run = []))
      run.push(coords[i])
    } else run = null
  }
  return runs.filter((r) => r.length >= 2)
}

/**
 * Streets, paths and railways as LineString features. properties: cls ("major"|"minor"|"path"|"rail"),
 * and when present: hw (highway or railway value), tunnel (underground: do not draw on the surface),
 * bridge (elevated), name (major streets only).
 */
export function buildStreets(docs, { outside }) {
  const seen = new Set()
  const out = []
  const counts = { major: 0, minor: 0, path: 0, rail: 0 }
  for (const doc of docs) {
    for (const el of doc.elements) {
      if (el.type !== 'way' || !(el.tags?.highway || el.tags?.railway)) continue
      const id = osmId(el)
      if (seen.has(id)) continue
      seen.add(id)
      const t = el.tags
      const cls = streetClass(t)
      if (!cls) continue
      const tol = cls === 'major' || cls === 'rail' ? 2 : 2.5
      for (const line of elementLines(el)) {
        for (const run of corridorRuns(line, outside, STREET_MARGIN_M)) {
          const coords = roundCoords(simplify(run, tol), 5)
          if (coords.length < 2) continue
          const props = { cls, hw: t.railway || t.highway }
          const layer = Number(t.layer) || 0
          if (t.tunnel && t.tunnel !== 'no') props.tunnel = true
          else if (layer < 0 && (t.railway === 'subway' || t.location === 'underground')) props.tunnel = true
          if (t.bridge && t.bridge !== 'no') props.bridge = true
          if (cls === 'major' && (t['name:en'] || t.name)) props.name = t['name:en'] || t.name
          out.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } })
          counts[cls]++
        }
      }
    }
  }
  return { features: out, counts }
}

function areaKind(t) {
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.natural === 'wetland') return 'water'
  if (t.landuse === 'forest' || t.natural === 'wood') return 'wood'
  if (t.natural === 'scrub' || t.natural === 'grassland' || t.landuse === 'meadow') return 'scrub'
  if (t.leisure === 'pitch' || t.leisure === 'playground') return 'pitch'
  if (t.landuse === 'cemetery') return 'cemetery'
  if (t.leisure === 'garden') return 'garden'
  if (t.landuse === 'grass' || t.landuse === 'village_green') return 'grass'
  return 'park'
}

/**
 * Small parks, lawns, woods and ponds the base map (geo.json, areas >= 5 ha) leaves out, clipped to
 * the detail bbox: { green, water } FeatureCollections of Polygons (outer ring; properties.kind).
 */
export function buildAreas(docs, { outside, bbox }) {
  const [s, w, n, e] = bbox
  const box = [w, s, e, n]
  const seen = new Set()
  const green = []
  const water = []
  for (const doc of docs) {
    for (const el of doc.elements) {
      const t = el.tags || {}
      if (t.highway || t.railway || t.building) continue
      const id = osmId(el)
      if (seen.has(id)) continue
      seen.add(id)
      for (const [outer] of areaPolygons(el)) {
        const area = ringAreaM2(outer)
        if (area < 300) continue
        // keep it when it touches the corridor (any of a few vertices, or its centroid)
        const step = Math.max(1, Math.floor(outer.length / 16))
        let hit = outside(ringCentroid(outer)) <= 0
        for (let i = 0; !hit && i < outer.length; i += step) hit = outside(outer[i]) <= 0
        if (!hit) continue
        const clipped = clipRing(outer, box)
        const ring = clipped && cleanRing(clipped, area > 50_000 ? 3 : 1.5)
        if (!ring) continue
        const kind = areaKind(t)
        const f = { type: 'Feature', properties: { kind, area_ha: Math.round(area / 100) / 100 }, geometry: { type: 'Polygon', coordinates: [ring] } }
        ;(kind === 'water' ? water : green).push(f)
      }
    }
  }
  const big = (a, b) => b.properties.area_ha - a.properties.area_ha // big first: small ones paint on top
  return { green: fc(green.sort(big)), water: fc(water.sort(big)) }
}

// ---------- land use and the infill where OSM maps the lanes but not the houses ---------------------

const M_LON = (lat) => Math.cos(lat * RAD) * M_PER_DEG
const DENSE = new Set(['residential', 'commercial', 'retail'])

/** A metric frame around lat0: [lon, lat] <-> [x, y] metres. */
function frame(lat0, lon0) {
  const kx = M_LON(lat0)
  return { to: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * M_PER_DEG], from: ([x, y]) => [lon0 + x / kx, lat0 + y / M_PER_DEG] }
}

/** Sum grid (cell metres): add(x, y, v), sum(x, y, r) over the (2r+1)^2 cells around. */
function grid(cell) {
  const m = new Map()
  const k = (i, j) => i * 100003 + j
  return {
    add(x, y, v) {
      const key = k(Math.floor(x / cell), Math.floor(y / cell))
      m.set(key, (m.get(key) || 0) + v)
    },
    sum(x, y, r) {
      const i0 = Math.floor(x / cell)
      const j0 = Math.floor(y / cell)
      let s = 0
      for (let i = i0 - r; i <= i0 + r; i++) for (let j = j0 - r; j <= j0 + r; j++) s += m.get(k(i, j)) || 0
      return s
    },
  }
}

/** Bucket index of items with metric bboxes: near(x, y, pad) -> candidate items. */
function bucketIndex(cell) {
  const m = new Map()
  const k = (i, j) => i * 100003 + j
  return {
    insert(box, item) {
      for (let i = Math.floor(box[0] / cell); i <= Math.floor(box[2] / cell); i++) for (let j = Math.floor(box[1] / cell); j <= Math.floor(box[3] / cell); j++) {
        const key = k(i, j)
        if (!m.has(key)) m.set(key, [])
        m.get(key).push(item)
      }
    },
    near(x, y) {
      return m.get(k(Math.floor(x / cell), Math.floor(y / cell))) || []
    },
  }
}

/**
 * OSM land use touching the corridor: Polygon features { kind, area_ha, bldg_cover, lanes_km_km2 }.
 * bldg_cover: share of the area under OSM buildings; lanes_km_km2: mapped streets and paths per km²
 * (dense lanes with almost no buildings = OSM has not mapped the houses yet).
 * Also tags each building with `lu`: the kind of the smallest land use its centroid falls in (the 3D
 * city reads an untyped building=yes by its neighbourhood: residential, commercial, education, ...).
 */
export function buildLanduse(docs, { outside, bbox, buildings, streets }) {
  const [s, w, n, e] = bbox
  const box = [w, s, e, n]
  const F = frame((s + n) / 2, (w + e) / 2)
  const bIdx = bucketIndex(100)
  for (const f of buildings) {
    const ring = f.geometry.coordinates[0]
    const c = F.to(ringCentroid(ring))
    bIdx.insert([c[0], c[1], c[0], c[1]], { c, a: ringAreaM2(ring), f })
  }
  const luArea = new Map() // building -> area of the land use it was given (smallest wins)
  const lanes = grid(25)
  for (const f of streets) {
    if (f.properties.tunnel || f.properties.cls === 'rail') continue
    const co = f.geometry.coordinates.map(F.to)
    for (let i = 1; i < co.length; i++) {
      const len = Math.hypot(co[i][0] - co[i - 1][0], co[i][1] - co[i - 1][1])
      const steps = Math.max(1, Math.ceil(len / 10))
      for (let k = 0; k < steps; k++) {
        const u = (k + 0.5) / steps
        lanes.add(co[i - 1][0] + (co[i][0] - co[i - 1][0]) * u, co[i - 1][1] + (co[i][1] - co[i - 1][1]) * u, len / steps)
      }
    }
  }
  const seen = new Set()
  const out = []
  for (const doc of docs) {
    for (const el of doc.elements) {
      const id = osmId(el)
      if (seen.has(id)) continue
      seen.add(id)
      const kind = el.tags?.landuse
      for (const [outer] of areaPolygons(el)) {
        const area = ringAreaM2(outer)
        if (area < 2000) continue
        const step = Math.max(1, Math.floor(outer.length / 16))
        let hit = outside(ringCentroid(outer)) <= 0
        for (let i = 0; !hit && i < outer.length; i += step) hit = outside(outer[i]) <= 0
        if (!hit) continue
        const clipped = clipRing(outer, box)
        const ring = clipped && cleanRing(clipped, 2)
        if (!ring) continue
        const a = ringAreaM2(ring)
        // coverage and lane density from the buildings / street pieces whose points fall inside
        const mr = ring.map(F.to)
        const mb = bboxOf(mr)
        let built = 0
        const counted = new Set()
        for (let x = mb[0]; x <= mb[2] + 100; x += 100) for (let y = mb[1]; y <= mb[3] + 100; y += 100) for (const b of bIdx.near(x, y)) if (!counted.has(b) && pointInRing(b.c, mr)) (counted.add(b), (built += b.a))
        for (const b of counted) {
          if (!kind || (luArea.has(b.f) && luArea.get(b.f) <= a)) continue
          luArea.set(b.f, a)
          b.f.properties.lu = kind
        }
        let laneM = 0
        for (let i = Math.floor(mb[0] / 25); i <= Math.floor(mb[2] / 25); i++) for (let j = Math.floor(mb[1] / 25); j <= Math.floor(mb[3] / 25); j++) if (pointInRing([(i + 0.5) * 25, (j + 0.5) * 25], mr)) laneM += lanes.sum((i + 0.5) * 25, (j + 0.5) * 25, 0)
        out.push({ type: 'Feature', properties: { kind, area_ha: Math.round(a / 100) / 100, bldg_cover: Math.round((built / a) * 1000) / 1000, lanes_km_km2: Math.round(laneM / 1000 / (a / 1e6)) }, geometry: { type: 'Polygon', coordinates: [ring] } })
      }
    }
  }
  return fc(out.sort((a, b) => b.properties.area_ha - a.properties.area_ha))
}

/**
 * Procedural infill (NOT OpenStreetMap data): small blocks where OSM maps a dense web of lanes but
 * almost no buildings (dense land use, local building cover < maxCover, lane density >= minLanes),
 * on a jittered grid, aligned to the nearest street, kept clear of every street, building, park and
 * pond. Deterministic. Polygon features { h, min_h: 0, fill: true, lu } (6 dp; lu: the land use kind).
 */
export function buildFill({ landuse, buildings, streets, areas, bbox }, { spacing = 15, areaCover = 0.08, areaLanes = 18, maxCover = 0.08, minLanes = 14, radius = 70 } = {}) {
  const [s, w, n, e] = bbox
  const F = frame((s + n) / 2, (w + e) / 2)
  const cover = grid(20)
  const bIdx = bucketIndex(50)
  for (const f of buildings) {
    const mr = f.geometry.coordinates[0].map(F.to)
    const b = bboxOf(mr)
    const c = F.to(ringCentroid(f.geometry.coordinates[0]))
    cover.add(c[0], c[1], ringAreaM2(f.geometry.coordinates[0]))
    bIdx.insert([b[0] - 4, b[1] - 4, b[2] + 4, b[3] + 4], b)
  }
  const lanes = grid(20)
  const sIdx = bucketIndex(40)
  const CLEAR = { major: 10, minor: 5.5, path: 2.5, rail: 7 }
  for (const f of streets) {
    if (f.properties.tunnel) continue
    const co = f.geometry.coordinates.map(F.to)
    const clear = CLEAR[f.properties.cls] || 5
    for (let i = 1; i < co.length; i++) {
      const a = co[i - 1]
      const b = co[i]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (f.properties.cls !== 'rail') lanes.add((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, len)
      const pad = clear + 8
      sIdx.insert([Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad, Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad], { a, b, clear })
    }
  }
  const aIdx = bucketIndex(100)
  for (const f of areas) {
    const mr = f.geometry.coordinates[0].map(F.to)
    aIdx.insert(bboxOf(mr), { mr, box: bboxOf(mr) })
  }
  const r = Math.round(radius / 20)
  const disk = ((2 * Math.round(radius / 20) + 1) * 20) ** 2 // the square the sums cover
  const out = []
  const stats = { polygons: 0, blocks: 0 }
  for (const lu of landuse.features) {
    // the whole area must look under-mapped (a dense web of lanes, almost no buildings): a garden suburb
    // (wide plots, few roads) never qualifies, however empty its gardens look
    const P = lu.properties
    if (!DENSE.has(P.kind) || P.bldg_cover > areaCover || P.lanes_km_km2 < areaLanes) continue
    const mr = lu.geometry.coordinates[0].map(F.to)
    const mb = bboxOf(mr)
    let used = false
    for (let gx = Math.floor(mb[0] / spacing) * spacing; gx <= mb[2]; gx += spacing) {
      for (let gy = Math.floor(mb[1] / spacing) * spacing; gy <= mb[3]; gy += spacing) {
        const hsh = parseInt(hash(`${Math.round(gx)},${Math.round(gy)}`, 8), 16)
        const rnd = (k) => ((hsh >>> (k * 4)) & 0xff) / 255
        const x = gx + (rnd(0) - 0.5) * spacing * 0.3
        const y = gy + (rnd(1) - 0.5) * spacing * 0.3
        if (!pointInRing([x, y], mr)) continue
        if (cover.sum(x, y, r) / disk >= maxCover) continue
        if ((lanes.sum(x, y, r) / 1000) / (((2 * r + 1) * 20) ** 2 / 1e6) < minLanes) continue
        // nearest street: its direction aligns the block, its clearance sizes it
        let best = Infinity
        let dir = 0
        let room = Infinity
        for (const sg of sIdx.near(x, y)) {
          const dx = sg.b[0] - sg.a[0]
          const dy = sg.b[1] - sg.a[1]
          const l2 = dx * dx + dy * dy || 1
          const t = Math.max(0, Math.min(1, ((x - sg.a[0]) * dx + (y - sg.a[1]) * dy) / l2))
          const d = Math.hypot(x - sg.a[0] - t * dx, y - sg.a[1] - t * dy)
          room = Math.min(room, d - sg.clear)
          if (d < best) [best, dir] = [d, Math.atan2(dy, dx)]
        }
        const half = Math.min(spacing * (0.3 + 0.12 * rnd(2)), room / 1.45)
        if (!(half >= 3)) continue
        if (bIdx.near(x, y).some((b) => x > b[0] - half && x < b[2] + half && y > b[1] - half && y < b[3] + half)) continue
        if (aIdx.near(x, y).some((a) => x >= a.box[0] && x <= a.box[2] && y >= a.box[1] && y <= a.box[3] && pointInRing([x, y], a.mr))) continue
        const hd = half * (0.8 + 0.4 * rnd(3))
        const [cx, cy] = [Math.cos(dir), Math.sin(dir)]
        const ring = [[-half, -hd], [half, -hd], [half, hd], [-half, hd], [-half, -hd]].map(([u, v]) => {
          const [lon, lat] = F.from([x + u * cx - v * cy, y + u * cy + v * cx])
          return [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]
        })
        const kind = lu.properties.kind
        const h = r1(kind === 'residential' ? 6.4 + rnd(4) * 6.4 : 8 + rnd(4) * 8)
        out.push({ type: 'Feature', properties: { h, min_h: 0, fill: true, lu: kind }, geometry: { type: 'Polygon', coordinates: [ring] } })
        used = true
      }
    }
    if (used) {
      stats.polygons++
      P.infill = true
    }
  }
  stats.blocks = out.length
  return { features: out, stats }
}

/** Per lit site: where it is and how tall it stands (for labels and camera framing). */
export function siteSummaries(sites, buildings) {
  return sites.map((s) => {
    const mine = buildings.filter((f) => f.properties.site_ids?.includes(s.id))
    const own = mine.filter((f) => f.properties.site_ids[0] === s.id)
    return {
      id: s.id,
      name: s.display_name || s.name,
      lon: s.lon,
      lat: s.lat,
      top_h: mine.length ? Math.max(...mine.map((f) => f.properties.h)) : 0,
      buildings: own.length,
      in_footprint: mine.length,
    }
  })
}

/** Compact writer: one feature per line (geo_detail.json is big; indenting every coordinate would double it). */
export function stringifyDetail(detail) {
  const lines = ['{']
  const keys = Object.keys(detail)
  keys.forEach((k, ki) => {
    const v = detail[k]
    const comma = ki < keys.length - 1 ? ',' : ''
    if (v?.type === 'FeatureCollection') {
      lines.push(`  ${JSON.stringify(k)}: {"type": "FeatureCollection", "features": [`)
      v.features.forEach((f, i) => lines.push(`    ${JSON.stringify(f)}${i < v.features.length - 1 ? ',' : ''}`))
      lines.push(`  ]}${comma}`)
    } else if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      lines.push(`  ${JSON.stringify(k)}: [`)
      v.forEach((x, i) => lines.push(`    ${JSON.stringify(x)}${i < v.length - 1 ? ',' : ''}`))
      lines.push(`  ]${comma}`)
    } else lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v, null, 1).replace(/\n\s*/g, ' ')}${comma}`)
  })
  lines.push('}')
  return lines.join('\n')
}
