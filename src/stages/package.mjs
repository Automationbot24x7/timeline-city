// Stage `package` (after mix): the contest entry, build/final/entry.json.
//   node src/stages/package.mjs <projectDir> [--mock] [--submit] [--entry <id>]
// (bin/timeline.mjs does not list `package` among its stages; this file runs on its own, see the end.)
// One MiniMax M3.1 flash call (src/prompts/package.md, logged in build/director/package.json) writes
// the summary and the director's notes from the build's own logs (director calls, cost ledger,
// verify.json, HUMAN_LOG.md). The whole step is capped at $0.01: at most two tries of that call (when
// an answer is cut off) and one retry with the code checks' problems, all measured in the ledger.
// Code fills every other field: the title (the brief's working title / the plan's), the sources the
// verified claims still in the film cite, the place, the city line, and whether M3.1 flash really
// directed the film. Then it checks the files against the contest rules (16:9 MP4, 60-180 s, >= 720p,
// <= 100 MiB; cover <= 5 MiB, made as build/final/cover.jpg from the director's cover painting when
// there is none) and prints a checklist.
// Exports gather / directorTexts / finish so a harness can rebuild the entry from a logged answer.
// Uploading is never automatic: only with --submit AND LAB_SUBMISSION_TOKEN in the environment AND an
// entry id (project.yaml entry_id or --entry <id>) does it run the official client, and only when
// every check passes. The token stays in that subprocess's environment: never printed, never written.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ask, prompt, resetLog } from '../director/llm.mjs'
import { BOT_TITLE } from '../ground/facts.mjs'
import { authority, modelName } from './timing.mjs'

export const PIPELINE = ['geo', 'ground', 'direct', 'verify', 'art', 'assets', 'timing', 'render', 'mix', 'package']
const CAP_USD = 0.01 // the whole step: the call and at most one retry
const MAX_TOKENS = 6000 // per attempt (reasoning included)
// The director is asked for words, not characters: asked to count characters, M3.1 flash spent its
// whole 6,000-token budget reasoning about the count (2026-10-26). Code measures the characters.
const LIMIT = { title: 80, summary: 200, summaryWords: 28, notes: 1600, notesWords: 200, cityLine: 50, sources: 25 }
const VIDEO = { min: 60, max: 180, maxBytes: 100 * 1024 ** 2, minShortSide: 720 }
const COVER_MAX = 5 * 1024 ** 2
const COVER_EXT = /\.(jpe?g|png|webp)$/i
const M31 = /m3\.1-flash/i
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s)"']+/gi
const ENTRY_ID = /^[0-9a-f-]{36}$/
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const uniq = (a) => [...new Set(a.filter(Boolean))]
const usd = (x) => `$${Number(x).toFixed(2)}`
const mib = (b) => `${(b / 1024 ** 2).toFixed(1)} MiB`
const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** project.yaml fields the entry needs; throws before anything is paid for when one is missing. */
export function entryConfig(config) {
  const line = one(config.my_city_line)
  if (!line) throw new Error('package: project.yaml needs `my_city_line` (the maker\'s own line about the city, at most 50 characters)')
  if (line.length > LIMIT.cityLine) throw new Error(`package: my_city_line is ${line.length} characters; the contest allows ${LIMIT.cityLine}`)
  // a placeholder ("...", "[removed ...]", "<your line>") is not the maker's line
  if (/^[[<(]|^\.+$|^\W*$/.test(line) || /\bremoved\b.*\brequest\b/i.test(line)) throw new Error(`package: my_city_line "${line}" is a placeholder: the maker's own line about the city goes there`)
  const cityId = slugify(config.city_id || config.city || '')
  if (!cityId) throw new Error('package: no city_id (and no city to derive it from) in project.yaml')
  return { line, cityId }
}

/** Where the film starts: project.yaml `place: {lat, lng}`, else the first station of the ride. */
export function placeOf(config, geo) {
  const p = config.place
  const lat = Number(p?.lat ?? geo?.stations?.[0]?.lat)
  const lng = Number(p?.lng ?? p?.lon ?? geo?.stations?.[0]?.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error('package: no valid place (project.yaml place: {lat, lng}, or geo.json stations)')
  return { lat: +lat.toFixed(6), lng: +lng.toFixed(6), from: p ? 'project.yaml place' : `first station (${geo.stations[0].name})` }
}

/** The cost ledger (build/costs.jsonl) summed: M3.1 chat calls and tokens, media runs by model. */
// chatUntil (ms): leave out chat rows after the film's last director call, i.e. the package step's
// own calls, so a re-run sees the same facts and replays its cached answer instead of paying again
export function ledgerSummary(file, { chatUntil } = {}) {
  const rows = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [])
    .filter((r) => r.kind !== 'chat' || !chatUntil || Date.parse(r.ts) <= chatUntil)
  const cost = (r) => Number(r.est_cost_usd ?? r.base_price_usd ?? 0)
  const chat = rows.filter((r) => r.kind === 'chat')
  const m31 = chat.filter((r) => M31.test(r.model || ''))
  const media = {}
  for (const r of rows.filter((x) => x.kind === 'run')) {
    const m = (media[r.model] ||= { runs: 0, cost: 0 })
    m.runs++
    m.cost += cost(r)
  }
  const sum = (list, f) => list.reduce((s, r) => s + f(r), 0)
  return {
    rows: rows.length,
    m31: {
      calls: m31.length,
      prompt_tokens: sum(m31, (r) => r.usage?.prompt_tokens || 0),
      completion_tokens: sum(m31, (r) => r.usage?.completion_tokens || 0),
      reasoning_tokens: sum(m31, (r) => r.usage?.completion_tokens_details?.reasoning_tokens || 0),
      cost: sum(m31, cost),
    },
    other_chat: { calls: chat.length - m31.length, cost: sum(chat, cost) - sum(m31, cost) },
    media,
    media_cost: Object.values(media).reduce((s, m) => s + m.cost, 0),
    total: sum(rows, cost),
  }
}

/** Director calls behind this film (build/director/index.json; the package step itself left out). */
export function directorCalls(buildDir) {
  const dir = path.join(buildDir, 'director')
  const file = path.join(dir, 'index.json')
  const index = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
  return index.filter((e) => e.stage !== 'package' && M31.test(e.model || '') && (e.usage?.completion_tokens || 0) > 0 && fs.existsSync(path.join(dir, e.file)))
}

/** Page titles the ground stage fetched (build/cache/ground/pages): url -> title, to spot bot walls. */
function fetchedTitles(buildDir) {
  const dir = path.join(buildDir, 'cache', 'ground', 'pages')
  const out = new Map()
  if (!fs.existsSync(dir)) return out
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (j.url && j.status === 200 && typeof j.data === 'string') out.set(j.url, j.data)
    } catch {}
  }
  return out
}

