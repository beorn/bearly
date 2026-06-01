# @bearly/mux-cmux-adapter

cmux backend for [`@bearly/mux-protocol`](../mux-protocol) — wraps the `cmux` CLI
behind the `MuxBackend` interface with **no behavior change**. This is the seam
that lets tent/chief talk to "a mux" instead of shelling out to `cmux` directly
([`@km/silvery/17273`](https://github.com/beorn), Phase 1).

## Usage

```ts
import { createCmuxBackend } from "@bearly/mux-cmux-adapter"

const mux = createCmuxBackend() // spawns the real `cmux` binary
const pane = await mux.spawnPane({ workspace: "tent", command: "claude" })
const [surface] = await mux.listSurfaces("tent", pane.id)
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

| MuxBackend     | cmux argv                                                  |
| -------------- | ---------------------------------------------------------- |
| `spawnPane`    | `new-pane --workspace W --command C [--cwd D] [--title T]` |
| `closePane`    | `close-pane --workspace W --pane P`                        |
| `listPanes`    | `list-panes --workspace W`                                 |
| `listSurfaces` | `list-pane-surfaces --workspace W --pane P`                |
| `sendText`     | `send-text --surface S --text T`                           |
| `sendKey`      | `send-key --surface S --key K`                             |
| `readScreen`   | `read-screen --surface S [--lines N]`                      |
| `renameTab`    | `rename-tab --pane P --title T`                            |

The **read/enumerate** argv (`read-screen --surface --lines`, `list-panes
--workspace`, `list-pane-surfaces --workspace --pane`) are confirmed from tent's
real call sites (`chief.ts`). The **lifecycle/io/metadata** argv are the adapter's
contract with cmux, pinned by the contract test's stateful fake cmux; **Phase 2
verifies them against the real `cmux` binary before any tent call site is
refactored.**

`capabilities()` reports all four flags `true` — cmux is the full-featured
backend. cmux "not found" failures map to the typed `MuxRefNotFoundError`; any
other non-zero exit surfaces as a loud `Error` (no silent fallbacks).
