/**
 * synthesize.ts - LLM synthesis: sending search results to LLM for summarization,
 * racing multiple models, and extracting lessons from session transcripts.
 */

import * as fs from "fs"
import * as path from "path"
import { getCheapModels, getCheapModel, estimateCost, type Model } from "../llm/types"
import { queryModel } from "../llm/research"
import { isProviderAvailable } from "../llm/providers"
import { log } from "./recall-shared.ts"
import type { RecallSearchResult } from "./recall-shared.ts"

// ============================================================================
// Synthesis prompt
// ============================================================================

export const SYNTHESIS_PROMPT = `You are a knowledge retrieval assistant. Given search results from prior Claude Code sessions, synthesize the most useful information.

Extract and present:
- Decisions made and their rationale
- Approaches tried (including what failed and why)
- Key file paths and code patterns mentioned
- Warnings, caveats, or lessons learned
- Any unresolved issues or open questions

Rules:
- Be concise: 3-8 bullet points maximum
- Use plain text, no markdown headers
- Include specific file paths when mentioned
- If the results aren't relevant to the query, say "No relevant prior knowledge found."
- Do NOT invent information not present in the search results`

// ============================================================================
// LLM Race Infrastructure
// ============================================================================

export interface LlmRaceModelResult {
  model: string
  ms: number
  status: "ok" | "timeout" | "error"
  tokens?: { input: number; output: number }
  cost?: number // USD
}

export interface LlmRaceResult {
  winner: string | null
  text: string | null
  cost?: number
  timedOut: boolean
  totalMs: number
  perModel: LlmRaceModelResult[]
  totalCost: number // sum of ALL models called (winner + losers)
}

/**
 * Race multiple LLM models — first valid response wins.
 * Returns per-model timing diagnostics regardless of outcome.
 */
export async function raceLlmModels(
  context: string,
  systemPrompt: string,
  models: Model[],
  timeoutMs: number,
): Promise<LlmRaceResult> {
  const raceStart = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Track per-model results (settled after race completes)
  const modelResults: LlmRaceModelResult[] = models.map((m) => ({
    model: m.modelId,
    ms: 0,
    status: "timeout" as const,
  }))

  // Race all models
  const racePromises = models.map(async (model, i) => {
    const result = await queryModel({
      question: context,
      model,
      systemPrompt,
      abortSignal: controller.signal,
    })

    const elapsed = Date.now() - raceStart
    const mr = modelResults[i]!
    mr.ms = elapsed

    // Track tokens + compute cost from actual usage
    const usage = result.response.usage
    if (usage) {
      mr.tokens = { input: usage.promptTokens, output: usage.completionTokens }
      mr.cost = estimateCost(model, usage.promptTokens, usage.completionTokens)
    }

    // queryModel catches errors internally — check for abort/error
    if (controller.signal.aborted) {
      mr.status = "timeout"
      return null
    }
    if (result.response.error) {
      mr.status = "error"
      return null
    }

    const content = result.response.content
    if (!content) {
      mr.status = "error"
      return null
    }

    mr.status = "ok"
    return {
      text: content,
      cost: mr.cost,
      model: model.modelId,
    }
  })

  try {
    const winner = await Promise.any(
      racePromises.map((p) =>
        p.then((r) => {
          if (!r) throw new Error("empty")
          clearTimeout(timer)
          controller.abort()
          return r
        }),
      ),
    )

    const totalCost = modelResults.reduce((s, m) => s + (m.cost ?? 0), 0)
    return {
      winner: winner.model,
      text: winner.text,
      cost: winner.cost,
      timedOut: false,
      totalMs: Date.now() - raceStart,
      perModel: modelResults,
      totalCost,
    }
  } catch {
    clearTimeout(timer)
    controller.abort()
    const totalMs = Date.now() - raceStart
    const totalCost = modelResults.reduce((s, m) => s + (m.cost ?? 0), 0)
    return {
      winner: null,
      text: null,
      timedOut: totalMs >= timeoutMs - 50,
      totalMs,
      perModel: modelResults,
      totalCost,
    }
  }
}

// ============================================================================
// LLM synthesis (internal)
// ============================================================================

export interface SynthesisResult {
  text: string | null
  cost?: number
  aborted?: boolean
}

export async function synthesizeResults(
  query: string,
  results: RecallSearchResult[],
  timeoutMs: number,
): Promise<SynthesisResult> {
  const models = getCheapModels(2).filter((m) => isProviderAvailable(m.provider))
  if (models.length === 0) {
    log(`no LLM providers available for synthesis`)
    return { text: null }
  }

  const context = formatResultsForLlm(query, results)
  const modelNames = models.map((m) => m.modelId).join(", ")
  log(`LLM synthesis: racing [${modelNames}] context=${context.length} chars timeout=${timeoutMs}ms`)

  const race = await raceLlmModels(context, SYNTHESIS_PROMPT, models, timeoutMs)

  if (race.winner) {
    log(`LLM winner: ${race.winner} in ${race.totalMs}ms`)
  } else {
    log(`LLM synthesis ${race.timedOut ? "aborted" : "failed"} after ${race.totalMs}ms (models: [${modelNames}])`)
  }

  return {
    text: race.text,
    cost: race.cost,
    aborted: race.timedOut,
  }
}

