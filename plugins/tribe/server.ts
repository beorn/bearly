#!/usr/bin/env bun
// @bun
const __using = (stack, value, async) => {
  if (value != null) {
    if (typeof value !== "object" && typeof value !== "function")
      throw TypeError('Object expected to be assigned to "using" declaration')
    let dispose
    if (async) dispose = value[Symbol.asyncDispose]
    if (dispose === undefined) dispose = value[Symbol.dispose]
    if (typeof dispose !== "function") throw TypeError("Object not disposable")
    stack.push([async, dispose, value])
  } else if (async) {
    stack.push([async])
  }
  return value
}
const __callDispose = (stack, error, hasError) => {
  const fail = (e) =>
      (error = hasError
        ? new SuppressedError(e, error, "An error was suppressed during disposal")
        : ((hasError = true), e)),
    next = (it) => {
      while ((it = stack.pop())) {
        try {
          const result = it[1]?.call(it[2])
          if (it[0]) return Promise.resolve(result).then(next, (e) => (fail(e), next()))
        } catch (e) {
          fail(e)
        }
      }
      if (hasError) throw error
    }
  return next()
}

// tools/lib/tribe/config.ts
import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync } from "fs"
import { basename, dirname, resolve } from "path"
import { parseArgs } from "util"
function parseTribeArgs() {
  const { values } = parseArgs({
    options: {
      name: { type: "string", default: process.env.TRIBE_NAME },
      role: { type: "string", default: process.env.TRIBE_ROLE },
      domains: { type: "string", default: process.env.TRIBE_DOMAINS ?? "" },
      db: { type: "string", default: process.env.TRIBE_DB },
      socket: { type: "string", default: process.env.TRIBE_SOCKET },
      "auto-report": { type: "boolean", default: (process.env.TRIBE_AUTO_REPORT ?? "1") === "1" },
    },
    strict: false,
  })
  return values
}
function parseSessionDomains(args) {
  return String(args.domains ?? "")
    .split(",")
    .filter(Boolean)
}
function findBeadsDir(from) {
  let dir = from ?? process.cwd()
  while (dir !== "/") {
    const candidate = resolve(dir, ".beads")
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  return null
}
function resolveProjectName(cwd) {
  const dir = cwd ?? process.cwd()
  const beadsDir = findBeadsDir(dir)
  if (beadsDir) {
    const projectRoot = dirname(beadsDir)
    const depth = dir.replace(projectRoot, "").split("/").filter(Boolean).length
    if (depth <= 2) {
      const configPath = resolve(beadsDir, "config.yaml")
      if (existsSync(configPath)) {
        try {
          const content = readFileSync(configPath, "utf-8")
          const match = content.match(/^project:\s*["']?(\w+)["']?/m)
          if (match?.[1]) return match[1].toLowerCase()
        } catch {}
      }
      return basename(projectRoot).toLowerCase()
    }
  }
  return basename(dir).toLowerCase()
}
function resolveClaudeSessionId() {
  return process.env.CLAUDE_SESSION_ID ?? process.env.BD_ACTOR?.replace("claude:", "") ?? null
}
function resolveClaudeSessionName() {
  return process.env.CLAUDE_SESSION_NAME ?? null
}
function resolveProjectId(cwd) {
  const dir = cwd ?? process.cwd()
  try {
    const real = realpathSync(dir)
    return createHash("sha256").update(real).digest("hex").slice(0, 12)
  } catch {
    return createHash("sha256").update(dir).digest("hex").slice(0, 12)
  }
}

// tools/lib/tribe/socket.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, unlinkSync, readFileSync as readFileSync2 } from "fs"
import { resolve as resolve2, dirname as dirname2 } from "path"
import { createConnection } from "net"
import { spawn } from "child_process"

// ../loggily/src/colors.ts
const _process = typeof process !== "undefined" ? process : undefined
const enabled =
  _process?.env?.["FORCE_COLOR"] !== undefined && _process?.env?.["FORCE_COLOR"] !== "0"
    ? true
    : _process?.env?.["NO_COLOR"] !== undefined
      ? false
      : (_process?.stdout?.isTTY ?? false)
function wrap(open, close) {
  if (!enabled) return (str) => str
  return (str) => open + str + close
}
const colors = {
  dim: wrap("\x1B[2m", "\x1B[22m"),
  blue: wrap("\x1B[34m", "\x1B[39m"),
  yellow: wrap("\x1B[33m", "\x1B[39m"),
  red: wrap("\x1B[31m", "\x1B[39m"),
  magenta: wrap("\x1B[35m", "\x1B[39m"),
  cyan: wrap("\x1B[36m", "\x1B[39m"),
}

// ../loggily/src/tracing.ts
const currentIdFormat = "simple"
let simpleSpanCounter = 0
let simpleTraceCounter = 0
function randomHex(bytes) {
  const uuid = crypto.randomUUID().replace(/-/g, "")
  return uuid.slice(0, bytes * 2)
}
function generateSpanId() {
  if (currentIdFormat === "w3c") {
    return randomHex(8)
  }
  return `sp_${(++simpleSpanCounter).toString(36)}`
}
function generateTraceId() {
  if (currentIdFormat === "w3c") {
    return randomHex(16)
  }
  return `tr_${(++simpleTraceCounter).toString(36)}`
}
const sampleRate = 1
function shouldSample() {
  if (sampleRate >= 1) return true
  if (sampleRate <= 0) return false
  return Math.random() < sampleRate
}

// ../loggily/src/core.ts
const _process2 = typeof process !== "undefined" ? process : undefined
function getEnv(key) {
  return _process2?.env?.[key]
}
function writeStderr(text) {
  if (_process2?.stderr?.write) {
    _process2.stderr.write(
      text +
        `
`,
    )
  } else {
    console.error(text)
  }
}
const writers = []
const suppressConsole = false
const outputMode = "console"
const LOG_LEVEL_PRIORITY = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  silent: 5,
}
const envLogLevel = getEnv("LOG_LEVEL")?.toLowerCase()
let currentLogLevel =
  envLogLevel === "trace" ||
  envLogLevel === "debug" ||
  envLogLevel === "info" ||
  envLogLevel === "warn" ||
  envLogLevel === "error" ||
  envLogLevel === "silent"
    ? envLogLevel
    : "info"
const traceEnv = getEnv("TRACE")
let spansEnabled = traceEnv === "1" || traceEnv === "true"
let traceFilter = null
if (traceEnv && traceEnv !== "1" && traceEnv !== "true") {
  traceFilter = new Set(traceEnv.split(",").map((s) => s.trim()))
  spansEnabled = true
}
function parseNamespaceFilter(input) {
  const includeList = []
  const excludeList = []
  for (const part of input) {
    if (part.startsWith("-")) {
      excludeList.push(part.slice(1))
    } else {
      includeList.push(part)
    }
  }
  return {
    includes: includeList.length > 0 ? new Set(includeList) : null,
    excludes: excludeList.length > 0 ? new Set(excludeList) : null,
  }
}
const debugEnv = getEnv("DEBUG")
let debugIncludes = null
let debugExcludes = null
if (debugEnv) {
  const parts = debugEnv.split(",").map((s) => s.trim())
  const parsed = parseNamespaceFilter(parts)
  debugIncludes = parsed.includes
  if (debugIncludes && [...debugIncludes].some((p) => p === "*" || p === "1" || p === "true")) {
    debugIncludes = new Set(["*"])
  }
  debugExcludes = parsed.excludes
  if (LOG_LEVEL_PRIORITY[currentLogLevel] > LOG_LEVEL_PRIORITY.debug) {
    currentLogLevel = "debug"
  }
}
const envLogFormat = getEnv("LOG_FORMAT")?.toLowerCase()
const currentLogFormat = envLogFormat === "json" ? "json" : envLogFormat === "console" ? "console" : "console"
function useJsonFormat() {
  return currentLogFormat === "json" || getEnv("NODE_ENV") === "production" || getEnv("TRACE_FORMAT") === "json"
}
const _getContextTags = null
const _getContextParent = null
const _enterContext = null
const _exitContext = null
function shouldLog(level) {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLogLevel]
}
function shouldTraceNamespace(namespace) {
  if (!spansEnabled) return false
  if (!traceFilter) return true
  return matchesNamespaceSet(namespace, traceFilter)
}
function safeStringify(value) {
  const seen = new WeakSet()
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "bigint") return val.toString()
    if (typeof val === "symbol") return val.toString()
    if (val instanceof Error) return { message: val.message, stack: val.stack, name: val.name }
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]"
      seen.add(val)
    }
    return val
  })
}
function formatConsole(namespace, level, message, data) {
  const time = colors.dim(new Date().toISOString().split("T")[1]?.split(".")[0] || "")
  let levelStr = ""
  switch (level) {
    case "trace":
      levelStr = colors.dim("TRACE")
      break
    case "debug":
      levelStr = colors.dim("DEBUG")
      break
    case "info":
      levelStr = colors.blue("INFO")
      break
    case "warn":
      levelStr = colors.yellow("WARN")
      break
    case "error":
      levelStr = colors.red("ERROR")
      break
    case "span":
      levelStr = colors.magenta("SPAN")
      break
  }
  const ns = colors.cyan(namespace)
  let output = `${time} ${levelStr} ${ns} ${message}`
  if (data && Object.keys(data).length > 0) {
    output += ` ${colors.dim(safeStringify(data))}`
  }
  return output
}
function formatJSON(namespace, level, message, data) {
  const entry = {
    time: new Date().toISOString(),
    level,
    name: namespace,
    msg: message,
    ...data,
  }
  return safeStringify(entry)
}
function matchesNamespaceSet(namespace, set) {
  if (set.has("*")) return true
  for (const filter of set) {
    if (namespace === filter || namespace.startsWith(filter + ":")) {
      return true
    }
  }
  return false
}
function shouldDebugNamespace(namespace) {
  if (!debugIncludes && !debugExcludes) return true
  if (debugExcludes && matchesNamespaceSet(namespace, debugExcludes)) {
    return false
  }
  if (debugIncludes) return matchesNamespaceSet(namespace, debugIncludes)
  return true
}
function resolveMessage(msg) {
  return typeof msg === "function" ? msg() : msg
}
function writeLog(namespace, level, message, data) {
  if (!shouldLog(level)) return
  if (!shouldDebugNamespace(namespace)) return
  const resolved = resolveMessage(message)
  const contextTags = _getContextTags?.()
  const mergedData = contextTags && Object.keys(contextTags).length > 0 ? { ...contextTags, ...data } : data
  const formatted = useJsonFormat()
    ? formatJSON(namespace, level, resolved, mergedData)
    : formatConsole(namespace, level, resolved, mergedData)
  for (const w of writers) w(formatted, level)
  if (suppressConsole || outputMode === "writers-only") return
  if (outputMode === "stderr") {
    writeStderr(formatted)
    return
  }
  switch (level) {
    case "trace":
    case "debug":
      console.debug(formatted)
      break
    case "info":
      console.info(formatted)
      break
    case "warn":
      console.warn(formatted)
      break
    case "error":
      console.error(formatted)
      break
  }
}
function writeSpan(namespace, duration, attrs) {
  if (!shouldTraceNamespace(namespace)) return
  if (!shouldDebugNamespace(namespace)) return
  const message = `(${duration}ms)`
  const formatted = useJsonFormat()
    ? formatJSON(namespace, "span", message, { duration, ...attrs })
    : formatConsole(namespace, "span", message, { duration, ...attrs })
  for (const w of writers) w(formatted, "span")
  if (!suppressConsole) writeStderr(formatted)
}
function createSpanDataProxy(getFields, attrs) {
  const READONLY_KEYS = new Set(["id", "traceId", "parentId", "startTime", "endTime", "duration"])
  return new Proxy(attrs, {
    get(_target, prop) {
      if (READONLY_KEYS.has(prop)) {
        return getFields()[prop]
      }
      return attrs[prop]
    },
    set(_target, prop, value) {
      if (READONLY_KEYS.has(prop)) {
        return false
      }
      attrs[prop] = value
      return true
    },
  })
}
function createLoggerImpl(name, props, spanMeta, parentSpanId, traceId, traceSampled = true) {
  const log = (level, msgOrError, data) => {
    if (msgOrError instanceof Error) {
      const err = msgOrError
      writeLog(name, level, err.message, {
        ...props,
        ...data,
        error_type: err.name,
        error_stack: err.stack,
        error_code: err.code,
      })
    } else {
      writeLog(name, level, msgOrError, { ...props, ...data })
    }
  }
  const logger = {
    name,
    props: Object.freeze({ ...props }),
    get spanData() {
      if (!spanMeta) return null
      return createSpanDataProxy(
        () => ({
          id: spanMeta.id,
          traceId: spanMeta.traceId,
          parentId: spanMeta.parentId,
          startTime: spanMeta.startTime,
          endTime: spanMeta.endTime,
          duration: spanMeta.endTime !== null ? spanMeta.endTime - spanMeta.startTime : Date.now() - spanMeta.startTime,
        }),
        spanMeta.attrs,
      )
    },
    trace: (msg, data) => log("trace", msg, data),
    debug: (msg, data) => log("debug", msg, data),
    info: (msg, data) => log("info", msg, data),
    warn: (msg, data) => log("warn", msg, data),
    error: (msgOrError, data) => log("error", msgOrError, data),
    logger(namespace, childProps) {
      const childName = namespace ? `${name}:${namespace}` : name
      const mergedProps = { ...props, ...childProps }
      return createLoggerImpl(childName, mergedProps, null, parentSpanId, traceId, traceSampled)
    },
    span(namespace, childProps) {
      const childName = namespace ? `${name}:${namespace}` : name
      const mergedProps = { ...props, ...childProps }
      const newSpanId = generateSpanId()
      let resolvedParentId = parentSpanId
      let resolvedTraceId = traceId
      if (!resolvedParentId && _getContextParent) {
        const ctxParent = _getContextParent()
        if (ctxParent) {
          resolvedParentId = ctxParent.spanId
          resolvedTraceId = resolvedTraceId || ctxParent.traceId
        }
      }
      const isNewTrace = !resolvedTraceId
      const finalTraceId = resolvedTraceId || generateTraceId()
      const sampled = isNewTrace ? shouldSample() : traceSampled
      const newSpanData = {
        id: newSpanId,
        traceId: finalTraceId,
        parentId: resolvedParentId,
        startTime: Date.now(),
        endTime: null,
        duration: null,
        attrs: {},
      }
      const spanLogger = createLoggerImpl(childName, mergedProps, newSpanData, newSpanId, finalTraceId, sampled)
      _enterContext?.(newSpanId, finalTraceId, resolvedParentId)
      spanLogger[Symbol.dispose] = () => {
        if (newSpanData.endTime !== null) return
        newSpanData.endTime = Date.now()
        newSpanData.duration = newSpanData.endTime - newSpanData.startTime
        if (collectSpans) {
          collectedSpans.push(
            createSpanDataProxy(
              () => ({
                id: newSpanData.id,
                traceId: newSpanData.traceId,
                parentId: newSpanData.parentId,
                startTime: newSpanData.startTime,
                endTime: newSpanData.endTime,
                duration: newSpanData.duration,
              }),
              { ...newSpanData.attrs },
            ),
          )
        }
        _exitContext?.(newSpanId)
        if (sampled) {
          writeSpan(childName, newSpanData.duration, {
            span_id: newSpanData.id,
            trace_id: newSpanData.traceId,
            parent_id: newSpanData.parentId,
            ...mergedProps,
            ...newSpanData.attrs,
          })
        }
      }
      return spanLogger
    },
    child(context) {
      if (typeof context === "string") {
        return this.logger(context)
      }
      return createLoggerImpl(name, { ...props, ...context }, null, parentSpanId, traceId, traceSampled)
    },
    end() {
      if (spanMeta?.endTime === null) {
        this[Symbol.dispose]?.()
      }
    },
  }
  return logger
}
function createPlainLogger(name, props) {
  return createLoggerImpl(name, props || {}, null, null, null)
}
const collectedSpans = []
const collectSpans = false
function createLogger(name, props) {
  const baseLog = createPlainLogger(name, props)
  return new Proxy(baseLog, {
    get(target, prop) {
      if (prop in LOG_LEVEL_PRIORITY && prop !== "silent") {
        const current = LOG_LEVEL_PRIORITY[currentLogLevel]
        if (LOG_LEVEL_PRIORITY[prop] < current) {
          return
        }
      }
      return target[prop]
    },
  })
}
// tools/lib/tribe/timers.ts
function createTimers(signal) {
  const timeouts = new Set()
  const intervals = new Set()
  signal.addEventListener(
    "abort",
    () => {
      for (const t of timeouts) globalThis.clearTimeout(t)
      for (const t of intervals) globalThis.clearInterval(t)
      timeouts.clear()
      intervals.clear()
    },
    { once: true },
  )
  return {
    setTimeout(fn, ms) {
      if (signal.aborted) return null
      const t = globalThis.setTimeout(() => {
        timeouts.delete(t)
        if (!signal.aborted) fn()
      }, ms)
      t.unref?.()
      timeouts.add(t)
      return t
    },
    setInterval(fn, ms) {
      if (signal.aborted) return null
      const t = globalThis.setInterval(() => {
        if (signal.aborted) {
          globalThis.clearInterval(t)
          intervals.delete(t)
          return
        }
        fn()
      }, ms)
      t.unref?.()
      intervals.add(t)
      return t
    },
    clearTimeout(t) {
      globalThis.clearTimeout(t)
      timeouts.delete(t)
    },
    clearInterval(t) {
      globalThis.clearInterval(t)
      intervals.delete(t)
    },
    delay(ms) {
      return new Promise((resolve2, reject) => {
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        const t = globalThis.setTimeout(resolve2, ms)
        t.unref?.()
        timeouts.add(t)
        signal.addEventListener(
          "abort",
          () => {
            globalThis.clearTimeout(t)
            timeouts.delete(t)
            reject(signal.reason)
          },
          { once: true },
        )
      })
    },
  }
}

