# llm

Multi-LLM research for Claude Code. Get second opinions, deep research with web search, and multi-model consensus from GPT, Gemini, Grok, and Perplexity.

## Install

```bash
claude plugin install llm@bearly
```

## Commands

```bash
# Quick question (~$0.02)
bun tools/llm.ts "question"

# Pro review — champion + runner-up + rotating challenger, judged (~$0.50–$15)
bun tools/llm.ts pro --context-file ./src/module.ts "Review this"

# Deep research with web search (~$2–5)
bun tools/llm.ts --deep -y "topic"

# Second opinion from another model (~$0.02)
bun tools/llm.ts opinion "Is this approach reasonable?"

# Multi-model debate with synthesis (~$1–3)
bun tools/llm.ts debate -y "Monorepo vs polyrepo?"
```

### Pro admin (champion-challenger leaderboard)

```bash
bun tools/llm.ts pro --leaderboard      # ranked table from ab-pro.jsonl
bun tools/llm.ts pro --promote-review   # interactive promotion flow w/ samples
bun tools/llm.ts pro --backtest         # replay history; OLD vs NEW config
```

Cost dials: `--no-challenger` (skip leg C), `--no-judge` (skip rubric scoring),
`--challenger <id>` (override rotation). Backtest dials: `--sample N`,
`--quick` (cheap judge), `--no-old-fire` (only fire NEW; less honest, half cost).

## --json envelope

Every command supports `--json` for pipe-friendly output. JSON line on stdout,
all progress on stderr:

```bash
bun tools/llm.ts "ping" --json | jq .file
```

## Context

```bash
# From string
bun tools/llm.ts --context "relevant code" "question"

# From file
bun tools/llm.ts --context-file ./src/module.ts "Review this"

# Include session history
bun tools/llm.ts --with-history "topic"
```

## Output

Response always written to a file. JSON metadata on stdout (more fields with
`--json`):

```json
{
  "file": "/tmp/llm-abc12345.txt",
  "model": "GPT-5.4",
  "tokens": { "prompt": 1234, "completion": 567 },
  "cost": 0.02,
  "durationMs": 3200,
  "responseId": "resp_abc",
  "status": "completed"
}
```

`status` ∈ `completed | failed | background | recovered`. Dual-pro emits
per-leg `a`, `b`, and (when `--challenger` enabled) `c` envelopes plus a
`judge` block with rubric scores. Read the output file — streaming tokens go
to stderr only in interactive terminals.

## API Keys

Set the API keys for providers you want to use:

```bash
export OPENAI_API_KEY="sk-..."
export GOOGLE_GENERATIVE_AI_API_KEY="..."
export XAI_API_KEY="..."
export PERPLEXITY_API_KEY="pplx-..."
```

## Environment Variables

- `LLM_DUAL_PRO_B=<modelId>` — swap leg B of dual-pro (default `moonshotai/kimi-k2.6`). Use for head-to-head A/B sprints; e.g. `LLM_DUAL_PRO_B=gpt-5.5-pro` pairs two frontier Pros and logs both to `ab-pro.jsonl`.
- `LLM_RECOVER_MAX_ATTEMPTS=<n>` — deep-research recovery poll ceiling (default 600 = 50 min).

## License

MIT
