// Code-side checks of the director's output: structure and evidence only, never taste.
// Each check returns { value (fixed copy), problems (for the model to fix), notes (silent fixes), stats }.
import { KINDS } from './schemas.mjs'
import { mapSiteId, resolveStation } from './evidence.mjs'
import { timingOptions } from '../stages/timing.mjs'

const IMG_KINDS = new Set(['title', 'illustration', 'personal', 'end'])
const PAUSE = /<#\s*([\d.]+)\s*#>/g
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|org|net|gov|in|io)(?:\/\S*)?\b/gi
// "each/every stop/station ... older / further back in time": only true where the dates prove it
const FALSE_ORDER = /\b(each|every)\s+(?:single\s+)?(stop|station)\b[^.!?]{0,80}\b(older|further back|farther back|deeper into (?:the past|time)|back in time|earlier century)\b/i
const uniq = (a) => [...new Set(a.filter(Boolean))]
const clone = (v) => JSON.parse(JSON.stringify(v ?? null))

export const stripPauses = (t) => String(t || '').replace(PAUSE, ' ').replace(/\s+/g, ' ').trim()
export const wordCount = (t) => stripPauses(t).split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length
export const pauseSeconds = (t) => [...String(t || '').matchAll(PAUSE)].reduce((s, m) => s + Number(m[1] || 0), 0)
const firstSentence = (t) => stripPauses(String(t || '').split(PAUSE)[0]).split(/(?<=[.!?…])\s+/)[0] || ''

/** Length targets derived from project.yaml (target_seconds, optional director: {...}, timing: {...}). */
// words_per_second: measure the chosen voice (speech only, without pauses); edge: silence a TTS clip
// carries at its ends (MiniMax speech 2.8: ~0.6 s)
export function limits(config) {
  const d = config.director || {}
  const target = config.target_seconds || 150
  return {
    target,
    wps: d.words_per_second ?? 2.3,
    edge: d.clip_edge_seconds ?? 0.6,
    timing: timingOptions(config),
    minWords: d.min_words ?? Math.round(target * 2.0),
    maxWords: d.max_words ?? Math.round(target * 2.2),
    minScenes: d.min_scenes ?? 10,
    maxScenes: d.max_scenes ?? 14,
    maxImages: d.max_images ?? 7,
    maxCps: d.max_cps ?? 17,
    hookWords: d.hook_words ?? 10,
    maxSeconds: Number(config.max_seconds ?? 178),
  }
}

// figures in narration: years, and other numbers in digits ("1,600") or words ("five thousand");
// one figure may span several tokens ("700 million", "hundreds of thousands")
const NUM_TOKEN = /\b\d[\d,]*(?:\.\d+)?\b|\b(?:hundred|thousand|million|billion|lakh|crore)s?\b/gi
const isYear = (s) => /^\d{4}$/.test(s) && +s >= 1000 && +s <= 2100
export function figures(text) {
  const t = stripPauses(text)
  const years = []
  const others = []
  let last = null
  for (const m of t.matchAll(NUM_TOKEN)) {
    const tok = m[0]
    const joins = last && !isYear(tok) && !isYear(last.text) && /^\s*(?:of|a)?\s*$/i.test(t.slice(last.end, m.index))
    if (joins) others[others.length - 1] += ` ${tok}`
    else (isYear(tok) ? years : others).push(tok)
    last = { text: joins ? 'x' : tok, end: m.index + tok.length }
  }
  return { years, others }
}

/** On-screen year "1912-1931" / "c. 1303" / "300 BC" -> { lo, hi } (signed years) or null. */
export function eraOf(year) {
  const s = String(year || '')
  const nums = (s.match(/\d{3,4}/g) || []).map(Number)
  if (!nums.length) return null
  const sign = /\bB\.?\s?C/i.test(s) ? -1 : 1
  return { lo: sign * nums[0], hi: sign * nums.at(-1) }
}

/** A site's dates in the evidence: its Wikidata inception, or the years of facts about it / curated facts naming it. */
export function siteYears(ev, mapId) {
  const g = [...ev.groundSites.values()].find((s) => s.geo_site_id === mapId || s.id === mapId)
  const label = g?.label || ev.geoSites.get(mapId)?.name || mapId
  if (g?.inception_year != null) return { years: [g.inception_year], label }
  const name = String(label).toLowerCase()
  const years = []
  for (const f of ev.facts.values()) {
    if (f.year == null) continue
    if ((g && f.site_id === g.id) || (f.origin === 'facts_file' && name.length > 3 && String(f.claim).toLowerCase().includes(name))) years.push(f.year)
  }
  return { years, label }
}

