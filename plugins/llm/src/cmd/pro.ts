/**
 * Run dual-pro mode — 2+2 fleet (4 legs in parallel) with pairwise judge.
 *
 * Flow:
 *   - Leg A (mainstay 1): frontier reasoning anchor — stable across calls
 *   - Leg B (mainstay 2): proven cheap baseline — stable across calls
 *   - Leg C (split-test slot 1): rotates through `splitTestPool`
 *   - Leg D (split-test slot 2): correlated re-test — re-faces most-recent
 *     winner from history (cold start: round-robin offset by 1 from slot C)
 *
 * After all 4 respond, three cheap pairwise judge calls run in parallel:
 *   - judge AB: B vs A on the rubric
 *   - judge AC: C vs A on the rubric
 *   - judge AD: D vs A on the rubric
 *
 * Pairwise judging (vs. a single 4-way prompt) sidesteps position bias and
 * context-saturation that materially degrade N-way judge accuracy. With
 * Gemini 2.5 Flash judge at ~$0.001/call, 3 pairwise calls (~$0.003) is
 * usually cheaper than one bloated 4-way prompt that would need more
 * tokens to fit four responses anyway.
 *
 * Cost sliders:
 *   --legs N         : cap legs (2 = mainstays only, 3 = +slot C, 4 = full)
 *   --no-challenger  : alias for --legs 2
 *   --challenger <id>: explicit slot C override (skips slot D unless --legs 4)
 *   --no-judge       : skip judge calls (saves ~$0.003; loses scoring)
 *
 * A/B log lives at ~/.claude/projects/<project>/memory/ab-pro.jsonl. Each
 * line records the prompt, every leg's cost/duration/length/score, judge
 * model, pairwise judge results (ab/ac/ad), and a synthesized "winner"
 * field for back-compat with v2 readers.
 *
 * Auto-falls-back to single-model `askAndFinish` if a mainstay provider is
 * unavailable.
 */

import { ask } from "../lib/research"
import { isProviderAvailable, getProviderEnvVar } from "../lib/providers"
import { estimateCost, formatCost, getModel, type Model, type ModelMode } from "../lib/types"
import { withSignalAbort } from "../lib/signals"
import { confirmOrExit } from "../ui/confirm"
import { askAndFinish } from "./ask"

