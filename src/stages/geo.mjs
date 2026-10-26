// Stage geo: OpenStreetMap via Overpass -> build/geo.json: the ridden line (one direction,
// trimmed from -> to), its stations in ride order, base-map layers and nearby heritage sites.
// Map data (c) OpenStreetMap contributors, ODbL 1.0.
import fs from 'node:fs'
import path from 'node:path'
import { overpass } from '../geo/overpass.mjs'
import { buildRoute, transitQuery } from '../geo/route.mjs'
import {
  boundaryCandidatesQuery,
  boundaryQuery,
  buildBoundary,
  buildGreen,
  buildOtherLines,
  buildRoads,
  buildWater,
  fc,
  greenQuery,
  pickBoundary,
  roadsQuery,
  waterQuery,
} from '../geo/layers.mjs'
import { buildSites, sitesQuery } from '../geo/sites.mjs'
import { stringifyGeo } from '../geo/jsonfmt.mjs'
import {
  CORRIDOR_M,
  SITE_M,
  buildAreas,
  buildFill,
  buildLanduse,
  buildBuildings,
  buildStreets,
  buildingsQuery,
  landuseQuery,
  corridor,
  detailChunks,
  siteSummaries,
  streetsQuery,
  stringifyDetail,
} from '../geo/detail.mjs'

// local-script station names (name:<lang>); override with project.yaml `local_language`
const COUNTRY_LANG = { india: 'hi', japan: 'ja', china: 'zh', 'south korea': 'ko', korea: 'ko', russia: 'ru', greece: 'el', egypt: 'ar', iran: 'fa', israel: 'he', thailand: 'th', taiwan: 'zh', pakistan: 'ur', bangladesh: 'bn', ukraine: 'uk' }

function checkBbox(b) {
  if (!Array.isArray(b) || b.length !== 4 || b.some((x) => !Number.isFinite(Number(x)))) throw new Error('project.yaml bbox must be [south, west, north, east]')
  const [s, w, n, e] = b.map(Number)
  if (s >= n || w >= e) throw new Error(`bbox ${b} is not [south, west, north, east]`)
  return [s, w, n, e]
}

const count = (layer) => layer.features.length
const r5 = (x) => Math.round(x * 1e5) / 1e5
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * project.yaml `footprints`: a GeoJSON file of outlines for sites OSM maps only as a point (a walled
 * city known from wall fragments). Each feature names its site by `site_id` (or `label` = site name);
 * `approximate: true` marks a hull, which the renderer draws dashed and labels with `label`.
 */
function attachFootprints(sites, file, log) {
  if (!fs.existsSync(file)) return log(`geo: warning: footprints file ${file} not found`)
  for (const f of JSON.parse(fs.readFileSync(file, 'utf8')).features || []) {
    const p = f.properties || {}
    const g = f.geometry || {}
    const ring = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null
    const site = sites.find((s) => s.id === p.site_id) || sites.find((s) => [s.name, s.tags?.['name:en'], s.tags?.alt_name].some((n) => n && key(n) === key(p.label)))
    if (!ring || !site) {
      log(`geo: warning: footprint ${p.site_id || p.label} matches no site`)
      continue
    }
    if (site.polygon && !p.replace) continue // OSM's own outline wins
    site.polygon = ring.map(([x, y]) => [r5(x), r5(y)])
    site.approximate = !!p.approximate
    if (p.label) site.display_name = p.label
    log(`geo: footprint for ${site.id}${site.approximate ? ' (approximate)' : ''}`)
  }
}

/**
 * The sites the film lights up: every focus site (and landmark) of the plan when one exists; before
 * `direct` has run, every site with a Wikidata item (the ones the director can choose from).
 */
