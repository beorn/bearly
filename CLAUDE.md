# bearly

Reusable Claude Code tools — coordination, testing, research, refactoring.

**All generic Claude tools should live here**, not in project-specific repos.

## Tools

| Tool          | Description                                                   | Entry Point                   |
| ------------- | ------------------------------------------------------------- | ----------------------------- |
| `refactor`    | Batch rename, replace, API migration (run `--help` for guide) | `bun tools/refactor.ts`       |
| `llm`         | Multi-LLM research, consensus, deep research, local models    | `bun tools/llm.ts`            |
| `recall`      | Session history search, LLM synthesis, file recovery          | `bun tools/recall.ts`         |
| `tribe`       | Cross-session coordination MCP channel                        | `bun tools/tribe.ts`          |
| `tribe-cli`   | Tribe CLI: status, send, log, health, sessions                | `bun tools/tribe-cli.ts`      |
| `tribe-retro` | Tribe retrospective: metrics, timeline, coordination health   | `bun tools/tribe-retro.ts`    |
| `github`      | GitHub notifications MCP channel (push, PR, CI, issues)       | `bun tools/github-channel.ts` |
| `tty`         | TTY testing MCP server (Bun PTY + xterm-headless)             | MCP server + CLI              |
| `worktree`    | Git worktree management with submodules                       | `bun tools/worktree.ts`       |

### Plugin System

Tribe supports a plugin architecture for optional capabilities that enhance coordination. Plugins gracefully degrade -- if dependencies are unavailable, they silently disable themselves.

**Interface** (`TribePlugin` in `tools/lib/tribe/plugins.ts`):

```typescript
interface TribePlugin {
  name: string
  available(): boolean                          // Check if plugin can activate
  start?(ctx: PluginContext): (() => void) | void  // Background polling; returns cleanup
  instructions?(): string                       // Extra MCP system prompt text
}
```

**Built-in plugins** (activate automatically based on availability):

| Plugin   | Activates when          | What it does                                      |
| -------- | ----------------------- | ------------------------------------------------- |
| `git`    | Inside a git repo       | Reports new commits to chief every 30s            |
| `beads`  | `.beads/` dir exists    | Reports bead claims/closures to chief every 30s   |

**Standalone operation**: Tribe works without beads. When no `.beads/` directory is found, the DB defaults to `~/.local/share/tribe/tribe.db` and the beads plugin silently disables.

**Adding a custom plugin**:

1. Create a factory function returning `TribePlugin`
2. Add it to the plugins array in `tools/tribe.ts` (where `gitPlugin()` and `beadsPlugin()` are loaded)
3. `loadPlugins()` handles availability checking, startup, and cleanup

### Refactor Tool Capabilities

- **migrate**: Full terminology migration (files + symbols + text)
- **rename.batch**: TypeScript symbol rename (catches destructuring, re-exports)
- **pattern.replace**: Text search/replace (comments, markdown, strings)
- **pattern.migrate**: LLM-powered API migration (complex pattern transformations)

Run `bun tools/refactor.ts --help` for detailed command reference and examples.

## Skills

See `skills/` for Claude Code skill definitions:

- `batch-refactor/` - Batch refactoring workflow
- `llm/` - Multi-LLM queries
- `tty/` - Terminal app testing

## Usage

Include as git submodule in `vendor/`:

```bash
git submodule add <repo-url> vendor/bearly
```

Run tools:

```bash
bun vendor/bearly/tools/llm.ts ask "question"
bun vendor/bearly/tools/refactor.ts rename.batch --pattern foo --replace bar
```

## Development

```bash
cd vendor/bearly
bun install
bun run typecheck
```
