#!/usr/bin/env bun
// @bun
var __using = (stack, value, async) => {
  if (value != null) {
    if (typeof value !== "object" && typeof value !== "function")
      throw TypeError('Object expected to be assigned to "using" declaration');
    let dispose;
    if (async)
      dispose = value[Symbol.asyncDispose];
    if (dispose === undefined)
      dispose = value[Symbol.dispose];
    if (typeof dispose !== "function")
      throw TypeError("Object not disposable");
    stack.push([async, dispose, value]);
  } else if (async) {
    stack.push([async]);
  }
  return value;
};
var __callDispose = (stack, error, hasError) => {
  let fail = (e) => error = hasError ? new SuppressedError(e, error, "An error was suppressed during disposal") : (hasError = true, e), next = (it) => {
    while (it = stack.pop()) {
      try {
        var result = it[1] && it[1].call(it[2]);
        if (it[0])
          return Promise.resolve(result).then(next, (e) => (fail(e), next()));
      } catch (e) {
        fail(e);
      }
    }
    if (hasError)
      throw error;
  };
  return next();
};

// tools/lib/tribe/config.ts
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "fs";
import { basename, dirname, resolve } from "path";
import { parseArgs } from "util";
function parseTribeArgs() {
  const { values } = parseArgs({
    options: {
      name: { type: "string", default: process.env.TRIBE_NAME },
      role: { type: "string", default: process.env.TRIBE_ROLE },
      domains: { type: "string", default: process.env.TRIBE_DOMAINS ?? "" },
      db: { type: "string", default: process.env.TRIBE_DB },
      socket: { type: "string", default: process.env.TRIBE_SOCKET },
      "auto-report": { type: "boolean", default: (process.env.TRIBE_AUTO_REPORT ?? "1") === "1" },
      account: { type: "string", default: process.env.TRIBE_ACCOUNT },
      provider: { type: "string", default: process.env.TRIBE_PROVIDER }
    },
    strict: false
  });
  return values;
}
function parseSessionDomains(args) {
  return String(args.domains ?? "").split(",").filter(Boolean);
}
function findBeadsDir(from) {
  let dir = from ?? process.cwd();
  while (dir !== "/") {
    const candidate = resolve(dir, ".beads");
    if (existsSync(candidate))
      return candidate;
    dir = dirname(dir);
  }
  return null;
}
function resolveProjectName(cwd) {
  const dir = cwd ?? process.cwd();
  const beadsDir = findBeadsDir(dir);
  if (beadsDir) {
    const projectRoot = dirname(beadsDir);
    const depth = dir.replace(projectRoot, "").split("/").filter(Boolean).length;
    if (depth <= 2) {
      const configPath = resolve(beadsDir, "config.yaml");
      if (existsSync(configPath)) {
        try {
          const content = readFileSync(configPath, "utf-8");
          const match = content.match(/^project:\s*["']?(\w+)["']?/m);
          if (match?.[1])
            return match[1].toLowerCase();
        } catch {}
      }
      return basename(projectRoot).toLowerCase();
    }
  }
  return basename(dir).toLowerCase();
}
function resolveClaudeSessionId() {
  return process.env.CLAUDE_SESSION_ID ?? process.env.BD_ACTOR?.replace("claude:", "") ?? null;
}
function resolveClaudeSessionName() {
  return process.env.CLAUDE_SESSION_NAME ?? null;
}
function resolveProjectId(cwd) {
  const dir = cwd ?? process.cwd();
  try {
    const real = realpathSync(dir);
    return createHash("sha256").update(real).digest("hex").slice(0, 12);
  } catch {
    return createHash("sha256").update(dir).digest("hex").slice(0, 12);
  }
}

// tools/lib/tribe/socket.ts
import { dirname as dirname3, resolve as resolve3 } from "path";

// packages/tribe-client/src/rpc.ts
function isResponse(msg) {
  return "id" in msg && !("method" in msg);
}
function isNotification(msg) {
  return "method" in msg && !("id" in msg);
}
function makeRequest(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + `
`;
}
function makeNotification(method, params) {
  return JSON.stringify({ jsonrpc: "2.0", method, params }) + `
`;
}
// node_modules/.bun/loggily@0.8.0+e40b0dfdd726a224/node_modules/loggily/dist/metrics.mjs
function percentile(sorted, p) {
  if (sorted.length === 0)
    return 0;
  return sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
}
function computeStats(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const total = sorted.reduce((sum, d) => sum + d, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length > 0 ? total / sorted.length : 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    total
  };
}
function createMetricsCollector(maxEntries = 1000) {
  const store = /* @__PURE__ */ new Map;
  return {
    recordSpan(data) {
      let arr = store.get(data.name);
      if (!arr) {
        arr = [];
        store.set(data.name, arr);
      }
      arr.push(data.durationMs);
      if (arr.length > maxEntries)
        arr.shift();
    },
    stats(name) {
      const arr = store.get(name);
      if (!arr || arr.length === 0)
        return;
      return computeStats(arr);
    },
    all() {
      const result = /* @__PURE__ */ new Map;
      for (const [name, durations] of store)
        if (durations.length > 0)
          result.set(name, computeStats(durations));
      return result;
    },
    summary() {
      const entries = [...this.all().entries()];
      if (entries.length === 0)
        return "(no span data)";
      return entries.map(([name, s]) => `${name}: ${s.count} spans, mean=${s.mean.toFixed(1)}ms, p50=${s.p50.toFixed(1)}ms, p95=${s.p95.toFixed(1)}ms, p99=${s.p99.toFixed(1)}ms`).join(`
`);
    },
    reset() {
      store.clear();
    }
  };
}
function withMetrics(collector) {
  return (logger) => {
    return new Proxy(logger, { get(target, prop) {
      if (prop === "metrics")
        return collector;
      if (prop === "span") {
        const originalSpan = target.span;
        if (!originalSpan)
          return;
        return (namespace, props) => {
          const span = originalSpan.call(target, namespace, props);
          const originalDispose = span[Symbol.dispose];
          span[Symbol.dispose] = () => {
            originalDispose.call(span);
            if (span.spanData?.duration != null)
              collector.recordSpan({
                name: span.name,
                durationMs: span.spanData.duration
              });
          };
          return span;
        };
      }
      if (prop === "child")
        return (namespaceOrContext, childProps) => {
          const child = target.child(namespaceOrContext, childProps);
          return withMetrics(collector)(child);
        };
      if (prop === "logger")
        return (namespace, childProps) => {
          const child = target.logger(namespace, childProps);
          return withMetrics(collector)(child);
        };
      return target[prop];
    } });
  };
}

// node_modules/.bun/loggily@0.8.0+e40b0dfdd726a224/node_modules/loggily/dist/core-B3pox577.mjs
import { closeSync, openSync, writeSync } from "fs";
var _process$1 = typeof process !== "undefined" ? process : undefined;
var enabled = _process$1?.env?.["FORCE_COLOR"] !== undefined && _process$1?.env?.["FORCE_COLOR"] !== "0" ? true : _process$1?.env?.["NO_COLOR"] !== undefined ? false : _process$1?.stdout?.isTTY ?? false;
function wrap(open, close) {
  if (!enabled)
    return (str) => str;
  return (str) => open + str + close;
}
var colors = {
  dim: wrap("\x1B[2m", "\x1B[22m"),
  blue: wrap("\x1B[34m", "\x1B[39m"),
  yellow: wrap("\x1B[33m", "\x1B[39m"),
  red: wrap("\x1B[31m", "\x1B[39m"),
  magenta: wrap("\x1B[35m", "\x1B[39m"),
  cyan: wrap("\x1B[36m", "\x1B[39m")
};
function createFileWriter(filePath, options = {}) {
  const bufferSize = options.bufferSize ?? 4096;
  const flushInterval = options.flushInterval ?? 100;
  let buffer = "";
  let fd = null;
  let timer = null;
  let closed = false;
  fd = openSync(filePath, "a");
  function flush() {
    if (buffer.length === 0 || fd === null)
      return;
    writeSync(fd, buffer);
    buffer = "";
  }
  timer = setInterval(flush, flushInterval);
  if (timer && typeof timer === "object" && "unref" in timer)
    timer.unref();
  const exitHandler = () => flush();
  process.on("exit", exitHandler);
  return {
    write(line) {
      if (closed)
        return;
      buffer += line + `
`;
      if (buffer.length >= bufferSize)
        flush();
    },
    flush,
    close() {
      if (closed)
        return;
      closed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      try {
        flush();
      } catch {} finally {
        if (fd !== null) {
          closeSync(fd);
          fd = null;
        }
        process.removeListener("exit", exitHandler);
      }
    }
  };
}
var currentIdFormat = "simple";
function setIdFormat(format) {
  currentIdFormat = format;
}
var simpleSpanCounter = 0;
var simpleTraceCounter = 0;
function randomHex(bytes) {
  return crypto.randomUUID().replace(/-/g, "").slice(0, bytes * 2);
}
function generateSpanId() {
  if (currentIdFormat === "w3c")
    return randomHex(8);
  return `sp_${(++simpleSpanCounter).toString(36)}`;
}
function generateTraceId() {
  if (currentIdFormat === "w3c")
    return randomHex(16);
  return `tr_${(++simpleTraceCounter).toString(36)}`;
}
var sampleRate = 1;
function setSampleRate(rate) {
  if (rate < 0 || rate > 1)
    throw new Error(`Sample rate must be between 0.0 and 1.0, got ${rate}`);
  sampleRate = rate;
}
function shouldSample() {
  if (sampleRate >= 1)
    return true;
  if (sampleRate <= 0)
    return false;
  return Math.random() < sampleRate;
}
var LOG_LEVEL_PRIORITY = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  silent: 5
};
var _process = typeof process !== "undefined" ? process : undefined;
function getEnv(key) {
  return _process?.env?.[key];
}
function writeStderr(text) {
  if (_process?.stderr?.write)
    _process.stderr.write(text + `
`);
  else
    console.error(text);
}
function serializeCause(cause, maxDepth = 3) {
  if (maxDepth <= 0 || cause === undefined || cause === null)
    return;
  if (cause instanceof Error) {
    const result = {
      name: cause.name,
      message: cause.message,
      stack: cause.stack
    };
    if (cause.code)
      result.code = cause.code;
    if (cause.cause !== undefined)
      result.cause = serializeCause(cause.cause, maxDepth - 1);
    return result;
  }
  return cause;
}
function safeStringify(value) {
  const seen = /* @__PURE__ */ new WeakSet;
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "bigint")
      return val.toString();
    if (typeof val === "symbol")
      return val.toString();
    if (val instanceof Error) {
      const result = {
        message: val.message,
        stack: val.stack,
        name: val.name
      };
      if (val.code)
        result.code = val.code;
      if (val.cause !== undefined)
        result.cause = serializeCause(val.cause);
      return result;
    }
    if (typeof val === "object" && val !== null) {
      if (seen.has(val))
        return "[Circular]";
      seen.add(val);
    }
    return val;
  });
}
function formatConsoleEvent(event) {
  const time = colors.dim(new Date(event.time).toISOString().split("T")[1]?.split(".")[0] || "");
  const ns = colors.cyan(event.namespace);
  if (event.kind === "span") {
    const message = `(${event.duration}ms)`;
    let output2 = `${time} ${colors.magenta("SPAN")} ${ns} ${message}`;
    if (event.props && Object.keys(event.props).length > 0)
      output2 += ` ${colors.dim(safeStringify(event.props))}`;
    return output2;
  }
  let levelStr;
  switch (event.level) {
    case "trace":
      levelStr = colors.dim("TRACE");
      break;
    case "debug":
      levelStr = colors.dim("DEBUG");
      break;
    case "info":
      levelStr = colors.blue("INFO");
      break;
    case "warn":
      levelStr = colors.yellow("WARN");
      break;
    case "error":
      levelStr = colors.red("ERROR");
      break;
  }
  let output = `${time} ${levelStr} ${ns} ${event.message}`;
  if (event.props && Object.keys(event.props).length > 0)
    output += ` ${colors.dim(safeStringify(event.props))}`;
  return output;
}
function formatJSONEvent(event) {
  if (event.kind === "span")
    return safeStringify({
      time: new Date(event.time).toISOString(),
      level: "span",
      name: event.namespace,
      msg: `(${event.duration}ms)`,
      duration: event.duration,
      span_id: event.spanId,
      trace_id: event.traceId,
      parent_id: event.parentId,
      ...event.props
    });
  return safeStringify({
    time: new Date(event.time).toISOString(),
    level: event.level,
    name: event.namespace,
    msg: event.message,
    ...event.props
  });
}
function matchesPattern(namespace, pattern) {
  if (pattern === "*")
    return true;
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return namespace === prefix || namespace.startsWith(prefix + ":");
  }
  return namespace === pattern || namespace.startsWith(pattern + ":");
}
function parseNsFilter(ns) {
  const patterns = typeof ns === "string" ? ns.split(",").map((s) => s.trim()) : ns;
  const includes = [];
  const excludes = [];
  for (const p of patterns)
    if (p.startsWith("-"))
      excludes.push(p.slice(1));
    else
      includes.push(p);
  return (namespace) => {
    for (const exc of excludes)
      if (matchesPattern(namespace, exc))
        return false;
    if (includes.length > 0) {
      for (const inc of includes)
        if (matchesPattern(namespace, inc))
          return true;
      return false;
    }
    return true;
  };
}
function writeToConsole(text, event) {
  if (event.kind === "span") {
    writeStderr(text);
    return;
  }
  switch (event.level) {
    case "trace":
    case "debug":
      Function.prototype.bind.call(console.debug, console, text)();
      break;
    case "info":
      Function.prototype.bind.call(console.info, console, text)();
      break;
    case "warn":
      Function.prototype.bind.call(console.warn, console, text)();
      break;
    case "error":
      Function.prototype.bind.call(console.error, console, text)();
      break;
  }
}
function createConsoleSink(format) {
  const formatter = format === "json" ? formatJSONEvent : formatConsoleEvent;
  return (event) => writeToConsole(formatter(event), event);
}
function createFileSink(path, format) {
  const writer = createFileWriter(path);
  const formatter = format === "json" ? formatJSONEvent : formatConsoleEvent;
  return {
    write: (event) => writer.write(formatter(event)),
    dispose: () => writer.close()
  };
}
function isNodeStream(obj) {
  return typeof obj === "object" && obj !== null && (("_write" in obj) || ("writable" in obj) || ("fd" in obj));
}
function createWritableSink(writable, format) {
  if (!(writable.objectMode ?? !isNodeStream(writable))) {
    const formatter = format === "json" ? formatJSONEvent : formatConsoleEvent;
    return (event) => writable.write(formatter(event) + `
`);
  }
  return (event) => writable.write(event);
}
var VALID_CONFIG_KEYS = new Set([
  "level",
  "ns",
  "format",
  "spans",
  "metrics",
  "idFormat",
  "sampleRate"
]);
var SINK_KEYS = new Set(["file", "otel"]);
function isPojo(obj) {
  if (typeof obj !== "object" || obj === null)
    return false;
  const proto = Object.getPrototypeOf(obj);
  return proto === Object.prototype || proto === null;
}
function isWritable(obj) {
  return typeof obj === "object" && obj !== null && "write" in obj && typeof obj.write === "function";
}
function isValidLogLevel(val) {
  return typeof val === "string" && val in LOG_LEVEL_PRIORITY;
}
function buildPipeline(elements, parentConfig) {
  const config = {
    level: parentConfig?.level ?? readEnvLevel(),
    ns: parentConfig?.ns ?? readEnvNs(),
    format: parentConfig?.format ?? readEnvFormat()
  };
  let spansEnabled = true;
  const stages = [];
  const outputs = [];
  const branches = [];
  const disposables = [];
  for (const element of elements) {
    if (Array.isArray(element)) {
      const branch = buildPipeline(element, { ...config });
      branches.push(branch);
      disposables.push(() => branch.dispose());
      continue;
    }
    if (element === console || element === "console") {
      outputs.push({
        levelPriority: LOG_LEVEL_PRIORITY[config.level],
        nsFilter: config.ns,
        write: createConsoleSink(config.format)
      });
      continue;
    }
    if (typeof element === "function") {
      stages.push(element);
      continue;
    }
    if (isWritable(element)) {
      outputs.push({
        levelPriority: LOG_LEVEL_PRIORITY[config.level],
        nsFilter: config.ns,
        write: createWritableSink(element, config.format)
      });
      continue;
    }
    if (isPojo(element)) {
      const obj = element;
      const keys = Object.keys(obj);
      const hasSinkKey = keys.some((k) => SINK_KEYS.has(k));
      if (keys.some((k) => !VALID_CONFIG_KEYS.has(k) && !SINK_KEYS.has(k))) {
        const unknown = keys.find((k) => !VALID_CONFIG_KEYS.has(k) && !SINK_KEYS.has(k));
        throw new Error(`loggily: unknown config key "${unknown}" in config object. Valid keys: ${[...VALID_CONFIG_KEYS, ...SINK_KEYS].join(", ")}`);
      }
      if (hasSinkKey) {
        if (typeof obj.file === "string") {
          const outputLevel = isValidLogLevel(obj.level) ? obj.level : config.level;
          const outputNs = obj.ns ? parseNsFilter(obj.ns) : config.ns;
          const outputFormat = obj.format ?? config.format;
          const sink = createFileSink(obj.file, outputFormat);
          disposables.push(sink.dispose);
          outputs.push({
            levelPriority: LOG_LEVEL_PRIORITY[outputLevel],
            nsFilter: outputNs,
            write: sink.write,
            dispose: sink.dispose
          });
        }
        if (obj.otel !== undefined)
          throw new Error("loggily: OTEL sink is not yet implemented. See loggily/otel for the planned bridge.");
        continue;
      }
      if (isValidLogLevel(obj.level))
        config.level = obj.level;
      if (obj.ns !== undefined)
        config.ns = parseNsFilter(obj.ns);
      if (obj.format === "console" || obj.format === "json")
        config.format = obj.format;
      if (obj.spans === true)
        spansEnabled = true;
      if (obj.spans === false)
        spansEnabled = false;
      if (obj.idFormat === "simple" || obj.idFormat === "w3c")
        setIdFormat(obj.idFormat);
      if (typeof obj.sampleRate === "number")
        setSampleRate(obj.sampleRate);
      continue;
    }
    if (element === "stderr" && typeof process !== "undefined") {
      outputs.push({
        levelPriority: LOG_LEVEL_PRIORITY[config.level],
        nsFilter: config.ns,
        write: createWritableSink(process.stderr, config.format)
      });
      continue;
    }
    throw new Error(`loggily: unsupported config element of type "${typeof element}". Config arrays accept: objects (config), arrays (branches), functions (stages), console, "console", or writables ({ write }).`);
  }
  const dispatch = (event) => {
    if (event.kind === "span" && !spansEnabled)
      return;
    let e = event;
    for (const stage of stages) {
      const result = stage(e);
      if (result === null)
        return;
      if (result !== undefined)
        e = result;
    }
    for (const output of outputs) {
      if (e.kind === "log" && LOG_LEVEL_PRIORITY[e.level] < output.levelPriority)
        continue;
      if (output.nsFilter && !output.nsFilter(e.namespace))
        continue;
      output.write(e);
    }
    for (const branch of branches)
      branch.dispatch(e);
  };
  return {
    dispatch,
    level: config.level,
    dispose: () => {
      for (const d of disposables)
        d();
    }
  };
}
function readEnvLevel() {
  const env = getEnv("LOG_LEVEL")?.toLowerCase();
  let level = env === "trace" || env === "debug" || env === "info" || env === "warn" || env === "error" || env === "silent" ? env : "info";
  if (getEnv("DEBUG") && LOG_LEVEL_PRIORITY[level] > LOG_LEVEL_PRIORITY.debug)
    level = "debug";
  return level;
}
function readEnvLevelForNamespace(namespace) {
  const env = getEnv("LOG_LEVEL")?.toLowerCase();
  const baseLevel = env === "trace" || env === "debug" || env === "info" || env === "warn" || env === "error" || env === "silent" ? env : "info";
  if (getEnv("DEBUG") && LOG_LEVEL_PRIORITY[baseLevel] > LOG_LEVEL_PRIORITY.debug) {
    const nsFilter = readEnvNs();
    if (nsFilter && nsFilter(namespace))
      return "debug";
    return baseLevel;
  }
  return baseLevel;
}
function readEnvNs() {
  const debugEnv = getEnv("DEBUG");
  if (!debugEnv)
    return null;
  return parseNsFilter(debugEnv.split(",").map((s) => s.trim()));
}
function readEnvFormat() {
  const envFormat = getEnv("LOG_FORMAT")?.toLowerCase();
  if (envFormat === "json")
    return "json";
  if (envFormat === "console")
    return "console";
  if (getEnv("TRACE_FORMAT") === "json")
    return "json";
  if (getEnv("NODE_ENV") === "production")
    return "json";
  return "console";
}
function readEnvTrace() {
  const traceEnv = getEnv("TRACE");
  if (!traceEnv)
    return {
      enabled: false,
      filter: null
    };
  if (traceEnv === "1" || traceEnv === "true")
    return {
      enabled: true,
      filter: null
    };
  const prefixes = traceEnv.split(",").map((s) => s.trim());
  return {
    enabled: true,
    filter: (namespace) => {
      for (const prefix of prefixes)
        if (matchesPattern(namespace, prefix))
          return true;
      return false;
    }
  };
}
var _getContextTags = null;
var _getContextParent = null;
var _enterContext = null;
var _exitContext = null;
function createSpanDataProxy(getFields, attrs) {
  const READONLY_KEYS = new Set([
    "id",
    "traceId",
    "parentId",
    "startTime",
    "endTime",
    "duration"
  ]);
  return new Proxy(attrs, {
    get(_target, prop) {
      if (READONLY_KEYS.has(prop))
        return getFields()[prop];
      return attrs[prop];
    },
    set(_target, prop, value) {
      if (READONLY_KEYS.has(prop))
        return false;
      attrs[prop] = value;
      return true;
    }
  });
}
var collectedSpans = [];
var collectSpans = false;
function resolveMessage(msg) {
  return typeof msg === "function" ? msg() : msg;
}
function createLoggerImpl(name, props, pipeline) {
  const emitLog = (level, msgOrError, dataOrMsg, extraData) => {
    let message;
    let data;
    if (msgOrError instanceof Error) {
      const err = msgOrError;
      const contextTags = _getContextTags?.() ?? {};
      if (typeof dataOrMsg === "string") {
        message = dataOrMsg;
        data = {
          ...contextTags,
          ...props,
          ...extraData,
          error_type: err.name,
          error_message: err.message,
          error_stack: err.stack,
          error_code: err.code,
          error_cause: err.cause !== undefined ? serializeCause(err.cause) : undefined
        };
      } else {
        message = err.message;
        data = {
          ...contextTags,
          ...props,
          ...dataOrMsg,
          error_type: err.name,
          error_stack: err.stack,
          error_code: err.code,
          error_cause: err.cause !== undefined ? serializeCause(err.cause) : undefined
        };
      }
    } else {
      message = resolveMessage(msgOrError);
      const contextTags = _getContextTags?.();
      data = contextTags && Object.keys(contextTags).length > 0 ? {
        ...contextTags,
        ...props,
        ...dataOrMsg
      } : Object.keys(props).length > 0 || dataOrMsg ? {
        ...props,
        ...dataOrMsg
      } : undefined;
    }
    const event = {
      kind: "log",
      time: Date.now(),
      namespace: name,
      level,
      message,
      props: data
    };
    pipeline.dispatch(event);
  };
  return {
    name,
    props: Object.freeze({ ...props }),
    get level() {
      return pipeline.level;
    },
    dispatch(event) {
      pipeline.dispatch(event);
    },
    [Symbol.dispose]() {
      pipeline.dispose();
    },
    trace: (msg, data) => emitLog("trace", msg, data),
    debug: (msg, data) => emitLog("debug", msg, data),
    info: (msg, data) => emitLog("info", msg, data),
    warn: (msg, data) => emitLog("warn", msg, data),
    error: (msgOrError, dataOrMsg, extraData) => emitLog("error", msgOrError, dataOrMsg, extraData),
    logger(namespace, childProps) {
      return this.child(namespace ?? "", childProps);
    },
    span(_namespace, _childProps) {
      throw new Error("loggily: span() requires the withSpans() plugin. Use pipe(baseCreateLogger, withSpans()) or the default createLogger.");
    },
    child(namespaceOrContext, childProps) {
      if (typeof namespaceOrContext === "string")
        return wrapConditional(createLoggerImpl(namespaceOrContext ? `${name}:${namespaceOrContext}` : name, {
          ...props,
          ...childProps
        }, pipeline), () => pipeline.level);
      return wrapConditional(createLoggerImpl(name, {
        ...props,
        ...namespaceOrContext
      }, pipeline), () => pipeline.level);
    },
    end() {}
  };
}
function wrapConditional(logger, getLevel) {
  return new Proxy(logger, { get(target, prop) {
    if (typeof prop === "string" && prop in LOG_LEVEL_PRIORITY && prop !== "silent") {
      if (LOG_LEVEL_PRIORITY[prop] < LOG_LEVEL_PRIORITY[getLevel()])
        return;
    }
    if (prop === "span") {
      const val = target[prop];
      if (val === baseSpanStub)
        return;
      return val;
    }
    return target[prop];
  } });
}
var baseSpanStub = function baseSpanStub2(_namespace, _childProps) {
  throw new Error("loggily: span() requires the withSpans() plugin. Use pipe(baseCreateLogger, withSpans()) or the default createLogger.");
};
function withSpans() {
  return (factory, _ctx) => {
    return (name, configOrProps) => {
      return augmentWithSpans(factory(name, configOrProps), null, null, true);
    };
  };
}
function augmentWithSpans(logger, parentSpanId, traceId, traceSampled) {
  const spanState = {
    parentSpanId,
    traceId,
    traceSampled
  };
  return new Proxy(logger, { get(target, prop) {
    if (prop === "span")
      return createSpanMethod(target, spanState);
    if (prop === "child")
      return function child(namespaceOrContext, childProps) {
        return augmentWithSpans(target.child(namespaceOrContext, childProps), spanState.parentSpanId, spanState.traceId, spanState.traceSampled);
      };
    if (prop === "logger")
      return function logger2(namespace, childProps) {
        return augmentWithSpans(target.logger(namespace, childProps), spanState.parentSpanId, spanState.traceId, spanState.traceSampled);
      };
    return target[prop];
  } });
}
function createSpanMethod(logger, spanState) {
  return (namespace, childProps) => {
    const childName = namespace ? `${logger.name}:${namespace}` : logger.name;
    const resolvedChildProps = typeof childProps === "function" ? childProps() : childProps;
    const mergedProps = {
      ...logger.props,
      ...resolvedChildProps
    };
    const newSpanId = generateSpanId();
    let resolvedParentId = spanState.parentSpanId;
    let resolvedTraceId = spanState.traceId;
    if (!resolvedParentId && _getContextParent) {
      const ctxParent = _getContextParent();
      if (ctxParent) {
        resolvedParentId = ctxParent.spanId;
        resolvedTraceId = resolvedTraceId || ctxParent.traceId;
      }
    }
    const isNewTrace = !resolvedTraceId;
    const finalTraceId = resolvedTraceId || generateTraceId();
    const sampled = isNewTrace ? shouldSample() : spanState.traceSampled;
    const newSpanData = {
      id: newSpanId,
      traceId: finalTraceId,
      parentId: resolvedParentId,
      startTime: Date.now(),
      endTime: null,
      duration: null,
      attrs: {}
    };
    const spanAugmented = augmentWithSpans(logger.child(namespace ?? "", resolvedChildProps), newSpanId, finalTraceId, sampled);
    _enterContext?.(newSpanId, finalTraceId, resolvedParentId);
    const disposeSpan = () => {
      if (newSpanData.endTime !== null)
        return;
      newSpanData.endTime = Date.now();
      newSpanData.duration = newSpanData.endTime - newSpanData.startTime;
      if (collectSpans)
        collectedSpans.push(createSpanDataProxy(() => ({
          id: newSpanData.id,
          traceId: newSpanData.traceId,
          parentId: newSpanData.parentId,
          startTime: newSpanData.startTime,
          endTime: newSpanData.endTime,
          duration: newSpanData.duration
        }), { ...newSpanData.attrs }));
      _exitContext?.(newSpanId);
      if (sampled) {
        const spanEvent = {
          kind: "span",
          time: newSpanData.endTime,
          namespace: childName,
          name: childName,
          duration: newSpanData.duration,
          props: {
            ...mergedProps,
            ...newSpanData.attrs
          },
          spanId: newSpanData.id,
          traceId: newSpanData.traceId,
          parentId: newSpanData.parentId
        };
        logger.dispatch(spanEvent);
      }
    };
    const spanDataProxy = createSpanDataProxy(() => ({
      id: newSpanData.id,
      traceId: newSpanData.traceId,
      parentId: newSpanData.parentId,
      startTime: newSpanData.startTime,
      endTime: newSpanData.endTime,
      duration: newSpanData.endTime !== null ? newSpanData.endTime - newSpanData.startTime : Date.now() - newSpanData.startTime
    }), newSpanData.attrs);
    let currentDispose = disposeSpan;
    return new Proxy(spanAugmented, {
      get(target, prop) {
        if (prop === "spanData")
          return spanDataProxy;
        if (prop === Symbol.dispose)
          return currentDispose;
        if (prop === "end")
          return () => {
            if (newSpanData.endTime === null)
              currentDispose();
          };
        if (prop === "name")
          return childName;
        if (prop === "props")
          return Object.freeze({ ...mergedProps });
        return target[prop];
      },
      set(_target, prop, value) {
        if (prop === Symbol.dispose) {
          currentDispose = value;
          return true;
        }
        return false;
      }
    });
  };
}
function baseCreateLogger(name, configOrProps) {
  let pipeline;
  let props = {};
  if (Array.isArray(configOrProps))
    pipeline = buildPipeline(configOrProps);
  else if (configOrProps && typeof configOrProps === "object") {
    props = configOrProps;
    pipeline = buildPipeline(["console"]);
  } else
    pipeline = buildPipeline(["console"]);
  const logger = createLoggerImpl(name, props, pipeline);
  logger.span = baseSpanStub;
  return wrapConditional(logger, () => pipeline.level);
}
function pipe(base, ...plugins) {
  const ctx = {};
  return plugins.reduce((factory, plugin) => plugin(factory, ctx), base);
}
var _env = (typeof process !== "undefined" ? process : undefined)?.env ?? {};
function currentLevel() {
  return readEnvLevel();
}
function currentNs() {
  return readEnvNs();
}
function currentFormat() {
  return readEnvFormat();
}
function currentTrace() {
  return readEnvTrace();
}
var _writers = [];
var _suppressConsole = false;
var _logFileWriterFactory = null;
function _setLogFileWriterFactory(factory) {
  _logFileWriterFactory = factory;
}
function withEnvDefaults() {
  return (factory, _ctx) => (name, configOrProps) => {
    const envIdFormat = _env.TRACE_ID_FORMAT?.toLowerCase();
    if (envIdFormat === "simple" || envIdFormat === "w3c")
      setIdFormat(envIdFormat);
    const envSampleRate = _env.TRACE_SAMPLE_RATE;
    if (envSampleRate !== undefined) {
      const rate = Number.parseFloat(envSampleRate);
      if (!Number.isNaN(rate) && rate >= 0 && rate <= 1)
        setSampleRate(rate);
    }
    if (Array.isArray(configOrProps))
      return factory(name, configOrProps);
    const envPipeline = createEnvPipeline();
    const envStage = (event) => {
      envPipeline.dispatch(event);
      return null;
    };
    if (configOrProps && typeof configOrProps === "object")
      return applyNamespaceGating(factory(name, [{ level: "trace" }, envStage]).child(configOrProps));
    return applyNamespaceGating(factory(name, [{ level: "trace" }, envStage]));
  };
}
function applyNamespaceGating(logger) {
  return new Proxy(logger, { get(target, prop) {
    if (typeof prop === "string" && prop in LOG_LEVEL_PRIORITY && prop !== "silent") {
      const nsLevel = readEnvLevelForNamespace(target.name);
      if (LOG_LEVEL_PRIORITY[prop] < LOG_LEVEL_PRIORITY[nsLevel])
        return;
    }
    return target[prop];
  } });
}
function createEnvPipeline() {
  const disposables = [];
  const logFile = _env.LOG_FILE;
  let fileSink = null;
  if (logFile && _logFileWriterFactory) {
    const writer = _logFileWriterFactory(logFile);
    fileSink = (event) => {
      const fmt = currentFormat() === "json" ? formatJSONEvent : formatConsoleEvent;
      writer.write(fmt(event));
    };
    disposables.push(() => writer.close());
  }
  const dispatch = (event) => {
    if (event.kind === "log" && LOG_LEVEL_PRIORITY[event.level] < LOG_LEVEL_PRIORITY[currentLevel()])
      return;
    if (event.kind === "span") {
      const trace = currentTrace();
      if (!trace.enabled)
        return;
      if (trace.filter && !trace.filter(event.namespace))
        return;
    }
    const ns = currentNs();
    if (ns && !ns(event.namespace))
      return;
    const text = (currentFormat() === "json" ? formatJSONEvent : formatConsoleEvent)(event);
    const lvl = event.kind === "log" ? event.level : "span";
    for (const w of _writers)
      w(text, lvl);
    if (!_suppressConsole)
      writeToConsole(text, event);
    fileSink?.(event);
  };
  return {
    dispatch,
    get level() {
      return currentLevel();
    },
    dispose: () => {
      for (const d of disposables)
        d();
    }
  };
}
function withConfigMetrics() {
  return (factory, _ctx) => {
    return (name, configOrProps) => {
      const logger = factory(name, configOrProps);
      if (!Array.isArray(configOrProps))
        return logger;
      if (!configOrProps.some((el) => typeof el === "object" && el !== null && !Array.isArray(el) && ("metrics" in el) && el.metrics === true))
        return logger;
      return withMetrics(createMetricsCollector())(logger);
    };
  };
}
var createLogger = pipe(baseCreateLogger, withEnvDefaults(), withSpans(), withConfigMetrics());
function setSuppressConsole(value) {
  _suppressConsole = value;
}

