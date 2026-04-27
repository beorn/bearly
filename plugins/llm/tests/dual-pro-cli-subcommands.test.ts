/**
 * CLI sub-command coverage for the dual-pro shadow-test framework
 * (km-bearly.llm-dual-pro-shadow-test):
 *
 *   bun llm pro --leaderboard
 *   bun llm pro --promote-review
 *   bun llm pro --backtest --quick --no-old-fire --sample 2
 *
 * Mocks the underlying ai SDK so the CLI runs end-to-end without billing.
 * Pre-seeds ab-pro.jsonl with realistic v2 entries so the leaderboard /
 * promotion logic has data to chew on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const generateTextMock = vi.fn()
vi.mock("ai", () => ({
  generateText: generateTextMock,
  streamText: vi.fn(),
}))
vi.mock("../src/lib/openai-deep", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/openai-deep")>("../src/lib/openai-deep")
  return { ...actual, queryOpenAIBackground: vi.fn() }
})

interface CapturedIO {
  stderr: string[]
  stdout: string[]
  exitCodes: number[]
}

let homeDir: string
let prevHome: string | undefined
let prevProjectDir: string | undefined
let io: CapturedIO

function captureIo(): CapturedIO {
  const stderr: string[] = []
  const stdout: string[] = []
  const exitCodes: number[] = []
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0)
    throw new Error(`__exit_${code ?? 0}`)
  }) as unknown as () => never)
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "))
  })
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(" "))
  })
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "))
  })
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  }) as unknown as () => boolean)
  return { stderr, stdout, exitCodes }
}

function memoryDir(home: string): string {
  const projectRoot = process.env.CLAUDE_PROJECT_DIR!
  const encoded = projectRoot.replace(/\//g, "-")
  return `${home}/.claude/projects/${encoded}/memory`
}

function seedAbPro(home: string, lines: object[]) {
  const dir = memoryDir(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/ab-pro.jsonl`, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "dual-pro-cli-"))
  prevHome = process.env.HOME
  prevProjectDir = process.env.CLAUDE_PROJECT_DIR
  process.env.HOME = homeDir
  process.env.CLAUDE_PROJECT_DIR = "/tmp/cli-subcmd-test"
  process.env.CLAUDE_SESSION_ID = "subcmdsess"
  process.env.OPENAI_API_KEY = "sk-test-openai"
  process.env.OPENROUTER_API_KEY = "sk-test-openrouter"
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google"
  process.env.LLM_NO_HISTORY = "1"
  process.env.LLM_NO_AUTO_PRICING = "1"
  io = captureIo()
})

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true })
  if (prevHome !== undefined) process.env.HOME = prevHome
  else delete process.env.HOME
  if (prevProjectDir !== undefined) process.env.CLAUDE_PROJECT_DIR = prevProjectDir
  else delete process.env.CLAUDE_PROJECT_DIR
  vi.restoreAllMocks()
  vi.resetModules()
})

async function runCli(args: string[]) {
  vi.resetModules()
  process.argv = ["node", "cli.ts", ...args]
  try {
    const mod = await import("../src/cli")
    await mod.main()
  } catch (e) {
    if (!/^__exit_/.test((e as Error).message)) throw e
  }
}

describe("bun llm pro --leaderboard", () => {
  it("prints a friendly hint when ab-pro.jsonl is missing", async () => {
    await runCli(["pro", "--leaderboard"])
    expect(io.stderr.join("\n")).toMatch(/No ab-pro\.jsonl entries yet/)
  })

  it("prints a ranked table when entries exist", async () => {
    seedAbPro(homeDir, [
      {
        schema: "ab-pro/v2",
        question: "q1",
        a: {
          model: "champA",
          ok: true,
          score: { scores: { specificity: 4, actionability: 4, correctness: 4, depth: 4 }, total: 16 },
          cost: 0.5,
          durationMs: 9000,
        },
        b: {
          model: "runnerB",
          ok: true,
          score: { scores: { specificity: 3, actionability: 3, correctness: 3, depth: 3 }, total: 12 },
          cost: 0.05,
          durationMs: 7000,
        },
        c: {
          model: "challC",
          ok: true,
          score: { scores: { specificity: 5, actionability: 5, correctness: 5, depth: 5 }, total: 20 },
          cost: 0.8,
          durationMs: 12000,
        },
      },
    ])
    await runCli(["pro", "--leaderboard"])
    const all = io.stderr.join("\n")
    expect(all).toMatch(/Leaderboard/)
    expect(all).toMatch(/champA/)
    expect(all).toMatch(/runnerB/)
    expect(all).toMatch(/challC/)
  })
})

describe("bun llm pro --promote-review", () => {
  it("emits 'no-action' verdict when threshold not met (skipConfirm=true)", async () => {
    seedAbPro(homeDir, [
      {
        schema: "ab-pro/v2",
        question: "q1",
        a: {
          model: "gpt-5.4-pro",
          ok: true,
          score: { scores: { specificity: 4, actionability: 4, correctness: 4, depth: 4 }, total: 16 },
          cost: 0.5,
          durationMs: 9000,
        },
      },
    ])
    await runCli(["pro", "--promote-review", "-y"])
    const stderrAll = io.stderr.join("\n")
    expect(stderrAll).toMatch(/Verdict:/)
    expect(stderrAll).toMatch(/no challenger has cleared/)
  })

  it("records a 'keep-watching' decision when -y is set and threshold met", async () => {
    // Build 12 entries where challenger consistently outscores champion.
    const entries: object[] = []
    for (let i = 0; i < 12; i++) {
      entries.push({
        schema: "ab-pro/v2",
        question: `q${i}`,
        a: {
          model: "gpt-5.4-pro",
          ok: true,
          score: { scores: { specificity: 3, actionability: 3, correctness: 3, depth: 3 }, total: 12 },
          cost: 0.5,
          durationMs: 9000,
        },
        b: {
          model: "moonshotai/kimi-k2.6",
          ok: true,
          score: { scores: { specificity: 3, actionability: 3, correctness: 3, depth: 3 }, total: 12 },
          cost: 0.05,
          durationMs: 7000,
        },
        c: {
          model: "gemini-3-pro-preview",
          ok: true,
          score: { scores: { specificity: 5, actionability: 5, correctness: 5, depth: 5 }, total: 18 },
          cost: 0.4,
          durationMs: 8000,
        },
      })
    }
    seedAbPro(homeDir, entries)
    await runCli(["pro", "--promote-review", "-y"])
    const stderrAll = io.stderr.join("\n")
    expect(stderrAll).toMatch(/Verdict:/)
    // Promotions log written
    const promPath = `${memoryDir(homeDir)}/dual-pro-promotions.jsonl`
    expect(existsSync(promPath)).toBe(true)
    const line = JSON.parse(readFileSync(promPath, "utf-8").trim()) as { decision: string; oldChampion: string }
    expect(line.decision).toBe("keep-watching")
    expect(line.oldChampion).toBe("gpt-5.4-pro")
  })
})

describe("bun llm pro --backtest", () => {
  it("emits empty status when ab-pro.jsonl has no entries", async () => {
    await runCli(["pro", "--backtest", "--quick", "--sample", "2"])
    expect(io.stderr.join("\n")).toMatch(/No ab-pro\.jsonl entries available/)
  })

  it("--quick --no-old-fire --sample 2 runs without firing OLD legs", async () => {
    seedAbPro(homeDir, [
      {
        schema: "ab-pro/v2",
        question: "what is X?",
        a: {
          model: "gpt-5.4-pro",
          ok: true,
          score: { scores: { specificity: 4, actionability: 4, correctness: 4, depth: 4 }, total: 16 },
        },
      },
      {
        schema: "ab-pro/v2",
        question: "describe Y",
        a: {
          model: "gpt-5.4-pro",
          ok: true,
          score: { scores: { specificity: 4, actionability: 4, correctness: 4, depth: 4 }, total: 16 },
        },
      },
    ])
    // generateText returns NEW responses + judge JSON. Distinguish by the
    // judge prompt's "STRICT JSON" marker.
    generateTextMock.mockImplementation(async (args: { messages?: { role: string; content: unknown }[] }) => {
      const text = (args.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ")
      if (text.includes("STRICT JSON")) {
        return {
          text: JSON.stringify({
            a: { scores: { specificity: 4, actionability: 4, correctness: 4, depth: 4 }, total: 16 },
            b: { scores: { specificity: 3, actionability: 3, correctness: 3, depth: 3 }, total: 12 },
            c: { scores: { specificity: 5, actionability: 5, correctness: 5, depth: 5 }, total: 20 },
            winner: "c",
          }),
          reasoning: [],
          usage: { inputTokens: 200, outputTokens: 80 },
        }
      }
      return {
        text: "answer text",
        reasoning: [],
        usage: { inputTokens: 100, outputTokens: 50 },
      }
    })
    await runCli(["pro", "--backtest", "--quick", "--no-old-fire", "--sample", "2", "-y"])
    const stderrAll = io.stderr.join("\n")
    expect(stderrAll).toMatch(/Backtest:/)
    expect(stderrAll).toMatch(/Sample size:/)
    // Persisted
    const runsPath = `${memoryDir(homeDir)}/backtest-runs.jsonl`
    expect(existsSync(runsPath)).toBe(true)
    const line = JSON.parse(readFileSync(runsPath, "utf-8").trim()) as {
      schema: string
      noOldFire: boolean
      quick: boolean
    }
    expect(line.schema).toBe("backtest-runs/v1")
    expect(line.noOldFire).toBe(true)
    expect(line.quick).toBe(true)
  })
})
