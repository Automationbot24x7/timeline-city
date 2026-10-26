// Stage `mix`: narration placed per scene + music bed ducked by sidechaincompress, fades, loudness
// mastered to -14 LUFS / -1 dBTP, muxed with each build/render/<aspect>.video.mp4 -> build/final/.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { mediaDuration } from '../util.mjs'
import { BOT_TITLE } from '../ground/facts.mjs'

const TARGET = { I: -14, TP: -1, LRA: 11 }
const VOICE_LUFS = -18 // voice stem level before mastering
const MUSIC_ALONE_DB = -12 // music relative to the voice when nobody speaks
const MUSIC_UNDER_DB = -20 // ... and under the voice
const FADE_IN = 0.5
const FADE_OUT = 2
const SR = 48000
const STEREO = `aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=stereo`

function ff(args, what) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 })
  if (r.status !== 0) throw new Error(`ffmpeg (${what}) failed: ${(r.stderr || r.error?.message || '').slice(-2000)}`)
  return r.stderr
}

/** EBU R128 stats via loudnorm's analysis pass: { input_i, input_tp, input_lra, input_thresh, target_offset, ... } */
function loudness(file, pre = '') {
  const err = ff(['-i', file, '-af', `${pre}loudnorm=I=${TARGET.I}:TP=${TARGET.TP}:LRA=${TARGET.LRA}:print_format=json`, '-f', 'null', '-'], 'loudness')
  const m = err.match(/\{[^{}]*"input_i"[^{}]*\}/)
  if (!m) throw new Error(`no loudnorm stats for ${file}`)
  const j = JSON.parse(m[0])
  for (const k of Object.keys(j)) if (k !== 'normalization_type') j[k] = Number(j[k])
  return j
}

function probeVideo(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', file], { encoding: 'utf8' })
  return JSON.parse(r.stdout || '{}').streams?.[0] || null
}

export const aspectTag = (a) => a.replace(':', 'x')

/** build/render/<aspect>.video.mp4; ':' is illegal in Windows file names, so 16x9 / 16-9 / 16_9 are accepted too. */
export function findVideo(buildDir, aspect) {
  const names = [`${aspectTag(aspect)}.video.mp4`, `${aspect.replace(':', '-')}.video.mp4`, `${aspect.replace(':', '_')}.video.mp4`]
  if (process.platform !== 'win32') names.push(`${aspect}.video.mp4`)
  return names.map((n) => path.join(buildDir, 'render', n)).find((f) => fs.existsSync(f)) || null
}

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'film'

function srtTime(t) {
  const ms = Math.max(0, Math.round(t * 1000))
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
}

export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n')
}

/** Plain-text source list: per citation window, publisher, title and URL of every cited source. */
export function sourcesText(tl, ground) {
  const byId = new Map((ground.sources || []).map((s) => [s.id, s]))
  const mmss = (t) => srtTime(t).slice(3, 8)
  const out = [`${tl.title || 'Film'}: sources, by time in the film`, '']
  for (const c of tl.citations || []) {
    out.push(`${mmss(c.start)}-${mmss(c.end)}${c.scene ? ` (${c.scene})` : ''}`)
    const seen = new Set()
    for (const id of c.source_ids || []) {
      const s = byId.get(id)
      if (!s || seen.has(s.url)) continue
      seen.add(s.url)
      // ground titles of bot-blocked pages are "publisher: host/path": keep only real titles
      // (and a bot wall's title, "Client Challenge", is not the page's title either)
      const title = s.title && !s.title.startsWith(`${s.publisher}:`) && !BOT_TITLE.test(s.title) ? s.title : ''
      out.push(`  - ${[s.publisher, title].filter(Boolean).join(': ')} <${s.url}>`)
    }
    out.push('')
  }
  out.push(tl.attribution || '', ...(tl.credits || []), '')
  return out.join('\n')
}

