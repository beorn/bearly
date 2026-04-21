/**
 * LLM types and schemas for multi-model research
 */

import { z } from "zod"

// Provider identifiers
export const ProviderSchema = z.enum(["openai", "anthropic", "google", "xai", "perplexity", "ollama", "openrouter"])
export type Provider = z.infer<typeof ProviderSchema>

// Model identifiers by provider
export const ModelSchema = z.object({
  provider: ProviderSchema,
  modelId: z.string(),
  displayName: z.string(),
  isDeepResearch: z.boolean().default(false),
  costTier: z.enum(["local", "low", "medium", "high", "very-high"]),
  // Pricing per 1M tokens (USD)
  inputPricePerM: z.number().optional(),
  outputPricePerM: z.number().optional(),
  // Typical response time
  typicalLatencyMs: z.number().optional(),
  // Reasoning-model metadata. Thinking models burn tokens on chain-of-thought
  // before emitting visible output — different providers expose different
  // knobs for controlling that. Fields are composable (a model can declare
  // both a cap AND an effort level). Absent field means the feature isn't
  // used for this model.
  //
  // History: originally a single field `minCompletionTokens` (intended as
  // "floor", actually used as a cap on maxOutputTokens); replaced by this
  // structure so future providers can plug in without bolting on more one-off
  // fields. See km-infra.llm-review-fixes for context.
  reasoning: z
    .object({
      // Max total output tokens (reasoning + content). Required for models
      // where reasoning counts against the output budget — Kimi K2.6 and
      // OpenAI o-series behave this way. Sized generously so a long-context
      // review has room for ~20K+ reasoning tokens plus a full answer.
      //   - Short queries (<5K input): 16384 is typical
      //   - Long queries (>30K input): 65536 is safe
      // Non-reasoning chat models leave this unset and fall through to the
      // provider default.
      maxOutputTokens: z.number().optional(),
      // OpenAI o-series `reasoning_effort`: low | medium | high. Controls
      // how many reasoning tokens the model spends before answering.
      // Plumbing into queryModel is TODO — add when an o-series model is
      // actually routed through the Chat Completions API from here.
      openaiEffort: z.enum(["low", "medium", "high"]).optional(),
      // Anthropic Claude 4.5+ extended-thinking `budget_tokens`. Plumbing
      // into the @ai-sdk/anthropic provider call is TODO — same reason as
      // openaiEffort: add when a thinking-enabled Claude model ships here.
      anthropicBudget: z.number().optional(),
    })
    .optional(),
})
export type Model = z.infer<typeof ModelSchema>

// Thinking levels (tiered cost/quality)
export const ThinkingLevelSchema = z.enum([
  "quick", // Level 1: Single fast model (~$0.01)
  "standard", // Level 2: Single strong model (~$0.10)
  "research", // Level 3: Single deep research model (~$2-5)
  "consensus", // Level 4: Multiple models + synthesis (~$1-3)
  "deep", // Level 5: All deep research models + consolidation (~$15-30)
])
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>

// Response from a single model
export const ModelResponseSchema = z.object({
  model: ModelSchema,
  content: z.string(),
  responseId: z.string().optional(), // API response ID for recovery
  reasoning: z.string().optional(), // Extended thinking/chain-of-thought
  citations: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string(),
        snippet: z.string().optional(),
      }),
    )
    .optional(),
  usage: z
    .object({
      promptTokens: z.number(),
      completionTokens: z.number(),
      totalTokens: z.number(),
      estimatedCost: z.number().optional(), // USD
    })
    .optional(),
  durationMs: z.number(),
  error: z.string().optional(),
})
export type ModelResponse = z.infer<typeof ModelResponseSchema>

// Consensus result from multiple models
export const ConsensusResultSchema = z.object({
  level: ThinkingLevelSchema,
  question: z.string(),
  responses: z.array(ModelResponseSchema),
  synthesis: z.string().optional(), // Combined answer
  agreements: z.array(z.string()).optional(), // Points of agreement
  disagreements: z.array(z.string()).optional(), // Points of disagreement
  confidence: z.number().min(0).max(1).optional(),
  totalCost: z.number().optional(),
  totalDurationMs: z.number(),
})
export type ConsensusResult = z.infer<typeof ConsensusResultSchema>

