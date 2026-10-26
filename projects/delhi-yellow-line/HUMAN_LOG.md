# Human interventions log

Everything a person decided for this film, for the "How you made it" field. Creative
direction of the film itself (stops, script, style bible, image and music prompts) is
done by MiniMax M3.1 flash and logged in `build/director/`.

| Date (UTC) | Who | Decision |
|---|---|---|
| 2026-10-23 | Maker | Chose the city: Delhi, his birthplace. |
| 2026-10-23 | Maker | Asked for a positive story rather than "the city that died seven times". |
| 2026-10-23 | Maker + Claude Code | Picked the Yellow Line ride as the frame (Claude Code proposed it, the maker accepted). |
| 2026-10-23 | Maker | [personal memory removed at the maker's request] |
| 2026-10-23 | Maker | Asked for a male narrator. |
| 2026-10-25 | Maker | Approved a custom narrator voice made with MiniMax Voice Design (`minimax/voice-design`), replacing the stock voice used by the official Skill. |
| 2026-10-25 | Maker | [personal memory removed at the maker's request] |
| 2026-10-25 | Maker | Asked to review the finished file before any upload; nothing is submitted automatically. |
| 2026-10-26 | Claude Code | Added an end-credit disclosure: OpenStreetMap maps Old Delhi's lanes but few of its houses, so the 3D city draws dimmed procedural blocks there (`fill` in geo_detail.json); the credits now say some old-city blocks are illustrative. |
| 2026-10-26 | Maker | [personal memory removed at the maker's request] |
| 2026-10-23 → | Claude Code | Wrote the TimeLine tool (code only) and ran adversarial fact-check research that produced `facts.verified.json`. |
| 2026-10-25 | Claude Code (review fixes) | Pinned the working title "One Ticket, 800 Years" from the original brief in project.yaml. Brought facts.verified.[personal memory removed at the maker's request] Set the word budget from the custom voice's measured speed so the film stays under 180 s. No script text was edited by hand: the director re-runs from these inputs. |
| 2026-10-25 | Maker | Reviewed the first cut: asked for a real-looking map (3D OpenStreetMap city, like the chronicle-ink template, with a Google-Earth-style fly-in) and a painting for each major stop, including the Qutb Minar. Approved ~$0.40 for 5 landmark paintings. |
| 2026-10-26 | Maker | [personal memory removed at the maker's request] The last scene now keeps only its two verified sentences, reordered to end on "Ride on, traveller." (no new text; claim c30 removed). |
| 2026-10-26 | Maker | [personal memory removed at the maker's request] The film now ends on the city-of-arrivals line and "Ride on, traveller." No new text. |
| 2026-10-26 | Maker | Asked to keep his GitHub account name off the film and repo link; the repo URL was removed from the end card. |
