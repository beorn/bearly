/**
 * Persistence for streaming LLM responses
 *
 * Saves partial responses to temp files during streaming so they aren't lost
 * if the process is interrupted. Supports recovery via OpenAI response ID.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, appendFileSync } from "fs"
import { join } from "path"

const CACHE_DIR = join(process.env.HOME ?? "~", ".cache", "tools")
const PARTIALS_DIR = join(CACHE_DIR, "llm-partials")

export interface PartialMetadata {
  responseId: string
  model: string
  modelId: string
  topic: string
  startedAt: string
  lastSequence?: number
  completedAt?: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export interface PartialFile {
  path: string
  metadata: PartialMetadata
  content: string
}

/**
 * Ensure partials directory exists
 */
function ensureDir(): void {
  mkdirSync(PARTIALS_DIR, { recursive: true })
}

/**
 * Generate a partial file path for a new response
 */
export function getPartialPath(responseId: string): string {
  ensureDir()
  const timestamp = Date.now()
  // Use response ID in filename for easy lookup
  const safeId = responseId.replace(/[^a-zA-Z0-9_-]/g, "_")
  return join(PARTIALS_DIR, `${timestamp}-${safeId}.md`)
}

/**
 * Write initial metadata to partial file
 */
export function writePartialHeader(path: string, metadata: PartialMetadata): void {
  const header = `---
response_id: ${metadata.responseId}
model: ${metadata.model}
model_id: ${metadata.modelId}
topic: ${metadata.topic.slice(0, 200).replace(/\n/g, " ")}
started_at: ${metadata.startedAt}
---

`
  writeFileSync(path, header)
}

/**
 * Append content to partial file
 */
export function appendPartial(path: string, content: string): void {
  appendFileSync(path, content)
}

/**
 * Update metadata in partial file (e.g., sequence number, completion)
 */
export function updatePartialMetadata(path: string, updates: Partial<PartialMetadata>): void {
  if (!existsSync(path)) return

  const content = readFileSync(path, "utf-8")
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return

  const headerContent = match[1]!
  const bodyContent = match[2]!
  const lines = headerContent.split("\n")
  const metadata: Record<string, string> = {}

  for (const line of lines) {
    const colonIdx = line.indexOf(": ")
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx)
      const value = line.slice(colonIdx + 2)
      metadata[key] = value
    }
  }

  // Apply updates
  if (updates.lastSequence !== undefined) {
    metadata["last_sequence"] = String(updates.lastSequence)
  }
  if (updates.completedAt) {
    metadata["completed_at"] = updates.completedAt
  }
  if (updates.usage) {
    metadata["usage_prompt"] = String(updates.usage.promptTokens)
    metadata["usage_completion"] = String(updates.usage.completionTokens)
    metadata["usage_total"] = String(updates.usage.totalTokens)
  }

  // Rebuild file
  const newHeader = Object.entries(metadata)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")

  writeFileSync(path, `---\n${newHeader}\n---\n${bodyContent}`)
}

/**
 * Mark partial as complete and optionally delete it
 */
export function completePartial(
  path: string,
  options: { delete?: boolean; usage?: PartialMetadata["usage"] } = {},
): void {
  if (options.delete) {
    if (existsSync(path)) {
      unlinkSync(path)
    }
  } else {
    updatePartialMetadata(path, {
      completedAt: new Date().toISOString(),
      usage: options.usage,
    })
  }
}

/**
 * Parse a partial file
 */
export function parsePartialFile(path: string): PartialFile | null {
  if (!existsSync(path)) return null

  const content = readFileSync(path, "utf-8")
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return null

  const headerContent = match[1]!
  const bodyContent = match[2] ?? ""
  const lines = headerContent.split("\n")
  const metadata: Record<string, string> = {}

  for (const line of lines) {
    const colonIdx = line.indexOf(": ")
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx)
      const value = line.slice(colonIdx + 2)
      metadata[key] = value
    }
  }

  return {
    path,
    metadata: {
      responseId: metadata["response_id"] || "",
      model: metadata["model"] || "",
      modelId: metadata["model_id"] || "",
      topic: metadata["topic"] || "",
      startedAt: metadata["started_at"] || "",
      lastSequence: metadata["last_sequence"] ? parseInt(metadata["last_sequence"], 10) : undefined,
      completedAt: metadata["completed_at"],
      usage: metadata["usage_total"]
        ? {
            promptTokens: parseInt(metadata["usage_prompt"] || "0", 10),
            completionTokens: parseInt(metadata["usage_completion"] || "0", 10),
            totalTokens: parseInt(metadata["usage_total"] || "0", 10),
          }
        : undefined,
    },
    content: bodyContent,
  }
}

/**
 * List all partial files (incomplete responses)
 */
export function listPartials(options: { includeCompleted?: boolean } = {}): PartialFile[] {
  ensureDir()

  const files = readdirSync(PARTIALS_DIR).filter((f) => f.endsWith(".md"))
  const partials: PartialFile[] = []

  for (const file of files) {
    const path = join(PARTIALS_DIR, file)
    const partial = parsePartialFile(path)
    if (partial) {
      // Skip completed unless requested
      if (!options.includeCompleted && partial.metadata.completedAt) {
        continue
      }
      partials.push(partial)
    }
  }

  // Sort by start time, newest first
  partials.sort((a, b) => {
    const aTime = new Date(a.metadata.startedAt).getTime()
    const bTime = new Date(b.metadata.startedAt).getTime()
    return bTime - aTime
  })

  return partials
}

/**
 * Find partial by response ID
 */
export function findPartialByResponseId(responseId: string): PartialFile | null {
  const partials = listPartials({ includeCompleted: true })
  return partials.find((p) => p.metadata.responseId === responseId) || null
}

/**
 * Clean up old partial files (older than maxAge)
 */
export function cleanupPartials(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
  ensureDir()

  const files = readdirSync(PARTIALS_DIR).filter((f) => f.endsWith(".md"))
  const now = Date.now()
  let deleted = 0

  for (const file of files) {
    const path = join(PARTIALS_DIR, file)
    const partial = parsePartialFile(path)
    if (partial) {
      const age = now - new Date(partial.metadata.startedAt).getTime()
      if (age > maxAgeMs) {
        unlinkSync(path)
        deleted++
      }
    }
  }

  return deleted
}
