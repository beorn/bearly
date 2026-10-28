/**
 * `bun llm deep` — long-running deep research dispatch with fire-and-forget,
 * partial recovery sweep, and SIGINT-safe abort.
 */

import { createLogger } from "loggily"
import { research } from "../lib/research"
import { isProviderAvailable } from "../lib/providers"
import { getBestAvailableModel, type Model } from "../lib/types"
import { emitJson } from "../lib/output-mode"
import { withSignalAbort } from "../lib/signals"
import { confirmOrExit } from "../ui/confirm"
import { checkAndRecoverPartials } from "./recover"
import { safeCurrentSeat, declaredHabitatEnvFile } from "../lib/env-preflight"
import { loadConfig, type HarnessLeg } from "../lib/dual-pro"
import { resolveClaudeHarnessAccount } from "../lib/harness-account"
import { HARNESS_RUN_TIMEOUT_CAP_MS, runHarnessLeg } from "../lib/harness-run"

const log = createLogger("bearly:llm")

/** Run deep research command */
export async function runDeep(options: {
  topic: string
  modelOverride: Model | undefined
  streamToken: (token: string) => void
  buildContext: (topic: string) => Promise<string | undefined>
  outputFile: string
  sessionTag: string
  skipRecover: boolean
  skipConfirm: boolean
  maxOutputTokens?: number
  retryCommand?: (model: string, bound: number) => string
  dryRun: boolean
}): Promise<void> {
  const { topic, modelOverride, streamToken, outputFile, sessionTag, skipRecover, skipConfirm, dryRun } = options
  const { finishResponse, outputTokenStop, estimateFleetCost } = await import("../lib/format")

  const context = await options.buildContext(topic)
  const shouldContinue = await checkAndRecoverPartials(skipRecover, skipConfirm)
  if (!shouldContinue) {
    console.error("Cancelled.")
    return
  }

  const cfg = await loadConfig({ writeOnMissing: false })
  const harnessLeg = cfg.harnessLegs[0]
  if (harnessLeg) {
    await runDeepHarnessLeg({
      topic,
      context,
      leg: harnessLeg,
      extraLegs: cfg.harnessLegs.length - 1,
      launcher: cfg.harnessLauncher,
      outputFile,
      sessionTag,
      skipConfirm,
      dryRun,
      modelOverridden: modelOverride !== undefined,
    })
    return
  }

  let deepModel: Model
  if (modelOverride) {
    deepModel = modelOverride
  } else {
    const result = getBestAvailableModel("deep", isProviderAvailable)
    if (!result.model) {
      const seat = safeCurrentSeat()
      const envFile = declaredHabitatEnvFile()
      const msg =
        `No deep research model available for seat ${seat}: provider keys not found in declared env file (${envFile}) or launch environment. ${result.warning || ""}`.trim()
      emitJson({ error: msg, status: "failed" })
      console.error(`error: ${msg}`)
      process.exit(1)
    }
    if (result.warning) console.error(`⚠️  ${result.warning}\n`)
    deepModel = result.model
  }

  console.error(`Deep research: ${topic}`)
  console.error(`Model: ${deepModel.displayName}`)
  if (!deepModel.isDeepResearch && deepModel.costTier === "very-high") {
    console.error(`⚠️  ${deepModel.displayName} is not a dedicated deep research model — may take 10-15 minutes`)
  }
  // The displayed forecast and consent share the same amounts and assumptions.
  const costEstimate = estimateFleetCost(
    [deepModel],
    Math.max(200, Math.ceil((topic.length + (context?.length ?? 0)) / 4)),
    options.maxOutputTokens ?? 1_000,
  ).text
  const consentPrompt = `⚠️  This uses deep research models (${costEstimate}). Proceed? [Y/n] `
  console.error(`Estimated cost: ${costEstimate}\n`)
  if (context) {
    console.error(`📎 Context provided (${context.length} chars)\n`)
  }

  if (dryRun) {
    console.error("🔍 Dry run - would call deep research API")
    console.error(`   Model: ${deepModel.modelId}`)
    console.error(`   Provider: ${deepModel.provider}`)
    // The dry run returns BEFORE the gate, which is why the divergence
    // survived: the only safe way to inspect this command never reached the
    // line that was wrong. So it states the question it would have asked.
    console.error(`   Would ask: ${consentPrompt.trim()}`)
    if (context) console.error(`   Context: ${context.slice(0, 100)}...`)
    return
  }

  await confirmOrExit(consentPrompt, skipConfirm)

  // SIGINT/SIGTERM aborts both the synchronous create (rare — it's a single
  // HTTP call) and any inline polling (Gemini deep path polls for up to 20m
  // inside research()). Fire-and-forget OpenAI paths return immediately
  // after the ID is captured, but we wrap anyway so either provider
  // branch honours Ctrl-C uniformly.
  const response = await withSignalAbort((signal) =>
    research(topic, {
      maxOutputTokens: options.maxOutputTokens,
      context,
      stream: true,
      onToken: streamToken,
      modelOverride: deepModel.modelId,
      fireAndForget: true,
      abortSignal: signal,
    }),
  )

  // Fire-and-forget: response ID is persisted, recover later with `bun llm recover`
  // For fire-and-forget deep research, empty content is expected — the research continues
  // server-side. The response ID was already persisted by the research layer.
  if (!response.content || response.content.trim().length === 0) {
    // Only emit the "in_progress" status when the response layer actually
    // succeeded in firing the job. If there's an error alongside a responseId
    // (e.g. a client-side timeout after the server accepted the request),
    // fall through to the error path — otherwise scripts parsing stdout see
    // a false success. Flagged by K2.6 round-3 review.
    if (
      deepModel.modelId !== "perplexity/sonar-deep-research" &&
      response.responseId &&
      !response.error &&
      outputTokenStop(response) === undefined
    ) {
      // Emit a machine-readable status line on stdout so scripts and callers
      // can harvest the responseId without parsing stderr. Mirrors the
      // normal completion path (which emits JSON via finalizeOutput). The
      // human-readable "bun llm recover" hint was already printed to stderr
      // by the research layer. Flagged in Pro round-2 review 2026-04-21.
      // Fire-and-forget envelope — no file yet (recover/await will fill
      // that in once the response completes). status="background" maps
      // to the spec's enum so skill consumers can branch on it.
      emitJson({
        status: "background",
        responseId: response.responseId,
        model: deepModel.displayName,
        provider: deepModel.provider,
        topic,
        recoverCommand: `bun llm recover ${response.responseId}`,
      })
      return
    }
    // No response ID OR an error is set — write error details to file
    await finishResponse(
      undefined,
      deepModel,
      outputFile,
      sessionTag,
      response.usage,
      response.durationMs,
      topic,
      response.responseId,
      undefined,
      response.error,
      options.retryCommand,
      response.servedBy,
      response,
    )
    return
  }

  // Fast model that completed immediately (no polling needed)
  if (response.error) {
    log.error?.(`Deep research failed: ${response.error}`)
    if (!response.content || response.content.trim().length === 0) {
      // Genuine failure — finishResponse will write error details to the output file
      await finishResponse(
        undefined,
        deepModel,
        outputFile,
        sessionTag,
        response.usage,
        response.durationMs,
        topic,
        response.responseId,
        undefined,
        response.error,
        options.retryCommand,
        response.servedBy,
        response,
      )
      return
    }
    log.warn?.("Partial content recovered — writing what we have.")
  }
  await finishResponse(
    response.content,
    response.model,
    outputFile,
    sessionTag,
    response.usage,
    response.durationMs,
    topic,
    response.responseId,
    undefined,
    response.error,
    options.retryCommand,
    response.servedBy,
    response,
  )
}

