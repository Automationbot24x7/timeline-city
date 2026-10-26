// Director calls (MiniMax M3.1 flash): prompt templates from src/prompts/, structured output via
// ctx.client.chatJSON (forced function call), and a full transparency log of every call in
// build/director/<step>.json (messages, schema, response, reasoning, usage, cost) + build/director/index.json.
// Identical requests replay from build/cache/director/ (free); set TIMELINE_FRESH=1 or bump
// project.yaml `director.take` for a fresh take.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hash, readJSON, writeJSON } from '../util.mjs'

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

/** Load src/prompts/<name> and fill {{vars}} (strings as-is, anything else as JSON). */
export function prompt(name, vars = {}) {
  const text = fs.readFileSync(path.join(PROMPTS, name), 'utf8')
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`prompt ${name}: no value for {{${k}}}`)
    const v = vars[k]
    return typeof v === 'string' ? v : JSON.stringify(v, null, 1)
  }).replace(/\r\n/g, '\n')
}

function sumUsage(list) {
  const u = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 }
  for (const a of list) {
    u.prompt_tokens += a.usage?.prompt_tokens || 0
    u.completion_tokens += a.usage?.completion_tokens || 0
    u.reasoning_tokens += a.usage?.completion_tokens_details?.reasoning_tokens || 0
  }
  return u
}

/** Remove a stage's earlier call logs (by stage name) so build/director/ shows only the current run. */
export function resetLog(ctx, stage) {
  const indexFile = ctx.file(path.join('director', 'index.json'))
  const index = readJSON(indexFile, [])
  for (const e of index.filter((e) => e.stage === stage)) fs.rmSync(ctx.file(path.join('director', e.file)), { force: true })
  writeJSON(indexFile, index.filter((e) => e.stage !== stage))
}

/**
 * One director call. `messages` may extend the system+user pair (retries add the previous answer
 * and the list of problems). Returns the parsed JSON object.
 */
// attempts: forced-call tries when the answer is not valid JSON (each is paid; a capped step lowers it)
export async function ask(ctx, { stage, step, messages, schema, name, description, max_tokens = 40000, effort, attempts: tries = 3 }) {
  const model = ctx.config.models.director
  const take = ctx.config.director?.take ?? 0
  const reasoning_effort = effort || ctx.config.director?.reasoning_effort || 'medium'
  const key = hash({ model, messages, schema, name, take, reasoning_effort }, 24)
  const cacheFile = ctx.file(path.join('cache', 'director', `${key}.json`))
  let entry
  if (process.env.TIMELINE_FRESH !== '1' && fs.existsSync(cacheFile)) {
    entry = { ...readJSON(cacheFile), cached: true }
  } else {
    const attempts = []
    const t0 = Date.now()
    const response = await ctx.client.chatJSON({
      model, messages, schema, name, description, max_tokens, reasoning_effort, attempts: tries, timeoutMs: 20 * 60_000,
      onResponse: (r) => attempts.push({ usage: r.usage, finish_reason: r.raw?.choices?.[0]?.finish_reason, reasoning: r.reasoning }),
    })
    const usage = sumUsage(attempts)
    const card = await ctx.client.modelPrice(model)
    const cost = (usage.prompt_tokens * Number(card.prompt_token_price || 0) + usage.completion_tokens * Number(card.completion_token_price || 0)) / 1e6
    entry = { model, reasoning_effort, at: new Date().toISOString(), seconds: +((Date.now() - t0) / 1000).toFixed(1), usage, cost_usd: +cost.toFixed(5), attempts, messages, tool: { name, description, parameters: schema }, response }
    writeJSON(cacheFile, entry)
  }
  const file = `${step}.json`
  writeJSON(ctx.file(path.join('director', file)), { stage, step, cached: !!entry.cached, ...entry })
  const indexFile = ctx.file(path.join('director', 'index.json'))
  const index = readJSON(indexFile, []).filter((e) => e.file !== file)
  // `at`/`cost_usd` are of the original call; `cached` means this run replayed it for free
  index.push({ stage, step, file, model, reasoning_effort: entry.reasoning_effort, at: entry.at, cached: !!entry.cached, seconds: entry.seconds, usage: entry.usage, cost_usd: entry.cost_usd })
  writeJSON(indexFile, index.sort((a, b) => String(a.at).localeCompare(String(b.at))))
  const u = entry.usage
  ctx.log(`  M3.1 ${step}: ${u.prompt_tokens} in / ${u.completion_tokens} out (${u.reasoning_tokens} thinking, effort ${entry.reasoning_effort})${entry.cached ? ' [replayed from cache]' : `, $${entry.cost_usd.toFixed(4)}`}`)
  return entry.response
}

/**
 * ask(), check, and if the check finds problems, ask once more with the previous answer and the
 * problem list. check(raw) -> { value, problems: [string], ...extra }.
 */
export async function askChecked(ctx, opts, check) {
  const raw = await ask(ctx, opts)
  const first = check(raw)
  if (!first.problems.length) return { ...first, retried: false }
  ctx.log(`  ${opts.step}: ${first.problems.length} problem(s), asking once more:\n    - ${first.problems.slice(0, 12).join('\n    - ')}`)
  const messages = [
    ...opts.messages,
    { role: 'assistant', content: JSON.stringify(raw) },
    {
      role: 'user',
      content: `The code checks of your ${opts.step} found these problems:\n- ${first.problems.join('\n- ')}\n\nFix every one of them and submit the complete ${opts.step} again (all fields, not a diff). Keep everything that was not a problem.`,
    },
  ]
  const raw2 = await ask(ctx, { ...opts, step: `${opts.step}.retry`, messages })
  const second = check(raw2)
  if (second.problems.length) ctx.log(`  ${opts.step}: still ${second.problems.length} problem(s) after the retry:\n    - ${second.problems.slice(0, 12).join('\n    - ')}`)
  // keep whichever answer has fewer problems
  return second.problems.length <= first.problems.length ? { ...second, retried: true } : { ...first, retried: true }
}