// node_modules/.bun/loggily@0.8.0+e40b0dfdd726a224/node_modules/loggily/dist/index.mjs
_setLogFileWriterFactory(createFileWriter);

// packages/tribe-client/src/parser.ts
var log = createLogger("tribe-client:parser");
function createLineParser(onMessage) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(`
`);
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed)
        continue;
      try {
        onMessage(JSON.parse(trimmed));
      } catch {
        log.warn?.(`Invalid JSON: ${trimmed.slice(0, 100)}`);
      }
    }
  };
}
// packages/tribe-client/src/client.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, unlinkSync } from "fs";
import { createConnection } from "net";
import { spawn } from "child_process";
import { dirname as dirname2 } from "path";

// packages/tribe-client/src/timers.ts
function createTimers(signal) {
  const timeouts = new Set;
  const intervals = new Set;
  signal.addEventListener("abort", () => {
    for (const t of timeouts)
      globalThis.clearTimeout(t);
    for (const t of intervals)
      globalThis.clearInterval(t);
    timeouts.clear();
    intervals.clear();
  }, { once: true });
  return {
    setTimeout(fn, ms) {
      if (signal.aborted)
        return null;
      const t = globalThis.setTimeout(() => {
        timeouts.delete(t);
        if (!signal.aborted)
          fn();
      }, ms);
      t.unref?.();
      timeouts.add(t);
      return t;
    },
    setInterval(fn, ms) {
      if (signal.aborted)
        return null;
      const t = globalThis.setInterval(() => {
        if (signal.aborted) {
          globalThis.clearInterval(t);
          intervals.delete(t);
          return;
        }
        fn();
      }, ms);
      t.unref?.();
      intervals.add(t);
      return t;
    },
    clearTimeout(t) {
      globalThis.clearTimeout(t);
      timeouts.delete(t);
    },
    clearInterval(t) {
      globalThis.clearInterval(t);
      intervals.delete(t);
    },
    delay(ms) {
      return new Promise((resolve2, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const t = globalThis.setTimeout(resolve2, ms);
        t.unref?.();
        timeouts.add(t);
        signal.addEventListener("abort", () => {
          globalThis.clearTimeout(t);
          timeouts.delete(t);
          reject(signal.reason);
        }, { once: true });
      });
    }
  };
}

