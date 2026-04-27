/**
 * BaseTribe — the seed value flowing through the tribe-daemon composition pipe.
 *
 * Carries the lifetime owner (Scope) and the daemon's identity (sessionId,
 * startedAt, pid, daemonVersion). Every subsequent `withX` factory extends
 * this type with one more capability.
 *
 * See `hub/composition.md` § "tribe (proposed migration)" for the full design.
 */

import { randomUUID } from "node:crypto"
import { createScope, type Scope } from "@bearly/daemon-spine"

export interface BaseTribe {
  readonly scope: Scope
  /** Synthetic session id used by daemon-internal writes. */
  readonly daemonSessionId: string
  /** Wall-clock ms when boot started. Used for uptime + suppress-window. */
  readonly startedAt: number
  /** Daemon version (matches @bearly/tribe package.json). */
  readonly daemonVersion: string
  /** Process pid — captured once for diagnostics. */
  readonly daemonPid: number
}

export interface CreateBaseTribeOpts {
  /** Override the lifetime owner — tests may pass a child scope. */
  scope?: Scope
  /** Override the version string surfaced in lore/status (defaults to "0.10.0"). */
  daemonVersion?: string
}

export function createBaseTribe(opts: CreateBaseTribeOpts = {}): BaseTribe {
  return {
    scope: opts.scope ?? createScope("tribe-daemon"),
    daemonSessionId: randomUUID(),
    startedAt: Date.now(),
    daemonVersion: opts.daemonVersion ?? "0.10.0",
    daemonPid: process.pid,
  }
}
