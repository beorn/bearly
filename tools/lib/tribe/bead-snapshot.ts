/**
 * Fresh bead-state snapshot helper for the broadcast pipeline.
 *
 * When a chief sends `tribe.send {type: "assign", bead: <id>}`, the daemon
 * enriches the channel envelope with `bead_state` sourced fresh from
 * `.beads/backup/issues.jsonl` at delivery time. The chief's own in-context
 * snapshot of the bead is irrelevant — receivers always see current title,
 * status, priority, and a notes excerpt regardless of how stale the chief's
 * memory is.
 *
 * Why the jsonl file (not `bd show`):
 *   - Already maintained by `bd` and polled by the beads-plugin.
 *   - No subprocess/IPC to break under load or in test sandboxes.
 *   - Robust to bd not being installed on the daemon's host.
 *
 * Best-effort throughout: a missing file, a malformed line, or a bead id that
 * does not match any row returns null and the broadcast pipeline falls back to
 * the existing envelope shape.
 *
 * See bead `km-tribe.task-assignment-stale-snapshot`.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Fresh bead state surfaced on `assign`-typed channel envelopes.
 *
 *   - `title`         — current title (latest jsonl line wins).
 *   - `status`        — `open` / `in_progress` / `closed` etc., as `bd` writes it.
 *   - `priority`      — string form (`"0"`–`"4"`); `null` if missing.
 *   - `notes_excerpt` — first ~600 chars of the notes section. Receivers can
 *                        request the full notes via `bd show <id>` if needed.
 *   - `notes_truncated` — true when `notes_excerpt` was clipped.
 *   - `updated_at`    — last-update timestamp (RFC 3339); `null` if missing.
 */
export type BeadSnapshot = {
  title: string
  status: string
  priority: string | null
  notes_excerpt: string
  notes_truncated: boolean
  updated_at: string | null
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const NOTES_EXCERPT_LIMIT = 600

/** jsonl rows we consume — all fields optional so malformed lines don't throw. */
type IssueLine = {
  id?: unknown
  title?: unknown
  status?: unknown
  priority?: unknown
  notes?: unknown
  updated_at?: unknown
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null
}

function clipNotes(raw: string): { excerpt: string; truncated: boolean } {
  if (raw.length <= NOTES_EXCERPT_LIMIT) return { excerpt: raw, truncated: false }
  return { excerpt: raw.slice(0, NOTES_EXCERPT_LIMIT), truncated: true }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Resolve the path to `.beads/backup/issues.jsonl` rooted at `projectRoot`.
 * Returns null when the file is absent (e.g. project has no beads dir).
 */
export function resolveIssuesJsonlPath(projectRoot: string): string | null {
  const path = resolve(projectRoot, ".beads/backup/issues.jsonl")
  return existsSync(path) ? path : null
}

/**
 * Read the latest snapshot for `beadId` from a `.beads/backup/issues.jsonl`
 * file. The file is a journal — multiple lines per id, with the latest wins
 * (we scan the whole file and take the last match). Returns null on:
 *
 *   - missing file
 *   - read error (permissions, IO)
 *   - bead id not present
 *
 * The implementation is intentionally synchronous + allocation-light: this is
 * called inline on the broadcast tap which runs on every `assign` delivery.
 * For typical beads files (~5-50 KB) the full scan is sub-millisecond.
 */
export function readBeadSnapshot(beadId: string, projectRoot: string): BeadSnapshot | null {
  if (!beadId) return null
  const path = resolveIssuesJsonlPath(projectRoot)
  if (!path) return null

  let content: string
  try {
    content = readFileSync(path, "utf8")
  } catch {
    return null
  }

  let latest: IssueLine | null = null
  // We need the LAST occurrence of beadId in the journal. Scanning forward
  // and overwriting `latest` is simpler than reverse-scanning and avoids
  // off-by-one risk on the last (potentially empty) line.
  for (const line of content.split("\n")) {
    if (!line) continue
    // Cheap pre-filter: a line not containing the id can be skipped without
    // parsing JSON. The id appears in `"id":"<beadId>"` so we accept either a
    // straight match or the `\"id\":\"<beadId>\"` shape.
    if (!line.includes(beadId)) continue
    let parsed: IssueLine
    try {
      parsed = JSON.parse(line) as IssueLine
    } catch {
      continue
    }
    if (parsed.id !== beadId) continue
    latest = parsed
  }

  if (!latest) return null

  const title = asString(latest.title) ?? ""
  const status = asString(latest.status) ?? ""
  const priority = asString(latest.priority)
  const notes = asString(latest.notes) ?? ""
  const updated_at = asString(latest.updated_at)
  const { excerpt, truncated } = clipNotes(notes)

  return {
    title,
    status,
    priority,
    notes_excerpt: excerpt,
    notes_truncated: truncated,
    updated_at,
  }
}