// CLI command options
export const AskOptionsSchema = z.object({
  question: z.string(),
  level: ThinkingLevelSchema.default("standard"),
  models: z.array(z.string()).optional(), // Override default models
  maxCost: z.number().default(5), // USD - require confirmation above this
  stream: z.boolean().default(true),
  json: z.boolean().default(false), // Output as JSON
})
export type AskOptions = z.infer<typeof AskOptionsSchema>

export const ResearchOptionsSchema = z.object({
  topic: z.string(),
  models: z.array(z.string()).optional(),
  maxCost: z.number().default(10),
  stream: z.boolean().default(true),
  json: z.boolean().default(false),
})
export type ResearchOptions = z.infer<typeof ResearchOptionsSchema>

export const ConsensusOptionsSchema = z.object({
  question: z.string(),
  models: z.array(z.string()).optional(),
  synthesize: z.boolean().default(true), // Generate synthesis
  maxCost: z.number().default(5),
  stream: z.boolean().default(true),
  json: z.boolean().default(false),
})
export type ConsensusOptions = z.infer<typeof ConsensusOptionsSchema>

export const CompareOptionsSchema = z.object({
  question: z.string(),
  models: z.array(z.string()).min(2),
  stream: z.boolean().default(true),
  json: z.boolean().default(false),
})
export type CompareOptions = z.infer<typeof CompareOptionsSchema>

