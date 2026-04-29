/**
 * recall-shared.ts - Shared logging, constants, and types used across recall modules
 */

import type { ContentType } from "./types.ts"

// ============================================================================
// Logging
// ============================================================================

let _logEnabled = true
export function setRecallLogging(enabled: boolean): void {
  _logEnabled = enabled
}
export function log(msg: string): void {
  if (_logEnabled) console.error(`[recall] ${msg}`)
}

// ============================================================================
// Time constants
// ============================================================================

export const ONE_HOUR_MS = 60 * 60 * 1000
export const ONE_DAY_MS = 24 * ONE_HOUR_MS
export const THIRTY_DAYS_MS = 30 * ONE_DAY_MS

// ============================================================================
// Types
// ============================================================================

export interface RecallOptions {
  limit?: number // Max results to include (default 10)
  raw?: boolean // Return raw results without LLM synthesis
  since?: string // Time filter (1h, 1d, 1w, etc.)
  json?: boolean // Return structured JSON
  timeout?: number // Total timeout in ms (default 4000)
  snippetTokens?: number // Snippet window size (default 200)
  projectFilter?: string // Project filter
  excludeCurrentSession?: boolean // Drop matches from CLAUDE_SESSION_ID (default false)
}

export interface RecallResult {
  query: string
  synthesis: string | null // LLM synthesis (null if raw mode or no results)
  results: RecallSearchResult[]
  durationMs: number
  llmCost?: number
  timing?: {
    searchMs: number
    llmMs?: number
  }
}

export interface RecallSearchResult {
  type: ContentType
  sessionId: string
  sessionTitle: string | null
  timestamp: number
  snippet: string
  rank: number
}