// packages/tribe-client/src/client.ts
var log2 = createLogger("tribe-client:client");
function connectToDaemon(socketPath, opts) {
  const callTimeoutMs = opts?.callTimeoutMs ?? 1e4;
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath);
    const pending = new Map;
    const notificationHandlers = [];
    let nextId = 1;
    const ac = new AbortController;
    const timers = createTimers(ac.signal);
    const parse = createLineParser((msg) => {
      if (isResponse(msg)) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error)
            p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }));
          else
            p.resolve(msg.result);
        }
      } else if (isNotification(msg)) {
        for (const h of notificationHandlers)
          h(msg.method, msg.params);
      }
    });
    socket.on("data", parse);
    socket.on("error", reject);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      socket.on("error", (err) => {
        log2.error?.(`Connection error: ${err.message}`);
        for (const [, p] of pending)
          p.reject(err);
        pending.clear();
      });
      let timeouts = 0;
      const client = {
        call(method, params) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { resolve: res, reject: rej });
            socket.write(makeRequest(id, method, params));
            timers.setTimeout(() => {
              if (!pending.delete(id))
                return;
              rej(new Error(`Request ${method} timed out`));
              if (++timeouts >= 3) {
                log2.warn?.(`${timeouts} consecutive timeouts, destroying connection`);
                socket.destroy();
              }
            }, callTimeoutMs);
          }).then((v) => {
            timeouts = 0;
            return v;
          });
        },
        notify(method, params) {
          socket.write(makeNotification(method, params));
        },
        onNotification(handler) {
          notificationHandlers.push(handler);
        },
        close() {
          for (const [, p] of pending)
            p.reject(new Error("Connection closed"));
          pending.clear();
          ac.abort();
          socket.end();
        },
        socket
      };
      resolvePromise(client);
    });
  });
}
async function connectOrStart(socketPath, opts) {
  try {
    return await connectToDaemon(socketPath, { callTimeoutMs: opts?.callTimeoutMs });
  } catch (err) {
    const code = err.code;
    if (code !== "ECONNREFUSED" && code !== "ENOENT")
      throw err;
    if (opts?.noSpawn)
      throw err;
  }
  if (existsSync2(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {}
  }
  const socketDir = dirname2(socketPath);
  if (!existsSync2(socketDir))
    mkdirSync2(socketDir, { recursive: true });
  const script = opts?.daemonScript;
  if (!script) {
    throw new Error(`connectOrStart: no daemon at ${socketPath} and no daemonScript provided to spawn one`);
  }
  const args = ["--socket", socketPath, ...opts?.daemonArgs ?? []];
  const child = spawn(process.execPath, [script, ...args], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  const maxAttempts = opts?.maxStartupAttempts ?? 10;
  for (let attempt = 0;attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, Math.min(100 * 2 ** attempt, 2000)));
    try {
      return await connectToDaemon(socketPath, { callTimeoutMs: opts?.callTimeoutMs });
    } catch {}
  }
  throw new Error(`Failed to connect to daemon at ${socketPath} after starting it`);
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
    maxStartupAttempts
  } = opts;
  const startOpts = { callTimeoutMs, daemonScript, daemonArgs, maxStartupAttempts };
  let current = await connectOrStart(socketPath, startOpts);
  if (onConnect)
    await onConnect(current);
  let closed = false;
  let reconnectAc = null;
  const notificationHandlers = [];
  const setupReconnect = () => {
    current.socket.on("close", () => {
      if (closed)
        return;
      onDisconnect?.();
      reconnectAc?.abort();
      reconnectAc = new AbortController;
      const timers = createTimers(reconnectAc.signal);
      (async () => {
        for (let attempt = 0;attempt < maxAttempts; attempt++) {
          if (closed)
            return;
          const ms = Math.min(500 * 2 ** attempt, 1e4);
          try {
            await timers.delay(ms);
          } catch {
            return;
          }
          if (closed)
            return;
          try {
            current = await connectOrStart(socketPath, startOpts);
            if (onConnect)
              await onConnect(current);
            for (const h of notificationHandlers)
              current.onNotification(h);
            setupReconnect();
            onReconnect?.();
            return;
          } catch {
            log2.debug?.(`Reconnect attempt ${attempt + 1} failed`);
          }
        }
        log2.error?.(`Failed to reconnect after ${maxAttempts} attempts`);
      })();
    });
  };
  setupReconnect();
  return new Proxy(current, {
    get(_, prop) {
      if (prop === "close")
        return () => {
          closed = true;
          reconnectAc?.abort();
          current.close();
          current.socket.unref();
        };
      if (prop === "onNotification")
        return (handler) => {
          notificationHandlers.push(handler);
          current.onNotification(handler);
        };
      return current[prop];
    }
  });
}
// packages/tribe-client/src/paths.ts
import { resolve as resolve2 } from "path";
function resolveSocketPath(socketArg) {
  if (socketArg)
    return socketArg;
  if (process.env.TRIBE_SOCKET)
    return process.env.TRIBE_SOCKET;
  const xdg = process.env.XDG_RUNTIME_DIR;
  return xdg ? resolve2(xdg, "tribe.sock") : resolve2(process.env.HOME ?? "/tmp", ".local/share/tribe/tribe.sock");
}
// packages/tribe-client/src/composition/scope.ts
class Scope extends AsyncDisposableStack {
  signal;
  name;
  #children = new Set;
  #parent;
  constructor(parent, name) {
    super();
    this.name = name;
    this.#parent = parent;
    const controller = new AbortController;
    this.signal = controller.signal;
    this.defer(() => controller.abort());
    if (parent) {
      if (parent.disposed) {
        throw new ReferenceError("Cannot create child of disposed scope");
      }
      if (parent.signal.aborted) {
        controller.abort();
      } else {
        const onAbort = () => controller.abort();
        parent.signal.addEventListener("abort", onAbort, { once: true });
        this.defer(() => parent.signal.removeEventListener("abort", onAbort));
      }
      parent.#children.add(this);
    }
  }
  child(name) {
    return new Scope(this, name);
  }
  async[Symbol.asyncDispose]() {
    if (this.disposed)
      return;
    const errors = [];
    const children = [...this.#children].reverse();
    this.#children.clear();
    for (const c of children) {
      try {
        await c[Symbol.asyncDispose]();
      } catch (e) {
        errors.push(e);
      }
    }
    try {
      await super[Symbol.asyncDispose]();
    } catch (e) {
      errors.push(e);
    }
    if (this.#parent)
      this.#parent.#children.delete(this);
    if (errors.length === 1)
      throw errors[0];
    if (errors.length > 1) {
      throw errors.reduce((acc, e) => new SuppressedError(e, acc, "Multiple disposers threw"));
    }
  }
  move() {
    throw new TypeError("Scope.move() is not supported \u2014 create a new scope and re-register resources explicitly");
  }
}
// tools/lib/tribe/socket.ts
var TRIBE_PROTOCOL_VERSION = 5;
function defaultDaemonScript() {
  return resolve3(dirname3(new URL(import.meta.url).pathname), "../../tribe-daemon.ts");
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
    daemonArgs: opts.dbPath ? ["--db", opts.dbPath] : undefined
  };
  return createReconnectingClient(clientOpts);
}

// tools/lib/tribe/tools-list.ts
var ERROR_SHAPE = {
  error: { type: "string", description: "Error message \u2014 present when the tool refused or hit an exception." }
};
var OBJ = (properties, description) => ({
  type: "object",
  description,
  properties,
  additionalProperties: true
});
var TOOLS_LIST = [
  {
    name: "send",
    description: 'Send a message to one tribe member, or to everyone with to: "*".',
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: 'Recipient session name, or "*" for broadcast' },
        message: { type: "string", description: "Message content" },
        type: {
          type: "string",
          description: "Message type. The tribe-wire daemon delivers every type to every session \u2014 no type is role-gated.",
          enum: ["assign", "status", "query", "response", "notify", "request", "verdict"],
          default: "notify"
        },
        bead: { type: "string", description: "Associated bead ID (optional)" },
        ref: { type: "string", description: "Reference to a previous message ID (optional)" }
      },
      required: ["to", "message"]
    },
    outputSchema: OBJ({
      sent: { type: "boolean", description: "True on successful send." },
      id: { type: "string", description: "Message id assigned by the daemon." },
      ...ERROR_SHAPE
    }, "Send result: { sent, id } on success, { error } on validation failure.")
  },
  {
    name: "fetch",
    description: "Read tribe messages. Default drains this session's pending queue and advances its cursor. ids/with/from/to reads are snapshots. since scans the journal and advances only with advance:true.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Fetch specific message IDs without advancing the cursor."
        },
        topics: {
          type: "array",
          items: { type: "string" },
          description: "Optional topic globs, e.g. ['github:*', 'git:commit']."
        },
        since: {
          type: "number",
          description: "Scan rows with rowid > since. Default mode uses the session cursor."
        },
        with: { type: "string", description: "Bilateral history with this session name." },
        from: { type: "string", description: "One-sided history from this sender." },
        to: { type: "string", description: "One-sided history to this recipient." },
        limit: { type: "number", description: "Max rows to return (default 50, max 500)." },
        advance: {
          type: "boolean",
          description: "Advance the session cursor after a since/default scan. Default: true only for default drain."
        }
      }
    },
    outputSchema: OBJ({
      events: {
        type: "array",
        description: "Visible messages. Each: { id, rowid, type, from, to, content, bead?, ref?, ts (ISO), delivery, topic?, room_id? }.",
        items: { type: "object", additionalProperties: true }
      },
      cursor: { type: "number", description: "Highest rowid returned (or unchanged when no rows matched)." },
      ...ERROR_SHAPE
    }, "Fetch result: { events, cursor } on success, { error } on argument validation failure.")
  },
  {
    name: "members",
    description: "List active tribe sessions with their domains",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Include dead sessions (default: false)" }
      }
    },
    outputSchema: OBJ({
      sessions: {
        type: "array",
        description: "Per-session rows: { name, role, domains, pid, cwd, claude_session_id?, claude_session_name?, alive, uptime_min, last_seen_sec, parent? }.",
        items: { type: "object", additionalProperties: true }
      }
    }, "Members list \u2014 array of session records under `sessions`.")
  },
  {
    name: "rename",
    description: "Rename this session in the tribe",
    inputSchema: {
      type: "object",
      properties: {
        new_name: { type: "string", description: "New session name" }
      },
      required: ["new_name"]
    },
    outputSchema: OBJ({
      renamed: { type: "boolean" },
      old_name: { type: "string" },
      new_name: { type: "string" },
      name: { type: "string", description: "Present on rename-to-self no-op." },
      existing_names: {
        type: "array",
        items: { type: "string" },
        description: "On collision: active session names already in use."
      },
      ...ERROR_SHAPE
    }, "Rename result: { renamed, old_name, new_name } on success, { renamed:false, name } on no-op, { error, existing_names? } on collision.")
  },
  {
    name: "health",
    description: "Diagnostic: check for silent members, stale beads, unread messages",
    inputSchema: {
      type: "object",
      properties: {}
    },
    outputSchema: OBJ({
      members: {
        type: "array",
        description: "Per-member diagnostic: { name, role, domains, pid, alive, warnings: string[], ... }.",
        items: { type: "object", additionalProperties: true }
      },
      stale_beads: { type: "number", description: "Count of beads claimed but idle past threshold." },
      unread: { type: "number", description: "Messages addressed to this session not yet drained." },
      reconciler: {
        type: "object",
        description: "Optional chief-reconciler snapshot (opt-in via TRIBE_RECONCILER_SNAPSHOT env var). Field shape mirrors @km/tribe/stable-coordination L4.",
        additionalProperties: true
      }
    }, "Health snapshot \u2014 members + counts + optional reconciler snapshot.")
  },
  {
    name: "join",
    description: "Re-announce this session's name and domains after compaction or rejoin.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name" },
        domains: {
          type: "array",
          items: { type: "string" },
          description: "Domain expertise areas, e.g. ['silvery', 'flexily']."
        },
        delivery: {
          type: "string",
          description: "How this session consumes messages. 'push' sends channel notifications. 'pull' queues rows for tribe.fetch. Sender is transport-blind.",
          enum: ["push", "pull"]
        }
      },
      required: ["name"]
    },
    outputSchema: OBJ({
      joined: { type: "boolean" },
      name: { type: "string" },
      role: { type: "string" },
      domains: { type: "array", items: { type: "string" } },
      delivery: { type: "string", enum: ["push", "pull"] },
      previous_name: {
        type: "string",
        description: "Set when this join performed a rename relative to the prior session name."
      },
      ...ERROR_SHAPE
    }, "Join result: { joined, name, role, domains, delivery, previous_name? }. { error } on name validation failure.")
  },
  {
    name: "reload",
    description: "Hot-reload the tribe MCP server \u2014 re-exec with latest code from disk. Use after tribe code is updated to pick up fixes without restarting the Claude Code session.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why the reload is needed (logged to events)" }
      }
    },
    outputSchema: OBJ({
      reloading: { type: "boolean" },
      reason: { type: "string" },
      pid: { type: "number", description: "PID of the daemon about to re-exec." }
    }, "Reload acknowledgment \u2014 the actual re-exec happens shortly after this response flushes.")
  },
  {
    name: "retro",
    description: "Generate a retrospective report analyzing tribe message history, coordination health, and per-member activity",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: 'Duration to look back (e.g. "2h", "30m", "1d"). Default: entire session.'
        },
        format: {
          type: "string",
          description: "Output format",
          enum: ["markdown", "json"],
          default: "markdown"
        }
      }
    },
    outputSchema: OBJ({
      text: {
        type: "string",
        description: "Markdown retro report. Present when format=markdown (default). For format=json the structured payload is the full retro report object instead \u2014 properties such as session count, message volume, per-member breakdowns."
      },
      ...ERROR_SHAPE
    }, "Retro result: { text } for markdown, full report object for json, { error } on invalid duration.")
  },
  {
    name: "debug",
    description: "Dump daemon internals for troubleshooting \u2014 clients, per-session cursors.",
    inputSchema: {
      type: "object",
      properties: {}
    },
    outputSchema: OBJ({
      clients: { type: "array", items: { type: "object", additionalProperties: true } },
      cursors: { type: "array", items: { type: "object", additionalProperties: true } }
    }, "Daemon internals \u2014 shape varies by daemon build; always at least { clients, cursors }.")
  },
  {
    name: "filter",
    description: "Per-session filter for incoming channel events. mode controls focus level; mute stores topic globs to silence until the optional timestamp. Empty args clears the filter.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["focus", "normal", "ambient"],
          description: "Persistent filter mode. Defaults to 'normal' when args are empty."
        },
        mute: {
          type: "array",
          items: { type: "string" },
          description: "Optional topic globs to silence, e.g. ['github:*']."
        },
        until: {
          type: "number",
          description: "Optional unix-ms timestamp at which mute expires. Absent = persistent."
        }
      },
      required: []
    },
    outputSchema: OBJ({
      set: { type: "boolean" },
      mode: { type: "string", enum: ["focus", "normal", "ambient"] },
      until: {
        type: ["string", "null"],
        description: "ISO timestamp at which mute expires; null when no expiry."
      },
      mute: {
        type: ["array", "null"],
        items: { type: "string" },
        description: "Topic globs being silenced; null when not muting anything."
      },
      ...ERROR_SHAPE
    }, "Filter result: { set, mode, until, mute } on success, { error } on argument validation failure.")
  }
];