export async function runProDual(options: {
  question: string
  modelOverride: Model | undefined
  imagePath: string | undefined
  streamToken: (token: string) => void
  buildContext: (topic: string) => Promise<string | undefined>
  outputFile: string
  sessionTag: string
  skipConfirm: boolean
  challengerOverride?: string
  noChallenger?: boolean
  noJudge?: boolean
  /** Cap the number of legs that fire (2 = mainstays only, 3 = mainstays + slot C,
   * 4 = full 2+2 fleet). Defaults to `splitTestSlots + 2` from config. */
  legs?: number
  /** Extra model IDs to exclude from split-test rotation for THIS call only.
   * Joins (union) with the persistent `exclude` list in dual-pro-config.json. */
  extraExclude?: readonly string[]
}): Promise<void> {
  const { question, modelOverride, imagePath, buildContext, outputFile, sessionTag, skipConfirm } = options
  const { finalizeOutput } = await import("../lib/format")
  const dualPro = await import("../lib/dual-pro")

  // Explicit --model override bypasses dual mode entirely.
  if (modelOverride) {
    await askAndFinish({
      question,
      modelMode: "pro" as ModelMode,
      level: "standard",
      header: (name) => `[${name} - pro mode]`,
      modelOverride,
      imagePath,
      streamToken: options.streamToken,
      buildContext,
      outputFile,
      sessionTag,
    })
    return
  }

  // Load fleet config (file + env overrides). Legacy env LLM_DUAL_PRO_B and
  // LLM_CHALLENGER_POOL still work — applyEnvOverrides preserves them.
  const cfg = await dualPro.loadConfig()
  const [mainstay0Id, mainstay1Id] = cfg.mainstays
  const mainstay0 = getModel(mainstay0Id)
  const mainstay1 = getModel(mainstay1Id)
  const m0Available = mainstay0 && isProviderAvailable(mainstay0.provider)
  const m1Available = mainstay1 && isProviderAvailable(mainstay1.provider)

  // Effective exclude = persistent config + this-call --exclude flag (union).
  const effectiveExclude =
    options.extraExclude && options.extraExclude.length > 0
      ? Array.from(new Set([...cfg.exclude, ...options.extraExclude]))
      : cfg.exclude

  // Mainstays listed in `exclude` log a warning but still dispatch — explicit
  // config wins over implicit exclude. Stale leaderboard data shouldn't
  // silently drop a model the user pinned.
  for (const id of cfg.mainstays) {
    if (effectiveExclude.includes(id)) {
      console.error(`⚠️  excluded model "${id}" is set as a mainstay — dispatching anyway. Fix dual-pro-config.json.`)
    }
  }

  // Decide leg cap: --no-challenger forces 2; --legs N caps explicitly;
  // otherwise default = 2 (mainstays) + cfg.splitTestSlots.
  const defaultLegCap = 2 + cfg.splitTestSlots
  const requestedLegs = options.noChallenger ? 2 : (options.legs ?? defaultLegCap)
  const legCap = Math.max(2, Math.min(4, Math.floor(requestedLegs)))

  // Resolve split-test slots. Slot C honors --challenger override; slot D is
  // always picked via correlated re-test (most-recent winner reproducer).
  let slotC: Model | undefined
  let slotD: Model | undefined
  let nextCounter = 0
  if (legCap >= 3) {
    const counter = await dualPro.readChallengerCounter()
    if (options.challengerOverride) {
      slotC = getModel(options.challengerOverride)
      // --challenger always means "slot C only" — slot D is skipped to honor
      // the user's explicit pick. Pump the counter so the next non-override
      // call doesn't replay the same rotation slot.
      nextCounter = counter + 1
    } else {
      const filteredPool = dualPro.filterPoolByCapability(
        cfg.splitTestPool.filter((id) => !cfg.mainstays.includes(id)),
        [],
      )
      // Build winner history for the correlated re-test (slot D).
      const priorEntries = await dualPro.readAbProLog()
      const winnerHistory = priorEntries
        .map((e) => {
          const w = e.judge?.winner
          if (!w || w === "tie") return undefined
          const leg = w === "a" ? e.a : w === "b" ? e.b : w === "c" ? e.c : w === "d" ? e.d : undefined
          return leg?.model ? { winnerModelId: leg.model } : undefined
        })
        .filter((x): x is { winnerModelId: string } => !!x)
      if (legCap >= 4) {
        const picked = dualPro.pickSplitTestSlots(
          filteredPool,
          cfg.splitTestStrategy,
          counter,
          winnerHistory,
          cfg.mainstays,
          effectiveExclude,
        )
        slotC = getModel(picked.slotC ?? "")
        slotD = getModel(picked.slotD ?? "")
        nextCounter = picked.nextCounter
      } else {
        const picked = dualPro.pickNextChallenger(filteredPool, cfg.splitTestStrategy, counter, effectiveExclude)
        slotC = getModel(picked.modelId ?? "")
        nextCounter = picked.nextCounter
      }
    }
  }

  // Fall back to single-model mode if we can't run both mainstays.
  if (!m0Available || !m1Available) {
    const missing = !m0Available
      ? !mainstay0
        ? `unknown model "${mainstay0Id}"`
        : `provider key for ${mainstay0.provider}`
      : !mainstay1
        ? `unknown model "${mainstay1Id}"`
        : `provider key for ${mainstay1.provider}`
    console.error(`⚠️  Dual-pro unavailable (${missing}) — falling back to single model\n`)
    await askAndFinish({
      question,
      modelMode: "pro" as ModelMode,
      level: "standard",
      header: (name) => `[${name} - pro mode]`,
      modelOverride: undefined,
      imagePath,
      streamToken: options.streamToken,
      buildContext,
      outputFile,
      sessionTag,
    })
    return
  }

  const context = await buildContext(question)
  const enrichedQuestion = context ? `${context}\n\n---\n\n${question}` : question
  if (context) console.error(`📎 Context provided (${context.length} chars)\n`)

  // Build the slot/leg list. Always 2 mainstays; up to 2 split-test slots.
  type LegSlot = { id: "a" | "b" | "c" | "d"; role: "mainstay" | "split-test"; model: Model }
  const legSlots: LegSlot[] = [
    { id: "a", role: "mainstay", model: mainstay0! },
    { id: "b", role: "mainstay", model: mainstay1! },
  ]
  if (slotC && legCap >= 3) legSlots.push({ id: "c", role: "split-test", model: slotC })
  if (slotD && legCap >= 4) legSlots.push({ id: "d", role: "split-test", model: slotD })

  const fleetLabel = legSlots
    .map((s) => `${s.model.displayName}${s.role === "split-test" ? " [split-test]" : ""}`)
    .join(" + ")
  console.error(`[dual-pro] Querying ${legSlots.length} legs in parallel: ${fleetLabel}...`)
  // Cost estimate — mainstays drive most of the bill. Per-leg cap is
  // ~$5-15 for Pro-tier; cheap baselines (kimi-k2.6) are $0.01-0.05.
  const proLegCount = legSlots.filter((s) => s.model.costTier === "very-high").length
  const totalEstStr = proLegCount >= 2 ? `~$${5 * proLegCount}-${15 * proLegCount}` : `~$5-15`
  console.error(`  • Estimated cost: ${totalEstStr} (${proLegCount} Pro-tier legs of ${legSlots.length})`)
  // Surface dynamic-thinking budgets for any leg that uses them.
  for (const s of legSlots) {
    if (s.model.reasoning?.contextWindow || s.model.reasoning?.maxOutputTokens) {
      const cap = s.model.reasoning?.contextWindow
        ? `dynamic (up to ~${s.model.reasoning.contextWindow - 4096} tokens, scales with input)`
        : `${s.model.reasoning?.maxOutputTokens} tokens (static)`
      console.error(`  • ${s.model.displayName} output budget: ${cap}`)
    }
  }
  console.error("")

  // Cost confirmation — a multi-dollar call deserves a Y/n gate. Pre-existing
  // 2026-04-20 double-fire-class bugs made silent billing mistakes worse than
  // they otherwise would be; this is the explicit-opt-in backstop.
  const tierLabel = proLegCount >= 2 ? `${proLegCount} Pro-tier legs` : "mostly mainstays"
  await confirmOrExit(`⚠️  Dual-pro costs ${totalEstStr} (${tierLabel}). Proceed? [Y/n] `, skipConfirm)

  const { queryOpenAIBackground, isOpenAIBackgroundCapable } = await import("../lib/openai-deep")

  // Route OpenAI Pro legs through the Responses API so they're recoverable:
  // a 30+ min Pro call that gets SIGINT / network-hiccup / wall-clock killed
  // still persists its responseId, and `bun llm recover <id>` reattaches to
  // the server-side work. Non-OpenAI legs stay on generateText (if aborted,
  // work is lost — acceptable given ~30s typical runtime).
  //
  // imagePath disables the background path — the Responses-API background
  // helper is text-only today, and silently dropping the image would be worse
  // than losing recoverability for the rare image+pro case.
  const dispatchOne = (m: Model, ac: AbortController) => {
    const useBackground = isOpenAIBackgroundCapable(m) && !imagePath
    return useBackground
      ? queryOpenAIBackground({
          prompt: enrichedQuestion,
          model: m,
          topic: question,
          abortSignal: ac.signal,
        })
      : ask(enrichedQuestion, "standard", {
          modelOverride: m.modelId,
          stream: false,
          imagePath,
          abortSignal: ac.signal,
        })
  }

  // Fire ALL legs in parallel — single round trip, timing dominated by the
  // slowest leg. Streaming disabled (multi-stream interleave unreadable).
  const settledResults = await withSignalAbort(async (outerSignal) => {
    const ac = new AbortController()
    const onOuterAbort = () => ac.abort(outerSignal.reason ?? "aborted")
    if (outerSignal.aborted) onOuterAbort()
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true })
    try {
      const calls = legSlots.map((s) => dispatchOne(s.model, ac))
      return await Promise.allSettled(calls)
    } finally {
      outerSignal.removeEventListener("abort", onOuterAbort)
    }
  })

  // Normalize each leg to (ok, error). "Success" requires non-empty trimmed
  // content AND no error — a fulfilled promise with empty content
  // (reasoning-exhaustion, abort, API quirks) is a failure, not a silent
  // success.
  type LegOutcome = LegSlot & {
    response?: import("../lib/types").ModelResponse
    error?: string
    ok: boolean
  }
  const legOutcomes: LegOutcome[] = legSlots.map((slot, i) => {
    const settled = settledResults[i]!
    const response = settled.status === "fulfilled" ? settled.value : undefined
    const errRaw = settled.status === "rejected" ? String(settled.reason) : response?.error
    const ok = !errRaw && !!response?.content && response.content.trim().length > 0
    const error = errRaw ?? (response && !ok ? "empty content" : undefined)
    return { ...slot, response, error, ok }
  })

  for (const leg of legOutcomes) {
    const tag = leg.role === "split-test" ? " [split-test]" : ""
    if (leg.ok && leg.response) {
      console.error(
        `  ✓ ${leg.model.displayName}${tag} (${leg.response.usage?.totalTokens ?? 0} tok, ${Math.round(leg.response.durationMs / 1000)}s)`,
      )
    } else {
      console.error(`  ✗ ${leg.model.displayName}${tag}: ${leg.error ?? "unknown failure"}`)
    }
  }

  // Persist the rotation counter only after all legs returned — guarantees a
  // SIGINT'd dispatch doesn't burn a slot rotation.
  if (legCap >= 3 && !options.challengerOverride && nextCounter > 0) {
    try {
      await dualPro.writeChallengerCounter(nextCounter)
    } catch {
      // best-effort; counter drift is benign.
    }
  }

  // Convenience aliases for the report builder (so we don't have to thread
  // legOutcomes through everything).
  const legA = legOutcomes[0]!
  const legB = legOutcomes[1]!
  const legC = legOutcomes.find((l) => l.id === "c")
  const legD = legOutcomes.find((l) => l.id === "d")

  // Per-leg cost — failed legs cost zero (no usage payload).
  const costForLeg = (l: LegOutcome) =>
    l.response?.usage ? estimateCost(l.model, l.response.usage.promptTokens, l.response.usage.completionTokens) : 0
  const legCosts = new Map<string, number>(legOutcomes.map((l) => [l.id, costForLeg(l)]))
  const totalLegCost = Array.from(legCosts.values()).reduce((s, c) => s + c, 0)

  // Pairwise judge — three cheap calls in parallel (B-vs-A, C-vs-A, D-vs-A).
  // Each pair sends only TWO responses to the judge — sidesteps N-way
  // position bias and context dilution. With Gemini 2.5 Flash at ~$0.001/call
  // this costs ~$0.003 total, often cheaper than one bloated 4-way prompt.
  type PairwiseLog = {
    ab?: import("../lib/dual-pro").PairwiseJudgeResult
    ac?: import("../lib/dual-pro").PairwiseJudgeResult
    ad?: import("../lib/dual-pro").PairwiseJudgeResult
  }
  const pairwise: PairwiseLog = {}
  let judgeError: string | undefined
  let judgeCost = 0
  let judgeModelId: string | undefined
  const anyLegOk = legOutcomes.some((l) => l.ok)
  if (!options.noJudge && anyLegOk && legA.ok) {
    const judgeModel = getModel(cfg.judge)
    if (!judgeModel) {
      judgeError = `judge model "${cfg.judge}" not found in registry`
    } else if (!isProviderAvailable(judgeModel.provider)) {
      judgeError = `judge unavailable: ${getProviderEnvVar(judgeModel.provider)} not set`
    } else {
      judgeModelId = judgeModel.modelId
      const pairs: { id: "ab" | "ac" | "ad"; contender: LegOutcome }[] = []
      if (legB.ok) pairs.push({ id: "ab", contender: legB })
      if (legC?.ok) pairs.push({ id: "ac", contender: legC })
      if (legD?.ok) pairs.push({ id: "ad", contender: legD })
      console.error(`\n[dual-pro] Pairwise judging via ${judgeModel.displayName} (${pairs.length} pairs)...`)
      const judgeOnce = async (
        pairId: "ab" | "ac" | "ad",
        contender: LegOutcome,
      ): Promise<{
        id: typeof pairId
        result?: import("../lib/dual-pro").PairwiseJudgeResult
        cost: number
        error?: string
      }> => {
        const prompt = dualPro.buildPairwiseJudgePrompt({
          question,
          pair: {
            a: { model: legA.model.displayName, content: legA.response!.content },
            b: { model: contender.model.displayName, content: contender.response!.content },
          },
          rubric: cfg.rubric,
        })
        try {
          const raw = await ask(prompt, "quick", { modelOverride: judgeModel.modelId, stream: false })
          const cost = raw.usage ? estimateCost(judgeModel, raw.usage.promptTokens, raw.usage.completionTokens) : 0
          const result = raw.content ? dualPro.parsePairwiseJudgeResponse(raw.content) : undefined
          return { id: pairId, result, cost, error: result ? undefined : "unparseable" }
        } catch (e) {
          return { id: pairId, cost: 0, error: e instanceof Error ? e.message : String(e) }
        }
      }
      const settled = await Promise.all(pairs.map((p) => judgeOnce(p.id, p.contender)))
      for (const r of settled) {
        judgeCost += r.cost
        if (r.result) pairwise[r.id] = r.result
      }
      const failures = settled.filter((r) => !r.result)
      if (failures.length === settled.length && settled.length > 0) {
        judgeError = `all pairwise judges failed (${failures.map((f) => f.error).join("; ")})`
      } else if (failures.length > 0) {
        console.error(`  ⚠ ${failures.length}/${settled.length} pairwise judges failed`)
      }
    }
    if (judgeError) console.error(`  ⚠ judge unavailable: ${judgeError}`)
  } else if (!options.noJudge && !legA.ok) {
    judgeError = "judge skipped — anchor leg A failed"
  }

  // Synthesize an N-way `judge.{a,b,c,d,winner}` shape for v2 consumers
  // (leaderboard, judge-history, backtest). Pull leg-specific scores from
  // the AB/AC/AD pairs (each pair scored leg A on its own line — they should
  // agree but we average to reduce variance).
  const aScoreSamples = (
    [pairwise.ab?.scoreA, pairwise.ac?.scoreA, pairwise.ad?.scoreA].filter(
      Boolean,
    ) as import("../lib/dual-pro").JudgeBreakdown[]
  ).map((s) => s.total)
  const aTotal = aScoreSamples.length > 0 ? aScoreSamples.reduce((s, x) => s + x, 0) / aScoreSamples.length : undefined
  const judgeTotals: Record<"a" | "b" | "c" | "d", number | undefined> = {
    a: aTotal,
    b: pairwise.ab?.scoreB?.total,
    c: pairwise.ac?.scoreB?.total,
    d: pairwise.ad?.scoreB?.total,
  }
  const overallWinnerKey = (() => {
    const candidates: ("a" | "b" | "c" | "d")[] = ["a", "b", "c", "d"]
    const have = candidates.filter((k) => judgeTotals[k] != null)
    if (have.length === 0) return undefined
    let best = have[0]!
    for (const k of have) if ((judgeTotals[k] ?? 0) > (judgeTotals[best] ?? 0)) best = k
    // Tie if within 1 point of the runner-up.
    const others = have.filter((k) => k !== best).map((k) => judgeTotals[k] ?? 0)
    const second = others.length > 0 ? Math.max(...others) : -Infinity
    if ((judgeTotals[best] ?? 0) - second <= 1) return "tie" as const
    return best
  })()
  // Average breakdown for leg A (used by the v2 reader synthesis).
  const aScoreAvg: import("../lib/dual-pro").JudgeBreakdown | undefined = (() => {
    const samples = [pairwise.ab?.scoreA, pairwise.ac?.scoreA, pairwise.ad?.scoreA].filter(
      Boolean,
    ) as import("../lib/dual-pro").JudgeBreakdown[]
    if (samples.length === 0) return undefined
    const avg = (k: keyof import("../lib/dual-pro").JudgeBreakdown["scores"]) =>
      samples.reduce((s, x) => s + x.scores[k], 0) / samples.length
    return {
      scores: {
        specificity: avg("specificity"),
        actionability: avg("actionability"),
        correctness: avg("correctness"),
        depth: avg("depth"),
      },
      total: aTotal!,
    }
  })()

  const judgeResult: import("../lib/dual-pro").JudgeResult | undefined =
    overallWinnerKey != null
      ? {
          a: aScoreAvg ?? null,
          b: pairwise.ab?.scoreB ?? null,
          c: pairwise.ac?.scoreB ?? null,
          d: pairwise.ad?.scoreB ?? null,
          winner: overallWinnerKey,
          reasoning:
            overallWinnerKey === "tie"
              ? "pairwise totals within 1 point"
              : `${overallWinnerKey.toUpperCase()} highest pairwise total`,
        }
      : undefined

  // Build the combined markdown report. All responses presented side-by-side,
  // headers labelled so the reader can diff. Non-fatal errors surface inline
  // so the reader sees which model failed without digging through logs.
  const parts: string[] = []
  parts.push(`# Dual-Pro Response\n`)
  parts.push(`**Question**: ${question}\n`)
  parts.push(`**Models**: ${legOutcomes.map((l) => l.model.displayName).join(" + ")}`)
  const costBreakdown = legOutcomes.map((l) => formatCost(legCosts.get(l.id) ?? 0)).join(" + ")
  parts.push(`**Total cost**: ${formatCost(totalLegCost)} (${costBreakdown})\n`)

  for (let i = 0; i < legOutcomes.length; i++) {
    const leg = legOutcomes[i]!
    const tag = leg.role === "split-test" ? " [split-test]" : ""
    if (i === 0) parts.push(`---\n`)
    else parts.push(`\n---\n`)
    parts.push(`## ${leg.model.displayName}${tag}`)
    if (leg.ok && leg.response) {
      const cost = legCosts.get(leg.id) ?? 0
      const meta = `_${leg.response.usage?.totalTokens ?? 0} tokens · ${Math.round(leg.response.durationMs / 1000)}s · ${formatCost(cost)}_`
      parts.push(meta + "\n")
      parts.push(leg.response.content.trim())
    } else {
      parts.push(`⚠️  Failed: ${leg.error ?? "no content"}`)
    }
  }

  if (judgeResult) {
    parts.push(`\n---\n`)
    parts.push(`## Judge breakdown (${judgeModelId ?? cfg.judge})\n`)
    const fmtRow = (
      id: "a" | "b" | "c" | "d",
      label: string,
      breakdown: import("../lib/dual-pro").JudgeBreakdown | null | undefined,
    ) => {
      if (!breakdown) return `- **${id.toUpperCase()}** ${label}: skipped (failed)`
      const s = breakdown.scores
      return `- **${id.toUpperCase()}** ${label}: spec ${s.specificity.toFixed(1)}, action ${s.actionability.toFixed(1)}, correct ${s.correctness.toFixed(1)}, depth ${s.depth.toFixed(1)} → **total ${breakdown.total.toFixed(1)}**`
    }
    parts.push(fmtRow("a", legA.model.displayName, judgeResult.a))
    parts.push(fmtRow("b", legB.model.displayName, judgeResult.b))
    if (legC) parts.push(fmtRow("c", `${legC.model.displayName} [split-test]`, judgeResult.c ?? null))
    if (legD) parts.push(fmtRow("d", `${legD.model.displayName} [split-test]`, judgeResult.d ?? null))
    parts.push("")
    // Surface the pairwise outcomes so the reader can see what each judge
    // call actually decided (not just the synthesized N-way winner).
    if (pairwise.ab)
      parts.push(`- **AB**: ${pairwise.ab.winner}${pairwise.ab.reasoning ? ` — ${pairwise.ab.reasoning}` : ""}`)
    if (pairwise.ac)
      parts.push(`- **AC**: ${pairwise.ac.winner}${pairwise.ac.reasoning ? ` — ${pairwise.ac.reasoning}` : ""}`)
    if (pairwise.ad)
      parts.push(`- **AD**: ${pairwise.ad.winner}${pairwise.ad.reasoning ? ` — ${pairwise.ad.reasoning}` : ""}`)
    parts.push(
      `\n**Overall winner**: ${judgeResult.winner.toUpperCase()}${judgeResult.reasoning ? ` — ${judgeResult.reasoning}` : ""}`,
    )
  } else if (judgeError) {
    parts.push(`\n---\n`)
    parts.push(`_Judge unavailable: ${judgeError}_`)
  }

  const combined = parts.join("\n")

  // Dual-pro envelope ships per-leg sections so skill consumers can branch
  // on which leg produced what without re-parsing the combined report.
  type EnvelopeLeg = {
    model: string
    tokens?: { prompt: number; completion: number; total: number }
    cost: number
    durationMs?: number
    status: "completed" | "failed"
    error?: string
  }
  const envelopeLeg = (leg: LegOutcome): EnvelopeLeg => ({
    model: leg.model.displayName,
    tokens: leg.response?.usage
      ? {
          prompt: leg.response.usage.promptTokens,
          completion: leg.response.usage.completionTokens,
          total: leg.response.usage.totalTokens,
        }
      : undefined,
    cost: legCosts.get(leg.id) ?? 0,
    durationMs: leg.response?.durationMs,
    status: leg.ok ? "completed" : "failed",
    error: leg.error,
  })
  const aLeg = envelopeLeg(legA)
  const bLeg = envelopeLeg(legB)
  const cLegEnv = legC ? envelopeLeg(legC) : undefined
  const dLegEnv = legD ? envelopeLeg(legD) : undefined

  // Combine prompt/completion totals across legs so the top-level `tokens`
  // is the canonical {prompt, completion, total} shape (mirrors single-model
  // emission). Total cost stays a single USD number.
  const combinedTokens = legOutcomes.some((l) => l.response?.usage)
    ? {
        prompt: legOutcomes.reduce((s, l) => s + (l.response?.usage?.promptTokens ?? 0), 0),
        completion: legOutcomes.reduce((s, l) => s + (l.response?.usage?.completionTokens ?? 0), 0),
        total: legOutcomes.reduce((s, l) => s + (l.response?.usage?.totalTokens ?? 0), 0),
      }
    : undefined

  // Build a leaderboard snapshot at write time for skill consumers that
  // want the current rankings without re-reading ab-pro.jsonl.
  const priorEntries = await dualPro.readAbProLog()
  const leaderboardSnapshot = dualPro.buildLeaderboard(priorEntries, cfg.scoreWeights)
  await finalizeOutput(combined, outputFile, sessionTag, {
    query: question,
    model: `dual-pro (${legOutcomes.map((l) => l.model.displayName).join(" + ")})`,
    tokens: combinedTokens,
    cost: formatCost(totalLegCost + judgeCost),
    costUsd: totalLegCost + judgeCost,
    durationMs: Math.max(0, ...legOutcomes.map((l) => l.response?.durationMs ?? 0)),
    status: anyLegOk ? "completed" : "failed",
    a: aLeg,
    b: bLeg,
    c: cLegEnv,
    d: dLegEnv,
    legs: legOutcomes.length,
    judge: judgeResult
      ? {
          model: judgeModelId,
          winner: judgeResult.winner,
          reasoning: judgeResult.reasoning,
          a: judgeResult.a,
          b: judgeResult.b,
          c: judgeResult.c,
          d: judgeResult.d,
          ab: pairwise.ab,
          ac: pairwise.ac,
          ad: pairwise.ad,
          cost: judgeCost,
        }
      : judgeError
        ? { error: judgeError }
        : undefined,
    leaderboardSnapshot: leaderboardSnapshot.slice(0, 10).map((r) => r as unknown as Record<string, unknown>),
  })

  // Append an ab-pro.jsonl entry so we can review quality over time. v3
  // shape carries leg D + pairwise judge results; legacy gpt/kimi keys
  // remain for v1 readers.
  await appendAbProLog({
    question,
    sessionTag,
    outputFile,
    legs: legOutcomes.map((l) => ({
      id: l.id,
      model: l.model,
      response: l.response,
      error: l.error,
      cost: legCosts.get(l.id) ?? 0,
      score:
        l.id === "a"
          ? (aScoreAvg ?? null)
          : l.id === "b"
            ? (pairwise.ab?.scoreB ?? null)
            : l.id === "c"
              ? (pairwise.ac?.scoreB ?? null)
              : (pairwise.ad?.scoreB ?? null),
    })),
    pairwise,
    judgeModel: judgeModelId,
    judgeWinner: judgeResult?.winner,
    judgeReasoning: judgeResult?.reasoning,
    judgeError,
    judgeCost,
    rubric: cfg.rubric,
  })

  // Promotion banner: if the leaderboard now suggests the challenger has
  // earned a promotion conversation, surface a non-blocking hint. Never
  // auto-switches.
  try {
    const updated = await dualPro.readAbProLog()
    const updatedBoard = dualPro.buildLeaderboard(updated, cfg.scoreWeights)
    const verdict = dualPro.evaluatePromotion(updatedBoard, cfg.mainstays[0], cfg.splitTestPool)
    if (verdict.shouldOfferPromotion && verdict.challenger) {
      console.error(
        `\n🏆 Promotion candidate: ${verdict.challenger.model} (${verdict.reason}). Run \`bun llm pro --promote-review\`.`,
      )
    }
  } catch {
    // Best-effort signal.
  }

  // If all legs failed, surface as a non-zero exit so scripts don't mistake
  // an error report for a success. The combined report + ab-pro log still
  // get written — useful for post-mortem — but the caller knows it went
  // wrong. Keep the legacy "Both dual-pro legs failed" message for the
  // 2-leg case, since downstream scripts grep for it.
  if (!anyLegOk) {
    const msg =
      legOutcomes.length === 2
        ? "\n⚠️  Both dual-pro legs failed — see report for details."
        : "\n⚠️  All dual-pro legs failed — see report for details."
    console.error(msg)
    process.exit(1)
  }
}

