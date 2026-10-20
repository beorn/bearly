/**
 * Pricing cache and runtime overlay.
 *
 * The SKU registry in types.ts is frozen — pricing values there are baseline
 * defaults. This module manages a JSON cache (`~/.cache/tools/llm-pricing.json`)
 * containing current pricing, and overlays it onto the registry at process
 * start via `setPricingOverlay()`. Reads of `model.inputPricePerM` /
 * `outputPricePerM` always see the current overlay (the legacy `MODELS` rows
 * use property getters that consult the overlay map).
 *
 * The cache becomes stale after 5 days. `performPricingUpdate()` writes the
 * cache itself, or returns an error and leaves the cache unchanged.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { SKUS, setPricingOverlay, type Model, type SkuConfig } from "./types"
import { resolveCost, type CostBasis, type ModelRates, type ResolvedCost, type UsageMap } from "./cost.ts"

// Cache location (in user's home directory)
const CACHE_DIR = join(process.env.HOME ?? "~", ".cache", "tools")
const PRICING_CACHE_FILE = join(CACHE_DIR, "llm-pricing.json")
const STALE_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000 // 5 days

interface PricingCache {
  updatedAt: string // ISO date
  models: Record<
    string,
    {
      inputPricePerM: number
      outputPricePerM: number
      typicalLatencyMs?: number
      /** Cache-class rates from the LiteLLM map (bead 19899 P3). Optional —
       *  pre-19899 caches lack them; cost.ts then bills cache classes at the
       *  input rate (LiteLLM's own fallback convention). */
      cacheReadPerM?: number
      cacheWritePerM?: number
      /** Absent on a cache written before the dated basis. The lookup then
       * reports `unrecorded` and does not infer a date from `updatedAt`. */
      rateSource?: "litellm" | "sku"
      rateDate?: string
    }
  >
}

/** Where a model's rates came from. `unrecorded` is a cache row with no basis fields. */
export type RateSource = CostBasis["rateSource"]

export interface ModelRateLookup {
  modelId: string
  rates: ModelRates
  basis: { rateSource: RateSource; rateDate?: string }
}

/**
 * Load cached pricing data
 */
export function loadPricingCache(): PricingCache | null {
  try {
    if (!existsSync(PRICING_CACHE_FILE)) return null
    const data = readFileSync(PRICING_CACHE_FILE, "utf-8")
    return JSON.parse(data) as PricingCache
  } catch {
    return null
  }
}

/**
 * Save pricing data to cache
 */
export function savePricingCache(cache: PricingCache): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(PRICING_CACHE_FILE, JSON.stringify(cache, null, 2))
  } catch (error) {
    console.error("Failed to save pricing cache:", error)
  }
}

/**
 * Check if pricing cache is stale
 */
export function isPricingStale(): boolean {
  const cache = loadPricingCache()
  if (!cache) return true

  const updatedAt = new Date(cache.updatedAt).getTime()
  const now = Date.now()
  return now - updatedAt > STALE_THRESHOLD_MS
}

/**
 * Get days since last pricing update
 */
export function getDaysSinceUpdate(): number | null {
  const cache = loadPricingCache()
  if (!cache) return null

  const updatedAt = new Date(cache.updatedAt).getTime()
  const now = Date.now()
  return Math.floor((now - updatedAt) / (24 * 60 * 60 * 1000))
}

/**
 * Apply cached pricing to the runtime overlay (registry stays frozen).
 *
 * After this call, every read of `model.inputPricePerM` / `outputPricePerM` /
 * `typicalLatencyMs` reflects the cache values where present, falling through
 * to the SKU defaults otherwise.
 */
export function applyCachedPricing(): void {
  const cache = loadPricingCache()
  if (!cache) return
  setPricingOverlay(cache.models)
}

/**
 * Build a fresh snapshot from a set of accepted price updates, merging on top
 * of the current cache. This is the only merge. A caller that has no accepted
 * update does not call it: that refresh is an error and the cache stays put.
 *
 * A matched row takes cache-class rates only from this update. An omitted
 * class stays absent. `typicalLatencyMs` still comes from the previous row.
 *
 * Pure — does not mutate any registry or cache.
 */
