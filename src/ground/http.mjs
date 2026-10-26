// Cached, serialised HTTP for the ground stage: one request at a time, per-host pacing
// (Wikidata SPARQL <= 1 req/s), every response kept in build/cache/ground/<kind>/<hash>.json.
// Failures (timeouts, 5xx/429 after retries) return null and are logged, never thrown.
import fs from 'node:fs'
import path from 'node:path'
import { hash, sleep } from '../util.mjs'

export const UA = 'TimeLine/0.1 (open-source city map-film tool; Node.js) timeline-city/0.1'
const PACE_MS = { 'query.wikidata.org': 1100, 'www.wikidata.org': 1000, 'en.wikipedia.org': 250 }
const DEFAULT_PACE_MS = 1000

class HttpError extends Error {
  constructor(status, label) {
    super(`HTTP ${status} for ${label}`)
    this.status = status
  }
}

/** One request with retries on 429/5xx/network errors (honours Retry-After); other 4xx fail fast. */
async function fetchRetry(url, opts, { retries, timeoutMs, label }) {
  for (let attempt = 0; ; attempt++) {
    let retryAfter = 0
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) })
      if (res.ok) return await res.text()
      if (res.status !== 429 && res.status < 500) throw new HttpError(res.status, label)
      retryAfter = Number(res.headers.get('retry-after')) * 1000 || 0
      if (attempt >= retries) throw new HttpError(res.status, label)
    } catch (err) {
      if (err instanceof HttpError && (err.status < 500 && err.status !== 429)) throw err
      if (attempt >= retries) throw err
    }
    await sleep(Math.min(Math.max(retryAfter, 3000 * (attempt + 1)), 60_000))
  }
}

export function createFetcher({ cacheDir, log = () => {} }) {
  let queue = Promise.resolve()
  const last = new Map()
  const stats = { cached: 0, network: 0, failed: 0 }
  const failures = []

  async function go(url, { kind = 'misc', method = 'GET', body, headers = {}, as = 'json', label = url, timeoutMs = 30_000, retries = 2 }) {
    const file = path.join(cacheDir, kind, `${hash(`${method} ${url} ${body || ''}`)}.json`)
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      stats.cached++
      const hit = JSON.parse(fs.readFileSync(file, 'utf8'))
      return hit.status === 200 ? hit.data : null
    }
    const host = new URL(url).host
    const wait = (last.get(host) || 0) + (PACE_MS[host] ?? DEFAULT_PACE_MS) - Date.now()
    if (wait > 0) await sleep(wait)
    stats.network++
    try {
      const text = await fetchRetry(url, { method, body, headers: { 'User-Agent': UA, ...headers } }, { retries, timeoutMs, label })
      const data = as === 'json' ? JSON.parse(text) : as === 'title' ? htmlTitle(text) : text.slice(0, 200_000)
      save(file, { url, method, body: body ? String(body).slice(0, 4000) : undefined, fetched_at: new Date().toISOString(), status: 200, data })
      return data
    } catch (err) {
      stats.failed++
      // definite misses (404 etc.) are cached so reruns don't ask again; timeouts are not
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) save(file, { url, method, fetched_at: new Date().toISOString(), status: err.status })
      failures.push({ label, url, error: String(err.message).slice(0, 200) })
      log(`ground: skip ${label}: ${String(err.message).slice(0, 160)}`)
      return null
    } finally {
      last.set(host, Date.now())
    }
  }

  /** GET/POST url -> parsed JSON (or text with as:'text'), or null on failure. Serialised. */
  function get(url, opts = {}) {
    const job = queue.then(() => go(url, opts))
    queue = job.catch(() => {})
    return job
  }

  return { get, stats, failures }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' }
/** <title> of an HTML page (entities decoded), or null. */
export function htmlTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return null
  const t = m[1]
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (s, n) => ENTITIES[n.toLowerCase()] ?? s)
    .replace(/\s+/g, ' ')
    .trim()
  return t ? t.slice(0, 300) : null
}

function save(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj))
}
