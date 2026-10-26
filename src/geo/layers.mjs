// Base-map layers as simplified GeoJSON FeatureCollections: water, green, roads,
// boundary (the city's own admin boundary ONLY, never a national border) and other_lines.
import { cleanRing, clipLine, clipRing, lengthKm, mergeLines, ringAreaM2, ringCentroid, roundCoords, simplify } from './geom.mjs'
import { areaPolygons, displayName, elementLines, geomCoords, normName, osmId, qlRe } from './osm.mjs'
import { lineName, normColour, TRACK_ROLES } from './route.mjs'

const TOL_M = 12 // Douglas-Peucker tolerance for base layers
const PAD = 0.05 // degrees kept around the bbox (camera overscan)
const GREEN_MIN_HA = 5
const WATER_MIN_HA = 1.5
const GREEN_NAMES = /ridge|asola|bhatti|sanjay van|aravall?i|biodiversity|city forest|wildlife/i

const bboxStr = (b) => b.join(',')
const padBox = ([s, w, n, e]) => [w - PAD, s - PAD, e + PAD, n + PAD] // -> [w, s, e, n]
export const fc = (features) => ({ type: 'FeatureCollection', features })
const feature = (properties, geometry) => ({ type: 'Feature', properties, geometry })

// ---- queries -------------------------------------------------------------------------

export const waterQuery = (bbox) => {
  const bb = bboxStr(bbox)
  return `[out:json][timeout:180];
(
  way["waterway"~"^(river|canal)$"](${bb});
  way["natural"="water"](${bb})(if: length() > 400);
  way["waterway"="riverbank"](${bb});
  relation["natural"="water"](${bb});
  relation["waterway"="riverbank"](${bb});
);
out geom;`
}

export const greenQuery = (bbox) => {
  const bb = bboxStr(bbox)
  const big = '(if: length() > 800)'
  return `[out:json][timeout:180];
(
  way["leisure"~"^(park|nature_reserve|garden|golf_course)$"](${bb})${big};
  way["landuse"~"^(forest|recreation_ground)$"](${bb})${big};
  way["natural"~"^(wood|scrub|grassland)$"](${bb})${big};
  relation["leisure"~"^(park|nature_reserve|garden|golf_course)$"](${bb});
  relation["landuse"~"^(forest|recreation_ground)$"](${bb});
  relation["natural"~"^(wood|scrub|grassland)$"](${bb});
  nwr["boundary"="protected_area"]["protect_class"~"^[1-6]$"](${bb});
  nwr["name"~"${GREEN_NAMES.source}",i]["leisure"](${bb});
  nwr["name"~"${GREEN_NAMES.source}",i]["landuse"](${bb});
  nwr["name"~"${GREEN_NAMES.source}",i]["natural"](${bb});
);
out geom;`
}

export const roadsQuery = (bbox) => `[out:json][timeout:180];
way["highway"~"^(motorway|trunk|primary)$"](${bboxStr(bbox)});
out geom;`

/** Admin-boundary candidates for the city (tags only). Never admin_level 2. */
export const boundaryCandidatesQuery = (bbox, city) => {
  const bb = bboxStr(bbox)
  const sel = `relation["boundary"="administrative"]["admin_level"~"^([3-9]|10)$"]`
  return `[out:json][timeout:120];
(
  ${sel}["name"~"${qlRe(city)}",i](${bb});
  ${sel}["name:en"~"${qlRe(city)}",i](${bb});
);
out tags;`
}

/** The chosen boundary with geometry, plus ids of any of its ways that are also national borders. */
export const boundaryQuery = (id) => `[out:json][timeout:180];
relation(${id})->.city;
.city out geom;
way(r.city)->.cw;
rel(bw.cw)["boundary"="administrative"]["admin_level"~"^[12]$"]->.nat;
way(r.nat)->.natw;
way.cw.natw;
out ids;`

// ---- builders ------------------------------------------------------------------------

