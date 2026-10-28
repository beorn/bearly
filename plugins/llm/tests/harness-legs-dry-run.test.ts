/**
 * @failure pro omits configured harness legs, bypasses its launcher, or loses incomplete outcomes.
 * @level l1
 * @consumer seats previewing which Claude and Codex subscription logins a pro dry-run would use.
 * @testonly none
 *
 * Spawn named by the dry-run gate: pro.ts launches an API leg through `ask`
 * (src/lib/research.ts) and `queryOpenAIBackground` (src/lib/openai-deep.ts).
 * The subscription CLI process is `runCli` → `spawn` from node:child_process
 * (src/lib/subscription-cli.ts). A dry-run must call none of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getMemoryDir, loadConfig } from "../src/lib/dual-pro"
import { NO_CLAUDE_LOGIN, resolveClaudeHarnessAccount } from "../src/lib/harness-account"
import { runProDual } from "../src/cmd/pro"
import { getModel } from "../src/lib/types"

import { nativeRunner, agCodeRunner as nativeRunnerFactory, harnessLegLaunch } from "./fixtures/harness-launcher"
import { runHarnessLeg } from "../src/lib/harness-run"

const spawnMock = vi.hoisted(() => vi.fn())

const launcher = new URL("./fixtures/harness-launcher.ts", import.meta.url).href
const askMock = vi.hoisted(() => vi.fn())
const queryBackgroundMock = vi.hoisted(() => vi.fn())
const costMock = vi.hoisted(() => vi.fn())
const providerRouteMock = vi.hoisted(() => vi.fn((_provider: string) => false))

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawn: spawnMock }
})

// Most cases isolate subscription legs; the coexistence case opts one API
// route into the existing dispatch mock without contacting a provider.
vi.mock("../src/lib/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/providers")>()
  return { ...actual, isProviderRoutable: providerRouteMock }
})

vi.mock("../src/lib/research", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/research")>()
  return { ...actual, ask: askMock }
})

vi.mock("../src/lib/openai-deep", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/openai-deep")>()
  return { ...actual, queryOpenAIBackground: queryBackgroundMock }
})

vi.mock("../src/lib/format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/format")>()
  return {
    ...actual,
    estimateFleetCost: (...args: Parameters<typeof actual.estimateFleetCost>) => {
      costMock(args[0])
      return actual.estimateFleetCost(...args)
    },
  }
})

const HARNESS_CONFIG = {
  harnessLauncher: launcher,
  harnessLegs: [
    { provider: "claude-code", model: "fable" },
    { provider: "codex", model: "gpt-6-astra", profile: "codex-login-name" },
  ],
}

let root: string

function writeConfig(body: unknown): void {
  const dir = getMemoryDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "dual-pro-config.json"), JSON.stringify(body))
}

async function captureDryRun(): Promise<string> {
  const lines: string[] = []
  const stderr = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map((part) => String(part)).join(" "))
  })
  try {
    await runProDual({
      question: "ping",
      modelOverride: undefined,
      imagePath: undefined,
      streamToken: vi.fn(),
      buildContext: async () => undefined,
      outputFile: join(root, "never-written.txt"),
      sessionTag: "harness-dry-run",
      skipConfirm: true,
      dryRun: true,
    })
  } finally {
    stderr.mockRestore()
  }
  return lines.join("\n")
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llm-dry-"))
  vi.stubEnv("HOME", join(root, "home"))
  vi.stubEnv("CLAUDE_PROJECT_DIR", join(root, "project"))
  vi.stubEnv("BEARLY_LLM_MEMORY_DIR", "")
  vi.stubEnv("LLM_DIR", "")
  vi.stubEnv("LLM_DUAL_PRO_B", "")
  vi.stubEnv("LLM_SPLIT_TEST_POOL", "")
  vi.stubEnv("LLM_CHALLENGER_POOL", "")
  vi.stubEnv("LLM_JUDGE_MODEL", "")
  vi.stubEnv("LLM_EXCLUDE", "")
  vi.stubEnv("CLAUDE_CONFIG_DIR", "")
  vi.stubEnv("CLAUDE_PROFILE_ROOT", "")
  spawnMock.mockReset()
  harnessLegLaunch.mockClear()
  nativeRunner.mockReset()
  nativeRunnerFactory.mockReset()
  nativeRunner.mockResolvedValue({ exitCode: 0, timedOut: false, ms: 5, stdout: "harness opinion" })
  nativeRunnerFactory.mockImplementation(() => nativeRunner)
  providerRouteMock.mockReset()
  providerRouteMock.mockReturnValue(false)
  askMock.mockReset()
  queryBackgroundMock.mockReset()
  costMock.mockReset()
  spawnMock.mockImplementation(() => {
    throw new Error("dry-run spawned a process")
  })
  askMock.mockImplementation(() => {
    throw new Error("dry-run called ask")
  })
  queryBackgroundMock.mockImplementation(() => {
    throw new Error("dry-run called queryOpenAIBackground")
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe("Claude harness account", () => {
  it("reads the account from the CLAUDE_CONFIG_DIR path and does not fall through", () => {
    const profiles = join(root, "profiles")
    mkdirSync(profiles, { recursive: true })
    symlinkSync("from-default@example.com", join(profiles, "default"))
    vi.stubEnv("CLAUDE_PROFILE_ROOT", profiles)
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/ag/profiles/claude/fake-claude-acct/")
    expect(resolveClaudeHarnessAccount()).toBe("fake-claude-acct")
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/not-a-profile")
    expect(resolveClaudeHarnessAccount()).toBe(NO_CLAUDE_LOGIN)
  })

  it("uses ag's default profile symlink when CLAUDE_CONFIG_DIR is unset", () => {
    const profiles = join(root, "profiles")
    mkdirSync(profiles, { recursive: true })
    symlinkSync("from-default@example.com", join(profiles, "default"))
    vi.stubEnv("CLAUDE_PROFILE_ROOT", profiles)
    vi.stubEnv("CLAUDE_CONFIG_DIR", "")
    expect(resolveClaudeHarnessAccount()).toBe("from-default@example.com")
  })

  it("says no Claude login resolved when neither source names one", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "")
    vi.stubEnv("CLAUDE_PROFILE_ROOT", join(root, "empty-profiles"))
    mkdirSync(join(root, "empty-profiles"), { recursive: true })
    expect(resolveClaudeHarnessAccount()).toBe(NO_CLAUDE_LOGIN)
  })
})

describe("pro dry-run harness legs", () => {
  it("keeps an empty harnessLegs list byte-identical to an omitted field", async () => {
    const omitted = await captureDryRun()
    writeConfig({ harnessLegs: [] })
    const empty = await captureDryRun()
    expect(empty).toBe(omitted)
    expect(empty).not.toContain("• harness ")
    expect(empty).not.toContain("subscription quota")
    expect(spawnMock).not.toHaveBeenCalled()
    expect(askMock).not.toHaveBeenCalled()
    expect(queryBackgroundMock).not.toHaveBeenCalled()
  })

  it("lists both harness legs and the quota cost line without spawning or pricing them", async () => {
    const omitted = await captureDryRun()
    writeConfig(HARNESS_CONFIG)
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "profiles", "claude", "fake-claude-acct"))
    const listed = await captureDryRun()

    expect(listed).toContain("harness claude-code fable (account fake-claude-acct)")
    expect(listed).toContain("harness codex gpt-6-astra (account codex-login-name)")
    expect(listed).toContain("+2 harness legs on subscription quota")
    expect(listed).toContain(`launcher set to ${launcher}`)
    writeConfig({ harnessLegs: HARNESS_CONFIG.harnessLegs })
    expect(await captureDryRun()).toContain("launcher unset")
    expect(listed).not.toContain("unknown model")
    for (const line of omitted.split("\n")) {
      if (line.includes("Estimated cost:")) {
        expect(listed).toContain(`${line} +2 harness legs on subscription quota`)
      } else if (line.length > 0) {
        expect(listed).toContain(line)
      }
    }
    const priced = costMock.mock.calls.flatMap((call) => call[0] as { modelId: string }[])
    expect(priced.some((model) => model.modelId === "fable" || model.modelId === "gpt-6-astra")).toBe(false)
    expect(costMock).toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(askMock).not.toHaveBeenCalled()
    expect(queryBackgroundMock).not.toHaveBeenCalled()
  })

  it("runs harness legs through agCodeRunner and does not spawn from bearly", async () => {
    const judgeModel = getModel("gpt-5-mini")
    if (!judgeModel) throw new Error("harness judge fixture requires the registered GPT-5 Mini model")
    const judged = {
      scoreA: { scores: { specificity: 4, actionability: 4, correctness: 5, depth: 4 }, total: 17 },
      scoreB: { scores: { specificity: 3, actionability: 3, correctness: 3, depth: 3 }, total: 12 },
      winner: "A",
      reasoning: "The Claude opinion answers the question.",
    }
    const claudeOpinion = "The Claude harness opinion."
    const codexOpinion = "The Codex harness opinion."
    nativeRunner
      .mockResolvedValueOnce({ exitCode: 0, timedOut: false, ms: 5, stdout: claudeOpinion })
      .mockResolvedValueOnce({ exitCode: 0, timedOut: false, ms: 5, stdout: codexOpinion })
    askMock.mockResolvedValueOnce({ model: judgeModel, content: JSON.stringify(judged), durationMs: 5 })
    writeConfig({ ...HARNESS_CONFIG, judge: judgeModel.modelId })
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "profiles", "claude", "fake-claude-acct"))
    const diagnostics: string[] = []
    const stderr = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      diagnostics.push(parts.map(String).join(" "))
    })
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {})
    const fileNotice = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code ?? ""}`)
    }) as typeof process.exit)
    try {
      await runProDual({
        question: "ping",
        modelOverride: undefined,
        imagePath: undefined,
        streamToken: vi.fn(),
        buildContext: async () => undefined,
        outputFile: join(root, "never-written.txt"),
        sessionTag: "harness-real-run",
        skipConfirm: true,
        dryRun: false,
      }).catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.startsWith("exit ")) throw error
      })
    } finally {
      exit.mockRestore()
      stderr.mockRestore()
    }
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        "  • harness claude-code fable (account fake-claude-acct) returned",
        "  • harness codex gpt-6-astra (account codex-login-name) returned",
      ]),
    )
    expect(stdout).toHaveBeenCalledTimes(1)
    const envelope = JSON.parse(String(stdout.mock.calls[0]![0])) as { harness: unknown; harnessJudge: unknown }
    expect(envelope.harness).toEqual([
      expect.objectContaining({ harness: "claude-code", ok: true }),
      expect.objectContaining({ harness: "codex", ok: true }),
    ])
    expect(envelope.harnessJudge).toEqual(judged)
    stdout.mockRestore()
    expect(fileNotice.mock.calls.map(([chunk]) => chunk)).toEqual([
      "\n",
      `Output written to: ${join(root, "never-written.txt")}\n`,
    ])
    fileNotice.mockRestore()
    expect(askMock).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("QUESTION:\nping"),
      "quick",
      expect.objectContaining({ modelObject: judgeModel, stream: false }),
    )
    const judgePrompt = askMock.mock.calls[0]![0] as string
    expect(judgePrompt).toContain(`### Response A (claude-code fable)\n\n${claudeOpinion}`)
    expect(judgePrompt).toContain(`### Response B (codex gpt-6-astra)\n\n${codexOpinion}`)
    expect(queryBackgroundMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(nativeRunner).toHaveBeenCalled()
    const factoryCalls = nativeRunnerFactory.mock.calls as unknown as unknown[][]
    for (const call of factoryCalls) {
      expect(call[0] as number).toBeLessThanOrEqual(300_000)
      expect(call[1]).toEqual({ stdout: "full" })
    }
    expect(harnessLegLaunch.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        harness: "claude",
        account: "fake-claude-acct",
        model: "fable",
        prompt: "ping",
        env: process.env,
      }),
      expect.objectContaining({
        harness: "codex",
        account: "codex-login-name",
        model: "gpt-6-astra",
        prompt: "ping",
        env: process.env,
      }),
    ])
    for (const [index, launch] of harnessLegLaunch.mock.results.entries()) {
      expect(nativeRunner.mock.calls[index]).toEqual([launch.value.argv, launch.value.env])
    }
    const log = await import("node:fs").then((fs) => fs.readFileSync(join(getMemoryDir(), "ab-pro.jsonl"), "utf8"))
    expect(log).toContain('"provider":"harness"')
    expect(log).toContain('"account":"fake-claude-acct"')
    expect(log).toContain('"account":"codex-login-name"')
    expect(log).toContain("fixture codex launch")
    expect(JSON.parse(log.trim()).harnessJudge).toEqual(judged)
    const report = await import("node:fs").then((fs) => fs.readFileSync(join(root, "never-written.txt"), "utf8"))
    expect(report).toContain("## Harness legs")
    expect(report).toContain("fake-claude-acct")
    expect(report).toContain("codex-login-name")
    expect(report).toContain(`Harness judge: A — A 17, B 12. ${judged.reasoning}`)
  })

  // The earlier launcher-failure cases excluded every API route, so they
  // could not detect a failed launcher cancelling a paid opinion or its report.
  it("keeps a successful API opinion alongside an unloadable configured harness launcher", async () => {
    const apiModel = getModel("moonshotai/kimi-k2.6")
    if (!apiModel) throw new Error("coexistence fixture requires the registered Kimi model")
    providerRouteMock.mockImplementation((provider) => provider === apiModel.provider)
    const apiContent = "The API opinion survives the failed harness launcher."
    askMock.mockResolvedValue({ model: apiModel, content: apiContent, durationMs: 5 })
    vi.stubEnv("LLM_SKIP_MODEL_LIVENESS", "1")
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "profiles", "claude", "fake-claude-acct"))
    const missingLauncher = "missing-coexistence-launcher"
    writeConfig({
      harnessLauncher: missingLauncher,
      harnessLegs: [{ provider: "claude-code", model: "fable" }],
    })
    const outputFile = join(root, "coexistence-report.txt")
    const diagnostics: string[] = []
    const stderr = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      diagnostics.push(parts.map(String).join(" "))
    })
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {})
    const fileNotice = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code ?? ""}`)
    }) as typeof process.exit)
    try {
      await expect(
        runProDual({
          question: "coexistence question",
          modelOverride: undefined,
          imagePath: undefined,
          streamToken: vi.fn(),
          buildContext: async () => undefined,
          outputFile,
          sessionTag: "api-harness-coexistence",
          skipConfirm: true,
          dryRun: false,
          noChallenger: true,
          noJudge: true,
        }),
      ).rejects.toThrow("exit 1")
      expect(askMock).toHaveBeenCalledTimes(1)
      expect(askMock).toHaveBeenCalledWith(
        "coexistence question",
        "standard",
        expect.objectContaining({
          modelObject: apiModel,
          stream: false,
        }),
      )
      expect(queryBackgroundMock).not.toHaveBeenCalled()
      expect(nativeRunner).not.toHaveBeenCalled()
      expect(stdout).toHaveBeenCalledTimes(1)
      const envelope = JSON.parse(String(stdout.mock.calls[0]![0])) as { b: unknown; harness: unknown }
      expect(envelope.b).toEqual(expect.objectContaining({ model: apiModel.displayName, status: "completed" }))
      expect(envelope.harness).toEqual([
        expect.objectContaining({
          harness: "claude-code",
          model: "fable",
          ok: false,
          error: expect.stringContaining(missingLauncher),
        }),
      ])
      const report = readFileSync(outputFile, "utf8")
      expect(report).toContain(apiContent)
      expect(report).toContain("## Harness legs")
      expect(report).toContain(`Incomplete: harnessLauncher "${missingLauncher}"`)
      expect(
        diagnostics.some((line) => line.includes("harness claude-code fable") && line.includes("incomplete")),
      ).toBe(true)
      expect(fileNotice.mock.calls.map(([chunk]) => chunk)).toEqual(["\n", `Output written to: ${outputFile}\n`])
    } finally {
      exit.mockRestore()
      stderr.mockRestore()
      stdout.mockRestore()
      fileNotice.mockRestore()
    }
  })

  it.each([
    ["over-cap", { exitCode: 0, timedOut: false, ms: 1, stdoutOverCap: true, stdout: "A" }, "stdout exceeded 1 MiB"],
    ["timeout", { exitCode: null, timedOut: true, ms: 1 }, "timed out after"],
    ["nonzero exit", { exitCode: 2, timedOut: false, ms: 1, stdout: "nope", stderrTail: "line-a\nrefused" }, "exit 2"],
    ["empty stdout", { exitCode: 0, timedOut: false, ms: 1, stdout: "  " }, "empty stdout"],
    ["spawn error", { exitCode: null, timedOut: false, ms: 0, spawnError: "ENOENT" }, "spawn failed: ENOENT"],
  ] as const)("records an incomplete harness leg on %s", async (_name, result, printed) => {
    writeConfig({ harnessLauncher: launcher, harnessLegs: [{ provider: "claude-code", model: "fable" }] })
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "profiles", "claude", "fake-claude-acct"))
    nativeRunner.mockResolvedValue(result as never)
    const lines: string[] = []
    const stderr = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map((part) => String(part)).join(" "))
    })
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {})
    const fileNotice = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code ?? ""}`)
    }) as typeof process.exit)
    try {
      await runProDual({
        question: "ping",
        modelOverride: undefined,
        imagePath: undefined,
        streamToken: vi.fn(),
        buildContext: async () => undefined,
        outputFile: join(root, "never-written.txt"),
        sessionTag: "harness-incomplete",
        skipConfirm: true,
        dryRun: false,
      }).catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.startsWith("exit ")) throw error
      })
    } finally {
      stderr.mockRestore()
      exit.mockRestore()
    }
    expect(stdout).toHaveBeenCalledTimes(1)
    expect((JSON.parse(String(stdout.mock.calls[0]![0])) as { harness: unknown }).harness).toEqual([
      expect.objectContaining({ harness: "claude-code", ok: false, error: expect.stringContaining(printed) }),
    ])
    stdout.mockRestore()
    expect(fileNotice.mock.calls.map(([chunk]) => chunk)).toEqual([
      "\n",
      `Output written to: ${join(root, "never-written.txt")}\n`,
    ])
    fileNotice.mockRestore()
    expect(askMock).not.toHaveBeenCalled()
    expect(queryBackgroundMock).not.toHaveBeenCalled()
    expect(
      lines.some((line) => line.includes(printed) && line.includes("incomplete") && line.includes("fake-claude-acct")),
    ).toBe(true)
    expect(lines.some((line) => line.includes("[dual-pro] incomplete"))).toBe(true)
    const log = await import("node:fs").then((fs) => fs.readFileSync(join(getMemoryDir(), "ab-pro.jsonl"), "utf8"))
    expect(log).toContain(printed.startsWith("timed out") ? "timed out after" : printed)
    if ("stderrTail" in result && result.stderrTail) expect(log).toContain("refused")
  })
})

describe("configured harness launcher boundary", () => {
  it("delegates the capped request and supplied environment to the configured module", async () => {
    const env = { PATH: "/fixture/bin", REQUEST: "explicit" }
    const outcome = await runHarnessLeg(
      {
        launcher,
        leg: { provider: "codex", model: "test-model", profile: "test-account" },
        account: "test-account",
        question: "test question",
        timeoutMs: 900_000,
      },
      env,
    )
    expect(harnessLegLaunch).toHaveBeenCalledWith({
      harness: "codex",
      account: "test-account",
      model: "test-model",
      prompt: "test question",
      env,
    })
    expect(nativeRunnerFactory).toHaveBeenCalledWith(300_000, { stdout: "full" })
    expect(outcome).toMatchObject({ ok: true, content: "harness opinion", timeoutMs: 300_000 })
  })

  it("stores stdout full as the assistant text, not a json wrapper", async () => {
    // claude -p without --output-format json writes the assistant message as process stdout.
    // agCodeRunner stdout full returns that string. content is the trim of it.
    nativeRunner.mockResolvedValueOnce({
      exitCode: 0,
      timedOut: false,
      ms: 5,
      stdout: "\nThe answer is 4.\n",
    })
    const outcome = await runHarnessLeg(
      {
        launcher,
        leg: { provider: "claude-code", model: "fable" },
        account: "fake-claude-acct",
        question: "what is 2+2",
        timeoutMs: 30_000,
      },
      { PATH: "/fixture/bin" },
    )
    expect(outcome).toMatchObject({ ok: true, content: "The answer is 4." })
    expect(outcome.content?.startsWith("{")).toBe(false)
  })

  it.each([
    undefined,
    "",
    "   ",
    "node:path",
    new URL("./fixtures/incomplete-harness-launcher.ts", import.meta.url).href,
    "missing-launcher-for-test",
  ])("keeps an unusable launcher as an incomplete leg (%s)", async (specifier) => {
    writeConfig({ ...HARNESS_CONFIG, harnessLauncher: specifier })
    const cfg = await loadConfig()
    expect(cfg.harnessLegs).toEqual(HARNESS_CONFIG.harnessLegs)
    const outcome = await runHarnessLeg({
      launcher: cfg.harnessLauncher,
      leg: { provider: "claude-code", model: "fable" },
      account: "test",
      question: "ping",
      timeoutMs: 1,
    })
    expect(outcome).toMatchObject({ ok: false, argv: [], notes: [], timeoutMs: 1 })
    expect(outcome.error).toContain("harnessLauncher")
    expect(outcome.error).toContain(join(getMemoryDir(), "dual-pro-config.json"))
    expect(outcome.error).toContain("claude-code fable")
    expect(outcome.error).toContain("set harnessLauncher to a module exporting harnessLegLaunch and agCodeRunner")
    expect(nativeRunner).not.toHaveBeenCalled()
  })
})
