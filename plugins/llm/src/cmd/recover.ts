/**
 * Recovery commands — `bun llm recover`, `bun llm await`, plus the shared
 * pre-dispatch partial sweep.
 *
 * Includes:
 *   - pollResponseToCompletion: provider-aware poll loop (OpenAI + Gemini)
 *   - classifyRecovery: shared (partial, pollResult) → outcome classifier
 *   - runRecover / runAwait: command entry points
 *   - checkAndRecoverPartials: auto-sweep before dispatching a new query
 */

import { retrieveResponse, pollForCompletion } from "../lib/openai-deep"
import { listPartials, findPartialByResponseId, cleanupPartials } from "../lib/persistence"
import { getModel } from "../lib/types"
import { emitContent, emitJson } from "../lib/output-mode"
import { withSignalAbort } from "../lib/signals"
import { confirmOrExit } from "../ui/confirm"

/**
 * Default poll ceiling for recover/await: 600 × 5s = 50 minutes.
 *
 * Raised from the original 180 (=15 min) after a GPT 5.4 Pro deep review took
 * ~40 min end-to-end and the recover command timed out. Tune via env var
 * LLM_RECOVER_MAX_ATTEMPTS; each attempt is one 5s poll.
 */
const DEFAULT_RECOVER_MAX_ATTEMPTS = 600

function resolveMaxAttempts(): number {
  const raw = process.env.LLM_RECOVER_MAX_ATTEMPTS
  if (!raw) return DEFAULT_RECOVER_MAX_ATTEMPTS
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RECOVER_MAX_ATTEMPTS
}

/**
 * Progress printer for poll loops.
 *
 * - silent: no output (used by `await`)
 * - TTY: live `\r`-overwriting spinner every poll
 * - non-TTY (claude-code, CI): one line per 60s — keeps output compact so
 *   claude-code's stdout-burst auto-background heuristic doesn't trigger.
 */
function makePollProgress(opts: { silent?: boolean } = {}): (status: string, elapsedMs: number) => void {
  if (opts.silent) return () => {}
  const isTTY = process.stderr.isTTY
  let lastLogged = -60
  return (status, elapsedMs) => {
    if (isTTY) {
      process.stderr.write(`\r⏳ ${status} (${Math.round(elapsedMs / 1000)}s elapsed)`)
      return
    }
    const seconds = Math.round(elapsedMs / 1000)
    if (seconds - lastLogged < 60) return
    lastLogged = seconds
    process.stderr.write(`⏳ ${status} (${seconds}s elapsed)\n`)
  }
}

/** Write a recovered response to /tmp/llm-*.txt so background callers can find it. */
async function writeRecoveredResponse(
  content: string,
  responseId: string,
  topic: string | undefined,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined,
): Promise<string> {
  const { buildOutputPath, finalizeOutput } = await import("../lib/format")
  const sessionTag = process.env.CLAUDE_SESSION_ID?.slice(0, 8) ?? "manual"
  const outputFile = buildOutputPath(sessionTag, topic ?? `recover-${responseId}`)
  await finalizeOutput(content, outputFile, sessionTag, {
    query: topic,
    tokens: usage
      ? { prompt: usage.promptTokens, completion: usage.completionTokens, total: usage.totalTokens }
      : undefined,
    responseId,
    status: "recovered",
  })
  return outputFile
}

/**
 * Poll a response ID until completion. Shared by `recover <id>` and `await <id>`.
 *
 * @param silentProgress — when true, suppress all progress output (used by `await`).
 *                        Otherwise TTY gets spinner, non-TTY gets 60s-gated lines.
 * @param abortSignal — optional signal that short-circuits the poll on abort.
 *                      Wired by runRecover/runAwait via withSignalAbort so
 *                      Ctrl-C during a 50-minute recover stops cleanly.
 */
