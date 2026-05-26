/**
 * withDispatcher — per-connection JSON-RPC dispatch loop.
 *
 * Owns:
 *   - `handleConnection(socket)` — accept-handler that creates a placeholder
 *     ClientSession, wires the line parser, and tears down on `close`.
 *   - `handleRequest(req, connId)` — JSON-RPC method router. The big switch
 *     covers `register`, every `tribe.*` coord method (delegated to
 *     `handleToolCall`), the `cli_*` introspection methods, `log_event`,
 *     `discover`, `set_state` / `get_state`, `subscribe`, plus the lore
 *     fallthrough in `default`.
 *   - The session-name resolution helpers (`adoptIdentity`,
 *     `adoptByProjectAndRole`, `resolveName`, `deduplicateName`,
 *     `applyClient`, `resetOffsetsToTail`, `announceJoin`).
 *
 * Runtime hooks injected via `withDispatcher({...})`:
 *   - `onActiveClient()` — invoked from accept (a fresh client connected).
 *     Wired to `withIdleQuit.markActive()`.
 *   - `onIdle()` — invoked when the registry empties on disconnect. Wired
 *     to `withIdleQuit.markIdle()`.
 *   - `getActivePluginNames()` — surfaced via `cli_status` for UI.
 *   - `getCliDaemonExtras()` / `getCliStatusExtras()` — late-bound
 *     introspection that needs runtime knobs (quitTimeout, etc.).
 *   - `suppressWindowMs` — join/leave broadcast window after hot-reload.
 *
 * The dispatcher attaches its connection handler to the bound `socket.server`
 * via `server.on("connection", handler)`.
 */

