/**
 * Runtime composition factories — withClientRegistry, withBroadcast,
 * withSocketServer, withDispatcher, withSignals, withHotReload, withIdleQuit,
 * withRuntime + the end-to-end pipe assembly.
 *
 * Pairs with tribe-compose.test.ts (which covers the boot-half factories
 * config / database / daemonCtx / lore / pluginApi). Together they verify the
 * full pipe shape that tribe-daemon.ts boots through.
 */

import { describe, expect, it, afterEach } from "vitest"
import { existsSync, unlinkSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { createScope, pipe, withTool, withTools } from "../packages/daemon-spine/src/index.ts"
import {
  createBaseTribe,
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
  withProjectRoot,
  withRuntime,
  withSignals,
  withSocketServer,
} from "../tools/lib/tribe/compose/index.ts"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const cleanupPaths: string[] = []
function tmpDb(): string {
  const path = `/tmp/tribe-runtime-test-${randomUUID().slice(0, 8)}.db`
  cleanupPaths.push(path)
  return path
}
function tmpSock(): string {
  const path = `/tmp/tribe-runtime-test-${randomUUID().slice(0, 8)}.sock`
  cleanupPaths.push(path)
  return path
}

afterEach(() => {
  for (const p of cleanupPaths.splice(0)) {
    try {
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* ignore */
    }
  }
})

function bootShape(overrides: { socketPath?: string; dbPath?: string; loreEnabled?: boolean } = {}) {
  return pipe(
    createBaseTribe({ scope: createScope("test") }),
    withConfig({
      override: {
        socketPath: overrides.socketPath ?? tmpSock(),
        dbPath: overrides.dbPath ?? tmpDb(),
        loreDbPath: tmpDb(),
        quitTimeoutSec: -1,
        inheritFd: null,
        focusPollMs: 1000,
        summaryPollMs: 2000,
        summarizerMode: "off" as const,
        loreEnabled: overrides.loreEnabled ?? false,
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
  )
}

// ---------------------------------------------------------------------------
// withClientRegistry
// ---------------------------------------------------------------------------

describe("withClientRegistry", () => {
  it("exposes empty maps + chief lease accessors at composition time", async () => {
    const t = bootShape()
    expect(t.registry.clients.size).toBe(0)
    expect(t.registry.socketToClient.size).toBe(0)
    expect(t.registry.getChiefClaim()).toBeNull()
    expect(t.registry.getChiefId()).toBeNull()
    expect(t.registry.getActiveSessionIds().size).toBe(0)
    expect(t.registry.getActiveSessionInfo()).toEqual([])
    await t.scope[Symbol.asyncDispose]()
  })

  it("setChiefClaim + getChiefClaim round-trip", async () => {
    const t = bootShape()
    t.registry.setChiefClaim("session-x")
    expect(t.registry.getChiefClaim()).toBe("session-x")
    t.registry.setChiefClaim(null)
    expect(t.registry.getChiefClaim()).toBeNull()
    await t.scope[Symbol.asyncDispose]()
  })

  it("claimChief / releaseChief invokes the log callback", async () => {
    const t = bootShape()
    const events: Array<[string, string]> = []
    const log = (type: string, content: string): void => {
      events.push([type, content])
    }
    t.registry.claimChief("s1", "alice", log)
    expect(t.registry.getChiefClaim()).toBe("s1")
    expect(events[0]).toEqual(["chief:claimed", "alice claimed chief"])
    t.registry.releaseChief("s1", log)
    expect(t.registry.getChiefClaim()).toBeNull()
    expect(events[1]?.[0]).toBe("chief:released")
    await t.scope[Symbol.asyncDispose]()
  })

  it("scope close clears the registry maps", async () => {
    const t = bootShape()
    // Synthesise a client entry via a fake socket so the disposer has work
    t.registry.clients.set("c1", {
      socket: {} as unknown as import("node:net").Socket,
      id: "c1",
      name: "test",
      role: "member",
      domains: [],
      project: "/x",
      projectName: "x",
      projectId: "p",
      pid: 0,
      claudeSessionId: null,
      peerSocket: null,
      conn: "",
      ctx: t.daemonCtx,
      registeredAt: Date.now(),
      lore: { sessionId: null, claudePid: null },
    })
    expect(t.registry.clients.size).toBe(1)
    await t.scope[Symbol.asyncDispose]()
    expect(t.registry.clients.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// withBroadcast
// ---------------------------------------------------------------------------

describe("withBroadcast", () => {
  it("installs daemonCtx.onMessageInserted (the messageTap) at composition time", async () => {
    const t = bootShape()
    expect(typeof t.daemonCtx.onMessageInserted).toBe("function")
    expect(t.broadcast.messageTap).toBe(t.daemonCtx.onMessageInserted)
    await t.scope[Symbol.asyncDispose]()
  })

  it("scope close detaches the messageTap", async () => {
    const t = bootShape()
    expect(t.daemonCtx.onMessageInserted).toBeDefined()
    await t.scope[Symbol.asyncDispose]()
    expect(t.daemonCtx.onMessageInserted).toBeUndefined()
  })

  it("notify() is a no-op when no clients are connected", async () => {
    const t = bootShape()
    expect(() => t.broadcast.notify("hello", { x: 1 })).not.toThrow()
    await t.scope[Symbol.asyncDispose]()
  })
})

// ---------------------------------------------------------------------------
// withSocketServer
// ---------------------------------------------------------------------------

describe("withSocketServer", () => {
  it("binds a Unix socket and exposes server + path on the value", async () => {
    const sockPath = tmpSock()
    const t = withSocketServer<ReturnType<typeof bootShape>>()(bootShape({ socketPath: sockPath }))
    // Wait for listen() callback to fire so the file exists on disk
    await new Promise<void>((resolve) => {
      if (t.socket.server.listening) resolve()
      else t.socket.server.once("listening", () => resolve())
    })
    expect(existsSync(sockPath)).toBe(true)
    expect(t.socket.socketPath).toBe(sockPath)
    expect(t.socket.inheritedFd).toBe(false)
    expect(t.socket.startedAt).toBeGreaterThan(0)
    await t.scope[Symbol.asyncDispose]()
    // After dispose the socket file is unlinked
    expect(existsSync(sockPath)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// withIdleQuit
// ---------------------------------------------------------------------------

describe("withIdleQuit", () => {
  it("starts idle countdown when registry is empty at composition time", async () => {
    const t = withIdleQuit<ReturnType<typeof bootShape>>({
      triggerShutdown: () => {},
    })(bootShape())
    // quitTimeoutSec is -1 in bootShape → markIdle() is a no-op, deadline stays null
    expect(t.idleQuit.getDeadline()).toBeNull()
    await t.scope[Symbol.asyncDispose]()
  })

  it("markActive clears the deadline", async () => {
    const t = withIdleQuit<ReturnType<typeof bootShape>>({
      triggerShutdown: () => {},
    })(bootShape())
    t.idleQuit.markActive()
    expect(t.idleQuit.getDeadline()).toBeNull()
    await t.scope[Symbol.asyncDispose]()
  })

  it("markIdle sets a deadline when quitTimeoutSec > 0", async () => {
    const partial = pipe(
      createBaseTribe({ scope: createScope("test") }),
      withConfig({
        override: {
          socketPath: tmpSock(),
          dbPath: tmpDb(),
          loreDbPath: tmpDb(),
          quitTimeoutSec: 60,
          inheritFd: null,
          focusPollMs: 1000,
          summaryPollMs: 2000,
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
    )
    const t = withIdleQuit<typeof partial>({ triggerShutdown: () => {} })(partial)
    // Composition called markIdle() on empty registry
    expect(t.idleQuit.getDeadline()).not.toBeNull()
    await t.scope[Symbol.asyncDispose]()
  })
})

// ---------------------------------------------------------------------------
// withDispatcher
// ---------------------------------------------------------------------------

describe("withDispatcher", () => {
  it("attaches handleConnection to socket.server (verified via .listenerCount)", async () => {
    const partial = bootShape()
    const withSock = withSocketServer<typeof partial>()(partial)
    const withIdle = withIdleQuit<typeof withSock>({ triggerShutdown: () => {} })(withSock)
    const before = withSock.socket.server.listenerCount("connection")
    const t = withDispatcher<typeof withIdle>({})(withIdle)
    const after = t.socket.server.listenerCount("connection")
    expect(after).toBe(before + 1)
    expect(t.dispatcher.handleConnection).toBeDefined()
    expect(t.dispatcher.handleRequest).toBeDefined()
    await t.scope[Symbol.asyncDispose]()
    // Dispose removes the listener
    expect(t.socket.server.listenerCount("connection")).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// withSignals
// ---------------------------------------------------------------------------

describe("withSignals", () => {
  it("registers + cleans up SIGINT / SIGTERM / SIGHUP listeners", async () => {
    const partial = bootShape()
    const before = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
      sighup: process.listenerCount("SIGHUP"),
    }
    const t = withSignals<typeof partial>({
      onShutdown: () => {},
      onReload: () => {},
    })(partial)
    expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1)
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1)
    expect(process.listenerCount("SIGHUP")).toBe(before.sighup + 1)
    expect(t.signals.installed).toEqual(["SIGINT", "SIGTERM", "SIGHUP"])
    await t.scope[Symbol.asyncDispose]()
    // After dispose, listener counts revert
    expect(process.listenerCount("SIGINT")).toBe(before.sigint)
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm)
    expect(process.listenerCount("SIGHUP")).toBe(before.sighup)
  })
})

// ---------------------------------------------------------------------------
// withHotReload
// ---------------------------------------------------------------------------

describe("withHotReload", () => {
  it("exposes reload() + watchers list", async () => {
    const partial = bootShape()
    const withSock = withSocketServer<typeof partial>()(partial)
    const t = withHotReload<typeof withSock>({
      stopPlugins: () => {},
      triggerShutdown: () => {},
      disableWatch: true,
    })(withSock)
    expect(typeof t.hotReload.reload).toBe("function")
    expect(t.hotReload.watchers).toEqual([])
    await t.scope[Symbol.asyncDispose]()
  })
})

// ---------------------------------------------------------------------------
// withRuntime
// ---------------------------------------------------------------------------

describe("withRuntime", () => {
  it("loads zero plugins, publishes empty names, exposes run()", async () => {
    const partial = bootShape()
    const withSock = withSocketServer<typeof partial>()(partial)
    const withIdle = withIdleQuit<typeof withSock>({ triggerShutdown: () => {} })(withSock)
    const dispatchShape = withDispatcher<typeof withIdle>({})(withIdle)

    const published: { names: string[]; stopFn: () => void; shutdownFn: () => void } = {
      names: ["pre"],
      stopFn: () => {},
      shutdownFn: () => {},
    }
    const tribe = withRuntime<typeof dispatchShape>({
      plugins: [],
      publishActivePluginNames: (n) => {
        published.names = n
      },
      publishStopPlugins: (fn) => {
        published.stopFn = fn
      },
      publishShutdown: (fn) => {
        published.shutdownFn = fn
      },
    })(dispatchShape)
    expect(published.names).toEqual([])
    expect(typeof published.stopFn).toBe("function")
    expect(typeof published.shutdownFn).toBe("function")
    expect(typeof tribe.run).toBe("function")
    expect(typeof tribe.runtime.run).toBe("function")
    expect(typeof tribe.runtime.shutdown).toBe("function")
    await tribe.scope[Symbol.asyncDispose]()
  })

  it("run() resolves when scope aborts", async () => {
    const partial = bootShape()
    const withSock = withSocketServer<typeof partial>()(partial)
    const withIdle = withIdleQuit<typeof withSock>({ triggerShutdown: () => {} })(withSock)
    const dispatchShape = withDispatcher<typeof withIdle>({})(withIdle)
    const tribe = withRuntime<typeof dispatchShape>({
      plugins: [],
      publishActivePluginNames: () => {},
      publishStopPlugins: () => {},
      publishShutdown: () => {},
    })(dispatchShape)
    const runPromise = tribe.run()
    setTimeout(() => {
      void tribe.scope[Symbol.asyncDispose]().catch(() => {})
    }, 50)
    await runPromise
    // Resolved without timeout — pass
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// End-to-end pipe assembly — the full daemon shape composes cleanly
// ---------------------------------------------------------------------------

describe("end-to-end pipe assembly", () => {
  it("composes all 16 with* factories and exposes tribe.run()", async () => {
    const refs = {
      activePluginNames: [] as string[],
      stopPlugins: () => {},
      shutdown: () => {},
    }
    const partial = bootShape()
    const withSock = withSocketServer<typeof partial>()(partial)
    const withIdle = withIdleQuit<typeof withSock>({ triggerShutdown: () => refs.shutdown() })(withSock)
    const dispatchShape = withDispatcher<typeof withIdle>({
      onActiveClient: () => withIdle.idleQuit.markActive(),
      onIdle: () => withIdle.idleQuit.markIdle(),
      getActivePluginNames: () => refs.activePluginNames,
      getQuitTimeoutSec: () => withSock.config.quitTimeoutSec,
    })(withIdle)
    const hotReloadShape = withHotReload<typeof dispatchShape>({
      stopPlugins: () => refs.stopPlugins(),
      triggerShutdown: () => refs.shutdown(),
      disableWatch: true,
    })(dispatchShape)
    const signalsShape = withSignals<typeof hotReloadShape>({
      onShutdown: () => refs.shutdown(),
      onReload: () => hotReloadShape.hotReload.reload(),
    })(hotReloadShape)
    const tribe = withRuntime<typeof signalsShape>({
      plugins: [],
      publishActivePluginNames: (n) => {
        refs.activePluginNames = n
      },
      publishStopPlugins: (fn) => {
        refs.stopPlugins = fn
      },
      publishShutdown: (fn) => {
        refs.shutdown = fn
      },
    })(signalsShape)

    // All capability keys present and well-typed.
    expect(tribe.scope).toBeDefined()
    expect(tribe.config).toBeDefined()
    expect(tribe.projectRoot).toBe("/test")
    expect(tribe.db).toBeDefined()
    expect(tribe.daemonCtx.getRole()).toBe("daemon")
    expect(tribe.lore).toBeNull()
    expect(tribe.tools.size).toBeGreaterThan(0)
    expect(tribe.registry.clients).toBeDefined()
    expect(tribe.broadcast).toBeDefined()
    expect(tribe.socket.server).toBeDefined()
    expect(tribe.idleQuit.markActive).toBeDefined()
    expect(tribe.dispatcher.handleConnection).toBeDefined()
    expect(tribe.hotReload.reload).toBeDefined()
    expect(tribe.signals.installed.length).toBe(3)
    expect(tribe.runtime.shutdown).toBeDefined()
    expect(typeof tribe.run).toBe("function")

    await tribe.scope[Symbol.asyncDispose]()
  })
})
