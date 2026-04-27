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
import { captureRateLimitFromHeaders, buildPerCallQuota } from "./quota"
import type { Model, ModelResponse, ThinkingLevel } from "./types"
import { getModelsForLevel, getModel, getEndpoint, MODELS } from "./types"

/**
 * Extract `x-ratelimit-*` / `anthropic-ratelimit-*` headers from a Vercel AI
 * SDK `generateText` result and update the runtime quota cache. Returns the
 * per-call envelope fragment (suitable for `ModelResponse.quota`) or
 * `undefined` if no rate-limit data was on the response.
 *
 * The AI SDK exposes the underlying response via `result.response` —
 * `headers` is on the response object. Provider availability of
 * rate-limit headers varies (Google Gemini doesn't ship them; OpenAI /
 * Anthropic / OpenRouter do). The capture is best-effort — silent when
 * the headers aren't present.
 */
function captureQuotaFromGenerateResult(
  result: unknown,
  provider: import("./types").Provider,
): Record<string, unknown> | undefined {
  const headers = extractHeaders(result)
  if (!headers) return undefined
  const snapshot = captureRateLimitFromHeaders(provider, headers)
  return buildPerCallQuota(snapshot)
}

/** Same as above, but for `streamText` — `result.response` is a Promise. */
async function captureQuotaFromResult(
  result: unknown,
  provider: import("./types").Provider,
): Promise<Record<string, unknown> | undefined> {
  let headers
  try {
    const r = result as { response?: unknown }
    const resp = r.response && typeof (r.response as Promise<unknown>).then === "function"
      ? await (r.response as Promise<unknown>)
      : r.response
    headers = extractHeaders({ response: resp })
  } catch {
    return undefined
  }
  if (!headers) return undefined
  const snapshot = captureRateLimitFromHeaders(provider, headers)
  return buildPerCallQuota(snapshot)
}

function extractHeaders(result: unknown): Record<string, string> | undefined {
  if (!result || typeof result !== "object") return undefined
  const r = result as { response?: { headers?: unknown } }
  const headers = r.response?.headers
  if (!headers || typeof headers !== "object") return undefined
  return headers as Record<string, string>
}

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

/** Rough token estimate: must OVERESTIMATE, not under-estimate.
 *
 * ~4 chars/token is the textbook English value, but dense content (code,
 * JSON, markdown tables, tight punctuation) tokenizes at ~3.3-3.7 chars
 * per token. Dividing by 4 under-counts by 5-15% on code-heavy content.
 *
 * When this function feeds cost estimation (soft hint), under-counting
 * is harmless. When it feeds `computeMaxOutputTokens` for providers that
 * enforce a combined input+output cap (Kimi K2.6: 262K), under-counting
 * silently exceeds the hard limit and fails the request.
 *
 * Divisor 3.5 gives ~14% overestimate on English prose and ~0-5% on
 * dense code — always ≥ real token count for any realistic content.
 * A proper tokenizer (tiktoken) would be exact but adds a per-provider
 * dep we don't otherwise need. */
// @internal — exported for testing only
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

/** Compute the output-token cap for a query. Returns `undefined` for
 * non-reasoning models (provider default applies).
 *
 * Dynamic path (`reasoning.contextWindow` set): cap =
 *   contextWindow − estimatedInputTokens − 2048 safety margin. Handles
 *   providers like Kimi K2.6 that enforce a combined input+output limit.
 *   Safety margin is generous enough to absorb tokenizer-estimation error
 *   without cutting into the output budget meaningfully.
 *
 * Static path (`reasoning.maxOutputTokens` set): cap = that value.
 *
 * If dynamic math produces a non-positive value (input already exceeds
 * the window — impossible in practice but worth guarding), fall back to
 * the static ceiling if any, or `undefined` to defer to the provider. */
