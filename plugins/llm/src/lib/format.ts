import { describeDispatchFailure } from "./dispatch-error"
import { deniedProviders } from "./denied-providers"
/**
 * Output formatting — file writing, result JSON, research archival, streaming.
 *
 * Handles writing LLM responses to files, building JSON metadata for stdout,
 * archiving to research directories, and streaming tokens to stderr.
 */

import { createLogger } from "loggily"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import * as os from "os"
import { formatCost, type ServedBy, type ModelResponse } from "./types"
import { resolveResponseCost } from "./pricing.ts"
import { aggregateCosts, serializeCost, deserializeCost, type CostFields, type ResolvedCost } from "./cost"
import { emitJson, formatEnvelopeFile, isFullPaths, isJsonMode } from "./output-mode"

const log = createLogger("bearly:llm")

/** Human display retains the independent amounts and the selected rate basis. */
export function formatCostColumns(value: ResolvedCost | CostFields): string {
  const cost = "charged" in value ? value : deserializeCost(value)
  const amount = (value: ResolvedCost["charged"]) =>
    "usd" in value ? formatCost(value.usd) : `unknown (${value.reason})`
  const basis =
    cost.listEquivalentBasis
      .map(
        (row) => `${row.rateSource}; date ${row.rateDate ?? "unrecorded"}; model ${row.matchedModelId ?? "unrecorded"}`,
      )
      .join(" | ") || "unrecorded"
  return `charged ${amount(cost.charged)}; list-equivalent ${amount(cost.listEquivalent)} [${basis}]`
}

/**
 * Per-leg metadata for dual-pro envelopes. Each leg ships independently
 * because the two models can disagree on tokens/cost/duration; flattening
 * loses the A/B signal we publish for skill consumers (e.g. ranking).
 */
export interface LegMeta extends Partial<CostFields> {
  model?: string
  tokens?: { prompt: number; completion: number; total: number }
  durationMs?: number
  status?: "completed" | "incomplete" | "failed"
  error?: string
  finishReason?: string
  rawFinishReason?: string
  appliedMaxOutputTokens?: number
  /** Which mechanism answered this leg (subscription CLI routes, bead 29147). */
  servedBy?: ServedBy
}

/** The requested panel and its measured completion, including preflight loss. */
export interface ProCompletion {
  requested: ReadonlyArray<{ slot: "a" | "b" | "c" | "d"; role: "mainstay" | "split-test"; model: string }>
  returned: ReadonlyArray<"a" | "b" | "c" | "d">
  missing: ReadonlyArray<{
    slot: "a" | "b" | "c" | "d"
    model: string
    cause: "dropped-before-dispatch" | "unavailable" | "timed-out" | "errored" | "output-token-limit"
    detail: string
  }>
  judges: {
    waived: boolean
    required: readonly string[]
    returned: readonly string[]
    failed: ReadonlyArray<{ pair: string; cause: string }>
  }
}

export interface OutputMeta extends Partial<CostFields> {
  query?: string
  model?: string
  /**
   * Total tokens (legacy single-number field) OR structured prompt/completion
   * pair (preferred for the JSON envelope schema). Both forms are accepted;
   * the envelope serializer normalizes.
   */
  tokens?: number | { prompt: number; completion: number; total?: number }
  /** Which mechanism actually answered (subscription CLI routes, bead 29147).
   *  Carried into the envelope so a CLI substitution is never silent. */
  servedBy?: ServedBy
  durationMs?: number
  responseId?: string
  finishReason?: string
  rawFinishReason?: string
  appliedMaxOutputTokens?: number
  error?: string
  status?: "completed" | "incomplete" | "failed" | "background" | "recovered"
  completion?: ProCompletion
  /** Dual-pro: per-leg sections. A/B are mainstays (always present in
   * dual-pro mode); C/D are optional split-test slots. */
  a?: LegMeta
  b?: LegMeta
  c?: LegMeta
  d?: LegMeta
  /** Dual-pro: number of legs that fired (2 = mainstays only, 3 = +slot C,
   * 4 = full 2+2 fleet). */
  legs?: number
  /** Dual-pro: judge envelope (km-bearly.llm-dual-pro-shadow-test). */
  judge?: Record<string, unknown>
  /** Dual-pro: top-N leaderboard snapshot at write time. */
  leaderboardSnapshot?: ReadonlyArray<Record<string, unknown>>
  /** Per-call rate-limit headers from THIS request (km-bearly.llm-quota-tracking).
   *  Surface gated by the `--quota` flag in the CLI — when unset, this is
   *  excluded from the JSON envelope to avoid bloating default output. The
   *  runtime quota cache is updated regardless of this flag. */
  quota?: {
    remainingRequests?: number
    requestsPerWindow?: number
    remainingTokens?: number
    tokensPerWindow?: number
    resetRequestsAt?: string
    resetTokensAt?: string
  }
}

