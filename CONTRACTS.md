# TimeLine module contracts

TimeLine turns **a city + a transit line** into a narrated, fact-checked map film.
MiniMax **M3.1 flash** (via SandBase) is the director: it picks the stops, writes and
fact-checks the script, and writes every image and music prompt. Code only executes.

Runtime: Node >= 20, ESM (`.mjs`), deps `playwright-core` (drives the system's Microsoft
Edge or Chrome with `channel: 'msedge'` / `'chrome'`, no browser download), `yaml`, and `three`
0.186.1 (MIT; the 3D map layer, served to the page from node_modules).
External tools: `ffmpeg`/`ffprobe` on PATH. No other npm deps without a strong reason.

## Stage modules

Each stage lives in `src/stages/<name>.mjs` and exports:

```js
export const stage = {
  name: 'geo',
  outputs: ['geo.json'],          // files in build/; stage is skipped when all exist (unless --force)
  async run(ctx) { ... },
}
```

`ctx` (built in `bin/timeline.mjs`):

| field | meaning |
|---|---|
| `ctx.config` | parsed `project.yaml` (see below), with defaults applied |
| `ctx.projectDir`, `ctx.buildDir`, `ctx.root` | absolute paths (`root` = repo root) |
| `ctx.client` | SandBase client from `src/sandbase.mjs`: `chat()`, `chatJSON()`, `run()`, `download()` |
| `ctx.read(name, fallback?)`, `ctx.write(name, obj)`, `ctx.file(name)`, `ctx.exists(name)` | JSON IO in `build/` |
| `ctx.log(...)` | progress logging |
| `ctx.mock` | true → never call paid media models; generate local placeholders (ffmpeg / canvas) instead. Chat calls are still allowed (cheap). Media stages (assets, timing, render, mix) then run with `buildDir` = `build/mock/`: they write only there and read upstream JSON (geo, ground, plan) from `build/`, so a placeholder can never overwrite or pass for a real asset or film. |
| `ctx.input(name)` | path to read `name` from (mock: `build/mock/` first, then `build/`); `ctx.realBuildDir` is always `build/` (cost ledger, real media cache) |
| `ctx.aspects` | e.g. `['16:9', '9:16']` |

Helpers in `src/util.mjs`: `readJSON`, `writeJSON`, `hash`, `cachedFile(dir, key, ext, fn)`,
`mediaDuration(file)`, `politeFetch(url, opts)` (UA + retries), `sleep`.

Stage order: `geo → ground → direct → verify → art → assets → timing → render → mix`.
(`art` has no output file of its own: it adds `landmark` fields to plan.verified.json and decides itself
whether there is work, so it runs on every `all` and replays its logged call for free.)

A stage is skipped when its outputs exist (`--force` redoes it). Media stages are also redone when
an upstream output or `project.yaml` is newer, when a file their JSON lists is missing, or (in a real
run) when their JSON says `mock: true`. geo/ground/direct/verify are never redone implicitly (network/money).

### SandBase client facts (verified 2026-10-23)

- `chatJSON({ model, messages, schema, name })` forces a function call. M3.1 flash
  **ignores** `response_format: json_schema`, but honours `tool_choice`. Use chatJSON for all structured output.
- M3.1 flash will invent plausible URLs from memory. **Never** accept a URL or fact
  the model did not get from the evidence pack. Citations reference evidence `source_id`s only.
- Media runs: `POST /v1/run {model, ...params}` → poll. The org allows **one concurrent run**:
  run media jobs sequentially (the client already backs off on 429).
- Prices: M3.1 flash $0.15/$0.60 per 1M tokens; `minimax/speech/2.8/hd` $0.10 per 1k chars;
  `minimax/music/2.6` $0.15/song (default music model: `is_instrumental: true` guarantees no vocals);
  `minimax/music/3` $0.002/s (song model, instrumental only by prompt + tag-only lyrics: fallback);
  `google/lyria-3.5` $0.10/track (song model with vocals, prompt-only control: avoid); `google/nano-banana-2.1` $0.04 (1K);
  `bytedance/seedream/5.0/flash` $0.018; `minimax/voice-design` $3 (avoid).
- TTS params (`minimax/speech/2.8/hd`): `text` (≤5000 chars, `<#0.5#>` = pause seconds),
  `voice_id`, `speed` 0.5–2, `pitch` −12..12, `emotion` (happy|sad|angry|fearful|disgusted|surprised|neutral),
  `format` mp3. Output `outputs[0].url` (+ `duration_ms`).

