# Changelog

## 0.1.0 (2026-04-17)

Initial extraction into a first-class package. The recall library was
previously spread across `vendor/bearly/tools/recall/` and
`vendor/bearly/tools/lib/history/`. Promoted to `@bearly/recall` at
`plugins/recall/` so `@bearly/lore` (the memory daemon) can depend on
it cleanly — matching the runtime relationship (lore builds on recall).

### Contents

- `src/lib/` — recall-specific: agent (LLM-driven multi-round search),
  plan (query planner), fanout (parallel FTS), context (project
  vocabulary for the planner), session-context (current-session brief),
  trace (agent-mode observability), hooks (UserPromptSubmit /
  SessionStart / SessionEnd), status (dashboard), sessions, files,
  summarize-beads / summarize-daily / summarize-session / summarize,
  search (CLI wrapper), format (render helpers), extract
- `src/history/` — core FTS library: search (BM25 + coverage rerank),
  synthesize (LLM race-of-N + remember), scanner (JSONL parse + hookRecall),
  db / db-schema / db-queries, formatters, indexer, project-sources,
  recall-shared, types
- `src/cli.ts` — the `bun recall` CLI (93 test files in `tests/history/`)
- `src/index.ts` — barrel export for consumers

### Verification

- 93/93 recall tests pass (was at `tests/history/*` before the move)
- 0 new TypeScript errors
- `bun vendor/bearly/tools/recall.ts` shim still works via `main` export

### Notes

- `private: true` at this version — published when the tribe family
  (tribe + lore + recall) is stable for ≥2 weeks.
- Consumed by `@bearly/lore` via workspace resolution (Bun `workspaces`).
- A thin 3-line shim at `vendor/bearly/tools/recall.ts` preserves the
  `~/.claude/settings.json` hook path (`bun vendor/bearly/tools/recall.ts session-start`).
