/**
 * Provider dispatch — model selection, routing, pricing updates, recovery.
 *
 * Bridges CLI arguments to the research/consensus/persistence layers.
 */

import { createLogger } from "loggily"
import { ask, research, queryModel } from "./research"
import { retrieveResponse, pollForCompletion } from "./openai-deep"
import { listPartials, findPartialByResponseId, cleanupPartials } from "./persistence"
import { consensus } from "./consensus"
import { isProviderAvailable, getProviderEnvVar } from "./providers"
import { getDb, closeDb, ftsSearchWithSnippet } from "../history/db"
import { estimateCost, formatCost, getBestAvailableModel, getModel, MODELS, type Model, type ModelMode } from "./types"
import { isPricingStale, cacheCurrentPricing, PRICING_SOURCES } from "./pricing"

const log = createLogger("bearly:llm")

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
    cacheCurrentPricing()
    return { priceChanges: [], error: "Could not fetch any pricing pages. Cache refreshed from hardcoded values." }
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
    cacheCurrentPricing()
    return { priceChanges: [], error: "No LLM available for price extraction. Cache refreshed from hardcoded values." }
  }
  if (extractWarning) log(`  ℹ ${extractWarning}`)

  log(`\nExtracting prices via ${extractModel.displayName}...`)

  const extractResult = await queryModel({
    question: extractionPrompt,
    model: extractModel,
    systemPrompt: "You are a data extraction assistant. Output only valid JSON arrays. No markdown fences.",
  })

  if (extractResult.response.error || !extractResult.response.content) {
    cacheCurrentPricing()
    return {
      priceChanges: [],
      error: `LLM extraction failed: ${extractResult.response.error ?? "empty response"}. Cache refreshed from hardcoded values.`,
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
    cacheCurrentPricing()
    return { priceChanges: [], error: "Could not parse LLM response. Cache refreshed from hardcoded values." }
  }

  // Apply changes
  const priceChanges: PricingUpdateResult["priceChanges"] = []
  for (const u of priceUpdates) {
    const current = currentPrices.get(u.modelId)
    if (!current) continue
    const inChanged = u.inputPricePerM !== current.input
    const outChanged = u.outputPricePerM !== current.output
    if (inChanged || outChanged) {
      priceChanges.push({
        modelId: u.modelId,
        oldInput: current.input,
        oldOutput: current.output,
        newInput: u.inputPricePerM,
        newOutput: u.outputPricePerM,
      })
      const model = MODELS.find((m) => m.modelId === u.modelId)
      if (model) {
        model.inputPricePerM = u.inputPricePerM
        model.outputPricePerM = u.outputPricePerM
      }
    }
  }

  // Save cache (resets stale timer)
  cacheCurrentPricing()

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

  return { priceChanges, extractionCost }
}

/**
 * Discover new models by querying provider APIs (OpenAI, Anthropic).
 * Returns model IDs not present in the MODELS registry.
 */
export async function discoverNewModels(): Promise<string[]> {
  const knownIds = new Set(MODELS.map((m) => m.modelId))
  const newModels: string[] = []

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
            !m.id.includes("whisper") &&
            !knownIds.has(m.id)
          ) {
            newModels.push(m.id)
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
          if (m.id.startsWith("claude-") && !knownIds.has(m.id)) {
            newModels.push(m.id)
          }
        }
      }
    } catch {}
  }

  return newModels
}

/**
 * Auto-update pricing after invocation if cache is stale (>5 days).
 * Prints discoveries prominently to stderr AFTER the main response.
 */
export async function maybeAutoUpdatePricing(command: string | undefined): Promise<void> {
  if (!isPricingStale()) return
  const skip = ["update-pricing", "recover", "partials"]
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
      console.error(`\n  ⚠️  To persist: update tools/lib/llm/types.ts`)
    }

    if (hasNewModels) {
      console.error(`\n  🆕 New models (${newModels.length}):`)
      for (const id of newModels.slice(0, 15)) {
        console.error(`    • ${id}`)
      }
      if (newModels.length > 15) {
        console.error(`    ... and ${newModels.length - 15} more`)
      }
      console.error(`\n  ℹ️  Add to MODELS in tools/lib/llm/types.ts`)
    }

    if (updateResult.extractionCost) {
      console.error(`\n  (auto-update cost: ${updateResult.extractionCost})`)
    }
    console.error("")
  } catch {
    // Best-effort — never fail the main operation
  }
}

