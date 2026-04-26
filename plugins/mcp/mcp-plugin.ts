/**
 * MCP-as-tribe-plugin — prototype.
 *
 * One long-running HTTP+SSE MCP server, shared across Claude Code sessions,
 * hosted as a plugin on the tribe daemon. This is the lifecycle skeleton —
 * tool implementations and migration of existing stdio MCPs follow in later
 * beads.
 *
 * # Why one daemon, not one-per-session
 *
 * Today every Claude Code session spawns its own MCP servers via stdio. With
 * N sessions × M servers, startup latency, FD pressure, and lifecycle bugs
 * (orphaned children, double-close, PID exhaustion) all scale linearly. A
 * shared MCP daemon drops that to one process per machine.
 *
 * # Connection-as-lease
 *
 * The active SSE-connection count IS the lease. No `lease()` API, no
 * reference-count dance, no handshake — Claude Code clients just connect
 * over SSE and the connection itself is the "I'm using this" signal.
 *
 * - Last connection drops → arm idle-quit timer (default 30 min, configurable)
 * - New connection arrives → cancel the timer
 * - Timer fires → predicate returns true → daemon shuts down
 *
 * Liveness check from outside: `connect to the socket`. If it answers, it's
 * alive. No pidfile, no handshake, no reaper.
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
 * # Wire (prototype scope)
 *
 *   GET  /healthz   — 200 "ok\n"
 *   GET  /sse       — text/event-stream; each connect joins the active set
 *   POST /rpc       — JSON-RPC; right now only `tools/list` → { tools: [] }
 *
 * Bound to a Unix socket (mode 0600, bind-before-publish). The MCP wire is
 * loopback in spirit — only processes on the same machine that can read the
 * socket file can talk to it. Claude Code's HTTP MCP client supports `unix:`
 * URIs, so consumers point at the socket directly.
 *
 * The MCP SDK's StreamableHttp/SSE transports are deliberately NOT used
 * here — this prototype validates the LIFECYCLE design (lease / predicate
 * composition / clean shutdown) and stays small enough to read in one
 * sitting. Wire upgrade to the MCP SDK is a one-file follow-up.
 *
 * @see tools/lib/tribe/plugin-api.ts — TribePluginApi shape
 * @see tools/lib/tribe/socket.ts     — XDG socket-path resolver we mirror
 * @see tools/lib/tribe/git-plugin.ts — minimal plugin example
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http"
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs"
import { createConnection } from "node:net"
import { dirname, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { createLogger } from "loggily"
import type { TribePluginApi, TribeClientApi } from "../../tools/lib/tribe/plugin-api.ts"
import { createTimers } from "../../tools/lib/tribe/timers.ts"

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

export interface McpPluginOptions {
  /**
   * Called when a registered quit predicate returns true. The daemon's own
   * shutdown path should subscribe via this callback. The plugin does NOT
   * call `process.exit()` — shutdown is the daemon's responsibility.
   *
   * @param reason  short human-readable diagnostic, e.g. "idle 30m" or "SIGTERM"
   */
  onRequestQuit?: (reason: string) => void

  /**
   * Idle-quit window — how long after the last SSE connection drops before
   * the idle predicate flips true. Default 30 minutes.
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
   * Hook tests reach for to register custom predicates BEFORE start(),
   * without needing to touch the global `registerQuitPredicate` export.
   */
  initialPredicates?: QuitPredicate[]
}

export interface McpPluginHandle extends TribePluginApi {
  /**
   * Register an additional quit predicate AFTER start() has been called.
   * Predicates are called from the slow tick AND on connection-count-zero
   * transitions, so `register → idle drop → predicate fires → onRequestQuit`
   * is observable within `pollIntervalMs`.
   */
  registerQuitPredicate(fn: QuitPredicate): void

  /**
   * The bound Unix socket path — only meaningful AFTER start() has been
   * called. Returns `null` if the server isn't listening (not started, or
   * stopped).
   */
  getAddress(): { socketPath: string } | null

