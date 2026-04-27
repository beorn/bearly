#!/usr/bin/env bun
// @bun
var __using = (stack, value, async) => {
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
var __callDispose = (stack, error, hasError) => {
  let fail = (e) =>
      (error = hasError
        ? new SuppressedError(e, error, "An error was suppressed during disposal")
        : ((hasError = true), e)),
    next = (it) => {
      while ((it = stack.pop())) {
        try {
          var result = it[1] && it[1].call(it[2])
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
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "fs"
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
import { dirname as dirname3, resolve as resolve3 } from "path"

// packages/tribe-client/src/rpc.ts
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
function makeError(id, code, message, data) {
  return (
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } }) +
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
// ../loggily/src/colors.ts
var _process = typeof process !== "undefined" ? process : undefined
var enabled =
  _process?.env?.["FORCE_COLOR"] !== undefined && _process?.env?.["FORCE_COLOR"] !== "0"
    ? true
    : _process?.env?.["NO_COLOR"] !== undefined
      ? false
      : (_process?.stdout?.isTTY ?? false)
function wrap(open, close) {
  if (!enabled) return (str) => str
  return (str) => open + str + close
}
var colors = {
  dim: wrap("\x1B[2m", "\x1B[22m"),
  blue: wrap("\x1B[34m", "\x1B[39m"),
  yellow: wrap("\x1B[33m", "\x1B[39m"),
  red: wrap("\x1B[31m", "\x1B[39m"),
  magenta: wrap("\x1B[35m", "\x1B[39m"),
  cyan: wrap("\x1B[36m", "\x1B[39m"),
}

// ../loggily/src/file-writer.ts
import { openSync, writeSync, closeSync } from "fs"
function createFileWriter(filePath, options = {}) {
  const bufferSize = options.bufferSize ?? 4096
  const flushInterval = options.flushInterval ?? 100
  let buffer = ""
  let fd = null
  let timer = null
  let closed = false
  fd = openSync(filePath, "a")
  function flush() {
    if (buffer.length === 0 || fd === null) return
    const data = buffer
    writeSync(fd, data)
    buffer = ""
  }
  timer = setInterval(flush, flushInterval)
  if (timer && typeof timer === "object" && "unref" in timer) {
    timer.unref()
  }
  const exitHandler = () => flush()
  process.on("exit", exitHandler)
  return {
    write(line) {
      if (closed) return
      buffer +=
        line +
        `
`
      if (buffer.length >= bufferSize) {
        flush()
      }
    },
    flush,
    close() {
      if (closed) return
      closed = true
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      try {
        flush()
      } catch {
      } finally {
        if (fd !== null) {
          closeSync(fd)
          fd = null
        }
        process.removeListener("exit", exitHandler)
      }
    },
  }
}

// ../loggily/src/tracing.ts
var currentIdFormat = "simple"
function setIdFormat(format) {
  currentIdFormat = format
}
var simpleSpanCounter = 0
var simpleTraceCounter = 0
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
var sampleRate = 1
function setSampleRate(rate) {
  if (rate < 0 || rate > 1) {
    throw new Error(`Sample rate must be between 0.0 and 1.0, got ${rate}`)
  }
  sampleRate = rate
}
function shouldSample() {
  if (sampleRate >= 1) return true
  if (sampleRate <= 0) return false
  return Math.random() < sampleRate
}

// ../loggily/src/console-sinks.ts
function isBrowserRuntime() {
  return typeof globalThis?.window !== "undefined" && typeof globalThis.document !== "undefined"
}
function timeStr(time) {
  return new Date(time).toISOString().split("T")[1]?.split(".")[0] ?? ""
}
function levelLabel(level) {
  switch (level) {
    case "trace":
      return "TRACE"
    case "debug":
      return "DEBUG"
    case "info":
      return "INFO"
    case "warn":
      return "WARN"
    case "error":
      return "ERROR"
  }
}
function userArgsOf(event) {
  if ("userArgs" in event && Array.isArray(event.userArgs)) {
    const ua = event.userArgs
    return ua.filter((v) => v !== undefined)
  }
  if (event.props && Object.keys(event.props).length > 0) {
    return [event.props]
  }
  return []
}
function createTerminalConsoleSink(format = "console") {
  if (format === "json") {
    return (event) => routeSingle(event, formatJSONEvent(event))
  }
  return (event) => {
    if (event.kind === "span") {
      writeStderrLine(formatConsoleEvent(event))
      return
    }
    const prefix = `${colors.dim(timeStr(event.time))} ${levelAnsi(event.level)} ${colors.cyan(event.namespace)}`
    const args = userArgsOf(event)
    invokeForLevel(event.level, prefix, event.message, ...args)
  }
}
function writeStderrLine(text) {
  const p = typeof process !== "undefined" ? process : undefined
  if (p?.stderr && typeof p.stderr.write === "function") {
    p.stderr.write(
      text +
        `
`,
    )
    return
  }
  console.info(text)
}
function levelAnsi(level) {
  switch (level) {
    case "trace":
      return colors.dim("TRACE")
    case "debug":
      return colors.dim("DEBUG")
    case "info":
      return colors.blue("INFO")
    case "warn":
      return colors.yellow("WARN")
    case "error":
      return colors.red("ERROR")
  }
}
function createBrowserConsoleSink(format = "console") {
  if (format === "json") {
    return (event) => routeSingle(event, formatJSONEvent(event))
  }
  return (event) => {
    if (event.kind === "span") {
      const spanTemplate = `%c%s %cSPAN %c%s %c(%sms)`
      const args2 = userArgsOf(event)
      const spanPropsString =
        args2.length > 0 ? ` ${safeStringify(Object.assign({}, ...args2.filter(isPlainRecord)))}` : ""
      const { durationLabel } = { durationLabel: String(event.duration) }
      invokeForLevel(
        "info",
        spanTemplate + (spanPropsString ? "%s" : ""),
        cssDim(),
        timeStr(event.time),
        cssSpan(),
        cssNamespace(),
        event.namespace,
        cssDim(),
        durationLabel,
        ...(spanPropsString ? [cssDim(), spanPropsString] : []),
      )
      return
    }
    const template = `%c%s %c%s %c%s`
    const args = userArgsOf(event)
    invokeForLevel(
      event.level,
      template,
      cssDim(),
      timeStr(event.time),
      cssLevel(event.level),
      levelLabel(event.level),
      cssNamespace(),
      event.namespace,
      event.message,
      ...args,
    )
  }
}
function isPlainRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
function cssDim() {
  return "color: #888"
}
function cssNamespace() {
  return "color: #0aa; font-weight: bold"
}
function cssSpan() {
  return "color: #a0a; font-weight: bold"
}
function cssLevel(level) {
  switch (level) {
    case "trace":
    case "debug":
      return "color: #888; font-weight: bold"
    case "info":
      return "color: #36f; font-weight: bold"
    case "warn":
      return "color: #b80; font-weight: bold"
    case "error":
      return "color: #c33; font-weight: bold"
  }
}
function invokeForLevel(level, ...args) {
  switch (level) {
    case "trace":
    case "debug":
      console.debug(...args)
      return
    case "info":
      console.info(...args)
      return
    case "warn":
      console.warn(...args)
      return
    case "error":
      console.error(...args)
      return
  }
}
function routeSingle(event, text) {
  if (event.kind === "span") {
    console.info(text)
    return
  }
  switch (event.level) {
    case "trace":
    case "debug":
      console.debug(text)
      return
    case "info":
      console.info(text)
      return
    case "warn":
      console.warn(text)
      return
    case "error":
      console.error(text)
      return
  }
}
function createConsoleSink(format = "console") {
  return isBrowserRuntime() ? createBrowserConsoleSink(format) : createTerminalConsoleSink(format)
}

// ../loggily/src/pipeline.ts
var LOG_LEVEL_PRIORITY = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  silent: 5,
}
var _process2 = typeof process !== "undefined" ? process : undefined
function getEnv(key) {
  return _process2?.env?.[key]
}
function serializeCause(cause, maxDepth = 3) {
  if (maxDepth <= 0 || cause === undefined || cause === null) return
  if (cause instanceof Error) {
    const result = {
      name: cause.name,
      message: cause.message,
      stack: cause.stack,
    }
    if (cause.code) result.code = cause.code
    if (cause.cause !== undefined) {
      result.cause = serializeCause(cause.cause, maxDepth - 1)
    }
    return result
  }
  return cause
}
function safeStringify(value) {
  const seen = new WeakSet()
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "bigint") return val.toString()
    if (typeof val === "symbol") return val.toString()
    if (val instanceof Error) {
      const result = {
        message: val.message,
        stack: val.stack,
        name: val.name,
      }
      if (val.code) result.code = val.code
      if (val.cause !== undefined) result.cause = serializeCause(val.cause)
      return result
    }
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]"
      seen.add(val)
    }
    return val
  })
}
function formatConsoleEvent(event) {
  const time = colors.dim(new Date(event.time).toISOString().split("T")[1]?.split(".")[0] || "")
  const ns = colors.cyan(event.namespace)
  if (event.kind === "span") {
    const message = `(${event.duration}ms)`
    let output2 = `${time} ${colors.magenta("SPAN")} ${ns} ${message}`
    if (event.props && Object.keys(event.props).length > 0) {
      output2 += ` ${colors.dim(safeStringify(event.props))}`
    }
    return output2
  }
  let levelStr
  switch (event.level) {
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
  }
  let output = `${time} ${levelStr} ${ns} ${event.message}`
  if (event.props && Object.keys(event.props).length > 0) {
    output += ` ${colors.dim(safeStringify(event.props))}`
  }
  return output
}
function formatJSONEvent(event) {
  if (event.kind === "span") {
    return safeStringify({
      time: new Date(event.time).toISOString(),
      level: "span",
      name: event.namespace,
      msg: `(${event.duration}ms)`,
      duration: event.duration,
      span_id: event.spanId,
      trace_id: event.traceId,
      parent_id: event.parentId,
      ...event.props,
    })
  }
  return safeStringify({
    time: new Date(event.time).toISOString(),
    level: event.level,
    name: event.namespace,
    msg: event.message,
    ...event.props,
  })
}
function matchesPattern(namespace, pattern) {
  if (pattern === "*") return true
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2)
    return namespace === prefix || namespace.startsWith(prefix + ":")
  }
  return namespace === pattern || namespace.startsWith(pattern + ":")
}
function parseNsFilter(ns) {
  const patterns = typeof ns === "string" ? ns.split(",").map((s) => s.trim()) : ns
  const includes = []
  const excludes = []
  for (const p of patterns) {
    if (p.startsWith("-")) {
      excludes.push(p.slice(1))
    } else {
      includes.push(p)
    }
  }
  return (namespace) => {
    for (const exc of excludes) {
      if (matchesPattern(namespace, exc)) return false
    }
    if (includes.length > 0) {
      for (const inc of includes) {
        if (matchesPattern(namespace, inc)) return true
      }
      return false
    }
    return true
  }
}
function createConsoleSink2(format) {
  return createConsoleSink(format)
}
function createFileSink(path, format) {
  const writer = createFileWriter(path)
  const formatter = format === "json" ? formatJSONEvent : formatConsoleEvent
  return {
    write: (event) => writer.write(formatter(event)),
    dispose: () => writer.close(),
  }
}
function isNodeStream(obj) {
  return typeof obj === "object" && obj !== null && ("_write" in obj || "writable" in obj || "fd" in obj)
}
function createWritableSink(writable, format) {
  const useObjectMode = writable.objectMode ?? !isNodeStream(writable)
  if (!useObjectMode) {
    const formatter = format === "json" ? formatJSONEvent : formatConsoleEvent
    return (event) =>
      writable.write(
        formatter(event) +
          `
`,
      )
  }
  return (event) => writable.write(event)
}
var VALID_CONFIG_KEYS = new Set(["level", "ns", "format", "spans", "metrics", "idFormat", "sampleRate"])
var SINK_KEYS = new Set(["file", "otel"])
function isPojo(obj) {
  if (typeof obj !== "object" || obj === null) return false
  const proto = Object.getPrototypeOf(obj)
  return proto === Object.prototype || proto === null
}
function isWritable(obj) {
  return typeof obj === "object" && obj !== null && "write" in obj && typeof obj.write === "function"
}
function isValidLogLevel(val) {
  return typeof val === "string" && val in LOG_LEVEL_PRIORITY
}
function buildPipeline(elements, parentConfig) {
  const config = {
    level: parentConfig?.level ?? readEnvLevel(),
    ns: parentConfig?.ns ?? readEnvNs(),
    format: parentConfig?.format ?? readEnvFormat(),
  }
  let spansEnabled = true
  const stages = []
  const outputs = []
  const branches = []
  const disposables = []
  for (const element of elements) {
    if (Array.isArray(element)) {
      const branch = buildPipeline(element, { ...config })
      branches.push(branch)
      disposables.push(() => branch.dispose())
      continue
    }
    if (element === console || element === "console") {
      outputs.push({
        levelPriority: LOG_LEVEL_PRIORITY[config.level],
        nsFilter: config.ns,
        write: createConsoleSink2(config.format),
      })
      continue
    }
    if (typeof element === "function") {
      stages.push(element)
      continue
    }
    if (isWritable(element)) {
      outputs.push({
        levelPriority: LOG_LEVEL_PRIORITY[config.level],
        nsFilter: config.ns,
        write: createWritableSink(element, config.format),
      })
      continue
    }
    if (isPojo(element)) {
      const obj = element
      const keys = Object.keys(obj)
      const hasSinkKey = keys.some((k) => SINK_KEYS.has(k))
      const hasUnknownKey = keys.some((k) => !VALID_CONFIG_KEYS.has(k) && !SINK_KEYS.has(k))
      if (hasUnknownKey) {
        const unknown = keys.find((k) => !VALID_CONFIG_KEYS.has(k) && !SINK_KEYS.has(k))
        throw new Error(
          `loggily: unknown config key "${unknown}" in config object. Valid keys: ${[...VALID_CONFIG_KEYS, ...SINK_KEYS].join(", ")}`,
        )
      }
      if (hasSinkKey) {
        if (typeof obj.file === "string") {
          const outputLevel = isValidLogLevel(obj.level) ? obj.level : config.level
          const outputNs = obj.ns ? parseNsFilter(obj.ns) : config.ns
          const outputFormat = obj.format ?? config.format
          const sink = createFileSink(obj.file, outputFormat)
          disposables.push(sink.dispose)
          outputs.push({
            levelPriority: LOG_LEVEL_PRIORITY[outputLevel],
            nsFilter: outputNs,
            write: sink.write,
            dispose: sink.dispose,
          })
        }
        if (obj.otel !== undefined) {
          throw new Error("loggily: OTEL sink is not yet implemented. See loggily/otel for the planned bridge.")
        }
        continue
      }
      if (isValidLogLevel(obj.level)) config.level = obj.level
      if (obj.ns !== undefined) config.ns = parseNsFilter(obj.ns)
      if (obj.format === "console" || obj.format === "json") config.format = obj.format
      if (obj.spans === true) spansEnabled = true
      if (obj.spans === false) spansEnabled = false
      if (obj.idFormat === "simple" || obj.idFormat === "w3c") setIdFormat(obj.idFormat)
      if (typeof obj.sampleRate === "number") setSampleRate(obj.sampleRate)
      continue
    }
    if (element === "stderr" && typeof process !== "undefined") {
      outputs.push({
        levelPriority: LOG_LEVEL_PRIORITY[config.level],
        nsFilter: config.ns,
        write: createWritableSink(process.stderr, config.format),
      })
      continue
    }
    throw new Error(
      `loggily: unsupported config element of type "${typeof element}". ` +
        'Config arrays accept: objects (config), arrays (branches), functions (stages), console, "console", or writables ({ write }).',
    )
  }
  const dispatch = (event) => {
    if (event.kind === "span" && !spansEnabled) return
    let e = event
    for (const stage of stages) {
      const result = stage(e)
      if (result === null) return
      if (result !== undefined) e = result
    }
    for (const output of outputs) {
      if (e.kind === "log" && LOG_LEVEL_PRIORITY[e.level] < output.levelPriority) continue
      if (output.nsFilter && !output.nsFilter(e.namespace)) continue
      output.write(e)
    }
    for (const branch of branches) {
      branch.dispatch(e)
    }
  }
  return {
    dispatch,
    level: config.level,
    dispose: () => {
      for (const d of disposables) d()
    },
  }
}
function readEnvLevel() {
  const env = getEnv("LOG_LEVEL")?.toLowerCase()
  let level =
    env === "trace" || env === "debug" || env === "info" || env === "warn" || env === "error" || env === "silent"
      ? env
      : "info"
  const debugEnv = getEnv("DEBUG")
  if (debugEnv && LOG_LEVEL_PRIORITY[level] > LOG_LEVEL_PRIORITY.debug) {
    level = "debug"
  }
  return level
}
function readEnvLevelForNamespace(namespace) {
  const env = getEnv("LOG_LEVEL")?.toLowerCase()
  const baseLevel =
    env === "trace" || env === "debug" || env === "info" || env === "warn" || env === "error" || env === "silent"
      ? env
      : "info"
  const debugEnv = getEnv("DEBUG")
  if (debugEnv && LOG_LEVEL_PRIORITY[baseLevel] > LOG_LEVEL_PRIORITY.debug) {
    const nsFilter = readEnvNs()
    if (nsFilter && nsFilter(namespace)) {
      return "debug"
    }
    return baseLevel
  }
  return baseLevel
}
function readEnvNs() {
  const debugEnv = getEnv("DEBUG")
  if (!debugEnv) return null
  const parts = debugEnv.split(",").map((s) => s.trim())
  return parseNsFilter(parts)
}
function readEnvFormat() {
  const envFormat = getEnv("LOG_FORMAT")?.toLowerCase()
  if (envFormat === "json") return "json"
  if (envFormat === "console") return "console"
  if (getEnv("TRACE_FORMAT") === "json") return "json"
  if (getEnv("NODE_ENV") === "production") return "json"
  return "console"
}
function readEnvTrace() {
  const traceEnv = getEnv("TRACE")
  if (!traceEnv) return { enabled: false, filter: null }
  if (traceEnv === "1" || traceEnv === "true") return { enabled: true, filter: null }
  const prefixes = traceEnv.split(",").map((s) => s.trim())
  return {
    enabled: true,
    filter: (namespace) => {
      for (const prefix of prefixes) {
        if (matchesPattern(namespace, prefix)) return true
      }
      return false
    },
  }
}