// tools/lib/tribe/timers.ts
function createTimers2(signal) {
  const timeouts = new Set;
  const intervals = new Set;
  signal.addEventListener("abort", () => {
    for (const t of timeouts)
      globalThis.clearTimeout(t);
    for (const t of intervals)
      globalThis.clearInterval(t);
    timeouts.clear();
    intervals.clear();
  }, { once: true });
  return {
    setTimeout(fn, ms) {
      if (signal.aborted)
        return null;
      const t = globalThis.setTimeout(() => {
        timeouts.delete(t);
        if (!signal.aborted)
          fn();
      }, ms);
      t.unref?.();
      timeouts.add(t);
      return t;
    },
    setInterval(fn, ms) {
      if (signal.aborted)
        return null;
      const t = globalThis.setInterval(() => {
        if (signal.aborted) {
          globalThis.clearInterval(t);
          intervals.delete(t);
          return;
        }
        fn();
      }, ms);
      t.unref?.();
      intervals.add(t);
      return t;
    },
    clearTimeout(t) {
      globalThis.clearTimeout(t);
      timeouts.delete(t);
    },
    clearInterval(t) {
      globalThis.clearInterval(t);
      intervals.delete(t);
    },
    delay(ms) {
      return new Promise((resolve4, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const t = globalThis.setTimeout(resolve4, ms);
        t.unref?.();
        timeouts.add(t);
        signal.addEventListener("abort", () => {
          globalThis.clearTimeout(t);
          timeouts.delete(t);
          reject(signal.reason);
        }, { once: true });
      });
    }
  };
}

