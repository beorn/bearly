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
import { getDb, closeDb, ftsSearchWithSnippet } from "../../../recall/src/history/db"
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
  // Respect an explicit opt-out — useful in CI, cost-sensitive batch jobs, or
  // any environment where surprise API spend is unwelcome.
  if (process.env.LLM_NO_AUTO_PRICING === "1") return
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
      console.error(`\n  🆕 New models (${newModels.length}):`)
      for (const id of newModels.slice(0, 15)) {
        console.error(`    • ${id}`)
      }
      if (newModels.length > 15) {
        console.error(`    ... and ${newModels.length - 15} more`)
      }
      console.error(`\n  ℹ️  Add to MODELS in plugins/llm/src/lib/types.ts`)
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

/** Prompt user for Y/n confirmation; exit if declined.
 *
 * Non-TTY safety: if stdin isn't a TTY (CI, Docker, Claude Code background
 * tasks), stdin.once('data') never resolves because the pipe is closed at
 * EOF — the process would hang forever waiting for input that can't arrive.
 * We detect that up front and refuse to proceed unless the caller passed -y.
 * A 5-minute timeout guards the interactive path too, in case raw mode gets
 * wedged for any other reason.
 */
export async function confirmOrExit(message: string, skipConfirm: boolean): Promise<void> {
  if (skipConfirm) return
  if (!process.stdin.isTTY) {
    console.error("Non-interactive environment — pass -y / --yes to skip confirmation.")
    process.exit(1)
  }
  console.error(message)
  const answer = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      process.stdin.setRawMode?.(false)
      reject(new Error("confirmation timed out after 5 minutes"))
    }, 5 * 60 * 1000)
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.once("data", (data) => {
      clearTimeout(timer)
      process.stdin.setRawMode?.(false)
      resolve(data.toString().trim().toLowerCase())
    })
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
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

  // Delegate to confirmOrExit's hardened prompt (TTY check + 5min timeout).
  // The skipConfirm short-circuit returns silently; a declined prompt calls
  // process.exit(0) inside confirmOrExit. We only need to handle "ok, continue".
  await confirmOrExit("Continue with new query? [Y/n] ", skipConfirm)
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

/**
 * Default poll ceiling for recover/await: 600 × 5s = 50 minutes.
 *
 * Raised from the original 180 (=15 min) after a GPT 5.4 Pro deep review took
 * ~40 min end-to-end and the recover command timed out. Tune via env var
 * LLM_RECOVER_MAX_ATTEMPTS; each attempt is one 5s poll.
 */
const DEFAULT_RECOVER_MAX_ATTEMPTS = 600

function resolveMaxAttempts(): number {
  const raw = process.env.LLM_RECOVER_MAX_ATTEMPTS
  if (!raw) return DEFAULT_RECOVER_MAX_ATTEMPTS
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RECOVER_MAX_ATTEMPTS
}

/**
 * Progress printer for poll loops.
 *
 * - silent: no output (used by `await`)
 * - TTY: live `\r`-overwriting spinner every poll
 * - non-TTY (claude-code, CI): one line per 60s — keeps output compact so
 *   claude-code's stdout-burst auto-background heuristic doesn't trigger.
 */
function makePollProgress(opts: { silent?: boolean } = {}): (status: string, elapsedMs: number) => void {
  if (opts.silent) return () => {}
  const isTTY = process.stderr.isTTY
  let lastLogged = -60
  return (status, elapsedMs) => {
    if (isTTY) {
      process.stderr.write(`\r⏳ ${status} (${Math.round(elapsedMs / 1000)}s elapsed)`)
      return
    }
    const seconds = Math.round(elapsedMs / 1000)
    if (seconds - lastLogged < 60) return
    lastLogged = seconds
    process.stderr.write(`⏳ ${status} (${seconds}s elapsed)\n`)
  }
}

/** Write a recovered response to /tmp/llm-*.txt so background callers can find it. */
async function writeRecoveredResponse(
  content: string,
  responseId: string,
  topic: string | undefined,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined,
): Promise<string> {
  const { buildOutputPath, finalizeOutput } = await import("./format")
  const sessionTag = process.env.CLAUDE_SESSION_ID?.slice(0, 8) ?? "manual"
  const outputFile = buildOutputPath(sessionTag, topic ?? `recover-${responseId}`)
  await finalizeOutput(content, outputFile, sessionTag, {
    query: topic,
    tokens: usage?.totalTokens,
  })
  return outputFile
}

/**
 * Poll a response ID until completion. Shared by `recover <id>` and `await <id>`.
 *
 * @param silentProgress — when true, suppress all progress output (used by `await`).
 *                        Otherwise TTY gets spinner, non-TTY gets 60s-gated lines.
 */
