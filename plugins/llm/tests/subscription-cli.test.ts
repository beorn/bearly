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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs"
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
  cliOnPath,
  codexProfile,
  codexSubscriptionRow,
  subscriptionRouteNote,
  resetSubscriptionCliProbe,
  resolveSubscriptionRoute,
  agyConversationPaths,
  removeAgyConversation,
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
  'if [ -n "$FAKE_AGY_AGENT_FILE" ] && [ -f .agents/agents/bearly-llm-text/agent.md ]; then',
  '  while IFS= read -r agent_line; do printf "%s\\n" "$agent_line"; done < .agents/agents/bearly-llm-text/agent.md > "$FAKE_AGY_AGENT_FILE"',
  "fi",
  // The prompt must arrive on STDIN via stream-json, never as a `-p <prompt>`
  // argv string (which dies with E2BIG past MAX_ARG_STRLEN). PATH is the fake
  // dir ONLY, so no external `cat` — read the single line with the builtin.
  "IFS= read -r line",
  'if [ -n "$FAKE_AGY_STDIN" ]; then printf "%s" "$line" > "$FAKE_AGY_STDIN"; fi',
  'if [ -n "$FAKE_AGY_CWD" ]; then pwd -P > "$FAKE_AGY_CWD"; fi',
  // The real agy (1.3.5) names the conversation it persists on `init` and again on `result` (29475). The id here is
  // format-valid and reserved for this test: nothing of that name exists under any agy home.
  'echo \'{"event":"init","conversation_id":"00000000-0000-4000-8000-000000029475","init":{"model":"gemini-4-argon-high"}}\'',
  'echo \'{"event":"result","result":{"conversation_id":"00000000-0000-4000-8000-000000029475","status":"SUCCESS","response":"AGY-FAKE-OK","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\'',
  "exit 0",
].join("\n")

const FAIL_AGY = [
  "IFS= read -r line",
  // 29475: a failed run still names a conversation; this one is not a UUID, so its removal is refused before any
  // filesystem target — the refusal must reach the caller on the error envelope.
  'echo \'{"event":"init","conversation_id":"not-a-uuid","init":{"model":"gemini-4-argon-high"}}\'',
  'echo \'{"event":"result","result":{"status":"ERROR","response":"","error":"not signed in to Antigravity"}}\'',
  "exit 0",
].join("\n")

// 29475: a run that answers nothing is an error, and its one-shot still had a conversation to remove.
const EMPTY_AGY = [
  "IFS= read -r line",
  'echo \'{"event":"init","conversation_id":"00000000-0000-4000-8000-000000029475","init":{"model":"gemini-4-argon-high"}}\'',
  'echo \'{"event":"result","result":{"conversation_id":"00000000-0000-4000-8000-000000029475","status":"SUCCESS","response":"   "}}\'',
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
  delete process.env.FAKE_AGY_CWD
  delete process.env.FAKE_AGY_AGENT_FILE
  resetSubscriptionCliProbe()
  safeRemoveSync(fakeDir, { within: tmpdir(), allowMissing: true })
})

function modelOf(id: string): Model {
  const model = getModel(id)
  if (!model) throw new Error(`test bug: unknown model ${id}`)
  return model
}

describe("route table", () => {
  it("Pro subscription dry-run keeps forecast charge unknown", async () => {
    writeBin("codex", "exit 0")
    resetSubscriptionCliProbe()
    const output: string[] = []
    const stderr = vi.spyOn(console, "error").mockImplementation((...parts) => {
      output.push(parts.join(" "))
    })
    try {
      const { runProDual } = await import("../src/cmd/pro")
      await runProDual({
        question: "forecast fixture",
        modelOverride: modelOf("gpt-5.4"),
        imagePath: undefined,
        streamToken: vi.fn(),
        buildContext: vi.fn(),
        outputFile: join(fakeDir, "never-written.txt"),
        sessionTag: "test",
        skipConfirm: true,
        dryRun: true,
      })
      const forecast = output.find((line) => line.includes("Estimated cost:"))!
      expect(forecast).toContain("charged unknown (forecast; no call dispatched)")
      expect(forecast).toContain("list-equivalent unknown")
      expect(forecast).toContain("subscription served model not yet reported")
      expect(output.join("\n")).not.toContain("~$0")
      expect(existsSync(join(fakeDir, "never-written.txt"))).toBe(false)
    } finally {
      stderr.mockRestore()
    }
  })

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
    expect(describeSubscriptionRoute(modelOf("gemini-2.5-pro"))).toContain("gemini-4-argon-high")
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

  it("reports a PATH symlink loop instead of caching the CLI as absent", () => {
    symlinkSync("codex", join(fakeDir, "codex"))
    expect(() => cliOnPath("codex")).toThrow(/ELOOP/)
  })
})

