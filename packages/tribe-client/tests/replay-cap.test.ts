// Tests the connection-time drain replay cap — km @km/tribe/19442.
//
// The adapter's drainDaemonInbox used to forward EVERY drained event as a
// <channel> envelope (tribe.fetch limit:500 looped until empty), flooding agent
// context on connect. selectReplayEvents is the pure policy that bounds what gets
// surfaced: max 100 events, drop anything older than 1 day. This is the real
// drain-path test (the policy), complementing the instruction-string grep guard.
import { describe, expect, it } from "vitest"
import { MAX_REPLAY_AGE_MS, MAX_REPLAY_EVENTS, selectReplayEvents } from "../src/lib/replay-cap.ts"

// Fixed clock — no Date.now() so the test is deterministic.
const NOW = Date.UTC(2026, 4, 30, 12, 0, 0)
const isoAgo = (msAgo: number) => new Date(NOW - msAgo).toISOString()

describe("selectReplayEvents (km 19442 connection-time replay cap)", () => {
  it("forwards recent events untouched when under both caps", () => {
    const events = [
      { id: "a", ts: isoAgo(1_000) },
      { id: "b", ts: isoAgo(2_000) },
    ]
    const r = selectReplayEvents(events, { now: NOW })
    expect(r.forward.map((e) => e.id)).toEqual(["a", "b"])
    expect(r.skippedOld).toBe(0)
    expect(r.capped).toBe(0)
  })

  it("drops events older than the age cap (default 1 day)", () => {
    const events = [
      { id: "fresh", ts: isoAgo(0) },
      { id: "stale", ts: isoAgo(MAX_REPLAY_AGE_MS + 60_000) }, // > 1d old
      { id: "just-in", ts: isoAgo(MAX_REPLAY_AGE_MS - 60_000) }, // < 1d old
    ]
    const r = selectReplayEvents(events, { now: NOW })
    expect(r.forward.map((e) => e.id)).toEqual(["fresh", "just-in"])
    expect(r.skippedOld).toBe(1)
    expect(r.capped).toBe(0)
  })

  it("keeps an event sitting exactly on the age cutoff (older-than is strict)", () => {
    const events = [{ id: "edge", ts: isoAgo(MAX_REPLAY_AGE_MS) }]
    const r = selectReplayEvents(events, { now: NOW })
    expect(r.forward.map((e) => e.id)).toEqual(["edge"])
    expect(r.skippedOld).toBe(0)
  })

  it("caps the number of surfaced events", () => {
    const events = Array.from({ length: MAX_REPLAY_EVENTS + 50 }, (_, i) => ({ id: String(i), ts: isoAgo(i) }))
    const r = selectReplayEvents(events, { now: NOW })
    expect(r.forward).toHaveLength(MAX_REPLAY_EVENTS)
    expect(r.capped).toBe(50)
    expect(r.skippedOld).toBe(0)
  })

  it("fails open on missing/unparseable ts — keeps the event rather than dropping it", () => {
    const events = [{ id: "no-ts" }, { id: "bad-ts", ts: "not-a-date" }]
    const r = selectReplayEvents(events, { now: NOW })
    expect(r.forward.map((e) => e.id)).toEqual(["no-ts", "bad-ts"])
    expect(r.skippedOld).toBe(0)
  })

  it("surfaces nothing for a huge all-stale backlog (the connection-flood case)", () => {
    // all strictly older than 1d (+1min so none sit exactly on the cutoff)
    const events = Array.from({ length: 500 }, (_, i) => ({
      id: String(i),
      ts: isoAgo(MAX_REPLAY_AGE_MS + 60_000 + i * 1_000),
    }))
    const r = selectReplayEvents(events, { now: NOW })
    expect(r.forward).toHaveLength(0)
    expect(r.skippedOld).toBe(500)
  })

  it("honours explicit overrides for caps", () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ id: String(i), ts: isoAgo(i) }))
    const r = selectReplayEvents(events, { now: NOW, maxEvents: 3, maxAgeMs: 60_000 })
    expect(r.forward).toHaveLength(3)
    expect(r.capped).toBe(7)
  })
})
