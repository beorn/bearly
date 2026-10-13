import { describe, expect, it } from "vitest"
import { describeDispatchFailure, type DispatchFailureTarget } from "../src/lib/dispatch-error"

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
