/**
 * LiteLLM price-map source (km bead 19899 P5: ONE maintained price source).
 *
 * Consumes BerriAI/litellm's community-maintained
 * `model_prices_and_context_window.json` — the de-facto shared LLM price map
 * (MIT; per-token USD; models cache-read/cache-write rates; day-0 model
 * coverage). This replaces the previous scrape-provider-pricing-pages +
 * LLM-extraction pipeline in `cmd/pricing.ts` with a deterministic fetch.
 *
 * Units: LiteLLM stores USD **per token**; this module converts to the
 * plugin's per-1M convention at the parse boundary so everything downstream
 * (SKU registry, pricing cache, cost.ts) speaks one unit.
 */

import type { ModelRates } from "./cost.ts"

export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"

interface LiteLLMEntry {
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
  litellm_provider?: string
  max_input_tokens?: number
  max_output_tokens?: number
  supports_vision?: boolean
  supports_prompt_caching?: boolean
  supports_reasoning?: boolean
  mode?: string
}

export type LiteLLMRatesMap = Map<string, ModelRates & { provider?: string }>

/**
 * Per-token USD → per-1M USD, rounded to 6 decimals. Upstream stores values
 * like `2e-7`; a raw `* 1_000_000` yields float debris
 * (`0.19999999999999998`) that fabricates phantom price "changes" in the
 * update diff. Six decimals of a per-M price = $0.000001 resolution — far
 * below any real price granularity.
 */
function perM(perToken: number): number {
  return Math.round(perToken * 1_000_000 * 1_000_000) / 1_000_000
}

/**
 * Parse the raw LiteLLM JSON into a per-M rates map. Entries without both an
 * input and output rate are skipped (embeddings, image models, the
 * `sample_spec` documentation entry).
 */
export function parseLiteLLMMap(json: Record<string, unknown>): LiteLLMRatesMap {
  const map: LiteLLMRatesMap = new Map()
  for (const [key, value] of Object.entries(json)) {
    if (key === "sample_spec" || typeof value !== "object" || value === null) continue
    const entry = value as LiteLLMEntry
    if (typeof entry.input_cost_per_token !== "number" || typeof entry.output_cost_per_token !== "number") continue
    const rates: ModelRates & { provider?: string } = {
      inputPerM: perM(entry.input_cost_per_token),
      outputPerM: perM(entry.output_cost_per_token),
      ...(typeof entry.cache_read_input_token_cost === "number"
        ? { cacheReadPerM: perM(entry.cache_read_input_token_cost) }
        : {}),
      ...(typeof entry.cache_creation_input_token_cost === "number"
        ? { cacheWritePerM: perM(entry.cache_creation_input_token_cost) }
        : {}),
      ...(entry.litellm_provider ? { provider: entry.litellm_provider } : {}),
    }
    map.set(key, rates)
  }
  return map
}

/**
 * Resolve a model against the LiteLLM map by candidate ids. Tries, in order:
 * exact key, then each candidate with its provider prefix stripped
 * (`openai/gpt-4o` → `gpt-4o` — the OpenHands fallback pattern), then a
 * prefixed lookup for every distinct provider prefix present in the
 * candidates. First hit wins; a miss returns null (callers treat that as
 * cost-source UNKNOWN, never $0).
 */
export function matchLiteLLMEntry(map: LiteLLMRatesMap, candidates: string[]): ModelRates | null {
  for (const candidate of candidates) {
    if (!candidate) continue
    const exact = map.get(candidate)
    if (exact) return exact
    const slash = candidate.lastIndexOf("/")
    if (slash !== -1) {
      const stripped = map.get(candidate.slice(slash + 1))
      if (stripped) return stripped
    }
  }
  return null
}

/**
 * Fetch + parse the live LiteLLM map. Throws on network/HTTP/parse failure —
 * callers decide whether that is fatal (`llm update-pricing` reports the
 * error and leaves the cache untouched, preserving the retry timer).
 */
export async function fetchLiteLLMMap(opts: { timeoutMs?: number } = {}): Promise<LiteLLMRatesMap> {
  const resp = await fetch(LITELLM_PRICES_URL, {
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    redirect: "follow",
  })
  if (!resp.ok) {
    throw new Error(`LiteLLM price map fetch failed: HTTP ${resp.status}`)
  }
  const json = (await resp.json()) as Record<string, unknown>
  const map = parseLiteLLMMap(json)
  if (map.size === 0) {
    throw new Error("LiteLLM price map parsed to zero priced models — refusing to treat as valid")
  }
  return map
}

/**
 * Render LiteLLM entries that are NOT in our SKU registry as a synthetic
 * provider-page block for the stage-1 discovery pipeline (discover.ts) —
 * `[PROVIDER — url]\ntext` shape. The LiteLLM map replaces the scraped
 * provider doc pages as the discovery feed: new models appear there day-0
 * with prices and capability booleans.
 */
export function renderUnknownModelsPage(map: LiteLLMRatesMap, knownIds: ReadonlySet<string>): string {
  const lines: string[] = []
  for (const [key, rates] of map) {
    const bare = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key
    if (knownIds.has(key) || knownIds.has(bare)) continue
    lines.push(`${key}: $${rates.inputPerM.toFixed(2)}/M in, $${rates.outputPerM.toFixed(2)}/M out`)
  }
  return `[LITELLM — ${LITELLM_PRICES_URL}]\n${lines.join("\n")}`
}