// tools/lib/tribe/socket.ts
const log = createLogger("tribe:socket")
const TRIBE_PROTOCOL_VERSION = 2
function resolveSocketPath(socketArg) {
  if (socketArg) return socketArg
  if (process.env.TRIBE_SOCKET) return process.env.TRIBE_SOCKET
  const xdg = process.env.XDG_RUNTIME_DIR
  return xdg ? resolve2(xdg, "tribe.sock") : resolve2(process.env.HOME ?? "/tmp", ".local/share/tribe/tribe.sock")
}
function resolvePeerSocketPath(sessionId) {
  const xdg = process.env.XDG_RUNTIME_DIR
  const dir = xdg ?? resolve2(process.env.HOME ?? "/tmp", ".local/share/tribe")
  return resolve2(dir, `s-${sessionId.slice(0, 12)}.sock`)
}
function isRequest(msg) {
  return "method" in msg && "id" in msg
}
function isResponse(msg) {
  return "id" in msg && !("method" in msg)
}
function isNotification(msg) {
  return "method" in msg && !("id" in msg)
}
function makeRequest(id, method, params) {
  return (
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) +
    `
`
  )
}
function makeResponse(id, result) {
  return (
    JSON.stringify({ jsonrpc: "2.0", id, result }) +
    `
`
  )
}
function makeError(id, code, message) {
  return (
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) +
    `
`
  )
}
function makeNotification(method, params) {
  return (
    JSON.stringify({ jsonrpc: "2.0", method, params }) +
    `
`
  )
}
function createLineParser(onMessage) {
  let buffer = ""
  return (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split(`
`)
    buffer = lines.pop()
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        onMessage(JSON.parse(trimmed))
      } catch {
        log.warn?.(`Invalid JSON: ${trimmed.slice(0, 100)}`)
      }
    }
  }
}
function connectToDaemon(socketPath) {
  return new Promise((resolve3, reject) => {
    const socket = createConnection(socketPath)
    const pending = new Map()
    const notificationHandlers = []
    let nextId = 1
    const ac = new AbortController()
    const timers = createTimers(ac.signal)
    const parse = createLineParser((msg) => {
      if (isResponse(msg)) {
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message))
          else p.resolve(msg.result)
        }
      } else if (isNotification(msg)) {
        for (const h of notificationHandlers) h(msg.method, msg.params)
      }
    })
    socket.on("data", parse)
    socket.on("error", reject)
    socket.once("connect", () => {
      socket.removeListener("error", reject)
      socket.on("error", (err) => {
        log.error?.(`Connection error: ${err.message}`)
        for (const [, p] of pending) p.reject(err)
        pending.clear()
      })
      let timeouts = 0
      const client = {
        call(method, params) {
          return new Promise((res, rej) => {
            const id = nextId++
            pending.set(id, { resolve: res, reject: rej })
            socket.write(makeRequest(id, method, params))
            timers.setTimeout(() => {
              if (!pending.delete(id)) return
              rej(new Error(`Request ${method} timed out`))
              if (++timeouts >= 3) {
                log.warn?.(`${timeouts} consecutive timeouts, destroying connection`)
                socket.destroy()
              }
            }, 1e4)
          }).then((v) => {
            timeouts = 0
            return v
          })
        },
        notify(method, params) {
          socket.write(makeNotification(method, params))
        },
        onNotification(handler) {
          notificationHandlers.push(handler)
        },
        close() {
          for (const [, p] of pending) p.reject(new Error("Connection closed"))
          pending.clear()
          ac.abort()
          socket.end()
        },
        socket,
      }
      resolve3(client)
    })
  })
}
async function connectOrStart(socketPath, opts) {
  try {
    return await connectToDaemon(socketPath)
  } catch (err) {
    const code = err.code
    if (code !== "ECONNREFUSED" && code !== "ENOENT") throw err
  }
  if (existsSync2(socketPath)) {
    try {
      unlinkSync(socketPath)
    } catch {}
  }
  const socketDir = dirname2(socketPath)
  if (!existsSync2(socketDir)) mkdirSync2(socketDir, { recursive: true })
  const script = opts?.daemonScript ?? resolve2(dirname2(new URL(import.meta.url).pathname), "../../tribe-daemon.ts")
  const daemonArgs = ["--socket", socketPath]
  if (opts?.dbPath) daemonArgs.push("--db", opts.dbPath)
  const child = spawn(process.execPath, [script, ...daemonArgs], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  })
  child.unref()
  const startupAc = new AbortController()
  const startupTimers = createTimers(startupAc.signal)
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      await startupTimers.delay(Math.min(100 * 2 ** attempt, 2000))
      try {
        return await connectToDaemon(socketPath)
      } catch {}
    }
  } finally {
    startupAc.abort()
  }
  throw new Error(`Failed to connect to tribe daemon at ${socketPath} after starting it`)
}
async function createReconnectingClient(opts) {
  const { socketPath, onConnect, onDisconnect, onReconnect, maxAttempts = 30 } = opts
  let current = await connectOrStart(socketPath)
  await onConnect(current)
  let closed = false
  let reconnectAc = null
  const notificationHandlers = []
  const setupReconnect = () => {
    current.socket.on("close", () => {
      if (closed) return
      onDisconnect?.()
      reconnectAc?.abort()
      reconnectAc = new AbortController()
      const timers = createTimers(reconnectAc.signal)
      ;(async () => {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (closed) return
          const ms = Math.min(500 * 2 ** attempt, 1e4)
          try {
            await timers.delay(ms)
          } catch {
            return
          }
          if (closed) return
          try {
            current = await connectOrStart(socketPath)
            await onConnect(current)
            for (const h of notificationHandlers) current.onNotification(h)
            setupReconnect()
            onReconnect?.()
            return
          } catch {
            log.warn?.(`Reconnect attempt ${attempt + 1} failed`)
          }
        }
        log.error?.(`Failed to reconnect after ${maxAttempts} attempts`)
      })()
    })
  }
  setupReconnect()
  return new Proxy(current, {
    get(_, prop) {
      if (prop === "close")
        return () => {
          closed = true
          reconnectAc?.abort()
          current.close()
          current.socket.unref()
        }
      if (prop === "onNotification")
        return (handler) => {
          notificationHandlers.push(handler)
          current.onNotification(handler)
        }
      return current[prop]
    },
  })
}

