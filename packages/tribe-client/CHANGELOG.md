# @bearly/tribe-client

## 0.4.1 — 2026-05-25

### Fixed

- **`src/cli.ts` mode bit (chmod 755) — fixes recurring km CI format-check failures.**
  `bun install` chmod's bin sources to 755 on every install (correct npm
  behavior). When the source was committed at 644 in 0.4.0, every install
  produced a one-line mode-only diff that dirtied the bearly submodule in
  km's working tree → km format-check assert-clean-tree gate tripped on
  every PR. Now committed at 755 so install is a no-op. See
  `@km/bearly/tribe-client-cli-source-mode-bit`.
- Sibling fix in `@bearly/llm` (`plugins/llm/src/cli.ts` had the same
  shape) — both bin sources now ship at 755.

## 0.4.0 — 2026-05-25

### Known issue (fixed in 0.4.1)

- `src/cli.ts` was committed at mode 644. `bun install` chmod-fixed it
  on every install, producing a mode-only diff that dirtied the bearly
  submodule in km's working tree. Affects all installs against the 0.4.0
  tag. Workaround for anyone pinning 0.4.0: `chmod +x
node_modules/@bearly/tribe-client/dist/cli.mjs` post-install. Upgrade
  to 0.4.1 to fix.

### Added

- **`tribe` CLI binary (Phase A.MVP of `@km/bearly/tribe-cli-unify-phase-a-substrate`).**
  The package now ships a `tribe` bin entry (`./src/cli.ts` in local dev,
  `./dist/cli.mjs` post-publish). Subcommand dispatcher with `tribe mcp`
  as the only subcommand in this release — runs the stdio MCP adapter
  with the same flag surface (`--name`, `--role`, `--socket`, `--account`,
  `--provider`, `--domains`) as the underlying `stdio-adapter.ts`. The
  `mcp` subcommand exists to be invocable as `tribe mcp` from the bin
  entry rather than `bun packages/tribe-client/src/stdio-adapter.ts`.
- **`@bearly/tribe-client/cli` subpath export.** Importing the cli module
  directly is supported for embedding scenarios; the bin entry is the
  primary surface.

### Not yet (deferred to Phase A.2)

- Verb subcommands (`status`, `sessions`, `send`, `log`, `retro`,
  `install`, `uninstall`, `doctor`, `lifecycle`, `hook`, …) — these
  remain in `vendor/bearly/tools/tribe-cli.ts` for now. The verb
  migration adds ~6 transitive deps from `tools/lib/tribe/`
  (`retro.ts`, `install.ts`, `hook-dispatch.ts`, `activity-watch.ts`,
  `autostart-config.ts`, `hooks/index.ts`); some are daemon-internal
  (retro reads DB directly). The scope-split was chief-approved per the
  "rename first, split later" refactor lesson — `tribe mcp` ships first
  to unblock downstream consumers (`@bearly/tribe` plugin, daemon
  hardening, notification renderer), verb migration follows.

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
- **`@bearly/tribe-client/lib/transcript`** — pure readers for
  `resolveTranscriptPath` and `readTranscriptSlug`, extracted from
  `tools/lib/tribe/session.ts` (the rest of session.ts stays in `tools/`
  because it is TribeContext-coupled).
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
