/**
 * @i/1-instruments/24546 — the failure-rate warning reads the fleet, not one
 * directory, and it fires on the shape the real corpus actually has.
 *
 * The rule itself (>30% over ≥20 calls) is untouched by this bead and is
 * already covered by tests/diagnostics.test.ts. What is proven here is the
 * three things that were wrong around it:
 *
 *   1. the read covered ONE of 106 logs, so it reported health by omission;
 *   2. the leg extractor double-counted the duplicated v1 keys and never read
 *      leg d, so both the rate and the ≥20-call evidence bar were wrong;
 *   3. the statistic was a trailing time window, which cannot catch either of
 *      the two retirements this bead exists to explain.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { legsOf } from "../src/lib/dual-pro"
import {
  FLEET_RECENT_CALLS,
  fleetFailureRows,
  listFleetLogFiles,
  readFleetFailureReport,
  readRecentCalls,
  failingMainstays,
} from "../src/lib/fleet-failure"

const DAY = 86_400_000
const NOW = Date.parse("2026-09-11T20:00:00Z")

let root: string
let projects: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fleet-failure-"))
  projects = join(root, "projects")
  mkdirSync(projects, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Write one per-project log. `calls` is a list of [model, ok] per entry leg. */
function seedLog(project: string, entries: readonly { agoDays: number; legs: Record<string, [string, boolean]> }[]) {
  const dir = join(projects, project, "memory")
  mkdirSync(dir, { recursive: true })
  const lines = entries
    // The reader relies on the file being chronological, as an append-only
    // log is. Seed it that way or the fixture is not the real shape.
    .slice()
    .sort((a, b) => b.agoDays - a.agoDays)
    .map((e) => {
      const row: Record<string, unknown> = {
        schema: "ab-pro/v3",
        timestamp: new Date(NOW - e.agoDays * DAY).toISOString(),
        question: "x".repeat(400), // entries are fat; the reader must not keep them
      }
      for (const [slot, [model, ok]] of Object.entries(e.legs)) row[slot] = { model, ok }
      return JSON.stringify(row)
    })
  writeFileSync(join(dir, "ab-pro.jsonl"), lines.join("\n") + "\n")
  return join(dir, "ab-pro.jsonl")
}

const legs = (model: string, ok: boolean) => ({ a: [model, ok] as [string, boolean] })

describe("legsOf — one definition, replacing two that disagreed", () => {
  it("ignores the duplicated v1 keys when the modern keys are present", () => {
    // This is the real v3 write: gpt/kimi are EXACT duplicates of a/b. 708 of
    // the corpus's 949 entries carry both. Counting them is a 2x inflation.
    const entry = {
      gpt: { model: "deepseek/deepseek-chat", ok: true },
      kimi: { model: "moonshotai/kimi-k2.6", ok: true },
      a: { model: "deepseek/deepseek-chat", ok: true },
      b: { model: "moonshotai/kimi-k2.6", ok: true },
    }
    expect(legsOf(entry).map((l) => l.model)).toEqual(["deepseek/deepseek-chat", "moonshotai/kimi-k2.6"])
  })

  it("reads leg d, which the diagnostics extractor never did", () => {
    const entry = { a: { model: "m-a", ok: true }, d: { model: "m-d", ok: false } }
    expect(legsOf(entry).map((l) => l.model)).toEqual(["m-a", "m-d"])
  })

  it("still reads a v1-only entry, which is the only time gpt/kimi count", () => {
    const entry = { gpt: { model: "old-a", ok: true }, kimi: { model: "old-b", ok: false } }
    expect(legsOf(entry).map((l) => l.model)).toEqual(["old-a", "old-b"])
  })

  it("returns nothing for an entry with no legs at all", () => {
    expect(legsOf({ timestamp: "2026-09-11T00:00:00Z" })).toEqual([])
  })
})

