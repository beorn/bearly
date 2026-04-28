# @bearly/llm

Multi-LLM research and dispatch. Get second opinions, deep research with web search, multi-model consensus, and a champion-challenger framework that pits frontier models against each other and tracks results in a leaderboard. Works with OpenAI, Anthropic, Google, xAI, OpenRouter (Kimi, DeepSeek, …), Perplexity, and local Ollama models.

Originally built for Claude Code, now usable as a standalone CLI and library.

## Install

```bash
# Standalone (npm)
npm install @bearly/llm

# As a Claude Code plugin
claude plugin install llm@bearly
```

## Use without Claude Code

`@bearly/llm` works standalone — no Claude Code required.

```bash
npm install @bearly/llm
export OPENAI_API_KEY=sk-...
export OPENROUTER_API_KEY=sk-or-...

npx bearly-llm "what's the capital of France"
npx bearly-llm pro "review this code"        # multi-leg + pairwise judge
npx bearly-llm --deep "TUI testing best practices 2026"
```

State (config + history) lives in `~/.config/llm/` by default. Override
the location with `LLM_DIR=/path/to/dir` (or `BEARLY_LLM_MEMORY_DIR`).

Output files (the per-call response transcript) land in `os.tmpdir()` by
default. Override with `BEARLY_LLM_OUTPUT_DIR=/path/to/dir`.

To install the skill markdowns into Claude Code's skill dir so the
`/ask`, `/pro`, `/deep`, `/fresh`, `/big` slash commands work:

```bash
npx bearly-llm install-skills              # → ~/.claude/skills/
npx bearly-llm install-skills --yes        # overwrite without prompting
npx bearly-llm install-skills /custom/dir  # custom target
```

For the per-project Claude Code experience (where `ab-pro.jsonl` is
scoped per project), set `CLAUDE_PROJECT_DIR=$PWD` and `@bearly/llm`
follows the existing `~/.claude/projects/<encoded-cwd>/memory/`
convention. This is the default Claude Code wires up.

The `📚 Similar past queries` hint surfaces only when `@bearly/recall` is
installed (`npm install @bearly/recall`). Without it, the hint is
silently skipped — `@bearly/llm` runs standalone without crashing.

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

### Auto-discovery: keep the model registry fresh

New models ship constantly. The registry in `src/lib/types.ts` is hand-curated
on purpose — pricing is frozen, capabilities encode dispatch behaviour, and a
wrong entry can silently route Pro calls to a non-existent model. The
auto-discovery flow keeps the curation cheap:

```bash
# Stage 1 — discovery (free, runs as a side-effect of pricing-update)
bun tools/llm.ts update-pricing
# → writes ~/.cache/bearly-llm/new-models.json with candidates +
#   capability hints scraped from provider docs

# Stage 2 — LLM-gated promotion (~$0.02 per scan)
bun tools/llm.ts pro --discover-models
# → prints a markdown decision table (yes / no / needs-review per candidate)

bun tools/llm.ts pro --discover-models --apply
# → writes /tmp/llm-new-models.patch (unified diff for the `yes` decisions)

git apply /tmp/llm-new-models.patch   # human reviews and applies
```

The classifier (`gpt-5-nano`) filters obvious noise — dated snapshots that
should map via `apiModelId`, deprecated/private-beta entries, garbage pricing.
`needs-review` items appear under a `## Pending review` heading so the human
can act on them without them entering the diff. Run weekly via `/sop infra`
or cron.

## --json envelope

Every command supports `--json` for pipe-friendly output. JSON line on stdout,
all progress on stderr:

```bash
bun tools/llm.ts "ping" --json | jq .file
```

## Quota tracking

Surface remaining credit + rate limits per provider so spending decisions
are visible. Two layers, both opt-in.

### `bun tools/llm.ts quota` — one-shot snapshot

```
Provider         Balance / Used      Rate Limit         Last Used
---------------------------------------------------------------
OpenAI           $300 / $700/mo     50K TPM, 500 RPM   2026-04-27 07:43
OpenRouter       $48 credit          100 RPM            (live)
Anthropic        (header-only)       100K TPM           2026-04-27 02:30
Google Gemini    (no quota API)      —                  —
xAI (Grok)       (no quota API)      —                  —
```

- **OpenRouter** — live `GET /api/v1/auth/key` (no admin key needed)
- **OpenAI** — tries `/v1/organization/usage/completions` (admin key required); falls back to cached rate-limit headers
- **Anthropic** — header-only (no balance endpoint); shows the most recent `anthropic-ratelimit-*` headers from cache
- **Google / xAI / Perplexity** — no quota API; row says so
- **Ollama** — skipped (local)

`--json` emits a structured envelope:

```bash
bun tools/llm.ts quota --json | jq .snapshots
```

### `--quota` flag on existing commands

Captures rate-limit headers from THE call you just made and drops them into
the JSON envelope. Zero extra HTTP — the headers were already on the
response. The runtime cache (`~/.cache/bearly-llm/last-quota-by-provider.json`)
is updated unconditionally so `bun llm quota` always has fresh fallback data
even when `--quota` wasn't set.

```bash
bun tools/llm.ts "ping" --model gpt-5-nano --json --quota | jq .quota
# {
#   "remainingRequests": 487,
#   "remainingTokens": 145000,
#   "resetRequestsAt": "2026-04-27T08:00:00Z",
#   "resetTokensAt": "2026-04-27T07:45:00Z"
# }
```

**Why opt-in**: rate-limit headers bloat default JSON output for callers
that don't care. `--quota` keeps the canonical envelope tidy; the cache
update is unconditional for the on-demand `bun llm quota` view.

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
  "file": "llm-abc12345.txt",
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

### `file` field — relativized by default

The `file` field is relativized to avoid leaking absolute `/tmp` paths
(which carry username, hostname, and project hashes embedded in temp dir
names) into CI logs and log aggregators (Splunk, Datadog, etc.).

- **Default**: basename only (or cwd-relative path when the file lives
  under cwd). E.g. `/tmp/llm-abc.txt` → `llm-abc.txt`,
  `<cwd>/out/llm-x.txt` → `out/llm-x.txt`.
- **`--full-paths`**: restores the absolute path verbatim. Use this when a
  consumer needs to `cat` the file from a different cwd, or for debugging.

```bash
bun tools/llm.ts "ping" --json | jq .file              # "llm-abc.txt"
bun tools/llm.ts "ping" --json --full-paths | jq .file # "/tmp/llm-abc.txt"
```

The actual file location is unchanged — only the envelope's surface
representation. The output dir is still `os.tmpdir()` by default
(`BEARLY_LLM_OUTPUT_DIR` overrides). To resolve the basename back to a
full path: `path.join(os.tmpdir(), envelope.file)`.

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
