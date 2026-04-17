/**
 * Lore summarizer — turns a session tail into a short "focus + loose_ends"
 * summary via the cheap-model pool (Haiku by default, or local qwen).
 *
 * Opt-in: gated behind LORE_SUMMARIZER_MODEL env var (off | haiku | local).
 * Default off — daemons don't burn LLM credits unless the user enables it.
 */

import { queryModel } from "../../../../tools/lib/llm/research.ts"
import { getCheapModel, getCheapModels, type Model } from "../../../../tools/lib/llm/types.ts"
import { isProviderAvailable } from "../../../../tools/lib/llm/providers.ts"

export type SummarizerMode = "off" | "haiku" | "local"

export type SessionSummary = {
  focus: string
  looseEnds: string[]
  model: string
  cost: number
}

export function resolveSummarizerMode(raw?: string): SummarizerMode {
  const v = (raw ?? process.env.LORE_SUMMARIZER_MODEL ?? "off").toLowerCase()
  if (v === "haiku" || v === "local") return v as SummarizerMode
  return "off"
}

/**
 * Pick the model to drive summaries for the given mode. Returns null when
 * the mode is "off" or no available provider matches.
 */
export function pickSummaryModel(mode: SummarizerMode): Model | null {
  if (mode === "off") return null
  if (mode === "haiku") {
    const haiku =
      getCheapModels(8).find((m) => /haiku/i.test(m.modelId) && isProviderAvailable(m.provider)) ?? getCheapModel()
    if (!haiku || !isProviderAvailable(haiku.provider)) return null
    return haiku
  }
  // mode === "local" — prefer any ollama-backed model; extend when we add
  // lmstudio to the provider enum.
  const local = getCheapModels(8).find((m) => m.provider === "ollama" && isProviderAvailable(m.provider))
  return local ?? null
}

const SYSTEM_PROMPT = `You are a terse session summarizer. Given the recent tail of a Claude Code
session, output JSON describing what the user is currently working on.

Output format — strict JSON, nothing else:
{
  "focus": "<one-sentence description of the current task>",
  "loose_ends": ["<unfinished thread 1>", "<unfinished thread 2>", ...]
}

Rules:
- "focus" is ONE sentence (max ~20 words). Present tense. Concrete nouns.
- "loose_ends" lists 0–5 short strings. Omit if nothing meaningful is pending.
- No filler ("The user is...", "It appears that..."). Start with a verb when possible.
- If the tail is empty or uninformative, return {"focus": "", "loose_ends": []}.
`.trim()

/**
 * Summarize a flattened session tail. Returns null on model unavailable,
 * empty tail, or parse failure (non-throwing — caller just skips).
 */
export async function summarizeTail(
  tail: string,
  opts: { mode?: SummarizerMode; timeoutMs?: number } = {},
): Promise<SessionSummary | null> {
  const mode = opts.mode ?? resolveSummarizerMode()
  if (mode === "off") return null
  if (!tail || tail.trim().length === 0) return null

  const model = pickSummaryModel(mode)
  if (!model) return null

  const startedAt = Date.now()
  try {
    const result = await queryModel({
      model,
      systemPrompt: SYSTEM_PROMPT,
      question: `TAIL:\n${tail.slice(-4000)}`,
      stream: false,
      abortSignal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    })
    const content = result.response?.content ?? ""
    const parsed = parseSummary(content)
    if (!parsed) return null
    const cost = result.response?.usage?.estimatedCost ?? 0
    return {
      focus: parsed.focus,
      looseEnds: parsed.loose_ends,
      model: model.modelId,
      cost: typeof cost === "number" ? cost : 0,
    }
  } catch (err) {
    if (process.env.LORE_LOG === "1") {
      process.stderr.write(
        `[lore-summarizer] ${model.modelId} failed after ${Date.now() - startedAt}ms: ${err instanceof Error ? err.message : err}\n`,
      )
    }
    return null
  }
}

/**
 * Strict-ish JSON parse. Strips code fences and tolerates trailing whitespace.
 * Returns null if the output isn't the expected shape.
 */
export function parseSummary(raw: string): { focus: string; loose_ends: string[] } | null {
  if (!raw) return null
  let cleaned = raw.trim()
  // Strip ```json ... ``` fences
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/m)
  if (fenceMatch) cleaned = fenceMatch[1]!.trim()
  // Extract first {...} block if more text wraps it
  const jsonStart = cleaned.indexOf("{")
  const jsonEnd = cleaned.lastIndexOf("}")
  if (jsonStart < 0 || jsonEnd < jsonStart) return null
  cleaned = cleaned.slice(jsonStart, jsonEnd + 1)
  try {
    const parsed = JSON.parse(cleaned) as { focus?: unknown; loose_ends?: unknown }
    const focus = typeof parsed.focus === "string" ? parsed.focus.trim() : ""
    const looseRaw = Array.isArray(parsed.loose_ends) ? parsed.loose_ends : []
    const looseEnds = looseRaw
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((s) => s.trim())
    return { focus, loose_ends: looseEnds }
  } catch {
    return null
  }
}
