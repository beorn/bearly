/**
 * MCP-as-tribe-plugin — prototype.
 *
 * One long-running MCP server, shared across Claude Code sessions, hosted as
 * a plugin on the tribe daemon. Wire is `@modelcontextprotocol/sdk`'s
 * Streamable HTTP transport over a Unix socket. This is the lifecycle
 * skeleton — real tool implementations and migration of existing stdio
 * MCPs follow in later beads.
 *
 * # Why one daemon, not one-per-session
 *
 * Today every Claude Code session spawns its own MCP servers via stdio. With
 * N sessions × M servers, startup latency, FD pressure, and lifecycle bugs
 * (orphaned children, double-close, PID exhaustion) all scale linearly. A
 * shared MCP daemon drops that to one process per machine.
 *
 * # Request-as-lease
 *
 * The count of active in-flight HTTP responses IS the lease. No `lease()`
 * API, no reference-count dance, no handshake — Claude Code clients hit the
 * MCP wire and each open response is the "I'm using this" signal. Quick
 * request/response pairs (POST /mcp tools/list, GET /healthz) take and
 * release the lease in microseconds. Long-running streams (GET /mcp's SSE
 * channel) hold it for the duration of the stream.
 *
 * - Last response closes → arm idle-quit timer (default 30 min, configurable)
 * - New request arrives → cancel the timer
 * - Timer fires → the `idle` predicate flips true → events.emit("request_quit")
 *
 * Liveness check from outside: `connect to the socket`. If it answers, it's
 * alive. No pidfile, no handshake, no reaper.
 *
 * Note: an earlier draft tracked the kernel-level TCP/Unix-socket connection
 * via http.Server's "connection" event. Bun's http.Server (1.3.x) does not
 * fire server-side socket close events on keep-alive client disconnect (see
 * oven-sh/bun#7716), so that signal silently dropped the lease accounting on
 * Bun. Tracking at the request/response level uses signals both runtimes
 * honor, and the realistic lease semantics are unchanged — an MCP client
 * with no open response isn't actually using the daemon.
 *
 * # Composable quit predicates
 *
 * Multiple shutdown reasons coexist as a flat list of callable predicates:
 *
 *   () => boolean | Promise<boolean>
 *
 * The daemon quits when ANY predicate returns true. The default registry
 * holds:
 *
 *   - the idle-quit predicate (true once the idle timer has fired)
 *   - a SIGTERM predicate (true once the signal handler flips a flag)
 *
 * Anything else (quota exhausted, parent process gone, config-file removed,
 * external "shutdown" message) plugs in the same way: register a thunk.
 *
 * NO tagged union, NO `kind` field — predicates are just functions. Cheap
 * to add, cheap to compose, and they keep the daemon's own shutdown path a
 * single `Promise.race` over (predicate poll, fast-path event).
 *
 * # request_quit channel — EventEmitter
 *
 * The plugin emits a `"request_quit"` event with the firing predicate's
 * label as payload. Multiple subscribers can listen — a daemon supervisor
 * can record telemetry while the actual lifecycle handler does the
 * shutdown:
 *
 *   handle.events.on("request_quit", (reason) => daemon.shutdown(reason))
 *   handle.events.on("request_quit", (reason) => metrics.record(reason))
 *
 * Multi-listener is the win over a single `onRequestQuit` callback. The
 * plugin does NOT call `process.exit()` — shutdown is the daemon's
 * responsibility.
 *
 * # Wire (prototype scope)
 *
 *   GET    /healthz   — 200 "ok\n"  (cheap liveness probe; no MCP framing)
 *   POST   /mcp       — Streamable HTTP transport (JSON-RPC over POST)
 *   GET    /mcp       — Streamable HTTP transport (server-initiated SSE stream)
 *   DELETE /mcp       — Streamable HTTP transport (session teardown, stateful only)
 *
 * `/mcp` is a single MCP endpoint per the Streamable HTTP spec; the SDK's
 * `StreamableHTTPServerTransport.handleRequest(req, res)` dispatches by
 * HTTP method internally. We run the transport in stateless mode
 * (`sessionIdGenerator: undefined`) for the prototype — no per-client
 * state, each request stands alone. Statefulness is a follow-up if needed.
 *
 * Bound to a Unix socket (mode 0600, bind-before-publish). Same-UID local
 * IPC, no TCP, no network surface. Claude Code's HTTP MCP client supports
 * `unix:` URIs, so consumers point at the socket directly.
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
import { EventEmitter } from "node:events"
import { createLogger } from "loggily"
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { TribePluginApi, TribeClientApi } from "../../tools/lib/tribe/plugin-api.ts"
import { createTimers } from "../../tools/lib/tribe/timers.ts"

// ---------------------------------------------------------------------------
// Node IncomingMessage / ServerResponse  ↔  web-standard Request / Response
// ---------------------------------------------------------------------------
//
// The MCP SDK ships two flavors of the streamable HTTP server transport:
//   - StreamableHTTPServerTransport — wraps the web-standard transport in
//     `@hono/node-server`'s adapter for direct Node http.Server use.
//   - WebStandardStreamableHTTPServerTransport — Request → Response, which
//     is the underlying primitive.
//
// We bridge to the web-standard transport directly. The hono adapter has
// surfaced flaky behavior with our minimal test fetch shim (500 Internal
// Server Error with no body, no error event), and the bridge is small
// enough that owning it is cheaper than debugging through a third
// integration layer. ~30 lines, no dependencies beyond `node:http`.

function toWebRequest(req: IncomingMessage): Request {
  // Build a stable URL — the host header is what the client sent, but
  // we never actually use it (the transport only reads pathname / search
  // / headers). `localhost` is a safe default for over-Unix-socket calls.
  const host = req.headers.host ?? "localhost"
  const url = new URL(req.url ?? "/", `http://${host}`)

  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const vv of v) headers.append(k, vv)
    else if (typeof v === "string") headers.set(k, v)
  }

  // GET/HEAD have no body. Otherwise, stream from the IncomingMessage.
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

  return new Request(url.toString(), {
    method,
    headers,
    body,
    // Required by the Fetch spec when `body` is a ReadableStream.
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
  // For SSE responses Node buffers headers until first body write — that
  // makes the client wait indefinitely for the response handshake. Force
  // headers out so the client side completes its `fetch()` Promise as
  // soon as the server starts streaming.
  if (typeof nodeRes.flushHeaders === "function") nodeRes.flushHeaders()
  const reader = webRes.body.getReader()
  // If the client tears down (close/error), cancel the body reader so the
  // server-side stream stops producing into a dead socket.
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
    // Stream chunks straight to the response — keeps SSE working without
    // buffering the whole body, since the transport's SSE response is an
    // open stream.
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (clientGone) break
      nodeRes.write(value)
    }
  } catch {
    /* reader was cancelled — nothing more to do */
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
 * Predicate signature — anything callable that resolves to a boolean. The
 * daemon quits when ANY registered predicate returns true.
 *
 * Examples:
 *
 *     // idle-quit — built in
 *     () => idleTimerFired
 *
 *     // SIGTERM — built in
 *     () => sigtermReceived
 *
 *     // parent process gone — caller-supplied
 *     () => process.ppid === 1
 *
 *     // accountly says we're out of quota — caller-supplied
 *     async () => (await getQuotaState()) === "exhausted"
 */
