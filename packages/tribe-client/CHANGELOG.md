# @bearly/tribe-client

## Unreleased

### Changed

- **Codex/Gemini stdio adapters default to pull delivery.** `resolveDeliveryMode`
  now honors explicit `TRIBE_DELIVERY=push|pull`, then auto-detects MCP-only
  hosts (`TRIBE_PROVIDER=codex|gemini`, Codex Desktop env vars) and registers
  them as `delivery: "pull"`. Claude Code stays on push by default.

## 0.3.0 — 2026-05-25

### Added

- **`@bearly/tribe-client/stdio` subpath export.** The stdio MCP adapter
  (formerly `tools/stdio-adapter.ts`) now lives at
  `packages/tribe-client/src/stdio-adapter.ts`. Importing the subpath runs
  the adapter's module-level bootstrap — used by `@bearly/tribe`'s
  `server.ts` so the plugin no longer ships a committed bundle.
- **`@bearly/tribe-client/lib/socket`** — tribe-flavored facade over the
  core IPC primitives. Exports `TRIBE_PROTOCOL_VERSION`, `probeDaemonPid`,
  and a `createReconnectingClient` wrapper with a default `daemonScript`
  resolver (env-var-overridable via `TRIBE_DAEMON_SCRIPT`).
- **`@bearly/tribe-client/lib/config`** — tribe arg parser + session-id /
  project-name / DB-path resolvers (moved from `tools/lib/tribe/config.ts`).
- **`@bearly/tribe-client/lib/tools-list`** — canonical MCP tools list
  (moved from `tools/lib/tribe/tools-list.ts`); the daemon now imports it
  from here as the single source of truth.
- **`@bearly/tribe-client/lib/cwd-guardrail`** — cwd policy probe and
  evaluator (moved from `tools/lib/tribe/cwd-guardrail.ts`).
- **`@bearly/tribe-client/lib/hot-reload`** — file-watch + re-exec helper
  (moved from `tools/lib/tribe/hot-reload.ts`).
- **`@bearly/tribe-client/lib/transcript`** — pure `resolveTranscriptPath`
  and `readTranscriptSlug` readers extracted from `tools/lib/tribe/session.ts`
  (the rest of session.ts stays in `tools/` because it is TribeContext-
  coupled).
- **`@bearly/tribe-client/lib/defang`** — vendored copy of
  `defangModelInput` from `@bearly/injection-envelope`, so the published
  tribe-client has zero plugin-cross dependencies.

### Changed

- **Package flipped public** (`"private": false`) — first publish.
- Added `@modelcontextprotocol/sdk` as a runtime dependency.

### Migration

External consumers of `tools/lib/tribe/{socket,config,tools-list,cwd-guardrail,hot-reload}.ts`
should import from `@bearly/tribe-client/lib/<x>` instead. In bearly's own
tree, that migration is already complete — `tools/tribe-daemon.ts`,
`tools/tribe-cli.ts`, `tools/bg-recall.ts`, the daemon's `tools/lib/tribe/compose/*`,
and the integration tests now all source the shared lib from
`@bearly/tribe-client/lib/<x>`. No re-export shims in the legacy paths —
they were deleted, not aliased (per `docs/lessons/refactoring.md` Case
Study 7).

## 0.2.0 — 2026-04-27

### Breaking

- **Renamed from `@bearly/daemon-spine` → `@bearly/tribe-client`.** Directory
  also renamed from `packages/daemon-spine/` → `packages/tribe-client/`.
  Closes the "(rename pending)" annotation tracked in `hub/architecture.md`
  under the km-tribe.refactor post-close package-rename wave.

  Migration: replace `@bearly/daemon-spine` with `@bearly/tribe-client` in
  every import. Public surface (factory exports, types, log namespaces inside
  the package) is unchanged — only the import path moves.

  Internal log namespaces follow the rename:
  - `daemon-spine:client` → `tribe-client:client`
  - `daemon-spine:parser` → `tribe-client:parser`

  Rationale: the package is conceptually a "tribe client" library — it owns
  the JSON-RPC wire, the line-delimited parser, the daemon client, the
  reconnection policy, and the composition primitives (pipe, Scope, tool
  registry). The `daemon-spine` name predated the tribe vocabulary
  stabilization and confused readers ("spine of what?").

## 0.1.0 — 2026-04-26

Initial release as `@bearly/daemon-spine`. Shared Unix-socket IPC primitives
extracted from `tools/lib/tribe/socket.ts` (and the verbatim copy at
`plugins/tribe/lore/lib/socket.ts`):

- JSON-RPC 2.0 wire protocol (types + helpers)
- Line-delimited JSON parser
- `connectToDaemon`, `connectOrStart`, `createReconnectingClient`
- `withDaemonCall` (deadline-bounded call, hook-friendly)
- Socket path discovery (`resolveSocketPath`, `resolvePeerSocketPath`)
- Composition primitives: `pipe`, `Scope` / `createScope`, tool registry
  (`Tool`, `ToolRegistry`, `withTools`, `withTool`)