// tools/lib/tribe/tools-list.ts
const TOOLS_LIST = [
  {
    name: "tribe_send",
    description: "Send a message to a specific tribe member",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient session name" },
        message: { type: "string", description: "Message content" },
        type: {
          type: "string",
          description: "Message type",
          enum: ["assign", "status", "query", "response", "notify", "request", "verdict"],
          default: "notify",
        },
        bead: { type: "string", description: "Associated bead ID (optional)" },
        ref: { type: "string", description: "Reference to a previous message ID (optional)" },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "tribe_broadcast",
    description: "Broadcast a message to all tribe members",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message content" },
        type: {
          type: "string",
          description: "Message type",
          enum: ["notify", "status"],
          default: "notify",
        },
        bead: { type: "string", description: "Associated bead ID (optional)" },
      },
      required: ["message"],
    },
  },
  {
    name: "tribe_sessions",
    description: "List active tribe sessions with their roles and domains",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Include dead sessions (default: false)" },
      },
    },
  },
  {
    name: "tribe_history",
    description: "View recent message history",
    inputSchema: {
      type: "object",
      properties: {
        with: { type: "string", description: "Filter to messages involving this session" },
        limit: { type: "number", description: "Max messages to return (default: 20)" },
      },
    },
  },
  {
    name: "tribe_rename",
    description: "Rename this session in the tribe",
    inputSchema: {
      type: "object",
      properties: {
        new_name: { type: "string", description: "New session name" },
      },
      required: ["new_name"],
    },
  },
  {
    name: "tribe_health",
    description: "Diagnostic: check for silent members, stale beads, unread messages",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "tribe_join",
    description: "Re-announce this session's name, role, and domains (e.g. after compaction/rejoin)",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name" },
        role: {
          type: "string",
          description: "Session role",
          enum: ["chief", "member"],
        },
        domains: {
          type: "array",
          items: { type: "string" },
          description: "Domain expertise areas (e.g. ['silvery', 'flexily'])",
        },
      },
      required: ["name", "role"],
    },
  },
  {
    name: "tribe_reload",
    description:
      "Hot-reload the tribe MCP server \u2014 re-exec with latest code from disk. Use after tribe code is updated to pick up fixes without restarting the Claude Code session.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why the reload is needed (logged to events)",
        },
      },
    },
  },
  {
    name: "tribe_retro",
    description:
      "Generate a retrospective report analyzing tribe message history, coordination health, and per-member activity",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: 'Duration to look back (e.g. "2h", "30m", "1d"). Default: entire session.',
        },
        format: {
          type: "string",
          description: "Output format",
          enum: ["markdown", "json"],
          default: "markdown",
        },
      },
    },
  },
  {
    name: "tribe_leadership",
    description: "Show the current chief lease holder, term number, and time until expiry",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
]

