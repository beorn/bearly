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
 * Output: response written to /tmp/llm-*.txt for all synchronous modes and
 * recover/await. Fire-and-forget deep research defers file creation until
 * `bun llm recover <id>` or `bun llm await <id>` is called — the initial
 * invocation only persists the response ID. JSON metadata on stdout.
 * Streaming tokens shown on stderr only in TTY.
 *
 * Recover/await ceiling: 600 polls × 5s = 50m. Override with LLM_RECOVER_MAX_ATTEMPTS.
 *
 * Heavy logic lives in lib/llm/:
 *   dispatch.ts — provider dispatch, model selection, recovery, pricing updates
 *   format.ts   — output formatting, file writing, research archival, streaming
 */

import { getAvailableProviders } from "./lib/providers"
import { getModel, MODELS, type Model, type Provider } from "./lib/types"
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

// Side effects are deferred to initCli() so importing this module from a
// test or programmatic consumer doesn't fire pricing init, /tmp cleanup, or
// any other startup work as a surprise. The wrapper (tools/llm.ts) invokes
// main() which calls initCli() — no behavior change for the canonical path.
//
// Module-scope `args` parsing still runs on import (pure read of process.argv,
// no side effects). outputFile was previously a module-scope `let` mutated
// via setOutputSlug; it now lives as a local inside main(), resolved per
// dispatch branch via the pure resolveOutputFile helper below.
function initCli(): void {
  initializePricing()

  // Clean up stale output files (>7 days old).
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
}

// --- CLI argument parsing ---

const args = process.argv.slice(2)

// Keywords that trigger specific modes. Hoisted above resolveCommand (which
// runs at module-scope) so the lookup doesn't trip a temporal-dead-zone
// ReferenceError. Single source of truth — used by resolveCommand,
// dropCommandAndLeadingFlags, isKeyword checks, and the --deep-keyword
// foot-gun guard.
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
  // Slash-prefixed synonyms for --deep / --ask. Without these in the list,
  // resolveCommand would return undefined and `llm /deep "topic"` would
  // fall through to the default-ask path instead of entering deep research.
  // isDeepFlag / isAskFlag match against `command` once it's resolved.
  "/deep",
  "/ask",
]

// Flags whose next argv token is the flag's value — excluded from the user
// prompt text by extractText, and skipped over when resolveCommand scans
// for the command keyword. Missing entries cause that value to leak into
// the prompt (e.g. --image screenshot.png → "describe this screenshot.png").
// --models / --provider were aspirational and removed; resurrect here when
// the CLI actually implements them.
const VALUE_FLAGS = ["--model", "--context", "--context-file", "--output", "--image"]

/**
 * The canonical command keyword for this invocation — the FIRST positional
 * that matches a known keyword, skipping over leading flags and their values.
 *
 * Why: `args[0]` gets the first token, which breaks on `llm --verbose pro "q"`
 * (command would be `"--verbose"`, keyword `"pro"` would leak into the prompt).
 * Pro round-2 review 2026-04-21 flagged this as major — the wrapper's claim of
 * "canonical command regardless of argv ordering" was false until this fix.
 *
 * Returns undefined when no keyword positional exists (default-ask path).
 */
function resolveCommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith("--")) {
      // Skip the flag's value if it's space-separated (--name value form).
      // `--name=value` forms are single tokens — just skip this one.
      if (!a.includes("=") && VALUE_FLAGS.includes(a) && i + 1 < argv.length) i++
      continue
    }
    if (a.match(/^-[a-zA-Z]+$/)) continue // short flag (e.g. -y)
    if (KEYWORDS.includes(a)) return a
    // First positional that's not a keyword: default-ask path (no command).
    return undefined
  }
  return undefined
}

const command = resolveCommand(args)

