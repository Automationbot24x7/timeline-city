// Site selection: significance score, link to geo.json footprints, station assignment
// (nearest, or the station named after the site), per-station ranking with de-duplication.
import { haversineKm, pointInRing } from '../geo/geom.mjs'
import { nameSimilarity, normName, skeleton, slug } from '../geo/osm.mjs'

const GEO_HERITAGE_KEYS = /^(historic|heritage|castle_type|tomb|ruins|ref:asi|whc|unesco)$/
const STOP = new Set(['of', 'the', 'and', 'ka', 'ki', 'ke', 'e', 'i'])
const MATCH_M = 200

/** Does an OSM site from geo.json carry a heritage tag (not just tourism=museum)? */
export const geoHeritage = (g) => Object.keys(g?.tags || {}).some((k) => GEO_HERITAGE_KEYS.test(k) && g.tags[k] !== 'no')

const words = (s) =>
  normName(s)
    .split(' ')
    .filter((w) => w && !STOP.has(w))
    .map((w) => skeleton(w.length > 4 ? w.replace(/s$/, '') : w)) // "Safdarjungs" (possessive) -> safdarjung

/**
 * Name match tolerant of transliteration, possessives, joined words and extra words:
 * "Tomb of Mirza Najaf Khan" ~ "Tomb of Najaf Khan", "Tomb of Safdar Jang" ~ "Safdarjung's Tomb".
 */
export function nameMatch(a, b) {
  const sim = nameSimilarity(a, b)
  if (sim >= 0.75) return sim
  const wa = words(a), wb = words(b)
  const [small, big] = wa.length <= wb.length ? [wa, wb] : [wb, wa]
  const joined = big.join('')
  return small.length >= 2 && small.every((w) => big.includes(w) || (w.length >= 4 && joined.includes(w))) ? 0.8 : 0
}

const near = (s, g) => haversineKm(s.coord, [g.lon, g.lat]) * 1000 <= MATCH_M || (g.polygon?.length > 3 && pointInRing(s.coord, g.polygon))

/** Is the site named after the station ("Hauz Khas Complex" / Hauz Khas, "Qutb Minar" / Qutab Minar)? */
export function namedAfter(label, stationName) {
  const st = words(stationName).join(' ')
  const lb = words(label).join(' ')
  return st.length >= 3 && (lb === st || lb.startsWith(`${st} `))
}

/** Significance: global reach (sitelinks), protection, a known date, an English article, closeness. */
export function score(s) {
  let v = 2 * Math.log1p(s.sitelinks)
  if (s.world_heritage) v += 4
  else if (s.heritage.length) v += 2.5
  if (s.date) v += 1.5
  if (s.enwiki) v += 1
  if (s.named_after) v += 2
  if (!s.kinds.length && !s.heritage.length && !geoHeritage(s.geo)) v -= 4 // museums etc. only fill gaps
  v -= Math.max(0, s.dist_km - 0.8)
  return Math.round(v * 100) / 100
}

/**
 * Attach geo.json sites: same Wikidata id first, then (for OSM sites without a usable id, e.g.
 * one that links the buried person) the best name match within 200 m. Each geo site is used once.
 * Matched sites take the OSM coordinates, so labels sit on the drawn footprints.
 */
export function matchGeo(sites, geoSites) {
  const valid = new Set(sites.map((s) => s.qid))
  const byQid = new Map(geoSites.filter((g) => g.wikidata).map((g) => [g.wikidata, g]))
  const used = new Set()
  for (const s of sites) {
    const g = byQid.get(s.qid)
    if (g && !used.has(g.id)) (s.geo = g), used.add(g.id)
  }
  for (const s of sites) {
    if (s.geo || !s.coord) continue
    let best = null
    let bestSim = 0
    for (const g of geoSites) {
      if (used.has(g.id) || (g.wikidata && valid.has(g.wikidata))) continue
      if (!near(s, g)) continue
      const sim = Math.max(nameMatch(s.label, g.name), ...(g.tags?.['name:en'] ? [nameMatch(s.label, g.tags['name:en'])] : []))
      if (sim >= 0.75 && sim > bestSim) (best = g), (bestSim = sim)
    }
    if (best) (s.geo = best), used.add(best.id)
  }
  for (const s of sites) if (s.geo) s.coord = [s.geo.lon, s.geo.lat]
}

/**
 * Station per site: the station named after it when within maxKm, else the nearest.
 * also_near = other stations within nearKm.
 */
export function assign(sites, stations, nearKm, maxKm) {
  for (const s of sites) {
    const d = stations.map((st) => ({ st, km: haversineKm(s.coord, [st.lon, st.lat]) })).sort((a, b) => a.km - b.km)
    const named = d.find((x) => x.km <= maxKm && namedAfter(s.label, x.st.name))
    const pick = named || d[0]
    s.named_after = named ? named.st.id : null
    s.station_id = pick.st.id
    s.dist_km = Math.round(pick.km * 100) / 100
    s.also_near = d.filter((x) => x !== pick && x.km <= nearKm).map((x) => x.st.id)
  }
}

/** Unique ids: the geo.json id when linked (so the renderer can draw the footprint), else site_<slug>. */
export function assignIds(sites, geoSites) {
  const taken = new Set(geoSites.map((g) => g.id))
  for (const s of sites) {
    if (s.geo) {
      s.id = s.geo.id
      continue
    }
    let id = `site_${slug(s.label)}`
    if (taken.has(id)) id = `${id}_${s.qid.toLowerCase()}`
    taken.add(id)
    s.id = id
  }
}

/**
 * Per station: drop duplicates (same English article), demote parts of a stronger site at the
 * same station (Red Fort's halls under Red Fort), keep the top `perStation` by score.
 */
export function rank(sites, stations, perStation) {
  const byArticle = new Map()
  for (const s of sites) {
    if (!s.enwiki) continue
    const o = byArticle.get(s.enwiki)
    if (!o || s.score > o.score) byArticle.set(s.enwiki, s)
  }
  const pool = sites.filter((s) => !s.enwiki || byArticle.get(s.enwiki) === s)
  const byQid = new Map(pool.map((s) => [s.qid, s]))
  for (const s of pool) {
    const parent = s.partOf.map((p) => byQid.get(p.qid)).find((p) => p && p.station_id === s.station_id && p.score >= s.score)
    if (parent) s.score = Math.round((s.score - 2) * 100) / 100
  }
  const out = new Map(stations.map((st) => [st.id, []]))
  for (const s of pool) out.get(s.station_id)?.push(s)
  for (const [k, list] of out) out.set(k, list.sort((a, b) => b.score - a.score).slice(0, perStation))
  return out
}
