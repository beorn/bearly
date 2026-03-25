/**
 * Deep research orchestration
 *
 * Handles single-model queries with streaming support
 */

import { generateText, streamText } from "ai"
import { getLanguageModel, isProviderAvailable } from "./providers"
import { isOpenAIDeepResearch, queryOpenAIDeepResearch } from "./openai-deep"
import { isGeminiDeepResearch, queryGeminiDeepResearch } from "./gemini-deep"
import { ollamaChat } from "./ollama"
import type { Model, ModelResponse, ThinkingLevel } from "./types"
import { getModelsForLevel, getModel, MODELS } from "./types"

export interface QueryOptions {
  question: string
  model: Model
  systemPrompt?: string
  stream?: boolean
  onToken?: (token: string) => void
  /** Optional context passed to deep research models */
  context?: string
  /** Optional image path — sent as base64 for multimodal models */
  imagePath?: string
  /** AbortSignal to cancel the request */
  abortSignal?: AbortSignal
}

export interface QueryResult {
  response: ModelResponse
  stream?: AsyncIterable<string>
}

/**
 * Query a single model
 */
export async function queryModel(options: QueryOptions): Promise<QueryResult> {
  const { question, model, systemPrompt, stream = false, onToken, context, abortSignal } = options
  const startTime = Date.now()

  // Check provider availability
  if (!isProviderAvailable(model.provider)) {
    return {
      response: {
        model,
        content: "",
        durationMs: Date.now() - startTime,
        error: `Provider ${model.provider} not available (API key not set)`,
      },
    }
  }

  // Ollama uses its own REST API, not Vercel AI SDK
  if (model.provider === "ollama") {
    const response = await ollamaChat({
      model: model.modelId,
      question,
      systemPrompt,
      imagePath: options.imagePath,
      stream: stream ?? false,
      onToken,
      abortSignal,
    })
    return { response }
  }

  // Use direct OpenAI SDK for deep research models (requires web_search_preview)
  if (isOpenAIDeepResearch(model)) {
    const response = await queryOpenAIDeepResearch({
      topic: question,
      model,
      stream,
      onToken,
      context,
    })
    return { response }
  }

  // Use Gemini Interactions API for Gemini deep research models
  if (isGeminiDeepResearch(model)) {
    const response = await queryGeminiDeepResearch({
      topic: question,
      model,
      stream,
      onToken,
      context,
    })
    return { response }
  }

  const languageModel = getLanguageModel(model)

  // Build user message content — text or multimodal (text + image)
  let userContent: any = question
  if (options.imagePath) {
    const { readFileSync } = await import("fs")
    const imageData = readFileSync(options.imagePath)
    const base64 = imageData.toString("base64")
    const ext = options.imagePath.split(".").pop()?.toLowerCase() ?? "png"
    const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`
    // Vercel AI SDK expects image as a URL (data URI) or Uint8Array
    userContent = [
      { type: "text" as const, text: question },
      { type: "image" as const, image: new Uint8Array(imageData), mimeType },
    ]
  }

  const messages = [
    ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
    { role: "user" as const, content: userContent },
  ]

  try {
    if (stream && onToken) {
      const result = streamText({
        model: languageModel,
        messages,
        abortSignal,
      })

      // Consume the stream and call onToken for each part
      let fullText = ""
      for await (const part of result.textStream) {
        onToken(part)
        fullText += part
      }

      const usage = await result.usage

      return {
        response: {
          model,
          content: fullText,
          usage: usage
            ? {
                promptTokens: usage.inputTokens ?? 0,
                completionTokens: usage.outputTokens ?? 0,
                totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
              }
            : undefined,
          durationMs: Date.now() - startTime,
        },
      }
    } else {
      const result = await generateText({
        model: languageModel,
        messages,
        abortSignal,
      })

      return {
        response: {
          model,
          content: result.text,
          reasoning:
            Array.isArray(result.reasoning) && result.reasoning.length > 0
              ? result.reasoning.map((r) => r.text).join("\n")
              : undefined,
          usage: result.usage
            ? {
                promptTokens: result.usage.inputTokens ?? 0,
                completionTokens: result.usage.outputTokens ?? 0,
                totalTokens: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
              }
            : undefined,
          durationMs: Date.now() - startTime,
        },
      }
    }
  } catch (error) {
    return {
      response: {
        model,
        content: "",
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * Query with a specific thinking level
 */
export async function ask(
  question: string,
  level: ThinkingLevel = "standard",
  options: {
    stream?: boolean
    onToken?: (token: string) => void
    modelOverride?: string
    imagePath?: string
  } = {},
): Promise<ModelResponse> {
  // Get model for level, or use override
  let model: Model | undefined
  if (options.modelOverride) {
    model = getModel(options.modelOverride)
    if (!model) {
      throw new Error(`Unknown model: ${options.modelOverride}`)
    }
  } else {
    const models = getModelsForLevel(level)
    // Find first available model
    model = models.find((m) => isProviderAvailable(m.provider))
    if (!model) {
      throw new Error(`No available models for level: ${level}`)
    }
  }

  const result = await queryModel({
    question,
    model,
    stream: options.stream,
    onToken: options.onToken,
    imagePath: options.imagePath,
  })

  return result.response
}

export interface ResearchCallOptions {
  stream?: boolean
  onToken?: (token: string) => void
  modelOverride?: string
  /** Optional context to prepend to the research prompt */
  context?: string
}

/**
 * Deep research query using deep research models
 */
export async function research(topic: string, options: ResearchCallOptions = {}): Promise<ModelResponse> {
  const { context } = options

  // Get a deep research model, or use override
  let model: Model | undefined
  if (options.modelOverride) {
    model = getModel(options.modelOverride)
    if (!model) {
      throw new Error(`Unknown model: ${options.modelOverride}`)
    }
  } else {
    // Prefer deep research models, fall back to strong standard models
    const deepModels = MODELS.filter((m) => m.isDeepResearch && isProviderAvailable(m.provider))
    const strongModels = MODELS.filter(
      (m) => !m.isDeepResearch && m.costTier === "high" && isProviderAvailable(m.provider),
    )
    model = deepModels[0] || strongModels[0]
    if (!model) {
      throw new Error("No deep research or high-tier models available")
    }
  }

  // For deep research models, pass topic and context separately
  // For other models, build the prompt ourselves
  if (isOpenAIDeepResearch(model) || isGeminiDeepResearch(model)) {
    const result = await queryModel({
      question: topic,
      model,
      context,
      stream: options.stream,
      onToken: options.onToken,
    })
    return result.response
  }

  // Build the research prompt with optional context for non-deep-research models
  const contextSection = context ? `## Background Context\n\n${context}\n\n---\n\n` : ""

  const researchPrompt = `${contextSection}Research the following topic thoroughly. Provide comprehensive information with sources where possible.

Topic: ${topic}

Please provide:
1. An overview/summary
2. Key details and facts
3. Different perspectives or approaches (if applicable)
4. Recent developments or current state
5. Sources and references (if available)`

  const result = await queryModel({
    question: researchPrompt,
    model,
    stream: options.stream,
    onToken: options.onToken,
  })

  return result.response
}

/**
 * Compare responses from multiple specific models
 */
export async function compare(
  question: string,
  modelIds: string[],
  options: { stream?: boolean } = {},
): Promise<ModelResponse[]> {
  const models = modelIds.map((id) => {
    const model = getModel(id)
    if (!model) throw new Error(`Unknown model: ${id}`)
    return model
  })

  // Query all models in parallel
  const results = await Promise.all(models.map((model) => queryModel({ question, model, stream: options.stream })))

  return results.map((r) => r.response)
}