/**
 * The sources the verified claims cite: unique https pages with an excerpt, no bot-wall page and no
 * machine API endpoint, the same page under two URLs once, strongest authority first (the film's own
 * citation-chip order), then the most-cited. The ride itself (claims citing the map) cites the line's
 * OpenStreetMap relation.
 */
export function entrySources({ verify, ground, geo, titles = new Map(), max = LIMIT.sources }) {
  const byId = new Map((ground.sources || []).map((s) => [s.id, s]))
  const seen = new Map() // dedupe key -> candidate
  let order = 0
  const dropped = []
  for (const c of verify.claims || []) {
    if (c.status !== 'supported') continue
    for (const id of c.source_ids || []) {
      if (id === 'osm_ride') {
        const rel = geo?.line?.osm_id
        if (!rel) continue
        const url = `https://www.openstreetmap.org/${rel}`
        const cur = seen.get(url) || { url, publisher: 'OpenStreetMap', auth: 4, claims: new Set(), order: order++ }
        cur.claims.add(c.id)
        seen.set(url, cur)
        continue
      }
      const s = byId.get(id)
      if (!s?.url) continue
      let u
      try {
        u = new URL(s.url)
      } catch {
        continue
      }
      const why =
        u.protocol !== 'https:' ? 'not https' : !one(s.excerpt) ? 'no excerpt' : BOT_TITLE.test(titles.get(s.url) || '') ? 'bot wall' : /\/api\//i.test(u.pathname) ? 'API endpoint, not a page' : null
      if (why) {
        if (!dropped.some((d) => d.url === s.url)) dropped.push({ url: s.url, why })
        continue
      }
      // the same page under two URLs (victorianweb.org/art/... and /victorian/art/...): one entry
      const realTitle = s.title && !s.title.startsWith(`${s.publisher}:`) && !BOT_TITLE.test(s.title) ? one(s.title).toLowerCase() : null
      const site = u.hostname.replace(/^www\./, '')
      const key = realTitle ? `${site} ${realTitle}` : s.url
      const cur = seen.get(key) || { url: s.url, publisher: s.publisher, auth: authority(s.publisher || '', s.url), claims: new Set(), order: order++ }
      cur.claims.add(c.id)
      seen.set(key, cur)
    }
  }
  const ranked = [...seen.values()].sort((a, b) => a.auth - b.auth || b.claims.size - a.claims.size || a.order - b.order)
  return { urls: ranked.slice(0, max).map((s) => s.url), ranked, dropped, cut: Math.max(0, ranked.length - max) }
}