export async function pollResponseToCompletion(
  responseId: string,
  silentProgress: boolean,
  abortSignal?: AbortSignal,
): Promise<{
  status: string
  content: string
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  error?: string
}> {
  // Route to the right backend based on the persisted model. Gemini deep
  // research writes partials with Gemini interaction IDs into the same
  // persistence store — previously we always called OpenAI retrieveResponse,
  // which silently failed for Gemini IDs. Look up the partial, resolve its
  // provider, and dispatch accordingly. If no partial exists we fall back to
  // OpenAI (historical default, consistent with external callers passing in
  // resp_* IDs directly).
  const partial = findPartialByResponseId(responseId)
  const persistedModel = partial ? getModel(partial.metadata.modelId) : undefined
  const isGemini = persistedModel?.provider === "google"

  if (isGemini) {
    const { pollForGeminiCompletion } = await import("../lib/gemini-deep")
    const maxAttempts = resolveMaxAttempts()
    if (!silentProgress) {
      const mins = Math.round((maxAttempts * 5) / 60)
      console.error(`\nPolling Gemini interaction (ceiling: ${mins}m, set LLM_RECOVER_MAX_ATTEMPTS to override)`)
    }
    const result = await pollForGeminiCompletion(responseId, {
      intervalMs: 5_000,
      maxAttempts,
      abortSignal,
      onProgress: makePollProgress({ silent: silentProgress }),
    })
    if (!silentProgress && process.stderr.isTTY) process.stderr.write("\n")
    return result
  }

  const initial = await retrieveResponse(responseId)
  if (initial.status !== "in_progress" && initial.status !== "queued") {
    return initial
  }
  const maxAttempts = resolveMaxAttempts()
  if (!silentProgress) {
    const mins = Math.round((maxAttempts * 5) / 60)
    console.error(
      `\nStatus: ${initial.status} — polling every 5s (ceiling: ${mins}m, set LLM_RECOVER_MAX_ATTEMPTS to override)`,
    )
  }
  const result = await pollForCompletion(responseId, {
    intervalMs: 5_000,
    maxAttempts,
    abortSignal,
    onProgress: makePollProgress({ silent: silentProgress }),
  })
  if (!silentProgress && process.stderr.isTTY) process.stderr.write("\n")
  return result
}

/**
 * Classify a (partial, pollResult) pair into one of four user-facing
 * outcomes. Both checkAndRecoverPartials (auto-recover before new query)
 * and runRecover (explicit `llm recover <id>`) do the same branching; this
 * helper puts the classification logic in one place so the Gemini routing
 * fix, stale-age threshold, and status taxonomy apply uniformly.
 *
 * `partial` is optional because runRecover may be called with a raw
 * response ID that has no local partial (external callers passing IDs
 * direct from `openai.responses.create`). Without a partial, we can't
 * compute age, so "stale" never fires — pending/pending-ish statuses
 * just fall through to the caller's "still running" path.
 */
export type RecoveryOutcome =
  | {
      kind: "completed"
      content: string
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
    }
  | { kind: "failed"; status: string; error?: string }
  | { kind: "stale"; status: string; ageMs: number }
  | { kind: "pending"; status: string; ageMs: number | undefined }
  | { kind: "aborted"; status: string; error?: string }
  | { kind: "error"; status: string; error?: string }
  | { kind: "unknown"; status: string }

/** Stale threshold for pending deep-research responses: 30m. */
const STALE_THRESHOLD_MS = 30 * 60 * 1000

