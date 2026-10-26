// Geometry on [lon, lat] arrays (GeoJSON order): distances, projection onto polylines,
// slicing, Douglas-Peucker, bbox clipping, line merging and ring assembly.
// Planar maths use a local equirectangular frame in metres (plenty at city scale).

const R_KM = 6371.0088
const RAD = Math.PI / 180
const M_PER_DEG = 111_320

export function haversineKm(a, b) {
  const dLat = (b[1] - a[1]) * RAD
  const dLon = (b[0] - a[0]) * RAD
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}
export const distM = (a, b) => haversineKm(a, b) * 1000

export function cumulativeKm(coords) {
  const out = [0]
  for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + haversineKm(coords[i - 1], coords[i]))
  return out
}
export const lengthKm = (coords) => (coords.length > 1 ? cumulativeKm(coords).at(-1) : 0)

/** Nearest point of a polyline to p: { i (segment), t, km (along line), distM, point }. */
export function project(coords, p, cum = cumulativeKm(coords)) {
  if (coords.length < 2) return { i: 0, t: 0, km: 0, distM: coords.length ? distM(coords[0], p) : Infinity, point: coords[0] }
  const kx = Math.cos(p[1] * RAD) * M_PER_DEG
  let bi = 0, bt = 0, bd = Infinity
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = (coords[i][0] - p[0]) * kx, ay = (coords[i][1] - p[1]) * M_PER_DEG
    const dx = (coords[i + 1][0] - coords[i][0]) * kx, dy = (coords[i + 1][1] - coords[i][1]) * M_PER_DEG
    const len2 = dx * dx + dy * dy
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0
    const d = Math.hypot(ax + t * dx, ay + t * dy)
    if (d < bd) [bi, bt, bd] = [i, t, d]
  }
  const a = coords[bi], b = coords[bi + 1]
  return { i: bi, t: bt, distM: bd, km: cum[bi] + (cum[bi + 1] - cum[bi]) * bt, point: [a[0] + (b[0] - a[0]) * bt, a[1] + (b[1] - a[1]) * bt] }
}

/** Point at distance km along the polyline. */
export function pointAt(coords, cum, km) {
  if (km <= 0) return coords[0].slice()
  for (let i = 1; i < coords.length; i++) {
    if (cum[i] >= km) {
      const t = cum[i] > cum[i - 1] ? (km - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0
      return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t]
    }
  }
  return coords.at(-1).slice()
}

/** Sub-polyline between km0 < km1 (interpolated ends). */
export function sliceLine(coords, cum, km0, km1) {
  const out = [pointAt(coords, cum, km0)]
  for (let i = 0; i < coords.length; i++) if (cum[i] > km0 && cum[i] < km1) out.push(coords[i])
  out.push(pointAt(coords, cum, km1))
  return out
}

function segDistM(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

/** Douglas-Peucker with a tolerance in metres. Works for closed rings too. */
export function simplify(coords, tolM) {
  const n = coords.length
  if (n < 3 || !tolM) return coords.slice()
  const kx = Math.cos(coords[0][1] * RAD) * M_PER_DEG
  const xy = coords.map((c) => [c[0] * kx, c[1] * M_PER_DEG])
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack = [[0, n - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()
    let maxD = -1, idx = -1
    for (let i = s + 1; i < e; i++) {
      const d = segDistM(xy[i], xy[s], xy[e])
      if (d > maxD) [maxD, idx] = [d, i]
    }
    if (maxD > tolM) {
      keep[idx] = 1
      stack.push([s, idx], [idx, e])
    }
  }
  return coords.filter((_, i) => keep[i])
}

/** Round to dp decimals and drop consecutive duplicates. */
export function roundCoords(coords, dp = 5) {
  const f = 10 ** dp
  const out = []
  for (const c of coords) {
    const r = [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f]
    const last = out.at(-1)
    if (!last || last[0] !== r[0] || last[1] !== r[1]) out.push(r)
  }
  return out
}

export const isClosed = (l) => l.length > 2 && l[0][0] === l.at(-1)[0] && l[0][1] === l.at(-1)[1]

/** Simplify + round a closed ring; null when it collapses. */
export function cleanRing(ring, tolM, dp = 5) {
  const r = roundCoords(simplify(ring, tolM), dp)
  if (!isClosed(r)) r.push(r[0].slice())
  return r.length >= 4 ? r : null
}

export function ringAreaM2(ring) {
  if (ring.length < 4) return 0
  const kx = Math.cos(ring[0][1] * RAD) * M_PER_DEG
  let s = 0
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * kx * ring[i + 1][1] * M_PER_DEG - ring[i + 1][0] * kx * ring[i][1] * M_PER_DEG
  return Math.abs(s / 2)
}

export function ringCentroid(ring) {
  let a = 0, x = 0, y = 0
  const [ox, oy] = ring[0]
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = [ring[i][0] - ox, ring[i][1] - oy]
    const [x1, y1] = [ring[i + 1][0] - ox, ring[i + 1][1] - oy]
    const f = x0 * y1 - x1 * y0
    a += f
    x += (x0 + x1) * f
    y += (y0 + y1) * f
  }
  if (Math.abs(a) < 1e-14) return bboxCenter(ring)
  return [ox + x / (3 * a), oy + y / (3 * a)]
}

export function pointInRing(p, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** [w, s, e, n] of a coordinate list. */
export function bboxOf(coords) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  for (const [x, y] of coords) {
    if (x < w) w = x
    if (x > e) e = x
    if (y < s) s = y
    if (y > n) n = y
  }
  return [w, s, e, n]
}
const bboxCenter = (coords) => {
  const [w, s, e, n] = bboxOf(coords)
  return [(w + e) / 2, (s + n) / 2]
}
const boxesTouch = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
const inBox = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]

