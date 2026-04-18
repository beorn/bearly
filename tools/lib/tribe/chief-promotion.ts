/**
 * Chief auto-promotion — when the chief lease expires and no member takes
 * over within a grace window, promote the longest-running active member on
 * their behalf. Keeps the tribe self-healing across Claude Code session
 * crashes, network blips, and the "chief just walked away from their
 * machine" case.
 *
 * This is Layer 2 of km-tribe.chief-auto-election. Layer 1 (health plugin
 * alert) and Layer 3 (dead-letter routing for `to: "chief"`) are already
 * shipped. The three layers compose:
 *
 *   Layer 1 (observability): "something is wrong, no chief"
 *   Layer 2 (self-heal):     "found the longest-running member, promoted"
 *   Layer 3 (dead-letter):   "while no chief holds, route to-chief → *"
 *
 * Design notes:
 *
 * - **Pure function + side-effect wrapper**: `pickPromotionCandidate` is
 *   deterministic (given inputs, returns the same decision). `tryAutoPromote`
 *   wraps it with the DB writes and broadcast, so the daemon calls one thing
 *   and tests can assert on the decision independently.
 *
 * - **Idempotent**: if called twice within the same grace window,
 *   `acquireLease` just renews the existing lease (since holder_id matches).
 *   No double-promote.
 *
 * - **No role mutation**: the promoted session's in-memory role stays
 *   "member" until they reconnect. The lease is the authoritative chief
 *   signal — `isLeaseHolder(db, sessionId)` gates assign/verdict and
 *   handlers already trust that, not client.role.
 *
 * - **Watch and pending excluded**: `watch-*` sessions are admin dashboards
 *   (should never be chief); `pending-*` are half-connected clients that
 *   haven't finished registration.
 */

import type { Database } from "bun:sqlite"
import { acquireLease, getLeaseInfo } from "./lease.ts"
import { sendMessage } from "./messaging.ts"
import type { TribeContext } from "./context.ts"

/** Grace period after lease expiry before auto-promoting. Matches the
 *  health plugin's CHIEF_EXPIRED_GRACE_MS so Layer 1 alert fires first. */
export const CHIEF_PROMOTION_GRACE_MS = 5 * 60 * 1000

/** Heartbeat threshold — a session must have checked in this recently to
 *  be eligible. Matches the live-session cutoff used elsewhere. */
export const CHIEF_PROMOTION_HEARTBEAT_MS = 30_000

export type PromotionCandidate = {
  id: string
  name: string
  pid: number
  started_at: number
  heartbeat: number
}

export type PromotionDecision =
  | { action: "no-lease"; reason: string }
  | { action: "lease-live"; reason: string; expiresInMs: number }
  | { action: "within-grace"; reason: string; expiredByMs: number }
  | { action: "no-candidates"; reason: string; expiredByMs: number }
  | {
      action: "promote"
      candidate: PromotionCandidate
      expiredByMs: number
      previousHolderName: string
    }

/**
 * Pure decision function: given the current lease state and the list of
 * eligible candidates, decide whether to auto-promote and which session wins.
 *
 * Deterministic. No DB writes. No broadcasts. Unit-testable with plain
 * fixtures — see `chief-promotion.test.ts`.
 *
 * Winner selection: longest-running = earliest `started_at`. Ties broken by
 * alphabetical `name` for reproducibility.
 */
export function pickPromotionCandidate(
  lease: { holder_name: string; lease_until: number } | null,
  candidates: readonly PromotionCandidate[],
  nowMs: number = Date.now(),
): PromotionDecision {
  if (lease === null) {
    return { action: "no-lease", reason: "no lease row yet — nobody has ever been chief" }
  }

  const expiredByMs = nowMs - lease.lease_until
  if (expiredByMs <= 0) {
    return { action: "lease-live", reason: "lease still valid", expiresInMs: -expiredByMs }
  }
  if (expiredByMs <= CHIEF_PROMOTION_GRACE_MS) {
    return { action: "within-grace", reason: "lease expired but within grace window", expiredByMs }
  }

  // Past grace — promote someone if possible.
  const eligible = candidates.filter((c) => nowMs - c.heartbeat <= CHIEF_PROMOTION_HEARTBEAT_MS)
  if (eligible.length === 0) {
    return { action: "no-candidates", reason: "lease expired past grace but no eligible member alive", expiredByMs }
  }

  // Longest-running first, then name alpha for stable tie-breaking.
  const winner = [...eligible].sort((a, b) => {
    if (a.started_at !== b.started_at) return a.started_at - b.started_at
    return a.name.localeCompare(b.name)
  })[0]!

  return { action: "promote", candidate: winner, expiredByMs, previousHolderName: lease.holder_name }
}

/**
 * Side-effect wrapper: check the lease, decide, and if a promotion is
 * warranted, call `acquireLease` on the candidate's behalf and broadcast
 * the event. Returns the decision so the caller can log/telemetry-emit it.
 *
 * Returning the decision (rather than a boolean) means callers can
 * distinguish "everything fine" from "nobody alive to promote" from
 * "promoted" — useful for dashboards and tests.
 */
export function tryAutoPromote(
  db: Database,
  candidates: readonly PromotionCandidate[],
  daemonCtx: TribeContext,
  nowMs: number = Date.now(),
): PromotionDecision {
  const lease = getLeaseInfo(db)
  const decision = pickPromotionCandidate(lease, candidates, nowMs)

  if (decision.action !== "promote") return decision

  // Grant the lease on their behalf. acquireLease handles the race: if
  // another candidate already took the lease between pickPromotion and here,
  // our update returns 0 changes and we skip the broadcast.
  const granted = acquireLease(db, decision.candidate.id, decision.candidate.name)
  if (!granted.granted) {
    return {
      action: "within-grace",
      reason: "lease was re-acquired by someone else between pick and commit",
      expiredByMs: decision.expiredByMs,
    }
  }

  const expiredMin = Math.floor(decision.expiredByMs / 60_000)
  const msg = `auto-promoted: ${decision.candidate.name} → chief (previous holder ${decision.previousHolderName} lease was expired ${expiredMin}min)`
  sendMessage(daemonCtx, "*", msg, "chief:auto-promoted")

  return decision
}
