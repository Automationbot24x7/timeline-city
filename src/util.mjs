// Small shared helpers: JSON IO, content-hash caching, ffprobe, HTTP with polite retries.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function readJSON(file, fallback) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback
    throw new Error(`Missing ${file}`)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
  return file
}

export function hash(value, len = 16) {
  return crypto.createHash('sha1').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, len)
}

/** Run fn() once per key; the result path is reused while the file exists. */
export async function cachedFile(dir, key, ext, fn) {
  const file = path.join(dir, `${hash(key)}${ext}`)
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file
  fs.mkdirSync(dir, { recursive: true })
  await fn(file)
  return file
}

export function mediaDuration(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  return Number(out.trim())
}

/** fetch() with a descriptive User-Agent (required by Wikimedia/Overpass policies) and retries. */
export async function politeFetch(url, opts = {}, { retries = 4, label = url } = {}) {
  const headers = { 'User-Agent': 'timeline-city/0.1 (open-source city film tool)', ...(opts.headers || {}) }
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...opts, headers, signal: AbortSignal.timeout(opts.timeoutMs || 180_000) })
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(4000 * (attempt + 1))
        continue
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${label}`)
      return res
    } catch (err) {
      if (attempt >= retries) throw err
      await sleep(4000 * (attempt + 1))
    }
  }
}
