/**
 * @failure Provider health silently collapses missing, stale, or corrupt evidence into a usable boolean and lets older writers overwrite newer facts.
 * @level l0
 * @consumer @bearly/llm selectors and cross-process Recall dispatch
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProviderObservationStore, readProviderAvailability, recordProviderObservation } from "../src/index"
import { isOllamaAvailable } from "../src/lib/ollama"
import type { ProviderObservationStore, RecordedProviderObservation } from "../src/index"

let cacheRoot: string

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "bearly-provider-facts-"))
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(cacheRoot, { recursive: true, force: true })
})

function memoryStore(
  write = vi.fn(async (_observation: RecordedProviderObservation) => undefined),
): ProviderObservationStore {
  return {
    pathFor: () => "/test/providers/ollama.json",
    read: vi.fn(async () => ({ status: "absent" as const, path: "/test/providers/ollama.json" })),
    write,
  }
}

describe("provider observation store", () => {
  it("keeps the newest observed fact when two store instances write out of order", async () => {
    const firstWriter = createProviderObservationStore({ cacheRoot })
    const secondWriter = createProviderObservationStore({ cacheRoot })

    await recordProviderObservation(firstWriter, {
      provider: "openai",
      status: "available",
      source: "dispatch",
      reason: "successful completion",
      observedAt: 2_000,
    })
    await recordProviderObservation(secondWriter, {
      provider: "openai",
      status: "refusing",
      kind: "auth",
      source: "dispatch",
      reason: "401 invalid_api_key",
      observedAt: 1_000,
    })

    const fact = await readProviderAvailability("openai", {
      store: firstWriter,
      now: 2_001,
      env: { OPENAI_API_KEY: "configured" },
    })
    expect(fact).toMatchObject({
      status: "available",
      source: "dispatch",
      observedAt: 2_000,
      reason: "successful completion",
    })
  })

  it("turns corrupt persisted evidence into one loud unknown fact naming the path", async () => {
    const warn = vi.fn()
    const store = createProviderObservationStore({ cacheRoot, warn })
    const providerDir = join(cacheRoot, "providers")
    const providerPath = join(providerDir, "openai.json")
    mkdirSync(providerDir, { recursive: true })
    writeFileSync(providerPath, "{not-json")

    const fact = await readProviderAvailability("openai", {
      store,
      now: 5_000,
      env: { OPENAI_API_KEY: "configured" },
    })

    expect(fact.status).toBe("unknown")
    expect(fact.reason).toContain(`observation store unreadable: ${providerPath}:`)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(providerPath))
  })

  it("turns a wrong-version observation into one loud unknown fact", async () => {
    const warn = vi.fn()
    const store = createProviderObservationStore({ cacheRoot, warn })
    const providerDir = join(cacheRoot, "providers")
    const providerPath = join(providerDir, "openai.json")
    mkdirSync(providerDir, { recursive: true })
    writeFileSync(providerPath, JSON.stringify({ version: 2, observation: {} }))

    const fact = await readProviderAvailability("openai", {
      store,
      now: 5_000,
      env: { OPENAI_API_KEY: "configured" },
    })

    expect(fact).toMatchObject({ status: "unknown", source: "observation-store" })
    expect(fact.reason).toContain(`observation store unreadable: ${providerPath}:`)
    expect(fact.reason).toContain("unsupported provider observation version 2")
    expect(warn).toHaveBeenCalledOnce()
  })

  it("rejects invalid injected observations before writing them", async () => {
    const store = memoryStore()
    await expect(
      recordProviderObservation(store, {
        provider: "openai",
        status: "available",
        source: "dispatch",
        reason: "successful completion",
        observedAt: Number.NaN,
      }),
    ).rejects.toThrow("provider observation observedAt must be finite")
    expect(store.write).not.toHaveBeenCalled()
  })

  it("retains stale evidence but resolves it to unknown with its prior status and age", async () => {
    const store = createProviderObservationStore({ cacheRoot })
    const observation = await recordProviderObservation(store, {
      provider: "openrouter",
      status: "refusing",
      kind: "transport",
      source: "dispatch",
      reason: "connection refused",
      observedAt: 10_000,
    })

    const fact = await readProviderAvailability("openrouter", {
      store,
      now: observation.expiresAt + 1,
      env: { OPENROUTER_API_KEY: "configured" },
    })

    expect(fact.status).toBe("unknown")
    expect(fact.observedAt).toBe(10_000)
    expect(fact.reason).toMatch(/last refusing observation.*age/i)
  })

  it("lets current credential removal override a fresh available observation without caching the missing credential", async () => {
    const store = createProviderObservationStore({ cacheRoot })
    await recordProviderObservation(store, {
      provider: "anthropic",
      status: "available",
      source: "dispatch",
      reason: "successful completion",
      observedAt: 20_000,
    })

    const fact = await readProviderAvailability("anthropic", {
      store,
      now: 20_001,
      env: {},
    })

    expect(fact).toMatchObject({
      status: "refusing",
      kind: "credential-missing",
      source: "config",
    })
    expect(fact).not.toHaveProperty("expiresAt")
    expect(existsSync(join(cacheRoot, "providers", "anthropic.json"))).toBe(true)
  })
})

describe("Ollama free availability feed", () => {
  it("records an available observation when /api/tags succeeds", async () => {
    const store = memoryStore()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, statusText: "OK" })),
    )

    await expect(isOllamaAvailable({ observationStore: store })).resolves.toBe(true)
    expect(store.write).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ollama", status: "available", source: "ollama:/api/tags" }),
    )
  })

  it("records transport refusal for a definite connection failure but nothing for timeout ambiguity", async () => {
    const store = memoryStore()
    const fetchMock = vi.fn()
    fetchMock.mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"))
    fetchMock.mockRejectedValueOnce(new Error("request timed out after 2000ms"))
    vi.stubGlobal("fetch", fetchMock)

    await expect(isOllamaAvailable({ observationStore: store })).resolves.toBe(false)
    expect(store.write).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ollama", status: "refusing", kind: "transport" }),
    )
    const writesAfterTransport = vi.mocked(store.write).mock.calls.length

    await expect(isOllamaAvailable({ observationStore: store })).resolves.toBe(false)
    expect(store.write).toHaveBeenCalledTimes(writesAfterTransport)
  })
})