function getArg(name: string): string | undefined {
  // Accept both `--name value` and `--name=value` forms. The latter matters
  // when callers shell-quote a value containing spaces, or use GNU-style
  // option parsing habits; dropping it was a silent UX trap.
  const prefix = `${name}=`
  for (const a of args) {
    if (a.startsWith(prefix)) return a.slice(prefix.length)
  }
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
 * Resolve the output file path for this invocation.
 *
 * If `--output <path>` was passed, honour it verbatim regardless of topic.
 * Otherwise synthesize a slug-bearing path via buildOutputPath. Pure —
 * callers hold the resolved string as a local, no module-scope mutation.
 * The previous `let outputFile` + mutating `setOutputSlug` worked, but the
 * module-scope `let` made it hard to reason about which dispatch path saw
 * which filename (especially when tests import cli.ts and exercise main()
 * multiple times). Response is ALWAYS written to a file — never stream to
 * stdout, it causes truncation when Claude Code captures background tasks.
 */
function resolveOutputFile(topic?: string): string {
  if (outputArg) return outputArg
  return buildOutputPath(sessionTag, topic)
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
    // OpenRouter hosts thousands of models (qwen3, deepseek, llama variants,
    // …) — we shouldn't have to hardcode every one in types.ts. IDs in the
    // `owner/model` shape are the OpenRouter convention; synthesize a
    // transient Model on the fly so the caller can reach any of them without
    // editing source. Pricing is unknown for synthetics (cost display will
    // show "$0.00"), costTier falls back to "medium" so requiresConfirmation
    // behaves reasonably.
    if (!modelOverride && modelOverrideId.includes("/")) {
      const { isProviderAvailable: checkProvider } = await import("./lib/providers")
      if (checkProvider("openrouter")) {
        modelOverride = {
          provider: "openrouter",
          modelId: modelOverrideId,
          displayName: modelOverrideId,
          isDeepResearch: false,
          costTier: "medium",
        }
      }
    }
  }
  if (!modelOverride) {
    const available = MODELS.map((m) => m.modelId).join(", ")
    error(
      `Unknown model: ${modelOverrideId}. Available: ${available}, or ollama:<model>, or <owner>/<model> for OpenRouter`,
    )
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

function extractText(fromAll: boolean, exclude?: string[]): string {
  // Drop the keyword (if any) AND any leading flags before the keyword, so
  // `llm --verbose pro "q"` yields "q", not "pro q". Previously this used
  // args.slice(1), which broke when a flag came first. Pro round-2 review
  // 2026-04-21 flagged the leaking-keyword case.
  const source = fromAll ? args : dropCommandAndLeadingFlags(args)
  return source
    .filter((a, i, arr) => {
      if (a.startsWith("--")) return false
      if (a.match(/^-[a-zA-Z]+$/)) return false
      if (exclude?.includes(a)) return false
      if (i > 0 && arr[i - 1]?.startsWith("--") && VALUE_FLAGS.includes(arr[i - 1]!)) return false
      return true
    })
    .join(" ")
}

/** Return argv with the resolved command keyword removed and the positional
 * sequence intact. If there's no keyword, we still strip nothing — the
 * filter inside extractText handles the remaining flags.
 *
 * Stripping the keyword by index rather than value avoids deleting a second
 * identical token (e.g. a question that happens to be the word "pro"). */
function dropCommandAndLeadingFlags(argv: string[]): string[] {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith("--")) {
      if (!a.includes("=") && VALUE_FLAGS.includes(a) && i + 1 < argv.length) i++
      continue
    }
    if (a.match(/^-[a-zA-Z]+$/)) continue
    if (KEYWORDS.includes(a)) {
      // Keep everything before the keyword (flags) AND everything after it.
      return [...argv.slice(0, i), ...argv.slice(i + 1)]
    }
    return argv
  }
  return argv
}

// Provider rows for the --help banner. Typed metadata replaces the previous
// hand-rolled template with six `as any` casts; adding a provider here is a
// one-line change in a single place.
const PROVIDER_ROWS: ReadonlyArray<{ id: Provider; name: string; env: string; readyHint?: string }> = [
  { id: "openai", name: "OpenAI", env: "OPENAI_API_KEY" },
  { id: "anthropic", name: "Anthropic", env: "ANTHROPIC_API_KEY" },
  { id: "google", name: "Google", env: "GOOGLE_GENERATIVE_AI_API_KEY" },
  { id: "xai", name: "xAI (Grok)", env: "XAI_API_KEY" },
  { id: "perplexity", name: "Perplexity", env: "PERPLEXITY_API_KEY" },
  { id: "openrouter", name: "OpenRouter", env: "OPENROUTER_API_KEY", readyHint: "ready (Kimi K2.6, etc.)" },
]

