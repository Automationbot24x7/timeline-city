// Stage `render`: drives render/index.html in the system's Edge/Chrome (playwright-core) and pipes
// every frame to ffmpeg -> build/render/<16x9|9x16>.video.mp4 (H.264, yuv420p, silent).
// ':' is illegal in Windows file names, so aspects are tagged 16x9 / 9x16 (mix.mjs accepts these).
// Pages and assets are served from a throwaway 127.0.0.1 server: Chromium's file:// loader fails at
// Windows MAX_PATH (260 chars), which deep project folders reach, and one origin keeps the canvas untainted.
//
// Dev loop (no project build needed):
//   node src/stages/render.mjs --fixture --frames 0,90,300 [--aspect 9:16] [--out dir]
//   node src/stages/render.mjs --fixture --times 12.5,30 | --frames 0-600:60 | --video [--workers 3] [--jpeg]
//   node src/stages/render.mjs --project projects/delhi-yellow-line [--mock] --frames ...
//   --timeline other.json swaps the fixture timeline (images still resolve in test/fixtures/render-assets)
//   --map 2d renders the flat 2D night map instead of the 3D city (env TIMELINE_MAP=2d for the stage);
//   --synthetic (dev) fills the city with seeded placeholder blocks when build/geo_detail.json is missing
// 3D map: three.js (node_modules/three, served at /three/) draws render/three/city.js (and the globe
// fly-in, render/three/globe.js, when that file exists) under the 2D overlay; the city reads the
// real build dir's geo_detail.json (OSM buildings + streets, served at /data/).
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURES = path.join(ROOT, 'test', 'fixtures')
export const aspectTag = (a) => a.replace(':', 'x')
const now = () => performance.now() / 1000

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' }

/** Read-only static server for { render: dir, build: dir } (URL prefix -> folder), on 127.0.0.1. */
export async function serveStatic(roots) {
  const server = http.createServer((req, res) => {
    const parts = decodeURIComponent(new URL(req.url, 'http://x').pathname).split('/').filter(Boolean)
    const base = roots[parts.shift()]
    const file = base && path.resolve(base, ...parts)
    if (req.method !== 'GET' || !file || !file.startsWith(path.resolve(base) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

export async function launchBrowser() {
  const args = ['--allow-file-access-from-files', '--disable-gpu-vsync', '--hide-scrollbars', '--mute-audio']
  let last
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: true, args })
    } catch (err) {
      last = err
    }
  }
  throw new Error(`render: no system Edge or Chrome found (playwright-core channel msedge/chrome): ${last?.message}`)
}

/** Opens the renderer page with its data injected; resolves once fonts and images are ready. */
/** Static roots for the renderer page: the page itself, three.js, the build dir (assets) and the real
 *  build dir (geo_detail.json; a mock run's assets live in build/mock/ but the city data does not). */
export function renderRoots(assetDir, realBuildDir = assetDir) {
  return { render: path.join(ROOT, 'render'), three: path.join(ROOT, 'node_modules', 'three'), build: assetDir, data: realBuildDir }
}

/** Page globals for the 3D layer: geo_detail.json and the globe module when present. */
export function map3dInfo(origin, realBuildDir) {
  const detail = realBuildDir && fs.existsSync(path.join(realBuildDir, 'geo_detail.json'))
  const globe = fs.existsSync(path.join(ROOT, 'render', 'three', 'globe.js'))
  return { detailUrl: detail ? `${origin}/data/geo_detail.json` : null, globeUrl: globe ? `${origin}/render/three/globe.js` : null }
}

export async function openRenderer(browser, { aspect, origin, timeline, geo, siteInfo = {}, project = {}, cpu = false, map = process.env.TIMELINE_MAP || '3d', detailUrl = null, globeUrl = null, synthetic = false }) {
  const [width, height] = aspect === '9:16' ? [1080, 1920] : [1920, 1080]
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error('[renderer]', e.message))
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.warn('[renderer]', m.text()))
  await page.addInitScript((d) => Object.assign(window, d), { TIMELINE: timeline, GEO: geo, ASSET_BASE: `${origin}/build/`, SITE_INFO: siteInfo, PROJECT: project, DETAIL_URL: detailUrl, GLOBE_URL: globeUrl, CITY_SYNTHETIC: synthetic })
  const url = `${origin}/render/index.html?aspect=${encodeURIComponent(aspect)}${cpu ? '&cpu=1' : ''}${map === '2d' ? '&map=2d' : ''}`
  page.on('console', (m) => m.type() === 'log' && /^renderer:/.test(m.text()) && console.log(`[renderer] ${m.text()}`))
  await page.goto(url)
  const info = await page.evaluate(() => window.timelineReady)
  return { page, context, info }
}

