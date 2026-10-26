// Stage `verify`: M3.1 flash fact-checks every claim of plan.json against ONLY the excerpts it cites
// (about 8 claims a call), and reads each scene for uncovered facts, living people, borders,
// unsupported superlatives and broken caveats. One repair call per round then rewrites (or cuts) only
// the failing scenes from the evidence, and the changed scenes are checked again; at most 2 rounds.
// Code enforces evidence: unknown source ids, uncited facts, and "supported" verdicts whose quote is
// not in the cited excerpts are downgraded. Writes build/verify.json and build/plan.verified.json.
import { ask, askChecked, prompt, resetLog } from '../director/llm.mjs'
import { RIDE_SOURCE, caveatsFor, excerptPack, factsPack, loadEvidence, sourcesFor } from '../director/evidence.mjs'
import { alignSites, alignTrain, checkPlan, estimate, limits, stripPauses, wordCount } from '../director/check.mjs'
import { repairSchema, verifySchema } from '../director/schemas.mjs'
import { directorSystem } from './direct.mjs'

const BATCH = 8
const MAX_ROUNDS = 3
// maker_note: a human review note from project.yaml director.review, applied through a repair round
const BLOCKING = new Set(['uncovered_fact', 'living_person', 'national_border', 'unsupported_superlative', 'caveat_violation', 'false_time_order', 'maker_note'])
const uniq = (a) => [...new Set(a.filter(Boolean))]
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** A quote counts as found when it is in the texts verbatim, or 80% of its longer words are. */
export function quoteFound(quote, texts) {
  const q = norm(quote)
  if (!q) return false
  const hay = texts.map(norm).join(' | ')
  if (hay.includes(q)) return true
  const words = q.split(' ').filter((w) => w.length > 3)
  return words.length >= 3 && words.filter((w) => hay.includes(w)).length / words.length >= 0.8
}

const claimLine = (c) => `- ${c.id} [${c.kind}] "${c.text}"${c.kind === 'fact' ? ` cites: ${c.source_ids.join(', ') || '(nothing)'}` : ''}`

function batchesOf(scenes, claimsOf) {
  const out = []
  let cur = []
  let n = 0
  for (const sc of scenes) {
    const k = claimsOf(sc).length
    if (cur.length && n + k > BATCH) {
      out.push(cur)
      cur = []
      n = 0
    }
    cur.push(sc)
    n += k
  }
  if (cur.length) out.push(cur)
  return out
}

/** Check the claims and narration of `scenes`; returns { verdicts: Map(claimId -> v), issues: Map(sceneId -> [...]) }. */
async function checkScenes(ctx, ev, plan, scenes, round) {
  const personal = (ctx.config.personal || []).map((l) => `- ${l}`).join('\n') || '(none)'
  const claimsOf = (sc) => plan.claims.filter((c) => c.scene_id === sc.id)
  const verdicts = new Map()
  const issues = new Map()
  const system = { role: 'system', content: prompt('verify.system.md') }
  const batches = batchesOf(scenes, claimsOf)
  for (const [bi, batch] of batches.entries()) {
    const claims = batch.flatMap(claimsOf)
    // code verdicts first: a fact claim that cites nothing usable cannot be supported
    const judge = []
    for (const c of claims) {
      if (c.kind === 'fact' && !c.source_ids.length) verdicts.set(c.id, { status: 'unsupported', note: 'cites no evidence source', quote: '', flags: [], by: 'code' })
      else judge.push(c)
    }
    const srcIds = uniq(judge.flatMap((c) => c.source_ids)).filter((id) => id !== RIDE_SOURCE)
    const scenesText = batch.map((sc) => [`### ${sc.id} (${sc.kind}) narration: "${stripPauses(sc.narration)}"`, ...claimsOf(sc).filter((c) => judge.includes(c)).map(claimLine)].join('\n')).join('\n\n')
    const caveats = caveatsFor(ev, { factIds: batch.flatMap((sc) => sc.fact_ids || []), sourceIds: srcIds }) || '(none)'
    const user = prompt('verify.md', { n: String(judge.length), caveats, personal, scenes: scenesText, ride: ev.sources.get(RIDE_SOURCE).excerpt, excerpts: excerptPack(ev, srcIds) || '(none)' })
    const wantIds = judge.map((c) => c.id)
    const res = await askChecked(
      ctx,
      { stage: 'verify', step: `verify-r${round}-b${bi + 1}`, messages: [system, { role: 'user', content: user }], schema: verifySchema, name: 'submit_verdicts', description: 'Submit a verdict for every claim and the issues of every scene.', max_tokens: 24000 },
      (raw) => {
        const got = new Set((raw?.claims || []).map((v) => v.id))
        const missing = wantIds.filter((id) => !got.has(id))
        return { value: raw, problems: missing.length ? [`no verdict for claims ${missing.join(', ')}`] : [] }
      },
    )
    for (const v of res.value?.claims || []) {
      const c = judge.find((x) => x.id === v.id)
      if (!c) continue
      const out = { status: v.status, note: v.note || '', quote: v.quote || '', flags: uniq(v.flags || []), by: 'M3.1' }
      // evidence check: the supporting quote must really be in what the claim cites
      const texts = c.kind === 'personal' ? testimony(ctx.config) : [...c.source_ids, RIDE_SOURCE].map((id) => ev.sources.get(id)?.excerpt || '')
      if (out.status === 'supported' && out.quote && !quoteFound(out.quote, texts)) {
        out.status = 'partial'
        out.note = `${out.note} [code: the quoted support was not found in the cited excerpts]`.trim()
      }
      verdicts.set(c.id, out)
    }
    for (const c of judge) if (!verdicts.has(c.id)) verdicts.set(c.id, { status: 'partial', note: 'the checker returned no verdict', quote: '', flags: [], by: 'code' })
    for (const s of res.value?.scenes || []) {
      if (!batch.some((sc) => sc.id === s.scene_id)) continue
      issues.set(s.scene_id, (s.issues || []).filter((i) => i && i.type))
    }
  }
  return { verdicts, issues }
}