// tools/lib/tribe/hot-reload.ts
import { createHash as createHash2 } from "crypto"
import { existsSync as existsSync3, readdirSync, readFileSync as readFileSync3, watch } from "fs"
import { dirname as dirname3, resolve as resolve3 } from "path"
import { spawn as spawn2 } from "child_process"
const log2 = createLogger("tribe:reload")
function setupHotReload(opts) {
  const { importMetaUrl, extraFiles = [], extraDirs = [], onReload, logActivity, debounceMs = 500 } = opts
  if (!importMetaUrl.startsWith("file://")) return null
  const scriptPath = new URL(importMetaUrl).pathname
  const reloadScriptName =
    scriptPath
      .split("/")
      .pop()
      ?.replace(/\.(ts|tsx)$/, "") ?? "unknown"
  const sourceDir = dirname3(scriptPath)
  const libTribeDir = resolve3(sourceDir, "lib/tribe")
  if (process.env.__TRIBE_HOT_RELOAD === "1") {
    delete process.env.__TRIBE_HOT_RELOAD
    log2.info?.(`Hot-reloaded: ${reloadScriptName}`)
    logActivity?.("reload", `${reloadScriptName} hot-reloaded`)
  }
  function getSourceFiles() {
    const files = [scriptPath, ...extraFiles]
    const dirs = [libTribeDir, ...extraDirs]
    for (const dir of dirs) {
      try {
        if (existsSync3(dir)) {
          for (const f of readdirSync(dir)) {
            if (f.endsWith(".ts")) files.push(resolve3(dir, f))
          }
        }
      } catch {}
    }
    return files.sort()
  }
  function computeHash() {
    const hash = createHash2("md5")
    for (const f of getSourceFiles()) {
      try {
        hash.update(readFileSync3(f))
      } catch {}
    }
    return hash.digest("hex").slice(0, 12)
  }
  const currentHash = computeHash()
  let debounceTimer = null
  const watchers = []
  function onChange(filename) {
    if (filename && !filename.endsWith(".ts") && !filename.endsWith(".tsx")) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      const newHash = computeHash()
      if (newHash === currentHash) return
      log2.info?.(`Source changed (${currentHash} \u2192 ${newHash}), re-execing`)
      logActivity?.("reload", `${reloadScriptName} reloading (${currentHash} \u2192 ${newHash})`)
      for (const w of watchers) w.close()
      watchers.length = 0
      onReload?.()
      const child = spawn2(process.execPath, process.argv.slice(1), {
        stdio: "inherit",
        env: { ...process.env, __TRIBE_HOT_RELOAD: "1" },
        detached: true,
      })
      child.unref()
      process.exit(0)
    }, debounceMs)
  }
  try {
    watchers.push(watch(sourceDir, { persistent: false }, (_e, f) => onChange(f)))
  } catch {}
  if (existsSync3(libTribeDir)) {
    try {
      watchers.push(watch(libTribeDir, { persistent: false }, (_e, f) => onChange(f)))
    } catch {}
  }
  for (const dir of extraDirs) {
    if (existsSync3(dir)) {
      try {
        watchers.push(watch(dir, { persistent: false }, (_e, f) => onChange(f)))
      } catch {}
    }
  }
  log2.info?.(`Watching ${getSourceFiles().length} source files for hot-reload`)
  return {
    [Symbol.dispose]() {
      if (debounceTimer) clearTimeout(debounceTimer)
      for (const w of watchers) w.close()
    },
  }
}