/** Sutherland-Hodgman clip of a closed ring to box [w, s, e, n]; null when outside. */
export function clipRing(ring, box) {
  const rb = bboxOf(ring)
  if (!boxesTouch(rb, box)) return null
  if (rb[0] >= box[0] && rb[2] <= box[2] && rb[1] >= box[1] && rb[3] <= box[3]) return ring
  let pts = isClosed(ring) ? ring.slice(0, -1) : ring.slice()
  const cutX = (a, b, x) => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])]
  const cutY = (a, b, y) => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y]
  const edges = [
    [(p) => p[0] >= box[0], (a, b) => cutX(a, b, box[0])],
    [(p) => p[0] <= box[2], (a, b) => cutX(a, b, box[2])],
    [(p) => p[1] >= box[1], (a, b) => cutY(a, b, box[1])],
    [(p) => p[1] <= box[3], (a, b) => cutY(a, b, box[3])],
  ]
  for (const [inside, cut] of edges) {
    const out = []
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[(i + pts.length - 1) % pts.length]
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur))
        out.push(cur)
      } else if (inside(prev)) out.push(cut(prev, cur))
    }
    pts = out
    if (pts.length < 3) return null
  }
  pts.push(pts[0].slice())
  return pts
}

/** Keep the runs of a polyline whose segments touch box [w, s, e, n]. */
export function clipLine(coords, box) {
  const rb = bboxOf(coords)
  if (!boxesTouch(rb, box)) return []
  if (rb[0] >= box[0] && rb[2] <= box[2] && rb[1] >= box[1] && rb[3] <= box[3]) return [coords]
  const runs = []
  let run = null
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1]
    const touch = inBox(a, box) || inBox(b, box) || boxesTouch(bboxOf([a, b]), box)
    if (touch) {
      if (!run) runs.push((run = [a]))
      run.push(b)
    } else run = null
  }
  return runs
}

const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`

/** Merge lines that share exact end points into longer chains (like ST_LineMerge). */
export function mergeLines(lines) {
  lines = lines.filter((l) => l.length >= 2)
  const ends = new Map()
  const add = (k, i) => (ends.get(k) || ends.set(k, []).get(k)).push(i)
  lines.forEach((l, i) => {
    add(key(l[0]), i)
    add(key(l.at(-1)), i)
  })
  const used = new Uint8Array(lines.length)
  const take = (k) => (ends.get(k) || []).find((j) => !used[j]) ?? -1
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue
    used[i] = 1
    let chain = lines[i].slice()
    for (let j; (j = take(key(chain.at(-1)))) >= 0; ) {
      used[j] = 1
      const l = key(lines[j][0]) === key(chain.at(-1)) ? lines[j] : lines[j].slice().reverse()
      for (let m = 1; m < l.length; m++) chain.push(l[m])
    }
    for (let j; (j = take(key(chain[0]))) >= 0; ) {
      used[j] = 1
      const l = key(lines[j].at(-1)) === key(chain[0]) ? lines[j] : lines[j].slice().reverse()
      chain = l.slice(0, -1).concat(chain)
    }
    out.push(chain)
  }
  return out
}

/** Join way geometries into closed rings (multipolygon members); unclosed leftovers are closed. */
export function assembleRings(lines) {
  const rings = []
  for (const chain of mergeLines(lines)) {
    if (chain.length < 3) continue
    if (!isClosed(chain)) chain.push(chain[0].slice())
    if (chain.length >= 4) rings.push(chain)
  }
  return rings
}

function appendLine(chain, line) {
  const start = distM(chain.at(-1), line[0]) < 0.5 ? 1 : 0
  for (let i = start; i < line.length; i++) chain.push(line[i])
}

/**
 * Stitch ordered route ways into ONE polyline: follows member order, flips reversed ways,
 * bridges gaps <= gapM; leftover chains are joined nearest-end-first. Returns { coords, gaps }.
 */
export function stitch(lines, gapM = 50) {
  const chains = []
  let cur = null, single = false
  for (const l of lines) {
    if (l.length < 2) continue
    if (!cur) {
      cur = l.slice()
      single = true
      continue
    }
    const dF = distM(cur.at(-1), l[0]), dL = distM(cur.at(-1), l.at(-1))
    if (Math.min(dF, dL) <= gapM) {
      appendLine(cur, dF <= dL ? l : l.slice().reverse())
      single = false
      continue
    }
    if (single) {
      const sF = distM(cur[0], l[0]), sL = distM(cur[0], l.at(-1))
      if (Math.min(sF, sL) <= gapM) {
        cur.reverse()
        appendLine(cur, sF <= sL ? l : l.slice().reverse())
        single = false
        continue
      }
    }
    chains.push(cur)
    cur = l.slice()
    single = true
  }
  if (cur) chains.push(cur)
  const gaps = []
  while (chains.length > 1) {
    let best = null
    for (let i = 0; i < chains.length; i++) {
      for (let j = 0; j < chains.length; j++) {
        if (i === j) continue
        // an end of chain i -> an end of chain j (revI: leave i from its start)
        for (const revI of [false, true]) {
          for (const flip of [false, true]) {
            const d = distM(revI ? chains[i][0] : chains[i].at(-1), flip ? chains[j].at(-1) : chains[j][0])
            if (!best || d < best.d) best = { i, j, revI, flip, d }
          }
        }
      }
    }
    const { i, j, revI, flip, d } = best
    if (d > gapM) gaps.push(Math.round(d))
    if (revI) chains[i].reverse()
    appendLine(chains[i], flip ? chains[j].slice().reverse() : chains[j])
    chains.splice(j, 1)
  }
  return { coords: chains[0] || [], gaps }
}
