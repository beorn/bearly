# bearly

Claude Code plugins and CLI tools — coordination, testing, research, refactoring.

## Plugins

Install the marketplace, then pick the plugins you want:

```bash
# Add marketplace (one time)
claude plugin marketplace add github:beorn/tools

# Install plugins
claude plugin install tribe@beorn-tools      # Cross-session coordination
claude plugin install tty@beorn-tools        # Headless terminal testing
claude plugin install llm@beorn-tools        # Multi-LLM research
claude plugin install recall@beorn-tools     # Session history search
claude plugin install batch-refactor@beorn-tools  # Batch rename/refactor
```

| Plugin                                    | Type        | What                                                                                         |
| ----------------------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| [tribe](plugins/tribe/)                   | MCP channel | Cross-session coordination — discover, message, and coordinate multiple Claude Code sessions |
| [tty](plugins/tty/)                       | MCP server  | Headless terminal testing — spawn PTY sessions, send keystrokes, capture screenshots         |
| [llm](plugins/llm/)                       | CLI skill   | Multi-LLM research — deep research, second opinions, multi-model debate                      |
| [recall](plugins/recall/)                 | CLI skill   | Session history search — FTS5-indexed search with LLM synthesis and file recovery            |
| [batch-refactor](plugins/batch-refactor/) | CLI skill   | Batch rename, refactor, and migrate across files with confidence-based auto-apply            |

## CLI Tools

Available via `bunx @beorn/tools <command>` or `bun tools/<tool>.ts`:

```bash
bunx @beorn/tools llm "question"           # Ask other LLMs
bunx @beorn/tools llm --deep "topic"       # Deep research with web search
bunx @beorn/tools recall "query"           # Search session history
bunx @beorn/tools refactor --help          # Batch refactoring CLI
```

### Non-plugin tools

| Tool                | What                                           |
| ------------------- | ---------------------------------------------- |
| `tools/worktree.ts` | Git worktree management with submodule support |

## Development

```bash
bun install
bun run typecheck
```

### As a git submodule

```bash
git submodule add git@github.com:beorn/tools.git vendor/bearly
```

## License

MIT
