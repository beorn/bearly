#!/usr/bin/env bun
/**
 * llm.ts - Multi-LLM research CLI
 *
 *   llm "question"              Quick answer (~$0.02)
 *   llm --deep "topic"          Deep research with web search (~$2-5)
 *   llm opinion "question"      Second opinion from GPT/Gemini (~$0.02)
 *   llm debate "question"       Multi-model consensus (~$1-3)
 *
 * Output: response always written to /tmp/llm-*.txt, JSON metadata on stdout.
 * Streaming tokens shown on stderr only when running in an interactive terminal (TTY).
 */

import { ask, research, queryModel } from "./lib/llm/research"
import { retrieveResponse, pollForCompletion } from "./lib/llm/openai-deep"
import { listPartials, findPartialByResponseId, cleanupPartials } from "./lib/llm/persistence"
import { consensus } from "./lib/llm/consensus"
import { getAvailableProviders, getProviderEnvVar, isProviderAvailable } from "./lib/llm/providers"
import {
  estimateCost,
  formatCost,
  getBestAvailableModel,
  getBestAvailableModels,
  getModel,
  MODELS,
  type Model,
  type ModelMode,
} from "./lib/llm/types"
import {
  initializePricing,
  isPricingStale,
  getStaleWarning,
  cacheCurrentPricing,
  PRICING_SOURCES,
} from "./lib/llm/pricing"
import { getDb, closeDb, findSimilarQueries, ftsSearchWithSnippet } from "./lib/history/db"

// Initialize pricing on startup
initializePricing()

// Clean up stale output files (>7 days old)
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs"
import * as os from "os"
try {
  const maxAge = 7 * 24 * 60 * 60 * 1000
  const now = Date.now()
  for (const f of readdirSync("/tmp")) {
    if (f.startsWith("llm-") && f.endsWith(".txt")) {
      const path = `/tmp/${f}`
      try {
        if (now - statSync(path).mtimeMs > maxAge) unlinkSync(path)
      } catch {}
    }
  }
} catch {}

const args = process.argv.slice(2)
const command = args[0]

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`
  return `${Math.round(diff / 86400000)}d ago`
}

function error(message: string): never {
  console.error(JSON.stringify({ error: message }))
  process.exit(1)
}

function usage(): never {
  const available = getAvailableProviders()

  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                        LLM - Multi-Model Research CLI                        ║
╚══════════════════════════════════════════════════════════════════════════════╝

USAGE
  llm "question"                    Answer using gpt-5.4 (~$0.02)
  llm --deep "topic"                Deep research with web search (~$2-5)
  llm opinion "question"            Second opinion from Gemini (~$0.02)
  llm debate "question"             Multi-model consensus (~$1-3)

EXAMPLES
  llm "what port does postgres use"                      Standard answer
  llm --deep "best practices for TUI testing 2026"       Thorough research
  llm opinion "is my caching approach reasonable"        Get a second opinion
  llm debate "monorepo vs polyrepo for our use case"     Multiple perspectives

KEYWORDS
  (none)                 Default: gpt-5.4 (~$0.02)
  pro                    Pro model: gpt-5.4-pro (~$5-15, ~10x standard)
  opinion                Second opinion from different provider (~$0.02)
  debate                 Query 3 models, synthesize consensus (~$1-3, confirms)
  quick/cheap/mini/nano  Cheap/fast model if you really want it (~$0.01)
  update-pricing         Fetch latest model pricing from provider pages

FLAGS
  --deep, /deep          Deep research with web search (~$2-5, confirms)
  --ask, /ask            Explicit default mode (syntactic sugar)
  -y, --yes              Skip confirmation prompts (for scripting)
  --dry-run              Show what would happen without calling APIs
  --model <id>           Use specific model (e.g., gpt-5.4-pro, gemini-3-pro-preview)
  --no-recover           Skip auto-recovery of incomplete responses
  --with-history         Include relevant context from session history
  --context <text>       Provide explicit context (prepended to topic)
  --context-file <path>  Read context from a file
  --output <file>        Write response to specific file (default: auto /tmp/llm-<session>-<slug>-<rand>.txt)

FEATURES
  • Auto-recovery: Checks for interrupted responses and recovers them
  • Checks session history first (avoids duplicate research)
  • Cost confirmation for expensive queries (deep, debate)
  • Streams responses in real-time
  • Persistence: Saves progress to disk during streaming
  • File output: Response ALWAYS written to file (path printed to stdout + stderr)
  • Streaming tokens shown on stderr only in interactive terminals (TTY)

PROVIDERS
  ${available.includes("openai" as any) ? "✓" : "○"} OpenAI      ${available.includes("openai" as any) ? "ready" : "set OPENAI_API_KEY"}
  ${available.includes("anthropic" as any) ? "✓" : "○"} Anthropic   ${available.includes("anthropic" as any) ? "ready" : "set ANTHROPIC_API_KEY"}
  ${available.includes("google" as any) ? "✓" : "○"} Google      ${available.includes("google" as any) ? "ready" : "set GOOGLE_GENERATIVE_AI_API_KEY"}
  ${available.includes("xai" as any) ? "✓" : "○"} xAI (Grok)  ${available.includes("xai" as any) ? "ready" : "set XAI_API_KEY"}
  ${available.includes("perplexity" as any) ? "✓" : "○"} Perplexity  ${available.includes("perplexity" as any) ? "ready" : "set PERPLEXITY_API_KEY"}

RECOVERY (for interrupted deep research)
  llm recover                       List incomplete/partial responses
  llm recover <response_id>         Retrieve response by ID from OpenAI
  llm partials                      Alias for 'recover' (list partials)
  llm partials --clean              Clean up old partial files (>7 days)
`)
  process.exit(0)
}

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx === -1) return undefined
  return args[idx + 1]
}

