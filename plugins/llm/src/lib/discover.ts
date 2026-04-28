/**
 * Auto-discovery + LLM-gated promotion of new model SKUs.
 *
 * Two-stage pipeline (km-bearly.llm-registry-auto-update):
 *
 *   Stage 1 — discovery (called from `performPricingUpdate`):
 *     The pricing scraper already pulls provider doc HTML. After successful
 *     extraction, this module scans the same text for SKUs not in our
 *     registry, infers capability hints from the surrounding paragraph, and
 *     writes `~/.cache/bearly-llm/new-models.json`. Cheap (regex over text
 *     we've already fetched), so it costs nothing on top of the pricing run.
 *
 *   Stage 2 — promotion (`bun llm pro --discover-models [--apply]`):
 *     Reads the artifact, fires a cheap classifier (gpt-5-nano) per
 *     candidate to filter obvious noise (dated snapshots that should map
 *     via apiModelId, deprecated/private-beta entries, garbage pricing).
 *     Without --apply: prints a markdown table for review.
 *     With --apply: writes `/tmp/llm-new-models.patch` — a unified diff the
 *     user reviews and applies via `git apply`.
 *
 * The classifier is gpt-5-nano on purpose. ~$0.0005 per candidate × ~30
 * candidates = $0.02 per scan. Anything more expensive defeats the point of
 * "run weekly to keep the registry fresh."
 *
 * NOT auto-applied. The registry is hand-curated by design — pricing is
 * frozen, capabilities encode dispatch behaviour, and a wrong entry can
 * silently route Pro calls to a non-existent model. Human reviews the diff.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { SKUS, PROVIDER_ENDPOINTS, type Model } from "./types"

// `providers` and `research` are imported lazily inside the LLM-driven
// functions below. Tests that exercise the pure transformation surface
// (capability extraction, discovery, prompt build, parser, table, patch)
// don't need the AI SDK — keeping these out of the static import graph means
// the unit-test file can stay node_modules-free.

// ============================================================================
// Storage
// ============================================================================

const NEW_MODELS_DIR = join(process.env.HOME ?? "~", ".cache", "bearly-llm")
const NEW_MODELS_FILE = join(NEW_MODELS_DIR, "new-models.json")

export interface CapabilityHints {
  webSearch: boolean
  vision: boolean
  deepResearch: boolean
  backgroundApi: boolean
}

export interface DiscoveredCandidate {
  provider: string
  id: string
  displayName: string
  inputPricePerM?: number
  outputPricePerM?: number
  sourceUrl: string
  capabilityHints: CapabilityHints
  /** ~400-char paragraph from the provider doc that mentioned this id. */
  rawSnippet: string
}

export interface NewModelsArtifact {
  discoveredAt: string
  candidates: DiscoveredCandidate[]
}

export function loadNewModelsArtifact(): NewModelsArtifact | null {
  try {
    if (!existsSync(NEW_MODELS_FILE)) return null
    const data = readFileSync(NEW_MODELS_FILE, "utf-8")
    return JSON.parse(data) as NewModelsArtifact
  } catch {
    return null
  }
}

export function saveNewModelsArtifact(artifact: NewModelsArtifact): void {
  mkdirSync(NEW_MODELS_DIR, { recursive: true })
  writeFileSync(NEW_MODELS_FILE, JSON.stringify(artifact, null, 2))
}

export function getNewModelsPath(): string {
  return NEW_MODELS_FILE
}

// ============================================================================
// Capability-hint extraction
// ============================================================================

/**
 * Inspect a paragraph of doc text and infer rough capability hints. These are
 * NOT authoritative — the LLM classifier and (ultimately) the human reviewing
 * the patch decide what lands. They exist so the classifier prompt has more
 * than just "modelId + pricing" to chew on.
 *
 * Patterns are intentionally loose. A doc that says "supports image inputs"
 * fires `vision`; "browsing-enabled" fires `webSearch`; "deep research"
 * (literal phrase) fires `deepResearch`; "background mode" / "responses.create
 * with background" / "async polling" fires `backgroundApi`.
 *
 * False positives are fine — the classifier filters them. False negatives
 * are also fine — the human can edit the diff.
 */
