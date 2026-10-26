// Stage `art` (between verify and assets): MiniMax M3.1 flash as art director. One call (logged in
// build/director/art.json: prompt, reasoning, response, usage) writes a landmark painting for each map
// scene at a major stop: the map gives way to the painting after the train arrives, the 3D map keeps
// playing in an inset. It adds only `landmark: { image_prompt, subject, site_id, reveal_at }` to those
// scenes of plan.verified.json: narration, claims and on-screen text are never touched.
// Which scenes: map scenes that light up a site, unless the next scene already paints that place
// (project.yaml `art: { scenes: [s04, ...] }` overrides).
import { ask, prompt } from '../director/llm.mjs'
import { RIDE_SOURCE, caveatsFor, excerptPack, loadEvidence, mapSiteId, resolveStation } from '../director/evidence.mjs'
import { withStyle, wordCount } from '../director/check.mjs'
import { REVEALS, landmarkSchema } from '../director/schemas.mjs'
import { briefVars, directorSystem } from './direct.mjs'
import { norm, siteNames, stripPauses } from './timing.mjs'
import { createFetcher } from '../ground/http.mjs'

const IMG_KINDS = new Set(['title', 'illustration', 'personal', 'end'])
const CAP_USD = 0.03 // the whole step: the call and at most one retry
const MAX_TOKENS = 12000 // per attempt (reasoning included)
const ATTEMPTS = 2 // forced-call tries per ask when the answer is not JSON
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i
const uniq = (a) => [...new Set(a.filter(Boolean))]
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

const groundSite = (ev, id) => ev.groundSites.get(id) || [...ev.groundSites.values()].find((s) => s.geo_site_id === id) || null
const namesOf = (ev, id) => siteNames(ev.geoSites.get(id), groundSite(ev, id))

/** Where the narration first names a site: 0..1 of its length, or null. */
export function namedAt(narration, names) {
  const text = ` ${norm(stripPauses(narration))} `
  let best = null
  for (const n of uniq(names.map(norm)).filter((x) => x.length > 2)) {
    const i = text.indexOf(` ${n} `)
    if (i >= 0 && (best === null || i < best)) best = i
  }
  return best === null ? null : best / Math.max(1, text.length - 2)
}

/** Does an image scene already paint the place a map scene is about? (same headline, or it names a lit site) */
function paintsSamePlace(mapSc, imgSc, ev) {
  const h = norm(mapSc.on_screen?.headline)
  if (h && h === norm(imgSc.on_screen?.headline)) return true
  const names = (mapSc.map?.focus_site_ids || []).flatMap((id) => namesOf(ev, id))
  return namedAt(imgSc.image_prompt || '', names) !== null
}

/** The map scenes that get a landmark painting. */
export function landmarkScenes(plan, ev, config = {}) {
  const want = config.art?.scenes
  if (Array.isArray(want) && want.length) return plan.scenes.filter((sc) => want.includes(sc.id) && sc.kind === 'map')
  return plan.scenes.filter((sc, i) => {
    if (sc.kind !== 'map' || !(sc.map?.focus_site_ids || []).length) return false
    const next = plan.scenes[i + 1]
    return !(next && IMG_KINDS.has(next.kind) && paintsSamePlace(sc, next, ev))
  })
}

/** First station above ground (project.yaml line.underground), as an index into the ride; null without a tunnel. */
function surfaceIndex(ev, config) {
  const u = config.line?.underground
  if (!u || typeof u !== 'object') return null
  const idx = (ref) => {
    const id = resolveStation(ev, ref)
    return id ? ev.stations.findIndex((s) => s.id === id) : -1
  }
  const to = u.to ?? u.first_surface
  if (to != null) return idx(to) >= 0 ? idx(to) : null
  if (u.last_underground != null) return idx(u.last_underground) >= 0 ? idx(u.last_underground) + 1 : null
  return null
}