// Available models registry with pricing (per 1M tokens, USD)
export const MODELS: Model[] = [
  // OpenAI - GPT-5.4 series (2026-03-05)
  {
    provider: "openai",
    modelId: "gpt-5.4",
    displayName: "GPT-5.4",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 2.5,
    outputPricePerM: 15.0,
    typicalLatencyMs: 5000,
  },
  {
    provider: "openai",
    modelId: "gpt-5.4-pro",
    displayName: "GPT-5.4 Pro",
    isDeepResearch: false,
    costTier: "very-high",
    inputPricePerM: 25.0,
    outputPricePerM: 200.0,
    typicalLatencyMs: 15000,
  },
  // OpenAI - GPT-5.3 series
  {
    provider: "openai",
    modelId: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 1.5,
    outputPricePerM: 12.0,
    typicalLatencyMs: 5000,
  },
  // OpenAI - GPT-5.2 series
  {
    provider: "openai",
    modelId: "gpt-5.2",
    displayName: "GPT-5.2",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 1.75,
    outputPricePerM: 14.0,
    typicalLatencyMs: 5000,
  },
  {
    provider: "openai",
    modelId: "gpt-5.2-pro",
    displayName: "GPT-5.2 Pro",
    isDeepResearch: false,
    costTier: "very-high",
    inputPricePerM: 21.0,
    outputPricePerM: 168.0,
    typicalLatencyMs: 15000,
  },
  // OpenAI - GPT-5.1 series
  {
    provider: "openai",
    modelId: "gpt-5.1-codex-max",
    displayName: "GPT-5.1 Codex Max",
    isDeepResearch: false,
    costTier: "very-high",
    inputPricePerM: 10.0,
    outputPricePerM: 40.0,
    typicalLatencyMs: 10000,
  },
  {
    provider: "openai",
    modelId: "gpt-5.1-codex",
    displayName: "GPT-5.1 Codex",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 1.25,
    outputPricePerM: 10.0,
    typicalLatencyMs: 5000,
  },
  {
    provider: "openai",
    modelId: "gpt-5.1-codex-mini",
    displayName: "GPT-5.1 Codex Mini",
    isDeepResearch: false,
    costTier: "medium",
    inputPricePerM: 0.3,
    outputPricePerM: 1.2,
    typicalLatencyMs: 2000,
  },
  {
    provider: "openai",
    modelId: "gpt-5",
    displayName: "GPT-5",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 1.25,
    outputPricePerM: 10.0,
    typicalLatencyMs: 5000,
  },
  {
    provider: "openai",
    modelId: "gpt-5-codex",
    displayName: "GPT-5 Codex",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 1.25,
    outputPricePerM: 10.0,
    typicalLatencyMs: 5000,
  },
  {
    provider: "openai",
    modelId: "gpt-5-mini",
    displayName: "GPT-5 Mini",
    isDeepResearch: false,
    costTier: "medium",
    inputPricePerM: 0.25,
    outputPricePerM: 2.0,
    typicalLatencyMs: 2000,
  },
  {
    provider: "openai",
    modelId: "gpt-5-nano",
    displayName: "GPT-5 Nano",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.1,
    outputPricePerM: 0.4,
    typicalLatencyMs: 1000,
  },
  // OpenAI - GPT-4 series
  {
    provider: "openai",
    modelId: "gpt-4o-mini",
    displayName: "GPT-4o Mini",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.15,
    outputPricePerM: 0.6,
    typicalLatencyMs: 1500,
  },
  {
    provider: "openai",
    modelId: "gpt-4o",
    displayName: "GPT-4o",
    isDeepResearch: false,
    costTier: "medium",
    inputPricePerM: 2.5,
    outputPricePerM: 10.0,
    typicalLatencyMs: 3000,
  },
  {
    provider: "openai",
    modelId: "gpt-4.1",
    displayName: "GPT-4.1",
    isDeepResearch: false,
    costTier: "medium",
    inputPricePerM: 2.0,
    outputPricePerM: 8.0,
    typicalLatencyMs: 3000,
  },
  // OpenAI - O-series reasoning
  {
    provider: "openai",
    modelId: "o3",
    displayName: "O3",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 2.0,
    outputPricePerM: 8.0,
    typicalLatencyMs: 10000,
    reasoning: { openaiEffort: "medium" },
  },
  {
    provider: "openai",
    modelId: "o3-pro",
    displayName: "O3 Pro",
    isDeepResearch: false,
    costTier: "very-high",
    inputPricePerM: 10.0,
    outputPricePerM: 40.0,
    typicalLatencyMs: 20000,
    // Pro is paid for deep thought — high effort + generous output cap so
    // long reasoning traces don't truncate the final answer.
    reasoning: { openaiEffort: "high", maxOutputTokens: 32768 },
  },
  {
    provider: "openai",
    modelId: "o3-mini",
    displayName: "O3 Mini",
    isDeepResearch: false,
    costTier: "medium",
    inputPricePerM: 0.55,
    outputPricePerM: 2.2,
    typicalLatencyMs: 3000,
    reasoning: { openaiEffort: "medium" },
  },
  {
    provider: "openai",
    modelId: "o4-mini",
    displayName: "O4 Mini",
    isDeepResearch: false,
    costTier: "medium",
    inputPricePerM: 1.1,
    outputPricePerM: 4.4,
    typicalLatencyMs: 3000,
    reasoning: { openaiEffort: "medium" },
  },
  // OpenAI - Deep Research
  {
    provider: "openai",
    modelId: "o3-deep-research-2025-06-26",
    displayName: "O3 Deep Research",
    isDeepResearch: true,
    costTier: "very-high",
    inputPricePerM: 10.0,
    outputPricePerM: 40.0,
    typicalLatencyMs: 180000,
  },
  {
    provider: "openai",
    modelId: "o4-mini-deep-research-2025-06-26",
    displayName: "O4 Mini Deep Research",
    isDeepResearch: true,
    costTier: "high",
    inputPricePerM: 2.0,
    outputPricePerM: 8.0,
    typicalLatencyMs: 60000,
  },

  // Anthropic - Claude 4.6 series (latest)
  {
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    isDeepResearch: false,
    costTier: "very-high",
    inputPricePerM: 15.0,
    outputPricePerM: 75.0,
    typicalLatencyMs: 15000,
    // Extended thinking for the heaviest Claude — 16K budget covers most
    // complex reasoning chains without blowing the latency budget.
    reasoning: { anthropicBudget: 16384 },
  },
  {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 3.0,
    outputPricePerM: 15.0,
    typicalLatencyMs: 5000,
    // Lighter budget for mid-tier — enough for meaningful thinking, half
    // the budget of Opus to match the tier's cost/latency profile.
    reasoning: { anthropicBudget: 8192 },
  },
  // Anthropic - Claude 4.5 series
  {
    provider: "anthropic",
    modelId: "claude-opus-4-5-20251101",
    displayName: "Claude Opus 4.5",
    isDeepResearch: false,
    costTier: "very-high",
    inputPricePerM: 15.0,
    outputPricePerM: 75.0,
    typicalLatencyMs: 15000,
  },
  {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5-20250929",
    displayName: "Claude Sonnet 4.5",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 3.0,
    outputPricePerM: 15.0,
    typicalLatencyMs: 5000,
  },
  // Anthropic - Claude 4.1 / 4 series
  {
    provider: "anthropic",
    modelId: "claude-opus-4-1-20250805",
    displayName: "Claude Opus 4.1",
    isDeepResearch: false,
    costTier: "very-high",
    inputPricePerM: 15.0,
    outputPricePerM: 75.0,
    typicalLatencyMs: 12000,
  },
  {
    provider: "anthropic",
    modelId: "claude-opus-4-20250514",
    displayName: "Claude Opus 4",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 15.0,
    outputPricePerM: 75.0,
    typicalLatencyMs: 12000,
  },
  {
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    displayName: "Claude Sonnet 4",
    isDeepResearch: false,
    costTier: "medium",
    inputPricePerM: 3.0,
    outputPricePerM: 15.0,
    typicalLatencyMs: 4000,
  },
  // Anthropic - Claude Haiku
  {
    provider: "anthropic",
    modelId: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.8,
    outputPricePerM: 4.0,
    typicalLatencyMs: 1500,
  },
  {
    provider: "anthropic",
    modelId: "claude-3-haiku-20240307",
    displayName: "Claude 3 Haiku",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.25,
    outputPricePerM: 1.25,
    typicalLatencyMs: 1000,
  },

  // Google
  {
    provider: "google",
    modelId: "gemini-3-pro-preview",
    displayName: "Gemini 3 Pro",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 1.25,
    outputPricePerM: 5.0,
    typicalLatencyMs: 5000,
  },
  {
    provider: "google",
    modelId: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    isDeepResearch: false,
    costTier: "medium",
    inputPricePerM: 1.25,
    outputPricePerM: 5.0,
    typicalLatencyMs: 4000,
  },
  {
    provider: "google",
    modelId: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.15,
    outputPricePerM: 0.6,
    typicalLatencyMs: 1500,
  },
  {
    provider: "google",
    modelId: "gemini-2.0-flash",
    displayName: "Gemini 2.0 Flash",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.1,
    outputPricePerM: 0.4,
    typicalLatencyMs: 1000,
  },
  {
    provider: "google",
    modelId: "gemini-2.0-flash-lite",
    displayName: "Gemini 2.0 Flash Lite",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.05,
    outputPricePerM: 0.2,
    typicalLatencyMs: 800,
  },
  // Google - Deep Research
  {
    provider: "google",
    modelId: "deep-research-pro-preview-12-2025",
    displayName: "Gemini Deep Research",
    isDeepResearch: true,
    costTier: "high",
    inputPricePerM: 1.25,
    outputPricePerM: 10.0,
    typicalLatencyMs: 300000,
  },

  // xAI (Grok)
  {
    provider: "xai",
    modelId: "grok-4",
    displayName: "Grok 4",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 3.0,
    outputPricePerM: 15.0,
    typicalLatencyMs: 5000,
  },
  {
    provider: "xai",
    modelId: "grok-4-1-fast-reasoning",
    displayName: "Grok 4.1 Fast",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.2,
    outputPricePerM: 0.5,
    typicalLatencyMs: 3000,
  },
  {
    provider: "xai",
    modelId: "grok-3",
    displayName: "Grok 3",
    isDeepResearch: false,
    costTier: "medium",
    inputPricePerM: 1.0,
    outputPricePerM: 5.0,
    typicalLatencyMs: 3000,
  },
  {
    provider: "xai",
    modelId: "grok-3-fast",
    displayName: "Grok 3 Fast",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.2,
    outputPricePerM: 1.0,
    typicalLatencyMs: 1500,
  },

  // OpenRouter — Moonshot Kimi
  // Kimi K2.6 released 2026-04-13: 1T MoE (32B active), 262K context, reasoning model.
  // Pricing via OpenRouter (routes to Moonshot direct); launch-day promo may make it free.
  // Reasoning is heavy and counts against the output cap — defaultMaxOutputTokens
  // is sized generously (64K) so large-context reviews have room for thinking
  // plus a complete answer. Short queries only bill for what they use.
  {
    provider: "openrouter",
    modelId: "moonshotai/kimi-k2.6",
    displayName: "Kimi K2.6",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.95,
    outputPricePerM: 4.0,
    typicalLatencyMs: 15000,
    // 65K accommodates long-context reviews where reasoning alone eats 20K+.
    // Smaller queries only bill for what they actually use — the cap is upper
    // bound, not floor.
    reasoning: { maxOutputTokens: 65536 },
  },

  // Perplexity
  {
    provider: "perplexity",
    modelId: "sonar",
    displayName: "Perplexity Sonar",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 1.0,
    outputPricePerM: 1.0,
    typicalLatencyMs: 2000,
  },
  {
    provider: "perplexity",
    modelId: "sonar-pro",
    displayName: "Perplexity Sonar Pro",
    isDeepResearch: true,
    costTier: "medium",
    inputPricePerM: 3.0,
    outputPricePerM: 15.0,
    typicalLatencyMs: 5000,
  },
  {
    provider: "perplexity",
    modelId: "sonar-deep-research",
    displayName: "Perplexity Deep Research",
    isDeepResearch: true,
    costTier: "high",
    inputPricePerM: 5.0,
    outputPricePerM: 20.0,
    typicalLatencyMs: 120000,
  },
]

