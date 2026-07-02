/**
 * Pricing-update sub-command: scrape provider doc pages, ask an LLM to
 * extract a JSON price diff, validate it (10× outlier guard), and persist
 * a refreshed snapshot. Also auto-update on stale (>5d) cache during a
 * normal dispatch.
 */

import { queryModel } from "../lib/research"
import { isProviderAvailable } from "../lib/providers"
import {
  estimateCost,
  formatCost,
  getBestAvailableModel,
  MODELS,
  PROVIDER_ENDPOINTS,
  type ModelMode,
} from "../lib/types"
import {
  isPricingStale,
  cacheCurrentPricing,
  buildPricingSnapshot,
  savePricingCache,
  applyCachedPricing,
  PRICING_SOURCES,
} from "../lib/pricing"

export interface PricingUpdateResult {
  priceChanges: Array<{
    modelId: string
    oldInput: number
    oldOutput: number
    newInput: number
    newOutput: number
  }>
  extractionCost?: string
  error?: string
}

/**
 * Fetch pricing pages and extract price changes via LLM.
 * Used by both manual `update-pricing` command and auto-update after invocation.
 */
export async function performPricingUpdate(options: {
  verbose: boolean
  modelMode?: ModelMode
}): Promise<PricingUpdateResult> {
  const { verbose, modelMode = "quick" } = options
  const log = verbose ? (msg: string) => console.error(msg) : (_msg: string) => {}

  const currentPrices = new Map(
    MODELS.filter((m) => m.inputPricePerM != null).map((m) => [
      m.modelId,
      { input: m.inputPricePerM!, output: m.outputPricePerM! },
    ]),
  )

  // Fetch pricing pages in parallel
  log("Fetching pricing pages...")
  const pageTexts: string[] = []

  await Promise.allSettled(
    Object.entries(PRICING_SOURCES).map(async ([provider, url]) => {
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; llm-pricing/1.0)" },
          signal: AbortSignal.timeout(15000),
          redirect: "follow",
        })
        if (!resp.ok) {
          log(`  ⚠️  ${provider}: HTTP ${resp.status}`)
          return
        }
        const html = await resp.text()
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&nbsp;/g, " ")
          .replace(/&#\d+;/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 8000)

        pageTexts.push(`[${provider.toUpperCase()} — ${url}]\n${text}`)
        log(`  ✓ ${provider} (${text.length} chars)`)
      } catch (e) {
        log(`  ⚠️  ${provider}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }),
  )

  if (pageTexts.length === 0) {
    // Don't cacheCurrentPricing on failure — that would reset the stale-timer
    // and block retries for another 5 days. Leaving the timer alone means the
    // next invocation will try again.
    return { priceChanges: [], error: "Could not fetch any pricing pages. Pricing cache unchanged." }
  }

  // Build extraction prompt
  const modelList = MODELS.filter((m) => !m.isDeepResearch)
    .map((m) => `  ${m.modelId} (${m.displayName}): $${m.inputPricePerM}/M in, $${m.outputPricePerM}/M out`)
    .join("\n")

  const extractionPrompt = `Extract current API pricing for these AI models from the pricing pages below.

MODELS TO CHECK:
${modelList}

PRICING PAGES:
${pageTexts.join("\n\n---\n\n")}

Return a JSON array of objects for models where the price DIFFERS from what's listed above.
Each object: { "modelId": "exact-id-from-above", "inputPricePerM": number, "outputPricePerM": number }
- Prices are per 1 MILLION tokens in USD
- Input = prompt/input tokens, Output = completion/output tokens
- Only include models whose prices DIFFER. If prices match or model isn't on the pages, skip it.
- If no prices changed, return []
- Return ONLY the JSON array, no markdown fences, no explanation.`

  // Find a model for extraction
  const { model: extractModel, warning: extractWarning } = getBestAvailableModel(modelMode, (p) =>
    isProviderAvailable(p),
  )
  if (!extractModel) {
    return { priceChanges: [], error: "No LLM available for price extraction. Pricing cache unchanged." }
  }
  if (extractWarning) log(`  ℹ ${extractWarning}`)

  log(`\nExtracting prices via ${extractModel.displayName}...`)

  const extractResult = await queryModel({
    question: extractionPrompt,
    model: extractModel,
    systemPrompt: "You are a data extraction assistant. Output only valid JSON arrays. No markdown fences.",
  })

  if (extractResult.response.error || !extractResult.response.content) {
    return {
      priceChanges: [],
      error: `LLM extraction failed: ${extractResult.response.error ?? "empty response"}. Pricing cache unchanged.`,
    }
  }

  // Parse response
  let priceUpdates: Array<{ modelId: string; inputPricePerM: number; outputPricePerM: number }> = []
  try {
    const jsonStr = extractResult.response.content
      .replace(/```json?\n?/g, "")
      .replace(/```/g, "")
      .trim()
    priceUpdates = JSON.parse(jsonStr) as typeof priceUpdates
    if (!Array.isArray(priceUpdates)) priceUpdates = []
  } catch {
    return { priceChanges: [], error: "Could not parse LLM response. Pricing cache unchanged." }
  }

  // Compute changes — pure, no mutation. The accepted updates feed into
  // `buildPricingSnapshot` which writes a fresh JSON cache; `applyCachedPricing`
  // then overlays it onto the frozen registry so subsequent reads see the new
  // values without any in-place mutation of MODELS.
  const priceChanges: PricingUpdateResult["priceChanges"] = []
  const acceptedUpdates: Array<{ modelId: string; inputPricePerM: number; outputPricePerM: number }> = []
  for (const u of priceUpdates) {
    const current = currentPrices.get(u.modelId)
    if (!current) continue
    const inChanged = u.inputPricePerM !== current.input
    const outChanged = u.outputPricePerM !== current.output
    if (inChanged || outChanged) {
      // Sanity bound: reject swings greater than 10× in either direction.
      // Prices do change between model generations, but a real 10× jump is
      // rare — the likelier explanation is an LLM hallucination (e.g. reading
      // "$25 per 1K tokens" as "$25 per 1M tokens", or confusing input and
      // output). Rather than bake a bogus number into the cache and poison
      // every cost estimate downstream, log the rejection and keep the
      // previous price. The cache-refresh timer still resets so we don't
      // retry on every invocation.
      const inOutlier = Math.abs(u.inputPricePerM - current.input) / current.input > 10
      const outOutlier = Math.abs(u.outputPricePerM - current.output) / current.output > 10
      if (inOutlier || outOutlier) {
        console.error(
          `⚠️  Suspicious pricing delta for ${u.modelId}: ` +
            `in $${current.input}→$${u.inputPricePerM}, out $${current.output}→$${u.outputPricePerM} — rejecting`,
        )
        continue
      }
      priceChanges.push({
        modelId: u.modelId,
        oldInput: current.input,
        oldOutput: current.output,
        newInput: u.inputPricePerM,
        newOutput: u.outputPricePerM,
      })
      acceptedUpdates.push({
        modelId: u.modelId,
        inputPricePerM: u.inputPricePerM,
        outputPricePerM: u.outputPricePerM,
      })
    }
  }

  // Persist the snapshot and refresh the runtime overlay. `cacheCurrentPricing`
  // is preserved as the "snapshot current effective pricing" entry point — it
  // resets the stale timer regardless of whether we had updates (matching the
  // previous behaviour). When we have accepted updates, we build the snapshot
  // explicitly so the cache contains the new values; `applyCachedPricing()`
  // then makes them effective immediately for the rest of this process.
  if (acceptedUpdates.length > 0) {
    savePricingCache(buildPricingSnapshot(acceptedUpdates))
    applyCachedPricing()
  } else {
    cacheCurrentPricing()
  }

  // Extraction cost
  let extractionCost: string | undefined
  if (extractResult.response.usage) {
    const cost = estimateCost(
      extractModel,
      extractResult.response.usage.promptTokens,
      extractResult.response.usage.completionTokens,
    )
    extractionCost = formatCost(cost)
  }

  // Stage 1 of the auto-discovery pipeline (km-bearly.llm-registry-auto-update):
  // we already have the provider doc text in memory — feed it to the discovery
  // module so it writes `~/.cache/bearly-llm/new-models.json` with capability
  // hints + snippets. Stage 2 (`bun llm pro --discover-models`) reads that
  // artifact later and runs the LLM-gated promotion. Best-effort — never blocks
  // the pricing update.
  try {
    const { performDiscovery } = await import("../lib/discover")
    performDiscovery(pageTexts)
  } catch {
    // discovery failure is non-fatal
  }

  return { priceChanges, extractionCost }
}

/** Strip a trailing ISO date snapshot suffix (`-YYYY-MM-DD`). */
function stripDateSuffix(id: string): string {
  return id.replace(/-\d{4}-\d{2}-\d{2}$/, "")
}

/**
 * Filter provider-reported model ids down to *genuinely* new base models.
 *
 * The provider `/v1/models` lists are dominated by ids we already track under
 * a different shape: dated snapshots (`o3-mini-2025-01-31` when we have
 * `o3-mini`), `apiModelId` aliases (`gpt-5-pro` is our `gpt-5.4-pro`), and
 * non-SKU surfaces (`gpt-5-chat-latest`, `gpt-5-search-api`). Surfacing all of
 * them made the auto-update banner scream "30 new models — add to MODELS",
 * which read as "your models are being rejected" and caused a misdiagnosis
 * (2026-07-02). This keeps only ids that aren't a known base, a known alias, a
 * dated variant of either, a non-SKU surface, or a dated variant of another
 * candidate (we keep the undated base of that pair).
 *
 * Pure + exported so it can be unit-tested without hitting the network.
 */
export function filterNewModelCandidates(
  candidateIds: string[],
  knownIds: Iterable<string>,
  knownApiIds: Iterable<string>,
): string[] {
  const known = new Set<string>([...knownIds, ...knownApiIds])
  const knownBases = new Set<string>([...known].map(stripDateSuffix))
  const isKnownVariant = (id: string): boolean =>
    [id, stripDateSuffix(id)].some((form) => known.has(form) || knownBases.has(form))
  const candidateBases = new Set(candidateIds.map(stripDateSuffix))

  const out: string[] = []
  const seen = new Set<string>()
  for (const id of candidateIds) {
    if (seen.has(id)) continue
    if (isKnownVariant(id)) continue
    // OpenAI non-SKU surfaces we deliberately don't track as models.
    if (/-chat-latest$/.test(id) || /-search-api(-\d{4}-\d{2}-\d{2})?$/.test(id)) continue
    // Dated variant whose own base is also a candidate → keep only the base.
    const base = stripDateSuffix(id)
    if (base !== id && candidateBases.has(base)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** All `apiModelId` overrides declared on provider endpoints (e.g. `gpt-5-pro`
 *  for our `gpt-5.4-pro` alias) — these are known ids under a different name. */
function knownApiModelIds(): string[] {
  return Object.values(PROVIDER_ENDPOINTS)
    .map((e) => e.apiModelId)
    .filter((x): x is string => typeof x === "string")
}

/**
 * Discover *genuinely new* models by querying provider APIs (OpenAI, Anthropic).
 * Returns base model ids not represented in the MODELS registry (see
 * `filterNewModelCandidates` for what "represented" excludes).
 */
export async function discoverNewModels(): Promise<string[]> {
  const raw: string[] = []

  // OpenAI /v1/models
  if (process.env.OPENAI_API_KEY) {
    try {
      const resp = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        signal: AbortSignal.timeout(10000),
      })
      if (resp.ok) {
        const data = (await resp.json()) as { data: Array<{ id: string }> }
        for (const m of data.data) {
          if (
            (m.id.startsWith("gpt-5") ||
              m.id.startsWith("gpt-6") ||
              m.id.startsWith("o3") ||
              m.id.startsWith("o4") ||
              m.id.startsWith("o5")) &&
            !m.id.includes("audio") &&
            !m.id.includes("realtime") &&
            !m.id.includes("tts") &&
            !m.id.includes("dall-e") &&
            !m.id.includes("embedding") &&
            !m.id.includes("whisper")
          ) {
            raw.push(m.id)
          }
        }
      }
    } catch {}
  }

  // Anthropic /v1/models
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY!,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(10000),
      })
      if (resp.ok) {
        const data = (await resp.json()) as { data: Array<{ id: string }> }
        for (const m of data.data) {
          if (m.id.startsWith("claude-")) raw.push(m.id)
        }
      }
    } catch {}
  }

  return filterNewModelCandidates(
    raw,
    MODELS.map((m) => m.modelId),
    knownApiModelIds(),
  )
}

/**
 * Auto-update pricing after invocation if cache is stale (>5 days).
 * Prints discoveries prominently to stderr AFTER the main response.
 */
export async function maybeAutoUpdatePricing(command: string | undefined): Promise<void> {
  // Respect an explicit opt-out — useful in CI, cost-sensitive batch jobs, or
  // any environment where surprise API spend is unwelcome.
  if (process.env.LLM_NO_AUTO_PRICING === "1") return
  if (process.argv.slice(2).includes("--dry-run")) return
  if (!isPricingStale()) return
  const skip = ["update-pricing", "recover", "partials", "await"]
  if (!command || command === "--help" || command === "-h") return
  if (skip.includes(command!)) return

  try {
    console.error("\n📊 Pricing cache is >5 days old, refreshing...")

    const [updateResult, newModels] = await Promise.all([
      performPricingUpdate({ verbose: false, modelMode: "quick" }),
      discoverNewModels(),
    ])

    const hasChanges = updateResult.priceChanges.length > 0
    const hasNewModels = newModels.length > 0

    if (!hasChanges && !hasNewModels) {
      if (updateResult.error) {
        console.error(`  ⚠️  ${updateResult.error}`)
      } else {
        console.error("  ✓ No changes detected.")
      }
      return
    }

    console.error("")
    console.error("╔" + "═".repeat(58) + "╗")
    console.error("║  📊 Pricing Auto-Update — Discoveries                      ║")
    console.error("╚" + "═".repeat(58) + "╝")

    if (hasChanges) {
      console.error(`\n  Price changes (${updateResult.priceChanges.length}):`)
      for (const c of updateResult.priceChanges) {
        console.error(`    ${c.modelId}:`)
        if (c.oldInput !== c.newInput) console.error(`      input:  $${c.oldInput}/M → $${c.newInput}/M`)
        if (c.oldOutput !== c.newOutput) console.error(`      output: $${c.oldOutput}/M → $${c.newOutput}/M`)
      }
      console.error(`\n  ⚠️  To persist: update plugins/llm/src/lib/types.ts`)
    }

    if (hasNewModels) {
      console.error(`\n  🆕 Provider models not yet in the registry (${newModels.length}):`)
      for (const id of newModels.slice(0, 15)) {
        console.error(`    • ${id}`)
      }
      if (newModels.length > 15) {
        console.error(`    ... and ${newModels.length - 15} more`)
      }
      // This banner prints AFTER the response, on stderr — it is informational
      // only and does NOT mean your query failed or a model was rejected.
      // (2026-07-02: the old wording caused exactly that misdiagnosis.)
      console.error(`\n  ℹ️  Informational only — your query was unaffected. Add any you want`)
      console.error(`     selectable to the registry (plugins/llm/src/lib/types.ts).`)
    }

    if (updateResult.extractionCost) {
      console.error(`\n  (auto-update cost: ${updateResult.extractionCost})`)
    }
    console.error("")
  } catch {
    // Best-effort — never fail the main operation
  }
}
