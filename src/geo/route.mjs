// The ridden line: find the configured route relation, stitch ONE direction into a single
// polyline, trim it to `from` -> `to` and list the stations on that span in ride order.
import { cumulativeKm, distM, lengthKm, project, roundCoords, simplify, sliceLine, stitch } from './geom.mjs'
import { cleanName, displayName, elPoint, geomCoords, localName, nameScore, namesOf, normName, osmId, qlRe, qlStr, slug } from './osm.mjs'

export const MODES = 'subway|light_rail|train|monorail|tram'
const MODE_RE = new RegExp(`^(${MODES})$`)
export const TRACK_ROLES = new Set(['', 'forward', 'backward', 'route', 'main'])
const STOP_ROLE = /^(stop|stop_entry_only|stop_exit_only|station)$/
const STOP_MATCH_M = 400 // stop position -> station node search radius
const ON_LINE_M = 300 // a listed stop must be this close to the stitched line
const NEAR_LINE_M = 200 // relation without stops: stations this close to the line
const GAP_M = 50 // bridge gaps between route ways up to this size

const r5 = (x) => Math.round(x * 1e5) / 1e5
const r3 = (x) => Math.round(x * 1e3) / 1e3
export const isStation = (tags = {}) => /^(station|halt)$/.test(tags.railway || '') || tags.public_transport === 'station'

/** Route name without "(A → B)" / ": A → B" direction suffixes. */
export const lineName = (name = '') => name.replace(/\s*\(.*\)\s*$/, '').replace(/\s*:\s.*$/, '').trim()

export function normColour(c) {
  if (!c) return null
  const s = String(c).trim()
  return /^#?[0-9a-f]{6}$/i.test(s) ? `#${s.replace('#', '').toUpperCase()}` : s
}

/** Route relations (with member geometry), their member nodes, and every station in bbox. */
export function transitQuery({ bbox, line }) {
  const bb = bbox.join(',')
  const base = `relation["type"="route"]["route"~"^(${MODES})$"]`
  const clauses = []
  if (line.network) clauses.push(`${base}["network"~"^${qlRe(line.network)}$",i](${bb});`)
  if (line.name) clauses.push(`${base}["name"~"${qlRe(line.name)}",i](${bb});`)
  if (line.ref && !line.network) clauses.push(`${base}["ref"="${qlStr(line.ref)}"](${bb});`)
  return [
    '[out:json][timeout:180];',
    `(\n  ${clauses.join('\n  ')}\n)->.routes;`,
    '.routes out geom;',
    'node(r.routes)->.stops;',
    '.stops out;',
    '(',
    `  node["railway"~"^(station|halt)$"](${bb});`,
    `  way["railway"="station"](${bb});`,
    `  nwr["public_transport"="station"](${bb});`,
    ');',
    'out center;',
  ].join('\n')
}

/** How well a route relation matches project.yaml `line` (0 = not this line). */
export function lineScore(t = {}, line) {
  if (t.type !== 'route' || !MODE_RE.test(t.route || '')) return 0
  let s = 0
  if (line.ref != null && t.ref) {
    if (!String(t.ref).split(';').map((x) => x.trim()).includes(String(line.ref))) return 0
    s += 4
  }
  const want = normName(line.name || '')
  if (want && [t.name, t['name:en'], t.short_name].filter(Boolean).some((n) => ` ${normName(n)} `.includes(` ${want} `))) s += 3
  if (s < 3) return 0
  if (line.network && normName(t.network || '') === normName(line.network)) s += 2
  return s
}

function matchStation(pos, tags, stations) {
  let best = null
  for (const st of stations) {
    const p = elPoint(st)
    if (!p) continue
    const d = distM(pos, p)
    if (d > STOP_MATCH_M) continue
    const sim = tags.name ? nameScore(tags.name, st.tags) : 0
    if (sim < 0.7 && d > 150) continue
    const rank = (sim >= 0.7 ? 1000 * sim : 0) - d + (st.tags.railway === 'station' ? 30 : 0)
    if (!best || rank > best.rank) best = { st, rank }
  }
  return best?.st || null
}

