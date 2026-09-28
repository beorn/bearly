/**
 * Vercel AI SDK provider configuration
 *
 * Providers are initialized lazily from environment variables:
 * - OPENAI_API_KEY
 * - ANTHROPIC_API_KEY
 * - GOOGLE_GENERATIVE_AI_API_KEY
 * - XAI_API_KEY
 * - PERPLEXITY_API_KEY
 * - OPENROUTER_API_KEY (routes to Moonshot, Mistral, Qwen, etc. via OpenAI-compatible API)
 */

import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogle } from "@ai-sdk/google"
import { createPerplexity } from "@ai-sdk/perplexity"
import type { LanguageModel } from "ai"
import type { Provider, Model } from "./types"
import { getEndpoint } from "./types"
import { missingApiKeyError, ensureProviderKeysLoaded } from "./env-preflight"

// Provider instances (lazy-initialized)
let openaiProvider: ReturnType<typeof createOpenAI> | undefined
let anthropicProvider: ReturnType<typeof createAnthropic> | undefined
let googleProvider: ReturnType<typeof createGoogle> | undefined
let xaiProvider: ReturnType<typeof createOpenAICompatible> | undefined
let perplexityProvider: ReturnType<typeof createPerplexity> | undefined
let openrouterProvider: ReturnType<typeof createOpenAI> | undefined

function getOpenAI() {
  ensureProviderKeysLoaded()
  if (!openaiProvider) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw missingApiKeyError("OPENAI_API_KEY")
    openaiProvider = createOpenAI({ apiKey })
  }
  return openaiProvider
}

function getAnthropic() {
  ensureProviderKeysLoaded()
  if (!anthropicProvider) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw missingApiKeyError("ANTHROPIC_API_KEY")
    anthropicProvider = createAnthropic({ apiKey })
  }
  return anthropicProvider
}

function getGoogle() {
  ensureProviderKeysLoaded()
  if (!googleProvider) {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!apiKey) throw missingApiKeyError("GOOGLE_GENERATIVE_AI_API_KEY")
    googleProvider = createGoogle({ apiKey })
  }
  return googleProvider
}

function getXai() {
  ensureProviderKeysLoaded()
  if (!xaiProvider) {
    const apiKey = process.env.XAI_API_KEY
    if (!apiKey) throw missingApiKeyError("XAI_API_KEY")
    xaiProvider = createOpenAICompatible({
      name: "xai",
      baseURL: "https://api.x.ai/v1",
      apiKey,
      includeUsage: true,
      // Preserve @ai-sdk/xai 3.0.124's convertXaiChatUsage accounting:
      // xAI Chat reports reasoning tokens separately from completion_tokens.
      convertUsage: (usage) => {
        const input = usage?.prompt_tokens ?? 0
        const output = usage?.completion_tokens ?? 0
        const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? 0
        const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0
        const inputIncludesCache = cacheRead <= input
        return {
          inputTokens: {
            total: inputIncludesCache ? input : input + cacheRead,
            noCache: inputIncludesCache ? input - cacheRead : input,
            cacheRead,
            cacheWrite: undefined,
          },
          outputTokens: { total: output + reasoning, text: output, reasoning },
        }
      },
    })
  }
  return xaiProvider
}

function getPerplexity() {
  ensureProviderKeysLoaded()
  if (!perplexityProvider) {
    const apiKey = process.env.PERPLEXITY_API_KEY
    if (!apiKey) throw missingApiKeyError("PERPLEXITY_API_KEY")
    perplexityProvider = createPerplexity({ apiKey })
  }
  return perplexityProvider
}

// OpenRouter uses the OpenAI provider's default Responses API, as it did before
// AI SDK 7. The baseURL and attribution headers route that API to OpenRouter.
function getOpenRouter() {
  ensureProviderKeysLoaded()
  if (!openrouterProvider) {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) throw missingApiKeyError("OPENROUTER_API_KEY")
    openrouterProvider = createOpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://github.com/beorn/bearly",
        "X-Title": "bearly-llm",
      },
    })
  }
  return openrouterProvider
}

/**
 * Get the Vercel AI SDK model instance for a given model definition.
 *
 * The endpoint's `apiModelId` overrides the SKU's `modelId` when set — used
 * for OpenAI Pro tiers where our internal alias (`gpt-5.4-pro`) differs from
 * OpenAI's API ID (`gpt-5-pro`). Synthetic models (e.g. ad-hoc OpenRouter
 * SKUs not in the registry) won't have an endpoint entry, so `id` falls back
 * to the SKU's own `modelId`.
 */
export function getLanguageModel(model: Model): LanguageModel {
  const endpoint = getEndpoint(model.modelId)
  const id = endpoint?.apiModelId ?? model.modelId
  switch (model.provider) {
    case "openai":
      return getOpenAI()(id)
    case "anthropic":
      return getAnthropic()(id)
    case "google":
      return getGoogle()(id)
    case "xai":
      return getXai()(id)
    case "perplexity":
      return getPerplexity()(id)
    case "openrouter":
      return getOpenRouter()(id)
    case "ollama":
      throw new Error("Ollama does not use Vercel AI SDK — handle via ollamaChat() directly")
    default:
      throw new Error(`Unknown provider: ${String(model.provider)}`)
  }
}

/**
 * Check if a provider's API key is available
 *
 * Legacy source-compatible configuration-presence check, not endpoint/account
 * health. New selection must use ProviderAvailabilityFact with selectModels().
 */
export function isProviderAvailable(provider: Provider): boolean {
  ensureProviderKeysLoaded()
  switch (provider) {
    case "openai":
      return !!process.env.OPENAI_API_KEY
    case "anthropic":
      return !!process.env.ANTHROPIC_API_KEY
    case "google":
      return !!process.env.GOOGLE_GENERATIVE_AI_API_KEY
    case "xai":
      return !!process.env.XAI_API_KEY
    case "perplexity":
      return !!process.env.PERPLEXITY_API_KEY
    case "openrouter":
      return !!process.env.OPENROUTER_API_KEY
    case "ollama":
      // Ollama availability is checked asynchronously — use isOllamaAvailable() for runtime check.
      // For sync checks (model selection), assume available if not explicitly disabled.
      return true
    default:
      return false
  }
}

/**
 * Get list of available providers (those with API keys set)
 */
export function getAvailableProviders(): Provider[] {
  ensureProviderKeysLoaded()
  // Ollama excluded — it's checked asynchronously via isOllamaAvailable()
  const providers: Provider[] = ["openai", "anthropic", "google", "xai", "perplexity", "openrouter"]
  return providers.filter(isProviderAvailable)
}

// Re-exported from types.ts (single source of truth). The claim that these
// had to be duplicated to avoid a circular import was stale — types.ts has
// no imports from providers.ts, so the function can live there cleanly.
export { getProviderEnvVar } from "./types"
