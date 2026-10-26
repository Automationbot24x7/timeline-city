// Renders the night-globe fly-in (render/three/globe.js) through test/fixtures/globe-harness.html in
// headless Edge (WebGL2) for review. No project build and no SandBase calls needed.
//
//   node test/fixtures/globe-render.mjs                                   # stills p = 0, .3, .6, .85, 1 at 16:9 + 9:16 + contact sheets
//   node test/fixtures/globe-render.mjs --progress 0,0.5,1 --aspect 16:9
//   node test/fixtures/globe-render.mjs --video 7 [--aspect 16:9]         # 7 s preview at 30 fps -> globe_<aspect>_preview.mp4
//   node test/fixtures/globe-render.mjs --opts '{"end":{"tilt":0}}'       # pass createGlobe options through
//   --out <dir>   (default projects/delhi-yellow-line/build/review/globe)
//   --check       re-render every still (same page + a fresh page) and assert identical pixels (determinism)
//   --pin         ring the target where globe.project() puts it (checks the 2D-label projection)
//   --geo <file>  geo.json for the city layers (default the Delhi project's; none = skip)
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { serveStatic, launchBrowser, aspectTag } from '../../src/stages/render.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? def : args[i + 1]
}
const progress = arg('progress', '0,0.3,0.6,0.85,1').split(',').map(Number)
const aspects = arg('aspect', '16:9,9:16').split(',')
const out = path.resolve(ROOT, arg('out', 'projects/delhi-yellow-line/build/review/globe'))
const videoSeconds = Number(arg('video', 0))
const fps = Number(arg('fps', 30))
const optsJson = arg('opts', '')
const tag = arg('tag', '')
const check = args.includes('--check')
const pin = args.includes('--pin')
// city layers (OSM roads, water, green, the ridden line) for the last stretch of the dive; --geo none to skip
const geoArg = arg('geo', 'projects/delhi-yellow-line/build/geo.json')
const geoFile = geoArg === 'none' ? null : path.resolve(ROOT, geoArg)

if (!fs.existsSync(path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js'))) {
  console.error('three.js missing: run `npm install three@0.186.1` in the repo root')
  process.exit(1)
}
fs.mkdirSync(out, { recursive: true })

const ffmpeg = (argv, input) =>
  new Promise((res, rej) => {
    const ff = spawn('ffmpeg', ['-y', '-v', 'error', ...argv], { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] })
    let err = ''
    ff.stderr.on('data', (d) => (err += d))
    ff.on('close', (code) => (code === 0 ? res(ff) : rej(new Error(`ffmpeg ${code}: ${err.slice(-800)}`))))
    if (input) input(ff)
  })

const roots = { render: path.join(ROOT, 'render'), node_modules: path.join(ROOT, 'node_modules'), fixtures: path.join(ROOT, 'test', 'fixtures') }
if (geoFile) roots.geo = path.dirname(geoFile)
const srv = await serveStatic(roots)
const browser = await launchBrowser()
try {
  for (const aspect of aspects) {
    const [width, height] = aspect === '9:16' ? [1080, 1920] : [1920, 1080]
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error('[page]', e.message))
    page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.warn('[page]', m.text()))
    const qs = new URLSearchParams({ aspect, ...(optsJson && { opts: optsJson }), ...(geoFile && { geo: `/geo/${path.basename(geoFile)}` }), ...(pin && { pin: '1' }) })
    const t0 = performance.now()
    await page.goto(`${srv.origin}/fixtures/globe-harness.html?${qs}`)
    await page.waitForFunction(() => window.globeReady, null, { timeout: 60000 }) // the module awaits geo.json first
    const info = await page.evaluate(() => window.globeReady)
    console.log(`${aspect}: ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`, JSON.stringify(info))
    const grab = async (p, q = 0.93) => {
      const r = await page.evaluate(
        ([p, q]) => {
          const pose = window.drawGlobe(p)
          return { pose, url: document.getElementById('c').toDataURL('image/jpeg', q) }
        },
        [p, q],
      )
      return { pose: r.pose, buf: Buffer.from(r.url.slice(r.url.indexOf(',') + 1), 'base64') }
    }
    const at = aspectTag(aspect)
    const stills = []
    for (const p of progress) {
      const t1 = performance.now()
      const { pose, buf } = await grab(p)
      const file = path.join(out, `globe_${at}${tag}_p${p.toFixed(2)}.jpg`)
      fs.writeFileSync(file, buf)
      stills.push(file)
      const f = (v, d = 2) => Number(v).toFixed(d)
      console.log(`  p=${f(p)} look ${f(pose.lat, 3)},${f(pose.lon, 3)} alt ${f(pose.altKm, 1)} km tilt ${f(pose.tilt, 1)} bearing ${f(pose.bearing, 1)}  (${Math.round(performance.now() - t1)} ms) -> ${path.relative(ROOT, file)}`)
    }
    if (check) {
      // determinism: same page again (after other frames) and a fresh page must give identical pixels
      const page2 = await context.newPage()
      await page2.goto(`${srv.origin}/fixtures/globe-harness.html?${qs}`)
      await page2.waitForFunction(() => window.globeReady, null, { timeout: 60000 })
      await page2.evaluate(() => window.globeReady)
      const raw = (pg, p) => pg.evaluate((p) => {
        window.drawGlobe(p)
        const c = document.getElementById('c')
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        let h = 2166136261
        for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619) >>> 0
        return h
      }, p)
      let same = 0
      for (const p of [...progress].reverse()) {
        const [a, b, c] = [await raw(page, p), await raw(page, p), await raw(page2, p)]
        if (a === b && b === c) same++
        else console.log(`  NOT deterministic at p=${p}: ${a} ${b} ${c}`)
      }
      console.log(`  determinism: ${same}/${progress.length} stills identical across repeats and pages`)
      await page2.close()
    }
    if (stills.length > 1) {
      const sheet = path.join(out, `globe_${at}${tag}_contact.jpg`)
      const cols = aspect === '9:16' ? stills.length : Math.min(3, stills.length)
      const rows = Math.ceil(stills.length / cols)
      const tw = aspect === '9:16' ? 360 : 640
      const th = aspect === '9:16' ? 640 : 360
      await ffmpeg([...stills.flatMap((s) => ['-i', s]), '-filter_complex',
        `${stills.map((_, i) => `[${i}:v]scale=${tw}:${th}[v${i}]`).join(';')};${stills.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${stills.length}:layout=${stills.map((_, i) => `${(i % cols) * tw}_${Math.floor(i / cols) * th}`).join('|')}:fill=black${stills.length < cols * rows ? '' : ''}`,
        '-q:v', '3', sheet])
      console.log(`  contact sheet -> ${path.relative(ROOT, sheet)}`)
    }
    if (videoSeconds > 0) {
      const N = Math.round(videoSeconds * fps)
      const file = path.join(out, `globe_${at}${tag}_preview.mp4`)
      const t1 = performance.now()
      await ffmpeg(['-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-vf', 'scale=in_range=full:out_range=limited,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], async (ff) => {
        for (let f = 0; f < N; f++) {
          const { buf } = await grab(f / (N - 1), 0.92)
          if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
        }
        ff.stdin.end()
      })
      const el = (performance.now() - t1) / 1000
      console.log(`  preview ${N} frames in ${el.toFixed(1)} s (${(N / el).toFixed(1)} fps) -> ${path.relative(ROOT, file)}`)
    }
    await context.close()
  }
} finally {
  await browser.close()
  await srv.close()
}
