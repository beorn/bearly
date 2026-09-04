/**
 * @bearly/llm — barrel export
 *
 * Multi-provider LLM dispatch: cheap-model race, consensus queries, deep
 * research, provider detection, pricing, persistence. Provider-agnostic
 * wrappers around OpenAI, Anthropic, Gemini, xAI, and Ollama.
 *
 * Consumed by @bearly/recall (LLM-driven query planning + synthesis),
 * @bearly/tribe (session summarizer — internally), and the standalone `bun llm` CLI.
 */

export { queryModel } from "./lib/research.ts"
export {
  getCheapModel,
  getCheapModels,
  selectModels,
  getModel,
  estimateCost,
  formatCost,
  resolveCostForModel,
  skuRates,
  MODELS,
} from "./lib/types.ts"
export type {
  Model,
  Provider,
  ModelSelectionEvidence,
  ModelSelectionExclusion,
  ModelSelectionResult,
  SelectModelsOptions,
} from "./lib/types.ts"
export { isProviderAvailable, getAvailableProviders } from "./lib/providers.ts"
export {
  createProviderObservationStore,
  readProviderAvailability,
  recordProviderObservation,
} from "./lib/provider-availability.ts"
export type {
  CreateProviderObservationStoreOptions,
  ProviderAvailabilityFact,
  ProviderAvailabilityStatus,
  ProviderObservation,
  ProviderObservationReadResult,
  ProviderObservationStore,
  ProviderRefusalKind,
  ReadProviderAvailabilityOptions,
  RecordedProviderObservation,
} from "./lib/provider-availability.ts"
export { describeDispatchFailure } from "./lib/dispatch-error.ts"
export type { DispatchFailureDescription, DispatchFailureKind, DispatchFailureTarget } from "./lib/dispatch-error.ts"
export { buildMockQueryModel, buildPlanJson, alwaysAvailable } from "./lib/mock.ts"
// Canonical usage/cost substrate (bead 19899 P1–P3): open usage-class map,
// reported > computed > unknown precedence, unknown never renders as $0.
export { normalizeUsage, resolveCost, formatResolvedCost, UNKNOWN_COST_LABEL } from "./lib/cost.ts"
export type { UsageMap, UsageClass, ModelRates, ResolvedCost, CostSource, ProviderUsageLike } from "./lib/cost.ts"
export { lookupModelRates } from "./lib/pricing.ts"
export { LITELLM_PRICES_URL, fetchLiteLLMMap, parseLiteLLMMap, matchLiteLLMEntry } from "./lib/litellm.ts"
