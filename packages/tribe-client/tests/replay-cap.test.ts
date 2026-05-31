// Tests the connection-time drain replay cap — km @km/tribe/19442.
//
// The adapter's drainDaemonInbox used to forward EVERY drained event as a
// <channel> envelope (tribe.fetch limit:500 looped until empty), flooding agent
// context on connect. selectReplayEvents is the pure policy that bounds what gets
// surfaced: max 100 events, drop anything older than 1 day. This is the real
// drain-path test (the policy), complementing the instruction-string grep guard.
import { describe, expect, it } from "vitest"
import {
  CONNECT_REPLAY_WINDOW_MS,
  createConnectReplayGate,
  MAX_REPLAY_AGE_MS,
  MAX_REPLAY_EVENTS,
  selectReplayEvents,
} from "../src/lib/replay-cap.ts"

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

// The OTHER flood path (km 19442 reopen): a stale daemon that still pushes message
// BODIES as `channel` notifications bypasses the drain cap above. createConnectReplayGate
// bounds that per-(re)connect burst. Deterministic — `now` is passed, never read.
describe("createConnectReplayGate (km 19442 channel-push connect-burst cap)", () => {
  const T0 = 1_000_000

  it("forwards freely before any connect (steady state from start)", () => {
    const gate = createConnectReplayGate({ maxEvents: 3 })
    for (let i = 0; i < 50; i++) expect(gate.admit(T0 + i)).toBe(true)
    expect(gate.dropped).toBe(0)
  })

  it("bounds the post-connect burst to maxEvents, dropping the rest", () => {
    const gate = createConnectReplayGate({ maxEvents: 3, windowMs: 5_000 })
    gate.reset(T0)
    const verdicts = Array.from({ length: 10 }, (_, i) => gate.admit(T0 + i)) // all within window
    expect(verdicts.filter(Boolean)).toHaveLength(3)
    expect(gate.dropped).toBe(7)
  })

  it("forwards freely again once the window elapses (live messages are never withheld)", () => {
    const gate = createConnectReplayGate({ maxEvents: 2, windowMs: 5_000 })
    gate.reset(T0)
    expect(gate.admit(T0)).toBe(true)
    expect(gate.admit(T0 + 1)).toBe(true)
    expect(gate.admit(T0 + 2)).toBe(false) // over cap, still in window
    expect(gate.admit(T0 + 5_000)).toBe(true) // window elapsed → steady state
    expect(gate.admit(T0 + 6_000)).toBe(true)
  })

  it("reset reopens the window so a reconnect burst is rebounded", () => {
    const gate = createConnectReplayGate({ maxEvents: 2, windowMs: 5_000 })
    gate.reset(T0)
    gate.admit(T0)
    gate.admit(T0 + 1)
    gate.admit(T0 + 2) // 2 forwarded, 1 dropped
    expect(gate.dropped).toBe(1)
    gate.reset(T0 + 100_000) // reconnect much later
    expect(gate.dropped).toBe(0) // counters reset
    expect(gate.admit(T0 + 100_000)).toBe(true)
    expect(gate.admit(T0 + 100_001)).toBe(true)
    expect(gate.admit(T0 + 100_002)).toBe(false)
    expect(gate.dropped).toBe(1)
  })

  it("defaults to MAX_REPLAY_EVENTS over the connect window", () => {
    const gate = createConnectReplayGate()
    gate.reset(T0)
    const verdicts = Array.from({ length: MAX_REPLAY_EVENTS + 25 }, (_, i) => gate.admit(T0 + i))
    expect(verdicts.filter(Boolean)).toHaveLength(MAX_REPLAY_EVENTS)
    expect(gate.dropped).toBe(25)
    expect(gate.admit(T0 + CONNECT_REPLAY_WINDOW_MS)).toBe(true) // past window → steady state
  })
})
