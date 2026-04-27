import { describe, expect, test } from "vitest"
import { createBgRecallDaemon } from "../src/daemon.ts"
import type { QualityGate, RecallHit, RecallQueryResult, ToolCallEvent } from "../src/types.ts"

/** Stub quality gate — accept everything except the literal "STUCK_LOOP". */
function makeQualityGate(): QualityGate {
  return {
    isAcceptable: (text) => !text.includes("STUCK_LOOP"),
    analyze: (text) => (text.includes("STUCK_LOOP") ? { rejectReason: "stuck-loop:repeated-line" } : {}),
  }
}

function makeHit(overrides: Partial<RecallHit>): RecallHit {
  return {
    id: "h-" + Math.random().toString(36).slice(2),
    source: "bearly",
    title: "test hit",
    snippet: "this is a test snippet body",
    ts: new Date().toISOString(),
    rank: 1,
    ...overrides,
  }
}

function makeEvent(overrides: Partial<ToolCallEvent>): ToolCallEvent {
  return {
    sessionId: "s1",
    sessionName: "fixer",
    tool: "Read",
    input: "/Users/beorn/Code/pim/km/foo.ts",
    ts: Date.now(),
    ...overrides,
  }
}

describe("bg-recall daemon — end-to-end", () => {
  test("high-relevance hit fires a hint via tribeSend", async () => {
    const sent: Array<{ to: string; content: string; type: string }> = []
    const recall = async (query: string): Promise<RecallQueryResult> => ({
      source: "bearly",
      query,
      hits: [
        makeHit({
          id: "winner",
          // high-overlap snippet — contains the file path the model just read
          snippet: "earlier session worked on /Users/beorn/Code/pim/km/foo.ts and fixed the issue",
          title: "previous session: foo.ts work",
          rank: 1,
        }),
      ],
      durationMs: 5,
    })

    const daemon = createBgRecallDaemon({
      sources: { bearly: recall },
      qualityGate: makeQualityGate(),
      tribeSend: async (to, content, type) => {
        sent.push({ to, content, type })
      },
      throttle: { callsPerHint: 1, secondsPerHint: 0, maxBackoff: 1 },
      pipeline: { thresholds: { bearly: 0.1 } }, // permissive for testing
    })

    daemon.start()
    await daemon.observeToolCall(makeEvent({}))
    daemon.stop()

    expect(sent.length).toBe(1)
    expect(sent[0]!.to).toBe("fixer")
    expect(sent[0]!.type).toBe("hint")
    expect(sent[0]!.content).toContain("retrieve_memory")
    expect(sent[0]!.content).toContain("winner")
  })

  test("low-relevance hit is silently rejected (no send, decision recorded)", async () => {
    const sent: Array<unknown> = []
    const recall = async (query: string): Promise<RecallQueryResult> => ({
      source: "bearly",
      query,
      hits: [makeHit({ id: "nope", snippet: "totally unrelated content", rank: 1000 })],
      durationMs: 5,
    })

    const daemon = createBgRecallDaemon({
      sources: { bearly: recall },
      qualityGate: makeQualityGate(),
      tribeSend: async (to, content) => {
        sent.push({ to, content })
      },
      throttle: { callsPerHint: 1, secondsPerHint: 0, maxBackoff: 1 },
      pipeline: { thresholds: { bearly: 0.95 } }, // strict
    })

    daemon.start()
    const decision = await daemon.observeToolCall(makeEvent({}))
    daemon.stop()

    expect(sent.length).toBe(0)
    expect(decision.emitted).toBeUndefined()
    expect(decision.rejected?.reason).toBe("below-threshold")
  })

  test("quality-gate strikes a hit BEFORE it reaches scoring", async () => {
    const sent: Array<unknown> = []
    const recall = async (query: string): Promise<RecallQueryResult> => ({
      source: "bearly",
      query,
      hits: [
        makeHit({
          id: "loop",
          snippet: "STUCK_LOOP STUCK_LOOP STUCK_LOOP repeated",
          rank: 1,
        }),
      ],
      durationMs: 5,
    })

    const daemon = createBgRecallDaemon({
      sources: { bearly: recall },
      qualityGate: makeQualityGate(),
      tribeSend: async () => {
        sent.push({})
      },
      throttle: { callsPerHint: 1, secondsPerHint: 0, maxBackoff: 1 },
      pipeline: { thresholds: { bearly: 0.0 } },
    })

    daemon.start()
    const decision = await daemon.observeToolCall(makeEvent({}))
    daemon.stop()

    expect(sent.length).toBe(0)
    expect(decision.emitted).toBeUndefined()
    expect(decision.candidates.some((c) => c.rejectReason === "quality-gate")).toBe(true)
  })

  test("100 tool calls with default config produces ≤10 hints", async () => {
    const sent: unknown[] = []
    const recall = async (query: string): Promise<RecallQueryResult> => ({
      source: "bearly",
      query,
      hits: [
        makeHit({
          id: "h-" + Math.random().toString(36).slice(2),
          snippet: "previous session worked on foo.ts",
          rank: 1,
        }),
      ],
      durationMs: 1,
    })

    const daemon = createBgRecallDaemon({
      sources: { bearly: recall },
      qualityGate: makeQualityGate(),
      tribeSend: async () => {
        sent.push({})
      },
      pipeline: { thresholds: { bearly: 0.0 } }, // permissive
      // default throttle: callsPerHint=10, secondsPerHint=60
    })

    daemon.start()
    const start = Date.now()
    for (let i = 0; i < 100; i++) {
      await daemon.observeToolCall(makeEvent({ ts: start + i * 100 })) // 100ms apart
    }
    daemon.stop()

    expect(sent.length).toBeLessThanOrEqual(10)
  })

  test("explain returns the full causality chain for a fired hint", async () => {
    let firedId: string | null = null
    const recall = async (q: string): Promise<RecallQueryResult> => ({
      source: "bearly",
      query: q,
      hits: [
        makeHit({ id: "winner", snippet: "previous work on foo.ts", title: "winner-doc", rank: 1 }),
        makeHit({ id: "runner-up", snippet: "kinda relevant", rank: 50 }),
      ],
      durationMs: 5,
    })
    const daemon = createBgRecallDaemon({
      sources: { bearly: recall },
      qualityGate: makeQualityGate(),
      tribeSend: async (_to, content) => {
        const m = content.match(/retrieve_memory\("([^"]+)"\)/)
        if (m) firedId = m[1]!
      },
      throttle: { callsPerHint: 1, secondsPerHint: 0, maxBackoff: 1 },
      pipeline: { thresholds: { bearly: 0 } },
    })
    daemon.start()
    const decision = await daemon.observeToolCall(makeEvent({}))
    daemon.stop()

    expect(decision.emitted).toBeDefined()
    const hintId = decision.emitted!.id
    const explained = daemon.explain(hintId)
    expect(explained).toBeDefined()
    expect(explained!.candidates.length).toBeGreaterThan(0)
    expect(explained!.entities.length).toBeGreaterThan(0)
    expect(firedId).toBe("winner")
  })

  test("idle timeout fires onIdleQuit", async () => {
    let quitStatus: unknown = null
    const daemon = createBgRecallDaemon({
      sources: { bearly: async (q) => ({ source: "bearly", query: q, hits: [], durationMs: 0 }) },
      qualityGate: makeQualityGate(),
      tribeSend: async () => {},
      idleTimeoutMs: 50,
      onIdleQuit: (s) => {
        quitStatus = s
      },
    })
    daemon.start()
    await new Promise<void>((r) => setTimeout(r, 100))
    expect(daemon.isIdle()).toBe(true)
    expect(quitStatus).toBeTruthy()
    daemon.stop()
  })

  test("status snapshot reports per-session counts and recent hints", async () => {
    const recall = async (q: string): Promise<RecallQueryResult> => ({
      source: "bearly",
      query: q,
      hits: [makeHit({ snippet: "work on foo.ts" })],
      durationMs: 1,
    })
    const daemon = createBgRecallDaemon({
      sources: { bearly: recall },
      qualityGate: makeQualityGate(),
      tribeSend: async () => {},
      throttle: { callsPerHint: 1, secondsPerHint: 0, maxBackoff: 1 },
      pipeline: { thresholds: { bearly: 0 } },
    })
    daemon.start()
    await daemon.observeToolCall(makeEvent({ sessionId: "a", sessionName: "alice" }))
    await daemon.observeToolCall(makeEvent({ sessionId: "b", sessionName: "bob" }))
    daemon.stop()

    const status = daemon.status()
    expect(status.state).toBe("stopped")
    expect(status.sessions.length).toBe(2)
    expect(status.totals.toolCalls).toBe(2)
    expect(status.totals.hintsFired).toBe(2)
  })

  test("adoption tracked when retrieve_memory called within window", async () => {
    const recall = async (q: string): Promise<RecallQueryResult> => ({
      source: "bearly",
      query: q,
      hits: [makeHit({ snippet: "work on foo.ts" })],
      durationMs: 1,
    })
    const daemon = createBgRecallDaemon({
      sources: { bearly: recall },
      qualityGate: makeQualityGate(),
      tribeSend: async () => {},
      throttle: { callsPerHint: 1, secondsPerHint: 0, maxBackoff: 1 },
      pipeline: { thresholds: { bearly: 0 } },
      metrics: { adoptionWindowCalls: 3, topEntities: 10 },
    })
    daemon.start()
    const dec = await daemon.observeToolCall(makeEvent({ tool: "Read" }))
    expect(dec.emitted).toBeDefined()
    // Simulate retrieve_memory call shortly after
    await daemon.observeToolCall(makeEvent({ tool: "retrieve_memory", input: "" }))
    daemon.stop()

    const status = daemon.status()
    const recent = status.recentHints[0]
    expect(recent?.adoption).toBe("adopted")
  })
})
