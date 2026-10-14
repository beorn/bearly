/**
 * @failure A subscription CLI route falls back silently, or a broken CLI login is not reported, so a second
 *          opinion is answered by an unauthenticated or wrong CLI instead of failing loud.
 * @level l2 — bearly's real route table and PATH probe over faked CLIs
 * @consumer bearly LLM subscription CLI routing (bead 29147)
 * @reach fs-walk <fixture-only: temporary fake CLI directories placed on PATH; nothing here scans a source tree>
 * @testonly none
 *
 * Subscription CLI routes (bead 29147).
 *
 * A seat with a ChatGPT-subscribed `codex` login — or an Antigravity `agy`
 * login — answers an OpenAI / Gemini second opinion with NO billing API key by
 * shelling out to the provider's one-shot CLI. These tests prove the route
 * table, the PATH probe (and its kill switch), the argv each CLI is handed,
 * and that a broken CLI login is a loud error rather than a silent fallback.
 *
 * The CLIs are faked as tiny shell scripts on PATH; nothing here reaches a
 * provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs"
import { safeRemoveSync } from "removely"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Model, Provider } from "../src/lib/types"
import { getModel } from "../src/lib/types"
import {
  subscriptionCliFor,
  subscriptionCliEnabled,
  subscriptionCliAvailable,
  querySubscriptionCli,
  describeSubscriptionRoute,
  agySubscriptionModel,
  cliOnPath,
  codexSubscriptionRow,
  subscriptionRouteNote,
  resetSubscriptionCliProbe,
  resolveSubscriptionRoute,
} from "../src/lib/subscription-cli"
import { isProviderRoutable, providerRouteLabel } from "../src/lib/providers"

const KEY_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "OPENROUTER_API_KEY",
]

let fakeDir: string
let savedPath: string | undefined
let savedNoAutoload: string | undefined
let savedCodexHome: string | undefined

function writeBin(name: string, body: string): void {
  const path = join(fakeDir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

/** Write the codex CODEX_HOME profile the route probe reads (fakeDir is HOME). */
function writeCodexProfile(body: string): void {
  writeFileSync(join(fakeDir, "config.toml"), body)
}

const OK_CODEX = [
  'ALL="$*"',
  'out=""',
  'while [ $# -gt 0 ]; do case "$1" in -o) shift; out="$1";; esac; shift; done',
  'if [ -n "$FAKE_CODEX_ARGV" ]; then printf "%s" "$ALL" > "$FAKE_CODEX_ARGV"; fi',
  'echo \'{"type":"thread.started"}\'',
  'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"CODEX-FAKE-OK"}}\'',
  'echo \'{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":3}}\'',
  'if [ -n "$out" ]; then printf "CODEX-FAKE-OK" > "$out"; fi',
  "exit 0",
].join("\n")

const FAIL_CODEX = [
  'echo \'{"type":"error","message":"token expired"}\'',
  'echo \'{"type":"turn.failed","error":{"message":"token expired"}}\'',
  "exit 1",
].join("\n")

const OK_AGY = [
  'if [ -n "$FAKE_AGY_ARGV" ]; then printf "%s" "$*" > "$FAKE_AGY_ARGV"; fi',
  // The prompt must arrive on STDIN via stream-json, never as a `-p <prompt>`
  // argv string (which dies with E2BIG past MAX_ARG_STRLEN). PATH is the fake
  // dir ONLY, so no external `cat` — read the single line with the builtin.
  "IFS= read -r line",
  'if [ -n "$FAKE_AGY_STDIN" ]; then printf "%s" "$line" > "$FAKE_AGY_STDIN"; fi',
  'echo \'{"event":"result","result":{"status":"SUCCESS","response":"AGY-FAKE-OK","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\'',
  "exit 0",
].join("\n")

const FAIL_AGY = [
  "IFS= read -r line",
  'echo \'{"event":"result","result":{"status":"ERROR","response":"","error":"not signed in to Antigravity"}}\'',
  "exit 0",
].join("\n")

