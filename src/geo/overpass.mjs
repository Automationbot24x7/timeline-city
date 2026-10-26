// Overpass API client: one query at a time, polite pauses, mirror fallback, and raw
// responses cached as build/cache/overpass/<hash>.json (+ the .overpassql that made them).
import fs from 'node:fs'
import path from 'node:path'
import { hash, politeFetch, sleep } from '../util.mjs'

export const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
const PAUSE_MS = 5000 // between network queries

let queue = Promise.resolve()
let lastNetwork = 0

/** Run an Overpass QL query (serialised with every other call in this process). */
export function overpass(ql, opts = {}) {
  const job = queue.then(() => runQuery(ql, opts))
  queue = job.catch(() => {})
  return job
}

async function runQuery(ql, { cacheDir, log = () => {}, label = 'query' }) {
  const key = hash(ql)
  const file = cacheDir && path.join(cacheDir, `${key}.json`)
  if (file && fs.existsSync(file) && fs.statSync(file).size > 0) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    log(`overpass ${label}: cached ${key} (${doc.elements.length} elements)`)
    return doc
  }
  let lastErr
  for (const url of ENDPOINTS) {
    const wait = lastNetwork + PAUSE_MS - Date.now()
    if (wait > 0) await sleep(wait)
    const host = new URL(url).host
    const t0 = Date.now()
    try {
      log(`overpass ${label}: querying ${host}`)
      const res = await politeFetch(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ data: ql }).toString(),
          timeoutMs: 240_000,
        },
        { retries: 2, label: `overpass ${label}` },
      )
      const text = await res.text()
      const doc = JSON.parse(text)
      if (/runtime error|timed out|out of memory|rate_limited/i.test(doc.remark || '')) throw new Error(doc.remark)
      if (file) {
        fs.mkdirSync(cacheDir, { recursive: true })
        fs.writeFileSync(file, text)
        fs.writeFileSync(path.join(cacheDir, `${key}.overpassql`), ql)
      }
      log(`overpass ${label}: ${doc.elements.length} elements, ${(text.length / 1e6).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      return doc
    } catch (err) {
      lastErr = err
      log(`overpass ${label}: ${host} failed: ${err.message}`)
    } finally {
      lastNetwork = Date.now()
    }
  }
  throw new Error(`Overpass query "${label}" failed on all endpoints: ${lastErr?.message}`)
}
