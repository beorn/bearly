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

const log = createLogger("bearly:llm")

export interface OutputMeta {
  query?: string
  model?: string
  tokens?: number
  cost?: string
  durationMs?: number
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

/** Build JSON summary object for the response */
export function buildResultJson(content: string, meta?: OutputMeta): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (meta?.query) result.query = meta.query
  result.chars = content.length
  if (meta?.model) result.model = meta.model
  if (meta?.tokens) result.tokens = meta.tokens
  if (meta?.cost) result.cost = meta.cost
  if (meta?.durationMs) result.durationMs = meta.durationMs
  return result
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

    // Generate filename: YYYY-MM-DD-HHmmss-<slug>.md
    const now = new Date()
    const date = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
    const slug = meta.query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50)
    const filename = `${date}-${slug}.md`

    // Build YAML frontmatter
    const frontmatter = [
      "---",
      `query: ${JSON.stringify(meta.query)}`,
      meta.model ? `model: ${JSON.stringify(meta.model)}` : null,
      meta.cost ? `cost: ${JSON.stringify(meta.cost)}` : null,
      meta.tokens ? `tokens: ${meta.tokens}` : null,
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
  if (meta?.tokens) obj.tokens = meta.tokens
  if (meta?.durationMs) obj.durationMs = meta.durationMs
  return `<!-- llm-meta: ${JSON.stringify(obj)} -->`
}

/**
 * After response completes: write to file, print file path on stderr, JSON metadata on stdout.
 *
 * File path on stderr: human-readable, always visible in last lines of output.
 * JSON metadata on stdout: machine-parseable single line (file path, char count, cost, etc.)
 * Streaming tokens are suppressed in non-TTY mode (see createStreamToken), so stderr only contains
 * the file path line + any status messages — no truncation risk.
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
  process.stderr.write("\n")
  process.stderr.write(`Output written to: ${outputFile}\n`)
  const result = buildResultJson(content, meta)
  result.file = outputFile
  console.log(JSON.stringify(result))
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
      file: outputFile,
      model: model.displayName,
      tokens: usage?.totalTokens ?? 0,
      durationMs,
    }
    if (query) result.query = query
    console.log(JSON.stringify(result))

    process.exit(1)
  }
  const cost = usage ? estimateCost(model as any, usage.promptTokens, usage.completionTokens) : undefined
  await finalizeOutput(content, outputFile, sessionTag, {
    query,
    model: model.displayName,
    tokens: usage?.totalTokens,
    cost: cost !== undefined ? formatCost(cost) : undefined,
    durationMs,
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