/** Why the first lit site of a map scene contradicts its year card, or null. */
export function eraProblem(sc, ev, slack = 50) {
  const era = eraOf(sc.on_screen?.year)
  const id = sc.map?.focus_site_ids?.[0]
  if (sc.kind !== 'map' || !era || !id) return null
  const { years, label } = siteYears(ev, id)
  const card = `the year card says "${sc.on_screen.year}", but the first lit site ${id} (${label})`
  if (!years.length) return `${sc.id}: ${card} has no date in the evidence, so the card would date it: light only sites from the card's era (or none)`
  if (!years.some((y) => y >= Math.min(era.lo, era.hi) - slack && y <= Math.max(era.lo, era.hi) + slack)) return `${sc.id}: ${card} dates from ${years[0]}: light only sites from the card's era (or none)`
  return null
}

function stripUrls(text, where, problems) {
  const s = String(text ?? '')
  if (!URL_RE.test(s)) return s
  URL_RE.lastIndex = 0
  problems.push(`${where} contains a URL or web address; narration and captions must never contain one`)
  return s.replace(URL_RE, '').replace(/\s+/g, ' ').trim()
}

export function checkTreatment(raw, ev) {
  const t = clone(raw) || {}
  const problems = []
  const notes = []
  const sb = (t.style_bible ||= {})
  for (const k of ['narrator_persona', 'illustration_style', 'music_direction']) if (!String(sb[k] || '').trim()) problems.push(`style_bible.${k} is empty`)
  if (!Array.isArray(sb.palette) || sb.palette.length < 3) problems.push('style_bible.palette needs 4-6 colours')
  if (!Array.isArray(sb.title_options) || sb.title_options.length < 2) problems.push('style_bible.title_options needs 3-5 titles')
  if (!String(t.time_direction || '').trim()) problems.push('time_direction is empty: state honestly how the dates relate to the ride order')
  for (const k of ['time_direction', 'hook', 'logline']) if (FALSE_ORDER.test(t[k] || '')) problems.push(`${k} claims every stop is older than the last; the dates do not support that`)

  const stops = []
  for (const s of t.stops || []) {
    const id = resolveStation(ev, s.station_id)
    if (!id) {
      problems.push(`stop "${s.station_id}" is not a station id on the ride`)
      continue
    }
    const facts = (s.fact_ids || []).filter((f) => ev.facts.has(f))
    const bad = (s.fact_ids || []).filter((f) => !ev.facts.has(f))
    if (bad.length) notes.push(`stop ${id}: dropped unknown fact ids ${bad.join(', ')}`)
    const sites = uniq((s.site_ids || []).map((x) => mapSiteId(ev, x)))
    if (!facts.length) problems.push(`stop ${id} has no valid fact_ids: every stop needs at least one fact from the evidence`)
    stops.push({ ...s, station_id: id, fact_ids: facts, site_ids: sites })
  }
  stops.sort((a, b) => ev.stationById.get(a.station_id).km - ev.stationById.get(b.station_id).km)
  if (stops.length < 4 || stops.length > 6) problems.push(`choose 4-6 stops (you chose ${stops.length})`)
  t.stops = stops
  for (const k of ['kept_coming', 'personal']) {
    t[k] ||= {}
    const ids = t[k].fact_ids || []
    t[k].fact_ids = ids.filter((f) => ev.facts.has(f))
    if (t[k].fact_ids.length < ids.length) notes.push(`${k}: dropped unknown fact ids`)
  }
  if (!t.kept_coming.fact_ids.length) problems.push('kept_coming needs fact_ids from the evidence')
  if (!Array.isArray(t.arc) || t.arc.length < 4) problems.push('arc needs the four parts: hook, ride, kept_coming, personal')
  return { value: t, problems, notes }
}

/** Estimated film length, by the timing stage's own rule: lead + clip (speech, pauses, edge silence) + tail per scene. */
export function estimate(scenes, L) {
  const o = L.timing || timingOptions()
  let total = 0
  let speech = 0
  const per = scenes.map((sc, i) => {
    const w = wordCount(sc.narration)
    const talk = w / L.wps + pauseSeconds(sc.narration) + (w ? L.edge ?? 0.6 : 0)
    speech += w / L.wps
    const last = i === scenes.length - 1 || sc.kind === 'end'
    let len = w ? o.lead + talk + (last ? Math.max(o.tail, o.endTail) : o.tail) : 0
    len = Math.max(len, sc.kind === 'title' ? o.minTitle : sc.kind === 'end' ? o.minEnd : o.min)
    total += len
    return { id: sc.id, kind: sc.kind, words: w, seconds: +len.toFixed(1) }
  })
  return { per, total: +total.toFixed(1), speech }
}

