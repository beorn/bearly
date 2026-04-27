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
import { estimateCost, formatCost, getBestAvailableModel, getModel, MODELS, type Model, type ModelMode, type ModelResponse } from "./types"
import {
  isPricingStale,
  cacheCurrentPricing,
  buildPricingSnapshot,
  savePricingCache,
  applyCachedPricing,
  PRICING_SOURCES,
} from "./pricing"
import { emitContent, emitJson, isJsonMode } from "./output-mode"
import type { LeaderboardRow } from "./dual-pro"

const log = createLogger("bearly:llm")

/**
 * Bind SIGINT/SIGTERM to an AbortController for the duration of `fn`.
 *
 * Distinguishes the two signals in the abort reason — Ctrl-C fires
 * "ctrl-c" (the user actually wanted to stop), SIGTERM fires "sigterm"
 * (sent by a wrapper, parent process, or `timeout` command — NOT a
 * user interrupt). Surfaces correctly in error envelopes so the user
 * isn't told "user-interrupt" when they didn't interrupt anything.
 *
 * Handlers are removed in `finally` so later signals fall back to the
 * default (kill the process). `process.once` — we don't want to fire
 * abort twice if the user hammers Ctrl-C; the second press terminates
 * normally.
 *
 * Used by the expensive dispatch paths (askAndFinish, runDeep, runDebate,
 * runProDual, runRecover, runAwait) so a long Pro call or 50m poll stops
 * cleanly instead of leaking server-side work / wasting the user's time.
 */
async function withSignalAbort<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController()
  const onSigint = () => ac.abort("ctrl-c")
  const onSigterm = () => ac.abort("sigterm")
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)
  try {
    return await fn(ac.signal)
  } finally {
    process.off("SIGINT", onSigint)
    process.off("SIGTERM", onSigterm)
  }
}

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
    const { performDiscovery } = await import("./discover")
    performDiscovery(pageTexts)
  } catch {
    // discovery failure is non-fatal
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
  /** When true, include captured rate-limit headers in the JSON envelope
   *  under `quota`. Cache update is unconditional regardless of this flag. */
  includeQuota?: boolean
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
      // Error envelope on stdout (JSON mode honours the contract; legacy
      // mode also benefits — scripts that wrap llm consistently parse JSON
      // from stdout regardless of whether --json was passed).
      emitJson({ error: `No model available for ${modelMode}. ${result.warning || ""}`, status: "failed" })
      process.exit(1)
    }
    if (result.warning) console.error(`⚠️  ${result.warning}\n`)
    model = result.model
  }
  console.error(header(model.displayName) + "\n")

  // Pro-mode OpenAI calls route through the Responses API so they're
  // recoverable — a 30-min Pro call that loses its process (SIGINT, network
  // hiccup, wall-clock kill) still persists its responseId and the user can
  // `bun llm recover <id>`. Other modes (quick, opinion, default) stay on
  // generateText: fast models complete in <2s and polling overhead outweighs
  // the recovery benefit.
  //
  // imagePath disables the background route — queryOpenAIBackground is
  // text-only today. Falling back to generateText preserves multimodal
  // behaviour at the cost of recoverability for that specific invocation.
  const { isOpenAIBackgroundCapable, queryOpenAIBackground } = await import("./openai-deep")
  const useBackground = options.modelMode === "pro" && isOpenAIBackgroundCapable(model) && !imagePath

  // Response cache (CAS) — only for cheap deterministic single-model paths.
  // Pro modelMode is shadow-testing intent — caching there would defeat the
  // multi-model comparison. Image-bearing prompts skip too (image-as-cache-key
  // would need a hash of the bytes, deferred). Background mode skips because
  // the recovery path stores responseId, not content.
  const cacheable = !useBackground && !imagePath && options.modelMode !== "pro"
  const { readCache, writeCache } = await import("./cache")
  const cacheKey = {
    model: model.modelId,
    prompt: enrichedQuestion,
    params: { level, modelMode: options.modelMode },
  }
  let response: ModelResponse
  const cached = cacheable ? readCache<ModelResponse>(cacheKey) : null
  if (cached) {
    response = cached.envelope
    console.error(`🟢 cache hit (${cached.ts}) — ${cached.content.length} chars\n`)
    streamToken(cached.content)
  } else {
    // SIGINT/SIGTERM aborts the in-flight call — a long Pro call that the
    // user wants to kill should stop, not wait out the ai-sdk 300s default.
    // The abort reason surfaces in the response error so finishResponse can
    // write it to the output file instead of silently truncating.
    response = await withSignalAbort((signal) =>
      useBackground
        ? queryOpenAIBackground({
            prompt: enrichedQuestion,
            model,
            topic: question,
            abortSignal: signal,
          })
        : ask(enrichedQuestion, level, {
            modelOverride: model.provider !== "ollama" ? model.modelId : undefined,
            modelObject: model.provider === "ollama" ? model : undefined,
            stream: true,
            onToken: streamToken,
            imagePath,
            abortSignal: signal,
          }),
    )
    if (cacheable && response.content && !response.error) {
      try {
        writeCache(cacheKey, response, response.content)
      } catch {
        // Cache write failure must not affect the user-visible call result.
      }
    }
  }
  await finishResponse(
    response.content,
    model,
    outputFile,
    sessionTag,
    response.usage,
    response.durationMs,
    question,
    response.responseId,
    options.includeQuota ? response.quota : undefined,
  )
}

/** Prompt user for Y/n confirmation; exit if declined.
 *
 * Non-TTY safety: if stdin isn't a TTY (CI, Docker, Claude Code background
 * tasks), stdin.once('data') never resolves because the pipe is closed at
 * EOF — the process would hang forever waiting for input that can't arrive.
 * We detect that up front and refuse to proceed unless the caller passed -y.
 * A 5-minute timeout guards the interactive path too, in case raw mode gets
 * wedged for any other reason.
 *
 * **Raw-mode Ctrl-C handling**: setRawMode(true) suppresses SIGINT, so
 * Ctrl-C arrives as the data byte `\u0003` (and Ctrl-D as `\u0004`, ESC
 * as `\u001b`). Previous implementations only tested for "n"/"no" and fell
 * through to "proceed" on these — a catastrophic footgun on $5-15
 * commands. We now explicitly treat those control bytes as cancel and
 * exit 130 (standard SIGINT exit code). Flagged as blocker in the Pro
 * round-2 review, 2026-04-21.
 */
