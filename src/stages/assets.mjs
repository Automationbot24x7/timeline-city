// Stage `assets`: narration (one TTS run per scene), illustrations, cover, then a music bed sized to the film.
// Runs are sequential (one concurrent run per org) and cached by content hash in build/assets/<kind>/,
// with a <hash>.json sidecar (model, params, run id, output) so re-runs never pay twice.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { hash, mediaDuration, readJSON, writeJSON } from '../util.mjs'
import { MAX_SECONDS, readPlan, sceneLength, splitPauses, stripPauses, timingOptions } from './timing.mjs'
import { briefHash } from './direct.mjs'

const IMAGE_KINDS = new Set(['illustration', 'personal', 'title', 'end'])
const MIN_IMAGE_WIDTH = 1280
// mock narration speed and clip edges, measured on the real custom voice at speed 0.92
// (out/voice_design/test_line.mp3: 12.5 chars/s of speech, 0.225 s lead and 0.39 s trailing silence)
const MOCK_CPS = 12.5
const EDGE = [0.225, 0.39]
const EXT = { 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/flac': '.flac', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }
const FONTS = ['C:/Windows/Fonts/arial.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf']

// ---------- request params per model family (from the SandBase unified_schema of each card) ----------

export function ttsParams(config, text) {
  const n = config.narrator || {}
  const p = { text, voice_id: n.voice_id || 'English_CaptivatingStoryteller', speed: n.speed ?? 1, emotion: n.emotion || 'neutral', format: 'mp3', sample_rate: 44100, bitrate: 128000, channel: 1 }
  for (const k of ['pitch', 'volume', 'language_boost', 'english_normalization']) if (n[k] !== undefined) p[k] = n[k]
  return p
}

// style: the director's style bible (plan.style_bible.illustration_style) wins over project.yaml;
// it is not appended again when the director already wrote it into the prompt
export function imageParams(model, prompt, config, styleBible) {
  const style = (styleBible || config.style?.illustration || '').trim()
  let full = prompt.trim().replace(/[.\s]+$/, '')
  const has = (t) => full.toLowerCase().includes(t.toLowerCase().slice(0, 120))
  if (style && !has(style)) full += `. Style: ${style}`
  if ((config.aspects || []).includes('9:16')) full += '. Keep the main subject near the horizontal centre (the frame is also cropped to vertical 9:16)'
  if (model.includes('nano-banana')) return { prompt: full, aspect_ratio: '16:9', resolution: config.image_resolution || '1K', output_format: 'png' }
  return { prompt: full, aspect_ratio: '16:9', output_format: 'png' } // seedream / generic
}

// A landmark painting (map scenes, from the art step) must look like the real monument: nano-banana
// grounds it with a web search (+$0.014). Only these new images carry the flag, so every image paid
// for before keeps its params hash (and its cache).
export function landmarkImageParams(model, prompt, config, styleBible) {
  const p = imageParams(model, prompt, config, styleBible)
  return model.includes('nano-banana') ? { ...p, enable_web_search: true } : p
}

const INSTRUMENTAL = 'Instrumental only: no vocals, no singing, no humming, no choir, no spoken words.'

// Vocals are the risk: minimax/music/2.6 has a hard is_instrumental switch (the default model);
// music/3 (tag-only lyrics) and Lyria only have the prompt, so they are fallbacks.
export function musicParams(model, prompt, seconds) {
  prompt = `${prompt.trim().replace(/[.\s]+$/, '')}. ${INSTRUMENTAL}`
  if (model.startsWith('minimax/music/3')) return { prompt, lyrics: '[intro]\n[instrumental]\n[outro]', duration: seconds }
  if (model.startsWith('minimax/music/')) return { prompt: prompt.length > 2000 ? `${INSTRUMENTAL} ${prompt.slice(0, 1995 - INSTRUMENTAL.length)}` : prompt, is_instrumental: true, format: 'mp3', sample_rate: 44100, bitrate: 256000 }
  if (model.includes('lyria')) return { prompt: `A ${seconds}-second instrumental track. ${prompt}` }
  if (model.startsWith('elevenlabs/music')) return { prompt, force_instrumental: true, music_length_ms: seconds * 1000 }
  return { prompt, duration: seconds }
}

/** Price estimate for the ledger (mirrors each card's price_formula; undefined -> card base_price). */
export function estimateCost(model, p) {
  if (model.startsWith('minimax/speech/') && model.endsWith('/hd')) return +((p.text.length / 1000) * 0.1).toFixed(5)
  if (model.startsWith('minimax/music/3')) return +((p.duration ?? 60) * 0.002).toFixed(4)
  if (model.startsWith('minimax/music/')) return 0.15
  if (model.includes('lyria')) return 0.1
  if (model.includes('nano-banana')) return ({ '4K': 0.135, '2K': 0.06 }[p.resolution] ?? 0.04) + (p.enable_web_search || p.enable_image_search ? 0.014 : 0)
  if (model.includes('seedream')) return 0.018
  return undefined
}

// ---------- ffmpeg helpers ----------

function ff(args, what) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 })
  if (r.status !== 0) throw new Error(`ffmpeg (${what}) failed: ${(r.stderr || r.error?.message || '').slice(-1500)}`)
}