async function grab(page, t, type = 'jpeg', quality = 0.92) {
  const url = await page.evaluate(
    ([t, type, q]) => {
      window.drawFrame(t)
      return document.getElementById('c').toDataURL(`image/${type}`, q)
    },
    [t, type, quality],
  )
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
}

/** Renders all frames with N pages in parallel, written to ffmpeg in order. */
// crf 20 capped at 4 Mb/s: a 150 s 1080p film stays far below the contest's 100 MB upload limit
export async function encodeVideo(pages, info, out, { log = console.log, crf = 20, preset = 'medium', maxrate = '4M', bufsize = '8M', from = 0, to = Infinity } = {}) {
  // from/to (frames): a window of the film (dev benchmarks); default the whole film
  const { fps } = info
  const F0 = Math.max(0, Math.round(from))
  const N = Math.min(info.frames, Math.round(to)) - F0
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const tmp = out.replace(/\.mp4$/, '.part.mp4')
  // JPEG frames are full-range BT.601; deliver standard limited-range BT.709 yuv420p
  const vf = 'scale=in_range=full:out_range=limited:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p'
  const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-vf', vf,
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-maxrate', maxrate, '-bufsize', bufsize, '-profile:v', 'high',
    '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-r', String(fps), '-movflags', '+faststart', tmp], { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  ff.stderr.on('data', (d) => (stderr += d))
  const exited = new Promise((res) => ff.on('close', res))
  const pending = new Map()
  let nextWrite = 0
  let chain = Promise.resolve()
  const deliver = (f, buf) => {
    pending.set(f, buf)
    chain = chain.then(async () => {
      while (pending.has(nextWrite)) {
        const b = pending.get(nextWrite)
        pending.delete(nextWrite++)
        if (!ff.stdin.write(b)) await new Promise((r) => ff.stdin.once('drain', r))
      }
    })
    return chain
  }
  const t0 = now()
  let next = 0
  let done = 0
  let lastPct = -5
  const work = async (page) => {
    for (;;) {
      const f = next++
      if (f >= N) return
      await deliver(f, await grab(page, (F0 + f) / fps))
      done++
      const pct = Math.floor((done / N) * 100)
      if (pct >= lastPct + 5 || done === N) {
        lastPct = pct - (pct % 5)
        const el = now() - t0
        log(`  ${path.basename(out)} ${pct}% (${done}/${N} frames, ${(done / el).toFixed(1)} fps, eta ${Math.round((el / done) * (N - done))} s)`)
      }
    }
  }
  await Promise.all(pages.map(work))
  await chain
  ff.stdin.end()
  const code = await exited
  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${stderr.slice(-1500)}`)
  fs.renameSync(tmp, out)
  return { frames: N, seconds: now() - t0 }
}

/** Renders one aspect to `out` using `workers` parallel pages. */
export async function renderAspect(browser, data, out, { workers = 3, log = console.log, cpu = false, maxrate, from, to } = {}) {
  const opened = []
  for (let k = 0; k < workers; k++) opened.push(await openRenderer(browser, { ...data, cpu }))
  try {
    return await encodeVideo(opened.map((o) => o.page), opened[0].info, out, { log, from, to, ...(maxrate && { maxrate, bufsize: `${parseInt(maxrate) * 2}k` }) })
  } finally {
    for (const o of opened) await o.context.close()
  }
}

/** {site_id: {label, year}} from ground.json, for site labels on the map. */
export function siteInfoFrom(ground) {
  const out = {}
  for (const st of ground?.stations || [])
    for (const s of st.sites || []) {
      if (!s.id) continue
      const year = s.inception_text || (s.inception_year ? String(s.inception_year) : '')
      out[s.id] = { label: s.label || undefined, year: year || undefined }
    }
  return out
}

/** Renderer extras from project.yaml. Optional keys: `line.underground` (or `render.underground`):
 *  true | [from, to] | {from, to} with station names or km along the ride; `render.dawn: false`. */
function projectInfo(config, geo) {
  const r = config.render || {}
  return {
    city: config.city,
    line: geo.line?.name || config.line?.name,
    network: geo.line?.network || config.line?.network || '',
    underground: r.underground ?? config.line?.underground ?? null,
    dawn: r.dawn ?? true,
  }
}

export const stage = {
  name: 'render',
  outputs: ['render/16x9.video.mp4', 'render/9x16.video.mp4'],
  async run(ctx) {
    const timeline = ctx.read('timeline.json')
    const geo = ctx.read('geo.json')
    const input = ctx.input || ctx.file // mock runs read geo.json from build/, timeline.json from build/mock/
    const realBuild = ctx.realBuildDir || ctx.buildDir
    const detailFile = path.join(realBuild, 'geo_detail.json')
    // the 3D city is an input too: a new geo_detail.json re-renders
    const inputsAt = Math.max(...['timeline.json', 'geo.json'].map((n) => fs.statSync(input(n)).mtimeMs), fs.existsSync(detailFile) ? fs.statSync(detailFile).mtimeMs : 0)
    const workers = Number(process.env.TIMELINE_RENDER_WORKERS || 3) // 3 pages ~ 20 fps here (1 page: 13 fps)
    // video bitrate cap so final (video + 192k AAC) stays under ~85 MB: the upload limit is 100 MB
    const maxrate = `${Math.max(1500, Math.min(4000, Math.floor((85 * 8e6) / timeline.duration / 1000 - 220)))}k`
    const srv = await serveStatic(renderRoots(ctx.buildDir, realBuild))
    const data = { origin: srv.origin, timeline, geo, siteInfo: siteInfoFrom(ctx.read('ground.json', null)), project: projectInfo(ctx.config, geo), ...map3dInfo(srv.origin, realBuild) }
    if (process.env.TIMELINE_MAP !== '2d' && !data.detailUrl) ctx.log('  warning: build/geo_detail.json is missing: the 3D city has no buildings or streets')
    const browser = await launchBrowser()
    try {
      for (const aspect of ctx.aspects) {
        const out = ctx.file(path.join('render', `${aspectTag(aspect)}.video.mp4`))
        if (!ctx.force && fs.existsSync(out) && fs.statSync(out).mtimeMs > inputsAt) {
          ctx.log(`  ${path.basename(out)} is up to date`)
          continue
        }
        ctx.log(`  rendering ${aspect}: ${timeline.duration.toFixed(1)} s at ${timeline.fps || 30} fps, ${workers} workers, <= ${maxrate}b/s`)
        const r = await renderAspect(browser, { ...data, aspect }, out, { workers, log: ctx.log, maxrate })
        ctx.log(`  wrote ${path.relative(ctx.buildDir, out)} (${r.frames} frames in ${r.seconds.toFixed(0)} s)`)
      }
    } finally {
      await browser.close()
      await srv.close()
    }
  },
}

// ---------- dev CLI
function parseList(spec, fps) {
  const out = []
  for (const part of String(spec).split(',')) {
    const m = part.match(/^(\d+)-(\d+)(?::(\d+))?$/)
    if (m) for (let f = +m[1]; f <= +m[2]; f += +(m[3] || 1)) out.push(f)
    else if (part) out.push(+part)
  }
  return out.map((f) => ({ f, t: f / fps }))
}

async function cli(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (['--fixture', '--video', '--cpu', '--jpeg', '--mock', '--synthetic'].includes(a)) args[a.slice(2)] = true
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i]
    else args._.push(a)
  }
  const aspect = args.aspect || '16:9'
  let data
  let outDir
  if (args.project) {
    // --mock: timeline + assets from build/mock/ (as `timeline render --mock` writes them), geo/ground from build/
    const real = path.resolve(args.project, 'build')
    const build = args.mock ? path.join(real, 'mock') : real
    const pick = (n) => [build, real].map((d) => path.join(d, n)).find((f) => fs.existsSync(f))
    const read = (n, fb) => (pick(n) ? JSON.parse(fs.readFileSync(pick(n), 'utf8')) : fb)
    const geo = read('geo.json')
    const { loadProject } = await import(pathToFileURL(path.join(ROOT, 'src', 'env.mjs')).href)
    // --timeline swaps in another timeline (e.g. a landmark-reveal test); assets still resolve in build/
    data = { assetDir: build, realBuild: real, timeline: args.timeline ? JSON.parse(fs.readFileSync(path.resolve(args.timeline), 'utf8')) : read('timeline.json'), geo, siteInfo: siteInfoFrom(read('ground.json', null)), project: projectInfo(loadProject(path.resolve(args.project)), geo) }
    outDir = args.out || path.join(build, 'render', 'frames')
  } else {
    const timeline = JSON.parse(fs.readFileSync(args.timeline ? path.resolve(args.timeline) : path.join(FIXTURES, 'timeline.sample.json'), 'utf8'))
    const geo = JSON.parse(fs.readFileSync(path.join(ROOT, 'projects', 'delhi-yellow-line', 'build', 'geo.json'), 'utf8'))
    data = { assetDir: path.join(FIXTURES, 'render-assets'), realBuild: path.join(ROOT, 'projects', 'delhi-yellow-line', 'build'), timeline, geo, siteInfo: timeline.site_info || {}, project: timeline.project || {} }
    outDir = args.out || path.join(FIXTURES, 'render-frames')
  }
  const srv = await serveStatic(renderRoots(data.assetDir, args.detail ? path.dirname(path.resolve(args.detail)) : data.realBuild))
  data.origin = srv.origin
  Object.assign(data, map3dInfo(srv.origin, args.detail ? path.dirname(path.resolve(args.detail)) : data.realBuild), { synthetic: !!args.synthetic, map: args.map || process.env.TIMELINE_MAP || '3d' })
  if (args.detail === 'none') data.detailUrl = null
  const browser = await launchBrowser()
  try {
    const tag = aspectTag(aspect)
    if (args.video) {
      const out = path.resolve(args.out || path.join(outDir, `${tag}.video.mp4`))
      // --from/--to seconds: render only that window (benchmarks, quick looks)
      const fps = data.timeline.fps || 30
      const win = { from: args.from != null ? +args.from * fps : 0, to: args.to != null ? +args.to * fps : Infinity }
      const r = await renderAspect(browser, { ...data, aspect }, out, { workers: Number(args.workers || 3), cpu: !!args.cpu, ...win })
      console.log(`wrote ${out}: ${r.frames} frames in ${r.seconds.toFixed(1)} s (${(r.frames / r.seconds).toFixed(1)} fps)`)
      return
    }
    const { page, info } = await openRenderer(browser, { ...data, aspect, cpu: !!args.cpu })
    const list = args.times ? String(args.times).split(',').map((s) => ({ f: Math.round(+s * info.fps), t: +s })) : parseList(args.frames || '0', info.fps)
    fs.mkdirSync(outDir, { recursive: true })
    for (const { f, t } of list) {
      const t0 = now()
      const buf = await grab(page, t, args.jpeg ? 'jpeg' : 'png', 0.9)
      const file = path.join(outDir, `${tag}_f${String(f).padStart(5, '0')}.${args.jpeg ? 'jpg' : 'png'}`)
      fs.writeFileSync(file, buf)
      console.log(`${file}  t=${t.toFixed(2)}s  ${((now() - t0) * 1000).toFixed(0)} ms`)
    }
  } finally {
    await browser.close()
    await srv.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.stack || err)
    process.exit(1)
  })
}
