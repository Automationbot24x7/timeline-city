// SandBase API client: chat (MiniMax M3.1 flash is the director), media runs, downloads.
// Every call is appended to build/costs.jsonl so a film's spend is auditable.
import fs from 'node:fs'
import path from 'node:path'

const UA = 'timeline-city/0.1 (+https://github.com)' // Cloudflare rejects some default agents (error 1010)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TERMINAL = new Set(['completed', 'failed', 'timeout', 'cancelled', 'canceled', 'error'])

export class SandBaseError extends Error {
  constructor(status, body, where) {
    super(`SandBase ${status} at ${where}: ${String(body).slice(0, 1500)}`)
    this.status = status
    this.body = body
  }
}

export function createClient({
  apiKey = process.env.SANDBASE_API_KEY,
  baseUrl = process.env.SANDBASE_BASE_URL || 'https://api.sandbase.ai/v1',
  ledgerFile = null,
  mock = false,
  log = () => {},
} = {}) {
  if (!apiKey && !mock) throw new Error('SANDBASE_API_KEY missing: put it in .env')
  baseUrl = baseUrl.replace(/\/$/, '')
  const priceCache = new Map()

  function ledger(entry) {
    if (!ledgerFile) return
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true })
    fs.appendFileSync(ledgerFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  }

  // One concurrent media run per organization on small plans: back off on 429.
  // Network errors and timeouts are retried too, except for POST /run: a lost response there may
  // still have started a paid job, which run() then resumes by id instead of paying twice.
  async function request(method, urlPath, body, { retries = 30, timeoutMs = 300_000 } = {}) {
    const url = urlPath.startsWith('http') ? urlPath : baseUrl + urlPath
    const netRetries = method === 'GET' ? 4 : urlPath === '/run' ? 0 : 2
    for (let attempt = 0, net = 0; ; attempt++) {
      let res
      let text
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': UA,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
        text = await res.text()
      } catch (err) {
        if (net++ >= netRetries) throw err
        log(`  sandbase: ${method} ${urlPath}: ${err.name === 'TimeoutError' ? 'timeout' : err.cause?.code || err.message}; retrying`)
        await sleep(3000 * net)
        continue
      }
      if (res.status === 429 && attempt < retries) {
        await sleep(Math.min(5000 * (attempt + 1), 30_000))
        continue
      }
      if ((res.status >= 500 && res.status < 600) && attempt < 3) {
        await sleep(3000 * (attempt + 1))
        continue
      }
      if (!res.ok) throw new SandBaseError(res.status, text, `${method} ${urlPath}`)
      return { json: text ? JSON.parse(text) : null, headers: res.headers }
    }
  }

  async function modelPrice(model) {
    if (priceCache.has(model)) return priceCache.get(model)
    let card = {}
    try {
      card = (await request('GET', `/models/${model}`)).json?.model_card || {}
    } catch {}
    priceCache.set(model, card)
    return card
  }

  /** Plain chat completion. Returns { content, reasoning, toolCalls, usage, raw }. */
  // timeoutMs: optional HTTP timeout for long reasoning calls (default 300 s)
  async function chat({ model, messages, max_tokens = 4000, temperature, tools, tool_choice, timeoutMs, ...rest }) {
    const body = { model, messages, max_tokens, ...rest }
    if (temperature !== undefined) body.temperature = temperature
    if (tools) body.tools = tools
    if (tool_choice) body.tool_choice = tool_choice
    const { json, headers } = await request('POST', '/chat/completions', body, timeoutMs ? { timeoutMs } : undefined)
    const msg = json.choices?.[0]?.message || {}
    const usage = json.usage || {}
    const card = await modelPrice(model)
    const cost =
      ((usage.prompt_tokens || 0) * Number(card.prompt_token_price || 0) +
        (usage.completion_tokens || 0) * Number(card.completion_token_price || 0)) / 1e6
    ledger({ kind: 'chat', model, usage, est_cost_usd: +cost.toFixed(6), task_id: headers.get('x-task-id') || json.id })
    return { content: msg.content || '', reasoning: msg.reasoning_content || '', toolCalls: msg.tool_calls || [], usage, raw: json }
  }

  /**
   * Structured output. M3.1 flash ignores response_format json_schema, but honours a forced
   * function call, so the schema is sent as the parameters of a single required tool.
   */
  // onResponse(res): optional hook that sees each raw chat result (usage, reasoning) for transparency logs
  async function chatJSON({ model, messages, schema, name = 'submit', description = 'Submit the result', max_tokens = 16000, attempts = 3, onResponse, ...rest }) {
    let lastErr
    for (let i = 0; i < attempts; i++) {
      const res = await chat({
        model,
        messages,
        max_tokens,
        tools: [{ type: 'function', function: { name, description, parameters: schema } }],
        tool_choice: { type: 'function', function: { name } },
        ...rest,
      })
      onResponse?.(res)
      const call = res.toolCalls.find((c) => c.function?.name === name) || res.toolCalls[0]
      const text = call?.function?.arguments ?? res.content
      try {
        return JSON.parse(text)
      } catch (err) {
        const m = String(text).match(/\{[\s\S]*\}/)
        if (m) {
          try {
            return JSON.parse(m[0])
          } catch {}
        }
        lastErr = err
      }
    }
    throw new Error(`chatJSON: no valid JSON after ${attempts} attempts: ${lastErr?.message}`)
  }

  /** Media generation via POST /v1/run, polled until terminal. Returns the run object. */
  // estCost: caller's price estimate from the card's price_formula (logged as est_cost_usd)
  // onSubmitted(run): called right after the POST (persist run.id); resumeId: poll that earlier run instead of submitting
  async function run(model, params, { pollMs = 3000, timeoutMs = 20 * 60_000, estCost, onSubmitted, resumeId } = {}) {
    if (mock) throw new Error(`mock mode: refusing real run of ${model}`)
    let out
    if (resumeId) out = (await request('GET', `/run/${resumeId}`)).json
    else {
      out = (await request('POST', '/run', { model, ...params })).json
      if (out?.id) onSubmitted?.(out)
    }
    const deadline = Date.now() + timeoutMs
    while (out && !TERMINAL.has(out.status)) {
      if (Date.now() > deadline) throw new Error(`run ${out.id} of ${model} timed out`)
      await sleep(pollMs)
      out = (await request('GET', `/run/${out.id}`)).json
    }
    const card = await modelPrice(model)
    ledger({ kind: 'run', model, run_id: out?.id, status: out?.status, base_price_usd: Number(card.base_price || 0), params_keys: Object.keys(params), ...(estCost !== undefined && { est_cost_usd: estCost }) })
    if (out?.status !== 'completed') throw new Error(`run of ${model} ended ${out?.status}: ${JSON.stringify(out).slice(0, 1500)}`)
    return out
  }

  async function download(url, dest, { retries = 3, timeoutMs = 120_000 } = {}) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) })
        if (!res.ok) throw Object.assign(new Error(`download ${res.status}: ${url.split('?')[0]}`), { status: res.status })
        fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
        return dest
      } catch (err) {
        if (attempt >= retries || (err.status >= 400 && err.status < 500 && err.status !== 429)) throw err
        log(`  sandbase: download failed (${err.message}); retrying`)
        await sleep(3000 * (attempt + 1))
      }
    }
  }

  return { request, chat, chatJSON, run, download, modelPrice, mock }
}