/** Format a timestamp as relative time (e.g., "5m ago", "2h ago") */
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`
  return `${Math.round(diff / 86400000)}d ago`
}

/** Derive a short slug from the topic for the output filename. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("-")
    .slice(0, 40)
}

/**
 * Output dir for llm-*.txt files. Override via BEARLY_LLM_OUTPUT_DIR;
 * defaults to the OS tmpdir. Cleanup logic in cli.ts honours the same env.
 */
export function getOutputDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BEARLY_LLM_OUTPUT_DIR) return env.BEARLY_LLM_OUTPUT_DIR
  // Lazy-load os to keep this module Node-version friendly (and to avoid
  // top-of-file import noise for what is effectively a tiny helper).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os") as typeof import("os")
  return os.tmpdir()
}

/**
 * Build the canonical llm-*.txt output path used for both initial launches
 * and recover/await flows. Format: <outputDir>/llm-<session>-<slug-or-rand>-<hash>.txt
 *
 * If `topic` is empty/undefined, falls back to a millisecond timestamp slug so
 * the path is still unique. The 4-char random suffix prevents collisions when
 * two runs hit the same slug within the same millisecond.
 *
 * Output dir comes from `getOutputDir()` (BEARLY_LLM_OUTPUT_DIR or os.tmpdir).
 */
export function buildOutputPath(sessionTag: string, topic?: string): string {
  const hash = Math.random().toString(36).slice(2, 6)
  const slug = topic ? slugify(topic) : ""
  // Treat slugs with no alphanumerics (e.g. "---") as empty — they'd produce
  // visually broken filenames like llm-manual-----abcd.txt.
  const middle = /[a-z0-9]/.test(slug) ? slug : String(Date.now())
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path") as typeof import("path")
  return path.join(getOutputDir(), `llm-${sessionTag}-${middle}-${hash}.txt`)
}

/**
 * Build the canonical JSON result envelope.
 *
 * Schema (km-bearly.llm-cli-json-output):
 *
 *   {
 *     "file": "/tmp/llm-...txt",
 *     "model": "GPT-5.4 Pro",
 *     "tokens": { "prompt": 1234, "completion": 567, "total": 1801 },
 *     "cost_usd": 0.045,                     // stated charge or cost_usd_reason
 *     "list_equivalent_usd": 0.05,           // estimate or list_equivalent_reason
 *     "list_equivalent_basis": [],
 *     "durationMs": 12345,
 *     "responseId": "resp_abc123",
 *     "status": "completed" | "incomplete" | "failed" | "background" | "recovered",
 *     "chars": 4321,                         // response body length
 *     "query": "...",                        // optional
 *     "a": { ...leg meta },                  // optional, dual-pro
 *     "b": { ...leg meta }
 *   }
 *
 * Token totals retain their existing single-number input. Cost columns always
 * carry their independent value/reason and estimate basis, without legacy aliases.
 */
function costMeta(meta?: Partial<CostFields>): CostFields {
  return serializeCost(deserializeCost(meta))
}

export function buildResultJson(content: string, meta?: OutputMeta): Record<string, unknown> {
  const result: Record<string, unknown> = { ...costMeta(meta) }
  if (meta?.finishReason !== undefined) result.finishReason = meta.finishReason
  if (meta?.rawFinishReason !== undefined) result.rawFinishReason = meta.rawFinishReason
  if (meta?.appliedMaxOutputTokens !== undefined) result.appliedMaxOutputTokens = meta.appliedMaxOutputTokens
  if (meta?.error !== undefined) result.error = meta.error
  if (meta?.query) result.query = meta.query
  result.chars = content.length
  if (meta?.model) result.model = meta.model

  if (meta?.tokens != null) {
    if (typeof meta.tokens === "number") {
      // Legacy single-number form — promote to total. We don't have
      // prompt/completion split, so emit just total to preserve information
      // without lying about the breakdown.
      result.tokens = { total: meta.tokens }
    } else {
      const { prompt, completion } = meta.tokens
      const total = meta.tokens.total ?? prompt + completion
      result.tokens = { prompt, completion, total }
    }
  }

  if (meta?.durationMs) result.durationMs = meta.durationMs
  if (meta?.responseId) result.responseId = meta.responseId
  if (meta?.status) result.status = meta.status
  if (meta?.servedBy) result.servedBy = meta.servedBy
  if (meta?.completion) result.completion = meta.completion
  if (meta?.a) result.a = legToEnvelope(meta.a)
  if (meta?.b) result.b = legToEnvelope(meta.b)
  if (meta?.c) result.c = legToEnvelope(meta.c)
  if (meta?.d) result.d = legToEnvelope(meta.d)
  if (meta?.judge) result.judge = meta.judge
  if (meta?.leaderboardSnapshot) result.leaderboardSnapshot = meta.leaderboardSnapshot
  if (meta?.quota) result.quota = meta.quota
  return result
}

function legToEnvelope(leg: LegMeta): Record<string, unknown> {
  const out: Record<string, unknown> = { ...costMeta(leg) }
  if (leg.model) out.model = leg.model
  if (leg.tokens) {
    out.tokens = {
      prompt: leg.tokens.prompt,
      completion: leg.tokens.completion,
      total: leg.tokens.total ?? leg.tokens.prompt + leg.tokens.completion,
    }
  }
  if (leg.durationMs != null) out.durationMs = leg.durationMs
  if (leg.status) out.status = leg.status
  if (leg.finishReason !== undefined) out.finishReason = leg.finishReason
  if (leg.rawFinishReason !== undefined) out.rawFinishReason = leg.rawFinishReason
  if (leg.appliedMaxOutputTokens !== undefined) out.appliedMaxOutputTokens = leg.appliedMaxOutputTokens
  if (leg.servedBy) out.servedBy = leg.servedBy
  if (leg.error) out.error = leg.error
  return out
}

/**
 * Archive LLM output to research dir for recall indexing.
 * Best-effort — failures are silently ignored.
 */
export function persistToResearch(content: string, sessionTag: string, meta?: OutputMeta): void {
  if (!meta?.query) return
  try {
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd()
    const encodedPath = projectRoot.replace(/\//g, "-")
    // HOME first, so test isolation holds; os.homedir() is fixed at process
    // start under Bun and ignores a redirected HOME, leaking writes into the
    // real profile (same guard as pro.ts / judge-history.ts / dual-pro.ts).
    const home = process.env.HOME || os.homedir()
    const researchDir = `${home}/.claude/projects/${encodedPath}/memory/research`

    // Ensure directory exists
    if (!existsSync(researchDir)) {
      mkdirSync(researchDir, { recursive: true })
    }

    // Generate filename: YYYYMMDD-HHmmssSSS-<slug>-<rand>.md
    // Millisecond precision + 4-char random suffix prevents collisions when
    // parallel Claude Code sessions fire similar queries in the same second —
    // not hypothetical with the 6+ concurrent sessions this workspace runs.
    const now = new Date()
    const isoCompact = now.toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 18)
    const rand = Math.random().toString(36).slice(2, 6)
    const slug = meta.query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50)
    const filename = `${isoCompact}-${slug}-${rand}.md`

    // Tokens may be a legacy number or the structured {prompt, completion}
    // shape. Frontmatter is plain YAML — collapse to a total scalar so old
    // recall-indexer queries (which read `tokens: 1234`) continue to work.
    const tokensTotal =
      typeof meta.tokens === "number"
        ? meta.tokens
        : meta.tokens
          ? (meta.tokens.total ?? meta.tokens.prompt + meta.tokens.completion)
          : undefined

    // Build YAML frontmatter
    const frontmatter = [
      "---",
      `query: ${JSON.stringify(meta.query)}`,
      meta.model ? `model: ${JSON.stringify(meta.model)}` : null,
      ...Object.entries(costMeta(meta)).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
      tokensTotal != null ? `tokens: ${tokensTotal}` : null,
      meta.durationMs ? `duration_ms: ${meta.durationMs}` : null,
      `timestamp: ${JSON.stringify(now.toISOString())}`,
      sessionTag !== "manual" ? `session_id: ${JSON.stringify(sessionTag)}` : null,
      "---",
    ]
      .filter(Boolean)
      .join("\n")

    const archiveContent = `${frontmatter}\n\n${content}`
    writeFileSync(`${researchDir}/${filename}`, archiveContent)
  } catch {
    // Best-effort — don't fail the main output
  }
}

/** Build HTML comment with metadata for the output file header */
export function buildMetaComment(sessionTag: string, meta?: OutputMeta): string {
  const obj: Record<string, unknown> = {}
  if (meta?.model) obj.model = meta.model
  if (sessionTag !== "manual") obj.session = sessionTag
  obj.timestamp = new Date().toISOString()
  if (meta?.query) obj.query = meta.query
  Object.assign(obj, costMeta(meta))
  if (meta?.tokens != null) {
    // Both legacy number form and structured {prompt, completion} form
    // appear in the meta-comment unchanged — JSON.stringify handles both.
    obj.tokens = meta.tokens
  }
  if (meta?.durationMs) obj.durationMs = meta.durationMs
  if (meta?.status === "incomplete") {
    obj.status = meta.status
    if (meta.finishReason !== undefined) obj.finishReason = meta.finishReason
    if (meta.rawFinishReason !== undefined) obj.rawFinishReason = meta.rawFinishReason
    if (meta.appliedMaxOutputTokens !== undefined) obj.appliedMaxOutputTokens = meta.appliedMaxOutputTokens
    if (meta.error !== undefined) obj.error = meta.error
  }
  return `<!-- llm-meta: ${JSON.stringify(obj)} -->`
}

/**
 * After response completes: write to file, print file path on stderr, JSON metadata on stdout.
 *
 * Output routing:
 *   - File path line → stderr (human-readable; suppressed in JSON mode
 *     to keep stderr quieter for piped consumers, though most callers
 *     filter stderr regardless).
 *   - JSON envelope → stdout (machine-parseable single line; canonical
 *     in both JSON and legacy modes).
 *
 * DO NOT stream response content to stdout — only the JSON metadata line goes there.
 */
export async function finalizeOutput(
  content: string,
  outputFile: string,
  sessionTag: string,
  meta?: OutputMeta,
): Promise<void> {
  const metaComment = buildMetaComment(sessionTag, meta)
  try {
    await Bun.write(outputFile, `${metaComment}\n\n${content}`)
  } catch (err) {
    log.error?.(`Failed to write output file ${outputFile}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  persistToResearch(content, sessionTag, meta)
  // Path line: keep on stderr in legacy mode (long-standing UX). In JSON
  // mode, suppress — the consumer reads `envelope.file` instead, and the
  // path line on stderr is just visual noise for non-TTY pipes.
  if (!isJsonMode()) {
    process.stderr.write("\n")
    process.stderr.write(`Output written to: ${outputFile}\n`)
  }
  const envelope = buildResultJson(content, meta)
  // km-bearly.llm-path-leakage: relativize by default to avoid leaking
  // /tmp absolute paths (username/hostname/project hashes) into CI logs.
  // `--full-paths` opts back into the verbatim absolute path.
  envelope.file = formatEnvelopeFile(outputFile, { fullPaths: isFullPaths(), cwd: process.cwd() })
  // Default status when caller didn't set one — successful completion.
  if (!envelope.status) envelope.status = "completed"
  emitJson(envelope)
}