/** One Polygon / MultiPolygon feature per area element, clipped to box and simplified. */
function polygonFeatures(el, box, props, tolM = TOL_M) {
  const polys = []
  for (const [outer, ...holes] of areaPolygons(el)) {
    const clipped = clipRing(outer, box)
    const o = clipped && cleanRing(clipped, tolM)
    if (!o) continue
    polys.push([o, ...holes.map((r) => clipRing(r, box)).map((r) => r && cleanRing(r, tolM)).filter(Boolean)])
  }
  if (!polys.length) return []
  return [feature(props, polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys })]
}

const lineFeature = (props, lines) => {
  lines = lines.map((l) => roundCoords(simplify(l, TOL_M), 5)).filter((l) => l.length >= 2)
  if (!lines.length) return null
  return feature(props, lines.length === 1 ? { type: 'LineString', coordinates: lines[0] } : { type: 'MultiLineString', coordinates: lines })
}

/** Identity of an area by size + centroid, to drop the same area mapped as way and relation. */
const areaSig = (el, ha) => {
  const c = ringCentroid(areaPolygons(el)[0][0])
  return `${ha.toFixed(1)}|${c[0].toFixed(4)},${c[1].toFixed(4)}`
}

/** Sum of outer-ring areas in hectares. */
const areaHa = (el) => areaPolygons(el).reduce((s, p) => s + ringAreaM2(p[0]) - p.slice(1).reduce((h, r) => h + ringAreaM2(r), 0), 0) / 1e4

export function buildWater(doc, bbox) {
  const box = padBox(bbox)
  const rivers = new Map()
  const seen = new Set()
  const features = []
  for (const el of doc.elements) {
    const t = el.tags || {}
    if (el.type === 'way' && /^(river|canal)$/.test(t.waterway || '')) {
      const kind = t.waterway
      const k = `${kind}|${displayName(t)}`
      const lines = elementLines(el).flatMap((l) => clipLine(l, box))
      if (lines.length) rivers.set(k, [...(rivers.get(k) || []), ...lines])
      continue
    }
    const isRiver = t.water === 'river' || t.waterway === 'riverbank' || /yamuna|यमुना/i.test(t.name || '')
    if (!(t.natural === 'water' || t.waterway === 'riverbank')) continue
    const ha = areaHa(el)
    if (ha < (isRiver ? 0.3 : WATER_MIN_HA)) continue
    const sig = areaSig(el, ha) // same lake mapped twice (way + relation)
    if (seen.has(sig)) continue
    seen.add(sig)
    const kind = isRiver ? 'river_area' : t.water || 'water'
    features.push(...polygonFeatures(el, box, { kind, name: displayName(t) || null, area_ha: Math.round(ha * 10) / 10 }, 8))
  }
  for (const [k, lines] of rivers) {
    const [kind, name] = k.split('|')
    const merged = mergeLines(lines)
    const km = merged.reduce((s, l) => s + lengthKm(l), 0)
    if (kind === 'canal' && !name && km < 2) continue // unnamed canal stubs
    const f = lineFeature({ kind, name: name || null }, merged)
    if (f) features.push(f)
  }
  return fc(features)
}

function greenKind(t) {
  if (t.landuse === 'forest' || t.natural === 'wood') return 'forest'
  if (t.leisure === 'nature_reserve' || t.boundary === 'protected_area') return 'reserve'
  if (t.leisure === 'golf_course') return 'golf'
  if (t.natural === 'scrub' || t.natural === 'grassland') return 'scrub'
  return 'park'
}

export function buildGreen(doc, bbox) {
  const box = padBox(bbox)
  const seen = new Set()
  const features = []
  for (const el of doc.elements) {
    if (seen.has(osmId(el))) continue
    seen.add(osmId(el))
    const t = el.tags || {}
    if (/\bESZ\b|eco.?sensitive/i.test(`${t.name} ${t.protection_title}`)) continue // regulatory buffer, not green
    const named = GREEN_NAMES.test(t.name || '') || GREEN_NAMES.test(t['name:en'] || '')
    const ha = areaHa(el)
    if (ha < (named ? 0.5 : GREEN_MIN_HA)) continue
    const sig = areaSig(el, ha) // same area mapped twice (way + relation)
    if (seen.has(sig)) continue
    seen.add(sig)
    features.push(...polygonFeatures(el, box, { kind: greenKind(t), name: displayName(t) || null, area_ha: Math.round(ha) }))
  }
  // big areas first so renderers paint small parks on top
  return fc(features.sort((a, b) => b.properties.area_ha - a.properties.area_ha))
}