export function classifyRecovery(
  partial: { metadata: { startedAt: string } } | undefined,
  result: {
    status: string
    content: string
    error?: string
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  },
): RecoveryOutcome {
  // Local client abort — NEVER delete the partial. The remote job may still
  // be running; re-running `recover` later should still work. "cancelled"
  // is reserved for remote provider-terminated runs.
  if (result.status === "aborted") {
    return { kind: "aborted", status: result.status, error: result.error }
  }
  if (result.status === "completed" && result.content) {
    return { kind: "completed", content: result.content, usage: result.usage }
  }
  // "completed && !content" = provider returned completion but no body.
  // Treated as error rather than success so callers surface the failure.
  if (result.status === "completed" && !result.content) {
    return { kind: "error", status: "completed-empty", error: result.error ?? "completed with empty content" }
  }
  if (
    result.status === "failed" ||
    result.status === "cancelled" ||
    result.status === "expired" ||
    result.status === "incomplete"
  ) {
    return { kind: "failed", status: result.status, error: result.error }
  }
  if (result.status === "timeout") {
    return { kind: "error", status: result.status, error: result.error ?? "polling timed out" }
  }
  if (result.error) {
    return { kind: "error", status: result.status, error: result.error }
  }
  // Normalize running states: queued/in_progress/running/processing/submitted
  // all count as "still going".
  const runningStates = ["in_progress", "queued", "running", "processing", "submitted"]
  if (runningStates.includes(result.status)) {
    const ageMs = partial ? Date.now() - new Date(partial.metadata.startedAt).getTime() : undefined
    if (ageMs !== undefined && ageMs > STALE_THRESHOLD_MS) {
      return { kind: "stale", status: result.status, ageMs }
    }
    return { kind: "pending", status: result.status, ageMs }
  }
  return { kind: "unknown", status: result.status }
}

/**
 * Check for and auto-recover incomplete responses.
 * Returns true if user wants to continue with new query.
 */
export async function checkAndRecoverPartials(skipRecover: boolean, skipConfirm: boolean): Promise<boolean> {
  if (skipRecover) return true

  const partials = listPartials()
  if (partials.length === 0) return true

  console.error(`📦 Found ${partials.length} incomplete response(s) - attempting recovery...\n`)

  for (const partial of partials) {
    const age = Date.now() - new Date(partial.metadata.startedAt).getTime()
    const ageStr = age < 3600000 ? `${Math.round(age / 60000)}m ago` : `${Math.round(age / 3600000)}h ago`

    console.error(`  ${partial.metadata.responseId}`)
    console.error(`    Started: ${ageStr} | Topic: ${partial.metadata.topic.slice(0, 50)}...`)

    if (partial.metadata.responseId) {
      const persistedModel = getModel(partial.metadata.modelId)
      const provider = persistedModel?.provider ?? "openai"
      const providerName = provider === "google" ? "Gemini" : "OpenAI"
      const recovered = await pollResponseToCompletion(partial.metadata.responseId, /* silent */ true)
      const outcome = classifyRecovery(partial, recovered)
      const { completePartial } = await import("../lib/persistence")
      switch (outcome.kind) {
        case "completed": {
          console.error(`    ✅ Recovered from ${providerName} (${outcome.content.length} chars)`)
          console.error(`\n--- Recovered Response ---\n`)
          // emitContent → stdout in legacy, stderr in JSON mode (so the
          // single JSON envelope line is the only thing on stdout).
          emitContent(outcome.content)
          if (outcome.usage) console.error(`\n[Recovered: ${outcome.usage.totalTokens} tokens]`)
          completePartial(partial.path, { delete: true })
          console.error(`\n--- End Recovered Response ---\n`)
          break
        }
        case "failed": {
          console.error(`    ❌ Response ${outcome.status} — removing stale partial`)
          completePartial(partial.path, { delete: true })
          break
        }
        case "stale": {
          console.error(
            `    ⚠️  Still ${outcome.status} after ${Math.round(outcome.ageMs / 60000)}m — likely stale, removing`,
          )
          completePartial(partial.path, { delete: true })
          break
        }
        case "pending": {
          const ageStr = outcome.ageMs !== undefined ? `${Math.round(outcome.ageMs / 60000)}m old` : "age unknown"
          console.error(`    ⏳ Still ${outcome.status} on ${providerName} (${ageStr})`)
          console.error(`    Run 'llm recover ${partial.metadata.responseId}' to poll until complete`)
          break
        }
        case "aborted": {
          // Local interrupt — partial stays, job may still be running remotely.
          console.error(`    ⚠️  Local abort — partial kept for future recovery`)
          break
        }
        case "error":
        case "unknown": {
          console.error(`    ⚠️  Could not recover (status: ${outcome.status})`)
          if (partial.content.length > 0) {
            console.error(`    Local partial has ${partial.content.length} chars saved`)
          }
          break
        }
      }
    }
    console.error()
  }

  // Delegate to confirmOrExit's hardened prompt (TTY check + 5min timeout).
  // The skipConfirm short-circuit returns silently; a declined prompt calls
  // process.exit(0) inside confirmOrExit. We only need to handle "ok, continue".
  await confirmOrExit("Continue with new query? [Y/n] ", skipConfirm)
  return true
}

