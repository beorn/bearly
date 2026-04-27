# @bearly/bg-recall

Background just-in-time recall — async daemon that watches active Claude Code
sessions, runs entity-driven recall queries based on tool calls, and injects
high-relevance hints via the tribe channel.

Replaces the always-on `UserPromptSubmit` auto-recall (high noise, blocking,
only sees the initial prompt) with a non-blocking, evolving-context-aware
flow that fires hints only when relevance survives a quality gate, a per-source
threshold, and a per-session throttle.

## Why

`UserPromptSubmit` recall blocks the hook for hundreds of ms per turn, only
sees the user's first message, and produces high-noise hits that the model
mostly ignores. By the time the model is doing real work, the recall context is
stale.

`bg-recall` flips it: hooks stay fast, recall runs in the background based on
what the model is _currently_ doing (file paths in `Read`, command tokens in
`Bash`, search patterns in `Grep`). Hints fire only above a relevance
threshold, throttled per-session, with full why-this-hint observability.

## Architecture

```
PostToolUse hook (non-blocking)
  → bg-recall daemon receives tool name + result
    → extracts entities
    → runs recall() per source against the entity set
    → quality-gate every hit (composes with the recall-quality-gate library)
    → relevance scoring (rank + entity-overlap + recency + reinforcement)
    → per-session throttle + dedup
    → if survives all gates: tribeSend(to=session, type="hint", content)
  → Claude sees as <channel source="tribe:bg-recall" type="hint">
  → uses retrieve_memory or ignores
```

## Status & observability — first-class

Every decision is observable from three angles:

1. **JSONL log** — set `BG_RECALL_DEBUG_LOG=/tmp/bg-recall.log`; every tool
   call, query, candidate, throttle decision, hint, and rejection writes one
   JSON line. Format matches `INJECTION_DEBUG_LOG` so both can be tailed
   side-by-side with `jq`.
2. **Status snapshot** — host CLI exposes `bg-recall status`: state,
   per-session counts, top entities, recent hints with adoption status.
3. **Explain trace** — `bg-recall explain <hint-id>` returns the full
   causality chain (top-3 candidates with scores, why this one won).

Adoption is tracked: a hint is "adopted" if the model calls `retrieve_memory`
within N tool calls, otherwise it ages into "ignored".

## Usage (programmatic)

```ts
import { createBgRecallDaemon } from "@bearly/bg-recall"

const daemon = createBgRecallDaemon({
  sources: {
    bearly: async (query) => myRecall(query),
    qmd: async (query) => myQmdSearch(query),
  },
  tribeSend: async (to, content, type, meta) => {
    await tribeClient.call("tribe.send", { to, message: content, type })
  },
  qualityGate: { isAcceptable, analyze: analyzeQuality },
  idleTimeoutMs: 30 * 60 * 1000,
  onIdleQuit: () => process.exit(0),
})

daemon.start()
// Wire whatever event source feeds tool-call events:
daemon.observeToolCall({
  sessionId: "abc-123",
  sessionName: "fixer",
  tool: "Read",
  input: "/Users/me/code/project/foo.ts",
  output: "...",
  ts: Date.now(),
})
```

## Tuning

All defaults are reasonable. Override per-source thresholds, per-session
throttle, or scoring weights via the config object — see
`PipelineConfig`, `ThrottleConfig`, `RelevanceWeights` in the types.

## Tests

```bash
bun vitest run tests/
```

Tests cover relevance scoring, throttle behavior, entity extraction, and an
end-to-end integration test with a stub tribe + recall.
