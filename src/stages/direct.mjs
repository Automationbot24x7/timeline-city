// Stage `direct`: MiniMax M3.1 flash directs the film in a chain of three calls, each logged in
// build/director/ (prompt, reasoning, response, usage):
//   1 treatment: its own style bible, 4-6 stops, the arc, an honest statement of time vs ride order
//   2 script:    the full plan (scenes, narration, map moves, image/music/cover prompts, claims)
//   3 critique:  scores its draft against the contest rubric and returns a revised plan
// Code only checks structure and evidence (ids, sources, URLs, length, hook) and asks once more
// with the list of problems when a check fails. Writes build/plan.json.
import fs from 'node:fs'
import path from 'node:path'
import { askChecked, prompt, resetLog } from '../director/llm.mjs'
import { excerptPack, factsPack, loadEvidence, ridePack, sourcesFor } from '../director/evidence.mjs'
import { alignSites, alignTrain, checkPlan, checkTreatment, limits } from '../director/check.mjs'
import { RUBRIC, critiqueSchema, planSchema, treatmentSchema } from '../director/schemas.mjs'
import { hash } from '../util.mjs'

const LANGS = { en: 'English', hi: 'Hindi', fr: 'French', de: 'German', es: 'Spanish' }
const uniq = (a) => [...new Set(a.filter(Boolean))]

/** Who the personal thread is told about (project.yaml `personal_subject`). */
export const personalSubject = (config) => String(config.personal_subject || 'the maker, in the third person').trim()

/** The director's system prompt (shared by direct and verify's repair calls). */
export const directorSystem = (config) => prompt('director.system.md', { personal_subject: personalSubject(config) })

/**
 * Fingerprint of everything the director was briefed with (project.yaml brief keys + the curated facts
 * file). Stored in plan.json and carried into plan.verified.json; paid media refuses a stale plan.
 */
export function briefHash(config, projectDir) {
  const k = ['city', 'line', 'title', 'hook', 'personal', 'personal_subject', 'narrator', 'style', 'target_seconds', 'language', 'director']
  const facts = config.facts_file && projectDir && fs.existsSync(path.join(projectDir, config.facts_file)) ? hash(fs.readFileSync(path.join(projectDir, config.facts_file), 'utf8')) : null
  const brief = Object.fromEntries(k.map((x) => [x, config[x] ?? null]))
  if (brief.narrator) brief.narrator = { persona: brief.narrator.persona, voice_description: brief.narrator.voice_description }
  if (brief.director) brief.director = { ...brief.director, take: undefined, reasoning_effort: undefined }
  return hash({ brief, facts })
}

/** Template variables shared by every director prompt (the maker's brief + length limits). */
export function briefVars(config) {
  const L = limits(config)
  const n = config.narrator || {}
  const personal = (config.personal || []).map((l) => `  - ${l}`).join('\n') || '  (none)'
  const vars = {
    city: config.city,
    line: [config.line?.name, config.line?.network && `(${config.line.network})`].filter(Boolean).join(' '),
    from: config.line?.from,
    to: config.line?.to,
    language: LANGS[config.language] || config.language,
    persona: String(n.persona || 'the city itself, speaking in the first person').trim(),
    voice: String(n.voice_description || `a custom voice (${n.voice_id || 'default'}); write for the persona above`).trim(),
    map_style: String(config.style?.map || '').trim(),
    illustration_style: String(config.style?.illustration || '').trim(),
    personal,
    personal_subject: personalSubject(config),
    title_line: config.title ? `\nWorking title (keep it as the film's title): "${String(config.title).trim()}"\n` : '',
    hook_line: config.hook ? `- The maker's idea for the opening line (adapt it freely; at most ${L.hookWords} words, every fact in it from the evidence): "${String(config.hook).trim()}"\n` : '',
    notes: config.director?.notes ? `\n## The maker's notes (follow them)\n${String(config.director.notes).trim()}\n` : '',
    target_seconds: String(L.target),
    wps: String(L.wps),
    min_words: String(L.minWords),
    max_words: String(L.maxWords),
    min_scenes: String(L.minScenes),
    max_scenes: String(L.maxScenes),
    max_images: String(L.maxImages),
  }
  return { ...vars, brief: prompt('brief.md', vars) }
}

/** Scores as {criterion: {score, note}}; M3.1 sometimes packs all of them as arrays under the first key. */
function normScores(s = {}) {
  const packed = Object.values(s).find((v) => Array.isArray(v?.score))
  return Object.fromEntries(
    RUBRIC.map((k, i) => [k, packed ? { score: Number(packed.score[i]) || null, note: [].concat(packed.note || [])[i] || '' } : { score: Number(s[k]?.score) || null, note: s[k]?.note || '' }]),
  )
}

