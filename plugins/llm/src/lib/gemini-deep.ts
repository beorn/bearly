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
import { getPartialPath, writePartialHeader, appendPartial, completePartial } from "./persistence"

const log = createLogger("bearly:llm:gemini")

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"

function getApiKey(): string {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!apiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY not set")
  return apiKey
}

export interface GeminiDeepResearchOptions {
  topic: string
  model: Model
  stream?: boolean
  onToken?: (token: string) => void
  /** Don't persist to temp file (default: false) */
  noPersist?: boolean
  /** Optional context to prepend to the research prompt */
  context?: string
}

interface InteractionResponse {
  id: string
  status: string
  outputs?: Array<{ type?: string; text?: string }>
  error?: { message?: string; code?: number }
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
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
    throw new Error(`Gemini API error (${resp.status}): ${text}`)
  }

  return resp.json() as Promise<InteractionResponse>
}

/**
 * Extract text content from interaction outputs
 */
function extractText(interaction: InteractionResponse): string {
  if (!interaction.outputs || interaction.outputs.length === 0) return ""
  // The last output typically contains the final research report
  const lastOutput = interaction.outputs[interaction.outputs.length - 1]
  return lastOutput?.text || ""
}

/**
 * Extract usage from interaction response
 */
function extractUsage(interaction: InteractionResponse):
  | {
      promptTokens: number
      completionTokens: number
      totalTokens: number
    }
  | undefined {
  const meta = interaction.usageMetadata
  if (!meta) return undefined
  return {
    promptTokens: meta.promptTokenCount || 0,
    completionTokens: meta.candidatesTokenCount || 0,
    totalTokens: meta.totalTokenCount || 0,
  }
}

/**
 * Query Gemini deep research model using the Interactions API
 */
export async function queryGeminiDeepResearch(options: GeminiDeepResearchOptions): Promise<ModelResponse> {
  const { topic, model, stream = false, onToken, noPersist = false, context } = options
  const startTime = Date.now()

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
    if (stream && onToken) {
      return await queryWithStreaming(researchPrompt, model, topic, startTime, onToken, noPersist)
    } else {
      return await queryWithPolling(researchPrompt, model, topic, startTime, onToken, noPersist)
    }
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
      content: "",
      durationMs: Date.now() - startTime,
      error: errorMessage,
    }
  }
}

/**
 * Streaming mode: use SSE to get real-time updates
 */