## project.yaml

```yaml
city: Delhi
country: India            # search context only; NEVER draw national borders
line:
  name: Yellow Line       # matched against OSM route relation name
  ref: "2"                # OSM ref
  network: Delhi Metro
  from: Chandni Chowk     # ride start station (OSM name)
  to: Qutab Minar         # ride end station
bbox: [28.40, 76.83, 28.89, 77.35]   # south, west, north, east (Overpass order)
language: en
target_seconds: 150
fps: 30
aspects: ["16:9", "9:16"]
narrator:
  persona: Delhi itself, an old storyteller, speaking in the first person
  voice_id: English_CaptivatingStoryteller
  speed: 0.92
  emotion: neutral
personal:                 # the "me and this city" thread (the maker's own words, no names)
  - ...
facts_file: facts.verified.json      # optional curated claims [{id, claim, sources:[{url,publisher}]}]
style:
  map: dark night map, glowing line in the line colour, warm amber for history
  illustration: warm painterly illustration inspired by Indian miniature painting, no text, no real people's faces
models: { director, image, tts, music, music_fallback }   # defaults in src/env.mjs
```
Optional extras used by later stages: `line.underground: {from, to}` (tunnel + dawn in the renderer;
station names or km along the ride: `from` = first underground station, `to` (alias `first_surface`) =
the FIRST STATION ABOVE GROUND, the train surfaces just before it; or give `last_underground: <station>`
instead of `to`, the train surfaces just after it), `narrator.voice_label` (credits name for a custom voice),
`max_spend_usd` (cap on the whole ledger; paid media stops before exceeding it), `slug`,
`timing` ({lead, tail, endTail, ...}, see timeline.json), `image_resolution`, `render.dawn`,
`max_seconds` (default 178: timing and assets refuse a longer real film; `allow_long: true` overrides).
Brief extras for the director: `title` (working title, kept), `hook` (idea for the opening line),
`personal_subject` (who the personal thread is told about; default "the maker, in the third person"),
`director: {notes, min_words, max_words, words_per_second, clip_edge_seconds, min_scenes, max_scenes, max_images}`.
End card: `repo_url` (printed under MADE WITH TIMELINE), `dedication` (one line in the maker's own words).
Map: `footprints: <file.geojson>` (outlines for sites OSM maps only as a point; see geo.json).
Art: `art: { scenes: [s04, s05] }` (which map scenes get a landmark painting; default: see stage `art`).

## build/geo.json  (stage `geo`, src/stages/geo.mjs)

Fetched from Overpass (cache raw responses in `build/cache/overpass/`).
All coordinates are `[lon, lat]` (GeoJSON order).

```jsonc
{
  "bbox": [s, w, n, e],
  "line": { "name": "Yellow Line", "ref": "2", "color": "#FFDF00",
            "coords": [[lon, lat], ...],         // ONE continuous polyline, ordered from `from` to `to`, trimmed to that span
            "length_km": 18.3 },
  "stations": [ { "id": "st_chandni_chowk", "name": "Chandni Chowk", "name_local": "चाँदनी चौक",
                  "lon": 77.23, "lat": 28.65, "km": 0.0,      // distance along line.coords
                  "wikidata": "Q...", "osm_id": "node/123" } ],   // only stations on the ridden span, in ride order
  "layers": {                                   // simplified GeoJSON FeatureCollections for the base map
    "water": {...}, "green": {...}, "roads": {...}, "boundary": {...},
    "other_lines": {...}                        // other lines of the network, with properties.color
  },
  "sites": [ { "id": "site_red_fort", "name": "Red Fort", "lon": .., "lat": ..,
               "polygon": [[lon,lat],...] | null, "wikidata": "Q..." | null,
               "tags": { "historic": "fort" } } ]        // heritage features within ~2 km of the ridden span
}
```
A site outlined from project.yaml `footprints` (features with `site_id`, `label`, `approximate`) also has
`"approximate": true` (a hull of surviving walls: drawn dashed) and `"display_name"` (the map label).

## build/geo_detail.json  (stage `geo`, src/geo/detail.mjs)

The street-level city for the 3D map. Same stage as geo.json (outputs `geo.json`, `geo_detail.json`); an
existing geo.json is kept byte for byte (only `--force` rebuilds it, from the Overpass cache), so
`timeline geo <dir>` on a finished project builds just the detail. Overpass in bbox chunks of ~3 km of line
(+ corridor), one query at a time, raw responses cached in `build/cache/overpass/`. Cut locally to a
corridor of 1200 m each side of `geo.line.coords` plus 800 m around every lit site (every
`focus_site_ids`/`landmark.site_id` of the plan; before `direct` has run, every geo.json site with a
Wikidata item), plus everything inside a lit site's own outline up to 2 km². Coordinates `[lon, lat]`,
5 dp. Written one feature per line (Delhi: 8.8 MB, 20,273 OSM buildings, 11,433 street pieces, 240 land-use areas).

```jsonc
{
  "bbox": [s, w, n, e],                         // Overpass order, like geo.json
  "meta": { "attribution": "Map data © OpenStreetMap contributors (ODbL)", "osm_base": "…",
            "corridor_m": 1200, "site_m": 800, "sites_from": "plan" | "wikidata", "chunks": [[s,w,n,e], …],
            "heights": { "from_height_tag": n, "from_levels": n, "by_type": n, "level_m": 3.2 }, "counts": {…} },
  "sites": [ { "id": "site_qutb_minar", "name": "Qutb Minar", "lon": …, "lat": …,
               "top_h": 72.5, "buildings": 1, "in_footprint": 1 } ],    // per lit site: label anchor height
  "buildings": FeatureCollection of Polygon (outer ring only) {
      "h": 12.8, "min_h": 0,                   // metres: `height`, else building:levels x 3.2 (+ half a storey
                                               // per roof:levels), else a typical height for the building type
                                               // (deterministic per OSM id; <= 2.5 x footprint width); min_height /
                                               // building:min_level x 3.2 lift the base (canopies: 3 -> 4.5 m)
      "h_src": "height" | "levels" | "type",
      "k": "mosque",                           // building type when not "yes" (optional)
      "part": true,                            // a building:part (optional)
      "has_parts": true,                       // an outline whose parts are listed too: draw the parts, not it
      "site_ids": ["site_qutb_minar", "site_qutub_minar_complex"],   // lit sites it belongs to, most specific first
      "name": "Qutb Minar",                    // named monuments only (wikidata/historic)
      "synthetic": true,                       // a lit point monument (the iron pillar) given a small octagon
                                               // footprint (radius >= 0.6 m, 6 dp): exaggerate it in 3D if needed
      "osm_id": "way/369140381" },
  "streets": FeatureCollection of LineString {
      "cls": "major" | "minor" | "path" | "rail",   // major: motorway..secondary (+links); minor: tertiary,
                                                    // unclassified, residential, living_street, service
                                                    // (no parking aisles/driveways); path: pedestrian, footway
                                                    // (no sidewalks/crossings), path, cycleway, steps, track
      "hw": "residential" | "subway" | …,           // the OSM highway / railway value
      "tunnel": true,                               // underground (metro tunnels, underpasses): do not draw on the surface
      "bridge": true,                               // elevated (the Yellow Line viaduct south of Saket, flyovers)
      "name": "…" },                                // major streets only
  "green": FeatureCollection of Polygon { "kind": "park"|"garden"|"grass"|"wood"|"scrub"|"pitch"|"cemetery", "area_ha" },
  "water": FeatureCollection of Polygon { "kind": "water", "area_ha" },  // ponds, tanks, fountains' pools
  "landuse": FeatureCollection of Polygon {                // OSM land use touching the corridor (>= 0.2 ha)
      "kind": "residential"|"commercial"|"retail"|"industrial"|"institutional"|"education"|"religious"|"military"|"railway"|…,
      "area_ha", "bldg_cover": 0.047,                      // share of the area under OSM buildings
      "lanes_km_km2": 21,                                  // mapped streets + paths per km²
      "infill": true },                                    // the area got procedural `fill` blocks
  "fill": FeatureCollection of Polygon { "h", "min_h": 0, "fill": true }   // NOT OpenStreetMap data (6 dp)
}
```
`green`/`water` are the small areas (>= 0.03 ha) the base map leaves out; they may overlap geo.json's
layers (draw geo.json first). Never any administrative boundary.
`fill`: OSM maps Old Delhi's lanes but few of its houses (4.7% building cover in its 236 ha residential
area), so the old city would read as empty. `fill` holds procedural blocks (deterministic, 9-13 m wide,
aligned to the nearest street, 6.4-12.8 m tall in residential, 8-16 m in commercial land use) ONLY inside
dense land use whose whole area looks under-mapped (>= 18 km/km² of lanes and <= 8% building cover: a
garden suburb like the Lutyens bungalow zone never qualifies) and where it is still locally empty (< 8%
cover within ~70 m), clear of every street, OSM building, park and pond. Delhi: 4,130 blocks in 16 areas.
It is a separate collection so a renderer can skip it or draw it a shade dimmer than real buildings; it
never carries `site_ids`. `timeline geo <dir> --only detail` rebuilds just geo_detail.json (from the cache).