function hasFlag(name: string): boolean {
  return args.includes(name)
}

const outputArg = getArg("--output")
const sessionTag = process.env.CLAUDE_SESSION_ID?.slice(0, 8) ?? "manual"

/** Derive a short slug from the topic for the output filename. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("-")
    .slice(0, 40)
}

/**
 * Response is ALWAYS written to a file. Never stream to stdout — it causes truncation
 * when Claude Code captures background task output (stderr streaming tokens + stdout JSON
 * exceed 30KB limit). The --output - mode was removed for this reason.
 */
let outputFile = outputArg ?? `/tmp/llm-${sessionTag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`

/** Update the output filename to include a topic slug (call once topic is known). */
function setOutputSlug(topic: string) {
  if (outputArg) return // user specified explicit output, don't override
  const slug = slugify(topic)
  if (slug) {
    outputFile = `/tmp/llm-${sessionTag}-${slug}-${Math.random().toString(36).slice(2, 6)}.txt`
  }
}

/** Resolve --model flag to a Model, or undefined if not specified */
const modelOverrideId = getArg("--model")
const modelOverride: Model | undefined = modelOverrideId ? getModel(modelOverrideId) : undefined
if (modelOverrideId && !modelOverride) {
  const available = MODELS.map((m) => m.modelId).join(", ")
  error(`Unknown model: ${modelOverrideId}. Available: ${available}`)
}

/**
 * Write token during streaming — stderr ONLY if interactive terminal (TTY).
 *
 * When running as a background task (e.g., Claude Code's run_in_background), stderr is not
 * a TTY. Streaming thousands of tokens to a non-TTY stderr causes Claude Code to truncate
 * the combined output (>30KB), potentially losing the file path JSON on stdout.
 *
 * DO NOT remove the TTY check — it prevents background task output truncation.
 * Use --verbose to force streaming even without a TTY.
 */
function streamToken(token: string): void {
  if (process.stderr.isTTY || hasFlag("--verbose")) {
    process.stderr.write(token)
  }
}

interface OutputMeta {
  query?: string
  model?: string
  tokens?: number
  cost?: string
  durationMs?: number
}

/** Build JSON summary object for the response */
function buildResultJson(content: string, meta?: OutputMeta): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (meta?.query) result.query = meta.query
  result.chars = content.length
  if (meta?.model) result.model = meta.model
  if (meta?.tokens) result.tokens = meta.tokens
  if (meta?.cost) result.cost = meta.cost
  if (meta?.durationMs) result.durationMs = meta.durationMs
  return result
}

/**
 * Archive LLM output to research dir for recall indexing.
 * Best-effort — failures are silently ignored.
 */