/** Run recover/partials command */
export async function runRecover(options: {
  responseId: string | undefined
  clean: boolean
  cleanStale: boolean
  includeAll: boolean
}): Promise<void> {
  const { responseId, clean, cleanStale, includeAll } = options

  // Clean up old partials if requested
  if (clean) {
    const deleted = cleanupPartials(24 * 60 * 60 * 1000)
    console.error(`✓ Cleaned up ${deleted} old partial file(s)`)
    return
  }

  if (cleanStale) {
    const deleted = cleanupPartials(30 * 60 * 1000)
    console.error(`✓ Cleaned up ${deleted} stale partial file(s)`)
    return
  }

  // If response ID provided, try to retrieve it
  if (responseId) {
    console.error(`Retrieving response: ${responseId}...\n`)

    // First check local partials
    const localPartial = findPartialByResponseId(responseId)
    if (localPartial) {
      console.error(`Found local partial (${localPartial.content.length} chars):\n`)
      emitContent(localPartial.content)

      if (!localPartial.metadata.completedAt) {
        console.error("\n---")
        console.error("This response was interrupted. Attempting to retrieve from OpenAI...")
      }
    }

    // SIGINT/SIGTERM during a 50-minute recover should stop cleanly instead
    // of running until the max-attempt ceiling. The provider-side response
    // is unaffected — user can re-run `llm recover <id>` later.
    const result = await withSignalAbort((signal) =>
      pollResponseToCompletion(responseId, /* silentProgress */ false, signal),
    )

    const outcome = classifyRecovery(localPartial ?? undefined, result)
    const { completePartial } = await import("../lib/persistence")
    switch (outcome.kind) {
      case "completed": {
        console.error("\nFull response from OpenAI:\n")
        emitContent(outcome.content)
        if (outcome.usage) console.error(`\n[${outcome.usage.totalTokens} tokens]`)
        // finalizeOutput() inside writeRecoveredResponse already writes the
        // path line to stderr — skip the redundant "Recovered output written
        // to:" that used to print a near-identical second line.
        await writeRecoveredResponse(outcome.content, responseId, localPartial?.metadata.topic, outcome.usage)
        if (localPartial) completePartial(localPartial.path, { delete: true })
        break
      }
      case "failed": {
        console.error(`\nResponse ${outcome.status}`)
        if (localPartial) {
          completePartial(localPartial.path, { delete: true })
          console.error("Cleaned up stale partial file.")
        }
        break
      }
      case "stale": {
        console.error(`\n⚠️  Still ${outcome.status} after ${Math.round(outcome.ageMs / 60000)}m — likely stale`)
        if (localPartial) {
          completePartial(localPartial.path, { delete: true })
          console.error("Cleaned up stale partial file.")
        }
        break
      }
      case "pending": {
        const ageStr = outcome.ageMs !== undefined ? ` (${Math.round(outcome.ageMs / 60000)}m old)` : ""
        console.error(`Response ${outcome.status}${ageStr}`)
        break
      }
      case "aborted": {
        // Local Ctrl-C during recover: partial preserved. User can re-run
        // `llm recover <id>` later; the remote job is still running.
        // Exit 130 (SIGINT convention) so wrapping scripts can distinguish a
        // user interrupt from success. Flagged by K2.6 round-3 review.
        console.error(`\n⚠️  Recovery aborted locally — partial kept for future retry`)
        process.exit(130)
      }
      case "error": {
        if (!localPartial) {
          // Match runAwait's error envelope — include responseId + status so
          // scripts and the `bun llm await` caller can reason about the
          // failure without re-deriving context.
          emitJson({
            error: `Failed to retrieve: ${outcome.error}`,
            status: "failed",
            pollStatus: outcome.status,
            responseId,
          })
          process.exit(1)
        }
        console.error(`\n⚠️  Could not retrieve from OpenAI (${responseId}): ${outcome.error}`)
        break
      }
      case "unknown": {
        console.error(`Response ${outcome.status}${result.error ? `: ${result.error}` : ""}`)
        break
      }
    }
    return
  }

  // List all partials
  const partials = listPartials({ includeCompleted: includeAll })

  if (partials.length === 0) {
    console.error("No incomplete responses found.")
    console.error("\nPartial responses are saved automatically during deep research calls.")
    console.error("If interrupted, they appear here for recovery.")
    return
  }

  console.error(`Found ${partials.length} partial response(s):\n`)

  for (const partial of partials) {
    const age = Date.now() - new Date(partial.metadata.startedAt).getTime()
    const ageStr =
      age < 3600000
        ? `${Math.round(age / 60000)}m ago`
        : age < 86400000
          ? `${Math.round(age / 3600000)}h ago`
          : `${Math.round(age / 86400000)}d ago`

    const isStale = age > 30 * 60 * 1000 // >30 min
    const status = partial.metadata.completedAt ? "✓ completed" : isStale ? "💀 stale" : "⚠️  interrupted"
    const preview = partial.content.slice(0, 100).replace(/\n/g, " ")

    console.error(`  ${partial.metadata.responseId}`)
    console.error(`    ${status} | ${ageStr} | ${partial.metadata.model}`)
    console.error(`    Topic: ${partial.metadata.topic.slice(0, 60)}...`)
    if (partial.content.length > 0) {
      console.error(`    Content: ${preview}${partial.content.length > 100 ? "..." : ""}`)
    }
    console.error(`    (${partial.content.length} chars saved)`)
    console.error()
  }

  console.error("To retrieve a response: llm recover <response_id>")
  console.error("To clean up old partials: llm partials --clean")
}

