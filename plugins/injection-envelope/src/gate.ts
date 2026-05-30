/**
 * Pure PreToolUse authority gate for the injection envelope.
 *
 * The km hook wrapper owns stdin/stdout and activity logging. This module owns
 * the deterministic decision logic so bearly can test and typecheck standalone.
 */

import { readTurnManifest, extractEntities, extractShingles, type TurnManifest } from "./manifest.ts"

export interface GateInput {
  /** Claude Code session id — keys the turn-manifest lookup. */
  session_id: string
  /** Tool name from PreToolUse payload (Write, Edit, MultiEdit, Bash, Read, …). */
  tool_name: string
  /** Raw tool_input object — Claude Code passes this through unchanged. */
  tool_input: Record<string, unknown>
}

export type Permission = "allow" | "ask" | "deny"

export interface GateDecision {
  permissionDecision: Permission
  /** Human-readable explanation. Shown to the user on deny/ask. */
  permissionDecisionReason: string
  /**
   * Structured audit fields. Not part of Claude Code's schema, but included
   * so tests can assert why the gate made its call.
   */
  debug?: {
    reasonCode: string
    recallOnlyEntities?: string[]
    candidateInjectedOverlap?: number
    candidateTypedOverlap?: number
  }
}

const MUTATING_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])

/** Regex tokens in a bash command that count as destructive / mutating. */
const DESTRUCTIVE_BASH_RE =
  /\b(rm\s+-r?f?|rmdir|mv\s+[^\s]+\s+[^\s]+|cp\s+[^\s]+\s+[^\s]+|dd\s+|truncate\s+|>>?\s*\/(?!dev\/(?:null|stderr|stdout)\b|tmp\/)|tee\s+|chmod\s+|chown\s+|mkfs\b|dd\s+of=|git\s+(?:reset\s+--hard|checkout\s+\.|clean\s+-[fdx]|push\s+--force|stash\b)|npm\s+publish\b|pnpm\s+publish\b|curl\s+[^|]*\|\s*(sh|bash|zsh)\b|wget\s+[^|]*\|\s*(sh|bash|zsh)\b)/i

function isMutatingTool(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (MUTATING_TOOLS.has(toolName)) return true
  if (toolName === "Bash") {
    const cmd = typeof toolInput.command === "string" ? toolInput.command : ""
    return DESTRUCTIVE_BASH_RE.test(cmd)
  }
  return false
}

/**
 * Pull the string(s) from tool_input that represent the content we care about:
 * the bit that ends up on disk or executed.
 */
function extractCandidateText(toolName: string, toolInput: Record<string, unknown>): string {
  const pieces: string[] = []
  const push = (v: unknown): void => {
    if (typeof v === "string") pieces.push(v)
  }
  switch (toolName) {
    case "Write":
      push(toolInput.content)
      push(toolInput.file_path)
      break
    case "Edit":
      push(toolInput.new_string)
      push(toolInput.file_path)
      break
    case "MultiEdit":
      push(toolInput.file_path)
      if (Array.isArray(toolInput.edits)) {
        for (const e of toolInput.edits as Array<{ new_string?: unknown }>) {
          push(e.new_string)
        }
      }
      break
    case "Bash":
      push(toolInput.command)
      break
    case "NotebookEdit":
      push(toolInput.new_source)
      push(toolInput.notebook_path)
      break
    default:
      for (const v of Object.values(toolInput)) push(v)
  }
  return pieces.join("\n")
}

/** Entities present in any injected span but not in typed text. */
function recallOnlyEntities(manifest: TurnManifest): Set<string> {
  const typed = new Set(manifest.typedEntities.map((e) => e.toLowerCase()))
  const recallOnly = new Set<string>()
  for (const span of manifest.untrustedRecall) {
    for (const e of span.entities) {
      const lc = e.toLowerCase()
      if (!typed.has(lc)) recallOnly.add(lc)
    }
  }
  return recallOnly
}

/** Count shingles that appear in both the candidate and `other`. */
function shingleOverlap(candidate: Set<string>, other: string[]): number {
  let n = 0
  for (const s of other) if (candidate.has(s)) n++
  return n
}

