// JSON writer for geo.json: indented like writeJSON, but coordinate arrays and small flat
// objects stay on one line (pretty-printing every coordinate would triple the file size).

const flat = (v) =>
  v === null || typeof v !== 'object' ? true : Array.isArray(v) ? v.every((x) => x === null || typeof x !== 'object' || (Array.isArray(x) && flat(x))) : false

const flatObject = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => x === null || typeof x !== 'object')

export function stringifyGeo(v, ind = '') {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (flat(v)) return JSON.stringify(v)
  if (flatObject(v)) {
    const s = JSON.stringify(v)
    if (s.length <= 100) return s
  }
  const next = ind + '  '
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => next + stringifyGeo(x, next)).join(',\n')}\n${ind}]` : '[]'
  const entries = Object.entries(v).filter(([, x]) => x !== undefined)
  if (!entries.length) return '{}'
  return `{\n${entries.map(([k, x]) => `${next}${JSON.stringify(k)}: ${stringifyGeo(x, next)}`).join(',\n')}\n${ind}}`
}
