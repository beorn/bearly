/**
 * Turn manifest — persisted at UserPromptSubmit time, consumed at
 * PreToolUse time by the authority gate.
 *
 * The manifest lets the gate answer the pivotal question: did the user
 * actually ask for the thing the model is about to do? Or is the
 * authority coming from injected recall content?
 *
 * Lifecycle:
 *   1. UserPromptSubmit hook calls `wrapInjectedContext(...)`.
 *   2. The envelope library writes a manifest keyed by session id with
 *      the typed text, extracted entities, shingles for overlap tests,
 *      and the injected spans (with their own entities + shingles).
 *   3. PreToolUse hook reads the manifest, inspects the pending tool's
 *      args, and applies the gate heuristics.
 *   4. PostToolUse (or next UserPromptSubmit) clears the manifest.
 *
 * Stored as JSON under `$BEARLY_SESSIONS_DIR` (default
 * `~/.claude/bearly-sessions/`). One file per session.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Metadata about one injected span surfaced this turn. */
export interface InjectedSpan {
  /** Which hook/channel emitted this span. See RegisteredSource. */
  source: string
  /** Entities extracted from the span's content (lowercased, deduped). */
  entities: string[]
  /** 4-gram hashes of the span's content for overlap detection. */
  shingles: string[]
  /** Raw snippet (truncated) — useful for audit logs, not for decision logic. */
  snippet?: string
}

/** The full per-turn record consumed by the PreToolUse authority gate. */
export interface TurnManifest {
  /** Exactly what the user typed this turn. No hook additions, no tool output. */
  typedUserText: string
  /** Entities (names, file paths, task sigils, rare tokens) from typed text. */
  typedEntities: string[]
  /** 4-gram shingles of typed text for lexical-overlap comparison. */
  typedShingles: string[]
  /**
   * True iff the typed text looks like an explicit write authorization
   * ("create X", "write the file", "edit Y", "add Z to Q"). Heuristic;
   * the gate treats true here as necessary but not sufficient.
   */
  explicitWriteAuth: boolean
  /** All untrusted spans injected this turn, one per item (not per source). */
  untrustedRecall: InjectedSpan[]
  /** Milliseconds since epoch when the manifest was written. */
  ts: number
}

/**
 * Default location of the manifest directory. Override with
 * `BEARLY_SESSIONS_DIR` env var — used by tests and by anyone who wants
 * to put these files somewhere other than `~/.claude/bearly-sessions/`.
 */
export function sessionsDir(): string {
  return process.env.BEARLY_SESSIONS_DIR ?? join(homedir(), ".claude", "bearly-sessions")
}

/** Guard against `../` / absolute / separator-containing sessionIds. */
function assertSafeSessionId(sessionId: string): void {
  if (!sessionId) throw new Error("sessionId is required")
  if (sessionId.includes("/") || sessionId.includes("\\")) {
    throw new Error(`sessionId must not contain path separators: ${sessionId}`)
  }
  if (sessionId.startsWith(".")) {
    throw new Error(`sessionId must not start with a dot: ${sessionId}`)
  }
}

/**
 * Deterministic path for a session's manifest. Useful for both readers
 * (the gate) and for tests that want to assert file layout.
 */
export function turnManifestPathForSession(sessionId: string): string {
  assertSafeSessionId(sessionId)
  return join(sessionsDir(), `turn-manifest-${sessionId}.json`)
}

/**
 * Persist the manifest for a session. Overwrites any prior manifest —
 * the "current" turn is always the most recent write. Best-effort:
 * failures do not throw (never block a user prompt).
 */
export function writeTurnManifest(sessionId: string, manifest: TurnManifest): void {
  try {
    mkdirSync(sessionsDir(), { recursive: true })
    const p = turnManifestPathForSession(sessionId)
    writeFileSync(p, JSON.stringify(manifest), { mode: 0o600 })
  } catch {
    // Never block the hook over manifest IO. Gate will degrade to
    // no-manifest mode (conservative: block mutating tools when unsure).
  }
}

/** Read the manifest for a session, or null if missing / malformed. */
export function readTurnManifest(sessionId: string): TurnManifest | null {
  try {
    const p = turnManifestPathForSession(sessionId)
    const raw = readFileSync(p, "utf8")
    const parsed = JSON.parse(raw) as TurnManifest
    if (typeof parsed !== "object" || parsed === null) return null
    if (typeof parsed.typedUserText !== "string") return null
    if (!Array.isArray(parsed.typedEntities)) return null
    if (!Array.isArray(parsed.typedShingles)) return null
    if (!Array.isArray(parsed.untrustedRecall)) return null
    return parsed
  } catch {
    return null
  }
}

