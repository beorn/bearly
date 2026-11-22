/**
 * @failure A METERED route classification is treated as permission, so `llm pro` hands a signed-out codex
 *   profile's OpenAI leg to the raw Responses client and spends a key the fleet already refused to spend —
 *   the missing-login refusal exists but the paid client is called anyway.
 * @level l2 — fixture-only: fake `codex` on PATH, temp CODEX_HOME, stubbed paid clients, no network
 * @consumer bearly llm pro (dual dispatch) and llm pro --model / askAndFinish dispatch
 * @reach fs-walk <fixture-only: temporary bin and CODEX_HOME directories; nothing scans a source tree>
 * @testonly none
 *
 * 37884 follow-up (CTO c25b132f / 8f2f3903): `resolveQueryRoute(...).kind === "metered"` CLASSIFIES a route;
 * it does not grant permission. `queryModel` then applies two permission checks — `allowMetered === false`
 * and `codexNoLoginRefusal` — but the raw `queryOpenAIBackground` call sites in pro.ts and ask.ts bypassed
 * them. `meteredRouteRefusal` is that one decision, and both call sites must ask it before dispatch.
 *
 * Fixtures are profiles, not hosts: an inert key is always present, so "no paid dispatch" is proven by call
 * counts, not by absence of a key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeTestEnv, runCli, type TestEnv } from "./helpers"

const generateTextMock = vi.fn()
const streamTextMock = vi.fn()

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: generateTextMock,
  streamText: streamTextMock,
}))

const queryBackgroundMock = vi.fn()
vi.mock("../src/lib/openai-deep", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/openai-deep")>("../src/lib/openai-deep")
  return {
    ...actual,
    queryOpenAIBackground: queryBackgroundMock,
  }
})

const SUBSCRIPTION_ANSWER = "CODEX-SUBSCRIPTION-OK"
const METERED_ANSWER = "METERED-BACKGROUND-OK"
/** A model whose Responses background route is capable AND whose SKU codex can serve. */
const PRO_MODEL = "gpt-5.5-pro"
/** Dual-pro's first mainstay — same shape, so the dual path exercises `dispatchOne`. */
const DUAL_FIRST_MAINSTAY = "gpt-5.4-pro"

// The fake answers `codex login status` from CODEX_LOGIN_FIXTURE, then a normal one-shot with an `-o` file.
const FAKE_CODEX = [
  "#!/bin/sh",
  'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
  '  if [ "$CODEX_LOGIN_FIXTURE" = "chatgpt" ]; then echo "Logged in using ChatGPT"; exit 0; fi',
  '  echo "Not logged in"; exit 1',
  "fi",
  'out=""',
  'while [ $# -gt 0 ]; do case "$1" in -o) shift; out="$1";; esac; shift; done',
  `echo '{"type":"thread.started"}'`,
  `echo '{"type":"item.completed","item":{"type":"agent_message","text":"${SUBSCRIPTION_ANSWER}"}}'`,
  `echo '{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":3}}'`,
  `if [ -n "$out" ]; then printf "${SUBSCRIPTION_ANSWER}" > "$out"; fi`,
  "exit 0",
].join("\n")

type Profile = "chatgpt" | "signed-out" | "gateway"

let env: TestEnv | undefined
let createdDirs: string[] = []
let savedPath: string | undefined
let savedCodexHome: string | undefined
let savedLoginFixture: string | undefined
let savedDualProB: string | undefined

function fixture(profile: Profile): TestEnv {
  env = makeTestEnv()
  const binDir = mkdtempSync(join(tmpdir(), "llm-metered-bin-"))
  const codexHome = mkdtempSync(join(tmpdir(), "llm-metered-codex-"))
  createdDirs.push(binDir, codexHome)
  mkdirSync(binDir, { recursive: true })
  const codex = join(binDir, "codex")
  writeFileSync(codex, FAKE_CODEX)
  chmodSync(codex, 0o755)
  // No top-level model_provider = the codex default (ChatGPT) provider; a named gateway is NOT the subscription.
  writeFileSync(join(codexHome, "config.toml"), profile === "gateway" ? 'model_provider = "lunaroute"\n' : "")
  // PATH is the fixture dir ONLY, so this host's real `codex` can never decide the route for a test.
  process.env.PATH = binDir
  process.env.CODEX_HOME = codexHome
  if (profile === "chatgpt") process.env.CODEX_LOGIN_FIXTURE = "chatgpt"
  else delete process.env.CODEX_LOGIN_FIXTURE
  // An inert key is ALWAYS present: key presence alone must not authorize the background client.
  process.env.OPENAI_API_KEY = "sk-inert-37884"

  queryBackgroundMock.mockReset().mockResolvedValue({
    model: { displayName: "GPT background" },
    content: METERED_ANSWER,
    responseId: "resp_metered_fixture",
    durationMs: 5,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  })
  generateTextMock.mockReset().mockResolvedValue({
    text: "KIMI-FIXTURE-OK",
    finalStep: { reasoningText: undefined },
    usage: { inputTokens: 5, outputTokens: 3 },
  })
  streamTextMock.mockReset()
  return env
}