// @internal — exported for testing only
export function computeMaxOutputTokens(
  model: Model,
  messages: Array<{ role: string; content: unknown }>,
): number | undefined {
  const reasoning = model.reasoning
  if (!reasoning) return undefined
  if (reasoning.contextWindow) {
    // 4096-token safety margin (2× the old value). The prior 2048 margin
    // was overrun by ~45 tokens in a 2026-04-20 review when the estimator
    // under-counted code-heavy content by 7%. Even with the tightened
    // 3.5-chars/token divisor, a generous margin guards against outlier
    // content (repeated emoji, Chinese/Japanese text, or unusual token
    // distributions). Cost: 4096 tokens off the output budget on models
    // that enforce a combined limit — negligible on K2.6's 262K window.
    const SAFETY = 4096
    const inputText = messages
      .map((m) => {
        if (typeof m.content === "string") return m.content
        if (Array.isArray(m.content)) {
          return (m.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === "text" && p.text)
            .map((p) => p.text)
            .join("")
        }
        return ""
      })
      .join("")
    const estimatedInput = estimateTokens(inputText)
    const dynamicCap = reasoning.contextWindow - estimatedInput - SAFETY
    if (dynamicCap > 0) return dynamicCap
  }
  return reasoning.maxOutputTokens
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
      abortSignal,
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
      abortSignal,
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

  // Reasoning models (e.g. Kimi K2.6) count reasoning tokens against the
  // output cap — so the cap must cover reasoning + final content or the
  // answer comes back empty/truncated. Two sizing strategies:
  //
  //   1. `reasoning.contextWindow` (dynamic): provider enforces a COMBINED
  //      input+output limit. Compute max_tokens = contextWindow − estimated
  //      input − safety margin so every query gets the maximum usable
  //      headroom. Required for Kimi K2.6 (262144-token combined window)
  //      where a static cap always compromises between short-query headroom
  //      and long-review safety.
  //
  //   2. `reasoning.maxOutputTokens` (static): fixed ceiling, regardless of
  //      input size. Used when we just want to make sure reasoning has room
  //      for a worst-case answer and the provider doesn't combine limits.
  //
  // contextWindow takes precedence when both are set. Non-reasoning chat
  // models leave the block unset entirely (provider default applies).
  const maxOutputTokens = computeMaxOutputTokens(model, messages)

  // Provider-specific reasoning knobs. OpenAI o-series exposes a
  // `reasoning_effort` enum (low|medium|high) on the Chat Completions API;
  // Anthropic Claude 4.5+ extended thinking takes a `thinking` object with
  // a numeric `budget_tokens`. Vercel AI SDK forwards these via the
  // `providerOptions` key on generateText/streamText, scoped under the
  // provider id. Models without a reasoning block leave providerOptions
  // unset and fall through to the provider default.
  //
  // The SDK's type is `Record<string, JSONObject>` (from @ai-sdk/provider,
  // transitively) — we construct the shape with any-typed values and cast
  // at the call site rather than pulling in @ai-sdk/provider-utils as a
  // direct dep just for the ProviderOptions alias.
  // Current AI SDK naming is camelCase, not the raw-API snake_case. Snake
  // shapes are silently dropped by the SDK — previously this code was a
  // no-op that appeared to work because the test suite mocked the SDK at
  // the import boundary. Flagged in Pro round-2 review 2026-04-21.
  //   - OpenAI: `reasoningEffort`, not `reasoning_effort`
  //   - Anthropic: `budgetTokens`, not `budget_tokens`
  const providerOptions: Record<string, Record<string, any>> = {}
  if (model.provider === "openai" && model.reasoning?.openaiEffort) {
    providerOptions.openai = { reasoningEffort: model.reasoning.openaiEffort }
  }
  if (model.provider === "anthropic" && model.reasoning?.anthropicBudget) {
    providerOptions.anthropic = {
      thinking: { type: "enabled", budgetTokens: model.reasoning.anthropicBudget },
    }
  }
  const hasProviderOptions = Object.keys(providerOptions).length > 0

  try {
    if (stream && onToken) {
      const result = streamText({
        model: languageModel,
        messages,
        abortSignal,
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        ...(hasProviderOptions ? { providerOptions } : {}),
      })

      // Consume the stream and call onToken for each part
      let fullText = ""
      for await (const part of result.textStream) {
        onToken(part)
        fullText += part
      }

      const usage = await result.usage
      const quota = await captureQuotaFromResult(result, model.provider)

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
          ...(quota ? { quota } : {}),
        },
      }
    } else {
      const result = await generateText({
        model: languageModel,
        messages,
        abortSignal,
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        ...(hasProviderOptions ? { providerOptions } : {}),
      })

      const quota = captureQuotaFromGenerateResult(result, model.provider)

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
          ...(quota ? { quota } : {}),
        },
      }
    }
  } catch (error) {
    // Retry once if a combined-limit provider (K2.6 etc.) rejected us because
    // our estimate under-counted. The error message includes the REAL input
    // token count — use it to recompute the output cap exactly, then retry.
    // This is the fallback for the rare case where estimateTokens still
    // underestimates despite the 3.5-chars/token divisor + 4K SAFETY margin
    // (e.g. content dominated by CJK / emoji / unusual tokenizers).
    const errorMsg = error instanceof Error ? error.message : String(error)
    const capInfo = parseContextLengthError(errorMsg)
    if (capInfo && model.reasoning?.contextWindow) {
      const SAFETY = 4096
      const correctedCap = model.reasoning.contextWindow - capInfo.realInputTokens - SAFETY
      if (correctedCap > 1024) {
        console.error(
          `[retry] ${model.displayName} context-exceeded (estimated ${maxOutputTokens} cap, real input ${capInfo.realInputTokens}). Retrying with cap=${correctedCap}.`,
        )
        try {
          const retryResult = await generateText({
            model: languageModel,
            messages,
            abortSignal,
            maxOutputTokens: correctedCap,
            ...(hasProviderOptions ? { providerOptions } : {}),
          })
          return {
            response: {
              model,
              content: retryResult.text,
              reasoning:
                Array.isArray(retryResult.reasoning) && retryResult.reasoning.length > 0
                  ? retryResult.reasoning.map((r) => r.text).join("\n")
                  : undefined,
              usage: retryResult.usage
                ? {
                    promptTokens: retryResult.usage.inputTokens ?? 0,
                    completionTokens: retryResult.usage.outputTokens ?? 0,
                    totalTokens: (retryResult.usage.inputTokens ?? 0) + (retryResult.usage.outputTokens ?? 0),
                  }
                : undefined,
              durationMs: Date.now() - startTime,
            },
          }
        } catch (retryError) {
          // Retry failed — fall through to the original error below.
          const retryMsg = retryError instanceof Error ? retryError.message : String(retryError)
          return {
            response: {
              model,
              content: "",
              durationMs: Date.now() - startTime,
              error: `${errorMsg} (retry with cap=${correctedCap} also failed: ${retryMsg})`,
            },
          }
        }
      }
      // Input alone exceeds the window — no cap will help. Report clearly.
      return {
        response: {
          model,
          content: "",
          durationMs: Date.now() - startTime,
          error: `Input (${capInfo.realInputTokens} tokens) exceeds ${model.displayName}'s ${model.reasoning.contextWindow}-token window. Shorten the prompt or context.`,
        },
      }
    }
    return {
      response: {
        model,
        content: "",
        durationMs: Date.now() - startTime,
        error: errorMsg,
      },
    }
  }
}

