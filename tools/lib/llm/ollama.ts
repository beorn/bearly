/**
 * Ollama local model provider
 *
 * REST API at localhost:11434 (or OLLAMA_HOST).
 * Docs: https://github.com/ollama/ollama/blob/main/docs/api.md
 */

import type { Model, ModelResponse } from "./types"

const DEFAULT_HOST = "http://localhost:11434"

function getOllamaHost(): string {
  return process.env.OLLAMA_HOST?.replace(/\/+$/, "") ?? DEFAULT_HOST
}

/**
 * Check if Ollama server is reachable
 */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${getOllamaHost()}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * List models pulled locally in Ollama
 */
export async function listOllamaModels(): Promise<
  Array<{ name: string; size: number; modifiedAt: string }>
> {
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

  try {
    const resp = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream }),
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
      let fullText = ""
      let promptTokens = 0
      let completionTokens = 0

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
            }
            if (chunk.message?.content) {
              const token = chunk.message.content
              fullText += token
              onToken?.(token)
            }
            if (chunk.done) {
              promptTokens = chunk.prompt_eval_count ?? 0
              completionTokens = chunk.eval_count ?? 0
            }
          } catch {
            // Skip malformed lines
          }
        }
      }

      return {
        model: ollamaModel,
        content: fullText,
        usage:
          promptTokens || completionTokens
            ? {
                promptTokens,
                completionTokens,
                totalTokens: promptTokens + completionTokens,
              }
            : undefined,
        durationMs: Date.now() - startTime,
      }
    }

    // Non-streaming response
    const data = (await resp.json()) as {
      message?: { content?: string }
      prompt_eval_count?: number
      eval_count?: number
    }

    const content = data.message?.content ?? ""
    const promptTokens = data.prompt_eval_count ?? 0
    const completionTokens = data.eval_count ?? 0

    return {
      model: ollamaModel,
      content,
      usage:
        promptTokens || completionTokens
          ? {
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            }
          : undefined,
      durationMs: Date.now() - startTime,
    }
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message.includes("ECONNREFUSED") || err.message.includes("fetch failed")
          ? `Ollama not running. Start it with: ollama serve`
          : err.message
        : String(err)
    return {
      model: ollamaModel,
      content: "",
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
