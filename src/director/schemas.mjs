// JSON schemas for the director's forced function calls (M3.1 flash honours tool_choice, not response_format).
export const KINDS = ['title', 'map', 'illustration', 'personal', 'end']
export const STATUSES = ['supported', 'partial', 'unsupported']
export const FLAGS = ['living_person', 'national_border', 'unsupported_superlative', 'caveat_violation', 'false_time_order']

const str = (description) => ({ type: 'string', ...(description && { description }) })
const strs = (description) => ({ type: 'array', items: { type: 'string' }, ...(description && { description }) })
const obj = (properties, required = Object.keys(properties), description) => ({ type: 'object', properties, required, ...(description && { description }) })

export const treatmentSchema = obj({
  style_bible: obj({
    narrator_persona: str('Who speaks and how: age, warmth, humour, rhythm, how local words are used (2-4 sentences).'),
    illustration_style: str('One reusable style paragraph (<= 60 words) that every image prompt ends with. No text, no recognisable people.'),
    palette: strs('4-6 colours as "name #hex".'),
    music_direction: str('Instruments, mood arc across the film, tempo. Instrumental only.'),
    title_options: strs('3-5 short title options, best first.'),
  }),
  logline: str('One sentence.'),
  hook: str('The opening line idea (<= 10 words), spoken in the first 5 seconds.'),
  time_direction: str('1-3 honest sentences on how the dates relate to the ride order.'),
  arc: {
    type: 'array',
    items: obj({ part: { type: 'string', enum: ['hook', 'ride', 'kept_coming', 'personal'] }, purpose: str(), beats: strs() }),
  },
  stops: {
    type: 'array',
    description: '4-6 stops in ride order.',
    items: obj({ station_id: str('A station id from the ride list.'), era: str('e.g. "1639-1648"'), why: str(), fact_ids: strs(), site_ids: strs('Site ids to light up on the map.') }),
  },
  kept_coming: obj({ why: str(), fact_ids: strs() }),
  personal: obj({ plan: str('How the personal last stop is told, and how it ties back to the ride.'), fact_ids: strs() }),
  rejected: { type: 'array', items: obj({ fact_id: str(), reason: str() }) },
  risks: strs('Accuracy traps to avoid in the script.'),
})

const scene = obj(
  {
    id: str('s01, s02, ...'),
    kind: { type: 'string', enum: KINDS },
    narration: str('First-person narration for this scene; optional <#0.6#> pause markers.'),
    on_screen: obj({ headline: str('<= 24 characters'), year: str('Era for the year card, or ""'), subtitle_lang: str() }, ['headline', 'year']),
    map: obj(
      { train_to: str('Station id the train rides to in this scene, or "".'), focus_station: str(), focus_site_ids: strs(), zoom: { type: 'number' } },
      ['focus_station'],
      'For kind=map.',
    ),
    image_prompt: str('For kind title / illustration / personal / end.'),
    fact_ids: strs(),
    source_ids: strs(),
  },
  ['id', 'kind', 'narration', 'on_screen', 'fact_ids', 'source_ids'],
)

const claim = obj({
  id: str('c01, c02, ...'),
  scene_id: str(),
  text: str('One atomic factual statement made in that scene.'),
  kind: { type: 'string', enum: ['fact', 'personal'] },
  source_ids: strs('Evidence source ids whose excerpt supports it (empty for personal).'),
})

export const planSchema = obj({
  title: str(),
  logline: str(),
  music_prompt: str(),
  cover_prompt: str(),
  scenes: { type: 'array', items: scene },
  claims: { type: 'array', items: claim },
})

const score = obj({ score: { type: 'integer', description: '1-10' }, note: str() })
export const RUBRIC = ['accuracy', 'story_craft', 'warmth', 'pacing', 'hook', 'ending', 'positivity', 'length']
export const critiqueSchema = obj({
  scores: obj(Object.fromEntries(RUBRIC.map((k) => [k, score]))),
  fixes: strs('The concrete changes you are making, most important first.'),
  plan: planSchema,
})

export const verifySchema = obj({
  claims: {
    type: 'array',
    items: obj(
      {
        id: str(),
        status: { type: 'string', enum: STATUSES },
        note: str('What exactly is or is not supported.'),
        quote: str('The shortest exact quote from a cited excerpt that supports the claim, or "".'),
        flags: { type: 'array', items: { type: 'string', enum: FLAGS } },
      },
      ['id', 'status', 'note', 'quote', 'flags'],
    ),
  },
  scenes: {
    type: 'array',
    items: obj({
      scene_id: str(),
      issues: {
        type: 'array',
        items: obj({ type: { type: 'string', enum: ['uncovered_fact', ...FLAGS, 'other'] }, text: str('The words in the narration.'), note: str() }),
      },
    }),
  },
})

export const repairSchema = obj({
  scenes: {
    type: 'array',
    items: obj(
      {
        id: str(),
        action: { type: 'string', enum: ['rewrite', 'cut'] },
        narration: str(),
        on_screen: obj({ headline: str(), year: str() }),
        fact_ids: strs(),
        source_ids: strs(),
        claims: { type: 'array', items: obj({ text: str(), kind: { type: 'string', enum: ['fact', 'personal'] }, source_ids: strs() }) },
        note: str('What you changed and why.'),
      },
      ['id', 'action', 'narration', 'claims', 'note'],
    ),
  },
})

// art step: one landmark painting per map scene at a major stop (narration, claims and on-screen text untouched)
export const REVEALS = ['named', 'arrival']
export const landmarkSchema = obj({
  landmarks: {
    type: 'array',
    items: obj({
      scene_id: str('The map scene this painting belongs to.'),
      site_id: str('The site the painting shows: one of that scene\'s focus site ids.'),
      subject: str('What the painting shows, as the evidence spells it (<= 32 characters).'),
      reveal_at: { type: 'string', enum: REVEALS, description: '"named": the painting appears when the narration names the landmark (never before the train arrives); "arrival": about a second after the train stops.' },
      image_prompt: str('The painting: 90-170 words, architecturally accurate, ending with the style bible illustration_style.'),
      why: str('One sentence: what this painting adds at this moment of the film.'),
    }),
  },
})
