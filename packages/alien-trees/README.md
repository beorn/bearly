# alien-trees

Tree-scoped reactive aggregates for the [alien-signals](https://github.com/stackblitz/alien-signals) ecosystem.

Declarative aggregates over ancestors or descendants of a tree, maintained incrementally with a sparse ancestor index. Cursor / editing / selection / tag-propagation patterns become O(1) reads + O(depth) writes instead of O(subtree) walks.

## Which alien-* package do I need?

The `alien-*` family is "signals for a specific shape of data". Pick by what your data looks like:

| Your data is…                                          | Reach for                                                                  | What it gives you                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **A plain value** (cursor, count, toggle)              | [`alien-signals`](https://github.com/stackblitz/alien-signals)             | The primitive. `signal(value)`, `computed(fn)`, `effect(fn)`. Everything below builds on this.          |
| **A list that changes over time** (rows, cards, todos) | [`alien-projections`](https://www.npmjs.com/package/alien-projections)     | `createProjection(list, { key, map, filter, sort })` — when one row changes, only that row re-computes. |
| **An async fetch** (API call, file load, DB query)     | [`alien-resources`](https://www.npmjs.com/package/alien-resources)         | `createResource(fetcher)` — gives you `.loading()` / `.error()` / `.refetch()` + auto-cancels stale requests. |
| **A tree / hierarchy** (folders, outlines, nested UI)  | **`alien-trees`** (you're here)                                            | `createTree(...)` — ask "does any descendant have X?" or "inherit Y from any ancestor?" in O(1).        |

They **compose**. A list of async-fetched trees of plain values uses all four together. Each package earns its place by exploiting one data shape well, not by trying to do everything.

**You're on `alien-trees`** — reach for this one when your data has a parent/child structure and you need reactive "is any descendant doing X?" or "does this node inherit from an ancestor doing Y?" queries. Classic examples: a cursor in an outline (every ancestor highlights), tasks inside folders (folder shows "3 incomplete" live), tag inheritance down a subtree.

## Install

```bash
bun add alien-trees alien-signals
```

`alien-signals` is a peer dependency.

## Usage

```typescript
import { signal } from "alien-signals"
import { createTree, type Traversal } from "alien-trees"

// Any object that answers parent(id) + children(id) is a valid tree.
const parent: Record<string, string | null> = { root: null, col: "root", card: "col", sub: "card" }
const children: Record<string, string[]> = { root: ["col"], col: ["card"], card: ["sub"], sub: [] }
const traversal: Traversal = {
  parent: (id) => parent[id] ?? null,
  children: (id) => children[id] ?? [],
}

const store = createTree(
  (tree) => ({
    // Writable state (per node)
    cursor: signal(false),
    selected: signal(false),
    ownTags: signal([] as string[]),

    // Declarative aggregates — the engine picks the right strategy internally
    cursorDescendant: tree.descendants((s: { cursor: unknown }) => s.cursor).some(),
    selectedAncestor: tree.ancestors((s: { selected: unknown }) => s.selected).some(),
    tagsFromAncestors: tree
      .ancestors((s: { ownTags: unknown }) => s.ownTags)
      .reduce(
        (acc: string[], v) => ((v as string[]).length === 0 ? acc : [...acc, ...(v as string[])]),
        () => [] as string[],
        { includeSelf: true },
      ),
  }),
  traversal,
)

store.get("sub").cursor(true)
store.get("col").cursorDescendant() // true (O(1) read)
store.get("root").cursorDescendant() // true
```

## API

```ts
createTree(factory, traversal) → TreeStore
```

`factory` is called once with a `tree` DSL and returns a schema of signals + aggregate descriptors. `traversal` is a duck-typed `{ parent, children }` object — the engine doesn't own your tree storage.

### The `tree` DSL

```ts
tree.descendants(s => s.key).some(opts?)                         // Descriptor<boolean>
tree.descendants(s => s.key).count(opts?)                        // Descriptor<number>
tree.descendants(s => s.key).reduce(reducer, initial, opts?)     // Descriptor<T>
tree.ancestors(s => s.key).some(opts?)                           // same shape, walks up
tree.ancestors(s => s.key).count(opts?)
tree.ancestors(s => s.key).reduce(reducer, initial, opts?)
```

Options:

- `includeSelf?: boolean` — include the node itself in the aggregate
- `equals?: (a, b) => boolean` (reduce only) — stability check to avoid downstream re-renders

### `TreeStore<T>`

```ts
interface TreeStore<T> {
  get(id: string): NodeAccessor<T> // lazy-creates on first access; memoized thereafter
  has(id: string): boolean
  clear(): void // drop all nodes + indices
  readonly size: number
  rebind(traversal: Traversal): void // swap in a new traversal, keep signals alive
}
```

`NodeAccessor<T>` exposes every signal as a callable `(value?) => value` and every aggregate as a zero-arg getter. `rebind()` preserves node identity and signal values — React subscriptions (via alien-signals `computed`) stay valid across topology changes.

## How it works

The engine classifies each descriptor (`dir` + `type`) and picks a maintenance strategy internally:

| Descriptor shape                       | Strategy                   | Read cost           | Write cost |
| -------------------------------------- | -------------------------- | ------------------- | ---------- |
| `descendants(...).some()` / `.count()` | Sparse ancestor index      | O(1)                | O(depth)   |
| `ancestors(...).some()` / `.count()`   | Walk-up per read           | O(depth)            | O(1)       |
| `.reduce(...)` (either direction)      | Walk (needs actual values) | O(subtree or depth) | O(1)       |

**The sparse ancestor index** is the core win. It maintains a `Map<ancestorId, count>` of how many descendants of each node currently have the observed signal truthy. Cursor moves are O(depth) walk-up operations instead of O(subtree) reads from every ancestor. On a 100K-node column, that's 100,001 traversal calls → 0, and ~20ms → 0.01ms per cursor move.

Strategies are an internal implementation detail. There's one API, and the engine picks the right maintenance for each descriptor — same discipline as `alien-projections` and `alien-resources`.

## Credits & inspiration

- **[alien-signals](https://github.com/stackblitz/alien-signals)** by [Johnson Chu](https://github.com/johnsoncodehk) — the reactive engine this builds on. Powers Vue 3.6.
- **[Bevy ECS `Changed<T>` queries](https://bevy-cheatbook.github.io/programming/change-detection.html)** — the sparse-index-over-hierarchy pattern originates in game engines (Bevy, flecs). `alien-trees` brings that pattern to signal-driven JS UIs.
- **[Materialized views](https://www.postgresql.org/docs/current/rules-materializedviews.html)** (Postgres, Materialize) — the general model: declarative query, engine picks incremental-refresh strategy.
- **[Adapton](https://github.com/cuplv/adapton.ocaml)** / **[Salsa](https://github.com/salsa-rs/salsa)** — academic inspiration for self-adjusting computation over dependency graphs.

### Compatibility

**Not API-compatible with any of the above.** Follows alien-signals conventions (callable accessors: `store.get(id).cursorDescendant()` not `store.get(id).cursorDescendant.value`). The DSL is specific to alien-trees; similar ideas appear in the ECS and database worlds but no prior JS/TS library packages this exact combination.

## React integration

[`@silvery/signals`](https://silvery.dev) bundles all four alien-* packages and adds React hooks (`useSignal`, deep stores, model factories). If you're using React, that's the fastest way to pull the whole family in one install.

## Tests & benchmarks

From a clone of the [bearly monorepo](https://github.com/beorn/bearly):

```bash
bun vitest run packages/alien-trees/tests/              # 33 behavioral tests
bun vitest bench packages/alien-trees/                  # stress + perf benchmarks
BENCH_VERBOSE=1 bun vitest bench packages/alien-trees/  # prints traversal call counts
```

Covers: signals, `.some()` / `.count()` correctness, `.reduce()` with equals, `includeSelf`, lifecycle (clear / has / rebind), atomicity under batched writes, re-entrancy, bootstrap ordering of truthy initial values.

Benchmarks validate: cursor read on empty 100K column = 0 traversal calls; writes cost O(depth) `parent()` calls; rebind is linear in truthy-node count, not total-node count.

## License

MIT