/** Flatten injected shingles across all spans. */
function allInjectedShingles(manifest: TurnManifest): string[] {
  const out: string[] = []
  for (const span of manifest.untrustedRecall) {
    for (const s of span.shingles) out.push(s)
  }
  return out
}

export function evaluateGate(input: GateInput): GateDecision {
  // (A-0) Non-mutating tools are always allowed — the gate only scopes to
  // tools that write to disk or execute destructive shell.
  if (!isMutatingTool(input.tool_name, input.tool_input)) {
    return {
      permissionDecision: "allow",
      permissionDecisionReason: "non-mutating tool",
      debug: { reasonCode: "non-mutating" },
    }
  }

  // (A-1) No manifest — envelope didn't run this turn. Degrade to allow
  // rather than over-block.
  const manifest = readTurnManifest(input.session_id)
  if (!manifest) {
    return {
      permissionDecision: "allow",
      permissionDecisionReason: "no turn manifest — envelope did not run",
      debug: { reasonCode: "no-manifest" },
    }
  }

  // (A-2) Manifest with no injected spans — nothing to guard against.
  if (manifest.untrustedRecall.length === 0) {
    return {
      permissionDecision: "allow",
      permissionDecisionReason: "no injected recall this turn",
      debug: { reasonCode: "no-recall" },
    }
  }

  const candidate = extractCandidateText(input.tool_name, input.tool_input)
  if (!candidate) {
    return {
      permissionDecision: "allow",
      permissionDecisionReason: "no candidate text to inspect",
      debug: { reasonCode: "no-candidate" },
    }
  }

  const candidateEntities = new Set(extractEntities(candidate).map((e) => e.toLowerCase()))
  const candidateShingles = new Set(extractShingles(candidate))
  const recallOnly = recallOnlyEntities(manifest)

  // (B) Candidate references entities that live only in injected spans.
  const hitEntities: string[] = []
  for (const e of candidateEntities) {
    if (recallOnly.has(e)) hitEntities.push(e)
  }
  if (hitEntities.length > 0) {
    return {
      permissionDecision: "deny",
      permissionDecisionReason:
        `Blocked: about to write content referencing ${hitEntities
          .slice(0, 5)
          .map((e) => `"${e}"`)
          .join(", ")} — ` +
        `those entities came from retrieved recall spans, not your typed message. ` +
        `Reply "proceed" to authorize or clarify what you want.`,
      debug: { reasonCode: "recall-only-entity", recallOnlyEntities: hitEntities },
    }
  }

  // (C) Candidate body overlaps the injected spans much more than the typed
  // text, and the user did not explicitly authorize a write.
  const injectedOverlap = shingleOverlap(candidateShingles, allInjectedShingles(manifest))
  const typedOverlap = shingleOverlap(candidateShingles, manifest.typedShingles)
  if (!manifest.explicitWriteAuth && injectedOverlap > 0 && injectedOverlap > typedOverlap * 2) {
    return {
      permissionDecision: "deny",
      permissionDecisionReason:
        `Blocked: proposed content overlaps injected recall (${injectedOverlap} shingles) ` +
        `much more than your typed message (${typedOverlap}). ` +
        `Reply "proceed" to authorize if this really is what you want.`,
      debug: {
        reasonCode: "shingle-overlap",
        candidateInjectedOverlap: injectedOverlap,
        candidateTypedOverlap: typedOverlap,
      },
    }
  }

  // (D) Final guard: no explicit write authorization + injection present +
  // mutating tool.
  if (!manifest.explicitWriteAuth) {
    return {
      permissionDecision: "deny",
      permissionDecisionReason:
        `Blocked: your typed message did not ask for a write. ` +
        `Injected recall spans are present this turn — declining by default. ` +
        `Reply with an explicit "create/edit/write X" if you want to proceed.`,
      debug: { reasonCode: "no-write-auth" },
    }
  }

  return {
    permissionDecision: "allow",
    permissionDecisionReason: "explicit write auth + no recall-only entity overlap",
    debug: { reasonCode: "allow-explicit-auth" },
  }
}
