/**
 * Vercel AI SDK provider configuration
 *
 * Providers are initialized lazily from environment variables:
 * - OPENAI_API_KEY
 * - ANTHROPIC_API_KEY
 * - GOOGLE_GENERATIVE_AI_API_KEY
 * - XAI_API_KEY
 * - PERPLEXITY_API_KEY
 */

import { createOpenAI } from "@ai-sdk/openai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createXai } from "@ai-sdk/xai"
import { createPerplexity } from "@ai-sdk/perplexity"
import type { LanguageModel } from "ai"
import type { Provider, Model } from "./types"

// Provider instances (lazy-initialized)
let openaiProvider: ReturnType<typeof createOpenAI> | undefined
let anthropicProvider: ReturnType<typeof createAnthropic> | undefined
let googleProvider: ReturnType<typeof createGoogleGenerativeAI> | undefined
let xaiProvider: ReturnType<typeof createXai> | undefined
let perplexityProvider: ReturnType<typeof createPerplexity> | undefined

function getOpenAI() {
  if (!openaiProvider) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error("OPENAI_API_KEY not set")
    openaiProvider = createOpenAI({ apiKey })
  }
  return openaiProvider
}

function getAnthropic() {
  if (!anthropicProvider) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set")
    anthropicProvider = createAnthropic({ apiKey })
  }
  return anthropicProvider
}

function getGoogle() {
  if (!googleProvider) {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!apiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY not set")
    googleProvider = createGoogleGenerativeAI({ apiKey })
  }
  return googleProvider
}

function getXai() {
  if (!xaiProvider) {
    const apiKey = process.env.XAI_API_KEY
    if (!apiKey) throw new Error("XAI_API_KEY not set")
    xaiProvider = createXai({ apiKey })
  }
  return xaiProvider
}

function getPerplexity() {
  if (!perplexityProvider) {
    const apiKey = process.env.PERPLEXITY_API_KEY
    if (!apiKey) throw new Error("PERPLEXITY_API_KEY not set")
    perplexityProvider = createPerplexity({ apiKey })
  }
  return perplexityProvider
}

/**
 * Get the Vercel AI SDK model instance for a given model definition
 */
export function getLanguageModel(model: Model): LanguageModel {
  switch (model.provider) {
    case "openai":
      return getOpenAI()(model.modelId)
    case "anthropic":
      return getAnthropic()(model.modelId)
    case "google":
      return getGoogle()(model.modelId)
    case "xai":
      return getXai()(model.modelId)
    case "perplexity":
      return getPerplexity()(model.modelId)
    case "ollama":
      throw new Error("Ollama does not use Vercel AI SDK — handle via ollamaChat() directly")
    default:
      throw new Error(`Unknown provider: ${model.provider}`)
  }
}

/**
 * Check if a provider's API key is available
 */
export function isProviderAvailable(provider: Provider): boolean {
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
  // Ollama excluded — it's checked asynchronously via isOllamaAvailable()
  const providers: Provider[] = ["openai", "anthropic", "google", "xai", "perplexity"]
  return providers.filter(isProviderAvailable)
}

/**
 * Get environment variable name for a provider
 */
export function getProviderEnvVar(provider: Provider): string {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY"
    case "anthropic":
      return "ANTHROPIC_API_KEY"
    case "google":
      return "GOOGLE_GENERATIVE_AI_API_KEY"
    case "xai":
      return "XAI_API_KEY"
    case "perplexity":
      return "PERPLEXITY_API_KEY"
    case "ollama":
      return "OLLAMA_HOST (or localhost:11434)"
    default:
      return `${(provider as string).toUpperCase()}_API_KEY`
  }
}
