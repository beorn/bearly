/**
 * OpenAI Deep Research using Responses API
 *
 * Uses background create + poll (NOT streaming). Why:
 * (2026-03-20) Streaming deep research with GPT-5.4 Pro timed out 3x in a row.
 * The streaming connection drops after ~2 min but the research continues server-side
 * for 10-15 min. With streaming, the response ID isn't captured until the first event,
 * so if the process dies before that, recovery is impossible.
 *
 * Background create returns the response ID synchronously, which we persist immediately.
 * Then we poll until completion. This is slower to show incremental progress but 100%
 * reliable — the response ID is always captured, and recovery always works.
 *
 * Features:
 * - Background mode: server continues even if client disconnects
 * - Immediate ID persistence: response ID written to disk before any async work
 * - Recovery: can retrieve responses by ID via `bun llm recover`
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
}

/**
 * Query OpenAI deep research model using Responses API
 */
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

async function handleStreamingResponse(
  openai: ReturnType<typeof getClient>,
  researchPrompt: string,
  options: DeepResearchOptions & { background: boolean },
): Promise<{ fullText: string; responseId: string; promptTokens: number; completionTokens: number }> {
  const { model, topic, onToken, noPersist = false } = options

  // Step 1: Create in background mode (non-streaming) — gets response ID immediately
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

  // Step 2: Persist response ID immediately — recovery works even if process dies
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

  // Step 3: If fire-and-forget mode, stop here — ID is persisted, recover later
  if (options.fireAndForget) {
    console.error(`\n🔥 Fire-and-forget: response ID persisted. Recover later with:`)
    console.error(`   bun llm recover ${responseId}\n`)
    return {
      fullText: "",
      responseId,
      promptTokens: 0,
      completionTokens: 0,
    }
  }

  // Step 4: If already completed (fast models), extract immediately
  if (initialResponse.status === "completed") {
    const result = extractResponseText(initialResponse)
    if (onToken && result.text) onToken(result.text)
    if (partialPath) completePartial(partialPath, { delete: true, usage: result.usage })
    return {
      fullText: result.text,
      responseId,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
    }
  }

  // Step 5: Poll until complete — no streaming, just check periodically
  log.info?.("Research in progress...")
  const pollResult = await pollForCompletion(responseId, {
    intervalMs: 5_000,
    maxAttempts: 180,
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
    process.stderr.write("\n")
    return {
      fullText: pollResult.content,
      responseId,
      promptTokens: pollResult.usage?.promptTokens ?? 0,
      completionTokens: pollResult.usage?.completionTokens ?? 0,
    }
  }

  const status = pollResult.status
  const partial = pollResult.content || ""
  log.warn?.(`Research did not complete: ${status}`)
  if (partial.length > 0) {
    log.info?.(`Recovered ${partial.length} chars of partial content`)
  } else {
    log.error?.(`No content recovered from incomplete research (status: ${status})`)
  }
  return { fullText: partial, responseId, promptTokens: 0, completionTokens: 0 }
}

/** Extract text and usage from a completed response object */
function extractResponseText(response: any): {
  text: string
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
} {
  let text = ""
  for (const item of response.output || []) {
    if (item.type === "message" && item.content) {
      for (const content of item.content) {
        if (content.type === "output_text") text += content.text || ""
      }
    }
  }
  const usage = response.usage
  return {
    text,
    usage: {
      promptTokens: usage?.input_tokens || 0,
      completionTokens: usage?.output_tokens || 0,
      totalTokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
    },
  }
}

export async function queryOpenAIDeepResearch(options: DeepResearchOptions): Promise<ModelResponse> {
  const { topic, model, stream = false, onToken, noPersist = false, context } = options
  const background = options.background ?? stream
  const startTime = Date.now()
  const openai = getClient()
  const researchPrompt = buildResearchPrompt(topic, context)

  try {
    if (stream && onToken) {
      const result = await handleStreamingResponse(openai, researchPrompt, { ...options, background })
      return {
        model,
        content: result.fullText,
        responseId: result.responseId,
        usage: {
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          totalTokens: result.promptTokens + result.completionTokens,
        },
        durationMs: Date.now() - startTime,
      }
    }

    // Non-streaming
    const response = await openai.responses.create({
      model: model.modelId,
      input: researchPrompt,
      tools: [{ type: "web_search_preview" }],
      background,
    })

    let fullText = ""
    for (const item of response.output || []) {
      if (item.type === "message" && item.content) {
        for (const content of item.content) {
          if (content.type === "output_text") {
            fullText += content.text || ""
          }
        }
      }
    }

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
 * Poll for a background response to complete
 */
export async function pollForCompletion(
  responseId: string,
  options: {
    intervalMs?: number
    maxAttempts?: number
    onProgress?: (status: string, elapsedMs: number) => void
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
  const { intervalMs = 5_000, maxAttempts = 180 } = options
  const startTime = Date.now()

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

    // Still in progress or queued - wait and retry
    options.onProgress?.(result.status, Date.now() - startTime)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return {
    status: "timeout",
    content: "",
    error: `Timed out after ${maxAttempts} attempts (${Math.round((maxAttempts * intervalMs) / 1000)}s)`,
  }
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

    // Extract text from output
    let fullText = ""
    for (const item of response.output || []) {
      if (item.type === "message" && item.content) {
        for (const content of item.content) {
          if (content.type === "output_text") {
            fullText += content.text || ""
          }
        }
      }
    }

    const usage = response.usage

    return {
      status: response.status ?? "unknown",
      content: fullText,
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
 * Resume streaming a background response from a given sequence number
 */
export async function resumeStream(
  responseId: string,
  fromSequence: number,
  onToken: (token: string) => void,
): Promise<{
  content: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}> {
  const openai = getClient()

  // Note: The OpenAI SDK may support streaming from a response ID
  // This is a simplified implementation - full implementation would use
  // the stream endpoint with sequence_number parameter
  const response = await retrieveResponse(responseId)

  if (response.error) {
    throw new Error(response.error)
  }

  // For now, just return the full content (streaming resume is complex)
  // In a full implementation, we'd use the streaming API with starting_after
  onToken(response.content)

  return {
    content: response.content,
    usage: response.usage,
  }
}

/**
 * Check if a model is an OpenAI deep research model
 */
export function isOpenAIDeepResearch(model: Model): boolean {
  return model.provider === "openai" && model.isDeepResearch
}
