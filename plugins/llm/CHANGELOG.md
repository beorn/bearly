# Changelog

## 1.0.0 (2026-04-27)

First public release. Generalization sprint (Phase 5 of the @bearly/llm
refactor) — package is now usable by non-Claude-Code consumers and
publishable to npm under the `@bearly` scope.

### Breaking — for internal consumers

These changes are breaking only for callers that already depended on the
0.x internal layout (km root + bearly monorepo siblings). Standalone
consumers see them as the public 1.0 API.

- **Memory dir resolution rewritten.** `getMemoryDir` now follows a 4-step
  priority chain: `BEARLY_LLM_MEMORY_DIR` → `LLM_DIR` → (when
  `CLAUDE_PROJECT_DIR` set) `~/.claude/projects/<encoded>/memory` →
  `~/.config/llm/`. Existing Claude Code users keep their per-project
  history (step 3); standalone consumers get a single combined
  config+data dir at `~/.config/llm/`. Per user direction, we deliberately
  don't split into XDG_CONFIG_HOME + XDG_DATA_HOME — too much magic.
- **`@bearly/recall` is now an optional peer dependency.** Previously
  imported via the relative path `../../recall/src/history/db`, which
  coupled the package to the bearly monorepo layout. Now resolved at
  runtime via `import("@bearly/recall/history/db")` with a fallback to
  the sibling-source path for in-repo dev. Without recall installed, the
  "📚 Similar past queries" hint is silently skipped — no crash.
- **Output dir is configurable.** Previously hardcoded `/tmp/llm-*.txt`;
  now derived from `BEARLY_LLM_OUTPUT_DIR` (default `os.tmpdir()`).
  Affects `buildOutputPath` and the discover-models patch path.

### Added

- **`bearly-llm install-skills [<target-dir>]`** — copies the bundled
  `skills/{ask,pro,deep,fresh,big}` markdowns into a Claude Code skills
  directory. Default target: `process.env.CLAUDE_SKILLS_DIR` or
  `~/.claude/skills`. Prompts before overwriting unless `--yes` is set.
- **Bundled skill markdowns** under `skills/`. The 5 dispatch-related
  skills (`/ask`, `/pro`, `/deep`, `/fresh`, `/big`) ship inside the npm
  tarball so consumers don't need the km repo to use them.
- **`bin: { "bearly-llm": "./src/cli.ts" }`** — installs as
  `bearly-llm` on PATH (standalone consumers can invoke via `npx
  bearly-llm` or after `npm i -g`).
- **README "Use without Claude Code" section** — quickstart for
  standalone usage covering env vars, install-skills, and CLAUDE_PROJECT_DIR
  back-compat.

### Changed

- `package.json`: `private: true` → published. Version bumped to 1.0.0.
  `files` now ships `src` + `skills` + `README.md` + `CHANGELOG.md`.
  `peerDependencies.@bearly/recall` declared (optional).

## 0.8.0 (2026-04-27)

dispatch.ts shatter (Phase 4 of the @bearly/llm refactor). The 3061-LOC
monolith that mixed TTY raw-mode prompts, HTTP fetch for pricing, JSONL
persistence for the A/B log, signal handlers for SIGINT/SIGTERM, and 11
sub-command runners is now split into per-feature modules. **Move-not-change
refactor — no public CLI surface changes, no behavior changes, all 272
tests pass.**

### Changed — Module structure (km-bearly.llm-dispatch-shatter)

- **`src/cmd/`** — per-feature dispatch entry points:
  - `ask.ts` — `askAndFinish` (single-model dispatch + finalize)
  - `pro.ts` — `runProDual` (4-leg fleet + pairwise judge + ab-pro.jsonl
    append)
  - `deep.ts` — `runDeep` (deep research, fire-and-forget)
  - `debate.ts` — `runDebate` (multi-model consensus)
  - `recover.ts` — `runRecover`, `runAwait`, `pollResponseToCompletion`,
    `classifyRecovery`, `checkAndRecoverPartials` (provider-aware poll +
    classification)
  - `leaderboard.ts` — `runLeaderboard`, `runPromoteReview`, `runBacktest`
  - `judge-history.ts` — `runJudgeHistory` + `parseOutputFileSections`
  - `quota.ts` — `runQuota` (delegates to `lib/quota`)
  - `discover.ts` — `runDiscoverModels` (Stage 2 auto-discovery)
  - `diagnostics.ts` — `runDiagnostics`, `buildDiagnostics`, report types
  - `pricing.ts` — `performPricingUpdate`, `maybeAutoUpdatePricing`,
    `discoverNewModels`
