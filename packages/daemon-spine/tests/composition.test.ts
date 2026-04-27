import { describe, expect, it } from "vitest"
import {
  createScope,
  disposable,
  pipe,
  Scope,
  withTool,
  withTools,
  type Tool,
  type WithTools,
} from "../src/index.ts"

describe("pipe", () => {
  it("returns the base value when no plugins are passed", () => {
    expect(pipe(42)).toBe(42)
  })

  it("composes plugins left-to-right", () => {
    const result = pipe(
      { n: 1 },
      (s) => ({ ...s, n: s.n + 1 }),
      (s) => ({ ...s, n: s.n * 10 }),
    )
    expect(result.n).toBe(20)
  })

  it("threads types through additive plugins", () => {
    const result = pipe(
      { a: 1 },
      (s) => ({ ...s, b: 2 }),
      (s) => ({ ...s, c: s.a + s.b }),
    )
    expect(result).toEqual({ a: 1, b: 2, c: 3 })
  })

  it("supports many steps without losing the threaded value", () => {
    const result = pipe(
      { count: 0 },
      (s) => ({ ...s, count: s.count + 1 }),
      (s) => ({ ...s, count: s.count + 1 }),
      (s) => ({ ...s, count: s.count + 1 }),
      (s) => ({ ...s, count: s.count + 1 }),
      (s) => ({ ...s, count: s.count + 1 }),
      (s) => ({ ...s, count: s.count + 1 }),
      (s) => ({ ...s, count: s.count + 1 }),
    )
    expect(result.count).toBe(7)
  })
})

describe("Scope", () => {
  it("runs deferred cleanups in LIFO order", async () => {
    const order: number[] = []
    const scope = createScope("root")
    scope.defer(() => {
      order.push(1)
    })
    scope.defer(() => {
      order.push(2)
    })
    scope.defer(() => {
      order.push(3)
    })
    await scope[Symbol.asyncDispose]()
    expect(order).toEqual([3, 2, 1])
  })

  it("aborts the signal on disposal", async () => {
    const scope = createScope()
    expect(scope.signal.aborted).toBe(false)
    await scope[Symbol.asyncDispose]()
    expect(scope.signal.aborted).toBe(true)
  })

  it("propagates abort from parent to child", async () => {
    const parent = createScope("parent")
    const child = parent.child("child")
    expect(child.signal.aborted).toBe(false)
    await parent[Symbol.asyncDispose]()
    expect(child.signal.aborted).toBe(true)
  })

  it("disposes children before parent disposers", async () => {
    const order: string[] = []
    const parent = createScope("parent")
    parent.defer(() => {
      order.push("parent")
    })
    const child = parent.child("child")
    child.defer(() => {
      order.push("child")
    })
    await parent[Symbol.asyncDispose]()
    expect(order).toEqual(["child", "parent"])
  })

  it("supports `await using` for async dispose at block exit", async () => {
    let cleaned = false
    async function block(): Promise<void> {
      await using scope = createScope()
      scope.defer(() => {
        cleaned = true
      })
      expect(cleaned).toBe(false)
    }
    await block()
    expect(cleaned).toBe(true)
  })

  it("is idempotent on dispose", async () => {
    let count = 0
    const scope = createScope()
    scope.defer(() => {
      count++
    })
    await scope[Symbol.asyncDispose]()
    await scope[Symbol.asyncDispose]()
    expect(count).toBe(1)
  })

  it("frees early-disposed children from the parent set", async () => {
    const parent = createScope("parent")
    const child = parent.child("child")
    await child[Symbol.asyncDispose]()
    // Parent disposing later should not throw / re-dispose the child.
    await expect(parent[Symbol.asyncDispose]()).resolves.toBeUndefined()
  })

  it("rejects scope.move() to preserve invariants", () => {
    const scope = createScope()
    expect(() => scope.move()).toThrow(TypeError)
  })

  it("disposable() helper attaches both Symbol.dispose and Symbol.asyncDispose", async () => {
    let closed = false
    const value = disposable({ x: 1 }, () => {
      closed = true
    })
    const scope = createScope()
    scope.use(value)
    await scope[Symbol.asyncDispose]()
    expect(closed).toBe(true)
  })

  it("throws when trying to create a child of a disposed scope", async () => {
    const scope = createScope()
    await scope[Symbol.asyncDispose]()
    expect(() => scope.child("late")).toThrow(ReferenceError)
  })
})

describe("tool registry", () => {
  it("withTools() establishes the registry slot", () => {
    const v = pipe({ scope: createScope() }, withTools<{ scope: Scope }>())
    expect(v.tools).toBeInstanceOf(Map)
    expect(v.tools.size).toBe(0)
  })

  it("withTool() appends a single tool", () => {
    const tool: Tool = {
      name: "tribe.echo",
      handler: (args) => args,
    }
    const v = pipe({ scope: createScope() }, withTools<{ scope: Scope }>(), withTool(tool))
    expect(v.tools.has("tribe.echo")).toBe(true)
    expect(v.tools.get("tribe.echo")?.handler).toBe(tool.handler)
  })

  it("withTool() appends multiple tools at once", () => {
    const tools: Tool[] = [
      { name: "a", handler: () => 1 },
      { name: "b", handler: () => 2 },
    ]
    const v = pipe({ scope: createScope() }, withTools<{ scope: Scope }>(), withTool(tools))
    expect(v.tools.size).toBe(2)
  })

  it("withTool() rejects duplicate names — composition-time guard", () => {
    expect(() => {
      pipe(
        { scope: createScope() },
        withTools<{ scope: Scope }>(),
        withTool({ name: "x", handler: () => 1 }),
        withTool({ name: "x", handler: () => 2 }),
      )
    }).toThrow(/already registered/)
  })

  it("registry can be read by surfaces — single source of truth", async () => {
    const v = pipe(
      { scope: createScope() },
      withTools<{ scope: Scope }>(),
      withTool({ name: "tribe.add", handler: (a) => (a.x as number) + (a.y as number) }),
    )
    const tool = v.tools.get("tribe.add")
    expect(tool).toBeDefined()
    expect(await tool!.handler({ x: 2, y: 3 }, {})).toBe(5)
  })

  it("composition order: tools registered before surfaces are visible to them", () => {
    type WithSurface = WithTools & { surface: { call: (n: string) => unknown } }
    function withSurface<T extends WithTools>(): (t: T) => T & WithSurface {
      return (t) => ({
        ...t,
        surface: {
          call: (n: string) => {
            const tool = t.tools.get(n)
            return tool ? tool.handler({}, {}) : null
          },
        },
      })
    }
    const v = pipe(
      { scope: createScope() },
      withTools<{ scope: Scope }>(),
      withTool({ name: "ping", handler: () => "pong" }),
      withSurface(),
    )
    expect(v.surface.call("ping")).toBe("pong")
  })
})
