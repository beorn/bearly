/**
 * Unit tests for the auto-discovery + LLM-gated promotion pipeline
 * (km-bearly.llm-registry-auto-update). Pure modules — no network, no LLM.
 *
 * Coverage:
 *   - Capability-hint regex (`extractCapabilityHints`)
 *   - SKU discovery from synthetic provider doc text (`discoverFromPages`)
 *   - Classifier prompt building (`buildClassifierPrompt`)
 *   - Classifier output parsing — well-formed, fenced, malformed
 *     (`parseClassifierResult`)
 *   - Markdown decision table formatting (`formatDecisionTable`)
 *   - Unified-diff patch generation (`generateRegistryPatch`)
 *
 * The classifier and the discovery side-effect path (filesystem) are NOT
 * tested here — those go through `queryModel` and the real `~/.cache` dir.
 * They're integration concerns covered by smoke tests.
 */

import { describe, it, expect } from "vitest"
import {
  extractCapabilityHints,
  discoverFromPages,
  buildClassifierPrompt,
  parseClassifierResult,
  formatDecisionTable,
  generateRegistryPatch,
  type DiscoveredCandidate,
  type ProviderPage,
} from "../src/lib/discover"

// ============================================================================
// extractCapabilityHints
// ============================================================================

describe("extractCapabilityHints", () => {
  it("detects web search from doc text", () => {
    const hints = extractCapabilityHints("This model supports web search and browsing.")
    expect(hints.webSearch).toBe(true)
    expect(hints.vision).toBe(false)
  })

  it("detects vision from 'multimodal' or 'image'", () => {
    expect(extractCapabilityHints("Multimodal model accepting text and images.").vision).toBe(true)
    expect(extractCapabilityHints("Accepts image inputs alongside text.").vision).toBe(true)
    expect(extractCapabilityHints("Vision-enabled model.").vision).toBe(true)
  })

  it("detects deep research from the literal phrase", () => {
    expect(extractCapabilityHints("Deep research with citations.").deepResearch).toBe(true)
    expect(extractCapabilityHints("deep-research model").deepResearch).toBe(true)
  })

  it("detects background API from various phrasings", () => {
    expect(extractCapabilityHints("Use background mode for long-running calls.").backgroundApi).toBe(true)
    expect(extractCapabilityHints("Async polling supported.").backgroundApi).toBe(true)
  })

  it("returns all-false for plain text with no markers", () => {
    const hints = extractCapabilityHints("Reliable text completions.")
    expect(hints).toEqual({ webSearch: false, vision: false, deepResearch: false, backgroundApi: false })
  })

  it("is case-insensitive", () => {
    expect(extractCapabilityHints("WEB SEARCH").webSearch).toBe(true)
    expect(extractCapabilityHints("VISION").vision).toBe(true)
  })
})

// ============================================================================
// discoverFromPages
// ============================================================================

