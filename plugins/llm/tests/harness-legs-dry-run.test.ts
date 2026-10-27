/**
 * @failure pro --dry-run omits configured harness legs, or a real run starts API legs while those rows are set.
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
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getMemoryDir } from "../src/lib/dual-pro"
import { NO_CLAUDE_LOGIN, resolveClaudeHarnessAccount } from "../src/lib/harness-account"
import { runProDual } from "../src/cmd/pro"

const spawnMock = vi.hoisted(() => vi.fn())
const nativeRunner = vi.hoisted(() =>
  vi.fn(async () => ({ exitCode: 0, timedOut: false, ms: 5, stdout: "harness opinion" })),
)
const nativeRunnerFactory = vi.hoisted(() => vi.fn(() => nativeRunner))
vi.mock("@ag/cli/native-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ag/cli/native-run")>()
  return { ...actual, agCodeRunner: nativeRunnerFactory }
})
const askMock = vi.hoisted(() => vi.fn())
const queryBackgroundMock = vi.hoisted(() => vi.fn())
const costMock = vi.hoisted(() => vi.fn())

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawn: spawnMock }
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
  nativeRunner.mockReset()
  nativeRunnerFactory.mockReset()
  nativeRunner.mockResolvedValue({ exitCode: 0, timedOut: false, ms: 5, stdout: "harness opinion" })
  nativeRunnerFactory.mockImplementation(() => nativeRunner)
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
    writeConfig(HARNESS_CONFIG)
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "profiles", "claude", "fake-claude-acct"))
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
    }
    expect(spawnMock).not.toHaveBeenCalled()
    expect(nativeRunner).toHaveBeenCalled()
    const factoryCalls = nativeRunnerFactory.mock.calls as unknown as unknown[][]
    for (const call of factoryCalls) {
      expect(call[0] as number).toBeLessThanOrEqual(300_000)
      expect(call[1]).toEqual({ stdout: "full" })
    }
    const argvs = (nativeRunner.mock.calls as unknown as unknown[][]).map((call) => call[0] as string[])
    const claude = argvs.find((argv) => argv.includes("--harness=claude"))
    const codex = argvs.find((argv) => argv.includes("--harness=codex"))
    expect(claude).toEqual(
      expect.arrayContaining(["--hooks-none", "--strict-mcp-config", "--max-turns", "1", "--model", "fable"]),
    )
    expect(codex).toEqual(expect.arrayContaining(["--model", "gpt-6-astra", "--skip-git-repo-check"]))
    expect(codex).not.toContain("--hooks-none")
    expect(codex).not.toContain("--max-turns")
    const log = await import("node:fs").then((fs) => fs.readFileSync(join(getMemoryDir(), "ab-pro.jsonl"), "utf8"))
    expect(log).toContain('"provider":"harness"')
    expect(log).toContain('"account":"fake-claude-acct"')
    expect(log).toContain('"account":"codex-login-name"')
    expect(log).toContain("codex has no turn cap")
    const report = await import("node:fs").then((fs) => fs.readFileSync(join(root, "never-written.txt"), "utf8"))
    expect(report).toContain("## Harness legs")
    expect(report).toContain("fake-claude-acct")
    expect(report).toContain("codex-login-name")
  })

  it.each([
    ["over-cap", { exitCode: 0, timedOut: false, ms: 1, stdoutOverCap: true, stdout: "A" }, "stdout exceeded 1 MiB"],
    ["timeout", { exitCode: null, timedOut: true, ms: 1 }, "timed out after"],
    ["nonzero exit", { exitCode: 2, timedOut: false, ms: 1, stdout: "nope", stderrTail: "line-a\nrefused" }, "exit 2"],
    ["empty stdout", { exitCode: 0, timedOut: false, ms: 1, stdout: "  " }, "empty stdout"],
    ["spawn error", { exitCode: null, timedOut: false, ms: 0, spawnError: "ENOENT" }, "spawn failed: ENOENT"],
  ] as const)("records an incomplete harness leg on %s", async (_name, result, printed) => {
    writeConfig({ harnessLegs: [{ provider: "claude-code", model: "fable" }] })
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "profiles", "claude", "fake-claude-acct"))
    nativeRunner.mockResolvedValue(result as never)
    const lines: string[] = []
    const stderr = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map((part) => String(part)).join(" "))
    })
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
    expect(lines.some((line) => line.includes(printed) && line.includes("incomplete"))).toBe(true)
    const log = await import("node:fs").then((fs) => fs.readFileSync(join(getMemoryDir(), "ab-pro.jsonl"), "utf8"))
    expect(log).toContain(printed.startsWith("timed out") ? "timed out after" : printed)
    if ("stderrTail" in result && result.stderrTail) expect(log).toContain("refused")
  })
})