/** ffprobe: width, height, duration, codecs, size of a video file. */
export function probeVideo(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration,size', '-of', 'json', file], { encoding: 'utf8' })
  const j = JSON.parse(out)
  const v = (j.streams || []).find((s) => s.codec_type === 'video') || {}
  const a = (j.streams || []).find((s) => s.codec_type === 'audio')
  return { width: v.width || 0, height: v.height || 0, vcodec: v.codec_name || null, acodec: a?.codec_name || null, duration: Number(j.format?.duration || 0), bytes: Number(j.format?.size || fs.statSync(file).size) }
}

/** Fit text into n characters (line breaks kept): cut after the last sentence, else the last word (with an ellipsis). */
export function fit(text, n) {
  const s = String(text ?? '').replace(/[ \t\r]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  const end = [...cut.matchAll(/[.!?](?=\s|$)/g)].map((m) => m.index).at(-1) ?? -1
  if (end >= n * 0.6) return cut.slice(0, end + 1).trim()
  const sp = cut.lastIndexOf(' ', n - 2)
  return `${cut.slice(0, sp > 0 ? sp : n - 1).replace(/[,;:\s]+$/, '')}…`
}

const numbersIn = (s) => (String(s).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((x) => Number(x.replace(/,/g, ''))).filter(Number.isFinite)

/** Who took part according to HUMAN_LOG.md's "Who" column: the director's notes must credit each. */
export function rolesIn(humanLog) {
  const who = String(humanLog ?? '').split('\n').filter((l) => /^\s*\|/.test(l)).map((l) => l.split('|')[2] || '').join(' ')
  return [/\bmaker\b/i.test(who) && 'the maker', /claude code/i.test(who) && 'Claude Code'].filter(Boolean)
}

/** Code checks of the director's entry texts: lengths, URLs, no number that is not in the facts, everyone credited. */
export function checkTexts(raw, { facts, repoUrl, roles = [] }) {
  const problems = []
  const summary = one(raw?.summary)
  const notes = String(raw?.director_notes ?? '').trim()
  const words = (s) => s.split(/\s+/).filter(Boolean).length
  if (!summary) problems.push('summary is empty')
  if (summary.length > LIMIT.summary) problems.push(`summary has ${words(summary)} words (${summary.length} characters, the form allows ${LIMIT.summary}); write at most ${LIMIT.summaryWords} words`)
  if (!notes) problems.push('director_notes is empty')
  if (notes.length > LIMIT.notes) problems.push(`director_notes has ${words(notes)} words (${notes.length} characters); write at most ${LIMIT.notesWords} words`)
  // the human log's roles: an entry that credits only the AI models overclaims
  for (const r of roles) if (notes && !notes.toLowerCase().includes(r.replace(/^the /, '').toLowerCase())) problems.push(`director_notes never mentions ${r}: say in one short line what ${r} did, from the human log`)
  for (const [k, v] of [['summary', summary], ['director_notes', notes]]) {
    const urls = (v.match(URL_RE) || []).filter((u) => !repoUrl || u.replace(/[.,;]+$/, '') !== repoUrl)
    if (urls.length) problems.push(`${k} contains a URL that is not allowed: ${urls.join(', ')}`)
    // redacted rows of the human log stay out of the entry
    if (/\[[^\]]*\bremoved\b[^\]]*\]/i.test(v)) problems.push(`${k} copies a redaction placeholder ("[... removed ...]"): leave that row out`)
  }
  const known = new Set(numbersIn(facts))
  const unknown = uniq([...numbersIn(summary), ...numbersIn(notes)].filter((x) => !known.has(x)).map(String))
  if (unknown.length) problems.push(`these numbers are not in the film facts (use only the given numbers): ${unknown.join(', ')}`)
  return { summary, notes, problems }
}

