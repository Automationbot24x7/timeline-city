// Stage `timing`: scene windows, voice offsets, subtitle cues and citation windows -> build/timeline.json.
// Cues are timed ∝ characters inside each voice clip, anchored to the real pauses found by silencedetect.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const MAX_LINE = 42 // subtitle chars per line (2 lines max)
const MAX_CHIP = 2 // publishers named on a citation chip (the full list goes to sources.txt)
export const MAX_SECONDS = 178 // contest limit is 180 s; a real (non-mock) film longer than this is refused
const PAUSE = /<#\s*([\d.]+)\s*#>/g
const ABBR = /\b(c|ca|St|Dr|Mr|Mrs|Ms|Mt|vs|etc|e\.g|i\.e|No|Jr|Sr)\.$/i
const WEAK_END = /\b(a|an|the|of|to|in|and|at|on|my|by|for|with|from|I)$/i

/** Scene length rule (shared with assets, which sizes the music from it, and the director's estimate). */
// endTail: the last scene holds 5 s after its voice, so the closing line lands before credits and the fade
export function timingOptions(config = {}) {
  return { lead: 0.5, tail: 0.7, min: 3, minTitle: 4, minEnd: 5, endTail: 5.0, ...(config.timing || {}) }
}

export function sceneLength(scene, voiceDur, o, isLast = false) {
  const tail = isLast || scene.kind === 'end' ? Math.max(o.tail, o.endTail) : o.tail
  const len = voiceDur ? o.lead + voiceDur + tail : 0
  const min = scene.kind === 'title' ? o.minTitle : scene.kind === 'end' ? o.minEnd : o.min
  return Math.max(len, min)
}

export function readPlan(ctx) {
  const plan = ctx.read('plan.verified.json', null)
  if (plan?.verification?.passed === false) ctx.log(`  warning: verify did not pass (${(plan.verification.failing_scenes || []).join(', ') || 'see verify.json'})`)
  if (plan) return plan
  ctx.log('  warning: plan.verified.json missing, using unverified plan.json')
  return ctx.read('plan.json')
}

export const stripPauses = (text = '') => text.replace(PAUSE, ' ').replace(/\s+/g, ' ').trim()

/** "a <#0.5#> b" -> [{ text: 'a', pause: 0.5 }, { text: 'b', pause: 0 }] */
export function splitPauses(text = '') {
  const parts = []
  let last = 0
  for (const m of text.matchAll(PAUSE)) {
    parts.push({ text: stripPauses(text.slice(last, m.index)), pause: Number(m[1]) || 0 })
    last = m.index + m[0].length
  }
  parts.push({ text: stripPauses(text.slice(last)), pause: 0 })
  // fold empty text parts (leading/double markers) into neighbouring pauses
  const out = []
  let carry = 0
  for (const p of parts) {
    if (!p.text) {
      if (out.length) out[out.length - 1].pause += p.pause
      else carry += p.pause
      continue
    }
    out.push({ ...p, lead: carry })
    carry = 0
  }
  if (out.length) out[out.length - 1].pause = 0
  return out
}

/** Speaking weight: characters, with extra for digits (years are long to say) and punctuation pauses. */
export function weight(text) {
  let w = 0
  for (const ch of text) w += /[0-9]/.test(ch) ? 3.5 : /[,;:—–]/.test(ch) ? 3 : /[.!?…]/.test(ch) ? 5 : 1
  return Math.max(w, 1)
}

/** Best ≤2-line layout (≤ MAX_LINE each), preferring breaks after punctuation and balanced lines; null if impossible. */
export function wrapLines(text, max = MAX_LINE) {
  if (text.length <= max) return [text]
  let best = null
  for (let i = text.indexOf(' '); i !== -1; i = text.indexOf(' ', i + 1)) {
    const a = text.slice(0, i)
    const b = text.slice(i + 1)
    if (a.length > max || b.length > max) continue
    const score = Math.abs(a.length - b.length) - (/[,;:.!?—–]$/.test(a) ? 14 : 0) + (WEAK_END.test(a) ? 6 : 0)
    if (!best || score < best.score) best = { score, lines: [a, b] }
  }
  return best?.lines || null
}
const fits = (t) => !!wrapLines(t)