// the maker's own words: the personal thread, plus the brief's opening hook (framing, not a fact)
const testimony = (config) => [...(config.personal || []), ...(config.hook ? [`The film's opening framing, in the maker's words: ${config.hook}`] : [])]
const failingClaim = (v) => v.status !== 'supported' || v.flags.length > 0
const blockingIssues = (list) => (list || []).filter((i) => BLOCKING.has(i.type))

export const stage = {
  name: 'verify',
  outputs: ['verify.json', 'plan.verified.json'],
  async run(ctx) {
    const { config } = ctx
    const ev = loadEvidence(ctx)
    resetLog(ctx, 'verify')
    const styleBible = (ctx.read('plan.json').style_bible) || {}
    // normalise through the same checks as `direct` (ids, sources, URLs); tag scenes with a stable key
    let plan = checkPlan(ctx.read('plan.json'), ev, config, { styleBible }).value
    alignTrain(plan, ev)
    for (const sc of plan.scenes) sc._key = sc.id
    const wordsBefore = plan.scenes.reduce((s, sc) => s + wordCount(sc.narration), 0)

    // verdicts are keyed by scene key + claim text, so they survive renumbering after cuts
    const verdict = new Map()
    const sceneIssues = new Map()
    const keyOf = (c) => `${plan.scenes.find((s) => s.id === c.scene_id)?._key}|${norm(c.text)}`
    const history = []

    const runCheck = async (scenes, round) => {
      ctx.log(`  round ${round}: checking ${scenes.length} scene(s), ${plan.claims.filter((c) => scenes.some((s) => s.id === c.scene_id)).length} claim(s)`)
      const { verdicts, issues } = await checkScenes(ctx, ev, plan, scenes, round)
      for (const c of plan.claims) if (verdicts.has(c.id)) verdict.set(keyOf(c), { ...verdicts.get(c.id), round })
      for (const sc of scenes) sceneIssues.set(sc._key, (issues.get(sc.id) || []).map((i) => ({ ...i, round })))
    }
    const failingScenes = () =>
      plan.scenes.filter((sc) => blockingIssues(sceneIssues.get(sc._key)).length || plan.claims.some((c) => c.scene_id === sc.id && failingClaim(verdict.get(keyOf(c)) || { status: 'unsupported', flags: [] })))

    await runCheck(plan.scenes, 0)
    // the maker's review notes ride along as scene issues, so the director (not a person) rewrites the line
    for (const n of config.director?.review || []) {
      const sc = plan.scenes.find((s) => s.id === n.scene)
      if (!sc) {
        ctx.log(`  review note for unknown scene ${n.scene} ignored`)
        continue
      }
      sceneIssues.set(sc._key, [...(sceneIssues.get(sc._key) || []), { type: 'maker_note', text: stripPauses(sc.narration), note: `The maker's review note: ${String(n.note).trim()}`, round: 0 }])
    }
    let rounds = 0
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const failing = failingScenes()
      const tally = summary(plan, verdict, keyOf, sceneIssues)
      history.push({ round: round - 1, ...tally, failing_scenes: failing.map((s) => s.id) })
      if (!failing.length) break
      rounds = round
      ctx.log(`  repair ${round}: ${failing.map((s) => s.id).join(', ')}`)
      const { changed, cut } = await repair(ctx, ev, plan, failing, verdict, keyOf, sceneIssues, round)
      history.at(-1).repaired = changed
      history.at(-1).cut = cut
      // merge + normalise; checkPlan renumbers scenes and claims after cuts
      const before = plan
      plan = checkPlan(plan, ev, config, { styleBible }).value
      alignTrain(plan, ev)
      if (plan.scenes.length !== before.scenes.length) ctx.log(`  ${before.scenes.length - plan.scenes.length} scene(s) cut`)
      const recheck = plan.scenes.filter((sc) => changed.includes(sc._key))
      if (recheck.length) await runCheck(recheck, round)
      if (round === MAX_ROUNDS) history.push({ round, ...summary(plan, verdict, keyOf, sceneIssues), failing_scenes: failingScenes().map((s) => s.id) })
    }

    // outputs
    const claims = plan.claims.map((c) => {
      const v = verdict.get(keyOf(c)) || { status: 'unsupported', note: 'not checked', quote: '', flags: [], by: 'code' }
      return { id: c.id, scene_id: c.scene_id, kind: c.kind, text: c.text, source_ids: c.source_ids, status: v.status, note: v.note, quote: v.quote, flags: v.flags, by: v.by, round: v.round }
    })
    const scenes = plan.scenes.map((sc) => ({ scene_id: sc.id, issues: sceneIssues.get(sc._key) || [] })).filter((s) => s.issues.length)
    const remaining = failingScenes().map((s) => s.id)
    const passed = remaining.length === 0
    for (const sc of plan.scenes) delete sc._key
    for (const n of alignSites(plan, ev)) ctx.log(`  ${n}`) // a lit site never borrows the year card's date
    const tally = { supported: 0, partial: 0, unsupported: 0 }
    for (const c of claims) tally[c.status] = (tally[c.status] || 0) + 1
    const wordsAfter = plan.scenes.reduce((s, sc) => s + wordCount(sc.narration), 0)
    ctx.write('verify.json', { claims, scenes, rounds, passed, summary: { ...tally, claims: claims.length, failing_scenes: remaining, words_before: wordsBefore, words_after: wordsAfter }, history })
    const est = estimate(plan.scenes, limits(config))
    ctx.write('plan.verified.json', { ...plan, verification: { passed, rounds, ...tally, failing_scenes: remaining, words: wordsAfter, est_seconds: est.total } })
    ctx.log(`  ${claims.length} claims: ${tally.supported} supported, ${tally.partial} partial, ${tally.unsupported} unsupported; ${rounds} repair round(s); ${passed ? 'PASSED' : `NOT passed (${remaining.join(', ')})`}; ${wordsBefore} -> ${wordsAfter} words, ~${est.total} s`)
  },
}

