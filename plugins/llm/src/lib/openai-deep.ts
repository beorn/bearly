/**
 * OpenAI Deep Research using Responses API
 *
 * Background create + poll (NOT streaming). Why:
 * (2026-03-20) Streaming deep research with GPT-5.4 Pro timed out 3x in a row.
 * The streaming connection drops after ~2 min but the research continues server-side
 * for 10-15 min. With streaming, the response ID isn't captured until the first event,
 * so if the process dies before that, recovery is impossible.
 *
 * Background create returns the response ID synchronously, which we persist immediately.
 * Then we either return (fire-and-forget) or poll until completion. The response ID is
 * always captured, so recovery via `bun llm recover <id>` always works.
 *
 * The `stream` option is preserved on the public interface for API compatibility, but
 * it no longer performs real token-by-token streaming — `onToken` is invoked once with
 * the final content when the background response completes.
 */

import OpenAI from "openai"
import { createLogger } from "loggily"
import type { Model, ModelResponse } from "./types"
import { getEndpoint } from "./types"
import {
  getPartialPath,
  writePartialHeader,
  appendPartial,
  completePartial,
  updatePartialMetadata,
} from "./persistence"
import { missingApiKeyError } from "./env-preflight"
import { describeDispatchFailure } from "./dispatch-error"
import { outputTokenStop } from "./format"
import { statedCharge } from "./cost"

const log = createLogger("bearly:llm:openai")

let client: OpenAI | undefined

/** Keep the provider's original usage alongside disjoint priced token classes. */
function usageFacts(usage: OpenAI.Responses.Response["usage"]): Pick<ModelResponse, "usage" | "cost_usd"> {
  if (!usage) return {}
  const cached = usage.input_tokens_details?.cached_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  return {
    ...statedCharge(usage, "openai"),
    usage: {
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      totalTokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
      classes: {
        input: usage.input_tokens - (cached ?? 0),
        output: usage.output_tokens,
        ...(cached === undefined ? {} : { cache_read: cached }),
        ...(reasoning === undefined ? {} : { reasoning }),
      },
      raw: { ...usage },
    },
  }
}

function completionFacts(response: {
  incomplete_details?: { reason?: string } | null
  max_output_tokens?: number | null
}) {
  const reason = response.incomplete_details?.reason
  return {
    ...(reason === undefined ? {} : { rawFinishReason: reason }),
    ...(reason === "max_output_tokens" ? { finishReason: "length" } : {}),
    ...(typeof response.max_output_tokens === "number" ? { appliedMaxOutputTokens: response.max_output_tokens } : {}),
  }
}

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw missingApiKeyError("OPENAI_API_KEY")
    client = new OpenAI({ apiKey })
  }
  return client
}

/** Resolve the string sent as `model:` to the OpenAI API. Endpoint's
 *  `apiModelId` (e.g. "gpt-5-pro" for our internal "gpt-5.4-pro") wins over
 *  the SKU id. Synthetic models (CLI-injected OpenRouter SKUs not in the
 *  registry) have no endpoint entry, so this falls straight to the SKU id. */
function resolveApiModelId(model: Model): string {
  const endpoint = getEndpoint(model.modelId)
  return endpoint?.apiModelId ?? model.modelId
}

export interface DeepResearchOptions {
  topic: string
  model: Model
  /** Optional caller ceiling; intersected with model and context limits. */
  maxOutputTokens?: number
  stream?: boolean
  onToken?: (token: string) => void
  /** Use background mode for resilience (default: true for streaming) */
  background?: boolean
  /** Don't persist to temp file (default: false) */
  noPersist?: boolean
  /** Optional context to prepend to the research prompt */
  context?: string
  /** Fire-and-forget: persist response ID and exit immediately without polling (default: true) */
  fireAndForget?: boolean
  /**
   * Abort signal propagated into pollForCompletion so Ctrl-C / SIGTERM
   * during a synchronous deep-research call stops the poll cleanly. The
   * server-side response is unaffected — it remains recoverable via
   * `bun llm recover <id>` since the ID is already persisted.
   */
  abortSignal?: AbortSignal
}