/** Path inside a filter argument: forward slashes, escaped colon, single-quoted. */
const filterPath = (p) => `'${p.replace(/\\/g, '/').replace(/:/g, '\\:')}'`

export function imageSize(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file], { encoding: 'utf8' })
  const [width, height] = r.stdout.trim().split('x').map(Number)
  return { width, height }
}

function mockVoice(file, narration) {
  // pink noise shaped like syllables, real silences for <#x#> pauses, a little lead/trail silence like TTS
  const segs = [{ sil: EDGE[0] }]
  for (const p of splitPauses(narration)) {
    if (p.lead) segs.push({ sil: p.lead })
    segs.push({ len: Math.max(0.4, p.text.length / MOCK_CPS) })
    if (p.pause) segs.push({ sil: p.pause })
  }
  segs.push({ sil: EDGE[1] })
  const fmt = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono'
  const chains = segs.map((s, i) =>
    s.sil
      ? `anullsrc=r=44100:cl=mono,atrim=0:${s.sil.toFixed(3)},${fmt}[p${i}]`
      : `anoisesrc=d=${s.len.toFixed(3)}:c=pink:r=44100:a=0.35:seed=${i + 1},bandpass=f=900:width_type=h:w=1400,tremolo=f=4.5:d=0.85,${fmt}[p${i}]`,
  )
  const graph = `${chains.join(';')};${segs.map((_, i) => `[p${i}]`).join('')}concat=n=${segs.length}:v=0:a=1[out]`
  ff(['-filter_complex', graph, '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '128k', file], 'mock voice')
}

function mockImage(file, label, prompt) {
  const hue = parseInt(hash(label, 6), 16)
  const color = `0x${(((hue & 0x3f3f3f) + 0x202020) >>> 0).toString(16).padStart(6, '0')}`
  const font = FONTS.find((f) => fs.existsSync(f))
  if (font) {
    const words = stripPauses(prompt || '').split(' ')
    const lines = ['']
    for (const w of words) {
      if ((lines.at(-1) + ' ' + w).length > 64) lines.push(w)
      else lines[lines.length - 1] = (lines.at(-1) + ' ' + w).trim()
    }
    const txt = `${file}.txt`
    fs.writeFileSync(txt, `MOCK PLACEHOLDER · ${label}\n\n${lines.slice(0, 5).join('\n')}${lines.length > 5 ? ' …' : ''}`)
    // small and centred so the renderer's own cards stay readable over it
    const vf = `drawtext=fontfile=${filterPath(font)}:textfile=${filterPath(txt)}:fontcolor=white@0.55:fontsize=26:line_spacing=10:x=(w-tw)/2:y=h*0.36:box=1:boxcolor=black@0.25:boxborderw=24`
    try {
      ff(['-f', 'lavfi', '-i', `color=c=${color}:s=1920x1080:d=1`, '-vf', vf, '-frames:v', '1', file], 'mock image')
    } finally {
      fs.rmSync(txt, { force: true })
    }
    return
  }
  ff(['-f', 'lavfi', '-i', `color=c=${color}:s=1920x1080:d=1`, '-frames:v', '1', file], 'mock image')
}

function mockMusic(file, seconds) {
  // a quiet A-major pad with a slow swell
  const expr = '(0.05*sin(2*PI*110*t)+0.04*sin(2*PI*164.81*t)+0.035*sin(2*PI*220*t)+0.03*sin(2*PI*277.18*t))*(0.7+0.3*sin(2*PI*0.08*t))'
  ff(['-f', 'lavfi', '-i', `aevalsrc='${expr}|${expr}':s=44100:d=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '160k', file], 'mock music')
}

/** Loop a short music clip with crossfades until it covers `need` seconds. */
export function loopMusic(src, dur, need) {
  const out = src.replace(/\.[^.]+$/, `-loop${Math.ceil(need)}.flac`)
  if (fs.existsSync(out)) return out
  const xf = Math.min(3, dur / 4)
  const n = Math.max(2, Math.ceil((need - xf) / (dur - xf)))
  const args = []
  for (let i = 0; i < n; i++) args.push('-i', src)
  let graph = ''
  let last = '[0:a]'
  for (let i = 1; i < n; i++) {
    graph += `${last}[${i}:a]acrossfade=d=${xf.toFixed(2)}:c1=tri:c2=tri[x${i}];`
    last = `[x${i}]`
  }
  graph += `${last}atrim=0:${Math.ceil(need)}[out]`
  ff([...args, '-filter_complex', graph, '-map', '[out]', '-c:a', 'flac', out], 'music loop')
  return out
}

// ---------- cache + runs ----------

function findCached(dir, h) {
  if (!fs.existsSync(dir)) return null
  const f = fs.readdirSync(dir).find((n) => n.startsWith(`${h}.`) && !/\.(json|part|txt)$/.test(n))
  return f ? path.join(dir, f) : null
}

function spentSoFar(ctx) {
  const file = path.join(ctx.realBuildDir || ctx.buildDir, 'costs.jsonl')
  if (!fs.existsSync(file)) return 0
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return rows.reduce((s, r) => s + (r.est_cost_usd || r.base_price_usd || 0), 0) // same sum as `timeline costs`
}

class BudgetError extends Error {}

/**
 * One media item: reuse the cached real file if any; in mock mode synthesise a placeholder;
 * otherwise run the model, download outputs[0].url and record a sidecar.
 * Mock runs write to build/mock/assets/ (bin/timeline.mjs) and copy in real files already paid for.
 */
export async function produce(ctx, { dir, model, params, ext, mock }) {
  const h = hash({ model, params })
  let real = findCached(dir, h)
  const realDir = ctx.realBuildDir ? path.join(ctx.realBuildDir, path.relative(ctx.buildDir, dir)) : dir
  if (!real && ctx.mock && realDir !== dir) {
    const paid = findCached(realDir, h)
    if (paid) {
      fs.mkdirSync(dir, { recursive: true })
      real = path.join(dir, path.basename(paid))
      fs.copyFileSync(paid, real)
      const side = path.join(realDir, `${h}.json`)
      if (fs.existsSync(side)) fs.copyFileSync(side, path.join(dir, `${h}.json`))
    }
  }
  if (real) return { file: real, mock: false, cached: true, meta: readJSON(path.join(dir, `${h}.json`), {}) }
  fs.mkdirSync(dir, { recursive: true })
  if (ctx.mock) {
    const file = path.join(dir, `mock-${h}${ext}`)
    if (!fs.existsSync(file)) mock(file)
    return { file, mock: true, cached: false, meta: {} }
  }
  // a run submitted earlier whose result never arrived (network error while polling or downloading):
  // resume it instead of paying again
  const runFile = path.join(dir, `${h}.run.json`)
  const pending = readJSON(runFile, null)
  let est = estimateCost(model, params)
  if (est === undefined) est = Number((await ctx.client.modelPrice(model))?.base_price) || undefined
  const cap = Number(ctx.config.max_spend_usd)
  if (!pending && cap && est !== undefined && spentSoFar(ctx) + est > cap) throw new BudgetError(`max_spend_usd ${cap} would be exceeded by ${model} (~$${est})`)
  ctx.log(`  ${pending ? `resume run ${pending.run_id} of` : 'run'} ${model} (~$${est ?? '?'})`)
  const onSubmitted = (o) => writeJSON(runFile, { model, hash: h, run_id: o.id, submitted: new Date().toISOString() })
  let out
  try {
    out = await ctx.client.run(model, params, { estCost: est, resumeId: pending?.run_id, onSubmitted })
  } catch (err) {
    // a resumed run that is gone or ended badly is forgotten (a network error keeps it for the next try)
    if (pending && (err.status === 404 || /\bended\b/.test(err.message))) fs.rmSync(runFile, { force: true })
    if (!pending || err.status !== 404) throw err
    ctx.log(`  run ${pending.run_id} is gone (404); submitting again`)
    out = await ctx.client.run(model, params, { estCost: est, onSubmitted })
  }
  const o = out.outputs?.[0]
  if (!o?.url) throw new Error(`${model}: no outputs[0].url in ${JSON.stringify(out).slice(0, 600)}`)
  let e = EXT[(o.content_type || '').split(';')[0].trim()]
  if (!e) {
    try {
      e = path.extname(new URL(o.url).pathname) || ext
    } catch {
      e = ext
    }
  }
  const file = path.join(dir, `${h}${e}`)
  try {
    await ctx.client.download(o.url, `${file}.part`)
  } catch (err) {
    if (err.status >= 400 && err.status < 500) fs.rmSync(runFile, { force: true }) // expired output link: resubmit next time
    throw err
  }
  fs.renameSync(`${file}.part`, file)
  const { outputs, ...runInfo } = out
  const meta = {
    model, params, est_cost_usd: est, created: new Date().toISOString(),
    run: runInfo, output: { ...o, url: o.url.split('?')[0] }, outputs_count: outputs.length,
  }
  writeJSON(path.join(dir, `${h}.json`), meta)
  fs.rmSync(runFile, { force: true })
  return { file, mock: false, cached: false, meta }
}

const rel = (ctx, file) => path.relative(ctx.buildDir, file).split(path.sep).join('/')
const r3 = (x) => Math.round(x * 1000) / 1000

async function image(ctx, dir, prompt, label, styleBible, { landmark = false } = {}) {
  const model = ctx.config.models.image
  const params = (landmark ? landmarkImageParams : imageParams)(model, prompt, ctx.config, styleBible)
  const r = await produce(ctx, { dir, model, params, ext: '.png', mock: (f) => mockImage(f, label, prompt) })
  let file = r.file
  let size = imageSize(file)
  if (size.width < MIN_IMAGE_WIDTH) {
    const up = file.replace(/\.[^.]+$/, '-1920.png')
    if (!fs.existsSync(up)) ff(['-i', file, '-vf', 'scale=1920:-2:flags=lanczos', up], 'upscale')
    file = up
    size = imageSize(file)
  }
  return { file: rel(ctx, file), ...size, model: r.mock ? 'mock' : model, mock: r.mock }
}

/** The music prompt asks for the film's real length (the director only knew its estimate). */
export function withLength(prompt, seconds) {
  const s = Math.round(seconds / 5) * 5 // round so small script edits reuse the cache
  const re = /\b(?:in\s+)?(?:about|around|roughly|approximately)\s+\d{2,3}\s*(?:-|\s)?(?:s|sec|secs|seconds?)\b/gi
  return re.test(prompt) ? prompt.replace(re, `in about ${s} seconds`) : `${prompt.trim().replace(/[.\s]+$/, '')}. Total length about ${s} seconds.`
}

// Fit a track to the film. Longer, or a little shorter: back-time it, so its resolved ending lands
// under the end card (offset < 0 skips its head, offset > 0 starts it late). Much shorter: loop.
const MAX_LATE_START = 10

async function music(ctx, prompt, total, dir) {
  const need = Math.ceil(total + 1)
  // project.yaml music_length_seconds pins the length asked for (and so the cache key), so a late
  // script cut keeps the paid track; back-timing below still fits it to the real film
  const asked = Number(ctx.config.music_length_seconds) || total
  const seconds = Math.min(300, Math.ceil((asked + 3) / 10) * 10) // round up so small script edits reuse the cache
  prompt = withLength(prompt, asked)
  const models = [...new Set([ctx.config.models.music, ctx.config.models.music_fallback || 'google/lyria-3.5'].filter(Boolean))]
  let r
  let used
  for (const model of models) {
    try {
      r = await produce(ctx, { dir, model, params: musicParams(model, prompt, seconds), ext: '.mp3', mock: (f) => mockMusic(f, seconds) })
      used = model
      break
    } catch (err) {
      if (err instanceof BudgetError || ctx.mock || model === models.at(-1)) throw err
      ctx.log(`  music: ${model} failed (${String(err.message).slice(0, 300)}); falling back`)
    }
  }
  const rawDuration = mediaDuration(r.file)
  let file = r.file
  let offset = r3(total - rawDuration) // film time at which the track starts
  if (offset > Math.min(MAX_LATE_START, total * 0.1)) {
    ctx.log(`  music is ${rawDuration.toFixed(1)} s, film needs ${need} s: looping with crossfades`)
    file = loopMusic(r.file, rawDuration, need)
    offset = 0
  } else if (Math.abs(offset) > 0.05) ctx.log(`  music is ${rawDuration.toFixed(1)} s for a ${total.toFixed(1)} s film: back-timed (${offset < 0 ? `skips its first ${(-offset).toFixed(1)} s` : `starts at ${offset.toFixed(1)} s`}) so its ending lands under the end card`)
  return {
    file: rel(ctx, file), duration: r3(mediaDuration(file)), model: r.mock ? 'mock' : used, requested: seconds,
    raw: rel(ctx, r.file), raw_duration: r3(rawDuration), looped: file !== r.file, offset, mock: r.mock,
  }
}

/** Projected film length from the voices measured so far (the rest extrapolated at the same speech rate). */
function projectLength(scenes, voice, o, textOf) {
  let chars = 0
  let speech = 0
  for (const sc of scenes) {
    const v = voice[sc.id]
    if (!v) continue
    chars += stripPauses(textOf(sc)).length
    speech += Math.max(0.1, v.duration - EDGE[0] - EDGE[1] - splitPauses(textOf(sc)).reduce((s, p) => s + p.pause + (p.lead || 0), 0))
  }
  const cps = chars / speech
  return scenes.reduce((s, sc, i) => {
    const t = textOf(sc)
    const d = voice[sc.id]?.duration ?? (stripPauses(t) ? stripPauses(t).length / cps + EDGE[0] + EDGE[1] + splitPauses(t).reduce((a, p) => a + p.pause + (p.lead || 0), 0) : 0)
    return s + sceneLength(sc, d || undefined, o, i === scenes.length - 1)
  }, 0)
}

export const stage = {
  name: 'assets',
  outputs: ['assets.json'],
  async run(ctx) {
    const { config } = ctx
    const plan = readPlan(ctx)
    // never pay for media of a script that has not passed fact-checking, or that was directed from an
    // older brief (project.yaml or the facts file changed since `direct`); mock previews are fine
    if (!ctx.mock && plan.verification?.passed !== true && !config.allow_unverified) throw new Error('plan.verified.json is missing or did not pass verify: run verify (or set allow_unverified: true) before paying for media')
    if (!ctx.mock && plan.brief_hash !== briefHash(config, ctx.projectDir) && !config.allow_stale_plan) throw new Error('the plan was directed from an older brief (project.yaml or the facts file changed since `direct`): redo `direct --force` and `verify --force` (or set allow_stale_plan: true) before paying for media')
    const styleBible = plan.style_bible?.illustration_style
    const dir = (k) => ctx.file(path.join('assets', k))
    const out = { mock: !!ctx.mock, voice: {}, images: {}, music: null, cover: null }
    const o = timingOptions(config)
    const maxSec = Number(config.max_seconds ?? MAX_SECONDS)
    const textOf = (sc) => String(sc.narration || '').replace(/\s+/g, ' ').trim()

    // 1. narration, one run per scene (keeps timing exact). A real run voices the longest scene first and
    //    stops before paying for the rest when the measured speech rate projects a film over the limit.
    //    `--only s04[,s05]` voices just those scenes (an audition: listen before the full run).
    const only = ctx.only ? new Set(String(ctx.only).split(',').map((s) => s.trim())) : null
    const voiced = plan.scenes.filter((sc) => stripPauses(textOf(sc)) && (!only || only.has(sc.id)))
    let warned = false
    const order = ctx.mock ? voiced : [...voiced].sort((a, b) => stripPauses(textOf(b)).length - stripPauses(textOf(a)).length)
    for (const sc of order) {
      const text = textOf(sc)
      const r = await produce(ctx, { dir: dir('voice'), model: config.models.tts, params: ttsParams(config, text), ext: '.mp3', mock: (f) => mockVoice(f, text) })
      const duration = r3(mediaDuration(r.file))
      out.voice[sc.id] = { file: rel(ctx, r.file), duration, chars: stripPauses(text).length, model: r.mock ? 'mock' : config.models.tts, mock: r.mock }
      ctx.log(`  voice ${sc.id}: ${duration.toFixed(2)} s${r.mock ? ' (mock)' : r.cached ? ' (cached)' : ''}${only ? `: ${r.file}` : ''}`)
      if (only) continue
      const projected = projectLength(plan.scenes, out.voice, o, textOf)
      if (projected > maxSec && !warned) {
        const msg = `the voices so far project a ${projected.toFixed(1)} s film, over the ${maxSec} s limit: shorten the script (director.max_words) before paying for the rest`
        if (!ctx.mock && !config.allow_long) throw new Error(msg)
        ctx.log(`  WARNING: ${msg}`)
        warned = true
      }
    }
    if (only) {
      ctx.log(`  audition only (${[...only].join(', ')}): assets.json not written`)
      return
    }
    out.voice = Object.fromEntries(voiced.map((sc) => [sc.id, out.voice[sc.id]])) // scene order

    // 2. illustrations (16:9; the renderer crops for 9:16)
    for (const sc of plan.scenes) {
      if (!IMAGE_KINDS.has(sc.kind)) continue
      if (!sc.image_prompt) {
        ctx.log(`  warning: ${sc.id} (${sc.kind}) has no image_prompt`)
        continue
      }
      out.images[sc.id] = await image(ctx, dir('images'), sc.image_prompt, `${sc.id} · ${sc.kind}`, styleBible)
      ctx.log(`  image ${sc.id}: ${out.images[sc.id].width}x${out.images[sc.id].height}${out.images[sc.id].mock ? ' (mock)' : ''}`)
    }

    // 3. cover
    if (plan.cover_prompt) out.cover = await image(ctx, dir('cover'), plan.cover_prompt, `cover · ${plan.title || ''}`, styleBible)

    // 4. landmark paintings for map scenes (the art step's `landmark`): the map gives way to them after the
    //    train arrives (timeline.json `reveal`). New images only: everything above is reused from the cache.
    const landmarks = plan.scenes.filter((sc) => sc.kind === 'map' && sc.landmark?.image_prompt)
    if (!ctx.mock && landmarks.length) {
      // all or nothing: never pay for some paintings and then stop at the spend cap
      const model = config.models.image
      const todo = landmarks.map((sc) => landmarkImageParams(model, sc.landmark.image_prompt, config, styleBible)).filter((p) => !findCached(dir('images'), hash({ model, params: p })))
      const est = todo.reduce((s, p) => s + (estimateCost(model, p) ?? 0), 0)
      const cap = Number(config.max_spend_usd)
      if (todo.length) ctx.log(`  landmarks: ${todo.length} new painting(s), ~$${est.toFixed(3)} (spent so far $${spentSoFar(ctx).toFixed(3)}${cap ? `, cap $${cap}` : ''})`)
      if (cap && todo.length && spentSoFar(ctx) + est > cap) throw new BudgetError(`max_spend_usd ${cap} would be exceeded by ${todo.length} landmark painting(s) (~$${est.toFixed(3)}); nothing was paid for them`)
    }
    for (const sc of landmarks) {
      const lm = sc.landmark
      const img = await image(ctx, dir('images'), lm.image_prompt, `${sc.id} · landmark · ${lm.subject || ''}`, styleBible, { landmark: true })
      out.images[sc.id] = { ...img, landmark: true, subject: lm.subject || null, site_id: lm.site_id || null }
      ctx.log(`  landmark ${sc.id} (${lm.subject}): ${img.width}x${img.height}${img.mock ? ' (mock)' : ''}`)
    }

    // 5. music, sized to the film computed from the real narration lengths
    const total = plan.scenes.reduce((s, sc, i) => s + sceneLength(sc, out.voice[sc.id]?.duration, o, i === plan.scenes.length - 1), 0)
    out.estimated_duration = r3(total)
    const prompt = plan.music_prompt || 'Warm, gentle cinematic underscore for a documentary about an old city; soft strings, bansuri flute and tanpura drone, slow tempo, ending on a calm resolved chord.'
    out.music = await music(ctx, prompt, total, dir('music'))
    ctx.log(`  music: ${out.music.duration.toFixed(1)} s for a ${total.toFixed(1)} s film${out.music.mock ? ' (mock)' : ''}`)

    const items = [...Object.values(out.voice), ...Object.values(out.images), out.cover, out.music].filter(Boolean)
    out.mock = items.some((x) => x.mock) // placeholders inside: a film made from this must never be published
    ctx.write('assets.json', out)
  },
}
