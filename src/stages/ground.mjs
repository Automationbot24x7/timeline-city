// Stage ground: geo.json -> build/ground.json, the evidence pack the director is limited to.
// Heritage items around each station (Wikidata SPARQL), English Wikipedia leads as excerpts,
// simple facts from structured data, and the project's curated facts_file.
// Data: Wikidata (CC0 1.0), Wikipedia (CC BY-SA 4.0). HTTP cached in build/cache/ground/.
import path from 'node:path'
import { createFetcher } from '../ground/http.mjs'
import { around, createClassifier, details, dates, namesakes, pickDate, WORLD_HERITAGE } from '../ground/wikidata.mjs'
import { excerpt, leads, pageUrl, summary } from '../ground/wikipedia.mjs'
import { assign, assignIds, matchGeo, rank, score } from '../ground/select.mjs'
import { doubtfulDate, mentionsDate, readFactsFile, realTitle, shortPublisher, siteClaims, wikidataExcerpt } from '../ground/facts.mjs'

const DEFAULTS = { radius_km: 1.5, end_radius_km: 2.5, per_station: 4, excerpt_chars: 1500 }
const r5 = (x) => Math.round(x * 1e5) / 1e5
const cap = (s) => (s && /^[a-z]/.test(s) ? s[0].toUpperCase() + s.slice(1) : s)

function createSources(max) {
  const list = []
  const byKey = new Map()
  return {
    list,
    max,
    get: (key) => byKey.get(key),
    add({ key, url, title, publisher, excerpt, license, ...extra }) {
      key ??= url
      if (byKey.has(key)) return byKey.get(key).id
      const src = { id: `src_${String(list.length + 1).padStart(3, '0')}`, url, title, publisher, excerpt: String(excerpt || '').slice(0, max), ...extra }
      if (license) src.license = license
      list.push(src)
      byKey.set(key, src)
      return src.id
    },
  }
}

/**
 * Curated facts -> sources. One source per URL whose excerpt lists the checked claims citing it
 * (continued in a second source for that URL when 1500 chars would cut a claim off).
 * Returns, per fact, the source ids that carry its claim.
 */