/** Shared single-model ask: select model, stream, finalize */
export async function askAndFinish(options: {
  question: string
  modelMode: ModelMode
  level: "standard" | "quick"
  header: (name: string) => string
  modelOverride: Model | undefined
  imagePath: string | undefined
  streamToken: (token: string) => void
  buildContext: (topic: string) => Promise<string | undefined>
  outputFile: string
  sessionTag: string
}): Promise<void> {
  const {
    question,
    modelMode,
    level,
    header,
    modelOverride,
    imagePath,
    streamToken,
    buildContext,
    outputFile,
    sessionTag,
  } = options
  const { finishResponse } = await import("./format")

  const context = await buildContext(question)
  const enrichedQuestion = context ? `${context}\n\n---\n\n${question}` : question
  if (context) console.error(`📎 Context provided (${context.length} chars)\n`)
  let model: Model
  if (modelOverride) {
    model = modelOverride
  } else {
    const result = getBestAvailableModel(modelMode, isProviderAvailable)
    if (!result.model) {
      console.error(JSON.stringify({ error: `No model available for ${modelMode}. ${result.warning || ""}` }))
      process.exit(1)
    }
    if (result.warning) console.error(`⚠️  ${result.warning}\n`)
    model = result.model
  }
  console.error(header(model.displayName) + "\n")
  const response = await ask(enrichedQuestion, level, {
    modelOverride: model.provider !== "ollama" ? model.modelId : undefined,
    modelObject: model.provider === "ollama" ? model : undefined,
    stream: true,
    onToken: streamToken,
    imagePath,
  })
  await finishResponse(response.content, model, outputFile, sessionTag, response.usage, response.durationMs, question)
}

/** Prompt user for Y/n confirmation; exit if declined */
export async function confirmOrExit(message: string, skipConfirm: boolean): Promise<void> {
  if (skipConfirm) return
  console.error(message)
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.once("data", (data) => {
      process.stdin.setRawMode?.(false)
      resolve(data.toString().trim().toLowerCase())
    })
  })
  if (answer === "n" || answer === "no") {
    console.error("Cancelled.")
    process.exit(0)
  }
  console.error()
}

/** Build context from explicit text, file, and session history */
export async function buildContext(
  topic: string,
  options: {
    contextArg?: string
    contextFile?: string
    withHistory: boolean
  },
): Promise<string | undefined> {
  const parts: string[] = []
  if (options.contextArg) parts.push(options.contextArg)
  if (options.contextFile) {
    try {
      parts.push(await Bun.file(options.contextFile).text())
    } catch {
      console.error(JSON.stringify({ error: `Failed to read context file: ${options.contextFile}` }))
      process.exit(1)
    }
  }
  if (options.withHistory) {
    try {
      const db = getDb()
      const { results } = ftsSearchWithSnippet(db, topic, { limit: 3 })
      closeDb()
      if (results.length > 0) {
        console.error("📚 Including context from session history...\n")
        parts.push(
          "Relevant context from previous sessions:\n\n" +
            results
              .map((r) => {
                const role = r.type === "user" ? "User" : "Assistant"
                return `[${role}]: ${r.snippet.replace(/>>>/g, "").replace(/<<</g, "")}`
              })
              .join("\n\n"),
        )
      }
    } catch {
      /* History not indexed */
    }
  }
  return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined
}

/**
 * Check for and auto-recover incomplete responses.
 * Returns true if user wants to continue with new query.
 */