function lightText(ev, config) {
  const i = surfaceIndex(ev, config)
  if (i === null) return 'The film is set at dusk and night: warm lamplight, moonlight and a deep indigo sky in every painting of the ride.'
  const st = ev.stations[i]
  return `The ride runs underground at night until the train comes up into daylight just before ${st.name}, where dawn breaks. Landmark paintings at stops before ${st.name} are at dusk or night: deep indigo sky, warm lamplight, soft moonlight on stone. From ${st.name} on, early-morning golden light: a pale gold sky, long soft shadows, morning haze.`
}

function sceneLight(sc, ev, config) {
  const i = surfaceIndex(ev, config)
  if (i === null) return 'dusk or night, lamplit'
  const id = sc.map?.train_to || sc.map?.focus_station
  const k = ev.stations.findIndex((s) => s.id === id)
  return k >= i ? 'early-morning golden light (the train has come up into daylight)' : 'dusk or night, lamplit (the train is still underground)'
}

function siteLine(ev, sc, id) {
  const geo = ev.geoSites.get(id) || {}
  const g = groundSite(ev, id) || {}
  const t = geo.tags || {}
  const osm = ['building', 'historic', 'castle_type', 'tomb', 'amenity', 'religion'].filter((k) => t[k] && t[k] !== 'yes').map((k) => `${k}=${t[k]}`)
  const at = namedAt(sc.narration, namesOf(ev, id))
  const parts = [
    `${id}: ${g.label || geo.display_name || geo.name}${g.description ? ` (${one(g.description)})` : ''}`,
    g.inception_text ? `dated ${g.inception_text}` : null,
    g.heritage ? `heritage: ${g.heritage}` : null,
    g.dist_km != null ? `${g.dist_km} km from the station` : geo.dist_km != null ? `${geo.dist_km} km from the line` : null,
    osm.length ? `mapped in OpenStreetMap as ${osm.join(', ')}` : null,
    at === null ? 'the narration does not name it' : `the narration names it about ${Math.round(at * 100)}% of the way into the scene's line`,
  ]
  return `  - ${parts.filter(Boolean).join('; ')}`
}

function sceneBlock(sc, ev, config) {
  const m = sc.map || {}
  const st = ev.stationById.get(m.train_to || m.focus_station)
  const ride = m.train_to ? `rides to ${st?.name} (${m.train_to}) at the start of the scene` : `is already at ${st?.name || m.focus_station}`
  return [
    `### ${sc.id} (map) · headline "${sc.on_screen?.headline || ''}" · year card "${sc.on_screen?.year || ''}"`,
    `- narration: "${stripPauses(sc.narration)}"`,
    `- the train ${ride}; light: ${sceneLight(sc, ev, config)}`,
    '- focus sites (they light up on the map):',
    ...(m.focus_site_ids || []).map((id) => siteLine(ev, sc, id)),
  ].join('\n')
}

function othersText(plan, styleBible) {
  const style = one(styleBible?.illustration_style).replace(/[.\s]+$/, '')
  const list = plan.scenes.filter((sc) => sc.image_prompt).map((sc) => {
    let p = one(sc.image_prompt)
    if (style) p = p.replace(style, '').replace(/[.\s]+$/, '')
    return `- ${sc.id} (${sc.kind}, "${sc.on_screen?.headline || ''}"): ${p.slice(0, 260)}${p.length > 260 ? '…' : ''}`
  })
  if (plan.cover_prompt) list.push(`- cover: ${one(plan.cover_prompt).replace(style, '').slice(0, 200)}…`)
  return list.join('\n') || '(none)'
}