export async function confirmOrExit(message: string, skipConfirm: boolean): Promise<void> {
  if (skipConfirm) return
  if (!process.stdin.isTTY) {
    console.error("Non-interactive environment — pass -y / --yes to skip confirmation.")
    process.exit(1)
  }
  console.error(message)
  const raw = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        process.stdin.setRawMode?.(false)
        reject(new Error("confirmation timed out after 5 minutes"))
      },
      5 * 60 * 1000,
    )
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.once("data", (data) => {
      clearTimeout(timer)
      process.stdin.setRawMode?.(false)
      resolve(data.toString())
    })
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
  // Ctrl-C / Ctrl-D / ESC in raw mode → cancel, exit 130 (SIGINT convention).
  // Raw-mode `data` events can batch multiple bytes into one Buffer (event-loop
  // coalescing or fast typing), so "\u0003y" would miss exact-string equality
  // and fall through to the proceed path. Inspect the FIRST codepoint instead
  // — any leading control byte means "cancel". Flagged by K2.6 round-3 review.
  const firstCode = raw.charCodeAt(0)
  if (firstCode === 3 || firstCode === 4 || firstCode === 27) {
    console.error("\nCancelled.")
    process.exit(130)
  }
  const answer = raw.trim().toLowerCase()
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
      emitJson({ error: `Failed to read context file: ${options.contextFile}`, status: "failed" })
      process.exit(1)
    }
  }
  if (options.withHistory) {
    try {
      const db = getDb()
      try {
        const { results } = ftsSearchWithSnippet(db, topic, { limit: 3 })
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
      } finally {
        // try/finally ensures closeDb() runs even if the FTS query throws —
        // previously the catch path leaked the SQLite handle. Same pattern
        // as cli.ts history lookup.
        closeDb()
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

    // Dispatch to the backend that actually owns this response ID. Previously
    // this path hardcoded OpenAI's retrieveResponse, which silently failed
    // for Gemini interaction IDs persisted from gemini-deep. pollResponse-
    // ToCompletion resolves provider via the persisted modelId; the shared
    // classifyRecovery helper then maps the (partial, result) pair onto a
    // stable RecoveryOutcome so both this path and runRecover share one
    // classifier — the Gemini routing fix and 30m stale threshold apply
    // uniformly in one place.
    if (partial.metadata.responseId) {
      const persistedModel = getModel(partial.metadata.modelId)
      const provider = persistedModel?.provider ?? "openai"
      const providerName = provider === "google" ? "Gemini" : "OpenAI"
      const recovered = await pollResponseToCompletion(partial.metadata.responseId, /* silent */ true)
      const outcome = classifyRecovery(partial, recovered)
      const { completePartial } = await import("./persistence")
      switch (outcome.kind) {
        case "completed": {
          console.error(`    ✅ Recovered from ${providerName} (${outcome.content.length} chars)`)
          console.error(`\n--- Recovered Response ---\n`)
          // emitContent → stdout in legacy, stderr in JSON mode (so the
          // single JSON envelope line is the only thing on stdout).
          emitContent(outcome.content)
          if (outcome.usage) console.error(`\n[Recovered: ${outcome.usage.totalTokens} tokens]`)
          completePartial(partial.path, { delete: true })
          console.error(`\n--- End Recovered Response ---\n`)
          break
        }
        case "failed": {
          console.error(`    ❌ Response ${outcome.status} — removing stale partial`)
          completePartial(partial.path, { delete: true })
          break
        }
        case "stale": {
          console.error(
            `    ⚠️  Still ${outcome.status} after ${Math.round(outcome.ageMs / 60000)}m — likely stale, removing`,
          )
          completePartial(partial.path, { delete: true })
          break
        }
        case "pending": {
          const ageStr = outcome.ageMs !== undefined ? `${Math.round(outcome.ageMs / 60000)}m old` : "age unknown"
          console.error(`    ⏳ Still ${outcome.status} on ${providerName} (${ageStr})`)
          console.error(`    Run 'llm recover ${partial.metadata.responseId}' to poll until complete`)
          break
        }
        case "aborted": {
          // Local interrupt — partial stays, job may still be running remotely.
          console.error(`    ⚠️  Local abort — partial kept for future recovery`)
          break
        }
        case "error":
        case "unknown": {
          console.error(`    ⚠️  Could not recover (status: ${outcome.status})`)
          if (partial.content.length > 0) {
            console.error(`    Local partial has ${partial.content.length} chars saved`)
          }
          break
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
      emitJson({ error: "No deep research model available. " + (result.warning || ""), status: "failed" })
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

  // SIGINT/SIGTERM aborts both the synchronous create (rare — it's a single
  // HTTP call) and any inline polling (Gemini deep path polls for up to 20m
  // inside research()). Fire-and-forget OpenAI paths return immediately
  // after the ID is captured, but we wrap anyway so either provider
  // branch honours Ctrl-C uniformly.
  const response = await withSignalAbort((signal) =>
    research(topic, {
      context,
      stream: true,
      onToken: streamToken,
      modelOverride: deepModel.modelId,
      fireAndForget: true,
      abortSignal: signal,
    }),
  )

  // Fire-and-forget: response ID is persisted, recover later with `bun llm recover`
  // For fire-and-forget deep research, empty content is expected — the research continues
  // server-side. The response ID was already persisted by the research layer.
  if (!response.content || response.content.trim().length === 0) {
    // Only emit the "in_progress" status when the response layer actually
    // succeeded in firing the job. If there's an error alongside a responseId
    // (e.g. a client-side timeout after the server accepted the request),
    // fall through to the error path — otherwise scripts parsing stdout see
    // a false success. Flagged by K2.6 round-3 review.
    if (response.responseId && !response.error) {
      // Emit a machine-readable status line on stdout so scripts and callers
      // can harvest the responseId without parsing stderr. Mirrors the
      // normal completion path (which emits JSON via finalizeOutput). The
      // human-readable "bun llm recover" hint was already printed to stderr
      // by the research layer. Flagged in Pro round-2 review 2026-04-21.
      // Fire-and-forget envelope — no file yet (recover/await will fill
      // that in once the response completes). status="background" maps
      // to the spec's enum so skill consumers can branch on it.
      emitJson({
        status: "background",
        responseId: response.responseId,
        model: deepModel.displayName,
        provider: deepModel.provider,
        topic,
        recoverCommand: `bun llm recover ${response.responseId}`,
      })
      return
    }
    // No response ID OR an error is set — write error details to file
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
    response.responseId,
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
    emitJson({ error: "Need at least 2 models for debate. " + (debateWarning || ""), status: "failed" })
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

  // SIGINT/SIGTERM aborts all three parallel queryModel calls inside
  // consensus(). A $1-3 multi-model run that the user wants to kill should
  // stop billing immediately, not run every leg to completion.
  const result = await withSignalAbort((signal) =>
    consensus({
      question: enrichedQuestion,
      modelIds: debateModels.map((m) => m.modelId),
      synthesize: true,
      abortSignal: signal,
      onModelComplete: (response) => {
        if (response.error) {
          console.error(`[${response.model.displayName}] Error: ${response.error}`)
        } else {
          console.error(`[${response.model.displayName}] ✓`)
        }
      },
    }),
  )

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
  const debateCost = totalResponseCost(result.responses)
  await finalizeOutput(debateContent, outputFile, sessionTag, {
    query: question,
    model: `${result.responses.length} models`,
    cost: formatCost(debateCost),
    costUsd: debateCost,
    durationMs: result.totalDurationMs,
    status: "completed",
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
    tokens: usage
      ? { prompt: usage.promptTokens, completion: usage.completionTokens, total: usage.totalTokens }
      : undefined,
    responseId,
    status: "recovered",
  })
  return outputFile
}

/**
 * Poll a response ID until completion. Shared by `recover <id>` and `await <id>`.
 *
 * @param silentProgress — when true, suppress all progress output (used by `await`).
 *                        Otherwise TTY gets spinner, non-TTY gets 60s-gated lines.
 * @param abortSignal — optional signal that short-circuits the poll on abort.
 *                      Wired by runRecover/runAwait via withSignalAbort so
 *                      Ctrl-C during a 50-minute recover stops cleanly.
 */
export async function pollResponseToCompletion(
  responseId: string,
  silentProgress: boolean,
  abortSignal?: AbortSignal,
): Promise<{
  status: string
  content: string
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  error?: string
}> {
  // Route to the right backend based on the persisted model. Gemini deep
  // research writes partials with Gemini interaction IDs into the same
  // persistence store — previously we always called OpenAI retrieveResponse,
  // which silently failed for Gemini IDs. Look up the partial, resolve its
  // provider, and dispatch accordingly. If no partial exists we fall back to
  // OpenAI (historical default, consistent with external callers passing in
  // resp_* IDs directly).
  const partial = findPartialByResponseId(responseId)
  const persistedModel = partial ? getModel(partial.metadata.modelId) : undefined
  const isGemini = persistedModel?.provider === "google"

  if (isGemini) {
    const { pollForGeminiCompletion } = await import("./gemini-deep")
    const maxAttempts = resolveMaxAttempts()
    if (!silentProgress) {
      const mins = Math.round((maxAttempts * 5) / 60)
      console.error(`\nPolling Gemini interaction (ceiling: ${mins}m, set LLM_RECOVER_MAX_ATTEMPTS to override)`)
    }
    const result = await pollForGeminiCompletion(responseId, {
      intervalMs: 5_000,
      maxAttempts,
      abortSignal,
      onProgress: makePollProgress({ silent: silentProgress }),
    })
    if (!silentProgress && process.stderr.isTTY) process.stderr.write("\n")
    return result
  }

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
    abortSignal,
    onProgress: makePollProgress({ silent: silentProgress }),
  })
  if (!silentProgress && process.stderr.isTTY) process.stderr.write("\n")
  return result
}

/**
 * Classify a (partial, pollResult) pair into one of four user-facing
 * outcomes. Both checkAndRecoverPartials (auto-recover before new query)
 * and runRecover (explicit `llm recover <id>`) do the same branching; this
 * helper puts the classification logic in one place so the Gemini routing
 * fix, stale-age threshold, and status taxonomy apply uniformly.
 *
 * `partial` is optional because runRecover may be called with a raw
 * response ID that has no local partial (external callers passing IDs
 * direct from `openai.responses.create`). Without a partial, we can't
 * compute age, so "stale" never fires — pending/pending-ish statuses
 * just fall through to the caller's "still running" path.
 */
export type RecoveryOutcome =
  | {
      kind: "completed"
      content: string
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
    }
  | { kind: "failed"; status: string; error?: string }
  | { kind: "stale"; status: string; ageMs: number }
  | { kind: "pending"; status: string; ageMs: number | undefined }
  | { kind: "aborted"; status: string; error?: string }
  | { kind: "error"; status: string; error?: string }
  | { kind: "unknown"; status: string }

/** Stale threshold for pending deep-research responses: 30m. */
const STALE_THRESHOLD_MS = 30 * 60 * 1000

export function classifyRecovery(
  partial: { metadata: { startedAt: string } } | undefined,
  result: {
    status: string
    content: string
    error?: string
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  },
): RecoveryOutcome {
  // Local client abort — NEVER delete the partial. The remote job may still
  // be running; re-running `recover` later should still work. "cancelled"
  // is reserved for remote provider-terminated runs.
  if (result.status === "aborted") {
    return { kind: "aborted", status: result.status, error: result.error }
  }
  if (result.status === "completed" && result.content) {
    return { kind: "completed", content: result.content, usage: result.usage }
  }
  // "completed && !content" = provider returned completion but no body.
  // Treated as error rather than success so callers surface the failure.
  if (result.status === "completed" && !result.content) {
    return { kind: "error", status: "completed-empty", error: result.error ?? "completed with empty content" }
  }
  if (
    result.status === "failed" ||
    result.status === "cancelled" ||
    result.status === "expired" ||
    result.status === "incomplete"
  ) {
    return { kind: "failed", status: result.status, error: result.error }
  }
  if (result.status === "timeout") {
    return { kind: "error", status: result.status, error: result.error ?? "polling timed out" }
  }
  if (result.error) {
    return { kind: "error", status: result.status, error: result.error }
  }
  // Normalize running states: queued/in_progress/running/processing/submitted
  // all count as "still going".
  const runningStates = ["in_progress", "queued", "running", "processing", "submitted"]
  if (runningStates.includes(result.status)) {
    const ageMs = partial ? Date.now() - new Date(partial.metadata.startedAt).getTime() : undefined
    if (ageMs !== undefined && ageMs > STALE_THRESHOLD_MS) {
      return { kind: "stale", status: result.status, ageMs }
    }
    return { kind: "pending", status: result.status, ageMs }
  }
  return { kind: "unknown", status: result.status }
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
      emitContent(localPartial.content)

      if (!localPartial.metadata.completedAt) {
        console.error("\n---")
        console.error("This response was interrupted. Attempting to retrieve from OpenAI...")
      }
    }

    // SIGINT/SIGTERM during a 50-minute recover should stop cleanly instead
    // of running until the max-attempt ceiling. The provider-side response
    // is unaffected — user can re-run `llm recover <id>` later.
    const result = await withSignalAbort((signal) =>
      pollResponseToCompletion(responseId, /* silentProgress */ false, signal),
    )

    const outcome = classifyRecovery(localPartial ?? undefined, result)
    const { completePartial } = await import("./persistence")
    switch (outcome.kind) {
      case "completed": {
        console.error("\nFull response from OpenAI:\n")
        emitContent(outcome.content)
        if (outcome.usage) console.error(`\n[${outcome.usage.totalTokens} tokens]`)
        // finalizeOutput() inside writeRecoveredResponse already writes the
        // path line to stderr — skip the redundant "Recovered output written
        // to:" that used to print a near-identical second line.
        await writeRecoveredResponse(outcome.content, responseId, localPartial?.metadata.topic, outcome.usage)
        if (localPartial) completePartial(localPartial.path, { delete: true })
        break
      }
      case "failed": {
        console.error(`\nResponse ${outcome.status}`)
        if (localPartial) {
          completePartial(localPartial.path, { delete: true })
          console.error("Cleaned up stale partial file.")
        }
        break
      }
      case "stale": {
        console.error(`\n⚠️  Still ${outcome.status} after ${Math.round(outcome.ageMs / 60000)}m — likely stale`)
        if (localPartial) {
          completePartial(localPartial.path, { delete: true })
          console.error("Cleaned up stale partial file.")
        }
        break
      }
      case "pending": {
        const ageStr = outcome.ageMs !== undefined ? ` (${Math.round(outcome.ageMs / 60000)}m old)` : ""
        console.error(`Response ${outcome.status}${ageStr}`)
        break
      }
      case "aborted": {
        // Local Ctrl-C during recover: partial preserved. User can re-run
        // `llm recover <id>` later; the remote job is still running.
        // Exit 130 (SIGINT convention) so wrapping scripts can distinguish a
        // user interrupt from success. Flagged by K2.6 round-3 review.
        console.error(`\n⚠️  Recovery aborted locally — partial kept for future retry`)
        process.exit(130)
      }
      case "error": {
        if (!localPartial) {
          // Match runAwait's error envelope — include responseId + status so
          // scripts and the `bun llm await` caller can reason about the
          // failure without re-deriving context.
          emitJson({
            error: `Failed to retrieve: ${outcome.error}`,
            status: "failed",
            pollStatus: outcome.status,
            responseId,
          })
          process.exit(1)
        }
        console.error(`\n⚠️  Could not retrieve from OpenAI (${responseId}): ${outcome.error}`)
        break
      }
      case "unknown": {
        console.error(`Response ${outcome.status}${result.error ? `: ${result.error}` : ""}`)
        break
      }
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
    emitJson({ error: "Usage: llm await <response_id>", status: "failed" })
    process.exit(1)
  }

  const localPartial = findPartialByResponseId(responseId)
  // SIGINT/SIGTERM stops the silent poll cleanly — same rationale as
  // runRecover; a 50m poll should honour Ctrl-C.
  const result = await withSignalAbort((signal) =>
    pollResponseToCompletion(responseId, /* silentProgress */ true, signal),
  )

  if (result.status === "completed" && result.content) {
    // finalizeOutput() inside writeRecoveredResponse already emits
    // "Output written to: ..." on stderr — don't print it a second time here.
    await writeRecoveredResponse(result.content, responseId, localPartial?.metadata.topic, result.usage)
    if (localPartial) {
      const { completePartial } = await import("./persistence")
      completePartial(localPartial.path, { delete: true })
    }
    return
  }

  const errorPayload: Record<string, unknown> = {
    error: result.error ?? `Response ${result.status}`,
    status: "failed",
    pollStatus: result.status,
    responseId,
  }
  emitJson(errorPayload)
  process.exit(1)
}

/**
 * Run dual-pro mode (now three-leg champion-challenger pattern, behind config).
 *
 * Flow:
 *   - Leg A (champion): config'd top-1 — stable across calls (default gpt-5.4-pro)
 *   - Leg B (runner-up): config'd top-2 — stable across calls (default kimi-k2.6)
 *   - Leg C (challenger): rotates from a candidate pool, shadow-tested
 *
 * After all three respond, a cheap judge model rates each on a rubric
 * (specificity / actionability / correctness / depth, 1-5 each). Scores +
 * time + cost go to ab-pro.jsonl (extends, doesn't replace, the v1 format).
 *
 * Cost sliders:
 *   --no-challenger : skip leg C → 2-leg behavior (back-compat)
 *   --challenger <id>: explicit override of rotation
 *   --no-judge      : skip judge call (saves $0.01-0.05; loses scoring signal)
 *
 * A/B log lives at ~/.claude/projects/<project>/memory/ab-pro.jsonl. Each line
 * records the prompt, all three responses' cost/duration/length/score,
 * judge model, and winner. Read by `bun llm pro --leaderboard` and used by
 * the promotion threshold (`bun llm pro --promote-review`).
 *
 * Auto-falls-back to single-model `askAndFinish` if a champion provider is
 * unavailable.
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
  challengerOverride?: string
  noChallenger?: boolean
  noJudge?: boolean
  /** Extra model IDs to exclude from challenger rotation for THIS call only.
   * Joins (union) with the persistent `exclude` list in dual-pro-config.json. */
  extraExclude?: readonly string[]
}): Promise<void> {
  const { question, modelOverride, imagePath, buildContext, outputFile, sessionTag, skipConfirm } = options
  const { finalizeOutput } = await import("./format")
  const dualPro = await import("./dual-pro")

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

  // Load champion-challenger config (file + env overrides). The legacy
  // env var LLM_DUAL_PRO_B still works — applyEnvOverrides preserves it.
  const cfg = await dualPro.loadConfig()
  const gptPro = getModel(cfg.champion)
  // Leg B defaults to Kimi K2.6 (cheap sanity-check). Override with
  // LLM_DUAL_PRO_B=<modelId> for head-to-head sprints — e.g.
  // LLM_DUAL_PRO_B=gpt-5.5-pro to A/B frontier OpenAI Pros. The A/B log
  // (ab-pro.jsonl) records whichever model B was, so mixed windows are
  // disambiguated after the fact by reading `kimi.model` in each entry.
  const modelBId = cfg.runnerUp
  const kimi = getModel(modelBId)
  const gptAvailable = gptPro && isProviderAvailable(gptPro.provider)
  const kimiAvailable = kimi && isProviderAvailable(kimi.provider)

  // Effective exclude = persistent config + this-call --exclude flag (union).
  const effectiveExclude = options.extraExclude && options.extraExclude.length > 0
    ? Array.from(new Set([...cfg.exclude, ...options.extraExclude]))
    : cfg.exclude

  // Mainstays (champion / runner-up) listed in `exclude` log a warning but
  // still dispatch — explicit config wins over implicit exclude. Stale
  // leaderboard data shouldn't silently drop the model the user pinned.
  if (effectiveExclude.includes(cfg.champion)) {
    console.error(
      `⚠️  excluded model "${cfg.champion}" is set as champion — dispatching anyway. Fix dual-pro-config.json.`,
    )
  }
  if (effectiveExclude.includes(cfg.runnerUp)) {
    console.error(
      `⚠️  excluded model "${cfg.runnerUp}" is set as runnerUp — dispatching anyway. Fix dual-pro-config.json.`,
    )
  }

  // Resolve Leg C — the rotating challenger. Skipped when --no-challenger
  // or when the pool is empty after capability/availability/exclude filtering.
  let challenger: Model | undefined
  let challengerCounter = 0
  if (!options.noChallenger) {
    if (options.challengerOverride) {
      challenger = getModel(options.challengerOverride)
    } else {
      const filteredPool = dualPro.filterPoolByCapability(
        cfg.challengerPool.filter((id) => id !== cfg.champion && id !== cfg.runnerUp),
        [],
      )
      challengerCounter = await dualPro.readChallengerCounter()
      const picked = dualPro.pickNextChallenger(
        filteredPool,
        cfg.challengerStrategy,
        challengerCounter,
        effectiveExclude,
      )
      challenger = getModel(picked.modelId ?? "")
      if (challenger) await dualPro.writeChallengerCounter(picked.nextCounter)
    }
  }

  // Fall back to single-model mode if we can't run both sides.
  if (!gptAvailable || !kimiAvailable) {
    const missing = !gptAvailable
      ? "OPENAI_API_KEY"
      : !kimi
        ? `unknown model "${modelBId}"`
        : `provider key for ${kimi.provider}`
    console.error(`⚠️  Dual-pro unavailable (${missing}) — falling back to single model\n`)
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

  const challengerLabel = challenger ? ` + ${challenger.displayName} (challenger)` : ""
  console.error(`[dual-pro] Querying ${gptPro!.displayName} + ${kimi!.displayName}${challengerLabel} in parallel...`)
  // Cost estimate scales with leg B's tier. K2.6 = $0.01-0.05 (default,
  // rounding-error). A second very-high Pro (e.g. gpt-5.5-pro for A/B) ≈ $5-15.
  const legBCostStr = kimi!.costTier === "very-high" ? "$5-15" : "$0.01-0.05"
  const totalEstStr = kimi!.costTier === "very-high" ? "~$10-30" : "~$5-15"
  console.error(
    `  • Estimated cost: $5-15 (${gptPro!.displayName}) + ${legBCostStr} (${kimi!.displayName}) = ${totalEstStr} total`,
  )
  // K2.6-style thinking models use dynamic sizing via reasoning.contextWindow.
  // The actual output cap is computed per-call in research.ts (contextWindow −
  // estimated input − 4096 safety). Report the window + strategy here; per-call
  // numbers show up in the final report. Non-thinking models skip this line.
  if (kimi!.reasoning?.contextWindow || kimi!.reasoning?.maxOutputTokens) {
    const cap = kimi!.reasoning?.contextWindow
      ? `dynamic (up to ~${kimi!.reasoning.contextWindow - 4096} tokens, scales with input)`
      : `${kimi!.reasoning?.maxOutputTokens} tokens (static)`
    console.error(`  • ${kimi!.displayName} output budget: ${cap}\n`)
  } else {
    console.error("")
  }

  // Cost confirmation matches runDebate / runDeep — a multi-dollar call
  // deserves a Y/n gate. The 2026-04-20 double-fire bug made silent billing
  // mistakes worse than they would otherwise be; this is the explicit-opt-in
  // backstop. Prompt scales when both legs are Pro tier (frontier A/B).
  const proLabel =
    kimi!.costTier === "very-high"
      ? `(${gptPro!.displayName} + ${kimi!.displayName}, both Pro tier)`
      : `(mostly ${gptPro!.displayName})`
  await confirmOrExit(`⚠️  Dual-pro costs ${totalEstStr} ${proLabel}. Proceed? [Y/n] `, skipConfirm)

  const { ask } = await import("./research")
  const { queryOpenAIBackground, isOpenAIBackgroundCapable } = await import("./openai-deep")

  // Route the GPT leg through the Responses API so the call is recoverable:
  // a 30+ min Pro call that gets SIGINT / network-hiccup / wall-clock killed
  // still persists its responseId, and `bun llm recover <id>` reattaches to
  // the server-side work. K2.6 cannot take this path — OpenRouter doesn't
  // expose the Responses API, so the Kimi leg stays on generateText (if it's
  // aborted, work is lost — acceptable given the ~30s typical runtime).
  //
  // imagePath disables the background path — the Responses-API background
  // helper is text-only today, and silently dropping the image would be worse
  // than losing recoverability for the rare image+pro case.
  const canBackgroundGpt = isOpenAIBackgroundCapable(gptPro!) && !imagePath
  // Leg B also qualifies when it's an OpenAI Pro (e.g. gpt-5.5-pro A/B).
  // K2.6 doesn't — OpenRouter doesn't expose the Responses API, so Kimi stays
  // on generateText (if aborted, work is lost — acceptable given ~30s runtime).
  const canBackgroundKimi = isOpenAIBackgroundCapable(kimi!) && !imagePath
  const canBackgroundChallenger = challenger ? isOpenAIBackgroundCapable(challenger) && !imagePath : false

  // Fire all three in parallel. Streaming is disabled — multi streams would
  // interleave unreadably on stderr. Users read the final files.
  //
  // SIGINT-only cancellation. Previously this wrapper enforced a wall-clock
  // ceiling (5 min → scaled → removed here) that kept killing legitimate
  // long-context queries. With the GPT leg on background mode the user can
  // always `bun llm recover <id>` to reattach — losing the local process is
  // no longer terminal for the work.
  //
  // imagePath is forwarded explicitly — dropping it would silently degrade
  // `--image` to text-only.
  const dispatchOne = (m: Model, useBackground: boolean, ac: AbortController) =>
    useBackground
      ? queryOpenAIBackground({
          prompt: enrichedQuestion,
          model: m,
          topic: question,
          abortSignal: ac.signal,
        })
      : ask(enrichedQuestion, "standard", {
          modelOverride: m.modelId,
          stream: false,
          imagePath,
          abortSignal: ac.signal,
        })

  const [gptResult, kimiResult, challengerResult] = await withSignalAbort(async (outerSignal) => {
    const ac = new AbortController()
    const onOuterAbort = () => ac.abort(outerSignal.reason ?? "aborted")
    if (outerSignal.aborted) onOuterAbort()
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true })
    try {
      const calls: Promise<import("./types").ModelResponse>[] = [
        dispatchOne(gptPro!, canBackgroundGpt, ac),
        dispatchOne(kimi!, canBackgroundKimi, ac),
      ]
      if (challenger) calls.push(dispatchOne(challenger, canBackgroundChallenger, ac))
      const settled = await Promise.allSettled(calls)
      return [settled[0]!, settled[1]!, settled[2]] as const
    } finally {
      outerSignal.removeEventListener("abort", onOuterAbort)
    }
  })

  // Normalize both legs to a consistent (ok, error) shape. "Success" requires
  // non-empty trimmed content AND no error — a fulfilled promise with empty
  // content (reasoning-exhaustion, abort, API quirks) is a failure, not a
  // silent-success. Previously the progress line said ✓ while the combined
  // report said ⚠️ Failed for the same call — inconsistent + debug-hostile.
  const gptResp = gptResult.status === "fulfilled" ? gptResult.value : undefined
  const kimiResp = kimiResult.status === "fulfilled" ? kimiResult.value : undefined
  const challengerResp = challengerResult?.status === "fulfilled" ? challengerResult.value : undefined
  const gptErrRaw = gptResult.status === "rejected" ? String(gptResult.reason) : gptResp?.error
  const kimiErrRaw = kimiResult.status === "rejected" ? String(kimiResult.reason) : kimiResp?.error
  const challengerErrRaw =
    challengerResult?.status === "rejected" ? String(challengerResult.reason) : challengerResp?.error
  const gptOk = !gptErrRaw && !!gptResp?.content && gptResp.content.trim().length > 0
  const kimiOk = !kimiErrRaw && !!kimiResp?.content && kimiResp.content.trim().length > 0
  const challengerOk =
    !!challenger && !challengerErrRaw && !!challengerResp?.content && challengerResp.content.trim().length > 0
  const gptErr = gptErrRaw ?? (gptResp && !gptOk ? "empty content" : undefined)
  const kimiErr = kimiErrRaw ?? (kimiResp && !kimiOk ? "empty content" : undefined)
  const challengerErr = challengerErrRaw ?? (challengerResp && !challengerOk ? "empty content" : undefined)

  if (gptOk && gptResp)
    console.error(
      `  ✓ ${gptPro!.displayName} (${gptResp.usage?.totalTokens ?? 0} tok, ${Math.round(gptResp.durationMs / 1000)}s)`,
    )
  else console.error(`  ✗ ${gptPro!.displayName}: ${gptErr ?? "unknown failure"}`)
  if (kimiOk && kimiResp)
    console.error(
      `  ✓ ${kimi!.displayName} (${kimiResp.usage?.totalTokens ?? 0} tok, ${Math.round(kimiResp.durationMs / 1000)}s)`,
    )
  else console.error(`  ✗ ${kimi!.displayName}: ${kimiErr ?? "unknown failure"}`)
  if (challenger) {
    if (challengerOk && challengerResp)
      console.error(
        `  ✓ ${challenger.displayName} [challenger] (${challengerResp.usage?.totalTokens ?? 0} tok, ${Math.round(challengerResp.durationMs / 1000)}s)`,
      )
    else console.error(`  ✗ ${challenger.displayName} [challenger]: ${challengerErr ?? "unknown failure"}`)
  }

  // Build the combined report. All responses presented side-by-side, headers
  // labelled so the reader can diff. Non-fatal errors surface inline so the
  // reader sees which model failed without digging through logs.
  const gptCost = gptResp?.usage ? estimateCost(gptPro!, gptResp.usage.promptTokens, gptResp.usage.completionTokens) : 0
  const kimiCost = kimiResp?.usage
    ? estimateCost(kimi!, kimiResp.usage.promptTokens, kimiResp.usage.completionTokens)
    : 0
  const challengerCost =
    challenger && challengerResp?.usage
      ? estimateCost(challenger, challengerResp.usage.promptTokens, challengerResp.usage.completionTokens)
      : 0
  const totalCost = gptCost + kimiCost + challengerCost

  // Judge — score each leg via a cheap model. Skipped on --no-judge or
  // when no leg succeeded (nothing to score). Failures don't abort the
  // run — the user-facing report still ships, just without scores.
  let judgeResult: import("./dual-pro").JudgeResult | undefined
  let judgeError: string | undefined
  let judgeCost = 0
  let judgeModelId: string | undefined
  if (!options.noJudge && (gptOk || kimiOk || challengerOk)) {
    const judgeModel = getModel(cfg.judge)
    if (!judgeModel) {
      judgeError = `judge model "${cfg.judge}" not found in registry`
    } else if (!isProviderAvailable(judgeModel.provider)) {
      judgeError = `judge unavailable: ${getProviderEnvVar(judgeModel.provider)} not set`
    } else {
      judgeModelId = judgeModel.modelId
      const judgeResponses: { id: "a" | "b" | "c"; model: string; content: string }[] = []
      if (gptOk && gptResp) judgeResponses.push({ id: "a", model: gptPro!.displayName, content: gptResp.content })
      if (kimiOk && kimiResp) judgeResponses.push({ id: "b", model: kimi!.displayName, content: kimiResp.content })
      if (challengerOk && challengerResp && challenger)
        judgeResponses.push({ id: "c", model: challenger.displayName, content: challengerResp.content })
      const judgePrompt = dualPro.buildJudgePrompt({ question, responses: judgeResponses, rubric: cfg.rubric })
      try {
        console.error(`\n[dual-pro] Judging via ${judgeModel.displayName}...`)
        const judgeRaw = await ask(judgePrompt, "quick", { modelOverride: judgeModel.modelId, stream: false })
        if (judgeRaw.usage)
          judgeCost = estimateCost(judgeModel, judgeRaw.usage.promptTokens, judgeRaw.usage.completionTokens)
        if (judgeRaw.content) judgeResult = dualPro.parseJudgeResponse(judgeRaw.content)
        if (!judgeResult) judgeError = "judge response unparseable"
      } catch (e) {
        judgeError = `judge call failed: ${e instanceof Error ? e.message : String(e)}`
      }
    }
    if (judgeError) console.error(`  ⚠ judge unavailable: ${judgeError}`)
  }

  const parts: string[] = []
  parts.push(`# Dual-Pro Response\n`)
  parts.push(`**Question**: ${question}\n`)
  parts.push(`**Models**: ${gptPro!.displayName} + ${kimi!.displayName}`)
  parts.push(`**Total cost**: ${formatCost(totalCost)} (${formatCost(gptCost)} + ${formatCost(kimiCost)})\n`)

  parts.push(`---\n`)
  parts.push(`## ${gptPro!.displayName}`)
  if (gptOk && gptResp) {
    const meta = `_${gptResp.usage?.totalTokens ?? 0} tokens · ${Math.round(gptResp.durationMs / 1000)}s · ${formatCost(gptCost)}_`
    parts.push(meta + "\n")
    parts.push(gptResp.content.trim())
  } else {
    parts.push(`⚠️  Failed: ${gptErr ?? "no content"}`)
  }

  parts.push(`\n---\n`)
  parts.push(`## ${kimi!.displayName}`)
  if (kimiOk && kimiResp) {
    const meta = `_${kimiResp.usage?.totalTokens ?? 0} tokens · ${Math.round(kimiResp.durationMs / 1000)}s · ${formatCost(kimiCost)}_`
    parts.push(meta + "\n")
    parts.push(kimiResp.content.trim())
  } else {
    parts.push(`⚠️  Failed: ${kimiErr ?? "no content"}`)
  }

  if (challenger) {
    parts.push(`\n---\n`)
    parts.push(`## ${challenger.displayName} [challenger]`)
    if (challengerOk && challengerResp) {
      const meta = `_${challengerResp.usage?.totalTokens ?? 0} tokens · ${Math.round(challengerResp.durationMs / 1000)}s · ${formatCost(challengerCost)}_`
      parts.push(meta + "\n")
      parts.push(challengerResp.content.trim())
    } else {
      parts.push(`⚠️  Failed: ${challengerErr ?? "no content"}`)
    }
  }

  if (judgeResult) {
    parts.push(`\n---\n`)
    parts.push(`## Judge breakdown (${judgeModelId ?? cfg.judge})\n`)
    const fmtRow = (
      id: "a" | "b" | "c",
      label: string,
      breakdown: import("./dual-pro").JudgeBreakdown | null | undefined,
    ) => {
      if (!breakdown) return `- **${id.toUpperCase()}** ${label}: skipped (failed)`
      const s = breakdown.scores
      return `- **${id.toUpperCase()}** ${label}: spec ${s.specificity}, action ${s.actionability}, correct ${s.correctness}, depth ${s.depth} → **total ${breakdown.total}**`
    }
    parts.push(fmtRow("a", gptPro!.displayName, judgeResult.a))
    parts.push(fmtRow("b", kimi!.displayName, judgeResult.b))
    if (challenger) parts.push(fmtRow("c", `${challenger.displayName} [challenger]`, judgeResult.c ?? null))
    parts.push(
      `\n**Winner**: ${judgeResult.winner.toUpperCase()}${judgeResult.reasoning ? ` — ${judgeResult.reasoning}` : ""}`,
    )
  } else if (judgeError) {
    parts.push(`\n---\n`)
    parts.push(`_Judge unavailable: ${judgeError}_`)
  }

  const combined = parts.join("\n")

  // Dual-pro envelope ships per-leg sections (a, b) so skill consumers can
  // branch on which leg produced what without re-parsing the combined report.
  // Schema: { ..., a: {model, tokens, cost, durationMs, status}, b: {...} }
  const aLeg = {
    model: gptPro!.displayName,
    tokens: gptResp?.usage
      ? {
          prompt: gptResp.usage.promptTokens,
          completion: gptResp.usage.completionTokens,
          total: gptResp.usage.totalTokens,
        }
      : undefined,
    cost: gptCost,
    durationMs: gptResp?.durationMs,
    status: (gptOk ? "completed" : "failed") as "completed" | "failed",
    error: gptErr,
  }
  const bLeg = {
    model: kimi!.displayName,
    tokens: kimiResp?.usage
      ? {
          prompt: kimiResp.usage.promptTokens,
          completion: kimiResp.usage.completionTokens,
          total: kimiResp.usage.totalTokens,
        }
      : undefined,
    cost: kimiCost,
    durationMs: kimiResp?.durationMs,
    status: (kimiOk ? "completed" : "failed") as "completed" | "failed",
    error: kimiErr,
  }
  const cLeg = challenger
    ? {
        model: challenger.displayName,
        tokens: challengerResp?.usage
          ? {
              prompt: challengerResp.usage.promptTokens,
              completion: challengerResp.usage.completionTokens,
              total: challengerResp.usage.totalTokens,
            }
          : undefined,
        cost: challengerCost,
        durationMs: challengerResp?.durationMs,
        status: (challengerOk ? "completed" : "failed") as "completed" | "failed",
        error: challengerErr,
      }
    : undefined
  // Combine prompt/completion totals across legs so the top-level `tokens`
  // is the canonical {prompt, completion, total} shape (mirrors single-model
  // emission). Total cost stays a single USD number.
  const combinedTokens =
    gptResp?.usage || kimiResp?.usage || challengerResp?.usage
      ? {
          prompt:
            (gptResp?.usage?.promptTokens ?? 0) +
            (kimiResp?.usage?.promptTokens ?? 0) +
            (challengerResp?.usage?.promptTokens ?? 0),
          completion:
            (gptResp?.usage?.completionTokens ?? 0) +
            (kimiResp?.usage?.completionTokens ?? 0) +
            (challengerResp?.usage?.completionTokens ?? 0),
          total:
            (gptResp?.usage?.totalTokens ?? 0) +
            (kimiResp?.usage?.totalTokens ?? 0) +
            (challengerResp?.usage?.totalTokens ?? 0),
        }
      : undefined
  // Build a leaderboard snapshot at write time for skill consumers that
  // want the current rankings without re-reading ab-pro.jsonl.
  const priorEntries = await dualPro.readAbProLog()
  const leaderboardSnapshot = dualPro.buildLeaderboard(priorEntries, cfg.scoreWeights)
  await finalizeOutput(combined, outputFile, sessionTag, {
    query: question,
    model: `dual-pro (${gptPro!.displayName} + ${kimi!.displayName}${challenger ? ` + ${challenger.displayName}` : ""})`,
    tokens: combinedTokens,
    cost: formatCost(totalCost + judgeCost),
    costUsd: totalCost + judgeCost,
    durationMs: Math.max(gptResp?.durationMs ?? 0, kimiResp?.durationMs ?? 0, challengerResp?.durationMs ?? 0),
    status: gptOk || kimiOk || challengerOk ? "completed" : "failed",
    a: aLeg,
    b: bLeg,
    c: cLeg,
    judge: judgeResult
      ? {
          model: judgeModelId,
          winner: judgeResult.winner,
          reasoning: judgeResult.reasoning,
          a: judgeResult.a,
          b: judgeResult.b,
          c: judgeResult.c,
          cost: judgeCost,
        }
      : judgeError
        ? { error: judgeError }
        : undefined,
    leaderboardSnapshot: leaderboardSnapshot.slice(0, 10).map((r) => r as unknown as Record<string, unknown>),
  })

  // Append an A/B log entry so we can review quality over time. Extended
  // shape carries leg C + judge scores; appendAbProLog still writes the
  // legacy gpt/kimi keys for back-compat with v1 readers.
  await appendAbProLog({
    question,
    sessionTag,
    outputFile,
    gpt: { model: gptPro!, response: gptResp, error: gptErr, score: judgeResult?.a ?? null },
    kimi: { model: kimi!, response: kimiResp, error: kimiErr, score: judgeResult?.b ?? null },
    challenger: challenger
      ? { model: challenger, response: challengerResp, error: challengerErr, score: judgeResult?.c ?? null }
      : undefined,
    gptCost,
    kimiCost,
    challengerCost,
    judgeModel: judgeModelId,
    judgeWinner: judgeResult?.winner,
    judgeReasoning: judgeResult?.reasoning,
    judgeError,
    judgeCost,
    rubric: cfg.rubric,
  })

  // Promotion banner: if the leaderboard now suggests the challenger has
  // earned a promotion conversation, surface a non-blocking hint. Never
  // auto-switches.
  try {
    const updated = await dualPro.readAbProLog()
    const updatedBoard = dualPro.buildLeaderboard(updated, cfg.scoreWeights)
    const verdict = dualPro.evaluatePromotion(updatedBoard, cfg.champion, cfg.challengerPool)
    if (verdict.shouldOfferPromotion && verdict.challenger) {
      console.error(
        `\n🏆 Promotion candidate: ${verdict.challenger.model} (${verdict.reason}). Run \`bun llm pro --promote-review\`.`,
      )
    }
  } catch {
    // Best-effort signal.
  }

  // If all (relevant) legs failed, surface as a non-zero exit so scripts
  // don't mistake an error report for a success. The combined report + A/B
  // log still get written — useful for post-mortem — but the caller knows
  // it went wrong. Keep the legacy "Both dual-pro legs failed" message for
  // back-compat with downstream scripts that grep for it.
  const allFailed = !gptOk && !kimiOk && (!challenger || !challengerOk)
  if (allFailed) {
    const msg = challenger
      ? "\n⚠️  All dual-pro legs failed — see report for details."
      : "\n⚠️  Both dual-pro legs failed — see report for details."
    console.error(msg)
    process.exit(1)
  }
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
  gpt: {
    model: Model
    response: import("./types").ModelResponse | undefined
    error: string | undefined
    score?: import("./dual-pro").JudgeBreakdown | null
  }
  kimi: {
    model: Model
    response: import("./types").ModelResponse | undefined
    error: string | undefined
    score?: import("./dual-pro").JudgeBreakdown | null
  }
  challenger?: {
    model: Model
    response: import("./types").ModelResponse | undefined
    error: string | undefined
    score?: import("./dual-pro").JudgeBreakdown | null
  }
  gptCost: number
  kimiCost: number
  challengerCost?: number
  judgeModel?: string
  judgeWinner?: "a" | "b" | "c" | "tie"
  judgeReasoning?: string
  judgeError?: string
  judgeCost?: number
  rubric?: string
}): Promise<void> {
  try {
    const os = await import("os")
    const fs = await import("fs")
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd()
    const encoded = projectRoot.replace(/\//g, "-")
    // Prefer HOME env (test isolation respects it; os.homedir() reads from
    // getuid() and ignores HOME, leaking writes into the real user profile).
    const home = process.env.HOME || os.homedir()
    const dir = `${home}/.claude/projects/${encoded}/memory`
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    // Build a compact leg snapshot — both legacy gpt/kimi keys (for v1
    // readers) and the new a/b/c shape live in the same line. The
    // leaderboard reader normalizes both.
    const legSnapshot = (
      m: Model,
      response: import("./types").ModelResponse | undefined,
      error: string | undefined,
      cost: number,
      score?: import("./dual-pro").JudgeBreakdown | null,
    ) => ({
      model: m.modelId,
      ok: !!response?.content && response.content.trim().length > 0 && !error,
      error,
      tokens: response?.usage?.totalTokens,
      promptTokens: response?.usage?.promptTokens,
      completionTokens: response?.usage?.completionTokens,
      durationMs: response?.durationMs,
      chars: response?.content?.length,
      // Inline content so retroactive judging never depends on /tmp/llm-*.txt
      // file lifetime (auto-cleaned at 7 days). Adds ~3-50KB per entry; at
      // 1000 entries the JSONL stays under ~50MB. Worth the disk for the
      // ability to rescore historical runs against new judge models forever.
      content: response?.content,
      cost,
      score: score ?? null,
    })
    // Stable-ish hash of the question for leaderboard correlation. djb2.
    const queryHash = (() => {
      let h = 5381
      for (let i = 0; i < entry.question.length; i++) h = ((h << 5) + h + entry.question.charCodeAt(i)) >>> 0
      return h.toString(16)
    })()
    const a = legSnapshot(entry.gpt.model, entry.gpt.response, entry.gpt.error, entry.gptCost, entry.gpt.score)
    const b = legSnapshot(entry.kimi.model, entry.kimi.response, entry.kimi.error, entry.kimiCost, entry.kimi.score)
    const c = entry.challenger
      ? legSnapshot(
          entry.challenger.model,
          entry.challenger.response,
          entry.challenger.error,
          entry.challengerCost ?? 0,
          entry.challenger.score,
        )
      : undefined
    const line =
      JSON.stringify({
        // Schema version so future readers can detect format drift. v2
        // adds a/b/c keys + judge fields; v1 gpt/kimi keys remain for
        // back-compat. Readers should treat unknown fields as opaque.
        schema: "ab-pro/v2",
        timestamp: new Date().toISOString(),
        session: entry.sessionTag,
        question: entry.question,
        queryHash,
        outputFile: entry.outputFile,
        // v1 (back-compat) — same payload as v1 readers expect.
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
        // v2 — a/b/c + judge.
        a,
        b,
        c,
        judge:
          entry.judgeWinner || entry.judgeError
            ? {
                model: entry.judgeModel,
                winner: entry.judgeWinner,
                reasoning: entry.judgeReasoning,
                error: entry.judgeError,
                cost: entry.judgeCost,
                rubric: entry.rubric,
              }
            : undefined,
      }) + "\n"
    fs.appendFileSync(`${dir}/ab-pro.jsonl`, line)
  } catch {
    // Best-effort log
  }
}

// --------------------------------------------------------------------
// Sub-commands: --leaderboard / --promote-review / --backtest
// (km-bearly.llm-dual-pro-shadow-test)
// --------------------------------------------------------------------

/**
 * `bun llm pro --leaderboard` — print the current ranked leaderboard from
 * ab-pro.jsonl. **Default sort is by raw quality (judge score)** — we
 * optimize for raw intellect; cost surfaces as a column for context. Use
 * `--rank-by-cost` to sort by cost-aware rank (quality minus log-cost
 * penalty above $0.10). Speed and failure rate display only.
 */
export async function runLeaderboard(opts: { rankByCost?: boolean } = {}): Promise<void> {
  const dualPro = await import("./dual-pro")
  const cfg = await dualPro.loadConfig()
  const entries = await dualPro.readAbProLog()
  if (entries.length === 0) {
    console.error("No ab-pro.jsonl entries yet. Run `bun llm pro <question>` to start collecting data.")
    if (isJsonMode()) emitJson({ rows: [], status: "empty" })
    return
  }
  // Always compute cost-aware rank for the Rank column. Sort order is what
  // changes between modes.
  const rows = dualPro.buildLeaderboard(entries, cfg.scoreWeights)
  if (!opts.rankByCost) {
    // Default: sort by raw quality (avgScore desc, then calls desc as tiebreaker).
    rows.sort((x, y) => y.avgScore - x.avgScore || y.calls - x.calls)
  }
  // Quality warning: any model with avgScore below threshold AND ≥ 20 calls
  // (enough evidence to be a real signal, not first-row noise) gets a `⚠️`
  // prefix in the rendered name. Visual-only — does not affect dispatch. To
  // actually evict, add the model to `exclude` in dual-pro-config.json.
  const QUALITY_WARNING_MIN_CALLS = 20
  const qualityThreshold = cfg.scoreWeights.qualityWarningThreshold
  const isQualityWarning = (r: LeaderboardRow) =>
    r.calls >= QUALITY_WARNING_MIN_CALLS && r.avgScore < qualityThreshold
  const warnings = rows.filter(isQualityWarning)

  if (isJsonMode()) {
    emitJson({
      rows: rows.map((r) => ({ ...r, qualityWarning: isQualityWarning(r) })),
      status: "ok",
      weights: cfg.scoreWeights,
      mode: opts.rankByCost ? "rank-by-cost" : "by-quality",
      total: entries.length,
      qualityWarnings: warnings.map((r) => r.model),
      exclude: cfg.exclude,
    })
    return
  }
  // Plain-text table — column-aligned for skim-readability. Fixed widths.
  const fmtPct = (n: number) => `${(n * 100).toFixed(0)}%`
  const fmtMs = (n: number) => `${(n / 1000).toFixed(1)}s`
  const fmtScore = (n: number) => n.toFixed(2)
  const fmtCost = (n: number) => `$${n.toFixed(3)}`
  const headerNote = opts.rankByCost
    ? `sorted by Rank (quality − log-cost penalty above $${cfg.scoreWeights.costThreshold.toFixed(2)})`
    : `sorted by Quality — raw intellect (use --rank-by-cost for cost-aware sort)`
  console.error(`\nLeaderboard (${entries.length} runs, ${headerNote})\n`)
  console.error(
    `${"Model".padEnd(36)} ${"Calls".padStart(6)} ${"Quality".padStart(9)} ${"FailRate".padStart(9)} ${"Cost".padStart(9)} ${"Speed".padStart(8)} ${"Rank".padStart(7)}`,
  )
  console.error("-".repeat(92))
  for (const r of rows) {
    const flagged = isQualityWarning(r)
    const prefix = flagged ? "⚠️ " : ""
    const modelCell = `${prefix}${r.model}`
    console.error(
      `${modelCell.padEnd(36)} ${String(r.calls).padStart(6)} ${fmtScore(r.avgScore).padStart(9)} ${fmtPct(r.failureRate).padStart(9)} ${fmtCost(r.avgCost).padStart(9)} ${fmtMs(r.avgTimeMs).padStart(8)} ${fmtScore(r.rankScore).padStart(7)}`,
    )
  }
  if (warnings.length > 0) {
    const ids = warnings.map((r) => `"${r.model}"`).join(", ")
    console.error(
      `\n⚠️  rows = quality below ${qualityThreshold.toFixed(1)} (≥${QUALITY_WARNING_MIN_CALLS} calls). Consider adding to exclude: [${ids}] in dual-pro-config.json`,
    )
  }
  console.error("")
}

/**
 * `bun llm pro --promote-review` — show leaderboard, surface 3 sample
 * queries where models diverged most, then prompt:
 *   [P]romote / [W]atch / [D]emote / [C]ancel
 *
 * Decision is recorded to dual-pro-promotions.jsonl. We do NOT actually
 * rewrite dual-pro-config.json automatically yet — the user is expected
 * to edit the file manually after the prompt confirms intent. Auto-rewrite
 * is a one-line follow-up but the manual step keeps every promotion
 * traceable to a literal git diff in the project.
 */
export async function runPromoteReview(opts: { skipConfirm?: boolean } = {}): Promise<void> {
  const dualPro = await import("./dual-pro")
  const cfg = await dualPro.loadConfig()
  const entries = await dualPro.readAbProLog()
  const rows = dualPro.buildLeaderboard(entries, cfg.scoreWeights)
  await runLeaderboard()
  const verdict = dualPro.evaluatePromotion(rows, cfg.champion, cfg.challengerPool)
  console.error(`Verdict: ${verdict.reason}`)
  if (!verdict.shouldOfferPromotion) {
    if (isJsonMode()) emitJson({ status: "no-action", reason: verdict.reason, leaderboard: rows.slice(0, 10) })
    return
  }
  // Find divergent queries: where leg A and leg C scored different totals.
  // Subset is whatever's available; gives the human a flavor of the kind
  // of queries that actually diverge.
  const divergent = entries
    .filter((e) => e.a?.score?.total != null && e.c?.score?.total != null && e.a.score.total !== e.c.score.total)
    .slice(-3)
  console.error(`\nDivergent samples (judge winner / scores):`)
  for (const e of divergent) {
    const aT = e.a?.score?.total ?? "?"
    const bT = e.b?.score?.total ?? "?"
    const cT = e.c?.score?.total ?? "?"
    console.error(`  • ${(e.question ?? "").slice(0, 70)}  (a=${aT}, b=${bT}, c=${cT})`)
  }
  if (isJsonMode()) {
    emitJson({
      status: "offer",
      verdict: {
        challenger: verdict.challenger,
        champion: verdict.champion,
        reason: verdict.reason,
      },
      leaderboard: rows.slice(0, 10),
      divergentSamples: divergent.length,
    })
    return
  }
  // Interactive prompt — re-uses the confirm pattern from elsewhere.
  if (opts.skipConfirm) {
    console.error("\n(--yes set; recording 'keep-watching' decision and exiting without changes.)")
    await dualPro.appendPromotionDecision({
      oldChampion: cfg.champion,
      oldRunnerUp: cfg.runnerUp,
      decision: "keep-watching",
      reasoning: "auto-yes — no interactive confirmation",
      challenger: verdict.challenger,
    })
    return
  }
  const choice = await promptChoice(
    `\nPromote ${verdict.challenger?.model} to champion? [P]romote / [W]atch / [D]emote (promote-and-demote runner) / [C]ancel: `,
    ["p", "w", "d", "c"],
  )
  const decisionMap: Record<string, "promote" | "promote-and-demote" | "keep-watching" | "cancel"> = {
    p: "promote",
    d: "promote-and-demote",
    w: "keep-watching",
    c: "cancel",
  }
  const decision = decisionMap[choice]!
  await dualPro.appendPromotionDecision({
    oldChampion: cfg.champion,
    oldRunnerUp: cfg.runnerUp,
    newChampion: decision === "promote" || decision === "promote-and-demote" ? verdict.challenger?.model : undefined,
    newRunnerUp: decision === "promote-and-demote" ? cfg.champion : undefined,
    decision,
    reasoning: verdict.reason,
    challenger: verdict.challenger,
  })
  if (decision === "promote" || decision === "promote-and-demote") {
    console.error(
      `\nDecision recorded. Edit ${dualPro.getMemoryDir()}/dual-pro-config.json to apply (champion: "${verdict.challenger?.model}").`,
    )
  } else {
    console.error(`\nDecision recorded: ${decision}.`)
  }
}

/** Read a single keystroke or 'P/W/D/C\n' line from stdin in raw mode. */
async function promptChoice(prompt: string, allowed: readonly string[]): Promise<string> {
  process.stderr.write(prompt)
  // Falls back to readline if stdin isn't TTY (e.g. piped tests).
  if (!process.stdin.isTTY) {
    const readline = await import("readline")
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false })
    const answer: string = await new Promise((resolve) =>
      rl.question("", (a) => {
        rl.close()
        resolve(a.trim().toLowerCase())
      }),
    )
    return allowed.includes(answer[0] ?? "") ? (answer[0] as string) : "c"
  }
  // TTY raw mode — single keystroke. Mirrors confirmOrExit.
  return new Promise<string>((resolve) => {
    const stdin = process.stdin
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    const onData = (chunk: string) => {
      const ch = chunk.toLowerCase()[0] ?? ""
      stdin.setRawMode?.(false)
      stdin.pause()
      stdin.off("data", onData)
      process.stderr.write("\n")
      resolve(allowed.includes(ch) ? ch : "c")
    }
    stdin.on("data", onData)
  })
}