/** The facts block the director writes from: every number in it comes from the build's own files. */
export function packageFacts(ctx, { plan, verify, ground, geo, assets, mix, ledger, calls, sources, cut = [] }) {
  const { config } = ctx
  const L = config.line || {}
  const m = config.models || {}
  const n = config.narrator || {}
  const scenes = plan.scenes || []
  // media of scenes still in the film (assets.json keeps the clips and paintings of cut scenes)
  const inFilm = (key) => !scenes.length || scenes.some((s) => s.id === key)
  const images = Object.entries(assets?.images || {}).filter(([k]) => inFilm(k)).map(([, v]) => v)
  const clips = Object.keys(assets?.voice || {}).filter(inFilm).length
  const landmarks = images.filter((i) => i.landmark).length
  const nStations = (geo?.stations || []).length
  const outputs = (mix?.outputs || []).map((o) => `${o.width}x${o.height} (${o.aspect})`).join(' and ')
  const duration = Number(mix?.duration || 0)
  const facts = (verify.claims || []).filter((c) => c.kind !== 'personal')
  const pages = new Set(facts.flatMap((c) => c.source_ids || []).map((id) => (ground.sources || []).find((s) => s.id === id)?.url).filter(Boolean))
  const S = verify.summary || {}
  const custom = /^ttv-/.test(n.voice_id || '')
  const voice = n.voice_label || (custom ? 'a custom voice designed with MiniMax Voice Design (minimax/voice-design)' : n.voice_id ? `the stock voice ${n.voice_id}` : 'the default voice')
  // per stage, per kind of step: "verify 12: verify 9, repair 3" (verify-r0-b1 -> verify, critique.retry -> critique)
  const byStage = {}
  for (const c of calls) {
    const kind = String(c.step).replace(/\.retry$/, '').replace(/-r\d+(-b\d+)?$/, '')
    const st = (byStage[c.stage] ||= { n: 0, kinds: {} })
    st.n++
    st.kinds[kind] = (st.kinds[kind] || 0) + 1
  }
  const stageText = Object.entries(byStage).map(([k, v]) => `${k} ${v.n}: ${Object.entries(v.kinds).map(([x, y]) => `${x} ${y}`).join(', ')}`).join('; ')
  const retries = calls.filter((c) => /\.retry$/.test(c.step)).length
  const replayed = calls.filter((c) => c.cached).length
  const media = Object.entries(ledger.media).map(([model, x]) => `${modelName(model)} ${x.runs} run(s) ${usd(x.cost)}`).join('; ')
  const reviews = (config.director?.review || []).map((r) => r.scene).filter(Boolean)
  const years = (s) => one(s.on_screen?.year)
  const lines = [
    `Title: ${one(config.title || plan.title)}`,
    plan.logline && `Logline: ${one(plan.logline)}`,
    `City: ${config.city}${config.country ? ` (${config.country})` : ''}. Ride: ${[L.name, L.network && `(${L.network})`].filter(Boolean).join(' ')}, ${L.from} to ${L.to}: ${nStations} stations, ${geo?.line?.length_km ?? '?'} km of line as mapped in OpenStreetMap.`,
    `Final film: ${duration ? `${duration.toFixed(1)} s` : 'length unknown'}${outputs ? `, ${outputs}` : ''}, ${{ en: 'English', zh: 'Chinese' }[config.language] || config.language} narration with burned-in subtitles, on-screen citation chips and a sources list.`,
    `Scenes (${scenes.length}): ${scenes.map((s) => `${s.id} ${s.kind} "${one(s.on_screen?.headline)}"${years(s) ? ` ${years(s)}` : ''}`).join('; ')}.`,
    `Pipeline (TimeLine stages, in order): geo (OpenStreetMap via Overpass: the line, its stations, a 3D city) -> ground (evidence pack from Wikidata, Wikipedia and a curated facts file: ${(ground.sources || []).length} sources) -> direct (M3.1 flash: treatment, script, self-critique) -> verify (M3.1 flash checks every claim against the excerpts it cites; repair rounds rewrite failing scenes) -> art (M3.1 flash: landmark painting prompts) -> assets (voice, images, music) -> timing -> render (three.js 3D map in a system browser via playwright-core) -> mix (ffmpeg) -> package (this entry).`,
    `Director: ${modelName(m.director)} (${m.director}) via SandBase. It wrote the treatment, stops, script, on-screen text, every image prompt and the music prompt; code only checks evidence and structure and executes.`,
    `Voice: ${modelName(m.tts)} (${m.tts}), ${clips} narration clips in the film, ${voice}.`,
    `Images: ${modelName(m.image)} (${m.image}), ${images.length} paintings in the film (${images.length - landmarks} scene paintings, ${landmarks} landmark paintings)${assets?.cover ? ' plus the cover' : ''}.`,
    assets?.music && `Music: ${modelName(assets.music.model || m.music)} (${assets.music.model || m.music}), instrumental, 1 track.`,
    `Data and tools: OpenStreetMap (ODbL) via Overpass; Wikidata; Wikipedia; NASA Earth Observatory Black Marble (Earth at night) for the opening globe; three.js; playwright-core with the system's Edge or Chrome; ffmpeg.`,
    `M3.1 flash director calls behind this film (logged in build/director with prompt, reasoning and answer): ${calls.length} (${stageText}; ${retries} of them retries after code checks${replayed ? `; ${replayed} replayed from the cache of earlier identical paid calls` : ''}).`,
    `Paid M3.1 flash requests in the project's cost ledger for the film (every take and test up to its last director call; the entry's own requests not counted): ${ledger.m31.calls}, ${(ledger.m31.prompt_tokens / 1e6).toFixed(2)}M prompt and ${(ledger.m31.completion_tokens / 1e6).toFixed(2)}M completion tokens, ${usd(ledger.m31.cost)}.`,
    `Media generation in the ledger: ${usd(ledger.media_cost)} (${media}).`,
    `Total SandBase spend in the ledger before this entry: ${usd(ledger.total)}${config.max_spend_usd ? ` (spend cap ${usd(config.max_spend_usd)})` : ''}${custom ? '. The custom voice was designed once with MiniMax Voice Design, outside this ledger' : ''}.`,
    `Fact check: ${S.claims ?? (verify.claims || []).length} claims (${facts.length} historical facts against ${pages.size} distinct source pages, ${(verify.claims || []).length - facts.length} personal line(s) against the maker's own words): ${S.supported ?? 0} supported, ${S.partial ?? 0} partial, ${S.unsupported ?? 0} unsupported after ${verify.rounds ?? 0} repair round(s); ${verify.passed ? 'passed' : 'NOT passed'}.`,
    // cuts the maker made after verify (plan.verified.json drops their claims): stated from the ids
    // only, so no cut personal line reaches the entry
    cut.length && `After the fact check the maker cut ${cut.length} claim(s) from the film (${cut.join(', ')}); no text was added.`,
    reviews.length && `The maker's review notes (${reviews.length}, on ${reviews.join(', ')}) went to the director as repair issues: M3.1 flash rewrote those lines itself.`,
    `Sources listed with this entry: ${sources.length}.`,
  ]
  return lines.filter(Boolean).join('\n')
}

