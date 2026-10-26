// OSM element helpers: ids, names (with fuzzy transliteration matching), element geometry.
import { assembleRings, isClosed, pointInRing, ringAreaM2 } from './geom.mjs'

export const osmId = (el) => `${el.type}/${el.id}`

/** [lon, lat] of a node, or the center of a way/relation printed with `out center`. */
export const elPoint = (el) => (el.lon != null ? [el.lon, el.lat] : el.center ? [el.center.lon, el.center.lat] : null)

/** Coordinates of a way (or relation member) printed with `out geom`. */
export const geomCoords = (geometry) => (geometry || []).filter(Boolean).map((g) => [g.lon, g.lat])

/** Overpass QL: a value used inside a "regex" string, with regex/quote specials as wildcards. */
export const qlRe = (s) => String(s).replace(/[\\^$.|?*+()[\]{}"']/g, '.')
export const qlStr = (s) => String(s).replace(/[\\"]/g, '\\$&')

const LATIN = /[a-z]/i

/** Drop "(Yellow Line)" style qualifiers and "metro station" suffixes from a station name. */
export const cleanName = (s = '') =>
  String(s)
    .replace(/\s*\([^)]*\b(?:line|metro|station|branch|platform|interchange)\b[^)]*\)\s*$/i, '')
    .replace(/\s+(?:metro\s+|railway\s+|rail\s+)?station$/i, '')
    .trim()

/** Lower-case ASCII words: "Hauz Khás (Yellow Line)" -> "hauz khas". */
export const normName = (s = '') =>
  cleanName(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Consonant skeleton that survives transliteration variants: Qutab/Qutub/Qutb -> "ktb". */
export const skeleton = (s) =>
  normName(s)
    .split(' ')
    .map((w) => (w[0] || '') + w.slice(1).replace(/[aeiouy]/g, ''))
    .join(' ')
    .replace(/q/g, 'k')
    .replace(/w/g, 'v')
    .replace(/z/g, 'j')
    .replace(/ph/g, 'f')
    .replace(/(.)\1+/g, '$1')

export const slug = (s) => normName(s).replace(/ /g, '_') || 'x'

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

/** Every name an element is known by (name, name:en, alt/old/official/short names). */
export function namesOf(tags = {}) {
  const keys = ['name', 'name:en', 'alt_name', 'alt_name:en', 'old_name', 'old_name:en', 'official_name', 'official_name:en', 'short_name', 'loc_name']
  return keys.flatMap((k) => String(tags[k] || '').split(';')).map((s) => s.trim()).filter(Boolean)
}

/** 0..1 similarity of two names (exact > skeleton > edit distance > containment). */
export function nameSimilarity(a, b) {
  const na = normName(a), nb = normName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (skeleton(a) === skeleton(b)) return 0.92
  if (skeleton(a).replace(/ /g, '') === skeleton(b).replace(/ /g, '')) return 0.9 // Jor Bagh / Jorbagh
  const ratio = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length)
  if (ratio >= 0.8) return ratio * 0.9
  if (` ${nb} `.includes(` ${na} `) || ` ${na} `.includes(` ${nb} `)) return 0.75
  return 0
}

export const nameScore = (wanted, tags) => Math.max(0, ...namesOf(tags).map((n) => nameSimilarity(wanted, n)))

/** English display name: name:en when `name` is not in Latin script, minus line qualifiers. */
export function displayName(tags = {}) {
  const n = tags.name && LATIN.test(tags.name) ? tags.name : tags['name:en'] || tags.name || tags['official_name:en'] || ''
  return cleanName(n)
}

/** Local-script name: name:<lang>, or `name` itself when it is not Latin. */
export function localName(tags = {}, lang) {
  if (lang && tags[`name:${lang}`]) return tags[`name:${lang}`]
  if (tags.name && !LATIN.test(tags.name)) return tags.name
  return null
}

/**
 * Polygons of an area element: closed way or multipolygon/boundary relation printed with
 * `out geom`. Returns [[outer, ...holes], ...] (rings of [lon, lat]).
 */
export function areaPolygons(el) {
  if (el.type === 'way') {
    const c = geomCoords(el.geometry)
    return isClosed(c) && c.length >= 4 ? [[c]] : []
  }
  if (el.type !== 'relation' || !el.members) return []
  const ways = (role) => el.members.filter((m) => m.type === 'way' && role(m.role)).map((m) => geomCoords(m.geometry))
  const outers = assembleRings(ways((r) => r === 'outer' || r === ''))
  const inners = assembleRings(ways((r) => r === 'inner'))
  const polys = outers.map((o) => [o])
  for (const h of inners) {
    const host = polys.find((p) => pointInRing(h[0], p[0]))
    if (host) host.push(h)
  }
  return polys.sort((a, b) => ringAreaM2(b[0]) - ringAreaM2(a[0]))
}

/** Open polylines of a way (or of a relation's way members). */
export function elementLines(el) {
  if (el.type === 'way') return [geomCoords(el.geometry)].filter((c) => c.length >= 2)
  if (el.type === 'relation') return (el.members || []).filter((m) => m.type === 'way').map((m) => geomCoords(m.geometry)).filter((c) => c.length >= 2)
  return []
}