/** Remove the manifest for a session. No-op if absent. */
export function clearTurnManifest(sessionId: string): void {
  try {
    rmSync(turnManifestPathForSession(sessionId), { force: true })
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Entity + shingle extraction — shared between emit + gate
// ---------------------------------------------------------------------------

const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "this",
  "to",
  "we",
  "what",
  "when",
  "where",
  "why",
  "will",
  "with",
  "you",
  "your",
])

/**
 * Extract entity-like tokens from text: file paths, dotted IDs, names
 * (TitleCase multi-word), bead-style sigils (km-scope.suffix), and
 * uncommon multi-syllable words. Returned lowercased + deduped.
 *
 * Heuristic. The gate uses entity overlap to detect "this content
 * references things that are only in injected recall, not in typed
 * text". False positives cost a confirmation prompt; false negatives
 * cost the whole defense.
 */
export function extractEntities(text: string): string[] {
  if (!text) return []
  const out = new Set<string>()

  // File paths (contain / or . with a recognisable extension)
  for (const m of text.matchAll(/([\w.@/-]+\.(md|ts|tsx|js|jsx|json|sh|py|rs|go|toml|yml|yaml|txt|mdx))\b/gi)) {
    out.add(m[1]!.toLowerCase())
    const base = m[1]!.split("/").pop()
    if (base) out.add(base.toLowerCase())
  }

  // Dotted sigils (bead IDs, namespaces): km-scope.suffix, foo.bar.baz
  for (const m of text.matchAll(/\b([a-z][\w-]*\.[\w.-]+)\b/gi)) {
    out.add(m[1]!.toLowerCase())
  }

  // TitleCase names (possibly multi-word): "Gerd Leonhard", "Dan Hu"
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g)) {
    out.add(m[1]!.toLowerCase())
  }

  // Hash-like / uppercase sigils (@Next, #tag, $var)
  for (const m of text.matchAll(/([@#$][\w-]+)/g)) {
    out.add(m[1]!.toLowerCase())
  }

  // Long uncommon-ish words (≥7 chars, non-stopwords)
  for (const m of text.matchAll(/\b([a-zA-Z][a-zA-Z0-9-]{6,})\b/g)) {
    const w = m[1]!.toLowerCase()
    if (!STOPWORDS.has(w)) out.add(w)
  }

  return Array.from(out)
}

/**
 * 4-gram (by word) shingle hashes of text. Used to measure lexical
 * overlap between typed text and injected recall — if a candidate
 * mutation's content overlaps strongly with recall shingles and weakly
 * with typed shingles, that's evidence of injection-driven authority.
 *
 * Hash is a cheap 32-bit FNV-like mix returned as a zero-padded hex
 * string. Collisions don't matter for the overlap heuristic; we're not
 * using these cryptographically.
 */
export function extractShingles(text: string, n: number = 4): string[] {
  if (!text) return []
  const words = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0)
  if (words.length < n) return []
  const out = new Set<string>()
  for (let i = 0; i <= words.length - n; i++) {
    const gram = words.slice(i, i + n).join(" ")
    out.add(fnv1a32(gram))
  }
  return Array.from(out)
}

/** 32-bit FNV-1a — cheap non-cryptographic hash. Returned as 8-char hex. */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/**
 * Heuristic "did the typed text ask for a write?"
 *
 * Matches common mutation verbs in imperative / modal / question-shaped
 * positions. Question-shaped mutation asks ("can you add X?") still
 * count as authorization.
 *
 * Returns true on:
 *   "create foo.md"
 *   "can you edit the file?"
 *   "please add this to X"
 *   "write a short summary"
 *   "update the bead"
 *
 * Returns false on:
 *   "what is the status?"
 *   "summarize these notes"   (summarize alone doesn't imply file mutation)
 *   "tell me about X"
 */
export function looksLikeExplicitWriteAuth(typedText: string): boolean {
  if (!typedText) return false
  const t = typedText.toLowerCase()
  // Slash-command invocations are explicit user intent. When the command
  // itself implies mutation (filing, grooming, closing tasks, etc.) treat
  // the invocation as authorization without requiring additional verbs.
  const mutatingSlashRe =
    /<command-name>\/(file|inbox|groom|mark|close|defer|checkoff|sort|rename|due|fix|apply|do|bl)\b/
  if (mutatingSlashRe.test(t)) return true
  // Verbs that plausibly imply filesystem/store mutation
  const verbRe =
    /\b(create|write|add|edit|update|modify|delete|remove|append|patch|rewrite|generate|rename|apply|land)\b/
  return verbRe.test(t)
}