/** Code checks of the answer: exactly the requested scenes, real site ids, a usable prompt. */
export function checkLandmarks(raw, targets, ev, styleBible) {
  const problems = []
  const value = new Map()
  const why = {}
  for (const l of Array.isArray(raw?.landmarks) ? raw.landmarks : []) {
    const sc = targets.find((s) => s.id === l?.scene_id)
    if (!sc) {
      problems.push(`a landmark for scene "${l?.scene_id}", which is not one of ${targets.map((s) => s.id).join(', ')}`)
      continue
    }
    if (value.has(sc.id)) {
      problems.push(`two landmarks for ${sc.id}: give exactly one`)
      continue
    }
    const focus = sc.map?.focus_site_ids || []
    const site = mapSiteId(ev, l.site_id)
    const subject = one(l.subject)
    const reveal = REVEALS.includes(l.reveal_at) ? l.reveal_at : null
    let p = one(l.image_prompt)
    const bad = []
    // the painting shows what the scene's year card dates: its first focus site
    if (site !== focus[0]) bad.push(`${sc.id}: site_id "${l.site_id}" must be ${focus[0]}, the site its narration and year card are about`)
    if (!subject) bad.push(`${sc.id}: subject is empty`)
    else if (subject.length > 40) bad.push(`${sc.id}: subject "${subject}" is longer than 32 characters`)
    if (!reveal) bad.push(`${sc.id}: reveal_at must be "named" or "arrival"`)
    else if (reveal === 'named' && site && namedAt(sc.narration, [...namesOf(ev, site), subject]) === null) bad.push(`${sc.id}: reveal_at is "named" but the narration never names ${subject || site}; use "arrival"`)
    if (URL_RE.test(p)) bad.push(`${sc.id}: image_prompt contains a web address`)
    const style = one(styleBible?.illustration_style).replace(/[.\s]+$/, '')
    const words = wordCount(style ? p.replace(style, '') : p)
    if (words < 60) bad.push(`${sc.id}: image_prompt has only ${words} words before the style paragraph; describe the real monument (materials, colours, domes, minarets, storeys or instruments, setting, light, composition) in 90-170 words`)
    else if (words > 240) bad.push(`${sc.id}: image_prompt has ${words} words before the style paragraph; keep it to 90-170`)
    problems.push(...bad)
    if (bad.length) continue
    p = withStyle(p, styleBible)
    value.set(sc.id, { image_prompt: p, subject, site_id: site, reveal_at: reveal })
    why[sc.id] = one(l.why)
  }
  for (const sc of targets) if (!value.has(sc.id) && !problems.some((x) => x.startsWith(`${sc.id}:`))) problems.push(`no landmark for ${sc.id}`)
  return { value, problems, why }
}

// ---------- how the places look: the architecture sections of each landmark's Wikipedia article ----------
// (the paintings' visual evidence; never used for narration). Free, cached in build/cache/ground/wikipedia/.
// words that describe how a building looks: a sentence is kept by how many it uses
const VISUAL = /\b(storey|storeys|stories|story|tier|dome|domes|domed|cupola|minaret|minarets|tower|spire|arch|arches|arched|arcade|colonnade|column|columns|pillar|pilaster|capital|balcon\w*|gallery|parapet|chhatri\w*|chattri\w*|chuttri\w*|kiosk|pavilion|gate|gateway|portal|iwan|stair\w*|steps|courtyard|court|plinth|platform|terrace|facade|façade|sandstone|marble|granite|brick|plaster|stucco|copper|iron|stone|red|white|black|buff|cream|pink|yellow|ochre|fluted|flutes|ribbed|banded|bands|striped|carved|carving\w*|inlay|inlaid|ornament\w*|decorat\w*|calligraph\w*|lattice|jali|screen|niche|bracket\w*|corbel\w*|tapering|taper\w*|hemispher\w*|triangle|triangular|quadrant|cylind\w*|circular|octagonal|square|rectangular|bell|lotus|garden\w*|lawn\w*|fountain|pool|tank|hill|ridge|yantra|sundial|gnomon|instruments?|graduat\w*|ramp|hemispheres|diameter|height|tall)\b/gi
const NOT_VISUAL = /\b(references?|citation|retrieved|isbn|according to the|scholars?|debated|identified with|protest|politic\w*|ceremon\w*|president|minister|visitors?|tickets?|museum hours|publications?|pdf|vol|doi|journal|scientists?|chemi\w*|corrosion|metallurg\w*)\b/i
const LOOK_CHARS = 1800

/** Plain-text article -> its sentences (headings dropped). */
function articleSentences(text) {
  return String(text)
    .split('\n')
    .filter((l) => !/^={2,}.*={2,}\s*$/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 600)
}