/** Quote one argument for a POSIX shell, including embedded apostrophes. */
export function quotePosixArgument(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

/** Render one targeted retry using the CLI's parsed invocation, when affordable. */
export function formatBudgetRetry(
  error: string | undefined,
  model: { modelId?: string; provider?: import("./types").Provider },
  retryCommand?: (model: string, bound: number) => string,
): string | undefined {
  if (!error || !model.provider || !model.modelId || !retryCommand) return error
  const failure = describeDispatchFailure(error, { provider: model.provider, modelId: model.modelId })
  if (failure.kind !== "output-budget" || failure.retryOutputTokens === undefined) {
    return error
  }
  return `${failure.message} Run: ${retryCommand(model.modelId, failure.retryOutputTokens)}`
}

/**
 * 28886: a provider the host has excluded is not a secret. `RECALL_LLM_DENY_PROVIDERS` names the
 * providers marked broken on this machine, which is how a call can fail while its key looks fine —
 * without this the reader has to guess between the credential, the balance and a policy. Appended
 * at the CLI's human surface only: the classifier's own description, and the observation persisted
 * from it, keep the provider's real failure so model selection still sees the true cause.
 */
function withExclusionNote(message: string | undefined, provider?: import("./types").Provider): string | undefined {
  if (!message || !provider) return message
  if (!deniedProviders().has(provider)) return message
  return `${message} (${provider} is excluded by RECALL_LLM_DENY_PROVIDERS on this host — the error above is the provider's own.)`
}

/** One completion verdict for explicit provider output-token stops, independent of text or usage counts. */
export function outputTokenStop(
  response: Pick<ModelResponse, "finishReason" | "rawFinishReason" | "appliedMaxOutputTokens">,
): string | undefined {
  if (response.finishReason !== "length" && response.rawFinishReason !== "max_output_tokens") return undefined
  const bound =
    response.appliedMaxOutputTokens === undefined
      ? "applied output bound not measured"
      : `applied output bound ${response.appliedMaxOutputTokens}`
  return `Output token limit reached (${bound}; finishReason=${response.finishReason ?? "unavailable"}; rawFinishReason=${response.rawFinishReason ?? "unavailable"}). Partial output is incomplete.`
}

/** Compute cost, finalize output, and exit — shared by all single-model response modes */
export async function finishResponse(
  content: string | undefined,
  model: {
    displayName: string
    modelId?: string
    provider?: import("./types").Provider
    inputPricePerM?: number
    outputPricePerM?: number
  },
  outputFile: string,
  sessionTag: string,
  usage?: ModelResponse["usage"],
  durationMs?: number,
  query?: string,
  responseId?: string,
  /** Per-call rate-limit headers to include in the JSON envelope. Surface
   *  is gated by the caller — pass only when `--quota` was set. */
  quota?: OutputMeta["quota"],
  /** Actionable provider error (quota exhausted, rate-limit, renamed model)
   *  captured upstream by `queryModel`/`describeDispatchFailure`. When the
   *  completion is empty and this is set, it becomes the headline instead of
   *  the generic "silent failure" copy — this is the fix for the misleading
   *  empty-response message on a real provider failure. */
  error?: string,
  retryCommand?: (model: string, bound: number) => string,
  /** Names the actual subscription route/model; it does not establish an API charge. */
  servedBy?: OutputMeta["servedBy"],
  completion?: Pick<
    ModelResponse,
    "finishReason" | "rawFinishReason" | "appliedMaxOutputTokens" | "cost_usd" | "cacheHit"
  >,
  /** The panel slot this call answered for (27038). A failed leg names it, so
   *  a reader can match the error back to the panel header without guessing. */
  slot?: string,
  /** Structured provider failure facts, when the caller still had the error
   *  object (27038). The message carries them as prose; these expose them to a
   *  caller that branches on the envelope. */
  failure?: { httpStatus?: number; providerCode?: string },
): Promise<void> {
  const costs = serializeCost(
    resolveResponseCost({ model, usage, cost_usd: completion?.cost_usd, cacheHit: completion?.cacheHit, servedBy }),
  )
  const stopped = completion === undefined ? undefined : outputTokenStop(completion)
  if (stopped === undefined && (!content || content.trim().length === 0)) {
    const providerError = withExclusionNote(
      formatBudgetRetry(error?.trim() || undefined, model, retryCommand),
      model.provider,
    )
    // Write error to stderr (visible in interactive mode). Lead with the real
    // provider error when we have one; only fall back to the generic
    // "empty completion" copy when the provider reported no error at all.
    if (providerError) {
      log.error?.(providerError)
    } else {
      log.error?.(
        "Model returned an empty completion and the provider reported no error. Likely a content filter, an overloaded model, or reasoning tokens consuming the entire output budget.",
      )
    }
    log.error?.(`Model: ${model.displayName}`)
    if (slot) log.error?.(`Slot: ${slot}`)
    if (usage) log.error?.(`Tokens: prompt=${usage.promptTokens}, completion=${usage.completionTokens}`)
    if (durationMs) log.error?.(`Duration: ${Math.round(durationMs / 1000)}s`)

    // Write error details to the output file so background callers can find it
    const durationStr = durationMs ? `${Math.round(durationMs / 1000)}s` : "unknown"
    const promptTokens = usage?.promptTokens ?? 0
    const completionTokens = usage?.completionTokens ?? 0
    const errorContent = [
      providerError ? "# LLM Error" : "# LLM Error: Empty Response",
      "",
      providerError ?? "Model returned no content and the provider reported no error.",
      "",
      `- **Model**: ${model.displayName}`,
      ...(slot ? [`- **Slot**: ${slot}`] : []),
      `- **Tokens**: prompt=${promptTokens}, completion=${completionTokens}`,
      `- **Duration**: ${durationStr}`,
      `- **Query**: ${query ?? "(none)"}`,
      "",
      providerError
        ? "Resolve the call failure described above."
        : "Possible causes: API timeout, content filter, rate limit, model overload. Re-run to retry.",
    ].join("\n")

    const meta: OutputMeta = {
      ...costs,
      query,
      model: model.displayName,
      tokens: usage?.totalTokens,
      durationMs,
    }
    const metaComment = buildMetaComment(sessionTag, meta)
    try {
      await Bun.write(outputFile, `${metaComment}\n\n${errorContent}`)
    } catch {
      // Best-effort — if we can't write the file, the stderr log above is all we have
    }

    // Emit JSON metadata to stdout so the caller knows the file exists and can detect the error.
    // `error` carries the human message; `code` stays stable for machine branching
    // ("provider_error" when the provider reported a failure, "empty_response" otherwise).
    const result: Record<string, unknown> = {
      ...costs,
      error: providerError ?? "empty_response",
      code: providerError ? "provider_error" : "empty_response",
      status: "failed",
      file: formatEnvelopeFile(outputFile, { fullPaths: isFullPaths(), cwd: process.cwd() }),
      model: model.displayName,
      tokens: usage
        ? { prompt: usage.promptTokens, completion: usage.completionTokens, total: usage.totalTokens }
        : { total: 0 },
      durationMs,
    }
    if (query) result.query = query
    if (slot) result.slot = slot
    if (failure?.httpStatus !== undefined) result.httpStatus = failure.httpStatus
    if (failure?.providerCode !== undefined) result.providerCode = failure.providerCode
    emitJson(result)

    process.exit(1)
  }
  await finalizeOutput(content ?? "", outputFile, sessionTag, {
    ...costs,
    query,
    model: model.displayName,
    tokens: usage
      ? { prompt: usage.promptTokens, completion: usage.completionTokens, total: usage.totalTokens }
      : undefined,
    ...(servedBy ? { servedBy } : {}),
    durationMs,
    responseId,
    status: stopped === undefined ? "completed" : "incomplete",
    ...(stopped === undefined ? {} : { error: stopped }),
    finishReason: completion?.finishReason,
    rawFinishReason: completion?.rawFinishReason,
    appliedMaxOutputTokens: completion?.appliedMaxOutputTokens,
    ...(quota ? { quota } : {}),
  })
  if (stopped !== undefined) {
    const retry =
      completion?.appliedMaxOutputTokens === undefined
        ? "The applied bound is not measured; inspect the provider limit before retrying."
        : "The same applied bound can stop again; raise --max-output-tokens before retrying."
    log.error?.(`${stopped} ${retry}`)
    process.exit(1)
  }
}

/** Compute total cost across multiple model responses */
export function totalResponseCost(
  responses: Array<Pick<ModelResponse, "model" | "usage" | "cost_usd" | "servedBy" | "cacheHit">>,
): ResolvedCost {
  return aggregateCosts(responses.map(resolveResponseCost))
}

/**
 * Create a stream token writer — stderr ONLY if interactive terminal (TTY).
 *
 * When running as a background task (e.g., Claude Code's run_in_background), stderr is not
 * a TTY. Streaming thousands of tokens to a non-TTY stderr causes Claude Code to truncate
 * the combined output (>30KB), potentially losing the file path JSON on stdout.
 *
 * DO NOT remove the TTY check — it prevents background task output truncation.
 */
export function createStreamToken(verbose: boolean): (token: string) => void {
  return (token: string): void => {
    if (process.stderr.isTTY || verbose) {
      process.stderr.write(token)
    }
  }
}
