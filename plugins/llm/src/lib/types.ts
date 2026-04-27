/**
 * LLM types and schemas for multi-model research.
 *
 * The registry is split into two frozen tables:
 *
 *   1. SKUS (user-facing identity) — modelId, displayName, costTier, pricing,
 *      latency, isDeepResearch, reasoning config. Stable across provider API
 *      churn — our `gpt-5.4-pro` outlives OpenAI's `gpt-5-pro-2025-10-06`
 *      snapshots rolling forward.
 *
 *   2. PROVIDER_ENDPOINTS (dispatch contract) — { provider, apiModelId,
 *      capabilities }. Capabilities (webSearch, backgroundApi, vision,
 *      deepResearch) replace `provider === "openai"` magic strings in the
 *      routing layer — adding a new provider with the same capabilities
 *      doesn't require editing dispatch logic.
 *
 * Public surface:
 *   - getSku(id)              → SkuConfig | undefined
 *   - getEndpoint(id)         → ProviderEndpoint | undefined
 *   - getModel(id)            → Model | undefined  (legacy facade; SKU + endpoint flattened)
 *   - MODELS                  → readonly Model[]  (legacy view; do not mutate)
 *
 * `Model.apiModelId` is a deprecated alias preserved for one release window —
 * computed from the endpoint at facade-build time. New routing code should
 * read endpoint capabilities; new providers don't need a name match.
 *
 * Pricing is overlaid at process start by `applyCachedPricing()` — the SKU
 * defaults are frozen, the cache provides current values without mutating
 * the source-of-truth array.
 */

import { z } from "zod"

// ============================================================================
// Provider identifiers
// ============================================================================

export const ProviderSchema = z.enum(["openai", "anthropic", "google", "xai", "perplexity", "ollama", "openrouter"])
export type Provider = z.infer<typeof ProviderSchema>

// ============================================================================
// SKU — user-facing model identity (stable across provider API churn)
// ============================================================================

/** Reasoning-model knobs. See SkuConfig.reasoning JSDoc for field semantics. */
export const ReasoningConfigSchema = z.object({
  // Max total output tokens (reasoning + content). Used as a static ceiling.
  maxOutputTokens: z.number().optional(),
  // Combined context window (input + output) in tokens. When set, queryModel
  // computes max_tokens at call time as `contextWindow − estimatedInput −
  // safetyMargin`, eliminating the static-cap tradeoff.
  contextWindow: z.number().optional(),
  // OpenAI o-series `reasoning_effort`: low | medium | high.
  openaiEffort: z.enum(["low", "medium", "high"]).optional(),
  // Anthropic Claude 4.5+ extended-thinking `budget_tokens`.
  anthropicBudget: z.number().optional(),
})
export type ReasoningConfig = z.infer<typeof ReasoningConfigSchema>

export const SkuSchema = z.object({
  /** Internal alias used by the CLI and across the codebase. Stable across
   *  provider API churn — e.g. `gpt-5.4-pro` outlives OpenAI's
   *  `gpt-5-pro-2025-10-06` snapshot rolling forward. */
  modelId: z.string(),
  displayName: z.string(),
  isDeepResearch: z.boolean().default(false),
  costTier: z.enum(["local", "low", "medium", "high", "very-high"]),
  // Pricing per 1M tokens (USD). Defaults are frozen; runtime cache overlay
  // provides current values without mutating this array.
  inputPricePerM: z.number().optional(),
  outputPricePerM: z.number().optional(),
  // Typical response time
  typicalLatencyMs: z.number().optional(),
  /** Reasoning-model metadata. Thinking models burn tokens on chain-of-thought
   *  before emitting visible output — fields are composable (a model can declare
   *  both a cap AND an effort level). Absent field means the feature isn't
   *  used for this model. */
  reasoning: ReasoningConfigSchema.optional(),
})
export type SkuConfig = z.infer<typeof SkuSchema>

// ============================================================================
// Provider endpoint — how a SKU is dispatched and what it can do
// ============================================================================

/** Capabilities that drive routing decisions. Adding a new capability is a
 *  one-line schema change + a routing branch — never a name-match. */
