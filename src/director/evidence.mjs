// Evidence for the director: id indexes over geo.json + ground.json, and the compact text packs the
// prompts show (ride, curated facts first with narration_line + caveats, Wikidata facts, excerpts).
const uniq = (a) => [...new Set(a.filter(Boolean))]
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const SKIP_SITE = /tussaud|assassination|^mahatma gandhi$/i // wax figures of living people, a murder site, a statue labelled as a person

export function loadEvidence(ctx) {
  const geo = ctx.read('geo.json')
  const ground = ctx.read('ground.json')
  const stations = geo.stations
  const stationById = new Map(stations.map((s) => [s.id, s]))
  const geoSites = new Map((geo.sites || []).map((s) => [s.id, s]))
  const groundSites = new Map()
  for (const st of ground.stations || []) for (const s of st.sites || []) groundSites.set(s.id, { ...s, station_id: st.station_id })
  const sources = new Map((ground.sources || []).map((s) => [s.id, s]))
  const facts = new Map((ground.facts || []).map((f) => [f.id, f]))
  const ev = { geo, ground, stations, stationById, geoSites, groundSites, sources, facts }
  sources.set(RIDE_SOURCE, rideSource(ev))
  return ev
}

/** The map itself as evidence: station order, names and site distances from geo.json/ground.json (OSM, Wikidata). */
export const RIDE_SOURCE = 'osm_ride'
function rideSource(ev) {
  const gst = new Map((ev.ground.stations || []).map((s) => [s.station_id, s]))
  const L = ev.geo.line || {}
  const parts = [`The ${L.name || 'line'} as mapped in OpenStreetMap, ridden in this order (km along the line): ${ev.stations.map((s) => `${s.name}${s.alt_names?.length ? ` (formerly ${s.alt_names.join('/')})` : ''} ${s.km}`).join('; ')}. Ride length ${L.length_km} km.`]
  for (const s of ev.stations) {
    const sites = (gst.get(s.id)?.sites || []).map((x) => `${x.label} ${x.dist_km} km`)
    if (sites.length) parts.push(`Near ${s.name} station (straight-line distance): ${sites.join(', ')}.`)
  }
  return { id: RIDE_SOURCE, url: null, title: 'The ride as mapped', publisher: 'OpenStreetMap', excerpt: parts.join(' ') }
}

/** Any site id (geo or ground) -> the geo.json id the renderer can draw, or null. */
export function mapSiteId(ev, id) {
  if (ev.geoSites.has(id)) return id
  const g = ev.groundSites.get(id)
  return g?.geo_site_id && ev.geoSites.has(g.geo_site_id) ? g.geo_site_id : null
}

/** Resolve a station id or name the model wrote to a geo.json station id. */
export function resolveStation(ev, ref) {
  if (!ref) return null
  if (ev.stationById.has(ref)) return ref
  const key = String(ref).toLowerCase().replace(/^st_/, '').replace(/[^a-z0-9]+/g, '')
  const hit = ev.stations.find((s) => [s.id.replace(/^st_/, ''), s.name, ...(s.alt_names || [])].some((n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '') === key))
  return hit?.id || null
}

function nearestStation(ev, site) {
  if (site.km === undefined) return null
  let best = null
  for (const s of ev.stations) if (!best || Math.abs(s.km - site.km) < Math.abs(best.km - site.km)) best = s
  return best
}

/** The ride: stations in order with their curated-ground sites (map ids) and other mapped footprints. */
export function ridePack(ev) {
  const extra = new Map()
  const listed = new Set()
  for (const st of ev.ground.stations || []) for (const s of st.sites || []) listed.add(s.geo_site_id || s.id)
  for (const s of ev.geo.sites || []) {
    if (listed.has(s.id) || SKIP_SITE.test(s.name || '') || (s.dist_km ?? 0) > 1.6) continue
    const st = nearestStation(ev, s)
    if (st) extra.set(st.id, [...(extra.get(st.id) || []), s])
  }
  const gst = new Map((ev.ground.stations || []).map((s) => [s.station_id, s]))
  const lines = []
  for (const st of ev.stations) {
    const g = gst.get(st.id) || {}
    const alt = st.alt_names?.length ? `, formerly/also ${st.alt_names.join(' / ')}` : ''
    lines.push(`- ${st.id} | ${st.name} (${st.name_local || ''}${alt}) | km ${st.km}${g.namesake ? ` | named after: ${g.namesake.label} [${g.namesake.source_id}]` : ''}`)
    for (const s of g.sites || []) {
      const mapId = s.geo_site_id && ev.geoSites.has(s.geo_site_id) ? s.geo_site_id : null
      const year = s.inception_text ? `, ${s.date_dropped ? 'date dropped' : `dated ${s.inception_text}${s.date_in_wikipedia === false ? ' (Wikidata only; the Wikipedia excerpt does not give this date)' : ''}`}` : ''
      lines.push(`    site ${mapId || s.id}${mapId ? '' : ' (no map footprint)'}: ${s.label}${year}, ${s.dist_km} km from the station${s.heritage ? `, ${s.heritage}` : ''} [${(s.source_ids || []).join(', ')}]`)
    }
    if (g.nearby_site_ids?.length) lines.push(`    also near: ${g.nearby_site_ids.map((id) => mapSiteId(ev, id) || id).join(', ')}`)
    const more = (extra.get(st.id) || []).sort((a, b) => (a.dist_km ?? 9) - (b.dist_km ?? 9)).slice(0, 8)
    if (more.length) lines.push(`    other mapped footprints (map only, no facts): ${more.map((s) => `${s.id} (${s.name})`).join(', ')}`)
  }
  return lines.join('\n')
}