// plugins/injection-envelope/src/defang.ts
var LOG_LINE_RE = /\d{2}:\d{2}:\d{2}\s+(?:INFO|WARN|ERROR|DEBUG|TRACE)\s+\S+(?:\s[^\n]*)?/g;
var ROLE_PREFIX_RE = /(^|\n)(Human|Assistant|User|H):(?=\s|$)/g;
var ZWSP = String.fromCharCode(8203);
var LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function defangRolePrefix(_match, lead, role) {
  return `${lead}${role[0]}${ZWSP}${role.slice(1)}:`;
}
function defangModelInput(text) {
  if (text.length === 0)
    return text;
  return text.replace(LOG_LINE_RE, "[log-redacted]").replace(ROLE_PREFIX_RE, defangRolePrefix).replace(/\n{3,}/g, `

`).replace(LONE_SURROGATE_RE, "\uFFFD");
}

// tools/lib/tribe/cwd-guardrail.ts
import { existsSync as existsSync3 } from "fs";
import { basename as basename2, dirname as dirname4 } from "path";
import { spawnSync } from "child_process";
function parseCwdPolicy(raw) {
  if (raw === "ignore" || raw === "warn" || raw === "refuse")
    return raw;
  return "warn";
}
function readCwdPolicyFromEnv(env = process.env) {
  if (env.BEARLY_ALLOW_MAIN_REPO_CWD === "1" || env.BEARLY_ALLOW_MAIN_REPO_CWD === "true")
    return "ignore";
  return parseCwdPolicy(env.TRIBE_MAIN_REPO_POLICY);
}
function isPoolSlotName(name) {
  return /-wt\d+$/.test(name);
}
function findSiblingPoolSlots(repoRoot) {
  const parent = dirname4(repoRoot);
  const repoBasename = basename2(repoRoot);
  const slots = [];
  for (let n = 0;n < 10; n++) {
    const slotName = `${repoBasename}-wt${n}`;
    const slotPath = `${parent}/${slotName}`;
    if (existsSync3(slotPath))
      slots.push(slotName);
  }
  return slots;
}
function migrationOneLiner(repoRoot) {
  const repoBasename = basename2(repoRoot);
  return `bun worktree create wtN && cd ../${repoBasename}-wtN`;
}
function evaluateCwdPolicy(policy, probe) {
  if (policy === "ignore") {
    return { kind: "ignored", reason: "policy=ignore (or BEARLY_ALLOW_MAIN_REPO_CWD=1)" };
  }
  if (!probe.gitRoot) {
    return { kind: "ok", reason: "cwd is not inside a git repo" };
  }
  if (isPoolSlotName(basename2(probe.gitRoot))) {
    return { kind: "ok", reason: `cwd is pool slot ${basename2(probe.gitRoot)}` };
  }
  const branch = probe.headBranch ?? "";
  if (branch !== "main" && branch !== "master") {
    return { kind: "ok", reason: `HEAD is on ${branch || "(unknown)"}, not main` };
  }
  if (probe.siblingPoolSlots.length === 0) {
    return { kind: "ok", reason: "no `<repo>-wt<N>` pool detected \u2014 solo repo, no isolation needed" };
  }
  const projectBasename = basename2(probe.gitRoot);
  const oneLiner = migrationOneLiner(probe.gitRoot);
  const baseMsg = `tribe: standalone session running in main repo (${projectBasename}) on branch ${branch}. ` + `Tribe SOP \xA7F2a says main stays on main \u2014 edits should land in a pool slot. ` + `Migrate with: ${oneLiner}. ` + `Pool slots present: ${probe.siblingPoolSlots.join(", ")}. ` + `Set TRIBE_MAIN_REPO_POLICY=ignore (or BEARLY_ALLOW_MAIN_REPO_CWD=1) to silence this for legitimate chief / exploratory sessions.`;
  if (policy === "refuse") {
    return { kind: "refuse", message: `REFUSE: ${baseMsg}` };
  }
  return { kind: "warn", message: baseMsg };
}
function probeCwd(cwd = process.cwd()) {
  const git = (args) => {
    try {
      const res = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      if (res.status !== 0)
        return null;
      return res.stdout.trim() || null;
    } catch {
      return null;
    }
  };
  const gitRoot = git(["rev-parse", "--show-toplevel"]);
  const headBranch = gitRoot ? git(["rev-parse", "--abbrev-ref", "HEAD"]) : null;
  const siblingPoolSlots = gitRoot ? findSiblingPoolSlots(gitRoot) : [];
  return { cwd, gitRoot, headBranch, siblingPoolSlots };
}

