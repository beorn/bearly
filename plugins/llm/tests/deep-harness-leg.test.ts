/**
 * @failure /deep ignores a configured harness leg, skips its web search, or writes the answer somewhere other than the API completion file.
 * @level l1
 * @consumer a seat running /deep when Fable or Astra is a subscription login.
 * @testonly none
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeTestEnv } from "./helpers"

const LAUNCHER = `import { writeFileSync } from "node:fs"
export function harnessLegLaunch(input) {
  writeFileSync(process.env.HARNESS_LAUNCH_LOG, JSON.stringify(input))
  return { argv: ["harness-deep"], env: {}, notes: [] }
}
export function agCodeRunner() {
  return async () => {
    if (process.env.HARNESS_STUB === "fail") {
      return { exitCode: 2, timedOut: false, ms: 4, stdout: "", stderrTail: "weekly limit" }
    }
    return { exitCode: 0, timedOut: false, ms: 4, stdout: "\\nRecovered finding.\\n" }
  }
}
`

function writeConfig(dir: string, launcher: string, legs: unknown[]): void {
  writeFileSync(join(dir, "dual-pro-config.json"), JSON.stringify({ harnessLegs: legs, harnessLauncher: launcher }))
}

describe("/deep one harness leg", () => {
  let env: ReturnType<typeof makeTestEnv>
  beforeEach(() => {
    env = makeTestEnv()
  })
  const memory = mkdtempSync(join(tmpdir(), "deep-harness-"))
  const launcher = join(memory, "launcher.mjs")
  const launchLog = join(memory, "launch.json")
  writeFileSync(launcher, LAUNCHER)

  afterEach(() => {
    delete process.env.BEARLY_LLM_MEMORY_DIR
    delete process.env.HARNESS_LAUNCH_LOG
    delete process.env.HARNESS_STUB
    delete process.env.CLAUDE_CONFIG_DIR
    vi.resetModules()
  })

  async function run(opts: { dryRun: boolean; legs?: unknown[]; stub?: string }) {
    rmSync(launchLog, { force: true })
    process.env.BEARLY_LLM_MEMORY_DIR = memory
    process.env.HARNESS_LAUNCH_LOG = launchLog
    process.env.CLAUDE_CONFIG_DIR = "/tmp/profiles/claude/fake-claude-acct"
    if (opts.stub) process.env.HARNESS_STUB = opts.stub
    else delete process.env.HARNESS_STUB
    if (opts.legs) writeConfig(memory, launcher, opts.legs)
    else writeFileSync(join(memory, "dual-pro-config.json"), "{}")
    vi.resetModules()
    const { runDeep } = await import("../src/cmd/deep")
    const { getModel } = await import("../src/lib/types")
    const outputFile = join(memory, opts.dryRun ? "dry.md" : `out-${opts.stub ?? "ok"}.md`)
    const lines: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map(String).join(" "))
    })
    try {
      await runDeep({
        topic: "what changed",
        modelOverride: opts.legs ? undefined : getModel("gpt-5.4-pro"),
        streamToken: () => {},
        buildContext: async () => "prior note",
        outputFile,
        sessionTag: "deep-harness",
        skipRecover: true,
        skipConfirm: true,
        dryRun: opts.dryRun,
      })
    } finally {
      spy.mockRestore()
    }
    return { outputFile, stderr: lines.join("\n") }
  }

  it("keeps the API dry-run when no harness leg is configured", async () => {
    const { stderr } = await run({ dryRun: true })
    expect(stderr).toContain("Dry run - would call deep research API")
    expect(stderr).not.toContain("would run one harness leg")
    expect(env.stdout).toEqual([])
  })

  it("dry-run names the one leg and web search, and does not launch", async () => {
    const { stderr: text } = await run({
      dryRun: true,
      legs: [
        { provider: "claude-code", model: "fable" },
        { provider: "codex", model: "gpt-6-astra", profile: "astra-login" },
      ],
    })
    expect(text).toContain("Harness leg: claude-code fable (account fake-claude-acct)")
    expect(text).toContain("1 more configured harness legs are not run")
    expect(text).toContain("Web search: on")
    expect(text).toContain("subscription, not an API charge")
    expect(text).toContain("would run one harness leg with web search")
    expect(text).not.toContain("would call deep research API")
    expect(() => readFileSync(launchLog, "utf8")).toThrow()
    expect(env.stdout).toEqual([])
  })

  it("writes the harness answer through the API completion file", async () => {
    const { outputFile } = await run({
      dryRun: false,
      stub: "ok",
      legs: [{ provider: "claude-code", model: "fable" }],
    })
    const launch = JSON.parse(readFileSync(launchLog, "utf8")) as { webSearch?: boolean; prompt?: string }
    expect(launch.webSearch).toBe(true)
    expect(launch.prompt).toContain("what changed")
    expect(launch.prompt).toContain("prior note")
    const saved = readFileSync(outputFile, "utf8")
    expect(saved).toContain("Recovered finding.")
    expect(saved).toContain("account fake-claude-acct")
    expect(env.stdout).toHaveLength(1)
    expect(JSON.parse(env.stdout[0]!)).toMatchObject({ status: "completed", file: "out-ok.md" })
  })

  it("an incomplete leg names the account in the same error file", async () => {
    const outputFile = await run({
      dryRun: false,
      stub: "fail",
      legs: [{ provider: "codex", model: "gpt-6-astra", profile: "astra-login" }],
    }).then(
      () => {
        throw new Error("incomplete harness leg returned instead of failing the run")
      },
      (error: Error) => {
        expect(error.message).toMatch(/exit/i)
        return join(memory, "out-fail.md")
      },
    )
    const launch = JSON.parse(readFileSync(launchLog, "utf8")) as { webSearch?: boolean; harness?: string }
    expect(launch.webSearch).toBe(true)
    expect(launch.harness).toBe("codex")
    const saved = readFileSync(outputFile, "utf8")
    expect(saved).toContain("astra-login")
    expect(saved).toContain("incomplete")
    expect(env.stdout).toHaveLength(1)
    expect(JSON.parse(env.stdout[0]!)).toMatchObject({ status: "failed", code: "provider_error", file: "out-fail.md" })
  })
})