async function curatedSources(curated, sources, http) {
  const titles = new Map()
  for (const url of new Set(curated.flatMap((f) => f.sources.map((s) => s?.url)).filter((u) => /^https?:\/\//.test(u || '')))) {
    titles.set(url, /\.pdf($|\?)/i.test(url) ? null : await http.get(url, { kind: 'pages', as: 'title', label: `title ${url}`, timeoutMs: 15_000, retries: 1 }))
  }
  const open = new Map() // url -> { src, part }
  return curated.map((f, i) => {
    const ids = new Set()
    const line = ` [${f.id ?? `#${i + 1}`}] ${f.claim.trim()}`
    for (const s of f.sources) {
      if (!/^https?:\/\//.test(s?.url || '')) continue
      let cur = open.get(s.url)
      if (!cur || cur.src.excerpt.length + line.length > sources.max) {
        const part = (cur?.part || 0) + 1
        const detail = String(s.publisher || '').trim() // curated note, e.g. "DDA (facility page; does not state the 1982 date)"
        const publisher = shortPublisher(detail, s.url) // citation-chip name
        const key = `facts_file ${s.url} #${part}`
        sources.add({
          key,
          url: s.url,
          title: realTitle(titles.get(s.url)) || `${publisher}: ${s.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 120)}`,
          publisher,
          excerpt: `Claims from the project's curated facts file, each checked against this source${detail ? ` (${detail})` : ''}:`.slice(0, 400),
          ...(detail && detail !== publisher && { publisher_detail: detail }),
        })
        cur = { src: sources.get(key), part }
        open.set(s.url, cur)
      }
      cur.src.excerpt = (cur.src.excerpt + line).slice(0, sources.max)
      ids.add(cur.src.id)
    }
    return [...ids]
  })
}

export const stage = {
  name: 'ground',
  outputs: ['ground.json'],
  async run(ctx) {
    const { config, log } = ctx
    const geo = ctx.read('geo.json')
    const opt = { ...DEFAULTS, ...(config.ground || {}) }
    const http = createFetcher({ cacheDir: ctx.file('cache/ground'), log })
    const stations = geo.stations || []
    if (!stations.length) throw new Error('ground: geo.json has no stations')
    const geoSites = geo.sites || []

    // 1. candidates: Wikidata items near each station, plus geo.json sites that carry a Wikidata id
    const cands = new Map()
    let reached = 0
    for (const [i, st] of stations.entries()) {
      const radius = i === 0 || i === stations.length - 1 ? opt.end_radius_km : opt.radius_km
      const items = await around(http, st.lon, st.lat, radius, st.name)
      if (!items) continue
      reached++
      for (const it of items) {
        const c = cands.get(it.qid) || { qid: it.qid, types: new Set(), heritage: false, fromGeo: false }
        it.types.forEach((t) => c.types.add(t))
        c.heritage ||= it.heritage
        cands.set(it.qid, c)
      }
    }
    for (const g of geoSites) {
      if (!/^Q\d+$/.test(g.wikidata || '')) continue
      const c = cands.get(g.wikidata) || { qid: g.wikidata, types: new Set(), heritage: false }
      c.fromGeo = true
      cands.set(g.wikidata, c)
    }
    for (const st of stations) cands.delete(st.wikidata)
    // a pack without Wikidata would be cached as done and starve the director: fail loudly instead
    if (!reached) throw new Error('ground: every Wikidata station query failed (offline? see the skip lines); nothing written')
    if (reached < stations.length) log(`ground: warning: ${stations.length - reached} station queries failed; their sites may be missing (rerun with --force later)`)

    // 2. heritage designation or a heritage class (P31/P279*); never people, events, stations
    const classes = createClassifier(http)
    await classes.load([...cands.values()].flatMap((c) => [...c.types]))
    const shortlist = [...cands.values()]
      .filter((c) => {
        const k = classes.of(c.types, c.heritage)
        return !k.exclude.length && (c.fromGeo || c.heritage || k.include.length)
      })
      .map((c) => c.qid)
    log(`ground: ${cands.size} Wikidata items near the line, ${shortlist.length} heritage candidates`)

    // 3. labels, claims, sitelinks, dates
    const info = await details(http, shortlist)
    if (shortlist.length && !info.size) throw new Error('ground: Wikidata details queries failed; nothing written (rerun later)')
    await classes.load([...info.values()].flatMap((d) => d.types.map((t) => t.qid)))
    const dated = await dates(http, [...info.keys()])
    const geoByQid = new Map(geoSites.filter((g) => g.wikidata).map((g) => [g.wikidata, g]))
    let sites = []
    for (const d of info.values()) {
      const k = classes.of(d.types.map((t) => t.qid), d.heritage.length > 0)
      const g = geoByQid.get(d.qid)
      if (k.exclude.length) {
        if (g) log(`ground: ${g.id}: OSM links ${d.qid} "${d.label}" (${k.exclude.join(', ')}), not the site; ignored`)
        continue
      }
      if (!d.enwiki && !d.heritage.length) continue // nothing citable beyond a bare item
      if (!d.coord && !g) continue
      sites.push({ ...d, label: cap(d.label), wdCoord: d.coord, kinds: k.include, date: pickDate(dated.get(d.qid)), world_heritage: d.heritage.some((h) => h.qid === WORLD_HERITAGE), geo: null })
    }

    // 4. link to geo.json footprints, station, rank per station. Items without an English article
    // must be corroborated by an OSM feature (Wikidata bulk imports carry some misplaced points).
    matchGeo(sites, geoSites)
    const thin = sites.filter((s) => !s.enwiki && !s.geo).length
    sites = sites.filter((s) => s.enwiki || s.geo)
    assign(sites, stations, opt.radius_km, opt.end_radius_km)
    for (const s of sites) s.score = score(s)
    const ranked = rank(sites, stations, opt.per_station)
    const kept = [...ranked.values()].flat()
    assignIds(kept, geoSites)
    log(`ground: ${sites.length} citable sites (${thin} uncorroborated dropped), keeping ${kept.length} (top ${opt.per_station} per station)`)

    // 5. English Wikipedia (summary: canonical title + URL; plain-text lead) for the kept sites and
    // for the place each station is named after (context for the stop, not a map site)
    const named = await namesakes(http, stations)
    const wiki = new Map()
    for (const t of [...kept.map((s) => s.enwiki), ...[...named.values()].map((n) => n.enwiki)]) if (t && !wiki.has(t)) wiki.set(t, await summary(http, t))
    const leadText = await leads(http, [...wiki.entries()].map(([t, w]) => w?.title || t))

    // 6. sources + facts, in ride order
    const sources = createSources(opt.excerpt_chars)
    const wikiSource = (title, years = []) => {
      const w = title ? wiki.get(title) : null
      const lead = title ? leadText.get(w?.title || title) || w?.extract || '' : ''
      const text = lead ? excerpt(lead, { max: opt.excerpt_chars, years }) : ''
      const id = text ? sources.add({ url: w?.url || pageUrl(title), title: w?.title || title, publisher: 'Wikipedia', excerpt: text, license: 'CC BY-SA 4.0' }) : null
      return { id, text, w }
    }
    const facts = []
    const addFact = (f) => facts.push({ id: `fact_${String(facts.length + 1).padStart(3, '0')}`, ...f })
    const out = []
    for (const st of stations) {
      const n = named.get(st.id)
      const ns = n ? wikiSource(n.enwiki) : null
      const list = []
      for (const s of ranked.get(st.id)) {
        const { id: wpId, text, w } = wikiSource(s.enwiki, [s.date?.year])
        const dropped = doubtfulDate(text, s.date) ? s.date : null
        if (dropped) {
          log(`ground: ${s.label}: Wikidata ${dropped.prop} ${dropped.text} contradicts the Wikipedia lead; date dropped`)
          s.date = null
        }
        const wdId = sources.add({ url: `https://www.wikidata.org/wiki/${s.qid}`, title: `${s.label} (${s.qid})`, publisher: 'Wikidata', excerpt: wikidataExcerpt(s), license: 'CC0 1.0' })
        const corroborated = !!(wpId && mentionsDate(text, s.date))
        for (const c of siteClaims(s)) {
          const date = c.kind === 'date'
          addFact({
            claim: c.claim,
            year: c.year,
            source_ids: date && corroborated ? [wdId, wpId] : [wdId],
            origin: 'wikidata',
            site_id: s.id,
            station_id: st.id,
            ...(date && { corroborated }),
          })
        }
        list.push({
          id: s.id,
          qid: s.qid,
          label: s.label,
          description: s.description || w?.description || null,
          inception_year: s.date?.year ?? null,
          inception_text: s.date?.text ?? null,
          lon: r5(s.coord[0]),
          lat: r5(s.coord[1]),
          dist_km: s.dist_km,
          heritage: s.heritage.map((h) => h.label).join('; ') || null,
          source_ids: [wpId, wdId].filter(Boolean),
          date_property: s.date ? s.date.prop : null,
          date_precision: s.date?.precision ?? null,
          date_in_wikipedia: s.date ? corroborated : null,
          ...(dropped && { date_dropped: { prop: dropped.prop, text: dropped.text, reason: 'Wikidata date contradicted by the Wikipedia lead' } }),
          kinds: s.kinds,
          sitelinks: s.sitelinks,
          wikipedia: w?.title || s.enwiki || null,
          geo_site_id: s.geo?.id || null,
          named_after_station: !!s.named_after,
          also_near: s.also_near,
          score: s.score,
        })
      }
      out.push({
        station_id: st.id,
        name: st.name,
        sites: list,
        nearby_site_ids: [], // kept sites listed under another station but within radius_km of this one
        namesake: n && ns?.id ? { qid: n.qid, label: n.label, description: n.description || ns.w?.description || null, wikipedia: ns.w?.title || n.enwiki, source_id: ns.id } : null,
      })
    }
    for (const st of out) for (const s of st.sites) for (const n of s.also_near) out.find((o) => o.station_id === n)?.nearby_site_ids.push(s.id)

    // 7. curated facts_file: each URL becomes a source whose excerpt is the checked claim(s)
    const factsPath = config.facts_file ? path.resolve(ctx.projectDir, config.facts_file) : null
    const curated = readFactsFile(factsPath, log)
    const curatedIds = await curatedSources(curated, sources, http)
    curated.forEach((f, i) =>
      addFact({
        claim: f.claim.trim(),
        year: typeof f.year === 'number' || (typeof f.year === 'string' && /^-?\d+$/.test(f.year)) ? Number(f.year) : null,
        source_ids: curatedIds[i],
        origin: 'facts_file',
        ...(f.id != null && { file_id: String(f.id) }),
        ...(f.topic && { topic: f.topic }),
        ...(f.narration_line && { narration_line: f.narration_line }),
        ...(f.caveats && { caveats: f.caveats }),
      }),
    )

    if (!sources.list.length) throw new Error('ground: no evidence gathered (network down? see the skip lines above)')
    const ground = {
      sources: sources.list,
      stations: out,
      facts,
      meta: {
        generated_at: new Date().toISOString(),
        attribution: 'Facts: Wikidata (CC0 1.0) and English Wikipedia (CC BY-SA 4.0) contributors',
        options: opt,
        counts: { wikidata_items: cands.size, candidates: shortlist.length, citable: sites.length, kept: kept.length, sources: sources.list.length, facts: facts.length, curated_facts: curated.length },
        facts_file: factsPath ? path.relative(ctx.projectDir, factsPath).replace(/\\/g, '/') : null,
        http: { ...http.stats },
        failures: http.failures,
      },
    }
    ctx.write('ground.json', ground)
    for (const st of out) log(`ground: ${st.name}${st.namesake ? ` [${st.namesake.wikipedia}]` : ''}: ${st.sites.map((s) => `${s.label}${s.inception_text ? ` (${s.inception_text})` : ''}`).join(' · ') || '-'}`)
    log(`ground: wrote ground.json: ${sources.list.length} sources, ${kept.length} sites, ${facts.length} facts (${curated.length} curated); http ${http.stats.network} fetched, ${http.stats.cached} cached, ${http.stats.failed} failed`)
  },
}
