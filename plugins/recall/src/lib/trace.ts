/**
 * trace.ts — optional post-hoc trace writer.
 *
 * When `RECALL_AGENT_TRACE=1`, writes a JSON trace to
 * `~/.claude/recall-traces/<ISO-timestamp>-<query-hash>.json` so we can
 * build a gold set and compare configurations offline without re-running
 * against live corpora.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"

export interface TracePayload {
  query: string
  options: unknown
  context: {
    chars: number
    sessions: number
    beads: number
    vocabTokens: number
  }
  rounds: RoundTrace[]
  decision: { round2Mode: "wider" | "deeper" | "off"; reason: string }
  /** Which synth path delivered the answer — lets offline eval diff strategies. */
  synthPath?: "speculative-round1" | "fresh-merged" | "single-pass" | "none"
  /** 1 = clean, 2 = speculative was wasted (fresh synth superseded it). */
  synthCallsUsed?: number
  /** True if the answer came from round-1 results (speculative or single-pass). */
  round1ShortCircuited?: boolean
  results: { sessionId: string; type: string; title: string | null; rank: number }[]
  synthesisText: string | null
  timing: {
    planMs: number[]
    fanoutMs: number[]
    synthMs: number
    totalMs: number
  }
  costs: {
    plannerUsd: number
    synthesisUsd: number
    totalUsd: number
  }
}

export interface RoundTrace {
  round: 1 | 2
  mode?: "wider" | "deeper"
  planner: { model: string | null; elapsedMs: number; error?: string }
  plan: unknown
  variants: string[]
  stats: {
    totalQueries: number
    rawHits: number
    uniqueDocs: number
    topCoverage: number
    medianCoverage: number
    msTotal: number
  }
}

/**
 * Write a trace if `RECALL_AGENT_TRACE=1` is set. Returns the written path
 * or null if tracing is disabled or the write fails (errors are swallowed —
 * tracing must never affect search behavior).
 */
export function writeTrace(payload: TracePayload): string | null {
  if (!process.env.RECALL_AGENT_TRACE) return null

  try {
    const dir = path.join(os.homedir(), ".claude", "recall-traces")
    fs.mkdirSync(dir, { recursive: true })

    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    const hash = simpleHash(payload.query).toString(16).padStart(8, "0")
    const file = path.join(dir, `${ts}-${hash}.json`)

    fs.writeFileSync(file, JSON.stringify(payload, null, 2))
    return file
  } catch {
    return null
  }
}

function simpleHash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
