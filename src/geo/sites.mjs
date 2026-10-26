// Heritage sites within ~2 km of the ridden span: historic/heritage-tagged features, listed
// monuments, notable places of worship and museums, with footprints where OSM maps them.
import { bboxOf, cleanRing, cumulativeKm, distM, pointInRing, project, ringAreaM2, ringCentroid, roundCoords, simplify } from './geom.mjs'
import { areaPolygons, displayName, elPoint, geomCoords, localName, normName, osmId, slug } from './osm.mjs'

export const RADIUS_KM = 2
const MAX_SITES = 300
const NAME_RE = 'Fort|Qila|Quila|Kila|Killa|Tomb|Maqbara|Makbara|Gumbad|Gumbaz|Baoli|Baori|Bawli|Kotla|Darwaza|Darwaja|Dargah|Mausoleum|Archaeological|Ruins|Minar|Haveli|City Wall'
const STRONG_NAME = new RegExp(`\\b(${NAME_RE})\\b`, 'i')
const GENERIC_NAME = /^(tomb|tombs|grave|graveyard|cemetery|dome|gumti|gumbad|mosque|masjid|temple|mandir|church|gate|ruins|well|baoli|dargah|monument|memorial|statue|unidentified tomb|unknown tomb)$/
const NON_HERITAGE_BUILDING = /^(retail|commercial|residential|apartments|office|industrial|house|hotel|school|hospital|university|college|dormitory|warehouse|garage|parking)$/
const NON_HERITAGE_LEISURE = /^(sports_centre|stadium|pitch|golf_course|playground|fitness_centre|track|swimming_pool|sports_hall)$/
const MINOR_HISTORIC = /^(memorial|milestone|boundary_stone|wayside_shrine|wayside_cross|cannon|tank|aircraft|locomotive|railway_car|vehicle|plaque|bench|stone|district|no)$/
const MAJOR_HISTORIC = /^(fort|castle|archaeological_site|monument|tomb|city_gate|citywalls|ruins|palace|mosque|temple|church|building|manor|tower|aqueduct|observatory|baoli|stepwell)$/
const KEEP_TAG = /^(historic|historic:.+|heritage|heritage:.+|protect_class|ref:asi|tourism|building|amenity|religion|denomination|ruins|castle_type|tomb|memorial|start_date|construction_date|architect|wikipedia|name:en|alt_name|old_name|official_name|inscription|archaeological_site|site_type|leisure|boundary|whc|unesco)$/

const r5 = (x) => Math.round(x * 1e5) / 1e5
const r2 = (x) => Math.round(x * 100) / 100

function excluded(t) {
  if (t.shop || t.office || t.craft || t.highway || t.railway || t.public_transport || t.entrance || t.place || t.route) return true
  if (/^(route|route_master|network|public_transport)$/.test(t.type || '')) return true
  if (t.barrier === 'gate' || (t.boundary && t.boundary !== 'protected_area')) return true
  const heritage = t.historic || t.heritage
  if (!heritage && (NON_HERITAGE_LEISURE.test(t.leisure || '') || t.tourism === 'artwork')) return true
  if (!heritage && !t.wikidata && NON_HERITAGE_BUILDING.test(t.building || '')) return true
  if (t.amenity && t.amenity !== 'place_of_worship' && !t.historic && !t.heritage) return true
  if (/^(hotel|hostel|guest_house|apartment|information)$/.test(t.tourism || '')) return true
  return /^(residential|commercial|retail|industrial)$/.test(t.landuse || '')
}

export function sitesQuery(lineCoords) {
  const [w, s, e, n] = bboxOf(lineCoords)
  const dy = (RADIUS_KM + 0.2) / 110.574
  const dx = dy / Math.cos((((s + n) / 2) * Math.PI) / 180)
  const bb = [s - dy, w - dx, n + dy, e + dx].map((v) => v.toFixed(4)).join(',')
  return `[out:json][timeout:180];
(
  nwr["historic"](${bb});
  nwr["heritage"](${bb});
  nwr["castle_type"](${bb});
  nwr["tomb"](${bb});
  nwr["boundary"="protected_area"]["protect_class"="22"](${bb});
  nwr["tourism"~"^(attraction|museum)$"]["wikidata"](${bb});
  nwr["amenity"="place_of_worship"]["wikidata"](${bb});
  nwr["building"~"^(mosque|temple|church|cathedral|tomb|fort|castle|palace|ruins|shrine|gurudwara|gurdwara|monastery|synagogue)$"]["wikidata"](${bb});
  nwr["name"~"${NAME_RE}",i](${bb});
)->.all;
node.all;
out;
way.all;
out geom;
rel.all["type"~"^(multipolygon|boundary)$"];
out geom;
rel.all["type"!~"^(multipolygon|boundary)$"];
out center tags;`
}

