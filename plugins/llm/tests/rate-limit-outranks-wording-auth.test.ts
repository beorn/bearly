import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createProviderObservationStore, readProviderAvailability, recordProviderObservation } from "../src/index"
import {
  describeDispatchFailure,
  type DispatchFailureTarget,
  UPSTREAM_SHARED_POOL_RETRY_MS,
} from "../src/lib/dispatch-error"

const openrouter: DispatchFailureTarget = {
  provider: "openrouter",
  modelId: "deepseek/deepseek-chat",
  displayName: "DeepSeek Chat V3",
}
const openai: DispatchFailureTarget = { provider: "openai", modelId: "gpt-5.4-pro", displayName: "GPT-5.4 Pro" }

// The bodies two live models came back with in @dev/6's /pro run at 10:22 PDT 2026-10-13
// (`/hh/var/@dev6/29010/pro-deepseek.stderr`, `pro-kimi.stderr`), byte-for-byte except that the
// irrelevant caller identity is a fixture value. Each names the upstream provider's own rate limit
// and carries no credentials wording — with the status stripped these are the wording-only rows.
const sharedPool429Body = (model: string, provider: string): string =>
  `{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"${model} is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations","provider_name":"${provider}","is_byok":false,"limit_source":"upstream_provider_shared_pool","remedy_hint":"Retry shortly, add your own provider key (https://openrouter.ai/settings/integrations), or route to another provider with provider routing: https://openrouter.ai/docs/features/provider-routing"}},"user_id":"user_FIXTURE"}`

describe("an explicit 429 outranks a wording-based auth match (29057)", () => {
  it.each([
    ["deepseek/deepseek-chat", "StreamLake"],
    ["moonshotai/kimi-k2.7-code", "Inceptron"],
  ])("keeps the real %s shared-pool 429 rate-limited", (model, provider) => {
    const error = Object.assign(new Error(`HTTP 429; body: ${sharedPool429Body(model, provider)}`), { status: 429 })
    const described = describeDispatchFailure(error, openrouter)
    expect(described.kind).toBe("rate-limited")
    expect(described.message).toContain("rate-limited (429)")
    expect(described.message).not.toContain("auth failed")
  })

  it("keeps an explicit 429 rate-limited when its text ALSO reads as credentials", () => {
    // Synthetic precedence coverage, NOT a reconstruction of the specimen's own cause: the two
    // measured bodies above carry no credentials wording, so the field that made the specimen read
    // as auth could not be recovered from its log line. What is asserted here is the precedence
    // rule the specimen needs — a status the provider set to 429 is a fact about its rate limit,
    // while the auth wording is a guess about a key this call never questioned.
    const error = Object.assign(new Error("unauthorized: invalid api key"), { status: 429 })
    const described = describeDispatchFailure(error, openrouter)
    expect(described.kind).toBe("rate-limited")
    expect(described.message).not.toContain("OPENROUTER_API_KEY")
  })

  it("still reports a genuine 401 unauthorized as auth", () => {
    const described = describeDispatchFailure(Object.assign(new Error("unauthorized"), { status: 401 }), openrouter)
    expect(described.kind).toBe("auth")
    expect(described.message).toContain("check OPENROUTER_API_KEY")
  })

  it.each([401, 403])("keeps an explicit %i auth even when its body mentions a rate limit", (status) => {
    const described = describeDispatchFailure(
      Object.assign(new Error("invalid API key; see rate-limit documentation"), { status }),
      openrouter,
    )
    expect(described.kind).toBe("auth")
    expect(described.message).toContain("check OPENROUTER_API_KEY")
  })

  it.each([400, 403])("keeps Google's API_KEY_INVALID body as auth at status %i", (status) => {
    const described = describeDispatchFailure(
      Object.assign(new Error("API key not valid. Please pass a valid API key. reason: API_KEY_INVALID"), { status }),
      openrouter,
    )
    expect(described.kind).toBe("auth")
  })

  it("keeps a statusless body that names both a rate limit and credentials as auth (old ordering)", () => {
    const described = describeDispatchFailure(
      new Error("rate limit reached and unauthorized: invalid api key"),
      openrouter,
    )
    expect(described.kind).toBe("auth")
  })

  it("still reports a statusless rate-limit body as rate-limited", () => {
    const described = describeDispatchFailure(new Error("too many requests; retry shortly"), openrouter)
    expect(described.kind).toBe("rate-limited")
  })

  it("still reports OpenAI's insufficient_quota as quota, not rate-limited", () => {
    const described = describeDispatchFailure(
      Object.assign(new Error("insufficient_quota: billing hard limit reached"), { status: 429 }),
      openai,
    )
    expect(described.kind).toBe("quota")
  })
})

