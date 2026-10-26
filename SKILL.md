---
name: timeline-city-film
description: Make a narrated, fact-checked "ride a metro line through a city's history" film with TimeLine (MiniMax M3.1 flash via SandBase directs; OpenStreetMap 3D map; voice, paintings, music). Use when someone asks for a TimeLine film, a city or metro-line history film, or an AI City Remix contest entry for a new city or line. Covers gathering the maker's inputs, writing project.yaml, a --mock rehearsal, review, a paid run within a budget, and packaging the entry.
---

# Make a TimeLine film for a new city

TimeLine is a Node.js CLI in this repository: `node bin/timeline.mjs <stage|all|costs> <projectDir>`
for the film (`all` runs `geo` to `mix`), and `node src/stages/package.mjs <projectDir>` for the
contest entry. MiniMax M3.1 flash is the director: it chooses the stops, writes and fact-checks the script and
writes every image and music prompt. Your job as the agent is to set the brief up well, run the
pipeline, check the results, and keep the human in charge of money, personal content and uploading.
Read `README.md` and `CONTRACTS.md` once before the first run.

## Rules

- Never write or edit narration, on-screen text or image prompts yourself. Feedback goes back to the
  director as `director.notes` or `director.review` notes (below), so the film stays M3.1-directed.
- Never invent a fact, a source or a URL. Facts reach the film only through `ground.json` (Wikidata,
  Wikipedia, the curated `facts_file`).
- Personal lines come only from the human, in their words, with no names of private people.
- Never print, log or store secrets (`SANDBASE_API_KEY`, `LAB_SUBMISSION_TOKEN`). Do not ask for them
  in chat: the human puts the API key in `.env` and sets the token in their own shell.
- Never upload on your own. Uploading is the human's decision after they have watched the film; run
  `--submit` only when they explicitly ask for it (section 8).
- Keep `build/` (and its `cache/`): it is what makes re-runs free.
- Log every human decision in `projects/<name>/HUMAN_LOG.md` (date, who, decision). The `package`
  stage reads it for the director's notes.

## 1. Check the setup

```bash
node --version            # >= 20
ffmpeg -version && ffprobe -version
npm install               # playwright-core, three, yaml; no browser download
```

Microsoft Edge or Google Chrome must be installed (rendering drives it headless). Confirm a `.env`
with `SANDBASE_API_KEY` exists in the project folder, the repo root or a folder above them, without
printing it (for example `grep -c SANDBASE_API_KEY .env`).

## 2. Gather the inputs (ask the human; do not guess)

1. **City and line**, and the stretch to ride (start and end station). 6-12 stations suits 150 s.
2. **2-5 personal lines**: their own true "me and this city" memories. The film ends on them.
3. **`my_city_line`**: their own line about the city, at most 50 characters (contest field).
4. **Narrator**: persona (by default the city itself, in the first person), male or female voice,
   stock `voice_id` or a custom voice they have designed.
5. **Language**: `en` (or `zh`); the contest wants English or Chinese with subtitles.
6. **Budget**: the most they will spend (`max_spend_usd`). A whole Delhi-scale film costs about
   $1.2-1.6 in SandBase credits (see README, "Cost discipline"). A custom voice is extra: MiniMax
   Voice Design is listed at $3.00 plus $0.03 per 1,000 characters, outside TimeLine's ledger.

## 3. Find the line in OpenStreetMap

The `geo` stage matches `line.name` / `line.ref` / `line.network` against OSM route relations
(`route=subway|light_rail|train|monorail|tram`) inside `bbox`, then finds `from` and `to` among the
route's stops (fuzzy: "Qutab"/"Qutub"/"Qutb" all match). Get the real tags first: look the route up on
openstreetmap.org, or send ONE small Overpass query (descriptive User-Agent, no retries in a loop):

```
[out:json][timeout:60];
rel["type"="route"]["route"~"^(subway|light_rail|train)$"]["name"~"<line name>"](<s>,<w>,<n>,<e>);
out tags;
```

Leave `network` out when it is shared by many routes (London's Elizabeth line is tagged
`network=National Rail`, which would pull every National Rail route into the query).

## 4. Write `projects/<name>/project.yaml`