- **`src/ui/confirm.ts`** — `confirmOrExit` and `promptChoice`. Sole owner
  of `process.stdin.setRawMode` in the entire plugin (verifiable via
  `grep -rln "setRawMode" src/`).
- **`src/lib/signals.ts`** — `withSignalAbort`. Sole owner of
  `process.on/once("SIGINT" | "SIGTERM")` for signal coordination.
- **`src/lib/context-files.ts`** — `buildContext` (FTS history + file/text
  context builder). Owns the recall DB read path.
- **`src/lib/dispatch.ts`** — thin re-export router (~60 LOC) that
  preserves `./lib/dispatch` as a back-compat import path for `cli.ts` and
  any external caller.

### Deprecated — `output-mode.ts` singleton (km-bearly.llm-output-mode-singleton)

- **`src/lib/context.ts`** — new canonical surface:
  ```ts
  export interface DispatchContext {
    readonly jsonMode: boolean
    emit(envelope: Record<string, unknown>): void
    content(text: string): void
    stderr(text: string): void
  }
  export function createDispatchContext(opts: { jsonMode: boolean }): DispatchContext
  ```
- **`src/lib/output-mode.ts`** is now a thin **deprecated** shim that
  delegates to a default global `DispatchContext`. The singleton anti-
  pattern (process-level mutable mode) still exists at the shim layer for
  back-compat, but new code should construct an explicit ctx and pass it
  through the dispatch chain. `setJsonMode` / `isJsonMode` / `emitJson` /
  `emitContent` / `resetOutputMode` all still work and are still tested.
- **Migration plan**: future PRs will thread `ctx: DispatchContext` through
  `askAndFinish`, `runProDual`, `runDeep`, etc., and `cli.ts` will
  construct ctx at startup. The shim retires once all dispatch paths take
  ctx explicitly.

### Acceptance gates

- `dispatch.ts` is 60 LOC (target: ≤ 200) — re-export only, no logic.
- TTY raw-mode (`process.stdin.setRawMode`) lives in exactly one file:
  `src/ui/confirm.ts`.
- SIGINT/SIGTERM signal handlers live in exactly one file:
  `src/lib/signals.ts`.
- All 272 tests pass; 0 TypeScript errors.
- Public CLI surface (`bun llm`, all subcommands, all flags) is unchanged.

## 0.7.0 (2026-04-27)

2+2 fleet dispatch (4 legs in parallel) + pairwise judge — endorsed by both
Kimi K2.6 and Gemini 3 Pro in the 2026-04-27 review. Two stable mainstays
anchor judge calibration with low variance; two rotating split-test slots
cover the candidate pool roughly twice as fast as the old single-challenger
rotation. Slot D = correlated re-test of the most-recent winner (confirms
wins reproduce instead of pure pool exploration).

### Changed — Schema (km-bearly.llm-fleet-2x2)

- **`DualProConfigSchema`** now uses `mainstays: [string, string]` +
  `splitTestPool: string[]` + `splitTestSlots: number` (default 2) +
  `splitTestStrategy`. Legacy v0.6 fields (`champion`, `runnerUp`,
  `challengerPool`, `challengerStrategy`) still parse — the loader
  translates them to the new shape via `normalizeConfig`. Saves on disk
  (`renderStarterConfig`) emit the v0.7 shape; reads accept both.
- **Env overrides**: `LLM_DUAL_PRO_B` overrides `mainstays[1]`;
  `LLM_SPLIT_TEST_POOL` is the preferred name for the split-test pool
  (`LLM_CHALLENGER_POOL` still accepted for back-compat).

### Added — 4-leg dispatch + pairwise judging

- **`runProDual`** fires up to 4 legs (mainstays + 2 split-test slots) in a
  single `Promise.all` round trip. Total runtime is dominated by the slowest
  leg, not the sum.
