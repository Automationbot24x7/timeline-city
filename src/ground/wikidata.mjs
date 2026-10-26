// Wikidata SPARQL for the evidence pack: items around a point, class membership (P31/P279*),
// labels/claims/sitelinks, and dated statements (P571 inception, P580 start, P1619 opening).
// Data: Wikidata, CC0.
import { haversineKm } from '../geo/geom.mjs'

const ENDPOINT = 'https://query.wikidata.org/sparql'
const BATCH = 100

// Heritage-ish classes (all verified ids). Items of a subclass also match.
export const INCLUDE = {
  Q1785071: 'fort', Q57821: 'fortification', Q23413: 'castle', Q16560: 'palace',
  Q381885: 'tomb', Q162875: 'mausoleum', Q2639699: 'dargah', Q32815: 'mosque', Q48356: 'minaret',
  Q44539: 'temple', Q337986: 'gurdwara', Q16970: 'church building', Q1473950: 'stepwell',
  Q839954: 'archaeological site', Q4989906: 'monument', Q5003624: 'memorial', Q1081138: 'historic site',
  Q358: 'heritage site', Q15243209: 'historic district', Q16748868: 'city walls', Q82117: 'city gate',
  Q219760: 'bazaar', Q330284: 'marketplace', Q132510: 'market', Q1254933: 'astronomical observatory',
}
// Never a site: people (OSM sometimes links the person, not the tomb), wax figures, stations.
export const EXCLUDE = { Q5: 'human', Q667018: 'wax museum', Q928830: 'metro station' }
// Events (an assassination) are dropped unless also a heritage class or designated
// (India Gate reaches "occurrence" through "commemoration" in the class tree).
export const SOFT_EXCLUDE = { Q1190554: 'occurrence' }
export const WORLD_HERITAGE = 'Q9259'
const CIRCA = 'Q5727902'
export const DATE_PROPS = { P571: 'inception', P580: 'start time', P1619: 'date of official opening' }

export const qidOf = (uri) => String(uri || '').match(/Q\d+$/)?.[0] || null
const values = (qids) => qids.map((q) => `wd:${q}`).join(' ')
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n))

/** POST a SPARQL query; returns bindings[] or null (logged) on failure. */
export async function sparql(http, query, label) {
  const json = await http.get(ENDPOINT, {
    kind: 'wikidata',
    method: 'POST',
    headers: { Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ query, format: 'json' }).toString(),
    label: `wikidata ${label}`,
    timeoutMs: 65_000,
  })
  return json?.results?.bindings || null
}

/** Items with coordinates within radiusKm of [lon, lat]: their P31 classes and P1435 designations. */
export async function around(http, lon, lat, radiusKm, label) {
  const rows = await sparql(
    http,
    `SELECT ?item ?dist ?type ?h WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
    bd:serviceParam wikibase:distance ?dist .
  }
  OPTIONAL { ?item wdt:P31 ?type }
  OPTIONAL { ?item wdt:P1435 ?h }
}`,
    `around ${label}`,
  )
  if (!rows) return null
  const items = new Map()
  for (const r of rows) {
    const qid = qidOf(r.item.value)
    if (!qid) continue
    const it = items.get(qid) || { qid, dist_km: Number(r.dist?.value), types: new Set(), heritage: false }
    if (r.type) it.types.add(qidOf(r.type.value))
    if (r.h) it.heritage = true
    items.set(qid, it)
  }
  return [...items.values()]
}

/** Memoised class closure: which INCLUDE/EXCLUDE classes each type is (a subclass of). */
export function createClassifier(http) {
  const known = new Map() // type qid -> Set(target qids)
  const targets = Object.keys({ ...INCLUDE, ...EXCLUDE, ...SOFT_EXCLUDE })
  for (const t of targets) known.set(t, new Set([t]))
  return {
    async load(types) {
      const todo = [...new Set(types)].filter((t) => t && !known.has(t))
      for (const part of chunks(todo, 150)) {
        const rows = await sparql(
          http,
          `SELECT ?c ?target WHERE {
  VALUES ?c { ${values(part)} }
  VALUES ?target { ${values(targets)} }
  ?c wdt:P279* ?target .
}`,
          `classes (${part.length})`,
        )
        if (!rows) continue // unknown types stay unclassified (treated as no match)
        for (const t of part) known.set(t, new Set())
        for (const r of rows) known.get(qidOf(r.c.value))?.add(qidOf(r.target.value))
      }
    },
    /** { include: ['fort', ...], exclude: ['human', ...] } for P31 types (+ whether designated). */
    of(types, designated = false) {
      const hits = new Set([...types].flatMap((t) => [...(known.get(t) || [])]))
      const include = [...hits].filter((q) => INCLUDE[q]).map((q) => INCLUDE[q])
      const exclude = [...hits].filter((q) => EXCLUDE[q]).map((q) => EXCLUDE[q])
      if (!include.length && !designated) exclude.push(...[...hits].filter((q) => SOFT_EXCLUDE[q]).map((q) => SOFT_EXCLUDE[q]))
      return { include, exclude }
    },
  }
}

