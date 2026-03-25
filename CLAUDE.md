# bearly

Reusable Claude Code tools — coordination, testing, research, refactoring.

**All generic Claude tools should live here**, not in project-specific repos.

## Tools

| Tool       | Description                                                   | Entry Point             |
| ---------- | ------------------------------------------------------------- | ----------------------- |
| `refactor` | Batch rename, replace, API migration (run `--help` for guide) | `bun tools/refactor.ts` |
| `llm`      | Multi-LLM research, consensus, deep research                  | `bun tools/llm.ts`      |
| `recall`   | Session history search, LLM synthesis, file recovery          | `bun tools/recall.ts`   |
| `tty`      | TTY testing MCP server (Bun PTY + xterm-headless)             | MCP server + CLI        |
| `worktree` | Git worktree management with submodules                       | `bun tools/worktree.ts` |

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
