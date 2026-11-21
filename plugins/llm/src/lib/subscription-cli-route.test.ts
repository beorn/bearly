/**
 * @failure the default ask maps an OpenAI SKU to a codex model a ChatGPT login refuses, treats an unauthenticated
 *   CODEX_HOME as a subscription login, or silently spends the metered key in place of the absent binding (37260).
 * @level l1
 * @consumer plugins/llm subscription route; the default `llm` ask
 * @testonly none
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  cliOnPath,
  codexLoginFromStatus,
  codexNoLoginRefusal,
  codexProfile,
  codexSubscriptionRow,
  resetSubscriptionCliProbe,
} from "./subscription-cli"
import { getModel } from "./types"

const savedSubscription = process.env.LLM_SUBSCRIPTION_CLI
const savedHome = process.env.CODEX_HOME

beforeEach(() => {
  delete process.env.LLM_SUBSCRIPTION_CLI
  resetSubscriptionCliProbe()
})

afterEach(() => {
  if (savedSubscription === undefined) delete process.env.LLM_SUBSCRIPTION_CLI
  else process.env.LLM_SUBSCRIPTION_CLI = savedSubscription
  if (savedHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedHome
  resetSubscriptionCliProbe()
})

describe("codex subscription rows", () => {
  it("maps every OpenAI SKU to the model a ChatGPT login serves, keeping the requested effort", () => {
    expect(codexSubscriptionRow("gpt-5.4")).toEqual({ model: "gpt-6.2-sol", effort: "medium" })
    expect(codexSubscriptionRow("gpt-5.4-pro")).toEqual({ model: "gpt-6.2-sol", effort: "high" })
    expect(codexSubscriptionRow("gpt-5-nano")).toEqual({ model: "gpt-6.2-sol", effort: "low" })
    expect(codexSubscriptionRow("o3-pro")).toEqual({ model: "gpt-6.2-sol", effort: "high" })
    expect(codexSubscriptionRow("not-a-sku")).toBeUndefined()
  })
})

describe("codex login status", () => {
  it("reads a refused status as no login and keeps the CLI's own line", () => {
    expect(codexLoginFromStatus({ status: 1, stdout: "Not logged in\n", stderr: "" })).toEqual({
      login: "none",
      detail: "Not logged in",
    })
  })

  it("separates a ChatGPT login from an API-key login and from an unreadable one", () => {
    expect(codexLoginFromStatus({ status: 0, stdout: "Logged in using ChatGPT", stderr: "" }).login).toBe("chatgpt")
    expect(codexLoginFromStatus({ status: 0, stdout: "Logged in using an API key", stderr: "" }).login).toBe("api-key")
    expect(codexLoginFromStatus({ status: 0, stdout: "something new", stderr: "" }).login).toBe("unknown")
  })
})

describe("codex profile", () => {
  it("is not a subscription when the CLI reports no login, whatever the config says", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-nologin-"))
    process.env.CODEX_HOME = home
    const profile = codexProfile(() => ({ status: 1, stdout: "Not logged in\n", stderr: "" }))
    expect(profile).toMatchObject({ login: "none", subscription: false })
  })

  it("is a subscription only for a default-provider ChatGPT login", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-login-"))
    process.env.CODEX_HOME = home
    const profile = codexProfile(() => ({ status: 0, stdout: "Logged in using ChatGPT", stderr: "" }))
    expect(profile).toMatchObject({ login: "chatgpt", subscription: true })
  })

  it("keeps a gateway profile out of the subscription route and names it", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-gateway-"))
    writeFileSync(join(home, "config.toml"), 'model_provider = "lunaroute"\n')
    process.env.CODEX_HOME = home
    const profile = codexProfile(() => ({ status: 0, stdout: "Logged in using ChatGPT", stderr: "" }))
    expect(profile).toMatchObject({ modelProvider: "lunaroute", subscription: false })
  })
})

describe("the silent-key refusal", () => {
  const skip = !cliOnPath("codex")

  it.skipIf(skip)("refuses a metered OpenAI ask when the codex profile has no ChatGPT login", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-refuse-"))
    process.env.CODEX_HOME = home
    const refusal = codexNoLoginRefusal(getModel("gpt-5.4")!)
    expect(refusal).toMatch(/has no ChatGPT login/u)
    expect(refusal).toMatch(/CODEX_HOME/u)
  })

  it.skipIf(skip)("leaves a gateway profile and a SKU codex cannot serve on their own routes", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-gateway-refuse-"))
    writeFileSync(join(home, "config.toml"), 'model_provider = "lunaroute"\n')
    process.env.CODEX_HOME = home
    resetSubscriptionCliProbe()
    expect(codexNoLoginRefusal(getModel("gpt-5.4")!)).toBeUndefined()
    resetSubscriptionCliProbe()
    process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "codex-unserved-"))
    expect(codexNoLoginRefusal({ ...getModel("gpt-5.4")!, modelId: "not-a-sku" })).toBeUndefined()
  })
})
