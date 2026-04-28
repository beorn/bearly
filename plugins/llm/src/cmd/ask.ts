/**
 * Single-model ask + finalize. Used by `bun llm`, `bun llm --quick`,
 * and the runProDual fallback when a mainstay provider is unavailable.
 */

import { ask } from "../lib/research"
import { isProviderAvailable } from "../lib/providers"
import { getBestAvailableModel, type Model, type ModelMode, type ModelResponse } from "../lib/types"
import { emitJson } from "../lib/output-mode"
import { withSignalAbort } from "../lib/signals"

/** Shared single-model ask: select model, stream, finalize */
export async function askAndFinish(options: {
  question: string
  modelMode: ModelMode
  level: "standard" | "quick"
  header: (name: string) => string
  modelOverride: Model | undefined
  imagePath: string | undefined
  streamToken: (token: string) => void
  buildContext: (topic: string) => Promise<string | undefined>
  outputFile: string
  sessionTag: string
  /** When true, include captured rate-limit headers in the JSON envelope
   *  under `quota`. Cache update is unconditional regardless of this flag. */
  includeQuota?: boolean
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
    const result = getBestAvailableModel(modelMode, isProviderAvailable)
    if (!result.model) {
      // Error envelope on stdout (JSON mode honours the contract; legacy
      // mode also benefits — scripts that wrap llm consistently parse JSON
      // from stdout regardless of whether --json was passed).
      emitJson({ error: `No model available for ${modelMode}. ${result.warning || ""}`, status: "failed" })
      process.exit(1)
    }
    if (result.warning) console.error(`⚠️  ${result.warning}\n`)
    model = result.model
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
  const cacheKey = {
    model: model.modelId,
    prompt: enrichedQuestion,
    params: { level, modelMode: options.modelMode },
  }
  let response: ModelResponse
  const cached = cacheable ? readCache<ModelResponse>(cacheKey) : null
  if (cached) {
    response = cached.envelope
    console.error(`🟢 cache hit (${cached.ts}) — ${cached.content.length} chars\n`)
    streamToken(cached.content)
  } else {
    // SIGINT/SIGTERM aborts the in-flight call — a long Pro call that the
    // user wants to kill should stop, not wait out the ai-sdk 300s default.
    // The abort reason surfaces in the response error so finishResponse can
    // write it to the output file instead of silently truncating.
    response = await withSignalAbort((signal) =>
      useBackground
        ? queryOpenAIBackground({
            prompt: enrichedQuestion,
            model,
            topic: question,
            abortSignal: signal,
          })
        : ask(enrichedQuestion, level, {
            modelOverride: model.provider !== "ollama" ? model.modelId : undefined,
            modelObject: model.provider === "ollama" ? model : undefined,
            stream: true,
            onToken: streamToken,
            imagePath,
            abortSignal: signal,
          }),
    )
    if (cacheable && response.content && !response.error) {
      try {
        writeCache(cacheKey, response, response.content)
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
  )
}
