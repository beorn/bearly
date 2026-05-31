// Guards the turn-start inbox instruction against context-flood regressions.
//
// km @km/tribe/19442-turn-start-fetch-context-flood: the MCP server instructions
// told every chief/member/pull session to call `tribe.fetch({ limit: 50 })` on
// EVERY user turn. New messages already arrive inline as <channel> envelopes, so
// the 50-event window re-pulled already-seen ambient traffic each turn and burned
// long-running agent context. The fix extracts one shared `turnStartInboxCheck`
// constant (killing the 3-way drift that produced three copies of the limit) and
// caps the turn-start drain at 10.
//
// This is a grep-guard: it reads the adapter SOURCE as text and never imports the
// module (the adapter constructs an MCP Server + registers daemon handlers at load
// time, so importing it has side effects we don't want in a unit test).
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src/stdio-adapter.ts")
const src = readFileSync(SRC, "utf8")

describe("turn-start inbox instruction (km 19442 context-flood guard)", () => {
  it("defines the turn-start guidance exactly once (single source of truth)", () => {
    expect((src.match(/const turnStartInboxCheck\b/g) ?? []).length).toBe(1)
    // the literal block text exists only inside the constant, not duplicated
    expect((src.match(/Turn-start inbox check:/g) ?? []).length).toBe(1)
  })

  it("shares that one block across all three role variants (chief/member/pull)", () => {
    expect((src.match(/\$\{turnStartInboxCheck\}/g) ?? []).length).toBe(3)
  })

  it("no longer tells sessions to replay a 50-event window every turn", () => {
    expect(src).not.toContain("At the start of each user turn, call tribe.fetch({ limit: 50 })")
    expect(src).not.toMatch(/tribe\.fetch\(\{ limit: 50 \}\)/)
  })

  it("caps every turn-start fetch instruction at <= 10", () => {
    // Instruction-form fetches only: `tribe.fetch({ ... limit: N ... })`.
    // The delivery-path drain `daemon?.call("tribe.fetch", { limit: 500 })` uses a
    // different call syntax and is intentionally NOT model guidance — it must not
    // match this pattern (regression canary: if it ever did, 500 would fail here).
    const limits = [...src.matchAll(/tribe\.fetch\(\{[^}]*limit:\s*(\d+)[^}]*\}\)/g)].map((m) => Number(m[1]))
    expect(limits.length).toBeGreaterThan(0)
    expect(Math.max(...limits)).toBeLessThanOrEqual(10)
  })

  it("preserves direct-message discoverability + snapshot-filter freshness", () => {
    // The `with:` / `from:` snapshot filters stay documented so peers remain
    // discoverable, and the "newest matching" intent is spelled out.
    expect(src).toMatch(/with: <your session name>/)
    expect(src).toMatch(/from: <peer>/)
    expect(src).toMatch(/newest matching/)
  })
})