describe("discoverFromPages", () => {
  it("finds new OpenAI SKU IDs not in registry", () => {
    // gpt-9.0 is intentionally fictional so it can't collide with the real
    // registry as the codebase rolls forward.
    const pages: ProviderPage[] = [
      {
        provider: "openai",
        url: "https://openai.com/api/pricing/",
        text: "Introducing gpt-9.0-pro, our latest model. Web search supported.",
      },
    ]
    const candidates = discoverFromPages(pages)
    const ids = candidates.map((c) => c.id)
    expect(ids).toContain("gpt-9.0-pro")
  })

  it("skips IDs already in the SKU registry", () => {
    const pages: ProviderPage[] = [
      {
        provider: "openai",
        url: "https://openai.com/api/pricing/",
        text: "gpt-5.4 and gpt-5.5 are both available.",
      },
    ]
    const candidates = discoverFromPages(pages)
    expect(candidates.find((c) => c.id === "gpt-5.4")).toBeUndefined()
    expect(candidates.find((c) => c.id === "gpt-5.5")).toBeUndefined()
  })

  it("skips dated snapshots that are exact apiModelId aliases", () => {
    // `gpt-5-pro` (the bare apiModelId for our gpt-5.4-pro SKU) is in the
    // skip set even though the SKU id is gpt-5.4-pro. Dated snapshots are
    // discovered (the classifier filters them) — bare apiModelId aliases
    // are NOT discovered (already known to dispatch).
    const pages: ProviderPage[] = [
      {
        provider: "openai",
        url: "https://openai.com/api/pricing/",
        text: "The bare alias gpt-5-pro routes our pro tier.",
      },
    ]
    const candidates = discoverFromPages(pages)
    expect(candidates.find((c) => c.id === "gpt-5-pro")).toBeUndefined()
  })

  it("attaches capability hints from the surrounding paragraph", () => {
    const pages: ProviderPage[] = [
      {
        provider: "openai",
        url: "https://openai.com/api/pricing/",
        text: "The gpt-9.5 model supports web search and vision (multimodal images).",
      },
    ]
    const candidates = discoverFromPages(pages)
    const c = candidates.find((c) => c.id === "gpt-9.5")
    expect(c).toBeDefined()
    expect(c!.capabilityHints.webSearch).toBe(true)
    expect(c!.capabilityHints.vision).toBe(true)
  })

  it("deduplicates IDs that appear multiple times across pages", () => {
    const pages: ProviderPage[] = [
      {
        provider: "openai",
        url: "https://openai.com/api/pricing/",
        text: "The gpt-9.7-mini is great. Use gpt-9.7-mini for speed.",
      },
    ]
    const candidates = discoverFromPages(pages)
    const occurrences = candidates.filter((c) => c.id === "gpt-9.7-mini").length
    expect(occurrences).toBe(1)
  })

  it("supports anthropic, google, xai, perplexity providers", () => {
    const pages: ProviderPage[] = [
      {
        provider: "anthropic",
        url: "https://www.anthropic.com/pricing",
        text: "Try claude-opus-5-future for advanced tasks.",
      },
      {
        provider: "google",
        url: "https://ai.google.dev/pricing",
        text: "gemini-9.9-flash is fast and cheap.",
      },
      {
        provider: "xai",
        url: "https://x.ai/api",
        text: "grok-9-fast-reasoning released today.",
      },
    ]
    const candidates = discoverFromPages(pages)
    expect(candidates.find((c) => c.id === "claude-opus-5-future")).toBeDefined()
    expect(candidates.find((c) => c.id === "gemini-9.9-flash")).toBeDefined()
    expect(candidates.find((c) => c.id === "grok-9-fast-reasoning")).toBeDefined()
  })

  it("ignores pages with unknown provider", () => {
    const pages: ProviderPage[] = [
      {
        provider: "unknown-provider",
        url: "https://example.com",
        text: "gpt-9.0 mentioned here but provider is unknown.",
      },
    ]
    expect(discoverFromPages(pages)).toEqual([])
  })

  it("infers a display name from the model id", () => {
    const pages: ProviderPage[] = [
      {
        provider: "openai",
        url: "https://openai.com/api/pricing/",
        text: "gpt-9.5-pro-2026-04-23 is the new release.",
      },
    ]
    const c = discoverFromPages(pages).find((c) => c.id === "gpt-9.5-pro-2026-04-23")
    expect(c?.displayName).toMatch(/GPT.*Pro.*April 2026/)
  })
})

// ============================================================================
// buildClassifierPrompt
// ============================================================================