function splitSentences(text) {
  const out = []
  const re = /[.!?…]+["'”’)]?\s+/g
  let start = 0
  for (let m; (m = re.exec(text)); ) {
    const end = m.index + m[0].length
    const piece = text.slice(start, end).trim()
    if (ABBR.test(piece) || /^[a-z0-9]/.test(text[end] || '')) continue
    out.push(piece)
    start = end
  }
  if (start < text.length) out.push(text.slice(start).trim())
  return out.filter(Boolean)
}

/** Split an over-long clause at words into the fewest balanced chunks that each fit. */
function splitWords(text) {
  const words = text.split(' ')
  for (let n = 2; n <= words.length; n++) {
    const target = text.length / n
    const chunks = []
    let cur = ''
    for (const w of words) {
      const cand = cur ? `${cur} ${w}` : w
      if (cur && cand.length > target + 6 && chunks.length < n - 1) {
        chunks.push(cur)
        cur = w
      } else cur = cand
    }
    chunks.push(cur)
    if (chunks.every(fits)) return chunks
  }
  return words
}

/** Subtitle cue texts for one stretch of speech: split at sentences, then clauses, then words. */
export function splitCues(text) {
  text = stripPauses(text)
  if (!text) return []
  const pieces = []
  for (const s of splitSentences(text)) {
    if (fits(s)) {
      pieces.push(s)
      continue
    }
    const clauses = s.split(/(?<=[,;:—–])\s+|\s+(?=[—–]\s)/)
    let cur = ''
    for (const c of clauses) {
      const cand = cur ? `${cur} ${c}` : c
      if (fits(cand)) {
        cur = cand
        continue
      }
      if (cur) pieces.push(cur)
      if (fits(c)) cur = c
      else {
        const chunks = splitWords(c)
        pieces.push(...chunks.slice(0, -1))
        cur = chunks.at(-1)
      }
    }
    if (cur) pieces.push(cur)
  }
  // merge very short pieces into a neighbour when the result still fits two lines
  const out = []
  for (const p of pieces) {
    const prev = out.at(-1)
    if (prev && (prev.length < 18 || p.length < 12) && fits(`${prev} ${p}`)) out[out.length - 1] = `${prev} ${p}`
    else out.push(p)
  }
  return out
}

/** Silences in an audio file: [{ start, end }] (seconds). */
export function detectSilences(file, duration, { noise = -40, min = 0.1 } = {}) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-nostdin', '-i', file, '-af', `silencedetect=noise=${noise}dB:d=${min}`, '-f', 'null', '-'], {
    encoding: 'utf8',
    maxBuffer: 32 << 20,
  })
  if (r.status !== 0) return []
  const out = []
  let cur = null
  for (const line of r.stderr.split(/\r?\n/)) {
    let m
    if ((m = line.match(/silence_start: (-?[\d.]+)/))) cur = { start: Math.max(0, Number(m[1])) }
    else if ((m = line.match(/silence_end: ([\d.]+)/)) && cur) {
      out.push({ ...cur, end: Number(m[1]) })
      cur = null
    }
  }
  if (cur) out.push({ ...cur, end: duration })
  return out
}

/**
 * Cues for one voice clip, in clip time. Pause markers are matched to real silences near their
 * expected position; cue boundaries inside a stretch snap to a nearby natural pause.
 */
