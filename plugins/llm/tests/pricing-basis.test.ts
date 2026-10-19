/**
 * @failure  a lookup mixes SKU headlines with LiteLLM cache rates, a zero-match
 *           refresh rewrites the cache, or a pre-change row is treated as dated
 * @level    l2
 * @consumer 29660 dated Bearly rate basis
 * @testonly none
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeTestEnv } from "./helpers"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function pricing() {
  vi.resetModules()
  return import("../src/lib/pricing")
}

function cachePath(home: string): string {
  return join(home, ".cache", "tools", "llm-pricing.json")
}

describe("lookupModelRates basis", () => {
  it("reads headline rates, cache-class rates, and the basis from one entry with no overlay", async () => {
    const env = makeTestEnv()
    const mod = await pricing()
    mod.savePricingCache({
      updatedAt: "2020-01-01T00:00:00.000Z",
      models: {
        "retired-model": {
          inputPricePerM: 9,
          outputPricePerM: 10,
          cacheReadPerM: 1,
          cacheWritePerM: 2,
          rateSource: "litellm",
          rateDate: "2020-01-01T00:00:00.000Z",
        },
      },
    })
    const looked = mod.lookupModelRates("retired-model")
    expect(looked).toEqual({
      modelId: "retired-model",
      rates: { inputPerM: 9, outputPerM: 10, cacheReadPerM: 1, cacheWritePerM: 2 },
      basis: { rateSource: "litellm", rateDate: "2020-01-01T00:00:00.000Z" },
    })
    expect(env.homeDir).not.toBe("")
  })

  it("reads a pre-change entry as unrecorded", async () => {
    makeTestEnv()
    const mod = await pricing()
    mod.savePricingCache({
      updatedAt: "2020-01-01T00:00:00.000Z",
      models: {
        "old-row": { inputPricePerM: 4, outputPricePerM: 5, cacheReadPerM: 0.4 },
      },
    })
    expect(mod.lookupModelRates("old-row")?.basis).toEqual({ rateSource: "unrecorded" })
  })

  it("stamps a matched model and keeps an unmatched model's date", async () => {
    makeTestEnv()
    const mod = await pricing()
    const old = "2019-05-01T00:00:00.000Z"
    mod.savePricingCache({
      updatedAt: old,
      models: {
        matched: {
          inputPricePerM: 1,
          outputPricePerM: 2,
          rateSource: "litellm",
          rateDate: old,
        },
        held: {
          inputPricePerM: 3,
          outputPricePerM: 4,
          rateSource: "litellm",
          rateDate: old,
        },
      },
    })
    const snapshot = mod.buildPricingSnapshot([{ modelId: "matched", inputPricePerM: 1, outputPricePerM: 2 }])
    expect(snapshot.models.matched?.rateSource).toBe("litellm")
    expect(snapshot.models.matched?.rateDate).toBe(snapshot.updatedAt)
    expect(snapshot.models.matched?.rateDate).not.toBe(old)
    expect(snapshot.models.held?.rateDate).toBe(old)
    expect(snapshot.models.held?.rateSource).toBe("litellm")
  })
})

describe("performPricingUpdate writes nothing when nothing is accepted", () => {
  it("leaves the cache bytes unchanged when the map matches no tracked model", async () => {
    const env = makeTestEnv()
    const mod = await pricing()
    mod.savePricingCache({
      updatedAt: "2020-01-01T00:00:00.000Z",
      models: {
        kept: { inputPricePerM: 1, outputPricePerM: 2, rateSource: "litellm", rateDate: "2020-01-01T00:00:00.000Z" },
      },
    })
    const before = readFileSync(cachePath(env.homeDir), "utf8")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          "not-tracked": { input_cost_per_token: 1 / 1_000_000, output_cost_per_token: 1 / 1_000_000 },
        }),
      })),
    )
    vi.resetModules()
    const dispatch = await import("../src/lib/dispatch")
    const result = await dispatch.performPricingUpdate({ verbose: false, modelMode: "quick" })
    expect(result.error).toMatch(/Pricing cache unchanged/)
    expect(readFileSync(cachePath(env.homeDir), "utf8")).toBe(before)
  })

  it("leaves the cache bytes unchanged when the 10× guard holds every match", async () => {
    const env = makeTestEnv()
    const mod = await pricing()
    mod.savePricingCache({
      updatedAt: "2020-01-01T00:00:00.000Z",
      models: {
        "gpt-5.4": {
          inputPricePerM: 2.5,
          outputPricePerM: 15,
          rateSource: "litellm",
          rateDate: "2020-01-01T00:00:00.000Z",
        },
      },
    })
    const before = readFileSync(cachePath(env.homeDir), "utf8")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          "gpt-5.4": { input_cost_per_token: 250 / 1_000_000, output_cost_per_token: 1500 / 1_000_000 },
        }),
      })),
    )
    vi.resetModules()
    const dispatch = await import("../src/lib/dispatch")
    const result = await dispatch.performPricingUpdate({ verbose: false, modelMode: "quick" })
    expect(result.priceChanges).toHaveLength(0)
    expect(result.error).toMatch(/Pricing cache unchanged/)
    expect(readFileSync(cachePath(env.homeDir), "utf8")).toBe(before)
  })
})
