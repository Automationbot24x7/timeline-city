// Builds the renderer dev fixture: test/fixtures/timeline.sample.json (real station/site ids from
// projects/delhi-yellow-line/build/geo.json) and procedural placeholder images in render-assets/.
// usage: node test/fixtures/render-make-fixture.mjs
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const GEO = path.join(ROOT, 'projects', 'delhi-yellow-line', 'build', 'geo.json')
const OUT = path.join(HERE, 'render-assets')

// --- placeholder paintings: per-pixel painter -> raw RGB -> ffmpeg -> PNG
function paint(file, w, h, fn) {
  const buf = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x / w, y / h, x, y)
      const i = (y * w + x) * 3
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b
    }
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', '-', '-frames:v', '1', file], { input: buf })
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`)
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)))
const noise = (x, y) => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}
const grade = (c, x, y, n = 10) => c.map((v) => clamp(v + (noise(x, y) - 0.5) * n))

// skyline height (0..1 of frame) for domes, arches and a tapered minaret
function skyline(u, kind) {
  let h = 0
  const dome = (cx, r, base) => { const d = Math.abs(u - cx); if (d < r) h = Math.max(h, base + Math.sqrt(r * r - d * d) * 1.6) }
  const box = (x0, x1, top) => { if (u > x0 && u < x1) h = Math.max(h, top) }
  if (kind === 'tank') {
    box(0.05, 0.42, 0.12); dome(0.12, 0.035, 0.12); dome(0.3, 0.05, 0.12); box(0.28, 0.32, 0.14)
    box(0.55, 0.95, 0.1); dome(0.62, 0.03, 0.1); dome(0.8, 0.06, 0.1); box(0.79, 0.81, 0.13)
  } else if (kind === 'roofs') {
    for (let i = 0; i < 24; i++) box(i / 24, (i + 1) / 24, 0.08 + 0.12 * noise(i, 3))
  } else {
    box(0, 1, 0.04 + 0.03 * noise(Math.floor(u * 40), 1))
    const d = Math.abs(u - 0.66); const t = 0.55 - d * 9; if (d < 0.03) h = Math.max(h, t)
    dome(0.25, 0.04, 0.06); dome(0.4, 0.025, 0.06)
  }
  return h
}

function tank(u, v, x, y) {
  const hor = 0.64
  const sky = v < hor ? mix([28, 24, 70], [236, 150, 70], Math.pow(v / hor, 1.6)) : null
  const sun = Math.hypot((u - 0.7) * 1.78, v - 0.5)
  if (v < hor) {
    let c = sky
    if (sun < 0.06) c = mix(c, [255, 228, 170], 0.95)
    else c = mix(c, [255, 200, 120], Math.max(0, 0.35 - sun) * 0.9)
    if (hor - v < skyline(u, 'tank')) c = mix([38, 22, 30], c, 0.12)
    return grade(c, x, y)
  }
  const mv = hor - (v - hor) + Math.sin(u * 90 + v * 40) * 0.004
  const refl = mix([28, 24, 70], [236, 150, 70], Math.pow(Math.max(0, mv) / hor, 1.6))
  const sil = v - hor < skyline(u, 'tank') * 0.8
  return grade(mix(sil ? [30, 20, 34] : refl, [20, 28, 50], 0.35 + (v - hor) * 0.8), x, y, 16)
}

function roofs(u, v, x, y) {
  let c = mix([250, 196, 110], [196, 84, 52], v)
  const sun = Math.hypot((u - 0.25) * 1.78, v - 0.3)
  c = mix(c, [255, 240, 200], Math.max(0, 0.25 - sun) * 2)
  if (1 - v < skyline(u, 'roofs') + 0.18) c = mix([70, 34, 40], c, 0.18 + (1 - v) * 0.3)
  for (const [kx, ky, s] of [[0.6, 0.22, 0.02], [0.72, 0.3, 0.014], [0.82, 0.18, 0.018], [0.47, 0.35, 0.012]]) {
    if (Math.abs(u - kx) * 1.78 + Math.abs(v - ky) < s) c = [180, 40, 60]
  }
  return grade(c, x, y, 14)
}

function night(u, v, x, y) {
  let c = mix([8, 12, 34], [42, 40, 88], Math.pow(v, 1.4))
  if (noise(x, y) > 0.9993 && v < 0.6) c = [230, 230, 255]
  if (1 - v < skyline(u, 'night')) {
    c = [10, 10, 18]
    if (v > 0.93 && noise(Math.floor(x / 6), Math.floor(y / 6)) > 0.9) c = [255, 190, 90]
  }
  return grade(c, x, y, 8)
}

fs.mkdirSync(OUT, { recursive: true })
const images = { 'hauz-khas.png': tank, 'rooftops.png': roofs, 'night.png': night }
for (const [name, fn] of Object.entries(images)) {
  paint(path.join(OUT, name), 1920, 1080, fn)
  console.log('wrote', path.join(OUT, name))
}

// --- timeline: real ids, hand-timed cues
const geo = JSON.parse(fs.readFileSync(GEO, 'utf8'))
const stationIds = new Set(geo.stations.map((s) => s.id))
const siteIds = new Set(geo.sites.map((s) => s.id))

const S = [
  ['s01', 'title', 6, null, { headline: 'One Ticket, 800 Years' }, null,
    ['I am Dilli.', 'Buy one ticket for my Yellow Line,\nand I will carry you through eight hundred years.']],
  ['s02', 'map', 10, null, { headline: 'Chandni Chowk', year: '1639' },
    { train_to: 'st_chandni_chowk', focus_station: 'st_chandni_chowk', focus_site_ids: ['site_red_fort', 'site_jama_masjid'], zoom: 14.4 },
    ['We board at Chandni Chowk.', 'In 1639, Shah Jahan began a walled city here,\nShahjahanabad, with the Red Fort at its heart.']],
  ['s03', 'map', 10, null, { headline: 'New Delhi', year: '1931' },
    { train_to: 'st_central_secretariat', focus_station: 'st_central_secretariat', focus_site_ids: ['site_rashtrapati_bhavan', 'site_india_gate'], zoom: 14 },
    ['Three centuries later, the British\nbuilt a new capital to the south.', 'New Delhi was inaugurated in 1931.']],
  ['s04', 'map', 9, null, { headline: 'Lodi Gardens', year: '1494' },
    { train_to: 'st_jor_bagh', focus_station: 'st_jor_bagh', focus_site_ids: ['site_bara_gumbad', 'site_tomb_of_sikandar_lodhi'], zoom: 14.6 },
    ['Older still: the domed tombs of the Lodis,', 'sultans who ruled me five centuries ago.']],
  ['s05', 'map', 9, null, { headline: 'Hauz Khas', year: 'c. 1295' },
    { train_to: 'st_hauz_khas', focus_station: 'st_hauz_khas', focus_site_ids: ['site_hauz_khas_complex'], zoom: 14.6 },
    ['At Hauz Khas, Alauddin Khalji\ndug a royal tank around 1295.']],
  ['s06', 'illustration', 9, 'hauz-khas.png', { headline: 'Hauz Khas', year: 'c. 1295' }, null,
    ['Its stone steps still catch the evening light,', 'and the students still come to sit by the water.']],
  ['s07', 'map', 10, null, { headline: 'Qutb Minar', year: 'c. 1199' },
    { train_to: 'st_qutab_minar', focus_station: 'st_qutab_minar', focus_site_ids: ['site_qutb_minar', 'site_alai_darwaza', 'site_iron_pillar'], zoom: 14.8 },
    ['The last stop. Around 1199,', 'the first sultans raised a tower of red stone,\nthe Qutb Minar.']],
  ['s08', 'personal', 9, 'rooftops.png', { headline: 'A personal memory', year: '1982' }, null,
    ['Personal memory removed at the maker’s request.', 'A sample personal line.']],
  ['s09', 'end', 8, 'night.png', { headline: 'One Ticket, 800 Years' }, null,
    ['He made this film.', 'Come ride with me.']],
]
const CITES = { s02: 'Source: UNESCO · Wikipedia', s03: 'Source: Wikipedia', s04: 'Source: ASI', s05: 'Source: ASI · Wikipedia', s06: 'Source: ASI · Wikipedia', s07: 'Source: UNESCO' }

let t = 0
const scenes = []
const cues = []
const citations = []
for (const [id, kind, len, image, onScreen, map, lines] of S) {
  if (map) {
    for (const st of [map.train_to, map.focus_station]) if (!stationIds.has(st)) throw new Error(`unknown station ${st}`)
    for (const s of map.focus_site_ids) if (!siteIds.has(s)) throw new Error(`unknown site ${s}`)
  }
  const start = t
  const end = t + len
  const speech = len - 1.2
  const total = lines.reduce((n, l) => n + l.length, 0)
  let c = start + 0.5
  for (const l of lines) {
    const d = (speech * l.length) / total
    cues.push({ start: +c.toFixed(3), end: +(c + d - 0.05).toFixed(3), text: l, lines: l.split('\n'), scene: id })
    c += d
  }
  const narration = lines.join(' ').replace(/\n/g, ' ')
  scenes.push({
    id, kind, start, end,
    voice: { file: `assets/voice/${id}.mp3`, start: 0.5, duration: +speech.toFixed(3) },
    image: image || null, // relative to ASSET_BASE (= render-assets/ for the fixture)
    plan: { id, kind, narration, on_screen: { headline: '', year: '', subtitle_lang: 'en', ...onScreen }, ...(map && { map }), fact_ids: [], source_ids: [] },
  })
  if (CITES[id]) {
    const prev = citations.at(-1)
    if (prev && prev.text === CITES[id] && prev.end === start) prev.end = end
    else citations.push({ start, end, text: CITES[id], source_ids: [] })
  }
  t = end
}

const timeline = {
  fps: 30,
  duration: t,
  title: 'One Ticket, 800 Years',
  scenes,
  cues,
  citations,
  attribution: 'Map data © OpenStreetMap contributors (ODbL)',
  credits: ['Director & script: minimax/minimax-m3.1-flash', 'Narration: minimax/speech/2.8/hd (English_CaptivatingStoryteller)', 'Illustrations: google/nano-banana-2.1', 'Music: minimax/music/3'],
  // renderer-only extras (render.mjs builds these from ground.json + project.yaml for real projects)
  site_info: {
    site_red_fort: { label: 'Red Fort', year: '1639–48' },
    site_jama_masjid: { label: 'Jama Masjid', year: '1650–56' },
    site_rashtrapati_bhavan: { label: 'Rashtrapati Bhavan', year: '1929' },
    site_india_gate: { label: 'India Gate', year: '1931' },
    site_bara_gumbad: { label: 'Bara Gumbad', year: '1494' },
    site_tomb_of_sikandar_lodhi: { label: 'Tomb of Sikandar Lodi', year: '1517' },
    site_hauz_khas_complex: { label: 'Hauz Khas', year: 'c. 1295' },
    site_qutb_minar: { label: 'Qutb Minar', year: 'c. 1199' },
    site_alai_darwaza: { label: 'Alai Darwaza', year: '1311' },
    site_iron_pillar: { label: 'Iron Pillar', year: '4th–5th c.' },
  },
  project: { city: 'Delhi', city_local: 'दिल्ली', line: 'Yellow Line', network: 'Delhi Metro', underground: { from: 'Chandni Chowk', to: 'Qutab Minar' } },
}
fs.writeFileSync(path.join(HERE, 'timeline.sample.json'), JSON.stringify(timeline, null, 2))
console.log(`wrote timeline.sample.json: ${scenes.length} scenes, ${cues.length} cues, ${t} s`)
