/**
 * Leaderboard, promote-review, and backtest sub-commands for `bun llm pro`.
 * (km-bearly.llm-dual-pro-shadow-test)
 */

import { ask } from "../lib/research"
import { getModel, type Model, type ModelResponse } from "../lib/types"
import { emitJson, isJsonMode } from "../lib/output-mode"
import type { LeaderboardRow } from "../lib/dual-pro"
import { confirmOrExit, promptChoice } from "../ui/confirm"
import { formatCostColumns } from "../lib/format"
import { resolveCostForModel } from "../lib/pricing"
import { aggregateCosts } from "../lib/cost"

/**
 * `bun llm pro --leaderboard` — print the current ranked leaderboard from
 * ab-pro.jsonl. **Default sort is by raw quality (judge score)** — we
 * optimize for raw intellect; cost surfaces as a column for context. Use
 * `--rank-by-cost` to sort by cost-aware rank (quality minus log-cost
 * penalty above $0.10). Speed and failure rate display only.
 */
export async function runLeaderboard(opts: { rankByCost?: boolean } = {}): Promise<void> {
  const dualPro = await import("../lib/dual-pro")
  const cfg = await dualPro.loadConfig()
  const entries = await dualPro.readAbProLog()
  if (entries.length === 0) {
    console.error("No ab-pro.jsonl entries yet. Run `bun llm pro <question>` to start collecting data.")
    if (isJsonMode()) emitJson({ rows: [], status: "empty" })
    return
  }
  const rows = dualPro.buildLeaderboard(entries, cfg.scoreWeights)
  if (!opts.rankByCost) {
    rows.sort((x, y) => y.avgScore - x.avgScore || y.calls - x.calls)
  }
  const QUALITY_WARNING_MIN_CALLS = 20
  const qualityThreshold = cfg.scoreWeights.qualityWarningThreshold
  const isQualityWarning = (r: LeaderboardRow) => r.calls >= QUALITY_WARNING_MIN_CALLS && r.avgScore < qualityThreshold
  const warnings = rows.filter(isQualityWarning)

  if (isJsonMode()) {
    emitJson({
      rows: rows.map((r) => ({ ...r, qualityWarning: isQualityWarning(r) })),
      status: "ok",
      weights: cfg.scoreWeights,
      mode: opts.rankByCost ? "rank-by-cost" : "by-quality",
      total: entries.length,
      qualityWarnings: warnings.map((r) => r.model),
      exclude: cfg.exclude,
    })
    return
  }
  const fmtPct = (n: number) => `${(n * 100).toFixed(0)}%`
  const fmtMs = (n: number) => `${(n / 1000).toFixed(1)}s`
  const fmtScore = (n: number | undefined) => (n === undefined ? "unknown" : n.toFixed(2))
  const fmtCost = (n: number | undefined) => (n === undefined ? "unknown" : `$${n.toFixed(3)}`)
  const headerNote = opts.rankByCost
    ? `sorted by Rank (quality − log-cost penalty above $${cfg.scoreWeights.costThreshold.toFixed(2)})`
    : `sorted by Quality — raw intellect (use --rank-by-cost for cost-aware sort)`
  console.error(`\nLeaderboard (${entries.length} runs, ${headerNote})\n`)
  console.error(
    `${"Model".padEnd(36)} ${"Calls".padStart(6)} ${"Quality".padStart(9)} ${"FailRate".padStart(9)} ${"Charged".padStart(9)} ${"List-equiv".padStart(10)} ${"Speed".padStart(8)} ${"Rank".padStart(7)}`,
  )
  console.error("-".repeat(92))
  for (const r of rows) {
    const flagged = isQualityWarning(r)
    const prefix = flagged ? "⚠️ " : ""
    const modelCell = `${prefix}${r.model}`
    console.error(
      `${modelCell.padEnd(36)} ${String(r.calls).padStart(6)} ${fmtScore(r.avgScore).padStart(9)} ${fmtPct(r.failureRate).padStart(9)} ${fmtCost(r.average.cost_usd).padStart(9)} ${fmtCost(r.average.list_equivalent_usd).padStart(10)} ${fmtMs(r.avgTimeMs).padStart(8)} ${fmtScore(r.rankScore).padStart(7)}`,
    )
    console.error(
      `  Mean per invoked opinion: ${formatCostColumns(r.average)}; charged coverage ${r.costCoverage.charged.known}/${r.costCoverage.charged.total}; list-equivalent coverage ${r.costCoverage.listEquivalent.known}/${r.costCoverage.listEquivalent.total}; cost ranking ${r.costRanking}`,
    )
  }
  if (warnings.length > 0) {
    const ids = warnings.map((r) => `"${r.model}"`).join(", ")
    console.error(
      `\n⚠️  rows = quality below ${qualityThreshold.toFixed(1)} (≥${QUALITY_WARNING_MIN_CALLS} calls). Consider adding to exclude: [${ids}] in dual-pro-config.json`,
    )
  }
  console.error("")
}

