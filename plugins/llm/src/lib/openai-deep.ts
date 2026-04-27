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
import { getPartialPath, writePartialHeader, appendPartial, completePartial } from "./persistence"

const log = createLogger("bearly:llm:openai")

let client: OpenAI | undefined

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error("OPENAI_API_KEY not set")
    client = new OpenAI({ apiKey })
  }
  return client
}

export interface DeepResearchOptions {
  topic: string
  model: Model
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

function formatApiError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)

  const errorMap: Array<{ match: string; message: string }> = [
    {
      match: "verified",
      message: "Organization not verified. Visit https://platform.openai.com/settings/organization/general to verify.",
    },
    { match: "rate_limit", message: "Rate limited. Wait a moment and try again." },
    { match: "429", message: "Rate limited. Wait a moment and try again." },
    {
      match: "insufficient_quota",
      message: "Insufficient credits. Check your OpenAI billing at https://platform.openai.com/account/billing",
    },
    {
      match: "billing",
      message: "Insufficient credits. Check your OpenAI billing at https://platform.openai.com/account/billing",
    },
    { match: "invalid_api_key", message: "Invalid API key. Check OPENAI_API_KEY environment variable." },
    { match: "401", message: "Invalid API key. Check OPENAI_API_KEY environment variable." },
  ]

  for (const { match, message } of errorMap) {
    if (msg.includes(match)) return message
  }
  return msg
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
  const openai = getClient()
  const researchPrompt = buildResearchPrompt(topic, context)

  try {
    // Non-background path: single synchronous create. Used when caller explicitly
    // opts out (background === false). Kept for completeness; dispatch.ts + research.ts
    // default to the background+poll path.
    if (!background) {
      const response = await openai.responses.create({
        model: model.apiModelId ?? model.modelId,
        input: researchPrompt,
        tools: [{ type: "web_search_preview" }],
        background: false,
      })
      const fullText = extractText(response)
      const usage = response.usage
      return {
        model,
        content: fullText,
        responseId: response.id,
        usage: usage
          ? {
              promptTokens: usage.input_tokens || 0,
              completionTokens: usage.output_tokens || 0,
              totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
            }
          : undefined,
        durationMs: Date.now() - startTime,
      }
    }

    // Background path: create → persist ID → (fire-and-forget | poll).
    const initialResponse = await openai.responses.create({
      model: model.apiModelId ?? model.modelId,
      input: researchPrompt,
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
      })
      log.info?.(`Response ID: ${responseId} (recoverable with 'bun llm recover')`)
    }

    if (options.fireAndForget) {
      console.error(`\n🔥 Fire-and-forget: response ID persisted. Recover later with:`)
      console.error(`   bun llm recover ${responseId}\n`)
      return {
        model,
        content: "",
        responseId,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
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

    if (pollResult.status === "completed" && pollResult.content) {
      if (stream && onToken) onToken(pollResult.content)
      if (partialPath) {
        appendPartial(partialPath, pollResult.content)
        completePartial(partialPath, {
          delete: true,
          usage: {
            promptTokens: pollResult.usage?.promptTokens ?? 0,
            completionTokens: pollResult.usage?.completionTokens ?? 0,
            totalTokens: pollResult.usage?.totalTokens ?? 0,
          },
        })
      }
      process.stderr.write("\n")
      return {
        model,
        content: pollResult.content,
        responseId,
        usage: {
          promptTokens: pollResult.usage?.promptTokens ?? 0,
          completionTokens: pollResult.usage?.completionTokens ?? 0,
          totalTokens: pollResult.usage?.totalTokens ?? 0,
        },
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
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      durationMs: Date.now() - startTime,
    }
  } catch (error) {
    const errorMessage = formatApiError(error)
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
  const openai = getClient()
  const topic = options.topic ?? prompt.slice(0, 80)

  try {
    // Create in background mode so the ID is captured synchronously — that's
    // the whole point: even if the process dies on the next tick, the work
    // continues server-side and is recoverable via the persisted ID.
    const initialResponse = await openai.responses.create({
      model: model.apiModelId ?? model.modelId,
      input: prompt,
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
      })
      log.info?.(`Response ID: ${responseId} (recoverable with 'bun llm recover')`)
    }

    if (options.fireAndForget) {
      console.error(`\n🔥 Fire-and-forget: response ID persisted. Recover later with:`)
      console.error(`   bun llm recover ${responseId}\n`)
      return {
        model,
        content: "",
        responseId,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
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

    if (pollResult.status === "completed" && pollResult.content) {
      if (onToken) onToken(pollResult.content)
      if (partialPath) {
        appendPartial(partialPath, pollResult.content)
        completePartial(partialPath, {
          delete: true,
          usage: {
            promptTokens: pollResult.usage?.promptTokens ?? 0,
            completionTokens: pollResult.usage?.completionTokens ?? 0,
            totalTokens: pollResult.usage?.totalTokens ?? 0,
          },
        })
      }
      if (process.stderr.isTTY) process.stderr.write("\n")
      return {
        model,
        content: pollResult.content,
        responseId,
        usage: {
          promptTokens: pollResult.usage?.promptTokens ?? 0,
          completionTokens: pollResult.usage?.completionTokens ?? 0,
          totalTokens: pollResult.usage?.totalTokens ?? 0,
        },
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
      usage: {
        promptTokens: pollResult.usage?.promptTokens ?? 0,
        completionTokens: pollResult.usage?.completionTokens ?? 0,
        totalTokens: pollResult.usage?.totalTokens ?? 0,
      },
      durationMs: Date.now() - startTime,
      error: pollResult.status === "completed" ? undefined : (pollResult.error ?? `incomplete: ${pollResult.status}`),
    }
  } catch (error) {
    const errorMessage = formatApiError(error)
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
 * background execution. Every OpenAI model supports the Responses API;
 * other providers don't (OpenRouter/K2.6 routes through a Chat Completions
 * shim, Anthropic/Google have their own APIs). Deep-research models use
 * `queryOpenAIDeepResearch` which injects `web_search_preview` — they're
 * covered by `isOpenAIDeepResearch` and NOT by this predicate.
 */
export function isOpenAIBackgroundCapable(model: Model): boolean {
  return model.provider === "openai" && !model.isDeepResearch
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
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
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

    if (result.status === "completed") {
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
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  error?: string
}> {
  const openai = getClient()

  try {
    const response = await openai.responses.retrieve(responseId)
    const usage = response.usage
    return {
      status: response.status ?? "unknown",
      content: extractText(response),
      usage: usage
        ? {
            promptTokens: usage.input_tokens || 0,
            completionTokens: usage.output_tokens || 0,
            totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
          }
        : undefined,
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
 * Check if a model is an OpenAI deep research model
 */
export function isOpenAIDeepResearch(model: Model): boolean {
  return model.provider === "openai" && model.isDeepResearch
}
