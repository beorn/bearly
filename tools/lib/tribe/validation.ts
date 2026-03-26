/**
 * Tribe input validation — name format and message sanitization.
 */

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function validateName(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9_.-]{0,31}$/.test(name)) {
    return "Name must be 1-32 chars: lowercase letters, digits, hyphens, underscores, dots. Must start with letter or digit."
  }
  return null
}

export function sanitizeMessage(content: string): string {
  // Strip control chars except newlines
  const cleaned = content.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "")
  // Cap at 4096 chars
  if (cleaned.length > 4096) return cleaned.slice(0, 4093) + "..."
  return cleaned
}