function litSites(ctx, geo) {
  const plan = ctx.read('plan.verified.json', null) || ctx.read('plan.json', null)
  const byId = new Map((geo.sites || []).map((s) => [s.id, s]))
  if (plan?.scenes?.length) {
    const ids = new Set(plan.scenes.flatMap((sc) => [...(sc.map?.focus_site_ids || []), sc.landmark?.site_id]).filter(Boolean))
    return { from: 'plan', sites: [...ids].map((id) => byId.get(id)).filter(Boolean) }
  }
  return { from: 'wikidata', sites: (geo.sites || []).filter((s) => s.wikidata) }
}

/**
 * build/geo_detail.json: buildings (extruded, heights in metres), streets, small parks and water
 * in a corridor around the ridden line and the lit sites, for the 3D map. Overpass in a few bbox
 * chunks, one query at a time, cached in build/cache/overpass/ like geo.json's.
 */
async function buildDetail(ctx, geo, q) {
  const { log } = ctx
  const lit = litSites(ctx, geo)
  const boxes = detailChunks(geo.line.coords, lit.sites)
  log(`geo detail: ${boxes.length} chunks along ${geo.line.length_km} km, corridor ${CORRIDOR_M} m + ${SITE_M} m around ${lit.sites.length} sites (${lit.from})`)
  const bDocs = []
  const sDocs = []
  const lDocs = []
  for (const [i, box] of boxes.entries()) {
    bDocs.push(await q(buildingsQuery(box), `detail buildings ${i + 1}/${boxes.length}`))
    sDocs.push(await q(streetsQuery(box), `detail streets ${i + 1}/${boxes.length}`))
    lDocs.push(await q(landuseQuery(box), `detail landuse ${i + 1}/${boxes.length}`))
  }
  const bbox = boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]).map(r5)
  const { outside } = corridor(geo.line.coords, lit.sites)
  const buildings = buildBuildings(bDocs, { outside, sites: lit.sites })
  const streets = buildStreets(sDocs, { outside })
  const areas = buildAreas(sDocs, { outside, bbox })
  const landuse = buildLanduse(lDocs, { outside, bbox, buildings: buildings.features, streets: streets.features })
  // procedural blocks (not OSM) where OSM maps dense lanes but not yet the houses: a separate collection
  const fill = buildFill({ landuse, buildings: buildings.features, streets: streets.features, areas: [...areas.green.features, ...areas.water.features], bbox })
  const detail = {
    bbox,
    meta: {
      source: 'OpenStreetMap via Overpass API',
      attribution: 'Map data © OpenStreetMap contributors (ODbL)',
      osm_base: bDocs[0]?.osm3s?.timestamp_osm_base || null,
      corridor_m: CORRIDOR_M,
      site_m: SITE_M,
      sites_from: lit.from,
      chunks: boxes.map((b) => b.map(r5)),
      heights: { from_height_tag: buildings.stats.height, from_levels: buildings.stats.levels, by_type: buildings.stats.type, level_m: 3.2 },
      counts: { buildings: buildings.features.length, streets: streets.counts, green: areas.green.features.length, water: areas.water.features.length, landuse: landuse.features.length, fill: fill.features.length },
      fill: 'procedural blocks, NOT OpenStreetMap data: only inside residential/commercial/retail land use whose whole area looks under-mapped (>= 18 km of mapped lanes per km², <= 8% under OSM buildings; landuse.properties.infill) and locally still empty (< 8% cover within ~70 m); clear of every street, building, park and pond; deterministic',
    },
    sites: siteSummaries(lit.sites, buildings.features),
    buildings: fc(buildings.features),
    streets: fc(streets.features),
    green: areas.green,
    water: areas.water,
    landuse,
    fill: fc(fill.features),
  }
  const text = stringifyDetail(detail)
  fs.writeFileSync(ctx.file('geo_detail.json'), text)
  const st = streets.counts
  log(
    `geo detail: wrote geo_detail.json ${(text.length / 1e6).toFixed(2)} MB: ${buildings.features.length} buildings ` +
      `(height tag ${buildings.stats.height}, levels ${buildings.stats.levels}, by type ${buildings.stats.type}), ` +
      `streets major ${st.major} / minor ${st.minor} / path ${st.path} / rail ${st.rail}, green ${areas.green.features.length}, water ${areas.water.features.length}`,
  )
  log(`geo detail: land use ${landuse.features.length} areas; procedural infill ${fill.features.length} blocks in ${fill.stats.polygons} under-mapped areas (fill: true, not OSM)`)
  for (const s of detail.sites) log(`  site ${s.id}: ${s.buildings} own building(s), ${s.in_footprint} in its footprint, top ${s.top_h} m`)
}

