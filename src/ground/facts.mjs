// Facts: plain claims derived from Wikidata statements, the Wikidata source excerpt that states
// them, and the project's curated facts_file ([{id, claim, year?, sources:[{url,publisher}], narration_line?}]).
import fs from 'node:fs'
import { DATE_PROPS, ordinal } from './wikidata.mjs'

const an = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a')
const list = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

/** "1639" / "around 1295" / "the 1630s" / "the 13th century" / "1311–1316". */
function when(d) {
  const circa = d.text.startsWith('c. ')
  const t = circa ? d.text.slice(3) : d.text
  const core = d.precision === 'decade' || d.precision === 'century' || d.precision === 'millennium' ? `the ${t}` : t
  return circa ? `around ${core}` : core
}

/** Simple claims for one site: its date, its heritage designations. */
export function siteClaims(site) {
  const out = []
  const d = site.date
  if (d) {
    const w = when(d)
    const opened = w.startsWith('around') ? w : d.precision === 'range' ? `between ${w.replace('–', ' and ')}` : `in ${w}`
    const claim = d.prop === 'P1619' ? `${site.label} was officially opened ${opened}.` : `${site.label} dates from ${w}.`
    out.push({ kind: 'date', claim, year: d.year })
  }
  if (site.heritage.length) {
    const hs = site.heritage.map((h) => `${an(h.label)} ${h.label}`)
    out.push({ kind: 'heritage', claim: `${site.label} is designated ${list(hs)}.`, year: null })
  }
  return out
}

/** Does a Wikipedia excerpt mention the site's date (same year / same century)? */
export function mentionsDate(text, d) {
  if (!d || !text) return false
  if (d.precision === 'year' || d.precision === 'range') return String(text).includes(String(Math.abs(d.year)))
  if (d.precision === 'decade') return String(text).includes(`${Math.abs(d.year)}s`)
  if (d.precision === 'century') {
    const n = Math.floor((Math.abs(d.year) - 1) / 100) + 1
    if (new RegExp(`\\b${ordinal(n)}[ -]century`, 'i').test(text)) return true
    return d.year > 0 && yearsIn(text).some((y) => y >= d.year && y < d.year + 100) // "402 CE" for the 5th century
  }
  return false
}

const yearsIn = (text) => [...String(text).matchAll(/\b(\d{3,4})\b(?!\s*(?:m|km|ft|feet|metres|meters|steps|acres|hectares)\b|\s*%)/g)].map((m) => Number(m[1])).filter((y) => y >= 300 && y <= 2100)

/**
 * A Wikidata date the Wikipedia lead contradicts: not mentioned there, while the lead's earliest
 * year is a century or more older (Ghalib ki Haveli "2000" vs a lead about 1869).
 */
export function doubtfulDate(text, d) {
  if (!d || !text || d.year < 1000 || mentionsDate(text, d)) return false
  const ys = yearsIn(text).filter((y) => y >= 1000)
  return ys.length > 0 && d.year - Math.min(...ys) >= 100
}

/** The Wikidata source excerpt: the structured facts, stated plainly. */
export function wikidataExcerpt(site) {
  const parts = [`${site.label} (Wikidata ${site.qid})${site.description ? `: ${site.description}` : ''}.`]
  if (site.types.length) parts.push(`Instance of: ${site.types.map((t) => t.label).join(', ')}.`)
  if (site.date) parts.push(`${DATE_PROPS[site.date.prop][0].toUpperCase()}${DATE_PROPS[site.date.prop].slice(1)} (${site.date.prop}): ${site.date.text}.`)
  if (site.heritage.length) parts.push(`Heritage designation (P1435): ${site.heritage.map((h) => h.label).join('; ')}.`)
  if (site.partOf.length) parts.push(`Part of: ${site.partOf.map((p) => p.label).join('; ')}.`)
  if (site.wdCoord) parts.push(`Coordinates: ${site.wdCoord[1].toFixed(4)}° N, ${site.wdCoord[0].toFixed(4)}° E.`)
  if (site.enwiki) parts.push(`English Wikipedia article: ${site.enwiki}.`)
  parts.push(`Wikipedia language editions (sitelinks): ${site.sitelinks}.`)
  return parts.join(' ').slice(0, 1500)
}

const PUBLISHERS = [
  [/(^|\.)wikipedia\.org$/, 'Wikipedia'], [/(^|\.)wikidata\.org$/, 'Wikidata'], [/(^|\.)asi\.nic\.in$/, 'ASI'],
  [/(^|\.)unesco\.org$/, 'UNESCO'], [/(^|\.)britannica\.com$/, 'Britannica'], [/(^|\.)delhimetrorail\.com$/, 'DMRC'],
  [/(^|\.)openstreetmap\.org$/, 'OpenStreetMap'], [/(^|\.)pib\.gov\.in$/, 'PIB'], [/(^|\.)thehindu\.com$/, 'The Hindu'],
]
const hostOf = (url) => {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return null
  }
}
export const publisherOf = (url) => PUBLISHERS.find(([re]) => re.test(hostOf(url) || ''))?.[1] || hostOf(url)

/** Page titles that are a bot wall, not the page (Cloudflare, Akamai, ...): never shown as a source title. */
export const BOT_TITLE = /^\s*(client challenge|just a moment|access denied|attention required|are you a robot|security check|robot check|403\b|forbidden|captcha)/i
export const realTitle = (t) => (t && !BOT_TITLE.test(t) ? t : null)

/**
 * Short publisher for citation chips: the canonical name for well-known hosts, else the text
 * before any "(" or "," of the curated publisher ("The Hindu, 3 Sep 2010" -> "The Hindu"),
 * else the host.
 */
export function shortPublisher(publisher, url) {
  const known = PUBLISHERS.find(([re]) => re.test(hostOf(url) || ''))?.[1]
  if (known) return known
  const p = String(publisher || '').split(/\s*[(,;]/)[0].trim()
  if (!p || p.length > 40 || /evidence|pointer|used only|^sources?$/i.test(p)) return hostOf(url) || p || null
  return p
}

/** Curated facts from project.yaml `facts_file` (missing file -> []). Malformed entries are skipped. */
export function readFactsFile(file, log = () => {}) {
  if (!file || !fs.existsSync(file)) {
    if (file) log(`ground: no facts file at ${file}; continuing without curated facts`)
    return []
  }
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    log(`ground: facts file ${file} is not valid JSON (${err.message}); ignored`)
    return []
  }
  const arr = Array.isArray(data) ? data : Array.isArray(data?.facts) ? data.facts : []
  const ok = arr.filter((f) => f && typeof f.claim === 'string' && f.claim.trim() && Array.isArray(f.sources) && f.sources.some((s) => /^https?:\/\//.test(s?.url || '')))
  if (ok.length < arr.length) log(`ground: facts file: skipped ${arr.length - ok.length} entries without a claim or an http(s) source`)
  return ok
}
