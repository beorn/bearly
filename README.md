# bearly

Claude Code plugins and CLI tools for research, recall, refactoring, and developer
automation.

## Tribe Has Moved

The tribe coordination + memory system now lives in its own repository:
**[github.com/beorn/tribe](https://github.com/beorn/tribe)** — wire protocol
(`tribe-wire` on npm), daemon, recall engine, injection envelope, bg-recall,
and the Claude Code plugin (install: `/plugin marketplace add beorn/tribe`,
`/plugin install tribe@tribe`).

Moved from here (June 2026, km bead `@km/bearly/19273-tribe-repo-split`):
`plugins/tribe`, `packages/tribe-client`, `plugins/recall`,
`plugins/injection-envelope`, `packages/bg-recall`, and the `tools/tribe-*` /
`tools/recall*` hosts. The recall and injection-envelope histories were carried
over with `git subtree split`. bearly keeps the LLM toolkit (`plugins/llm`),
which tribe consumes through its `TRIBE_LLM_DIR` seam.

## Plugins

Install the marketplace, then pick the plugins you want:

```bash
# Add marketplace (one time)
claude plugin marketplace add beorn/bearly

# Install plugins
claude plugin install llm@bearly              # Multi-LLM research
claude plugin install batch-refactor@bearly   # Batch rename/refactor
claude plugin install github@bearly           # GitHub notifications
```

| Plugin                                    | Type        | What                                                                                |
| ----------------------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| [github](plugins/github/)                 | MCP channel | GitHub notifications — build failures, PR activity, push events as channel messages |
| [llm](plugins/llm/)                       | CLI skill   | Multi-LLM research — deep research, second opinions, multi-model debate             |
| [batch-refactor](plugins/batch-refactor/) | CLI skill   | Batch rename, refactor, and migrate across files with confidence-based auto-apply   |

The marketplace is defined by [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json); each
listed plugin carries its own [`.claude-plugin/plugin.json`](plugins/llm/.claude-plugin/plugin.json)
manifest, which is the source of truth for that plugin's version.

### Internal plugins (not in the marketplace)

Some directories under `plugins/` are **internal-only** — libraries or folded-away tools, not
installable Claude Code plugins. They have no `.claude-plugin/plugin.json` and are intentionally
absent from `marketplace.json`:

| Directory     | Status                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `plugins/tty` | Retired — terminal-testing MCP folded into `termless mcp` (`@termless/cli`); no longer ships here |

## CLI Tools

Available via `bun tools/<tool>.ts`:

```bash
bun tools/llm.ts ask "question"           # Ask other LLMs
bun tools/llm.ts ask --deep "topic"       # Deep research with web search
bun tools/refactor.ts --help              # Batch refactoring CLI
```

### Non-plugin tools

| Tool                | What                                           |
| ------------------- | ---------------------------------------------- |
| `tools/worktree.ts` | Git worktree management with submodule support |

## Packages

### The alien-\* family — "signals for a specific shape of data"

Three sibling packages on top of [alien-signals](https://github.com/stackblitz/alien-signals). Each solves one data shape well; they compose for real apps.

| Your data is…                                          | Reach for                                                                   | What it gives you                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **A plain value** (cursor, count, toggle)              | [`alien-signals`](https://github.com/stackblitz/alien-signals) _(upstream)_ | The primitive. `signal(value)`, `computed(fn)`, `effect(fn)`. Everything below builds on this.          |
| **A list that changes over time** (rows, cards, todos) | [`alien-projections`](packages/alien-projections/)                          | `createProjection(list, { key, map, filter, sort })` — when one row changes, only that row re-computes. |
| **An async fetch** (API call, file load, DB query)     | [`alien-resources`](packages/alien-resources/)                              | `createResource(fetcher)` — `.loading()` / `.error()` / `.refetch()` + auto-cancels stale requests.     |
| **A tree / hierarchy** (folders, outlines, nested UI)  | [`alien-trees`](packages/alien-trees/)                                      | `createTree(...)` — "does any descendant have X?" / "inherit Y from any ancestor?" in O(1).             |

A list of async-fetched trees of plain values uses all four together. For React apps, [`@silvery/signals`](https://silvery.dev) bundles the whole family + hooks.

### Other

| Package                                              | What                                                  |
| ---------------------------------------------------- | ----------------------------------------------------- |
| [vitest-silvery-dots](packages/vitest-silvery-dots/) | Streaming dot reporter for Vitest, built with Silvery |

## Development

```bash
bun install
bun run typecheck
```

### As a git submodule

```bash
git submodule add git@github.com:beorn/bearly.git vendor/bearly
```

## License

MIT
