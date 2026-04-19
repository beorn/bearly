# alien-projections

Incremental reactive collection transforms for the [alien-signals](https://github.com/stackblitz/alien-signals) ecosystem.

When one item in a large collection changes, only that item's mapped output is recomputed — not the entire collection.

## Which alien-* package do I need?

The `alien-*` family is "signals for a specific shape of data". Pick by what your data looks like:

| Your data is…                                          | Reach for                                                              | What it gives you                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **A plain value** (cursor, count, toggle)              | [`alien-signals`](https://github.com/stackblitz/alien-signals)         | The primitive. `signal(value)`, `computed(fn)`, `effect(fn)`. Everything below builds on this.          |
| **A list that changes over time** (rows, cards, todos) | **`alien-projections`** (you're here)                                  | `createProjection(list, { key, map, filter, sort })` — when one row changes, only that row re-computes. |
| **An async fetch** (API call, file load, DB query)     | [`alien-resources`](https://www.npmjs.com/package/alien-resources)     | `createResource(fetcher)` — gives you `.loading()` / `.error()` / `.refetch()` + auto-cancels stale requests. |
| **A tree / hierarchy** (folders, outlines, nested UI)  | [`alien-trees`](https://www.npmjs.com/package/alien-trees)             | `createTree(...)` — ask "does any descendant have X?" or "inherit Y from any ancestor?" in O(1).        |

They **compose**. A list of async-fetched trees of plain values uses all four together. Each package earns its place by exploiting one data shape well, not by trying to do everything.

**You're on `alien-projections`** — reach for this one when you have a reactive array and want a derived reactive array (mapped, filtered, sorted), and you don't want the whole array to recompute every time one item changes.

## Install

```bash
bun add alien-projections alien-signals
```

`alien-signals` is a peer dependency.

## Usage

```typescript
import { signal } from "alien-signals"
import { createProjection } from "alien-projections"

const items = signal([
  { id: "1", text: "Buy milk", done: false },
  { id: "2", text: "Fix bug", done: true },
])

// Incremental projection — only re-maps changed entries
const projection = createProjection(items, {
  key: (item) => item.id,
  map: (item) => ({ ...item, upper: item.text.toUpperCase() }),
  filter: (item) => !item.done,
  sort: (a, b) => a.text.localeCompare(b.text),
})

// Read the projected collection
console.log(projection())
// [{ id: "1", text: "Buy milk", done: false, upper: "BUY MILK" }]
```

## API

### `createProjection(source, options)`

Creates an incremental reactive projection over a signal-backed collection.

**Parameters:**

- `source: Signal<T[]>` — A readable signal containing the source array.
- `options.key: (item: T) => K` — Extract a stable identity key from each item. Used to track additions, removals, and changes.
- `options.map?: (item: T) => U` — Transform each item. Only re-executed when an item is new or its reference changed. Defaults to identity.
- `options.filter?: (mapped: U) => boolean` — Predicate applied after mapping. Items that fail are excluded.
- `options.sort?: (a: U, b: U) => number` — Comparator applied after map and filter.

**Returns:** `Signal<U[]>` — A computed signal producing the projected collection.

### How incremental updates work

On each recomputation:

1. The source array is iterated by key.
2. For each item, if the cache holds an entry with the **same reference**, the cached output is reused (no `map` call).
3. New or changed items (different reference) are mapped and cached.
4. Stale cache entries (keys no longer in source) are evicted.
5. Filter and sort are applied to produce the final output.

This means that if you have 10,000 items and change one, only that one item's `map` function runs.

## Credits & Inspiration

- **[alien-signals](https://github.com/stackblitz/alien-signals)** by [Johnson Chu](https://github.com/nicksrandall) — the reactive engine this package builds on. Fastest signals implementation, proven by Vue 3.6 adoption.
- **[SolidJS](https://github.com/solidjs/solid)** by [Ryan Carniato](https://github.com/ryansolid) — pioneered the "projections" concept for reactive collection transforms. See his ["Beyond Signals" talk](https://www.youtube.com/watch?v=Ck-e3hd3pKw) (JSNation US 2025) and [`createProjection`](https://github.com/solidjs/signals) in `@solidjs/signals`.
- **[Signia](https://github.com/tldraw/signia)** by [tldraw](https://tldraw.com) — incremental computation over large collections using logical clocks. Inspired the cache-based approach.

### Compatibility

This package is **not API-compatible** with SolidJS projections or Signia. It follows alien-signals conventions (callable accessors, `computed()` return type) and provides a broader API (filter + sort alongside map). SolidJS `createProjection` focuses on key-indexed UI reconciliation; this package targets general incremental collection transforms.

## See Also

- **[alien-resources](https://www.npmjs.com/package/alien-resources)** — Async signal bridge for alien-signals. `createResource(fetcher)` with loading/error states and automatic cancellation. The companion package for async data.
- **[@silvery/signals](https://silvery.dev)** — The [Silvery](https://silvery.dev) TUI framework includes `alien-projections` and `alien-resources` as part of its `@silvery/signals` package, adding React integration (`useSignal`), deep stores (`createStore`), and model factories on top.

## License

MIT