function summary(plan, verdict, keyOf, sceneIssues) {
  const t = { supported: 0, partial: 0, unsupported: 0, flagged: 0, scene_issues: 0 }
  for (const c of plan.claims) {
    const v = verdict.get(keyOf(c))
    if (!v) continue
    t[v.status]++
    if (v.flags.length) t.flagged++
  }
  for (const sc of plan.scenes) t.scene_issues += blockingIssues(sceneIssues.get(sc._key)).length
  return t
}

/** One director call rewrites (or cuts) the failing scenes; merges into `plan` in place. */
async function repair(ctx, ev, plan, failing, verdict, keyOf, sceneIssues, round) {
  const claimsOf = (sc) => plan.claims.filter((c) => c.scene_id === sc.id)
  // word budget: repaired scenes share whatever the film is over (or may use a little of what is left)
  const L = limits(ctx.config)
  const total = plan.scenes.reduce((n, sc) => n + wordCount(sc.narration), 0)
  const failWords = failing.reduce((n, sc) => n + wordCount(sc.narration), 0) || 1
  const spare = L.maxWords - total
  const limitOf = new Map(failing.map((sc) => {
    const w0 = wordCount(sc.narration)
    return [sc.id, Math.max(8, spare < 0 ? w0 + Math.floor((spare * w0) / failWords) : Math.min(w0 + Math.floor((spare * w0) / failWords), Math.ceil(w0 * 1.1)))]
  }))
  const budget = `The film has ${total} words now; its limit is ${L.minWords}-${L.maxWords}. ${spare < 0 ? `It is ${-spare} words too long, so the repaired scenes must get shorter.` : 'Repairs must keep it within the limit.'} Each scene below shows its word limit.`
  const film = plan.scenes.map((sc) => `${sc.id} (${sc.kind}${sc.map?.train_to ? ` -> ${sc.map.train_to}` : ''}): ${stripPauses(sc.narration)}`).join('\n')
  const failingText = failing
    .map((sc) => {
      const lines = [`### ${sc.id} (${sc.kind}, ${wordCount(sc.narration)} words now; at most ${limitOf.get(sc.id)} words)`, `narration: "${sc.narration}"`, `on_screen: ${JSON.stringify(sc.on_screen)}`, `fact_ids: ${(sc.fact_ids || []).join(', ') || '-'}`]
      for (const c of claimsOf(sc)) {
        const v = verdict.get(keyOf(c)) || {}
        lines.push(`- claim "${c.text}" [${c.kind}${c.source_ids.length ? `; cites ${c.source_ids.join(', ')}` : ''}] -> ${v.status}${v.flags?.length ? ` (${v.flags.join(', ')})` : ''}: ${v.note || ''}`)
      }
      for (const i of blockingIssues(sceneIssues.get(sc._key))) lines.push(`- scene issue ${i.type}: "${i.text}" ${i.note || ''}`)
      return lines.join('\n')
    })
    .join('\n\n')
  const srcIds = uniq([...failing.flatMap((sc) => [...(sc.source_ids || []), ...claimsOf(sc).flatMap((c) => c.source_ids)]), ...sourcesFor(ev, { factIds: failing.flatMap((sc) => sc.fact_ids || []) })]).filter((id) => id !== RIDE_SOURCE)
  const user = prompt('repair.md', {
    round: String(round),
    persona: plan.style_bible?.narrator_persona || ctx.config.narrator?.persona || '',
    film,
    budget,
    failing: failingText,
    ride: ev.sources.get(RIDE_SOURCE).excerpt,
    facts: factsPack(ev),
    excerpts: excerptPack(ev, srcIds),
  })
  const ids = new Set(failing.map((s) => s.id))
  const res = await askChecked(
    ctx,
    { stage: 'verify', step: `repair-r${round}`, messages: [{ role: 'system', content: directorSystem(ctx.config) }, { role: 'user', content: user }], schema: repairSchema, name: 'submit_repairs', description: 'Submit the rewritten (or cut) scenes.' },
    (raw) => {
      const problems = []
      for (const r of raw?.scenes || []) {
        const sc = failing.find((s) => s.id === r.id)
        if (!sc) {
          problems.push(`scene ${r.id} was not in the list to repair; return only ${[...ids].join(', ')}`)
          continue
        }
        if (r.action === 'cut') {
          if (['title', 'end', 'personal'].includes(sc.kind)) problems.push(`${r.id} is a ${sc.kind} scene and cannot be cut; rewrite it`)
          continue
        }
        const w0 = wordCount(sc.narration)
        const w1 = wordCount(r.narration)
        if (w1 > limitOf.get(r.id) + 1) problems.push(`${r.id}: rewrite has ${w1} words; the limit for this scene is ${limitOf.get(r.id)}`)
        else if (w1 < w0 * 0.6) problems.push(`${r.id}: rewrite has ${w1} words, far shorter than ${w0}; keep the scene's substance`)
        for (const c of r.claims || []) {
          if (c.kind !== 'personal' && !(c.source_ids || []).some((s) => ev.sources.has(s))) problems.push(`${r.id}: claim "${c.text}" cites no source id from the evidence`)
        }
        if (/https?:\/\/|www\./i.test(r.narration || '')) problems.push(`${r.id}: narration contains a URL`)
      }
      for (const id of ids) if (!(raw?.scenes || []).some((r) => r.id === id)) problems.push(`no repair returned for ${id}`)
      return { value: raw, problems }
    },
  )
  const changed = []
  const cut = []
  for (const r of res.value?.scenes || []) {
    const sc = plan.scenes.find((s) => s.id === r.id)
    if (!sc || !ids.has(r.id)) continue
    if (r.action === 'cut' && !['title', 'end', 'personal'].includes(sc.kind)) {
      cut.push(sc._key)
      plan.scenes = plan.scenes.filter((s) => s !== sc)
      plan.claims = plan.claims.filter((c) => c.scene_id !== sc.id)
      continue
    }
    if (!String(r.narration || '').trim()) continue
    sc.narration = r.narration
    if (r.on_screen?.headline !== undefined) sc.on_screen = { ...sc.on_screen, headline: r.on_screen.headline, year: r.on_screen.year ?? sc.on_screen?.year ?? '' }
    if (Array.isArray(r.fact_ids)) sc.fact_ids = r.fact_ids
    sc.source_ids = Array.isArray(r.source_ids) ? r.source_ids : []
    plan.claims = plan.claims.filter((c) => c.scene_id !== sc.id).concat((r.claims || []).map((c) => ({ scene_id: sc.id, text: c.text, kind: c.kind, source_ids: c.source_ids || [] })))
    changed.push(sc._key)
    ctx.log(`    ${sc.id}: ${r.note || 'rewritten'}`)
  }
  return { changed, cut }
}