// tools/lib/tribe/hot-reload.ts
import { createHash as createHash2 } from "crypto";
import { existsSync as existsSync4, readdirSync, readFileSync as readFileSync2, watch } from "fs";
import { dirname as dirname5, resolve as resolve4 } from "path";
import { spawn as spawn2 } from "child_process";
var log3 = createLogger("tribe:reload");
function setupHotReload(opts) {
  const { importMetaUrl, extraFiles = [], extraDirs = [], onReload, logActivity, debounceMs = 500 } = opts;
  if (!importMetaUrl.startsWith("file://"))
    return null;
  const scriptPath = new URL(importMetaUrl).pathname;
  const reloadScriptName = scriptPath.split("/").pop()?.replace(/\.(ts|tsx)$/, "") ?? "unknown";
  const sourceDir = dirname5(scriptPath);
  const libTribeDir = resolve4(sourceDir, "lib/tribe");
  if (process.env.__TRIBE_HOT_RELOAD === "1") {
    delete process.env.__TRIBE_HOT_RELOAD;
    log3.info?.(`Hot-reloaded: ${reloadScriptName}`);
    logActivity?.("reload", `${reloadScriptName} hot-reloaded`);
  }
  function getSourceFiles() {
    const files = [scriptPath, ...extraFiles];
    const dirs = [libTribeDir, ...extraDirs];
    for (const dir of dirs) {
      try {
        if (existsSync4(dir)) {
          for (const f of readdirSync(dir)) {
            if (f.endsWith(".ts"))
              files.push(resolve4(dir, f));
          }
        }
      } catch {}
    }
    return files.sort();
  }
  function computeHash() {
    const hash = createHash2("md5");
    for (const f of getSourceFiles()) {
      try {
        hash.update(readFileSync2(f));
      } catch {}
    }
    return hash.digest("hex").slice(0, 12);
  }
  const currentHash = computeHash();
  let debounceTimer = null;
  const watchers = [];
  function onChange(filename) {
    if (filename && !filename.endsWith(".ts") && !filename.endsWith(".tsx"))
      return;
    if (debounceTimer)
      clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const newHash = computeHash();
      if (newHash === currentHash)
        return;
      log3.info?.(`Source changed (${currentHash} \u2192 ${newHash}), re-execing`);
      logActivity?.("reload", `${reloadScriptName} reloading (${currentHash} \u2192 ${newHash})`);
      for (const w of watchers)
        w.close();
      watchers.length = 0;
      onReload?.();
      const child = spawn2(process.execPath, process.argv.slice(1), {
        stdio: "inherit",
        env: { ...process.env, __TRIBE_HOT_RELOAD: "1" },
        detached: true
      });
      child.unref();
      process.exit(0);
    }, debounceMs);
  }
  try {
    watchers.push(watch(sourceDir, { persistent: false }, (_e, f) => onChange(f)));
  } catch {}
  if (existsSync4(libTribeDir)) {
    try {
      watchers.push(watch(libTribeDir, { persistent: false }, (_e, f) => onChange(f)));
    } catch {}
  }
  for (const dir of extraDirs) {
    if (existsSync4(dir)) {
      try {
        watchers.push(watch(dir, { persistent: false }, (_e, f) => onChange(f)));
      } catch {}
    }
  }
  log3.info?.(`Watching ${getSourceFiles().length} source files for hot-reload`);
  return {
    [Symbol.dispose]() {
      if (debounceTimer)
        clearTimeout(debounceTimer);
      for (const w of watchers)
        w.close();
    }
  };
}

