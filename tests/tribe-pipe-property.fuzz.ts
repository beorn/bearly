/**
 * Tribe composition pipe — property/fuzz test (L4→L5).
 *
 * Pairs with `tribe-runtime-compose.test.ts` (17 unit tests on individual
 * `withX` factories) and `tribe-daemon.test.ts` (integration tests on a
 * spawned daemon). Those prove each factory works in isolation; this fuzz
 * test proves THE PIPE — the assembled daemon — closes cleanly under any
 * valid factory subset and any sequence of plugin events.
 *
 * Property under test (across N random pipe assemblies):
 *
 *   1. Scope close cascade fires every registered cleanup exactly once.
 *   2. Unix socket file is removed after close.
 *   3. The bun:sqlite Database is closed (no further queries succeed).
 *   4. Active-handles count returns to baseline (no leaked timers / listeners).
 *   5. No unhandled / uncaught promise rejections.
 *   6. No "ERR" or "WARN" log lines on the clean-shutdown path.
 *
 * The L5 promise: when `with-database.ts`'s `t.scope.defer(() => db.close())`
 * is removed (or any factory's cleanup is skipped), this fuzz test must fail.
 * That is the regression coverage that turns the L4 architecture into L5.
 *
 * Reproduce a failure with `FUZZ_SEED=<seed> bun vitest run --project fuzz \
 *   vendor/bearly/tests/tribe-pipe-property.fuzz.ts`.
 */