/** Labels, descriptions, sitelinks, enwiki title, coordinates, P31/P1435/P361 (with labels). */
export async function details(http, qids) {
  const out = new Map()
  for (const part of chunks(qids, BATCH)) {
    const base = await sparql(
      http,
      `SELECT ?item ?en ?mul ?hi ?desc ?sitelinks ?article ?coord WHERE {
  VALUES ?item { ${values(part)} }
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?item rdfs:label ?mul FILTER(LANG(?mul) = "mul") }
  OPTIONAL { ?item rdfs:label ?hi FILTER(LANG(?hi) = "hi") }
  OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "en") }
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  OPTIONAL { ?item wdt:P625 ?coord }
}`,
      `details (${part.length})`,
    )
    const claims = await sparql(
      http,
      `SELECT ?item ?prop ?val ?valLabel WHERE {
  VALUES ?item { ${values(part)} }
  { ?item wdt:P31 ?val BIND("P31" AS ?prop) } UNION
  { ?item wdt:P1435 ?val BIND("P1435" AS ?prop) } UNION
  { ?item wdt:P361 ?val BIND("P361" AS ?prop) }
  OPTIONAL { ?val rdfs:label ?valLabel FILTER(LANG(?valLabel) = "en") }
}`,
      `claims (${part.length})`,
    )
    if (!base) continue
    for (const r of base) {
      const qid = qidOf(r.item.value)
      if (out.has(qid)) continue // several coordinates: keep the first
      const m = r.coord?.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/)
      out.set(qid, {
        qid,
        label: r.en?.value || r.mul?.value || r.hi?.value || qid,
        description: r.desc?.value || null,
        sitelinks: Number(r.sitelinks?.value || 0),
        enwiki: r.article ? decodeURIComponent(r.article.value.split('/wiki/')[1]).replace(/_/g, ' ') : null,
        coord: m ? [Number(m[1]), Number(m[2])] : null,
        types: [], heritage: [], partOf: [],
      })
    }
    for (const r of claims || []) {
      const it = out.get(qidOf(r.item.value))
      const v = { qid: qidOf(r.val.value), label: r.valLabel?.value || qidOf(r.val.value) }
      if (!it || !v.qid) continue
      const list = { P31: it.types, P1435: it.heritage, P361: it.partOf }[r.prop.value]
      if (list && !list.some((x) => x.qid === v.qid)) list.push(v)
    }
  }
  return out
}

/** Best-rank dated statements: qid -> [{ prop, time, precision, circa, early, late }]. */
export async function dates(http, qids) {
  const out = new Map()
  for (const part of chunks(qids, BATCH)) {
    const rows = await sparql(
      http,
      `SELECT ?item ?pid ?time ?precision ?circa ?early ?late WHERE {
  VALUES ?item { ${values(part)} }
  VALUES ?pid { ${Object.keys(DATE_PROPS).map((p) => `wd:${p}`).join(' ')} }
  ?pid wikibase:claim ?p ; wikibase:statementValue ?psv .
  ?item ?p ?st . ?st a wikibase:BestRank ; ?psv ?tv .
  ?tv wikibase:timeValue ?time ; wikibase:timePrecision ?precision .
  OPTIONAL { ?st pq:P1480 ?circa }
  OPTIONAL { ?st pq:P1319 ?early }
  OPTIONAL { ?st pq:P1326 ?late }
}`,
      `dates (${part.length})`,
    )
    for (const r of rows || []) {
      const qid = qidOf(r.item.value)
      const list = out.get(qid) || []
      list.push({
        prop: r.pid.value.split('/').pop(),
        time: r.time.value,
        precision: Number(r.precision.value),
        circa: qidOf(r.circa?.value) === CIRCA,
        early: r.early?.value || null,
        late: r.late?.value || null,
      })
      out.set(qid, list)
    }
  }
  return out
}

