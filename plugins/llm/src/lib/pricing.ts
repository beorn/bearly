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
 * The cache becomes stale after 5 days; `performPricingUpdate()` in dispatch.ts
 * refreshes it (and returns the snapshot for callers to write).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { MODELS, SKUS, setPricingOverlay } from "./types"

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
    }
  >
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
 * Snapshot the current effective pricing (SKU defaults + overlay) into the cache.
 *
 * Use after a successful pricing-update extraction to persist the new values.
 * This does NOT mutate the registry — it writes the JSON cache; subsequent
 * processes will pick the values up via `applyCachedPricing()` at startup.
 */
export function cacheCurrentPricing(): void {
  const models: PricingCache["models"] = {}

  for (const model of MODELS) {
    if (model.inputPricePerM !== undefined && model.outputPricePerM !== undefined) {
      models[model.modelId] = {
        inputPricePerM: model.inputPricePerM,
        outputPricePerM: model.outputPricePerM,
        typicalLatencyMs: model.typicalLatencyMs,
      }
    }
  }

  savePricingCache({
    updatedAt: new Date().toISOString(),
    models,
  })
}

/**
 * Build a fresh snapshot from a set of price updates, merging on top of the
 * current effective pricing. Returns the snapshot the caller can persist via
 * `savePricingCache(snapshot)` or `cacheCurrentPricing()` after applying the
 * overlay first.
 *
 * Pure — does not mutate any registry or cache. The dispatch-side updater
 * uses this so the registry never has to be mutated in-place.
 */
export function buildPricingSnapshot(
  updates: Array<{ modelId: string; inputPricePerM: number; outputPricePerM: number }>,
): PricingCache {
  const models: PricingCache["models"] = {}
  // Seed with SKU defaults so the snapshot is always full.
  for (const sku of SKUS) {
    if (sku.inputPricePerM !== undefined && sku.outputPricePerM !== undefined) {
      models[sku.modelId] = {
        inputPricePerM: sku.inputPricePerM,
        outputPricePerM: sku.outputPricePerM,
        typicalLatencyMs: sku.typicalLatencyMs,
      }
    }
  }
  // Layer the existing cache (if any) on top — preserves prior overrides.
  const existing = loadPricingCache()
  if (existing) {
    for (const [id, v] of Object.entries(existing.models)) {
      models[id] = { ...models[id], ...v }
    }
  }
  // Apply the new updates last.
  for (const u of updates) {
    const prev = models[u.modelId]
    models[u.modelId] = {
      inputPricePerM: u.inputPricePerM,
      outputPricePerM: u.outputPricePerM,
      typicalLatencyMs: prev?.typicalLatencyMs,
    }
  }
  return { updatedAt: new Date().toISOString(), models }
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

/**
 * Initialize pricing on startup
 */
export function initializePricing(): void {
  // Apply cached pricing as an overlay on the frozen registry.
  applyCachedPricing()

  // If no cache exists, seed one from the SKU defaults so the stale-timer
  // tracks "since first run" rather than perpetually firing.
  const cache = loadPricingCache()
  if (!cache) {
    cacheCurrentPricing()
  }
}
