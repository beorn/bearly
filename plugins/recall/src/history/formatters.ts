/**
 * Formatting helpers for project knowledge sources.
 */

import type { BeadRecord } from "./types"

/**
 * Format a bead record into title + searchable content.
 */
export function formatBead(bead: BeadRecord): {
  title: string
  content: string
} {
  const parts: string[] = []

  // Status and type prefix
  const status = bead.status === "closed" ? "CLOSED" : bead.status.toUpperCase()
  const type = bead.issue_type ?? "task"
  const priority = bead.priority !== undefined ? `P${bead.priority}` : ""

  const title = `[${status}] [${type}] ${priority ? `[${priority}] ` : ""}${bead.title}`

  // ID for searchability
  parts.push(`ID: ${bead.id}`)

  // Description
  if (bead.description) {
    parts.push(bead.description)
  }

  // Notes
  if (bead.notes) {
    parts.push(`Notes: ${bead.notes}`)
  }

  // Design
  if (bead.design) {
    parts.push(`Design: ${bead.design}`)
  }

  // Close reason
  if (bead.close_reason) {
    parts.push(`Close reason: ${bead.close_reason}`)
  }

  // Parent
  if (bead.parent) {
    parts.push(`Parent: ${bead.parent}`)
  }

  return { title, content: parts.join("\n\n") }
}

/**
 * Extract the first markdown heading as a title, with fallback.
 */
export function extractMarkdownTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return match?.[1] ?? fallback
}