export function extractCapabilityHints(text: string): CapabilityHints {
  const t = text.toLowerCase()
  return {
    webSearch: /\bweb[\s-]?search\b|\bbrowsing\b|\bbrowse the web\b/.test(t),
    vision: /\bvision\b|\bmultimodal\b|\bimage[\s-]?input\b|\baccepts? images?\b/.test(t),
    deepResearch: /\bdeep[\s-]?research\b/.test(t),
    backgroundApi:
      /\bbackground[\s-]?(mode|api)\b|\bresponses\.create\b.*\b(async|background)\b|\basync polling\b/.test(t),
  }
}

// ============================================================================
// Discovery — scan provider doc text for unknown model IDs
// ============================================================================

/**
 * Provider-specific patterns for SKU IDs that look like "real model aliases."
 *
 * Conservative on purpose — false positives in this regex translate directly
 * to classifier spend. The classifier still filters, but skipping obvious
 * non-matches up front saves latency and keeps the artifact readable.
 */
const SKU_PATTERNS: Record<string, RegExp> = {
  openai:
    /\b(gpt-[5-9](?:\.\d+)?(?:-(?:pro|mini|nano|codex|codex-mini|codex-max|turbo|deep-research))?(?:-\d{4}-\d{2}-\d{2})?|o[3-9](?:-(?:pro|mini|deep-research))?(?:-\d{4}-\d{2}-\d{2})?)\b/g,
  anthropic: /\b(claude-(?:opus|sonnet|haiku|3|3-5|3-7|4|4-1|4-5|4-6|5)-[a-z0-9-]{2,40})\b/g,
  google:
    /\b(gemini-[1-9](?:\.\d+)?-(?:pro|flash|flash-lite|nano)(?:-[a-z0-9-]{0,40})?|deep-research-pro-preview-\d{2}-\d{4})\b/g,
  xai: /\b(grok-[3-9](?:\.\d+)?(?:-\d+)?(?:-(?:fast-reasoning|fast|reasoning))?)\b/g,
  perplexity: /\b(sonar(?:-(?:pro|deep-research))?)\b/g,
}

/**
 * Provider doc page input — same shape `performPricingUpdate` produces after
 * stripping HTML.
 */
export interface ProviderPage {
  provider: string
  url: string
  text: string
}

/**
 * Find the slice of `text` surrounding `match` (±200 chars), trimmed to a
 * paragraph-ish boundary. Used as `rawSnippet` so the classifier sees enough
 * context to decide.
 */
function snippetAround(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - 200)
  const end = Math.min(text.length, matchIndex + matchLength + 200)
  return text.slice(start, end).trim()
}

/**
 * Heuristic: turn `gpt-5.5-pro-2026-04-23` into `GPT-5.5 Pro (April 2026)`.
 *
 * We don't try too hard — the classifier and human-review steps catch ugly
 * cases. The display name is just for the markdown table; the actual SKU
 * additions happen via the diff which the human edits anyway.
 */
function inferDisplayName(id: string): string {
  // Strip the trailing date if present.
  const dateMatch = id.match(/-(\d{4})-(\d{2})-(\d{2})$/)
  let core = id
  let dateSuffix = ""
  if (dateMatch) {
    core = id.slice(0, dateMatch.index)
    const month = parseInt(dateMatch[2]!, 10)
    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ]
    if (month >= 1 && month <= 12) {
      dateSuffix = ` (${months[month - 1]} ${dateMatch[1]})`
    }
  }
  // Title-case each segment except known special tokens.
  const titleCase = core
    .split("-")
    .map((seg) => {
      if (/^gpt\d?$/i.test(seg)) return seg.toUpperCase()
      if (/^o\d$/i.test(seg)) return seg.toUpperCase()
      if (seg === "pro") return "Pro"
      if (seg === "mini") return "Mini"
      if (seg === "nano") return "Nano"
      if (seg === "codex") return "Codex"
      if (seg === "max") return "Max"
      if (seg === "fast") return "Fast"
      if (seg === "flash") return "Flash"
      if (seg === "lite") return "Lite"
      if (seg === "preview") return "Preview"
      // For numeric-segment models (gpt-5.5, claude-opus-4-6) preserve casing.
      if (/^[\d.]+$/.test(seg)) return seg
      return seg.charAt(0).toUpperCase() + seg.slice(1)
    })
    .join(" ")
  return `${titleCase}${dateSuffix}`
}