/**
 * `bun llm pro --promote-review` — show leaderboard, surface 3 sample
 * queries where models diverged most, then prompt:
 *   [P]romote / [W]atch / [D]emote / [C]ancel
 *
 * Decision is recorded to dual-pro-promotions.jsonl. We do NOT actually
 * rewrite dual-pro-config.json automatically yet — the user is expected
 * to edit the file manually after the prompt confirms intent. Auto-rewrite
 * is a one-line follow-up but the manual step keeps every promotion
 * traceable to a literal git diff in the project.
 */
export async function runPromoteReview(opts: { skipConfirm?: boolean } = {}): Promise<void> {
  const dualPro = await import("../lib/dual-pro")
  const cfg = await dualPro.loadConfig()
  const entries = await dualPro.readAbProLog()
  const rows = dualPro.buildLeaderboard(entries, cfg.scoreWeights)
  await runLeaderboard()
  const verdict = dualPro.evaluatePromotion(rows, cfg.mainstays[0], cfg.splitTestPool)
  console.error(`Verdict: ${verdict.reason}`)
  if (!verdict.shouldOfferPromotion) {
    if (isJsonMode()) emitJson({ status: "no-action", reason: verdict.reason, leaderboard: rows.slice(0, 10) })
    return
  }
  const divergent = entries
    .filter((e) => e.a?.score?.total != null && e.c?.score?.total != null && e.a.score.total !== e.c.score.total)
    .slice(-3)
  console.error(`\nDivergent samples (judge winner / scores):`)
  for (const e of divergent) {
    const aT = e.a?.score?.total ?? "?"
    const bT = e.b?.score?.total ?? "?"
    const cT = e.c?.score?.total ?? "?"
    console.error(`  • ${(e.question ?? "").slice(0, 70)}  (a=${aT}, b=${bT}, c=${cT})`)
  }
  if (isJsonMode()) {
    emitJson({
      status: "offer",
      verdict: {
        challenger: verdict.challenger,
        champion: verdict.champion,
        reason: verdict.reason,
      },
      leaderboard: rows.slice(0, 10),
      divergentSamples: divergent.length,
    })
    return
  }
  if (opts.skipConfirm) {
    console.error("\n(--yes set; recording 'keep-watching' decision and exiting without changes.)")
    await dualPro.appendPromotionDecision({
      oldChampion: cfg.mainstays[0],
      oldRunnerUp: cfg.mainstays[1],
      decision: "keep-watching",
      reasoning: "auto-yes — no interactive confirmation",
      challenger: verdict.challenger,
    })
    return
  }
  const choice = await promptChoice(
    `\nPromote ${verdict.challenger?.model} to champion? [P]romote / [W]atch / [D]emote (promote-and-demote runner) / [C]ancel: `,
    ["p", "w", "d", "c"],
  )
  const decisionMap: Record<string, "promote" | "promote-and-demote" | "keep-watching" | "cancel"> = {
    p: "promote",
    d: "promote-and-demote",
    w: "keep-watching",
    c: "cancel",
  }
  const decision = decisionMap[choice]!
  await dualPro.appendPromotionDecision({
    oldChampion: cfg.mainstays[0],
    oldRunnerUp: cfg.mainstays[1],
    newChampion: decision === "promote" || decision === "promote-and-demote" ? verdict.challenger?.model : undefined,
    newRunnerUp: decision === "promote-and-demote" ? cfg.mainstays[0] : undefined,
    decision,
    reasoning: verdict.reason,
    challenger: verdict.challenger,
  })
  if (decision === "promote" || decision === "promote-and-demote") {
    console.error(
      `\nDecision recorded. Edit ${dualPro.getMemoryDir()}/dual-pro-config.json to apply (champion: "${verdict.challenger?.model}").`,
    )
  } else {
    console.error(`\nDecision recorded: ${decision}.`)
  }
}