describe("buildClassifierPrompt", () => {
  const sample: DiscoveredCandidate = {
    provider: "openai",
    id: "gpt-9.0",
    displayName: "GPT-9.0",
    inputPricePerM: 5.0,
    outputPricePerM: 30.0,
    sourceUrl: "https://openai.com/api/pricing/",
    capabilityHints: { webSearch: true, vision: true, deepResearch: false, backgroundApi: false },
    rawSnippet: "GPT-9.0 supports web search and vision.",
  }

  it("includes provider, id, display, pricing, capabilities, snippet", () => {
    const prompt = buildClassifierPrompt(sample)
    expect(prompt).toContain("Provider: openai")
    expect(prompt).toContain("ID: gpt-9.0")
    expect(prompt).toContain("Display: GPT-9.0")
    expect(prompt).toContain("$5/M")
    expect(prompt).toContain("$30/M")
    expect(prompt).toContain("webSearch")
    expect(prompt).toContain("vision")
    expect(prompt).toContain("Doc snippet:")
    expect(prompt).toContain(sample.rawSnippet)
  })

  it("enumerates 'no' rejection reasons explicitly", () => {
    const prompt = buildClassifierPrompt(sample)
    expect(prompt).toContain("Dated snapshot")
    expect(prompt).toContain("Deprecated")
    expect(prompt).toContain("Private beta")
  })

  it("requests JSON output with decision/reason keys", () => {
    const prompt = buildClassifierPrompt(sample)
    expect(prompt).toContain('"decision"')
    expect(prompt).toContain('"reason"')
  })

  it("handles missing pricing without crashing", () => {
    const c: DiscoveredCandidate = { ...sample, inputPricePerM: undefined, outputPricePerM: undefined }
    const prompt = buildClassifierPrompt(c)
    expect(prompt).toContain("unknown")
  })

  it("handles all-false capabilities", () => {
    const c: DiscoveredCandidate = {
      ...sample,
      capabilityHints: { webSearch: false, vision: false, deepResearch: false, backgroundApi: false },
    }
    const prompt = buildClassifierPrompt(c)
    expect(prompt).toContain("(none detected)")
  })
})

// ============================================================================
// parseClassifierResult
// ============================================================================

describe("parseClassifierResult", () => {
  it("parses a clean yes decision", () => {
    const r = parseClassifierResult('{"decision": "yes", "reason": "Looks legit."}')
    expect(r.decision).toBe("yes")
    expect(r.reason).toBe("Looks legit.")
  })

  it("parses a no decision", () => {
    const r = parseClassifierResult('{"decision": "no", "reason": "Dated snapshot."}')
    expect(r.decision).toBe("no")
  })

  it("parses needs-review", () => {
    const r = parseClassifierResult('{"decision": "needs-review", "reason": "Pricing surprising."}')
    expect(r.decision).toBe("needs-review")
  })

  it("strips markdown json fences", () => {
    const r = parseClassifierResult('```json\n{"decision": "yes", "reason": "ok"}\n```')
    expect(r.decision).toBe("yes")
  })

  it("extracts JSON from surrounding prose", () => {
    const r = parseClassifierResult(
      'Sure, here is my decision: {"decision": "no", "reason": "deprecated"}. Hope that helps!',
    )
    expect(r.decision).toBe("no")
  })

  it("returns needs-review for malformed JSON", () => {
    const r = parseClassifierResult("not json at all")
    expect(r.decision).toBe("needs-review")
    expect(r.reason).toMatch(/could not parse/i)
  })

  it("returns needs-review for unknown decision values", () => {
    const r = parseClassifierResult('{"decision": "maybe", "reason": "I dunno"}')
    expect(r.decision).toBe("needs-review")
  })

  it("handles missing reason field", () => {
    const r = parseClassifierResult('{"decision": "yes"}')
    expect(r.decision).toBe("yes")
    expect(r.reason).toBe("")
  })
})

// ============================================================================
// formatDecisionTable
// ============================================================================

describe("formatDecisionTable", () => {
  const candidate: DiscoveredCandidate = {
    provider: "openai",
    id: "gpt-9.0",
    displayName: "GPT-9.0",
    inputPricePerM: 5.0,
    outputPricePerM: 30.0,
    sourceUrl: "https://openai.com/api/pricing/",
    capabilityHints: { webSearch: true, vision: false, deepResearch: false, backgroundApi: false },
    rawSnippet: "snippet",
  }

  it("renders an empty placeholder for no rows", () => {
    expect(formatDecisionTable([])).toContain("(no candidates)")
  })

  it("renders a markdown table header with 7 columns", () => {
    const out = formatDecisionTable([{ candidate, result: { decision: "yes", reason: "ok" } }])
    expect(out).toContain("| Decision | Provider | ID | Display |")
    expect(out).toContain("| --- |")
  })

  it("includes the decision and id in each row", () => {
    const out = formatDecisionTable([{ candidate, result: { decision: "yes", reason: "ok" } }])
    expect(out).toContain("| yes |")
    expect(out).toContain("`gpt-9.0`")
  })

  it("escapes pipe characters in reasons", () => {
    const out = formatDecisionTable([
      { candidate, result: { decision: "no", reason: "has | pipe" } },
    ])
    expect(out).toContain("has \\| pipe")
  })
})

