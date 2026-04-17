/**
 * @bearly/llm — barrel export
 *
 * Multi-provider LLM dispatch: cheap-model race, consensus queries, deep
 * research, provider detection, pricing, persistence. Provider-agnostic
 * wrappers around OpenAI, Anthropic, Gemini, xAI, and Ollama.
 *
 * Consumed by @bearly/recall (LLM-driven query planning + synthesis),
 * @bearly/lore (session summarizer), and the standalone `bun llm` CLI.
 */

export { queryModel } from "./lib/research.ts"
export { getCheapModel, getCheapModels, getModel, estimateCost, formatCost, MODELS } from "./lib/types.ts"
export type { Model } from "./lib/types.ts"
export { isProviderAvailable, getAvailableProviders } from "./lib/providers.ts"
export { buildMockQueryModel, buildPlanJson, alwaysAvailable } from "./lib/mock.ts"
