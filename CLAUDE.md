# bearly

Monorepo of reusable Claude Code tools. Each package is **independently publishable** with its own version, README, CHANGELOG, and npm scope.

The root `bearly` package is `private: true` at version `0.0.0` — it is never published. Only the child packages are published.

## Packages

### The tribe family (one cohesive product)

See the [domain model in `plugins/tribe/README.md`](plugins/tribe/README.md#domain-model) for the authoritative vocabulary (tribe, member, chief, agent, daemon, wire, lore, recall).

| Package         | npm                                                | Role                                                                                                       | Entry Point      |
| --------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| `@bearly/tribe` | [npm](https://www.npmjs.com/package/@bearly/tribe) | Coordination + memory daemon + MCP tools + `tribe` CLI — wire, lore, plugins, watch TUI, all in one package | `plugins/tribe/` |

`@bearly/lore` was folded into `@bearly/tribe` on 2026-04-17 — what was the standalone memory daemon (focus cache, LLM summarizer, per-session hook dedup) now ships inside tribe. The split existed briefly while the concepts stabilized; the unified package is the steady state.

### Supporting primitives

| Package          | npm               | Role                                                                                     | Entry Point       |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------- | ----------------- |
| `@bearly/recall` | _private (0.1.0)_ | Session-history search primitive — FTS5 + LLM planner/agent. Used by tribe internally; also standalone. | `plugins/recall/` |
| `@bearly/llm`    | _private (0.1.0)_ | Multi-provider LLM dispatch — cheap-model race, consensus, deep research                 | `plugins/llm/`    |

Future packages (not yet extracted): `@bearly/refactor`, `@bearly/tty`, `@bearly/worktree`.

### Package Independence Rules

Each package in `plugins/` must:

- Have its own `package.json` with version, name, description
- Have its own `README.md` describing usage independently of bearly
- Have its own `CHANGELOG.md` tracking releases
- Be publishable to npm independently (`npm publish` from its directory)
- Not depend on the root bearly package or other bearly packages (unless via npm)
- Work when installed via `npm install @bearly/<package>` without the monorepo

## Tools (not yet packaged)

These live in `tools/` and run from source. They will eventually become independent packages.

| Tool             | Description                                                 | Entry Point                   |
| ---------------- | ----------------------------------------------------------- | ----------------------------- |
| `refactor`       | Batch rename, replace, API migration                        | `bun tools/refactor.ts`       |
| `llm`            | Multi-LLM research, consensus, deep research                | `bun tools/llm.ts`            |
| `recall`         | Session history search, LLM synthesis                       | `bun tools/recall.ts`         |
| `tty`            | TTY testing MCP server                                      | `bun tools/tty.ts`            |
| `worktree`       | Git worktree management with submodules                     | `bun tools/worktree.ts`       |
| `github-channel` | GitHub notifications (deprecated — use tribe github plugin) | `bun tools/github-channel.ts` |

### Tribe Tools (part of @bearly/tribe)

| Tool           | Description                                             | Entry Point                 |
| -------------- | ------------------------------------------------------- | --------------------------- |
| `tribe-daemon` | Coordination daemon (discovery broker, Unix socket IPC) | `bun tools/tribe-daemon.ts` |
| `tribe-proxy`  | MCP proxy connecting Claude Code to daemon              | `bun tools/tribe-proxy.ts`  |
| `tribe-cli`    | CLI: status, send, log, health, sessions, retro, watch  | `bun tools/tribe-cli.ts`    |
| `tribe-watch`  | Live TUI dashboard (React/Silvery)                      | `bun tools/tribe-watch.tsx` |

### Plugin System

Tribe supports plugins for optional capabilities. Plugins gracefully degrade.

| Plugin      | Activates when                | What it does                                                     |
| ----------- | ----------------------------- | ---------------------------------------------------------------- |
| `git`       | Inside a git repo             | Broadcasts new commits to all sessions                           |
| `beads`     | `.beads/` dir exists          | Broadcasts bead claims/closures                                  |
| `github`    | `gh auth` available           | Monitors all user repos, broadcasts push/PR/CI/issue events      |
| `health`    | Always                        | CPU, memory, disk, fd, git-lock, GitHub rate limit, I/O monitors |
| `accountly` | `~/.config/accountly/` exists | Auto-rotates Claude Max accounts at quota thresholds             |

## Skills

See `skills/` for Claude Code skill definitions:

- `batch-refactor/` — Batch refactoring workflow
- `llm/` — Multi-LLM queries
- `tty/` — Terminal app testing
- `tribe/` — Tribe coordination

## Development

```bash
cd vendor/bearly
bun install
bun run typecheck
```

## Releasing

Only publish child packages, never the root:

```bash
# Tribe plugin
cd plugins/tribe
bun run build        # Bundle tribe-proxy.ts → server.ts
npm publish          # Publishes @bearly/tribe

# Future packages follow the same pattern
```

The root `bearly` package stays at `0.0.0` permanently.
