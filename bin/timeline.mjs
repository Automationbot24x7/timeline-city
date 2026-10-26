#!/usr/bin/env node
// TimeLine CLI: `timeline <stage|all> <projectDir> [--force] [--from <stage>] [--mock] [--aspect 16:9] [--only s04,s05]`
// --only (assets): voice just those scenes, an audition before the full paid run; `geo --only detail`: rebuild just geo_detail.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEnv, loadProject } from '../src/env.mjs'
import { createClient } from '../src/sandbase.mjs'
import { readJSON, writeJSON } from '../src/util.mjs'

// art: the director's landmark paintings for map scenes (adds landmark fields to plan.verified.json)
export const STAGES = ['geo', 'ground', 'direct', 'verify', 'art', 'assets', 'timing', 'render', 'mix', 'package']
// Media stages: cheap to redo (media is cached by content hash), so they re-run when an input is newer.
// With --mock they read upstream JSON (geo, ground, plan) from build/ but write everything to
// build/mock/, so a placeholder can never pass for (or overwrite) a real asset or a real final film.
export const MEDIA_STAGES = ['assets', 'timing', 'render', 'mix']
const MOCK_OWN = /^(assets|timeline|mix)\.json$|^(assets|render|mix|final)[\\/]/ // in mock mode never read from build/
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = { _: [], force: false, mock: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--force') args.force = true
    else if (a === '--mock') args.mock = true
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i]
    else args._.push(a)
  }
  return args
}

export function makeContext(projectDir, { force = false, mock = false, aspect, only } = {}) {
  projectDir = path.resolve(projectDir)
  loadEnv(projectDir, ROOT)
  const config = loadProject(projectDir)
  const buildDir = path.join(projectDir, 'build')
  fs.mkdirSync(buildDir, { recursive: true })
  mock = mock || process.env.TIMELINE_MOCK === '1'
  const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m)
  const client = createClient({ ledgerFile: path.join(buildDir, 'costs.jsonl'), mock, log })
  return {
    root: ROOT,
    projectDir,
    buildDir,
    realBuildDir: buildDir, // build/ even when a mock stage writes to build/mock/ (ledger, real media cache)
    config,
    client,
    log,
    force,
    mock,
    only: only || null,
    aspects: aspect ? [aspect] : config.aspects,
    file: (name) => path.join(buildDir, name),
    input: (name) => path.join(buildDir, name),
    read: (name, fallback) => readJSON(path.join(buildDir, name), fallback),
    write: (name, value) => writeJSON(path.join(buildDir, name), value),
    exists: (name) => fs.existsSync(path.join(buildDir, name)),
  }
}

/** The ctx a stage runs with: media stages in mock mode write to build/mock/ and read upstream from build/. */
export function stageContext(ctx, name) {
  if (!ctx.mock || !MEDIA_STAGES.includes(name)) return ctx
  const dir = path.join(ctx.realBuildDir, 'mock')
  fs.mkdirSync(dir, { recursive: true })
  const input = (n) => {
    const m = path.join(dir, n)
    return fs.existsSync(m) || MOCK_OWN.test(n) ? m : path.join(ctx.realBuildDir, n)
  }
  return {
    ...ctx,
    buildDir: dir,
    file: (n) => path.join(dir, n),
    input,
    read: (n, fallback) => readJSON(input(n), fallback),
    write: (n, value) => writeJSON(path.join(dir, n), value),
    exists: (n) => fs.existsSync(path.join(dir, n)),
  }
}

export async function loadStage(name) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'stages', `${name}.mjs`)).href)
  if (!mod.stage?.run) throw new Error(`src/stages/${name}.mjs must export { stage: { name, outputs, run } }`)
  return mod.stage
}

const mtime = (f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0)
// every { file: 'relative/path' } inside a stage's JSON output
const filesIn = (v) => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => (k === 'file' && typeof x === 'string' ? [x] : filesIn(x))) : [])

/** Why a finished media stage must run again: an upstream output or project.yaml is newer, or its outputs are mock. */
async function staleReason(name, ctx, stage) {
  const oldest = Math.min(...stage.outputs.map((o) => mtime(ctx.file(o))))
  if (!MEDIA_STAGES.includes(name)) {
    // network / paid chat stages are never redone implicitly: only say so (the director reads the brief)
    if (['direct', 'verify'].includes(name) && mtime(path.join(ctx.projectDir, 'project.yaml')) > oldest) ctx.log(`  note: project.yaml changed after ${stage.outputs.join(', ')}; if that matters for ${name}, redo it with --force`)
    return null
  }
  for (const o of stage.outputs.filter((x) => x.endsWith('.json'))) {
    const out = readJSON(ctx.file(o), {})
    if (!ctx.mock && out?.mock) return `${o} holds mock placeholders`
    const lost = filesIn(out).find((f) => !fs.existsSync(path.join(ctx.buildDir, f)))
    if (lost) return `${lost} (listed in ${o}) is missing`
  }
  const inputs = [path.join(ctx.projectDir, 'project.yaml')]
  for (const up of STAGES.slice(0, STAGES.indexOf(name))) for (const o of (await loadStage(up)).outputs || []) inputs.push(ctx.input(o))
  const newer = inputs.find((f) => mtime(f) > oldest)
  return newer ? `${path.relative(ctx.projectDir, newer).split(path.sep).join('/')} is newer` : null
}

export async function runStage(name, baseCtx) {
  let ctx = stageContext(baseCtx, name)
  const stage = await loadStage(name)
  const done = (stage.outputs || []).length && stage.outputs.every((o) => ctx.exists(o))
  if (done && !ctx.force && !ctx.only) {
    const why = await staleReason(name, ctx, stage)
    if (!why) {
      ctx.log(`skip ${name} (outputs exist; use --force to redo)`)
      return
    }
    ctx.log(`redo ${name}: ${why}`)
    ctx = { ...ctx, force: true }
  }
  const t0 = Date.now()
  ctx.log(`> ${name}${ctx.mock && MEDIA_STAGES.includes(name) ? ' (mock -> build/mock/)' : ''}`)
  await stage.run(ctx)
  ctx.log(`< ${name} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const [cmd, projectDir] = args._
  if (!cmd || !projectDir) {
    console.log(`usage: timeline <${STAGES.join('|')}|all|costs> <projectDir> [--force] [--from stage] [--mock] [--aspect 16:9|9:16] [--only s04]`)
    process.exit(1)
  }
  const ctx = makeContext(projectDir, args)
  if (cmd === 'costs') {
    const file = ctx.file('costs.jsonl')
    const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    const total = rows.reduce((s, r) => s + (r.est_cost_usd || r.base_price_usd || 0), 0)
    console.log(`${rows.length} calls, estimated $${total.toFixed(3)}`)
    return
  }
  if (cmd === 'all') {
    const from = args.from ? STAGES.indexOf(args.from) : 0
    if (from < 0) throw new Error(`unknown stage ${args.from}`)
    for (const [i, name] of STAGES.entries()) {
      if (i < from) continue
      await runStage(name, { ...ctx, force: ctx.force || (args.from && i >= from) })
    }
    return
  }
  if (!STAGES.includes(cmd)) throw new Error(`unknown stage ${cmd}`)
  await runStage(cmd, ctx)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.stack || err)
    process.exit(1)
  })
}