/** Curated, adversarially checked facts first (with narration_line and caveats), then Wikidata facts. */
export function factsPack(ev, { only } = {}) {
  const keep = only ? new Set(only) : null
  const curated = []
  const other = []
  for (const f of ev.facts.values()) {
    if (keep && !keep.has(f.id)) continue
    ;(f.origin === 'facts_file' ? curated : other).push(f)
  }
  const byTopic = new Map()
  for (const f of curated) byTopic.set(f.topic || 'other', [...(byTopic.get(f.topic || 'other') || []), f])
  const out = []
  if (curated.length) {
    out.push('### Curated facts (human-researched and adversarially fact-checked: PREFER THESE; a caveat overrides everything)')
    for (const [topic, list] of byTopic) {
      out.push(`#### ${topic}`)
      for (const f of list) {
        out.push(`- ${f.id}${f.year != null ? ` (${f.year})` : ''} [${f.source_ids.join(', ')}]: ${one(f.claim)}`)
        if (f.narration_line) out.push(`    narration_line: "${one(f.narration_line)}"`)
        if (f.caveats) out.push(`    caveats: ${one(f.caveats)}`)
      }
    }
  }
  if (other.length) {
    out.push('### Wikidata site facts (machine-gathered; weaker; use for dates/designations only when a curated fact does not cover it)')
    for (const f of other) {
      const flag = f.corroborated === false ? ' (date not in the Wikipedia excerpt)' : ''
      out.push(`- ${f.id} [${f.source_ids.join(', ')}]${f.site_id ? ` site ${f.site_id}` : ''}${f.station_id ? ` @${f.station_id}` : ''}: ${one(f.claim)}${flag}`)
    }
  }
  return out.join('\n')
}

/** Source excerpts, deduplicated, as "[src_x] publisher: title\n  excerpt". */
export function excerptPack(ev, ids, { maxChars = 1500 } = {}) {
  return uniq(ids)
    .map((id) => ev.sources.get(id))
    .filter(Boolean)
    .map((s) => `[${s.id}] ${s.publisher}: ${one(s.title)}\n  ${one(s.excerpt).slice(0, maxChars)}`)
    .join('\n')
}

/** Sources behind a set of facts and the sites/namesakes at a set of stations. */
export function sourcesFor(ev, { factIds = [], stationIds = [], siteIds = [] } = {}) {
  const ids = []
  for (const id of factIds) ids.push(...(ev.facts.get(id)?.source_ids || []))
  const st = new Set(stationIds)
  for (const g of ev.ground.stations || []) {
    if (!st.has(g.station_id)) continue
    if (g.namesake?.source_id) ids.push(g.namesake.source_id)
    for (const s of g.sites || []) ids.push(...(s.source_ids || []))
  }
  for (const id of siteIds) {
    const g = ev.groundSites.get(id) || [...ev.groundSites.values()].find((s) => s.geo_site_id === id)
    if (g) ids.push(...(g.source_ids || []))
  }
  return uniq(ids).filter((id) => ev.sources.has(id))
}

/** Caveats of the curated facts that share a source with these ids or are named directly. */
export function caveatsFor(ev, { factIds = [], sourceIds = [] } = {}) {
  const src = new Set(sourceIds)
  const ids = new Set(factIds)
  const out = []
  for (const f of ev.facts.values()) {
    if (f.origin !== 'facts_file' || !f.caveats) continue
    if (ids.has(f.id) || f.source_ids.some((s) => src.has(s))) out.push(`- ${f.id}: ${one(f.caveats)}`)
  }
  return out.join('\n')
}