describe("provider routing", () => {
  it.each(["PATH", "profile"])("records a %s probe fault in the model's error result", async (probe) => {
    if (probe === "PATH") symlinkSync("codex", join(fakeDir, "codex"))
    else {
      writeBin("codex", "exit 0")
      mkdirSync(join(fakeDir, "config.toml"))
    }
    const { queryModel } = await import("../src/lib/research")
    const { response } = await queryModel({ question: "hi", model: modelOf("gpt-5.4"), observationStore: null })
    expect(response.content).toBe("")
    expect(response.error).toContain(probe === "PATH" ? "ELOOP" : "EISDIR")
    expect(response.error).toContain(fakeDir)
    expect(response.error).toContain("GPT-5.4")
  })

  it("reports an unreadable profile instead of assuming a ChatGPT login", () => {
    mkdirSync(join(fakeDir, "config.toml"))
    expect(() => codexProfile()).toThrow(/EISDIR/)
  })

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
  it("refuses an unreadable authoritative answer instead of accepting its JSONL mirror", async () => {
    const bin = join(fakeDir, "codex")
    writeFileSync(
      bin,
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs")',
        'fs.mkdirSync(process.argv[process.argv.indexOf("-o") + 1])',
        'console.log(JSON.stringify({type: "item.completed", item: {type: "agent_message", text: "must-not-be-the-answer"}}))',
      ].join("\n"),
    )
    chmodSync(bin, 0o755)
    await expect(querySubscriptionCli(modelOf("gpt-5.4"), { question: "hi" })).rejects.toThrow(/EISDIR/)
  })

  // CLI usage is a provider receipt, not a zero-cost placeholder. Existing
  // complete fixtures miss absent counts and a manufactured subscription bill.
  it.each(
    [
      { raw: {}, counts: {} },
      { raw: { input_tokens: 7 }, counts: { promptTokens: 7 } },
      { raw: { output_tokens: 3 }, counts: { completionTokens: 3 } },
      { raw: { input_tokens: 0, output_tokens: 0 }, counts: { promptTokens: 0, completionTokens: 0 } },
    ].flatMap((item) => ["codex", "agy"].map((cli) => ({ ...item, cli }))),
  )("preserves $cli partial usage $raw", async ({ raw, counts, cli }) => {
    const original = { ...raw, invoice: "cli-original" }
    writeBin(
      cli,
      cli === "codex"
        ? OK_CODEX.replace('{"input_tokens":7,"output_tokens":3}', JSON.stringify(original))
        : OK_AGY.replace('{"input_tokens":5,"output_tokens":2,"total_tokens":7}', JSON.stringify(original)),
    )
    resetSubscriptionCliProbe()
    const response = await querySubscriptionCli(modelOf(cli === "codex" ? "gpt-5.4" : "gemini-2.5-pro"), {
      question: "probe",
    })
    expect(response.error).toBeUndefined()
    expect(JSON.parse(JSON.stringify(response.usage))).toEqual({ ...counts, raw: original })
    expect(response.cost_usd).toBeUndefined()
  })

  it("answers an OpenAI model through the codex CLI with no API key", async () => {
    const argvFile = join(fakeDir, "codex-argv.txt")
    process.env.FAKE_CODEX_ARGV = argvFile
    writeBin("codex", OK_CODEX.replace('"input_tokens":7', '"input_tokens":7,"cached_input_tokens":2'))
    resetSubscriptionCliProbe()

    const response = await querySubscriptionCli(modelOf("gpt-5.4"), { question: "hello" })
    expect(response.error).toBeUndefined()
    expect(response.content).toBe("CODEX-FAKE-OK")
    expect(response.usage).not.toHaveProperty("estimatedCost")
    expect(response.usage).not.toHaveProperty("totalTokens")
    expect(response.usage?.classes).toEqual({ input: 5, cache_read: 2, output: 3 })
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

  it("answers a Gemini model through the isolated question-only agy agent", async () => {
    const argvFile = join(fakeDir, "agy-argv.txt")
    const stdinFile = join(fakeDir, "agy-stdin.txt")
    process.env.FAKE_AGY_ARGV = argvFile
    process.env.FAKE_AGY_STDIN = stdinFile
    const agentFile = join(fakeDir, "agy-agent.md")
    process.env.FAKE_AGY_AGENT_FILE = agentFile
    writeBin("agy", OK_AGY)
    resetSubscriptionCliProbe()

    const cwdFile = join(fakeDir, "agy-cwd.txt")
    process.env.FAKE_AGY_CWD = cwdFile
    const response = await querySubscriptionCli(modelOf("gemini-2.5-pro"), { question: "hello" })
    expect(response.error).toBeUndefined()
    expect(response.content).toBe("AGY-FAKE-OK")
    expect(response.usage?.totalTokens).toBe(7)
    expect(response.servedBy).toEqual({
      route: "subscription-cli",
      cli: "agy",
      model: "gemini-4-argon-high",
      // 29475: the one-shot names the conversation agy persisted and what became of it. The reserved id exists
      // under no agy home, so the only honest answer here is `absent`.
      oneShot: { conversationId: "00000000-0000-4000-8000-000000029475", cleanup: "absent" },
    })
    // 29475: the run's cwd is the one-shot's own scratch directory (agy records its cwd as the conversation's
    // workspace), never the caller's checkout — and that directory is gone after the run.
    const cwd = readFileSync(cwdFile, "utf8").trim()
    expect(cwd.startsWith(join(realpathSync(tmpdir()), "llm-agy-")), cwd).toBe(true)
    expect(existsSync(cwd), "the scratch cwd is removed after the run").toBe(false)
    const argv = readFileSync(argvFile, "utf8")
    expect(argv).toContain("--model")
    expect(argv).toContain("gemini-4-argon-high")
    expect(argv).toContain("--input-format")
    expect(argv).toContain("stream-json")
    // This boundary proves delivery of the config whose capability effect is checked with the real CLI.
    expect(argv).toContain("--agent bearly-llm-text")
    const agent = readFileSync(agentFile, "utf8")
    expect(agent).toContain("name: bearly-llm-text")
    expect(agent).toContain("excludeDefaultComponents: true")
    expect(agent).toContain("tools: []")
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
    // 29475: the one-shot's cleanup outcome is carried on the error envelope too, so a refused or failed removal
    // after a failed run is never silently lost.
    expect(response.servedBy).toEqual({
      route: "subscription-cli",
      cli: "agy",
      model: "gemini-4-argon-high",
      oneShot: {
        conversationId: "not-a-uuid",
        cleanup: expect.stringMatching(/^failed: agy conversation id is not a UUID/),
      },
    })
  })

  it("an empty agy answer is an error that still carries the one-shot's cleanup outcome", async () => {
    writeBin("agy", EMPTY_AGY)
    resetSubscriptionCliProbe()

    const response = await querySubscriptionCli(modelOf("gemini-2.5-pro"), { question: "hello" })
    expect(response.content).toBe("")
    expect(response.error).toContain("returned an empty answer")
    expect(response.servedBy?.oneShot).toEqual({
      conversationId: "00000000-0000-4000-8000-000000029475",
      cleanup: "absent",
    })
  })

  it.each([
    {
      name: "denial with the CLI diagnostic",
      denied: true,
      diagnostic:
        "jetski: no output produced — command permission was auto-denied. Add an allow-rule under permissions.allow. Alternatively, re-run with --dangerously-skip-permissions.",
      reason: "command permission was auto-denied",
    },
    { name: "denial without stderr", denied: true, diagnostic: "", reason: "RunCommand" },
    {
      name: "provider diagnostic without a denial",
      denied: false,
      diagnostic: "provider produced no content",
      reason: "provider produced no content",
    },
  ])("an empty agy answer retains $name without bypass advice", async ({ denied, diagnostic, reason }) => {
    // The native exit-0/SUCCESS denial must survive at the public response boundary, even without stderr.
    const result = {
      conversation_id: "00000000-0000-4000-8000-000000029475",
      status: "SUCCESS",
      response: "",
      ...(denied ? { denied_actions: [{ action: "command", display_name: "RunCommand" }] } : {}),
    }
    writeBin(
      "agy",
      [
        "IFS= read -r line",
        `echo '${JSON.stringify({ event: "result", result })}'`,
        `echo '${diagnostic}' >&2`,
        "exit 0",
      ].join("\n"),
    )
    resetSubscriptionCliProbe()

    const response = await querySubscriptionCli(modelOf("gemini-2.5-pro"), { question: "hello" })
    expect(response.content).toBe("")
    expect(response.error).toContain(reason)
    if (denied) {
      expect(response.error).toContain("command")
      expect(response.error).toContain("RunCommand")
    }
    expect(response.error).not.toContain("Add an allow-rule")
    expect(response.error).not.toContain("--dangerously-skip-permissions")
    expect(response.servedBy?.oneShot?.cleanup).toBe("absent")
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

describe("29475: an agy one-shot keeps no conversation", () => {
  // agy persists every print-mode run under its home: brain/<id>/.system_generated/logs/transcript.jsonl (which
  // `ag transcript list` catalogs and recall indexes as a session) and conversations/<id>.db. agy 1.3.5 has no flag
  // to skip or mark that, so the caller removes what it created and says so by name.
  const ID = "c7ad3161-61e2-46bf-b24f-31ab84967b56"

  it("names the two artifacts under the home and refuses a non-UUID id (nothing else is ever removed)", () => {
    expect(agyConversationPaths("/home/x/.gemini/antigravity-cli", ID)).toEqual({
      brain: `/home/x/.gemini/antigravity-cli/brain/${ID}`,
      conversation: `/home/x/.gemini/antigravity-cli/conversations/${ID}.db`,
    })
    expect(() => agyConversationPaths("/home/x/.gemini/antigravity-cli", "../brain")).toThrow(/not a UUID/)
    expect(() => agyConversationPaths("/home/x/.gemini/antigravity-cli", "")).toThrow(/not a UUID/)
  })

  it("removes the brain directory and the conversation db of the id agy named, and only those", () => {
    const home = mkdtempSync(join(tmpdir(), "llm-agy-home-"))
    const other = "0ba45abc-f907-4c97-8b6c-c0698fb2d8a3"
    for (const id of [ID, other]) {
      mkdirSync(join(home, "brain", id, ".system_generated", "logs"), { recursive: true })
      writeFileSync(join(home, "brain", id, ".system_generated", "logs", "transcript.jsonl"), "{}\n")
      mkdirSync(join(home, "conversations"), { recursive: true })
      writeFileSync(join(home, "conversations", `${id}.db`), "")
    }
    writeFileSync(join(home, "history.jsonl"), "")
    try {
      expect(removeAgyConversation(home, ID)).toBe("removed")
      expect(existsSync(join(home, "brain", ID))).toBe(false)
      expect(existsSync(join(home, "conversations", `${ID}.db`))).toBe(false)
      const otherTranscript = join(home, "brain", other, ".system_generated", "logs", "transcript.jsonl")
      expect(existsSync(otherTranscript), "another conversation is untouched").toBe(true)
      expect(existsSync(join(home, "conversations", `${other}.db`))).toBe(true)
      expect(existsSync(join(home, "history.jsonl")), "the interactive history is untouched").toBe(true)
      expect(removeAgyConversation(home, ID), "a second removal finds nothing").toBe("absent")
      expect(removeAgyConversation(home, undefined), "a stream that named no conversation is said").toBe(
        "no-conversation-id",
      )
      expect(removeAgyConversation(home, "../../etc")).toMatch(/^failed: agy conversation id is not a UUID/)
    } finally {
      safeRemoveSync(home, { within: tmpdir(), allowMissing: true })
    }
  })
})
