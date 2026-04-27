import { describe, expect, test } from "vitest"
import { rankHits, scoreHit } from "../src/relevance.ts"
import type { RecallHit } from "../src/types.ts"

function hit(overrides: Partial<RecallHit>): RecallHit {
  return {
    id: "h1",
    source: "bearly",
    title: "test hit",
    snippet: "snippet body",
    ts: new Date().toISOString(),
    rank: 1,
    ...overrides,
  }
}

describe("scoreHit", () => {
  test("score is in [0, 1] range", () => {
    const s = scoreHit(hit({ rank: 0 }), { windowEntities: ["a"], threshold: 0 })
    expect(s.score).toBeGreaterThanOrEqual(0)
    expect(s.score).toBeLessThanOrEqual(1)
  })

  test("higher entity overlap → higher score", () => {
    const h = hit({ snippet: "test foo.ts and bar.ts and baz.ts" })
    const low = scoreHit(h, { windowEntities: ["nothing"], threshold: 0 })
    const high = scoreHit(h, { windowEntities: ["foo.ts", "bar.ts"], threshold: 0 })
    expect(high.score).toBeGreaterThan(low.score)
  })

  test("recency dominates when other components tie", () => {
    const recent = hit({ id: "r", ts: new Date().toISOString() })
    const old = hit({ id: "o", ts: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString() })
    const r = scoreHit(recent, { windowEntities: [], threshold: 0 })
    const o = scoreHit(old, { windowEntities: [], threshold: 0 })
    expect(r.score).toBeGreaterThan(o.score)
  })

  test("rank 0 produces a neutral 0.5 component, not 1.0", () => {
    const s = scoreHit(hit({ rank: 0 }), { windowEntities: [], threshold: 0 })
    expect(s.components.rank).toBe(0.5)
  })

  test("better (lower-magnitude) FTS rank → higher rank component", () => {
    const a = scoreHit(hit({ rank: 1 }), { windowEntities: [], threshold: 0 })
    const b = scoreHit(hit({ rank: 100 }), { windowEntities: [], threshold: 0 })
    expect(a.components.rank).toBeGreaterThan(b.components.rank)
  })

  test("reinforcement lookup contributes when supplied", () => {
    const lookup = (id: string) => (id === "h1" ? 1 : 0)
    const with_ = scoreHit(hit({ id: "h1" }), { windowEntities: [], threshold: 0, reinforcement: lookup })
    const without = scoreHit(hit({ id: "h2" }), { windowEntities: [], threshold: 0, reinforcement: lookup })
    expect(with_.score).toBeGreaterThan(without.score)
  })
})

describe("rankHits", () => {
  test("filters hits below threshold", () => {
    const hits = [hit({ id: "a" }), hit({ id: "b" }), hit({ id: "c" })]
    const r = rankHits(hits, { windowEntities: [], threshold: 0.99 })
    expect(r.length).toBe(0)
  })

  test("sorts surviving hits by score descending", () => {
    const hits = [
      hit({ id: "old", ts: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() }),
      hit({ id: "new", ts: new Date().toISOString() }),
    ]
    const r = rankHits(hits, { windowEntities: [], threshold: 0 })
    expect(r[0]?.id).toBe("new")
  })
})
