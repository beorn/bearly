# @bearly/mux-protocol

Backend-agnostic **multiplexer interface** + a **capability-adaptive contract suite**.
Lets a coordinator (tent/chief) drive agent panes without knowing whether cmux,
tmux-directly, or silvermux is underneath. Sibling to
[`@bearly/mux-cmux-adapter`](../mux-cmux-adapter).

Extracted **bottom-up** from tent/chief's actual cmux usage
([`@km/silvery/19260-silvermux-prototype/17273`](https://github.com/beorn)) — only
the verbs tent calls, nothing speculative.

## Interface

```ts
import type { MuxBackend } from "@bearly/mux-protocol"
```

- **lifecycle** — `spawnPane(opts) → PaneRef`, `closePane(pane)`;
  `PaneRef.primarySurfaceId` is populated when the backend reports the new
  pane's first surface directly
- **enumerate** — `listPanes(workspace)`, `listSurfaces(workspace, paneId)`
- **io** — `sendText(surface, text)`, `sendKey(surface, key)`, `readScreen(surface, {lines})`
- **metadata** — `renameTab(pane, title)`
- **negotiation** — `capabilities() → { multiPane, renameTab, browserPane, scrollback }`

A **pane** is the lifecycle/metadata unit; a **surface** is the addressable I/O
unit inside it (mirrors cmux's `read-screen --surface`). Backends throw the typed
`UnsupportedCapabilityError` for verbs beyond their `capabilities()`, and
`MuxRefNotFoundError` for unknown pane/surface refs — never a raw crash.

> **No `subscribe()`.** The 17273 audit found tent is poll-only (it scrapes via
> `readScreen` on a cadence; nothing consumes cmux's NDJSON event stream), so an
> event verb would be speculative over-design.

## Reference backend (test kit)

`createInMemoryMux(capabilities?)` is a faithful in-memory `MuxBackend` — the
behavioral spec the contract suite is validated against, and a zero-dependency
test double. It lives with the tests it serves, on its own subpath; this package
is private today, so these subpaths are internal seams, not a published API.
Pass restricted capabilities to exercise negotiation paths:

```ts
import { ALL_CAPABILITIES, createInMemoryMux } from "@bearly/mux-protocol/testing/in-memory-mux"
const noRename = createInMemoryMux({ ...ALL_CAPABILITIES, renameTab: false })
```

## Contract suite (test kit)

```ts
import { test } from "vitest"
import { muxContractCases } from "@bearly/mux-protocol/testing/contract-cases"
for (const c of muxContractCases(makeBackend)) test(c.name, c.run)
```

31 capability-adaptive cases (lifecycle, IO, surface enumeration, capability
negotiation, error paths). The **same** suite runs against any backend — divergence
beyond `capabilities()` is a bug. Assertions use `node:assert/strict` (no
test-framework dependency).