/**
 * Scan a set of provider doc pages for SKU IDs not in our registry. Returns
 * deduplicated candidates with capability hints + snippets. Pure — no I/O.
 */
export function discoverFromPages(pages: ProviderPage[]): DiscoveredCandidate[] {
  const knownIds = new Set(SKUS.map((s) => s.modelId))
  // Also include the apiModelId values — `gpt-5-pro-2025-10-06` is the API
  // alias for our `gpt-5.4-pro` SKU and would otherwise look "new."
  for (const ep of Object.values(PROVIDER_ENDPOINTS)) {
    if (ep.apiModelId) knownIds.add(ep.apiModelId)
  }

  const seen = new Set<string>()
  const out: DiscoveredCandidate[] = []

  for (const page of pages) {
    const pattern = SKU_PATTERNS[page.provider]
    if (!pattern) continue
    // Reset lastIndex (regex is /g, persists across calls).
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(page.text)) !== null) {
      const id = m[1]!
      if (knownIds.has(id) || seen.has(id)) continue
      seen.add(id)
      const snippet = snippetAround(page.text, m.index, id.length)
      out.push({
        provider: page.provider,
        id,
        displayName: inferDisplayName(id),
        sourceUrl: page.url,
        capabilityHints: extractCapabilityHints(snippet),
        rawSnippet: snippet,
      })
    }
  }
  return out
}

// ============================================================================
// Classifier — LLM-gated promotion decision
// ============================================================================

export type ClassifierDecision = "yes" | "no" | "needs-review"

export interface ClassifierResult {
  decision: ClassifierDecision
  reason: string
}

/**
 * Build the classifier prompt for a single candidate. Pure — exposed for tests.
 *
 * Strict-JSON output is requested up front and the rules for "no" / "needs-review"
 * are enumerated explicitly. Parser is forgiving (handles fence wrappers, trailing
 * prose) but the prompt nudges the model toward bare-JSON.
 */
export function buildClassifierPrompt(c: DiscoveredCandidate): string {
  const hints = Object.entries(c.capabilityHints)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ")
  const hintsLine = hints || "(none detected)"
  const inputPrice = c.inputPricePerM != null ? `$${c.inputPricePerM}/M` : "unknown"
  const outputPrice = c.outputPricePerM != null ? `$${c.outputPricePerM}/M` : "unknown"
  return `Should this model be added to the @bearly/llm registry?

Provider: ${c.provider}
ID: ${c.id}
Display: ${c.displayName}
Pricing: input ${inputPrice}, output ${outputPrice}
Capabilities (regex-detected): ${hintsLine}
Doc snippet: ${c.rawSnippet}

Decide: "yes" / "no" / "needs-review"
Reason: 1-2 sentences

Reasons to say "no":
- Dated snapshot of an existing model (e.g., "gpt-5-pro-2025-10-06" should map to "gpt-5-pro" via apiModelId, not be a new SKU)
- Deprecated or sunset
- Private beta / not generally available
- Pricing is wrong (negative, zero, or absurd)

Reasons to say "needs-review":
- Looks plausible but uncertain — capabilities ambiguous, pricing surprising

Output JSON only, no markdown fences:
{ "decision": "yes" | "no" | "needs-review", "reason": "..." }`
}

/**
 * Parse classifier output. Tolerates markdown fences, leading prose, and
 * trailing commentary. Returns `needs-review` with the raw text as reason if
 * we can't pull a valid decision out — failing safe (the human sees it).
 */
export function parseClassifierResult(raw: string): ClassifierResult {
  // Strip fences.
  let text = raw
    .replace(/```json?\n?/gi, "")
    .replace(/```/g, "")
    .trim()
  // Find the first {...} block.
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1)
  }
  try {
    const parsed = JSON.parse(text) as { decision?: unknown; reason?: unknown }
    const decision = parsed.decision
    const reason = typeof parsed.reason === "string" ? parsed.reason : ""
    if (decision === "yes" || decision === "no" || decision === "needs-review") {
      return { decision, reason }
    }
  } catch {
    // fall through
  }
  return {
    decision: "needs-review",
    reason: `(could not parse classifier output: ${raw.slice(0, 120)})`,
  }
}