/**
 * Parse provider "context length exceeded" errors to extract the real
 * input token count. Providers report this differently; this handles the
 * OpenRouter / Moonshot K2.6 wording ("requested about X tokens (Y of
 * text input, Z in the output)").
 *
 * Returns `null` for errors that aren't context-length exceeded.
 *
 * @internal — exported for testing only
 */
export function parseContextLengthError(errorMsg: string): { realInputTokens: number } | null {
  // OpenRouter / Moonshot format: "...(30687 of text input, 231502 in the output)."
  const openrouterMatch = errorMsg.match(/(\d+)\s+of\s+text\s+input/i)
  if (openrouterMatch && openrouterMatch[1]) {
    return { realInputTokens: parseInt(openrouterMatch[1], 10) }
  }
  // OpenAI-style: "...prompt has N tokens..." — best-effort.
  const openaiMatch = errorMsg.match(/prompt\s+has\s+(\d+)\s+tokens/i)
  if (openaiMatch && openaiMatch[1] && /maximum.*context|context.*length|too\s+long/i.test(errorMsg)) {
    return { realInputTokens: parseInt(openaiMatch[1], 10) }
  }
  return null
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
    /** Pre-resolved Model object (bypasses getModel lookup — used for ollama) */
    modelObject?: Model
    imagePath?: string
    /** Abort signal for cooperative cancellation (e.g. dual-pro wall-clock timeout) */
    abortSignal?: AbortSignal
  } = {},
): Promise<ModelResponse> {
  // Get model for level, or use override
  let model: Model | undefined
  if (options.modelObject) {
    model = options.modelObject
  } else if (options.modelOverride) {
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
    abortSignal: options.abortSignal,
  })

  return result.response
}

export interface ResearchCallOptions {
  stream?: boolean
  onToken?: (token: string) => void
  modelOverride?: string
  /** Optional context to prepend to the research prompt */
  context?: string
  /** Fire-and-forget: persist response ID and exit without polling (default: true for deep) */
  fireAndForget?: boolean
  /**
   * Abort signal propagated into the poll loops and underlying queryModel
   * calls. Used by the dispatch-level SIGINT/SIGTERM wiring so Ctrl-C
   * cancels a long deep-research synchronous call instead of leaving the
   * provider poll running for up to 50m.
   */
  abortSignal?: AbortSignal
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

  // Models with the `webSearch` capability: route through the OpenAI Responses
  // API with web_search_preview. GPT-5.4 isn't flagged isDeepResearch (that flag
  // marks dedicated slow models like O3 Deep Research), but it has webSearch
  // capability and the Responses API handles fast models fine — if the
  // response completes immediately, background+poll returns instantly.
  // Capability-based routing replaces the previous `model.provider === "openai"`
  // name match — Perplexity Sonar (which has internal web search but goes
  // through generateText) is correctly tagged webSearch=false in the endpoint
  // map and falls through to the standard Vercel AI SDK path below.
  const endpoint = getEndpoint(model.modelId)
  if (endpoint?.capabilities.webSearch) {
    const response = await queryOpenAIDeepResearch({
      topic,
      model,
      stream: options.stream,
      onToken: options.onToken,
      context,
      fireAndForget: options.fireAndForget,
      abortSignal: options.abortSignal,
    })
    return response
  }

  // Gemini deep research models use Interactions API
  if (isGeminiDeepResearch(model)) {
    const result = await queryModel({
      question: topic,
      model,
      context,
      stream: options.stream,
      onToken: options.onToken,
      abortSignal: options.abortSignal,
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