import { randomUUID } from "node:crypto"
import { type Socket as NetSocket } from "node:net"
import { createLogger } from "loggily"
import {
  createLineParser,
  isRequest,
  makeError,
  makeResponse,
  TRIBE_PROTOCOL_VERSION,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "@bearly/tribe-client/lib/socket"
import { detectRole, resolveProjectId, type TribeRole } from "@bearly/tribe-client/lib/config"
import { createTribeContext, type TribeContext } from "../context.ts"
import { handleToolCall, isRemovedTribeMethod, removedTribeMethodMessage, TRIBE_COORD_METHODS } from "../handlers.ts"
import { createLifecycleStore } from "../lifecycle-store.ts"
import { logEvent, sendMessage } from "../messaging.ts"
import { registerSession, NameConflictError } from "../session.ts"
import { adoptByPidCwd, adoptIdentity, resolveName, type PriorSession } from "../resolve-name.ts"
import { type RecallConnState } from "../recall-handlers.ts"
import type { BaseTribe } from "./base.ts"
import type { WithBroadcast } from "./with-broadcast.ts"
import type { WithClientRegistry, ClientSession } from "./with-client-registry.ts"
import type { WithConfig } from "./with-config.ts"
import type { WithDaemonContext } from "./with-daemon-context.ts"
import type { WithDatabase } from "./with-database.ts"
import type { WithRecall } from "./with-recall.ts"
import type { WithSocketServer } from "./with-socket-server.ts"

const log = createLogger("tribe:dispatcher")

export interface DispatcherRuntimeHooks {
  /** Called from accept(). Default: no-op. Wire to withIdleQuit. */
  onActiveClient?: () => void
  /** Called when the registry empties on disconnect. */
  onIdle?: () => void
  /** Plugin names surfaced via cli_status. Default: empty array. */
  getActivePluginNames?: () => string[]
  /** Quit-timeout (seconds) returned by cli_daemon. Default: -1. */
  getQuitTimeoutSec?: () => number
  /** Suppress-window for join/leave broadcasts. Default: 10000ms (0 disables). */
  suppressWindowMs?: number
}

/**
 * Method handler for late-bound JSON-RPC methods (e.g. MCP-spec methods
 * registered by `withMCPServer()`). Returns the result data; the dispatcher
 * wraps it in a JSON-RPC response. Throw to surface a JSON-RPC error.
 */
export type MethodHandler = (params: Record<string, unknown>, ctx: { connId: string }) => unknown | Promise<unknown>

export interface Dispatcher {
  /** The accept-handler the socket server invokes. */
  handleConnection: (socket: NetSocket) => void
  /** The JSON-RPC method router. Exposed for tests. */
  handleRequest: (req: JsonRpcRequest, connId: string) => Promise<string>
  /**
   * Register a late-bound method handler. Used by surfaces (e.g. MCP server)
   * that need to answer JSON-RPC methods after the dispatcher is built.
   * Late-bound methods are checked BEFORE lore in the default branch, so they
   * never conflict with the explicit `tribe.*` cases above. Re-registration
   * throws.
   */
  register: (method: string, handler: MethodHandler) => void
}

export interface WithDispatcher {
  readonly dispatcher: Dispatcher
}

function relPath(p: string): string {
  const cwd = process.cwd()
  return p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p
}

export function withDispatcher<
  T extends BaseTribe &
    WithConfig &
    WithDatabase &
    WithDaemonContext &
    WithRecall &
    WithClientRegistry &
    WithBroadcast &
    WithSocketServer,
>(hooks: DispatcherRuntimeHooks = {}): (t: T) => T & WithDispatcher {
  return (t) => {
    const { db, stmts, daemonCtx, recall: recallHandlers, registry, broadcast, socket } = t
    const { clients, socketToClient } = registry
    const onActiveClient = hooks.onActiveClient ?? (() => {})
    const onIdle = hooks.onIdle ?? (() => {})
    const getActivePluginNames = hooks.getActivePluginNames ?? (() => [])
    const getQuitTimeoutSec = hooks.getQuitTimeoutSec ?? (() => -1)
    const suppressWindowMs = hooks.suppressWindowMs ?? (process.env.TRIBE_NO_SUPPRESS ? 0 : 10_000)

    const methodHandlers = new Map<string, MethodHandler>()
    function register(method: string, handler: MethodHandler): void {
      if (methodHandlers.has(method)) {
        throw new Error(`Method "${method}" already registered`)
      }
      methodHandlers.set(method, handler)
    }

    function logActivity(type: string, content: string): void {
      sendMessage(daemonCtx, "*", content, type, undefined, undefined, "broadcast", {
        delivery: "pull",
        topic: `daemon:${type}`,
      })
    }

    /** In-memory per-session lifecycle-snapshot cache. Last-write-wins;
     *  lost on daemon restart by design (sessions re-publish on the next
     *  state transition). Wired via `getLifecycleStore` so direct-handler
     *  callers (smoke harness, tests) can opt out by omitting the
     *  accessor. See `@km/infra/15630-stuck-agent-observability` § S4. */
    const lifecycleStore = createLifecycleStore()

    /**
     * Name-claim replay nudge — when handleJoin / handleRename rewinds a
     * session's pull cursor to surface gap directs, fire an MCP `wakeup`
     * notification at the claiming session's live socket so push-mode clients
     * drain immediately instead of waiting for the next turn-start
     * `tribe.fetch`. Pull-mode clients pick the directs up on their next poll
     * regardless — the wakeup is opportunistic, not load-bearing.
     */
    function notifyWakeupForReplay(sessionId: string, claimedName: string): void {
      let connId: string | undefined
      for (const [cid, c] of clients) {
        if (c.ctx.sessionId === sessionId) {
          connId = cid
          break
        }
      }
      if (!connId) return
      const tail = stmts.getMessageTailSeq.get() as { seq: number } | null
      broadcast.pushToClient(connId, "wakeup", {
        latest_seq: tail?.seq ?? null,
        reason: "name-claim-replay",
        claimed_name: claimedName,
      })
    }

    /** No-op handler opts for daemon-side tool calls. */
    const DAEMON_HANDLER_OPTS = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => registry.getActiveSessionIds(),
      getActiveSessionInfo: () => registry.getActiveSessionInfo(),
      getLifecycleStore: () => lifecycleStore,
      notifyWakeupForReplay,
      getDebugState: () => ({
        clients: Array.from(clients.values()).map((c) => ({
          id: c.ctx.sessionId,
          name: c.name,
          role: c.role,
          pid: c.pid,
          registeredAt: c.registeredAt,
        })),
        cursors: db.prepare("SELECT id, name, last_delivered_ts, last_delivered_seq FROM sessions").all() as Array<{
          id: string
          name: string
          last_delivered_ts: number | null
          last_delivered_seq: number | null
        }>,
      }),
    } as const

    /** Generate a unique member-<pid> name, with random suffix if taken */
    function generateMemberName(pid: number, connId: string): string {
      const pidName = `member-${pid || connId.slice(0, 6)}`
      const taken = db.prepare("SELECT id FROM sessions WHERE name = ?").get(pidName)
      return taken ? `member-${pid}-${Math.random().toString(36).slice(2, 5)}` : pidName
    }
    void generateMemberName // currently unused but kept for parity

    function deduplicateName(name: string): string {
      const live = Array.from(clients.values())
      const holder = live.find((c) => c.name === name)
      if (!holder) return name
      // No silent fallback. Surface the conflict so the caller picks a fresh
      // name explicitly. The list of taken names + the live PID of the holder
      // go on the error so the caller doesn't need a separate
      // tribe.sessions round-trip AND can verify the conflict is real
      // (`isPidAlive(holder_pid)` on the caller side).
      const connectedNames = live.map((c) => c.name).sort()
      throw new NameConflictError(name, connectedNames, holder.pid || null)
    }

    function applyClient(
      connId: string,
      fields: {
        name: string
        role: TribeRole
        domains: string[]
        project: string
        projectName: string
        projectId: string
        pid: number
        claudeSessionId: string | null
        peerSocket: string | null
        ctx: TribeContext
      },
    ): ClientSession {
      const existing = clients.get(connId)!
      const client: ClientSession = {
        socket: existing.socket,
        id: connId,
        name: fields.name,
        role: fields.role,
        domains: fields.domains,
        project: fields.project,
        projectName: fields.projectName,
        projectId: fields.projectId,
        pid: fields.pid,
        claudeSessionId: fields.claudeSessionId,
        peerSocket: fields.peerSocket,
        conn: relPath(socket.socketPath),
        ctx: fields.ctx,
        registeredAt: Date.now(),
        lastActivityAt: Date.now(),
        recall: existing.recall,
      }
      clients.set(connId, client)
      onActiveClient()
      return client
    }

    function resetOffsetsToTail(client: ClientSession): void {
      const latest = stmts.getMessageTailSeq.get() as { seq: number } | null
      const tailSeq = latest?.seq ?? 0
      stmts.resetSessionDeliveryOffsets.run({ $id: client.ctx.sessionId, $ts: Date.now(), $seq: tailSeq })
    }

    function announceJoin(client: ClientSession): void {
      if (Date.now() - socket.startedAt <= suppressWindowMs) return
      let parentName: string | null = null
      if (client.claudeSessionId) {
        for (const [cid, c] of clients) {
          if (cid !== client.id && c.claudeSessionId === client.claudeSessionId) {
            parentName = c.name
            break
          }
        }
      }
      const shortProject = client.project.replace(process.env.HOME ?? "", "~")
      const suffix = parentName ? ` (sub-agent of ${parentName})` : ""
      logActivity("session", `${client.name} joined (${client.role}) pid=${client.pid} ${shortProject}${suffix}`)
    }

    async function handleRequest(req: JsonRpcRequest, connId: string): Promise<string> {
      const { method, params, id } = req
      const p = (params ?? {}) as Record<string, unknown>

      // Touch lastActivityAt for THIS client on every inbound request —
      // drives the idle column in `tribe sessions` / `tribe health`.
      // Spec: @km/tribe/15588-tribe-list-sessions.
      const liveClient = clients.get(connId)
      if (liveClient) liveClient.lastActivityAt = Date.now()

      try {
        switch (method) {
          case "register": {
            const claudeSessionName = (p.claudeSessionName as string) ?? null
            const claudeSessionId = (p.claudeSessionId as string) ?? null
            const identityToken = (p.identityToken as string) ?? null

            let role = detectRole(db, { role: p.role as string | undefined })
            if (role === "daemon" || role === "pending") role = "member"

            const isActive = (sid: string): boolean => Array.from(clients.values()).some((c) => c.ctx.sessionId === sid)

            // 15413 — daemon-restart-reconnect adoption. When the daemon
            // SIGHUP-re-execs, the listening socket fd survives but the
            // previously-accepted client connections close on the old
            // process's exit. Adapters reconnect; without this lookup the
            // fresh accept() looks like a brand-new session and the auto-
            // namer re-issues agentN — severing the prior name + chief-claim
            // mapping. (pid, cwd) is the safe key here: same client process
            // → same OS pid + cwd. Falls back to identityToken (weaker —
            // sha256(claude_session_id|cwd|role); see the 2026-05-14
            // adoption-by-identityToken removal note in resolve-name.ts).
            const clientPid = Number(p.pid ?? 0)
            const clientCwd = String(p.project ?? "")
            const pidCwdAdopted = adoptByPidCwd(db, clientPid, clientCwd, isActive)
            const adopted = pidCwdAdopted ?? adoptIdentity(db, identityToken, isActive)

            if (!p.role && adopted?.role) {
              const adoptedRole = adopted.role
              if (adoptedRole === "member" || adoptedRole === "watch") {
                role = adoptedRole
              }
            }

            const project = String(p.project ?? process.cwd())
            const projectName = String(p.projectName ?? project.split("/").pop() ?? "unknown")
            const projectId = String(p.projectId ?? resolveProjectId(project))

            // Names currently held by live (connected) clients — flavor
            // auto-numbering picks the lowest free integer among these.
            // Counting connected sessions (not DB rows) means a disconnected
            // codex frees `codex1` for the next spawn.
            const takenNames = new Set(Array.from(clients.values()).map((c) => c.name))
            // 15413 — when we adopted via (pid, cwd), inject the prior name
            // into resolveName's param so its existing "p.name set → return
            // verbatim" path picks it up. This is intentionally NOT done for
            // identityToken-only matches (the 2026-05-14 ban on adoption-by-
            // identityToken still stands — only the strictly-stable (pid,
            // cwd) form gets to override the name).
            const pForResolve = pidCwdAdopted ? { ...p, name: pidCwdAdopted.name } : p
            const name = deduplicateName(
              resolveName({
                db,
                p: pForResolve,
                adopted,
                claudeSessionName,
                claudeSessionId,
                role,
                isActive,
                projectId,
                takenNames,
                clientPid,
              }),
            )
            const domains = (p.domains as string[]) ?? []
            const peerSocket = (p.peerSocket as string) ?? null
            const pid = Number(p.pid ?? 0)

            const clientProtocolVersion = p.protocolVersion ? Number(p.protocolVersion) : undefined
            if (clientProtocolVersion !== undefined && clientProtocolVersion !== TRIBE_PROTOCOL_VERSION) {
              log.info?.(
                `Protocol version mismatch: client=${clientProtocolVersion}, daemon=${TRIBE_PROTOCOL_VERSION} (session=${name})`,
              )
            }

            const clientCtx = createTribeContext({
              db,
              stmts,
              sessionId: adopted?.id ?? randomUUID(),
              sessionRole: role,
              initialName: name,
              domains,
              claudeSessionId,
              claudeSessionName,
              onMessageInserted: broadcast.messageTap,
            })

            const deliveryRaw = (p.delivery as string) ?? "push"
            const delivery: "push" | "pull" = deliveryRaw === "pull" ? "pull" : "push"
            // @km/infra/15641 Phase 1 — per-session account/provider label
            // sourced from `ag` (which sets TRIBE_ACCOUNT/TRIBE_PROVIDER env
            // vars at backend-launch time). Tribe just stores the label so
            // tribe.members can answer "which account is each session on?";
            // quota poll + threshold logic live in ag, not tribe.
            const account = typeof p.account === "string" ? p.account : null
            const provider = typeof p.provider === "string" ? p.provider : null
            registerSession(
              clientCtx,
              projectId,
              (sid) => registry.getActiveSessionIds().has(sid),
              identityToken,
              pid,
              delivery,
              project,
              account,
              provider,
            )

            const client = applyClient(connId, {
              name,
              role,
              domains,
              project,
              projectName,
              projectId,
              pid,
              claudeSessionId,
              peerSocket,
              ctx: clientCtx,
            })

            resetOffsetsToTail(client)
            announceJoin(client)

            const coordState = db
              .prepare("SELECT key, value FROM coordination WHERE project_id = ?")
              .all(projectId) as Array<{ key: string; value: string | null }>

            return makeResponse(id, {
              sessionId: clientCtx.sessionId,
              name,
              role,
              protocolVersion: TRIBE_PROTOCOL_VERSION,
              coordinationState: coordState,
              daemon: { pid: process.pid, uptime: Math.floor((Date.now() - socket.startedAt) / 1000) },
            })
          }

          case TRIBE_COORD_METHODS.send:
          case TRIBE_COORD_METHODS.fetch:
          case TRIBE_COORD_METHODS.members:
          case TRIBE_COORD_METHODS.rename:
          case TRIBE_COORD_METHODS.join:
          case TRIBE_COORD_METHODS.health:
          case TRIBE_COORD_METHODS.reload:
          case TRIBE_COORD_METHODS.retro:
          case TRIBE_COORD_METHODS.debug:
          case TRIBE_COORD_METHODS.filter:
          case TRIBE_COORD_METHODS.lifecyclePublish:
          case TRIBE_COORD_METHODS.lifecycle:
          case TRIBE_COORD_METHODS.pending: {
            const client = clients.get(connId)
            const ctx = client?.ctx ?? daemonCtx
            const result = await handleToolCall(ctx, method, p, DAEMON_HANDLER_OPTS)
            if ((method === TRIBE_COORD_METHODS.join || method === TRIBE_COORD_METHODS.rename) && client) {
              client.name = ctx.getName()
              client.role = ctx.getRole()
            }
            return makeResponse(id, result)
          }

          case "cli_status": {
            const now = Date.now()
            const parentMap = new Map<string, string>()
            for (const [, c] of clients) {
              if (c.claudeSessionId && !parentMap.has(c.claudeSessionId)) {
                parentMap.set(c.claudeSessionId, c.name)
              }
            }
            const sessions = Array.from(clients.values()).map((c) => {
              const parent = c.claudeSessionId ? parentMap.get(c.claudeSessionId) : undefined
              return {
                id: c.id,
                name: c.name,
                role: c.role,
                domains: c.domains,
                pid: c.pid,
                project: c.project,
                projectName: c.projectName,
                projectId: c.projectId,
                claudeSessionId: c.claudeSessionId,
                peerSocket: c.peerSocket,
                connectedAt: c.registeredAt,
                uptimeMs: now - c.registeredAt,
                /** Wall-clock ms since this client's last inbound request.
                 *  15588 — drives the idle column. */
                idleMs: now - c.lastActivityAt,
                /** Working directory the session registered from. The
                 *  daemon already tracks this as `project`; surfaced here
                 *  under the `cwd` alias to match the bead's vocabulary. */
                cwd: c.project,
                source: "daemon" as const,
                conn: c.conn,
                resources: [] as string[],
                parent: parent && parent !== c.name ? parent : undefined,
              }
            })
            return makeResponse(id, {
              sessions,
              daemon: {
                pid: process.pid,
                uptime: Math.floor((Date.now() - socket.startedAt) / 1000),
                clients: clients.size,
                dbPath: t.config.dbPath,
                socketPath: socket.socketPath,
                resources: getActivePluginNames(),
              },
            })
          }

          case "cli_health": {
            const health = await handleToolCall(daemonCtx, TRIBE_COORD_METHODS.health, {}, DAEMON_HANDLER_OPTS)
            const { getHealthSnapshot } = await import("../health-monitor-plugin.ts")
            let machine: unknown = null
            try {
              machine = await getHealthSnapshot()
            } catch {
              /* health snapshot unavailable */
            }
            // 15588: fold the live roster into the health response so chief
            // can answer "who is connected / who is idle >15min" with one
            // command. Same shape as the cli_status response — name,
            // role, pid, cwd, idleMs, uptimeMs — minus the bookkeeping
            // fields (peerSocket, conn, projectId, etc.) that aren't
            // useful in a health overview.
            const nowH = Date.now()
            const roster = Array.from(clients.values()).map((c) => ({
              name: c.name,
              role: c.role,
              pid: c.pid,
              cwd: c.project,
              uptimeMs: nowH - c.registeredAt,
              idleMs: nowH - c.lastActivityAt,
            }))
            return makeResponse(id, {
              ...health,
              machine,
              sessions: roster,
              daemon: {
                pid: process.pid,
                uptime: Math.floor((Date.now() - socket.startedAt) / 1000),
                clients: clients.size,
              },
            })
          }

          case "cli_log": {
            const limit = Number(p.limit ?? 20)
            const rows = db.prepare("SELECT * FROM messages ORDER BY ts DESC LIMIT ?").all(limit)
            return makeResponse(id, { messages: (rows as unknown[]).reverse() })
          }

          /**
           * Chief-silent watchdog Layer 2 — inbox status for any session
           * (default `@chief`). Returns the count + age of actionable DMs
           * the session hasn't drained via tribe.fetch.
           * See @km/all/silent-errors-enforcement/chief-silent-watchdog-relay-pattern-detection.
           */
          case "cli_inbox_status": {
            const sessionName = String(p.session ?? "@chief")
            const row = stmts.getUnreadDms.get({ $name: sessionName }) as
              | { count: number; oldest_ts: number }
              | undefined
            const unread_count = row?.count ?? 0
            const oldest_ts = row?.oldest_ts ?? 0
            const oldest_unread_age_min = oldest_ts > 0 ? Math.floor((Date.now() - oldest_ts) / 60_000) : 0
            return makeResponse(id, {
              session: sessionName,
              unread_count,
              oldest_unread_age_min,
              oldest_unread_ts: oldest_ts,
            })
          }

          /**
           * Layer 3 — andon-pull alarm set. Anyone (user via CLI, agent via
           * tribe.send wrapper) can invoke. Stores reason + author in the
           * coordination table under a fixed key. The chief-drain-check.sh
           * PreToolUse hook reads it and hard-blocks chief tool calls until
           * `cli_alarm_ack` clears it.
           */
          case "cli_alarm_set": {
            const reason = String(p.reason ?? "(no reason given)")
            const by = String(p.by ?? "anonymous")
            const value = JSON.stringify({ reason, by, ts: Date.now() })
            db.prepare(
              "INSERT OR REPLACE INTO coordination (project_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)",
            ).run("", "alarm.active", value, by, Date.now())
            return makeResponse(id, { ok: true, reason, by })
          }

          /** Layer 3 — read current alarm state (or {active:false}). */
          case "cli_alarm_get": {
            const row = db
              .prepare("SELECT value FROM coordination WHERE project_id = ? AND key = ?")
              .get("", "alarm.active") as { value: string | null } | undefined
            if (!row || !row.value) {
              return makeResponse(id, { active: false })
            }
            try {
              const parsed = JSON.parse(row.value) as { reason: string; by: string; ts: number }
              return makeResponse(id, {
                active: true,
                reason: parsed.reason,
                by: parsed.by,
                ts: parsed.ts,
                age_min: Math.floor((Date.now() - parsed.ts) / 60_000),
              })
            } catch {
              return makeResponse(id, { active: false })
            }
          }

          /** Layer 3 — clear the alarm. Caller is expected to have already
           *  sent a verdict-typed acknowledgement to @user describing the
           *  action taken (the CLI surfaces this as `tribe alarm-ack`). */
          case "cli_alarm_ack": {
            db.prepare("DELETE FROM coordination WHERE project_id = ? AND key = ?").run("", "alarm.active")
            return makeResponse(id, { ok: true })
          }

          case "cli_daemon": {
            return makeResponse(id, {
              pid: process.pid,
              uptime: Math.floor((Date.now() - socket.startedAt) / 1000),
              clients: clients.size,
              dbPath: t.config.dbPath,
              socketPath: socket.socketPath,
              startedAt: socket.startedAt,
              quitTimeout: getQuitTimeoutSec(),
            })
          }

          case "log_event": {
            const client = clients.get(connId)
            const ctx = client?.ctx ?? daemonCtx
            logEvent(
              ctx,
              String(p.type ?? "unknown"),
              p.bead_id as string | undefined,
              p.meta as Record<string, unknown> | undefined,
            )
            if (p.content) logActivity(String(p.type ?? "event"), String(p.content))
            return makeResponse(id, { ok: true })
          }

          case "discover": {
            const query = {
              project_id: p.project_id as string | undefined,
              name: p.name as string | undefined,
            }
            let results = Array.from(clients.values()).filter((c) => c.role !== "pending")
            if (query.project_id) results = results.filter((c) => c.projectId === query.project_id)
            if (query.name) results = results.filter((c) => c.name === query.name)
            return makeResponse(id, {
              results: results.map((c) => ({
                name: c.name,
                role: c.role,
                project: c.project,
                projectId: c.projectId,
                peerSocket: c.peerSocket,
                domains: c.domains,
              })),
            })
          }

          case "set_state": {
            const client = clients.get(connId)
            const projectId = String(p.project_id ?? client?.projectId ?? "")
            const key = String(p.key)
            const value = p.value !== undefined ? JSON.stringify(p.value) : null
            db.prepare(
              "INSERT OR REPLACE INTO coordination (project_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)",
            ).run(projectId, key, value, client?.name ?? "daemon", Date.now())
            return makeResponse(id, { ok: true })
          }

          case "get_state": {
            const client = clients.get(connId)
            const projectId = String(p.project_id ?? client?.projectId ?? "")
            if (p.key) {
              const row = db
                .prepare("SELECT * FROM coordination WHERE project_id = ? AND key = ?")
                .get(projectId, String(p.key))
              return makeResponse(id, { state: row ?? null })
            }
            const rows = db.prepare("SELECT * FROM coordination WHERE project_id = ?").all(projectId)
            return makeResponse(id, { state: rows })
          }

          case "subscribe": {
            return makeResponse(id, { subscribed: true })
          }

          default: {
            if (isRemovedTribeMethod(method)) {
              return makeError(id, -32601, removedTribeMethodMessage(method))
            }

            // Late-bound method handlers (e.g. MCP-spec methods registered
            // by `withMCPServer()`). Checked first so surfaces composed after
            // the dispatcher can answer methods over the same Unix socket.
            const lateHandler = methodHandlers.get(method)
            if (lateHandler) {
              try {
                const result = await lateHandler(p, { connId })
                return makeResponse(id, result as Record<string, unknown>)
              } catch (err) {
                const errorWithCode = err as Error & { code?: number }
                const code = typeof errorWithCode.code === "number" ? errorWithCode.code : -32603
                const msg = errorWithCode.message ?? String(err)
                return makeError(id, code, msg)
              }
            }

            // Lore (memory) RPC surface.
            if (recallHandlers && recallHandlers.isRecallMethod(method)) {
              const client = clients.get(connId)
              const recallConn = client?.recall ?? ({ sessionId: null, claudePid: null } as RecallConnState)
              try {
                const result = await recallHandlers.dispatch(recallConn, method, p)
                return makeResponse(id, result as Record<string, unknown>)
              } catch (err) {
                const errorWithCode = err as Error & { code?: number }
                const code = typeof errorWithCode.code === "number" ? errorWithCode.code : -32603
                const msg = errorWithCode.message ?? String(err)
                return makeError(id, code, msg)
              }
            }
            return makeError(id, -32601, `Method not found: ${method}`)
          }
        }
      } catch (err) {
        if (err instanceof NameConflictError) {
          // Surface the conflict + existing_names + holder_pid so the caller
          // can pick a non-colliding alternative without a separate
          // tribe.sessions query AND verify the holder is a real live
          // process (vs. a stale daemon-side ghost). JSON-RPC error code
          // -32000 = "Server error" (application range).
          log.info?.(
            `NameConflict on ${method}: "${err.desiredName}" taken (existing=${err.existing_names.length}, pid=${err.holder_pid ?? "?"})`,
          )
          return makeError(id, -32000, err.message, {
            existing_names: err.existing_names,
            holder_pid: err.holder_pid,
          })
        }
        const msg = err instanceof Error ? err.message : String(err)
        log.info?.(`Error handling ${method}: ${msg}`)
        return makeError(id, -32603, msg)
      }
    }

    function handleConnection(sock: NetSocket): void {
      const connId = randomUUID()
      log.info?.(`Client connected: ${connId.slice(0, 8)}`)

      const placeholder: ClientSession = {
        socket: sock,
        id: connId,
        name: `pending-${connId.slice(0, 6)}`,
        role: "pending",
        domains: [],
        project: process.cwd(),
        projectName: "unknown",
        projectId: "",
        pid: 0,
        claudeSessionId: null,
        peerSocket: null,
        conn: "",
        ctx: daemonCtx,
        registeredAt: Date.now(),
        lastActivityAt: Date.now(),
        recall: { sessionId: null, claudePid: null },
      }
      clients.set(connId, placeholder)
      socketToClient.set(sock, connId)
      onActiveClient()

      const parse = createLineParser(async (msg: JsonRpcMessage) => {
        if (isRequest(msg)) {
          const response = await handleRequest(msg, connId)
          try {
            sock.write(response)
          } catch {
            /* socket died during handling */
          }
        }
      })

      sock.on("data", parse)

      sock.on("close", () => {
        const client = clients.get(connId)
        if (client && client.role !== "pending") {
          log.info?.(`Client disconnected: ${client.name}`)
          logActivity("session", `${client.name} left`)
        }
        broadcast.flushConnection(connId)
        broadcast.discardConnection(connId)
        clients.delete(connId)
        socketToClient.delete(sock)
        if (recallHandlers && client) recallHandlers.dropConn(client.recall.sessionId)
        if (clients.size === 0) onIdle()
      })

      sock.on("error", (err) => {
        log.info?.(`Client error (${connId.slice(0, 8)}): ${err.message}`)
        sock.destroy()
      })
    }

    // Wire the accept handler into the bound server. The withSocketServer
    // factory creates the Server without a handler; we attach via "connection"
    // event listener (Node Server supports late-bound handlers).
    socket.server.on("connection", handleConnection)
    t.scope.defer(() => {
      socket.server.removeListener("connection", handleConnection)
    })

    return {
      ...t,
      dispatcher: { handleConnection, handleRequest, register },
    }
  }
}
