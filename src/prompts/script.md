# Step 2 of 3: the script

{{brief}}

## Your treatment (step 1)
{{treatment}}

## Write the full plan now (call `submit_plan`)
Use your style_bible above, not the maker's brief, for the voice, every image_prompt, the cover and the music.

Format, all hard limits:
- **Scenes**: {{min_scenes}}-{{max_scenes}}, ids s01, s02, ... Kinds: `title` (first: the hook spoken over the title image), `map` (the train rides; the spine of the film, at least 5), `illustration` (a moment a map cannot show), `personal` (the maker's thread, told about {{personal_subject}}; the last personal scene ends on its reveal, alone, after a <#0.8#> pause), `end` (last: the closing "me and this city" line). At most {{max_images}} scenes of kinds title, illustration, personal and end together.
- **Length**: the narration of all scenes together is {{min_words}}-{{max_words}} words (the chosen voice speaks about {{wps}} words a second; with scene gaps that makes about {{target_seconds}} seconds). Count them. 8-40 words per scene, one idea per scene.
- **Hook**: the first sentence of s01 is at most 10 words and is spoken in the first 5 seconds. Make a stranger stay with a concrete picture or promise (the ride, the ticket, the centuries), not an abstraction.
- **Narration**: first person, in your narrator_persona, written to be spoken aloud in {{language}}; local words only where natural for {{city}} and clear from context. Short sentences that are easy to say and to read as subtitles (at most 17 characters a second). The year card already shows each stop's era: say a date only when it is the point (at most one date and one other number per scene) and spend the words on one sensory detail per stop (a sound, a smell, a light); let the narrator smile once or twice. Years as digits. No parentheses (the voice reads them flat); no hedges such as "roughly" unless the evidence itself is approximate; name a place, a court or a person before saying "it", "he" or "the Court". Where a caveat gives the wording ("about half a million", "around 1199"), use that wording. At most one pause marker per scene, like <#0.6#> (0.3-1.2 seconds), at a real dramatic beat. No URLs, no markup, no stage directions.
- **Ride order**: map scenes ride forward along the line. train_to is the station the train reaches during that scene; never send it back towards {{from}}. After the last station, map scenes may still look at an earlier station with focus_station and no train_to.
- **on_screen**: headline (at most 24 characters: the station or site name as the evidence spells it; no year in it), year (the era on the year card, such as "1639-1648", "c. 1300" or "1982"; a date the evidence gives as approximate is "c. 1199" on the card; "" if none), subtitle_lang "{{language}}".
- **map** (kind map): train_to, focus_station (station ids), focus_site_ids (site ids listed under or near that station in the ride list; each lights up as the narration names it, so light every mapped site the narration names, such as a tank or a wall, and only sites from the era on that scene's year card: the first one is the site the year card dates), zoom 12-16 (12 shows half the city, 14 a neighbourhood, 15.5 a few streets).
- **image_prompt** (title, illustration, personal, end): a concrete picture: subject, setting, era, time of day, light, composition; wide 16:9 with the main subject near the centre (it is also cropped to 9:16). End it with your style_bible.illustration_style. No text, letters, signs or logos; no recognisable real people; faces small, distant or turned away; no flags, maps or borders. Never picture what a caveat rules out (a monument seen from the train when the caveat says it cannot be, the train above ground where the line runs underground).
- **cover_prompt**: the 16:9 cover image, same rules.
- **music_prompt**: one paragraph for an instrumental bed from your music_direction: instruments, how the mood moves through hook, ride, "they kept coming" and the personal ending, tempo, ending on a warm resolved note, total length about {{target_seconds}} seconds. No vocals, no singing.
- **fact_ids / source_ids** per scene: the facts the narration states and the sources behind them.
- **claims**: EVERY factual statement in the narration (each date, number, name, place, cause, "first", superlative or distance) as one short atomic claim, with the source_ids whose excerpt supports it. Statements from the maker's personal thread are kind "personal" with no sources. Opinions said as the maker's own opinion are personal too.

Before you submit, read your narration aloud in your head as one piece: does it flow, does it feel like one warm person talking, does the ending land?

## The ride ({{from}} -> {{to}}, in order)
{{ride}}

## Evidence pack
{{facts}}

## Source excerpts behind the facts you chose (what the fact-checker will compare your claims with)
{{excerpts}}