export const CapabilitiesSchema = z.object({
  /** Routes through the OpenAI Responses API with `web_search_preview` for
   *  research-style queries. NOT a generic "model has web search" flag —
   *  Perplexity Sonar has internal web search but routes through plain
   *  `generateText`, so it stays false here. Adding a second provider that
   *  implements an analogous tool-based search route would extend this to
   *  a routing table; for now it's effectively "OpenAI Responses API". */
  webSearch: z.boolean().default(false),
  /** Supports background create + poll for recoverability. Routing:
   *  `askAndFinish` (and dual-pro) uses queryOpenAIBackground for these so a
   *  long Pro call survives SIGINT. Currently OpenAI-only — when other
   *  providers ship comparable mechanisms, the dispatch function selection
   *  becomes a per-endpoint table. */
  backgroundApi: z.boolean().default(false),
  /** Accepts image inputs (multimodal). */
  vision: z.boolean().default(false),
  /** Dedicated deep-research model (slow, heavy, expensive). Marks
   *  isDeepResearch SKUs that go through provider-specific deep-research
   *  dispatch (queryOpenAIDeepResearch / queryGeminiDeepResearch). */
  deepResearch: z.boolean().default(false),
})
export type Capabilities = z.infer<typeof CapabilitiesSchema>

export const ProviderEndpointSchema = z.object({
  provider: ProviderSchema,
  /** Override for the string sent to the provider API. When unset, the
   *  provider receives the SKU's `modelId`. Used for OpenAI Pro tiers where
   *  our internal alias (`gpt-5.4-pro`) doesn't match OpenAI's API ID
   *  (`gpt-5-pro` / `gpt-5-pro-2025-10-06`). */
  apiModelId: z.string().optional(),
  capabilities: CapabilitiesSchema,
})
export type ProviderEndpoint = z.infer<typeof ProviderEndpointSchema>

// ============================================================================
// Legacy facade — flattened SKU + endpoint, used by call sites that haven't
// migrated to capability-based dispatch yet.
// ============================================================================

/** Legacy `Model` shape. Composed from SkuConfig + ProviderEndpoint at
 *  registry-build time. New routing code should prefer `getEndpoint(id)` and
 *  inspect `endpoint.capabilities` directly — `apiModelId` and `provider` are
 *  preserved here for one release window so callers can migrate incrementally. */
export const ModelSchema = SkuSchema.extend({
  provider: ProviderSchema,
  /** @deprecated Read via `getEndpoint(id).apiModelId` — kept as a runtime
   *  alias so existing call sites (research.ts, openai-deep.ts) keep working
   *  without per-call lookups. Will be removed once all callers go through
   *  `getEndpoint`. */
  apiModelId: z.string().optional(),
})
export type Model = z.infer<typeof ModelSchema>

// ============================================================================
// Thinking levels (tiered cost/quality)
// ============================================================================

export const ThinkingLevelSchema = z.enum([
  "quick", // Level 1: Single fast model (~$0.01)
  "standard", // Level 2: Single strong model (~$0.10)
  "research", // Level 3: Single deep research model (~$2-5)
  "consensus", // Level 4: Multiple models + synthesis (~$1-3)
  "deep", // Level 5: All deep research models + consolidation (~$15-30)
])
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>

// ============================================================================
// Response & options schemas
// ============================================================================

export const ModelResponseSchema = z.object({
  model: ModelSchema,
  content: z.string(),
  responseId: z.string().optional(),
  reasoning: z.string().optional(),
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
      estimatedCost: z.number().optional(),
    })
    .optional(),
  durationMs: z.number(),
  error: z.string().optional(),
})
export type ModelResponse = z.infer<typeof ModelResponseSchema>

export const ConsensusResultSchema = z.object({
  level: ThinkingLevelSchema,
  question: z.string(),
  responses: z.array(ModelResponseSchema),
  synthesis: z.string().optional(),
  agreements: z.array(z.string()).optional(),
  disagreements: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  totalCost: z.number().optional(),
  totalDurationMs: z.number(),
})
export type ConsensusResult = z.infer<typeof ConsensusResultSchema>