## build/ground.json  (stage `ground`, src/stages/ground.mjs)

Evidence pack. Every fact the director may use must come from here.

```jsonc
{
  "sources": [ { "id": "src_001", "url": "https://...", "title": "...", "publisher": "Wikipedia|Wikidata|ASI|UNESCO|Britannica|...",
                 "excerpt": "plain text, ≤ 1500 chars, the passage that supports facts" } ],
  "stations": [ { "station_id": "st_hauz_khas",
                  "sites": [ { "id": "site_hauz_khas_complex", "qid": "Q...", "label": "Hauz Khas Complex",
                               "description": "...", "inception_year": 1295, "inception_text": "c. 1295",
                               "lon": .., "lat": .., "dist_km": 0.9, "heritage": "ASI monument of national importance",
                               "source_ids": ["src_014", "src_015"] } ] } ],
  "facts": [ { "id": "fact_001", "claim": "...", "year": 1639, "source_ids": ["src_002"], "origin": "facts_file|wikidata|wikipedia" } ]
}
```

## build/plan.json  (stage `direct`, src/stages/direct.mjs — M3.1 flash)

```jsonc
{
  "title": "One Ticket, 800 Years",
  "logline": "...",
  "music_prompt": "...",              // instrumental only; no vocals; mood, instruments, tempo, ending
  "cover_prompt": "...",              // for the 16:9 cover image
  "scenes": [ {
      "id": "s01",
      "kind": "title" | "map" | "illustration" | "personal" | "end",
      "narration": "First-person line(s), may include <#0.6#> pauses",
      "on_screen": { "headline": "Chandni Chowk", "year": "1639–1648", "subtitle_lang": "en" },
      "map": {                                    // for kind=map (optional on others)
        "train_to": "st_chandni_chowk",           // animate the train to this station during the scene
        "focus_station": "st_...", "focus_site_ids": ["site_..."],
        "zoom": 13.5                              // web-mercator zoom; renderer eases between scenes
      },
      "image_prompt": "...",                      // for kind=illustration|personal|title|end
      "fact_ids": ["fact_003"],                   // facts stated in this scene's narration
      "source_ids": ["src_002"]                   // shown on screen as a citation chip
  } ],
  "claims": [ { "id": "c01", "scene_id": "s03", "text": "Shah Jahan founded Shahjahanabad in 1639.", "source_ids": ["src_002"] } ],
  "brief_hash": "…"                      // fingerprint of the brief (project.yaml keys + facts file); paid media refuses a stale plan
}
```
A map scene's first focus site is the one its year card dates: code drops a first site from another
era (or with no date in the evidence) rather than show it under the wrong year.

