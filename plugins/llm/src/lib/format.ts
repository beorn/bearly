/**
 * Output formatting — file writing, result JSON, research archival, streaming.
 *
 * Handles writing LLM responses to files, building JSON metadata for stdout,
 * archiving to research directories, and streaming tokens to stderr.
 */

import { createLogger } from "loggily"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import * as os from "os"
import { estimateCost, formatCost } from "./types"
import { emitJson, formatEnvelopeFile, isFullPaths, isJsonMode } from "./output-mode"

const log = createLogger("bearly:llm")

/**
 * Per-leg metadata for dual-pro envelopes. Each leg ships independently
 * because the two models can disagree on tokens/cost/duration; flattening
 * loses the A/B signal we publish for skill consumers (e.g. ranking).
 */
export interface LegMeta {
  model?: string
  tokens?: { prompt: number; completion: number; total: number }
  cost?: number
  durationMs?: number
  status?: "completed" | "failed"
  error?: string
}

export interface OutputMeta {
  query?: string
  model?: string
  /**
   * Total tokens (legacy single-number field) OR structured prompt/completion
   * pair (preferred for the JSON envelope schema). Both forms are accepted;
   * the envelope serializer normalizes.
   */
  tokens?: number | { prompt: number; completion: number; total?: number }
  /** Display-formatted cost string (legacy, kept for the meta-comment header). */
  cost?: string
  /** Numeric cost in USD — preferred for the JSON envelope. */
  costUsd?: number
  durationMs?: number
  responseId?: string
  status?: "completed" | "failed" | "background" | "recovered"
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
 *     "cost": 0.045,                         // USD, number (not string)
 *     "durationMs": 12345,
 *     "responseId": "resp_abc123",
 *     "status": "completed" | "failed" | "background" | "recovered",
 *     "chars": 4321,                         // response body length
 *     "query": "...",                        // optional
 *     "a": { ...leg meta },                  // optional, dual-pro
 *     "b": { ...leg meta }
 *   }
 *
 * Backward-compat: legacy callers passed `tokens` as a number and `cost`
 * as a formatted string. Both are still accepted via OutputMeta; this
 * builder normalizes to the canonical shape so the envelope is stable
 * regardless of which dispatch path emitted it.
 */
export function buildResultJson(content: string, meta?: OutputMeta): Record<string, unknown> {
  const result: Record<string, unknown> = {}
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

  // Prefer numeric cost; fall back to legacy string form for back-compat.
  if (meta?.costUsd != null) {
    result.cost = meta.costUsd
  } else if (meta?.cost) {
    result.cost = meta.cost
  }

  if (meta?.durationMs) result.durationMs = meta.durationMs
  if (meta?.responseId) result.responseId = meta.responseId
  if (meta?.status) result.status = meta.status
  if (meta?.a) result.a = legToEnvelope(meta.a)
  if (meta?.b) result.b = legToEnvelope(meta.b)
  if (meta?.c) result.c = legToEnvelope(meta.c)
  if (meta?.judge) result.judge = meta.judge
  if (meta?.leaderboardSnapshot) result.leaderboardSnapshot = meta.leaderboardSnapshot
  if (meta?.quota) result.quota = meta.quota
  return result
}

function legToEnvelope(leg: LegMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (leg.model) out.model = leg.model
  if (leg.tokens) {
    out.tokens = {
      prompt: leg.tokens.prompt,
      completion: leg.tokens.completion,
      total: leg.tokens.total ?? leg.tokens.prompt + leg.tokens.completion,
    }
  }
  if (leg.cost != null) out.cost = leg.cost
  if (leg.durationMs != null) out.durationMs = leg.durationMs
  if (leg.status) out.status = leg.status
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
    const researchDir = `${os.homedir()}/.claude/projects/${encodedPath}/memory/research`

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
      meta.cost ? `cost: ${JSON.stringify(meta.cost)}` : null,
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
  if (meta?.cost) obj.cost = meta.cost
  if (meta?.tokens != null) {
    // Both legacy number form and structured {prompt, completion} form
    // appear in the meta-comment unchanged — JSON.stringify handles both.
    obj.tokens = meta.tokens
  }
  if (meta?.durationMs) obj.durationMs = meta.durationMs
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

/** Compute cost, finalize output, and exit — shared by all single-model response modes */
export async function finishResponse(
  content: string | undefined,
  model: { displayName: string; inputPricePerM?: number; outputPricePerM?: number },
  outputFile: string,
  sessionTag: string,
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  },
  durationMs?: number,
  query?: string,
  responseId?: string,
  /** Per-call rate-limit headers to include in the JSON envelope. Surface
   *  is gated by the caller — pass only when `--quota` was set. */
  quota?: OutputMeta["quota"],
): Promise<void> {
  if (!content || content.trim().length === 0) {
    // Write error to stderr (visible in interactive mode)
    log.error?.("Model returned empty response (no content). This is a silent failure.")
    log.error?.(`Model: ${model.displayName}`)
    if (usage) log.error?.(`Tokens: prompt=${usage.promptTokens}, completion=${usage.completionTokens}`)
    if (durationMs) log.error?.(`Duration: ${Math.round(durationMs / 1000)}s`)

    // Write error details to the output file so background callers can find it
    const durationStr = durationMs ? `${Math.round(durationMs / 1000)}s` : "unknown"
    const promptTokens = usage?.promptTokens ?? 0
    const completionTokens = usage?.completionTokens ?? 0
    const errorContent = [
      "# LLM Error: Empty Response",
      "",
      "Model returned no content. This usually means the API call failed silently.",
      "",
      `- **Model**: ${model.displayName}`,
      `- **Tokens**: prompt=${promptTokens}, completion=${completionTokens}`,
      `- **Duration**: ${durationStr}`,
      `- **Query**: ${query ?? "(none)"}`,
      "",
      "Possible causes: API timeout, content filter, rate limit, model overload.",
      "",
      "Re-run the command to retry.",
    ].join("\n")

    const meta: OutputMeta = {
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

    // Emit JSON metadata to stdout so the caller knows the file exists and can detect the error
    const result: Record<string, unknown> = {
      error: "empty_response",
      status: "failed",
      file: formatEnvelopeFile(outputFile, { fullPaths: isFullPaths(), cwd: process.cwd() }),
      model: model.displayName,
      tokens: usage
        ? { prompt: usage.promptTokens, completion: usage.completionTokens, total: usage.totalTokens }
        : { total: 0 },
      durationMs,
    }
    if (query) result.query = query
    emitJson(result)

    process.exit(1)
  }
  const cost = usage ? estimateCost(model as any, usage.promptTokens, usage.completionTokens) : undefined
  await finalizeOutput(content, outputFile, sessionTag, {
    query,
    model: model.displayName,
    tokens: usage
      ? { prompt: usage.promptTokens, completion: usage.completionTokens, total: usage.totalTokens }
      : undefined,
    cost: cost !== undefined ? formatCost(cost) : undefined,
    costUsd: cost,
    durationMs,
    responseId,
    status: "completed",
    ...(quota ? { quota } : {}),
  })
}

/** Compute total cost across multiple model responses */
export function totalResponseCost(
  responses: Array<{
    model: any
    usage?: { promptTokens: number; completionTokens: number }
  }>,
): number {
  let total = 0
  for (const resp of responses) {
    if (resp.usage) total += estimateCost(resp.model, resp.usage.promptTokens, resp.usage.completionTokens)
  }
  return total
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
