# @bearly/tribe-client

Tribe client library + unified `tribe` CLI binary. Connects to the [tribe daemon][tribe] (the multi-agent coordination + memory daemon) via Unix-socket IPC over JSON-RPC 2.0.

[tribe]: https://www.npmjs.com/package/@bearly/tribe

```bash
npm install -g @bearly/tribe-client
```

## What's in the box

This package is the **npm-consumer protocol surface** for the tribe daemon — everything an external coding agent (Claude Code, Codex, Gemini, etc.) needs to participate in a tribe without bundling the daemon itself.

### `tribe` CLI

12 protocol verbs that read or send via the daemon's Unix socket. Each is a thin RPC wrapper:

| Family         | Verbs                                                                        | What it does                                                                                                               |
| -------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| read/inspect   | `status`, `sessions`, `pending`, `log`, `health`, `inbox-status`, `activity` | Query daemon state — who's connected, what's pending, what's been said, daemon health, the unified activity log            |
| send/messaging | `send`, `retro`, `alarm`, `alarm-status`, `alarm-ack`                        | Send tribe messages (DM or broadcast), generate a retro, raise/clear the andon-pull alarm                                  |
| MCP adapter    | `mcp` (argv-forwarded; not Commander-parsed)                                 | Bridges Claude Code's stdio MCP wire to the tribe daemon's Unix socket — the entry point referenced by `.mcp.json` configs |

```bash
tribe --help                                 # full Commander help + addHelpText MCP-adapter hint
tribe status                                 # active sessions with uptime + last-seen
tribe send '@chief' 'task X done' --type=notify
tribe retro --since 2h --format markdown
tribe mcp --name '@agent/3' --role member    # argv-forwarded; what .mcp.json invokes
```

### Library exports

```ts
import { connectToDaemon, resolveSocketPath } from "@bearly/tribe-client/lib/socket"
import { TRIBE_PROTOCOL_VERSION } from "@bearly/tribe-client/lib/socket"
```

JSON-RPC client, reconnecting client, line parser, composition primitives (pipe / Scope / Tool registry). See `src/lib/socket.ts`.

## Surface delineation — protocol vs dev tooling

If a verb belongs on the daemon protocol, it lives **here** (`@bearly/tribe-client`). If a verb is bearly-monorepo internal dev tooling, it lives in `vendor/bearly/tools/tribe-cli.ts` — a separate Bun script that bundles daemon-spawn lifecycle (`start`/`stop`/`reload`/`watch`), Claude Code install/uninstall/doctor (which wires up sibling plugin paths like `plugins/tribe/recall/server.ts`), and the bearly-tools-wide pluggable hook router (`tools/lib/hooks/`).

This split is intentional. Standalone npm consumers shouldn't pull in `tribe-daemon.ts`, the recall server-path wiring, or the bearly-internal hook router just to talk to a daemon. The 12 protocol verbs above are sufficient for any external agent that wants to participate in a tribe; daemon lifecycle + install + hook integration stay bundled with the source-tree dev tooling.

See [`@km/bearly/19231-tribe-cli-unify-phase-a2-verbs`](https://github.com/beorn/km/blob/main/%40km/bearly/19231-tribe-cli-unify-phase-a2-verbs.md) for the architectural decision (chief verdict 2026-05-26 — "Q3 approved").

## License

MIT