## build/verify.json + build/plan.verified.json  (stage `verify`, src/stages/verify.mjs — M3.1 flash)

For each claim, M3.1 flash compares the narration with the cited excerpts only.
`status: supported | partial | unsupported`. Unsupported/partial claims are rewritten (or cut)
by a second director call constrained to the evidence; loop ≤ 2 times. Also reject:
claims about living people, national borders, invented URLs (source_ids not in ground.json).
Writes `verify.json` `{ "claims": [{id, status, note}], "rounds": n, "passed": bool }` and the
corrected plan as `plan.verified.json` (same schema as plan.json). Later stages read
`plan.verified.json`.

## Stage `art` (src/stages/art.mjs, src/prompts/art.md — M3.1 flash)

One director call (`submit_landmarks`, logged in `build/director/art.json`; capped at $0.03 for the step
including at most one retry; `max_tokens` 12k, 2 tries) paints the landmark of each map scene at a major
stop: map scenes that light up a site, unless the next scene is an image of the same place (same headline,
or its image_prompt names a lit site); project.yaml `art: { scenes: [s04, …] }` overrides. The call sees the
style bible, the scenes (narration, year card, where the narration names each site, the light: night until
the train surfaces per `line.underground`, dawn after), the film's other image prompts, source excerpts,
the scenes' caveats, and the sentences of each landmark's English Wikipedia article that describe how it
looks (fetched free and cached in `build/cache/ground/wikipedia/`; visual evidence for the paintings only).
Code checks: exactly the requested scenes; `site_id` = the scene's first focus site (what its year card
dates); `reveal_at` "named" only when the narration names it; 60-240 words; no URL; the style bible's
illustration_style appended. It adds ONLY this field to those scenes (narration, claims, on_screen untouched):

