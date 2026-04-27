# Changelog

## 0.4.0 (2026-04-27)

Quota tracking + auto-discovery — two features that together make spending
visible AND keep the registry fresh without surprise pollution.

## Quota + balance tracking (km-bearly.llm-quota-tracking)

User's $700/month spend signal made this urgent: today the only feedback
for "am I about to blow the rate limit" is a hard `insufficient_quota`
error AFTER the call fails.

### Added

- **`bun llm quota` subcommand** — one-shot snapshot. Hits each provider's
  quota / balance endpoint where one exists (live OpenRouter
  `/api/v1/auth/key`; OpenAI `/v1/organization/usage/completions` with admin
  keys), falls back to cached `x-ratelimit-*` headers from a recent call for
  Anthropic, prints "no quota API" for Google / xAI / Perplexity. Renders a
  fixed-width table by default; `--json` emits a structured envelope.
- **`--quota` flag** on `ask` / `pro` / `--deep` / `opinion` / `debate` /
  `research` — surfaces the rate-limit headers from THE call you just made
  in the JSON envelope under `quota`. Zero extra HTTP. Headers were already
  on the response.
- **Runtime quota cache** at `~/.cache/bearly-llm/last-quota-by-provider.json`
  (override via `XDG_CACHE_HOME`) — updated unconditionally on every call,
  so `bun llm quota` always has fresh fallback data even when `--quota`
  wasn't passed. Atomic write (temp + rename) so a crash mid-write can't
  corrupt the cache.
- **`ModelResponse.quota`** — new optional field. Captured from
  `result.response.headers` in `queryModel`, parsed via the right provider
  prefix (Anthropic uses `anthropic-ratelimit-*`; everyone else uses
  `x-ratelimit-*`). Best-effort — silent when headers aren't present.

## Auto-discovery + LLM-gated promotion (km-bearly.llm-registry-auto-update)

Models ship constantly (GPT-5.5 announced 2026-04-23, etc.). The registry
was hand-maintained: stale entries lingered, new ones were missed. This
adds a two-stage pipeline that surfaces candidates without auto-polluting.

### Added

- **Stage 1 — discovery side-effect on `bun llm update-pricing`.**
  `performPricingUpdate` now writes `~/.cache/bearly-llm/new-models.json`
  alongside the pricing cache. The artifact lists SKU IDs found in provider
  doc text but absent from the registry, enriched with regex-detected
  capability hints (`webSearch`, `vision`, `deepResearch`, `backgroundApi`)
  and a ~400-char snippet of surrounding doc context. No extra cost — the
  pricing scraper already pulled the HTML.
- **Stage 2 — `bun llm pro --discover-models [--apply]`.** Reads the
  artifact, runs `gpt-5-nano` (or whichever quick-tier model is available)
  as a classifier per candidate, and prints a markdown decision table with
  `yes` / `no` / `needs-review` decisions plus reasons. With `--apply`,
  writes `/tmp/llm-new-models.patch` — a unified diff adding the
  `yes`-decisions to `SKUS_DATA` and `ENDPOINTS_DATA` in `types.ts`. The
  diff is NOT auto-applied; the user reviews and runs `git apply` themselves.
- **`needs-review` items surface separately** under a `## Pending review`
  heading so the human can act on them without them entering the diff.

### Why LLM-gated, not auto-add

Provider docs lie. Some IDs are dated snapshots (`gpt-5-pro-2025-10-06`)
that should map to existing aliases via `apiModelId`, not become new SKUs.
Some are deprecated. Some are private beta. Auto-adding would pollute the
registry. The cheap classifier filters obvious noise; human reviews the
diff before it lands.

### Cost

Discovery: $0 (runs in pricing-update). Classifier: ~$0.0005 × N candidates.
For ~30 candidates, ~$0.02 per scan. Wired into `/sop packages` for weekly
runs.

### Files