export function buildRoads(doc, bbox) {
  const box = padBox(bbox)
  const byClass = new Map()
  for (const el of doc.elements) {
    if (el.type !== 'way') continue
    const cls = el.tags?.highway
    const lines = elementLines(el).flatMap((l) => clipLine(l, box))
    if (lines.length) byClass.set(cls, [...(byClass.get(cls) || []), ...lines])
  }
  const features = []
  for (const cls of ['motorway', 'trunk', 'primary']) {
    for (const chain of mergeLines(byClass.get(cls) || [])) {
      const f = lineFeature({ highway: cls }, [chain])
      if (f) features.push(f)
    }
  }
  return fc(features)
}

/** Best admin relation for the city: exact name, then the larger (lower admin_level) unit. */
export function pickBoundary(doc, city) {
  const want = normName(city)
  const rank = (t) => {
    const names = [t.name, t['name:en'], t.official_name, t['official_name:en']].filter(Boolean).map(normName)
    const exact = names.includes(want) ? 2 : names.some((n) => ` ${n} `.includes(` ${want} `)) ? 1 : 0
    return exact * 100 - Number(t.admin_level || 99)
  }
  const rels = doc.elements.filter((e) => e.type === 'relation' && Number(e.tags?.admin_level) > 2 && rank(e.tags) >= 0)
  return rels.sort((a, b) => rank(b.tags) - rank(a.tags))[0] || null
}

export function buildBoundary(doc, log = () => {}) {
  const rel = doc.elements.find((e) => e.type === 'relation')
  if (!rel || Number(rel.tags?.admin_level) <= 2) return fc([])
  const national = new Set(doc.elements.filter((e) => e.type === 'way').map((e) => e.id))
  const props = { name: displayName(rel.tags), admin_level: Number(rel.tags.admin_level), osm_id: osmId(rel) }
  if (national.size) {
    // part of this boundary is also a national border: emit only the other segments, as lines
    log(`geo: boundary shares ${national.size} ways with a national border; those are left out`)
    const lines = rel.members.filter((m) => m.type === 'way' && m.role === 'outer' && !national.has(m.ref)).map((m) => geomCoords(m.geometry))
    const f = lineFeature(props, mergeLines(lines))
    return fc(f ? [f] : [])
  }
  const polys = areaPolygons(rel)
    .map((p) => p.map((r) => cleanRing(r, 15)).filter(Boolean))
    .filter((p) => p.length)
  if (!polys.length) return fc([])
  return fc([feature(props, polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys })])
}

/** Every line of the network (the ridden one flagged `current`), one MultiLineString each. */
export function buildOtherLines(transitDoc, current, bbox) {
  const box = padBox(bbox)
  const net = normName(current.network || '')
  const groups = new Map()
  for (const rel of transitDoc.elements) {
    const t = rel.tags || {}
    if (rel.type !== 'relation' || t.type !== 'route' || !rel.members) continue
    if (net && normName(t.network || '') !== net) continue
    const k = t.ref || lineName(t.name)
    const g = groups.get(k) || { ref: t.ref || null, name: lineName(t.name), color: normColour(t.colour), ways: new Map(), current: false }
    if (osmId(rel) === current.osm_id || (current.ref && t.ref === current.ref)) g.current = true
    g.color ||= normColour(t.colour)
    for (const m of rel.members) if (m.type === 'way' && TRACK_ROLES.has(m.role) && m.geometry) g.ways.set(m.ref, geomCoords(m.geometry))
    groups.set(k, g)
  }
  const features = []
  for (const g of groups.values()) {
    const lines = mergeLines([...g.ways.values()]).flatMap((l) => clipLine(l, box))
    const f = lineFeature({ ref: g.ref, name: g.name, color: g.color || '#888888', current: g.current }, lines)
    if (f) features.push(f)
  }
  return fc(features.sort((a, b) => Number(a.properties.current) - Number(b.properties.current)))
}