```jsonc
"landmark": { "image_prompt": "Qutb Minar, Delhi, in early-morning golden light … <illustration_style>",
              "subject": "Qutb Minar", "site_id": "site_qutb_minar", "reveal_at": "named" | "arrival" }
```
Skipped when every target scene already has a landmark (`--force` redoes it; an identical request replays
from `build/cache/director/` for free). `verify --force` rewrites plan.verified.json: run `art` again after it.

## build/assets.json  (stage `assets`, src/stages/assets.mjs)

Media in `build/assets/` (cached by content hash, sequential runs):
```jsonc
{
  "voice": { "s01": { "file": "assets/voice/s01.mp3", "duration": 6.42 } },
  "images": { "s02": { "file": "assets/images/s02.png", "width": 1920, "height": 1080 } },  // 16:9; renderer crops for 9:16
  "music": { "file": "assets/music.mp3", "duration": 152.0, "offset": -6.2 },  // offset: film time the track starts (< 0 skips its head) so its ending lands at the end
  "cover": { "file": "assets/cover.png" }
}
```
Narration TTS: one call per scene (keeps timing exact). Images: 16:9, ≥1280 px wide.
Landmark paintings: a map scene with `landmark` gets `images.<id>` = `{ file, width, height, model, mock,
"landmark": true, "subject", "site_id" }`, made from `landmark.image_prompt` with the same params as other
images plus `enable_web_search: true` on google/nano-banana-* (+$0.014, grounds the monument's look); every
earlier image keeps its params hash, so nothing paid for is redone. A real run checks up front that all new
paintings fit under `max_spend_usd` and pays for none of them otherwise.
Music: generated after narration so its requested duration = total film length.
A real run voices the longest scene first and stops before paying for the rest when the measured
speech rate projects a film over `max_seconds`; `timeline assets <dir> --only s04` voices just those
scenes (an audition) without writing assets.json. Paid runs are recorded in `<hash>.run.json` right after
submission and resumed by id if polling or the download fails.
In mock mode: silent/sine audio of an estimated length (12.5 chars/s, the measured custom voice) and solid-colour
PNGs with the scene id drawn on them, all under `build/mock/` and named `mock-<hash>.*`;
`assets.json` (and `timeline.json`, `mix.json`) carry `mock: true` when any placeholder is used.
Real files already paid for (same model + params hash in `build/assets/`) are copied in instead.

## build/timeline.json  (stage `timing`, src/stages/timing.mjs)

```jsonc
{
  "fps": 30, "duration": 152.4,
  "scenes": [ { "id": "s01", "kind": "map", "start": 0.0, "end": 8.1,
                "voice": { "file": "assets/voice/s01.mp3", "start": 0.6, "duration": 6.4 },
                "image": "assets/images/s01.png" | null,
                "plan": { ...the scene object from plan.verified.json },
                "mentions": [ { "site_id": "site_siri_fort", "t": 65.1 } ] } ],   // when the narration names each focus site (it lights up then)
  "cues": [ { "start": 0.6, "end": 2.9, "text": "I am Dilli." } ],     // subtitles: ≤ 42 chars/line, ≤ 2 lines, split at punctuation, timed ∝ characters
  "citations": [ { "start": 8.1, "end": 20.0, "text": "Source: UNESCO · ASI" } ],   // strongest 2 publishers first; none on the title
  "attribution": "Map data © OpenStreetMap contributors (ODbL)",
  "credits": ["Directed and written by MiniMax M3.1 flash via SandBase", ...], "repo_url": "…", "dedication": "…"
}
```
Map scenes also carry the train and the landmark painting (absolute film seconds):
```jsonc
{ "id": "s10", "kind": "map", …,
  "arrive": 108.899,                        // the train stands at its station (scene start when already there)
  "travel": { "from": "st_saket", "to": "st_qutab_minar", "t0": 106.388, "t1": 108.899, "km": 1.821 },  // only when it rides
  "image": "assets/images/<hash>.png",      // the landmark painting (null on map scenes without one)
  "reveal": 110.099,                        // the painting crossfades in (~0.9 s, slow Ken Burns), the 3D view moves to the inset card
  "reveal_from": "named" | "arrival" | "arrival (named too late)" | "… (short scene)" }
```
`travel` mirrors render/renderer.js buildSchedule (starts 0.3 s into the scene, lasts
clamp(1.6 + 0.5 x km, 2.4, max(2.4, min(8.5, 0.6 x scene length))) s): renderers may use it as the schedule.
`reveal`: when the narration first names the landmark (`mentions`, reveal_at "named"), else 1.2 s after the
train arrives; never earlier than 1.2 s after arrival, and early enough that the painting holds >= 4 s.

Scene length = lead-in 0.5 s + voice + tail 0.7 s (min 3 s; title ≥ 4 s; the last scene holds `endTail` 5 s
so the closing line lands before credits). All of these are `timing:` keys in project.yaml. Pause markup
`<#x#>` is removed from subtitle text.

## Renderer (src/stages/render.mjs + render/index.html + render/renderer.js)

`render/index.html?aspect=16:9` loads `renderer.js`. Node (playwright-core, system Edge/Chrome)
injects `window.TIMELINE` (timeline.json), `window.GEO` (geo.json), and `window.ASSET_BASE`
(file URL of build/) before load, then:

- `await window.timelineReady` — fonts + images loaded.
- `window.drawFrame(t)` — synchronously draws time `t` (seconds) to `<canvas id="c">`
  (1920×1080 for 16:9, 1080×1920 for 9:16). Pure function of t: deterministic, no wall clock.
- Node grabs each frame (`canvas.toDataURL('image/jpeg', 0.92)` or raw RGBA) and pipes to ffmpeg
  → `build/render/<16x9|9x16>.video.mp4` (H.264, yuv420p, silent; `:` is illegal in Windows file names).
  The video bitrate is capped so each final stays under ~85 MB (upload limit 100 MB).

Visual language: dark night base map (water teal, green ridge, faint roads, faint other lines),
the ridden line glowing in its colour, a bright train pill moving along `line.coords` between
stations (ease in/out), station dots + English and local-script labels, historic sites as amber
footprints/pulses with year labels, a big year/era card, smooth camera (web-mercator, eased
center/zoom), illustration scenes as full-bleed Ken Burns with a soft vignette and crossfades,
burned-in subtitles (bottom, high contrast, safe areas), citation chip, OSM attribution, title
and end cards. 9:16 uses the same timeline with a taller camera and larger type.

Opening (3D map): the title painting holds for the first subtitle line, then the NASA Black Marble globe
(render/three/globe.js) dives toward the first map scene's station under the title card and hands over to the
3D city (~260 km up) as the first map scene starts; "Earth at night: NASA" sits in the corner while it shows.
Corner credit (OSM attribution guidelines for video): "Map data © OpenStreetMap contributors" for ~4 s when the
map first shows and ~3 s each time it returns after a painting or the globe, then it fades; never over a
painting. The end credits (timeline.json `credits`, from `timing`) carry "Map data © OpenStreetMap contributors ·
openstreetmap.org/copyright" and "Earth at night: NASA Earth Observatory (Black Marble)" (over a soft dark scrim,
so they stay legible on a bright end painting).
Hand-over: the city's ground carries the Black Marble lights (luminance-weighted, tinted like the globe's) at full
strength down to ~200 km and mostly gone by ~125 km, while the OSM street web fades in from 150 km, so the 500 m
satellite texels never magnify into a blurry glow. Light: dawn completes as the train surfaces (`line.underground`);
when a subtitle shortly before that announces it ("daylight", "dawn", "sunrise", "surfaces", "comes up"), the
light starts to pale (to ~40%) on those words. A painted landmark (`landmark.site_id`) is lit and tagged in the 3D
view by 0.8 s before its painting is revealed, even when the narration names it later, so the inset card shows it.

## Mix (src/stages/mix.mjs)

ffmpeg: place each scene's voice at `scene.start + voice.start`, music bed under it with
sidechain ducking (music ≈ −20 dB under voice, ≈ −12 dB alone), 0.5 s fade-in, 2 s fade-out,
loudness-normalise to −14 LUFS, mux with each `render/<aspect>.video.mp4` →
`build/final/<slug>_<16x9|9x16>.mp4` (H.264 + AAC 192k, `+faststart`; slug gets `-MOCK` with placeholders),
`build/final/<slug>.sources.txt` (every cited source with URL, per citation window). Also writes
`build/final/<slug>.srt`.
