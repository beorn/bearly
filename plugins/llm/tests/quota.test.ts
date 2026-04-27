/**
 * Quota tracking — header parsing, cache I/O, JSON envelope.
 *
 * Bead km-bearly.llm-quota-tracking. Surface remaining-credit + rate-limit
 * per provider so spending decisions are visible (user is at $700/mo with
 * no in-tool signal). Three concerns covered here:
 *
 *   1. Header parsing — OpenAI-style and Anthropic-style prefixes shipped
 *      by all providers we currently support.
 *   2. Cache read/write — atomic write (temp + rename), graceful fallback
 *      on missing/corrupted cache file.
 *   3. JSON envelope shape — buildQuotaEnvelope (table/JSON form) and
 *      buildPerCallQuota (per-call --quota field).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseOpenAIStyleRateLimitHeaders,
  parseAnthropicRateLimitHeaders,
  parseResetHeader,
  captureRateLimitFromHeaders,
  loadQuotaCache,
  saveQuotaCache,
  updateQuotaCache,
  buildPerCallQuota,
  buildQuotaEnvelope,
  renderQuotaTable,
  _setCachePathForTesting,
  type QuotaSnapshot,
} from "../src/lib/quota"

let cacheDir: string

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "bearly-quota-"))
  _setCachePathForTesting(join(cacheDir, "last-quota.json"))
})

afterEach(() => {
  _setCachePathForTesting(undefined)
  try {
    rmSync(cacheDir, { recursive: true, force: true })
  } catch {
    /* swallow */
  }
})

