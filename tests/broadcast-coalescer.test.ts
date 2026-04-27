/**
 * Broadcast coalescer — unit tests.
 *
 * These tests exercise the pure factory in isolation (no daemon, no sockets,
 * no DB). Fake timers let us assert flush-on-window-expiry without racing
 * real setTimeout.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import { createCoalescer, type Coalescer, type PendingBroadcast } from "../tools/lib/tribe/broadcast-coalescer.ts"

function makeEv(i: number, overrides: Partial<PendingBroadcast> = {}): PendingBroadcast {
  return {
    id: `msg-${i}`,
    ts: 1_700_000_000 + i,
    rowid: i,
    type: "status",
    sender: `sender-${i % 3}`,
    content: `event ${i}`,
    bead_id: null,
    responseExpected: "optional",
    pluginKind: null,
    ...overrides,
  }
}

type Captured = { connId: string; payload: string }

// Coalescer payload shape (what `singleEvent` / `batched` produce in tests).
type Parsed = {
  kind: "single" | "batch"
  id?: string
  content?: string
  count?: number
  ids?: string[]
  dropped?: number
}

function parsePayload(s: string): Parsed {
  return JSON.parse(s) as Parsed
}

function makeHarness(batchMs: number, maxEventsPerBatch = 50, writeOk = true) {
  const writes: Captured[] = []
  const delivered: { connId: string; id: string }[] = []
  const c = createCoalescer({
    batchMs,
    maxEventsPerBatch,
    deps: {
      singleEvent: (ev) => JSON.stringify({ kind: "single", id: ev.id, content: ev.content }),
      batched: (events, dropped) =>
        JSON.stringify({
          kind: "batch",
          count: events.length + dropped,
          ids: events.map((e) => e.id),
          dropped,
        }),
      write: (connId, payload) => {
        if (!writeOk) return false
        writes.push({ connId, payload })
        return true
      },
      onDelivered: (connId, ev) => {
        delivered.push({ connId, id: ev.id })
      },
    },
  })
  return { coalescer: c, writes, delivered }
}

describe("broadcast coalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("single event flushes as single-shape notification", () => {
    const { coalescer, writes, delivered } = makeHarness(400)
    coalescer.enqueue("conn-1", makeEv(1))
    expect(writes).toHaveLength(0)
    vi.advanceTimersByTime(400)
    expect(writes).toHaveLength(1)
    const parsed = parsePayload(writes[0]!.payload)
    expect(parsed.kind).toBe("single")
    expect(parsed.id).toBe("msg-1")
    expect(delivered).toEqual([{ connId: "conn-1", id: "msg-1" }])
  })

  it("N>1 events within window flush as ONE batched notification", () => {
    const { coalescer, writes, delivered } = makeHarness(400)
    coalescer.enqueue("conn-1", makeEv(1))
    coalescer.enqueue("conn-1", makeEv(2))
    coalescer.enqueue("conn-1", makeEv(3))
    expect(writes).toHaveLength(0)
    vi.advanceTimersByTime(400)
    expect(writes).toHaveLength(1)
    const parsed = parsePayload(writes[0]!.payload)
    expect(parsed.kind).toBe("batch")
    expect(parsed.count).toBe(3)
    expect(parsed.ids).toEqual(["msg-1", "msg-2", "msg-3"])
    expect(parsed.dropped).toBe(0)
    expect(delivered.map((d) => d.id)).toEqual(["msg-1", "msg-2", "msg-3"])
  })

  it("per-connection isolation — enqueues on conn-A don't flush with conn-B", () => {
    const { coalescer, writes } = makeHarness(400)
    coalescer.enqueue("conn-A", makeEv(1))
    coalescer.enqueue("conn-B", makeEv(2))
    coalescer.enqueue("conn-A", makeEv(3))
    vi.advanceTimersByTime(400)
    expect(writes).toHaveLength(2)
    const byConn: Record<string, Parsed> = Object.fromEntries(writes.map((w) => [w.connId, parsePayload(w.payload)]))
    expect(byConn["conn-A"]!.kind).toBe("batch")
    expect(byConn["conn-A"]!.ids).toEqual(["msg-1", "msg-3"])
    expect(byConn["conn-B"]!.kind).toBe("single")
    expect(byConn["conn-B"]!.id).toBe("msg-2")
  })

  it("batchMs=0 disables coalescing — enqueue writes through immediately", () => {
    const { coalescer, writes, delivered } = makeHarness(0)
    coalescer.enqueue("conn-1", makeEv(1))
    coalescer.enqueue("conn-1", makeEv(2))
    expect(writes).toHaveLength(2)
    expect(writes.every((w) => parsePayload(w.payload).kind === "single")).toBe(true)
    expect(delivered).toHaveLength(2)
    // No pending timer state when disabled.
    expect(coalescer.pendingCount("conn-1")).toBe(0)
  })

  it("events beyond maxEventsPerBatch are truncated with a dropped count", () => {
    const { coalescer, writes } = makeHarness(400, 3)
    for (let i = 1; i <= 7; i++) coalescer.enqueue("conn-1", makeEv(i))
    vi.advanceTimersByTime(400)
    expect(writes).toHaveLength(1)
    const parsed = parsePayload(writes[0]!.payload)
    expect(parsed.kind).toBe("batch")
    expect(parsed.count).toBe(7) // total reported
    expect(parsed.ids).toHaveLength(3) // first 3 kept
    expect(parsed.dropped).toBe(4)
  })

  it("flush(connId) drains the queue synchronously without waiting for window", () => {
    const { coalescer, writes } = makeHarness(10_000)
    coalescer.enqueue("conn-1", makeEv(1))
    coalescer.enqueue("conn-1", makeEv(2))
    expect(writes).toHaveLength(0)
    coalescer.flush("conn-1")
    expect(writes).toHaveLength(1)
    expect(parsePayload(writes[0]!.payload).ids).toEqual(["msg-1", "msg-2"])
  })

  it("discard(connId) clears the queue without writing — covers abandoned clients", () => {
    const { coalescer, writes } = makeHarness(400)
    coalescer.enqueue("conn-1", makeEv(1))
    coalescer.enqueue("conn-1", makeEv(2))
    expect(coalescer.pendingCount("conn-1")).toBe(2)
    coalescer.discard("conn-1")
    vi.advanceTimersByTime(10_000)
    expect(writes).toHaveLength(0)
    expect(coalescer.pendingCount("conn-1")).toBe(0)
  })

  it("failed write does not advance delivery cursor — caller can retry next window", () => {
    const { coalescer, delivered } = makeHarness(400, 50, /* writeOk */ false)
    coalescer.enqueue("conn-1", makeEv(1))
    vi.advanceTimersByTime(400)
    expect(delivered).toEqual([])
  })

  it("flush is idempotent — second flush on empty queue is a noop", () => {
    const { coalescer, writes } = makeHarness(400)
    coalescer.enqueue("conn-1", makeEv(1))
    coalescer.flush("conn-1")
    coalescer.flush("conn-1")
    expect(writes).toHaveLength(1)
  })

  it("flushAll drains every queued connection in one call", () => {
    const { coalescer, writes } = makeHarness(400)
    coalescer.enqueue("conn-A", makeEv(1))
    coalescer.enqueue("conn-B", makeEv(2))
    coalescer.enqueue("conn-C", makeEv(3))
    coalescer.flushAll()
    expect(writes).toHaveLength(3)
    expect(writes.map((w) => w.connId).sort()).toEqual(["conn-A", "conn-B", "conn-C"])
  })

  it("after flush, next enqueue starts a fresh window (timer reset)", () => {
    const { coalescer, writes } = makeHarness(400)
    coalescer.enqueue("conn-1", makeEv(1))
    vi.advanceTimersByTime(400)
    expect(writes).toHaveLength(1)
    coalescer.enqueue("conn-1", makeEv(2))
    expect(writes).toHaveLength(1) // timer reset — not flushed yet
    vi.advanceTimersByTime(400)
    expect(writes).toHaveLength(2)
  })
})
