# alien-resources

Async signal bridge for [alien-signals](https://github.com/stackblitz/alien-signals). Wraps async fetchers into reactive signals with loading/error states and automatic cancellation.

## Which alien-\* package do I need?

The `alien-*` family is "signals for a specific shape of data". Pick by what your data looks like:

| Your data is…                                          | Reach for                                                              | What it gives you                                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **A plain value** (cursor, count, toggle)              | [`alien-signals`](https://github.com/stackblitz/alien-signals)         | The primitive. `signal(value)`, `computed(fn)`, `effect(fn)`. Everything below builds on this.                |
| **A list that changes over time** (rows, cards, todos) | [`alien-projections`](https://www.npmjs.com/package/alien-projections) | `createProjection(list, { key, map, filter, sort })` — when one row changes, only that row re-computes.       |
| **An async fetch** (API call, file load, DB query)     | **`alien-resources`** (you're here)                                    | `createResource(fetcher)` — gives you `.loading()` / `.error()` / `.refetch()` + auto-cancels stale requests. |
| **A tree / hierarchy** (folders, outlines, nested UI)  | [`alien-trees`](https://www.npmjs.com/package/alien-trees)             | `createTree(...)` — ask "does any descendant have X?" or "inherit Y from any ancestor?" in O(1).              |

They **compose**. A list of async-fetched trees of plain values uses all four together. Each package earns its place by exploiting one data shape well, not by trying to do everything.

**You're on `alien-resources`** — reach for this one when you have an async operation (fetch, file read, DB query) whose result you want to read reactively. The fetcher re-runs when its dependencies change, old requests are cancelled automatically, and `.loading()` / `.error()` are exposed as signals so your UI can render each state without manual wiring.

## Install

```bash
npm install alien-resources alien-signals
```

`alien-signals` is a peer dependency.

## Usage

```typescript
import { signal, effect } from "alien-signals"
import { createResource } from "alien-resources"

const userId = signal("user-1")

// Resource tracks a fetcher — refetches when dependencies change
const profile = createResource(async (abort) => {
  const res = await fetch(`/api/users/${userId()}`, { signal: abort })
  return res.json()
})

// Read data, loading, and error reactively
effect(() => {
  if (profile.loading()) console.log("Loading...")
  else if (profile.error()) console.log("Error:", profile.error())
  else console.log("Data:", profile())
})

// Change dependency — automatically refetches (cancels in-flight request)
userId("user-2")
```

## API

### `createResource(fetcher, options?)`

Creates a reactive resource that tracks an async fetcher.

**Parameters:**

- `fetcher: (abort: AbortSignal) => Promise<T>` — Async function that produces data. Receives an `AbortSignal` for cancellation. Any alien-signals signals read in the synchronous preamble (before the first `await`) become reactive dependencies.
- `options.initialValue?: T` — Initial data value (default: `undefined`).

**Returns: `Resource<T>`**

| Member                   | Type             | Description                                                               |
| ------------------------ | ---------------- | ------------------------------------------------------------------------- |
| `resource()`             | `T \| undefined` | Read current data. `undefined` while loading (unless `initialValue` set). |
| `resource.loading()`     | `boolean`        | Whether a fetch is in progress.                                           |
| `resource.error()`       | `Error \| null`  | Error from last fetch, or `null`.                                         |
| `resource.refetch()`     | `void`           | Manually trigger a re-fetch.                                              |
| `resource.mutate(value)` | `void`           | Optimistically set data (overwritten on next fetch).                      |
| `resource.dispose()`     | `void`           | Stop tracking, cancel in-flight fetches.                                  |

## How It Works

1. The fetcher runs inside an `effect()` tracking context.
2. Any signals read during the fetcher's synchronous portion (before the first `await`) become dependencies.
3. When dependencies change, the effect re-runs — aborting any in-flight request via `AbortController` and starting a new fetch.
4. A monotonic fetch ID ensures only the latest fetch writes to the data/loading/error signals (stale responses are discarded).

## Examples

### Initial value

```typescript
const data = createResource(async () => fetchExpensiveData(), { initialValue: [] })
// data() returns [] immediately, then the fetched result
```

### Manual refetch

```typescript
const feed = createResource(async () => fetchFeed())

// Poll every 30 seconds
setInterval(() => feed.refetch(), 30_000)
```

### Optimistic update

```typescript
const todos = createResource(async () => fetchTodos())

function addTodo(todo: Todo) {
  // Show immediately
  todos.mutate([...todos()!, todo])
  // Persist (refetch will overwrite with server state)
  postTodo(todo).then(() => todos.refetch())
}
```

### Cleanup

```typescript
const resource = createResource(async (abort) => {
  const res = await fetch(url, { signal: abort })
  return res.json()
})

// When done — stops tracking dependencies, cancels in-flight fetch
resource.dispose()
```

## Credits & Inspiration

- **[alien-signals](https://github.com/stackblitz/alien-signals)** by [Johnson Chu](https://github.com/nicksrandall) — the reactive engine this package builds on. Fastest signals implementation, proven by Vue 3.6 adoption.
- **[SolidJS](https://github.com/solidjs/solid)** by [Ryan Carniato](https://github.com/ryansolid) — pioneered `createResource` (Solid 1.x) and `createAsync` (Solid 2.0) for bridging async data into reactive graphs. The loading/error/refetch/mutate pattern originates here.
- **[Angular](https://github.com/angular/angular)** — `resource()` (Angular 17+) provides a similar async-to-signal bridge with `.value()`, `.isLoading()`, `.error()`.
- **[TanStack Query](https://github.com/TanStack/query)** — popularized the loading/error/refetch pattern for async data in React. Not signal-based, but the UX conventions (stale-while-revalidate, optimistic updates) influenced this API.

### Compatibility

This package is **not API-compatible** with SolidJS `createResource` or Angular `resource()`. It follows alien-signals conventions (callable accessors: `resource()` not `resource.value`, `.loading()` not `.loading`). SolidJS returns `[data, { loading, error, refetch, mutate }]` (tuple); this returns a single callable with signal sub-properties. The concepts are the same; the ergonomics match the alien-signals ecosystem.

## See Also

- **[alien-projections](https://www.npmjs.com/package/alien-projections)** — Incremental reactive collection transforms for alien-signals. `createProjection(source, { key, map, filter, sort })` only re-maps changed entries. The companion package for derived collections.
- **[@silvery/signals](https://silvery.dev)** — The [Silvery](https://silvery.dev) TUI framework includes `alien-resources` and `alien-projections` as part of its `@silvery/signals` package, adding React integration (`useSignal`), deep stores (`createStore`), and model factories on top.

## License

MIT
