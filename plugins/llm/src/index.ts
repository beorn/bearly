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
  ensureProviderKeysLoaded,
  getEnvLoadFailure,
  currentSeat,
  safeCurrentSeat,
  declaredHabitatEnvFile,
  missingApiKeyError,
} from "./lib/env-preflight.ts"
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
// Canonical usage/cost substrate (bead 19899 P1-P3): open usage-class map,
// independent stated charges/list-equivalent estimates; unknown is never $0.
export { resolveCost, serializeCost, aggregateCosts } from "./lib/cost.ts"
export type { UsageMap, UsageClass, ModelRates, ResolvedCost, CostAmount, CostBasis, CostFields } from "./lib/cost.ts"
export { lookupModelRates, resolveCostForModel, resolveResponseCost } from "./lib/pricing.ts"
export { LITELLM_PRICES_URL, fetchLiteLLMMap, parseLiteLLMMap, matchLiteLLMEntry } from "./lib/litellm.ts"
