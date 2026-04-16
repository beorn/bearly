/**
 * plan.ts — LLM-driven query planner.
 *
 * Given a user query + rich project context, emits 10–20 FTS query variants
 * bucketed by kind (keywords, phrases, concepts, paths, errors, bead_ids).
 *
 * Round 2 re-runs the planner with round-1 results attached, in one of two
 * modes:
 *   - wider:  weak round-1 coverage → ask for broader / alt phrasings
 *   - deeper: strong round-1 cluster → mine entities from top snippets
 */

import { getCheapModel, getCheapModels, estimateCost, getModel, type Model } from "../lib/llm/types.ts"
import { isProviderAvailable } from "../lib/llm/providers.ts"
import { queryModel } from "../lib/llm/research.ts"
import type { RecallSearchResult } from "../lib/history/recall-shared.ts"
import type { QueryContext } from "./context.ts"
import { renderContextPrompt } from "./context.ts"

// ============================================================================
// Plan shape
// ============================================================================

export interface QueryPlan {
  /** Single technical tokens (FTS terms). */
  keywords: string[]
  /** Multi-word phrases (will be quoted for FTS). */
  phrases: string[]
  /** Broader concepts / domain terms — single or compound words. */
  concepts: string[]
  /** File paths, filenames, directory names. */
  paths: string[]
  /** Error messages / exception text / stack-trace markers. */
  errors: string[]
  /** Bead IDs mentioned or likely relevant. */
  bead_ids: string[]
  /** Short relative time hint ("1h"|"1d"|"1w"|"30d") or null. */
  time_hint: string | null
  /** Optional planner rationale for --debug-plan / trace. */
  notes?: string
}

export interface PlanCall {
  plan: QueryPlan | null
  model?: string
  elapsedMs: number
  cost?: number
  rawResponse?: string
  error?: string
}

// ============================================================================
// Prompts
// ============================================================================

const SYSTEM_PROMPT_ROUND1 = `You are a FTS5 query planner for a Claude Code session-history search engine.
Your job is to turn a vague user query into 10-20 FTS5-friendly search variants that will actually hit the indexed corpus.

KEY PRINCIPLE: Creativity comes from mining the project context for distinctive keywords.
The corpus is small and specific — generic synonyms ("authentication" for "login") rarely help.
What DOES help: the exact terminology this project uses. Pull candidate tokens from the
"Distinctive corpus tokens" list, recent session prompts, bead titles, and commit messages.
Prefer specific file/component names, bead IDs, and jargon you see in the context over
dictionary-level alternatives.

RULES:
- Output ONLY a single JSON object (no markdown, no prose, no code fences).
- Shape: { "keywords": [], "phrases": [], "concepts": [], "paths": [], "errors": [], "bead_ids": [], "time_hint": null, "notes": "" }
- Across all buckets: aim for 10-20 variants total, not per bucket.
- keywords: single technical tokens — camelCase, kebab-case, or domain nouns.
- phrases: 2-4 word exact phrases likely to appear verbatim in transcripts.
- concepts: broader domain terms (flexbox, virtual-list, CRDT) when intent is abstract.
- paths: file basenames or directory names seen in the context (with extension if known).
- errors: exception or error-message fragments, if the query hints at a bug.
- bead_ids: bead IDs from the context that plausibly match the intent.
- time_hint: one of "1h", "1d", "1w", "30d" or null. Infer from phrases like "today", "last week", "recently".
- notes: ONE sentence on why you chose these variants. Cite context evidence if possible.

DO NOT invent tokens that aren't plausible given the context. When uncertain, omit.`

const SYSTEM_PROMPT_ROUND2_WIDER = `You are a FTS5 query planner running ROUND 2 in WIDER mode.

Round 1 returned weak coverage — few docs matched, or matched shallowly. Your job now
is to widen the net: propose variants that round 1 missed. Look for:
- Alternate phrasings the user might have used (they described it imperfectly).
- Adjacent concepts (if query is about "columns", try "layout", "grid", "kanban").
- Broader technical terms from the context vocabulary list.
- Common misspellings or abbreviations.

Avoid duplicating round-1 variants. Output fresh angles.

Same JSON shape and budget as round 1 (10-20 variants total). Output ONLY the JSON object.`