/**
 * `bun llm pro --backtest` — sample N queries from ab-pro.jsonl, re-fire
 * each through OLD config (current champ/runner) AND NEW config (proposed),
 * judge with the same model, and compare scores.
 */
export async function runBacktest(opts: {
  sample?: number
  quick?: boolean
  noOldFire?: boolean
  noChallenger?: boolean
  challengerOverride?: string
  skipConfirm?: boolean
}): Promise<void> {
  const dualPro = await import("../lib/dual-pro")
  const cfg = await dualPro.loadConfig()
  const entries = await dualPro.readAbProLog()
  const sampleSize = opts.sample ?? (opts.quick ? 5 : 30)
  const sample = dualPro.sampleBacktestEntries(entries, { size: sampleSize })

  if (sample.length === 0) {
    console.error("No ab-pro.jsonl entries available for backtest. Run `bun llm pro <q>` first.")
    if (isJsonMode()) emitJson({ status: "empty", report: undefined })
    return
  }

  const champion = getModel(cfg.mainstays[0])
  const runner = getModel(cfg.mainstays[1])
  const challengerId = opts.challengerOverride ?? cfg.splitTestPool[0]
  const challenger = opts.noChallenger ? undefined : challengerId ? getModel(challengerId) : undefined
  const judgeModel = getModel(opts.quick ? "gpt-5-nano" : cfg.judge) ?? getModel("gpt-5-mini")
  const opinionModels = [...(opts.noOldFire ? [] : [champion, runner]), champion, runner, challenger].filter(
    (model) => model !== undefined,
  )
  const planned = opinionModels.map((model) => ({ model, input: 1500, output: 1500 }))
  if (judgeModel) {
    for (let i = 0; i < (opts.noOldFire ? 1 : 2); i++) {
      planned.push({ model: judgeModel, input: 4000, output: 800 })
    }
  }
  const estimates = planned.map(({ model, input, output }) =>
    resolveCostForModel(model, {
      input: input * sample.length,
      output: output * sample.length,
    }),
  )
  const forecast = aggregateCosts(estimates)
  forecast.charged = { reason: "forecast; no call dispatched" }
  const unpriced = planned.filter((_, i) => "reason" in estimates[i]!.listEquivalent)
  if (unpriced.length) {
    forecast.listEquivalent = {
      reason: `rates unavailable for ${unpriced.map((call) => call.model.displayName).join(", ")}`,
    }
  }
  const totalEst = "usd" in forecast.listEquivalent ? forecast.listEquivalent.usd : undefined

  console.error(
    `\nBacktest: ${sample.length} queries, judge=${judgeModel?.displayName ?? cfg.judge}${opts.quick ? " (quick)" : ""}${opts.noOldFire ? ", NEW-only" : ", OLD+NEW"}`,
  )
  console.error(
    `Forecast at 1500 input/1500 output tokens per opinion and 4000/800 per judge: ${formatCostColumns(forecast)}`,
  )

  if (totalEst !== undefined && totalEst > 50) {
    await confirmOrExit(`⚠️  Estimated cost exceeds $50. Proceed? [Y/n] `, !!opts.skipConfirm)
  }

  const perQueryResults: import("../lib/dual-pro").BacktestPerQueryResult[] = []
  let i = 0
  for (const entry of sample) {
    i++
    const q = entry.question ?? ""
    if (!q) continue
    console.error(`  [${i}/${sample.length}] ${q.slice(0, 60)}...`)

    let oldA, oldB, newA, newB, newC
    const oldCalls: ModelResponse[] = []
    const newCalls: ModelResponse[] = []
    const fire = async (prompt: string, model: Model, calls: ModelResponse[], level: "standard" | "quick") => {
      const started = Date.now()
      try {
        const response = await ask(prompt, level, { modelOverride: model.modelId, stream: false })
        calls.push(response)
        return response
      } catch (error) {
        calls.push({
          model,
          content: "",
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }
    try {
      if (!opts.noOldFire) {
        if (champion) oldA = await fire(q, champion, oldCalls, "standard")
        if (runner) oldB = await fire(q, runner, oldCalls, "standard")
      }
      if (champion) newA = await fire(q, champion, newCalls, "standard")
      if (runner) newB = await fire(q, runner, newCalls, "standard")
      if (challenger) newC = await fire(q, challenger, newCalls, "standard")
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error(`    skip scoring — fire failed: ${error}; invoked-call receipts retained`)
      perQueryResults.push({ question: q, oldCalls, newCalls, error })
      continue
    }

    const judgeFor = async (
      responses: { id: "a" | "b" | "c"; model: string; content: string }[],
      calls: ModelResponse[],
    ) => {
      if (!judgeModel || responses.length === 0) return undefined
      const prompt = dualPro.buildJudgePrompt({ question: q, responses, rubric: cfg.rubric })
      try {
        const r = await fire(prompt, judgeModel, calls, "quick")
        const parsed = dualPro.parseJudgeResponse(r.content)
        if (!parsed) {
          console.error(`    backtest judge ${judgeModel.modelId} returned unparseable scores; receipt retained`)
        }
        return parsed
      } catch (error) {
        console.error(
          `    backtest judge ${judgeModel.modelId} failed: ${error instanceof Error ? error.message : String(error)}; receipt retained`,
        )
        return undefined
      }
    }

    const oldResponses: { id: "a" | "b" | "c"; model: string; content: string }[] = []
    if (oldA?.content) oldResponses.push({ id: "a", model: oldA.model.displayName, content: oldA.content })
    if (oldB?.content) oldResponses.push({ id: "b", model: oldB.model.displayName, content: oldB.content })
    const newResponses: { id: "a" | "b" | "c"; model: string; content: string }[] = []
    if (newA?.content) newResponses.push({ id: "a", model: newA.model.displayName, content: newA.content })
    if (newB?.content) newResponses.push({ id: "b", model: newB.model.displayName, content: newB.content })
    if (newC?.content && challenger) {
      newResponses.push({ id: "c", model: challenger.displayName, content: newC.content })
    }

    const oldJudge = opts.noOldFire ? undefined : await judgeFor(oldResponses, oldCalls)
    const newJudge = await judgeFor(newResponses, newCalls)

    const bestTotal = (j?: import("../lib/dual-pro").JudgeResult) => {
      if (!j) return undefined
      return Math.max(j.a?.total ?? 0, j.b?.total ?? 0, j.c?.total ?? 0)
    }
    let oldTotal: number | undefined = bestTotal(oldJudge)
    if (oldTotal === undefined && opts.noOldFire) {
      oldTotal = Math.max(entry.a?.score?.total ?? 0, entry.b?.score?.total ?? 0)
    }
    perQueryResults.push({
      question: q,
      oldCalls,
      newCalls,
      oldWinner: oldJudge?.winner,
      newWinner: newJudge?.winner,
      oldTotal,
      newTotal: bestTotal(newJudge),
    })
  }

  const report = dualPro.aggregateBacktest(perQueryResults)
  await dualPro.appendBacktestRun({
    oldConfig: { mainstays: [...cfg.mainstays] as [string, string] },
    newConfig: { splitTestPool: [challengerId ?? ""].filter(Boolean) },
    report,
    decision: "deferred",
    noOldFire: !!opts.noOldFire,
    quick: !!opts.quick,
  })

  if (isJsonMode()) {
    emitJson({ status: "ok", report })
  } else {
    console.error("")
    console.error(dualPro.formatBacktestReport(report))
  }
}