/** Stitched geometry + ordered, de-duplicated stops (each mapped to its station element). */
function traceRelation(rel, nodes, stations) {
  const seen = new Set()
  const ways = rel.members
    .filter((m) => m.type === 'way' && TRACK_ROLES.has(m.role) && !seen.has(m.ref) && seen.add(m.ref))
    .map((m) => geomCoords(m.geometry))
  const { coords, gaps } = stitch(ways, GAP_M)
  const stops = []
  const push = (key, pos, el, stopTags) => {
    if (!stops.some((s) => s.key === key)) stops.push({ key, pos, el, stopTags })
  }
  for (const m of rel.members) {
    if (m.type !== 'node' || m.lat == null) continue
    const node = nodes.get(m.ref) || { type: 'node', id: m.ref, lat: m.lat, lon: m.lon, tags: {} }
    const tags = node.tags || {}
    if (!STOP_ROLE.test(m.role) && !(m.role === '' && isStation(tags))) continue
    const pos = [m.lon, m.lat]
    const st = isStation(tags) ? node : matchStation(pos, tags, stations) || node
    push(osmId(st), pos, st, tags)
  }
  if (!stops.length && coords.length > 1) {
    // no stop members: stations near the line, in line order, one per name
    const cum = cumulativeKm(coords)
    const near = new Map()
    const t = rel.tags
    const sameSystem = (s) =>
      (t.network && normName(s.network || '') === normName(t.network)) || s.station === t.route || (t.route === 'subway' && s.subway === 'yes')
    const own = stations.filter((st) => sameSystem(st.tags))
    for (const st of own.length ? own : stations) {
      const p = elPoint(st)
      const pr = p && project(coords, p, cum)
      if (!pr || pr.distM > NEAR_LINE_M) continue
      const k = st.tags.wikidata || normName(displayName(st.tags)) // one per interchange complex
      if (!near.has(k) || near.get(k).pr.distM > pr.distM) near.set(k, { st, p, pr })
    }
    for (const { st, p } of [...near.values()].sort((a, b) => a.pr.km - b.pr.km)) push(osmId(st), p, st, st.tags)
  }
  return { rel, coords, gaps, stops }
}

function findStop(stops, wanted) {
  let best = null
  stops.forEach((s, i) => {
    const sc = Math.max(nameScore(wanted, s.el.tags || {}), nameScore(wanted, s.stopTags || {}))
    if (sc >= 0.7 && (!best || sc > best.sc)) best = { i, sc }
  })
  return best
}

/**
 * From an Overpass transit response: { line, stations, relation, gaps, warnings }.
 * `lang` picks name:<lang> as each station's local-script name.
 */