/**
 * Options for a plain (non-research) Responses-API background query.
 *
 * Same persist → fire-and-forget → recoverable semantics as deep research,
 * but without `web_search_preview` — just the model completing the prompt.
 * Used by the standard `pro` path so long Pro calls survive SIGINT / network
 * hiccups / wall-clock kills.
 */
export interface BackgroundQueryOptions {
  prompt: string
  model: Model
  /** Optional caller ceiling; intersected with model and context limits. */
  maxOutputTokens?: number
  /** Topic line stored with the partial for recovery UIs (default: first 80 chars of prompt). */
  topic?: string
  /**
   * Fire-and-forget mode. When true, create the response, persist the ID,
   * and return `{ content: "", responseId }` immediately. The caller is
   * expected to surface the ID to the user for `bun llm recover` later.
   *
   * When false, create + poll until completion (happy path for fast models).
   * Either way the ID is persisted before we return — interruption loses
   * nothing. Default: false (synchronous with recovery as fallback).
   */
  fireAndForget?: boolean
  /** Don't persist to temp file (default: false). */
  noPersist?: boolean
  /** Abort signal — Ctrl-C / SIGTERM stops the poll; server-side response continues. */
  abortSignal?: AbortSignal
  /** Optional OSS streaming callback — called once with the final text when the background call completes. */
  onToken?: (token: string) => void
}

function buildResearchPrompt(topic: string, context?: string): string {
  const contextSection = context ? `## Background Context\n\n${context}\n\n---\n\n` : ""
  return `${contextSection}Research the following topic thoroughly. Provide comprehensive information with sources where possible.

Topic: ${topic}

Please provide:
1. An overview/summary
2. Key details and facts
3. Different perspectives or approaches (if applicable)
4. Recent developments or current state
5. Sources and references (if available)`
}

function formatApiError(error: unknown, model: Model): string {
  return describeDispatchFailure(error, {
    provider: "openai",
    modelId: model.modelId,
    displayName: model.displayName,
  }).message
}

/**
 * Query OpenAI deep research model using Responses API.
 *
 * Flow:
 *   1. Create the response in background mode — captures the ID synchronously.
 *   2. Persist the ID to disk so recovery works even if the process dies.
 *   3. If fire-and-forget: return immediately with the ID.
 *   4. Otherwise: poll until complete, then return the full text.
 *
 * `stream + onToken` is honored as a final one-shot callback with the completed
 * text — there is no real incremental streaming on this path (see file header).
 */