/**
 * `bun llm pro --backtest` — sample N queries from ab-pro.jsonl, re-fire
 * each through OLD config (current champ/runner) AND NEW config (proposed),
 * judge with the same model, and compare scores.
 *
 * --quick           cheap judge + small sample for rapid iteration
 * --no-old-fire     only fire NEW; compare against archived OLD scores
 * --no-challenger   match runtime cost shape (skip leg C)
 * --challenger <id> override challenger
 * --sample <N>      sample size (default 30, --quick = 5)
 *
 * Surfaces a cost estimate before firing and requires explicit
 * confirmation when estimate exceeds $50.
 */
export async function runBacktest(opts: {
  sample?: number
  quick?: boolean
  noOldFire?: boolean
  noChallenger?: boolean
  challengerOverride?: string
  skipConfirm?: boolean
}): Promise<void> {
  const dualPro = await import("./dual-pro")
  const cfg = await dualPro.loadConfig()
  const entries = await dualPro.readAbProLog()
  const sampleSize = opts.sample ?? (opts.quick ? 5 : 30)
  const sample = dualPro.sampleBacktestEntries(entries, { size: sampleSize })

  if (sample.length === 0) {
    console.error("No ab-pro.jsonl entries available for backtest. Run `bun llm pro <q>` first.")
    if (isJsonMode()) emitJson({ status: "empty", report: undefined })
    return
  }

  // Cost estimate. With default settings: sample × 3 models × cost × 2
  // (OLD + NEW). --no-old-fire halves it; --no-challenger drops by a third.
  const champion = getModel(cfg.champion)
  const runner = getModel(cfg.runnerUp)
  // Backtest fixes ONE challenger across the entire sample for fair OLD-vs-NEW
  // comparison. Deliberately does NOT call pickNextChallenger — replaying the
  // historical leg-C model would conflate "compare configs" with "reproduce
  // history" and is not what backtest is for. Override via --challenger.
  const challengerId = opts.challengerOverride ?? cfg.challengerPool[0]
  const challenger = opts.noChallenger ? undefined : challengerId ? getModel(challengerId) : undefined
  const perLegEst = (m: Model | undefined) => (m ? estimateCost(m, 1500, 1500) : 0)
  const oldCallCost = perLegEst(champion) + perLegEst(runner) + (opts.noChallenger ? 0 : perLegEst(challenger))
  const newCallCost = oldCallCost
  const judgeModel = getModel(opts.quick ? "gpt-5-nano" : cfg.judge) ?? getModel("gpt-5-mini")
  const judgeCost = judgeModel ? estimateCost(judgeModel, 4000, 800) : 0
  const perQuery = ((opts.noOldFire ? 1 : 2) * (oldCallCost + newCallCost)) / 2 + judgeCost * (opts.noOldFire ? 1 : 2)
  const totalEst = perQuery * sample.length

  console.error(
    `\nBacktest: ${sample.length} queries, judge=${judgeModel?.displayName ?? cfg.judge}${opts.quick ? " (quick)" : ""}${opts.noOldFire ? ", NEW-only" : ", OLD+NEW"}`,
  )
  console.error(`Estimated cost: ${formatCost(totalEst)}`)

  if (totalEst > 50) {
    await confirmOrExit(`⚠️  Estimated cost exceeds $50. Proceed? [Y/n] `, !!opts.skipConfirm)
  }

  // Re-fire each sample. We use ask() for OLD/NEW to keep it simple — full
  // background-API recovery isn't needed for offline backtest. Judge call
  // shares parseJudgeResponse with the live path.
  const perQueryResults: import("./dual-pro").BacktestPerQueryResult[] = []
  let i = 0
  for (const entry of sample) {
    i++
    const q = entry.question ?? ""
    if (!q) continue
    console.error(`  [${i}/${sample.length}] ${q.slice(0, 60)}...`)

    let oldA, oldB, newA, newB, newC
    try {
      if (!opts.noOldFire) {
        if (champion) oldA = await ask(q, "standard", { modelOverride: champion.modelId, stream: false })
        if (runner) oldB = await ask(q, "standard", { modelOverride: runner.modelId, stream: false })
      }
      if (champion) newA = await ask(q, "standard", { modelOverride: champion.modelId, stream: false })
      if (runner) newB = await ask(q, "standard", { modelOverride: runner.modelId, stream: false })
      if (challenger) newC = await ask(q, "standard", { modelOverride: challenger.modelId, stream: false })
    } catch (e) {
      console.error(`    skip — fire failed: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }

    const judgeFor = async (responses: { id: "a" | "b" | "c"; model: string; content: string }[]) => {
      if (!judgeModel || responses.length === 0) return undefined
      const prompt = dualPro.buildJudgePrompt({ question: q, responses, rubric: cfg.rubric })
      try {
        const r = await ask(prompt, "quick", { modelOverride: judgeModel.modelId, stream: false })
        return dualPro.parseJudgeResponse(r.content)
      } catch {
        return undefined
      }
    }

    const oldResponses: { id: "a" | "b" | "c"; model: string; content: string }[] = []
    if (oldA?.content) oldResponses.push({ id: "a", model: champion!.displayName, content: oldA.content })
    if (oldB?.content) oldResponses.push({ id: "b", model: runner!.displayName, content: oldB.content })
    const newResponses: { id: "a" | "b" | "c"; model: string; content: string }[] = []
    if (newA?.content) newResponses.push({ id: "a", model: champion!.displayName, content: newA.content })
    if (newB?.content) newResponses.push({ id: "b", model: runner!.displayName, content: newB.content })
    if (newC?.content && challenger)
      newResponses.push({ id: "c", model: challenger.displayName, content: newC.content })

    const oldJudge = opts.noOldFire ? undefined : await judgeFor(oldResponses)
    const newJudge = await judgeFor(newResponses)

    const bestTotal = (j?: import("./dual-pro").JudgeResult) => {
      if (!j) return undefined
      return Math.max(j.a?.total ?? 0, j.b?.total ?? 0, j.c?.total ?? 0)
    }
    // For --no-old-fire, fall back to the historical score on the entry.
    let oldTotal: number | undefined = bestTotal(oldJudge)
    if (oldTotal === undefined && opts.noOldFire) {
      oldTotal = Math.max(entry.a?.score?.total ?? 0, entry.b?.score?.total ?? 0)
    }
    perQueryResults.push({
      question: q,
      oldWinner: oldJudge?.winner,
      newWinner: newJudge?.winner,
      oldTotal,
      newTotal: bestTotal(newJudge),
    })
  }

  const report = dualPro.aggregateBacktest(perQueryResults)
  await dualPro.appendBacktestRun({
    oldConfig: { champion: cfg.champion, runnerUp: cfg.runnerUp },
    newConfig: { challengerPool: [challengerId ?? ""].filter(Boolean) },
    report,
    decision: "deferred",
    noOldFire: !!opts.noOldFire,
    quick: !!opts.quick,
  })

  if (isJsonMode()) {
    emitJson({ status: "ok", report })
  } else {
    console.error("")
    console.error(dualPro.formatBacktestReport(report))
  }
}

/**
 * Parse the markdown output file written by runProDual into per-leg content
 * sections. Format (see formatDualProResponse):
 *
 *   # Dual-Pro Response
 *   <preamble>
 *   ---
 *   ## GPT-5.4 Pro
 *   _5921 tokens · 107s · $0.018_
 *   <content>
 *   ---
 *   ## Kimi K2.6
 *   ...
 *
 * Maps the first three `## ` sections to legs a/b/c by order. Strips the
 * cost-summary line and "## Judge breakdown" tail. Skips legs that show
 * the failure marker `⚠️ Failed:`. Returns whatever subset is recoverable.
 */
function parseOutputFileSections(raw: string): { a?: string; b?: string; c?: string } {
  // Drop everything from "## Judge breakdown" onward — it's the judge output,
  // not a model leg.
  const beforeJudge = raw.split(/\n## Judge breakdown/)[0] ?? raw
  const parts = beforeJudge.split(/\n## /).slice(1) // drop preamble; sections start with "## "
  if (parts.length < 2) return {}
  const result: { a?: string; b?: string; c?: string } = {}
  const slot: ("a" | "b" | "c")[] = ["a", "b", "c"]
  for (let i = 0; i < Math.min(parts.length, 3); i++) {
    const lines = parts[i]!.split("\n")
    // Skip leading: model-name header (line 0), italic stat line (_..._),
    // empty lines, and `---` separators.
    let start = 1
    while (start < lines.length) {
      const t = (lines[start] ?? "").trim()
      if (t === "" || /^_.*_$/.test(t) || /^---/.test(t)) start++
      else break
    }
    const content = lines.slice(start).join("\n").trim()
    if (!content) continue
    if (/^⚠️\s+Failed:/.test(content) || /^Failed:/.test(content)) continue
    result[slot[i]!] = content
  }
  return result
}

/**
 * `bun llm pro --judge-history` — retroactively score historical
 * ab-pro.jsonl entries that have responses available (either inline
 * `content` field added 2026-04-27, or alive `outputFile` path).
 *
 * Read ab-pro.jsonl → filter unjudged entries with recoverable content →
 * fire judge on each (gpt-5-mini default; gpt-5-nano if --quick) → in
 * --apply mode, rewrite the file in place with augmented entries (with
 * .bak backup); otherwise dry-run reports counts only.
 */
export async function runJudgeHistory(opts: {
  limit?: number
  quick?: boolean
  apply?: boolean
  skipConfirm?: boolean
}): Promise<void> {
  const dualPro = await import("./dual-pro")
  const cfg = await dualPro.loadConfig()
  const fs = await import("fs")
  const os = await import("os")
  const entries = await dualPro.readAbProLog()
  const judgeModelId = opts.quick ? "gpt-5-nano" : cfg.judge
  const judgeModel = getModel(judgeModelId)
  if (!judgeModel) {
    console.error(`Judge model not in registry: ${judgeModelId}`)
    return
  }
  if (!isProviderAvailable(judgeModel.provider)) {
    console.error(`Judge unavailable: set ${getProviderEnvVar(judgeModel.provider)}`)
    return
  }

  // Build candidate list — unjudged + at least 2 legs with content + model
  // names. v1 entries only have `gpt`/`kimi`; v2 has `a`/`b`/`c`. Accept both.
  type Cand = {
    idx: number
    entry: import("./dual-pro").AbProEntry
    aModel: string
    bModel: string
    cModel?: string
    aContent: string
    bContent: string
    cContent?: string
  }
  const candidates: Cand[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    if (e.judge) continue
    // Resolve model names, preferring v2 a/b/c then falling back to v1 gpt/kimi.
    const aModel = e.a?.model ?? e.gpt?.model
    const bModel = e.b?.model ?? e.kimi?.model
    const cModel = e.c?.model
    if (!aModel || !bModel) continue
    // Resolve content. v2 inline `content` is preferred; fall back to parsing
    // the markdown outputFile (still works for entries that wrote one and
    // whose /tmp/llm-*.txt hasn't been auto-cleaned).
    let aContent = e.a?.content
    let bContent = e.b?.content
    let cContent = e.c?.content
    const outputFile = (e as { outputFile?: string }).outputFile
    if ((!aContent || !bContent) && outputFile && fs.existsSync(outputFile)) {
      try {
        const raw = fs.readFileSync(outputFile, "utf-8")
        const parsed = parseOutputFileSections(raw)
        aContent = aContent ?? parsed.a
        bContent = bContent ?? parsed.b
        cContent = cContent ?? parsed.c
      } catch {
        // unreadable — skip
      }
    }
    if (!aContent || !bContent) continue
    candidates.push({ idx: i, entry: e, aModel, bModel, cModel, aContent, bContent, cContent })
  }

  if (candidates.length === 0) {
    console.error("No entries eligible for retroactive judging.")
    console.error(`(Total: ${entries.length}, already-judged: ${entries.filter((e) => e.judge).length},`)
    console.error(` missing content: ${entries.length - entries.filter((e) => e.judge).length - candidates.length})`)
    if (isJsonMode()) emitJson({ status: "empty", judged: 0, eligible: 0 })
    return
  }

  const limit = Math.min(opts.limit ?? candidates.length, candidates.length)
  const todo = candidates.slice(0, limit)

  // Cost estimate — judge sees ~3-4KB combined per call, output ~400 tokens.
  const perCallCost = estimateCost(judgeModel, 3000, 400)
  const totalEst = perCallCost * todo.length
  console.error(
    `\nRetroactive judging: ${todo.length} entries (of ${candidates.length} eligible / ${entries.length} total)`,
  )
  console.error(`  Judge: ${judgeModel.displayName}${opts.quick ? " (quick)" : ""}`)
  console.error(`  Estimated cost: ${formatCost(totalEst)}\n`)

  if (totalEst > 5 && !opts.skipConfirm) {
    await confirmOrExit(`⚠️  Estimated cost ${formatCost(totalEst)}. Proceed? [Y/n] `, !!opts.skipConfirm)
  }

  const BATCH = 5
  type Result = {
    idx: number
    judge?: import("./dual-pro").JudgeResult
    cost: number
    error?: string
  }
  const results: Result[] = []
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH)
    const settled = await Promise.allSettled(
      batch.map(async (c): Promise<Result> => {
        const responses: { id: "a" | "b" | "c"; model: string; content: string }[] = []
        responses.push({ id: "a", model: c.aModel, content: c.aContent })
        responses.push({ id: "b", model: c.bModel, content: c.bContent })
        if (c.cContent && c.cModel) {
          responses.push({ id: "c", model: c.cModel, content: c.cContent })
        }
        const prompt = dualPro.buildJudgePrompt({
          question: c.entry.question ?? "",
          responses,
          rubric: cfg.rubric,
        })
        const r = await ask(prompt, "quick", { modelOverride: judgeModel.modelId, stream: false })
        const parsed = dualPro.parseJudgeResponse(r.content)
        const cost = r.usage ? estimateCost(judgeModel, r.usage.promptTokens, r.usage.completionTokens) : 0
        return { idx: c.idx, judge: parsed, cost }
      }),
    )
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j]!
      if (s.status === "fulfilled") results.push(s.value)
      else results.push({ idx: batch[j]!.idx, cost: 0, error: String(s.reason) })
    }
    process.stderr.write(`  ${Math.min(i + BATCH, todo.length)}/${todo.length} judged\n`)
  }

  const judgedCount = results.filter((r) => r.judge).length
  const totalCost = results.reduce((s, r) => s + r.cost, 0)
  console.error(`\n${judgedCount}/${todo.length} judged successfully (cost: ${formatCost(totalCost)})`)

  if (opts.apply && judgedCount > 0) {
    // Rewrite ab-pro.jsonl in place with augmented entries. Backup first.
    const updated = entries.map((e) => ({ ...e })) as Array<import("./dual-pro").AbProEntry>
    for (const r of results) {
      if (!r.judge) continue
      const e = updated[r.idx]
      if (!e) continue
      e.judge = { model: judgeModel.modelId, result: r.judge }
      if (e.a) e.a = { ...e.a, score: r.judge.a }
      if (e.b) e.b = { ...e.b, score: r.judge.b }
      if (e.c && r.judge.c) e.c = { ...e.c, score: r.judge.c }
    }
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd()
    const encoded = projectRoot.replace(/\//g, "-")
    const home = process.env.HOME || os.homedir()
    const file = `${home}/.claude/projects/${encoded}/memory/ab-pro.jsonl`
    fs.copyFileSync(file, `${file}.bak`)
    fs.writeFileSync(file, updated.map((e) => JSON.stringify(e)).join("\n") + "\n")
    console.error(`\n✓ Rewrote ${file}`)
    console.error(`  Backup: ${file}.bak`)
    console.error(`  Augmented ${judgedCount} entries with judge scores.`)
  } else if (judgedCount > 0) {
    console.error(`\nDry run — re-run with --apply to write augmented entries to ab-pro.jsonl`)
  }

  if (isJsonMode()) {
    emitJson({
      status: "completed",
      eligible: candidates.length,
      judged: judgedCount,
      totalCostUsd: totalCost,
      applied: !!opts.apply && judgedCount > 0,
    })
  }
}

// ============================================================================
// `bun llm quota` — provider quota / balance / rate-limit snapshot
// ============================================================================

/**
 * Print a unified quota snapshot for every configured provider.
 *
 * Hits each provider's quota endpoint where one exists (OpenRouter, OpenAI
 * org-usage), falls back to cached `x-ratelimit-*` headers from a recent call
 * for providers without a balance API (Anthropic), and prints a one-line
 * "no quota API" row for the rest (Google, xAI, Perplexity).
 *
 * `--json` flag emits a structured envelope; default mode prints a fixed-
 * width table to stderr (so the JSON envelope is always the only thing on
 * stdout — matches the rest of the CLI contract).
 */
export async function runQuota(): Promise<void> {
  const { getAllQuotas, renderQuotaTable, buildQuotaEnvelope } = await import("./quota")
  const snapshots = await getAllQuotas()
  const envelope = buildQuotaEnvelope(snapshots)
  if (isJsonMode()) {
    emitJson(envelope)
    return
  }
  // Legacy mode: human table on stderr, envelope on stdout (consistent with
  // the rest of the CLI — JSON is always available; stderr is human-readable).
  process.stderr.write(renderQuotaTable(snapshots))
  emitJson(envelope)
}

/**
 * `bun llm pro --discover-models [--apply]` — Stage 2 of the auto-discovery
 * pipeline (km-bearly.llm-registry-auto-update).
 *
 * Reads `~/.cache/bearly-llm/new-models.json` (written by `performPricingUpdate`),
 * runs the cheap classifier (gpt-5-nano) over each candidate, and prints a
 * markdown decision table. With `--apply`, writes a unified diff to
 * `/tmp/llm-new-models.patch` containing the `yes`-decisions formatted as
 * SKUs_DATA + ENDPOINTS_DATA additions to types.ts. The user reviews and runs
 * `git apply /tmp/llm-new-models.patch` themselves — never auto-applied.
 *
 * Cost: ~$0.0005 × N candidates. For ~30 candidates that's ~$0.02. Run weekly
 * via `/sop infra` or cron.
 */
export async function runDiscoverModels(opts: { apply?: boolean } = {}): Promise<void> {
  const fs = await import("fs")
  const {
    loadNewModelsArtifact,
    classifyCandidates,
    formatDecisionTable,
    generateRegistryPatch,
    selectClassifierModel,
  } = await import("./discover")

  const artifact = loadNewModelsArtifact()
  if (!artifact || artifact.candidates.length === 0) {
    console.error(
      "No candidates in ~/.cache/bearly-llm/new-models.json. Run `bun llm update-pricing` first to populate.",
    )
    if (isJsonMode()) emitJson({ status: "empty", candidates: 0 })
    return
  }

  console.error(`📋 Auto-discovery — ${artifact.candidates.length} candidates from ${artifact.discoveredAt}`)

  const classifierModel = await selectClassifierModel()
  if (!classifierModel) {
    console.error("⚠️  No classifier model available — set OPENAI_API_KEY for gpt-5-nano (or any quick-tier provider).")
    if (isJsonMode()) emitJson({ status: "no-classifier", candidates: artifact.candidates.length })
    return
  }
  console.error(`  classifier: ${classifierModel.displayName}`)

  const decisions = await classifyCandidates(artifact.candidates, classifierModel)

  // Print markdown table on stdout — pipe-friendly, can be redirected straight
  // into a doc / PR description.
  console.log("# Auto-discovered model candidates\n")
  console.log(`Discovered: ${artifact.discoveredAt}`)
  console.log(`Classifier: ${classifierModel.displayName}\n`)
  console.log(formatDecisionTable(decisions))

  // Pending review section — `needs-review` items don't enter the diff, but
  // surface separately so the human can act on them.
  const pending = decisions.filter((d) => d.result.decision === "needs-review")
  if (pending.length > 0) {
    console.log("## Pending review\n")
    for (const { candidate, result } of pending) {
      console.log(`- \`${candidate.id}\` (${candidate.provider}) — ${result.reason}`)
    }
    console.log("")
  }

  const approved = decisions.filter((d) => d.result.decision === "yes").map((d) => d.candidate)
  const rejected = decisions.filter((d) => d.result.decision === "no").length

  console.error(`\n  approved: ${approved.length}  needs-review: ${pending.length}  rejected: ${rejected}`)

  if (opts.apply) {
    if (approved.length === 0) {
      console.error("  no `yes` decisions — nothing to write.")
    } else {
      // Read types.ts via package-relative path. We deliberately compute the
      // path off this module's location so it works whether bearly is invoked
      // standalone or as a vendor submodule.
      const typesTsPath = new URL("./types.ts", import.meta.url).pathname
      const typesTsContent = fs.readFileSync(typesTsPath, "utf-8")
      const patch = generateRegistryPatch(approved, typesTsContent)
      const outPath = "/tmp/llm-new-models.patch"
      fs.writeFileSync(outPath, patch)
      console.error(`\n✓ Wrote ${outPath} (${approved.length} approved entries)`)
      console.error(`  Review with: cat ${outPath}`)
      console.error(`  Apply with:  git apply ${outPath}`)
    }
  }

  if (isJsonMode()) {
    emitJson({
      status: "completed",
      candidates: artifact.candidates.length,
      approved: approved.length,
      pending: pending.length,
      rejected,
      patchPath: opts.apply && approved.length > 0 ? "/tmp/llm-new-models.patch" : undefined,
    })
  }
}

// --------------------------------------------------------------------
// Sub-command: --diagnostics
// (km-bearly.llm-refactor — Phase 1D)
// --------------------------------------------------------------------

/** Per-model speed report row. Sourced from successful ab-pro.jsonl entries. */
export interface DiagnosticsSpeedRow {
  model: string
  calls: number
  avgMs: number
  p50Ms: number
  p95Ms: number
}

/** Per-model failure-rate report row. Includes a warn flag when fail rate is suspicious. */
export interface DiagnosticsFailureRow {
  model: string
  calls: number
  successCalls: number
  failureRate: number
  warn: boolean
}

/** Per-model cost-distribution report row. Successful calls only. */
export interface DiagnosticsCostRow {
  model: string
  calls: number
  avgUsd: number
  p50Usd: number
  p95Usd: number
  p99Usd: number
}

/** Aggregated diagnostics envelope — what `--diagnostics --json` emits. */
export interface DiagnosticsReport {
  status: "ok" | "empty"
  speed: DiagnosticsSpeedRow[]
  failureRate: DiagnosticsFailureRow[]
  costDist: DiagnosticsCostRow[]
}

const SPEED_MIN_CALLS = 5
const COST_MIN_CALLS = 10
const FAILURE_WARN_RATE = 0.3
const FAILURE_WARN_MIN_CALLS = 20

/** Quantile of an unsorted numeric array, linear interpolation between samples. */
function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]!
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

/**
 * Build the three diagnostic reports from raw ab-pro.jsonl entries. Pure —
 * no I/O, no side effects. Exported for testability and reuse.
 *
 * - Speed: avg/p50/p95 over successful calls; rows with calls ≥ 5.
 * - Failure rate: success/total per model; warn when >30% AND calls ≥ 20.
 * - Cost distribution: avg/p50/p95/p99 over successful calls; rows with calls ≥ 10.
 */
export function buildDiagnostics(entries: readonly import("./dual-pro").AbProEntry[]): DiagnosticsReport {
  type Stat = { calls: number; success: number; durations: number[]; costs: number[] }
  const stats = new Map<string, Stat>()
  const bumpLeg = (leg?: import("./dual-pro").AbProLegEntry) => {
    if (!leg?.model) return
    const s = stats.get(leg.model) ?? { calls: 0, success: 0, durations: [], costs: [] }
    s.calls += 1
    if (leg.ok) {
      s.success += 1
      if (leg.durationMs != null) s.durations.push(leg.durationMs)
      if (leg.cost != null) s.costs.push(leg.cost)
    }
    stats.set(leg.model, s)
  }
  for (const e of entries) {
    if (e.gpt) bumpLeg({ model: e.gpt.model, ok: e.gpt.ok, cost: e.gpt.cost, durationMs: e.gpt.durationMs })
    if (e.kimi) bumpLeg({ model: e.kimi.model, ok: e.kimi.ok, cost: e.kimi.cost, durationMs: e.kimi.durationMs })
    bumpLeg(e.a)
    bumpLeg(e.b)
    bumpLeg(e.c)
  }

  const speed: DiagnosticsSpeedRow[] = []
  const failureRate: DiagnosticsFailureRow[] = []
  const costDist: DiagnosticsCostRow[] = []

  for (const [model, s] of stats) {
    if (s.success >= SPEED_MIN_CALLS && s.durations.length > 0) {
      const sum = s.durations.reduce((a, b) => a + b, 0)
      speed.push({
        model,
        calls: s.success,
        avgMs: sum / s.durations.length,
        p50Ms: quantile(s.durations, 0.5),
        p95Ms: quantile(s.durations, 0.95),
      })
    }
    const fr = s.calls > 0 ? (s.calls - s.success) / s.calls : 0
    failureRate.push({
      model,
      calls: s.calls,
      successCalls: s.success,
      failureRate: fr,
      warn: fr > FAILURE_WARN_RATE && s.calls >= FAILURE_WARN_MIN_CALLS,
    })
    if (s.success >= COST_MIN_CALLS && s.costs.length > 0) {
      const sum = s.costs.reduce((a, b) => a + b, 0)
      costDist.push({
        model,
        calls: s.success,
        avgUsd: sum / s.costs.length,
        p50Usd: quantile(s.costs, 0.5),
        p95Usd: quantile(s.costs, 0.95),
        p99Usd: quantile(s.costs, 0.99),
      })
    }
  }

  speed.sort((a, b) => a.avgMs - b.avgMs)
  failureRate.sort((a, b) => b.failureRate - a.failureRate || b.calls - a.calls)
  costDist.sort((a, b) => a.avgUsd - b.avgUsd)

  return { status: "ok", speed, failureRate, costDist }
}

/**
 * `bun llm pro --diagnostics` — surface speed, failure rate, and cost
 * distribution per model from ab-pro.jsonl. Display-only signals that
 * the quality-first leaderboard intentionally hides (km-bearly.llm-refactor
 * Phase 1D).
 *
 * Plain-text mode prints three sections to stderr. JSON mode emits a
 * structured envelope on stdout (per output-mode contract).
 */
export async function runDiagnostics(): Promise<void> {
  const dualPro = await import("./dual-pro")
  const entries = await dualPro.readAbProLog()
  if (entries.length === 0) {
    console.error("No ab-pro.jsonl entries yet. Run `bun llm pro <question>` to start collecting data.")
    if (isJsonMode()) emitJson({ status: "empty", speed: [], failureRate: [], costDist: [] })
    return
  }

  const report = buildDiagnostics(entries)

  if (isJsonMode()) {
    emitJson({
      status: report.status,
      speed: report.speed,
      failureRate: report.failureRate,
      costDist: report.costDist,
    })
    return
  }

  const fmtMs = (n: number) => `${(n / 1000).toFixed(1)}s`
  const fmtPct = (n: number) => `${(n * 100).toFixed(0)}%`
  const fmtCost = (n: number) => `$${n.toFixed(4)}`

  console.error(`\nDiagnostics — ${entries.length} runs from ab-pro.jsonl\n`)

  // ---- Speed ----
  console.error(`Speed (successful calls, ≥${SPEED_MIN_CALLS} per model)`)
  if (report.speed.length === 0) {
    console.error(`  (no models meet the ≥${SPEED_MIN_CALLS}-call threshold yet)`)
  } else {
    console.error(
      `  ${"Model".padEnd(34)} ${"Calls".padStart(6)} ${"Avg".padStart(8)} ${"P50".padStart(8)} ${"P95".padStart(8)}`,
    )
    console.error(`  ${"-".repeat(68)}`)
    for (const r of report.speed) {
      console.error(
        `  ${r.model.padEnd(34)} ${String(r.calls).padStart(6)} ${fmtMs(r.avgMs).padStart(8)} ${fmtMs(r.p50Ms).padStart(8)} ${fmtMs(r.p95Ms).padStart(8)}`,
      )
    }
  }
  console.error("")

  // ---- Failure rate ----
  console.error(`Failure rate (warn: >${(FAILURE_WARN_RATE * 100).toFixed(0)}% with ≥${FAILURE_WARN_MIN_CALLS} calls)`)
  console.error(
    `  ${"Model".padEnd(34)} ${"Calls".padStart(6)} ${"Success".padStart(8)} ${"FailRate".padStart(9)} ${"".padStart(4)}`,
  )
  console.error(`  ${"-".repeat(64)}`)
  for (const r of report.failureRate) {
    const flag = r.warn ? " ⚠" : ""
    console.error(
      `  ${r.model.padEnd(34)} ${String(r.calls).padStart(6)} ${String(r.successCalls).padStart(8)} ${fmtPct(r.failureRate).padStart(9)}${flag}`,
    )
  }
  console.error("")

  // ---- Cost distribution ----
  console.error(`Cost distribution (successful calls, ≥${COST_MIN_CALLS} per model)`)
  if (report.costDist.length === 0) {
    console.error(`  (no models meet the ≥${COST_MIN_CALLS}-call threshold yet)`)
  } else {
    console.error(
      `  ${"Model".padEnd(34)} ${"Calls".padStart(6)} ${"Avg".padStart(10)} ${"P50".padStart(10)} ${"P95".padStart(10)} ${"P99".padStart(10)}`,
    )
    console.error(`  ${"-".repeat(82)}`)
    for (const r of report.costDist) {
      console.error(
        `  ${r.model.padEnd(34)} ${String(r.calls).padStart(6)} ${fmtCost(r.avgUsd).padStart(10)} ${fmtCost(r.p50Usd).padStart(10)} ${fmtCost(r.p95Usd).padStart(10)} ${fmtCost(r.p99Usd).padStart(10)}`,
      )
    }
  }
  console.error("")
}