const readIn = (dir, name, fallback) => (fs.existsSync(path.join(dir, name)) ? JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) : fallback)

/** M3.1 spend in the ledger since `t0` (ms): what this step has paid so far, failed attempts included. */
function spentSince(file, t0, model) {
  if (!fs.existsSync(file)) return 0
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    .filter((r) => r.kind === 'chat' && r.model === model && Date.parse(r.ts) >= t0)
    .reduce((s, r) => s + Number(r.est_cost_usd || 0), 0)
}

/** Everything code decides for the entry (fails before any paid call when the brief lacks a field). */
export function gather(ctx) {
  const { config } = ctx
  const real = ctx.realBuildDir || ctx.buildDir
  // a mock run packages the placeholder film in build/mock/ (and can never pass the checks)
  const out = ctx.mock && ctx.buildDir === real ? path.join(real, 'mock') : ctx.buildDir
  const { line, cityId } = entryConfig(config)
  const plan = readIn(real, 'plan.verified.json', null)
  const checked = readIn(real, 'verify.json', null)
  if (!plan || !checked) throw new Error('package: plan.verified.json / verify.json missing: run direct and verify first')
  // only the claims still in the film: a line the maker cut after verify (plan.verified.json drops
  // its claim, verification.maker_cut says so) must not be counted or cited
  const inFilm = new Set((plan.claims || []).map((c) => c.id))
  const kept = inFilm.size ? (checked.claims || []).filter((c) => inFilm.has(c.id)) : checked.claims || []
  const cut = (checked.claims || []).filter((c) => !kept.includes(c)).map((c) => c.id)
  const count = (st) => kept.filter((c) => c.status === st).length
  const verify = { ...checked, claims: kept, summary: { ...checked.summary, claims: kept.length, supported: count('supported'), partial: count('partial'), unsupported: count('unsupported') } }
  const ground = readIn(real, 'ground.json', { sources: [] })
  const geo = readIn(real, 'geo.json', null)
  const assets = readIn(out, 'assets.json', readIn(real, 'assets.json', {}))
  const mix = readIn(out, 'mix.json', null)
  const calls = directorCalls(real)
  const lastCall = Math.max(0, ...calls.map((c) => Date.parse(c.at) || 0))
  const ledger = ledgerSummary(path.join(real, 'costs.jsonl'), { chatUntil: lastCall || null })
  const sources = entrySources({ verify, ground, geo, titles: fetchedTitles(real) })
  const humanLogFile = path.join(ctx.projectDir, 'HUMAN_LOG.md')
  return {
    real,
    out,
    line,
    cityId,
    plan,
    verify,
    assets,
    mix,
    calls,
    sources,
    place: placeOf(config, geo),
    title: one(config.title || plan.title),
    repoUrl: config.repo_url ? String(config.repo_url).trim() : null,
    humanLog: fs.existsSync(humanLogFile) ? fs.readFileSync(humanLogFile, 'utf8').trim() : '(no HUMAN_LOG.md: say that no human decisions were logged)',
    facts: packageFacts(ctx, { plan, verify, ground, geo, assets, mix, ledger, calls, sources: sources.urls, cut }),
  }
}

