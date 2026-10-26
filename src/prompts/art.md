# Art direction: the landmark paintings

{{brief}}

## Why you are called again
Your verified script is final: its narration, claims and on-screen text do not change. The maker reviewed the first cut and asked for one thing more: when the train reaches a major stop, the film should show the landmark itself. On each scene listed below the map now gives way to a full-frame painting of that landmark shortly after the train arrives (or the moment the narration names it), while the 3D map keeps playing in a small card in the top-right corner. You are the art director: for each of these scenes, paint the landmark its narration is about, and say when the painting appears.

## Your style bible (every painting belongs to the same film)
- illustration_style: {{illustration_style}}
- palette: {{palette}}

## The light of the film
{{light}}

## Paintings already in the film
A landmark may appear in another painting too (a title or end image, say): then choose a clearly different viewpoint, distance and light, so the two never look like the same picture.
{{others}}

## The scenes that get a landmark painting
{{scenes}}

## How these places look (visual evidence for the paintings only; never for narration)
{{looks}}

## Source excerpts about these places
{{excerpts}}

## Caveats from the fact-checked research (obey them; a caveat overrides everything)
{{caveats}}

## What to submit (call `submit_landmarks`): exactly one entry for each of these scenes: {{scene_ids}}
- **scene_id**: the scene.
- **site_id**: the scene's FIRST focus site (exact id): the place its narration and year card are about.
- **subject**: what the painting shows, as the evidence spells it (at most 32 characters), such as "Jama Masjid".
- **reveal_at**: "named" when the narration names the landmark early enough for the painting to stay on screen a while (the painting then appears on that word, never before the train has arrived); "arrival" when the narration names it only in its last few words, or not at all (the painting then appears about a second after the train stops).
- **image_prompt**: one painting, 90-170 words before the style paragraph, ending with your illustration_style. Rules:
  - **Architecturally accurate.** A judge who knows {{city}} will compare it with the real place. Begin with the monument's name and city (the image model searches the web for references). Describe what a visitor really sees: the materials and their colours (stone, marble, plaster, metal; the colour of each dome), the number and shape of domes, minarets, storeys, arches or instruments, the proportions, the ornament, and the setting around it (courtyards, stairs, gardens, ruins, the hill it stands on). Take these details from "How these places look" above; add a detail from your own knowledge only when you are certain of it, and leave out anything doubtful rather than guess. Show the monument as it stands, complete and timeless, unless a caveat says otherwise.
  - **Viewpoint and moment.** A vantage point a person could stand at, chosen to show what makes this place itself (the view people know it by); the light the light section above gives for this scene; a quiet, reverent, warm mood.
  - **Composition for this film.** Wide 16:9 with the landmark near the horizontal centre (the frame is also cropped to vertical 9:16). Keep both upper corners calm and uncluttered (open sky or plain wall: the year card sits top-left, the map card top-right) and the bottom fifth simple (subtitles sit there).
  - **People.** No recognisable real people; any figures are few, small, distant or turned away. No crowds, no tourists with phones, no vehicles, no wires or modern signs.
  - **No writing.** No text, letters, numbers, signs, logos, flags, maps or borders anywhere. Carved bands and inscriptions are ornament, never legible lettering.
- **why**: one sentence: what this painting adds at this moment of the film.

Before you submit, read each image_prompt against "How these places look": strike every detail it does not support and you are not certain of.