- **Slot D = correlated re-test**: `pickSplitTestSlots(pool, strategy,
counter, history, mainstays, exclude)` returns `[slotC, slotD]`. Slot D
  picks the most-recent winner from `ab-pro.jsonl` history that is in the
  pool, NOT a mainstay, and NOT slot C. Cold start (no winners) falls back
  to "next pool entry after slot C in pool-list order" so the two slots
  cover different members on first run.
- **Pairwise judge**: instead of one 4-way prompt (which suffers from
  position bias and context saturation), three cheap pairwise judge calls
  fire in parallel — `ab` (B vs A), `ac` (C vs A), `ad` (D vs A). Each pair
  sends only TWO responses to the judge. With Gemini 2.5 Flash judge at
  ~$0.001/call, ~$0.003 total — usually cheaper than one bloated 4-way prompt.
- **`buildPairwiseJudgePrompt`** + **`parsePairwiseJudgeResponse`**: pairwise
  prompt builder + tolerant parser (strips ` ```json ` fences, handles
  prepended prose). Output: `{ winner: "A" | "B" | "tie", scoreA, scoreB,
reasoning }`.
- **`synthesizePairwiseFromV2`**: v2 → v3 reader. Historical v2 ab-pro.jsonl
  entries with N-way `judge.{a,b,c,winner}` fields surface a synthesized
  `judge.ab`/`ac` to keep leaderboard / judge-history / backtest consumers
  uniform.

### Added — `--legs N` CLI flag

- `--legs 2` / `--legs 3` / `--legs 4` caps the leg count for THIS call.
  `--no-challenger` is now an alias for `--legs 2`. Defaults to
  `2 + cfg.splitTestSlots` from config.

### Changed — ab-pro.jsonl bumped to v3

- **Schema**: `ab-pro/v3` adds leg `d` (split-test slot 2) and pairwise
  judge results (`judge.ab` / `judge.ac` / `judge.ad`).
- **Back-compat**: v3 entries still emit the v2 fields (`judge.winner`,
  `judge.{a,b,c,d}` synthesized from pairwise scoreA/scoreB) and the v1
  `gpt`/`kimi` keys. Readers can pin any of v1 / v2 / v3.
- **`buildLeaderboard`**: aggregates leg D alongside a/b/c. Skips the v1
  `gpt`/`kimi` keys when v2/v3 leg keys are present (avoids double-counting
  the same model in entries that emit both shapes).

### Tests

- **`tests/four-leg.test.ts`** — 28 new tests covering schema migration
  (v0.6 ↔ v0.7), `pickSplitTestSlots` (correlated re-test, cold-start,
  exclude, lookback window), pairwise prompt + parser, v2→v3 synthesis,
  full 4-leg dispatch with mocked providers (`--legs 2/3/4` honored),
  pairwise judge fires 3 calls, slot D is the recent winner from history.
- **Existing tests updated** to pin `ab-pro/v3` schema in the dispatch
  smoke test and reflect the pairwise judge mock shape.

## 0.6.0 (2026-04-27)

Phase 1 fleet-management additions on top of 0.5.0: static `exclude` config +
visual quality-warning badge, `pro --diagnostics` surface for speed/failure/cost,
filename-encoded cache metadata (`ls cache/` is the dashboard), and skill-doc
sharpening across `/ask /pro /deep /fresh /big` to reflect the new fleet.

### Added — Quality warning + exclude (km-bearly.llm-exclude-quality-warning)

- **`exclude: string[]`** field on `DualProConfigSchema` (default `[]`).
  `pickNextChallenger` filters the challenger pool by `exclude` before
  rotating. Mainstays in the exclude list log a stderr warning but still
  dispatch — explicit config wins over implicit eviction.
- **`scoreWeights.qualityWarningThreshold: number`** (default 5.0).
  Leaderboard prepends `⚠️ ` to model rows where `avgScore < threshold`
  AND `calls ≥ 20`. Visual-only — does not affect dispatch. Add the model
  to `exclude` to actually remove it from rotation.
- **`--exclude <model>` CLI flag** — joins (union) with config exclude for
  the current call. Repeat the flag or comma-separate. `LLM_EXCLUDE`
  env var works the same way.
- New tests: schema parses defaults + override; pickNextChallenger
  respects exclude; mainstay-in-exclude warns + still dispatches; warning
  badge fires for low-score high-call rows but not low-call rows; env
  override merges with config.

### Added — `pro --diagnostics` (km-bearly.llm-diagnostics)

- Three reports per `bun llm pro --diagnostics`:
  - **Speed** sorted by avgTimeMs ascending (calls ≥ 5)
  - **Failure rate** sorted descending; warns when >30% with calls ≥ 20
  - **Cost distribution** with avg + p50 + p95 + p99 per model (calls ≥ 10)
- `--json` emits structured envelope: `{ status, speed, failureRate, costDist }`
- Surfaces what the new quality-first rank no longer uses, so users don't
  lose the signal.
- 6 new tests in `tests/diagnostics.test.ts`.

### Changed — Cache filename-encoded metadata (km-bearly.llm-cache-filename)

- **Filename format**: `<sha64>,<model-slug>,<microUSD>,<ms>,<status>.json`
  (was `<sha256>.json`). Cache directory is now a `ls`-able CSV-like
  dashboard — top-cost / avg-duration / status distribution all derivable
  from filenames, no JSON parse needed.
- Status taxonomy: `ok | err | abrt | trunc` (regex-classified from
  `envelope.error`). microUSD = `round(usage.estimatedCost × 1_000_000)`.
- Helpers exported: `sanitizeModelSlug` (`/` → `_`), `parseFilename`
  (round-trips well-formed; null on stray / `.tmp.` / unknown-status).
- `cacheStats().byModel` returns `{ calls, totalMicroUSD, avgMs, statuses }`
  per model — derived from filenames, no per-entry JSON read.
- Lookup is `readdirSync + startsWith("<hash>,")` (O(N), N typically <1000).
- `writeCache` unlinks stale entries for the same hash so per-entry cost +
  duration stay current on rewrites.
- All 22 prior cache tests adapted; 20 new tests added (42 total).
- `readCache` / `writeCache` signatures unchanged — caller-facing behavior is
  identical.

### Added — `LLM_NO_CACHE=1` bypass

- New env var disables cache reads + writes. Used by tests for clean
  isolation; also a manual escape hatch for `bun llm "..." LLM_NO_CACHE=1`
  to force a fresh dispatch.

### Changed — Skill docs (km-skills.llm-consolidation)

- `/ask` — Single-model quick questions (~$0.02). Distinct from /pro.
- `/pro` — Multi-leg dual-pro (DeepSeek R1 + Kimi K2.6 + rotating
  challenger). Heavier than /ask, lighter than /deep. Reflects the
  no-OpenAI-default fleet shipped in 0.5.0.
- `/deep` — Long-running web-search research via OpenAI's Deep Research API
  (~$2-5, 2-15 min). NOT DeepSeek — "deep" is the OpenAI product name.
- `/fresh` — META-PROTOCOL for being stuck 20+ min on a specific problem.
  Calls /pro or /deep internally. Not itself an LLM tool.
- `/big` — META-PROTOCOL for reframing the problem (10-20 hypotheses, 2
  rounds). Subsumes /fresh. Not itself an LLM tool.
- Helper docs (`pro/discover.md`, `review.md`, `triage.md`, `history.md`)
  cross-referenced from `/pro/SKILL.md`.

### Tests

233/233 passing (was 191; +42 cache + 6 diagnostics + 6 exclude/warning - 1 deduped).

### Files

- New: `plugins/llm/tests/diagnostics.test.ts`
- Modified: `plugins/llm/src/lib/cache.ts` (filename-encoded metadata,
  LLM_NO_CACHE bypass)
- Modified: `plugins/llm/src/lib/dual-pro.ts` (`exclude` field,
  `qualityWarningThreshold`)
- Modified: `plugins/llm/src/lib/dispatch.ts` (`runDiagnostics`,
  exclude-aware `pickNextChallenger`, quality-warning badge)
- Modified: `plugins/llm/src/cli.ts` (`--exclude`, `--diagnostics` flags)
- Modified: `plugins/llm/tests/{cache.test.ts,dual-pro-shadow.test.ts,helpers.ts}`
- Modified (km repo): `.claude/skills/{ask,pro,deep,fresh,big}/SKILL.md`

## 0.5.0 (2026-04-27)

Quality-first leaderboard + log-cost penalty + response cache (CAS) + DeepSeek
in registry + non-OpenAI default fleet. The dispatch optimizes for raw intellect
("punch through intellectual issues") with a soft penalty so extreme priciness
brings score down — speed and failure rate are display-only.

### Changed (BREAKING — config semantics)

- **`scoreWeights.cost` semantics flipped from linear to log-scale.** Old:
  `rank = score * quality - cost * avgCost`. New: `rank = score \* quality
  - cost \* max(0, log10(avgCost / costThreshold))`. Cheap models (≤
`costThreshold`) pay zero penalty; each 10× over the threshold subtracts
`cost`points. Defaults:`cost: 1.0, costThreshold: 0.10`($0.10 → 0pt,
$1 → −1pt, $10 → −2pt, $100 → −3pt). Existing configs with`cost: 0.5`
    still parse but produce mathematically different rankings.
- **`bun llm pro --leaderboard` now sorts by raw quality by default** (was:
  sort by cost-aware rankScore). Add `--rank-by-cost` for the prior
  cost-aware sort. Rationale: quality is the dominant axis for "punch
  through intellectual issues"; cost surfaces as a column, not silent reorder.
- **Display column labels**: `AvgScore` → `Quality`, `AvgTime` → `Speed`.
  Speed and failure rate are display-only — they no longer enter rank.
  Failures are assumed programming errors / retryable, not a model property.

### Added — Response cache (CAS)

- **`src/lib/cache.ts`** — content-addressable storage keyed by sha256 of
  `(model, prompt, context, params)`. File path _is_ the hash:
  `~/.cache/bearly-llm/responses/<sha256>.json`. Lookup is O(1)
  `fs.exists`. Atomic write (temp + rename).
- **Wired into `askAndFinish`** for non-Pro single-model paths (ask,
  opinion, debate). Pro shadow testing, deep research, and image-bearing
  prompts deliberately bypass — caching there would corrupt judge
  calibration or miss content. Cache hit prints `🟢 cache hit (<ts>)`
  to stderr; the original envelope replays verbatim.
- **22 new tests** — sha256 hashing properties, atomic write, graceful
  read-failure on malformed entries, cache stats / clear, CAS round-trip.

### Added — DeepSeek in registry

- **`deepseek/deepseek-r1`** — frontier reasoning via OpenRouter.
  $0.55/M input, $2.19/M output, ~30s typical latency. Champion-mainstay
  role (cheaper than GPT-5.4 Pro, frontier-quality reasoning).
- **`deepseek/deepseek-chat`** — DeepSeek V3 general via OpenRouter.
  $0.27/M input, $1.10/M output, ~5s latency. Pool member.
- Both dispatch via existing OpenRouter provider — no `--force` needed.

### Changed — default fleet (no OpenAI in routine path)

Recommended `dual-pro-config.json`:

- **Champion**: `deepseek/deepseek-r1` (frontier reasoning anchor)
- **Runner-up**: `moonshotai/kimi-k2.6` (proven cheap baseline; 241 calls
  of judge calibration history)
- **Pool**: `gemini-3-pro-preview, deepseek/deepseek-chat, grok-4,
claude-opus-4-6`
- **Judge**: `gemini-2.5-flash` (~$0.001/judge call)

GPT-5.4 Pro deliberately removed from default pool — opt-in via
`--challenger gpt-5.4-pro` or env override. Rationale: $1+/call against
Kimi+Gemini-Pro at ~$0.05 each with comparable quality on limited data
(2026-04-27 verification: judge TIE 20/20).

### Files

- New: `plugins/llm/src/lib/cache.ts` (~140 LOC)
- New: `plugins/llm/tests/cache.test.ts` (22 tests)
- Modified: `plugins/llm/src/lib/dispatch.ts` (cache hook + leaderboard
  default sort + `--rank-by-cost` flag)
- Modified: `plugins/llm/src/lib/dual-pro.ts` (`ScoreWeightsSchema` adds
  `costThreshold`; rank formula log-scale)
- Modified: `plugins/llm/src/lib/types.ts` (DeepSeek SKUs + endpoints)
- Modified: `plugins/llm/src/cli.ts` (`--rank-by-cost` flag wiring)

### Tests

191/191 passing (was 169; +22 cache tests).

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
