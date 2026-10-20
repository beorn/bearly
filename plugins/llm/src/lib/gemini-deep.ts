/**
 * Gemini Deep Research using the Interactions API
 *
 * Uses REST API directly since the Gemini Deep Research agent
 * requires the Interactions API endpoint, not the standard
 * generateContent/streamGenerateContent endpoints.
 *
 * Features:
 * - Background mode: server continues even if client disconnects
 * - Streaming: SSE events for real-time progress
 * - Polling: retrieves completed responses by interaction ID
 */

import { createLogger } from "loggily"
import type { Model, ModelResponse } from "./types"
import { getEndpoint } from "./types"
import {
  getPartialPath,
  writePartialHeader,
  appendPartial,
  completePartial,
  findPartialByResponseId,
  updatePartialMetadata,
} from "./persistence"
import { statedCharge } from "./cost"
import { missingApiKeyError } from "./env-preflight"

const log = createLogger("bearly:llm:gemini")

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"

function getApiKey(): string {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!apiKey) throw missingApiKeyError("GOOGLE_GENERATIVE_AI_API_KEY")
  return apiKey
}

export interface GeminiDeepResearchOptions {
  /** Explicit bounds are refused until the agent API supports an output ceiling. */
  maxOutputTokens?: number
  topic: string
  model: Model
  stream?: boolean
  onToken?: (token: string) => void
  /** Don't persist to temp file (default: false) */
  noPersist?: boolean
  /** Optional context to prepend to the research prompt */
  context?: string
  /**
   * Abort signal propagated into pollForGeminiCompletion so Ctrl-C /
   * SIGTERM stops the poll cleanly during a synchronous deep-research call.
   * The server-side interaction is unaffected — its ID is persisted and
   * recoverable via `bun llm recover <id>`.
   */
  abortSignal?: AbortSignal
}

interface InteractionResponse {
  id: string
  status: string
  steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>
  cost_usd?: number
  error?: { message?: string; code?: number }
  usage?: {
    total_input_tokens?: number
    total_output_tokens?: number
    total_thought_tokens?: number
    total_cached_tokens?: number
    total_tokens?: number
    total_tool_use_tokens?: number
    input_tokens_by_modality?: Array<{ modality: string; tokens: number }>
    output_tokens_by_modality?: Array<{ modality: string; tokens: number }>
    [key: string]: unknown
  }
}

/**
 * Create a deep research interaction via the Interactions API
 */