// ../loggily/src/metrics.ts
function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1)
  return sorted[idx]
}
function computeStats(durations) {
  const sorted = [...durations].sort((a, b) => a - b)
  const total = sorted.reduce((sum, d) => sum + d, 0)
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length > 0 ? total / sorted.length : 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    total,
  }
}
function createMetricsCollector(maxEntries = 1000) {
  const store = new Map()
  return {
    recordSpan(data) {
      let arr = store.get(data.name)
      if (!arr) {
        arr = []
        store.set(data.name, arr)
      }
      arr.push(data.durationMs)
      if (arr.length > maxEntries) arr.shift()
    },
    stats(name) {
      const arr = store.get(name)
      if (!arr || arr.length === 0) return
      return computeStats(arr)
    },
    all() {
      const result = new Map()
      for (const [name, durations] of store) {
        if (durations.length > 0) result.set(name, computeStats(durations))
      }
      return result
    },
    summary() {
      const entries = [...this.all().entries()]
      if (entries.length === 0) return "(no span data)"
      const lines = entries.map(
        ([name, s]) =>
          `${name}: ${s.count} spans, mean=${s.mean.toFixed(1)}ms, p50=${s.p50.toFixed(1)}ms, p95=${s.p95.toFixed(1)}ms, p99=${s.p99.toFixed(1)}ms`,
      )
      return lines.join(`
`)
    },
    reset() {
      store.clear()
    },
  }
}
function withMetrics(collector) {
  return (logger) => {
    return new Proxy(logger, {
      get(target, prop) {
        if (prop === "metrics") {
          return collector
        }
        if (prop === "span") {
          const originalSpan = target.span
          if (!originalSpan) return
          return (namespace, props) => {
            const span = originalSpan.call(target, namespace, props)
            const originalDispose = span[Symbol.dispose]
            span[Symbol.dispose] = () => {
              originalDispose.call(span)
              if (span.spanData?.duration != null) {
                collector.recordSpan({
                  name: span.name,
                  durationMs: span.spanData.duration,
                })
              }
            }
            return span
          }
        }
        if (prop === "child") {
          return (namespaceOrContext, childProps) => {
            const child = target.child(namespaceOrContext, childProps)
            return withMetrics(collector)(child)
          }
        }
        if (prop === "logger") {
          return (namespace, childProps) => {
            const child = target.logger(namespace, childProps)
            return withMetrics(collector)(child)
          }
        }
        return target[prop]
      },
    })
  }
}