// tools/lib/tribe/session.ts
import { existsSync as existsSync5, readFileSync as readFileSync3 } from "fs";
import { resolve as resolve5 } from "path";
var log4 = createLogger("tribe:session");
function resolveTranscriptPath(claudeSessionId) {
  if (!claudeSessionId)
    return null;
  const cwd = process.cwd();
  const projectKey = "-" + cwd.replace(/\//g, "-");
  const transcriptPath = resolve5(process.env.HOME ?? "~", ".claude/projects", projectKey, `${claudeSessionId}.jsonl`);
  return existsSync5(transcriptPath) ? transcriptPath : null;
}
function readTranscriptSlug(transcriptPath) {
  if (!transcriptPath)
    return null;
  try {
    const size = Bun.file(transcriptPath).size;
    if (size === 0)
      return null;
    const text = new TextDecoder().decode(new Uint8Array(readFileSync3(transcriptPath).buffer.slice(Math.max(0, size - 4096))));
    const lines = text.trimEnd().split(`
`);
    const lastLine = lines[lines.length - 1];
    if (!lastLine)
      return null;
    const data = JSON.parse(lastLine);
    return data.slug ?? null;
  } catch {
    return null;
  }
}

// tools/stdio-adapter.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn as spawn3 } from "child_process";
import { createHash as createHash3, randomUUID } from "crypto";
function sendChannel(content, meta) {
  if (!mcp)
    return;
  const safeContent = defangModelInput(content);
  mcp.notification({ method: "notifications/claude/channel", params: { content: safeContent, meta } }).catch(() => {});
}
function isNotificationOnlyType(type) {
  if (type === "session" || type === "status" || type === "delta")
    return true;
  if (type.startsWith("chief:"))
    return true;
  if (type.startsWith("github:"))
    return true;
  return false;
}
function markedType(type) {
  return isNotificationOnlyType(type) ? `${NOTIFICATION_ONLY_MARKER}:${type}` : type;
}
function parseToolText(result) {
  const text = result.content?.[0]?.text;
  if (typeof text !== "string")
    return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function isAutoName(name) {
  return name.startsWith("member-") || name.startsWith("pending-") || /^[a-z]+-\d+-[a-z0-9]{3}$/.test(name);
}
function tryAutoRenameOnClaim(content) {
  if (autoRenamed)
    return;
  if (!/^km-\d+-[a-z0-9]{3}$/.test(myName))
    return;
  const byMatch = content.match(/\[by:claude:([a-f0-9]+)\]/);
  if (!byMatch)
    return;
  const claimSessionPrefix = byMatch[1];
  if (!CLAUDE_SESSION_ID || !CLAUDE_SESSION_ID.startsWith(claimSessionPrefix))
    return;
  const beadMatch = content.match(/^Claimed: (km-[a-z][\w-]*?)\./);
  if (!beadMatch)
    return;
  const scope = beadMatch[1];
  if (scope === myName)
    return;
  autoRenamed = true;
  daemon?.call("tribe.rename", { new_name: scope }).then((result) => {
    const r = result;
    try {
      const data = JSON.parse(r.content[0]?.text ?? "{}");
      if (data.name)
        myName = data.name;
    } catch {}
  }).catch(() => {});
}
function forwardFetchedEvent(event) {
  const content = String(event.content ?? "");
  const type = markedType(String(event.type ?? "notify"));
  if (type === "bead:claimed")
    tryAutoRenameOnClaim(content);
  sendChannel(content, {
    from: String(event.from ?? "unknown"),
    type,
    bead: event.bead ? String(event.bead) : undefined,
    message_id: event.id ? String(event.id) : undefined
  });
}
function drainDaemonInbox() {
  if (drainInFlight) {
    drainAgain = true;
    return;
  }
  drainInFlight = true;
  (async () => {
    try {
      do {
        drainAgain = false;
        for (;; ) {
          const result = parseToolText(await daemon?.call("tribe.fetch", { limit: 500 }));
          const events = result?.events ?? [];
          for (const event of events)
            forwardFetchedEvent(event);
          if (events.length < 500)
            break;
        }
      } while (drainAgain);
    } catch (err) {
      log5.warn?.(`Failed to drain tribe inbox after wakeup: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      drainInFlight = false;
      if (drainAgain)
        drainDaemonInbox();
    }
  })();
}
let __stack = [];
try {
  if (process.env.DEBUG_LOG) {
    process.env.LOG_FILE ??= process.env.DEBUG_LOG;
    setSuppressConsole(true);
  }
  var log5 = createLogger("tribe:stdio-adapter");
  var proxyAc = new AbortController;
  var timers = createTimers2(proxyAc.signal);
  var args = parseTribeArgs();
  var SOCKET_PATH = resolveSocketPath(args.socket);
  var SESSION_DOMAINS = parseSessionDomains(args);
  var CLAUDE_SESSION_ID = resolveClaudeSessionId();
  var CLAUDE_SESSION_NAME = resolveClaudeSessionName();
  var CWD_POLICY = readCwdPolicyFromEnv();
  var CWD_EVAL = evaluateCwdPolicy(CWD_POLICY, probeCwd());
  if (CWD_EVAL.kind === "warn" || CWD_EVAL.kind === "refuse") {
    log5.warn?.(CWD_EVAL.message);
  } else {
    log5.debug?.(`cwd-guardrail: ${CWD_EVAL.kind} (${CWD_EVAL.reason})`);
  }
  log5.info?.(`Connecting to daemon at ${SOCKET_PATH}`);
  var myName = "pending";
  var myRole = "member";
  var mySessionId = randomUUID();
  var PROJECT_NAME = resolveProjectName();
  var mcp;
  var daemon;
  var daemonReady;
  var NOTIFICATION_ONLY_MARKER = "notification-only:do-not-acknowledge-or-respond-to";
  var identityToken = createHash3("sha256").update(`${CLAUDE_SESSION_ID ?? ""}|${process.cwd()}|${args.role ?? "member"}`).digest("hex").slice(0, 16);
  var DELIVERY = process.env.TRIBE_DELIVERY === "pull" ? "pull" : "push";
  var registerParams = {
    ...args.name ? { name: args.name } : {},
    ...args.role ? { role: args.role } : {},
    domains: SESSION_DOMAINS,
    project: process.cwd(),
    projectName: PROJECT_NAME,
    projectId: resolveProjectId(),
    protocolVersion: TRIBE_PROTOCOL_VERSION,
    peerSocket: null,
    pid: process.pid,
    claudeSessionId: CLAUDE_SESSION_ID,
    claudeSessionName: CLAUDE_SESSION_NAME,
    identityToken,
    delivery: DELIVERY,
    ...args.account ? { account: args.account } : {},
    ...args.provider ? { provider: args.provider } : {}
  };
  daemonReady = createReconnectingClient2({
    socketPath: SOCKET_PATH,
    async onConnect(client) {
      const reg = await client.call("register", registerParams);
      myName = reg.name;
      myRole = reg.role;
      log5.info?.(`Registered as ${myName} (${myRole})`);
      client.call("subscribe").catch(() => {});
      try {
        const membersResult = await client.call("tribe.members", {});
        const membersData = JSON.parse(membersResult.content?.[0]?.text ?? "{}");
        const sessions = (membersData.sessions ?? []).filter((s) => s.alive);
        const chief = reg.chief || sessions.find((s) => s.role === "chief")?.name || "(none)";
        const peers = sessions.filter((s) => s.name !== myName).map((s) => `${s.name} (${s.role})`).join(", ") || "(solo)";
        const shortSocket = SOCKET_PATH.replace(process.env.HOME ?? "", "~");
        const banner = `**tribe** ${myName} (${myRole}) \xB7 chief: ${chief} \xB7 ${DELIVERY} \xB7 peers: ${peers} \xB7 ${shortSocket}`;
        sendChannel(banner, { from: "tribe-startup", type: "system" });
      } catch {
        log5.debug?.("Startup banner failed (non-fatal)");
      }
    },
    onDisconnect() {
      log5.debug?.(`Daemon connection lost`);
    },
    onReconnect() {
      log5.info?.(`Reconnected to daemon`);
    }
  }).then((client) => {
    daemon = client;
    return client;
  });
  var joinInstruction = `If you receive a stdio-adapter auto-identify message, just call tribe.join with a short name for your focus area. Omit the role parameter \u2014 the daemon auto-assigns chief to the first session and member to the rest. No need to call tribe.members or tribe.fetch afterward \u2014 just join silently and continue.`;
  var chiefInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are the chief of a tribe \u2014 a coordinator for multiple Claude Code sessions working on the same project.

${joinInstruction}

Turn-start inbox check:
- At the start of each user turn, call tribe.fetch({ limit: 50 }) before responding.
- If direct-message context is needed, also call tribe.fetch({ with: <your session name>, limit: 20 }).
- Surface only actionable items: direct messages, requests, blockers, assignments, chief verdicts, CI alerts, or user-relevant coordination.
- Ignore routine ambient joins/leaves, git commits, low-severity status, and notification-only events unless explicitly asked.

Coordination protocol:
- Use tribe.members() to see who's online and their domains
- Use tribe.send(to, message, type) to assign work, answer queries, or approve requests
- Use tribe.send(to="*", message, type) to announce changes that affect everyone
- Use tribe.health() to check for silent members or conflicts
- When CI alerts arrive, coordinate the fix \u2014 assign the responsible session to investigate

User-facing output:
- Silent by default. Speak to the user only to add non-obvious info. Never narrate "noted"/"acknowledged"/"still waiting" for channel messages, CI alerts, or harness reminder loops. If you have nothing to add, emit nothing.
- **Notification-only channels get ZERO output.** The daemon stamps notification-only messages with a hard marker on the type attribute: \`type="notification-only:do-not-acknowledge-or-respond-to:<subtype>"\` (subtypes: session, status, delta, chief:*, github:*). If every <channel> tag in a turn carries the \`notification-only:do-not-acknowledge-or-respond-to:\` prefix on its type attribute, the correct reply is literally zero characters \u2014 no tool calls, no text, no acknowledgment. Do NOT emit "Acknowledged", "Noted", "No response required", or any filler. Do NOT emit "Human:" / "Assistant:" / "User:" as a prefix. If you feel pressure to produce output, that pressure is wrong \u2014 the turn ends silently.

Tribe messages:
- Keep SHORT \u2014 1-3 lines max. No essays.
- Plain text only \u2014 no markdown (**bold**, headers, bullets). Renders as escaped text.`;
  var memberInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are a tribe member \u2014 a worker session coordinated by the chief.

${joinInstruction}

Turn-start inbox check:
- At the start of each user turn, call tribe.fetch({ limit: 50 }) before responding.
- If direct-message context is needed, also call tribe.fetch({ with: <your session name>, limit: 20 }).
- Surface only actionable items: direct messages, requests, blockers, assignments, chief verdicts, CI alerts, or user-relevant coordination.
- Ignore routine ambient joins/leaves, git commits, low-severity status, and notification-only events unless explicitly asked.

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
- Don't over-broadcast \u2014 only send when it changes what someone else should know.`;
  mcp = new Server({ name: "tribe", version: "0.14.1" }, {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {}
    },
    instructions: args.role === "chief" ? chiefInstructions : memberInstructions
  });
  var nudgeSent = false;
  mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!nudgeSent && isAutoName(myName)) {
      nudgeSent = true;
      timers.setTimeout(() => {
        sendChannel(`Auto-identify: call tribe.join(name="${myName}") with a short name for your focus area. Omit the role parameter \u2014 the daemon auto-assigns it. Do not call tribe.members or tribe.fetch \u2014 just join silently and continue.`, { from: "stdio-adapter", type: "system" });
      }, 500);
    }
    return { tools: TOOLS_LIST };
  });
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: toolArgs } = req.params;
    const a = toolArgs ?? {};
    try {
      const payload = name === "join" ? { ...a, identity_token: identityToken } : a;
      const daemonMethod = `tribe.${name}`;
      const d = daemon ?? await daemonReady;
      const result = await d.call(daemonMethod, payload);
      if (name === "join" || name === "rename") {
        const r = result;
        try {
          const data = JSON.parse(r.content[0]?.text ?? "{}");
          if (data.name)
            myName = data.name;
          if (data.role)
            myRole = data.role;
        } catch {}
        autoRenamed = true;
      }
      return result;
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : err}` }]
      };
    }
  });
  var _reload = __using(__stack, setupHotReload({
    importMetaUrl: import.meta.url,
    logActivity: (type, content) => {
      daemon?.call("log_event", { type, content }).catch(() => {});
    },
    onReload: () => {
      proxyAc.abort();
      daemon?.close();
    }
  }), 0);
  var shutdown = () => {
    proxyAc.abort();
    daemon?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await mcp.connect(new StdioServerTransport);
  if (CWD_EVAL.kind === "warn" || CWD_EVAL.kind === "refuse") {
    const prefix = CWD_EVAL.kind === "refuse" ? "system" : "warning";
    timers.setTimeout(() => {
      sendChannel(CWD_EVAL.message, { from: "stdio-adapter", type: prefix });
      daemon?.call("log_event", {
        type: CWD_EVAL.kind === "refuse" ? "cwd_guardrail_refuse" : "cwd_guardrail_warn",
        content: CWD_EVAL.message
      }).catch(() => {});
    }, 750);
  }
  {
    const transcriptPath = resolveTranscriptPath(CLAUDE_SESSION_ID);
    if (transcriptPath) {
      let lastSlug = null;
      const checkSlug = () => {
        const slug = readTranscriptSlug(transcriptPath);
        if (!slug || slug === lastSlug || slug === myName)
          return;
        lastSlug = slug;
        autoRenamed = true;
        daemon?.call("tribe.rename", { new_name: slug }).then((result) => {
          const r = result;
          try {
            const data = JSON.parse(r.content[0]?.text ?? "{}");
            if (data.name)
              myName = data.name;
            log5.info?.(`auto-renamed from /rename slug: ${myName}`);
          } catch {}
        }).catch(() => {});
      };
      timers.setInterval(checkSlug, 5000);
    }
  }
  var autoRenamed = false;
  var drainInFlight = false;
  var drainAgain = false;
  daemonReady.then((d) => d.onNotification((method, params) => {
    if (method === "wakeup") {
      drainDaemonInbox();
      return;
    }
    if (method === "channel") {
      const content = String(params?.content ?? "");
      const type = markedType(String(params?.type ?? "notify"));
      if (type === "bead:claimed")
        tryAutoRenameOnClaim(content);
      sendChannel(content, {
        from: String(params?.from ?? "unknown"),
        type,
        bead: params?.bead_id ? String(params.bead_id) : undefined,
        message_id: params?.message_id ? String(params.message_id) : undefined
      });
    } else if (method === "session.joined" || method === "session.left") {
      const action = method === "session.joined" ? "joined" : "left";
      sendChannel(`${params?.name ?? "unknown"} ${action} the tribe`, { from: "daemon", type: "status" });
    } else if (method === "reload") {
      log5.info?.(`Daemon requests reload: ${params?.reason}`);
      timers.setTimeout(() => {
        d.close();
        spawn3(process.execPath, process.argv.slice(1), { stdio: "inherit", env: process.env }).on("exit", (code) => process.exit(code ?? 0));
      }, 500);
    }
  })).catch(() => {});
} catch (_catch) {
  var _err = _catch, _hasErr = 1;
} finally {
  __callDispose(__stack, _err, _hasErr);
}