/** The director's messages for the entry texts. */
export function entryMessages(ctx, g) {
  const language = { en: 'English', zh: 'Chinese' }[ctx.config.language] || 'English'
  return [
    { role: 'system', content: 'You are MiniMax M3.1 flash, the director of this film, now writing its contest entry. You state only what the facts you are given say. Answer only through the submit_entry function.' },
    {
      role: 'user',
      content: prompt('package.md', {
        title: g.title,
        language,
        summary_words: String(LIMIT.summaryWords),
        notes_words: String(LIMIT.notesWords),
        repo_line: g.repoUrl ? `\n5. The open-source repository: ${g.repoUrl}` : '',
        allowed_url: g.repoUrl || '(none: write no URL at all)',
        facts: g.facts,
        human_log: g.humanLog,
      }),
    },
  ]
}

const ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: `One or two sentences, at most ${LIMIT.summaryWords} words.` },
    director_notes: { type: 'string', description: `At most ${LIMIT.notesWords} words of "label: value" lines: who did what, pipeline, models and tools, numbers.` },
  },
  required: ['summary', 'director_notes'],
}

/**
 * One M3.1 flash call (and at most one retry with the code checks' problems) writes the summary and
 * the notes; the whole step stays under CAP_USD (measured in the ledger, failed attempts included).
 */
export async function directorTexts(ctx, g) {
  const { config, log } = ctx
  const model = config.models.director
  const ledgerFile = path.join(g.real, 'costs.jsonl')
  const t0 = Date.now()
  const messages = entryMessages(ctx, g)
  const card = await ctx.client.modelPrice(model)
  const perAttempt = (msgs) => ((JSON.stringify(msgs).length / 3.2) * Number(card.prompt_token_price || 0.15) + MAX_TOKENS * Number(card.completion_token_price || 0.6)) / 1e6
  const affordable = (msgs, spent) => Math.min(2, Math.floor((CAP_USD - spent) / perAttempt(msgs)))
  const call = (step, msgs, attempts) => ask(ctx, { stage: 'package', step, messages: msgs, schema: ENTRY_SCHEMA, name: 'submit_entry', description: 'Submit the summary and the director notes of the contest entry.', max_tokens: MAX_TOKENS, attempts })
  const checkFacts = `${g.facts}\n${g.humanLog}\n${g.title}`
  const roles = rolesIn(g.humanLog)
  const first = affordable(messages, 0)
  if (first < 1) throw new Error(`package: the entry prompt is too large for the $${CAP_USD} cap (~$${perAttempt(messages).toFixed(4)} an attempt)`)
  const raw = await call('package', messages, first)
  let res = checkTexts(raw, { facts: checkFacts, repoUrl: g.repoUrl, roles })
  if (res.problems.length) {
    log(`  package: ${res.problems.length} problem(s):\n    - ${res.problems.join('\n    - ')}`)
    const msgs = [
      ...messages,
      { role: 'assistant', content: JSON.stringify(raw) },
      { role: 'user', content: `The code checks of your entry found these problems:\n- ${res.problems.join('\n- ')}\n\nFix every one of them and submit both texts again, complete.` },
    ]
    const spent = spentSince(ledgerFile, t0, model)
    if (affordable(msgs, spent) < 1) log(`  package: no retry (spent $${spent.toFixed(4)}, a retry could cost up to $${perAttempt(msgs).toFixed(4)}: cap $${CAP_USD})`)
    else {
      try {
        const res2 = checkTexts(await call('package.retry', msgs, 1), { facts: checkFacts, repoUrl: g.repoUrl, roles })
        if (res2.problems.length <= res.problems.length) res = res2
      } catch (err) {
        // a truncated retry must not lose the first answer, which is already paid for
        log(`  package: the retry failed (${err.message.split('\n')[0]}); keeping the first answer`)
      }
    }
  }
  const spent = spentSince(ledgerFile, t0, model)
  log(`  package: M3.1 cost $${spent.toFixed(4)} (cap $${CAP_USD})`)
  return { ...res, spent }
}