beforeEach(() => {
  fakeDir = mkdtempSync(join(tmpdir(), "llm-subcli-bin-"))
  savedPath = process.env.PATH
  savedNoAutoload = process.env.LLM_NO_ENV_AUTOLOAD
  savedCodexHome = process.env.CODEX_HOME
  // PATH is the fake dir ONLY, so a real `codex`/`agy` on the host PATH
  // cannot make this suite pass or fail by accident.
  process.env.PATH = fakeDir
  process.env.LLM_NO_ENV_AUTOLOAD = "1"
  // CODEX_HOME is the (empty) fake dir, so codexProfile() finds no config.toml
  // and reads the profile as a plain ChatGPT login — never this host's real
  // luna gateway profile.
  process.env.CODEX_HOME = fakeDir
  delete process.env.LLM_SUBSCRIPTION_CLI
  for (const key of KEY_VARS) delete process.env[key]
  resetSubscriptionCliProbe()
})

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  if (savedNoAutoload === undefined) delete process.env.LLM_NO_ENV_AUTOLOAD
  else process.env.LLM_NO_ENV_AUTOLOAD = savedNoAutoload
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedCodexHome
  delete process.env.FAKE_CODEX_ARGV
  delete process.env.FAKE_AGY_ARGV
  delete process.env.FAKE_AGY_STDIN
  resetSubscriptionCliProbe()
  safeRemoveSync(fakeDir, { within: tmpdir(), allowMissing: true })
})

function modelOf(id: string): Model {
  const model = getModel(id)
  if (!model) throw new Error(`test bug: unknown model ${id}`)
  return model
}

describe("route table", () => {
  it("maps openai→codex and google→agy, and nothing else", () => {
    expect(subscriptionCliFor("openai")).toBe("codex")
    expect(subscriptionCliFor("google")).toBe("agy")
    for (const other of ["anthropic", "xai", "perplexity", "openrouter", "ollama"] as Provider[]) {
      expect(subscriptionCliFor(other)).toBeUndefined()
    }
  })

  it("honours the LLM_SUBSCRIPTION_CLI kill switch", () => {
    writeBin("codex", "exit 0")
    resetSubscriptionCliProbe()
    expect(subscriptionCliEnabled()).toBe(true)
    expect(subscriptionCliAvailable("openai")).toBe(true)
    process.env.LLM_SUBSCRIPTION_CLI = "0"
    expect(subscriptionCliEnabled()).toBe(false)
    expect(subscriptionCliAvailable("openai")).toBe(false)
    expect(isProviderRoutable("openai")).toBe(false)
  })

  it("names the route it will take", () => {
    expect(describeSubscriptionRoute(modelOf("gpt-5.4"))).toContain("codex CLI")
    expect(describeSubscriptionRoute(modelOf("gemini-2.5-pro"))).toContain("agy CLI")
    expect(describeSubscriptionRoute(modelOf("gemini-2.5-pro"))).toContain(agySubscriptionModel())
  })
})

describe("PATH probe", () => {
  it("finds an executable on PATH and caches the answer", () => {
    writeBin("codex", "exit 0")
    resetSubscriptionCliProbe()
    expect(cliOnPath("codex")).toBe(true)
    expect(cliOnPath("agy")).toBe(false)
    // A newly added binary is not seen until the cache is reset — the probe is
    // deliberately cheap and per-process.
    writeBin("agy", "exit 0")
    expect(cliOnPath("agy")).toBe(false)
    resetSubscriptionCliProbe()
    expect(cliOnPath("agy")).toBe(true)
  })

  it("a non-executable file on PATH does not count as a CLI", () => {
    writeFileSync(join(fakeDir, "codex"), "#!/bin/sh\nexit 0\n")
    resetSubscriptionCliProbe()
    expect(cliOnPath("codex")).toBe(false)
  })
})

