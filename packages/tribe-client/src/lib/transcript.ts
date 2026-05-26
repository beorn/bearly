/**
 * Transcript path resolution + slug read — pure file-reading helpers used
 * by the stdio-adapter at startup to recover the session's `customTitle`
 * slug from its own JSONL transcript.
 *
 * Extracted from `tools/lib/tribe/session.ts` (which carries
 * TribeContext-coupled helpers that don't belong in the client surface).
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export function resolveTranscriptPath(claudeSessionId: string | null): string | null {
  if (!claudeSessionId) return null
  const cwd = process.cwd()
  const projectKey = "-" + cwd.replace(/\//g, "-")
  const transcriptPath = resolve(process.env.HOME ?? "~", ".claude/projects", projectKey, `${claudeSessionId}.jsonl`)
  return existsSync(transcriptPath) ? transcriptPath : null
}

/** Read the slug from the transcript — used once at startup to set initial name */
export function readTranscriptSlug(transcriptPath: string | null): string | null {
  if (!transcriptPath) return null
  try {
    const size = Bun.file(transcriptPath).size
    if (size === 0) return null
    const text = new TextDecoder().decode(
      new Uint8Array(readFileSync(transcriptPath).buffer.slice(Math.max(0, size - 4096))),
    )
    const lines = text.trimEnd().split("\n")
    const lastLine = lines[lines.length - 1]
    if (!lastLine) return null
    const data = JSON.parse(lastLine) as { slug?: string }
    return data.slug ?? null
  } catch {
    return null
  }
}