export function clipCues(narration, duration, silences = []) {
  const parts = splitPauses(narration)
  if (!parts.length) return []
  let s0 = 0
  let s1 = duration
  const leadSil = silences.find((s) => s.start <= 0.02)
  if (leadSil && leadSil.end < duration * 0.5) s0 = leadSil.end
  const trailSil = silences.find((s) => s.end >= duration - 0.02 && s.start > s0 + 0.2)
  if (trailSil) s1 = trailSil.start
  const inner = silences.filter((s) => s.start > s0 + 0.05 && s.end < s1 - 0.05)
  const used = new Set()
  const pick = (expected, minDur, tol, lo, hi) => {
    let best = null
    for (const s of inner) {
      if (used.has(s) || s.end - s.start < minDur || s.start <= lo || s.end >= hi) continue
      const d = Math.abs((s.start + s.end) / 2 - expected)
      if (d <= tol && (!best || d < best.d)) best = { s, d }
    }
    if (best) used.add(best.s)
    return best?.s || null
  }

  // 1. stretches between pause markers
  const weights = parts.map((p) => weight(p.text))
  let cursor = s0 + (parts[0].lead || 0)
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k]
    p.t0 = cursor
    if (k === parts.length - 1) {
      p.t1 = Math.max(s1, cursor + 0.3)
      break
    }
    const restW = weights.slice(k).reduce((a, b) => a + b, 0)
    const restP = parts.slice(k).reduce((a, q) => a + q.pause, 0)
    let rate = (s1 - cursor - restP) / restW
    if (rate <= 0) rate = (s1 - cursor) / (restW + restP * 14)
    const expectedEnd = cursor + weights[k] * rate
    const tol = Math.max(0.8, duration * 0.12)
    const sil = pick(expectedEnd + p.pause / 2, Math.max(0.15, p.pause * 0.5), tol, cursor + 0.2, s1)
    if (sil) {
      p.t1 = sil.start
      cursor = sil.end
    } else {
      p.t1 = expectedEnd
      cursor = expectedEnd + p.pause
    }
  }

  // 2. cues inside each stretch, ∝ weight, boundaries snapped to natural pauses
  const cues = []
  for (const p of parts) {
    const texts = splitCues(p.text)
    const ws = texts.map(weight)
    const total = ws.reduce((a, b) => a + b, 0)
    let t = p.t0
    const local = texts.map((text, i) => {
      const c = { text, t0: t, t1: t + ((p.t1 - p.t0) * ws[i]) / total }
      t = c.t1
      return c
    })
    for (let i = 0; i < local.length - 1; i++) {
      const b = local[i].t1
      const sil = pick(b, 0.15, 0.7, local[i].t0 + 0.4, local[i + 1].t1 - 0.4)
      if (sil) {
        local[i].t1 = sil.start
        local[i + 1].t0 = sil.end
      }
    }
    // keep a cue on screen through short gaps inside a stretch
    for (let i = 0; i < local.length - 1; i++) if (local[i + 1].t0 - local[i].t1 < 0.6) local[i].t1 = local[i + 1].t0
    cues.push(...local)
  }
  return cues
}

const r3 = (x) => Math.round(x * 1000) / 1000

function publisherOf(src) {
  if (src?.publisher) return src.publisher
  try {
    const host = new URL(src.url).hostname.replace(/^www\./, '')
    if (host.endsWith('wikipedia.org')) return 'Wikipedia'
    if (host.endsWith('wikidata.org')) return 'Wikidata'
    if (host.endsWith('unesco.org')) return 'UNESCO'
    if (host.includes('asi.nic.in')) return 'ASI'
    return host
  } catch {
    return src?.id || '?'
  }
}

