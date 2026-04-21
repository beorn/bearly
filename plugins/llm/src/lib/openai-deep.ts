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
        model: model.modelId,
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
      model: model.modelId,
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
      return {
        status: "cancelled",
        content: "",
        error: `Polling cancelled: ${String(abortSignal.reason ?? "aborted")}`,
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
