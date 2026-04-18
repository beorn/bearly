/**
 * derive-chief — pure unit tests for `deriveChiefId` in tribe-daemon.
 *
 * The function is the heart of the plateau model: no leases, no DB state —
 * chief is derived from the set of connected clients via two rules in order:
 *
 *   1. If `chiefClaim` points to a still-connected eligible client, that
 *      client wins (explicit `tribe.claim-chief` override).
 *   2. Otherwise the longest-connected eligible client (smallest
 *      `registeredAt`) wins, with name alphabetical tie-break.
 *
 * "Eligible" excludes the daemon itself and `watch-*` / `pending-*` sessions.
 */

import { describe, it, expect } from "vitest"
import { deriveChiefId } from "../tools/tribe-daemon.ts"

// ---------------------------------------------------------------------------
// Minimal ClientSession fixture — deriveChiefId only reads a few fields, so
// casting a partial to `any` keeps these tests focused and independent of the
// full ClientSession type.
// ---------------------------------------------------------------------------

type Client = {
  id: string
  name: string
  ctx: { sessionId: string }
  registeredAt: number
}

function c(partial: Partial<Client> & { name: string }): Client {
  return {
    id: partial.id ?? partial.name + "-connid",
    name: partial.name,
    ctx: { sessionId: partial.ctx?.sessionId ?? partial.name + "-ctx" },
    registeredAt: partial.registeredAt ?? 1000,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const derive = (clients: Client[], claim: string | null = null): string | null => deriveChiefId(clients as any, claim)

describe("deriveChiefId", () => {
  it("returns null for an empty client list", () => {
    expect(derive([])).toBeNull()
  })

  it("returns the sole eligible client", () => {
    const alice = c({ name: "alice" })
    expect(derive([alice])).toBe(alice.ctx.sessionId)
  })

  it("picks the longest-connected client (smallest registeredAt)", () => {
    const alice = c({ name: "alice", registeredAt: 1000 })
    const bob = c({ name: "bob", registeredAt: 2000 })
    // Order of input should not matter — both permutations yield alice.
    expect(derive([alice, bob])).toBe(alice.ctx.sessionId)
    expect(derive([bob, alice])).toBe(alice.ctx.sessionId)
  })

  it("breaks registeredAt ties by name alphabetical for stability", () => {
    const alice = c({ name: "alice", registeredAt: 1000 })
    const bob = c({ name: "bob", registeredAt: 1000 })
    expect(derive([alice, bob])).toBe(alice.ctx.sessionId)
    expect(derive([bob, alice])).toBe(alice.ctx.sessionId)
  })

  it("excludes watch-* sessions from the pool", () => {
    const watch = c({ name: "watch-dashboard", registeredAt: 500 }) // would win by time
    const alice = c({ name: "alice", registeredAt: 1000 })
    expect(derive([watch, alice])).toBe(alice.ctx.sessionId)
  })

  it("excludes pending-* sessions (half-connected clients)", () => {
    const pending = c({ name: "pending-abc123", registeredAt: 500 })
    const alice = c({ name: "alice", registeredAt: 1000 })
    expect(derive([pending, alice])).toBe(alice.ctx.sessionId)
  })

  it("excludes the daemon itself", () => {
    const daemon = c({ name: "daemon", registeredAt: 100 })
    const alice = c({ name: "alice", registeredAt: 1000 })
    expect(derive([daemon, alice])).toBe(alice.ctx.sessionId)
  })

  it("returns null if every client is ineligible", () => {
    expect(derive([c({ name: "daemon" }), c({ name: "watch-x" }), c({ name: "pending-y" })])).toBeNull()
  })

  it("explicit claim wins even when someone else has been connected longer", () => {
    const alice = c({ name: "alice", registeredAt: 1000 })
    const bob = c({ name: "bob", registeredAt: 2000 })
    // alice is older so she would win the derivation, but bob claimed.
    expect(derive([alice, bob], bob.ctx.sessionId)).toBe(bob.ctx.sessionId)
  })

  it("falls back to derivation when the claimer has disconnected", () => {
    const alice = c({ name: "alice", registeredAt: 1000 })
    const bob = c({ name: "bob", registeredAt: 2000 })
    // claim references a session that is not in the list — should be ignored.
    expect(derive([alice, bob], "someone-else-ctx")).toBe(alice.ctx.sessionId)
  })

  it("ignores a claim pointing to an ineligible session (daemon/watch-*)", () => {
    // This shouldn't happen in practice (claimChief is only called from
    // handlers for real clients), but if it ever did, derivation should still
    // fall back to the eligible pool rather than crashing or returning
    // ineligible IDs.
    const watch = c({ name: "watch-x", registeredAt: 500 })
    const alice = c({ name: "alice", registeredAt: 1000 })
    expect(derive([watch, alice], watch.ctx.sessionId)).toBe(alice.ctx.sessionId)
  })
})