// Chip order: the strongest authority first. 0 official/primary (UNESCO, ASI, census, courts,
// government), 1 encyclopaedia, major press, academic, 2 Wikipedia/Wikidata, 3 other sites,
// 4 the map and the operator (true, but rarely what the narration is saying).
const AUTH = [
  [0, /\b(unesco|asi|archaeological survey|census|government|gazette|supreme court|high court|ministry|department|pib|un desa|parliament|rashtrapati bhavan|development authority|sports authority|olympic council)\b/i],
  [4, /^(openstreetmap|dmrc)\b/i],
  [2, /^(wikipedia|wikidata)$/i],
  [1, /\b(britannica|the hindu|times of india|hindustan times|indian express|tribune|business standard|mint|the wire|theprint|outlook|the week|bbc|guardian|new york times|christian science monitor|statesman|ndtv|railway gazette|university|press|journal|museum)\b|&/i],
]
const AUTH_HOST = [[0, /\.(gov|nic)\.in$|\.gov(\.[a-z]{2})?$|(^|\.)un\.org$/], [1, /\.(edu|ac\.[a-z]{2})$|(cambridge|springer|jstor|oup|tandfonline|sagepub)\./]]
export function authority(pub, url) {
  let host = ''
  try {
    host = new URL(url).hostname.replace(/^www\./, '')
  } catch {}
  return (AUTH.find(([, re]) => re.test(pub)) || AUTH_HOST.find(([, re]) => re.test(host)) || [3])[0]
}
/** Short chip name: "Supreme Court of India judgment text" -> "Supreme Court of India", "scroll.in" kept, "x.com" -> "x". */
export const chipName = (p) =>
  String(p).split(' / ')[0].replace(/\s+(judgment text|website|collection|data|archive search)$/i, '').replace(/^([\w-]+(?:\.[\w-]+)*)\.(com|org|net)$/i, '$1').trim()

export const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
/** Names a site may be called in narration: its labels, alt names, and "Siri" for "Siri Fort". */
export function siteNames(site, groundSite) {
  const t = site?.tags || {}
  const raw = [site?.display_name, site?.name, t['name:en'], t.alt_name, t.old_name, groundSite?.label].flatMap((n) => String(n || '').split(';'))
  const out = new Set()
  for (const n of raw.map(norm).filter((x) => x.length > 2)) {
    out.add(n)
    const short = n.replace(/\s+(fort|complex|monument|ruins|park|precinct)$/, '')
    if (short !== n && short.length > 3) out.add(short)
  }
  return [...out]
}

/** When each focus site is first named in its scene's cues: [{ site_id, t }] (film seconds). */
export function mentionsOf(scene, cues, sites, groundSites) {
  const out = []
  for (const id of scene.map?.focus_site_ids || []) {
    const names = siteNames(sites.get(id), groundSites.get(id))
    let hit = null
    for (const c of cues) {
      const text = norm(c.text)
      for (const n of names) {
        const i = ` ${text} `.indexOf(` ${n} `)
        // interpolate inside the cue by character position (cues are timed ∝ characters too)
        const at = i < 0 ? null : c.start + (i / Math.max(text.length, 1)) * (c.end - c.start)
        if (at !== null && (hit === null || at < hit)) hit = at
      }
      if (hit !== null) break
    }
    if (hit !== null) out.push({ site_id: id, t: r3(hit) })
  }
  return out
}

// ---------- the train and the landmark paintings ----------

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
export const REVEAL_AFTER_ARRIVAL = 1.2 // a painting never covers the train's arrival
export const MIN_PAINTING = 4.0 // seconds a landmark painting stays on screen before its scene ends

/**
 * The train schedule, as render/renderer.js buildSchedule rides it: the train starts at the first
 * scene's train_to station; in a scene that sends it to another station it leaves 0.3 s in and rides
 * clamp(1.6 + 0.5 x km, 2.4, max(2.4, min(8.5, 0.6 x scene length))) s. Returns Map(scene id ->
 * { arrive, travel? }) for map scenes: arrive = film time the train stands at its station (the scene
 * start when it is already there); travel = { from, to, t0, t1, km } when it rides in this scene.
 */