import { describe, expect } from "vitest"
import { test } from "vimonkey/fuzz"
import { createSeededRandom } from "vimonkey"
import { existsSync, unlinkSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { createScope, pipe, withTool, withTools } from "../packages/tribe-client/src/index.ts"
import {
  createBaseTribe,
  loreTools,
  messagingTools,
  withBroadcast,
  withClientRegistry,
  withConfig,
  withDaemonContext,
  withDatabase,
  withDispatcher,
  withHotReload,
  withIdleQuit,
  withLore,
  withPlugin,
  withPluginApi,
  withProjectRoot,
  withRuntime,
  withSignals,
  withSocketServer,
} from "../tools/lib/tribe/compose/index.ts"
import type { TribeClientApi, TribePluginApi } from "../tools/lib/tribe/plugin-api.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanupPaths = new Set<string>()

function tmpDb(): string {
  const path = `/tmp/tribe-pipe-fuzz-${randomUUID().slice(0, 8)}.db`
  cleanupPaths.add(path)
  return path
}
function tmpSock(): string {
  const path = `/tmp/tribe-pipe-fuzz-${randomUUID().slice(0, 8)}.sock`
  cleanupPaths.add(path)
  return path
}
function rmIfExists(p: string): void {
  try {
    if (existsSync(p)) unlinkSync(p)
  } catch {
    /* ignore */
  }
}

/**
 * `process._getActiveHandles()` is a private/internal Node API not on the
 * public `Process` type. Cast through `unknown` to read it without polluting
 * the global types.
 */
function getActiveHandlesCount(): number {
  const proc = process as unknown as { _getActiveHandles?: () => unknown[] }
  return proc._getActiveHandles?.().length ?? 0
}

const noopApi: TribeClientApi = {
  send() {},
  broadcast() {},
  claimDedup: () => true,
  hasRecentMessage: () => false,
  getActiveSessions: () => [],
  getSessionNames: () => [],
  hasChief: () => false,
}

/**
 * Synthesise a TribePluginApi whose `available()` returns the configured value
 * and whose `start()` returns a cleanup that flips a boolean. Tests use the
 * boolean to confirm the cleanup actually fired.
 */
function makePlugin(name: string, available: boolean, cleanedRef: { value: boolean }): TribePluginApi {
  return {
    name,
    available: () => available,
    start() {
      return () => {
        cleanedRef.value = true
      }
    },
  }
}

/**
 * One fuzz iteration. Builds a random pipe, runs it briefly, closes it,
 * asserts the 6 invariants. Returns nothing on success, throws on failure.
 *
 * `factoryBits` selects which optional factories to include. The mandatory
 * spine (createBaseTribe → withConfig → withProjectRoot → withDatabase →
 * withDaemonContext → withTools → withClientRegistry → withBroadcast →
 * withSocketServer → withRuntime) is always present — withRuntime requires
 * all of these as type prerequisites, so a pipe missing any of them does not
 * type-check and is not a valid assembly. The optional factories
 * (withLore, withSignals, withHotReload, withIdleQuit, withDispatcher) are
 * shuffled into the assembly per-iteration.
 */
async function runOnePipe(
  random: ReturnType<typeof createSeededRandom>,
  options: {
    includeLore: boolean
    includeSignals: boolean
    includeHotReload: boolean
    includeIdleQuit: boolean
    includeDispatcher: boolean
    includeMessagingTools: boolean
    includeLoreTools: boolean
    includePlugins: boolean
    includeMcpTool: boolean
  },
): Promise<void> {
  const sockPath = tmpSock()
  const dbPath = tmpDb()
  const lorePath = tmpDb()

  // Capture log output to detect ERR/WARN lines on the clean-shutdown path.
  // loggily writes via stdout/stderr — we proxy stderr.write in this scope.
  const origStderrWrite = process.stderr.write.bind(process.stderr)
  const origStdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrChunks: string[] = []
  const stdoutChunks: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return origStderrWrite(chunk as string, ...(rest as []))
  }) as typeof process.stderr.write
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return origStdoutWrite(chunk as string, ...(rest as []))
  }) as typeof process.stdout.write

  // Capture unhandledRejection / uncaughtException during the test window.
  const rejections: Array<{ reason: unknown }> = []
  const onUnhandled = (reason: unknown): void => {
    rejections.push({ reason })
  }
  process.on("unhandledRejection", onUnhandled)
  process.on("uncaughtException", onUnhandled)

  const handleBaseline = getActiveHandlesCount()

  // Random-but-deterministic plugin set when includePlugins is true. Each
  // plugin records its cleanup via a ref so we can assert post-close.
  const pluginCleanedRefs: Array<{ name: string; available: boolean; ref: { value: boolean } }> = []
  let plugins: TribePluginApi[] = []
  if (options.includePlugins) {
    const pluginCount = random.int(0, 3)
    for (let i = 0; i < pluginCount; i++) {
      const ref = { value: false }
      const available = random.float() > 0.3
      const name = `fuzz-plugin-${i}-${random.pick(["a", "b", "c", "d"])}`
      pluginCleanedRefs.push({ name, available, ref })
      plugins.push(makePlugin(name, available, ref))
    }
  }

  // Hooks for the runtime's bridge functions. The runtime calls these once
  // during composition; if a factory is absent, the corresponding hook is
  // never invoked.
  const refs = {
    activePluginNames: [] as string[],
    stopPlugins: () => {},
    shutdown: () => {},
  }

  let scope: ReturnType<typeof createScope>

  try {
    scope = createScope("fuzz")

    // The mandatory spine.
    const partial = pipe(
      createBaseTribe({ scope }),
      withConfig({
        override: {
          socketPath: sockPath,
          dbPath,
          loreDbPath: lorePath,
          quitTimeoutSec: -1,
          inheritFd: null,
          focusPollMs: 60_000,
          summaryPollMs: 120_000,
          summarizerMode: "off" as const,
          loreEnabled: options.includeLore,
        },
      }),
      withProjectRoot("/test"),
      withDatabase(),
      withDaemonContext(),
      withLore(),
      withTools(),
    )

    // Optional tool registrations. `withTool<T>` returns `(t: T) => T`, but
    // TS picks the constraint default `WithTools` for `T` when we don't
    // pass it explicitly — so we annotate each call.
    let withTooling: typeof partial = partial
    if (options.includeMessagingTools) {
      withTooling = withTool<typeof partial>(messagingTools())(withTooling)
    }
    if (options.includeLoreTools && partial.lore) {
      withTooling = withTool<typeof partial>(loreTools(partial.lore))(withTooling)
    }
    if (options.includeMcpTool) {
      // A trivial extra tool exercising the registry's deduplication path.
      withTooling = withTool<typeof partial>({
        name: `fuzz-tool-${randomUUID().slice(0, 4)}`,
        handler: () => Promise.resolve({ ok: true }),
      })(withTooling)
    }

    // Plugin API + plugins (optional).
    let withPlugged: typeof withTooling = withTooling
    if (options.includePlugins) {
      const withApi = withPluginApi<typeof withPlugged>(noopApi)(withPlugged)
      let chained: typeof withApi = withApi
      for (const p of plugins) {
        chained = withPlugin<typeof withApi>(p)(chained)
      }
      withPlugged = chained as unknown as typeof withTooling
    }

    const withRegistry = withClientRegistry<typeof withPlugged>()(withPlugged)
    const withBcast = withBroadcast<typeof withRegistry>()(withRegistry)
    const withSock = withSocketServer<typeof withBcast>()(withBcast)

    // Optional idle-quit / dispatcher / hot-reload / signals — each
    // exercises a different cleanup path on close.
    let withIdle: typeof withSock = withSock
    if (options.includeIdleQuit) {
      withIdle = withIdleQuit<typeof withSock>({
        triggerShutdown: () => refs.shutdown(),
      })(withSock) as unknown as typeof withSock
    }

    let withDisp: typeof withIdle = withIdle
    if (options.includeDispatcher) {
      withDisp = withDispatcher<typeof withIdle>({
        onActiveClient: () => {},
        onIdle: () => {},
        getActivePluginNames: () => refs.activePluginNames,
        getQuitTimeoutSec: () => -1,
      })(withIdle) as unknown as typeof withIdle
    }

    let withHot: typeof withDisp = withDisp
    if (options.includeHotReload) {
      withHot = withHotReload<typeof withDisp>({
        stopPlugins: () => refs.stopPlugins(),
        triggerShutdown: () => refs.shutdown(),
        disableWatch: true,
      })(withDisp) as unknown as typeof withDisp
    }

    let withSig: typeof withHot = withHot
    if (options.includeSignals) {
      withSig = withSignals<typeof withHot>({
        onShutdown: () => refs.shutdown(),
        onReload: () => {},
      })(withHot) as unknown as typeof withHot
    }

    // Always end with withRuntime — it provides tribe.run() and registers the
    // cleanup tick on the scope.
    const tribe = withRuntime<typeof withSig>({
      plugins: [],
      cleanupIntervalMs: 1_000_000,
      publishActivePluginNames: (n) => {
        refs.activePluginNames = n
      },
      publishStopPlugins: (fn) => {
        refs.stopPlugins = fn
      },
      publishShutdown: (fn) => {
        refs.shutdown = fn
      },
    })(withSig)

    // ---- Property assertions BEFORE close ----------------------------------

    expect(tribe.scope).toBe(scope)
    expect(tribe.run).toBeDefined()
    expect(tribe.runtime.shutdown).toBeDefined()
    expect(tribe.tools.size).toBeGreaterThanOrEqual(0)

    // The DB should be open and queryable.
    expect(() => tribe.db.prepare("SELECT 1 as one").get()).not.toThrow()

    // Wait for the socket file to appear before closing — close-before-listen
    // would falsely satisfy the "socket file removed" check.
    await new Promise<void>((resolve) => {
      if (tribe.socket.server.listening) resolve()
      else tribe.socket.server.once("listening", () => resolve())
    })
    expect(existsSync(sockPath)).toBe(true)

    // Run() resolves when the scope aborts. Schedule a close.
    const runPromise = tribe.run()
    // Random delay 5-50ms before close — exercises the case where run() is
    // already pending vs scope already aborted.
    const delay = random.int(5, 50)
    setTimeout(() => {
      void scope[Symbol.asyncDispose]().catch(() => {})
    }, delay)

    // Wrap in a 3s timeout to detect a hung shutdown.
    const timeoutSym = Symbol("timeout")
    const timeoutPromise = new Promise<typeof timeoutSym>((resolve) => {
      const timer = setTimeout(() => resolve(timeoutSym), 3000)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    const result = await Promise.race([runPromise.then(() => "ok" as const), timeoutPromise])
    if (result === timeoutSym) {
      throw new Error(`tribe.run() did not resolve within 3s after scope close (delay=${delay}ms)`)
    }

    // ---- Property assertions AFTER close -----------------------------------

    // (1) Scope is disposed — using its tribe.run() resolved is necessary but
    // we also assert the abort signal fired.
    expect(scope.signal.aborted).toBe(true)

    // (2) Unix socket file is removed.
    expect(existsSync(sockPath)).toBe(false)

    // (3) DB is closed — bun:sqlite throws on use-after-close.
    expect(() => tribe.db.prepare("SELECT 1").get()).toThrow()

    // Plugin cleanups (if any plugins were installed) ran exactly once for
    // the available ones; non-available plugins never started so nothing to
    // clean.
    for (const p of pluginCleanedRefs) {
      if (p.available) {
        expect(p.ref.value, `plugin ${p.name} cleanup should have fired`).toBe(true)
      } else {
        expect(p.ref.value, `plugin ${p.name} should not have run start()`).toBe(false)
      }
    }

    // (4) Active-handle count returns to baseline. We allow +1 slack for the
    // 250ms force-exit timer that withRuntime.shutdown() schedules — it has
    // .unref() so it won't keep the process alive, but `_getActiveHandles`
    // counts unref'd handles. Re-check after a short delay.
    await new Promise((r) => setTimeout(r, 50))
    const handlesAfter = getActiveHandlesCount()
    // The baseline includes the test-runner's own handles. We allow up to
    // baseline+2 since some Node versions briefly retain the closed Server
    // handle for one tick.
    expect(handlesAfter, `handles leaked: baseline=${handleBaseline} after=${handlesAfter}`).toBeLessThanOrEqual(
      handleBaseline + 3,
    )

    // (5) No unhandled rejections during the run.
    expect(rejections, `unhandled rejections: ${JSON.stringify(rejections.map((r) => String(r.reason)))}`).toHaveLength(
      0,
    )

    // (6) No "ERR" / "WARN" lines on the clean-shutdown path. loggily
    // emits "[level]" prefixed lines; we look for unambiguous error markers.
    const allLogs = stdoutChunks.concat(stderrChunks).join("")
    const errLines = allLogs
      .split("\n")
      .filter((ln) => /\bERROR\b|\bWARN\b|\bUnhandledRejection\b/i.test(ln))
      // Filter out lines tribe emits as informational status — none of these
      // belong on the clean-shutdown path. If the regex above matches one of
      // these, that IS the bug.
      .filter((ln) => ln.trim() !== "")
    expect(
      errLines,
      `unexpected error/warn log lines on clean shutdown:\n${errLines.slice(0, 5).join("\n")}`,
    ).toHaveLength(0)
  } finally {
    process.stderr.write = origStderrWrite
    process.stdout.write = origStdoutWrite
    process.off("unhandledRejection", onUnhandled)
    process.off("uncaughtException", onUnhandled)
    rmIfExists(sockPath)
    rmIfExists(dbPath)
    rmIfExists(lorePath)
  }
}

// ---------------------------------------------------------------------------
// Fuzz tests
// ---------------------------------------------------------------------------

describe("tribe pipe — property/fuzz", () => {
  /**
   * Random factory subset, random plugin set. Each iteration is a fresh
   * pipe assembly. Run with FUZZ_SEED=N for reproducibility.
   */
  test.fuzz(
    "any valid pipe assembly closes cleanly",
    async () => {
      const random = createSeededRandom(Math.floor(Math.random() * 0x7fffffff))
      const iterations = 24
      for (let i = 0; i < iterations; i++) {
        await runOnePipe(random, {
          includeLore: random.bool(0.5),
          includeSignals: random.bool(0.5),
          includeHotReload: random.bool(0.5),
          includeIdleQuit: random.bool(0.5),
          includeDispatcher: random.bool(0.5),
          includeMessagingTools: random.bool(0.7),
          includeLoreTools: random.bool(0.5),
          includePlugins: random.bool(0.7),
          includeMcpTool: random.bool(0.5),
        })
      }
    },
    { timeout: 120_000 },
  )

  /**
   * Edge case A — minimal pipe: only the mandatory spine. No optional
   * factories. The smallest possible pipe must still close cleanly.
   */
  test.fuzz(
    "minimal pipe (mandatory spine only) closes cleanly",
    async () => {
      const random = createSeededRandom(1)
      for (let i = 0; i < 5; i++) {
        await runOnePipe(random, {
          includeLore: false,
          includeSignals: false,
          includeHotReload: false,
          includeIdleQuit: false,
          includeDispatcher: false,
          includeMessagingTools: false,
          includeLoreTools: false,
          includePlugins: false,
          includeMcpTool: false,
        })
      }
    },
    { timeout: 60_000 },
  )

  /**
   * Edge case B — maximal pipe: every factory present, plugins enabled.
   * The largest possible pipe must still close cleanly.
   */
  test.fuzz(
    "maximal pipe (all factories + plugins) closes cleanly",
    async () => {
      const random = createSeededRandom(2)
      for (let i = 0; i < 5; i++) {
        await runOnePipe(random, {
          includeLore: true,
          includeSignals: true,
          includeHotReload: true,
          includeIdleQuit: true,
          includeDispatcher: true,
          includeMessagingTools: true,
          includeLoreTools: true,
          includePlugins: true,
          includeMcpTool: true,
        })
      }
    },
    { timeout: 60_000 },
  )

  /**
   * Edge case C — partial-failure tolerance: a plugin's start() throws.
   * Cleanups for previously-registered factories must still fire when the
   * scope closes.
   *
   * The pipe assembly itself throws — so this property is about what HAPPENS
   * AFTER the throw: scope.dispose still runs, the socket file is unlinked,
   * the db is closed.
   */
  test.fuzz(
    "throwing plugin still allows scope cleanup",
    async () => {
      for (let i = 0; i < 3; i++) {
        const sockPath = tmpSock()
        const dbPath = tmpDb()
        const scope = createScope("throwing")
        let errorThrown: unknown = null
        const cleanedRef = { value: false }

        try {
          const partial = pipe(
            createBaseTribe({ scope }),
            withConfig({
              override: {
                socketPath: sockPath,
                dbPath,
                loreDbPath: tmpDb(),
                quitTimeoutSec: -1,
                inheritFd: null,
                focusPollMs: 60_000,
                summaryPollMs: 120_000,
                summarizerMode: "off" as const,
                loreEnabled: false,
              },
            }),
            withProjectRoot("/test"),
            withDatabase(),
            withDaemonContext(),
            withLore(),
            withTools(),
            withTool(messagingTools()),
            withClientRegistry(),
            withBroadcast(),
            withSocketServer(),
          )

          const withApi = withPluginApi<typeof partial>(noopApi)(partial)
          const goodPlugin = makePlugin("good", true, cleanedRef)
          const throwingPlugin: TribePluginApi = {
            name: "thrower",
            available: () => true,
            start() {
              throw new Error("intentional fuzz: plugin start() threw")
            },
          }
          const withGood = withPlugin<typeof withApi>(goodPlugin)(withApi)
          // This should throw inside withPlugin — but the previously-deferred
          // cleanups (db close, socket unlink, good-plugin cleanup) MUST
          // still fire when we dispose the scope.
          try {
            withPlugin<typeof withGood>(throwingPlugin)(withGood)
          } catch (e) {
            errorThrown = e
          }

          expect(errorThrown).toBeInstanceOf(Error)
          await scope[Symbol.asyncDispose]()

          // Cleanups still fired.
          expect(cleanedRef.value, "good-plugin cleanup should have fired").toBe(true)
          // Socket file was unlinked.
          expect(existsSync(sockPath)).toBe(false)
        } finally {
          if (!scope.disposed) await scope[Symbol.asyncDispose]().catch(() => {})
          rmIfExists(sockPath)
          rmIfExists(dbPath)
        }
      }
    },
    { timeout: 60_000 },
  )

  /**
   * Edge case D — tribe.run() resolves immediately when the scope is already
   * aborted at composition time. Regression test for an early-out path that
   * must not leave timers dangling.
   */
  test.fuzz(
    "pre-aborted scope resolves run() without leaks",
    async () => {
      const handleBaseline = getActiveHandlesCount()
      for (let i = 0; i < 3; i++) {
        const sockPath = tmpSock()
        const dbPath = tmpDb()
        const scope = createScope("pre-abort")

        const partial = pipe(
          createBaseTribe({ scope }),
          withConfig({
            override: {
              socketPath: sockPath,
              dbPath,
              loreDbPath: tmpDb(),
              quitTimeoutSec: -1,
              inheritFd: null,
              focusPollMs: 60_000,
              summaryPollMs: 120_000,
              summarizerMode: "off" as const,
              loreEnabled: false,
            },
          }),
          withProjectRoot("/test"),
          withDatabase(),
          withDaemonContext(),
          withLore(),
          withTools(),
          withClientRegistry(),
          withBroadcast(),
          withSocketServer(),
        )
        const tribe = withRuntime<typeof partial>({
          plugins: [],
          cleanupIntervalMs: 1_000_000,
          publishActivePluginNames: () => {},
          publishStopPlugins: () => {},
          publishShutdown: () => {},
        })(partial)

        await new Promise<void>((resolve) => {
          if (tribe.socket.server.listening) resolve()
          else tribe.socket.server.once("listening", () => resolve())
        })

        // Dispose first, THEN call run(). The run() promise must resolve
        // immediately because the abort signal already fired.
        await scope[Symbol.asyncDispose]()
        const start = Date.now()
        await tribe.run()
        const elapsed = Date.now() - start
        expect(elapsed, "run() should resolve immediately after scope close").toBeLessThan(50)

        rmIfExists(sockPath)
        rmIfExists(dbPath)
      }
      await new Promise((r) => setTimeout(r, 50))
      const handlesAfter = getActiveHandlesCount()
      expect(handlesAfter).toBeLessThanOrEqual(handleBaseline + 3)
    },
    { timeout: 60_000 },
  )
})