beforeEach(() => {
  savedPath = process.env.PATH
  savedCodexHome = process.env.CODEX_HOME
  savedLoginFixture = process.env.CODEX_LOGIN_FIXTURE
  savedDualProB = process.env.LLM_DUAL_PRO_B
  delete process.env.LLM_DUAL_PRO_B
  delete process.env.LLM_SUBSCRIPTION_CLI
})

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedCodexHome
  if (savedLoginFixture === undefined) delete process.env.CODEX_LOGIN_FIXTURE
  else process.env.CODEX_LOGIN_FIXTURE = savedLoginFixture
  if (savedDualProB === undefined) delete process.env.LLM_DUAL_PRO_B
  else process.env.LLM_DUAL_PRO_B = savedDualProB
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
  createdDirs = []
  env = undefined
})

/** The `--model` override path: pro's command, ask.ts's dispatch. */
const singleLeg = (outputFile: string, model = PRO_MODEL) => [
  "pro",
  "-y",
  "--model",
  model,
  "--output",
  outputFile,
  "fixture question",
]
/** The dual path: pro.ts's `dispatchOne`. */
const dualLegs = (outputFile: string) => [
  "pro",
  "-y",
  "--no-challenger",
  // Judging is another paid leg and not this fixture's subject; the route decision is.
  "--no-judge",
  "--output",
  outputFile,
  "fixture question",
]

describe("metered route permission (37884)", () => {
  it("single leg: refuses a signed-out codex profile before the paid client, with an inert key present", async () => {
    const env = fixture("signed-out")
    const result = await runCli(singleLeg(join(env.tmpDir, "signed-out.md")))
    expect(result.exited).toBe(1)
    expect(queryBackgroundMock).not.toHaveBeenCalled()
    expect(streamTextMock).not.toHaveBeenCalled()
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(env.stderr.join("\n")).toMatch(/has no ChatGPT login/)
    expect(env.stderr.join("\n")).toMatch(/metered OpenAI key is not spent/)
  })

  it("single leg: a ChatGPT subscription answers with no background dispatch", async () => {
    const env = fixture("chatgpt")
    const outputFile = join(env.tmpDir, "subscribed.md")
    const result = await runCli(singleLeg(outputFile))
    expect(result.exited).toBeUndefined()
    expect(queryBackgroundMock).not.toHaveBeenCalled()
    expect(streamTextMock).not.toHaveBeenCalled()
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(readFileSync(outputFile, "utf8")).toContain(SUBSCRIPTION_ANSWER)
  })

  it("single leg: a gateway profile leaves the leg metered and dispatches it once", async () => {
    const env = fixture("gateway")
    const outputFile = join(env.tmpDir, "metered.md")
    const result = await runCli(singleLeg(outputFile))
    expect(result.exited).toBeUndefined()
    expect(queryBackgroundMock).toHaveBeenCalledTimes(1)
    expect(readFileSync(outputFile, "utf8")).toContain(METERED_ANSWER)
  })

  it("dual: refuses every signed-out OpenAI leg before the paid client", async () => {
    const env = fixture("signed-out")
    // Both mainstays OpenAI so the fixture has no legitimate paid leg to explain a non-zero count.
    process.env.LLM_DUAL_PRO_B = "gpt-5.5"
    const result = await runCli(dualLegs(join(env.tmpDir, "dual-signed-out.md")))
    expect(result.exited).toBe(1)
    expect(queryBackgroundMock).not.toHaveBeenCalled()
    const stderr = env.stderr.join("\n")
    expect(stderr).toMatch(/has no ChatGPT login/)
    expect(stderr).toContain(DUAL_FIRST_MAINSTAY)
  })

  it("dual: a ChatGPT subscription answers the OpenAI leg with no background dispatch", async () => {
    const env = fixture("chatgpt")
    const outputFile = join(env.tmpDir, "dual-subscribed.md")
    const result = await runCli(dualLegs(outputFile))
    expect(result.exited).toBeUndefined()
    expect(queryBackgroundMock).not.toHaveBeenCalled()
    expect(readFileSync(outputFile, "utf8")).toContain(SUBSCRIPTION_ANSWER)
  })

  it("dual: a gateway profile dispatches the metered OpenAI leg exactly once", async () => {
    const env = fixture("gateway")
    const outputFile = join(env.tmpDir, "dual-metered.md")
    await runCli(dualLegs(outputFile))
    expect(queryBackgroundMock).toHaveBeenCalledTimes(1)
    expect(readFileSync(outputFile, "utf8")).toContain(METERED_ANSWER)
  })

  it("keeps allowMetered:false as its own refusal, ahead of the login check", async () => {
    fixture("gateway")
    vi.resetModules()
    const { meteredRouteRefusal } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")
    const model = getModel(PRO_MODEL)!
    expect(meteredRouteRefusal(model, { allowMetered: false })).toBe(`no unpaid route for ${PRO_MODEL}`)
    expect(meteredRouteRefusal(model)).toBeUndefined()
  })
})