describe("parseOpenAIStyleRateLimitHeaders", () => {
  it("extracts requests + tokens limits with reset timestamps", () => {
    const headers = {
      "x-ratelimit-remaining-requests": "487",
      "x-ratelimit-limit-requests": "500",
      "x-ratelimit-remaining-tokens": "145000",
      "x-ratelimit-limit-tokens": "200000",
      "x-ratelimit-reset-requests": "60",
      "x-ratelimit-reset-tokens": "30",
    }
    const result = parseOpenAIStyleRateLimitHeaders("openai", headers)
    expect(result.provider).toBe("openai")
    expect(result.remainingRequests).toBe(487)
    expect(result.requestsPerWindow).toBe(500)
    expect(result.remainingTokens).toBe(145000)
    expect(result.tokensPerWindow).toBe(200000)
    // Reset values normalized to ISO-8601 (now + N seconds).
    expect(result.resetRequestsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.resetTokensAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("handles case-insensitive header keys (Headers object form)", () => {
    const h = new Headers()
    h.set("X-RateLimit-Remaining-Tokens", "9999")
    const result = parseOpenAIStyleRateLimitHeaders("openrouter", h)
    expect(result.remainingTokens).toBe(9999)
  })

  it("returns just the provider field when no rate-limit headers present", () => {
    const result = parseOpenAIStyleRateLimitHeaders("openai", { "content-type": "application/json" })
    expect(result.provider).toBe("openai")
    expect(result.remainingRequests).toBeUndefined()
    expect(result.remainingTokens).toBeUndefined()
  })

  it("ignores garbage values without crashing", () => {
    const result = parseOpenAIStyleRateLimitHeaders("openai", {
      "x-ratelimit-remaining-tokens": "not-a-number",
    })
    expect(result.remainingTokens).toBeUndefined()
  })
})

describe("parseAnthropicRateLimitHeaders", () => {
  it("uses the anthropic-* prefix, not x-ratelimit-*", () => {
    const headers = {
      "anthropic-ratelimit-requests-remaining": "100",
      "anthropic-ratelimit-requests-limit": "1000",
      "anthropic-ratelimit-tokens-remaining": "100000",
      "anthropic-ratelimit-tokens-limit": "100000",
      "anthropic-ratelimit-requests-reset": "2026-04-27T08:00:00Z",
      "anthropic-ratelimit-tokens-reset": "2026-04-27T07:45:00Z",
    }
    const result = parseAnthropicRateLimitHeaders(headers)
    expect(result.provider).toBe("anthropic")
    expect(result.remainingRequests).toBe(100)
    expect(result.requestsPerWindow).toBe(1000)
    expect(result.remainingTokens).toBe(100000)
    expect(result.resetRequestsAt).toBe("2026-04-27T08:00:00Z")
    expect(result.resetTokensAt).toBe("2026-04-27T07:45:00Z")
  })
})

describe("parseResetHeader", () => {
  it("passes through ISO-8601 verbatim", () => {
    expect(parseResetHeader("2026-04-27T08:00:00Z")).toBe("2026-04-27T08:00:00Z")
  })

  it("converts seconds to ISO-8601 (now + N)", () => {
    const before = Date.now()
    const out = parseResetHeader("60")
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const reset = new Date(out!).getTime()
    expect(reset).toBeGreaterThanOrEqual(before + 59_000)
    expect(reset).toBeLessThanOrEqual(before + 61_000)
  })

  it("parses duration strings like 6m0s", () => {
    const out = parseResetHeader("6m0s")
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("parses millisecond suffix '2ms' (NOT as 2 minutes)", () => {
    // OpenAI's reset_requests header sometimes ships sub-second values like "2ms".
    // The greedy minute-suffix regex would match `2m` and treat the trailing `s`
    // as zero seconds — landing 2 minutes in the future, not 2ms. Real-world
    // smoke test on gpt-5-nano on 2026-04-27 surfaced this; fix protects the
    // resetRequestsAt timestamp from being off by orders of magnitude.
    const before = Date.now()
    const out = parseResetHeader("2ms")
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const reset = new Date(out!).getTime()
    expect(reset - before).toBeLessThan(1000)
  })

  it("returns undefined for empty input", () => {
    expect(parseResetHeader(undefined)).toBeUndefined()
    expect(parseResetHeader("")).toBeUndefined()
  })

  it("falls back to verbatim for unknown shapes", () => {
    expect(parseResetHeader("garbage-value")).toBe("garbage-value")
  })
})

describe("captureRateLimitFromHeaders", () => {
  it("returns undefined when no rate-limit data is present", () => {
    expect(captureRateLimitFromHeaders("openai", { "content-type": "json" })).toBeUndefined()
    expect(captureRateLimitFromHeaders("anthropic", undefined)).toBeUndefined()
  })

  it("captures + caches when at least one rate-limit field is present", () => {
    const snapshot = captureRateLimitFromHeaders("openai", {
      "x-ratelimit-remaining-tokens": "12345",
      "x-ratelimit-limit-tokens": "200000",
    })
    expect(snapshot).toBeDefined()
    expect(snapshot!.provider).toBe("openai")
    expect(snapshot!.remainingTokens).toBe(12345)
    expect(snapshot!.source).toBe("headers-cache")
    expect(snapshot!.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // Cache should now have the snapshot.
    const cache = loadQuotaCache()
    expect(cache.openai).toBeDefined()
    expect(cache.openai!.remainingTokens).toBe(12345)
  })

  it("uses Anthropic header prefix for anthropic provider", () => {
    const snapshot = captureRateLimitFromHeaders("anthropic", {
      "anthropic-ratelimit-tokens-remaining": "500",
      "anthropic-ratelimit-tokens-limit": "1000",
    })
    expect(snapshot!.remainingTokens).toBe(500)
    // Make sure the cache was written.
    const cache = loadQuotaCache()
    expect(cache.anthropic!.remainingTokens).toBe(500)
  })
})

describe("cache I/O (atomic write)", () => {
  it("returns empty map on missing cache file", () => {
    expect(loadQuotaCache()).toEqual({})
  })

  it("returns empty map on corrupt JSON", () => {
    const path = join(cacheDir, "last-quota.json")
    writeFileSync(path, "{ this is not valid JSON")
    expect(loadQuotaCache()).toEqual({})
  })

  it("round-trips snapshots via saveQuotaCache + loadQuotaCache", () => {
    const snap: QuotaSnapshot = {
      provider: "openrouter",
      remainingCreditUsd: 48.5,
      source: "api",
      fetchedAt: "2026-04-27T07:00:00Z",
    }
    saveQuotaCache({ openrouter: snap })
    const loaded = loadQuotaCache()
    expect(loaded.openrouter).toEqual(snap)
  })

  it("updateQuotaCache merges without clobbering other providers", () => {
    saveQuotaCache({
      openai: { provider: "openai", source: "api", fetchedAt: "2026-04-27T01:00:00Z" },
    })
    updateQuotaCache({
      provider: "openrouter",
      remainingCreditUsd: 10,
      source: "api",
      fetchedAt: "2026-04-27T02:00:00Z",
    })
    const loaded = loadQuotaCache()
    expect(loaded.openai).toBeDefined()
    expect(loaded.openrouter!.remainingCreditUsd).toBe(10)
  })

  it("doesn't leak temp files on success", () => {
    saveQuotaCache({ openai: { provider: "openai", source: "api", fetchedAt: "x" } })
    // Cache dir should contain exactly the canonical file (atomic rename).
    const entries = readFileSync(join(cacheDir, "last-quota.json"), "utf-8")
    expect(entries).toContain("openai")
    // No `.last-quota-*.tmp` files left behind.
    const tmpFiles = require("node:fs")
      .readdirSync(cacheDir)
      .filter((f: string) => f.includes(".tmp"))
    expect(tmpFiles).toEqual([])
  })
})

describe("buildPerCallQuota", () => {
  it("returns undefined for an empty snapshot", () => {
    expect(buildPerCallQuota(undefined)).toBeUndefined()
    expect(
      buildPerCallQuota({
        provider: "openai",
        source: "headers-cache",
        fetchedAt: "x",
      }),
    ).toBeUndefined()
  })

  it("strips the source/fetchedAt envelope and keeps just rate-limit fields", () => {
    const out = buildPerCallQuota({
      provider: "openai",
      remainingTokens: 1000,
      tokensPerWindow: 5000,
      resetTokensAt: "2026-04-27T08:00:00Z",
      source: "headers-cache",
      fetchedAt: "2026-04-27T07:43:00Z",
    })
    expect(out).toEqual({
      remainingTokens: 1000,
      tokensPerWindow: 5000,
      resetTokensAt: "2026-04-27T08:00:00Z",
    })
  })
})

describe("buildQuotaEnvelope", () => {
  it("serializes snapshots with status:ok", () => {
    const env = buildQuotaEnvelope([
      {
        provider: "openrouter",
        remainingCreditUsd: 48.5,
        source: "api",
        fetchedAt: "2026-04-27T07:00:00Z",
      },
    ])
    expect(env.status).toBe("ok")
    expect(env.snapshots).toBeInstanceOf(Array)
    expect((env.snapshots as QuotaSnapshot[])[0]!.provider).toBe("openrouter")
  })
})

describe("renderQuotaTable", () => {
  it("renders an empty table when no providers configured", () => {
    expect(renderQuotaTable([])).toContain("No providers configured")
  })

  it("renders a multi-row table with balance and rate columns", () => {
    const rows = renderQuotaTable([
      {
        provider: "openrouter",
        remainingCreditUsd: 48,
        source: "api",
        fetchedAt: "2026-04-27T07:00:00Z",
      },
      {
        provider: "anthropic",
        remainingTokens: 100000,
        tokensPerWindow: 100000,
        source: "headers-cache",
        fetchedAt: "2026-04-27T02:30:00Z",
      },
    ])
    expect(rows).toContain("OpenRouter")
    expect(rows).toContain("Anthropic")
    expect(rows).toContain("Provider")
    expect(rows).toContain("Balance / Used")
  })
})

describe("graceful fallback for providers with no quota API", () => {
  it("getNoApiQuota returns null when env var is unset", async () => {
    const original = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
    const { getNoApiQuota } = await import("../src/lib/quota")
    expect(await getNoApiQuota("google")).toBeNull()
    if (original !== undefined) process.env.GOOGLE_GENERATIVE_AI_API_KEY = original
  })

  it("getNoApiQuota returns a 'no quota API' row when env var IS set", async () => {
    process.env.XAI_API_KEY = "test-xai-key"
    const { getNoApiQuota } = await import("../src/lib/quota")
    const snap = await getNoApiQuota("xai")
    expect(snap).toBeDefined()
    expect(snap!.provider).toBe("xai")
    expect(snap!.error).toBe("no quota API")
    delete process.env.XAI_API_KEY
  })
})