const SYSTEM_PROMPT_ROUND2_DEEPER = `You are a FTS5 query planner running ROUND 2 in DEEPER mode.

Round 1 found a strong cluster of relevant docs. Your job now is to drill in: mine the
round-1 top snippets for SPECIFIC entities and search for those exact things.

Extract from the round-1 top snippets:
- File paths and filenames (put in "paths").
- Bead IDs (put in "bead_ids").
- Session IDs if shown.
- Distinctive technical identifiers (function names, component names, config keys) — "keywords".
- Exact phrases seen repeatedly — "phrases".
- Error strings — "errors".

Avoid duplicating round-1 variants. Focus on precision over breadth.

Same JSON shape and budget as round 1 (up to 15 variants). Output ONLY the JSON object.`

// ============================================================================
// Public API
// ============================================================================

export interface PlanOptions {
  round: 1 | 2
  mode?: "wider" | "deeper"
  priorPlan?: QueryPlan
  priorResults?: RecallSearchResult[]
  priorVariants?: string[]
  timeoutMs?: number
  /** Force a specific model (v2 feature; currently unused). */
  model?: Model
}

/**
 * Run the planner. Returns `plan: null` if no provider is available or the
 * model response can't be parsed — callers should fall back gracefully.
 */
export async function planQuery(query: string, context: QueryContext, options: PlanOptions): Promise<PlanCall> {
  const { round, mode, priorPlan, priorResults = [], priorVariants = [], timeoutMs = 2500 } = options
  const startedAt = Date.now()

  const model = options.model ?? pickPlannerModel()
  if (!model) {
    return {
      plan: null,
      elapsedMs: Date.now() - startedAt,
      error: "no-planner-model-available",
    }
  }

  const systemPrompt =
    round === 1 ? SYSTEM_PROMPT_ROUND1 : mode === "deeper" ? SYSTEM_PROMPT_ROUND2_DEEPER : SYSTEM_PROMPT_ROUND2_WIDER

  const userPrompt = buildUserPrompt(query, context, { round, mode, priorPlan, priorResults, priorVariants })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let rawResponse = ""
  let cost: number | undefined
  try {
    const result = await queryModel({
      question: userPrompt,
      model,
      systemPrompt,
      abortSignal: controller.signal,
    })
    clearTimeout(timer)

    if (result.response.error) {
      return {
        plan: null,
        model: model.modelId,
        elapsedMs: Date.now() - startedAt,
        error: result.response.error,
      }
    }

    rawResponse = result.response.content ?? ""
    const usage = result.response.usage
    if (usage) {
      cost = estimateCost(model, usage.promptTokens, usage.completionTokens)
    }
  } catch (err) {
    clearTimeout(timer)
    return {
      plan: null,
      model: model.modelId,
      elapsedMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
      rawResponse,
    }
  }

  const plan = parsePlan(rawResponse)
  return {
    plan,
    model: model.modelId,
    elapsedMs: Date.now() - startedAt,
    cost,
    rawResponse,
    error: plan ? undefined : "plan-parse-failed",
  }
}

/**
 * Flatten a plan into a deduped, normalized list of FTS queries.
 * Phrases get wrapped in quotes so FTS5 treats them as exact matches.
 * Bead IDs are emitted verbatim (toFts5Query already handles them).
 */
export function planVariants(plan: QueryPlan): string[] {
  const out = new Set<string>()
  const add = (v: string) => {
    const trimmed = v.trim()
    if (trimmed.length >= 2) out.add(trimmed)
  }

  for (const k of plan.keywords) add(k)
  for (const p of plan.phrases) {
    // Wrap multi-word phrases in quotes; leave single-word through as-is
    if (/\s/.test(p.trim())) add(`"${p.trim()}"`)
    else add(p)
  }
  for (const c of plan.concepts) add(c)
  for (const p of plan.paths) add(p)
  for (const e of plan.errors) {
    // Exact error strings benefit from phrase quoting
    if (/\s/.test(e.trim())) add(`"${e.trim()}"`)
    else add(e)
  }
  for (const b of plan.bead_ids) add(b)

  return [...out]
}