describe("provider routing", () => {
  it("isProviderRoutable is true for a CLI-backed provider with no key", () => {
    expect(isProviderRoutable("openai")).toBe(false)
    expect(providerRouteLabel("openai")).toBe("OPENAI_API_KEY not set")
    writeBin("codex", "exit 0")
    resetSubscriptionCliProbe()
    expect(isProviderRoutable("openai")).toBe(true)
    expect(providerRouteLabel("openai")).toBe("subscription CLI ready")
  })

  it("labels the route dispatch will actually take: the CLI wins over a key", () => {
    writeBin("codex", "exit 0")
    resetSubscriptionCliProbe()
    process.env.OPENAI_API_KEY = "sk-test"
    expect(providerRouteLabel("openai")).toBe("subscription CLI ready")
    // With the CLI route disabled the key really is the route, and the label says so.
    process.env.LLM_SUBSCRIPTION_CLI = "0"
    expect(providerRouteLabel("openai")).toBe("provider key ready")
  })

  it("N1: a codex profile that routes to a gateway is not a ChatGPT login", () => {
    writeBin("codex", "exit 0")
    writeCodexProfile('model_provider = "lunaroute"\n')
    resetSubscriptionCliProbe()
    expect(subscriptionCliAvailable("openai")).toBe(false)
    expect(isProviderRoutable("openai")).toBe(false)
    expect(providerRouteLabel("openai")).toBe("OPENAI_API_KEY not set")
    expect(subscriptionRouteNote(modelOf("gpt-5.4"))).toContain("routes to lunaroute")
  })

  it("N1 fold-in: a model_provider inside a [table] is not the active profile", () => {
    writeBin("codex", "exit 0")
    // The gateway key sits inside an inactive [profiles.other] table; the
    // top-level section names no provider, so this is still a ChatGPT login.
    writeCodexProfile('[profiles.other]\nmodel_provider = "lunaroute"\n')
    resetSubscriptionCliProbe()
    expect(subscriptionCliAvailable("openai")).toBe(true)
    expect(providerRouteLabel("openai")).toBe("subscription CLI ready")
  })
})

describe("codex route table", () => {
  it("N3: declares an effort per row and refuses an undeclared SKU", () => {
    expect(codexSubscriptionRow("gpt-5.4")).toEqual({ model: "gpt-5.5", effort: "medium" })
    expect(codexSubscriptionRow("gpt-5.4-pro")?.effort).toBe("high")
    expect(codexSubscriptionRow("gpt-5-nano")?.effort).toBe("low")
    expect(codexSubscriptionRow("gpt-4o")).toBeUndefined()
  })
})