export const AskOptionsSchema = z.object({
  question: z.string(),
  level: ThinkingLevelSchema.default("standard"),
  models: z.array(z.string()).optional(),
  maxCost: z.number().default(5),
  stream: z.boolean().default(true),
  json: z.boolean().default(false),
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
  synthesize: z.boolean().default(true),
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

// ============================================================================
// SKU registry — frozen, user-facing model identities
// ============================================================================

const SKUS_DATA: SkuConfig[] = [
  // OpenAI - GPT-5.5 "Spud" series (announced 2026-04-23)
  {
    modelId: "gpt-5.5",
    displayName: "GPT-5.5",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 5.0,
    outputPricePerM: 30.0,
    typicalLatencyMs: 5000,
  },
  {
    modelId: "gpt-5.5-pro",
    displayName: "GPT-5.5 Pro",
    isDeepResearch: false,
    costTier: "very-high",
    inputPricePerM: 30.0,
    outputPricePerM: 180.0,
    typicalLatencyMs: 15000,
  },
  // OpenAI - GPT-5.4 series (2026-03-05)
  {
    modelId: "gpt-5.4",
    displayName: "GPT-5.4",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 2.5,
    outputPricePerM: 15.0,
    typicalLatencyMs: 5000,
  },
  {
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
    modelId: "gpt-5.2",
    displayName: "GPT-5.2",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 1.75,
    outputPricePerM: 14.0,
    typicalLatencyMs: 5000,
  },
  {
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
    modelId: "gpt-5.1-codex-max",
    displayName: "GPT-5.1 Codex Max",
    isDeepResearch: false,
    costTier: "very-high",
    inputPricePerM: 10.0,
    outputPricePerM: 40.0,
    typicalLatencyMs: 10000,
  },
  {
    modelId: "gpt-5.1-codex",
    displayName: "GPT-5.1 Codex",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 1.25,
    outputPricePerM: 10.0,
    typicalLatencyMs: 5000,
  },
  {
    modelId: "gpt-5.1-codex-mini",
    displayName: "GPT-5.1 Codex Mini",
    isDeepResearch: false,
    costTier: "medium",
    inputPricePerM: 0.3,
    outputPricePerM: 1.2,
    typicalLatencyMs: 2000,
  },
  {
    modelId: "gpt-5",
    displayName: "GPT-5",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 1.25,
    outputPricePerM: 10.0,
    typicalLatencyMs: 5000,
  },
  {
    modelId: "gpt-5-codex",
    displayName: "GPT-5 Codex",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 1.25,
    outputPricePerM: 10.0,
    typicalLatencyMs: 5000,
  },
  {
    modelId: "gpt-5-mini",
    displayName: "GPT-5 Mini",
    isDeepResearch: false,
    costTier: "medium",
    inputPricePerM: 0.25,
    outputPricePerM: 2.0,
    typicalLatencyMs: 2000,
  },
  {
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
    modelId: "gpt-4o-mini",
    displayName: "GPT-4o Mini",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.15,
    outputPricePerM: 0.6,
    typicalLatencyMs: 1500,
  },
  {
    modelId: "gpt-4o",
    displayName: "GPT-4o",
    isDeepResearch: false,
    costTier: "medium",
    inputPricePerM: 2.5,
    outputPricePerM: 10.0,
    typicalLatencyMs: 3000,
  },
  {
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
    modelId: "o3-pro",
    displayName: "O3 Pro",
    isDeepResearch: false,
    costTier: "very-high",
    inputPricePerM: 10.0,
    outputPricePerM: 40.0,
    typicalLatencyMs: 20000,
    reasoning: { openaiEffort: "high", maxOutputTokens: 32768 },
  },
  {
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
    modelId: "o3-deep-research-2025-06-26",
    displayName: "O3 Deep Research",
    isDeepResearch: true,
    costTier: "very-high",
    inputPricePerM: 10.0,
    outputPricePerM: 40.0,
    typicalLatencyMs: 180000,
  },
  {
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
    modelId: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    isDeepResearch: false,
    costTier: "very-high",
    inputPricePerM: 15.0,
    outputPricePerM: 75.0,
    typicalLatencyMs: 15000,
    reasoning: { anthropicBudget: 16384 },
  },
  {
    modelId: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 3.0,
    outputPricePerM: 15.0,
    typicalLatencyMs: 5000,
    reasoning: { anthropicBudget: 8192 },
  },
  // Anthropic - Claude 4.5 series
  {
    modelId: "claude-opus-4-5-20251101",
    displayName: "Claude Opus 4.5",
    isDeepResearch: false,
    costTier: "very-high",
    inputPricePerM: 15.0,
    outputPricePerM: 75.0,
    typicalLatencyMs: 15000,
  },
  {
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
    modelId: "claude-opus-4-1-20250805",
    displayName: "Claude Opus 4.1",
    isDeepResearch: false,
    costTier: "very-high",
    inputPricePerM: 15.0,
    outputPricePerM: 75.0,
    typicalLatencyMs: 12000,
  },
  {
    modelId: "claude-opus-4-20250514",
    displayName: "Claude Opus 4",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 15.0,
    outputPricePerM: 75.0,
    typicalLatencyMs: 12000,
  },
  {
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
    modelId: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.8,
    outputPricePerM: 4.0,
    typicalLatencyMs: 1500,
  },
  {
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
    modelId: "gemini-3-pro-preview",
    displayName: "Gemini 3 Pro",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 1.25,
    outputPricePerM: 5.0,
    typicalLatencyMs: 5000,
  },
  {
    modelId: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    isDeepResearch: false,
    costTier: "medium",
    inputPricePerM: 1.25,
    outputPricePerM: 5.0,
    typicalLatencyMs: 4000,
  },
  {
    modelId: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.15,
    outputPricePerM: 0.6,
    typicalLatencyMs: 1500,
  },
  {
    modelId: "gemini-2.0-flash",
    displayName: "Gemini 2.0 Flash",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.1,
    outputPricePerM: 0.4,
    typicalLatencyMs: 1000,
  },
  {
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
    modelId: "grok-4",
    displayName: "Grok 4",
    isDeepResearch: false,
    costTier: "high",
    inputPricePerM: 3.0,
    outputPricePerM: 15.0,
    typicalLatencyMs: 5000,
  },
  {
    modelId: "grok-4-1-fast-reasoning",
    displayName: "Grok 4.1 Fast",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.2,
    outputPricePerM: 0.5,
    typicalLatencyMs: 3000,
  },
  {
    modelId: "grok-3",
    displayName: "Grok 3",
    isDeepResearch: false,
    costTier: "medium",
    inputPricePerM: 1.0,
    outputPricePerM: 5.0,
    typicalLatencyMs: 3000,
  },
  {
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
  // Reasoning is heavy and counts against the output cap — `reasoning.contextWindow`
  // (262K) lets queryModel compute max_tokens dynamically as
  // `contextWindow − estimatedInput − safetyMargin`, eliminating the static-cap
  // tradeoff between short-query headroom and long-review safety.
  {
    modelId: "moonshotai/kimi-k2.6",
    displayName: "Kimi K2.6",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.95,
    outputPricePerM: 4.0,
    typicalLatencyMs: 15000,
    reasoning: { contextWindow: 262144 },
  },

  // Perplexity
  {
    modelId: "sonar",
    displayName: "Perplexity Sonar",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 1.0,
    outputPricePerM: 1.0,
    typicalLatencyMs: 2000,
  },
  {
    modelId: "sonar-pro",
    displayName: "Perplexity Sonar Pro",
    isDeepResearch: true,
    costTier: "medium",
    inputPricePerM: 3.0,
    outputPricePerM: 15.0,
    typicalLatencyMs: 5000,
  },
  {
    modelId: "sonar-deep-research",
    displayName: "Perplexity Deep Research",
    isDeepResearch: true,
    costTier: "high",
    inputPricePerM: 5.0,
    outputPricePerM: 20.0,
    typicalLatencyMs: 120000,
  },
]

/** Frozen SKU registry. Source-of-truth identity for every supported model.
 *  Pricing values are defaults — `applyCachedPricing()` overlays the runtime
 *  cache for current values without mutating this array. */
export const SKUS: readonly SkuConfig[] = Object.freeze(SKUS_DATA.map((s) => Object.freeze({ ...s })))

// ============================================================================
// Provider-endpoint registry — capability-keyed dispatch contract
// ============================================================================

/** Defaults: all-false. We override only the capabilities a SKU actually has,
 *  so adding a new endpoint is a one-liner that explicitly enumerates what
 *  the SKU can do. */
const NO_CAPS: Capabilities = { webSearch: false, backgroundApi: false, vision: false, deepResearch: false }

const ENDPOINTS_DATA: Record<string, ProviderEndpoint> = {
  // OpenAI — GPT-5.5
  "gpt-5.5": { provider: "openai", capabilities: { ...NO_CAPS, webSearch: true, backgroundApi: true, vision: true } },
  "gpt-5.5-pro": {
    provider: "openai",
    capabilities: { ...NO_CAPS, webSearch: true, backgroundApi: true, vision: true },
  },
  // OpenAI — GPT-5.4 (apiModelId override: our internal alias → OpenAI's API ID)
  "gpt-5.4": {
    provider: "openai",
    apiModelId: "gpt-5",
    capabilities: { ...NO_CAPS, webSearch: true, backgroundApi: true, vision: true },
  },
  "gpt-5.4-pro": {
    provider: "openai",
    apiModelId: "gpt-5-pro",
    capabilities: { ...NO_CAPS, webSearch: true, backgroundApi: true, vision: true },
  },
  // OpenAI — GPT-5.3 / 5.2 / 5.1 / 5 / 4.x
  "gpt-5.3-codex": { provider: "openai", capabilities: { ...NO_CAPS, backgroundApi: true } },
  "gpt-5.2": {
    provider: "openai",
    capabilities: { ...NO_CAPS, webSearch: true, backgroundApi: true, vision: true },
  },
  "gpt-5.2-pro": {
    provider: "openai",
    capabilities: { ...NO_CAPS, webSearch: true, backgroundApi: true, vision: true },
  },
  "gpt-5.1-codex-max": { provider: "openai", capabilities: { ...NO_CAPS, backgroundApi: true } },
  "gpt-5.1-codex": { provider: "openai", capabilities: { ...NO_CAPS, backgroundApi: true } },
  "gpt-5.1-codex-mini": { provider: "openai", capabilities: { ...NO_CAPS, backgroundApi: true } },
  "gpt-5": {
    provider: "openai",
    capabilities: { ...NO_CAPS, webSearch: true, backgroundApi: true, vision: true },
  },
  "gpt-5-codex": { provider: "openai", capabilities: { ...NO_CAPS, backgroundApi: true } },
  "gpt-5-mini": {
    provider: "openai",
    capabilities: { ...NO_CAPS, webSearch: true, backgroundApi: true, vision: true },
  },
  "gpt-5-nano": { provider: "openai", capabilities: { ...NO_CAPS, backgroundApi: true } },
  "gpt-4o-mini": {
    provider: "openai",
    capabilities: { ...NO_CAPS, backgroundApi: true, vision: true },
  },
  "gpt-4o": { provider: "openai", capabilities: { ...NO_CAPS, backgroundApi: true, vision: true } },
  "gpt-4.1": { provider: "openai", capabilities: { ...NO_CAPS, backgroundApi: true, vision: true } },
  // OpenAI — O-series (reasoning, supports background API)
  o3: { provider: "openai", capabilities: { ...NO_CAPS, backgroundApi: true } },
  "o3-pro": { provider: "openai", capabilities: { ...NO_CAPS, backgroundApi: true } },
  "o3-mini": { provider: "openai", capabilities: { ...NO_CAPS, backgroundApi: true } },
  "o4-mini": { provider: "openai", capabilities: { ...NO_CAPS, backgroundApi: true } },
  // OpenAI — Deep Research (uses queryOpenAIDeepResearch with web_search_preview)
  "o3-deep-research-2025-06-26": {
    provider: "openai",
    capabilities: { ...NO_CAPS, webSearch: true, deepResearch: true },
  },
  "o4-mini-deep-research-2025-06-26": {
    provider: "openai",
    capabilities: { ...NO_CAPS, webSearch: true, deepResearch: true },
  },

  // Anthropic
  "claude-opus-4-6": { provider: "anthropic", capabilities: { ...NO_CAPS, vision: true } },
  "claude-sonnet-4-6": { provider: "anthropic", capabilities: { ...NO_CAPS, vision: true } },
  "claude-opus-4-5-20251101": { provider: "anthropic", capabilities: { ...NO_CAPS, vision: true } },
  "claude-sonnet-4-5-20250929": { provider: "anthropic", capabilities: { ...NO_CAPS, vision: true } },
  "claude-opus-4-1-20250805": { provider: "anthropic", capabilities: { ...NO_CAPS, vision: true } },
  "claude-opus-4-20250514": { provider: "anthropic", capabilities: { ...NO_CAPS, vision: true } },
  "claude-sonnet-4-20250514": { provider: "anthropic", capabilities: { ...NO_CAPS, vision: true } },
  "claude-haiku-4-5-20251001": { provider: "anthropic", capabilities: { ...NO_CAPS, vision: true } },
  "claude-3-haiku-20240307": { provider: "anthropic", capabilities: { ...NO_CAPS, vision: true } },

  // Google
  "gemini-3-pro-preview": { provider: "google", capabilities: { ...NO_CAPS, vision: true } },
  "gemini-2.5-pro": { provider: "google", capabilities: { ...NO_CAPS, vision: true } },
  "gemini-2.5-flash": { provider: "google", capabilities: { ...NO_CAPS, vision: true } },
  "gemini-2.0-flash": { provider: "google", capabilities: { ...NO_CAPS, vision: true } },
  "gemini-2.0-flash-lite": { provider: "google", capabilities: { ...NO_CAPS, vision: true } },
  // Gemini Deep Research has its own search tool, but it routes through the
  // Gemini Interactions API (queryGeminiDeepResearch), NOT the OpenAI
  // Responses API. `webSearch` capability flags the latter — leaving it false
  // here is what tells the dispatcher to pick the Gemini deep path instead of
  // the OpenAI one. `deepResearch + provider==='google'` is the routing key.
  "deep-research-pro-preview-12-2025": {
    provider: "google",
    capabilities: { ...NO_CAPS, deepResearch: true },
  },

  // xAI
  "grok-4": { provider: "xai", capabilities: NO_CAPS },
  "grok-4-1-fast-reasoning": { provider: "xai", capabilities: NO_CAPS },
  "grok-3": { provider: "xai", capabilities: NO_CAPS },
  "grok-3-fast": { provider: "xai", capabilities: NO_CAPS },

  // OpenRouter
  "moonshotai/kimi-k2.6": { provider: "openrouter", capabilities: NO_CAPS },

  // Perplexity Sonar has internal web search, but dispatch goes through the
  // standard Vercel AI SDK path (generateText) — `webSearch` capability flags
  // models that route through the OpenAI Responses API web_search_preview tool,
  // which Sonar doesn't use. Tagging deep-research variants so the deep path
  // can pick them up; non-deep Sonar stays on the plain chat route.
  sonar: { provider: "perplexity", capabilities: NO_CAPS },
  "sonar-pro": { provider: "perplexity", capabilities: { ...NO_CAPS, deepResearch: true } },
  "sonar-deep-research": {
    provider: "perplexity",
    capabilities: { ...NO_CAPS, deepResearch: true },
  },
}

/** Frozen provider-endpoint registry. */
export const PROVIDER_ENDPOINTS: Readonly<Record<string, ProviderEndpoint>> = Object.freeze(
  Object.fromEntries(
    Object.entries(ENDPOINTS_DATA).map(([k, v]) => [
      k,
      Object.freeze({ ...v, capabilities: Object.freeze({ ...v.capabilities }) }),
    ]),
  ),
)

// ============================================================================
// Pricing overlay — runtime cache merged with frozen SKU defaults
// ============================================================================

/** Per-modelId pricing overlay. Set via `setPricingOverlay()` (called by
 *  pricing.ts at startup with the JSON cache contents). Reads merge over
 *  the frozen SKUS values without mutating them.
 *
 *  Keeping this private + module-scoped (no global) avoids the previous
 *  in-place-mutation pattern and gives tests a clean reset hook
 *  (`resetPricingOverlay()`).
 */
const pricingOverlay = new Map<
  string,
  { inputPricePerM?: number; outputPricePerM?: number; typicalLatencyMs?: number }
>()

export function setPricingOverlay(
  entries: Record<string, { inputPricePerM: number; outputPricePerM: number; typicalLatencyMs?: number }>,
): void {
  pricingOverlay.clear()
  for (const [id, v] of Object.entries(entries)) {
    pricingOverlay.set(id, { ...v })
  }
}

/** @internal — for tests. */
export function resetPricingOverlay(): void {
  pricingOverlay.clear()
}

function applyOverlay(sku: SkuConfig): SkuConfig {
  const o = pricingOverlay.get(sku.modelId)
  if (!o) return sku
  return {
    ...sku,
    inputPricePerM: o.inputPricePerM ?? sku.inputPricePerM,
    outputPricePerM: o.outputPricePerM ?? sku.outputPricePerM,
    typicalLatencyMs: o.typicalLatencyMs ?? sku.typicalLatencyMs,
  }
}

// ============================================================================
// Public lookup API
// ============================================================================

/** Look up a SKU by id or display-name (case-insensitive, kebab variants). */
export function getSku(idOrName: string): SkuConfig | undefined {
  const lower = idOrName.toLowerCase()
  const sku = SKUS.find(
    (s) =>
      s.modelId.toLowerCase() === lower ||
      s.displayName.toLowerCase() === lower ||
      s.displayName.toLowerCase().replace(/\s+/g, "-") === lower,
  )
  return sku ? applyOverlay(sku) : undefined
}

/** Look up the dispatch endpoint for a SKU id. */
export function getEndpoint(idOrName: string): ProviderEndpoint | undefined {
  const sku = SKUS.find(
    (s) =>
      s.modelId.toLowerCase() === idOrName.toLowerCase() ||
      s.displayName.toLowerCase() === idOrName.toLowerCase() ||
      s.displayName.toLowerCase().replace(/\s+/g, "-") === idOrName.toLowerCase(),
  )
  if (!sku) return undefined
  return PROVIDER_ENDPOINTS[sku.modelId]
}

/** Build the legacy `Model` facade (SKU + endpoint flattened). */
function buildModel(sku: SkuConfig, endpoint: ProviderEndpoint): Model {
  return {
    ...applyOverlay(sku),
    provider: endpoint.provider,
    apiModelId: endpoint.apiModelId,
  }
}

/** Legacy lookup — flattens SKU + endpoint into the historical `Model` shape. */
export function getModel(idOrName: string): Model | undefined {
  const sku = getSku(idOrName)
  if (!sku) return undefined
  const endpoint = PROVIDER_ENDPOINTS[sku.modelId]
  if (!endpoint) return undefined
  return buildModel(sku, endpoint)
}

/** Legacy view of the registry — flattened SKU + endpoint per row. Built once
 *  at module load; pricing-overlay reads happen at access via
 *  `Object.defineProperty` so callers always see current overlay values
 *  without rebuild.
 *
 *  Marked `readonly` at the type level — mutation is a runtime no-op (entries
 *  are frozen objects), and assignment through the type is rejected by tsc.
 *  Use `setPricingOverlay()` to update runtime pricing. */
export const MODELS: readonly Model[] = Object.freeze(
  SKUS.filter((s) => PROVIDER_ENDPOINTS[s.modelId]).map((s) => {
    const endpoint = PROVIDER_ENDPOINTS[s.modelId]!
    // Build a getter-backed Model so reads of inputPricePerM / etc. always see
    // the current overlay. Avoids "frozen at module load" pricing while
    // keeping the surface immutable to writes.
    const target: Model = {
      ...s,
      provider: endpoint.provider,
      apiModelId: endpoint.apiModelId,
    }
    Object.defineProperty(target, "inputPricePerM", {
      get: () => pricingOverlay.get(s.modelId)?.inputPricePerM ?? s.inputPricePerM,
      enumerable: true,
      configurable: false,
    })
    Object.defineProperty(target, "outputPricePerM", {
      get: () => pricingOverlay.get(s.modelId)?.outputPricePerM ?? s.outputPricePerM,
      enumerable: true,
      configurable: false,
    })
    Object.defineProperty(target, "typicalLatencyMs", {
      get: () => pricingOverlay.get(s.modelId)?.typicalLatencyMs ?? s.typicalLatencyMs,
      enumerable: true,
      configurable: false,
    })
    return Object.freeze(target)
  }),
)

// ============================================================================
// Selection helpers
// ============================================================================

export function getModelsForLevel(level: ThinkingLevel): Model[] {
  switch (level) {
    case "quick":
      return MODELS.filter((m) => m.costTier === "low" && !m.isDeepResearch).slice(0, 1)
    case "standard":
      return MODELS.filter((m) => m.costTier === "medium" && !m.isDeepResearch).slice(0, 1)
    case "research":
      return MODELS.filter((m) => m.isDeepResearch).slice(0, 1)
    case "consensus":
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

/** Estimate cost for a query (USD) — assumes ~500 input / ~1000 output tokens. */
export function estimateCost(model: Model | SkuConfig, inputTokens = 500, outputTokens = 1000): number {
  const inputCost = (model.inputPricePerM ?? 0) * (inputTokens / 1_000_000)
  const outputCost = (model.outputPricePerM ?? 0) * (outputTokens / 1_000_000)
  return inputCost + outputCost
}

export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${(cost * 100).toFixed(2)}¢`
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}

export function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`
  return `${(ms / 60000).toFixed(1)}min`
}

export function getCheapModel(): Model | undefined {
  return MODELS.find((m) => m.costTier === "low" && m.provider === "openai") || MODELS.find((m) => m.costTier === "low")
}

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

export function requiresConfirmation(model: Model | SkuConfig, threshold = 0.1): boolean {
  const estimatedCost = estimateCost(model)
  return estimatedCost > threshold || model.costTier === "very-high" || model.isDeepResearch
}

// ============================================================================
// Best-models curation per mode
// ============================================================================

export const BEST_MODELS = {
  default: ["gpt-5.4", "gemini-3-pro-preview", "claude-sonnet-4-6", "grok-4"],
  // Deep research — GPT-5.4 via Responses API + web_search is the best deep
  // research model. The "dedicated" deep research models (o3, gemini) are
  // kept as fallbacks only.
  deep: ["gpt-5.4", "o3-deep-research-2025-06-26", "deep-research-pro-preview-12-2025", "sonar-deep-research"],
  opinion: ["gemini-3-pro-preview", "gemini-2.5-pro", "gpt-5.4", "grok-4"],
  debate: ["gpt-5.4", "gemini-3-pro-preview", "grok-4", "claude-sonnet-4-6"],
  quick: ["gpt-5-nano", "gemini-2.0-flash-lite", "grok-3-fast", "claude-haiku-4-5-20251001"],
  // Pro - dual-pro mode (CLI `pro` keyword, no --model override) runs the
  // first two entries in parallel: GPT-5.4 Pro + Kimi K2.6.
  pro: ["gpt-5.4-pro", "moonshotai/kimi-k2.6", "gpt-5.5-pro", "o3-pro", "claude-opus-4-6", "gpt-5.2-pro"],
}

export type ModelMode = keyof typeof BEST_MODELS

export function getBestAvailableModel(
  mode: ModelMode,
  isProviderAvailable: (provider: Provider) => boolean,
): { model: Model | undefined; warning: string | undefined } {
  const candidates = BEST_MODELS[mode]
  const globalBest = getModel(candidates[0]!)

  for (const modelId of candidates) {
    const model = getModel(modelId)
    if (model && isProviderAvailable(model.provider)) {
      let warning: string | undefined
      if (globalBest && model.modelId !== globalBest.modelId) {
        const envVar = getProviderEnvVar(globalBest.provider)
        warning = `Best model for ${mode}: ${globalBest.displayName} (set ${envVar} to enable)`
      }
      return { model, warning }
    }
  }

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
      if (!available.find((m) => m.provider === model.provider)) {
        available.push(model)
      }
    } else {
      unavailable.push(model)
    }

    if (available.length >= count) break
  }

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

/** Map a Provider to the env var name that activates it. */
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