- New: `plugins/llm/src/lib/quota.ts` (~470 LOC) — provider fetchers, header
  parsers, atomic cache I/O, table renderer.
- New: `plugins/llm/src/lib/discover.ts` (~400 LOC) — capability extraction,
  SKU discovery, classifier prompt/parser, unified-diff generator.
- New tests: `quota.test.ts` (26) + `discover.test.ts` (39).

## 0.3.0 (2026-04-27)

Cost-aware promotion default + defensive tests for /pro review findings.

### Changed

- **`scoreWeights.cost` default flipped to `0.5`** (was `0.0`). Without a cost
  weight, the leaderboard ranks purely by quality and would happily promote
  a $15-per-call model over a $0.50 model that scores marginally lower —
  directly responsible for cost surprises. Set `cost: 0.0` explicitly in
  your `dual-pro-config.json` to opt back in to quality-only ranking.

### Notes (false positives from /pro review surfaced and re-verified)

- **JSONC parser does NOT mangle URLs/paths inside string values.** The
  `^\s*` line-anchor in the strip regex only matches `//` at start-of-line +
  optional whitespace; `https://`, `moonshotai/kimi-k2.6`, `openai/gpt-5`
  inside string values are safe. Defensive test added to prove it.
- **Backtest does NOT call `pickNextChallenger`**; it deliberately fixes
  one challenger across the sample (`cfg.challengerPool[0]` or `--challenger`
  override) so OLD-vs-NEW comparison is fair. Comment added to clarify intent.
- **Judge skips failed legs.** Both live (`runProDual`) and backtest
  (`judgeFor`) paths filter the judge prompt to legs with content; failed
  legs aren't sent to the judge.

See `bd show km-bearly.llm-pro-review-fixes` for the full re-verification
log + remaining real findings (path leakage, O(N) leaderboard at scale,
half-finished registry split).

## 0.2.0 (2026-04-27)

Major iteration: capability-based dispatch, structured CLI output, and
champion-challenger shadow testing. No breaking changes to the public CLI
surface; existing invocations still work.

### Added — registry split (km-bearly.llm-registry-split)

- `SkuConfig` (frozen, user-facing identity: pricing, latency, reasoning) and
  `ProviderEndpoint` (frozen, dispatch contract: `apiModelId`, `capabilities`)
  separate two concerns the old `Model` god-type conflated.
- Capabilities flag — `webSearch`, `backgroundApi`, `vision`, `deepResearch` —
  drive routing instead of `provider === "openai"` magic strings. Adding a
  new provider with the same capabilities is a one-entry change.
- `getSku(id)` and `getEndpoint(id)` are the new lookup entry points;
  `getLanguageModel` resolves through `endpoint.apiModelId ?? sku.modelId`.
- `MODELS` array is now `readonly` and frozen. Pricing updates write a
  JSON cache (`~/.cache/bearly-llm/pricing.json`) loaded at process start;
  `performPricingUpdate` no longer mutates the registry in place.
- Synthetic OpenRouter SKUs (slash-IDs not in the registry) require `--force`
  and mint with `costTier: "very-high"` + `[unverified]` displayName tag.
  Silent minting was unsafe — it defeated `requiresConfirmation` and gave
  bogus $0 cost estimates.
- Legacy `Model` shape preserved as a flattened SKU+endpoint facade with
  getter-backed pricing properties (no rebuild on cache refresh).

### Added — `--json` flag (km-bearly.llm-cli-json-output)

- Every command (`ask`, `pro`, `--deep`, `opinion`, `debate`, `research`,
  `recover`, `await`) supports `--json`. JSON envelope on stdout; all
  human-readable progress on stderr. Pipe-friendly for skill consumption.
- Envelope: `{ file, model, tokens: { prompt, completion, total }, cost,
  durationMs, responseId?, status }`. Status ∈ `completed | failed |
  background | recovered`.