async function queryWithStreaming(
  prompt: string,
  model: Model,
  topic: string,
  startTime: number,
  onToken: (token: string) => void,
  noPersist: boolean,
): Promise<ModelResponse> {
  const resp = await createInteraction(prompt, model.modelId, { stream: true })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Gemini API error (${resp.status}): ${text}`)
  }

  if (!resp.body) {
    throw new Error("No response body for streaming")
  }

  let interactionId = ""
  let partialPath = ""
  let fullText = ""
  let completed = false
  let usage:
    | {
        promptTokens: number
        completionTokens: number
        totalTokens: number
      }
    | undefined

  // Parse SSE stream
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE events
      const lines = buffer.split("\n")
      buffer = lines.pop() || "" // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const data = line.slice(6).trim()
        if (!data || data === "[DONE]") continue

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const event = JSON.parse(data) as any

          // Capture interaction ID
          if (event.id && !interactionId) {
            interactionId = event.id

            if (!noPersist) {
              partialPath = getPartialPath(interactionId)
              writePartialHeader(partialPath, {
                responseId: interactionId,
                model: model.displayName,
                modelId: model.modelId,
                topic,
                startedAt: new Date().toISOString(),
              })
            }
          }

          // Handle text deltas
          if (event.type === "content.delta" || event.delta?.text) {
            const text = event.delta?.text || event.text || ""
            if (text) {
              onToken(text)
              fullText += text
              if (partialPath) appendPartial(partialPath, text)
            }
          }

          // Handle completion
          if (event.type === "interaction.complete" || event.status === "completed") {
            completed = true
            // Extract final text if available in the complete event
            if (event.outputs) {
              const finalText = extractText(event)
              if (finalText && finalText.length > fullText.length) {
                const newContent = finalText.slice(fullText.length)
                onToken(newContent)
                fullText = finalText
              }
            }
            if (event.usageMetadata) {
              usage = extractUsage(event)
            }
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // If stream ended without completing, poll for result
  if (!completed && interactionId) {
    log.info?.("Stream ended, polling for completion...")
    const result = await pollForGeminiCompletion(interactionId, {
      intervalMs: 10_000,
      maxAttempts: 120,
      onProgress: (status, elapsed) => {
        process.stderr.write(`\r⏳ ${status} (${Math.round(elapsed / 1000)}s elapsed)`)
      },
    })

    if (result.content && result.content.length > fullText.length) {
      const newContent = result.content.slice(fullText.length)
      onToken(newContent)
      fullText = result.content
    }
    if (result.usage) usage = result.usage
    if (result.status === "completed") completed = true
    process.stderr.write("\n")
  }

  // Clean up persistence
  if (partialPath) {
    if (completed) {
      completePartial(partialPath, { delete: true, usage })
    }
  }

  return {
    model,
    content: fullText,
    responseId: interactionId,
    usage,
    durationMs: Date.now() - startTime,
  }
}

/**
 * Non-streaming mode: create interaction then poll until complete
 */
async function queryWithPolling(
  prompt: string,
  model: Model,
  topic: string,
  startTime: number,
  onToken?: (token: string) => void,
  noPersist?: boolean,
): Promise<ModelResponse> {
  const resp = await createInteraction(prompt, model.modelId)

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Gemini API error (${resp.status}): ${text}`)
  }

  const initial = (await resp.json()) as InteractionResponse

  if (!initial.id) {
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
    })
  }

  // If already completed (unlikely for deep research but handle it)
  if (initial.status === "completed") {
    const content = extractText(initial)
    if (onToken && content) onToken(content)
    if (partialPath) completePartial(partialPath, { delete: true, usage: extractUsage(initial) })

    return {
      model,
      content,
      responseId: interactionId,
      usage: extractUsage(initial),
      durationMs: Date.now() - startTime,
    }
  }

  // Poll until complete
  log.info?.(`Deep research started (${interactionId}), polling...`)
  const result = await pollForGeminiCompletion(interactionId, {
    intervalMs: 10_000,
    maxAttempts: 120, // 20 min max
    onProgress: (status, elapsed) => {
      process.stderr.write(`\r⏳ ${status} (${Math.round(elapsed / 1000)}s elapsed)`)
    },
  })
  process.stderr.write("\n")

  if (result.error) {
    if (partialPath) completePartial(partialPath, { delete: true })
    return {
      model,
      content: "",
      responseId: interactionId,
      durationMs: Date.now() - startTime,
      error: result.error,
    }
  }

  if (onToken && result.content) onToken(result.content)
  if (partialPath) completePartial(partialPath, { delete: true, usage: result.usage })

  return {
    model,
    content: result.content,
    responseId: interactionId,
    usage: result.usage,
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
  const { intervalMs = 10_000, maxAttempts = 120 } = options
  const startTime = Date.now()

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const interaction = await getInteraction(interactionId)

      if (interaction.status === "completed") {
        return {
          status: "completed",
          content: extractText(interaction),
          usage: extractUsage(interaction),
        }
      }

      if (interaction.status === "failed") {
        return {
          status: "failed",
          content: "",
          error: interaction.error?.message || "Research failed",
        }
      }

      if (interaction.status === "cancelled") {
        return {
          status: "cancelled",
          content: "",
          error: "Research was cancelled",
        }
      }

      // Still in progress - wait and retry
      options.onProgress?.(interaction.status || "in_progress", Date.now() - startTime)
    } catch (err) {
      // Network errors during polling are transient - keep trying
      options.onProgress?.(
        `error (retrying): ${err instanceof Error ? err.message : String(err)}`,
        Date.now() - startTime,
      )
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return {
    status: "timeout",
    content: "",
    error: `Timed out after ${maxAttempts} attempts (${Math.round((maxAttempts * intervalMs) / 1000)}s)`,
  }
}

/**
 * Check if a model is a Gemini deep research model
 */
export function isGeminiDeepResearch(model: Model): boolean {
  return model.provider === "google" && model.isDeepResearch
}