export async function checkAndRecoverPartials(skipRecover: boolean, skipConfirm: boolean): Promise<boolean> {
  if (skipRecover) return true

  const partials = listPartials()
  if (partials.length === 0) return true

  console.error(`📦 Found ${partials.length} incomplete response(s) - attempting recovery...\n`)

  for (const partial of partials) {
    const age = Date.now() - new Date(partial.metadata.startedAt).getTime()
    const ageStr = age < 3600000 ? `${Math.round(age / 60000)}m ago` : `${Math.round(age / 3600000)}h ago`

    console.error(`  ${partial.metadata.responseId}`)
    console.error(`    Started: ${ageStr} | Topic: ${partial.metadata.topic.slice(0, 50)}...`)

    // Try to retrieve from OpenAI
    if (partial.metadata.responseId) {
      const recovered = await retrieveResponse(partial.metadata.responseId)
      if (recovered.status === "completed" && recovered.content) {
        console.error(`    ✅ Recovered from OpenAI (${recovered.content.length} chars)`)
        console.error(`\n--- Recovered Response ---\n`)
        console.log(recovered.content)
        if (recovered.usage) {
          console.error(`\n[Recovered: ${recovered.usage.totalTokens} tokens]`)
        }
        // Clean up the partial file
        const { completePartial } = await import("./persistence")
        completePartial(partial.path, { delete: true })
        console.error(`\n--- End Recovered Response ---\n`)
      } else if (recovered.status === "failed" || recovered.status === "cancelled" || recovered.status === "expired") {
        console.error(`    ❌ Response ${recovered.status} — removing stale partial`)
        const { completePartial } = await import("./persistence")
        completePartial(partial.path, { delete: true })
      } else if (recovered.status === "in_progress" || recovered.status === "queued") {
        // Check if stale (>30 min for deep research is suspicious)
        const partialAge = Date.now() - new Date(partial.metadata.startedAt).getTime()
        if (partialAge > 30 * 60 * 1000) {
          console.error(
            `    ⚠️  Still ${recovered.status} after ${Math.round(partialAge / 60000)}m — likely stale, removing`,
          )
          const { completePartial } = await import("./persistence")
          completePartial(partial.path, { delete: true })
        } else {
          console.error(`    ⏳ Still ${recovered.status} on OpenAI (${Math.round(partialAge / 60000)}m old)`)
          console.error(`    Run 'llm recover ${partial.metadata.responseId}' to poll until complete`)
        }
      } else {
        console.error(`    ⚠️  Could not recover (status: ${recovered.status})`)
        if (partial.content.length > 0) {
          console.error(`    Local partial has ${partial.content.length} chars saved`)
        }
      }
    }
    console.error()
  }

  // If we recovered anything or have partials, ask if user still wants to run new query
  if (!skipConfirm) {
    console.error("Continue with new query? [Y/n] ")
    const confirm = await new Promise<string>((resolve) => {
      process.stdin.setRawMode?.(true)
      process.stdin.resume()
      process.stdin.once("data", (data) => {
        process.stdin.setRawMode?.(false)
        resolve(data.toString().trim().toLowerCase())
      })
    })
    if (confirm === "n" || confirm === "no") {
      return false
    }
    console.error()
  }

  return true
}

/** Run deep research command */
export async function runDeep(options: {
  topic: string
  modelOverride: Model | undefined
  streamToken: (token: string) => void
  buildContext: (topic: string) => Promise<string | undefined>
  outputFile: string
  sessionTag: string
  skipRecover: boolean
  skipConfirm: boolean
  dryRun: boolean
}): Promise<void> {
  const { topic, modelOverride, streamToken, outputFile, sessionTag, skipRecover, skipConfirm, dryRun } = options
  const { finishResponse } = await import("./format")

  const context = await options.buildContext(topic)
  const shouldContinue = await checkAndRecoverPartials(skipRecover, skipConfirm)
  if (!shouldContinue) {
    console.error("Cancelled.")
    return
  }

  let deepModel: Model
  if (modelOverride) {
    deepModel = modelOverride
  } else {
    const result = getBestAvailableModel("deep", isProviderAvailable)
    if (!result.model) {
      console.error(JSON.stringify({ error: "No deep research model available. " + (result.warning || "") }))
      process.exit(1)
    }
    if (result.warning) console.error(`⚠️  ${result.warning}\n`)
    deepModel = result.model
  }

  console.error(`Deep research: ${topic}`)
  console.error(`Model: ${deepModel.displayName}`)
  if (!deepModel.isDeepResearch && deepModel.costTier === "very-high") {
    console.error(`⚠️  ${deepModel.displayName} is not a dedicated deep research model — may take 10-15 minutes`)
  }
  const costEstimate = deepModel.costTier === "very-high" ? "~$5-15" : "~$2-5"
  console.error(`Estimated cost: ${costEstimate}\n`)
  if (context) {
    console.error(`📎 Context provided (${context.length} chars)\n`)
  }

  if (dryRun) {
    console.error("🔍 Dry run - would call deep research API")
    console.error(`   Model: ${deepModel.modelId}`)
    console.error(`   Provider: ${deepModel.provider}`)
    if (context) console.error(`   Context: ${context.slice(0, 100)}...`)
    return
  }

  await confirmOrExit("⚠️  This uses deep research models (~$2-5). Proceed? [Y/n] ", skipConfirm)

  const response = await research(topic, {
    context,
    stream: true,
    onToken: streamToken,
    modelOverride: deepModel.modelId,
    fireAndForget: true,
  })

  // Fire-and-forget: response ID is persisted, recover later with `bun llm recover`
  // For fire-and-forget deep research, empty content is expected — the research continues
  // server-side. The response ID was already persisted by the research layer.
  if (!response.content || response.content.trim().length === 0) {
    if (response.responseId) {
      // Normal fire-and-forget — recovery info already printed by research layer
      return
    }
    // No response ID AND no content — this is a genuine failure, write error to file
    await finishResponse(undefined, deepModel, outputFile, sessionTag, response.usage, response.durationMs, topic)
    return
  }

  // Fast model that completed immediately (no polling needed)
  if (response.error) {
    log.error?.(`Deep research failed: ${response.error}`)
    if (!response.content || response.content.trim().length === 0) {
      // Genuine failure — finishResponse will write error details to the output file
      await finishResponse(undefined, deepModel, outputFile, sessionTag, response.usage, response.durationMs, topic)
      return
    }
    log.warn?.("Partial content recovered — writing what we have.")
  }
  await finishResponse(
    response.content,
    response.model,
    outputFile,
    sessionTag,
    response.usage,
    response.durationMs,
    topic,
  )
}

