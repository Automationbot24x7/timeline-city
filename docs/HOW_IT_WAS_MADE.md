# How "One Ticket, 800 Years" was made

A transparent account for the judges of the SandBase AI City Remix contest: who did what, how much
of it was automated, what it cost, and how the facts were checked. Every number below comes from
files in `projects/delhi-yellow-line/` (paths given), as of 26 October 2026.

## Who did what

| who | what |
|---|---|
| **MiniMax M3.1 flash** (via SandBase) | Every decision about what the film says and shows, and every line of its script: the stops, the arc, the style bible and title options (the film keeps the working title from the original brief), the narration, on-screen text and map moves, every image prompt, the music and cover prompts, the fact-check verdicts, the repairs (including the maker's three review notes), the five landmark paintings' prompts, and the contest entry's summary and notes. |
| **MiniMax Speech 2.8 HD** | The narration, one clip per scene, in a custom voice designed with **MiniMax Voice Design** from a short written description of the narrator (an elderly Old Delhi storyteller; that description is not an M3.1 prompt). The final cut uses 12 clips. |
| **MiniMax Music 2.6** | The instrumental score (`is_instrumental: true`), from M3.1's music prompt. |
| **Google Nano Banana 2.1** | The paintings, at 2K: 5 landmark paintings (Jama Masjid, Jantar Mantar, Rashtrapati Bhavan, Qutb Minar, the Iron Pillar), 6 scene paintings (4 in the final cut; the other 2 belonged to the family scenes the maker cut) and the cover. |
| **Claude Code** (Anthropic's coding agent) | Wrote the TimeLine tool (all code: `bin/`, `src/`, `render/`, so also the film's fixed visual style: the 3D city, the globe, type and motion) and these docs, proposed the Yellow Line ride as the frame, and ran the adversarial fact-check research behind `facts.verified.json`. Made review fixes to the brief (pinned the working title, aligned the facts file with the maker's wording wish, set the word budget from the custom voice's measured speed), added the end-credit note that some old-city blocks in the 3D map are illustrative, and carried out the maker's cuts of 26 October (below). It wrote no script text. |
| **The maker** (human) | The decisions in `HUMAN_LOG.md`, below. |

### The maker's decisions (`HUMAN_LOG.md`, `project.yaml`)

- Chose the city: Delhi, his birthplace; asked for a positive story rather than "the city that died
  seven times".
- Accepted the Yellow Line ride as the frame (proposed by Claude Code).
- Gave his own memories for a personal thread at the end of the film, and asked for one change of
  wording in them. (He later cut that thread from the film, below.)
- Asked for a male narrator, then approved the custom voice made with MiniMax Voice Design.
- Reviewed the first verified script: three notes (scenes s03, s13, s14), which went to the director
  as repair issues (`project.yaml` `director.review`). M3.1 flash rewrote those lines itself.
- Reviewed the first cut and asked for a real-looking 3D map with a fly-in and a painting for each
  major stop; approved about $0.40 for five landmark paintings.
- Approved the 3D cut, then cut a personal line from the last scene and, after that, the two family
  scenes. The film now ends on the city-of-arrivals line and "Ride on, traveller."
- Asked to review the finished file before any upload. Nothing is submitted automatically.
- Writes the entry's city line (`my_city_line`) himself.
- Asked for his personal memories to be removed from the repository; they show as "[personal memory
  removed at the maker's request]" in `HUMAN_LOG.md`, `project.yaml`, the facts file and the logs.

## Automation level

Everything from the brief to the finished film runs as one command per stage, with no person in the
loop: `geo -> ground -> direct -> verify -> art -> assets -> timing -> render -> mix -> package`.

- **No narration, on-screen text, image prompt or music prompt was written by a person.** Feedback
  reached the script as review notes that the director applied in a repair round. The one other
  change was the maker's cuts on 26 October: Claude Code removed a personal line (claim c30) and
  then the family scenes s12 and s13 (claims c23-c27) from `build/plan.verified.json`, and put
  the last scene's two remaining verified sentences in a new order. No word was added and the
  director was not called; `plan.verified.before-cut.json` and `plan.verified.before-family-cut.json`
  keep the earlier versions.
- **Code makes no choice about what the film says or shows.** It checks structure and evidence
  (ids, sources, quotes, lengths, the word budget), asks the director once more with the list of
  problems when a check fails, and executes: maps, timing, rendering, mixing, in the renderer's fixed
  visual style.
- The inputs from outside the director were the brief (`project.yaml`: city, line, personal lines,
  narrator persona and voice, style direction, the working title and a hook idea, budget), built from
  the maker's decisions and Claude Code's review fixes; three review notes; two review passes; the
  maker's cuts; and money approvals.

## The director's calls

`build/director/` keeps each call's full prompt, the model's reasoning, its answer, token usage and
cost (with the maker's personal memories redacted, as above); `build/director/index.json` lists
them. Behind the final film there are **19 M3.1 flash calls**
(20 paid requests: the script call's first answer hit its 40,000-token limit and was asked again):

| stage | calls | what | prompt + completion tokens | cost |
|---|---:|---|---:|---:|
| direct | 6 | treatment, script, critique, each with one retry after code checks | 382,483 + 136,942 | $0.1396 |
| verify | 12 | 9 fact-check batches over four check rounds, 3 repair calls | 134,890 + 36,032 | $0.0419 |
| art | 1 | landmark paintings for 5 map scenes | 11,521 + 3,852 | $0.0040 |
| **total** | **19** | | **528,894 + 176,826** | **$0.1854** |

121,790 of the completion tokens were reasoning. Five of the verify calls were replayed from the
cache of identical earlier paid calls. The critique scored the draft 8 or 9 out of 10 on every line of
the rubric; its revised plan had more open problems than the draft, so code kept the draft.

The `package` step (the contest entry) adds its own logged call (`build/director/package.json`).
The maker's cuts of 26 October called no model, so these numbers are unchanged by them.

## Costs

The project's ledger, `build/costs.jsonl`, records every paid request, including every take and test
while the tool was being built on this film (106 rows on 26 October, after the first test of the
`package` step):

| model | requests | cost |
|---|---:|---:|
| MiniMax M3.1 flash | 77 | $0.436 |
| MiniMax Speech 2.8 HD | 15 | $0.172 |
| Google Nano Banana 2.1 | 13 | $0.864 |
| MiniMax Music 2.6 | 1 | $0.150 |
| **total** | **106** | **$1.621** |

- M3.1 flash: the 19 calls behind the film (20 paid requests) cost $0.185; 54 more requests are
  earlier takes and tests, and 3 are the first test of the `package` step ($0.009).
- Voice: 14 clips, then the last scene voiced again after the first cut ($0.011).
- Paintings: 7 runs at $0.06 (6 scene paintings and the cover) and 6 landmark runs at $0.074 (2K with
  web-search grounding of the monument's look) for the 5 landmark paintings in the film.
- Spend cap: `max_spend_usd` for the whole ledger (1.65, raised to 1.70 on 26 October for the
  re-voiced ending); paid media stops before it.
- Outside the ledger: the custom voice, made once with `minimax/voice-design` (SandBase's price card:
  $3.00 plus $0.03 per 1,000 characters of the voice description).

## Fact check (`build/verify.json`)

- Every factual statement in the narration is an atomic claim citing evidence ids from
  `build/ground.json` (307 sources: Wikidata, Wikipedia and the curated facts file of 107 researched
  claims with sources and caveats).
- M3.1 flash judged each claim against only the excerpts it cites. A "supported" verdict must quote
  its support; code downgrades it when the quote is not in those excerpts.
- First check: 28 of 32 claims supported, 4 partial, and 5 blocking scene issues (two uncovered facts,
  and the maker's three review notes).
- Repair rounds: round 1 rewrote s01, s02, s03, s05, s08, s11, s13 and s14; round 2 s01, s02 and s14;
  round 3 s14.
- Final check: **30 of 30 claims supported** (24 historical facts against 42 distinct source pages,
  6 personal lines against the maker's own words), 0 partial, 0 unsupported; passed. 285 words.
- The maker's cuts then removed 6 of those claims (c30, and c23-c27 with the family scenes) and
  added none: the final cut carries **24 checked claims** (23 historical facts against 39 distinct
  source pages, and 1 personal claim) in 224 words. `verify.json` keeps the check as it ran;
  `plan.verified.json` (`verification`) records the cuts.
- Paid media is refused for a script that has not passed (`assets`), so no voice or painting was
  bought for an unchecked line.
- Note: after `direct`, the personal thread and the review notes changed in the
  brief; `verify --force` re-checked the whole script against both, and `project.yaml` sets
  `allow_stale_plan: true` with that reason.

## Data sources

- **Map**: OpenStreetMap (ODbL) via the Overpass API: the Yellow Line (relation 447210), its 16
  stations on the ridden span, water, parks, roads, heritage sites, and the 3D city (20,273 OSM
  buildings, 11,433 street pieces). Where OSM maps Old Delhi's lanes but few of its houses, the 3D
  city adds 4,130 procedural blocks, kept separate and not OSM data. The walled-city outlines
  (`footprints.geojson`) are approximate hulls of surviving OSM wall fragments, drawn dashed.
- **Evidence**: Wikidata (CC0), Wikipedia (CC BY-SA 4.0), and the curated facts file, whose sources
  include UNESCO, Britannica, the Delhi Metro Rail Corporation, government and court documents,
  academic papers and newspapers. The film's sources list is `build/final/delhi-yellow-line.sources.txt`.
- **Earth at night**: NASA Earth Observatory, Black Marble 2016 (`render/assets/earth/CREDITS.md`).
- **Fonts**: Fraunces, Inter, Noto Sans Devanagari (SIL Open Font License).

## Where to check all this

| file | what |
|---|---|
| `projects/delhi-yellow-line/project.yaml` | the brief, including the review notes and the spend cap |
| `projects/delhi-yellow-line/HUMAN_LOG.md` | every human decision |
| `projects/delhi-yellow-line/facts.verified.json` | the curated facts with sources, caveats and verdicts |
| `build/director/*.json` | every director call: prompt, reasoning, answer, usage, cost |
| `build/verify.json`, `build/plan.verified.json` | the fact check and the checked script (after the maker's cuts) |
| `build/plan.verified.before-cut.json`, `build/plan.verified.before-family-cut.json` | the checked script before each cut |
| `build/costs.jsonl` | the cost ledger (`node bin/timeline.mjs costs projects/delhi-yellow-line`) |
| `build/final/` | the films, subtitles, sources list, cover and `entry.json` |