export function buildRoute(doc, config, { lang, log = () => {} } = {}) {
  const want = config.line || {}
  if (!want.from || !want.to) throw new Error('project.yaml line.from and line.to are required')
  const nodes = new Map()
  const stations = []
  const routes = []
  for (const el of doc.elements) {
    if (el.type === 'node') nodes.set(el.id, { ...nodes.get(el.id), ...el })
    if (el.type === 'relation' && el.tags?.type === 'route') routes.push(el)
    if (el.tags && isStation(el.tags) && elPoint(el)) stations.push(el)
  }
  const scored = routes.map((r) => ({ r, s: lineScore(r.tags, want) })).filter((c) => c.s > 0)
  if (!scored.length) throw new Error(`No OSM route relation matches line ${JSON.stringify(want)} in bbox`)
  const top = Math.max(...scored.map((c) => c.s))
  const candidates = scored.filter((c) => c.s === top).map((c) => c.r)
  log(`geo: line candidates ${candidates.map((r) => `relation/${r.id} "${r.tags.name}"`).join(', ')}`)

  const options = []
  for (const rel of candidates) {
    const o = traceRelation(rel, nodes, stations)
    if (o.coords.length < 2) continue
    const f = findStop(o.stops, want.from), t = findStop(o.stops, want.to)
    if (!f || !t || f.i === t.i) {
      log(`geo: relation/${rel.id}: ${!f ? `"${want.from}"` : `"${want.to}"`} not found among ${o.stops.length} stops`)
      continue
    }
    const cum = cumulativeKm(o.coords)
    const pf = project(o.coords, o.stops[f.i].pos, cum), pt = project(o.coords, o.stops[t.i].pos, cum)
    const score = f.sc + t.sc + (f.i < t.i) + (pf.km < pt.km) - 0.1 * o.gaps.length - (pf.distM + pt.distM) / 1000
    options.push({ ...o, f, t, score })
  }
  if (!options.length) throw new Error(`Could not find both "${want.from}" and "${want.to}" on line ${want.name || want.ref}`)
  const best = options.sort((a, b) => b.score - a.score)[0]
  const { rel, stops } = best
  const warnings = []
  if (best.gaps.length) warnings.push(`relation/${rel.id}: bridged gaps of ${best.gaps.join(', ')} m between route ways`)

  // orient from -> to, then trim to the ridden span
  let coords = best.coords, cum = cumulativeKm(coords)
  const fromPos = stops[best.f.i].pos, toPos = stops[best.t.i].pos
  let pf = project(coords, fromPos, cum), pt = project(coords, toPos, cum)
  if (pf.km > pt.km) {
    coords = coords.slice().reverse()
    cum = cumulativeKm(coords)
    pf = project(coords, fromPos, cum)
    pt = project(coords, toPos, cum)
  }
  const lineCoords = roundCoords(simplify(sliceLine(coords, cum, pf.km, pt.km), 1), 5)
  const lineCum = cumulativeKm(lineCoords)
  const length = lineCum.at(-1)

  const out = []
  stops.forEach((s, i) => {
    const full = project(coords, s.pos, cum)
    if (full.distM > ON_LINE_M || full.km < pf.km - 0.05 || full.km > pt.km + 0.05) return
    const tags = s.el.tags || {}
    const name = displayName(tags) || displayName(s.stopTags) || `Station ${s.el.id}`
    const p = elPoint(s.el) || s.pos
    const on = project(lineCoords, s.pos, lineCum)
    const km = i === best.f.i ? 0 : i === best.t.i ? length : Math.min(length, Math.max(0, on.km))
    const onLine = i === best.f.i ? lineCoords[0] : i === best.t.i ? lineCoords.at(-1) : on.point
    out.push({
      id: `st_${slug(name)}`,
      name,
      name_local: localName(tags, lang) || localName(s.stopTags, lang),
      lon: r5(p[0]),
      lat: r5(p[1]),
      km: r3(km),
      wikidata: tags.wikidata || s.stopTags?.wikidata || null,
      osm_id: osmId(s.el),
      wikipedia: tags.wikipedia || null,
      alt_names: [...new Set(namesOf(tags).map(cleanName))].filter((n) => n !== name),
      on_line: [r5(onLine[0]), r5(onLine[1])],
    })
  })
  out.sort((a, b) => a.km - b.km)
  const stationsOut = out.filter((s, i) => out.findIndex((x) => x.id === s.id) === i)
  for (let i = 1; i < stationsOut.length; i++) {
    if (stationsOut[i].km - stationsOut[i - 1].km < 0.2) warnings.push(`stations ${stationsOut[i - 1].name} and ${stationsOut[i].name} are only ${Math.round((stationsOut[i].km - stationsOut[i - 1].km) * 1000)} m apart`)
  }

  return {
    relation: rel,
    line: {
      name: want.name || lineName(rel.tags.name),
      ref: rel.tags.ref ?? want.ref ?? null,
      color: normColour(rel.tags.colour) || '#FFD400',
      coords: lineCoords,
      length_km: r3(lengthKm(lineCoords)),
      network: rel.tags.network || want.network || null,
      osm_id: osmId(rel),
    },
    stations: stationsOut,
    warnings,
  }
}