/** Run multi-model debate command */
export async function runDebate(options: {
  question: string
  buildContext: (topic: string) => Promise<string | undefined>
  outputFile: string
  sessionTag: string
  skipRecover: boolean
  skipConfirm: boolean
  dryRun: boolean
}): Promise<void> {
  const { question, outputFile, sessionTag, skipRecover, skipConfirm, dryRun } = options
  const { finalizeOutput, totalResponseCost } = await import("./format")

  const contextDebate = await options.buildContext(question)
  const enrichedQuestion = contextDebate ? `${contextDebate}\n\n---\n\n${question}` : question

  const shouldContinueDebate = await checkAndRecoverPartials(skipRecover, skipConfirm)
  if (!shouldContinueDebate) {
    console.error("Cancelled.")
    process.exit(0)
  }

  const { getBestAvailableModels } = await import("./types")
  const { models: debateModels, warning: debateWarning } = getBestAvailableModels("debate", isProviderAvailable, 3)
  if (debateModels.length < 2) {
    console.error(JSON.stringify({ error: "Need at least 2 models for debate. " + (debateWarning || "") }))
    process.exit(1)
  }

  console.error(`Multi-model debate: ${question}`)
  console.error(`Models: ${debateModels.map((m) => m.displayName).join(", ")}`)
  console.error(`Estimated cost: ~$1-3\n`)
  if (debateWarning) console.error(`⚠️  ${debateWarning}\n`)
  if (contextDebate) {
    console.error(`📎 Context provided (${contextDebate.length} chars)\n`)
  }

  if (dryRun) {
    console.error("🔍 Dry run - would query these models:")
    for (const m of debateModels) {
      console.error(`   • ${m.displayName} (${m.provider})`)
    }
    if (contextDebate) {
      console.error(`   Context: ${contextDebate.slice(0, 100)}...`)
    }
    process.exit(0)
  }

  await confirmOrExit("⚠️  This queries multiple models (~$1-3). Proceed? [Y/n] ", skipConfirm)

  const result = await consensus({
    question: enrichedQuestion,
    modelIds: debateModels.map((m) => m.modelId),
    synthesize: true,
    onModelComplete: (response) => {
      if (response.error) {
        console.error(`[${response.model.displayName}] Error: ${response.error}`)
      } else {
        console.error(`[${response.model.displayName}] ✓`)
      }
    },
  })

  // Build full debate output
  const parts: string[] = []
  parts.push("--- Synthesis ---\n")
  parts.push(result.synthesis || "(No synthesis)")
  if (result.agreements?.length) {
    parts.push("\n--- Agreements ---")
    result.agreements.forEach((a) => parts.push(`• ${a}`))
  }
  if (result.disagreements?.length) {
    parts.push("\n--- Disagreements ---")
    result.disagreements.forEach((d) => parts.push(`• ${d}`))
  }
  const debateContent = parts.join("\n")

  // Print debate summary to stderr for progress visibility (if interactive)
  if (process.stderr.isTTY) {
    console.error("\n" + debateContent)
  }
  await finalizeOutput(debateContent, outputFile, sessionTag, {
    query: question,
    model: `${result.responses.length} models`,
    cost: formatCost(totalResponseCost(result.responses)),
    durationMs: result.totalDurationMs,
  })
}

