/**
 * withClientRegistry — owns the in-memory map of connected clients plus the
 * derived chief lease.
 *
 * The registry is a plain Map<connId, ClientSession> on the daemon value. Three
 * surfaces consume it:
 *   - the dispatcher (route requests by connId, look up client.ctx)
 *   - the broadcaster (fan messages to every connected socket)
 *   - the idle-quit (when registry is empty, start the countdown)
 *
 * Chief is derived from connection order via `deriveChief*`, with an optional
 * explicit lease (`chiefClaim`) that pins the role to a specific session until
 * it disconnects or releases.
 *
 * This split exists so the imperative socket / dispatch / idle-quit layers can
 * all read/write the same backing state through one shape, instead of via
 * module-level `const clients = new Map(...)` declarations.
 */

import type { Socket as NetSocket } from "node:net"
import { deriveChiefId, deriveChiefInfo, isChiefEligible } from "../chief.ts"
import type { LoreConnState } from "../lore-handlers.ts"
import type { TribeContext } from "../context.ts"
import type { TribeRole } from "../config.ts"
import type { BaseTribe } from "./base.ts"

export type ClientSession = {
  socket: NetSocket
  id: string
  name: string
  role: TribeRole
  domains: string[]
  project: string
  projectName: string
  projectId: string
  pid: number
  claudeSessionId: string | null
  /** Peer socket path for direct proxy-to-proxy connections */
  peerSocket: string | null
  /** Connection path (socket or db) */
  conn: string
  ctx: TribeContext
  registeredAt: number
  /** Per-connection lore state — tracks sessionId/claudePid for lore handlers
   *  (set on tribe.hello / tribe.session_register). Kept separate from the
   *  tribe-side sessionId because a single proxy connection may carry both
   *  coordination + memory traffic interleaved. */
  lore: LoreConnState
}

export interface ClientRegistry {
  /** connId → session */
  readonly clients: Map<string, ClientSession>
  /** socket → connId — reverse index for socket-keyed cleanup */
  readonly socketToClient: Map<NetSocket, string>
  /** sessionId of the explicit chief claimer, or null when derivation applies. */
  getChiefClaim(): string | null
  setChiefClaim(sessionId: string | null): void
  /** Take chief lease for a session. Logs activity via the supplied callback. */
  claimChief(sessionId: string, name: string, log: (type: string, content: string) => void): void
  /** Release chief lease for a session if currently held. Logs activity. */
  releaseChief(sessionId: string, log: (type: string, content: string) => void): void
  /** ctx.sessionIds of every currently-connected eligible client. */
  getActiveSessionIds(): Set<string>
  getActiveSessionInfo(): Array<{
    id: string
    name: string
    pid: number
    role: TribeRole
    claudeSessionId: string | null
    registeredAt: number
  }>
  /** Resolve the current chief sessionId — claim first, else longest-connected. */
  getChiefId(): string | null
  /** Resolve the current chief info (sessionId + name + role + …) or null. */
  getChiefInfo(): ReturnType<typeof deriveChiefInfo>
}

export interface WithClientRegistry {
  readonly registry: ClientRegistry
}

export function withClientRegistry<T extends BaseTribe>(): (t: T) => T & WithClientRegistry {
  return (t) => {
    const clients = new Map<string, ClientSession>()
    const socketToClient = new Map<NetSocket, string>()
    let chiefClaim: string | null = null

    const registry: ClientRegistry = {
      clients,
      socketToClient,
      getChiefClaim: () => chiefClaim,
      setChiefClaim: (sessionId) => {
        chiefClaim = sessionId
      },
      claimChief(sessionId, name, log) {
        chiefClaim = sessionId
        log("chief:claimed", `${name} claimed chief`)
      },
      releaseChief(sessionId, log) {
        if (chiefClaim !== sessionId) return
        chiefClaim = null
        const c = Array.from(clients.values()).find((x) => x.ctx.sessionId === sessionId)
        const who = c?.name ?? "unknown"
        log("chief:released", `${who} released chief`)
      },
      getActiveSessionIds(): Set<string> {
        const ids = new Set<string>()
        for (const c of clients.values()) {
          if (!isChiefEligible(c)) continue
          ids.add(c.ctx.sessionId)
        }
        return ids
      },
      getActiveSessionInfo() {
        return Array.from(clients.values())
          .filter(isChiefEligible)
          .map((c) => ({
            id: c.ctx.sessionId,
            name: c.name,
            pid: c.pid,
            role: c.role,
            claudeSessionId: c.claudeSessionId,
            registeredAt: c.registeredAt,
          }))
      },
      getChiefId: () => deriveChiefId(clients.values(), chiefClaim),
      getChiefInfo: () => deriveChiefInfo(clients.values(), chiefClaim),
    }

    // Drop all client refs on shutdown so disposal doesn't leave dangling
    // sockets in the maps. Actual socket teardown is the socket-server's job.
    t.scope.defer(() => {
      clients.clear()
      socketToClient.clear()
      chiefClaim = null
    })

    return { ...t, registry }
  }
}