/**
 * The place each station is named after: the station item's P138 "named after", else an item
 * labelled exactly like the station within maxKm (Chandni Chowk, New Delhi, Hauz Khas).
 * People and stations are skipped. Returns Map(station id -> { qid, label, description, enwiki }).
 */
export async function namesakes(http, stations, { maxKm = 5 } = {}) {
  const out = new Map()
  const withQ = stations.filter((s) => /^Q\d+$/.test(s.wikidata || ''))
  if (!withQ.length) return out
  const viaP138 = await sparql(http, `SELECT ?st ?item WHERE { VALUES ?st { ${values(withQ.map((s) => s.wikidata))} } ?st wdt:P138 ?item }`, 'station named-after')
  const names = [...new Set(withQ.map((s) => s.name))]
  const viaLabel = await sparql(http, `SELECT ?item ?name WHERE { VALUES ?name { ${names.map((n) => `${JSON.stringify(n)}@en`).join(' ')} } ?item rdfs:label ?name }`, 'station namesake labels')
  const pairs = [] // [station, qid, via]
  const byQ = new Map(withQ.map((s) => [s.wikidata, s]))
  for (const r of viaP138 || []) if (byQ.has(qidOf(r.st.value))) pairs.push([byQ.get(qidOf(r.st.value)), qidOf(r.item.value), 1])
  for (const r of viaLabel || []) for (const st of withQ.filter((s) => s.name === r.name.value)) pairs.push([st, qidOf(r.item.value), 2])
  const info = await details(http, [...new Set(pairs.map((p) => p[1]))].filter((q) => q && !byQ.has(q)))
  const best = new Map()
  for (const [st, qid, via] of pairs) {
    const d = info.get(qid)
    if (!d?.enwiki || d.types.some((t) => EXCLUDE[t.qid] || t.qid === 'Q55488')) continue // people, stations
    const km = d.coord ? haversineKm(d.coord, [st.lon, st.lat]) : null
    if (km == null ? via !== 1 : km > maxKm) continue
    const rank = via * 1e6 - d.sitelinks
    if (!best.has(st.id) || rank < best.get(st.id).rank) best.set(st.id, { rank, qid, label: d.label, description: d.description, enwiki: d.enwiki })
  }
  for (const [id, { rank, ...c }] of best) out.set(id, c)
  return out
}

const yearOf = (t) => {
  const m = /^([+-]?)(\d{1,})-/.exec(String(t || ''))
  return m ? Number(m[2]) * (m[1] === '-' ? -1 : 1) : null
}
const era = (y) => (y < 0 ? `${-y} BCE` : String(y))
export const ordinal = (n) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'
  return `${n}${s}`
}

/** One dated statement -> { year, text, precision } ("1639", "c. 1295", "13th century", "1311–1316"). */
export function parseDate(d) {
  const year = yearOf(d.time)
  if (year == null || d.precision < 6) return null
  const c = d.circa ? 'c. ' : ''
  const y1 = yearOf(d.early), y2 = yearOf(d.late)
  if (y1 != null && y2 != null && y1 < y2) return { year: y1, text: `${c}${era(y1)}–${era(y2)}`, precision: 'range' }
  if (d.precision >= 9) return { year, text: `${c}${era(year)}`, precision: 'year' }
  if (d.precision === 8) {
    const dec = Math.floor(year / 10) * 10
    return { year: dec, text: `${c}${era(dec)}s`, precision: 'decade' }
  }
  const unit = d.precision === 7 ? 100 : 1000
  const n = Math.floor((Math.abs(year) - 1) / unit) + 1
  const first = (n - 1) * unit + 1
  return {
    year: year < 0 ? -first : first,
    text: `${c}${ordinal(n)} ${unit === 100 ? 'century' : 'millennium'}${year < 0 ? ' BCE' : ''}`,
    precision: unit === 100 ? 'century' : 'millennium',
  }
}

/** Pick the item's date: inception, else start time, else opening; most precise, then earliest. */
export function pickDate(list = []) {
  for (const prop of Object.keys(DATE_PROPS)) {
    const rank = { year: 4, range: 3, decade: 2, century: 1, millennium: 0 }
    const opts = list.filter((d) => d.prop === prop).map((d) => ({ ...parseDate(d), prop })).filter((d) => d.text)
    opts.sort((a, b) => rank[b.precision] - rank[a.precision] || a.year - b.year)
    if (opts[0]) return opts[0]
  }
  return null
}