export function formatResultsForLlm(query: string, results: RecallSearchResult[]): string {
  const lines: string[] = [`Query: "${query}"`, "", `Found ${results.length} relevant results from prior sessions:`, ""]

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    const date = new Date(r.timestamp).toISOString().split("T")[0]
    const sessionLabel = r.sessionTitle ? `${r.sessionTitle} (${r.sessionId.slice(0, 8)})` : r.sessionId.slice(0, 8)

    lines.push(`--- Result ${i + 1} [${r.type}] ${date} - ${sessionLabel} ---`)

    // Clean snippet markers
    const cleanSnippet = r.snippet.replace(/>>>/g, "").replace(/<<</g, "").trim()
    lines.push(cleanSnippet)
    lines.push("")
  }

  lines.push("---")
  lines.push("Synthesize the above results into concise, actionable bullet points relevant to the query.")

  return lines.join("\n")
}

// ============================================================================
// Remember: extract lessons from session transcript
// ============================================================================

export interface RememberOptions {
  transcriptPath: string
  sessionId: string
  memoryDir: string
}

export interface RememberResult {
  skipped: boolean
  reason?: string
  memoryFile?: string
  lessonsCount?: number
}

const REMEMBER_PROMPT = `Extract key lessons, decisions, bugs found, patterns learned, and warnings from this Claude Code session transcript. Output as concise bullet points. Skip routine operations (file reads, test runs, linting). Focus on:
- Decisions made and WHY
- Bugs found and their root causes
- Approaches that failed and why
- Architectural patterns or conventions discovered
- Warnings for future sessions

If nothing noteworthy was learned, respond with just: NONE`

/**
 * Extract lessons from a session transcript and append to a dated memory file.
 * Throws on actual errors (fail loud).
 */
export async function remember(options: RememberOptions): Promise<RememberResult> {
  const { transcriptPath, sessionId, memoryDir } = options
  const startTime = Date.now()

  log(`remember session=${sessionId.slice(0, 8)} transcript=${transcriptPath}`)

  if (!fs.existsSync(transcriptPath)) {
    log(`transcript not found: ${transcriptPath}`)
    return { skipped: true, reason: "transcript_not_found" }
  }

  // Extract last user+assistant messages from JSONL transcript
  const extractStart = Date.now()
  const { extractTranscriptMessages } = await import("./scanner")
  const messages = extractTranscriptMessages(transcriptPath)
  if (!messages) {
    log(`no user/assistant messages found in transcript (${Date.now() - extractStart}ms)`)
    return { skipped: true, reason: "no_messages" }
  }
  log(`extracted ${messages.length} chars from transcript (${Date.now() - extractStart}ms)`)

  // Check LLM availability
  const model = getCheapModel()
  if (!model || !isProviderAvailable(model.provider)) {
    log(`no LLM provider available (model: ${model?.modelId ?? "none"}, provider: ${model?.provider ?? "none"})`)
    return { skipped: true, reason: "no_llm_provider" }
  }

  // Synthesize lessons
  const fullPrompt = `${REMEMBER_PROMPT}\n\nSession transcript (last messages):\n${messages}`
  log(`LLM synthesis: model=${model.modelId} provider=${model.provider} prompt=${fullPrompt.length} chars`)
  const llmStart = Date.now()
  const result = await queryModel({ question: fullPrompt, model })
  const synthesis = result.response.content
  log(`LLM responded in ${Date.now() - llmStart}ms`)

  if (!synthesis || synthesis.trim().length === 0) {
    log(`empty synthesis from LLM`)
    return { skipped: true, reason: "empty_synthesis" }
  }

  if (/^NONE$/im.test(synthesis.trim())) {
    log(`LLM says nothing noteworthy (${Date.now() - startTime}ms total)`)
    return { skipped: true, reason: "nothing_noteworthy" }
  }

  // Ensure memory dir exists
  fs.mkdirSync(memoryDir, { recursive: true })

  // Append to dated memory file
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  const memoryFile = path.join(memoryDir, `${today}.md`)
  const time = new Date().toTimeString().slice(0, 5)
  const entry = `\n## Session ${sessionId.slice(0, 8)} (${time})\n\n${synthesis}\n`

  fs.appendFileSync(memoryFile, entry)

  const lessonsCount = (synthesis.match(/^[-*]/gm) || []).length
  log(`saved ${lessonsCount} lessons (${synthesis.length} chars) to ${memoryFile} (${Date.now() - startTime}ms total)`)

  return {
    skipped: false,
    memoryFile,
    lessonsCount,
  }
}