const checksText = (r) =>
  [
    r.problems.length ? `Problems still open:\n- ${r.problems.join('\n- ')}` : 'No open problems.',
    r.notes.length ? `Silent fixes made by code:\n- ${r.notes.join('\n- ')}` : '',
    `Stats: ${r.stats.words} words, ${r.stats.scenes} scenes (${r.stats.map_scenes} map, ${r.stats.image_scenes} with images), ~${r.stats.est_seconds} s estimated, ${r.stats.cps} subtitle chars/s, hook "${r.stats.hook}" (${r.stats.hook_words} words), ${r.stats.claims} claims.`,
    `Words per scene: ${r.stats.per_scene.map((x) => `${x.id} ${x.kind} ${x.words}w ~${x.seconds}s`).join('; ')}`,
  ].filter(Boolean).join('\n')

export const stage = {
  name: 'direct',
  outputs: ['plan.json'],
  async run(ctx) {
    const { config } = ctx
    const ev = loadEvidence(ctx)
    resetLog(ctx, 'direct')
    const V = briefVars(config)
    const ride = ridePack(ev)
    const facts = factsPack(ev)
    const system = { role: 'system', content: directorSystem(config) }
    const call = (step, user, schema, name, description) => ({ stage: 'direct', step, messages: [system, { role: 'user', content: user }], schema, name, description })

    // 1. treatment
    ctx.log('  1/3 treatment')
    const t = await askChecked(
      ctx,
      call('treatment', prompt('treatment.md', { ...V, ride, facts }), treatmentSchema, 'submit_treatment', 'Submit the treatment: style bible, stops, arc, time direction.'),
      (raw) => checkTreatment(raw, ev),
    )
    const treatment = t.value
    const styleBible = treatment.style_bible
    ctx.log(`  stops: ${treatment.stops.map((s) => s.station_id.replace(/^st_/, '')).join(' > ')}; titles: ${(styleBible.title_options || []).join(' | ')}`)

    // 2. script
    ctx.log('  2/3 script')
    const chosen = uniq([...treatment.stops.flatMap((s) => s.fact_ids), ...treatment.kept_coming.fact_ids, ...treatment.personal.fact_ids])
    const chosenSrc = sourcesFor(ev, { factIds: chosen, stationIds: treatment.stops.map((s) => s.station_id), siteIds: treatment.stops.flatMap((s) => s.site_ids) })
    const s = await askChecked(
      ctx,
      call('script', prompt('script.md', { ...V, treatment: JSON.stringify(treatment, null, 1), ride, facts, excerpts: excerptPack(ev, chosenSrc) }), planSchema, 'submit_plan', 'Submit the complete plan for the film.'),
      (raw) => checkPlan(raw, ev, config, { styleBible }),
    )
    ctx.log(`  draft: ${s.stats.words} words, ${s.stats.scenes} scenes, ~${s.stats.est_seconds} s, ${s.problems.length} open problem(s)`)

    // 3. critique: self-review against the rubric, revised plan
    ctx.log('  3/3 critique')
    const draft = s.value
    if (config.title) draft.title = String(config.title).trim() // the maker's working title is kept
    const inPlay = uniq([...chosenSrc, ...draft.scenes.flatMap((sc) => sc.source_ids), ...sourcesFor(ev, { factIds: draft.scenes.flatMap((sc) => sc.fact_ids) })])
    const c = await askChecked(
      ctx,
      call(
        'critique',
        prompt('critique.md', { ...V, treatment: JSON.stringify(treatment, null, 1), draft: JSON.stringify(draft, null, 1), checks: checksText(s), ride, facts, excerpts: excerptPack(ev, inPlay) }),
        critiqueSchema,
        'submit_critique',
        'Submit your scores, your fixes and the complete revised plan.',
      ),
      (raw) => ({ ...checkPlan(raw?.plan, ev, config, { styleBible }), scores: normScores(raw?.scores), fixes: raw?.fixes }),
    )
    const useRevision = c.value.scenes.length > 0 && c.problems.length <= s.problems.length
    if (!useRevision) ctx.log(`  critique's revision has more problems (${c.problems.length}) than the draft (${s.problems.length}); keeping the draft`)
    const final = useRevision ? c : s

    const mapNotes = [...alignTrain(final.value, ev), ...alignSites(final.value, ev)]
    if (config.title) final.value.title = String(config.title).trim()
    const plan = {
      ...final.value,
      brief_hash: briefHash(config, ctx.projectDir),
      style_bible: styleBible,
      director: {
        model: config.models.director,
        logline: treatment.logline,
        hook: treatment.hook,
        time_direction: treatment.time_direction,
        stops: treatment.stops,
        arc: treatment.arc,
        rejected: treatment.rejected,
        risks: treatment.risks,
        critique: { scores: c.scores, fixes: c.fixes, used: useRevision },
        checks: { problems: final.problems, notes: final.notes, map_notes: mapNotes, stats: final.stats },
        log: 'director/index.json',
      },
    }
    ctx.write('plan.json', plan)
    const st = final.stats
    ctx.log(`  plan.json: "${plan.title}", ${st.scenes} scenes, ${st.words} words, ~${st.est_seconds} s, ${st.claims} claims${final.problems.length ? `, ${final.problems.length} open problem(s)` : ''}`)
  },
}
