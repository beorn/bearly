/**
 * withClientRegistry — owns the in-memory map of connected clients.
 *
 * The registry is a plain Map<connId, ClientSession> on the daemon value. Three
 * surfaces consume it:
 *   - the dispatcher (route requests by connId, look up client.ctx)
 *   - the broadcaster (fan messages to every connected socket)
 *   - the idle-quit (when registry is empty, start the countdown)
 *
 * The tribe-wire daemon is role-agnostic (F12 of
 * @km/tribe/15496-coordination-drift): there is no chief/member distinction
 * and nothing to derive. The only filtering the registry does is by
 * connection-lifecycle tag — `daemon` / `watch` / `pending` sessions are not
 * "participating members" for the active-session helpers.
 *
 * This split exists so the imperative socket / dispatch / idle-quit layers can
 * all read/write the same backing state through one shape, instead of via
 * module-level `const clients = new Map(...)` declarations.
 */

import type { Socket as NetSocket } from "node:net"
import type { RecallConnState } from "../recall-handlers.ts"
import type { TribeContext } from "../context.ts"
import type { TribeRole } from "@bearly/tribe-client/lib/config"
import type { BaseTribe } from "./base.ts"

/** A session participates as a regular tribe member iff it is not the daemon
 *  itself, a read-only watcher, or a half-registered pending connection. */
function isParticipant(c: { role: TribeRole }): boolean {
  return c.role === "member"
}

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
  /** Wall-clock ms at the last dispatched method from this client. Touched
   *  in `with-dispatcher.ts` for every inbound request; consumers compute
   *  `idleMs = Date.now() - lastActivityAt`. Initialised to `registeredAt`
   *  on connection so a brand-new session reads as 0ms idle. Spec:
   *  `@km/tribe/15588-tribe-list-sessions`. */
  lastActivityAt: number
  /** Per-connection recall state — tracks sessionId/claudePid for recall handlers
   *  (set on tribe.hello / tribe.session_register). Kept separate from the
   *  tribe-side sessionId because a single proxy connection may carry both
   *  coordination + memory traffic interleaved. */
  recall: RecallConnState
}

export interface ClientRegistry {
  /** connId → session */
  readonly clients: Map<string, ClientSession>
  /** socket → connId — reverse index for socket-keyed cleanup */
  readonly socketToClient: Map<NetSocket, string>
  /** ctx.sessionIds of every currently-connected participating member. */
  getActiveSessionIds(): Set<string>
  getActiveSessionInfo(): Array<{
    id: string
    name: string
    pid: number
    role: TribeRole
    claudeSessionId: string | null
    registeredAt: number
  }>
}

export interface WithClientRegistry {
  readonly registry: ClientRegistry
}

export function withClientRegistry<T extends BaseTribe>(): (t: T) => T & WithClientRegistry {
  return (t) => {
    const clients = new Map<string, ClientSession>()
    const socketToClient = new Map<NetSocket, string>()

    const registry: ClientRegistry = {
      clients,
      socketToClient,
      getActiveSessionIds(): Set<string> {
        const ids = new Set<string>()
        for (const c of clients.values()) {
          if (!isParticipant(c)) continue
          ids.add(c.ctx.sessionId)
        }
        return ids
      },
      getActiveSessionInfo() {
        return Array.from(clients.values())
          .filter(isParticipant)
          .map((c) => ({
            id: c.ctx.sessionId,
            name: c.name,
            pid: c.pid,
            role: c.role,
            claudeSessionId: c.claudeSessionId,
            registeredAt: c.registeredAt,
          }))
      },
    }

    // Drop all client refs on shutdown so disposal doesn't leave dangling
    // sockets in the maps. Actual socket teardown is the socket-server's job.
    t.scope.defer(() => {
      clients.clear()
      socketToClient.clear()
    })

    return { ...t, registry }
  }
}