async function pollResponseToCompletion(
  responseId: string,
  silentProgress: boolean,
): Promise<{
  status: string
  content: string
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  error?: string
}> {
  const initial = await retrieveResponse(responseId)
  if (initial.status !== "in_progress" && initial.status !== "queued") {
    return initial
  }
  const maxAttempts = resolveMaxAttempts()
  if (!silentProgress) {
    const mins = Math.round((maxAttempts * 5) / 60)
    console.error(
      `\nStatus: ${initial.status} — polling every 5s (ceiling: ${mins}m, set LLM_RECOVER_MAX_ATTEMPTS to override)`,
    )
  }
  const result = await pollForCompletion(responseId, {
    intervalMs: 5_000,
    maxAttempts,
    onProgress: makePollProgress({ silent: silentProgress }),
  })
  if (!silentProgress && process.stderr.isTTY) process.stderr.write("\n")
  return result
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

    const result = await pollResponseToCompletion(responseId, /* silentProgress */ false)

    if (result.error && result.status !== "timeout") {
      if (!localPartial) {
        // Match runAwait's error envelope — include responseId + status so
        // scripts and the `bun llm await` caller can reason about the
        // failure without re-deriving context.
        console.error(
          JSON.stringify({
            error: `Failed to retrieve: ${result.error}`,
            status: result.status,
            responseId,
          }),
        )
        process.exit(1)
      }
      console.error(`\n⚠️  Could not retrieve from OpenAI (${responseId}): ${result.error}`)
    } else if (result.status === "completed" && result.content) {
      console.error("\nFull response from OpenAI:\n")
      console.log(result.content)
      if (result.usage) {
        console.error(`\n[${result.usage.totalTokens} tokens]`)
      }
      const outputFile = await writeRecoveredResponse(
        result.content,
        responseId,
        localPartial?.metadata.topic,
        result.usage,
      )
      process.stderr.write(`Recovered output written to: ${outputFile}\n`)
      if (localPartial) {
        const { completePartial } = await import("./persistence")
        completePartial(localPartial.path, { delete: true })
      }
    } else if (result.status === "failed" || result.status === "cancelled" || result.status === "expired") {
      console.error(`\nResponse ${result.status}`)
      if (localPartial) {
        const { completePartial } = await import("./persistence")
        completePartial(localPartial.path, { delete: true })
        console.error("Cleaned up stale partial file.")
      }
    } else {
      console.error(`Response ${result.status}${result.error ? `: ${result.error}` : ""}`)
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

/**
 * Run `await <id>` — block silently until a deep-research response completes,
 * then print only the file path on stderr and a JSON summary on stdout. No
 * spinner, no preview, no progress. Designed for non-interactive callers
 * (claude-code, CI) that just want the final result.
 */
export async function runAwait(options: { responseId: string | undefined }): Promise<void> {
  const { responseId } = options
  if (!responseId) {
    console.error(JSON.stringify({ error: "Usage: llm await <response_id>" }))
    process.exit(1)
  }

  const localPartial = findPartialByResponseId(responseId)
  const result = await pollResponseToCompletion(responseId, /* silentProgress */ true)

  if (result.status === "completed" && result.content) {
    const outputFile = await writeRecoveredResponse(
      result.content,
      responseId,
      localPartial?.metadata.topic,
      result.usage,
    )
    process.stderr.write(`Output written to: ${outputFile}\n`)
    if (localPartial) {
      const { completePartial } = await import("./persistence")
      completePartial(localPartial.path, { delete: true })
    }
    return
  }

  const errorPayload: Record<string, unknown> = {
    error: result.error ?? `Response ${result.status}`,
    status: result.status,
    responseId,
  }
  console.log(JSON.stringify(errorPayload))
  process.exit(1)
}

/**
 * Run dual-pro mode: query GPT-5.4 Pro and Kimi K2.6 in parallel, write both
 * responses + an A/B log line. Two-is-better-than-one — user reads both, judges.
 *
 * A/B log lives at ~/.claude/projects/<project>/memory/ab-pro.jsonl. Each line
 * records the prompt, both responses' cost/duration/length, so we can rank
 * quality retrospectively (add a judgement field later if we want automated
 * scoring). Today it's just an append-only record for human review.
 *
 * Falls back to single-model `askAndFinish` if either provider is unavailable.
 */
export async function runProDual(options: {
  question: string
  modelOverride: Model | undefined
  imagePath: string | undefined
  streamToken: (token: string) => void
  buildContext: (topic: string) => Promise<string | undefined>
  outputFile: string
  sessionTag: string
  skipConfirm: boolean
}): Promise<void> {
  const { question, modelOverride, imagePath, buildContext, outputFile, sessionTag, skipConfirm } = options
  const { finalizeOutput } = await import("./format")

  // Explicit --model override bypasses dual mode entirely.
  if (modelOverride) {
    await askAndFinish({
      question,
      modelMode: "pro" as ModelMode,
      level: "standard",
      header: (name) => `[${name} - pro mode]`,
      modelOverride,
      imagePath,
      streamToken: options.streamToken,
      buildContext,
      outputFile,
      sessionTag,
    })
    return
  }

  const gptPro = getModel("gpt-5.4-pro")
  const kimi = getModel("moonshotai/kimi-k2.6")
  const gptAvailable = gptPro && isProviderAvailable(gptPro.provider)
  const kimiAvailable = kimi && isProviderAvailable(kimi.provider)

  // Fall back to single-model mode if we can't run both sides.
  if (!gptAvailable || !kimiAvailable) {
    const missing = !gptAvailable ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY"
    console.error(`⚠️  Dual-pro unavailable (${missing} not set) — falling back to single model\n`)
    await askAndFinish({
      question,
      modelMode: "pro" as ModelMode,
      level: "standard",
      header: (name) => `[${name} - pro mode]`,
      modelOverride: undefined,
      imagePath,
      streamToken: options.streamToken,
      buildContext,
      outputFile,
      sessionTag,
    })
    return
  }

  const context = await buildContext(question)
  const enrichedQuestion = context ? `${context}\n\n---\n\n${question}` : question
  if (context) console.error(`📎 Context provided (${context.length} chars)\n`)

  console.error(`[dual-pro] Querying ${gptPro!.displayName} + ${kimi!.displayName} in parallel...`)
  console.error(`  • Estimated cost: $5-15 (Pro) + $0.01-0.05 (K2.6) = ~$5-15 total`)
  console.error(`  • K2.6 output cap: ${kimi!.reasoning?.maxOutputTokens} tokens (reasoning + content)\n`)

  // Cost confirmation matches runDebate / runDeep — a $5-15 call deserves a
  // Y/n gate. The 2026-04-20 double-fire bug made silent billing mistakes
  // worse than they would otherwise be; this is the explicit-opt-in backstop.
  await confirmOrExit("⚠️  Dual-pro costs ~$5-15 (mostly GPT-5.4 Pro). Proceed? [Y/n] ", skipConfirm)

  const { ask } = await import("./research")

  // Fire both in parallel. Streaming is disabled — dual streams would interleave
  // unreadably on stderr. Users read the final files.
  //
  // AbortController enforces a 5-minute wall-clock ceiling per side so a hung
  // provider can't stall the whole run indefinitely (real incident: OpenAI
  // synchronous Pro timing out silently at the ai-sdk 300s default — at least
  // now we fail fast with a clear message). imagePath is forwarded explicitly
  // — dropping it would silently degrade `--image` to text-only responses.
  const ac = new AbortController()
  const abortTimer = setTimeout(() => ac.abort(), 5 * 60 * 1000)
  const [gptResult, kimiResult] = await Promise.allSettled([
    ask(enrichedQuestion, "standard", {
      modelOverride: gptPro!.modelId,
      stream: false,
      imagePath,
      abortSignal: ac.signal,
    }),
    ask(enrichedQuestion, "standard", {
      modelOverride: kimi!.modelId,
      stream: false,
      imagePath,
      abortSignal: ac.signal,
    }),
  ])
  clearTimeout(abortTimer)

  const gptResp = gptResult.status === "fulfilled" ? gptResult.value : undefined
  const kimiResp = kimiResult.status === "fulfilled" ? kimiResult.value : undefined
  const gptErr = gptResult.status === "rejected" ? String(gptResult.reason) : gptResp?.error
  const kimiErr = kimiResult.status === "rejected" ? String(kimiResult.reason) : kimiResp?.error

  if (gptErr) console.error(`  ✗ ${gptPro!.displayName}: ${gptErr}`)
  else if (gptResp) console.error(`  ✓ ${gptPro!.displayName} (${gptResp.usage?.totalTokens ?? 0} tok, ${Math.round(gptResp.durationMs / 1000)}s)`)
  if (kimiErr) console.error(`  ✗ ${kimi!.displayName}: ${kimiErr}`)
  else if (kimiResp) console.error(`  ✓ ${kimi!.displayName} (${kimiResp.usage?.totalTokens ?? 0} tok, ${Math.round(kimiResp.durationMs / 1000)}s)`)

  // Build the combined report. Both responses presented side-by-side, headers
  // labelled so the reader can diff. Non-fatal errors surface inline so the
  // reader sees which model failed without digging through logs.
  const gptCost = gptResp?.usage
    ? estimateCost(gptPro!, gptResp.usage.promptTokens, gptResp.usage.completionTokens)
    : 0
  const kimiCost = kimiResp?.usage
    ? estimateCost(kimi!, kimiResp.usage.promptTokens, kimiResp.usage.completionTokens)
    : 0
  const totalCost = gptCost + kimiCost

  const parts: string[] = []
  parts.push(`# Dual-Pro Response\n`)
  parts.push(`**Question**: ${question}\n`)
  parts.push(`**Models**: ${gptPro!.displayName} + ${kimi!.displayName}`)
  parts.push(`**Total cost**: ${formatCost(totalCost)} (${formatCost(gptCost)} + ${formatCost(kimiCost)})\n`)

  parts.push(`---\n`)
  parts.push(`## ${gptPro!.displayName}`)
  if (gptResp?.content) {
    const meta = `_${gptResp.usage?.totalTokens ?? 0} tokens · ${Math.round(gptResp.durationMs / 1000)}s · ${formatCost(gptCost)}_`
    parts.push(meta + "\n")
    parts.push(gptResp.content.trim())
  } else {
    parts.push(`⚠️  Failed: ${gptErr ?? "no content"}`)
  }

  parts.push(`\n---\n`)
  parts.push(`## ${kimi!.displayName}`)
  if (kimiResp?.content) {
    const meta = `_${kimiResp.usage?.totalTokens ?? 0} tokens · ${Math.round(kimiResp.durationMs / 1000)}s · ${formatCost(kimiCost)}_`
    parts.push(meta + "\n")
    parts.push(kimiResp.content.trim())
  } else {
    parts.push(`⚠️  Failed: ${kimiErr ?? "no content"}`)
  }

  const combined = parts.join("\n")

  await finalizeOutput(combined, outputFile, sessionTag, {
    query: question,
    model: `dual-pro (${gptPro!.displayName} + ${kimi!.displayName})`,
    tokens: (gptResp?.usage?.totalTokens ?? 0) + (kimiResp?.usage?.totalTokens ?? 0),
    cost: formatCost(totalCost),
    durationMs: Math.max(gptResp?.durationMs ?? 0, kimiResp?.durationMs ?? 0),
  })

  // Append an A/B log entry so we can review quality over time.
  await appendAbProLog({
    question,
    sessionTag,
    outputFile,
    gpt: { model: gptPro!, response: gptResp, error: gptErr },
    kimi: { model: kimi!, response: kimiResp, error: kimiErr },
    gptCost,
    kimiCost,
  })
}

/**
 * Append one dual-pro run to the A/B log (JSONL). Best-effort — errors are
 * swallowed so a log write failure doesn't break the user-facing output.
 *
 * Log lives with the project's memory directory so it travels with the
 * Claude Code project context. Fields are stable — later we can `jq` over
 * them to rank winners, estimate quality deltas, etc.
 */
async function appendAbProLog(entry: {
  question: string
  sessionTag: string
  outputFile: string
  gpt: { model: Model; response: import("./types").ModelResponse | undefined; error: string | undefined }
  kimi: { model: Model; response: import("./types").ModelResponse | undefined; error: string | undefined }
  gptCost: number
  kimiCost: number
}): Promise<void> {
  try {
    const os = await import("os")
    const fs = await import("fs")
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd()
    const encoded = projectRoot.replace(/\//g, "-")
    const dir = `${os.homedir()}/.claude/projects/${encoded}/memory`
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const line =
      JSON.stringify({
        // Schema version so future readers can detect format drift. Bump on
        // breaking changes (field rename, semantic shift); additive changes
        // don't require a bump — readers should treat unknown fields as
        // opaque.
        schema: "ab-pro/v1",
        timestamp: new Date().toISOString(),
        session: entry.sessionTag,
        question: entry.question,
        outputFile: entry.outputFile,
        gpt: {
          model: entry.gpt.model.modelId,
          ok: !!entry.gpt.response?.content,
          error: entry.gpt.error,
          tokens: entry.gpt.response?.usage?.totalTokens,
          promptTokens: entry.gpt.response?.usage?.promptTokens,
          completionTokens: entry.gpt.response?.usage?.completionTokens,
          durationMs: entry.gpt.response?.durationMs,
          chars: entry.gpt.response?.content?.length,
          cost: entry.gptCost,
        },
        kimi: {
          model: entry.kimi.model.modelId,
          ok: !!entry.kimi.response?.content,
          error: entry.kimi.error,
          tokens: entry.kimi.response?.usage?.totalTokens,
          promptTokens: entry.kimi.response?.usage?.promptTokens,
          completionTokens: entry.kimi.response?.usage?.completionTokens,
          durationMs: entry.kimi.response?.durationMs,
          chars: entry.kimi.response?.content?.length,
          cost: entry.kimiCost,
        },
      }) + "\n"
    fs.appendFileSync(`${dir}/ab-pro.jsonl`, line)
  } catch {
    // Best-effort log
  }
}
