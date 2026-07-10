# @bearly/mux-cmux-adapter

cmux backend for [`@bearly/mux-protocol`](../mux-protocol) — wraps the `cmux` CLI
behind the `MuxBackend` interface with **no behavior change**. This is the seam
that lets tent/chief talk to "a mux" instead of shelling out to `cmux` directly
([`@si/mux/19260-proto/17273`](https://github.com/beorn), Phase 1).

## Usage

```ts
import { createCmuxBackend } from "@bearly/mux-cmux-adapter"

const mux = createCmuxBackend() // spawns the real `cmux` binary
const pane = await mux.spawnPane({ workspace: "tent", command: "claude" })
const surface = pane.primarySurfaceId
  ? { id: pane.primarySurfaceId, paneId: pane.id }
  : (await mux.listSurfaces("tent", pane.id))[0]
await mux.sendText(surface, "/compact")
const screen = await mux.readScreen(surface, { lines: 60 })
await mux.closePane(pane)
```

Execution is dependency-injected for testing:

```ts
createCmuxBackend({ exec: myFakeCmux }) // (args: string[]) => Promise<{stdout, stderr, code}>
createCmuxBackend({ binary: "cmux-next" }) // override the binary
```

## cmux verb mapping

| MuxBackend     | cmux argv                                   |
| -------------- | ------------------------------------------- |
| `spawnPane`    | `new-pane --workspace W --type terminal`    |
| `closePane`    | `close-pane --workspace W --pane P`         |
| `listPanes`    | `list-panes --workspace W`                  |
| `listSurfaces` | `list-pane-surfaces --workspace W --pane P` |
| `sendText`     | `send --surface S -- T`                     |
| `sendKey`      | `send-key --surface S K`                    |
| `readScreen`   | `read-screen --surface S [--lines N]`       |
| `renameTab`    | `rename-tab --pane P --title T`             |

The **read/enumerate** argv (`read-screen --surface --lines`, `list-panes
--workspace`, `list-pane-surfaces --workspace --pane`) are confirmed from tent's
real call sites (`chief.ts`). The terminal lifecycle argv is confirmed against
`cmux new-pane --help` and tent's spawn path (`agent.ts`). The **io** argv is
verified against `cmux send --help` / `cmux send-key --help`: cmux has no
`send-text` verb (the text goes to `send`, positional after `--`) and `send-key`
takes the key positionally (no `--key` flag). `spawnPane` returns
`primarySurfaceId` when cmux reports the new terminal surface so callers can keep
their existing send path while routing creation through the adapter.

`capabilities()` reports all four flags `true` — cmux is the full-featured
backend. cmux "not found" failures map to the typed `MuxRefNotFoundError`; any
other non-zero exit surfaces as a loud `Error` (no silent fallbacks).