export async function queryOpenAIDeepResearch(options: DeepResearchOptions): Promise<ModelResponse> {
  const { topic, model, stream = false, onToken, noPersist = false, context } = options
  const background = options.background ?? stream
  const startTime = Date.now()
  const researchPrompt = buildResearchPrompt(topic, context)
  let maxOutputTokens: number | undefined
  if (options.maxOutputTokens !== undefined) {
    try {
      const { computeMaxOutputTokens } = await import("./research")
      maxOutputTokens = computeMaxOutputTokens(
        model,
        [{ role: "user", content: researchPrompt }],
        undefined,
        options.maxOutputTokens,
      )
    } catch (error) {
      return {
        model,
        content: "",
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  const openai = getClient()

  try {
    // Non-background path: single synchronous create. Used when caller explicitly
    // opts out (background === false). Kept for completeness; dispatch.ts + research.ts
    // default to the background+poll path.
    if (!background) {
      const response = await openai.responses.create({
        model: resolveApiModelId(model),
        input: researchPrompt,
        ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
        tools: [{ type: "web_search_preview" }],
        background: false,
      })
      const fullText = extractText(response)
      const usage = response.usage
      return {
        model,
        content: fullText,
        appliedMaxOutputTokens: maxOutputTokens,
        ...completionFacts(response),
        responseId: response.id,
        ...usageFacts(usage),
        durationMs: Date.now() - startTime,
      }
    }

    // Background path: create → persist ID → (fire-and-forget | poll).
    const initialResponse = await openai.responses.create({
      model: resolveApiModelId(model),
      input: researchPrompt,
      ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
      tools: [{ type: "web_search_preview" }],
      stream: false,
      background: true,
      store: true,
    })

    const responseId = initialResponse.id
    let partialPath = ""

    if (responseId && !noPersist) {
      partialPath = getPartialPath(responseId)
      writePartialHeader(partialPath, {
        responseId,
        model: model.displayName,
        modelId: model.modelId,
        topic,
        startedAt: new Date().toISOString(),
        ...usageFacts(initialResponse.usage),
        ...completionFacts(initialResponse),
        appliedMaxOutputTokens: maxOutputTokens,
      })
      log.info?.(`Response ID: ${responseId} (recoverable with 'bun llm recover')`)
    }

    if (options.fireAndForget) {
      const facts = {
        appliedMaxOutputTokens: maxOutputTokens,
        ...completionFacts(initialResponse),
      }
      const stopped = outputTokenStop(facts) !== undefined
      const content = stopped ? extractText(initialResponse) : ""
      const usage = initialResponse.usage
      if (stopped) {
        if (onToken && content) onToken(content)
        if (partialPath && content) appendPartial(partialPath, content)
      } else {
        console.error(`\n🔥 Fire-and-forget: response ID persisted. Recover later with:`)
        console.error(`   bun llm recover ${responseId}\n`)
      }
      return {
        model,
        content,
        responseId,
        ...facts,
        ...usageFacts(usage),
        durationMs: Date.now() - startTime,
      }
    }

    // Poll until complete. pollForCompletion handles the already-completed case
    // on its first attempt, so we don't need a separate fast-path here.
    // 50-minute ceiling (600 × 5s) matches dispatch-side recovery; historical
    // 180 × 5s = 15min timed out on long Pro deep runs. LLM_RECOVER_MAX_ATTEMPTS overrides.
    log.info?.("Research in progress...")
    const pollResult = await pollForCompletion(responseId, {
      intervalMs: 5_000,
      abortSignal: options.abortSignal,
      onProgress: (status, elapsed) => {
        process.stderr.write(`\r⏳ ${status} (${Math.round(elapsed / 1000)}s elapsed)`)
      },
    })

    if (partialPath) updatePartialMetadata(partialPath, pollResult)

    if (outputTokenStop(pollResult) !== undefined) {
      if (onToken && pollResult.content) onToken(pollResult.content)
      if (partialPath && pollResult.content) appendPartial(partialPath, pollResult.content)
      return {
        model,
        content: pollResult.content,
        responseId,
        usage: pollResult.usage,
        cost_usd: pollResult.cost_usd,
        finishReason: pollResult.finishReason,
        rawFinishReason: pollResult.rawFinishReason,
        appliedMaxOutputTokens: pollResult.appliedMaxOutputTokens ?? maxOutputTokens,
        durationMs: Date.now() - startTime,
      }
    }
    if (pollResult.status === "completed" && pollResult.content) {
      if (stream && onToken) onToken(pollResult.content)
      if (partialPath) {
        appendPartial(partialPath, pollResult.content)
        // Don't delete on completion — the partial doubles as a content cache
        // so `bun llm recover <id>` works even if the caller (dual-pro, ask)
        // is SIGKILLed between leg-completion and final output. The OpenAI
        // response object can re-enter `queued` if the background task is
        // requeued, leaving on-disk partials as the only durable record.
        // `cleanupPartials(24h)` sweeps completed entries automatically.
        completePartial(partialPath, {
          delete: false,
          ...pollResult,
        })
      }
      process.stderr.write("\n")
      return {
        model,
        content: pollResult.content,
        responseId,
        usage: pollResult.usage,
        cost_usd: pollResult.cost_usd,
        durationMs: Date.now() - startTime,
      }
    }

    const partial = pollResult.content || ""
    log.warn?.(`Research did not complete: ${pollResult.status}`)
    if (partial.length > 0) {
      log.info?.(`Recovered ${partial.length} chars of partial content`)
    } else {
      log.error?.(`No content recovered from incomplete research (status: ${pollResult.status})`)
    }
    return {
      model,
      content: partial,
      responseId,
      usage: pollResult.usage,
      cost_usd: pollResult.cost_usd,
      error: pollResult.error ?? (pollResult.status === "completed" ? undefined : "incomplete: " + pollResult.status),
      durationMs: Date.now() - startTime,
    }
  } catch (error) {
    const errorMessage = formatApiError(error, model)
    log.error?.(`Deep research error: ${errorMessage}`)
    return {
      model,
      content: "",
      durationMs: Date.now() - startTime,
      error: errorMessage,
    }
  }
}

/**
 * Query any OpenAI chat/reasoning model via the Responses API with
 * `background: true`. Persists the response ID to disk synchronously,
 * so recovery via `bun llm recover <id>` works even if the process dies
 * mid-poll.
 *
 * Shape is intentionally narrower than `queryOpenAIDeepResearch`:
 *   - No `web_search_preview` tool (this is plain chat, not research)
 *   - No research prompt wrapper (caller passes the final prompt verbatim)
 *   - No system-prompt plumbing yet (none of our standard-pro callers need it)
 *
 * Recovery semantics mirror deep research: every call writes a partial with
 * the response ID, model, and topic so `bun llm recover <id>` (and the
 * auto-recover sweep on the next invocation) picks it up uniformly. If the
 * caller sets `fireAndForget: true` we skip polling and return `content: ""`
 * with the ID — dual-pro uses this so a 30-min Pro leg can survive Ctrl-C.
 */
export async function queryOpenAIBackground(options: BackgroundQueryOptions): Promise<ModelResponse> {
  const { prompt, model, onToken, noPersist = false } = options
  const startTime = Date.now()
  let maxOutputTokens: number | undefined
  if (options.maxOutputTokens !== undefined) {
    try {
      const { computeMaxOutputTokens } = await import("./research")
      maxOutputTokens = computeMaxOutputTokens(
        model,
        [{ role: "user", content: prompt }],
        undefined,
        options.maxOutputTokens,
      )
    } catch (error) {
      return {
        model,
        content: "",
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  const openai = getClient()
  const topic = options.topic ?? prompt.slice(0, 80)

  try {
    // Create in background mode so the ID is captured synchronously — that's
    // the whole point: even if the process dies on the next tick, the work
    // continues server-side and is recoverable via the persisted ID.
    const initialResponse = await openai.responses.create({
      model: resolveApiModelId(model),
      input: prompt,
      ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
      stream: false,
      background: true,
      store: true,
    })

    const responseId = initialResponse.id
    let partialPath = ""

    if (responseId && !noPersist) {
      partialPath = getPartialPath(responseId)
      writePartialHeader(partialPath, {
        responseId,
        model: model.displayName,
        modelId: model.modelId,
        topic,
        startedAt: new Date().toISOString(),
        ...usageFacts(initialResponse.usage),
        ...completionFacts(initialResponse),
        appliedMaxOutputTokens: maxOutputTokens,
      })
      log.info?.(`Response ID: ${responseId} (recoverable with 'bun llm recover')`)
    }

    if (options.fireAndForget) {
      const facts = {
        appliedMaxOutputTokens: maxOutputTokens,
        ...completionFacts(initialResponse),
      }
      const stopped = outputTokenStop(facts) !== undefined
      const content = stopped ? extractText(initialResponse) : ""
      const usage = initialResponse.usage
      if (stopped) {
        if (onToken && content) onToken(content)
        if (partialPath && content) appendPartial(partialPath, content)
      } else {
        console.error(`\n🔥 Fire-and-forget: response ID persisted. Recover later with:`)
        console.error(`   bun llm recover ${responseId}\n`)
      }
      return {
        model,
        content,
        responseId,
        ...facts,
        ...usageFacts(usage),
        durationMs: Date.now() - startTime,
      }
    }

    // Happy path: poll until complete. Matches the 50-min ceiling used by
    // deep research — a standard Pro call is much shorter in practice but
    // we prefer one behaviour across paths over bespoke per-model tuning.
    const pollResult = await pollForCompletion(responseId, {
      intervalMs: 5_000,
      abortSignal: options.abortSignal,
      onProgress: (status, elapsed) => {
        process.stderr.write(`\r⏳ ${status} (${Math.round(elapsed / 1000)}s elapsed)`)
      },
    })

    if (partialPath) updatePartialMetadata(partialPath, pollResult)

    if (outputTokenStop(pollResult) !== undefined) {
      if (onToken && pollResult.content) onToken(pollResult.content)
      if (partialPath && pollResult.content) appendPartial(partialPath, pollResult.content)
      return {
        model,
        content: pollResult.content,
        responseId,
        usage: pollResult.usage,
        cost_usd: pollResult.cost_usd,
        finishReason: pollResult.finishReason,
        rawFinishReason: pollResult.rawFinishReason,
        appliedMaxOutputTokens: pollResult.appliedMaxOutputTokens ?? maxOutputTokens,
        durationMs: Date.now() - startTime,
      }
    }
    if (pollResult.status === "completed" && pollResult.content) {
      if (onToken) onToken(pollResult.content)
      if (partialPath) {
        appendPartial(partialPath, pollResult.content)
        // See deep-research path above for the don't-delete-on-completion
        // rationale: keeps partial as a recovery cache for SIGKILL between
        // leg-completion and dispatcher's final-output write.
        completePartial(partialPath, {
          delete: false,
          ...pollResult,
        })
      }
      if (process.stderr.isTTY) process.stderr.write("\n")
      return {
        model,
        content: pollResult.content,
        responseId,
        usage: pollResult.usage,
        cost_usd: pollResult.cost_usd,
        durationMs: Date.now() - startTime,
      }
    }

    // Incomplete — return whatever content we have plus the ID so callers
    // can surface "still running, recover later" without losing context.
    const partial = pollResult.content || ""
    if (pollResult.status === "aborted") {
      log.warn?.(`Polling aborted locally — server-side response ${responseId} still running`)
    } else {
      log.warn?.(`Response did not complete: ${pollResult.status}`)
    }
    return {
      model,
      content: partial,
      responseId,
      usage: pollResult.usage,
      cost_usd: pollResult.cost_usd,
      durationMs: Date.now() - startTime,
      error: pollResult.status === "completed" ? undefined : (pollResult.error ?? `incomplete: ${pollResult.status}`),
    }
  } catch (error) {
    const errorMessage = formatApiError(error, model)
    log.error?.(`Background query error: ${errorMessage}`)
    return {
      model,
      content: "",
      durationMs: Date.now() - startTime,
      error: errorMessage,
    }
  }
}

/**
 * Whether a model can be routed through the Responses API for recoverable
 * background execution. Capability-driven: the endpoint map flags every
 * non-deep-research OpenAI SKU with `backgroundApi: true`. Other providers
 * default to false until they ship a comparable mechanism. Deep-research
 * models go through `queryOpenAIDeepResearch` (web_search_preview path) and
 * are intentionally NOT flagged here — they're covered by `isOpenAIDeepResearch`.
 */
export function isOpenAIBackgroundCapable(model: Model): boolean {
  const endpoint = getEndpoint(model.modelId)
  return Boolean(endpoint?.capabilities.backgroundApi) && !model.isDeepResearch
}

/** Extract concatenated output_text from a Responses API result. */
function extractText(response: { output?: Array<any> }): string {
  let text = ""
  for (const item of response.output || []) {
    if (item.type === "message" && item.content) {
      for (const content of item.content) {
        if (content.type === "output_text") text += content.text || ""
      }
    }
  }
  return text
}

/**
 * Poll for a background response to complete
 */
export async function pollForCompletion(
  responseId: string,
  options: {
    intervalMs?: number
    maxAttempts?: number
    onProgress?: (status: string, elapsedMs: number) => void
    /**
     * AbortSignal that short-circuits the poll loop. On abort, returns a
     * "cancelled" result with the abort reason — callers (dispatch.ts wiring
     * SIGINT/SIGTERM) can treat it the same as a user cancellation without
     * the poll leaking sleep ticks. We don't try to cancel the server-side
     * response; the Responses API keeps it accessible via `retrieveResponse`
     * for later `bun llm recover`.
     */
    abortSignal?: AbortSignal
  } = {},
): Promise<{
  status: string
  content: string
  finishReason?: string
  rawFinishReason?: string
  appliedMaxOutputTokens?: number
  usage?: ModelResponse["usage"]
  cost_usd?: number
  error?: string
}> {
  // Default ceiling: 600 × 5s = 50 minutes (parity with dispatch.ts recover
  // path). LLM_RECOVER_MAX_ATTEMPTS overrides. Historical 180 was 15 min —
  // too short for real Pro deep runs, which routinely take 30-40 min.
  const envMax = Number.parseInt(process.env.LLM_RECOVER_MAX_ATTEMPTS ?? "", 10)
  const defaultMax = Number.isFinite(envMax) && envMax > 0 ? envMax : 600
  const { intervalMs = 5_000, maxAttempts = defaultMax, abortSignal } = options
  const startTime = Date.now()

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (abortSignal?.aborted) {
      // "aborted" = local client cancellation; distinct from "cancelled"
      // which is reserved for remote provider-terminated runs. The
      // distinction matters for recovery: a local Ctrl-C during `recover`
      // must NOT delete the partial file, while a remote-cancelled run
      // should. Flagged in Pro round-2 review 2026-04-21.
      return {
        status: "aborted",
        content: "",
        error: `Polling aborted: ${String(abortSignal.reason ?? "local-interrupt")}`,
      }
    }

    const result = await retrieveResponse(responseId)

    if (result.error) {
      return result
    }

    if (result.status === "completed" || result.status === "incomplete") {
      return result
    }

    if (result.status === "failed" || result.status === "cancelled" || result.status === "expired") {
      return { ...result, error: `Response ${result.status}` }
    }

    // Still in progress or queued - wait and retry. sleep() is interruptible
    // via abortSignal so Ctrl-C doesn't have to wait for the next 5s tick.
    options.onProgress?.(result.status, Date.now() - startTime)
    await sleepAbortable(intervalMs, abortSignal)
  }

  return {
    status: "timeout",
    content: "",
    error: `Timed out after ${maxAttempts} attempts (${Math.round((maxAttempts * intervalMs) / 1000)}s)`,
  }
}

/**
 * Abortable sleep — resolves on timer elapse OR on signal abort, whichever
 * comes first. Exported so pollForCompletion and pollForGeminiCompletion
 * share one implementation.
 */
export function sleepAbortable(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        resolve()
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}

/**
 * Retrieve a response by ID from OpenAI
 */
export async function retrieveResponse(responseId: string): Promise<{
  status: string
  content: string
  finishReason?: string
  rawFinishReason?: string
  appliedMaxOutputTokens?: number
  usage?: ModelResponse["usage"]
  cost_usd?: number
  error?: string
}> {
  const openai = getClient()

  try {
    const response = await openai.responses.retrieve(responseId)
    const usage = response.usage
    // A stored response can come back "failed" with the provider's own cause in
    // `response.error`. Without this the normalized return carries no reason and
    // `llm await`/`llm recover` can only say "Response failed" (29325).
    const providerError = response.error
    return {
      status: response.status ?? "unknown",
      content: extractText(response),
      ...completionFacts(response),
      ...usageFacts(usage),
      error: providerError ? `${providerError.code}: ${providerError.message}` : undefined,
    }
  } catch (error) {
    return {
      status: "error",
      content: "",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Check if a model is an OpenAI deep research model. Capability-driven:
 * `webSearch` flags routing through the OpenAI Responses API web_search_preview
 * tool, `deepResearch` flags dedicated DR SKUs (slow, expensive). The combined
 * check picks exactly the OpenAI DR SKUs — Perplexity / Gemini DR variants
 * are flagged `deepResearch: true` but `webSearch: false` (they use their
 * own provider APIs) and correctly fall through.
 */
export function isOpenAIDeepResearch(model: Model): boolean {
  const endpoint = getEndpoint(model.modelId)
  return Boolean(endpoint?.capabilities.deepResearch && endpoint?.capabilities.webSearch)
}
