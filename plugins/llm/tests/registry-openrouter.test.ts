/**
 * OpenRouter registry expansion: the curated registry is the dispatch gate —
 * a model is callable iff it has BOTH a SKU (identity + pricing) and a
 * ProviderEndpoint (routing). Every "Unknown model" FATAL in research.ts /
 * consensus.ts keys on that join, so these tests pin:
 *   1. Join integrity — every openrouter endpoint has a SKU and vice versa
 *      (derived over the whole provider set, not an enumerated list).
 *   2. The expansion ids are present in both maps with provider "openrouter".
 *   3. An unregistered id resolves in NEITHER map — the precondition all
 *      Unknown-model throw sites rely on stays intact (no silent fallback).
 */

import { describe, it, expect } from "vitest"
import { SKUS, PROVIDER_ENDPOINTS } from "../src/lib/types"

const EXPANSION_IDS = [
  "qwen/qwen3.7-flash",
  "google/gemini-3.6-flash",
  "google/gemini-3-flash-preview",
  "google/gemini-2.5-pro",
  "poolside/laguna-s-2.1",
  "meituan/longcat-2.0",
  "thinkingmachines/inkling",
  "moonshotai/kimi-k2.7-code",
] as const

describe("openrouter registry expansion", () => {
  it("every openrouter endpoint has a SKU and every openrouter SKU has an endpoint", () => {
    const endpointIds = Object.entries(PROVIDER_ENDPOINTS)
      .filter(([, endpoint]) => endpoint.provider === "openrouter")
      .map(([id]) => id)
      .sort()
    const skuIds = SKUS.filter((sku) => PROVIDER_ENDPOINTS[sku.modelId]?.provider === "openrouter")
      .map((sku) => sku.modelId)
      .sort()
    expect(endpointIds).toEqual(skuIds)
    expect(endpointIds.length).toBeGreaterThanOrEqual(12)
  })

  it("registers each expansion id in both maps with provider openrouter and real pricing", () => {
    for (const id of EXPANSION_IDS) {
      const endpoint = PROVIDER_ENDPOINTS[id]
      expect(endpoint, `endpoint missing: ${id}`).toBeDefined()
      expect(endpoint?.provider).toBe("openrouter")
      const sku = SKUS.find((candidate) => candidate.modelId === id)
      expect(sku, `SKU missing: ${id}`).toBeDefined()
      expect(sku!.inputPricePerM).toBeGreaterThan(0)
      expect(sku!.outputPricePerM).toBeGreaterThan(0)
      expect(sku!.reasoning?.contextWindow).toBeGreaterThan(0)
    }
  })

  it("keeps the OpenRouter route distinct from the google-direct gemini-2.5-pro SKU", () => {
    expect(PROVIDER_ENDPOINTS["gemini-2.5-pro"]?.provider).toBe("google")
    expect(PROVIDER_ENDPOINTS["google/gemini-2.5-pro"]?.provider).toBe("openrouter")
    const direct = SKUS.find((sku) => sku.modelId === "gemini-2.5-pro")
    const routed = SKUS.find((sku) => sku.modelId === "google/gemini-2.5-pro")
    expect(direct?.displayName).not.toBe(routed?.displayName)
  })

  it("an unregistered id resolves in neither map (Unknown-model FATAL precondition)", () => {
    const unknown = "google/gemini-9000-ultra"
    expect(PROVIDER_ENDPOINTS[unknown]).toBeUndefined()
    expect(SKUS.find((sku) => sku.modelId === unknown)).toBeUndefined()
  })
})