export function buildPricingSnapshot(
  updates: Array<{
    modelId: string
    inputPricePerM: number
    outputPricePerM: number
    cacheReadPerM?: number
    cacheWritePerM?: number
  }>,
): PricingCache {
  const updatedAt = new Date().toISOString()
  const models: PricingCache["models"] = {}
  // Seed with frozen SKU defaults. A row that no cache entry and no update
  // replaces is sku, with no date.
  for (const sku of SKUS) {
    if (sku.inputPricePerM !== undefined && sku.outputPricePerM !== undefined) {
      models[sku.modelId] = {
        inputPricePerM: sku.inputPricePerM,
        outputPricePerM: sku.outputPricePerM,
        typicalLatencyMs: sku.typicalLatencyMs,
        rateSource: "sku",
      }
    }
  }
  // A previous entry is kept whole, including its basis. An entry with no
  // basis fields stays that way so the lookup reports unrecorded.
  const existing = loadPricingCache()
  if (existing) {
    for (const [id, v] of Object.entries(existing.models)) {
      const merged = { ...models[id], ...v }
      if (v.rateSource === undefined) {
        delete merged.rateSource
        delete merged.rateDate
      }
      models[id] = merged
    }
  }
  for (const u of updates) {
    const prev = models[u.modelId]
    models[u.modelId] = {
      inputPricePerM: u.inputPricePerM,
      outputPricePerM: u.outputPricePerM,
      ...(prev?.typicalLatencyMs !== undefined ? { typicalLatencyMs: prev.typicalLatencyMs } : {}),
      ...(u.cacheReadPerM !== undefined ? { cacheReadPerM: u.cacheReadPerM } : {}),
      ...(u.cacheWritePerM !== undefined ? { cacheWritePerM: u.cacheWritePerM } : {}),
      rateSource: "litellm",
      rateDate: updatedAt,
    }
  }
  return { updatedAt, models }
}

/**
 * Rates and basis for one model, from a single cache entry when one exists.
 *
 * Headline rates, cache-class rates, and the basis all come from that entry.
 * This does not read `MODELS`: those getters show LiteLLM headlines only after
 * `applyCachedPricing` has run in this process. A cache entry whose id is no
 * longer a SKU still answers, with its own basis, so an older session can
 * price on the last known rate and the date shows its age.
 *
 * No entry: the frozen SKU default, basis `sku`, no date. Not a SKU and not
 * cached: null. An entry with no basis fields reads `unrecorded`.
 */
export function lookupModelRates(modelId: string): ModelRateLookup | null {
  const cached = loadPricingCache()?.models[modelId]
  if (cached?.inputPricePerM !== undefined && cached.outputPricePerM !== undefined) {
    const basis =
      cached.rateSource === "litellm"
        ? { rateSource: "litellm" as const, ...(cached.rateDate !== undefined ? { rateDate: cached.rateDate } : {}) }
        : cached.rateSource === "sku"
          ? { rateSource: "sku" as const }
          : { rateSource: "unrecorded" as const }
    return {
      modelId,
      rates: {
        inputPerM: cached.inputPricePerM,
        outputPerM: cached.outputPricePerM,
        ...(cached.cacheReadPerM !== undefined ? { cacheReadPerM: cached.cacheReadPerM } : {}),
        ...(cached.cacheWritePerM !== undefined ? { cacheWritePerM: cached.cacheWritePerM } : {}),
      },
      basis,
    }
  }
  const sku = SKUS.find((s) => s.modelId === modelId)
  if (sku?.inputPricePerM === undefined || sku?.outputPricePerM === undefined) return null
  return {
    modelId,
    rates: { inputPerM: sku.inputPricePerM, outputPerM: sku.outputPricePerM },
    basis: { rateSource: "sku" },
  }
}

/**
 * Pricing sources for auto-update
 */
export const PRICING_SOURCES = {
  openai: "https://openai.com/api/pricing/",
  anthropic: "https://www.anthropic.com/pricing",
  google: "https://ai.google.dev/pricing",
  xai: "https://x.ai/api",
  perplexity: "https://docs.perplexity.ai/guides/pricing",
}

/**
 * Parse pricing from OpenAI pricing page (simplified)
 * In practice, this would need proper web scraping or API calls
 */
export interface PricingUpdate {
  modelId: string
  inputPricePerM: number
  outputPricePerM: number
}

/**
 * Format stale warning message
 */
export function getStaleWarning(): string | null {
  const days = getDaysSinceUpdate()
  if (days === null) {
    return "⚠️  No pricing cache found. Run `llm update-pricing` to fetch latest prices."
  }
  if (days > 5) {
    return `⚠️  Pricing data is ${days} days old. Run \`llm update-pricing\` to refresh.`
  }
  return null
}

/** Provenance-aware cost. One path: the lookup, which already answers SKU defaults. */
export function resolveCostForModel(model: Model | SkuConfig, usage: UsageMap, reportedUsd?: number): ResolvedCost {
  const lookup = lookupModelRates(model.modelId)
  return resolveCost({
    usage,
    ...(lookup ? { rates: lookup.rates } : {}),
    ...(reportedUsd !== undefined ? { reportedUsd } : {}),
  })
}

/**
 * Initialize pricing on startup
 */
export function initializePricing(): void {
  applyCachedPricing()
  // A missing cache is seeded from SKU defaults. The seed is sku with no date.
  if (!loadPricingCache()) {
    savePricingCache(buildPricingSnapshot([]))
  }
}
