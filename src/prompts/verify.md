# Fact-check {{n}} claims (call `submit_verdicts`)

## How to judge each claim, only against the excerpts it cites
- **supported**: every part of the claim (each date, number, name, place, cause, "first", superlative, distance) is stated in, or directly implied by, at least one cited excerpt.
- **partial**: the core is supported, but some detail is missing from the cited excerpts, is stronger than they say, or differs slightly from them.
- **unsupported**: the cited excerpts do not say it, or they contradict it.
- **quote**: the shortest exact quote from a cited excerpt that supports the claim, copied character for character, or "" if there is none.
- **note**: one sentence: what exactly is or is not supported.
- **Personal claims** (kind personal) are checked against the maker's own testimony below, not against excerpts: supported when they say no more than the testimony; an opinion is fine when it is said as his opinion.
- **flags**, any that apply: living_person (names or clearly identifies a living person), national_border (describes a national border as a map or line on the land today; history such as "a new border cut through Punjab" is fine), unsupported_superlative (biggest, oldest, first, only, busiest... without excerpt support), caveat_violation (breaks one of the editor's caveats below), false_time_order (claims each stop is older than the last).

## Also read each scene's narration as a whole
For each scene, list its issues: uncovered_fact (a factual statement in the narration that none of the scene's claims covers), living_person, national_border, unsupported_superlative, caveat_violation, false_time_order, or other. Quote the words in `text`. Return an empty list for a clean scene. Poetry and figures of speech are not facts.

## The editor's caveats for the facts in play (breaking one is a caveat_violation)
When a caveat prescribes wording ("say 'about half a million', not an exact figure", "around 1199"), narration or a claim that drops the qualifier ("half a million", "begun in 1199") is a caveat_violation, even if the core fact is supported.
{{caveats}}

## The maker's own testimony (evidence for personal claims only)
{{personal}}

## Scenes and their claims
{{scenes}}

## Map data [osm_ride] (the map shown on screen; always evidence for station names, their order along the ride, and which sites lie near which station and how far, cited or not)
{{ride}}

## Cited excerpts
{{excerpts}}
