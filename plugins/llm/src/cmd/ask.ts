/**
 * Single-model ask + finalize. Used by `bun llm`, `bun llm --quick`,
 * and an explicitly selected single-model Pro call.
 */

import { ask } from "../lib/research"
import { isProviderRoutable } from "../lib/providers"
import { resolveSubscriptionRoute } from "../lib/subscription-cli"
import { getBestAvailableModel, type Model, type ModelMode, type ModelResponse } from "../lib/types"
import { emitJson } from "../lib/output-mode"
import { withSignalAbort } from "../lib/signals"
import { getLegTimeoutMs, runWithTimeout } from "../lib/dispatch-safety"
import { describeDispatchFailure } from "../lib/dispatch-error"
import { safeCurrentSeat, declaredHabitatEnvFile } from "../lib/env-preflight"
import { outputTokenStop } from "../lib/format"
import { resolveResponseCost } from "../lib/pricing"
import { serializeCost } from "../lib/cost"

/** Shared single-model ask: select model, stream, finalize */
export async function askAndFinish(options: {
  question: string
  modelMode: ModelMode
  level: "standard" | "quick"
  header: (name: string) => string
  modelOverride: Model | undefined
  imagePath: string | undefined
  /** The panel slot this call answers for (27038). Passed through to the
   *  failure envelope, stderr and saved report. */
  slot?: string
  streamToken: (token: string) => void
  buildContext: (topic: string) => Promise<string | undefined>
  outputFile: string
  sessionTag: string
  /** When true, include captured rate-limit headers in the JSON envelope
   *  under `quota`. Cache update is unconditional regardless of this flag. */
  includeQuota?: boolean
  dryRun?: boolean
  maxOutputTokens?: number
  retryCommand?: (model: string, bound: number) => string
}): Promise<void> {
  const {
    question,
    modelMode,
    level,
    header,
    modelOverride,
    imagePath,
    streamToken,
    buildContext,
    outputFile,
    sessionTag,
  } = options
  const { finishResponse } = await import("../lib/format")

  const context = await buildContext(question)
  const enrichedQuestion = context ? `${context}\n\n---\n\n${question}` : question
  if (context) console.error(`📎 Context provided (${context.length} chars)\n`)
  let model: Model
  if (modelOverride) {
    model = modelOverride
  } else {
    const result = getBestAvailableModel(modelMode, isProviderRoutable)
    if (!result.model) {
      const seat = safeCurrentSeat()
      const envFile = declaredHabitatEnvFile()
      const msg =
        `No model available for ${modelMode} for seat ${seat}: provider keys not found in declared env file (${envFile}) or launch environment. ${result.warning || ""}`.trim()
      // Error envelope on stdout (JSON mode honours the contract; legacy
      // mode also benefits — scripts that wrap llm consistently parse JSON
      // from stdout regardless of whether --json was passed).
      emitJson({ error: msg, status: "failed" })
      console.error(`error: ${msg}`)
      process.exit(1)
    }
    if (result.warning) console.error(`⚠️  ${result.warning}\n`)
    model = result.model
  }
  if (options.dryRun) {
    console.error(`[ask] Dry run - would query ${model.displayName} (${model.modelId})`)
    return
  }
  console.error(header(model.displayName) + "\n")

  // Pro-mode OpenAI calls route through the Responses API so they're
  // recoverable — a 30-min Pro call that loses its process (SIGINT, network
  // hiccup, wall-clock kill) still persists its responseId and the user can
  // `bun llm recover <id>`. Other modes (quick, opinion, default) stay on
  // generateText: fast models complete in <2s and polling overhead outweighs
  // the recovery benefit.
  //
  // imagePath disables the background route — queryOpenAIBackground is
  // text-only today. Falling back to generateText preserves multimodal
  // behaviour at the cost of recoverability for that specific invocation.
  const { isOpenAIBackgroundCapable, queryOpenAIBackground } = await import("../lib/openai-deep")
  const useBackground = options.modelMode === "pro" && isOpenAIBackgroundCapable(model) && !imagePath

  // Response cache (CAS) — only for cheap deterministic single-model paths.
  // Pro modelMode is shadow-testing intent — caching there would defeat the
  // multi-model comparison. Image-bearing prompts skip too (image-as-cache-key
  // would need a hash of the bytes, deferred). Background mode skips because
  // the recovery path stores responseId, not content.
  const cacheable = !useBackground && !imagePath && options.modelMode !== "pro"
  const { readCache, writeCache } = await import("../lib/cache")
  // The route is part of the cache identity: a subscription-CLI answer and an
  // API-key answer for the same SKU are different results and must not collide
  // (bead 29147), and the CLI's model can change independently of the SKU.
  const route = resolveSubscriptionRoute(model, { hasImage: imagePath !== undefined }) ?? "key"
  const cacheKey = {
    model: model.modelId,
    prompt: enrichedQuestion,
    route,
    params: { level, modelMode: options.modelMode, maxOutputTokens: options.maxOutputTokens },
  }
  let response: ModelResponse
  // Structured facts from the dispatch error, kept beside the rendered message
  // so the envelope can expose them without a caller parsing prose (27038).
  let dispatchFailure: { httpStatus?: number; providerCode?: string } | undefined
  const cached = cacheable ? readCache<ModelResponse>(cacheKey) : null
  if (cached && outputTokenStop(cached.envelope) === undefined) {
    response = { ...cached.envelope, cacheHit: true }
    console.error(`🟢 cache hit (${cached.ts}) — ${cached.content.length} chars\n`)
    streamToken(cached.content)
  } else {
    // SIGINT/SIGTERM aborts the in-flight call — a long Pro call that the
    // user wants to kill should stop, not wait out the ai-sdk 300s default.
    // The abort reason surfaces in the response error so finishResponse can
    // write it to the output file instead of silently truncating.
    const dispatch = (signal: AbortSignal) =>
      useBackground
        ? queryOpenAIBackground({
            maxOutputTokens: options.maxOutputTokens,
            prompt: enrichedQuestion,
            model,
            topic: question,
            abortSignal: signal,
          })
        : ask(enrichedQuestion, level, {
            modelObject: model,
            maxOutputTokens: options.maxOutputTokens,
            stream: true,
            onToken: streamToken,
            imagePath,
            abortSignal: signal,
          })
    if (modelMode === "pro") {
      const startedAt = Date.now()
      response = await withSignalAbort(async (outerSignal) => {
        try {
          return await runWithTimeout({
            label: `${model.displayName} leg`,
            timeoutMs: getLegTimeoutMs(),
            outerSignal,
            run: dispatch,
          })
        } catch (error) {
          const described = describeDispatchFailure(error, model)
          dispatchFailure = {
            httpStatus: described.httpStatus,
            providerCode: described.providerCode,
          }
          return {
            model,
            content: "",
            durationMs: Date.now() - startedAt,
            error: described.message,
          }
        }
      })
    } else {
      response = await withSignalAbort(dispatch)
    }
    if (cacheable && response.content && !response.error && outputTokenStop(response) === undefined) {
      try {
        const receipt = { ...response }
        // The normalized total replaces the final call's stated amount; its raw fact remains in calls/usage.
        delete receipt.cost_usd
        writeCache(cacheKey, { ...receipt, ...serializeCost(resolveResponseCost(response)) }, response.content)
      } catch {
        // Cache write failure must not affect the user-visible call result.
      }
    }
  }
  await finishResponse(
    response.content,
    model,
    outputFile,
    sessionTag,
    response.usage,
    response.durationMs,
    question,
    response.responseId,
    options.includeQuota ? response.quota : undefined,
    // Surface the provider error (quota, rate-limit, renamed model) instead of
    // the generic "silent failure" message when the completion came back empty.
    response.error,
    options.retryCommand,
    response.servedBy,
    response,
    options.slot,
    response.failure ?? dispatchFailure,
  )
}