function persistToResearch(content: string, meta?: OutputMeta): void {
  if (!meta?.query) return
  try {
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd()
    const encodedPath = projectRoot.replace(/\//g, "-")
    const researchDir = `${os.homedir()}/.claude/projects/${encodedPath}/memory/research`

    // Ensure directory exists
    if (!existsSync(researchDir)) {
      mkdirSync(researchDir, { recursive: true })
    }

    // Generate filename: YYYY-MM-DD-HHmmss-<slug>.md
    const now = new Date()
    const date = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
    const slug = meta.query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50)
    const filename = `${date}-${slug}.md`

    // Build YAML frontmatter
    const frontmatter = [
      "---",
      `query: ${JSON.stringify(meta.query)}`,
      meta.model ? `model: ${JSON.stringify(meta.model)}` : null,
      meta.cost ? `cost: ${JSON.stringify(meta.cost)}` : null,
      meta.tokens ? `tokens: ${meta.tokens}` : null,
      meta.durationMs ? `duration_ms: ${meta.durationMs}` : null,
      `timestamp: ${JSON.stringify(now.toISOString())}`,
      sessionTag !== "manual" ? `session_id: ${JSON.stringify(sessionTag)}` : null,
      "---",
    ]
      .filter(Boolean)
      .join("\n")

    const archiveContent = `${frontmatter}\n\n${content}`
    writeFileSync(`${researchDir}/${filename}`, archiveContent)
  } catch {
    // Best-effort — don't fail the main output
  }
}

/**
 * After response completes: write to file, print file path on stderr, JSON metadata on stdout.
 *
 * File path on stderr: human-readable, always visible in last lines of output.
 * JSON metadata on stdout: machine-parseable single line (file path, char count, cost, etc.)
 * Streaming tokens are suppressed in non-TTY mode (see streamToken), so stderr only contains
 * the file path line + any status messages — no truncation risk.
 *
 * DO NOT stream response content to stdout — only the JSON metadata line goes there.
 */
function buildMetaComment(meta?: OutputMeta): string {
  const obj: Record<string, unknown> = {}
  if (meta?.model) obj.model = meta.model
  if (sessionTag !== "manual") obj.session = sessionTag
  obj.timestamp = new Date().toISOString()
  if (meta?.query) obj.query = meta.query
  if (meta?.cost) obj.cost = meta.cost
  if (meta?.tokens) obj.tokens = meta.tokens
  if (meta?.durationMs) obj.durationMs = meta.durationMs
  return `<!-- llm-meta: ${JSON.stringify(obj)} -->`
}

function finalizeOutput(content: string, meta?: OutputMeta): void {
  const metaComment = buildMetaComment(meta)
  void Bun.write(outputFile, `${metaComment}\n\n${content}`)
  persistToResearch(content, meta)
  process.stderr.write("\n")
  process.stderr.write(`Output written to: ${outputFile}\n`)
  const result = buildResultJson(content, meta)
  result.file = outputFile
  console.log(JSON.stringify(result))
}

/** Compute cost, finalize output, and exit — shared by all single-model response modes */
function finishResponse(
  content: string | undefined,
  model: { displayName: string },
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  },
  durationMs?: number,
  query?: string,
): void {
  if (!content) return
  const cost = usage ? estimateCost(model as any, usage.promptTokens, usage.completionTokens) : undefined
  finalizeOutput(content, {
    query,
    model: model.displayName,
    tokens: usage?.totalTokens,
    cost: cost !== undefined ? formatCost(cost) : undefined,
    durationMs,
  })
}

/** Compute total cost across multiple model responses */
function totalResponseCost(
  responses: Array<{
    model: any
    usage?: { promptTokens: number; completionTokens: number }
  }>,
): number {
  let total = 0
  for (const resp of responses) {
    if (resp.usage) total += estimateCost(resp.model, resp.usage.promptTokens, resp.usage.completionTokens)
  }
  return total
}