function providerStatusLines(available: readonly Provider[]): string {
  const set = new Set(available)
  return (
    PROVIDER_ROWS.map(({ id, name, env, readyHint }) => {
      const ok = set.has(id)
      const status = ok ? (readyHint ?? "ready") : `set ${env}`
      return `  ${ok ? "✓" : "○"} ${name.padEnd(12)}${status}`
    }).join("\n") + "\n"
  )
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
  --verbose              Stream tokens to stderr even in non-TTY contexts
                         (DANGEROUS: large outputs can truncate in Claude Code
                         background tasks — prefer default TTY-only behavior)
  --model <id>           Use specific model (e.g., gpt-5.4-pro, gemini-3-pro-preview)
  --no-recover           Skip auto-recovery of incomplete responses
  --with-history         Include relevant context from session history
  --context <text>       Provide explicit context (prepended to topic)
  --context-file <path>  Read context from a file
  --output <file>        Write response to specific file (default: auto /tmp/llm-<session>-<slug>-<rand>.txt)

ENVIRONMENT VARIABLES
  LLM_DUAL_PRO_B=<modelId>         Swap leg B of dual-pro (default: moonshotai/kimi-k2.6).
                                   Use for head-to-head A/B sprints — e.g.
                                   LLM_DUAL_PRO_B=gpt-5.5-pro pairs two frontier
                                   Pros and logs both to ab-pro.jsonl.
  LLM_RECOVER_MAX_ATTEMPTS=<n>     Polls for deep-research recovery (default: 600 = 50 min).

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
${providerStatusLines(available)}  ${ollamaStatus} Ollama      ${ollamaStatusText}

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

// KEYWORDS is defined above (hoisted for resolveCommand's module-scope call).

// --- Shared options for dispatch functions ---

function askOpts(
  question: string,
  modelMode: string,
  level: "standard" | "quick",
  header: (name: string) => string,
  outputFile: string,
) {
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

/** Returns the canonical command string (e.g. "pro", "--deep", "list-models")
 * so the wrapper can pass it to maybeAutoUpdatePricing accurately — raw
 * process.argv[2] fails on invocations like `bun llm --verbose pro "q"`
 * where argv[2] is the flag, not the keyword. */
export async function main(): Promise<string | undefined> {
  initCli()
  // Show usage only for empty argv or explicit help flags. A resolved
  // `command === undefined` now means "default-ask path" (no keyword
  // positional), not "show help" — the legacy `command = args[0]` made
  // the latter equivalent, but resolveCommand tightens the semantics.
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || hasFlag("--help")) {
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
    const outputFile = resolveOutputFile(question)

    // Check history first. try/finally ensures closeDb() runs even if the
    // FTS query throws (e.g., schema version drift, locked DB, malformed
    // index) — previously the except path leaked the SQLite handle.
    try {
      const db = getDb()
      try {
        const similar = findSimilarQueries(db, question, { limit: 2 })
        if (similar.length > 0) {
          console.error("📚 Similar past queries:\n")
          for (const s of similar) {
            const relTime = formatRelativeTime(new Date(s.timestamp).getTime())
            const preview = (s.user_content || "").slice(0, 100).replace(/\n/g, " ")
            console.error(`  ${relTime}: ${preview}...`)
          }
          console.error()
        }
      } finally {
        closeDb()
      }
    } catch {
      /* History not indexed */
    }

    await askAndFinish(askOpts(question, "default", "standard", (name) => `[${name}]`, outputFile))
    return command
  }

  if (isDeepFlag) {
    const topic = isKeyword ? getQuestion() : extractText(true, ["/deep"])
    if (!topic) error("Usage: llm --deep <topic>")
    // `--deep <keyword>` silently absorbs the keyword into the topic text
    // because --deep sets command to "--deep" and the keyword just becomes a
    // word in the topic. Documented in the skill, but easy to trip over —
    // error out explicitly so the user knows what happened.
    const firstWord = topic.split(/\s+/)[0]?.toLowerCase()
    if (firstWord && KEYWORDS.includes(firstWord)) {
      error(
        `"${firstWord}" is a keyword and cannot be combined with --deep. Use --model <id> instead, e.g. ` +
          `llm --deep --model gpt-5.4-pro "${topic.split(/\s+/).slice(1).join(" ")}"`,
      )
    }
    const outputFile = resolveOutputFile(topic)
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
    return "--deep"
  }

  if (isAskFlag) {
    const question = isKeyword ? getQuestion() : extractText(true, ["/ask"])
    if (!question) error("Usage: llm --ask <question>")
    const outputFile = resolveOutputFile(question)
    await askAndFinish(askOpts(question, "default", "standard", (name) => `[${name}]`, outputFile))
    return "--ask"
  }

  switch (command) {
    case "quick":
    case "cheap":
    case "mini":
    case "nano": {
      const q = getQuestion()
      if (!q) error("Usage: llm quick <question>")
      const outputFile = resolveOutputFile(q)
      await askAndFinish(askOpts(q, "quick", "quick", (name) => `[${name} - quick mode]`, outputFile))
      break
    }
    case "opinion": {
      const q = getQuestion()
      if (!q) error("Usage: llm opinion <question>")
      const outputFile = resolveOutputFile(q)
      await askAndFinish(askOpts(q, "opinion", "standard", (name) => `[Second opinion from ${name}]`, outputFile))
      break
    }
    case "pro": {
      const q = getQuestion()
      if (!q) error("Usage: llm pro <question>")
      const outputFile = resolveOutputFile(q)
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
        skipConfirm,
      })
      break
    }
    case "debate": {
      const q = getQuestion()
      if (!q) error("Usage: llm debate <question>")
      const outputFile = resolveOutputFile(q)
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
  return command
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
