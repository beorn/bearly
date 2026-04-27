/**
 * `bun llm pro --diagnostics` — speed / failure-rate / cost-distribution
 * surface from ab-pro.jsonl. Display-only signals that the quality-first
 * leaderboard intentionally hides (km-bearly.llm-refactor Phase 1D).
 *
 * Tests cover both the pure `buildDiagnostics` aggregator and the CLI
 * front-door (empty file hint, JSON envelope shape).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildDiagnostics } from "../src/lib/dispatch"
import type { AbProEntry, AbProLegEntry } from "../src/lib/dual-pro"

interface CapturedIo {
  stderr: string[]
  stdout: string[]
}

let homeDir: string
let prevHome: string | undefined
let prevProjectDir: string | undefined
let io: CapturedIo

function captureIo(): CapturedIo {
  const stderr: string[] = []
  const stdout: string[] = []
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`__exit_${code ?? 0}`)
  }) as unknown as () => never)
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "))
  })
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(" "))
  })
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  }) as unknown as () => boolean)
  return { stderr, stdout }
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

/** Build N synthetic v2 entries where leg `a` has the given (model, ok, cost, durationMs). */
function makeEntries(
  count: number,
  legA: { model: string; ok: boolean; cost?: number; durationMs?: number },
  legB?: { model: string; ok: boolean; cost?: number; durationMs?: number },
): object[] {
  const out: object[] = []
  for (let i = 0; i < count; i++) {
    const e: { schema: string; question: string; a: AbProLegEntry; b?: AbProLegEntry } = {
      schema: "ab-pro/v2",
      question: `q${i}`,
      a: legA,
    }
    if (legB) e.b = legB
    out.push(e)
  }
  return out
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "diagnostics-"))
  prevHome = process.env.HOME
  prevProjectDir = process.env.CLAUDE_PROJECT_DIR
  process.env.HOME = homeDir
  process.env.CLAUDE_PROJECT_DIR = "/tmp/diagnostics-test"
  process.env.CLAUDE_SESSION_ID = "diagsess"
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

describe("buildDiagnostics — pure aggregator", () => {
  it("returns empty rows when given no entries", () => {
    const r = buildDiagnostics([])
    expect(r.status).toBe("ok")
    expect(r.speed).toEqual([])
    expect(r.failureRate).toEqual([])
    expect(r.costDist).toEqual([])
  })

  it("computes speed avg/p50/p95 over successful calls only", () => {
    // 6 success durations 1..6 sec for 'fast', plus 1 failure (no duration).
    const entries: AbProEntry[] = []
    for (let i = 1; i <= 6; i++) {
      entries.push({ a: { model: "fast", ok: true, durationMs: i * 1000 } })
    }
    entries.push({ a: { model: "fast", ok: false } })
    const r = buildDiagnostics(entries)
    expect(r.speed).toHaveLength(1)
    expect(r.speed[0]!.model).toBe("fast")
    expect(r.speed[0]!.calls).toBe(6)
    // avg of 1..6 = 3.5s
    expect(r.speed[0]!.avgMs).toBeCloseTo(3500, 0)
    // p50 over [1000..6000] = 3500 (linear interp between 3000 and 4000)
    expect(r.speed[0]!.p50Ms).toBeCloseTo(3500, 0)
    expect(r.speed[0]!.p95Ms).toBeGreaterThan(5000)
  })

  it("skips models below the speed threshold (calls < 5)", () => {
    const entries: AbProEntry[] = []
    for (let i = 0; i < 4; i++) {
      entries.push({ a: { model: "low-volume", ok: true, durationMs: 1000 } })
    }
    const r = buildDiagnostics(entries)
    expect(r.speed.find((x) => x.model === "low-volume")).toBeUndefined()
  })

  it("flags failure rate > 30% when calls >= 20, otherwise no warn", () => {
    // 10 success + 10 failure = 50% over 20 calls → warn.
    const flaky: AbProEntry[] = []
    for (let i = 0; i < 10; i++) flaky.push({ a: { model: "flaky", ok: true } })
    for (let i = 0; i < 10; i++) flaky.push({ a: { model: "flaky", ok: false } })
    // Same ratio but only 4 calls total — should NOT warn.
    for (let i = 0; i < 2; i++) flaky.push({ a: { model: "small-sample", ok: true } })
    for (let i = 0; i < 2; i++) flaky.push({ a: { model: "small-sample", ok: false } })

    const r = buildDiagnostics(flaky)
    const flakyRow = r.failureRate.find((x) => x.model === "flaky")
    const smallRow = r.failureRate.find((x) => x.model === "small-sample")
    expect(flakyRow?.failureRate).toBeCloseTo(0.5, 5)
    expect(flakyRow?.warn).toBe(true)
    expect(smallRow?.failureRate).toBeCloseTo(0.5, 5)
    expect(smallRow?.warn).toBe(false)
  })

  it("orders failureRate descending and surfaces the worst offender first", () => {
    const entries: AbProEntry[] = []
    for (let i = 0; i < 25; i++) entries.push({ a: { model: "good", ok: true } })
    for (let i = 0; i < 5; i++) entries.push({ a: { model: "good", ok: false } })
    for (let i = 0; i < 10; i++) entries.push({ a: { model: "bad", ok: true } })
    for (let i = 0; i < 15; i++) entries.push({ a: { model: "bad", ok: false } })
    const r = buildDiagnostics(entries)
    expect(r.failureRate[0]!.model).toBe("bad")
    expect(r.failureRate[0]!.warn).toBe(true)
  })

  it("computes cost distribution at the ≥10-call threshold and skips below", () => {
    const entries: AbProEntry[] = []
    // 12 successful cost entries for 'pricey'.
    for (let i = 1; i <= 12; i++) {
      entries.push({ a: { model: "pricey", ok: true, cost: i * 0.1 } })
    }
    // Only 5 successful cost entries for 'tooFew'.
    for (let i = 1; i <= 5; i++) {
      entries.push({ a: { model: "tooFew", ok: true, cost: 0.05 } })
    }
    const r = buildDiagnostics(entries)
    const pricey = r.costDist.find((x) => x.model === "pricey")
    expect(pricey).toBeDefined()
    expect(pricey!.calls).toBe(12)
    // avg of 0.1..1.2 step 0.1 = 0.65
    expect(pricey!.avgUsd).toBeCloseTo(0.65, 5)
    expect(pricey!.p99Usd).toBeGreaterThan(pricey!.p95Usd)
    expect(pricey!.p95Usd).toBeGreaterThan(pricey!.p50Usd)
    expect(r.costDist.find((x) => x.model === "tooFew")).toBeUndefined()
  })

  it("aggregates legs a/b/c independently per model", () => {
    const entries: AbProEntry[] = []
    for (let i = 0; i < 5; i++) {
      entries.push({
        a: { model: "alpha", ok: true, durationMs: 1000, cost: 0.1 },
        b: { model: "beta", ok: true, durationMs: 2000, cost: 0.2 },
        c: { model: "alpha", ok: true, durationMs: 1500, cost: 0.15 },
      })
    }
    const r = buildDiagnostics(entries)
    const alpha = r.speed.find((x) => x.model === "alpha")
    const beta = r.speed.find((x) => x.model === "beta")
    expect(alpha?.calls).toBe(10) // a + c
    expect(beta?.calls).toBe(5)
  })
})