/** The sentences of an article that best describe how the place looks (in article order, <= max chars). */
export function lookText(text, max = LOOK_CHARS) {
  const list = articleSentences(text).map((s, i) => ({ s, i, score: new Set((s.match(VISUAL) || []).map((w) => w.toLowerCase())).size - (NOT_VISUAL.test(s) ? 3 : 0) }))
  const picked = []
  let len = 0
  for (const x of [...list].filter((x) => x.score >= 2).sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (len + x.s.length + 1 > max) continue
    picked.push(x)
    len += x.s.length + 1
  }
  return picked.sort((a, b) => a.i - b.i).map((x) => x.s).join(' ')
}

/** For each landmark candidate (a scene's first focus site): how it looks, from its Wikipedia article. */
async function lookNotes(ctx, ev, siteIds) {
  const http = createFetcher({ cacheDir: ctx.file('cache/ground'), log: ctx.log })
  const out = []
  for (const id of uniq(siteIds)) {
    const title = groundSite(ev, id)?.wikipedia || String(ev.geoSites.get(id)?.tags?.wikipedia || '').replace(/^[a-z]{2}:/, '')
    if (!title) continue
    const params = new URLSearchParams({ action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'wiki', redirects: '1', titles: title, format: 'json', formatversion: '2' })
    const j = await http.get(`https://en.wikipedia.org/w/api.php?${params}`, { kind: 'wikipedia', label: `wikipedia article "${title}"` })
    const text = lookText(j?.query?.pages?.[0]?.extract || '')
    if (text) out.push(`[${id}] Wikipedia, "${title}" (the sentences about how it looks):\n  ${text}`)
  }
  return out.join('\n') || '(none found: describe only what you are certain of)'
}

/** Source excerpts, each distinct text once (curated sources often repeat the same checked claims). */
function uniqueExcerpts(ev, ids) {
  const groups = new Map()
  for (const id of ids) {
    const src = ev.sources.get(id)
    if (!src) continue
    const k = one(src.excerpt).replace(/^Claims from the project's curated facts file, each checked against this source \([^)]*\):\s*/, '')
    groups.set(k, [...(groups.get(k) || []), src])
  }
  return [...groups.values()]
    .map((list) => excerptPack(ev, [list[0].id], { maxChars: 1100 }).replace(/^\[[^\]]+\]/, `[${list.map((x) => x.id).join(', ')}]`))
    .join('\n')
}

/** The art director's messages: the director's system prompt + src/prompts/art.md filled from the plan and evidence. */
export async function artMessages(ctx, plan, ev, targets) {
  const { config } = ctx
  const styleBible = plan.style_bible || {}
  const srcIds = uniq(targets.flatMap((sc) => [...(sc.source_ids || []), ...(sc.map?.focus_site_ids || []).flatMap((id) => groundSite(ev, id)?.source_ids || [])])).filter((id) => id !== RIDE_SOURCE)
  const vars = {
    brief: briefVars(config).brief,
    city: config.city,
    illustration_style: one(styleBible.illustration_style || config.style?.illustration),
    palette: (styleBible.palette || []).join(', ') || '(none)',
    light: lightText(ev, config),
    others: othersText(plan, styleBible),
    scenes: targets.map((sc) => sceneBlock(sc, ev, config)).join('\n\n'),
    excerpts: uniqueExcerpts(ev, srcIds),
    // caveats of the facts these scenes state (not of every fact that shares a source with them)
    caveats: caveatsFor(ev, { factIds: targets.flatMap((sc) => sc.fact_ids || []) }) || '(none)',
    scene_ids: targets.map((s) => s.id).join(', '),
    looks: await lookNotes(ctx, ev, targets.map((sc) => sc.map?.focus_site_ids?.[0])),
  }
  return [
    { role: 'system', content: directorSystem(config) },
    { role: 'user', content: prompt('art.md', vars) },
  ]
}

/** What a director log entry cost this run (a replay from the cache is free). */
function stepCost(ctx, step) {
  const e = ctx.read(`director/${step}.json`, null)
  return e && !e.cached ? Number(e.cost_usd) || 0 : 0
}

