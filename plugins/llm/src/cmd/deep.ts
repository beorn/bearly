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
  dryRun: boolean
}): Promise<void> {
  const { topic, modelOverride, streamToken, outputFile, sessionTag, skipRecover, skipConfirm, dryRun } = options
  const { finishResponse } = await import("../lib/format")

  const context = await options.buildContext(topic)
  const shouldContinue = await checkAndRecoverPartials(skipRecover, skipConfirm)
  if (!shouldContinue) {
    console.error("Cancelled.")
    return
  }

  let deepModel: Model
  if (modelOverride) {
    deepModel = modelOverride
  } else {
    const result = getBestAvailableModel("deep", isProviderAvailable)
    if (!result.model) {
      emitJson({ error: "No deep research model available. " + (result.warning || ""), status: "failed" })
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
  const costEstimate = deepModel.costTier === "very-high" ? "~$5-15" : "~$2-5"
  console.error(`Estimated cost: ${costEstimate}\n`)
  if (context) {
    console.error(`📎 Context provided (${context.length} chars)\n`)
  }

  if (dryRun) {
    console.error("🔍 Dry run - would call deep research API")
    console.error(`   Model: ${deepModel.modelId}`)
    console.error(`   Provider: ${deepModel.provider}`)
    if (context) console.error(`   Context: ${context.slice(0, 100)}...`)
    return
  }

  await confirmOrExit("⚠️  This uses deep research models (~$2-5). Proceed? [Y/n] ", skipConfirm)

  // SIGINT/SIGTERM aborts both the synchronous create (rare — it's a single
  // HTTP call) and any inline polling (Gemini deep path polls for up to 20m
  // inside research()). Fire-and-forget OpenAI paths return immediately
  // after the ID is captured, but we wrap anyway so either provider
  // branch honours Ctrl-C uniformly.
  const response = await withSignalAbort((signal) =>
    research(topic, {
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
    if (response.responseId && !response.error) {
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
    await finishResponse(undefined, deepModel, outputFile, sessionTag, response.usage, response.durationMs, topic)
    return
  }

  // Fast model that completed immediately (no polling needed)
  if (response.error) {
    log.error?.(`Deep research failed: ${response.error}`)
    if (!response.content || response.content.trim().length === 0) {
      // Genuine failure — finishResponse will write error details to the output file
      await finishResponse(undefined, deepModel, outputFile, sessionTag, response.usage, response.durationMs, topic)
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
  )
}