// ../loggily/src/core.ts
var _getContextTags = null
var _getContextParent = null
var _enterContext = null
var _exitContext = null
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
var collectedSpans = []
var collectSpans = false
function resolveMessage(msg) {
  return typeof msg === "function" ? msg() : msg
}
function createLoggerImpl(name, props, pipeline) {
  const emitLog = (level, msgOrError, dataOrMsg, extraData) => {
    let message
    let data
    const userArgs = []
    if (msgOrError instanceof Error) {
      const err = msgOrError
      const contextTags = _getContextTags?.() ?? {}
      if (typeof dataOrMsg === "string") {
        message = dataOrMsg
        data = {
          ...contextTags,
          ...props,
          ...extraData,
          error_type: err.name,
          error_message: err.message,
          error_stack: err.stack,
          error_code: err.code,
          error_cause: err.cause !== undefined ? serializeCause(err.cause) : undefined,
        }
      } else {
        message = err.message
        data = {
          ...contextTags,
          ...props,
          ...dataOrMsg,
          error_type: err.name,
          error_stack: err.stack,
          error_code: err.code,
          error_cause: err.cause !== undefined ? serializeCause(err.cause) : undefined,
        }
      }
      userArgs.push(err)
      if (data && Object.keys(data).length > 0) userArgs.push(data)
    } else {
      message = resolveMessage(msgOrError)
      const contextTags = _getContextTags?.()
      data =
        contextTags && Object.keys(contextTags).length > 0
          ? {
              ...contextTags,
              ...props,
              ...dataOrMsg,
            }
          : Object.keys(props).length > 0 || dataOrMsg
            ? { ...props, ...dataOrMsg }
            : undefined
      if (data && Object.keys(data).length > 0) userArgs.push(data)
    }
    const event = {
      kind: "log",
      time: Date.now(),
      namespace: name,
      level,
      message,
      props: data,
      userArgs,
    }
    pipeline.dispatch(event)
  }
  const logger = {
    name,
    props: Object.freeze({ ...props }),
    get level() {
      return pipeline.level
    },
    dispatch(event) {
      pipeline.dispatch(event)
    },
    [Symbol.dispose]() {
      pipeline.dispose()
    },
    trace: (msg, data) => emitLog("trace", msg, data),
    debug: (msg, data) => emitLog("debug", msg, data),
    info: (msg, data) => emitLog("info", msg, data),
    warn: (msg, data) => emitLog("warn", msg, data),
    error: (msgOrError, dataOrMsg, extraData) => emitLog("error", msgOrError, dataOrMsg, extraData),
    logger(namespace, childProps) {
      return this.child(namespace ?? "", childProps)
    },
    span(_namespace, _childProps) {
      throw new Error(
        "loggily: span() requires the withSpans() plugin. Use pipe(baseCreateLogger, withSpans()) or the default createLogger.",
      )
    },
    child(namespaceOrContext, childProps) {
      if (typeof namespaceOrContext === "string") {
        const childName = namespaceOrContext ? `${name}:${namespaceOrContext}` : name
        const mergedProps = { ...props, ...childProps }
        return wrapConditional(createLoggerImpl(childName, mergedProps, pipeline), () => pipeline.level)
      }
      return wrapConditional(
        createLoggerImpl(name, { ...props, ...namespaceOrContext }, pipeline),
        () => pipeline.level,
      )
    },
    end() {},
  }
  return logger
}
function wrapConditional(logger, getLevel) {
  return new Proxy(logger, {
    get(target, prop) {
      if (typeof prop === "string" && prop in LOG_LEVEL_PRIORITY && prop !== "silent") {
        if (LOG_LEVEL_PRIORITY[prop] < LOG_LEVEL_PRIORITY[getLevel()]) {
          return
        }
      }
      if (prop === "span") {
        const val = target[prop]
        if (val === baseSpanStub) return
        return val
      }
      return target[prop]
    },
  })
}
var baseSpanStub = function baseSpanStub2(_namespace, _childProps) {
  throw new Error(
    "loggily: span() requires the withSpans() plugin. Use pipe(baseCreateLogger, withSpans()) or the default createLogger.",
  )
}
function withSpans() {
  return (factory, _ctx) => {
    return (name, configOrProps) => {
      const logger = factory(name, configOrProps)
      return augmentWithSpans(logger, null, null, true)
    }
  }
}
function augmentWithSpans(logger, parentSpanId, traceId, traceSampled) {
  const spanState = { parentSpanId, traceId, traceSampled }
  return new Proxy(logger, {
    get(target, prop) {
      if (prop === "span") {
        return createSpanMethod(target, spanState)
      }
      if (prop === "child") {
        return function child(namespaceOrContext, childProps) {
          const childLogger = target.child(namespaceOrContext, childProps)
          return augmentWithSpans(childLogger, spanState.parentSpanId, spanState.traceId, spanState.traceSampled)
        }
      }
      if (prop === "logger") {
        return function logger2(namespace, childProps) {
          const childLogger = target.logger(namespace, childProps)
          return augmentWithSpans(childLogger, spanState.parentSpanId, spanState.traceId, spanState.traceSampled)
        }
      }
      return target[prop]
    },
  })
}
function createSpanMethod(logger, spanState) {
  return (namespace, childProps) => {
    const childName = namespace ? `${logger.name}:${namespace}` : logger.name
    const resolvedChildProps = typeof childProps === "function" ? childProps() : childProps
    const mergedProps = { ...logger.props, ...resolvedChildProps }
    const newSpanId = generateSpanId()
    let resolvedParentId = spanState.parentSpanId
    let resolvedTraceId = spanState.traceId
    if (!resolvedParentId && _getContextParent) {
      const ctxParent = _getContextParent()
      if (ctxParent) {
        resolvedParentId = ctxParent.spanId
        resolvedTraceId = resolvedTraceId || ctxParent.traceId
      }
    }
    const isNewTrace = !resolvedTraceId
    const finalTraceId = resolvedTraceId || generateTraceId()
    const sampled = isNewTrace ? shouldSample() : spanState.traceSampled
    const newSpanData = {
      id: newSpanId,
      traceId: finalTraceId,
      parentId: resolvedParentId,
      startTime: Date.now(),
      endTime: null,
      duration: null,
      attrs: {},
    }
    const childLogger = logger.child(namespace ?? "", resolvedChildProps)
    const spanAugmented = augmentWithSpans(childLogger, newSpanId, finalTraceId, sampled)
    _enterContext?.(newSpanId, finalTraceId, resolvedParentId)
    const disposeSpan = () => {
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
        const spanEvent = {
          kind: "span",
          time: newSpanData.endTime,
          namespace: childName,
          name: childName,
          duration: newSpanData.duration,
          props: {
            ...mergedProps,
            ...newSpanData.attrs,
          },
          spanId: newSpanData.id,
          traceId: newSpanData.traceId,
          parentId: newSpanData.parentId,
        }
        logger.dispatch(spanEvent)
      }
    }
    const spanDataProxy = createSpanDataProxy(
      () => ({
        id: newSpanData.id,
        traceId: newSpanData.traceId,
        parentId: newSpanData.parentId,
        startTime: newSpanData.startTime,
        endTime: newSpanData.endTime,
        duration:
          newSpanData.endTime !== null
            ? newSpanData.endTime - newSpanData.startTime
            : Date.now() - newSpanData.startTime,
      }),
      newSpanData.attrs,
    )
    let currentDispose = disposeSpan
    const spanLogger = new Proxy(spanAugmented, {
      get(target, prop) {
        if (prop === "spanData") return spanDataProxy
        if (prop === Symbol.dispose) return currentDispose
        if (prop === "end") {
          return () => {
            if (newSpanData.endTime === null) {
              currentDispose()
            }
          }
        }
        if (prop === "name") return childName
        if (prop === "props") return Object.freeze({ ...mergedProps })
        return target[prop]
      },
      set(_target, prop, value) {
        if (prop === Symbol.dispose) {
          currentDispose = value
          return true
        }
        return false
      },
    })
    return spanLogger
  }
}
function baseCreateLogger(name, configOrProps) {
  let pipeline
  let props = {}
  if (Array.isArray(configOrProps)) {
    pipeline = buildPipeline(configOrProps)
  } else if (configOrProps && typeof configOrProps === "object") {
    props = configOrProps
    pipeline = buildPipeline(["console"])
  } else {
    pipeline = buildPipeline(["console"])
  }
  const logger = createLoggerImpl(name, props, pipeline)
  logger.span = baseSpanStub
  return wrapConditional(logger, () => pipeline.level)
}
function pipe(base, ...plugins) {
  const ctx = {}
  return plugins.reduce((factory, plugin) => plugin(factory, ctx), base)
}
var _process3 = typeof process !== "undefined" ? process : undefined
var _env = _process3?.env ?? {}
function currentLevel() {
  return readEnvLevel()
}
function currentNs() {
  return readEnvNs()
}
function currentFormat() {
  return readEnvFormat()
}
function currentTrace() {
  return readEnvTrace()
}
var _writers = []
var _suppressConsole = false
var _logFileWriterFactory = null
function _setLogFileWriterFactory(factory) {
  _logFileWriterFactory = factory
}
function withEnvDefaults() {
  return (factory, _ctx) => (name, configOrProps) => {
    const envIdFormat = _env.TRACE_ID_FORMAT?.toLowerCase()
    if (envIdFormat === "simple" || envIdFormat === "w3c") {
      setIdFormat(envIdFormat)
    }
    const envSampleRate = _env.TRACE_SAMPLE_RATE
    if (envSampleRate !== undefined) {
      const rate = Number.parseFloat(envSampleRate)
      if (!Number.isNaN(rate) && rate >= 0 && rate <= 1) {
        setSampleRate(rate)
      }
    }
    if (Array.isArray(configOrProps)) return factory(name, configOrProps)
    const envPipeline = createEnvPipeline()
    const envStage = (event) => {
      envPipeline.dispatch(event)
      return null
    }
    if (configOrProps && typeof configOrProps === "object") {
      const logger = factory(name, [{ level: "trace" }, envStage])
      return applyNamespaceGating(logger.child(configOrProps))
    }
    return applyNamespaceGating(factory(name, [{ level: "trace" }, envStage]))
  }
}
function applyNamespaceGating(logger) {
  return new Proxy(logger, {
    get(target, prop) {
      if (typeof prop === "string" && prop in LOG_LEVEL_PRIORITY && prop !== "silent") {
        const nsLevel = readEnvLevelForNamespace(target.name)
        if (LOG_LEVEL_PRIORITY[prop] < LOG_LEVEL_PRIORITY[nsLevel]) {
          return
        }
      }
      return target[prop]
    },
  })
}
function createEnvPipeline() {
  const disposables = []
  const logFile = _env.LOG_FILE
  let fileSink = null
  if (logFile && _logFileWriterFactory) {
    const writer = _logFileWriterFactory(logFile)
    fileSink = (event) => {
      const fmt = currentFormat() === "json" ? formatJSONEvent : formatConsoleEvent
      writer.write(fmt(event))
    }
    disposables.push(() => writer.close())
  }
  const dispatch = (event) => {
    if (event.kind === "log" && LOG_LEVEL_PRIORITY[event.level] < LOG_LEVEL_PRIORITY[currentLevel()]) return
    if (event.kind === "span") {
      const trace = currentTrace()
      if (!trace.enabled) return
      if (trace.filter && !trace.filter(event.namespace)) return
    }
    const ns = currentNs()
    if (ns && !ns(event.namespace)) return
    const format = currentFormat()
    const formatter = format === "json" ? formatJSONEvent : formatConsoleEvent
    const text = formatter(event)
    const lvl = event.kind === "log" ? event.level : "span"
    for (const w of _writers) w(text, lvl, event.namespace, event)
    if (!_suppressConsole) createConsoleSink(format)(event)
    fileSink?.(event)
  }
  return {
    dispatch,
    get level() {
      return currentLevel()
    },
    dispose: () => {
      for (const d of disposables) d()
    },
  }
}
function withConfigMetrics() {
  return (factory, _ctx) => {
    return (name, configOrProps) => {
      const logger = factory(name, configOrProps)
      if (!Array.isArray(configOrProps)) return logger
      const hasMetrics = configOrProps.some(
        (el) => typeof el === "object" && el !== null && !Array.isArray(el) && "metrics" in el && el.metrics === true,
      )
      if (!hasMetrics) return logger
      const collector = createMetricsCollector()
      return withMetrics(collector)(logger)
    }
  }
}
var createLogger = pipe(baseCreateLogger, withEnvDefaults(), withSpans(), withConfigMetrics())
// ../loggily/src/index.ts
_setLogFileWriterFactory(createFileWriter)

