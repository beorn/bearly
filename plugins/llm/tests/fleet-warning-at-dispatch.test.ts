/**
 * @i/1-instruments/24546, acceptance 2 — the warning must reach a reader in the
 * `/pro` output of a REAL dispatch, not only in `pro --diagnostics`, which
 * nobody runs.
 *
 * tests/fleet-failure-rate.test.ts proves the reader and the formatter. That is
 * not the same claim: a correct warning wired into a branch nobody takes warns
 * nobody. On 22972 a second, unexercised clamp site survived all 417 tests and
 * was found only by mutating it. So this file drives `cli.ts main()` down the
 * actual dual-pro path with the providers mocked, and asserts the line lands on
 * stderr among the other pre-dispatch facts.
 *
 * The seeded history lives in a project directory that is NOT this run's
 * CLAUDE_PROJECT_DIR, so a reader that regressed to the single-directory read
 * would find nothing and print nothing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const generateTextMock = vi.fn()
vi.mock("ai", () => ({ generateText: generateTextMock, streamText: vi.fn() }))

const MAINSTAYS = ["gpt-5.4-pro", "moonshotai/kimi-k2.6"] as const

describe("the fleet failure-rate warning at dispatch", () => {
  let homeDir: string
  let stderr: string[]
  const saved: Record<string, string | undefined> = {}

  const setEnv = (key: string, value: string) => {
    saved[key] = process.env[key]
    process.env[key] = value
  }

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "fleet-warn-"))
    stderr = []
    setEnv("HOME", homeDir)
    // The CURRENT directory's log stays empty on purpose.
    setEnv("CLAUDE_PROJECT_DIR", "/tmp/fleet-warn-current")
    setEnv("CLAUDE_SESSION_ID", "fleetwarnsess")
    setEnv("OPENAI_API_KEY", "sk-test-openai")
    setEnv("OPENROUTER_API_KEY", "sk-test-openrouter")
    setEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-google")
    setEnv("ANTHROPIC_API_KEY", "sk-test-anthropic")
    setEnv("XAI_API_KEY", "test-xai")
    setEnv("LLM_NO_HISTORY", "1")
    setEnv("LLM_NO_AUTO_PRICING", "1")

    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(" "))
    })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk))
      return true
    }) as unknown as () => boolean)

    generateTextMock.mockImplementation(async () => ({
      text: "leg answer",
      reasoning: [],
      usage: { inputTokens: 100, outputTokens: 50 },
    }))
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    vi.restoreAllMocks()
  })

  /** Seed one OTHER project's log with `count` calls for `model`. */
  function seedElsewhere(project: string, model: string, count: number, ok: boolean) {
    const dir = join(homeDir, ".claude", "projects", project, "memory")
    mkdirSync(dir, { recursive: true })
    const lines = Array.from({ length: count }, (_, i) =>
      JSON.stringify({
        schema: "ab-pro/v3",
        timestamp: new Date(Date.now() - (count - i) * 60_000).toISOString(),
        a: { model, ok },
      }),
    )
    writeFileSync(join(dir, "ab-pro.jsonl"), lines.join("\n") + "\n")
  }

  async function runPro() {
    vi.resetModules()
    process.argv = ["node", "cli.ts", "pro", "-y", "--no-judge", "--legs", "2", "what is the best storage layer?"]
    const mod = await import("../src/cli")
    try {
      await mod.main()
    } catch (e) {
      if (!/^__exit_/.test((e as Error).message)) throw e
    }
    return stderr.join("\n")
  }

  it("WARNS in the real dispatch output about a mainstay failing in ANOTHER directory", async () => {
    seedElsewhere("-hh-dev-wt3", MAINSTAYS[0], 25, false)
    const out = await runPro()

    // It reached the dispatch announcement at all — otherwise the assertion
    // below would pass vacuously on a run that never got here.
    expect(out).toMatch(/Querying \d+ legs in parallel/)
    expect(out).toMatch(/mainstay "gpt-5\.4-pro" failed 100% of its last 25 calls/)
    // The population, because a rate without a denominator is this bead's bug.
    expect(out).toMatch(/across the fleet \(1 of 1 logs/)
  })

  it("stays SILENT when the same history is healthy — the negative control", async () => {
    seedElsewhere("-hh-dev-wt3", MAINSTAYS[0], 25, true)
    const out = await runPro()
    expect(out).toMatch(/Querying \d+ legs in parallel/)
    expect(out).not.toMatch(/failed \d+% of its last/)
  })

  it("stays SILENT for a failing model that is NOT a mainstay", async () => {
    // A split-test challenger failing is what split-testing is for, and a
    // warning per challenger would train the reader to ignore the line.
    seedElsewhere("-hh-dev-wt3", "deepseek/deepseek-r1", 25, false)
    const out = await runPro()
    expect(out).toMatch(/Querying \d+ legs in parallel/)
    expect(out).not.toMatch(/mainstay "deepseek\/deepseek-r1"/)
  })

  it("stays SILENT below the 20-call minimum, however bad the rate", async () => {
    seedElsewhere("-hh-dev-wt3", MAINSTAYS[0], 19, false)
    const out = await runPro()
    expect(out).toMatch(/Querying \d+ legs in parallel/)
    expect(out).not.toMatch(/failed \d+% of its last/)
  })
})
