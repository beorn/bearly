import { computed, effect, signal } from "alien-signals"
import { describe, expect, it, vi } from "vitest"
import { createProjection } from "../src/index.js"

interface Todo {
  id: string
  text: string
  done: boolean
}

function makeTodo(id: string, text: string, done = false): Todo {
  return { id, text, done }
}

describe("createProjection", () => {
  it("basic map projection", () => {
    const items = signal([makeTodo("1", "Buy milk"), makeTodo("2", "Fix bug")])

    const projection = createProjection(items, {
      key: (item: Todo) => item.id,
      map: (item: Todo) => ({ ...item, upper: item.text.toUpperCase() }),
    })

    const result = projection()
    expect(result).toEqual([
      { id: "1", text: "Buy milk", done: false, upper: "BUY MILK" },
      { id: "2", text: "Fix bug", done: false, upper: "FIX BUG" },
    ])
  })

  it("filter projection", () => {
    const items = signal([
      makeTodo("1", "Buy milk", false),
      makeTodo("2", "Fix bug", true),
      makeTodo("3", "Write docs", false),
    ])

    const projection = createProjection(items, {
      key: (item: Todo) => item.id,
      filter: (item: Todo) => !item.done,
    })

    const result = projection()
    expect(result).toHaveLength(2)
    expect(result[0]!.id).toBe("1")
    expect(result[1]!.id).toBe("3")
  })

  it("sort projection", () => {
    const items = signal([makeTodo("1", "Zebra"), makeTodo("2", "Apple"), makeTodo("3", "Mango")])

    const projection = createProjection(items, {
      key: (item: Todo) => item.id,
      sort: (a: Todo, b: Todo) => a.text.localeCompare(b.text),
    })

    const result = projection()
    expect(result.map((r) => r.text)).toEqual(["Apple", "Mango", "Zebra"])
  })

  it("combined map + filter + sort", () => {
    const items = signal([
      makeTodo("1", "Zebra", false),
      makeTodo("2", "Apple", true),
      makeTodo("3", "Mango", false),
      makeTodo("4", "Banana", false),
    ])

    const projection = createProjection(items, {
      key: (item: Todo) => item.id,
      map: (item: Todo) => ({ ...item, upper: item.text.toUpperCase() }),
      filter: (item: Todo) => !item.done,
      sort: (a: Todo, b: Todo) => a.text.localeCompare(b.text),
    })

    const result = projection()
    expect(result).toHaveLength(3)
    expect(result.map((r) => r.upper)).toEqual(["BANANA", "MANGO", "ZEBRA"])
  })

  it("incremental update — only changed items re-map", () => {
    const mapFn = vi.fn((item: Todo) => ({
      ...item,
      upper: item.text.toUpperCase(),
    }))

    const todo1 = makeTodo("1", "Buy milk")
    const todo2 = makeTodo("2", "Fix bug")
    const items = signal([todo1, todo2])

    const projection = createProjection(items, {
      key: (item: Todo) => item.id,
      map: mapFn,
    })

    // Initial computation — both items mapped
    projection()
    expect(mapFn).toHaveBeenCalledTimes(2)

    mapFn.mockClear()

    // Change only item 2, keep item 1 the same reference
    const todo2Updated = makeTodo("2", "Fix all bugs")
    items([todo1, todo2Updated])

    projection()
    // Only the changed item should be re-mapped
    expect(mapFn).toHaveBeenCalledTimes(1)
    expect(mapFn).toHaveBeenCalledWith(todo2Updated)
  })

  it("add item to source", () => {
    const mapFn = vi.fn((item: Todo) => ({
      ...item,
      upper: item.text.toUpperCase(),
    }))

    const todo1 = makeTodo("1", "Buy milk")
    const items = signal([todo1])

    const projection = createProjection(items, {
      key: (item: Todo) => item.id,
      map: mapFn,
    })

    projection()
    expect(mapFn).toHaveBeenCalledTimes(1)
    mapFn.mockClear()

    // Add a new item, keeping the existing one
    const todo2 = makeTodo("2", "Fix bug")
    items([todo1, todo2])

    const result = projection()
    // Only the new item should be mapped
    expect(mapFn).toHaveBeenCalledTimes(1)
    expect(mapFn).toHaveBeenCalledWith(todo2)
    expect(result).toHaveLength(2)
    expect(result[1]!.upper).toBe("FIX BUG")
  })

  it("remove item from source", () => {
    const mapFn = vi.fn((item: Todo) => ({
      ...item,
      upper: item.text.toUpperCase(),
    }))

    const todo1 = makeTodo("1", "Buy milk")
    const todo2 = makeTodo("2", "Fix bug")
    const items = signal([todo1, todo2])

    const projection = createProjection(items, {
      key: (item: Todo) => item.id,
      map: mapFn,
    })

    projection()
    expect(mapFn).toHaveBeenCalledTimes(2)
    mapFn.mockClear()

    // Remove item 1
    items([todo2])

    const result = projection()
    // No re-mapping needed — item 2 is unchanged
    expect(mapFn).toHaveBeenCalledTimes(0)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("2")
  })

  it("empty source", () => {
    const items = signal<Todo[]>([])

    const projection = createProjection(items, {
      key: (item: Todo) => item.id,
      map: (item: Todo) => ({ ...item, upper: item.text.toUpperCase() }),
    })

    expect(projection()).toEqual([])
  })

  it("key collision — last occurrence wins", () => {
    const items = signal([
      { id: "1", text: "First" },
      { id: "1", text: "Second" },
    ])

    type Item = { id: string; text: string }
    const projection = createProjection(items, {
      key: (item: Item) => item.id,
      map: (item: Item) => ({ ...item, upper: item.text.toUpperCase() }),
    })

    const result = projection()
    // Both appear in output (both pass through), but cache holds last
    expect(result).toHaveLength(2)
    expect(result[0]!.upper).toBe("FIRST")
    expect(result[1]!.upper).toBe("SECOND")
  })

  it("works without map function (identity projection)", () => {
    const items = signal([makeTodo("1", "Buy milk", false), makeTodo("2", "Fix bug", true)])

    const projection = createProjection(items, {
      key: (item: Todo) => item.id,
      filter: (item: Todo) => !item.done,
    })

    const result = projection()
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(items()[0]) // Same reference, not mapped
  })

  it("reactive — triggers effects on change", () => {
    const todo1 = makeTodo("1", "Buy milk")
    const todo2 = makeTodo("2", "Fix bug", true)
    const items = signal([todo1, todo2])

    const projection = createProjection(items, {
      key: (item: Todo) => item.id,
      filter: (item: Todo) => !item.done,
    })

    const results: number[] = []
    effect(() => {
      results.push(projection().length)
    })

    expect(results).toEqual([1])

    // Mark todo1 as done — now both are done, result should be empty
    items([makeTodo("1", "Buy milk", true), todo2])
    expect(results).toEqual([1, 0])
  })

  it("cache is cleaned up when items are removed", () => {
    const mapFn = vi.fn((item: Todo) => ({
      ...item,
      upper: item.text.toUpperCase(),
    }))

    const todo1 = makeTodo("1", "Buy milk")
    const todo2 = makeTodo("2", "Fix bug")
    const items = signal([todo1, todo2])

    const projection = createProjection(items, {
      key: (item: Todo) => item.id,
      map: mapFn,
    })

    projection()
    mapFn.mockClear()

    // Remove all items
    items([])
    projection()

    // Re-add item 1 with same reference
    items([todo1])
    projection()

    // Item 1 was evicted from cache, so it must be re-mapped
    expect(mapFn).toHaveBeenCalledTimes(1)
    expect(mapFn).toHaveBeenCalledWith(todo1)
  })

  it("numeric keys", () => {
    const items = signal([
      { n: 10, label: "ten" },
      { n: 20, label: "twenty" },
    ])

    const projection = createProjection(items, {
      key: (item: { n: number; label: string }) => item.n,
      map: (item: { n: number; label: string }) => item.label.toUpperCase(),
    })

    expect(projection()).toEqual(["TEN", "TWENTY"])
  })

  it("filter change triggers recomputation", () => {
    const todo1 = makeTodo("1", "Buy milk", false)
    const todo2 = makeTodo("2", "Fix bug", true)
    const items = signal([todo1, todo2])

    const projection = createProjection(items, {
      key: (item: Todo) => item.id,
      filter: (item: Todo) => !item.done,
    })

    expect(projection()).toHaveLength(1)

    // Update todo2 to not done
    items([todo1, makeTodo("2", "Fix bug", false)])
    expect(projection()).toHaveLength(2)
  })
})
