/**
 * Canonical LLM usage/cost substrate (km bead 19899 Phase 0, policy P1–P5).
 *
 * One contract for every cost consumer (/llm commands, /ask prose, external
 * apps): normalize provider usage shapes into an open usage-class map, then
 * resolve a cost with an explicit provenance label.
 *
 * SOURCE-SELECTION DECISION (recorded per bead @km/bearly/20798):
 * price data comes from LiteLLM's community-maintained
 * `model_prices_and_context_window.json` (see litellm.ts) — MIT, raw-URL
 * consumable, day-0 model coverage, and it models cache-read/cache-write/
 * reasoning rates. The npm `tokentally` library was evaluated as a dependency
 * (TS, active, LiteLLM-aware) but rejected for now: it is young (0.1.x), and
 * the normalization + precedence logic we need is ~150 LOC that must match
 * OUR usage-class vocabulary exactly — a dependency would still need a
 * wrapper of comparable size. Its design informed this module.
 *
 * Semantics rules (from the accepted 19899 design):
 *  P1 usage classes are an OPEN map with OTel-aligned token naming:
 *     input / output / cache_read / cache_write / reasoning (+ future keys).
 *     `input` is always NON-CACHED input; cache classes are disjoint from it.
 *     `reasoning` is informational — it is a subset of `output` on every
 *     provider that reports it, so it is never priced separately here.
 *  P2 cost precedence: provider-reported > computed > unknown. Unknown is a
 *     first-class result (`source: "unknown"`) and must NEVER render as $0 —
 *     use `formatResolvedCost`, which renders the unknown label.
 *  P3 cache classes are priced at their own rates; a missing cache rate
 *     falls back to the input rate (LiteLLM's own convention).
 */

// ============================================================================
// Usage classes (P1)
// ============================================================================

/** Canonical usage-class keys. Open map — unknown keys are preserved. */
export type UsageClass = "input" | "output" | "cache_read" | "cache_write" | "reasoning"

/** Open usage map: canonical classes plus any future provider classes. */
export type UsageMap = Partial<Record<UsageClass, number>> & Record<string, number>

/**
 * Raw provider usage — the union of shapes seen on the wire. All fields
 * optional; `normalizeUsage` sorts out which dialect it is looking at.
 */
export interface ProviderUsageLike {
  // OpenAI chat-completions dialect
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
  // OpenAI responses / Anthropic dialect
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
  // Anthropic cache classes (disjoint from input_tokens by API contract)
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/**
 * Normalize a raw provider usage object into the canonical {@link UsageMap}.
 *
 * Dialect semantics (the load-bearing part):
 * - **Anthropic**: `input_tokens` already EXCLUDES cache reads/writes — the
 *   three classes map through disjoint.
 * - **OpenAI (chat + responses)**: `cached_tokens` is a SUBSET of the prompt/
 *   input count — subtract it so `input` means non-cached input everywhere.
 * - **reasoning**: a subset of output on both OpenAI dialects; surfaced as its
 *   own class for display, never priced on top of `output`.
 */
export function normalizeUsage(raw: ProviderUsageLike): UsageMap {
  const usage: UsageMap = {}

  const anthropicCacheRead = raw.cache_read_input_tokens
  const anthropicCacheWrite = raw.cache_creation_input_tokens
  const isAnthropic = anthropicCacheRead !== undefined || anthropicCacheWrite !== undefined

  const rawInput = raw.input_tokens ?? raw.prompt_tokens
  const rawOutput = raw.output_tokens ?? raw.completion_tokens
  const openaiCached = raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens
  const reasoning = raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens

  if (rawInput !== undefined) {
    if (isAnthropic) {
      usage.input = rawInput
    } else if (openaiCached !== undefined) {
      usage.input = Math.max(0, rawInput - openaiCached)
      usage.cache_read = openaiCached
    } else {
      usage.input = rawInput
    }
  }
  if (rawOutput !== undefined) usage.output = rawOutput
  if (anthropicCacheRead !== undefined) usage.cache_read = anthropicCacheRead
  if (anthropicCacheWrite !== undefined) usage.cache_write = anthropicCacheWrite
  if (reasoning !== undefined) usage.reasoning = reasoning

  return usage
}

// ============================================================================
// Rates + resolution (P2/P3)
// ============================================================================

/** Per-1M-token USD rates (the plugin's existing convention). */
export interface ModelRates {
  inputPerM: number
  outputPerM: number
  cacheReadPerM?: number
  cacheWritePerM?: number
}

export type CostSource = "provider" | "computed" | "unknown"

export interface ResolvedCost {
  /** USD. Meaningful only when `source !== "unknown"` (0 there is a default, not a price). */
  usd: number
  source: CostSource
  /** Per-class USD contributions (computed source only). */
  breakdown?: Partial<Record<UsageClass, number>>
}

/** Priced classes and the rate each bills at. `reasoning` is deliberately
 *  absent — it is a subset of `output` on every provider that reports it. */
function classRate(rates: ModelRates, cls: UsageClass): number | undefined {
  switch (cls) {
    case "input":
      return rates.inputPerM
    case "output":
      return rates.outputPerM
    case "cache_read":
      // LiteLLM convention: an unset cache rate bills at the input rate.
      return rates.cacheReadPerM ?? rates.inputPerM
    case "cache_write":
      return rates.cacheWritePerM ?? rates.inputPerM
    case "reasoning":
      return undefined
  }
}

/**
 * Resolve a cost with explicit provenance (P2: reported > computed > unknown).
 *
 * - `reportedUsd` defined (including a genuine 0) → `source: "provider"`.
 * - else `rates` present → `source: "computed"` with a per-class breakdown.
 * - else → `source: "unknown"` — callers must not render `usd` as a dollar
 *   figure (use {@link formatResolvedCost}).
 */
export function resolveCost(opts: { usage: UsageMap; rates?: ModelRates | null; reportedUsd?: number }): ResolvedCost {
  if (opts.reportedUsd !== undefined) {
    return { usd: opts.reportedUsd, source: "provider" }
  }
  const rates = opts.rates
  if (rates) {
    const breakdown: Partial<Record<UsageClass, number>> = {}
    let usd = 0
    for (const cls of ["input", "output", "cache_read", "cache_write"] as const) {
      const tokens = opts.usage[cls]
      if (tokens === undefined || tokens === 0) continue
      const rate = classRate(rates, cls)
      if (rate === undefined) continue
      const contribution = rate * (tokens / 1_000_000)
      breakdown[cls] = contribution
      usd += contribution
    }
    return { usd, source: "computed", breakdown }
  }
  return { usd: 0, source: "unknown" }
}

/** Rendered for a cost with no price source — never a synthetic "$0". */
export const UNKNOWN_COST_LABEL = "—"

/**
 * Format a resolved cost for display. Unknown renders the unknown label (P2);
 * known values reuse the plugin's ¢/$ conventions.
 */
export function formatResolvedCost(cost: ResolvedCost): string {
  if (cost.source === "unknown") return UNKNOWN_COST_LABEL
  if (cost.usd < 0.01) return `$${(cost.usd * 100).toFixed(2)}¢`
  if (cost.usd < 1) return `$${cost.usd.toFixed(3)}`
  return `$${cost.usd.toFixed(2)}`
}