export const stage = {
  name: 'geo',
  outputs: ['geo.json', 'geo_detail.json'],
  async run(ctx) {
    const { log } = ctx
    const cacheDir = ctx.file('cache/overpass')
    const q = (ql, label) => overpass(ql, { cacheDir, log, label })
    // geo.json is what the director and the fact-checker saw: an existing one is kept as is
    // (only --force rebuilds it, from the cached Overpass responses; `--only detail` redoes just the detail)
    let geo
    if (ctx.exists('geo.json') && (!ctx.force || ctx.only === 'detail')) {
      log('geo: geo.json exists, kept as is (--force rebuilds it)')
      geo = ctx.read('geo.json')
    } else geo = await buildGeo(ctx, q)
    await buildDetail(ctx, geo, q)
  },
}

async function buildGeo(ctx, q) {
  const { config, log } = ctx
  const bbox = checkBbox(config.bbox)
  const lang = config.local_language || COUNTRY_LANG[String(config.country || '').toLowerCase()] || null

  // 1. the line and its stations
  const transit = await q(transitQuery({ bbox, line: config.line || {} }), 'transit')
  const route = buildRoute(transit, config, { lang, log })
  for (const w of route.warnings) log(`geo: warning: ${w}`)
  const { line, stations } = route
  log(`geo: ${line.name} (${line.osm_id}) ${stations[0]?.name} -> ${stations.at(-1)?.name}: ${line.length_km} km, ${stations.length} stations`)

  // 2. heritage sites near the ridden span (+ project footprints for sites OSM maps only as a point)
  const sites = buildSites(await q(sitesQuery(line.coords), 'sites'), line.coords, { lang })
  if (config.footprints) attachFootprints(sites, path.resolve(ctx.projectDir, config.footprints), log)

  // 3. base layers (one Overpass query at a time)
  const water = buildWater(await q(waterQuery(bbox), 'water'), bbox)
  const green = buildGreen(await q(greenQuery(bbox), 'green'), bbox)
  const roads = buildRoads(await q(roadsQuery(bbox), 'roads'), bbox)
  let boundary = fc([])
  const city = config.boundary_name || config.city
  const pick = city && pickBoundary(await q(boundaryCandidatesQuery(bbox, city), 'boundary-candidates'), city)
  if (pick) boundary = buildBoundary(await q(boundaryQuery(pick.id), 'boundary'), log)
  else log(`geo: no admin boundary named "${city}" found; boundary layer left empty`)
  const other_lines = buildOtherLines(transit, line, bbox)

  const geo = {
    bbox,
    line,
    stations,
    layers: { water, green, roads, boundary, other_lines },
    sites,
    meta: {
      source: 'OpenStreetMap via Overpass API',
      attribution: 'Map data © OpenStreetMap contributors (ODbL)',
      osm_base: transit.osm3s?.timestamp_osm_base || null,
      local_language: lang,
      boundary: pick ? { osm_id: `relation/${pick.id}`, name: pick.tags.name, admin_level: Number(pick.tags.admin_level) } : null,
      warnings: route.warnings,
    },
  }
  const text = stringifyGeo(geo)
  fs.writeFileSync(ctx.file('geo.json'), text)
  log(
    `geo: wrote geo.json ${(text.length / 1e6).toFixed(2)} MB: ${stations.length} stations, ${sites.length} sites, ` +
      `water ${count(water)}, green ${count(green)}, roads ${count(roads)}, boundary ${count(boundary)}, other_lines ${count(other_lines)}`,
  )
  return geo
}
