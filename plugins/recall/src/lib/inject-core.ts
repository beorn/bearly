/**
 * Shared recall-and-format pipeline used by both injection paths:
 *   1. Lore daemon's `lore.inject_delta` (in-memory Map-backed SeenStore)
 *   2. Library `hookRecall` fallback (tmpfile-backed SeenStore)
 *
 * Both paths filter trivial prompts, run an FTS recall, dedup already-shown
 * results against a per-session seen set, format snippets, and return a
 * discriminated result. The only moving part between them is WHERE the
 * seen set lives — pluggable via the `SeenStore` interface.
 */

import { classifyPromptSkip, cleanSnippet, type InjectSkipReason } from "./prompt-filter.ts"
import { recall } from "../history/search.ts"
import { ensureProjectSourcesIndexed } from "../history/project-sources.ts"

/**
 * Abstract seen-set backing store. Implementations must be cheap per-call —
 * `get/set/size` land on the hot path of every UserPromptSubmit.
 */
export interface SeenStore {
  /** Current turn counter for this session. 0 before first call. */
  turn(): number
  /** Advance and return the new turn number. */
  advanceTurn(): number
  /** Last turn at which `key` was marked seen, or undefined. */
  get(key: string): number | undefined
  /** Mark `key` as seen at `turn`. */
  set(key: string, turn: number): void
  /** Current number of keys tracked. */
  size(): number
  /** Drop entries older than `minTurn`. Called opportunistically. */
  gc(minTurn: number): void
  /** Persist any pending state. No-op for in-memory stores. */
  flush?(): void
}

export interface RunInjectDeltaOptions {
  /** Max snippets to include. Default 3. */
  limit?: number
  /** Number of turns a key stays in the seen set. Default 10. */
  ttlTurns?: number
  /** Min length after cleaning to include a snippet. Default 20. */
  minSnippetLength?: number
  /** Chars per snippet. Default 300. */
  snippetChars?: number
}

/** Outcome of a single injection attempt — pure data, no side effects. */
export type RunInjectDeltaResult =
  | { skipped: true; reason: InjectSkipReason }
  | {
      skipped: false
      additionalContext: string
      newKeys: string[]
      turn: number
    }

/**
 * Run the recall + dedup + format pipeline against the supplied seen-store.
 * Pure logic aside from the recall call itself and the store reads/writes;
 * both callers (daemon, hook library) adapt this to their result shape.
 */
export async function runInjectDelta(
  prompt: string,
  store: SeenStore,
  opts: RunInjectDeltaOptions = {},
): Promise<RunInjectDeltaResult> {
  const limitSnippets = opts.limit ?? 3
  const ttlTurns = opts.ttlTurns ?? 10
  const minLength = opts.minSnippetLength ?? 20
  const snippetChars = opts.snippetChars ?? 300

  const skipReason = classifyPromptSkip(prompt)
  if (skipReason) return { skipped: true, reason: skipReason }

  ensureProjectSourcesIndexed()

  const turn = store.advanceTurn()

  const result = await recall(prompt, {
    limit: 5,
    raw: true,
    timeout: 2000,
    snippetTokens: 80,
    json: true,
  })

  if (result.results.length === 0) return { skipped: true, reason: "no_results" }

  const snippets: string[] = []
  const newKeys: string[] = []
  for (const r of result.results) {
    const key = `${r.sessionId}:${r.type}`
    const lastTurn = store.get(key)
    if (lastTurn !== undefined && turn - lastTurn < ttlTurns) continue
    const text = cleanSnippet(r.snippet)
    if (text.length < minLength) continue
    const label = r.sessionTitle ?? r.sessionId.slice(0, 8)
    snippets.push(`[${r.type}] ${label}: ${text.slice(0, snippetChars)}`)
    newKeys.push(key)
    if (snippets.length >= limitSnippets) break
  }

  for (const k of newKeys) store.set(k, turn)

  if (store.size() > 500) store.gc(turn - ttlTurns * 4)
  store.flush?.()

  if (snippets.length === 0) return { skipped: true, reason: "all_seen" }

  return {
    skipped: false,
    additionalContext: `## Session Memory\n\n${snippets.join("\n")}`,
    newKeys,
    turn,
  }
}

// ---------------------------------------------------------------------------
// Ready-made stores
// ---------------------------------------------------------------------------

/**
 * In-memory store for daemon use. Hot-path reads/writes on a Map.
 * One instance per session; the daemon keeps them in a Map<sessionId, ...>.
 */
export function createMemorySeenStore(initial?: { turn: number; seen: Map<string, number> }): SeenStore {
  const state = initial ?? { turn: 0, seen: new Map<string, number>() }
  return {
    turn: () => state.turn,
    advanceTurn: () => ++state.turn,
    get: (k) => state.seen.get(k),
    set: (k, t) => void state.seen.set(k, t),
    size: () => state.seen.size,
    gc: (minTurn) => {
      for (const [k, t] of state.seen) if (t < minTurn) state.seen.delete(k)
    },
  }
}

/**
 * Tmpfile-backed store for the library fallback path. Reads on construction,
 * writes on flush(). Identified by an opaque `sessionId` (pass undefined for
 * an in-memory no-dedup fallback — matches pre-daemon hookRecall semantics
 * when CLAUDE_SESSION_ID isn't set).
 */
export function createTmpfileSeenStore(filePath: string | null): SeenStore {
  // Read once at construction; hookRecall used to read on every call, but
  // hookRecall is itself called once per UserPromptSubmit so one read is
  // the same cost.
  let seen: Record<string, number> = {}
  let turn = 0
  if (filePath) {
    try {
      // Top-level require is fine here — fs is a node builtin.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs")
      const raw = fs.readFileSync(filePath, "utf8")
      const data = JSON.parse(raw) as { seen?: Record<string, number>; turn?: number }
      seen = data.seen ?? {}
      turn = data.turn ?? 0
    } catch {
      // First call in session or corrupt file — reset.
    }
  }
  return {
    turn: () => turn,
    advanceTurn: () => ++turn,
    get: (k) => seen[k],
    set: (k, t) => void (seen[k] = t),
    size: () => Object.keys(seen).length,
    gc: (minTurn) => {
      for (const k in seen) if ((seen[k] ?? 0) < minTurn) delete seen[k]
    },
    flush: () => {
      if (!filePath) return
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("node:fs") as typeof import("node:fs")
        fs.writeFileSync(filePath, JSON.stringify({ turn, seen }))
      } catch {
        // Non-fatal — best-effort persistence.
      }
    },
  }
}