export function trainSchedule(scenes, stations = []) {
  const byId = new Map(stations.map((s) => [s.id, s]))
  const atKm = (km) => stations.find((s) => Math.abs(s.km - km) < 0.02)?.id || null
  const first = scenes.find((s) => byId.has(s.plan?.map?.train_to))
  let cur = first ? byId.get(first.plan.map.train_to).km : 0
  const out = new Map()
  for (const s of scenes) {
    const to = byId.get(s.plan?.map?.train_to)
    if (to && Math.abs(to.km - cur) > 0.02) {
      const km = Math.abs(to.km - cur)
      const dur = clamp(1.6 + 0.5 * km, 2.4, Math.max(2.4, Math.min(8.5, 0.6 * (s.end - s.start))))
      const t0 = s.start + 0.3
      out.set(s.id, { arrive: r3(t0 + dur), travel: { from: atKm(cur), to: to.id, t0: r3(t0), t1: r3(t0 + dur), km: r3(km) } })
      cur = to.km
    } else if (s.kind === 'map') out.set(s.id, { arrive: r3(s.start) })
  }
  return out
}

/**
 * When a map scene's landmark painting appears (film seconds): when the narration first names the
 * landmark (reveal_at "named"), else 1.2 s after the train arrives; never before that, and early
 * enough to stay MIN_PAINTING s (a "named" that comes too late falls back to the arrival).
 */
export function revealOf(scene, arrive, mentions = [], landmark = {}) {
  const floor = arrive + REVEAL_AFTER_ARRIVAL
  let t = floor
  let from = 'arrival'
  const named = landmark.reveal_at === 'named' ? mentions.find((m) => m.site_id === landmark.site_id)?.t : undefined
  if (named != null) {
    if (named >= floor && scene.end - named >= MIN_PAINTING) [t, from] = [named, 'named']
    else if (named >= floor) from = 'arrival (named too late)'
  }
  if (scene.end - t < MIN_PAINTING) {
    t = Math.max(arrive, scene.end - MIN_PAINTING)
    from += ' (short scene)'
  }
  return { reveal: r3(t), from }
}