/** Voice-activity windows (slightly early so the bed dips before the first word). */
function voiceWindows(timeline) {
  const w = []
  for (const s of timeline.scenes) {
    if (!s.voice) continue
    const a = Math.max(0, s.start + s.voice.start - 0.25)
    const b = s.start + s.voice.start + s.voice.duration + 0.1
    const prev = w.at(-1)
    if (prev && a - prev[1] < 0.4) prev[1] = Math.max(prev[1], b)
    else w.push([a, b])
  }
  return w
}

export const stage = {
  name: 'mix',
  outputs: ['mix.json'],
  async run(ctx) {
    const tl = ctx.read('timeline.json')
    const assets = ctx.read('assets.json')
    const D = tl.duration
    const mixDir = ctx.file('mix')
    const finalDir = ctx.file('final')
    fs.mkdirSync(mixDir, { recursive: true })
    fs.mkdirSync(finalDir, { recursive: true })
    // a film with placeholder media says so in its file name (and lives in build/mock/final/)
    const mock = !!(assets.mock || tl.mock)
    const slug = slugify(ctx.config.slug || path.basename(ctx.projectDir)) + (mock ? '-MOCK' : '')
    const f = (n) => path.join(mixDir, n)

    // 1. voice stem: each scene's clip at scene.start + voice.start (sample-accurate adelay)
    const voices = tl.scenes.filter((s) => s.voice).map((s) => ({ file: path.join(ctx.buildDir, s.voice.file), at: s.start + s.voice.start }))
    const vIn = voices.flatMap((v) => ['-i', v.file])
    let vGraph
    if (voices.length) {
      const chains = voices.map((v, i) => `[${i}:a]aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=mono,adelay=delays=${Math.round(v.at * SR)}S:all=1[v${i}]`)
      const sum = voices.length > 1 ? `${voices.map((_, i) => `[v${i}]`).join('')}amix=inputs=${voices.length}:normalize=0:dropout_transition=0` : '[v0]anull'
      vGraph = `${chains.join(';')};${sum},highpass=f=70,pan=stereo|c0=c0|c1=c0,apad=whole_dur=${D},atrim=0:${D}[out]`
    } else vGraph = `anullsrc=r=${SR}:cl=stereo,atrim=0:${D}[out]`
    ff([...vIn, '-filter_complex', vGraph, '-map', '[out]', '-c:a', 'pcm_f32le', f('voice_raw.wav')], 'voice stem')
    // gentle narration compression at a known level (TTS crest factor is ~20 dB; tames peaks before mastering)
    let vStats = null
    if (voices.length) {
      const raw = loudness(f('voice_raw.wav'))
      ff(['-i', f('voice_raw.wav'), '-af', `volume=${(VOICE_LUFS - raw.input_i).toFixed(2)}dB,acompressor=threshold=0.158:ratio=2.5:attack=5:release=150:knee=2.8`, '-c:a', 'pcm_f32le', f('voice.wav')], 'voice comp')
      vStats = loudness(f('voice.wav'))
    } else fs.copyFileSync(f('voice_raw.wav'), f('voice.wav'))
    const gv = vStats && Number.isFinite(vStats.input_i) ? VOICE_LUFS - vStats.input_i : 0

    // 2. music bed: level set from its own loudness, ducked by sidechaincompress keyed on voice activity
    const musicFile = assets.music?.file ? path.join(ctx.buildDir, assets.music.file) : null
    const hasMusic = musicFile && fs.existsSync(musicFile)
    let mStats = null
    let gm = 0
    const duck = { key: 'voice-activity tone, -9 dBFS RMS', threshold: 0.0316, ratio: 1.54, attack: 120, release: 700, knee: 2 }
    const inputs = ['-i', f('voice.wav')]
    let graph = `[0:a]volume=${gv.toFixed(2)}dB,${STEREO}[voice];`
    if (hasMusic) {
      mStats = loudness(musicFile, `atrim=0:${D},`)
      gm = VOICE_LUFS + MUSIC_ALONE_DB - mStats.input_i
      // key = steady tone while a clip plays, so the duck is a constant 8 dB (measured: ratio 1.54 -> 8.0 dB)
      // instead of pumping with the syllables; the bed breathes back up between scenes (release 700 ms)
      const win = voiceWindows(tl)
      const gate = win.length ? `gt(${win.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join('+')},0)` : '0'
      // back-timed bed (assets music.offset): < 0 skips the track's head, > 0 starts it late, so its
      // resolved ending lands under the end card; either way it fades in. No offset: loop to cover.
      const off = Number(assets.music.offset)
      const timed = Number.isFinite(off)
      const skip = timed && off < 0 ? -off : 0
      const late = timed && off > 0 ? off : 0
      if (!timed) inputs.push('-stream_loop', '-1')
      inputs.push('-i', musicFile)
      const fit = timed
        ? `atrim=start=${skip.toFixed(3)},asetpts=PTS-STARTPTS,${skip || late ? `afade=t=in:st=0:d=2,` : ''}${late ? `adelay=delays=${Math.round(late * SR)}S:all=1,` : ''}apad,atrim=0:${D}`
        : `atrim=0:${D}`
      graph +=
        `[1:a]aresample=${SR},${STEREO},${fit},asetpts=PTS-STARTPTS,volume=${gm.toFixed(2)}dB[bed];` +
        `aevalsrc='0.5*sin(2*PI*1000*t)*${gate}|0.5*sin(2*PI*1000*t)*${gate}':s=${SR}:d=${D},${STEREO}[key];` +
        `[bed][key]sidechaincompress=threshold=${duck.threshold}:ratio=${duck.ratio}:attack=${duck.attack}:release=${duck.release}:knee=${duck.knee}:detection=rms:makeup=1[ducked];` +
        `[voice][ducked]amix=inputs=2:normalize=0:duration=first:dropout_transition=0`
    } else graph += '[voice]anull'
    graph += `,afade=t=in:st=0:d=${FADE_IN},afade=t=out:st=${Math.max(0, D - FADE_OUT).toFixed(3)}:d=${FADE_OUT},atrim=0:${D}[out]`
    ff([...inputs, '-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_f32le', f('mix.wav')], 'mix')

    // 3. master: gain + peak limiter (iterated until the limited mix sits at -14 LUFS), then a two-pass
    //    loudnorm that can stay linear because the peaks already have headroom below -1 dBTP
    const m1 = loudness(f('mix.wav'))
    if (!Number.isFinite(m1.input_i)) throw new Error('mix is silent: no voice or music to master')
    let pre = TARGET.I - m1.input_i
    let m2
    for (let i = 0; i < 4; i++) {
      ff(['-i', f('mix.wav'), '-af', `volume=${pre.toFixed(2)}dB,alimiter=limit=0.7:attack=5:release=60:level=false`, '-c:a', 'pcm_f32le', f('limited.wav')], 'limiter')
      m2 = loudness(f('limited.wav'))
      const short = TARGET.I - m2.input_i
      if (Math.abs(short) < 0.15) break
      pre += short
    }
    const ln = `loudnorm=I=${TARGET.I}:TP=${TARGET.TP}:LRA=${TARGET.LRA}:measured_I=${m2.input_i}:measured_TP=${m2.input_tp}:measured_LRA=${m2.input_lra}:measured_thresh=${m2.input_thresh}:offset=${m2.target_offset}:linear=true:print_format=json`
    const err = ff(['-i', f('limited.wav'), '-af', `${ln},aresample=${SR}`, '-c:a', 'pcm_s24le', f('master.wav')], 'loudnorm')
    const normType = (err.match(/"normalization_type"\s*:\s*"(\w+)"/) || [])[1]
    const master = loudness(f('master.wav'))
    for (const n of ['voice_raw.wav', 'mix.wav', 'limited.wav']) fs.rmSync(f(n), { force: true }) // keep voice.wav + master.wav

    // 4. mux with each rendered aspect; audio-only m4a when a video is missing
    const outputs = []
    const missing = []
    for (const aspect of ctx.aspects) {
      const video = findVideo(ctx.buildDir, aspect)
      if (!video) {
        missing.push(aspect)
        continue
      }
      const v = probeVideo(video)
      const vcodec = v?.codec_name === 'h264' ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p']
      const out = path.join(finalDir, `${slug}_${aspectTag(aspect)}.mp4`)
      ff(['-i', video, '-i', f('master.wav'), '-map', '0:v:0', '-map', '1:a:0', ...vcodec, '-c:a', 'aac', '-b:a', '192k', '-ar', String(SR), '-ac', '2',
        '-movflags', '+faststart', '-metadata', `title=${tl.title || slug}`, '-metadata', `comment=${tl.attribution}`, out], `mux ${aspect}`)
      const vd = mediaDuration(video)
      if (Math.abs(vd - D) > 0.2) ctx.log(`  warning: ${aspect} video is ${vd.toFixed(2)} s, audio ${D.toFixed(2)} s`)
      const mb = Math.round((fs.statSync(out).size / 1e6) * 10) / 10
      outputs.push({ aspect, file: path.relative(ctx.buildDir, out).split(path.sep).join('/'), video_codec: v?.codec_name, width: v?.width, height: v?.height, duration: mediaDuration(out), size_mb: mb })
      ctx.log(`  ${path.basename(out)} (${v?.width}x${v?.height}, ${mb} MB, video ${v?.codec_name === 'h264' ? 'copied' : 're-encoded'})`)
      if (mb > 90) ctx.log(`  WARNING: ${path.basename(out)} is ${mb} MB; the contest upload limit is 100 MB`)
    }
    let audioOnly = null
    if (missing.length) {
      audioOnly = path.join(finalDir, `${slug}.m4a`)
      ff(['-i', f('master.wav'), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', audioOnly], 'audio-only')
      ctx.log(`  no rendered video for ${missing.join(', ')}: wrote audio-only ${path.basename(audioOnly)}`)
    }
    const srt = path.join(finalDir, `${slug}.srt`)
    fs.writeFileSync(srt, toSrt(tl.cues || []))
    // every on-screen citation with its full URL list, for the video description
    const sourcesTxt = path.join(finalDir, `${slug}.sources.txt`)
    fs.writeFileSync(sourcesTxt, sourcesText(tl, ctx.read('ground.json', { sources: [] })))

    const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null)
    ctx.write('mix.json', {
      duration: D,
      mock,
      voice: { clips: voices.length, input_lufs: r2(vStats?.input_i), gain_db: r2(gv), target_lufs: VOICE_LUFS },
      music: hasMusic ? { file: assets.music.file, offset: assets.music.offset ?? null, input_lufs: r2(mStats.input_i), gain_db: r2(gm), alone_db: MUSIC_ALONE_DB, under_voice_db: MUSIC_UNDER_DB, ducking: duck } : null,
      master: { pre_gain_db: r2(pre), normalization: normType, lufs: r2(master.input_i), true_peak_dbtp: r2(master.input_tp), lra: r2(master.input_lra), target: TARGET },
      outputs,
      missing_video: missing,
      audio_only: audioOnly && path.relative(ctx.buildDir, audioOnly).split(path.sep).join('/'),
      srt: path.relative(ctx.buildDir, srt).split(path.sep).join('/'),
      sources: path.relative(ctx.buildDir, sourcesTxt).split(path.sep).join('/'),
    })
    ctx.log(`  master ${r2(master.input_i)} LUFS, ${r2(master.input_tp)} dBTP (${normType}); ${outputs.length} video(s), ${tl.cues?.length || 0} subtitles`)
  },
}