Start from `projects/_examples/london-elizabeth-line/project.yaml` or `rome-metro-c/project.yaml`
(full list of keys: `CONTRACTS.md`). Fill in:

- `city`, `country`, `line` (`name`, `ref`, optional `network`, `from`, `to`), `bbox` (south, west,
  north, east) around the ride with some context: it bounds every Overpass query.
- `line.underground: { from: <first underground station>, to: <first station above ground> }` when
  part of the ride is in a tunnel (night in the tunnel, dawn as the train surfaces). Only set it when
  you know which station is the first above ground.
- `narrator`, `personal`, `style` (`map`, `illustration`: no text, no recognisable real people),
  `language`, `target_seconds: 150`, `max_seconds: 178`, `aspects: ["16:9"]` (add `"9:16"` for a
  vertical cut), `max_spend_usd`, `my_city_line`, `city_id`.
- Optional: `facts_file` (curated claims `[{id, claim, sources: [{url, publisher}], caveats}]`, the
  strongest accuracy lever), `title` (kept by the director), `hook`, `director.notes`.

Validate: `node -e "import('./src/env.mjs').then(m => console.log(m.loadProject('projects/<name>')))"`.

## 5. Rehearse with `--mock`

```bash
node bin/timeline.mjs all projects/<name> --mock
node bin/timeline.mjs costs projects/<name>
```

`--mock` replaces every paid media model with local placeholders under `build/mock/`; the M3.1 chat
stages (`direct`, `verify`, `art`) run for real and cost cents. Then check:

- the `geo` log line names the right line, direction and station count;
- `build/verify.json`: `passed: true`, and the claim statuses;
- `build/plan.verified.json`: scenes, narration, `verification.est_seconds` (60-180);
- the placeholder film `build/mock/final/<slug>-MOCK_16x9.mp4` (or frames from it:
  `ffmpeg -ss 30 -i <film> -frames:v 1 frame.jpg`).

## 6. Review with the human

Show them the script (narration per scene) and the fact check. Turn their feedback into director
input, never into your own rewrite:

- a note on one scene: `director.review: [{ scene: s03, note: "..." }]`, then
  `node bin/timeline.mjs verify projects/<name> --force` (the notes become repair issues), then
  `node bin/timeline.mjs art projects/<name> --force`;
- a note on the whole film: `director.notes`, then `direct --force` and `verify --force`.

Log what they decided in `HUMAN_LOG.md`.

## 7. The paid run, within the budget

Confirm the budget with the human, check `max_spend_usd`, then:

```bash
node bin/timeline.mjs assets projects/<name> --only s04   # optional: audition one voice clip
node bin/timeline.mjs all projects/<name>
node bin/timeline.mjs costs projects/<name>
```

`assets` refuses a plan that did not pass `verify` or was directed from an older brief, stops before
`max_spend_usd`, and stops early if the measured voice projects a film over `max_seconds`. Watch the
film in `build/final/` (or check frames) and its `.srt` and `.sources.txt`.

## 8. Package the entry

```bash
node src/stages/package.mjs projects/<name>
```

(`package` is not one of `bin/timeline.mjs`'s stages and `all` does not run it; this command always
runs, and with nothing changed it replays the director's cached answer for free.) It writes
`build/final/entry.json` (summary and director's notes by M3.1 flash; title, sources, place and city
line by code), makes `build/final/cover.jpg` from the cover painting if there is none, and prints a
checklist: title, summary and notes within the form's limits, every contributor in `HUMAN_LOG.md`
credited, 16:9 MP4, 60-180 s, >= 720p, <= 100 MiB, H.264 + audio, cover <= 5 MiB. Fix every failed
check, and run it again after any re-render or cut (a changed film changes the director's facts, so
that run pays for a new answer, capped at $0.01). Show the human `entry.json` and the film, and check
the director's notes against `HUMAN_LOG.md` (who did what). Uploading happens only when the human
chooses: they run the printed `contest-submit.py` command themselves (it sends `entry.json` exactly
as reviewed), or ask for `node src/stages/package.mjs projects/<name> --submit --entry <id>` with
`LAB_SUBMISSION_TOKEN` set in their own environment (it refuses while any check fails).