/**
 * Run `await <id>` — block silently until a deep-research response completes,
 * then print only the file path on stderr and a JSON summary on stdout. No
 * spinner, no preview, no progress. Designed for non-interactive callers
 * (claude-code, CI) that just want the final result.
 */
export async function runAwait(options: { responseId: string | undefined }): Promise<void> {
  const { responseId } = options
  if (!responseId) {
    emitJson({ error: "Usage: llm await <response_id>", status: "failed" })
    process.exit(1)
  }

  const localPartial = findPartialByResponseId(responseId)
  // SIGINT/SIGTERM stops the silent poll cleanly — same rationale as
  // runRecover; a 50m poll should honour Ctrl-C.
  const result = await withSignalAbort((signal) =>
    pollResponseToCompletion(responseId, /* silentProgress */ true, signal),
  )

  if (result.status === "completed" && result.content) {
    // finalizeOutput() inside writeRecoveredResponse already emits
    // "Output written to: ..." on stderr — don't print it a second time here.
    await writeRecoveredResponse(result.content, responseId, localPartial?.metadata.topic, result.usage)
    if (localPartial) {
      const { completePartial } = await import("../lib/persistence")
      completePartial(localPartial.path, { delete: true })
    }
    return
  }

  const errorPayload: Record<string, unknown> = {
    error: result.error ?? `Response ${result.status}`,
    status: "failed",
    pollStatus: result.status,
    responseId,
  }
  emitJson(errorPayload)
  process.exit(1)
}