async function createInteraction(input: string, agent: string, options: { stream?: boolean } = {}): Promise<Response> {
  const apiKey = getApiKey()
  const url = options.stream ? `${BASE_URL}?alt=sse&key=${apiKey}` : `${BASE_URL}?key=${apiKey}`

  const body = {
    input,
    agent,
    background: true,
  }

  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

/**
 * Retrieve an interaction by ID
 */
async function getInteraction(interactionId: string): Promise<InteractionResponse> {
  const apiKey = getApiKey()
  const resp = await fetch(`${BASE_URL}/${interactionId}?key=${apiKey}`)

  if (!resp.ok) {
    const text = await resp.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch (cause) {
      throw new Error(`Gemini API error (${resp.status}): ${text}`, { cause })
    }
    throw new Error(`Gemini API error (${resp.status}): ${text}`, { cause: body })
  }

  return resp.json() as Promise<InteractionResponse>
}

/**
 * Extract the final model output from documented Interactions steps.
 */
function extractText(interaction: InteractionResponse): string {
  const lastOutput = interaction.steps?.filter((step) => step.type === "model_output").at(-1)
  return (
    lastOutput?.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n") ?? ""
  )
}

/**
 * Extract usage from interaction response
 */
function extractUsage(interaction: InteractionResponse): ModelResponse["usage"] {
  const meta = interaction.usage
  if (!meta) return undefined
  // Interactions output and thought counts are disjoint. Our output class
  // includes thought; reasoning remains its informational subset.
  // https://ai.google.dev/api/interactions-api
  const output =
    meta.total_output_tokens !== undefined && meta.total_thought_tokens !== undefined
      ? meta.total_output_tokens + meta.total_thought_tokens
      : undefined
  const input =
    meta.total_input_tokens !== undefined && meta.total_cached_tokens !== undefined
      ? meta.total_input_tokens - meta.total_cached_tokens
      : undefined
  const classes = Object.fromEntries([
    ...Object.entries({
      input,
      output,
      cache_read: meta.total_cached_tokens,
      reasoning: meta.total_thought_tokens,
      tool: meta.total_tool_use_tokens,
    }).filter((entry): entry is [string, number] => entry[1] !== undefined),
    ...(meta.input_tokens_by_modality ?? [])
      .filter((part) => part.modality !== "text")
      .map((part) => [`input_${part.modality}`, part.tokens]),
    ...(meta.output_tokens_by_modality ?? [])
      .filter((part) => part.modality !== "text")
      .map((part) => [`output_${part.modality}`, part.tokens]),
  ])
  return {
    ...(meta.total_input_tokens === undefined ? {} : { promptTokens: meta.total_input_tokens }),
    ...(output === undefined ? {} : { completionTokens: output }),
    ...(meta.total_tokens === undefined ? {} : { totalTokens: meta.total_tokens }),
    classes,
    raw: meta,
  }
}

/**
 * Query Gemini deep research model using the Interactions API
 */
export async function queryGeminiDeepResearch(options: GeminiDeepResearchOptions): Promise<ModelResponse> {
  const { topic, model, stream = false, onToken, noPersist = false, context, abortSignal } = options
  const startTime = Date.now()
  const retained: Pick<ModelResponse, "content" | "usage" | "cost_usd" | "responseId"> = { content: "" }

  // Build the research prompt with optional context
  const contextSection = context ? `## Background Context\n\n${context}\n\n---\n\n` : ""

  const researchPrompt = `${contextSection}Research the following topic thoroughly. Provide comprehensive information with sources where possible.

Topic: ${topic}

Please provide:
1. An overview/summary
2. Key details and facts
3. Different perspectives or approaches (if applicable)
4. Recent developments or current state
5. Sources and references (if available)`

  try {
    if (options.maxOutputTokens !== undefined) {
      const { computeMaxOutputTokens } = await import("./research")
      computeMaxOutputTokens(model, [{ role: "user", content: researchPrompt }], undefined, options.maxOutputTokens)
      // Interactions generation_config.max_output_tokens applies only to model
      // interactions; Deep Research uses agent and has no verified output bound.
      // https://ai.google.dev/api/interactions-api
      throw new Error(
        `${model.displayName} (${model.modelId}): Gemini Deep Research agent cannot honor maxOutputTokens=${options.maxOutputTokens}; request refused before dispatch.`,
      )
    }
    // Streaming is disabled pending verification of the SSE event shape.
    // The current parser speculates on `content.delta` / `delta.text`, which
    // don't match the Gemini Interactions API (that API emits {candidates:[…]}
    // SSE frames). Until we have a live probe, force the polling path — it
    // works, it's just less responsive. The `stream` / `onToken` parameters
    // are accepted so callers don't need to change; onToken simply fires once
    // with the final content from the poll path.
    void stream
    void onToken
    return await queryWithPolling(researchPrompt, model, topic, startTime, retained, onToken, noPersist, abortSignal)
  } catch (error) {
    let errorMessage = error instanceof Error ? error.message : String(error)

    if (errorMessage.includes("403") || errorMessage.includes("PERMISSION_DENIED")) {
      errorMessage = "Permission denied. Check your GOOGLE_GENERATIVE_AI_API_KEY and ensure the Gemini API is enabled."
    } else if (errorMessage.includes("429") || errorMessage.includes("RESOURCE_EXHAUSTED")) {
      errorMessage = "Rate limited. Wait a moment and try again."
    } else if (errorMessage.includes("400") || errorMessage.includes("INVALID_ARGUMENT")) {
      errorMessage = `Invalid request: ${errorMessage}`
    }

    log.error?.(`Gemini deep research error: ${errorMessage}`)

    return {
      model,
      ...retained,
      durationMs: Date.now() - startTime,
      error: errorMessage,
    }
  }
}

/**
 * Non-streaming mode: create interaction then poll until complete.
 *
 * Streaming (SSE) was removed 2026-04-20 because the parser speculated on
 * `content.delta` / `delta.text` field names that don't match the actual
 * Gemini Interactions API. The polling path has always been the reliable
 * fallback; make it the only path until someone probes the live API and
 * rewrites the SSE parser against real event frames.
 */
async function queryWithPolling(
  prompt: string,
  model: Model,
  topic: string,
  startTime: number,
  retained: Pick<ModelResponse, "content" | "usage" | "cost_usd" | "responseId">,
  onToken?: (token: string) => void,
  noPersist?: boolean,
  abortSignal?: AbortSignal,
): Promise<ModelResponse> {
  const resp = await createInteraction(prompt, model.modelId)

  const text = await resp.text()
  let initial: InteractionResponse
  try {
    initial = JSON.parse(text) as InteractionResponse
  } catch (cause) {
    throw new Error(`Gemini API response (${resp.status}): ${text}`, { cause })
  }
  Object.assign(retained, {
    content: extractText(initial),
    usage: extractUsage(initial),
    responseId: initial.id,
    ...statedCharge(initial.usage, "google"),
    ...statedCharge(initial, "google"),
  })
  if (!initial.id) {
    if (!resp.ok) throw new Error(`Gemini API error (${resp.status}): ${text}`)
    throw new Error("No interaction ID in response")
  }

  const interactionId = initial.id
  let partialPath = ""

  if (!noPersist) {
    partialPath = getPartialPath(interactionId)
    writePartialHeader(partialPath, {
      responseId: interactionId,
      model: model.displayName,
      modelId: model.modelId,
      topic,
      startedAt: new Date().toISOString(),
      usage: retained.usage,
      cost_usd: retained.cost_usd,
    })
  }
  if (!resp.ok) {
    const error = `Gemini API error (${resp.status}): ${text}`
    if (partialPath) updatePartialMetadata(partialPath, { error })
    throw new Error(error)
  }

  // If already completed (unlikely for deep research but handle it)
  if (initial.status === "completed") {
    const content = extractText(initial)
    if (onToken && content) onToken(content)
    // Keep completed partials on disk as a recovery cache. See openai-deep.ts
    // for the SIGKILL-between-leg-completion-and-final-output rationale.
    // cleanupPartials(24h) ages them out.
    if (partialPath) {
      appendPartial(partialPath, content)
      completePartial(partialPath, { delete: false, usage: retained.usage, cost_usd: retained.cost_usd })
    }

    return {
      model,
      ...retained,
      durationMs: Date.now() - startTime,
    }
  }
  if (["failed", "cancelled", "expired"].includes(initial.status)) {
    const error = initial.error?.message ?? `Research ${initial.status}`
    if (partialPath) updatePartialMetadata(partialPath, { error })
    throw new Error(error)
  }

  // Poll until complete
  log.info?.(`Deep research started (${interactionId}), polling...`)
  const result = await pollForGeminiCompletion(interactionId, {
    intervalMs: 10_000,
    maxAttempts: 120, // 20 min max
    abortSignal,
    onProgress: (status, elapsed) => {
      process.stderr.write(`\r⏳ ${status} (${Math.round(elapsed / 1000)}s elapsed)`)
    },
  })
  process.stderr.write("\n")
  Object.assign(retained, {
    content: result.content || retained.content,
    usage: result.usage ?? retained.usage,
    cost_usd: result.cost_usd ?? retained.cost_usd,
  })
  if (partialPath)
    updatePartialMetadata(partialPath, { usage: retained.usage, cost_usd: retained.cost_usd, error: result.error })

  if (result.error) {
    // Keep failed and locally interrupted receipts available to recovery.
    return {
      model,
      ...retained,
      durationMs: Date.now() - startTime,
      error: result.error,
    }
  }

  if (onToken && result.content) onToken(result.content)
  // Keep completed partials on disk; SIGKILL-recovery cache. See above.
  if (partialPath) {
    appendPartial(partialPath, retained.content)
    completePartial(partialPath, { delete: false, usage: retained.usage, cost_usd: retained.cost_usd })
  }

  return {
    model,
    ...retained,
    durationMs: Date.now() - startTime,
  }
}

/**
 * Poll for a Gemini interaction to complete
 */
export async function pollForGeminiCompletion(
  interactionId: string,
  options: {
    intervalMs?: number
    maxAttempts?: number
    onProgress?: (status: string, elapsedMs: number) => void
    /**
     * AbortSignal that short-circuits the poll loop. Same semantics as
     * pollForCompletion (openai-deep) — returns a "cancelled" result so the
     * SIGINT/SIGTERM wiring in dispatch.ts can surface the cancellation
     * without leaking the next 10s tick.
     */
    abortSignal?: AbortSignal
  } = {},
): Promise<{
  status: string
  content: string
  usage?: ModelResponse["usage"]
  cost_usd?: number
  error?: string
}> {
  const { intervalMs = 10_000, maxAttempts = 120, abortSignal } = options
  const { sleepAbortable } = await import("./openai-deep")
  const startTime = Date.now()
  const partial = findPartialByResponseId(interactionId)
  let latest: Pick<ModelResponse, "content" | "usage" | "cost_usd"> = {
    content: "",
    usage: partial?.metadata.usage,
    cost_usd: partial?.metadata.cost_usd,
  }
  let lastError: string | undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (abortSignal?.aborted) {
      // Local-abort status, mirroring openai-deep — "aborted" ≠ "cancelled".
      // See openai-deep pollForCompletion for why the distinction matters
      // for recovery partial cleanup.
      return {
        status: "aborted",
        ...latest,
        error: `Polling aborted: ${String(abortSignal.reason ?? "local-interrupt")}`,
      }
    }

    let retrieved = false
    try {
      const interaction = await getInteraction(interactionId)
      retrieved = true
      latest = {
        ...latest,
        content: extractText(interaction) || latest.content,
        usage: extractUsage(interaction) ?? latest.usage,
        ...statedCharge(interaction.usage, "google"),
        ...statedCharge(interaction, "google"),
      }
      lastError = undefined
      if (partial) updatePartialMetadata(partial.path, latest)

      if (interaction.status === "completed") {
        return {
          status: "completed",
          ...latest,
        }
      }

      if (interaction.status === "failed") {
        return {
          status: "failed",
          ...latest,
          error: interaction.error?.message || "Research failed",
        }
      }

      if (interaction.status === "cancelled") {
        return {
          status: "cancelled",
          ...latest,
          error: "Research was cancelled",
        }
      }

      // Gemini can surface "expired" the same way OpenAI does (long-idle
      // server-side response with a TTL). Treat it terminally so we stop
      // burning polls. Flagged by K2.6 round-3 review.
      if (interaction.status === "expired") {
        return {
          status: "expired",
          ...latest,
          error: "Research expired",
        }
      }

      // Still in progress - wait and retry
      options.onProgress?.(interaction.status || "in_progress", Date.now() - startTime)
    } catch (err) {
      if (err instanceof Error && err.cause && typeof err.cause === "object") {
        const interaction = err.cause as InteractionResponse
        latest = {
          ...latest,
          usage: extractUsage(interaction) ?? latest.usage,
          ...statedCharge(interaction.usage, "google"),
          ...statedCharge(interaction, "google"),
        }
      }
      lastError = err instanceof Error ? err.message : String(err)
      // A failed local write is not a transient provider read; return the
      // accepted receipt and the actual path error instead of polling again.
      if (retrieved) return { status: "error", ...latest, error: lastError }
      // Network errors during polling are transient - keep trying
      options.onProgress?.(
        `error (retrying): ${err instanceof Error ? err.message : String(err)}`,
        Date.now() - startTime,
      )
    }

    await sleepAbortable(intervalMs, abortSignal)
  }

  return {
    status: abortSignal?.aborted ? "aborted" : lastError === undefined ? "timeout" : "error",
    ...latest,
    error: abortSignal?.aborted
      ? `Polling aborted: ${String(abortSignal.reason ?? "local-interrupt")}`
      : (lastError ?? `Timed out after ${maxAttempts} attempts (${Math.round((maxAttempts * intervalMs) / 1000)}s)`),
  }
}

/**
 * Check if a model is a Gemini deep research model. Capability-driven:
 * Gemini DR SKUs are flagged `deepResearch: true` (no `webSearch` — that
 * flag is reserved for the OpenAI Responses API path). Combined with the
 * provider check (Gemini has its own Interactions API for DR), this picks
 * the right dispatch.
 */
export function isGeminiDeepResearch(model: Model): boolean {
  const endpoint = getEndpoint(model.modelId)
  return Boolean(endpoint?.capabilities.deepResearch && endpoint?.provider === "google")
}