export const stage = {
  name: 'timing',
  outputs: ['timeline.json'],
  async run(ctx) {
    const plan = readPlan(ctx)
    const assets = ctx.read('assets.json')
    const ground = ctx.read('ground.json', { sources: [] })
    const geo = ctx.read('geo.json', { sites: [] })
    const sources = new Map((ground.sources || []).map((s) => [s.id, s]))
    const geoSites = new Map((geo.sites || []).map((s) => [s.id, s]))
    const groundSites = new Map((ground.stations || []).flatMap((st) => (st.sites || []).map((s) => [s.geo_site_id || s.id, s])))
    const o = timingOptions(ctx.config)
    const scenes = []
    const cues = []
    let t = 0
    plan.scenes.forEach((sc, i) => {
      const v = assets.voice?.[sc.id]
      const len = sceneLength(sc, v?.duration, o, i === plan.scenes.length - 1)
      const start = t
      const end = t + len
      const voice = v ? { file: v.file, start: o.lead, duration: r3(v.duration) } : null
      if (v && stripPauses(sc.narration)) {
        const abs = path.join(ctx.buildDir, v.file)
        const sil = detectSilences(abs, v.duration)
        for (const c of clipCues(sc.narration, v.duration, sil)) {
          cues.push({ start: start + o.lead + c.t0, end: start + o.lead + c.t1, text: c.text, scene: sc.id })
        }
      }
      scenes.push({ id: sc.id, kind: sc.kind, start: r3(start), end: r3(end), voice, image: assets.images?.[sc.id]?.file ?? null, plan: sc })
      t = end
    })
    // linger 0.3 s after speech, never overlapping the next cue
    for (let i = 0; i < cues.length; i++) {
      const next = cues[i + 1]
      cues[i].end = Math.min(cues[i].end + 0.3, next ? next.start - 0.05 : t)
    }
    const schedule = trainSchedule(scenes, geo.stations || [])
    for (const s of scenes) {
      const m = mentionsOf(s.plan, cues.filter((c) => c.scene === s.id), geoSites, groundSites)
      if (m.length) s.mentions = m
      const tr = schedule.get(s.id)
      if (tr) {
        s.arrive = tr.arrive
        if (tr.travel) s.travel = tr.travel
      }
      if (s.kind !== 'map') continue
      // a landmark painting (art step + assets): the map gives way to it at `reveal`, the 3D view goes to an inset
      const lm = s.plan.landmark
      const img = assets.images?.[s.id]
      if (!lm || !img?.file || !tr) {
        s.image = null
        continue
      }
      const { reveal, from } = revealOf(s, tr.arrive, s.mentions, lm)
      Object.assign(s, { image: img.file, reveal, reveal_from: from })
      ctx.log(`  ${s.id}: ${lm.subject} painting from ${reveal.toFixed(2)} s (${from}; train arrives ${tr.arrive.toFixed(2)} s), ${(s.end - reveal).toFixed(1)} s on screen`)
    }
    const citations = citationsOf(plan, scenes, cues, sources)
    const duration = r3(t)
    const cfg = ctx.config
    const timeline = {
      fps: cfg.fps || 30,
      duration,
      mock: !!assets.mock,
      title: cfg.title || plan.title, // the maker's working title (project.yaml `title`) wins
      scenes,
      cues: cues.map((c) => {
        const lines = wrapLines(c.text) || [c.text]
        return { start: r3(c.start), end: r3(c.end), text: lines.join('\n'), lines, scene: c.scene }
      }),
      citations: citations.map((c) => ({ ...c, start: r3(c.start), end: r3(c.end) })),
      attribution: 'Map data © OpenStreetMap contributors (ODbL)',
      credits: creditsOf(cfg, assets, plan, sources, hasFill(ctx)),
      ...(cfg.repo_url && { repo_url: String(cfg.repo_url) }),
      ...(cfg.dedication && { dedication: String(cfg.dedication).trim() }),
    }
    ctx.write('timeline.json', timeline)
    const long = timeline.cues.filter((c) => c.lines.length > 2 || c.lines.some((l) => l.length > MAX_LINE))
    if (long.length) ctx.log(`  warning: ${long.length} cues exceed 2×${MAX_LINE} chars`)
    ctx.log(`  ${scenes.length} scenes, ${timeline.cues.length} cues, ${citations.length} citation windows, ${duration.toFixed(1)} s`)
    const max = Number(cfg.max_seconds ?? MAX_SECONDS)
    if (duration > max) {
      const msg = `film is ${duration.toFixed(1)} s, over the ${max} s limit (contest: 60-180 s): shorten the script (director.max_words) or the gaps (timing.lead/tail)`
      if (!ctx.mock && !cfg.allow_long) throw new Error(msg)
      ctx.log(`  WARNING: ${msg}`)
    } else if (duration < 60) ctx.log(`  warning: film is ${duration.toFixed(1)} s (contest wants 60-180 s)`)
  },
}

/**
 * Citation chip windows, one per scene with sources. No chip on the title (the hook makes no
 * claim) or on a personal scene whose claims are all personal; it leaves a personal scene before
 * its last line and shows only under the end scene's first line, so reveals play clean. The chip names the
 * strongest MAX_CHIP publishers (+N more); sources.txt (mix) keeps the full list.
 */
function citationsOf(plan, scenes, cues, sources) {
  const out = []
  for (const s of scenes) {
    const sc = s.plan
    if (sc.kind === 'title') continue
    const claims = (plan.claims || []).filter((c) => c.scene_id === sc.id)
    if (sc.kind === 'personal' && claims.length && claims.every((c) => c.kind === 'personal')) continue
    const ids = (sc.source_ids || []).filter((id) => sources.has(id) || !sources.size)
    if (!ids.length) continue
    const pubs = []
    for (const id of ids) {
      const src = sources.get(id) || { id }
      const name = chipName(publisherOf(src))
      if (!pubs.some((p) => p.name === name)) pubs.push({ name, rank: authority(name, src.url), k: pubs.length })
    }
    pubs.sort((a, b) => a.rank - b.rank || a.k - b.k)
    const names = pubs.map((p) => p.name)
    const more = names.length - MAX_CHIP
    const text = `Source${names.length > 1 ? 's' : ''}: ${names.slice(0, MAX_CHIP).join(' · ')}${more > 0 ? ` +${more} more` : ''}`
    // personal: off before the last line (the reveal); end: only under its first line (the fact),
    // so the closing lines and the credits play clean
    let end = s.end
    const mine = cues.filter((c) => c.scene === sc.id)
    if (sc.kind === 'personal' && mine.length > 1) end = Math.max(s.start + 2, mine.at(-1).start - 0.2)
    if (sc.kind === 'end' && mine.length > 1) end = Math.max(s.start + 2, mine[0].end + 0.3)
    const prev = out.at(-1)
    if (prev && prev.text === text && Math.abs(prev.end - s.start) < 1e-6) {
      prev.end = end
      prev.source_ids = [...new Set([...prev.source_ids, ...ids])]
    } else out.push({ start: s.start, end, text, source_ids: ids, publishers: names, scene: sc.id })
  }
  return out
}