/** Is this element a heritage site worth a map footprint? */
function qualifies(el, t, name) {
  if (excluded(t) || !name) return false
  if (t.wikidata) return true
  if (GENERIC_NAME.test(normName(name))) return false
  if (t.heritage || t.castle_type || t.tomb || t.protect_class === '22' || t.ruins === 'yes') return true
  if (t.historic === 'yes') return el.type !== 'node'
  if (t.historic && !MINOR_HISTORIC.test(t.historic)) return true
  const placeLike = t.building || t.ruins || /^(attraction|museum)$/.test(t.tourism || '') || /^(park|garden)$/.test(t.leisure || '') || t.amenity === 'place_of_worship'
  return STRONG_NAME.test(name) && Boolean(placeLike)
}

function toCandidate(el, lineCoords, cum, lang) {
  const t = el.tags || {}
  const name = displayName(t)
  if (!qualifies(el, t, name)) return null
  let polygon = null, line = null, point = elPoint(el), area = 0
  const polys = el.type === 'way' || el.type === 'relation' ? areaPolygons(el) : []
  if (polys.length) {
    const outer = polys[0][0]
    area = ringAreaM2(outer)
    polygon = cleanRing(outer, Math.min(10, Math.max(1.5, Math.sqrt(area) / 80)))
    point = ringCentroid(outer)
  } else if (el.type === 'way') {
    const c = geomCoords(el.geometry)
    if (c.length >= 2) {
      line = roundCoords(simplify(c, 3), 5)
      point = c[Math.floor(c.length / 2)]
    }
  }
  if (!point) return null
  // distance to the ridden line: nearest of the label point and the outline vertices
  const outline = polygon || line || []
  const step = Math.max(1, Math.floor(outline.length / 24))
  const pr = project(lineCoords, point, cum)
  let dM = pr.distM
  for (let i = 0; i < outline.length && dM > 0; i += step) dM = Math.min(dM, project(lineCoords, outline[i], cum).distM)
  if (dM > RADIUS_KM * 1000) return null
  const tags = Object.fromEntries(Object.entries(t).filter(([k]) => KEEP_TAG.test(k)))
  const major = MAJOR_HISTORIC.test(t.historic || '') || t.castle_type || t.tomb
  const score = (t.wikidata ? 3 : 0) + (t.heritage ? 2 : 0) + (major ? 2 : 0) + (polygon ? 1 : 0) + (t.wikipedia ? 1 : 0) - dM / 2000
  return {
    name,
    name_local: localName(t, lang),
    point,
    polygon,
    line,
    area,
    wikidata: t.wikidata || null,
    tags,
    osm_id: osmId(el),
    km: pr.km,
    distM: dM,
    score,
    rank: (t.historic || t.castle_type || t.tomb ? 2 : 0) + (polygon ? 1 : 0),
  }
}

/** Fold b into a (a keeps its geometry unless b's is better). */
function merge(a, b) {
  const [base, other] = b.rank > a.rank || (b.rank === a.rank && b.area > a.area) ? [b, a] : [a, b]
  return {
    ...base,
    wikidata: base.wikidata || other.wikidata,
    name_local: base.name_local || other.name_local,
    tags: { ...other.tags, ...base.tags },
    distM: Math.min(base.distM, other.distM),
    score: Math.max(base.score, other.score),
  }
}

const near = (a, b) => {
  const inside = (x, y) => x.polygon && (pointInRing(y.point, x.polygon) || project(x.polygon, y.point).distM < 150)
  return inside(a, b) || inside(b, a) || distM(a.point, b.point) < 300
}

export function buildSites(doc, lineCoords, { lang } = {}) {
  const cum = cumulativeKm(lineCoords)
  const seen = new Set()
  let list = []
  for (const el of doc.elements) {
    if (seen.has(osmId(el))) continue
    seen.add(osmId(el))
    const c = toCandidate(el, lineCoords, cum, lang)
    if (c) list.push(c)
  }
  // de-duplicate: same Wikidata item, or same name close together
  const byQ = new Map()
  const rest = []
  for (const c of list) {
    if (!c.wikidata) rest.push(c)
    else byQ.set(c.wikidata, byQ.has(c.wikidata) ? merge(byQ.get(c.wikidata), c) : c)
  }
  list = []
  for (const c of [...byQ.values(), ...rest]) {
    const i = list.findIndex((x) => normName(x.name) === normName(c.name) && near(x, c))
    if (i >= 0) list[i] = merge(list[i], c)
    else list.push(c)
  }
  list = list.sort((a, b) => b.score - a.score).slice(0, MAX_SITES)
  // stable ids: the higher-scoring site gets the plain slug
  const used = new Map()
  const sites = list.map((c) => {
    const base = `site_${slug(c.name)}`
    const n = (used.get(base) || 0) + 1
    used.set(base, n)
    return {
      id: n === 1 ? base : `${base}_${n}`,
      name: c.name,
      name_local: c.name_local,
      lon: r5(c.point[0]),
      lat: r5(c.point[1]),
      polygon: c.polygon,
      line: c.line,
      wikidata: c.wikidata,
      tags: c.tags,
      osm_id: c.osm_id,
      km: r2(c.km),
      dist_km: r2(c.distM / 1000),
    }
  })
  return sites.sort((a, b) => a.km - b.km || a.dist_km - b.dist_km)
}
