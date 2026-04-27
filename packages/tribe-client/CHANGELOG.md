# @bearly/tribe-client

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