/**
 * Append one dual-pro run to the A/B log (JSONL). Best-effort — errors are
 * swallowed so a log write failure doesn't break the user-facing output.
 *
 * Log lives with the project's memory directory so it travels with the
 * Claude Code project context. Fields are stable — later we can `jq` over
 * them to rank winners, estimate quality deltas, etc.
 */
async function appendAbProLog(entry: {
  question: string
  sessionTag: string
  outputFile: string
  legs: {
    id: "a" | "b" | "c" | "d"
    model: Model
    response: import("../lib/types").ModelResponse | undefined
    error: string | undefined
    cost: number
    score: import("../lib/dual-pro").JudgeBreakdown | null
  }[]
  pairwise: {
    ab?: import("../lib/dual-pro").PairwiseJudgeResult
    ac?: import("../lib/dual-pro").PairwiseJudgeResult
    ad?: import("../lib/dual-pro").PairwiseJudgeResult
  }
  judgeModel?: string
  judgeWinner?: "a" | "b" | "c" | "d" | "tie"
  judgeReasoning?: string
  judgeError?: string
  judgeCost?: number
  rubric?: string
}): Promise<void> {
  try {
    const os = await import("os")
    const fs = await import("fs")
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd()
    const encoded = projectRoot.replace(/\//g, "-")
    // Prefer HOME env (test isolation respects it; os.homedir() reads from
    // getuid() and ignores HOME, leaking writes into the real user profile).
    const home = process.env.HOME || os.homedir()
    const dir = `${home}/.claude/projects/${encoded}/memory`
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    // Build a compact leg snapshot. Inline content so retroactive judging
    // never depends on /tmp/llm-*.txt file lifetime (auto-cleaned at 7 days).
    const snapshot = (l: (typeof entry.legs)[number]) => ({
      model: l.model.modelId,
      ok: !!l.response?.content && l.response.content.trim().length > 0 && !l.error,
      error: l.error,
      tokens: l.response?.usage?.totalTokens,
      promptTokens: l.response?.usage?.promptTokens,
      completionTokens: l.response?.usage?.completionTokens,
      durationMs: l.response?.durationMs,
      chars: l.response?.content?.length,
      content: l.response?.content,
      cost: l.cost,
      score: l.score ?? null,
    })
    const byId = new Map(entry.legs.map((l) => [l.id, l]))
    const a = byId.has("a") ? snapshot(byId.get("a")!) : undefined
    const b = byId.has("b") ? snapshot(byId.get("b")!) : undefined
    const c = byId.has("c") ? snapshot(byId.get("c")!) : undefined
    const d = byId.has("d") ? snapshot(byId.get("d")!) : undefined

    // Stable-ish hash of the question for leaderboard correlation. djb2.
    const queryHash = (() => {
      let h = 5381
      for (let i = 0; i < entry.question.length; i++) h = ((h << 5) + h + entry.question.charCodeAt(i)) >>> 0
      return h.toString(16)
    })()
    const legA = byId.get("a")
    const legB = byId.get("b")
    const line =
      JSON.stringify({
        // Schema version. v3 adds leg `d` + pairwise judge results
        // (`judge.ab`/`ac`/`ad`); v2-v1 keys preserved for back-compat.
        // Readers should treat unknown fields as opaque.
        schema: "ab-pro/v3",
        timestamp: new Date().toISOString(),
        session: entry.sessionTag,
        question: entry.question,
        queryHash,
        outputFile: entry.outputFile,
        // v1 (back-compat) — same payload as v1 readers expect. Always
        // mirrors legs A and B (the mainstays).
        gpt: legA
          ? {
              model: legA.model.modelId,
              ok: !!legA.response?.content,
              error: legA.error,
              tokens: legA.response?.usage?.totalTokens,
              promptTokens: legA.response?.usage?.promptTokens,
              completionTokens: legA.response?.usage?.completionTokens,
              durationMs: legA.response?.durationMs,
              chars: legA.response?.content?.length,
              cost: legA.cost,
            }
          : undefined,
        kimi: legB
          ? {
              model: legB.model.modelId,
              ok: !!legB.response?.content,
              error: legB.error,
              tokens: legB.response?.usage?.totalTokens,
              promptTokens: legB.response?.usage?.promptTokens,
              completionTokens: legB.response?.usage?.completionTokens,
              durationMs: legB.response?.durationMs,
              chars: legB.response?.content?.length,
              cost: legB.cost,
            }
          : undefined,
        // v2/v3 — a/b/c/d + judge.
        a,
        b,
        c,
        d,
        judge:
          entry.judgeWinner || entry.judgeError || entry.pairwise.ab || entry.pairwise.ac || entry.pairwise.ad
            ? {
                model: entry.judgeModel,
                // v2 fields (winner/reasoning/error/cost/rubric + leg scores)
                // — synthesized from pairwise results so v2 readers still work.
                winner: entry.judgeWinner,
                reasoning: entry.judgeReasoning,
                error: entry.judgeError,
                cost: entry.judgeCost,
                rubric: entry.rubric,
                a: byId.get("a")?.score ?? null,
                b: byId.get("b")?.score ?? null,
                c: byId.has("c") ? (byId.get("c")!.score ?? null) : undefined,
                d: byId.has("d") ? (byId.get("d")!.score ?? null) : undefined,
                // v3 — pairwise results, the actual judge output.
                ab: entry.pairwise.ab,
                ac: entry.pairwise.ac,
                ad: entry.pairwise.ad,
              }
            : undefined,
      }) + "\n"
    fs.appendFileSync(`${dir}/ab-pro.jsonl`, line)
  } catch {
    // Best-effort log
  }
}
