// Fixture for the assets / timing / mix stages.
//   node test/fixtures/audio-fixture.mjs setup   -> projects/_fixture (project.yaml + hand-made plan.verified.json, ground.json)
//   node test/fixtures/audio-fixture.mjs video   -> synthetic 1920x1080 colour-bars build/mock/render/16x9.video.mp4 (length = timeline)
//   node test/fixtures/audio-fixture.mjs check   -> unit checks of the cue splitter + checks of timeline.json / mix outputs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readJSON, writeJSON, mediaDuration } from '../../src/util.mjs'
import { MAX_LINE, clipCues, splitCues, splitPauses, wrapLines } from '../../src/stages/timing.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIX = path.join(ROOT, 'projects', '_fixture')
const BUILD = path.join(FIX, 'build')
// stage outputs: `timeline <stage> projects/_fixture --mock` writes them to build/mock/ (--real: build/)
const OUT = process.argv.includes('--real') ? BUILD : path.join(BUILD, 'mock')
const here = (n) => path.join(ROOT, 'test', 'fixtures', n)

function setup() {
  fs.mkdirSync(BUILD, { recursive: true })
  const yaml = fs.readFileSync(path.join(ROOT, 'projects', 'delhi-yellow-line', 'project.yaml'), 'utf8')
  fs.writeFileSync(path.join(FIX, 'project.yaml'), `${yaml.trimEnd()}\n\n# fixture only: refuse media runs beyond this ledger total\nmax_spend_usd: 0.25\n`)
  writeJSON(path.join(BUILD, 'plan.verified.json'), readJSON(here('audio-plan.verified.json')))
  writeJSON(path.join(BUILD, 'ground.json'), readJSON(here('audio-ground.json')))
  console.log(`fixture ready in ${FIX}`)
}

function video() {
  const tl = readJSON(path.join(OUT, 'timeline.json'))
  const out = path.join(OUT, 'render', '16x9.video.mp4')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=${tl.fps}:d=${tl.duration}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', out])
  console.log(`${out} (${mediaDuration(out).toFixed(2)} s)`)
}

function unit() {
  // pauses
  assert.deepEqual(splitPauses('a <#0.5#> b'), [{ text: 'a', pause: 0.5, lead: 0 }, { text: 'b', pause: 0, lead: 0 }])
  assert.equal(splitPauses('<#0.3#> a').at(0).lead, 0.3)
  // line layout
  assert.deepEqual(wrapLines('I am Dilli.'), ['I am Dilli.'])
  const long = 'In 1639, Shah Jahan began a walled city here, Shahjahanabad, with the Red Fort at its heart, and the river below it.'
  const cues = splitCues(long)
  for (const c of cues) {
    const lines = wrapLines(c)
    assert.ok(lines && lines.length <= 2 && lines.every((l) => l.length <= MAX_LINE), `bad cue ${c}`)
  }
  assert.equal(cues.join(' '), long)
  // abbreviations do not end sentences; pause markup never reaches subtitles
  assert.equal(splitCues('Built c. 1295 by the Khaljis.').length, 1)
  assert.ok(!splitCues('One <#0.4#> two.').join(' ').includes('<#'))
  // a 200-char sentence without punctuation still splits into valid cues
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
  for (const c of splitCues(words)) assert.ok(wrapLines(c), `unwrappable ${c}`)
  // pause anchoring: a silence near the expected spot moves the boundary onto it
  const cc = clipCues('First part here. <#0.5#> Second part comes after the pause.', 6, [{ start: 2.0, end: 2.6 }])
  assert.equal(cc[0].t1, 2.0)
  assert.equal(cc[1].t0, 2.6)
  console.log('unit checks ok')
}

function outputs() {
  const tl = readJSON(path.join(OUT, 'timeline.json'))
  const assets = readJSON(path.join(OUT, 'assets.json'))
  let prevEnd = 0
  for (const s of tl.scenes) {
    assert.ok(Math.abs(s.start - prevEnd) < 1e-6, `gap before ${s.id}`)
    assert.ok(s.end - s.start >= (s.kind === 'title' ? 4 : 3) - 1e-6, `${s.id} too short`)
    if (s.voice) assert.ok(s.voice.start + s.voice.duration <= s.end - s.start + 1e-6, `${s.id} voice overruns`)
    prevEnd = s.end
  }
  assert.ok(Math.abs(prevEnd - tl.duration) < 1e-3)
  for (let i = 0; i < tl.cues.length; i++) {
    const c = tl.cues[i]
    assert.ok(c.end > c.start, `cue ${i} empty`)
    assert.ok(c.lines.length <= 2 && c.lines.every((l) => l.length <= MAX_LINE), `cue ${i} too long`)
    assert.ok(!c.text.includes('<#'), `cue ${i} has pause markup`)
    if (i) assert.ok(c.start >= tl.cues[i - 1].end, `cue ${i} overlaps`)
  }
  assert.ok(tl.citations.length >= 2 && tl.attribution.includes('OpenStreetMap'))
  for (const v of Object.values(assets.voice)) assert.ok(fs.existsSync(path.join(OUT, v.file)))
  const mix = readJSON(path.join(OUT, 'mix.json'), null)
  if (mix) {
    assert.ok(Math.abs(mix.master.lufs - -14) <= 0.6, `master ${mix.master.lufs} LUFS`)
    assert.ok(mix.master.true_peak_dbtp <= -0.9, `true peak ${mix.master.true_peak_dbtp}`)
    for (const o of mix.outputs) {
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,bit_rate,width,height', '-of', 'json', path.join(OUT, o.file)], { encoding: 'utf8' }))
      const kinds = probe.streams.map((s) => `${s.codec_type}:${s.codec_name}`)
      assert.ok(kinds.includes('video:h264') && kinds.includes('audio:aac'), kinds.join(','))
    }
    assert.ok(fs.existsSync(path.join(OUT, mix.srt)))
  }
  console.log(`output checks ok: ${tl.scenes.length} scenes, ${tl.cues.length} cues, ${tl.duration} s${mix ? `, master ${mix.master.lufs} LUFS / ${mix.master.true_peak_dbtp} dBTP` : ''}`)
}

const cmd = process.argv[2]
if (cmd === 'setup') setup()
else if (cmd === 'video') video()
else if (cmd === 'check') {
  unit()
  if (fs.existsSync(path.join(OUT, 'timeline.json'))) outputs()
} else console.log('usage: node test/fixtures/audio-fixture.mjs setup|video|check')