describe("the read covers the fleet, not one directory", () => {
  it("finds every per-project log", () => {
    seedLog("-hh-dev", [{ agoDays: 1, legs: legs("m", true) }])
    seedLog("-hh-dev-wt10", [{ agoDays: 1, legs: legs("m", true) }])
    seedLog("-hh", [{ agoDays: 1, legs: legs("m", true) }])
    expect(listFleetLogFiles({ env: { HOME: root }, projectsRoot: projects }).length).toBe(3)
  })

  it("WARNS on a model failing elsewhere in the fleet when THIS directory is empty", () => {
    // The reported bug, exactly: run from a fresh worktree and the old reader
    // printed "no entries yet" — health by omission. Nothing is seeded for the
    // current directory at all.
    for (const project of ["-hh-dev", "-hh-dev-wt3", "-hh"]) {
      seedLog(
        project,
        Array.from({ length: 10 }, (_, i) => ({ agoDays: i + 1, legs: legs("moonshotai/kimi-k3", false) })),
      )
    }
    const report = readFleetFailureReport({ env: { HOME: root }, projectsRoot: projects, now: NOW })
    expect(report.filesRead).toBe(3)
    expect(report.callsRead).toBe(30)
    const row = report.rows.find((r) => r.model === "moonshotai/kimi-k3")!
    expect(row.calls).toBe(30)
    expect(row.failureRate).toBe(1)
    expect(row.warn).toBe(true)
  })

  it("stays SILENT for a model under the threshold — the negative control", () => {
    seedLog(
      "-hh-dev",
      Array.from({ length: 40 }, (_, i) => ({ agoDays: i * 0.1 + 1, legs: legs("healthy", i % 5 !== 0) })),
    )
    const report = readFleetFailureReport({ env: { HOME: root }, projectsRoot: projects, now: NOW })
    const row = report.rows.find((r) => r.model === "healthy")!
    // 1 in 5 fail = 20%, under the 30% rule, over the 20-call minimum.
    expect(row.calls).toBe(FLEET_RECENT_CALLS)
    expect(row.failureRate).toBeCloseTo(0.2, 5)
    expect(row.warn).toBe(false)
  })

  it("honours an explicit memory-dir override as an override — one store, not the fleet", () => {
    seedLog("-hh-dev", [{ agoDays: 1, legs: legs("m", true) }])
    const only = join(root, "explicit")
    mkdirSync(only, { recursive: true })
    writeFileSync(join(only, "ab-pro.jsonl"), "")
    expect(listFleetLogFiles({ env: { HOME: root, LLM_DIR: only }, projectsRoot: projects })).toEqual([
      join(only, "ab-pro.jsonl"),
    ])
  })

  it("reports the population it searched even when it found nothing", () => {
    const report = readFleetFailureReport({ env: { HOME: root }, projectsRoot: projects, now: NOW })
    expect(report).toMatchObject({ filesFound: 0, filesRead: 0, callsRead: 0, rows: [] })
  })
})

describe("the tail read is bounded by the window, not by history", () => {
  it("stops at the first entry older than the cutoff", () => {
    const file = seedLog("-hh-dev", [
      { agoDays: 200, legs: legs("ancient", false) },
      { agoDays: 100, legs: legs("ancient", false) },
      { agoDays: 2, legs: legs("recent", true) },
      { agoDays: 1, legs: legs("recent", true) },
    ])
    const calls = readRecentCalls(file, NOW - 60 * DAY)
    expect(calls.map((c) => c.model)).toEqual(["recent", "recent"])
  })

  it("reassembles lines across chunk boundaries", () => {
    // A 64-byte chunk splits nearly every line. The answer must not change —
    // a faster reader that returns a different answer is not faster.
    const file = seedLog(
      "-hh-dev",
      Array.from({ length: 25 }, (_, i) => ({ agoDays: i + 1, legs: legs(`m${i % 3}`, i % 2 === 0) })),
    )
    const whole = readRecentCalls(file, NOW - 60 * DAY)
    const tiny = readRecentCalls(file, NOW - 60 * DAY, 64)
    expect(tiny).toEqual(whole)
    expect(whole.length).toBe(25)
  })

  it("skips a torn line without treating it as the window edge", () => {
    const file = seedLog("-hh-dev", [
      { agoDays: 3, legs: legs("before", true) },
      { agoDays: 1, legs: legs("after", true) },
    ])
    const raw = readFileSync(file, "utf8")
    const lines = raw.split("\n").filter(Boolean)
    writeFileSync(file, `${lines[0]}\n{"timestamp":"2026-09-\n${lines[1]}\n`)
    // The corrupt line sits BETWEEN the two good ones. If it ended the read,
    // "before" would be lost and the log would look half its size.
    expect(
      readRecentCalls(file, NOW - 60 * DAY)
        .map((c) => c.model)
        .sort(),
    ).toEqual(["after", "before"])
  })
})