// ============================================================================
// generateRegistryPatch
// ============================================================================

describe("generateRegistryPatch", () => {
  // Synthetic types.ts shape — minimal but parseable by the patch generator.
  // The generator hunts for `^const SKUS_DATA: SkuConfig[] = [` ... `^]` and
  // `^const ENDPOINTS_DATA: Record<string, ProviderEndpoint> = {` ... `^}`.
  const fakeTypesContent = [
    "// header comment",
    "const NO_CAPS = {}",
    "",
    "const SKUS_DATA: SkuConfig[] = [",
    "  {",
    "    modelId: \"gpt-5\",",
    "    displayName: \"GPT-5\",",
    "  },",
    "]",
    "",
    "const ENDPOINTS_DATA: Record<string, ProviderEndpoint> = {",
    "  \"gpt-5\": { provider: \"openai\", capabilities: NO_CAPS },",
    "}",
    "",
    "// footer",
  ].join("\n")

  const candidate: DiscoveredCandidate = {
    provider: "openai",
    id: "gpt-9.0",
    displayName: "GPT-9.0",
    inputPricePerM: 5.0,
    outputPricePerM: 30.0,
    sourceUrl: "https://openai.com/api/pricing/",
    capabilityHints: { webSearch: true, vision: true, deepResearch: false, backgroundApi: false },
    rawSnippet: "snippet",
  }

  it("returns empty string when no candidates approved", () => {
    expect(generateRegistryPatch([], fakeTypesContent)).toBe("")
  })

  it("emits a unified-diff header (--- / +++)", () => {
    const patch = generateRegistryPatch([candidate], fakeTypesContent)
    expect(patch).toContain("diff --git a/plugins/llm/src/lib/types.ts b/plugins/llm/src/lib/types.ts")
    expect(patch).toContain("--- a/plugins/llm/src/lib/types.ts")
    expect(patch).toContain("+++ b/plugins/llm/src/lib/types.ts")
  })

  it("includes the new SKU entry as added lines (+ prefix)", () => {
    const patch = generateRegistryPatch([candidate], fakeTypesContent)
    expect(patch).toContain('+    modelId: "gpt-9.0",')
    expect(patch).toContain('+    displayName: "GPT-9.0",')
    expect(patch).toContain("+    inputPricePerM: 5,")
    expect(patch).toContain("+    outputPricePerM: 30,")
  })

  it("includes the new ENDPOINTS_DATA entry with capabilities", () => {
    const patch = generateRegistryPatch([candidate], fakeTypesContent)
    // webSearch + vision were true, deepResearch + backgroundApi were false.
    expect(patch).toContain('+  "gpt-9.0":')
    expect(patch).toContain("webSearch: true")
    expect(patch).toContain("vision: true")
  })

  it("emits two @@ hunks (one per registry table)", () => {
    const patch = generateRegistryPatch([candidate], fakeTypesContent)
    const hunks = patch.match(/^@@ /gm) ?? []
    expect(hunks.length).toBe(2)
  })

  it("falls back to NO_CAPS when no capabilities detected", () => {
    const dull: DiscoveredCandidate = {
      ...candidate,
      id: "gpt-9.1",
      displayName: "GPT-9.1",
      capabilityHints: { webSearch: false, vision: false, deepResearch: false, backgroundApi: false },
    }
    const patch = generateRegistryPatch([dull], fakeTypesContent)
    expect(patch).toContain('+  "gpt-9.1": { provider: "openai", capabilities: NO_CAPS }')
  })

  it("uses isDeepResearch:true when the deepResearch capability fired", () => {
    const dr: DiscoveredCandidate = {
      ...candidate,
      id: "o9-deep-research",
      displayName: "O9 Deep Research",
      capabilityHints: { webSearch: true, vision: false, deepResearch: true, backgroundApi: false },
    }
    const patch = generateRegistryPatch([dr], fakeTypesContent)
    expect(patch).toContain("+    isDeepResearch: true,")
  })

  it("returns empty when SKUS_DATA cannot be located", () => {
    const malformed = "// no registry markers here"
    expect(generateRegistryPatch([candidate], malformed)).toBe("")
  })
})
