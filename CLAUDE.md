# bearly

Monorepo of reusable Claude Code tools. Each package is **independently publishable** with its own version, README, CHANGELOG, and npm scope.

The root `bearly` package is `private: true` at version `0.0.0` — it is never published. Only the child packages are published.

## Packages

### The tribe family — MOVED to github.com/beorn/tribe (June 2026)

The tribe coordination + memory system (wire, daemon, recall engine,
injection envelope, bg-recall, Claude Code plugin) lives in its own
repository: `github.com/beorn/tribe` (km bead
`@km/bearly/19273-tribe-repo-split`). Install:
`/plugin marketplace add beorn/tribe` then `/plugin install tribe@tribe`.
bearly keeps `plugins/llm`, which tribe consumes via its `TRIBE_LLM_DIR`
seam — do not add tribe-specific surface area back into bearly.

### Supporting primitives

| Package       | npm               | Role                                                                     | Entry Point    |
| ------------- | ----------------- | ------------------------------------------------------------------------ | -------------- |
| `@bearly/llm` | _private (0.1.0)_ | Multi-provider LLM dispatch — cheap-model race, consensus, deep research | `plugins/llm/` |

**0.3.0 — bundle removed (2026-05-25)** — `@bearly/tribe-client` now ships the stdio MCP adapter (formerly `tools/stdio-adapter.ts`); the `@bearly/tribe` plugin's `server.mjs` committed bundle is gone, replaced by a one-line `server.ts` that imports `@bearly/tribe-client/stdio`. Eliminates the recurring drift class (CI built-artifacts gate failures, monorepo-vs-standalone build mismatch, stale MCP schema). See `packages/tribe-client/CHANGELOG.md` 0.3.0 + `plugins/tribe/CHANGELOG.md` 0.15.0 + `@km/bearly/tribe-stdio-adapter-as-npm-dep`.

**0.4.0 — `tribe` CLI binary (2026-05-25)** — Phase A.MVP of `@km/bearly/tribe-cli-unify-phase-a-substrate`. The package now ships a `tribe` bin entry with a `tribe mcp` subcommand that runs the stdio adapter (same flag surface). Subsequent A.2 work ports the verb subcommands (`status`, `sessions`, `send`, `log`, `retro`, `install`, …) from `vendor/bearly/tools/tribe-cli.ts`.

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

| Tool             | Description                                                                                      | Entry Point                          |
| ---------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `refactor`       | Batch rename, replace, API migration                                                             | `bun tools/refactor.ts`              |
| `llm`            | Multi-LLM research, consensus, deep research                                                     | `bun tools/llm.ts`                   |
| `recall`         | Session history search, LLM synthesis                                                            | `bun tools/recall.ts`                |
| ~~`tty`~~        | ~~TTY testing MCP server~~ — **folded into `termless mcp`** (see note below)                     | `termless mcp` (via `@termless/cli`) |
| `worktree`       | Git worktree management with submodules — **now lives in km/tools/worktree.ts** (see note below) | `bun tools/worktree.ts` (km root)    |
| `github-channel` | GitHub notifications (deprecated — use tribe github plugin)                                      | `bun tools/github-channel.ts`        |

### Note: `tty` moved out of vendor/bearly

Per [`@km/infra/mcp-tty-ghostty-backend-toggle`](https://github.com/beorn/km/blob/main/%40km/infra/mcp-tty-ghostty-backend-toggle.md): the canonical `tty` MCP tool lives in `@termless/cli` (run as `termless mcp`), not in this submodule. The deprecated `bun tools/tty.ts` + `tools/lib/playwright-tty/` were deleted in Phase 9 (2026-05-19). The migration was driven by the native canvas pipeline (`@napi-rs/canvas` + `ghostty-web` in pure Bun) that eliminated termless's Chromium dependency, making bearly's Playwright-based tty wrapper redundant — `termless mcp`'s `screenshot` tool routes through `Terminal.screenshot()` for the same (or better) fidelity, with no Chromium and a resvg cross-platform fallback. Existing MCP client configs that pointed at the bearly `playwright-tty` MCP server should switch to `termless mcp`.

### Note: `worktree` moved out of vendor/bearly

Per [`@km/all/worktree-tooling-submodule-cycle`](https://github.com/beorn/km/blob/main/%40km/all/worktree-tooling-submodule-cycle.md): the canonical `bun worktree` tool now lives at `km/tools/worktree.ts`, not in this submodule. This breaks the submodule-pointer-propagation cycle where main bumps the bearly pointer for a worktree-tooling fix but each git-worktree carries its own pinned pointer that doesn't auto-update. `vendor/bearly` retains the source for backwards-compatible callers but the km root is the source of truth.

### Tribe Tools (part of @bearly/tribe)

| Tool            | Description                                             | Entry Point                  |
| --------------- | ------------------------------------------------------- | ---------------------------- |
| `tribe-daemon`  | Coordination daemon (discovery broker, Unix socket IPC) | `bun tools/tribe-daemon.ts`  |
| `stdio-adapter` | Per-agent stdio↔Unix-socket MCP transport adapter       | `bun tools/stdio-adapter.ts` |
| `tribe-cli`     | CLI: status, send, log, health, sessions, retro, watch  | `bun tools/tribe-cli.ts`     |
| `tribe-watch`   | Live TUI dashboard (React/Silvery)                      | `bun tools/tribe-watch.tsx`  |

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
- ~~`tty/`~~ — Terminal app testing (folded into `termless mcp`; see Tools table note above)
- `tribe/` — Tribe coordination

## Development

```bash
cd vendor/bearly
bun install
bun run typecheck
```

## Releasing

Only publish child packages, never the root. The root `bearly` package stays at `0.0.0` permanently.

Publishing is CI-driven via per-package tags. `.github/workflows/release.yml` fires on tags matching `<package-dir-name>-v<version>` and publishes only the matching package.

```bash
# Bump version in packages/<pkg>/package.json, then:
git commit -am "release: alien-trees 0.2.0"
git tag alien-trees-v0.2.0
git push origin main --follow-tags
```

The workflow parses the tag, verifies `package.json` version matches (fails fast on drift), builds with tsc, and runs `npm publish --access public --provenance`.

**Local fallback** for emergencies:

```bash
cd packages/<pkg> && bun run build && npm publish --access public --provenance
```

Required GitHub secret: `NPM_TOKEN`. Provenance runs via OIDC (no extra setup).