// "minimax/speech/2.8/hd" -> "MiniMax Speech 2.8 HD", "minimax/minimax-m3.1-flash" -> "MiniMax M3.1 flash"
const VENDORS = { minimax: 'MiniMax', google: 'Google', bytedance: 'ByteDance', openai: 'OpenAI', elevenlabs: 'ElevenLabs', bfl: 'BFL' }
export function modelName(slug = '') {
  const [vendor, ...rest] = String(slug).split('/')
  const words = rest.join(' ').replace(new RegExp(`^${vendor}-`, 'i'), '').split(/[\s-]+/).filter(Boolean)
  return [VENDORS[vendor] || vendor, ...words.map((w) => (/^(hd|tts)$/i.test(w) ? w.toUpperCase() : w === 'flash' || !/^[a-z]/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))].join(' ')
}

/** geo_detail.json carries procedural `fill` blocks where OSM maps lanes but no houses (see src/geo/detail.mjs) */
function hasFill(ctx) {
  const file = ctx.input('geo_detail.json')
  if (!fs.existsSync(file)) return false
  return (JSON.parse(fs.readFileSync(file, 'utf8')).fill?.features?.length || 0) > 0
}

function creditsOf(config, assets, plan = {}, sources = new Map(), fill = false) {
  const m = config.models || {}
  const n = config.narrator || {}
  // custom voices (minimax/voice-design) have opaque ids like ttv-voice-2026...
  const voice = n.voice_label || (/^ttv-/.test(n.voice_id || '') ? 'custom voice' : n.voice_id)
  const out = [`Directed and written by ${modelName(m.director)} via SandBase`, `Voice: ${modelName(m.tts)}${voice ? ` (${voice})` : ''}`]
  if (Object.keys(assets.images || {}).length) out.push(`Illustrations: ${modelName(m.image)}`)
  if (assets.music) out.push(`Music: ${assets.music.model === 'mock' ? 'placeholder (mock)' : modelName(assets.music.model || m.music)}`)
  const facts = (plan.claims || []).filter((c) => c.kind !== 'personal')
  // distinct pages (a curated source may be split into parts that share one URL)
  const srcs = new Set(facts.flatMap((c) => c.source_ids || []).filter((id) => sources.has(id)).map((id) => sources.get(id).url || id))
  if (plan.verification?.passed && facts.length) out.push(`Fact-checked: ${facts.length} claims against ${srcs.size} sources`)
  // OSM attribution guidelines (video): the full credit with the copyright page in the end credits
  out.push('Map data © OpenStreetMap contributors · openstreetmap.org/copyright')
  // disclose generated geometry: an accuracy judge should never mistake it for surveyed data
  if (fill) out.push('Some old-city blocks are illustrative fill where OpenStreetMap has no building data')
  // the fly-in from space (render/three/globe.js) uses NASA Black Marble
  if (fs.existsSync(new URL('../../render/assets/earth/earth_night_8k.jpg', import.meta.url))) out.push('Earth at night: NASA Earth Observatory (Black Marble)')
  return out
}
