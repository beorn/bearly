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
  vi.unstubAllEnvs()
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
  it("honors LLM_NO_CACHE for provider observation reads and writes", async () => {
    vi.stubEnv("LLM_NO_CACHE", "1")
    const store = createProviderObservationStore({ cacheRoot })

    await recordProviderObservation(store, {
      provider: "openai",
      status: "available",
      source: "dispatch",
      reason: "successful completion",
      observedAt: 1_000,
    })
    const fact = await readProviderAvailability("openai", {
      store,
      now: 1_001,
      env: { OPENAI_API_KEY: "configured" },
    })

    expect(existsSync(join(cacheRoot, "providers", "openai.json"))).toBe(false)
    expect(fact).toMatchObject({ status: "unknown", source: "observation-store" })
    expect(fact.reason).toContain("LLM_NO_CACHE=1")
  })

  it("rejects unknown and path-traversing provider identifiers before resolving a store path", async () => {
    const store = createProviderObservationStore({ cacheRoot })
    const invalidProvider = "../escaped" as unknown as RecordedProviderObservation["provider"]

    expect(() => store.pathFor(invalidProvider)).toThrow('invalid provider identifier "../escaped"')
    await expect(
      recordProviderObservation(store, {
        provider: invalidProvider,
        status: "available",
        source: "dispatch",
        reason: "successful completion",
      }),
    ).rejects.toThrow("provider observation input rejected invalid observation")
    await expect(
      readProviderAvailability(invalidProvider, {
        store,
        now: 1_000,
        env: {},
      }),
    ).rejects.toThrow('invalid provider identifier "../escaped"')
    expect(existsSync(join(cacheRoot, "escaped.json"))).toBe(false)
  })

  it("keeps the newest observed fact when two store instances write concurrently", async () => {
    const firstWriter = createProviderObservationStore({ cacheRoot })
    const secondWriter = createProviderObservationStore({ cacheRoot })

    await Promise.all([
      recordProviderObservation(firstWriter, {
        provider: "openai",
        status: "available",
        source: "dispatch",
        reason: "successful completion",
        observedAt: 2_000,
      }),
      recordProviderObservation(secondWriter, {
        provider: "openai",
        status: "refusing",
        kind: "auth",
        source: "dispatch",
        reason: "401 invalid_api_key",
        observedAt: 1_000,
      }),
    ])

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

    const firstFact = await readProviderAvailability("openai", {
      store,
      now: 5_000,
      env: { OPENAI_API_KEY: "configured" },
    })
    const secondFact = await readProviderAvailability("openai", {
      store,
      now: 5_000,
      env: { OPENAI_API_KEY: "configured" },
    })

    expect(firstFact.status).toBe("unknown")
    expect(firstFact.reason).toContain(`observation store unreadable: ${providerPath}:`)
    expect(secondFact.status).toBe("unknown")
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
    await expect(
      recordProviderObservation(store, {
        provider: "openai",
        status: "bogus",
        source: "dispatch",
        reason: "unexpected state",
      } as never),
    ).rejects.toThrow("provider observation input rejected invalid observation")
    expect(store.write).not.toHaveBeenCalled()
  })

  it("rejects non-finite read times instead of silently misclassifying freshness", async () => {
    const store = memoryStore()
    await expect(
      readProviderAvailability("openai", {
        store,
        now: Number.NaN,
        env: { OPENAI_API_KEY: "configured" },
      }),
    ).rejects.toThrow("provider availability now must be finite")
    await expect(
      readProviderAvailability("openai", {
        store,
        now: Number.POSITIVE_INFINITY,
        env: { OPENAI_API_KEY: "configured" },
      }),
    ).rejects.toThrow("provider availability now must be finite")
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

  it("never persists credentials embedded in OLLAMA_HOST", async () => {
    const store = memoryStore()
    vi.stubEnv("OLLAMA_HOST", "http://user:secret@ollama.test")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, statusText: "Service Unavailable" })),
    )

    await expect(isOllamaAvailable({ observationStore: store })).resolves.toBe(false)

    const observation = vi.mocked(store.write).mock.calls[0]?.[0]
    expect(observation?.reason).toBe("Ollama /api/tags returned HTTP 503")
    expect(JSON.stringify(observation)).not.toMatch(/user|secret|ollama\.test/)
  })
})