  /**
   * Active SSE-connection count — primarily for tests and observability.
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
  const onRequestQuit = opts.onRequestQuit ?? (() => {})

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
  // Connection tracking + idle-quit
  // ------------------------------------------------------------------------

  const connections = new Set<ServerResponse>()
  let idleTimerFired = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  function armIdleTimer(): void {
    if (idleTimer !== null) return
    idleTimer = setTimeout(() => {
      idleTimerFired = true
      idleTimer = null
      // Probe predicates immediately so onRequestQuit fires without
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
          onRequestQuit(label)
          return
        }
      } catch (err) {
        log.warn?.(`predicate ${label} threw: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  // ------------------------------------------------------------------------
  // HTTP wire
  // ------------------------------------------------------------------------

  let server: Server | null = null
  let abortCtl: AbortController | null = null
  let timers: ReturnType<typeof createTimers> | null = null

  function handleSse(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Disable buffering on intermediaries (defense-in-depth even on
      // Unix-socket — a future sidecar relay shouldn't break SSE).
      "X-Accel-Buffering": "no",
    })
    // SSE preamble — comment line keeps the connection warm if the first
    // event takes a while to arrive.
    res.write(": connected\n\n")

    connections.add(res)
    cancelIdleTimer()
    log.debug?.(`sse connect (count=${connections.size})`)

    const drop = (): void => {
      if (!connections.delete(res)) return
      log.debug?.(`sse disconnect (count=${connections.size})`)
      if (connections.size === 0) {
        armIdleTimer()
        // Event-driven check: predicates that watch external state
        // (parent gone, quota exhausted) get probed at the moment a
        // session detaches, not just on the slow tick.
        void checkPredicates("connection-zero")
      }
    }
    res.on("close", drop)
    res.on("error", drop)
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
    }
    return Buffer.concat(chunks).toString("utf8")
  }

  async function handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: string
    try {
      body = await readBody(req)
    } catch (err) {
      writeJson(res, 400, { error: { code: -32700, message: `read error: ${err}` } })
      return
    }

    let msg: { id?: string | number; method?: string; params?: unknown }
    try {
      msg = JSON.parse(body) as typeof msg
    } catch (err) {
      writeJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: `parse error: ${err}` } })
      return
    }

    const { id = null, method } = msg
    if (method === "tools/list") {
      // Skeleton: real tools come in a follow-up bead.
      writeJson(res, 200, { jsonrpc: "2.0", id, result: { tools: [] } })
      return
    }

    writeJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } })
  }

  function writeJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(body))
  }

  function dispatch(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/"
    if (req.method === "GET" && url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.end("ok\n")
      return
    }
    if (req.method === "GET" && url === "/sse") {
      handleSse(req, res)
      return
    }
    if (req.method === "POST" && url === "/rpc") {
      void handleRpc(req, res)
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

    server = createServer(dispatch)
    await new Promise<void>((resolveListen, reject) => {
      const onError = (err: Error): void => reject(err)
      server!.once("error", onError)
      server!.listen(tempPath, () => {
        server!.removeListener("error", onError)
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
    if (server !== null) throw new Error("mcp plugin already started")

    abortCtl = new AbortController()
    timers = createTimers(abortCtl.signal)

    // SIGTERM → predicate. NOT a process.exit — the daemon owns shutdown.
    const onSigterm = (): void => {
      sigtermReceived = true
      void checkPredicates("sigterm")
    }
    process.on("SIGTERM", onSigterm)
    abortCtl.signal.addEventListener("abort", () => process.off("SIGTERM", onSigterm), { once: true })

    // bindAndPublish is async; surface bind errors via console + abort —
    // the daemon's plugin loader doesn't await start(), and a thrown error
    // here would just trigger unhandled rejection.
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
    // Force-close active SSE responses so the server can shut down.
    for (const res of connections) {
      try {
        res.end()
      } catch {
        /* already closed */
      }
    }
    connections.clear()
    if (server !== null) {
      const s = server
      server = null
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
      if (server === null || !server.listening) return null
      // Until rename completes the published path may not exist; expose
      // the address only once the published path is in place.
      if (!existsSync(socketPath)) return null
      return { socketPath }
    },

    getConnectionCount() {
      return connections.size
    },
  }

  return handle
}