/** Run recover/partials command */
export async function runRecover(options: {
  responseId: string | undefined
  clean: boolean
  cleanStale: boolean
  includeAll: boolean
}): Promise<void> {
  const { responseId, clean, cleanStale, includeAll } = options

  // Clean up old partials if requested
  if (clean) {
    const deleted = cleanupPartials(24 * 60 * 60 * 1000)
    console.error(`✓ Cleaned up ${deleted} old partial file(s)`)
    return
  }

  if (cleanStale) {
    const deleted = cleanupPartials(30 * 60 * 1000)
    console.error(`✓ Cleaned up ${deleted} stale partial file(s)`)
    return
  }

  // If response ID provided, try to retrieve it
  if (responseId) {
    console.error(`Retrieving response: ${responseId}...\n`)

    // First check local partials
    const localPartial = findPartialByResponseId(responseId)
    if (localPartial) {
      console.error(`Found local partial (${localPartial.content.length} chars):\n`)
      console.log(localPartial.content)

      if (!localPartial.metadata.completedAt) {
        console.error("\n---")
        console.error("This response was interrupted. Attempting to retrieve from OpenAI...")
      }
    }

    // Try to retrieve from OpenAI (with polling for in-progress responses)
    const initial = await retrieveResponse(responseId)

    if (initial.error) {
      if (!localPartial) {
        console.error(JSON.stringify({ error: `Failed to retrieve: ${initial.error}` }))
        process.exit(1)
      }
      console.error(`\n⚠️  Could not retrieve from OpenAI: ${initial.error}`)
    } else if (initial.status === "completed") {
      console.error("\nFull response from OpenAI:\n")
      console.log(initial.content)
      if (initial.usage) {
        console.error(`\n[${initial.usage.totalTokens} tokens]`)
      }
      if (localPartial) {
        const { completePartial } = await import("./persistence")
        completePartial(localPartial.path, { delete: true })
      }
    } else if (initial.status === "in_progress" || initial.status === "queued") {
      console.error(`\nStatus: ${initial.status} — polling every 5s...`)
      const result = await pollForCompletion(responseId, {
        intervalMs: 5_000,
        maxAttempts: 180,
        onProgress: (status, elapsed) => {
          process.stderr.write(`\r⏳ ${status} (${Math.round(elapsed / 1000)}s elapsed)`)
        },
      })
      process.stderr.write("\n")

      if (result.status === "completed" && result.content) {
        console.error("Full response from OpenAI:\n")
        console.log(result.content)
        if (result.usage) {
          console.error(`\n[${result.usage.totalTokens} tokens]`)
        }
        if (localPartial) {
          const { completePartial } = await import("./persistence")
          completePartial(localPartial.path, { delete: true })
        }
      } else {
        console.error(`Response ${result.status}${result.error ? `: ${result.error}` : ""}`)
      }
    } else if (initial.status === "failed" || initial.status === "cancelled" || initial.status === "expired") {
      console.error(`\nResponse ${initial.status}`)
      if (localPartial) {
        const { completePartial } = await import("./persistence")
        completePartial(localPartial.path, { delete: true })
        console.error("Cleaned up stale partial file.")
      }
    } else {
      console.error(`\nResponse status: ${initial.status}`)
    }
    return
  }

  // List all partials
  const partials = listPartials({ includeCompleted: includeAll })

  if (partials.length === 0) {
    console.error("No incomplete responses found.")
    console.error("\nPartial responses are saved automatically during deep research calls.")
    console.error("If interrupted, they appear here for recovery.")
    return
  }

  console.error(`Found ${partials.length} partial response(s):\n`)

  for (const partial of partials) {
    const age = Date.now() - new Date(partial.metadata.startedAt).getTime()
    const ageStr =
      age < 3600000
        ? `${Math.round(age / 60000)}m ago`
        : age < 86400000
          ? `${Math.round(age / 3600000)}h ago`
          : `${Math.round(age / 86400000)}d ago`

    const isStale = age > 30 * 60 * 1000 // >30 min
    const status = partial.metadata.completedAt ? "✓ completed" : isStale ? "💀 stale" : "⚠️  interrupted"
    const preview = partial.content.slice(0, 100).replace(/\n/g, " ")

    console.error(`  ${partial.metadata.responseId}`)
    console.error(`    ${status} | ${ageStr} | ${partial.metadata.model}`)
    console.error(`    Topic: ${partial.metadata.topic.slice(0, 60)}...`)
    if (partial.content.length > 0) {
      console.error(`    Content: ${preview}${partial.content.length > 100 ? "..." : ""}`)
    }
    console.error(`    (${partial.content.length} chars saved)`)
    console.error()
  }

  console.error("To retrieve a response: llm recover <response_id>")
  console.error("To clean up old partials: llm partials --clean")
}