describe("bun llm pro --diagnostics — CLI", () => {
  it("prints a friendly hint when ab-pro.jsonl is missing", async () => {
    await runCli(["pro", "--diagnostics"])
    expect(io.stderr.join("\n")).toMatch(/No ab-pro\.jsonl entries yet/)
  })

  it("emits an empty JSON envelope with --json when there's no data", async () => {
    await runCli(["pro", "--diagnostics", "--json"])
    expect(io.stdout).toHaveLength(1)
    const env = JSON.parse(io.stdout[0]!) as {
      status: string
      speed: unknown[]
      failureRate: unknown[]
      costDist: unknown[]
    }
    expect(env.status).toBe("empty")
    expect(env.speed).toEqual([])
    expect(env.failureRate).toEqual([])
    expect(env.costDist).toEqual([])
  })

  it("emits a structured envelope with all three sections when entries exist", async () => {
    // 10 successful pricey calls so cost-dist has rows; 6 fast → speed has rows;
    // 25 calls of 'flaky' (warn).
    const entries: object[] = []
    entries.push(...makeEntries(10, { model: "pricey", ok: true, cost: 0.5, durationMs: 9000 }))
    entries.push(...makeEntries(6, { model: "fast", ok: true, cost: 0.05, durationMs: 1500 }))
    for (let i = 0; i < 17; i++) entries.push({ a: { model: "flaky", ok: true } })
    for (let i = 0; i < 8; i++) entries.push({ a: { model: "flaky", ok: false } })
    seedAbPro(homeDir, entries)

    await runCli(["pro", "--diagnostics", "--json"])
    expect(io.stdout).toHaveLength(1)
    const env = JSON.parse(io.stdout[0]!) as {
      status: string
      speed: { model: string; calls: number; avgMs: number; p50Ms: number; p95Ms: number }[]
      failureRate: { model: string; calls: number; failureRate: number; warn: boolean }[]
      costDist: { model: string; calls: number; avgUsd: number; p50Usd: number; p95Usd: number; p99Usd: number }[]
    }
    expect(env.status).toBe("ok")
    expect(env.speed.find((r) => r.model === "pricey")).toBeDefined()
    expect(env.speed.find((r) => r.model === "fast")).toBeDefined()
    expect(env.costDist.find((r) => r.model === "pricey")).toBeDefined()
    const flakyRow = env.failureRate.find((r) => r.model === "flaky")
    expect(flakyRow).toBeDefined()
    expect(flakyRow!.warn).toBe(true)
    expect(flakyRow!.failureRate).toBeCloseTo(8 / 25, 5)
  })

  it("prints three plain-text sections (Speed / Failure rate / Cost distribution)", async () => {
    const entries: object[] = []
    entries.push(...makeEntries(12, { model: "pricey", ok: true, cost: 0.5, durationMs: 9000 }))
    seedAbPro(homeDir, entries)

    await runCli(["pro", "--diagnostics"])
    const all = io.stderr.join("\n")
    expect(all).toMatch(/Diagnostics/)
    expect(all).toMatch(/Speed/)
    expect(all).toMatch(/Failure rate/)
    expect(all).toMatch(/Cost distribution/)
    expect(all).toMatch(/pricey/)
  })
})