/**
 * Run the classifier over every candidate, in parallel. Quiet when a candidate
 * fails to classify — it falls back to `needs-review` so the human still sees it.
 *
 * Lazy-imports `./research` so the static import graph (which is what unit
 * tests instantiate) never pulls in the `ai` SDK / provider packages.
 */
export async function classifyCandidates(
  candidates: DiscoveredCandidate[],
  classifierModel: Model,
): Promise<Array<{ candidate: DiscoveredCandidate; result: ClassifierResult }>> {
  const { queryModel } = await import("./research")
  const out = await Promise.all(
    candidates.map(async (candidate) => {
      const prompt = buildClassifierPrompt(candidate)
      try {
        const r = await queryModel({
          question: prompt,
          model: classifierModel,
          systemPrompt:
            "You are a strict registry curator. Output exactly one JSON object with `decision` and `reason` keys.",
        })
        if (r.response.error || !r.response.content) {
          return {
            candidate,
            result: {
              decision: "needs-review" as const,
              reason: `(classifier error: ${r.response.error ?? "empty response"})`,
            },
          }
        }
        return { candidate, result: parseClassifierResult(r.response.content) }
      } catch (e) {
        return {
          candidate,
          result: {
            decision: "needs-review" as const,
            reason: `(classifier threw: ${e instanceof Error ? e.message : String(e)})`,
          },
        }
      }
    }),
  )
  return out
}

/**
 * Pick the cheapest available classifier — `gpt-5-nano` if OpenAI is up,
 * otherwise whatever the "quick" tier resolves to. Never throws — returns
 * `null` if no provider is available, and the caller bails.
 *
 * Lazy-imports `./providers` and `getBestAvailableModel` to keep static
 * imports node_modules-free.
 */
export async function selectClassifierModel(): Promise<Model | null> {
  const { isProviderAvailable } = await import("./providers")
  const { getBestAvailableModel } = await import("./types")
  // Try gpt-5-nano explicitly first.
  if (isProviderAvailable("openai")) {
    const sku = SKUS.find((s) => s.modelId === "gpt-5-nano")
    const ep = sku ? PROVIDER_ENDPOINTS[sku.modelId] : undefined
    if (sku && ep) {
      return { ...sku, provider: ep.provider, apiModelId: ep.apiModelId }
    }
  }
  // Fallback: any available "quick" model.
  const { model } = getBestAvailableModel("quick", isProviderAvailable)
  return model ?? null
}

// ============================================================================
// Markdown table + diff generation
// ============================================================================

/**
 * Format a raw discovery markdown table — every candidate, no LLM filter.
 * Used when `--classify` is NOT passed (default). Cheaper, faster, and lets
 * the human reviewer see the full set without paying classifier tokens.
 *
 * Phase 6 over-engineering review (2026-04-27): the classifier pre-filter
 * had unproven empirical value. Default mode is now raw discovery; the
 * classifier-driven `formatDecisionTable` is opt-in via `--classify`.
 */
export function formatRawDiscoveryTable(candidates: readonly DiscoveredCandidate[]): string {
  if (candidates.length === 0) return "_(no candidates)_\n"
  const header = "| Provider | ID | Display | Pricing in/out | Capabilities |\n" + "| --- | --- | --- | --- | --- |\n"
  const body = candidates
    .map((c) => {
      const caps =
        Object.entries(c.capabilityHints)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(", ") || "—"
      const price =
        c.inputPricePerM != null && c.outputPricePerM != null ? `$${c.inputPricePerM}/$${c.outputPricePerM}` : "?"
      return `| ${c.provider} | \`${c.id}\` | ${c.displayName} | ${price} | ${caps} |`
    })
    .join("\n")
  return header + body + "\n"
}

/**
 * Format a markdown table summarizing classifier decisions. Stable column
 * order so the output is diffable. Used when `--classify` is passed; for
 * the default raw view, see `formatRawDiscoveryTable`.
 */
