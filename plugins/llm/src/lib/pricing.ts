/**
 * Pricing cache and auto-update functionality
 *
 * Caches model pricing info and auto-updates when stale (>5 days old)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { MODELS, type Model } from "./types"

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
 * Apply cached pricing to models (mutates MODELS array)
 */
export function applyCachedPricing(): void {
  const cache = loadPricingCache()
  if (!cache) return

  for (const model of MODELS) {
    const cached = cache.models[model.modelId]
    if (cached) {
      model.inputPricePerM = cached.inputPricePerM
      model.outputPricePerM = cached.outputPricePerM
      if (cached.typicalLatencyMs) {
        model.typicalLatencyMs = cached.typicalLatencyMs
      }
    }
  }
}

/**
 * Save current model pricing to cache
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
  // First, try to apply cached pricing
  applyCachedPricing()

  // If no cache exists, create one from hardcoded values
  const cache = loadPricingCache()
  if (!cache) {
    cacheCurrentPricing()
  }
}