export type QuitPredicate = () => boolean | Promise<boolean>

/**
 * Event surface emitted by the plugin handle. Use `events.on("request_quit",
 * reason => ...)` to subscribe. Multiple listeners are supported — that's
 * the reason this is an EventEmitter rather than a single callback.
 */
export interface McpPluginEvents {
  /** A quit predicate returned true; `reason` is the predicate's label. */
  request_quit: [reason: string]
}

export interface McpPluginOptions {
  /**
   * Idle-quit window — how long after the last MCP-wire connection drops
   * before the idle predicate flips true. Default 30 minutes.
   */
  idleTimeoutMs?: number

  /**
   * Predicate poll interval. Default 5s. Reduced to 50ms in tests so the
   * happy-path test doesn't have to wait for a real tick.
   */
  pollIntervalMs?: number

  /**
   * Override the published Unix-socket path. If omitted, resolved via
   * `resolveMcpSocketPath()` (XDG_RUNTIME_DIR else `~/.local/share/bearly-mcp/`,
   * filename `mcp-<pid>.sock`).
   */
  socketPath?: string

  /**
   * MCP server identity reported back in the initialize response.
   */
  serverInfo?: { name: string; version: string }

  /**
   * Hook tests reach for to register custom predicates BEFORE start(),
   * without needing to touch `registerQuitPredicate` after the fact.
   */
  initialPredicates?: QuitPredicate[]
}