describe("the statistic is a model's last N calls, not a trailing window", () => {
  it("catches a model failing NOW that a trailing window dilutes", () => {
    // kimi-k3's real shape on 2026-09-11: a long healthy history, then a wall
    // of failures. Over 14 days it reads 27.9% and stays silent; over its last
    // 30 calls it reads 100%. The dilution is the whole point.
    const entries = [
      ...Array.from({ length: 250 }, (_, i) => ({ agoDays: 13 - i * 0.04, legs: legs("k3", true) })),
      ...Array.from({ length: 30 }, (_, i) => ({ agoDays: 0.5 - i * 0.01, legs: legs("k3", false) })),
    ]
    seedLog("-hh-dev", entries)
    const report = readFleetFailureReport({ env: { HOME: root }, projectsRoot: projects, now: NOW })
    const row = report.rows.find((r) => r.model === "k3")!
    expect(row.calls).toBe(30)
    expect(row.failureRate).toBe(1)
    expect(row.warn).toBe(true)

    // And the control: the trailing-window statistic the bead first specified
    // would have stayed silent on this very fixture.
    const all = report.rows
    expect(all.length).toBe(1)
    const trailing14 = { calls: 280, fails: 30 }
    expect(trailing14.fails / trailing14.calls).toBeLessThan(0.3)
  })

  it("needs ≥20 calls before it will warn at all", () => {
    seedLog(
      "-hh-dev",
      Array.from({ length: 19 }, (_, i) => ({ agoDays: i + 1, legs: legs("thin", false) })),
    )
    const report = readFleetFailureReport({ env: { HOME: root }, projectsRoot: projects, now: NOW })
    const row = report.rows.find((r) => r.model === "thin")!
    expect(row.calls).toBe(19)
    expect(row.failureRate).toBe(1)
    expect(row.warn).toBe(false)
  })

  it("takes the newest N calls wherever in the fleet they were made", () => {
    seedLog(
      "-hh-dev",
      Array.from({ length: 30 }, (_, i) => ({ agoDays: 20 + i, legs: legs("m", true) })),
    )
    seedLog(
      "-hh-dev-wt10",
      Array.from({ length: 30 }, (_, i) => ({ agoDays: 1 + i * 0.1, legs: legs("m", false) })),
    )
    const report = readFleetFailureReport({ env: { HOME: root }, projectsRoot: projects, now: NOW })
    const row = report.rows.find((r) => r.model === "m")!
    // The 30 newest are all from the second log, and all failures. Interleaving
    // by file order rather than by time would give 50%.
    expect(row.failureRate).toBe(1)
  })
})

describe("the dispatch warning", () => {
  it("fires for a failing MAINSTAY and ignores a failing split-test leg", () => {
    seedLog("-hh-dev", [
      ...Array.from({ length: 25 }, (_, i) => ({ agoDays: i + 1, legs: legs("mainstay-dead", false) })),
      ...Array.from({ length: 25 }, (_, i) => ({
        agoDays: i + 1,
        legs: { c: ["challenger-dead", false] as [string, boolean] },
      })),
    ])
    const report = readFleetFailureReport({ env: { HOME: root }, projectsRoot: projects, now: NOW })
    // Both trip the rule…
    expect(
      report.rows
        .filter((r) => r.warn)
        .map((r) => r.model)
        .sort(),
    ).toEqual(["challenger-dead", "mainstay-dead"])
    // …but only the mainstay is news. A challenger failing is what split-
    // testing is FOR.
    expect(failingMainstays(report, ["mainstay-dead", "some-healthy-model"]).map((r) => r.model)).toEqual([
      "mainstay-dead",
    ])
  })
})

describe("fleetFailureRows — the pure reducer", () => {
  it("returns no row for a model with no calls, rather than a 0% row", () => {
    expect(fleetFailureRows([]).length).toBe(0)
  })

  it("orders the worst offender first", () => {
    const at = NOW
    const rows = fleetFailureRows([
      ...Array.from({ length: 25 }, () => ({ at, model: "bad", ok: false })),
      ...Array.from({ length: 25 }, () => ({ at, model: "ok", ok: true })),
    ])
    expect(rows.map((r) => r.model)).toEqual(["bad", "ok"])
  })
})
