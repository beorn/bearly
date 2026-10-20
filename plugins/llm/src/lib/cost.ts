/**
 * Canonical LLM usage/cost substrate (km bead 19899 Phase 0, policy P1–P5).
 *
 * One contract for every cost consumer (/llm commands, /ask prose, external
 * apps): retain a stated charge independently from a list-equivalent estimate
 * derived from an open usage-class map and its rate basis.
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
 *  P2 charged and list-equivalent dollars are independent. An unavailable
 *     amount has a reason, never a synthetic numeric zero. A stated zero is
 *     known; a subscription allowance is not a stated API-key charge.
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

export type CostAmount = { usd: number } | { reason: string }

export interface CostBasis {
  rateSource: "litellm" | "sku" | "unrecorded"
  rateDate?: string
  matchedModelId?: string
}

export interface ResolvedCost {
  charged: CostAmount
  listEquivalent: CostAmount
  listEquivalentBasis: CostBasis[]
  /** Per-class list-equivalent USD contributions; reasoning is an output subset. */
  breakdown?: Partial<Record<UsageClass, number>>
}

/** Canonical serialized columns. Each amount is emitted with either its value or its reason. */
export interface CostFields {
  cost_usd?: number
  cost_usd_reason?: string
  list_equivalent_usd?: number
  list_equivalent_reason?: string
  list_equivalent_basis: CostBasis[]
}

/** Decode saved canonical columns without reinterpreting older ambiguous scalar fields. */
export function deserializeCost(fields?: Partial<CostFields>): ResolvedCost {
  const amount = (usd: number | undefined, reason: string | undefined, name: string): CostAmount =>
    usd === undefined
      ? { reason: reason || `${name} facts are unavailable` }
      : Number.isFinite(usd) && usd >= 0
        ? { usd }
        : { reason: `stored ${name} amount is invalid` }
  return {
    charged: amount(fields?.cost_usd, fields?.cost_usd_reason, "charged"),
    listEquivalent: amount(fields?.list_equivalent_usd, fields?.list_equivalent_reason, "list-equivalent"),
    listEquivalentBasis: fields?.list_equivalent_basis ?? [],
  }
}

export function serializeCost(cost: ResolvedCost): CostFields {
  return {
    ...("usd" in cost.charged ? { cost_usd: cost.charged.usd } : { cost_usd_reason: cost.charged.reason }),
    ...("usd" in cost.listEquivalent
      ? { list_equivalent_usd: cost.listEquivalent.usd }
      : { list_equivalent_reason: cost.listEquivalent.reason }),
    list_equivalent_basis: cost.listEquivalentBasis,
  }
}

/** Sum every invoked call independently in each column; absent facts are never free. */
export function aggregateCosts(costs: readonly ResolvedCost[]): ResolvedCost {
  const total = (column: "charged" | "listEquivalent"): CostAmount => {
    const unknown = costs.filter((cost) => "reason" in cost[column])
    if (unknown.length) {
      return { reason: `${column} unavailable for ${unknown.length} of ${costs.length} invoked calls` }
    }
    let usd = 0
    for (const cost of costs) {
      const amount = cost[column]
      if ("usd" in amount) usd += amount.usd
    }
    return Number.isFinite(usd) ? { usd } : { reason: `${column} total is not finite` }
  }
  return {
    charged: total("charged"),
    listEquivalent: total("listEquivalent"),
    listEquivalentBasis: costs.flatMap((cost) => cost.listEquivalentBasis),
  }
}

interface CostOptions {
  usage: UsageMap
  rates?: ModelRates | null
  /** A validated stated charge from the actual API-key route, not an estimate. */
  reportedUsd?: number
  basis?: readonly CostBasis[]
  /** Subscription/cache reuse cannot restate an original bill as a new charge. */
  chargedUnavailableReason?: string
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
 * Resolve both meanings without precedence or pre-display rounding.
 * Missing charge facts do not suppress a computable estimate, and a stated
 * charge does not supply missing rates or usage.
 */
export function resolveCost(opts: CostOptions): ResolvedCost {
  const charged: CostAmount =
    opts.chargedUnavailableReason !== undefined
      ? { reason: opts.chargedUnavailableReason }
      : opts.reportedUsd === undefined
        ? { reason: "provider did not state a charge" }
        : !Number.isFinite(opts.reportedUsd) || opts.reportedUsd < 0
          ? { reason: "provider stated an invalid charge" }
          : { usd: opts.reportedUsd }
  const rates = opts.rates
  const listEquivalentBasis = opts.basis ? [...opts.basis] : rates ? [{ rateSource: "unrecorded" as const }] : []
  const unknownEstimate = (reason: string): ResolvedCost => ({
    charged,
    listEquivalent: { reason },
    listEquivalentBasis,
  })
  if (!rates) return unknownEstimate("model rates are unavailable")
  const breakdown: Partial<Record<UsageClass, number>> = {}
  let usd = 0
  let hasPricedUsage = false
  for (const cls of ["input", "output", "cache_read", "cache_write"] as const) {
    const tokens = opts.usage[cls]
    if (tokens === undefined) continue
    hasPricedUsage = true
    const rate = classRate(rates, cls)
    if (!Number.isFinite(tokens) || tokens < 0) return unknownEstimate(`${cls} token count is invalid`)
    if (rate === undefined || !Number.isFinite(rate) || rate < 0) {
      return unknownEstimate(`${cls} token rate is invalid`)
    }
    const contribution = rate * (tokens / 1_000_000)
    if (tokens !== 0) breakdown[cls] = contribution
    usd += contribution
  }
  if (!hasPricedUsage) return unknownEstimate("no priced token classes were reported")
  if (!Number.isFinite(usd)) return unknownEstimate("list-equivalent calculation is not finite")
  return { charged, listEquivalent: { usd }, listEquivalentBasis, breakdown }
}

/**
 * A subscription has no stated API-key charge. Its list-equivalent estimate
 * still uses the actual served model's rates/usage when the caller has them.
 */
export function resolveSubscriptionCost(
  opts: Pick<CostOptions, "usage" | "rates" | "basis"> = { usage: {} },
): ResolvedCost {
  return resolveCost({
    usage: opts.usage,
    rates: opts.rates,
    basis: opts.basis,
    chargedUnavailableReason: "subscription route has no stated API-key charge",
  })
}
