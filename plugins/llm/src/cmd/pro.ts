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
import { estimateCost, formatCost, getModel, skuRates, type Model, type ModelMode } from "../lib/types"
import { withSignalAbort } from "../lib/signals"
import { assertDispatchableModelIds, getLegTimeoutMs, runWithTimeout } from "../lib/dispatch-safety"
import { describeDispatchFailure } from "../lib/dispatch-error"
import { failingMainstays, formatFleetWarning, readFleetFailureReport } from "../lib/fleet-failure"
import { confirmOrExit } from "../ui/confirm"
import { askAndFinish } from "./ask"

/**
 * 24533 defect 4. The estimate was a hardcoded tier band — `~$5-15` whenever
 * fewer than two Pro-tier legs were selected, INCLUDING when none were. @chief
 * measured a 2-leg run at $0.0015 against that printed $5-15: four orders of
 * magnitude, on the very line that gates the spend confirmation. An estimate
 * nobody can trust is one nobody reads, including when it matters.
 *
 * It is now derived from the registry prices of the models actually selected. A
 * model the registry cannot price is NAMED rather than folded into an invented
 * number, because "we do not know" and "about five dollars" are different facts.
 */
function estimateFleetCost(
  models: readonly Model[],
  inputTokens: number,
  outputTokens: number,
): { text: string; usd: number; unpriced: readonly string[] } {
  const unpriced = models.filter((m) => skuRates(m) === null).map((m) => m.displayName)
  const usd = models.reduce((sum, m) => sum + estimateCost(m, inputTokens, outputTokens), 0)
  const text =
    unpriced.length === 0
      ? `~${formatCost(usd)}`
      : `~${formatCost(usd)} for the priced legs, plus ${unpriced.length} the registry cannot price (${unpriced.join(", ")})`
  return { text, usd, unpriced }
}

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
  /** Resolve and print the dual-pro fleet without provider calls or writes. */
  dryRun?: boolean
}): Promise<void> {
  const {
    question,
    modelOverride,
    imagePath,
    buildContext,
    outputFile,
    sessionTag,
    skipConfirm,
    dryRun = false,
  } = options
  const { finalizeOutput } = await import("../lib/format")
  const dualPro = await import("../lib/dual-pro")

  // Explicit --model override bypasses dual mode entirely.
  if (modelOverride) {
    assertDispatchableModelIds([modelOverride.modelId])
    if (dryRun) {
      const estimate = modelOverride.costTier === "very-high" ? "~$5-15" : "registry-priced single-model call"
      console.error("[pro] Dry run - would query one model:")
      console.error(`  • Model: ${modelOverride.displayName} (${modelOverride.modelId})`)
      console.error("  • Config: explicit --model override")
      console.error(`  • Estimated cost: ${estimate}`)
      console.error("  • Side effects: none (no provider calls, output files, A/B logs, or rotation counters)")
      return
    }
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
  const cfg = await dualPro.loadConfig({ writeOnMissing: !dryRun })
  assertDispatchableModelIds([
    ...cfg.mainstays,
    ...cfg.splitTestPool,
    cfg.judge,
    ...(options.challengerOverride ? [options.challengerOverride] : []),
  ])
  const legTimeoutMs = getLegTimeoutMs()
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
  let slotCId: string | undefined
  let slotDId: string | undefined
  let nextCounter = 0
  if (legCap >= 3) {
    const counter = await dualPro.readChallengerCounter()
    if (options.challengerOverride) {
      slotCId = options.challengerOverride
      slotC = getModel(slotCId)
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
        slotCId = picked.slotC
        slotDId = picked.slotD
        slotC = getModel(slotCId ?? "")
        slotD = getModel(slotDId ?? "")
        nextCounter = picked.nextCounter
      } else {
        const picked = dualPro.pickNextChallenger(filteredPool, cfg.splitTestStrategy, counter, effectiveExclude)
        slotCId = picked.modelId
        slotC = getModel(slotCId ?? "")
        nextCounter = picked.nextCounter
      }
    }
  }

  if (dryRun) {
    type DryLeg = {
      id: "a" | "b" | "c" | "d"
      role: "mainstay" | "split-test"
      modelId: string
      model: Model | undefined
    }
    const dryLegs: DryLeg[] = [
      { id: "a", role: "mainstay", modelId: mainstay0Id, model: mainstay0 },
      { id: "b", role: "mainstay", modelId: mainstay1Id, model: mainstay1 },
    ]
    if (legCap >= 3 && slotCId) dryLegs.push({ id: "c", role: "split-test", modelId: slotCId, model: slotC })
    if (legCap >= 4 && slotDId) dryLegs.push({ id: "d", role: "split-test", modelId: slotDId, model: slotD })
    const knownLegs = dryLegs.filter((l): l is DryLeg & { model: Model } => Boolean(l.model))
    const dryProLegCount = knownLegs.filter((l) => l.model.costTier === "very-high").length
    const dryCost = estimateFleetCost(
      knownLegs.map((l) => l.model),
      Math.max(200, Math.ceil(question.length / 4)),
      1_000,
    ).text
    console.error("[dual-pro] Dry run - would query these models:")
    for (const leg of dryLegs) {
      const tag = leg.role === "split-test" ? " [split-test]" : ""
      if (!leg.model) {
        console.error(`  • ${leg.id.toUpperCase()} unknown model "${leg.modelId}"${tag}`)
        continue
      }
      const availability = isProviderAvailable(leg.model.provider)
        ? "provider key ready"
        : `${getProviderEnvVar(leg.model.provider)} not set`
      console.error(
        `  • ${leg.id.toUpperCase()} ${leg.model.displayName}${tag} (${leg.model.modelId}; ${availability})`,
      )
    }
    const cfgPath = `${dualPro.getMemoryDir()}/dual-pro-config.json`
    console.error(`  • Config: ${cfgPath} (or built-in defaults if missing) + env overrides`)
    console.error(
      `  • Safety: one dispatch per leg with actionable quota/auth errors; ${Math.round(legTimeoutMs / 60_000)}m per-leg timeout`,
    )
    console.error(`  • Estimated cost: ${dryCost} (${dryProLegCount} Pro-tier legs of ${dryLegs.length})`)
    if (options.noJudge) {
      console.error("  • Judge: disabled (--no-judge)")
    } else {
      const judgeModel = getModel(cfg.judge)
      if (judgeModel) {
        const availability = isProviderAvailable(judgeModel.provider)
          ? "provider key ready"
          : `${getProviderEnvVar(judgeModel.provider)} not set`
        console.error(`  • Judge: ${judgeModel.displayName} (${judgeModel.modelId}; ${availability})`)
      } else {
        console.error(`  • Judge: unknown model "${cfg.judge}"`)
      }
    }
    if (!m0Available || !m1Available) {
      console.error("  • Real run note: unavailable mainstay would fall back to single-model pro mode.")
    }
    console.error("  • Side effects: none (no provider calls, output files, A/B logs, or rotation counters)")
    return
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
  // Cost estimate, derived from the models this call actually selected.
  const proLegCount = legSlots.filter((s) => s.model.costTier === "very-high").length
  const estInputTokens = Math.max(200, Math.ceil((question.length + (context?.length ?? 0)) / 4))
  const estOutputTokens = 1_000
  const fleetEstimate = estimateFleetCost(
    legSlots.map((s) => s.model),
    estInputTokens,
    estOutputTokens,
  )
  const totalEstStr = fleetEstimate.text
  console.error(
    `  • Estimated cost: ${totalEstStr} — registry prices for ${legSlots.length} legs at ~${estInputTokens} in / ${estOutputTokens} out tokens`,
  )
  // Surface dynamic-thinking budgets for any leg that uses them.
  for (const s of legSlots) {
    if (s.model.reasoning?.contextWindow || s.model.reasoning?.maxOutputTokens) {
      const cap = s.model.reasoning?.contextWindow
        ? `dynamic (up to ~${s.model.reasoning.contextWindow - 4096} tokens, scales with input)`
        : `${s.model.reasoning?.maxOutputTokens} tokens (static)`
      console.error(`  • ${s.model.displayName} output budget: ${cap}`)
    }
  }
  // A mainstay that has been failing across the fleet must say so HERE, in the
  // output every real run prints — `pro --diagnostics` is where this signal
  // lived, and nobody runs it. Fleet-wide by construction: the per-directory
  // read is what let two working models get retired as dead
  // (@i/1-instruments/24546). Split-test legs are excluded on purpose; a
  // challenger failing is the point of split-testing, not news.
  try {
    const fleet = readFleetFailureReport()
    for (const row of failingMainstays(fleet, cfg.mainstays)) {
      console.error(formatFleetWarning(row, fleet))
    }
  } catch (err) {
    // Never let a diagnostic read break a dispatch — but never swallow it
    // either. A reader that fails silently is the defect this warning is for.
    console.error(`\u26a0\ufe0f  fleet failure-rate check skipped: ${err instanceof Error ? err.message : String(err)}`)
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
  const dispatchOne = (m: Model, abortSignal: AbortSignal) => {
    const useBackground = isOpenAIBackgroundCapable(m) && !imagePath
    return useBackground
      ? queryOpenAIBackground({
          prompt: enrichedQuestion,
          model: m,
          topic: question,
          abortSignal,
        })
      : ask(enrichedQuestion, "standard", {
          modelOverride: m.modelId,
          stream: false,
          imagePath,
          abortSignal,
        })
  }

  // Fire ALL legs in parallel — single round trip, timing dominated by the
  // slowest leg. Streaming disabled (multi-stream interleave unreadable).
  const settledResults = await withSignalAbort((outerSignal) =>
    Promise.allSettled(
      legSlots.map((slot) =>
        runWithTimeout({
          label: `${slot.model.displayName} leg`,
          timeoutMs: legTimeoutMs,
          outerSignal,
          run: (signal) => dispatchOne(slot.model, signal),
        }),
      ),
    ),
  )

  // Normalize each leg to (ok, error). "Success" requires non-empty trimmed
  // content AND no error — a fulfilled promise with empty content
  // (reasoning-exhaustion, abort, API quirks) is a failure, not a silent
  // success.
  type LegOutcome = LegSlot & {
    response?: import("../lib/types").ModelResponse
    error?: string
    ok: boolean
    /** Classifier verdict, kept so a credential-blaming message can be rewritten
     * once the run knows that credential worked for another leg (24533 defect 2). */
    failureKind?: import("../lib/dispatch-error").DispatchFailureKind
    /** The provider's own text, before classification added a cure. */
    rawError?: string
  }
  const legOutcomes: LegOutcome[] = legSlots.map((slot, i) => {
    const settled = settledResults[i]!
    const response = settled.status === "fulfilled" ? settled.value : undefined
    const raw: unknown = settled.status === "rejected" ? (settled.reason as unknown) : (response?.error ?? undefined)
    const described = raw === undefined ? undefined : describeDispatchFailure(raw, slot.model)
    // The upstream text, kept separately so the rewrite below can quote what
    // failed. It is NOT the provider's raw words -- dispatchOne classifies before
    // it rethrows -- so it still carries a "check <ENV>" cure, which the rewrite
    // strips rather than smuggling the wrong cure into the corrected message.
    const rawText = raw === undefined ? undefined : raw instanceof Error ? raw.message : String(raw)
    const errRaw = described?.message
    const ok = !errRaw && !!response?.content && response.content.trim().length > 0
    const error = errRaw ?? (response && !ok ? "empty content" : undefined)
    return {
      ...slot,
      response,
      error,
      ok,
      ...(described === undefined ? {} : { failureKind: described.kind }),
      ...(rawText === undefined ? {} : { rawError: rawText }),
    }
  })

  /**
   * 24533 defect 2. A per-error classifier cannot know that the credential it is
   * about to blame worked three times in the same run — only the run knows that.
   * So a credential-scoped verdict is REWRITTEN here when another leg reached the
   * same provider successfully: the message names the model and the route that
   * actually failed, and stops sending the reader to a key that is demonstrably
   * fine. Measured specimen: kimi-k3 answered a direct probe with an unclassified
   * provider error in 191 ms at zero tokens while three other models
   * authenticated with the same OPENROUTER_API_KEY in the same dispatch.
   */
  /** Upstream text with the credential cure removed — the one thing it must not say. */
  const withoutCredentialCure = (leg: LegOutcome): string => {
    const envVar = getProviderEnvVar(leg.model.provider)
    const text = leg.rawError ?? "nothing"
    return envVar === undefined
      ? text
      : text
          .replace(new RegExp(String.raw`\s*[\u2014-]?\s*check\s+${envVar}\.?`, "giu"), "")
          .replace(/\s+/gu, " ")
          .trim()
  }
  const provenProviders = new Set(legOutcomes.filter((l) => l.ok).map((l) => l.model.provider))
  for (const leg of legOutcomes) {
    const blamesCredential = leg.failureKind === "auth" || leg.failureKind === "quota"
    if (!blamesCredential || leg.ok || !provenProviders.has(leg.model.provider)) continue
    const proof = legOutcomes.find((l) => l.ok && l.model.provider === leg.model.provider)!
    leg.error =
      `${leg.model.displayName} (${leg.model.modelId}) failed on ${leg.model.provider}. ` +
      `This is NOT a credentials problem: ${proof.model.displayName} reached ${proof.model.provider} ` +
      `with the same credential in this run. The route or the model id is the suspect — ` +
      `probe it with \`llm ask --model ${leg.model.modelId}\`. Upstream said: ${withoutCredentialCure(leg)}`
  }

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
  /**
   * Pair results keyed by the CONTENDER's slot, so the score synthesis below is
   * correct whichever leg anchored. `pairwise` above keeps the legacy ab/ac/ad
   * keys and is populated ONLY when leg A anchored: those names assert "A vs X"
   * and would misdescribe a reduced panel.
   */
  const pairByContender = new Map<"a" | "b" | "c" | "d", import("../lib/dual-pro").PairwiseJudgeResult>()
  let judgeError: string | undefined
  let judgeCost = 0
  let judgeModelId: string | undefined
  const okLegs = legOutcomes.filter((l) => l.ok)
  /**
   * 24533 defect 1. The judge used to be gated on leg A (`anyLegOk && legA.ok`),
   * so one dead anchor model turned every dispatch into unjudged opinions that
   * still read like a verdict — three specimens across three days, all the same
   * dead model.
   *
   * A failed leg now REDUCES the panel instead of cancelling the verdict: the
   * judge anchors on leg A when it returned, and otherwise on the first leg that
   * did. The single case that genuinely cannot be judged is a panel of one,
   * because there is nothing to compare it against; that is REPORTED rather than
   * silently skipped.
   */
  const judgeAnchor: LegOutcome | undefined = legA.ok ? legA : okLegs[0]
  if (!options.noJudge && okLegs.length >= 2 && judgeAnchor) {
    const judgeModel = getModel(cfg.judge)
    if (!judgeModel) {
      judgeError = `judge model "${cfg.judge}" not found in registry`
    } else if (!isProviderAvailable(judgeModel.provider)) {
      judgeError = `judge unavailable: ${getProviderEnvVar(judgeModel.provider)} not set`
    } else {
      judgeModelId = judgeModel.modelId
      // Every surviving leg that is not the anchor is a contender. The pair id
      // names BOTH slots (`ab`, `bc`, …) so a reduced panel is self-describing;
      // only the A-anchored ids coincide with the legacy ab/ac/ad keys.
      const contenders = okLegs.filter((l) => l.id !== judgeAnchor.id)
      const pairs: { id: string; contender: LegOutcome }[] = contenders.map((contender) => ({
        id: `${judgeAnchor.id}${contender.id}`,
        contender,
      }))
      const contenderSlotByPairId = new Map<string, "a" | "b" | "c" | "d">(
        pairs.map((p) => [p.id, p.contender.id as "a" | "b" | "c" | "d"] as const),
      )
      const panelNote = judgeAnchor.id === "a" ? "" : ` (reduced panel — anchored on ${judgeAnchor.model.displayName})`
      console.error(
        `\n[dual-pro] Pairwise judging via ${judgeModel.displayName} (${pairs.length} pairs)${panelNote}...`,
      )
      const judgeOnce = async (
        pairId: string,
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
            a: { model: judgeAnchor.model.displayName, content: judgeAnchor.response!.content },
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
        if (!r.result) continue
        const contenderId = contenderSlotByPairId.get(r.id)
        if (contenderId === undefined) continue
        pairByContender.set(contenderId, r.result)
        // Legacy ab/ac/ad keys mean "leg A vs X" and are written only when A
        // actually anchored; on a reduced panel they would name the wrong pair.
        if (judgeAnchor.id === "a" && (r.id === "ab" || r.id === "ac" || r.id === "ad")) pairwise[r.id] = r.result
      }
      const failures = settled.filter((r) => !r.result)
      if (failures.length === settled.length && settled.length > 0) {
        judgeError = `all pairwise judges failed (${failures.map((f) => f.error).join("; ")})`
      } else if (failures.length > 0) {
        console.error(`  ⚠ ${failures.length}/${settled.length} pairwise judges failed`)
      }
    }
    if (judgeError) console.error(`  ⚠ judge unavailable: ${judgeError}`)
  } else if (!options.noJudge && okLegs.length === 1) {
    // The only honest skip: one opinion cannot be scored against anything. Name
    // the leg that survived and the ones that did not, so the reason is legible
    // without opening the status block.
    const lost = legOutcomes.filter((l) => !l.ok).map((l) => l.model.displayName)
    const survivor = okLegs[0]
    judgeError =
      `judge skipped — only 1 of ${legOutcomes.length} legs returned (${survivor?.model.displayName ?? "unknown"}); ` +
      `a panel of one cannot be scored. Missing: ${lost.join(", ")}`
    console.error(`  ⚠ ${judgeError}`)
  }

  // Synthesize an N-way `judge.{a,b,c,d,winner}` shape for v2 consumers
  // (leaderboard, judge-history, backtest). Pull leg-specific scores from
  // the AB/AC/AD pairs (each pair scored leg A on its own line — they should
  // agree but we average to reduce variance).
  // Each pair scored the ANCHOR on its own line (`scoreA`) and its contender on
  // the other (`scoreB`). Keyed by contender slot, this synthesis is correct
  // whichever leg anchored — it no longer assumes that leg is A.
  const anchorSamples = Array.from(pairByContender.values())
    .map((p) => p.scoreA)
    .filter(Boolean) as import("../lib/dual-pro").JudgeBreakdown[]
  const anchorTotal =
    anchorSamples.length > 0 ? anchorSamples.reduce((s, x) => s + x.total, 0) / anchorSamples.length : undefined
  const judgeTotals: Record<"a" | "b" | "c" | "d", number | undefined> = {
    a: pairByContender.get("a")?.scoreB?.total,
    b: pairByContender.get("b")?.scoreB?.total,
    c: pairByContender.get("c")?.scoreB?.total,
    d: pairByContender.get("d")?.scoreB?.total,
  }
  if (judgeAnchor) judgeTotals[judgeAnchor.id as "a" | "b" | "c" | "d"] = anchorTotal
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
  // Average breakdown for the ANCHOR leg (used by the v2 reader synthesis).
  const anchorScoreAvg: import("../lib/dual-pro").JudgeBreakdown | undefined = (() => {
    if (anchorSamples.length === 0 || anchorTotal === undefined) return undefined
    const avg = (k: keyof import("../lib/dual-pro").JudgeBreakdown["scores"]) =>
      anchorSamples.reduce((s, x) => s + x.scores[k], 0) / anchorSamples.length
    return {
      scores: {
        specificity: avg("specificity"),
        actionability: avg("actionability"),
        correctness: avg("correctness"),
        depth: avg("depth"),
      },
      total: anchorTotal,
    }
  })()
  /** Per-slot breakdown: the anchor's averaged score, each contender's own. */
  const breakdownFor = (slot: "a" | "b" | "c" | "d"): import("../lib/dual-pro").JudgeBreakdown | null =>
    judgeAnchor?.id === slot ? (anchorScoreAvg ?? null) : (pairByContender.get(slot)?.scoreB ?? null)

  const judgeResult: import("../lib/dual-pro").JudgeResult | undefined =
    overallWinnerKey != null
      ? {
          a: breakdownFor("a"),
          b: breakdownFor("b"),
          c: breakdownFor("c"),
          d: breakdownFor("d"),
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
  /**
   * 24533 acceptance row 2. The panel's state belongs on the line a reader
   * reaches FIRST, not in a status block further down. Three specimens of the
   * anchor defect survived three days precisely because "judge skipped" sat
   * below the answers, so a degraded run read like a verdict to anyone who did
   * not scroll. Line 1 now always says how many legs ran, how many were asked
   * for, and which model judged — or, when nothing judged, why not.
   */
  const legsAsked = legOutcomes.length
  const legsRan = okLegs.length
  const judgedBy = judgeResult ? (judgeModelId ?? cfg.judge) : undefined
  const judgeSummary = judgedBy
    ? `judged by ${judgedBy}`
    : options.noJudge
      ? "NOT JUDGED (--no-judge)"
      : `NOT JUDGED (${judgeError ?? "no judge result"})`
  parts.push(`# Dual-Pro Response — ${legsRan}/${legsAsked} legs · ${judgeSummary}\n`)
  const failedLegs = legOutcomes.filter((l) => !l.ok)
  if (failedLegs.length > 0) {
    parts.push(
      `**Missing legs**: ${failedLegs.map((l) => `${l.model.displayName} (${l.error ?? "no content"})`).join("; ")}\n`,
    )
  }
  // A reduced panel is named where the verdict is read, not inferred from which
  // leg happens to be missing.
  if (judgeResult && judgeAnchor && judgeAnchor.id !== "a") {
    parts.push(`**Reduced panel**: leg A did not return; judged against ${judgeAnchor.model.displayName} as anchor\n`)
  }
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
    if (pairwise.ab) {
      parts.push(`- **AB**: ${pairwise.ab.winner}${pairwise.ab.reasoning ? ` — ${pairwise.ab.reasoning}` : ""}`)
    }
    if (pairwise.ac) {
      parts.push(`- **AC**: ${pairwise.ac.winner}${pairwise.ac.reasoning ? ` — ${pairwise.ac.reasoning}` : ""}`)
    }
    if (pairwise.ad) {
      parts.push(`- **AD**: ${pairwise.ad.winner}${pairwise.ad.reasoning ? ` — ${pairwise.ad.reasoning}` : ""}`)
    }
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
    status: okLegs.length > 0 ? "completed" : "failed",
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
      score: breakdownFor(l.id as "a" | "b" | "c" | "d"),
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
  if (okLegs.length === 0) {
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