// packages/tribe-client/src/parser.ts
var log = createLogger("tribe-client:parser")
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
// packages/tribe-client/src/client.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, unlinkSync } from "fs"
import { createConnection } from "net"
import { spawn } from "child_process"
import { dirname as dirname2 } from "path"

// packages/tribe-client/src/timers.ts
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

// packages/tribe-client/src/client.ts
var log2 = createLogger("tribe-client:client")
function connectToDaemon(socketPath, opts) {
  const callTimeoutMs = opts?.callTimeoutMs ?? 1e4
  return new Promise((resolvePromise, reject) => {
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
          if (msg.error)
            p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }))
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
        log2.error?.(`Connection error: ${err.message}`)
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
                log2.warn?.(`${timeouts} consecutive timeouts, destroying connection`)
                socket.destroy()
              }
            }, callTimeoutMs)
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
      resolvePromise(client)
    })
  })
}
async function connectOrStart(socketPath, opts) {
  try {
    return await connectToDaemon(socketPath, { callTimeoutMs: opts?.callTimeoutMs })
  } catch (err) {
    const code = err.code
    if (code !== "ECONNREFUSED" && code !== "ENOENT") throw err
    if (opts?.noSpawn) throw err
  }
  if (existsSync2(socketPath)) {
    try {
      unlinkSync(socketPath)
    } catch {}
  }
  const socketDir = dirname2(socketPath)
  if (!existsSync2(socketDir)) mkdirSync2(socketDir, { recursive: true })
  const script = opts?.daemonScript
  if (!script) {
    throw new Error(`connectOrStart: no daemon at ${socketPath} and no daemonScript provided to spawn one`)
  }
  const args = ["--socket", socketPath, ...(opts?.daemonArgs ?? [])]
  const child = spawn(process.execPath, [script, ...args], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  })
  child.unref()
  const maxAttempts = opts?.maxStartupAttempts ?? 10
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, Math.min(100 * 2 ** attempt, 2000)))
    try {
      return await connectToDaemon(socketPath, { callTimeoutMs: opts?.callTimeoutMs })
    } catch {}
  }
  throw new Error(`Failed to connect to daemon at ${socketPath} after starting it`)
}
async function createReconnectingClient(opts) {
  const {
    socketPath,
    onConnect,
    onDisconnect,
    onReconnect,
    maxAttempts = 30,
    callTimeoutMs,
    daemonScript,
    daemonArgs,
    maxStartupAttempts,
  } = opts
  const startOpts = { callTimeoutMs, daemonScript, daemonArgs, maxStartupAttempts }
  let current = await connectOrStart(socketPath, startOpts)
  if (onConnect) await onConnect(current)
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
            current = await connectOrStart(socketPath, startOpts)
            if (onConnect) await onConnect(current)
            for (const h of notificationHandlers) current.onNotification(h)
            setupReconnect()
            onReconnect?.()
            return
          } catch {
            log2.debug?.(`Reconnect attempt ${attempt + 1} failed`)
          }
        }
        log2.error?.(`Failed to reconnect after ${maxAttempts} attempts`)
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
// packages/tribe-client/src/paths.ts
import { resolve as resolve2 } from "path"
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
// packages/tribe-client/src/composition/scope.ts
class Scope extends AsyncDisposableStack {
  signal
  name
  #children = new Set()
  #parent
  constructor(parent, name) {
    super()
    this.name = name
    this.#parent = parent
    const controller = new AbortController()
    this.signal = controller.signal
    this.defer(() => controller.abort())
    if (parent) {
      if (parent.disposed) {
        throw new ReferenceError("Cannot create child of disposed scope")
      }
      if (parent.signal.aborted) {
        controller.abort()
      } else {
        const onAbort = () => controller.abort()
        parent.signal.addEventListener("abort", onAbort, { once: true })
        this.defer(() => parent.signal.removeEventListener("abort", onAbort))
      }
      parent.#children.add(this)
    }
  }
  child(name) {
    return new Scope(this, name)
  }
  async [Symbol.asyncDispose]() {
    if (this.disposed) return
    const errors = []
    const children = [...this.#children].reverse()
    this.#children.clear()
    for (const c of children) {
      try {
        await c[Symbol.asyncDispose]()
      } catch (e) {
        errors.push(e)
      }
    }
    try {
      await super[Symbol.asyncDispose]()
    } catch (e) {
      errors.push(e)
    }
    if (this.#parent) this.#parent.#children.delete(this)
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw errors.reduce((acc, e) => new SuppressedError(e, acc, "Multiple disposers threw"))
    }
  }
  move() {
    throw new TypeError("Scope.move() is not supported \u2014 create a new scope and re-register resources explicitly")
  }
}
// tools/lib/tribe/socket.ts
var TRIBE_PROTOCOL_VERSION = 4
function defaultDaemonScript() {
  return resolve3(dirname3(new URL(import.meta.url).pathname), "../../tribe-daemon.ts")
}
function createReconnectingClient2(opts) {
  const clientOpts = {
    socketPath: opts.socketPath,
    onConnect: opts.onConnect,
    onDisconnect: opts.onDisconnect,
    onReconnect: opts.onReconnect,
    maxAttempts: opts.maxAttempts,
    callTimeoutMs: opts.callTimeoutMs,
    daemonScript: defaultDaemonScript(),
    daemonArgs: opts.dbPath ? ["--db", opts.dbPath] : undefined,
  }
  return createReconnectingClient(clientOpts)
}

// tools/lib/tribe/tools-list.ts
var TOOLS_LIST = [
  {
    name: "tribe.send",
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
    name: "tribe.broadcast",
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
    name: "tribe.members",
    description: "List active tribe sessions with their roles and domains",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Include dead sessions (default: false)" },
      },
    },
  },
  {
    name: "tribe.history",
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
    name: "tribe.rename",
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
    name: "tribe.health",
    description: "Diagnostic: check for silent members, stale beads, unread messages",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "tribe.join",
    description: "Re-announce this session's name, role, and domains (e.g. after compaction/rejoin)",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name" },
        role: {
          type: "string",
          description:
            "Session role. 'chief' = coordinator, 'member' = default worker, 'watch' = read-only observer (never chief-eligible).",
          enum: ["chief", "member", "watch"],
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
    name: "tribe.reload",
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
    name: "tribe.retro",
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
    name: "tribe.chief",
    description:
      "Show the current chief \u2014 derived from connection order, or explicitly claimed via tribe.claim-chief.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "tribe.debug",
    description:
      "Dump daemon internals for troubleshooting \u2014 clients, chief derivation, chief claim, per-session cursors.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "tribe.claim-chief",
    description:
      "Claim the chief role explicitly. Idempotent. Overrides the default connection-order derivation until released (or this session disconnects).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "tribe.release-chief",
    description:
      "Release an explicit chief claim, letting the role fall back to connection-order derivation. Idempotent \u2014 no-op if this session did not hold an explicit claim.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "tribe.inbox",
    description:
      "Pull pending tribe events that did NOT push to the channel (ambient: commits, joins/leaves, routine github events, low-severity health warnings). Returns events newer than the per-session pull cursor; advances the cursor on call. " +
      "Empty response is the correct behavior for most tribe channel events you do see \u2014 the tool returns inbox data; you decide whether to act. Do not generate acknowledgement text just because a message arrived.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "number",
          description: "Pull rows with rowid > since. Default: per-session cursor.",
        },
        kinds: {
          type: "array",
          items: { type: "string" },
          description: "Optional plugin_kind globs to filter (e.g. ['github:*', 'git:commit']).",
        },
        limit: { type: "number", description: "Max rows to return (default: 50)." },
      },
    },
  },
  {
    name: "tribe.filter",
    description:
      "Per-session filter for incoming events. Combines persistent mode + time-bounded mute + per-kind glob matching into a single tool. " +
      "`mode` sets the persistent focus level (`focus` = only direct DMs reach the channel, `normal` = kind-based default, `ambient` = everything). " +
      "`kinds` matches `plugin_kind` globs (e.g. `['github:*', 'git:commit']`) to silence selectively. " +
      "`until` is an optional unix-ms timestamp expiring the kind filter; absent = persistent. " +
      "Empty args clears the filter (mode resets to `normal`, kinds + until cleared). Direct messages always bypass kinds/until \u2014 only `mode: focus` filters DMs.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["focus", "normal", "ambient"],
          description: "Persistent filter mode (optional). Defaults to 'normal' when args are empty.",
        },
        kinds: {
          type: "array",
          items: { type: "string" },
          description: "Optional plugin_kind globs to silence (e.g. ['github:*']).",
        },
        until: {
          type: "number",
          description: "Optional unix-ms timestamp at which the kind/mute filter expires. Absent = persistent.",
        },
      },
      required: [],
    },
  },
]