export interface McpPluginHandle extends TribePluginApi {
  /**
   * Register an additional quit predicate AFTER start() has been called.
   * Predicates are called from the slow tick AND on connection-count-zero
   * transitions, so `register → idle drop → predicate fires → request_quit`
   * is observable within `pollIntervalMs`.
   */
  registerQuitPredicate(fn: QuitPredicate): void

  /**
   * The bound Unix socket path — only meaningful AFTER start() has been
   * called and bind-and-publish has completed. Returns `null` until then.
   */
  getAddress(): { socketPath: string } | null

  /**
   * Active in-flight response count — primarily for tests and observability.
   * Tracks open HTTP responses (which is what holds the lease). A long-
   * running SSE response holds the lease for its lifetime; a quick
   * request-response pair takes and releases it in microseconds.
   */
  getConnectionCount(): number

  /**
   * Subscribe to plugin events. Currently emits:
   *
   *   - `"request_quit"` with `(reason: string)` — a quit predicate fired.
   *     Multiple listeners supported; daemon supervisor + telemetry can
   *     coexist on the same channel.
   */
  events: EventEmitter<McpPluginEvents>
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
 *   5. `/tmp/bearly-mcp/mcp-<pid>.sock` (no HOME — exotic environments)
 *
 * Per-PID filename keeps multi-instance dev usage clean (e.g. one MCP
 * daemon per logical workspace if you ever want it). The default deployment
 * is one per user; both work.
 *
 * Note: macOS limits Unix-socket paths to 104 bytes. If `$HOME` is unusually
 * deep, callers may want to override via `opts.socketPath` to point at a
 * shorter path (e.g. `/tmp/...`).
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
const DEFAULT_POLL_INTERVAL_MS = 5_000

export function createMcpPlugin(opts: McpPluginOptions = {}): McpPluginHandle {
  const log = createLogger("tribe:mcp")

  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const socketPath = resolveMcpSocketPath(opts)
  const serverInfo = opts.serverInfo ?? { name: "@bearly/mcp", version: "0.0.0" }

  const events = new EventEmitter<McpPluginEvents>()
  // Allow many subscribers — daemon shutdown handler, telemetry, debug
  // listeners. The default of 10 is plenty for now but explicit is clearer.
  events.setMaxListeners(64)

  // ------------------------------------------------------------------------
  // Predicate registry
  // ------------------------------------------------------------------------

  // Stored as { fn, label } so quit-reason diagnostics are non-empty.
  type Entry = { fn: QuitPredicate; label: string }
  const predicates: Entry[] = []

  function register(fn: QuitPredicate, label: string): void {
    predicates.push({ fn, label })
  }

  // ------------------------------------------------------------------------
  // Lease tracking + idle-quit
  // ------------------------------------------------------------------------

  // Track active in-flight responses — that's the lease. The original
  // design tracked raw TCP/Unix-socket connections via http.Server's
  // "connection" event, but Bun's http.Server (1.3.x) does NOT fire the
  // server-side socket "close" event when a keep-alive client disconnects
  // (see oven-sh/bun#7716). Both runtimes fire `res.on("close")` reliably,
  // so we track at the response level instead. Semantically equivalent
  // for the realistic case (an MCP client either has an open SSE stream
  // = active response = lease held, or it doesn't = no lease) and works
  // identically on Bun and Node.
  //
  // Quick requests (e.g. POST /mcp tools/list, GET /healthz) take and
  // release the lease in microseconds. Long-running streams (GET /mcp
  // SSE) hold it for the duration of the stream. Either way, the
  // idle-quit timer arms once the count drops to zero and stays there
  // for `idleTimeoutMs`.
  const activeResponses = new Set<ServerResponse>()
  let idleTimerFired = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  function armIdleTimer(): void {
    if (idleTimer !== null) return
    idleTimer = setTimeout(() => {
      idleTimerFired = true
      idleTimer = null
      // Probe predicates immediately so request_quit fires without
      // waiting for the next slow tick.
      void checkPredicates("idle-timer-fired")
    }, idleTimeoutMs)
    // Don't pin the event loop — daemon shutdown should still work.
    ;(idleTimer as { unref?: () => void }).unref?.()
    log.debug?.(`idle timer armed (${idleTimeoutMs}ms)`)
  }

  function cancelIdleTimer(): void {
    if (idleTimer === null) return
    clearTimeout(idleTimer)
    idleTimer = null
    idleTimerFired = false
    log.debug?.("idle timer canceled (new connection)")
  }

  // Built-in: the idle predicate.
  register(() => idleTimerFired, "idle")

  // Built-in: SIGTERM. Plug-in pattern — not a special case in the daemon.
  let sigtermReceived = false
  register(() => sigtermReceived, "sigterm")

  // Caller-supplied predicates from opts (handy for tests).
  for (const fn of opts.initialPredicates ?? []) register(fn, "initial")

  // ------------------------------------------------------------------------
  // Predicate poll
  // ------------------------------------------------------------------------

  let quitting = false

  async function checkPredicates(trigger: string): Promise<void> {
    if (quitting) return
    for (const { fn, label } of predicates) {
      try {
        const result = await fn()
        if (result) {
          quitting = true
          log.info?.(`quit requested (predicate=${label} trigger=${trigger})`)
          events.emit("request_quit", label)
          return
        }
      } catch (err) {
        log.warn?.(`predicate ${label} threw: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  // ------------------------------------------------------------------------
  // MCP server + transport (per-session)
  // ------------------------------------------------------------------------
  //
  // The MCP SDK's Streamable HTTP transport requires one transport instance
  // per session. The Protocol layer also requires one instance per
  // connection (see protocol.ts: "Already connected to a transport. Call
  // close() before connecting to a new transport, or use a separate
  // Protocol instance per connection."). So our model is:
  //
  //   sessionId  →  { server: McpServer, transport: …Transport }
  //
  // - Request with no Mcp-Session-Id header → new client; spin up a
  //   fresh server+transport pair, connect them, dispatch, store under
  //   the session ID the transport generated.
  // - Request with a known session ID → look up and dispatch to the
  //   stored transport.
  // - Unknown session ID → the transport returns 404 itself (we just
  //   route to a fresh "default" pair which will reject).
  //
  // Tool handlers are configured by `installHandlers(server)`; the same
  // logic runs on every server instance, just rebound. This is the price
  // of the SDK's per-connection-Protocol design — the alternative would
  // be reimplementing wire framing ourselves, which is what the SDK
  // exists to spare us.

  function installHandlers(server: McpServer): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Skeleton: real tools come in a follow-up bead.
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
        // The transport tells us its session ID once initialize completes;
        // record it for subsequent same-session requests.
        sessions.set(id, { server, transport })
      },
    })
    transport.onerror = (err) => {
      log.warn?.(`mcp transport onerror: ${err instanceof Error ? err.message : err}`)
    }
    transport.onclose = () => {
      // Best-effort cleanup — find this transport in `sessions` and remove.
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
      // Unknown session ID — return a fresh pair; the transport's
      // session validation will reject the request with 404.
    }
    return createSessionEntry()
  }

  // ------------------------------------------------------------------------
  // HTTP wire
  // ------------------------------------------------------------------------

  let httpServer: HttpServer | null = null
  let abortCtl: AbortController | null = null
  let timers: ReturnType<typeof createTimers> | null = null

  function trackResponse(req: IncomingMessage, res: ServerResponse): void {
    activeResponses.add(res)
    cancelIdleTimer()
    log.debug?.(`wire connect (count=${activeResponses.size})`)

    const drop = (): void => {
      if (!activeResponses.delete(res)) return
      log.debug?.(`wire disconnect (count=${activeResponses.size})`)
      if (activeResponses.size === 0) {
        armIdleTimer()
        // Event-driven check: predicates that watch external state
        // (parent gone, quota exhausted) get probed at the moment the
        // last in-flight response detaches, not just on the slow tick.
        void checkPredicates("connection-zero")
      }
    }
    // Fire on whichever close event arrives first — Set delete is
    // idempotent so duplicate fires are harmless.
    //
    //   - Node: `res.on("close")` fires on `res.end()` AND on client
    //     disconnect during streaming.
    //   - Bun (1.3.x): `res.on("close")` fires on `res.end()` for short
    //     responses but NOT on client disconnect for streaming responses
    //     (oven-sh/bun#7716). `req.on("close")` DOES fire reliably in
    //     both cases on Bun, so we listen there too.
    //
    // Using both ensures the lease drops promptly on either runtime,
    // regardless of which signal the runtime chooses to honor.
    res.once("close", drop)
    req.once("close", drop)
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Track this request as the lease. See `activeResponses` doc above for
    // why we track at the response level rather than the socket level.
    trackResponse(req, res)

    const url = req.url ?? "/"
    if (req.method === "GET" && url.startsWith("/healthz")) {
      // Optional `?stream=<ms>` opens a streaming response that stays open
      // for up to <ms> milliseconds, or until the client disconnects.
      // Pings are written every 100ms so the response stream stays live
      // (Node/Bun keep `res.on("close")` armed for the whole window).
      // Realistic use: liveness probe + lease-take in one round trip
      // (e.g. an external supervisor wanting to verify the plugin is up
      // AND hold the lease for a brief grace window). Test use: take a
      // deterministic, runtime-independent lease without dragging the
      // MCP SDK into lifecycle assertions.
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
      // Hand off to the MCP SDK transport. The web-standard transport
      // takes a Request and returns a Response; we bridge to/from Node's
      // IncomingMessage/ServerResponse with a small adapter (`toWebRequest`
      // + `writeWebResponse`). No `@hono/node-server` in the path — fewer
      // moving pieces, easier to debug.
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
   * Probe whether `path` is a live Unix socket (something is `accept()`-ing).
   * If `connect()` succeeds → live; if it fails → stale (or absent). We use
   * this to decide whether a leftover socket file is safe to unlink before
   * we bind.
   *
   * Best-effort with a short timeout — never hangs daemon startup.
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
   * Bind-before-publish:
   *
   *   1. Create parent dir if missing.
   *   2. If a socket file already exists at `socketPath`, probe it. If
   *      something is alive, error out — we don't trample a running peer.
   *      Otherwise unlink it (stale).
   *   3. Bind the HTTP server to a temp path inside the same dir.
   *   4. chmod 0600 on the temp path (owner-only access).
   *   5. Atomic `rename(temp → published)`.
   *
   * Step (4) before step (5) means the published path is never world-
   * readable, even briefly.
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
        /* ignore — race with another startup is fine */
      }
    }

    // Temp path: hidden, randomized, in the same dir so `rename()` is atomic
    // (POSIX guarantees same-filesystem rename atomicity).
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

    // Publish atomically. If another process raced us to the published
    // path, `rename` will replace whatever's there — but since we already
    // probed-and-unlinked above, that's a benign last-writer-wins.
    renameSync(tempPath, socketPath)
    log.info?.(`mcp plugin listening on unix:${socketPath}`)
  }

  function start(): void {
    if (httpServer !== null) throw new Error("mcp plugin already started")

    abortCtl = new AbortController()
    timers = createTimers(abortCtl.signal)

    // SIGTERM → predicate. NOT a process.exit — the daemon owns shutdown.
    const onSigterm = (): void => {
      sigtermReceived = true
      void checkPredicates("sigterm")
    }
    process.on("SIGTERM", onSigterm)
    abortCtl.signal.addEventListener("abort", () => process.off("SIGTERM", onSigterm), { once: true })

    // bindAndPublish is async; surface bind errors via log + abort — the
    // daemon's plugin loader doesn't await start(), and a thrown error
    // here would just trigger an unhandled rejection.
    bindAndPublish().catch((err: unknown) => {
      log.error?.(`bindAndPublish failed: ${err instanceof Error ? err.message : err}`)
      abortCtl?.abort()
    })

    // Slow tick — predicates that don't have a natural event get checked here.
    timers.setInterval(() => {
      void checkPredicates("poll")
    }, pollIntervalMs)

    // No connections at start → arm immediately.
    armIdleTimer()
  }

  function stop(): void {
    abortCtl?.abort()
    cancelIdleTimer()
    // End any in-flight responses so the server can shut down promptly.
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
    // Close every per-session transport. Transport.close() returns a
    // promise but we don't need to await — http.Server.close() finishes
    // the cleanup synchronously enough for shutdown.
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
    // Unlink the published socket so a restart doesn't trip the "already
    // in use" probe. Best-effort — a dead listener leaves a stale file
    // that the next start() will clean up anyway.
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
      // Unix sockets are universally available on the platforms tribe
      // supports; no external dependency to probe.
      return true
    },

    start(_api: TribeClientApi) {
      start()
      return () => stop()
    },

    registerQuitPredicate(fn: QuitPredicate) {
      register(fn, "user")
    },

    getAddress() {
      // Listening implies the file exists. We treat "no server" as not
      // started; tests poll on this to wait for bind-and-publish.
      if (httpServer === null || !httpServer.listening) return null
      // Until rename completes the published path may not exist; expose
      // the address only once the published path is in place.
      if (!existsSync(socketPath)) return null
      return { socketPath }
    },

    getConnectionCount() {
      return activeResponses.size
    },

    events,
  }

  return handle
}
