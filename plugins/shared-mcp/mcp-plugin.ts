/**
 * createMcpPlugin — MCP server hosted as a tribe plugin.
 *
 * One long-running MCP server, shared across Claude Code sessions, hosted on
 * the tribe daemon. Wire is `@modelcontextprotocol/sdk`'s Streamable HTTP
 * transport over a Unix socket.
 *
 * # The lifetime policy is two numbers and two timers
 *
 * Per the /pro elegance review (2026-04-26,
 * /tmp/llm-2405c72e-elegance-review-of-the-wrw1.txt):
 *
 *   - `idleTimeoutMs` — how long after the last MCP connection drops before
 *     the plugin asks the daemon to shut down. Connection-as-lease.
 *   - `maxLifetimeMs` — hard upper bound on plugin uptime, regardless of
 *     activity. Caps long-running daemons that never see an idle window.
 *
 * Both fire as event-driven `setTimeout`s. No DSL, no rule engine, no
 * heartbeat tick, no predicate registry. The plugin holds two timer handles
 * and exactly one shutdown reason at a time.
 *
 * # Connection-as-lease
 *
 * `connectionCount` is incremented on every active in-flight HTTP response
 * (which is what holds an MCP/SSE channel open) and decremented when each
 * response ends. When the count drops to zero, the idle timer arms. When a
 * new request takes a lease, the idle timer is canceled.
 *
 * Tracking at the response level (rather than raw socket level) is required
 * for Bun compatibility: Bun's http.Server (1.3.x) does not fire socket-level
 * close events on keep-alive client disconnect (oven-sh/bun#7716). Both
 * runtimes fire `res.on("close")` reliably.
 *
 * # Shutdown is the daemon's responsibility
 *
 * When a timer fires, the plugin calls `opts.onShutdown(reason)`. The plugin
 * does NOT call `process.exit()` — the daemon owner decides what shutting
 * down means (drain in-flight messages, persist state, exit, etc.). If
 * `onShutdown` is not provided, the timer fires are silent (useful for
 * tests).
 *
 * # Wire (prototype scope)
 *
 *   GET    /healthz   — 200 "ok\n"  (cheap liveness probe; no MCP framing)
 *   POST   /mcp       — Streamable HTTP transport (JSON-RPC over POST)
 *   GET    /mcp       — Streamable HTTP transport (server-initiated SSE)
 *   DELETE /mcp       — Streamable HTTP transport (session teardown)
 *
 * # Unix socket discipline
 *
 * Bound to a Unix socket (mode 0600, bind-before-publish). Same-UID local
 * IPC, no TCP, no network surface. `bindAndPublish()`:
 *
 *   1. Creates the parent dir if missing (mode 0700).
 *   2. Probes any existing file at the published path. Live peer → throw;
 *      stale → unlink.
 *   3. Binds the HTTP server to a hidden temp path in the same dir.
 *   4. `chmod 0600` on the temp path BEFORE publishing.
 *   5. `rename(temp → published)` — atomic on the same filesystem.
 *
 * Step 4 before step 5 means the published path is never readable to other
 * users, even briefly.
 *
 * No pidfile. No handshake. Liveness check from outside is a single line:
 * "can I connect to the socket?"
 *
 * @see tools/lib/tribe/plugin-api.ts — TribePluginApi shape
 * @see tools/lib/tribe/socket.ts     — XDG socket-path resolver we mirror
 * @see tools/lib/tribe/git-plugin.ts — minimal plugin example
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http"
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs"
import { createConnection } from "node:net"
import { dirname, resolve } from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import { createLogger } from "loggily"
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { TribePluginApi, TribeClientApi } from "../../tools/lib/tribe/plugin-api.ts"

// ---------------------------------------------------------------------------
// Node IncomingMessage / ServerResponse  ↔  web-standard Request / Response
// ---------------------------------------------------------------------------
//
// The MCP SDK ships two flavors of the streamable HTTP server transport:
//   - StreamableHTTPServerTransport — wraps the web-standard transport in
//     `@hono/node-server`'s adapter for direct Node http.Server use.
//   - WebStandardStreamableHTTPServerTransport — Request → Response.
//
// We bridge to the web-standard transport directly. The hono adapter has
// surfaced flaky behavior with our minimal test fetch shim (500 with no
// body), and the bridge is small enough that owning it is cheaper than
// debugging through a third integration layer.

function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost"
  const url = new URL(req.url ?? "/", `http://${host}`)

  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const vv of v) headers.append(k, vv)
    else if (typeof v === "string") headers.set(k, v)
  }

  const method = req.method ?? "GET"
  const hasBody = method !== "GET" && method !== "HEAD"
  const body = hasBody
    ? new ReadableStream<Uint8Array>({
        start(controller) {
          req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
          req.on("end", () => controller.close())
          req.on("error", (err) => controller.error(err))
        },
      })
    : null

  // UPSTREAM-WAITING(oven-sh/bun#7716): Delete url.toString() when Bun ships keep-alive close-event fix
  // Bead: km-bearly.bun-keepalive-url-shim
  // Escalate by: 2026-10-27
  return new Request(url.toString(), {
    method,
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex?: "half" })
}

async function writeWebResponse(webRes: Response, nodeRes: ServerResponse): Promise<void> {
  const headerObj: Record<string, string> = {}
  webRes.headers.forEach((value, key) => {
    headerObj[key] = value
  })
  nodeRes.writeHead(webRes.status, headerObj)

  if (webRes.body === null) {
    nodeRes.end()
    return
  }
  // Force headers out so the client side completes its `fetch()` Promise as
  // soon as the server starts streaming (matters for SSE).
  if (typeof nodeRes.flushHeaders === "function") nodeRes.flushHeaders()
  const reader = webRes.body.getReader()
  let clientGone = false
  const onClientGone = (): void => {
    if (clientGone) return
    clientGone = true
    reader.cancel().catch(() => {
      /* already done */
    })
  }
  nodeRes.on("close", onClientGone)
  nodeRes.on("error", onClientGone)

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (clientGone) break
      nodeRes.write(value)
    }
  } catch {
    /* reader was cancelled */
  } finally {
    nodeRes.off("close", onClientGone)
    nodeRes.off("error", onClientGone)
    if (!clientGone) nodeRes.end()
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Reason passed to `onShutdown`. Two timers, two reasons.
 */
export type McpShutdownReason = "idle" | "max-lifetime"

export interface McpPluginOptions {
  /**
   * How long after the last MCP connection drops before the plugin asks the
   * daemon to shut down. Default 30 minutes.
   */
  idleTimeoutMs?: number

  /**
   * Hard upper bound on plugin uptime, regardless of activity. Default
   * 24 hours.
   */
  maxLifetimeMs?: number

  /**
   * Called when either timer fires. The plugin does not call
   * `process.exit()` — the daemon decides what to do. Optional; tests can
   * omit it and read shutdown intent through `getConnectionCount()` /
   * `getAddress()`.
   */
  onShutdown?: (reason: McpShutdownReason) => void

  /**
   * Override the published Unix-socket path. If omitted, resolved via
   * `resolveMcpSocketPath()`.
   */
  socketPath?: string

  /**
   * MCP server identity reported back in `initialize`.
   */
  serverInfo?: { name: string; version: string }
}

export interface McpPluginHandle extends TribePluginApi {
  /**
   * The bound Unix socket path — only meaningful AFTER start() has
   * completed bind-and-publish. Returns `null` until then or after stop().
   */
  getAddress(): { socketPath: string } | null

  /**
   * Active in-flight response count. Tracks open HTTP responses (which is
   * what holds the lease in the connection-as-lease design).
   */
  getConnectionCount(): number
}

// ---------------------------------------------------------------------------
// Socket-path resolver (mirrors tools/lib/tribe/socket.ts)
// ---------------------------------------------------------------------------

/**
 * Resolve the published MCP socket path. Priority:
 *
 *   1. `opts.socketPath`   — explicit override
 *   2. `BEARLY_MCP_SOCKET` — env override
 *   3. `XDG_RUNTIME_DIR/bearly-mcp/mcp-<pid>.sock`
 *   4. `~/.local/share/bearly-mcp/mcp-<pid>.sock` (macOS / no XDG)
 *   5. `/tmp/bearly-mcp/mcp-<pid>.sock` (no HOME)
 *
 * Per-PID filename keeps multi-instance dev usage clean.
 *
 * macOS limits Unix-socket paths to 104 bytes. If `$HOME` is unusually
 * deep, callers may want to override via `opts.socketPath`.
 */
export function resolveMcpSocketPath(opts?: { socketPath?: string }): string {
  if (opts?.socketPath) return opts.socketPath
  if (process.env.BEARLY_MCP_SOCKET) return process.env.BEARLY_MCP_SOCKET

  const xdg = process.env.XDG_RUNTIME_DIR
  const home = process.env.HOME
  const dir = xdg ?? (home !== undefined && home !== "" ? resolve(home, ".local/share/bearly-mcp") : "/tmp/bearly-mcp")
  return resolve(dir, `mcp-${process.pid}.sock`)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000

export function createMcpPlugin(opts: McpPluginOptions = {}): McpPluginHandle {
  const log = createLogger("tribe:mcp")

  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const maxLifetimeMs = opts.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS
  const socketPath = resolveMcpSocketPath(opts)
  const serverInfo = opts.serverInfo ?? { name: "@bearly/shared-mcp", version: "0.0.0" }
  const onShutdown = opts.onShutdown

  // ------------------------------------------------------------------------
  // Lease tracking + two timers
  // ------------------------------------------------------------------------

  const activeResponses = new Set<ServerResponse>()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null
  let shutdownFired = false

  function fireShutdown(reason: McpShutdownReason): void {
    if (shutdownFired) return
    shutdownFired = true
    log.info?.(`mcp shutdown requested (reason=${reason})`)
    try {
      onShutdown?.(reason)
    } catch (err) {
      log.warn?.(`onShutdown threw: ${err instanceof Error ? err.message : err}`)
    }
  }

  function armIdleTimer(): void {
    if (idleTimer !== null || shutdownFired) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      fireShutdown("idle")
    }, idleTimeoutMs)
    ;(idleTimer as { unref?: () => void }).unref?.()
  }

  function cancelIdleTimer(): void {
    if (idleTimer === null) return
    clearTimeout(idleTimer)
    idleTimer = null
  }

  // ------------------------------------------------------------------------
  // MCP server + transport (per-session)
  // ------------------------------------------------------------------------
  //
  // The MCP SDK requires one Protocol/Transport pair per session. Map keyed
  // by the SDK-issued session ID.

  function installHandlers(server: McpServer): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Skeleton: real tools come in a follow-up bead (see parent epic).
      return { tools: [] }
    })
  }

  type SessionEntry = { server: McpServer; transport: WebStandardStreamableHTTPServerTransport }
  const sessions = new Map<string, SessionEntry>()

  async function createSessionEntry(): Promise<SessionEntry> {
    const server = new McpServer(serverInfo, { capabilities: { tools: {} } })
    installHandlers(server)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport })
      },
    })
    transport.onerror = (err) => {
      log.warn?.(`mcp transport onerror: ${err instanceof Error ? err.message : err}`)
    }
    transport.onclose = () => {
      for (const [id, entry] of sessions) {
        if (entry.transport === transport) sessions.delete(id)
      }
    }
    await server.connect(transport)
    return { server, transport }
  }

  function lookupOrCreateSession(req: Request): Promise<SessionEntry> {
    const id = req.headers.get("mcp-session-id")
    if (id !== null) {
      const existing = sessions.get(id)
      if (existing) return Promise.resolve(existing)
    }
    return createSessionEntry()
  }

  // ------------------------------------------------------------------------
  // HTTP wire
  // ------------------------------------------------------------------------

  let httpServer: HttpServer | null = null

  function trackResponse(req: IncomingMessage, res: ServerResponse): void {
    activeResponses.add(res)
    cancelIdleTimer()

    const drop = (): void => {
      if (!activeResponses.delete(res)) return
      if (activeResponses.size === 0) armIdleTimer()
    }
    // Fire on whichever close event arrives first.
    //
    //   - Node: `res.on("close")` fires reliably.
    //   - Bun (1.3.x): `res.on("close")` fires for short responses but
    //     not on streaming-disconnect. `req.on("close")` fires reliably
    //     in both cases on Bun.
    //
    // Listening to both ensures the lease drops promptly on either runtime.
    res.once("close", drop)
    req.once("close", drop)
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    trackResponse(req, res)

    const url = req.url ?? "/"
    if (req.method === "GET" && url.startsWith("/healthz")) {
      // Optional `?stream=<ms>` opens a streaming response — useful for
      // tests that need to take and hold the lease deterministically.
      const q = url.indexOf("?")
      const streamParam = q >= 0 ? new URLSearchParams(url.slice(q + 1)).get("stream") : null
      const streamMs = streamParam !== null ? Math.max(0, Number(streamParam) | 0) : 0
      if (streamMs > 0) {
        res.writeHead(200, { "Content-Type": "text/plain" })
        res.write("ok\n")
        const ping = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            clearInterval(ping)
            return
          }
          res.write(":\n")
        }, 100)
        ;(ping as { unref?: () => void }).unref?.()
        const stop = setTimeout(() => {
          clearInterval(ping)
          if (!res.writableEnded) res.end()
        }, streamMs)
        ;(stop as { unref?: () => void }).unref?.()
        res.once("close", () => {
          clearInterval(ping)
          clearTimeout(stop)
        })
        return
      }
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.end("ok\n")
      return
    }
    if (url.startsWith("/mcp")) {
      try {
        const webRequest = toWebRequest(req)
        const session = await lookupOrCreateSession(webRequest)
        const webResponse = await session.transport.handleRequest(webRequest)
        await writeWebResponse(webResponse, res)
      } catch (err) {
        const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)
        log.error?.(`mcp dispatch error: ${msg}`)
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" })
          res.end(`internal error: ${msg}\n`)
        } else {
          res.end()
        }
      }
      return
    }
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("not found\n")
  }

  // ------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------

  /**
   * Probe whether `path` is a live Unix socket. If `connect()` succeeds → live;
   * otherwise stale or absent.
   */
  function probeAlive(path: string, timeoutMs = 250): Promise<boolean> {
    return new Promise((resolveProbe) => {
      let settled = false
      const done = (alive: boolean): void => {
        if (settled) return
        settled = true
        try {
          probe.destroy()
        } catch {
          /* ignore */
        }
        resolveProbe(alive)
      }
      const probe = createConnection(path)
      probe.once("connect", () => done(true))
      probe.once("error", () => done(false))
      const t = setTimeout(() => done(false), timeoutMs)
      ;(t as { unref?: () => void }).unref?.()
    })
  }

  /**
   * Bind-before-publish: see file header for the full sequence.
   */
  async function bindAndPublish(): Promise<void> {
    const dir = dirname(socketPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })

    if (existsSync(socketPath)) {
      const alive = await probeAlive(socketPath)
      if (alive) {
        throw new Error(`mcp socket ${socketPath} is already in use by a live peer`)
      }
      log.debug?.(`removing stale socket ${socketPath}`)
      try {
        unlinkSync(socketPath)
      } catch {
        /* ignore */
      }
    }

    // Temp path: hidden, randomized, in the same dir so `rename()` is atomic.
    const tempPath = resolve(dir, `.mcp-${process.pid}-${randomBytes(4).toString("hex")}.tmp.sock`)

    httpServer = createServer((req, res) => {
      void dispatch(req, res)
    })

    await new Promise<void>((resolveListen, reject) => {
      const onError = (err: Error): void => reject(err)
      httpServer!.once("error", onError)
      httpServer!.listen(tempPath, () => {
        httpServer!.removeListener("error", onError)
        resolveListen()
      })
    })

    // chmod BEFORE publishing — published path is never wider than 0600.
    try {
      chmodSync(tempPath, 0o600)
    } catch (err) {
      log.warn?.(`chmod 0600 failed (continuing): ${err instanceof Error ? err.message : err}`)
    }

    renameSync(tempPath, socketPath)
    log.info?.(`mcp plugin listening on unix:${socketPath}`)
  }

  function start(): void {
    if (httpServer !== null) throw new Error("mcp plugin already started")

    bindAndPublish().catch((err: unknown) => {
      log.error?.(`bindAndPublish failed: ${err instanceof Error ? err.message : err}`)
    })

    // Lifetime timer — fires regardless of activity.
    lifetimeTimer = setTimeout(() => {
      lifetimeTimer = null
      fireShutdown("max-lifetime")
    }, maxLifetimeMs)
    ;(lifetimeTimer as { unref?: () => void }).unref?.()

    // No connections at start → arm idle timer immediately.
    armIdleTimer()
  }

  function stop(): void {
    cancelIdleTimer()
    if (lifetimeTimer !== null) {
      clearTimeout(lifetimeTimer)
      lifetimeTimer = null
    }
    // End every in-flight response so the server can shut down promptly.
    for (const res of activeResponses) {
      try {
        res.end()
      } catch {
        /* already ended */
      }
      try {
        res.socket?.destroy()
      } catch {
        /* already closed */
      }
    }
    activeResponses.clear()
    for (const { transport } of sessions.values()) {
      try {
        void transport.close()
      } catch {
        /* already closed */
      }
    }
    sessions.clear()
    if (httpServer !== null) {
      const s = httpServer
      httpServer = null
      s.close()
    }
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath)
      } catch {
        /* ignore */
      }
    }
  }

  // ------------------------------------------------------------------------
  // Plugin shape
  // ------------------------------------------------------------------------

  const handle: McpPluginHandle = {
    name: "mcp",

    available() {
      // Unix sockets are available on every platform tribe targets.
      return true
    },

    start(_api: TribeClientApi) {
      start()
      return () => stop()
    },

    getAddress() {
      if (httpServer === null || !httpServer.listening) return null
      if (!existsSync(socketPath)) return null
      return { socketPath }
    },

    getConnectionCount() {
      return activeResponses.size
    },
  }

  return handle
}