export function formatDecisionTable(rows: Array<{ candidate: DiscoveredCandidate; result: ClassifierResult }>): string {
  if (rows.length === 0) return "_(no candidates)_\n"
  const header =
    "| Decision | Provider | ID | Display | Pricing in/out | Capabilities | Reason |\n" +
    "| --- | --- | --- | --- | --- | --- | --- |\n"
  const body = rows
    .map(({ candidate: c, result }) => {
      const caps =
        Object.entries(c.capabilityHints)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(", ") || "—"
      const price =
        c.inputPricePerM != null && c.outputPricePerM != null ? `$${c.inputPricePerM}/$${c.outputPricePerM}` : "?"
      const reason = (result.reason || "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160)
      return `| ${result.decision} | ${c.provider} | \`${c.id}\` | ${c.displayName} | ${price} | ${caps} | ${reason} |`
    })
    .join("\n")
  return header + body + "\n"
}

/**
 * Produce a unified-diff patch string adding approved (`yes`) candidates to
 * the SKUS_DATA array and PROVIDER_ENDPOINTS map in `types.ts`.
 *
 * Targets the closing `]` of `const SKUS_DATA: SkuConfig[] = [...]` and the
 * closing `}` of `const ENDPOINTS_DATA: Record<...> = {...}`. We don't try to
 * reformat existing entries — appended rows are added immediately before the
 * close brace/bracket.
 *
 * Output is a `git apply`-shaped unified diff — the user reviews and applies
 * by hand. Pure — does not touch the filesystem.
 */
export function generateRegistryPatch(
  approved: DiscoveredCandidate[],
  typesTsContent: string,
  typesTsPath = "plugins/llm/src/lib/types.ts",
): string {
  if (approved.length === 0) return ""

  const lines = typesTsContent.split("\n")

  // Locate the SKUS_DATA close-bracket. We scan from the SKUS_DATA opening
  // line to the next `^]` — that's the close of the array literal. Robust
  // against the comma-trailing pattern used in the existing entries.
  const skusOpenIdx = lines.findIndex((l) => /^const SKUS_DATA:\s*SkuConfig\[\]\s*=\s*\[/.test(l))
  if (skusOpenIdx < 0) return ""
  let skusCloseIdx = -1
  for (let i = skusOpenIdx + 1; i < lines.length; i++) {
    if (lines[i] === "]") {
      skusCloseIdx = i
      break
    }
  }
  if (skusCloseIdx < 0) return ""

  // Locate the ENDPOINTS_DATA close-brace. Same scanning strategy — first
  // `^}` after the opening line.
  const endpointsOpenIdx = lines.findIndex((l) =>
    /^const ENDPOINTS_DATA:\s*Record<string,\s*ProviderEndpoint>\s*=\s*\{/.test(l),
  )
  if (endpointsOpenIdx < 0) return ""
  let endpointsCloseIdx = -1
  for (let i = endpointsOpenIdx + 1; i < lines.length; i++) {
    if (lines[i] === "}") {
      endpointsCloseIdx = i
      break
    }
  }
  if (endpointsCloseIdx < 0) return ""

  // Build the new SKU entries.
  const skuEntries = approved.map((c) => formatSkuEntry(c)).join("\n")
  const endpointEntries = approved.map((c) => formatEndpointEntry(c)).join("\n")

  // Construct the unified diff. We emit two hunks — one for SKUS_DATA close,
  // one for ENDPOINTS_DATA close. Context lines: 3 above, 3 below (git default).
  const skusHunk = makeHunk(typesTsPath, lines, skusCloseIdx, skuEntries.split("\n"))
  const endpointsHunk = makeHunk(typesTsPath, lines, endpointsCloseIdx, endpointEntries.split("\n"))

  // Note: the second hunk's line numbers must account for the lines added by
  // the first hunk. makeHunk uses pre-edit line numbers; we adjust the second
  // hunk's "after" line count manually.
  const firstAdded = skuEntries.split("\n").length
  return (
    `diff --git a/${typesTsPath} b/${typesTsPath}\n` +
    `--- a/${typesTsPath}\n` +
    `+++ b/${typesTsPath}\n` +
    skusHunk +
    shiftHunkAfterLine(endpointsHunk, firstAdded)
  )
}

function formatSkuEntry(c: DiscoveredCandidate): string {
  const lines: string[] = []
  lines.push(`  // Auto-discovered ${new Date().toISOString().slice(0, 10)} from ${c.sourceUrl}`)
  lines.push(`  {`)
  lines.push(`    modelId: ${JSON.stringify(c.id)},`)
  lines.push(`    displayName: ${JSON.stringify(c.displayName)},`)
  lines.push(`    isDeepResearch: ${c.capabilityHints.deepResearch},`)
  lines.push(`    costTier: "medium",`)
  if (c.inputPricePerM != null) {
    lines.push(`    inputPricePerM: ${c.inputPricePerM},`)
  }
  if (c.outputPricePerM != null) {
    lines.push(`    outputPricePerM: ${c.outputPricePerM},`)
  }
  lines.push(`  },`)
  return lines.join("\n")
}

function formatEndpointEntry(c: DiscoveredCandidate): string {
  const caps: string[] = []
  if (c.capabilityHints.webSearch) caps.push("webSearch: true")
  if (c.capabilityHints.backgroundApi) caps.push("backgroundApi: true")
  if (c.capabilityHints.vision) caps.push("vision: true")
  if (c.capabilityHints.deepResearch) caps.push("deepResearch: true")
  const capsLiteral = caps.length === 0 ? "NO_CAPS" : `{ ...NO_CAPS, ${caps.join(", ")} }`
  return `  ${JSON.stringify(c.id)}: { provider: ${JSON.stringify(c.provider)}, capabilities: ${capsLiteral} },`
}

/**
 * Build a single unified-diff hunk that inserts `addedLines` immediately
 * before line index `beforeIndex` (0-based). 3 lines of context above and
 * below.
 */
function makeHunk(_path: string, origLines: string[], beforeIndex: number, addedLines: string[]): string {
  const ctxBefore = 3
  const ctxAfter = 3
  const startCtx = Math.max(0, beforeIndex - ctxBefore)
  const endCtx = Math.min(origLines.length, beforeIndex + ctxAfter)
  const beforeLines = origLines.slice(startCtx, beforeIndex)
  const afterLines = origLines.slice(beforeIndex, endCtx)

  const oldLen = beforeLines.length + afterLines.length
  const newLen = oldLen + addedLines.length
  const oldStart = startCtx + 1 // 1-based
  const newStart = oldStart

  const out: string[] = []
  out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`)
  for (const l of beforeLines) out.push(` ${l}`)
  for (const l of addedLines) out.push(`+${l}`)
  for (const l of afterLines) out.push(` ${l}`)
  return out.join("\n") + "\n"
}

/**
 * Shift the `+newStart` of a single-hunk header by `delta`. The new-file line
 * numbers depend on prior hunks' insertions; pre-edit (`-`) numbers stay put.
 */
function shiftHunkAfterLine(hunk: string, delta: number): string {
  return hunk.replace(
    /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/m,
    (_match, oldStart: string, oldLen: string, newStart: string, newLen: string) => {
      const ns = parseInt(newStart, 10) + delta
      return `@@ -${oldStart},${oldLen} +${ns},${newLen} @@`
    },
  )
}

// ============================================================================
// Discovery integration — called from performPricingUpdate after scrape
// ============================================================================

/**
 * Run discovery on the same `pageTexts` array `performPricingUpdate` builds
 * (each entry is `[PROVIDER — URL]\nbody`). Splits the format back out, runs
 * `discoverFromPages`, and persists the artifact.
 *
 * Best-effort — returns `null` and writes nothing if parsing fails. Never
 * throws (the parent pricing-update flow shouldn't break because discovery
 * tripped on an unexpected provider format).
 */
export function performDiscovery(pageTexts: string[]): NewModelsArtifact | null {
  try {
    const pages: ProviderPage[] = []
    for (const block of pageTexts) {
      const m = block.match(/^\[([A-Z]+)\s*—\s*(\S+)\]\n([\s\S]*)$/)
      if (!m) continue
      pages.push({
        provider: m[1]!.toLowerCase(),
        url: m[2]!,
        text: m[3]!,
      })
    }
    const candidates = discoverFromPages(pages)
    const artifact: NewModelsArtifact = {
      discoveredAt: new Date().toISOString(),
      candidates,
    }
    saveNewModelsArtifact(artifact)
    return artifact
  } catch {
    return null
  }
}
