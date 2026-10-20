/**
 * Ollama local model provider
 *
 * REST API at localhost:11434 (or OLLAMA_HOST).
 * Docs: https://github.com/ollama/ollama/blob/main/docs/api.md
 */

import type { Model, ModelResponse } from "./types"
import { statedCharge } from "./cost"
import { describeDispatchFailure } from "./dispatch-error"
import {
  createProviderObservationStore,
  recordProviderObservation,
  type ProviderObservationStore,
} from "./provider-availability"

const DEFAULT_HOST = "http://localhost:11434"

function getOllamaHost(): string {
  return process.env.OLLAMA_HOST?.replace(/\/+$/, "") ?? DEFAULT_HOST
}

/**
 * Check if Ollama server is reachable
 */
export async function isOllamaAvailable(
  options: { observationStore?: ProviderObservationStore | null } = {},
): Promise<boolean> {
  const observationStore =
    options.observationStore === undefined ? createProviderObservationStore() : options.observationStore
  const target = `${getOllamaHost()}/api/tags`
  try {
    const resp = await fetch(target, {
      signal: AbortSignal.timeout(2000),
    })
    if (observationStore) {
      await recordProviderObservation(
        observationStore,
        resp.ok
          ? {
              provider: "ollama",
              status: "available",
              source: "ollama:/api/tags",
              reason: `Ollama /api/tags returned HTTP ${resp.status}`,
            }
          : {
              provider: "ollama",
              status: "refusing",
              kind: "transport",
              source: "ollama:/api/tags",
              reason: `Ollama /api/tags returned HTTP ${resp.status}`,
            },
      )
    }
    return resp.ok
  } catch (error) {
    const described = describeDispatchFailure(error, { provider: "ollama" })
    if (observationStore && described.observation) {
      await recordProviderObservation(observationStore, {
        ...described.observation,
        source: "ollama:/api/tags",
      })
    }
    return false
  }
}

/**
 * List models pulled locally in Ollama
 */
export async function listOllamaModels(): Promise<Array<{ name: string; size: number; modifiedAt: string }>> {
  const resp = await fetch(`${getOllamaHost()}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!resp.ok) {
    throw new Error(`Ollama API error: ${resp.status} ${resp.statusText}`)
  }
  const data = (await resp.json()) as {
    models: Array<{ name: string; size: number; modified_at: string }>
  }
  return (data.models ?? []).map((m) => ({
    name: m.name,
    size: m.size,
    modifiedAt: m.modified_at,
  }))
}

/**
 * Parse an "ollama:model" string into a Model object
 */
export function parseOllamaModel(modelString: string): Model {
  // modelString is everything after "ollama:", e.g. "qwen2.5-vl:7b"
  return {
    provider: "ollama",
    modelId: modelString,
    displayName: `Ollama ${modelString}`,
    isDeepResearch: false,
    costTier: "local",
  }
}

export interface OllamaChatOptions {
  /** Optional caller ceiling; sent as Ollama num_predict. */
  maxOutputTokens?: number
  model: string
  question: string
  systemPrompt?: string
  imagePath?: string
  stream?: boolean
  onToken?: (token: string) => void
  abortSignal?: AbortSignal
}

/**
 * Query Ollama via /api/chat with streaming NDJSON
 */
export async function ollamaChat(options: OllamaChatOptions): Promise<ModelResponse> {
  const { model, question, systemPrompt, imagePath, stream = true, onToken, abortSignal } = options
  const startTime = Date.now()
  const host = getOllamaHost()

  // Build user message
  const userMessage: Record<string, unknown> = { role: "user", content: question }

  // Handle image: read file, convert to base64
  if (imagePath) {
    const { readFileSync } = await import("fs")
    const imageData = readFileSync(imagePath)
    const base64 = imageData.toString("base64")
    userMessage.images = [base64]
  }

  const messages: Array<Record<string, unknown>> = []
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt })
  }
  messages.push(userMessage)

  const ollamaModel: Model = {
    provider: "ollama",
    modelId: model,
    displayName: `Ollama ${model}`,
    isDeepResearch: false,
    costTier: "local",
  }
  const retained: Pick<ModelResponse, "content" | "usage" | "cost_usd"> = { content: "" }

  try {
    let maxOutputTokens: number | undefined
    if (options.maxOutputTokens !== undefined) {
      const { computeMaxOutputTokens } = await import("./research")
      maxOutputTokens = computeMaxOutputTokens(
        ollamaModel,
        messages as Array<{ role: string; content: unknown }>,
        undefined,
        options.maxOutputTokens,
      )
    }
    const resp = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream,
        ...(maxOutputTokens === undefined ? {} : { options: { num_predict: maxOutputTokens } }),
      }),
      signal: abortSignal,
    })

    if (!resp.ok) {
      const body = await resp.text().catch(() => "")
      const errorMsg = body.includes("not found")
        ? `Model "${model}" not found. Pull it first: ollama pull ${model}`
        : `Ollama API error: ${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`
      return {
        model: ollamaModel,
        content: "",
        durationMs: Date.now() - startTime,
        error: errorMsg,
      }
    }

    if (stream && resp.body) {
      // Parse NDJSON stream

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const chunk = JSON.parse(line) as {
              message?: { content?: string }
              done?: boolean
              prompt_eval_count?: number
              eval_count?: number
              [key: string]: unknown
            }
            if (
              chunk.done ||
              chunk.prompt_eval_count !== undefined ||
              chunk.eval_count !== undefined ||
              "cost_usd" in chunk
            ) {
              const { message: _message, ...raw } = chunk
              retained.usage = {
                ...(chunk.prompt_eval_count === undefined ? {} : { promptTokens: chunk.prompt_eval_count }),
                ...(chunk.eval_count === undefined ? {} : { completionTokens: chunk.eval_count }),
                raw,
              }
              Object.assign(retained, statedCharge(chunk, "ollama"))
            }
            if (chunk.message?.content) {
              const token = chunk.message.content
              retained.content += token
              onToken?.(token)
            }
          } catch (cause) {
            throw new Error(
              `Ollama /api/chat stream failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              { cause },
            )
          }
        }
      }

      return {
        model: ollamaModel,
        ...retained,
        durationMs: Date.now() - startTime,
      }
    }

    // Non-streaming response
    const data = (await resp.json()) as {
      message?: { content?: string }
      prompt_eval_count?: number
      eval_count?: number
      [key: string]: unknown
    }

    const { message, ...raw } = data
    retained.content = message?.content ?? ""
    retained.usage = {
      ...(data.prompt_eval_count === undefined ? {} : { promptTokens: data.prompt_eval_count }),
      ...(data.eval_count === undefined ? {} : { completionTokens: data.eval_count }),
      raw,
    }
    Object.assign(retained, statedCharge(data, "ollama"))

    return {
      model: ollamaModel,
      ...retained,
      durationMs: Date.now() - startTime,
    }
  } catch (err) {
    const message =
      err instanceof Error
        ? !retained.usage &&
          !retained.content &&
          (err.message.includes("ECONNREFUSED") || err.message.includes("fetch failed"))
          ? `Ollama not running. Start it with: ollama serve`
          : err.message
        : String(err)
    return {
      model: ollamaModel,
      ...retained,
      durationMs: Date.now() - startTime,
      error: message,
    }
  }
}

/**
 * Format file size for display
 */
export function formatSize(bytes: number): string {
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)}MB`
  return `${(bytes / 1e9).toFixed(1)}GB`
}