// tools/lib/tribe/timers.ts
function createTimers2(signal) {
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
      return new Promise((resolve4, reject) => {
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        const t = globalThis.setTimeout(resolve4, ms)
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

// tools/lib/tribe/hot-reload.ts
import { createHash as createHash2 } from "crypto"
import { existsSync as existsSync3, readdirSync, readFileSync as readFileSync2, watch } from "fs"
import { dirname as dirname4, resolve as resolve4 } from "path"
import { spawn as spawn2 } from "child_process"
var log3 = createLogger("tribe:reload")
function setupHotReload(opts) {
  const { importMetaUrl, extraFiles = [], extraDirs = [], onReload, logActivity, debounceMs = 500 } = opts
  if (!importMetaUrl.startsWith("file://")) return null
  const scriptPath = new URL(importMetaUrl).pathname
  const reloadScriptName =
    scriptPath
      .split("/")
      .pop()
      ?.replace(/\.(ts|tsx)$/, "") ?? "unknown"
  const sourceDir = dirname4(scriptPath)
  const libTribeDir = resolve4(sourceDir, "lib/tribe")
  if (process.env.__TRIBE_HOT_RELOAD === "1") {
    delete process.env.__TRIBE_HOT_RELOAD
    log3.info?.(`Hot-reloaded: ${reloadScriptName}`)
    logActivity?.("reload", `${reloadScriptName} hot-reloaded`)
  }
  function getSourceFiles() {
    const files = [scriptPath, ...extraFiles]
    const dirs = [libTribeDir, ...extraDirs]
    for (const dir of dirs) {
      try {
        if (existsSync3(dir)) {
          for (const f of readdirSync(dir)) {
            if (f.endsWith(".ts")) files.push(resolve4(dir, f))
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
        hash.update(readFileSync2(f))
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
      log3.info?.(`Source changed (${currentHash} \u2192 ${newHash}), re-execing`)
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
  log3.info?.(`Watching ${getSourceFiles().length} source files for hot-reload`)
  return {
    [Symbol.dispose]() {
      if (debounceTimer) clearTimeout(debounceTimer)
      for (const w of watchers) w.close()
    },
  }
}

// tools/lib/tribe/session.ts
import { existsSync as existsSync4, readFileSync as readFileSync3 } from "fs"
import { resolve as resolve5 } from "path"
var log4 = createLogger("tribe:session")
function resolveTranscriptPath(claudeSessionId) {
  if (!claudeSessionId) return null
  const cwd = process.cwd()
  const projectKey = "-" + cwd.replace(/\//g, "-")
  const transcriptPath = resolve5(process.env.HOME ?? "~", ".claude/projects", projectKey, `${claudeSessionId}.jsonl`)
  return existsSync4(transcriptPath) ? transcriptPath : null
}
function readTranscriptSlug(transcriptPath) {
  if (!transcriptPath) return null
  try {
    const size = Bun.file(transcriptPath).size
    if (size === 0) return null
    const text = new TextDecoder().decode(
      new Uint8Array(readFileSync3(transcriptPath).buffer.slice(Math.max(0, size - 4096))),
    )
    const lines = text.trimEnd().split(`
`)
    const lastLine = lines[lines.length - 1]
    if (!lastLine) return null
    const data = JSON.parse(lastLine)
    return data.slug ?? null
  } catch {
    return null
  }
}

// tools/stdio-adapter.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { createServer } from "net"
import { existsSync as existsSync5, unlinkSync as unlinkSync2, mkdirSync as mkdirSync3, chmodSync } from "fs"
import { dirname as dirname5 } from "path"
import { spawn as spawn3 } from "child_process"
import { createHash as createHash3, randomUUID } from "crypto"
function sendChannel(content, meta) {
  if (!mcp) return
  mcp.notification({ method: "notifications/claude/channel", params: { content, meta } }).catch(() => {})
}
function startPeerServer() {
  const socketDir = dirname5(PEER_SOCKET_PATH)
  if (!existsSync5(socketDir)) mkdirSync3(socketDir, { recursive: true })
  if (existsSync5(PEER_SOCKET_PATH)) {
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
    log5.info?.(`Peer socket listening at ${PEER_SOCKET_PATH}`)
  })
  server.on("error", (err) => {
    log5.warn?.(`Peer server error: ${err.message}`)
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
function isAutoName(name) {
  return name.startsWith("member-") || name.startsWith("pending-") || /^[a-z]+-\d+-[a-z0-9]{3}$/.test(name)
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
    log5.info?.(`Direct message sent to ${target}`)
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
  if (existsSync5(PEER_SOCKET_PATH)) {
    try {
      unlinkSync2(PEER_SOCKET_PATH)
    } catch {}
  }
}
function tryAutoRenameOnClaim(content) {
  if (autoRenamed) return
  if (!/^km-\d+-[a-z0-9]{3}$/.test(myName)) return
  const byMatch = content.match(/\[by:claude:([a-f0-9]+)\]/)
  if (!byMatch) return
  const claimSessionPrefix = byMatch[1]
  if (!CLAUDE_SESSION_ID || !CLAUDE_SESSION_ID.startsWith(claimSessionPrefix)) return
  const beadMatch = content.match(/^Claimed: (km-[a-z][\w-]*?)\./)
  if (!beadMatch) return
  const scope = beadMatch[1]
  if (scope === myName) return
  autoRenamed = true
  daemon
    .call("tribe.rename", { new_name: scope })
    .then((result) => {
      const r = result
      try {
        const data = JSON.parse(r.content[0]?.text ?? "{}")
        if (data.name) myName = data.name
      } catch {}
    })
    .catch(() => {})
}
let __stack = []
try {
  var log5 = createLogger("tribe:stdio-adapter")
  var proxyAc = new AbortController()
  var timers = createTimers2(proxyAc.signal)
  var args = parseTribeArgs()
  var SOCKET_PATH = resolveSocketPath(args.socket)
  var SESSION_DOMAINS = parseSessionDomains(args)
  var CLAUDE_SESSION_ID = resolveClaudeSessionId()
  var CLAUDE_SESSION_NAME = resolveClaudeSessionName()
  log5.info?.(`Connecting to daemon at ${SOCKET_PATH}`)
  var myName = "pending"
  var myRole = "member"
  var mySessionId = randomUUID()
  var PROJECT_NAME = resolveProjectName()
  var PEER_SOCKET_PATH = resolvePeerSocketPath(mySessionId)
  var peerServer = null
  var mcp
  peerServer = startPeerServer()
  var identityToken = createHash3("sha256")
    .update(`${CLAUDE_SESSION_ID ?? ""}|${process.cwd()}|${args.role ?? "member"}`)
    .digest("hex")
    .slice(0, 16)
  var registerParams = {
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
    identityToken,
  }
  var daemon = await createReconnectingClient2({
    socketPath: SOCKET_PATH,
    async onConnect(client) {
      const reg = await client.call("register", registerParams)
      myName = reg.name
      myRole = reg.role
      log5.info?.(`Registered as ${myName} (${myRole})`)
      client.call("subscribe").catch(() => {})
    },
    onDisconnect() {
      log5.debug?.(`Daemon connection lost`)
    },
    onReconnect() {
      log5.info?.(`Reconnected to daemon`)
    },
  })
  var joinInstruction = `If you receive a stdio-adapter auto-identify message, just call tribe.join with a short name for your focus area. Omit the role parameter \u2014 the daemon auto-assigns chief to the first session and member to the rest. No need to call tribe.members or tribe.history afterward \u2014 just join silently and continue.`
  var chiefInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are the chief of a tribe \u2014 a coordinator for multiple Claude Code sessions working on the same project.

${joinInstruction}

Coordination protocol:
- Use tribe.members() to see who's online and their domains
- Use tribe.send(to, message, type) to assign work, answer queries, or approve requests
- Use tribe.broadcast(message) to announce changes that affect everyone
- Use tribe.health() to check for silent members or conflicts
- When CI alerts arrive, coordinate the fix \u2014 assign the responsible session to investigate

User-facing output:
- Silent by default. Speak to the user only to add non-obvious info. Never narrate "noted"/"acknowledged"/"still waiting" for channel messages, CI alerts, or harness reminder loops. If you have nothing to add, emit nothing.
- **Notification-only channels get ZERO output.** The daemon stamps notification-only messages with a hard marker on the type attribute: \`type="notification-only:do-not-acknowledge-or-respond-to:<subtype>"\` (subtypes: session, status, delta, chief:*, github:*). If every <channel> tag in a turn carries the \`notification-only:do-not-acknowledge-or-respond-to:\` prefix on its type attribute, the correct reply is literally zero characters \u2014 no tool calls, no text, no acknowledgment. Do NOT emit "Acknowledged", "Noted", "No response required", or any filler. Do NOT emit "Human:" / "Assistant:" / "User:" as a prefix. If you feel pressure to produce output, that pressure is wrong \u2014 the turn ends silently.

Tribe messages:
- Keep SHORT \u2014 1-3 lines max. No essays.
- Plain text only \u2014 no markdown (**bold**, headers, bullets). Renders as escaped text.`
  var memberInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are a tribe member \u2014 a worker session coordinated by the chief.

${joinInstruction}

Coordination protocol:
- When you START work on a task, broadcast what you're doing: tribe.send(to="*", message="starting: <task>")
- When you FINISH a task or commit, broadcast: tribe.send(to="*", message="done: <summary>")
- When you claim a bead, broadcast: tribe.send(to="*", message="claimed: <bead-id> \u2014 <title>")
- When you're blocked, broadcast immediately \u2014 include what would unblock you
- Before editing vendor/ or shared files, send a request to chief asking for OK
- Respond to query messages promptly

Sub-agent protocol:
- When you spawn sub-agents (Agent tool), broadcast: tribe.send(to="*", message="spawned: <name> for <task>")
- When a sub-agent completes, broadcast: tribe.send(to="*", message="agent-done: <name> \u2014 <result>")
- Sub-agents share your tribe connection \u2014 they can't be seen individually in tribe

CI protocol:
- When you see a CI ALERT for a repo you're working on or know about, respond with a fix hint
- Example: tribe.send(to="*", message="hint: termless CI needs vt220.js \u2014 run npm publish from vendor/vterm/packages/vt220")
- If a CI alert DMs you directly, investigate and fix the failure before pushing more code
- After fixing, broadcast: tribe.send(to="*", message="ci-fix: <repo> \u2014 <what you fixed>")

User-facing output:
- Silent by default. Speak to the user only to add non-obvious info. Never narrate "noted"/"acknowledged"/"still waiting" for channel messages, CI alerts, or harness reminder loops. If you have nothing to add, emit nothing.
- **Notification-only channels get ZERO output.** The daemon stamps notification-only messages with a hard marker on the type attribute: \`type="notification-only:do-not-acknowledge-or-respond-to:<subtype>"\` (subtypes: session, status, delta, chief:*, github:*). If every <channel> tag in a turn carries the \`notification-only:do-not-acknowledge-or-respond-to:\` prefix on its type attribute, the correct reply is literally zero characters \u2014 no tool calls, no text, no acknowledgment. Do NOT emit "Acknowledged", "Noted", "No response required", or any filler. Do NOT emit "Human:" / "Assistant:" / "User:" as a prefix. If you feel pressure to produce output, that pressure is wrong \u2014 the turn ends silently.

Tribe messages:
- Keep SHORT \u2014 1-3 lines max. No essays.
- Plain text only \u2014 no markdown (**bold**, headers, bullets). Renders as escaped text.
- Don't over-broadcast \u2014 only send when it changes what someone else should know.`
  mcp = new Server(
    { name: "tribe", version: "0.12.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: myRole === "chief" ? chiefInstructions : memberInstructions,
    },
  )
  var nudgeSent = false
  mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!nudgeSent && isAutoName(myName)) {
      nudgeSent = true
      timers.setTimeout(() => {
        sendChannel(
          `Auto-identify: call tribe.join(name="${myName}") with a short name for your focus area. Omit the role parameter \u2014 the daemon auto-assigns it. Do not call tribe.members or tribe.history \u2014 just join silently and continue.`,
          { from: "stdio-adapter", type: "system" },
        )
      }, 500)
    }
    return { tools: TOOLS_LIST }
  })
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: toolArgs } = req.params
    const a = toolArgs ?? {}
    try {
      if (name === "tribe.send" && a.to && typeof a.to === "string") {
        const directResult = await trySendDirect(a)
        if (directResult) return directResult
      }
      const payload = name === "tribe.join" ? { ...a, identity_token: identityToken } : a
      const result = await daemon.call(name, payload)
      if (name === "tribe.join" || name === "tribe.rename") {
        const r = result
        try {
          const data = JSON.parse(r.content[0]?.text ?? "{}")
          if (data.name) myName = data.name
          if (data.role) myRole = data.role
        } catch {}
        autoRenamed = true
      }
      return result
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : err}` }],
      }
    }
  })
  var _reload = __using(
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
  var shutdown = () => {
    proxyAc.abort()
    cleanupPeerSocket()
    daemon.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  process.on("exit", cleanupPeerSocket)
  await mcp.connect(new StdioServerTransport())
  {
    const transcriptPath = resolveTranscriptPath(CLAUDE_SESSION_ID)
    if (transcriptPath) {
      let lastSlug = null
      const checkSlug = () => {
        const slug = readTranscriptSlug(transcriptPath)
        if (!slug || slug === lastSlug || slug === myName) return
        lastSlug = slug
        autoRenamed = true
        daemon
          .call("tribe.rename", { new_name: slug })
          .then((result) => {
            const r = result
            try {
              const data = JSON.parse(r.content[0]?.text ?? "{}")
              if (data.name) myName = data.name
              log5.info?.(`auto-renamed from /rename slug: ${myName}`)
            } catch {}
          })
          .catch(() => {})
      }
      timers.setInterval(checkSlug, 5000)
    }
  }
  var autoRenamed = false
  daemon.onNotification((method, params) => {
    if (method === "channel") {
      const content = String(params?.content ?? "")
      const type = String(params?.type ?? "notify")
      if (type === "bead:claimed") tryAutoRenameOnClaim(content)
      sendChannel(content, {
        from: String(params?.from ?? "unknown"),
        type,
        bead: params?.bead_id ? String(params.bead_id) : undefined,
        message_id: params?.message_id ? String(params.message_id) : undefined,
      })
    } else if (method === "session.joined" || method === "session.left") {
      const action = method === "session.joined" ? "joined" : "left"
      sendChannel(`${params?.name ?? "unknown"} ${action} the tribe`, { from: "daemon", type: "status" })
    } else if (method === "reload") {
      log5.info?.(`Daemon requests reload: ${params?.reason}`)
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