export const stage = {
  name: 'art',
  outputs: [], // it only adds landmark fields to plan.verified.json; it decides itself whether there is work
  async run(ctx) {
    const { config, log } = ctx
    const plan = ctx.read('plan.verified.json', null)
    if (!plan?.scenes?.length) throw new Error('art: plan.verified.json is missing: run verify first')
    const ev = loadEvidence(ctx)
    const targets = landmarkScenes(plan, ev, config)
    if (!targets.length) return log('  art: no map scene lights up a landmark; nothing to paint')
    log(`  art: landmark paintings for ${targets.map((s) => `${s.id} (${s.on_screen?.headline})`).join(', ')}`)
    if (!ctx.force && targets.every((sc) => sc.landmark?.image_prompt)) return log('  art: every landmark is already directed (use --force to redo)')

    const styleBible = plan.style_bible || {}
    const messages = await artMessages(ctx, plan, ev, targets)
    const call = (step, msgs) =>
      ask(ctx, { stage: 'art', step, messages: msgs, schema: landmarkSchema, name: 'submit_landmarks', description: 'Submit one landmark painting per listed scene.', max_tokens: MAX_TOKENS, attempts: ATTEMPTS })

    const raw = await call('art', messages)
    let spent = stepCost(ctx, 'art')
    let res = checkLandmarks(raw, targets, ev, styleBible)
    if (res.problems.length) {
      log(`  art: ${res.problems.length} problem(s):\n    - ${res.problems.join('\n    - ')}`)
      // one retry with the problem list, only while the whole step stays under its cap
      const card = await ctx.client.modelPrice(config.models.director)
      const chars = JSON.stringify(messages).length + JSON.stringify(raw).length + 1500
      const next = ((chars / 3.2) * Number(card.prompt_token_price || 0.15) + MAX_TOKENS * Number(card.completion_token_price || 0.6)) / 1e6
      if (spent + next * ATTEMPTS > CAP_USD) log(`  art: no retry (spent $${spent.toFixed(4)}, a retry could cost up to $${(next * ATTEMPTS).toFixed(4)}: cap $${CAP_USD})`)
      else {
        const raw2 = await call('art.retry', [
          ...messages,
          { role: 'assistant', content: JSON.stringify(raw) },
          { role: 'user', content: `The code checks of your landmarks found these problems:\n- ${res.problems.join('\n- ')}\n\nFix every one of them and submit all ${targets.length} landmarks again (complete entries, not a diff). Keep everything that was not a problem.` },
        ])
        spent += stepCost(ctx, 'art.retry')
        const res2 = checkLandmarks(raw2, targets, ev, styleBible)
        if (res2.value.size > res.value.size || (res2.value.size === res.value.size && res2.problems.length <= res.problems.length)) res = res2
        if (res.problems.length) log(`  art: still ${res.problems.length} problem(s) after the retry:\n    - ${res.problems.join('\n    - ')}`)
      }
    }
    if (spent) log(`  art: M3.1 cost $${spent.toFixed(4)} (cap $${CAP_USD})`)

    // add only the landmark field (re-read: nothing else is ever written back)
    const fresh = ctx.read('plan.verified.json')
    const before = JSON.stringify(fresh)
    for (const sc of fresh.scenes) {
      const l = res.value.get(sc.id)
      if (l) sc.landmark = l
    }
    for (const sc of targets) {
      const l = res.value.get(sc.id)
      if (l) log(`  ${sc.id}: ${l.subject} (${l.site_id}), reveal at ${l.reveal_at}${res.why[sc.id] ? `: ${res.why[sc.id]}` : ''}`)
      else log(`  WARNING: ${sc.id} has no usable landmark${sc.landmark ? ' (keeping the earlier one)' : ''}`)
    }
    if (JSON.stringify(fresh) === before) return log('  art: plan.verified.json unchanged')
    ctx.write('plan.verified.json', fresh)
    log(`  art: wrote ${res.value.size} landmark(s) into plan.verified.json`)
  },
}