// Model lookup helpers
export function getModel(idOrName: string): Model | undefined {
  const lower = idOrName.toLowerCase()
  return MODELS.find(
    (m) =>
      m.modelId.toLowerCase() === lower ||
      m.displayName.toLowerCase() === lower ||
      m.displayName.toLowerCase().replace(/\s+/g, "-") === lower,
  )
}

export function getModelsForLevel(level: ThinkingLevel): Model[] {
  switch (level) {
    case "quick":
      return MODELS.filter((m) => m.costTier === "low" && !m.isDeepResearch).slice(0, 1)
    case "standard":
      return MODELS.filter((m) => m.costTier === "medium" && !m.isDeepResearch).slice(0, 1)
    case "research":
      return MODELS.filter((m) => m.isDeepResearch).slice(0, 1)
    case "consensus":
      // One model per provider (non-deep-research)
      return MODELS.filter((m) => !m.isDeepResearch && m.costTier !== "low").reduce((acc, m) => {
        if (!acc.find((x) => x.provider === m.provider)) acc.push(m)
        return acc
      }, [] as Model[])
    case "deep":
      return MODELS.filter((m) => m.isDeepResearch)
    default:
      return [MODELS[0]!]
  }
}

export function getModelsByProvider(provider: Provider): Model[] {
  return MODELS.filter((m) => m.provider === provider)
}