- Dual-pro emits per-leg `a` and `b` envelopes plus aggregate metadata.
- Centralized via `output-mode.ts` singleton (`setJsonMode`/`isJsonMode`/
  `emitJson`/`emitContent`); test-isolatable via `resetOutputMode()`.

### Added — dual-pro shadow testing (km-bearly.llm-dual-pro-shadow-test)

- 3-leg champion-challenger pattern. Leg A = champion, Leg B = runner-up
  (both stable across calls), Leg C = rotating challenger from a candidate
  pool. After all three respond, a cheap judge model rates each on a 4-D
  rubric (specificity / actionability / correctness / depth, 1-5 each).
- Config at `~/.claude/projects/<proj>/memory/dual-pro-config.json` (JSONC
  with comment header). Env overrides: `LLM_CHALLENGER_POOL`,
  `LLM_DUAL_PRO_B`, `LLM_JUDGE_MODEL`.
- New CLI subcommands:
  - `bun llm pro --leaderboard` — table sorted by config-weighted score
  - `bun llm pro --promote-review` — interactive promotion flow with sample
    queries and three-gate threshold (≥10 calls, score margin ≥0.3, failure
    rate ≤ champion's)
  - `bun llm pro --backtest [--sample N] [--quick] [--no-old-fire]
    [--no-challenger]` — replay historical queries through OLD + NEW configs
    in parallel for apples-to-apples promotion gate
- Cost sliders: `--no-challenger` (skip leg C), `--no-judge` (skip judge),
  `--challenger <id>` (override rotation).
- `ab-pro.jsonl` schema bumped to v2 (`a`/`b`/`c` legs + `judge` envelope;
  v1 `gpt`/`kimi` keys preserved for back-compat).
- New persistence files: `dual-pro-promotions.jsonl`, `backtest-runs.jsonl`.

### Notes

- Auto-switching is never allowed — the framework surfaces evidence; the
  human decides via `--promote-review`.
- Capability-based candidate filtering uses `endpoint.capabilities[cap]`
  directly; legacy heuristics (`provider === "openai"`) removed from the
  routing path. Two remaining `provider === "openai"` references in
  `research.ts` are an OpenAI API-parameter scope (`reasoning_effort`) and
  a comment, not routing.

### Verification

- 103 LLM tests pass (101 prior + 48 new dual-pro / backtest tests).
- 0 new TypeScript errors. Two pre-existing baseline errors in
  `injection-envelope` and `silvery/ansi` are unrelated.
- Real Kimi via OpenRouter call confirmed `--json` envelope shape end-to-end.

### Still `private: true`

Published when the tribe family stabilizes and the dispatcher is ready
for public use.

## 0.1.0 (2026-04-17)

Initial extraction into a first-class package. The LLM dispatcher was
previously at `vendor/bearly/tools/lib/llm/` with a CLI at
`vendor/bearly/tools/llm.ts`. Promoted to `@bearly/llm` at
`plugins/llm/` so `@bearly/recall` and `@bearly/lore` can depend on it
cleanly and so the library is reusable standalone.

### Contents

- `src/lib/` — multi-provider dispatch: types (Model registry), providers
  (availability detection), research (queryModel), consensus (multi-model
  agreement), dispatch (cheap-model race), format, persistence, pricing,
  mock (vi.mock harness for tests), ollama, openai-deep, gemini-deep, index
- `src/cli.ts` — the `bun llm` CLI (multi-LLM research + deep research)
- `src/index.ts` — barrel export

### Verification

- 0 new TypeScript errors
- Consumers under `plugins/{lore,recall}/src/*` use `../../../llm/src/lib/`
  (relative workspace path)
- `bun vendor/bearly/tools/llm.ts` shim still works via `main` export

### Notes

- `private: true` at this version — published when the tribe family
  stabilizes and the llm dispatcher is ready for public use.
- Exports `buildMockQueryModel`, `alwaysAvailable`, and related test
  helpers used by `@bearly/recall` and `@bearly/lore` test suites.