describe("a 429's refusal record keeps the head of the upstream body (29495, @cto e60d240d)", () => {
  const refusalReason = (error: Error): string => {
    const { observation } = describeDispatchFailure(error, openrouter)
    if (observation?.status !== "refusing") throw new Error(`expected a refusal record, got ${String(observation)}`)
    return observation.reason
  }

  it("names whose limit refused, beside bearly's own text", () => {
    const body = sharedPool429Body("deepseek/deepseek-chat", "StreamLake")
    const reason = refusalReason(
      Object.assign(new Error("Provider returned error"), { status: 429, responseBody: body }),
    )
    expect(reason).toMatch(/^openrouter rate-limited \(429\)/u)
    expect(reason).toContain('upstream body: {"error":{"message":"Provider returned error","code":429')
    expect(reason).toContain('"provider_name":"StreamLake"')
    expect(reason).toContain('"limit_source":"upstream_provider_shared_pool"')
  })

  it("keeps at most 512 characters of the body, redacted before it is cut", () => {
    const body = `{"api_key":"sk-live-secret","error":{"message":"${"x".repeat(2_000)}"}}`
    const reason = refusalReason(Object.assign(new Error("rate limited"), { status: 429, responseBody: body }))
    const head = reason.slice(reason.indexOf("upstream body: ") + "upstream body: ".length)
    expect(head).toHaveLength(512)
    expect(reason).toContain('"api_key":"[REDACTED]"')
    expect(reason).not.toContain("sk-live-secret")
  })

  it("leaves another refusal's record as it was", () => {
    const { observation } = describeDispatchFailure(
      Object.assign(new Error("upstream unavailable"), { status: 503, responseBody: '{"error":"overloaded"}' }),
      openrouter,
    )
    expect(observation?.status).toBe("refusing")
    expect(observation?.reason).not.toContain("upstream body")
  })
})

describe("a 429 from an upstream provider's shared pool is held for seconds, not the provider's 10 minutes (29534)", () => {
  const now = Date.parse("2026-10-15T18:34:10Z")
  const sharedPool = (extra: object = {}) =>
    Object.assign(new Error("Provider returned error"), {
      status: 429,
      responseBody: sharedPool429Body("deepseek/deepseek-chat", "StreamLake"),
      ...extra,
    })

  it("holds the refusal until now + UPSTREAM_SHARED_POOL_RETRY_MS when no Retry-After is given", () => {
    const described = describeDispatchFailure(sharedPool(), openrouter, now)
    expect(described.kind).toBe("rate-limited")
    expect(described.retryAt).toBe(now + UPSTREAM_SHARED_POOL_RETRY_MS)
    expect(described.observation?.retryAt).toBe(now + UPSTREAM_SHARED_POOL_RETRY_MS)
    expect(described.observation?.reason).toContain('"limit_source":"upstream_provider_shared_pool"')
  })

  it("the shared store's record expires at that retryAt, so every process stops refusing within seconds", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "bearly-shared-pool-"))
    try {
      const store = createProviderObservationStore({ cacheRoot })
      const { observation } = describeDispatchFailure(sharedPool(), openrouter, now)
      if (observation?.status !== "refusing") throw new Error("expected a refusal record")
      const recorded = await recordProviderObservation(store, { ...observation, observedAt: now })
      expect(recorded.expiresAt).toBe(now + UPSTREAM_SHARED_POOL_RETRY_MS)
      const env = { OPENROUTER_API_KEY: "configured" }
      expect((await readProviderAvailability("openrouter", { store, now: now + 29_000, env })).status).toBe("refusing")
      expect((await readProviderAvailability("openrouter", { store, now: now + 31_000, env })).status).not.toBe(
        "refusing",
      )
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it("leaves an account-level 429, one naming no upstream shared pool, to the provider's default hold", () => {
    const account = Object.assign(new Error("Rate limit exceeded"), {
      status: 429,
      responseBody: '{"error":{"message":"Rate limit exceeded: free-models-per-day","code":429}}',
    })
    const described = describeDispatchFailure(account, openrouter, now)
    expect(described.kind).toBe("rate-limited")
    expect(described.retryAt).toBeUndefined()
  })

  it("lets a Retry-After the provider sent win over the shared-pool hold", () => {
    const described = describeDispatchFailure(
      sharedPool({ responseHeaders: { "retry-after": "120" } }),
      openrouter,
      now,
    )
    expect(described.retryAt).toBe(now + 120_000)
  })
})