interface PricingUpdateResult {
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
async function performPricingUpdate(options: {
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
async function discoverNewModels(): Promise<string[]> {
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
async function maybeAutoUpdatePricing(): Promise<void> {
  if (!isPricingStale()) return
  const skip = ["update-pricing", "recover", "partials"]
  if (!command || command === "--help" || command === "-h") return
  if (skip.includes(command!)) return
  if (hasFlag("--dry-run")) return

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
      console.error(`\n  ⚠️  To persist: update vendor/tools/tools/lib/llm/types.ts`)
    }

    if (hasNewModels) {
      console.error(`\n  🆕 New models (${newModels.length}):`)
      for (const id of newModels.slice(0, 15)) {
        console.error(`    • ${id}`)
      }
      if (newModels.length > 15) {
        console.error(`    ... and ${newModels.length - 15} more`)
      }
      console.error(`\n  ℹ️  Add to MODELS in vendor/tools/tools/lib/llm/types.ts`)
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
async function askAndFinish(
  question: string,
  modelMode: ModelMode,
  level: "standard" | "quick",
  header: (name: string) => string,
): Promise<void> {
  const context = await buildContext(question)
  const enrichedQuestion = context ? `${context}\n\n---\n\n${question}` : question
  if (context) console.error(`📎 Context provided (${context.length} chars)\n`)
  let model: Model
  if (modelOverride) {
    model = modelOverride
  } else {
    const result = getBestAvailableModel(modelMode, isProviderAvailable)
    if (!result.model) error(`No model available for ${modelMode}. ${result.warning || ""}`)
    if (result.warning) console.error(`⚠️  ${result.warning}\n`)
    model = result.model
  }
  console.error(header(model.displayName) + "\n")
  const response = await ask(enrichedQuestion, level, {
    modelOverride: model.modelId,
    stream: true,
    onToken: streamToken,
  })
  finishResponse(response.content, model, response.usage, response.durationMs, question)
}

/** Prompt user for Y/n confirmation; exit if declined */
async function confirmOrExit(message: string): Promise<void> {
  if (hasFlag("--yes") || hasFlag("-y")) return
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

/** Build context from --context, --context-file, and --with-history flags */
async function buildContext(topic: string): Promise<string | undefined> {
  const parts: string[] = []
  const contextArg = getArg("--context")
  const contextFile = getArg("--context-file")
  if (contextArg) parts.push(contextArg)
  if (contextFile) {
    try {
      parts.push(await Bun.file(contextFile).text())
    } catch {
      error(`Failed to read context file: ${contextFile}`)
    }
  }
  if (hasFlag("--with-history")) {
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

const VALUE_FLAGS = ["--model", "--models", "--provider", "--context", "--context-file", "--output"]

/** Extract non-flag text from args, optionally starting from index 0 (all args) or 1 (after command) */
function extractText(fromAll: boolean, exclude?: string[]): string {
  const source = fromAll ? args : args.slice(1)
  return source
    .filter((a, i, arr) => {
      if (a.startsWith("--")) return false
      if (a.match(/^-[a-zA-Z]$/)) return false
      if (exclude?.includes(a)) return false
      if (i > 0 && arr[i - 1]?.startsWith("--") && VALUE_FLAGS.includes(arr[i - 1]!)) return false
      return true
    })
    .join(" ")
}

function getQuestion(): string {
  return extractText(false, ["/deep", "/ask"])
}

/**
 * Check for and auto-recover incomplete responses
 * Returns true if user wants to continue with new query
 */
async function checkAndRecoverPartials(): Promise<boolean> {
  if (hasFlag("--no-recover")) return true

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
        const { completePartial } = await import("./lib/llm/persistence")
        completePartial(partial.path, { delete: true })
        console.error(`\n--- End Recovered Response ---\n`)
      } else if (recovered.status === "failed" || recovered.status === "cancelled" || recovered.status === "expired") {
        console.error(`    ❌ Response ${recovered.status} — removing stale partial`)
        const { completePartial } = await import("./lib/llm/persistence")
        completePartial(partial.path, { delete: true })
      } else if (recovered.status === "in_progress" || recovered.status === "queued") {
        // Check if stale (>30 min for deep research is suspicious)
        const age = Date.now() - new Date(partial.metadata.startedAt).getTime()
        if (age > 30 * 60 * 1000) {
          console.error(`    ⚠️  Still ${recovered.status} after ${Math.round(age / 60000)}m — likely stale, removing`)
          const { completePartial } = await import("./lib/llm/persistence")
          completePartial(partial.path, { delete: true })
        } else {
          console.error(`    ⏳ Still ${recovered.status} on OpenAI (${Math.round(age / 60000)}m old)`)
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
  if (!hasFlag("--yes") && !hasFlag("-y")) {
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

// Keywords that trigger specific modes
const KEYWORDS = ["quick", "cheap", "mini", "nano", "opinion", "pro", "debate", "recover", "partials", "update-pricing"]

async function main() {
  if (!command || command === "--help" || command === "-h") {
    usage()
  }

  // Check for stale pricing and warn
  const staleWarning = getStaleWarning()
  if (staleWarning) console.error(staleWarning + "\n")

  // Flag-based mode detection (before keyword/default dispatch)
  const isDeepFlag = hasFlag("--deep") || command === "/deep"
  const isAskFlag = hasFlag("--ask") || command === "/ask"

  // If first arg is not a keyword, treat entire args as a question (default mode)
  const isKeyword = KEYWORDS.includes(command!)
  if (!isKeyword && !isDeepFlag && !isAskFlag) {
    const question = extractText(true, [])
    if (!question) usage()
    setOutputSlug(question)

    // Check history first
    try {
      const db = getDb()
      const similar = findSimilarQueries(db, question, { limit: 2 })
      closeDb()
      if (similar.length > 0) {
        console.error("📚 Similar past queries:\n")
        for (const s of similar) {
          const relTime = formatRelativeTime(new Date(s.timestamp).getTime())
          const preview = (s.user_content || "").slice(0, 100).replace(/\n/g, " ")
          console.error(`  ${relTime}: ${preview}...`)
        }
        console.error()
      }
    } catch {
      /* History not indexed */
    }

    await askAndFinish(question, "default", "standard", (name) => `[${name}]`)
    return
  }

  if (isDeepFlag) {
    const topic = isKeyword ? getQuestion() : extractText(true, ["/deep"])
    if (!topic) error("Usage: llm --deep <topic>")
    setOutputSlug(topic)

    const context = await buildContext(topic)
    const shouldContinue = await checkAndRecoverPartials()
    if (!shouldContinue) {
      console.error("Cancelled.")
      return
    }

    let deepModel: Model
    if (modelOverride) {
      deepModel = modelOverride
    } else {
      const result = getBestAvailableModel("deep", isProviderAvailable)
      if (!result.model) error("No deep research model available. " + (result.warning || ""))
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

    if (hasFlag("--dry-run")) {
      console.error("🔍 Dry run - would call deep research API")
      console.error(`   Model: ${deepModel.modelId}`)
      console.error(`   Provider: ${deepModel.provider}`)
      if (context) console.error(`   Context: ${context.slice(0, 100)}...`)
      return
    }

    await confirmOrExit("⚠️  This uses deep research models (~$2-5). Proceed? [Y/n] ")

    const response = await research(topic, {
      context,
      stream: true,
      onToken: streamToken,
      modelOverride: deepModel.modelId,
    })

    if (response.error) console.error(`Error: ${response.error}`)
    finishResponse(response.content, response.model, response.usage, response.durationMs, topic)
    return
  }

  if (isAskFlag) {
    const question = isKeyword ? getQuestion() : extractText(true, ["/ask"])
    if (!question) error("Usage: llm --ask <question>")
    setOutputSlug(question)
    await askAndFinish(question, "default", "standard", (name) => `[${name}]`)
    return
  }

  switch (command) {
    // New keyword commands
    case "quick":
    case "cheap":
    case "mini":
    case "nano": {
      const question = getQuestion()
      if (!question) error("Usage: llm quick <question>")
      setOutputSlug(question)
      await askAndFinish(question, "quick", "quick", (name) => `[${name} - quick mode]`)
      break
    }

    case "opinion": {
      const question = getQuestion()
      if (!question) error("Usage: llm opinion <question>")
      setOutputSlug(question)
      await askAndFinish(question, "opinion", "standard", (name) => `[Second opinion from ${name}]`)
      break
    }

    case "pro": {
      const question = getQuestion()
      if (!question) error("Usage: llm pro <question>")
      setOutputSlug(question)
      await askAndFinish(question, "pro", "standard", (name) => `[${name} - pro mode]`)
      break
    }

    // Alias for consensus
    case "debate": {
      const question = getQuestion()
      if (!question) error("Usage: llm debate <question>")
      setOutputSlug(question)

      const contextDebate = await buildContext(question)
      const enrichedQuestion = contextDebate ? `${contextDebate}\n\n---\n\n${question}` : question

      const shouldContinueDebate = await checkAndRecoverPartials()
      if (!shouldContinueDebate) {
        console.error("Cancelled.")
        process.exit(0)
      }

      const { models: debateModels, warning: debateWarning } = getBestAvailableModels("debate", isProviderAvailable, 3)
      if (debateModels.length < 2) {
        error("Need at least 2 models for debate. " + (debateWarning || ""))
      }

      console.error(`Multi-model debate: ${question}`)
      console.error(`Models: ${debateModels.map((m) => m.displayName).join(", ")}`)
      console.error(`Estimated cost: ~$1-3\n`)
      if (debateWarning) console.error(`⚠️  ${debateWarning}\n`)
      if (contextDebate) {
        console.error(`📎 Context provided (${contextDebate.length} chars)\n`)
      }

      // Dry run - show what would happen without calling API
      if (hasFlag("--dry-run")) {
        console.error("🔍 Dry run - would query these models:")
        for (const m of debateModels) {
          console.error(`   • ${m.displayName} (${m.provider})`)
        }
        if (contextDebate) {
          console.error(`   Context: ${contextDebate.slice(0, 100)}...`)
        }
        process.exit(0)
      }

      await confirmOrExit("⚠️  This queries multiple models (~$1-3). Proceed? [Y/n] ")

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
      finalizeOutput(debateContent, {
        query: question,
        model: `${result.responses.length} models`,
        cost: formatCost(totalResponseCost(result.responses)),
        durationMs: result.totalDurationMs,
      })
      break
    }

    case "recover":
    case "partials": {
      const responseId = getQuestion()

      // Clean up old partials if requested
      if (hasFlag("--clean")) {
        // --clean removes files older than 24h (default was 7 days)
        const deleted = cleanupPartials(24 * 60 * 60 * 1000)
        console.error(`✓ Cleaned up ${deleted} old partial file(s)`)
        break
      }

      // --clean-stale removes files older than 30 minutes
      if (hasFlag("--clean-stale")) {
        const deleted = cleanupPartials(30 * 60 * 1000)
        console.error(`✓ Cleaned up ${deleted} stale partial file(s)`)
        break
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
            error(`Failed to retrieve: ${initial.error}`)
          }
          console.error(`\n⚠️  Could not retrieve from OpenAI: ${initial.error}`)
        } else if (initial.status === "completed") {
          console.error("\nFull response from OpenAI:\n")
          console.log(initial.content)
          if (initial.usage) {
            console.error(`\n[${initial.usage.totalTokens} tokens]`)
          }
          // Clean up partial file
          if (localPartial) {
            const { completePartial } = await import("./lib/llm/persistence")
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
            // Clean up partial file
            if (localPartial) {
              const { completePartial } = await import("./lib/llm/persistence")
              completePartial(localPartial.path, { delete: true })
            }
          } else {
            console.error(`Response ${result.status}${result.error ? `: ${result.error}` : ""}`)
          }
        } else if (initial.status === "failed" || initial.status === "cancelled" || initial.status === "expired") {
          console.error(`\nResponse ${initial.status}`)
          // Clean up stale partial file for terminal states
          if (localPartial) {
            const { completePartial } = await import("./lib/llm/persistence")
            completePartial(localPartial.path, { delete: true })
            console.error("Cleaned up stale partial file.")
          }
        } else {
          console.error(`\nResponse status: ${initial.status}`)
        }
        break
      }

      // List all partials
      const partials = listPartials({ includeCompleted: hasFlag("--all") })

      if (partials.length === 0) {
        console.error("No incomplete responses found.")
        console.error("\nPartial responses are saved automatically during deep research calls.")
        console.error("If interrupted, they appear here for recovery.")
        break
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
      break
    }

    case "update-pricing": {
      console.error("📊 Updating model pricing...\n")
      const result = await performPricingUpdate({ verbose: true, modelMode: "default" })

      if (result.error) {
        console.error(`\n⚠️  ${result.error}`)
      } else if (result.priceChanges.length === 0) {
        console.error("\n✓ All prices are current — no changes detected.")
      } else {
        console.error(`\n📋 Price changes detected (${result.priceChanges.length}):\n`)
        for (const c of result.priceChanges) {
          console.error(`  ${c.modelId}:`)
          if (c.oldInput !== c.newInput) console.error(`    input:  $${c.oldInput}/M → $${c.newInput}/M`)
          if (c.oldOutput !== c.newOutput) console.error(`    output: $${c.oldOutput}/M → $${c.newOutput}/M`)
        }
        console.error(`\n⚠️  To persist, update vendor/tools/tools/lib/llm/types.ts`)
      }

      console.error("✓ Pricing cache updated.")
      if (result.extractionCost) {
        console.error(`  (extraction cost: ${result.extractionCost})`)
      }
      break
    }

    default:
      error(`Unknown command: ${command}`)
  }
}

main()
  .then(() => maybeAutoUpdatePricing())
  .catch((err) => {
    error(err instanceof Error ? err.message : String(err))
  })