/**
 * One configured harness leg, with that harness's own web search, written
 * through the same completion file as a finished API deep response.
 * Further configured legs stay listed and are not run.
 */
async function runDeepHarnessLeg(args: {
  topic: string
  context: string | undefined
  leg: HarnessLeg
  extraLegs: number
  launcher: string | undefined
  outputFile: string
  sessionTag: string
  skipConfirm: boolean
  dryRun: boolean
  modelOverridden: boolean
}): Promise<void> {
  const account = args.leg.provider === "codex" ? args.leg.profile : resolveClaudeHarnessAccount()
  const label = `${args.leg.provider} ${args.leg.model} (account ${account})`
  console.error(`Deep research: ${args.topic}`)
  console.error(`Harness leg: ${label}`)
  if (args.extraLegs > 0) console.error(`  • ${args.extraLegs} more configured harness legs are not run`)
  console.error("Web search: on")
  console.error(`Quota: subscription, not an API charge. Timeout ${HARNESS_RUN_TIMEOUT_CAP_MS}ms.`)
  if (args.modelOverridden) console.error("API model override is not used; this run is the harness leg.")
  if (args.context) console.error(`📎 Context provided (${args.context.length} chars)`)
  const consent = "This runs one harness leg on subscription quota with web search. Proceed? [Y/n] "
  if (args.dryRun) {
    console.error("🔍 Dry run - would run one harness leg with web search")
    console.error(`   Would ask: ${consent.trim()}`)
    return
  }
  await confirmOrExit(consent, args.skipConfirm)
  const question = args.context ? `${args.topic}\n\n${args.context}` : args.topic
  const outcome = await runHarnessLeg({
    launcher: args.launcher,
    leg: args.leg,
    account,
    question,
    timeoutMs: HARNESS_RUN_TIMEOUT_CAP_MS,
    webSearch: true,
  })
  const { finishResponse } = await import("../lib/format")
  const model = {
    displayName: `${outcome.model} (account ${outcome.account})`,
    modelId: outcome.model,
  }
  const servedBy = {
    route: "subscription-cli" as const,
    cli: outcome.harness === "codex" ? "codex" : "claude",
    model: outcome.model,
  }
  const failure = outcome.ok ? undefined : `${label} incomplete: ${outcome.error ?? "unknown"}`
  await finishResponse(
    outcome.ok ? outcome.content : undefined,
    model,
    args.outputFile,
    args.sessionTag,
    undefined,
    undefined,
    args.topic,
    undefined,
    undefined,
    failure,
    undefined,
    servedBy,
  )
}
