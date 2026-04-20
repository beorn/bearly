#!/usr/bin/env bun
/**
 * llm.ts - Multi-LLM research CLI (entry point)
 *
 *   llm "question"              Quick answer (~$0.02)
 *   llm --deep "topic"          Deep research with web search (~$2-5)
 *   llm opinion "question"      Second opinion from GPT/Gemini (~$0.02)
 *   llm debate "question"       Multi-model consensus (~$1-3)
 *   llm recover <id>            Resume polling (TTY spinner; non-TTY 60s lines)
 *   llm await <id>              Silent block until done — for non-interactive callers
 *
 * Output: response always written to /tmp/llm-*.txt (recover/await included),
 * JSON metadata on stdout. Streaming tokens shown on stderr only in TTY.
 *
 * Recover/await ceiling: 600 polls × 5s = 50m. Override with LLM_RECOVER_MAX_ATTEMPTS.
 *
 * Heavy logic lives in lib/llm/:
 *   dispatch.ts — provider dispatch, model selection, recovery, pricing updates
 *   format.ts   — output formatting, file writing, research archival, streaming
 */

import { getAvailableProviders } from "./lib/providers"
import { getModel, MODELS, type Model } from "./lib/types"
import { initializePricing, getStaleWarning } from "./lib/pricing"
import { getDb, closeDb, findSimilarQueries } from "../../recall/src/history/db"
import {
  performPricingUpdate,
  maybeAutoUpdatePricing,
  askAndFinish,
  buildContext,
  runDeep,
  runDebate,
  runProDual,
  runRecover,
  runAwait,
} from "./lib/dispatch"
import { buildOutputPath, formatRelativeTime, createStreamToken } from "./lib/format"

import { readdirSync, statSync, unlinkSync } from "fs"

// Initialize pricing on startup
initializePricing()

// Clean up stale output files (>7 days old)
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

// --- CLI argument parsing ---

const args = process.argv.slice(2)
const command = args[0]

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx === -1) return undefined
  return args[idx + 1]
}

function hasFlag(name: string): boolean {
  return args.includes(name)
}

function error(message: string): never {
  console.error(JSON.stringify({ error: message }))
  process.exit(1)
}

const outputArg = getArg("--output")
const sessionTag = process.env.CLAUDE_SESSION_ID?.slice(0, 8) ?? "manual"
const skipConfirm = hasFlag("--yes") || hasFlag("-y")
const streamToken = createStreamToken(hasFlag("--verbose"))

/**
 * Response is ALWAYS written to a file. Never stream to stdout — it causes truncation
 * when Claude Code captures background task output.
 */
let outputFile = outputArg ?? buildOutputPath(sessionTag)

function setOutputSlug(topic: string) {
  if (outputArg) return
  outputFile = buildOutputPath(sessionTag, topic)
}

/** Resolve --model flag */
const modelOverrideId = getArg("--model")
let modelOverride: Model | undefined
if (modelOverrideId) {
  if (modelOverrideId.startsWith("ollama:")) {
    const { parseOllamaModel } = await import("./lib/ollama")
    modelOverride = parseOllamaModel(modelOverrideId.slice("ollama:".length))
  } else {
    modelOverride = getModel(modelOverrideId)
  }
  if (!modelOverride) {
    const available = MODELS.map((m) => m.modelId).join(", ")
    error(`Unknown model: ${modelOverrideId}. Available: ${available}, or ollama:<model>`)
  }
}

/** Resolve --image flag */
const imagePath = getArg("--image")
if (imagePath) {
  const { existsSync: imageExists } = await import("fs")
  if (!imageExists(imagePath)) {
    error(`Image not found: ${imagePath}`)
  }
}

/** Build context from CLI flags */
function buildContextFromFlags(topic: string): Promise<string | undefined> {
  return buildContext(topic, {
    contextArg: getArg("--context"),
    contextFile: getArg("--context-file"),
    withHistory: hasFlag("--with-history"),
  })
}

const VALUE_FLAGS = ["--model", "--models", "--provider", "--context", "--context-file", "--output"]

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

// --- Ollama status (for help display) ---

let ollamaStatus = "○"
let ollamaStatusText = "not checked"