/** Write the entry, check it and the files against the contest rules, and submit only when asked. */
export function finish(ctx, g, texts) {
  const { config, log } = ctx
  const notes = fit(texts.notes, LIMIT.notes)
  const entry = {
    title: g.title,
    summary: fit(texts.summary, LIMIT.summary),
    lang: config.language === 'zh' ? 'zh' : 'en',
    fields: {
      city_id: g.cityId,
      place_lat: g.place.lat,
      place_lng: g.place.lng,
      used_m31_flash: g.calls.length > 0,
      director_notes: notes,
      sources: g.sources.urls,
      my_city_line: g.line,
    },
  }
  const entryFile = path.join(g.out, 'final', 'entry.json')
  fs.mkdirSync(path.dirname(entryFile), { recursive: true })
  fs.writeFileSync(entryFile, JSON.stringify(entry, null, 2) + '\n')

  const checks = []
  const check = (ok, what, detail = '') => checks.push({ ok: !!ok, what, detail })
  const open = (prefix) => (texts.problems || []).filter((p) => prefix.some((x) => p.startsWith(x)))
  check(g.title && g.title.length <= LIMIT.title, 'title', `"${g.title}" (${g.title.length}/${LIMIT.title} chars)`)
  check(entry.summary && entry.summary.length <= LIMIT.summary && !open(['summary']).length, 'summary', `${entry.summary.length}/${LIMIT.summary} chars${open(['summary']).length ? `; open: ${open(['summary']).join('; ')}` : ''}`)
  const notesOpen = open(['director_notes', 'these numbers'])
  check(notes && !notesOpen.length, 'director_notes', `${notes.length} chars${notes.length < texts.notes.length ? ` (trimmed from ${texts.notes.length})` : ''}${notesOpen.length ? `; open: ${notesOpen.join('; ')}` : ''}`)
  check(['en', 'zh'].includes(config.language || 'en'), 'language', `${config.language} (contest: English or Chinese, subtitles in the video)`)
  check(entry.fields.used_m31_flash, 'used_m31_flash', `${g.calls.length} logged M3.1 flash director calls in build/director`)
  check(entry.fields.sources.length > 0, 'sources', `${entry.fields.sources.length} URLs${g.sources.cut ? ` (${g.sources.cut} weaker ones left out)` : ''}${g.sources.dropped.length ? `; skipped ${g.sources.dropped.map((d) => `${d.url} (${d.why})`).join(', ')}` : ''}`)
  check(true, 'my_city_line', `"${g.line}" (${g.line.length}/${LIMIT.cityLine})`)
  check(true, 'place', `${g.place.lat}, ${g.place.lng} (${g.place.from})`)
  check(g.verify.passed, 'fact check', `${g.verify.summary?.supported ?? '?'}/${g.verify.summary?.claims ?? '?'} claims supported, ${g.verify.rounds} repair round(s)`)

  const slug = slugify(config.slug || path.basename(ctx.projectDir)) || 'film'
  const listed = (g.mix?.outputs || []).find((o) => o.aspect === '16:9')
  const video = config.video ? path.resolve(ctx.projectDir, config.video) : path.join(g.out, listed?.file || `final/${slug}${ctx.mock ? '-MOCK' : ''}_16x9.mp4`)
  if (!fs.existsSync(video)) check(false, 'video', `${video} not found: run mix`)
  else {
    try {
      const v = probeVideo(video)
      const short = Math.min(v.width, v.height)
      check(v.height && Math.abs(v.width / v.height - 16 / 9) < 0.01, 'video 16:9', `${v.width}x${v.height}`)
      check(short >= VIDEO.minShortSide, 'video >= 720p', `${short}p`)
      check(v.duration >= VIDEO.min && v.duration <= VIDEO.max, 'video 60-180 s', `${v.duration.toFixed(1)} s`)
      check(v.bytes > 0 && v.bytes <= VIDEO.maxBytes, 'video <= 100 MiB', mib(v.bytes))
      check(v.vcodec === 'h264' && !!v.acodec, 'video codecs', `${v.vcodec} + ${v.acodec || 'NO AUDIO'}`)
      check(!(g.mix?.mock || /-MOCK/i.test(video)), 'real media', g.mix?.mock ? 'mix.json says mock: placeholder media, not a submission' : 'no placeholders')
      const renderMp4 = path.join(g.out, 'render', '16x9.video.mp4')
      if (fs.existsSync(renderMp4) && fs.statSync(renderMp4).mtimeMs > fs.statSync(video).mtimeMs) check(false, 'video is current', 'build/render/16x9.video.mp4 is newer than the final film: run mix (and package) again')
    } catch (err) {
      check(false, 'video', `ffprobe failed: ${err.message.split('\n')[0]}`)
    }
  }
  let cover = config.cover ? path.resolve(ctx.projectDir, config.cover) : ['cover.jpg', 'cover.png', 'cover.webp'].map((f) => path.join(g.out, 'final', f)).find((f) => fs.existsSync(f))
  const painted = g.assets?.cover?.file && path.join(g.out, g.assets.cover.file)
  if (!cover && painted && fs.existsSync(painted)) {
    // the director's cover painting (assets stage), as a 1920 px JPEG well under the 5 MiB limit
    cover = path.join(g.out, 'final', 'cover.jpg')
    const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', painted, '-vf', 'scale=1920:-2:flags=lanczos', '-q:v', '3', cover], { encoding: 'utf8' })
    if (r.status !== 0) cover = null
    else log(`  cover: ${path.relative(ctx.projectDir, cover).split(path.sep).join('/')} from ${g.assets.cover.file}`)
  }
  cover ||= path.join(g.out, 'final', 'cover.jpg')
  if (!fs.existsSync(cover)) check(false, 'cover', `${cover} not found (project.yaml cover: <file>, or build/final/cover.jpg)`)
  else {
    const b = fs.statSync(cover).size
    check(COVER_EXT.test(cover), 'cover format', path.extname(cover))
    check(b > 0 && b <= COVER_MAX, 'cover <= 5 MiB', mib(b))
  }

  const passed = checks.every((c) => c.ok)
  log(`  entry: ${path.relative(ctx.projectDir, entryFile).split(path.sep).join('/')}`)
  log('  contest checklist:')
  for (const c of checks) log(`    [${c.ok ? 'x' : ' '}] ${c.what}: ${c.detail}`)
  log(`  ${passed ? 'ALL CHECKS PASS' : `${checks.filter((c) => !c.ok).length} check(s) FAILED`}`)

  // upload: only on explicit request (--submit), with every check passing
  const argv = process.argv.slice(2)
  const after = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
  }
  const entryId = String(ctx.entry || after('--entry') || config.entry_id || '').trim()
  const wantSubmit = ctx.submit === true || argv.includes('--submit')
  const script = path.resolve(config.submit_script ? path.resolve(ctx.projectDir, config.submit_script) : process.env.TIMELINE_SUBMIT_SCRIPT || path.join(ctx.root, '..', 'submit', 'contest-submit.py'))
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const args = [script, '--entry', entryId || '<ENTRY_ID>', ...(config.contest ? ['--contest', String(config.contest)] : []), '--metadata', entryFile, '--video', video, '--cover', cover]
  const q = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
  const command = [python, ...args].map(q).join(' ')
  const token = process.env.LAB_SUBMISSION_TOKEN
  let submitted = false
  if (wantSubmit && token && ENTRY_ID.test(entryId) && passed && fs.existsSync(script)) {
    log(`  submitting entry ${entryId} with ${path.basename(script)} (the token stays in the subprocess environment)`)
    const r = spawnSync(python, args, { env: { ...process.env, LAB_SUBMISSION_TOKEN: token }, stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`package: the upload client exited with ${r.status ?? r.error?.message}`)
    submitted = true
  } else {
    const why = !wantSubmit
      ? 'not submitted: uploading needs --submit (after you have reviewed the film and entry.json)'
      : !passed ? 'not submitted: fix the failed checks first'
      : !token ? 'not submitted: LAB_SUBMISSION_TOKEN is not set in the environment'
      : !ENTRY_ID.test(entryId) ? 'not submitted: no valid entry id (project.yaml entry_id or --entry <id>)'
      : `not submitted: no upload client at ${script}`
    log(`  ${why}`)
    log('  to upload yourself, set LAB_SUBMISSION_TOKEN in your shell (or let the client ask for it) and run:')
    log(`    ${command}`)
  }
  return { entry, entryFile, checks, passed, submitted, command }
}

export const stage = {
  name: 'package',
  outputs: ['final/entry.json'],
  async run(ctx) {
    const g = gather(ctx)
    resetLog(ctx, 'package') // build/director shows only this run's entry calls (the ledger keeps every one)
    const texts = await directorTexts(ctx, g)
    return { ...finish(ctx, g, texts), spent: texts.spent, sources: g.sources }
  },
}

// On its own: node src/stages/package.mjs <projectDir> [--mock] [--submit] [--entry <id>]
// It always runs (there is no skip): with nothing changed, the director's answer replays from
// build/cache/director/ for free. --force is accepted and changes nothing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const dir = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--entry')
  if (!dir) {
    console.log('usage: node src/stages/package.mjs <projectDir> [--mock] [--submit] [--entry <id>]')
    process.exit(1)
  }
  try {
    const { makeContext } = await import('../../bin/timeline.mjs')
    const ctx = makeContext(dir, { mock: argv.includes('--mock') })
    const t0 = Date.now()
    ctx.log(`> package${ctx.mock ? ' (mock -> build/mock/)' : ''}`)
    await stage.run(ctx)
    ctx.log(`< package in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  } catch (err) {
    console.error(err.stack || err)
    process.exit(1)
  }
}
