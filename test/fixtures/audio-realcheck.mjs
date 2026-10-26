// One real, low-cost SandBase run per media model to check request/response shapes (~$0.11):
// TTS of fixture scene s02 (~120 chars), one 1K image (s03), one 30 s music clip.
// Outputs are cached in projects/_fixture/build/assets/, so `assets --mock` then reuses them for free.
//   node test/fixtures/audio-realcheck.mjs [tts] [image] [music]
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeContext } from '../../bin/timeline.mjs'
import { imageParams, imageSize, loopMusic, musicParams, produce, ttsParams } from '../../src/stages/assets.mjs'
import { mediaDuration } from '../../src/util.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ctx = makeContext(path.join(ROOT, 'projects', '_fixture'))
const plan = ctx.read('plan.verified.json')
const scene = (id) => plan.scenes.find((s) => s.id === id)
const want = process.argv.slice(2)
const on = (k) => !want.length || want.includes(k)
const noop = () => {
  throw new Error('not in mock mode')
}

function report(kind, r) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,width,height:format=duration,bit_rate', '-of', 'compact', r.file], { encoding: 'utf8' }).stdout.trim()
  console.log(`\n== ${kind}: ${path.relative(ROOT, r.file)}${r.cached ? ' (cached)' : ''}`)
  console.log(JSON.stringify({ params: r.meta.params, run: r.meta.run, output: r.meta.output, est_cost_usd: r.meta.est_cost_usd }, null, 1))
  console.log(probe)
}

if (on('tts')) {
  const text = scene('s02').narration
  const r = await produce(ctx, { dir: ctx.file('assets/voice'), model: ctx.config.models.tts, params: ttsParams(ctx.config, text), ext: '.mp3', mock: noop })
  report('tts', r)
}
if (on('image')) {
  const model = ctx.config.models.image
  const r = await produce(ctx, { dir: ctx.file('assets/images'), model, params: imageParams(model, scene('s03').image_prompt, ctx.config), ext: '.png', mock: noop })
  report('image', r)
  console.log(imageSize(r.file))
}
if (on('music')) {
  let r
  for (const model of [ctx.config.models.music, 'google/lyria-3.5']) {
    try {
      r = await produce(ctx, { dir: ctx.file('assets/music'), model, params: musicParams(model, plan.music_prompt, 30), ext: '.mp3', mock: noop })
      break
    } catch (err) {
      console.log(`music ${model} failed: ${String(err.message).slice(0, 800)}`)
    }
  }
  if (r) {
    report('music', r)
    const d = mediaDuration(r.file)
    const looped = loopMusic(r.file, d, 75)
    console.log(`loop test: ${d.toFixed(2)} s -> ${mediaDuration(looped).toFixed(2)} s (${path.basename(looped)})`)
  }
}