// ============================================================================
// Internals
// ============================================================================

// Planner preference order — prioritizes empirically fastest models for
// short structured-JSON tasks. Haiku consistently beats gpt-5-nano on
// planner-sized prompts (~2s vs 5s+) in current testing.
const PLANNER_PREFERENCE = ["claude-haiku-4-5-20251001", "gemini-2.0-flash-lite", "gpt-5-nano", "grok-3-fast"]

function pickPlannerModel(): Model | undefined {
  for (const id of PLANNER_PREFERENCE) {
    const m = getModel(id)
    if (m && isProviderAvailable(m.provider)) return m
  }

  // Fallback: any available cheap model.
  const cheap = getCheapModel()
  if (cheap && isProviderAvailable(cheap.provider)) return cheap

  for (const m of getCheapModels(5)) {
    if (isProviderAvailable(m.provider)) return m
  }
  return undefined
}

function buildUserPrompt(
  query: string,
  context: QueryContext,
  opts: {
    round: 1 | 2
    mode?: "wider" | "deeper"
    priorPlan?: QueryPlan
    priorResults: RecallSearchResult[]
    priorVariants: string[]
  },
): string {
  const { round, mode, priorPlan, priorResults, priorVariants } = opts
  const parts: string[] = []

  parts.push(`USER QUERY: ${query}`)
  parts.push("")
  parts.push("PROJECT CONTEXT:")
  parts.push(renderContextPrompt(context))

  if (round === 2) {
    parts.push("")
    parts.push(`ROUND 2 (${mode ?? "wider"})`)
    parts.push("")

    if (priorVariants.length > 0) {
      parts.push("Round 1 variants already tried (do NOT repeat these):")
      for (const v of priorVariants) parts.push(`  ${v}`)
      parts.push("")
    }

    if (priorResults.length > 0) {
      parts.push("Round 1 top results (mine these for new keywords):")
      const topN = Math.min(5, priorResults.length)
      for (let i = 0; i < topN; i++) {
        const r = priorResults[i]!
        const sess = r.sessionTitle ? `${r.sessionTitle}` : r.sessionId.slice(0, 8)
        const snippet = r.snippet.replace(/>>>/g, "").replace(/<<</g, "").replace(/\s+/g, " ").trim().slice(0, 400)
        parts.push(`  [${r.type}] ${sess}: ${snippet}`)
      }
      parts.push("")
    } else {
      parts.push("Round 1 returned ZERO results. Round 2 must cast wider — try fundamentally different angles.")
      parts.push("")
    }

    if (priorPlan?.notes) {
      parts.push(`Round 1 notes: ${priorPlan.notes}`)
      parts.push("")
    }
  }

  parts.push("")
  parts.push("Return ONLY the JSON object described in the system prompt.")
  return parts.join("\n")
}

/**
 * Parse the planner response into a QueryPlan. Tolerates:
 *  - plain JSON
 *  - JSON wrapped in ```json fences
 *  - extra prose before/after (extracts first {...} block)
 */
export function parsePlan(raw: string): QueryPlan | null {
  if (!raw) return null

  // Strip code fences
  let text = raw.trim()
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")

  // Find first JSON object
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  const jsonStr = text.slice(start, end + 1)

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>

  const asStringArray = (v: unknown): string[] => {
    if (!Array.isArray(v)) return []
    return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim())
  }

  const plan: QueryPlan = {
    keywords: asStringArray(obj.keywords),
    phrases: asStringArray(obj.phrases),
    concepts: asStringArray(obj.concepts),
    paths: asStringArray(obj.paths),
    errors: asStringArray(obj.errors),
    bead_ids: asStringArray(obj.bead_ids),
    time_hint: typeof obj.time_hint === "string" && obj.time_hint.trim().length > 0 ? obj.time_hint.trim() : null,
    notes: typeof obj.notes === "string" ? obj.notes.trim() : undefined,
  }

  // Reject totally empty plans — parse technically succeeded but output is useless.
  const total =
    plan.keywords.length +
    plan.phrases.length +
    plan.concepts.length +
    plan.paths.length +
    plan.errors.length +
    plan.bead_ids.length
  if (total === 0) return null

  return plan
}