// tools/tribe-proxy.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { createServer } from "net"
import { existsSync as existsSync4, unlinkSync as unlinkSync2, mkdirSync as mkdirSync3, chmodSync } from "fs"
import { dirname as dirname4 } from "path"
import { spawn as spawn3 } from "child_process"
import { randomUUID } from "crypto"
function sendChannel(content, meta) {
  if (!mcp) return
  mcp.notification({ method: "notifications/claude/channel", params: { content, meta } }).catch(() => {})
}
function startPeerServer() {
  const socketDir = dirname4(PEER_SOCKET_PATH)
  if (!existsSync4(socketDir)) mkdirSync3(socketDir, { recursive: true })
  if (existsSync4(PEER_SOCKET_PATH)) {
    try {
      unlinkSync2(PEER_SOCKET_PATH)
    } catch {}
  }
  const server = createServer((socket) => {
    const parse = createLineParser((msg) => {
      if (!isRequest(msg)) return
      const req = msg
      const { method, params, id } = req
      try {
        switch (method) {
          case "tribe.send": {
            sendChannel(String(params?.content ?? ""), {
              from: String(params?.from ?? "unknown"),
              type: String(params?.type ?? "notify"),
              bead: params?.bead_id ? String(params.bead_id) : undefined,
              message_id: String(params?.message_id ?? randomUUID()),
            })
            socket.write(makeResponse(id, { delivered: true }))
            break
          }
          default:
            socket.write(makeError(id, -32601, `Method not found: ${method}`))
        }
      } catch (err) {
        socket.write(makeError(id, -32603, err instanceof Error ? err.message : String(err)))
      }
    })
    socket.on("data", parse)
    socket.on("error", () => {})
  })
  server.listen(PEER_SOCKET_PATH, () => {
    try {
      chmodSync(PEER_SOCKET_PATH, 384)
    } catch {}
    log3.info?.(`Peer socket listening at ${PEER_SOCKET_PATH}`)
  })
  server.on("error", (err) => {
    log3.warn?.(`Peer server error: ${err.message}`)
  })
  return server
}
async function sendDirect(peerSocketPath, message) {
  try {
    const client = await connectToDaemon(peerSocketPath)
    try {
      await client.call("tribe.send", message)
      return true
    } finally {
      client.close()
    }
  } catch {
    return false
  }
}
async function trySendDirect(a) {
  const target = String(a.to)
  try {
    const discovery = await daemon.call("discover", { name: target })
    const peer = discovery.results.find((r) => r.name === target)
    if (!peer?.peerSocket) return null
    const messageId = randomUUID()
    const sent = await sendDirect(peer.peerSocket, {
      from: myName,
      type: String(a.type ?? "notify"),
      content: String(a.message ?? ""),
      bead_id: a.bead_id ? String(a.bead_id) : undefined,
      message_id: messageId,
    })
    if (!sent) return null
    daemon
      .call("log_event", {
        type: "message.sent",
        meta: { to: target, from: myName, direct: true, message_id: messageId },
      })
      .catch(() => {})
    log3.info?.(`Direct message sent to ${target}`)
    return {
      content: [{ type: "text", text: JSON.stringify({ sent: true, to: target, direct: true }) }],
    }
  } catch {
    return null
  }
}
function cleanupPeerSocket() {
  if (peerServer) {
    peerServer.close()
    peerServer = null
  }
  if (existsSync4(PEER_SOCKET_PATH)) {
    try {
      unlinkSync2(PEER_SOCKET_PATH)
    } catch {}
  }
}
const __stack = []
try {
  var log3 = createLogger("tribe:proxy")
  const proxyAc = new AbortController()
  const timers = createTimers(proxyAc.signal)
  const args = parseTribeArgs()
  const SOCKET_PATH = resolveSocketPath(args.socket)
  const SESSION_DOMAINS = parseSessionDomains(args)
  const CLAUDE_SESSION_ID = resolveClaudeSessionId()
  const CLAUDE_SESSION_NAME = resolveClaudeSessionName()
  log3.info?.(`Connecting to daemon at ${SOCKET_PATH}`)
  var myName = "pending"
  let myRole = "member"
  const mySessionId = randomUUID()
  const PROJECT_NAME = resolveProjectName()
  var PEER_SOCKET_PATH = resolvePeerSocketPath(mySessionId)
  var peerServer = null
  var mcp
  peerServer = startPeerServer()
  const registerParams = {
    ...(args.name ? { name: args.name } : {}),
    ...(args.role ? { role: args.role } : {}),
    domains: SESSION_DOMAINS,
    project: process.cwd(),
    projectName: PROJECT_NAME,
    projectId: resolveProjectId(),
    protocolVersion: TRIBE_PROTOCOL_VERSION,
    peerSocket: PEER_SOCKET_PATH,
    pid: process.pid,
    claudeSessionId: CLAUDE_SESSION_ID,
    claudeSessionName: CLAUDE_SESSION_NAME,
  }
  var daemon = await createReconnectingClient({
    socketPath: SOCKET_PATH,
    async onConnect(client) {
      const reg = await client.call("register", registerParams)
      myName = reg.name
      myRole = reg.role
      log3.info?.(`Registered as ${myName} (${myRole})`)
      client.call("subscribe").catch(() => {})
    },
    onDisconnect() {
      log3.warn?.(`Daemon connection lost`)
    },
    onReconnect() {
      log3.info?.(`Reconnected to daemon`)
    },
  })
  timers.setInterval(() => {
    daemon.call("heartbeat").catch(() => {})
  }, 15000)
  const joinInstruction = `If you receive a tribe-proxy auto-identify message, just call tribe_join with a short name for your focus area and role="member". Do not use "chief" unless explicitly told. No need to call tribe_sessions or tribe_history afterward \u2014 just join silently and continue.`
  const chiefInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are the chief of a tribe \u2014 a coordinator for multiple Claude Code sessions working on the same project.

${joinInstruction}

Coordination protocol:
- Use tribe_sessions() to see who's online and their domains
- Use tribe_send(to, message, type) to assign work, answer queries, or approve requests
- Use tribe_broadcast(message) to announce changes that affect everyone
- Use tribe_health() to check for silent members or conflicts
- When CI alerts arrive, coordinate the fix \u2014 assign the responsible session to investigate

Message format rules:
- Keep messages SHORT \u2014 1-3 lines max. No essays.
- Use plain text only \u2014 no markdown (**bold**, headers, bullets). It renders as ugly escaped text.
- Batch-acknowledge: if you receive many messages at once, one summary covers all.`
  const memberInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are a tribe member \u2014 a worker session coordinated by the chief.

${joinInstruction}

Coordination protocol:
- When you START work on a task, broadcast what you're doing: tribe_send(to="*", message="starting: <task>")
- When you FINISH a task or commit, broadcast: tribe_send(to="*", message="done: <summary>")
- When you claim a bead, broadcast: tribe_send(to="*", message="claimed: <bead-id> \u2014 <title>")
- When you're blocked, broadcast immediately \u2014 include what would unblock you
- Before editing vendor/ or shared files, send a request to chief asking for OK
- Respond to query messages promptly

CI protocol:
- When you see a CI ALERT for a repo you're working on or know about, respond with a fix hint
- Example: tribe_send(to="*", message="hint: termless CI needs vt220.js \u2014 run npm publish from vendor/vt100/packages/vt220")
- If a CI alert DMs you directly, investigate and fix the failure before pushing more code
- After fixing, broadcast: tribe_send(to="*", message="ci-fix: <repo> \u2014 <what you fixed>")

Message format rules:
- Keep messages SHORT \u2014 1-3 lines max. No essays.
- Use plain text only \u2014 no markdown (**bold**, headers, bullets). It renders as ugly escaped text.
- Batch-acknowledge stale messages: "Acknowledged N old messages, no action needed"

Don't over-communicate \u2014 only broadcast when it changes what someone else should know.`
  mcp = new Server(
    { name: "tribe", version: "0.8.1" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: myRole === "chief" ? chiefInstructions : memberInstructions,
    },
  )
  let nudgeSent = false
  mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!nudgeSent && (myName.startsWith("member-") || myName.startsWith("pending-"))) {
      nudgeSent = true
      timers.setTimeout(() => {
        sendChannel(
          `Auto-identify: call tribe_join(name="${myName}", role="member") with a short name for your focus area. Do not use "chief". Do not call tribe_sessions or tribe_history \u2014 just join silently and continue.`,
          { from: "tribe-proxy", type: "system" },
        )
      }, 500)
    }
    return { tools: TOOLS_LIST }
  })
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: toolArgs } = req.params
    const a = toolArgs ?? {}
    try {
      if (name === "tribe_send" && a.to && typeof a.to === "string") {
        const directResult = await trySendDirect(a)
        if (directResult) return directResult
      }
      const result = await daemon.call(name, a)
      if (name === "tribe_join" || name === "tribe_rename") {
        const r = result
        try {
          const data = JSON.parse(r.content[0]?.text ?? "{}")
          if (data.name) myName = data.name
          if (data.role) myRole = data.role
        } catch {}
      }
      return result
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : err}` }],
      }
    }
  })
  const _reload = __using(
    __stack,
    setupHotReload({
      importMetaUrl: import.meta.url,
      logActivity: (type, content) => {
        daemon.call("log_event", { type, content }).catch(() => {})
      },
      onReload: () => {
        proxyAc.abort()
        cleanupPeerSocket()
        daemon.close()
      },
    }),
    0,
  )
  const shutdown = () => {
    proxyAc.abort()
    cleanupPeerSocket()
    daemon.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  process.on("exit", cleanupPeerSocket)
  await mcp.connect(new StdioServerTransport())
  daemon.onNotification((method, params) => {
    if (method === "channel") {
      sendChannel(String(params?.content ?? ""), {
        from: String(params?.from ?? "unknown"),
        type: String(params?.type ?? "notify"),
        bead: params?.bead_id ? String(params.bead_id) : undefined,
        message_id: params?.message_id ? String(params.message_id) : undefined,
      })
    } else if (method === "session.joined" || method === "session.left") {
      const action = method === "session.joined" ? "joined" : "left"
      sendChannel(`${params?.name ?? "unknown"} ${action} the tribe`, { from: "daemon", type: "status" })
    } else if (method === "reload") {
      log3.info?.(`Daemon requests reload: ${params?.reason}`)
      timers.setTimeout(() => {
        daemon.close()
        spawn3(process.execPath, process.argv.slice(1), { stdio: "inherit", env: process.env }).on("exit", (code) =>
          process.exit(code ?? 0),
        )
      }, 500)
    }
  })
} catch (_catch) {
  var _err = _catch,
    _hasErr = 1
} finally {
  __callDispose(__stack, _err, _hasErr)
}