export function getDeepResearchModels(): Model[] {
  return MODELS.filter((m) => m.isDeepResearch)
}

/**
 * Estimate cost for a query (USD)
 * Assumes ~500 input tokens and ~1000 output tokens for a typical query
 */
export function estimateCost(model: Model, inputTokens = 500, outputTokens = 1000): number {
  const inputCost = (model.inputPricePerM ?? 0) * (inputTokens / 1_000_000)
  const outputCost = (model.outputPricePerM ?? 0) * (outputTokens / 1_000_000)
  return inputCost + outputCost
}

/**
 * Format cost for display
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${(cost * 100).toFixed(2)}¢`
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}

/**
 * Format latency for display
 */
export function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`
  return `${(ms / 60000).toFixed(1)}min`
}

/**
 * Get cheap model for question refinement
 */
export function getCheapModel(): Model | undefined {
  return MODELS.find((m) => m.costTier === "low" && m.provider === "openai") || MODELS.find((m) => m.costTier === "low")
}

/**
 * Get cheap models from distinct available providers (for racing).
 * Returns up to `max` models, one per provider, preferring openai first.
 */
export function getCheapModels(max = 2): Model[] {
  const seen = new Set<string>()
  const result: Model[] = []
  for (const m of MODELS) {
    if (m.costTier !== "low" || m.isDeepResearch || seen.has(m.provider)) continue
    seen.add(m.provider)
    result.push(m)
    if (result.length >= max) break
  }
  return result
}

/**
 * Check if model requires cost confirmation (expensive)
 */
export function requiresConfirmation(model: Model, threshold = 0.1): boolean {
  const estimatedCost = estimateCost(model)
  return estimatedCost > threshold || model.costTier === "very-high" || model.isDeepResearch
}

/**
 * Best models for each mode (in priority order)
 */
export const BEST_MODELS = {
  // Default query - best general-purpose models
  default: ["gpt-5.4", "gemini-3-pro-preview", "claude-sonnet-4-6", "grok-4"],
  // Deep research — GPT-5.4 via Responses API + web_search is the best deep research model.
  // (2026-03-12) Tested GPT-5.4 vs O3 Deep Research on 19K lines of silvery+flexily source:
  //   GPT-5.4: $0.57, 182K tokens, comprehensive findings
  //   O3 Deep Research: $2.27, 14KB output, much worse quality
  // (2026-03-20) GPT-5.4 Pro also works via --model gpt-5.4-pro but takes 2-3 min (background+poll).
  // The "dedicated" deep research models (o3, gemini) are kept as fallbacks only.
  deep: ["gpt-5.4", "o3-deep-research-2025-06-26", "deep-research-pro-preview-12-2025", "sonar-deep-research"],
  // Second opinion - prefer different provider than default
  opinion: ["gemini-3-pro-preview", "gemini-2.5-pro", "gpt-5.4", "grok-4"],
  // Debate - one from each major provider
  debate: ["gpt-5.4", "gemini-3-pro-preview", "grok-4", "claude-sonnet-4-6"],
  // Quick/cheap - fast and cheap
  quick: ["gpt-5-nano", "gemini-2.0-flash-lite", "grok-3-fast", "claude-haiku-4-5-20251001"],
  // Pro - most capable models (very-high cost tier, ~10x standard)
  // Dual-pro mode (CLI `pro` keyword, no --model override) runs the first two
  // entries in parallel: GPT-5.4 Pro + Kimi K2.6 — A/B test + 2-is-better-than-one.
  pro: ["gpt-5.4-pro", "moonshotai/kimi-k2.6", "o3-pro", "claude-opus-4-6", "gpt-5.2-pro"],
}

export type ModelMode = keyof typeof BEST_MODELS

/**
 * Get the best available model for a mode, with unavailability warnings
 */
export function getBestAvailableModel(
  mode: ModelMode,
  isProviderAvailable: (provider: Provider) => boolean,
): { model: Model | undefined; warning: string | undefined } {
  const candidates = BEST_MODELS[mode]
  const globalBest = getModel(candidates[0]!)

  // Find first available model
  for (const modelId of candidates) {
    const model = getModel(modelId)
    if (model && isProviderAvailable(model.provider)) {
      // Check if we're not using the global best
      let warning: string | undefined
      if (globalBest && model.modelId !== globalBest.modelId) {
        const envVar = getProviderEnvVar(globalBest.provider)
        warning = `Best model for ${mode}: ${globalBest.displayName} (set ${envVar} to enable)`
      }
      return { model, warning }
    }
  }

  // No available model
  const envVars = candidates
    .map((id) => getModel(id))
    .filter(Boolean)
    .map((m) => `${m!.displayName}: ${getProviderEnvVar(m!.provider)}`)
    .slice(0, 3)
    .join(", ")

  return {
    model: undefined,
    warning: `No models available for ${mode}. Set one of: ${envVars}`,
  }
}

/**
 * Get multiple best available models (for debate mode)
 */
export function getBestAvailableModels(
  mode: ModelMode,
  isProviderAvailable: (provider: Provider) => boolean,
  count: number = 3,
): { models: Model[]; warning: string | undefined } {
  const candidates = BEST_MODELS[mode]
  const available: Model[] = []
  const unavailable: Model[] = []

  for (const modelId of candidates) {
    const model = getModel(modelId)
    if (!model) continue

    if (isProviderAvailable(model.provider)) {
      // Avoid duplicate providers for diversity
      if (!available.find((m) => m.provider === model.provider)) {
        available.push(model)
      }
    } else {
      unavailable.push(model)
    }

    if (available.length >= count) break
  }

  // Build warning for unavailable better models
  let warning: string | undefined
  if (unavailable.length > 0 && available.length < count) {
    const missing = unavailable
      .slice(0, 2)
      .map((m) => `${m.displayName} (${getProviderEnvVar(m.provider)})`)
      .join(", ")
    warning = `More models available: ${missing}`
  }

  return { models: available, warning }
}

/** Map a Provider to the env var name that activates it. Single source of
 *  truth — re-exported from providers.ts so callers can import from either. */
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
    case "openrouter":
      return "OPENROUTER_API_KEY"
    case "ollama":
      return "OLLAMA_HOST (or localhost:11434)"
    default:
      return `${(provider as string).toUpperCase()}_API_KEY`
  }
}

