// English Wikipedia: REST page summary (canonical title, URL, description) and plain-text
// leads (batched action=query extracts), trimmed to excerpts. Text: CC BY-SA 4.0.
const API = 'https://en.wikipedia.org/w/api.php'
const REST = 'https://en.wikipedia.org/api/rest_v1/page/summary/'

const norm = (t) => String(t || '').replace(/_/g, ' ').trim()
export const pageUrl = (title) => `https://en.wikipedia.org/wiki/${encodeURIComponent(norm(title).replace(/ /g, '_'))}`

/** REST summary -> { title, url, description, extract } or null (missing / disambiguation). */
export async function summary(http, title) {
  const j = await http.get(REST + encodeURIComponent(norm(title).replace(/ /g, '_')), { kind: 'wikipedia', label: `wikipedia summary "${title}"`, timeoutMs: 20_000 })
  if (!j || j.type === 'disambiguation' || !j.title) return null
  return {
    title: norm(j.titles?.normalized || j.title),
    url: j.content_urls?.desktop?.page || pageUrl(j.title),
    description: j.description || null,
    extract: j.extract || '',
  }
}

/** Plain-text intro sections for many titles (20 per request) -> Map(title -> text). */
export async function leads(http, titles) {
  const out = new Map()
  const list = [...new Set(titles.map(norm))].filter(Boolean)
  for (let i = 0; i < list.length; i += 20) {
    const part = list.slice(i, i + 20)
    const params = new URLSearchParams({ action: 'query', prop: 'extracts', exintro: '1', explaintext: '1', exlimit: '20', redirects: '1', titles: part.join('|'), format: 'json', formatversion: '2' })
    const j = await http.get(`${API}?${params}`, { kind: 'wikipedia', label: `wikipedia leads (${part.length})` })
    if (!j?.query) continue
    const alias = new Map() // asked title -> final title (normalisation, redirects)
    for (const n of [...(j.query.normalized || []), ...(j.query.redirects || [])]) alias.set(norm(n.from), norm(n.to))
    const byTitle = new Map((j.query.pages || []).filter((p) => p.extract).map((p) => [norm(p.title), p.extract]))
    for (const t of part) {
      let final = t
      for (let k = 0; k < 3 && alias.has(final); k++) final = alias.get(final)
      if (byTitle.has(final)) out.set(t, byTitle.get(final))
    }
  }
  return out
}

/** Tidy explaintext leftovers: emptied pronunciation brackets, doubled spaces. */
export function clean(text) {
  return String(text || '')
    .replace(/\(\s*(?:[;,:]\s*)*\)/g, '')
    .replace(/\(\s*[;,]\s*/g, '(')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim()
}

const ABBR = /(?:\b(?:c|ca|St|Dr|Mr|Mrs|Ms|Lt|Col|Gen|Sr|Jr|approx|No|vs|i\.e|e\.g|A\.D|B\.C|C\.E|B\.C\.E|[A-Z]))$/
export function sentences(text) {
  const parts = clean(text).split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/)
  const out = []
  for (const p of parts) {
    if (out.length && ABBR.test(out[out.length - 1].replace(/\.$/, ''))) out[out.length - 1] += ` ${p}`
    else out.push(p)
  }
  return out.filter(Boolean)
}

/**
 * Lead -> excerpt of at most `max` chars, in original order: the opening sentences first,
 * then sentences with dates (the `years` given, any 3-4 digit year, centuries), then the rest.
 */
export function excerpt(text, { max = 1500, years = [] } = {}) {
  const all = sentences(text)
  if (!all.length) return ''
  if (all.join(' ').length <= max) return all.join(' ')
  const want = years.filter((y) => y != null).map(String)
  const pri = all.map((s, i) => {
    if (i < 2) return 0
    if (want.some((y) => s.includes(y))) return 1
    if (/\b(1[0-9]{3}|[2-9][0-9]{2})\b|\bcentur(y|ies)\b/i.test(s)) return 2
    return 3
  })
  const order = all.map((_, i) => i).sort((a, b) => pri[a] - pri[b] || a - b)
  const keep = new Set()
  let len = 0
  for (const i of order) {
    const add = all[i].length + 3
    if (len + add > max) continue
    keep.add(i)
    len += add
  }
  let out = ''
  let prev = -1
  for (let i = 0; i < all.length; i++) {
    if (!keep.has(i)) continue
    out += (out ? (i === prev + 1 ? ' ' : ' … ') : '') + all[i]
    prev = i
  }
  return (out || all[0].slice(0, max - 1) + '…').slice(0, max)
}