export function checkPlan(raw, ev, config, { styleBible } = {}) {
  const L = limits(config)
  const p = clone(raw) || {}
  const problems = []
  const notes = []
  p.scenes = Array.isArray(p.scenes) ? p.scenes : []
  p.claims = Array.isArray(p.claims) ? p.claims : []
  if (!String(p.title || '').trim()) problems.push('title is empty')

  // ids: s01.. in order; claims follow their scene
  const idMap = new Map()
  p.scenes = p.scenes.filter((sc) => sc && typeof sc === 'object')
  p.scenes.forEach((sc, i) => {
    const id = `s${String(i + 1).padStart(2, '0')}`
    if (sc.id && sc.id !== id) notes.push(`renumbered scene ${sc.id} -> ${id}`)
    if (sc.id) idMap.set(sc.id, id)
    sc.id = id
  })

  const n = p.scenes.length
  if (n < L.minScenes || n > L.maxScenes) problems.push(`use ${L.minScenes}-${L.maxScenes} scenes (you have ${n})`)
  if (n && p.scenes[0].kind !== 'title') problems.push('the first scene must be kind "title" (the hook over the title image)')
  if (n && p.scenes[n - 1].kind !== 'end') problems.push('the last scene must be kind "end"')
  const maps = p.scenes.filter((s) => s.kind === 'map').length
  if (maps < Math.min(5, n / 2)) problems.push(`only ${maps} map scenes: the ride on the map is the spine of the film (use at least 5)`)
  const images = p.scenes.filter((s) => IMG_KINDS.has(s.kind)).length
  if (images > L.maxImages) problems.push(`${images} scenes need an illustration (title/illustration/personal/end); keep it to ${L.maxImages} or fewer and let map scenes carry the rest`)
  if (!p.scenes.some((s) => s.kind === 'personal')) problems.push('no "personal" scene: the film must end on the personal last stop')

  let lastKm = -Infinity
  for (const sc of p.scenes) {
    if (!KINDS.includes(sc.kind)) {
      problems.push(`${sc.id}: unknown kind "${sc.kind}"`)
      sc.kind = 'illustration'
    }
    sc.narration = stripUrls(sc.narration, `${sc.id} narration`, problems).replace(/<#\s*([\d.]+)\s*#>/g, (_, s) => `<#${Math.min(2, Math.max(0.2, +s)).toFixed(1)}#>`)
    if (FALSE_ORDER.test(sc.narration)) problems.push(`${sc.id}: "${sc.narration.match(FALSE_ORDER)[0]}" claims every stop is older than the last; the dates do not support that`)
    if (/[<>{}\[\]]/.test(stripPauses(sc.narration))) problems.push(`${sc.id}: narration contains markup other than <#x#> pauses`)
    if (/[()]/.test(sc.narration || '')) problems.push(`${sc.id}: narration has parentheses, which the voice reads flat; say it as a plain clause`)
    // map scenes (under a year card): one date and one other number at most; elsewhere 2 figures in all
    const fig = figures(sc.narration)
    const listy = sc.kind === 'map' ? fig.years.length > 1 || fig.others.length > 1 : fig.years.length + fig.others.length > 2
    if (listy) problems.push(`${sc.id} says ${[...fig.years, ...fig.others].join(', ')}: a list of figures. The year card already shows the era, so say at most one date and one other number per scene (the one that is the point) and spend the words on one sensory detail`)
    const os = (sc.on_screen ||= {})
    os.headline = stripUrls(os.headline || '', `${sc.id} headline`, problems)
    os.year = String(os.year ?? '')
    os.subtitle_lang = config.language || 'en'
    if (os.headline.length > 30) problems.push(`${sc.id}: headline "${os.headline}" is longer than 24 characters`)

    sc.fact_ids = uniq((sc.fact_ids || []).filter((f) => ev.facts.has(f)))
    sc.source_ids = uniq((sc.source_ids || []).filter((s) => ev.sources.has(s)))

    if (sc.kind === 'map') {
      const m = (sc.map ||= {})
      const to = resolveStation(ev, m.train_to)
      const focus = resolveStation(ev, m.focus_station) || to
      if (m.train_to && !to) notes.push(`${sc.id}: unknown train_to "${m.train_to}" removed`)
      if (!to && !focus) problems.push(`${sc.id}: map scene needs map.train_to or map.focus_station (a station id)`)
      if (to) {
        const km = ev.stationById.get(to).km
        if (km < lastKm) {
          notes.push(`${sc.id}: train_to ${to} would ride backwards; kept as focus only`)
          m.train_to = ''
        } else {
          m.train_to = to
          lastKm = km
        }
      } else m.train_to = ''
      if (!m.train_to) delete m.train_to
      m.focus_station = focus || undefined
      const sites = (m.focus_site_ids || []).map((x) => mapSiteId(ev, x))
      if (sites.some((x) => !x)) notes.push(`${sc.id}: dropped focus_site_ids not on the map`)
      m.focus_site_ids = uniq(sites)
      m.zoom = Math.min(16.5, Math.max(11, Number(m.zoom) || 14))
      const era = eraProblem(sc, ev)
      if (era) problems.push(era)
    } else if (sc.map) {
      const focus = resolveStation(ev, sc.map.focus_station)
      if (focus) sc.map = { focus_station: focus, focus_site_ids: uniq((sc.map.focus_site_ids || []).map((x) => mapSiteId(ev, x))) }
      else delete sc.map
    }

    if (IMG_KINDS.has(sc.kind)) {
      if (!String(sc.image_prompt || '').trim()) problems.push(`${sc.id} (${sc.kind}) needs an image_prompt`)
      else sc.image_prompt = withStyle(sc.image_prompt, styleBible)
    } else delete sc.image_prompt
  }

  // claims
  const sceneIds = new Set(p.scenes.map((s) => s.id))
  const claims = []
  for (const c of p.claims) {
    const sid = idMap.get(c.scene_id) || c.scene_id
    if (!sceneIds.has(sid)) {
      notes.push(`dropped claim "${String(c.text).slice(0, 60)}" (unknown scene ${c.scene_id})`)
      continue
    }
    const kind = c.kind === 'personal' ? 'personal' : 'fact'
    const src = uniq((c.source_ids || []).filter((s) => ev.sources.has(s)))
    const bad = (c.source_ids || []).filter((s) => !ev.sources.has(s))
    if (bad.length) notes.push(`claim "${String(c.text).slice(0, 50)}": removed unknown source ids ${bad.join(', ')}`)
    if (kind === 'fact' && !src.length) problems.push(`claim "${String(c.text).slice(0, 80)}" (${sid}) has no valid source_ids: cite the source ids from the evidence, or remove the statement`)
    claims.push({ id: '', scene_id: sid, text: stripUrls(c.text, `claim in ${sid}`, problems), kind, source_ids: kind === 'personal' ? [] : src })
  }
  claims.sort((a, b) => a.scene_id.localeCompare(b.scene_id))
  claims.forEach((c, i) => (c.id = `c${String(i + 1).padStart(2, '0')}`))
  p.claims = claims
  for (const sc of p.scenes) {
    const mine = claims.filter((c) => c.scene_id === sc.id)
    sc.source_ids = uniq([...sc.source_ids, ...mine.flatMap((c) => c.source_ids)])
    if (sc.fact_ids.length && !mine.length) problems.push(`${sc.id} uses facts (${sc.fact_ids.join(', ')}) but has no claims: list every factual statement as a claim`)
  }

  // length, hook, subtitle speed
  const est = estimate(p.scenes, L)
  const words = est.per.reduce((s, x) => s + x.words, 0)
  const chars = p.scenes.reduce((s, sc) => s + stripPauses(sc.narration).length, 0)
  const cps = est.speech ? chars / est.speech : 0
  const tooFew = words < Math.floor(L.minWords * 0.97)
  const tooMany = words > Math.ceil(L.maxWords * 1.03)
  if (tooFew || tooMany) {
    const per = est.per.map((x) => `${x.id} ${x.words}`).join(', ')
    problems.push(`narration totals ${words} words; it must be ${L.minWords}-${L.maxWords} (${tooMany ? `cut about ${words - L.maxWords}` : `add about ${L.minWords - words}`} words). Words per scene: ${per}`)
  }
  for (const x of est.per) if (x.words > 45) problems.push(`${x.id} has ${x.words} words; keep scenes to 8-40 words (split it or cut)`)
  // back-to-back scenes that open the same way ("In 1982 ...", "In 1982 ...") read as a list
  const opening = (sc) => stripPauses(sc.narration).toLowerCase().split(/\s+/).slice(0, 2).join(' ').replace(/[^\p{L}\p{N} ]/gu, '')
  for (let i = 1; i < p.scenes.length; i++) {
    const a = opening(p.scenes[i - 1])
    if (a.includes(' ') && a === opening(p.scenes[i])) problems.push(`${p.scenes[i].id} opens like ${p.scenes[i - 1].id} ("${a}..."): vary it (e.g. "That same year, ...")`)
  }
  const lastPersonal = p.scenes.filter((s) => s.kind === 'personal').at(-1)
  if (lastPersonal) {
    const parts = String(lastPersonal.narration || '').split(PAUSE)
    const after = stripPauses(parts.length > 1 ? parts.at(-1) : '')
    if (!after || after.split(/(?<=[.!?…])\s+/).length > 2) problems.push(`${lastPersonal.id}: end the last personal scene on its reveal: the final short line alone, after a <#0.8#> pause`)
  }
  if (est.total > L.maxSeconds) problems.push(`the film would run about ${est.total} s, over the ${L.maxSeconds} s limit: cut about ${Math.ceil((est.total - L.maxSeconds + 8) * L.wps)} words`)
  const hook = firstSentence(p.scenes[0]?.narration)
  const hookWords = wordCount(hook)
  if (!hookWords) problems.push('s01 has no narration: the hook must be spoken in the first 5 seconds')
  else if (hookWords > L.hookWords + 1) problems.push(`the hook "${hook}" is ${hookWords} words; the first sentence must be <= ${L.hookWords} words so it lands in the first 5 seconds`)
  if (cps > L.maxCps) problems.push(`subtitles would run at ${cps.toFixed(1)} characters/second (max ${L.maxCps}); use shorter words and sentences`)

  // music + cover
  p.music_prompt = String(p.music_prompt || '').trim()
  if (!p.music_prompt) problems.push('music_prompt is empty')
  else if (!/\b\d{2,3}\s*(?:-|\s)?(?:s|sec|secs|seconds?)\b|\bminutes?\b/i.test(p.music_prompt)) {
    p.music_prompt = `${p.music_prompt.replace(/[.\s]+$/, '')}. Total length about ${L.target} seconds.`
    notes.push('music_prompt: appended the total length')
  }
  p.cover_prompt = String(p.cover_prompt || '').trim()
  if (!p.cover_prompt) problems.push('cover_prompt is empty')
  else p.cover_prompt = withStyle(p.cover_prompt, styleBible)

  const stats = { scenes: n, words, chars, est_seconds: est.total, cps: +cps.toFixed(1), hook, hook_words: hookWords, map_scenes: maps, image_scenes: images, claims: claims.length, per_scene: est.per }
  return { value: p, problems: uniq(problems), notes, stats }
}

/**
 * Render normalisation (after the director is done): in each map scene the train arrives at the
 * station the scene is about (focus_station), riding forward only; a station behind the train is
 * looked at without moving it. Returns notes; mutates plan.
 */
export function alignTrain(plan, ev) {
  const notes = []
  let lastKm = -Infinity
  for (const sc of plan.scenes || []) {
    const m = sc.map
    if (sc.kind !== 'map' || !m) continue
    const focus = resolveStation(ev, m.focus_station) || resolveStation(ev, m.train_to)
    if (!focus) continue
    m.focus_station = focus
    const km = ev.stationById.get(focus).km
    if (km >= lastKm) {
      if (m.train_to !== focus) notes.push(`${sc.id}: train_to ${m.train_to || '(none)'} -> ${focus} (arrive at the scene's station)`)
      m.train_to = focus
      lastKm = km
    } else if (m.train_to) {
      notes.push(`${sc.id}: ${focus} is behind the train; camera looks back, train stays`)
      delete m.train_to
    }
  }
  return notes
}

/**
 * Render normalisation of lit sites (after the director is done): a map scene's first lit site is the
 * one its year card dates, so a site from another era (or with no date) is dropped rather than shown
 * under the wrong year. Returns notes; mutates plan.
 */
export function alignSites(plan, ev) {
  const notes = []
  for (const sc of plan.scenes || []) {
    let why
    while ((why = eraProblem(sc, ev))) {
      notes.push(`dropped a lit site: ${why}`)
      sc.map.focus_site_ids = sc.map.focus_site_ids.slice(1)
    }
  }
  return notes
}

/** Make sure an image prompt carries the director's own illustration style (from the style bible). */
export function withStyle(prompt, styleBible) {
  const style = String(styleBible?.illustration_style || '').trim().replace(/[.\s]+$/, '')
  let out = String(prompt).trim().replace(/\s+/g, ' ')
  if (!style) return out
  const key = style.toLowerCase().slice(0, 40)
  if (!out.toLowerCase().includes(key)) out = `${out.replace(/[.\s]+$/, '')}. ${style}.`
  return out
}