describe("dispatch", () => {
  it("answers an OpenAI model through the codex CLI with no API key", async () => {
    const argvFile = join(fakeDir, "codex-argv.txt")
    process.env.FAKE_CODEX_ARGV = argvFile
    writeBin("codex", OK_CODEX)
    resetSubscriptionCliProbe()

    const response = await querySubscriptionCli(modelOf("gpt-5.4"), { question: "hello" })
    expect(response.error).toBeUndefined()
    expect(response.content).toBe("CODEX-FAKE-OK")
    expect(response.usage?.estimatedCost).toBe(0)
    expect(response.usage?.totalTokens).toBe(10)
    expect(response.servedBy).toEqual({ route: "subscription-cli", cli: "codex", model: "gpt-5.5" })
    const argv = readFileSync(argvFile, "utf8")
    expect(argv).toContain("exec")
    expect(argv).toContain("--json")
    expect(argv).toContain("--ephemeral")
    // The model is passed explicitly so codex cannot silently answer with its
    // own config default.
    expect(argv).toContain("-m")
    expect(argv).toContain("gpt-5.5")
    expect(argv).toContain("model_reasoning_effort=medium")
  })

  it("passes the declared reasoning effort per row", async () => {
    const argvFile = join(fakeDir, "codex-argv-pro.txt")
    process.env.FAKE_CODEX_ARGV = argvFile
    writeBin("codex", OK_CODEX)
    resetSubscriptionCliProbe()

    await querySubscriptionCli(modelOf("gpt-5.4-pro"), { question: "hi" })
    const argv = readFileSync(argvFile, "utf8")
    expect(argv).toContain("-c")
    expect(argv).toContain("model_reasoning_effort=high")
  })

  it("answers a Gemini model through agy stream-json with the Antigravity model", async () => {
    const argvFile = join(fakeDir, "agy-argv.txt")
    const stdinFile = join(fakeDir, "agy-stdin.txt")
    process.env.FAKE_AGY_ARGV = argvFile
    process.env.FAKE_AGY_STDIN = stdinFile
    writeBin("agy", OK_AGY)
    resetSubscriptionCliProbe()

    const response = await querySubscriptionCli(modelOf("gemini-2.5-pro"), { question: "hello" })
    expect(response.error).toBeUndefined()
    expect(response.content).toBe("AGY-FAKE-OK")
    expect(response.usage?.totalTokens).toBe(7)
    expect(response.servedBy).toEqual({
      route: "subscription-cli",
      cli: "agy",
      model: agySubscriptionModel(),
    })
    const argv = readFileSync(argvFile, "utf8")
    expect(argv).toContain("--model")
    expect(argv).toContain(agySubscriptionModel())
    expect(argv).toContain("--input-format")
    expect(argv).toContain("stream-json")
    // The prompt travels on stdin, not in argv.
    expect(argv).not.toContain("hello")
    const stdin = readFileSync(stdinFile, "utf8")
    expect(stdin).toContain('"event":"user"')
    expect(stdin).toContain("hello")
  })

  it("a broken codex login is a loud error, never a silent fallback", async () => {
    writeBin("codex", FAIL_CODEX)
    resetSubscriptionCliProbe()

    const response = await querySubscriptionCli(modelOf("gpt-5.4"), { question: "hello" })
    expect(response.content).toBe("")
    expect(response.error).toContain("codex CLI")
    expect(response.error).toContain("token expired")
  })

  it("refuses a provider that has no subscription route", async () => {
    await expect(querySubscriptionCli(modelOf("claude-sonnet-4-6"), { question: "hi" })).rejects.toThrow(
      /No subscription CLI route/,
    )
  })

  it("a broken agy login is a loud error, never a silent fallback", async () => {
    writeBin("agy", FAIL_AGY)
    resetSubscriptionCliProbe()

    const response = await querySubscriptionCli(modelOf("gemini-2.5-pro"), { question: "hello" })
    expect(response.content).toBe("")
    expect(response.error).toContain("agy CLI")
    expect(response.error).toContain("not signed in to Antigravity")
    expect(response.error).toContain("status ERROR")
  })

  it("refuses an OpenAI SKU with no declared codex model, by name, before spawn", async () => {
    writeBin("codex", OK_CODEX)
    resetSubscriptionCliProbe()
    const response = await querySubscriptionCli(modelOf("gpt-4o"), { question: "hi" })
    expect(response.content).toBe("")
    expect(response.error).toContain("no codex model is declared")
    expect(response.error).toContain("gpt-4o")
  })
})

describe("temp working directory hygiene", () => {
  it("removes its scratch dirs after a successful dispatch", async () => {
    writeBin("codex", OK_CODEX)
    writeBin("agy", OK_AGY)
    resetSubscriptionCliProbe()
    const countScratch = () =>
      readdirSync(tmpdir()).filter((f) => f.startsWith("llm-codex-") || f.startsWith("llm-agy-")).length
    const before = countScratch()
    await querySubscriptionCli(modelOf("gpt-5.4"), { question: "hi" })
    await querySubscriptionCli(modelOf("gemini-2.5-pro"), { question: "hi" })
    expect(countScratch()).toBe(before)
  })
})