async function checkOllamaStatus(): Promise<void> {
  try {
    const { isOllamaAvailable } = await import("./lib/ollama")
    const available = await isOllamaAvailable()
    ollamaStatus = available ? "✓" : "○"
    ollamaStatusText = available ? "ready (local)" : "not running (ollama serve)"
  } catch {
    ollamaStatus = "○"
    ollamaStatusText = "not running (ollama serve)"
  }
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
  pro                    Dual-pro: GPT-5.4 Pro + Kimi K2.6 in parallel (~$5-15, A/B logged)
                         (falls back to single GPT-5.4 Pro if OPENROUTER_API_KEY unset)
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

LOCAL MODELS
  --model ollama:<name>            Run locally via Ollama (free, no API key)
  list-models                      Show available local models (ollama list)

  Examples:
    --model ollama:qwen2.5-vl:7b     Vision model, local
    --model ollama:llama3.3:70b       Large local model
    --model ollama:llava:34b          Multimodal (image support)

PROVIDERS
  ${available.includes("openai" as any) ? "✓" : "○"} OpenAI      ${available.includes("openai" as any) ? "ready" : "set OPENAI_API_KEY"}
  ${available.includes("anthropic" as any) ? "✓" : "○"} Anthropic   ${available.includes("anthropic" as any) ? "ready" : "set ANTHROPIC_API_KEY"}
  ${available.includes("google" as any) ? "✓" : "○"} Google      ${available.includes("google" as any) ? "ready" : "set GOOGLE_GENERATIVE_AI_API_KEY"}
  ${available.includes("xai" as any) ? "✓" : "○"} xAI (Grok)  ${available.includes("xai" as any) ? "ready" : "set XAI_API_KEY"}
  ${available.includes("perplexity" as any) ? "✓" : "○"} Perplexity  ${available.includes("perplexity" as any) ? "ready" : "set PERPLEXITY_API_KEY"}
  ${available.includes("openrouter" as any) ? "✓" : "○"} OpenRouter  ${available.includes("openrouter" as any) ? "ready (Kimi K2.6, etc.)" : "set OPENROUTER_API_KEY"}
  ${ollamaStatus} Ollama      ${ollamaStatusText}

RECOVERY (for interrupted deep research)
  llm recover                       List incomplete/partial responses
  llm recover <response_id>         Retrieve & poll response by ID (TTY: spinner;
                                    non-TTY: 60s-gated lines). Writes /tmp/llm-*.txt.
  llm await <response_id>           Block silently until done. Prints only the file
                                    path on stderr + JSON on stdout. For scripts.
  llm partials                      Alias for 'recover' (list partials)
  llm partials --clean              Clean up old partial files (>7 days)

  Env: LLM_RECOVER_MAX_ATTEMPTS     Poll ceiling for recover/await (default 600 = 50m
                                    @ 5s/poll; was 180/15m before km-infra.llm-recover-ux).
`)
  process.exit(0)
}

// --- Keywords that trigger specific modes ---

const KEYWORDS = [
  "quick",
  "cheap",
  "mini",
  "nano",
  "opinion",
  "pro",
  "debate",
  "recover",
  "partials",
  "await",
  "update-pricing",
  "list-models",
]

// --- Shared options for dispatch functions ---

function askOpts(question: string, modelMode: string, level: "standard" | "quick", header: (name: string) => string) {
  return {
    question,
    modelMode: modelMode as any,
    level,
    header,
    modelOverride,
    imagePath,
    streamToken,
    buildContext: buildContextFromFlags,
    outputFile,
    sessionTag,
  }
}

// --- Main ---

export async function main() {
  if (!command || command === "--help" || command === "-h") {
    await checkOllamaStatus()
    usage()
  }

  if (command === "list-models") {
    const { isOllamaAvailable, listOllamaModels, formatSize } = await import("./lib/ollama")
    const available = await isOllamaAvailable()
    if (!available) {
      console.error("Ollama is not running. Start it with: ollama serve")
      console.error("Install: https://ollama.com")
      process.exit(1)
    }
    const models = await listOllamaModels()
    if (models.length === 0) {
      console.error("No models pulled. Pull one with: ollama pull qwen2.5-vl:7b")
      process.exit(0)
    }
    console.error("Available Ollama models:\n")
    for (const m of models) {
      const size = formatSize(m.size)
      console.error(`  ollama:${m.name.padEnd(30)} ${size.padStart(8)}`)
    }
    console.error(`\nUsage: llm --model ollama:<name> "your question"`)
    process.exit(0)
  }

  const staleWarning = getStaleWarning()
  if (staleWarning) console.error(staleWarning + "\n")

  const isDeepFlag = hasFlag("--deep") || command === "/deep"
  const isAskFlag = hasFlag("--ask") || command === "/ask"
  const isKeyword = KEYWORDS.includes(command!)

  // Default mode: no keyword, no flag — treat entire args as a question
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

    await askAndFinish(askOpts(question, "default", "standard", (name) => `[${name}]`))
    return
  }

  if (isDeepFlag) {
    const topic = isKeyword ? getQuestion() : extractText(true, ["/deep"])
    if (!topic) error("Usage: llm --deep <topic>")
    setOutputSlug(topic)
    await runDeep({
      topic,
      modelOverride,
      streamToken,
      buildContext: buildContextFromFlags,
      outputFile,
      sessionTag,
      skipRecover: hasFlag("--no-recover"),
      skipConfirm,
      dryRun: hasFlag("--dry-run"),
    })
    // Deep research is always fire-and-forget. Recover with: bun llm recover
    return
  }

  if (isAskFlag) {
    const question = isKeyword ? getQuestion() : extractText(true, ["/ask"])
    if (!question) error("Usage: llm --ask <question>")
    setOutputSlug(question)
    await askAndFinish(askOpts(question, "default", "standard", (name) => `[${name}]`))
    return
  }

  switch (command) {
    case "quick":
    case "cheap":
    case "mini":
    case "nano": {
      const q = getQuestion()
      if (!q) error("Usage: llm quick <question>")
      setOutputSlug(q)
      await askAndFinish(askOpts(q, "quick", "quick", (name) => `[${name} - quick mode]`))
      break
    }
    case "opinion": {
      const q = getQuestion()
      if (!q) error("Usage: llm opinion <question>")
      setOutputSlug(q)
      await askAndFinish(askOpts(q, "opinion", "standard", (name) => `[Second opinion from ${name}]`))
      break
    }
    case "pro": {
      const q = getQuestion()
      if (!q) error("Usage: llm pro <question>")
      setOutputSlug(q)
      // Dual-pro: GPT-5.4 Pro + Kimi K2.6 in parallel. A/B test + two-is-better-than-one.
      // --model override bypasses to single-model mode; missing OPENROUTER_API_KEY
      // auto-falls-back to single-model mode inside runProDual.
      await runProDual({
        question: q,
        modelOverride,
        imagePath,
        streamToken,
        buildContext: buildContextFromFlags,
        outputFile,
        sessionTag,
      })
      break
    }
    case "debate": {
      const q = getQuestion()
      if (!q) error("Usage: llm debate <question>")
      setOutputSlug(q)
      await runDebate({
        question: q,
        buildContext: buildContextFromFlags,
        outputFile,
        sessionTag,
        skipRecover: hasFlag("--no-recover"),
        skipConfirm,
        dryRun: hasFlag("--dry-run"),
      })
      break
    }
    case "recover":
    case "partials": {
      await runRecover({
        responseId: getQuestion() || undefined,
        clean: hasFlag("--clean"),
        cleanStale: hasFlag("--clean-stale"),
        includeAll: hasFlag("--all"),
      })
      break
    }
    case "await": {
      await runAwait({ responseId: getQuestion() || undefined })
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
        console.error(`\n⚠️  To persist, update plugins/llm/src/lib/types.ts`)
      }
      console.error("✓ Pricing cache updated.")
      if (result.extractionCost) console.error(`  (extraction cost: ${result.extractionCost})`)
      break
    }
    default:
      error(`Unknown command: ${command}`)
  }
}

// Auto-run when this file is the entry point (e.g. `bun cli.ts`). When imported
// by tools/llm.ts (the canonical wrapper), it calls `await main()` explicitly,
// so we must NOT run here or the command double-fires — billing every pro query
// twice. The `import.meta.main` guard is bun's equivalent of `__name__ == '__main__'`.
if (import.meta.main) {
  main()
    .then(() => maybeAutoUpdatePricing(command))
    .catch((err) => {
      error(err instanceof Error ? err.message : String(err))
    })
}