describe("route decision (pure)", () => {
  it("is subscription-first: the CLI wins even when a key exists", () => {
    writeBin("codex", "exit 0")
    resetSubscriptionCliProbe()
    process.env.OPENAI_API_KEY = "sk-test"
    expect(resolveSubscriptionRoute(modelOf("gpt-5.4"), {})).toBe("codex")
  })

  it("yields the key route only when the CLI route is disabled", () => {
    writeBin("codex", "exit 0")
    resetSubscriptionCliProbe()
    process.env.LLM_SUBSCRIPTION_CLI = "0"
    expect(resolveSubscriptionRoute(modelOf("gpt-5.4"), {})).toBeUndefined()
  })

  it("never routes an image, nor a provider with no CLI", () => {
    writeBin("codex", "exit 0")
    resetSubscriptionCliProbe()
    expect(resolveSubscriptionRoute(modelOf("gpt-5.4"), { hasImage: true })).toBeUndefined()
    expect(resolveSubscriptionRoute(modelOf("claude-sonnet-4-6"), {})).toBeUndefined()
  })

  it("is disabled when no CLI is on PATH", () => {
    resetSubscriptionCliProbe()
    expect(resolveSubscriptionRoute(modelOf("gpt-5.4"), {})).toBeUndefined()
  })

  it("refuses an OpenAI SKU codex cannot serve, naming the key instead", () => {
    writeBin("codex", "exit 0")
    resetSubscriptionCliProbe()
    // gpt-4o has no CODEX_SUBSCRIPTION_MODEL row: the route must not promise a
    // CLI that would only answer with a substitute.
    expect(resolveSubscriptionRoute(modelOf("gpt-4o"), {})).toBeUndefined()
  })

  it("refuses a deep-research SKU: its own SDK path, not a text one-shot", () => {
    writeBin("codex", "exit 0")
    resetSubscriptionCliProbe()
    expect(resolveSubscriptionRoute(modelOf("o3-deep-research-2025-06-26"), {})).toBeUndefined()
  })
})

describe("queryModel wiring", () => {
  it("answers an OpenAI model with no key through the codex CLI", async () => {
    writeBin("codex", OK_CODEX)
    resetSubscriptionCliProbe()
    // No LLM_SUBSCRIPTION_CLI: the default is subscription-first.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { queryModel } = await import("../src/lib/research")
      const { response } = await queryModel({
        question: "hi",
        model: modelOf("gpt-5.4"),
        observationStore: null,
      })
      expect(response.error).toBeUndefined()
      expect(response.content).toBe("CODEX-FAKE-OK")
      expect(response.servedBy?.cli).toBe("codex")
    } finally {
      errSpy.mockRestore()
    }
  })

  it("does not route a deep-research model onto the CLI — the gate names the key", async () => {
    writeBin("codex", OK_CODEX)
    resetSubscriptionCliProbe()
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { queryModel } = await import("../src/lib/research")
      const { response } = await queryModel({
        question: "hi",
        model: modelOf("o3-deep-research-2025-06-26"),
        observationStore: null,
      })
      // Refused by the route, so with no key the error is a missing-key message,
      // never a CLI attempt that fails on the SDK's words.
      expect(response.content).toBe("")
      expect(response.error).toMatch(/OPENAI_API_KEY/)
      expect(response.servedBy).toBeUndefined()
    } finally {
      errSpy.mockRestore()
    }
  })

  it("N5: names the no-row case beside the missing key", async () => {
    writeBin("codex", OK_CODEX)
    resetSubscriptionCliProbe()
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { queryModel } = await import("../src/lib/research")
      const { response } = await queryModel({
        question: "hi",
        model: modelOf("gpt-4o"),
        observationStore: null,
      })
      expect(response.content).toBe("")
      expect(response.error).toMatch(/OPENAI_API_KEY/)
      expect(response.error).toContain("no declared model for OpenAI SKU gpt-4o")
    } finally {
      errSpy.mockRestore()
    }
  })
})
