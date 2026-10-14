/**
 * Subscription-backed CLI routes for OpenAI and Google second opinions.
 *
 * A seat with a ChatGPT-subscribed `codex` login (or an Antigravity `agy`
 * login) can answer an OpenAI / Gemini question WITHOUT any billing API key:
 * we shell out to the provider's own one-shot CLI and read its final message.
 * The CLI is preferred when present; the paid API-key route is the explicit
 * fallback (see `providers.ts` `isProviderRoutable`), and every dispatch names
 * which route ran, so a route is never switched silently.
 *
 * Route table (provider → CLI):
 *   openai → `codex exec`   (the codex CLI login — a ChatGPT subscription or
 *                            whatever provider the seat's CODEX_HOME names)
 *   google → `agy`          (Antigravity Ultra subscription)
 *
 * Both CLIs are run with an EXPLICIT model (`codex exec -m …`, `agy --model …`)
 * so the answer is not quietly served by whatever model the CLI's own config
 * happens to name. The model that answered is reported on the response as
 * `servedBy`; a SKU the CLI cannot serve is refused by name BEFORE spawn, never
 * answered by a substitute.
 *
 * The CLIs own their own authentication (CODEX_HOME profile, agy OAuth). We
 * neither read nor require any `*_API_KEY`; a missing/expired CLI login is a
 * loud failure carrying the CLI's own stderr, never a silent fallback.
 *
 * Sandbox note: a codex second opinion runs as an AGENT with read-only sandbox
 * access to the seat's filesystem (unlike the API-key route, which sends only
 * the prompt). A question may therefore make it explore; the caller's leg
 * timeout bounds that.
 */

import { spawn } from "node:child_process"
import { accessSync, constants, mkdtempSync, readFileSync } from "node:fs"
import { safeRemoveSync } from "removely"
import { homedir, tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import type { Model, ModelResponse, Provider, ServedBy } from "./types"

export type SubscriptionCliId = "codex" | "agy"

interface SubscriptionCliSpec {
  /** Executable name resolved on PATH. */
  bin: string
  /** Name of the subscription the CLI spends, for loud error/report text. */
  subscription: string
}

const SPECS: Record<SubscriptionCliId, SubscriptionCliSpec> = {
  codex: { bin: "codex", subscription: "codex CLI login (ChatGPT subscription or the seat's CODEX_HOME provider)" },
  agy: { bin: "agy", subscription: "Antigravity Ultra subscription (agy)" },
}

/** Which provider a subscription CLI can answer for. */
const ROUTE_BY_PROVIDER: Partial<Record<Provider, SubscriptionCliId>> = {
  openai: "codex",
  google: "agy",
}

/**
 * Antigravity model used for every Gemini SKU routed through the subscription.
 * Antigravity exposes Argon only (gemini-4-argon-{low,medium,high}); its other
 * slugs (Flash, Claude, GPT-OSS) are a different product, not our SKUs. The
 * operator selected Argon-high for second opinions (bead 29140), so a Gemini
 * SKU routed over the subscription is served by Argon-high and the substitution
 * is named on stderr.
 */
const AGY_SUBSCRIPTION_MODEL = "gemini-4-argon-high"

/**
 * Declared map: the plugin OpenAI SKU a caller selected → the codex model slug
 * handed to `codex exec -m`, and the reasoning effort handed as
 * `-c model_reasoning_effort=`.
 *
 * Codex answers from ITS OWN catalog, so a SKU the plugin can select is not
 * necessarily one codex serves. Without an explicit `-m`, codex silently
 * answers with ~/.codex/config.toml's model while the envelope records the
 * requested SKU — the silent substitution this module exists to prevent. Each
 * row below names a codex model codex's catalog lists (the union of
 * `codex models` and the migration table), and the requested SKU stays the
 * SLOT's identity while `servedBy.model` reports who answered.
 *
 * The SKUs here are exactly those the plugin's mode table (types.ts
 * `BEST_MODELS`) selects for openai: default/deep/debate use gpt-5.4, pro uses
 * gpt-5.4-pro, quick uses gpt-5-nano. A SKU with no row is REFUSED by name
 * before spawn (see {@link resolveSubscriptionRoute}), never answered by a
 * substitute. `gpt-5.5` is codex's current OpenAI workhorse (codex migrates it
 * to gpt-5.6-sol); the rows map each plugin SKU to it explicitly rather than
 * letting codex guess. Effort is part of the identity too (N3): without it the
 * stock profile's "high" would turn a quick `gpt-5-nano` call into a thinking
 * call, so pro tiers run high, the default tier medium, nano low.
 */
export interface CodexSubscriptionRow {
  /** The codex model slug passed as `-m`. */
  model: string
  /** Reasoning effort passed as `-c model_reasoning_effort=<effort>`. */
  effort: "low" | "medium" | "high"
}

const CODEX_SUBSCRIPTION_MODEL: Record<string, CodexSubscriptionRow> = {
  "gpt-5.5": { model: "gpt-5.5", effort: "medium" },
  "gpt-5.5-pro": { model: "gpt-5.5", effort: "high" },
  "gpt-5.4": { model: "gpt-5.5", effort: "medium" },
  "gpt-5.4-pro": { model: "gpt-5.5", effort: "high" },
  "gpt-5.2-pro": { model: "gpt-5.5", effort: "high" },
  "gpt-5-nano": { model: "gpt-5.5", effort: "low" },
  "o3-pro": { model: "gpt-5.5", effort: "high" },
}

/** The codex row that serves a plugin OpenAI SKU, or undefined if none. */
export function codexSubscriptionRow(skuId: string): CodexSubscriptionRow | undefined {
  return CODEX_SUBSCRIPTION_MODEL[skuId]
}

/** The codex model slug that serves a plugin OpenAI SKU, or undefined if none. */
export function codexSubscriptionModel(skuId: string): string | undefined {
  return CODEX_SUBSCRIPTION_MODEL[skuId]?.model
}

/** The CLI that answers for a provider, or undefined when none applies. */
export function subscriptionCliFor(provider: Provider): SubscriptionCliId | undefined {
  return ROUTE_BY_PROVIDER[provider]
}

/**
 * Subscription routing is on by default. `LLM_SUBSCRIPTION_CLI=0` (or `false`)
 * forces every provider back onto its API-key route — the escape hatch for a
 * host where the CLI login is broken and the key route is the only one.
 */
export function subscriptionCliEnabled(): boolean {
  const value = process.env.LLM_SUBSCRIPTION_CLI
  return value !== "0" && value !== "false"
}

const onPathCache = new Map<string, boolean>()

/** True when `bin` is an executable on this process's PATH. Cached. */
export function cliOnPath(bin: string): boolean {
  const cached = onPathCache.get(bin)
  if (cached !== undefined) return cached
  const path = process.env.PATH ?? ""
  let found = false
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, bin), constants.X_OK)
      found = true
      break
    } catch (error) {
      // A missing path component or non-executable candidate does not answer this probe.
      // silent-fallback-allow: a missing or non-executable PATH candidate is the
      // expected miss of a lookup scan, not a swallowed failure.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES") throw error
    }
  }
  onPathCache.set(bin, found)
  return found
}

/** Clear the cached PATH probe. Test-only. */
export function resetSubscriptionCliProbe(): void {
  onPathCache.clear()
  codexProfileCache = undefined
}

/** True when this provider can be answered by its CLI right now. */
export function subscriptionCliAvailable(provider: Provider): boolean {
  if (!subscriptionCliEnabled()) return false
  const id = subscriptionCliFor(provider)
  if (id === undefined || !cliOnPath(SPECS[id].bin)) return false
  // The codex route exists only when the seat's profile is a ChatGPT login; a
  // profile that routes to a gateway is not the subscription (N1).
  if (id === "codex" && !codexProfile().subscription) return false
  return true
}

/**
 * Pure route decision: should `provider` be answered by its subscription CLI?
 *
 * SUBSCRIPTION-FIRST (operator, via @chief 2026-10-13): when the CLI is
 * available it wins, whether or not a billing API key exists — the whole point
 * is to spend the subscription, not the key. The key route runs only when the
 * CLI is absent, when an image attachment rules the text-only CLI out, or when
 * `LLM_SUBSCRIPTION_CLI=0` disables the route, and two model SHAPES are refused
 * outright so the decision names the key rather than promising a CLI that will
 * not answer: a deep-research SKU (its own SDK/web-search path, not a text
 * one-shot) and an OpenAI SKU with no `CODEX_SUBSCRIPTION_MODEL` row (codex
 * cannot serve it). Returns the CLI id or undefined; no I/O beyond the cached
 * PATH probe.
 */
export function resolveSubscriptionRoute(model: Model, context: { hasImage?: boolean }): SubscriptionCliId | undefined {
  if (!subscriptionCliEnabled()) return undefined
  if (context.hasImage) return undefined
  // Deep research uses its own Responses/Interactions path with web_search; the
  // subscription CLI is a plain text one-shot and cannot serve it.
  if (model.isDeepResearch) return undefined
  const id = subscriptionCliFor(model.provider)
  if (!id) return undefined
  // OpenAI SKUs are served only when codex has a declared model for them.
  if (id === "codex" && codexSubscriptionModel(model.modelId) === undefined) return undefined
  if (!subscriptionCliAvailable(model.provider)) return undefined
  return id
}

/**
 * The CODEX_HOME profile's routing, cached for the process. A profile with no
 * top-level `model_provider` uses the default OpenAI provider — the ChatGPT
 * subscription login. A profile whose `model_provider` names a gateway (e.g. a
 * LunaRoute profile) is NOT a ChatGPT login, so the codex route must report
 * itself unavailable rather than 401 at dispatch (N1).
 */
export interface CodexProfile {
  /** Absolute path to the config.toml that decides the route. */
  path: string
  /** Top-level `model_provider`, when the profile names one. */
  modelProvider?: string
  /** True when the profile is a plain ChatGPT (default-provider) login. */
  subscription: boolean
}

let codexProfileCache: CodexProfile | undefined

/** Read (and cache) the CODEX_HOME profile's routing decision. */
export function codexProfile(): CodexProfile {
  if (codexProfileCache) return codexProfileCache
  const home =
    process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0 ? process.env.CODEX_HOME : join(homedir(), ".codex")
  const path = join(home, "config.toml")
  let modelProvider: string | undefined
  try {
    const text = readFileSync(path, "utf8")
    // Only the TOP-LEVEL section sets the route. A `model_provider` key inside
    // an inactive `[profiles.x]` table is not the active provider, so match the
    // text before the first table header (`[`) only (N1 fold-in).
    const boundary = text.search(/^[ \t]*\[/mu)
    const topLevel = boundary === -1 ? text : text.slice(0, boundary)
    const match = topLevel.match(/^\s*model_provider\s*=\s*"([^"]+)"/mu)
    if (match) modelProvider = match[1]
  } catch (error) {
    // Only an absent optional config uses the default OpenAI provider.
    // silent-fallback-allow: an absent optional codex config means codex uses its
    // default provider; the absence itself is what sets the route.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof Error) error.message += ` (reading ${path})`
      throw error
    }
  }
  codexProfileCache = { path, modelProvider, subscription: modelProvider === undefined }
  return codexProfileCache
}

/**
 * Why the subscription route does NOT apply to `model` even though its CLI is
 * on PATH, or undefined when it does apply. Names the cause so the gate can
 * report it beside the missing key (N5) the same way the image note does.
 */
export function subscriptionRouteNote(model: Model): string | undefined {
  const id = subscriptionCliFor(model.provider)
  if (id === undefined || !cliOnPath(SPECS[id].bin)) return undefined
  if (id === "codex") {
    const profile = codexProfile()
    if (!profile.subscription) {
      return `codex profile ${profile.path} routes to ${profile.modelProvider}, not a ChatGPT login`
    }
    if (codexSubscriptionRow(model.modelId) === undefined) {
      return `codex has no declared model for OpenAI SKU ${model.modelId}`
    }
  }
  return undefined
}

export interface SubscriptionQueryOptions {
  question: string
  systemPrompt?: string
  onToken?: (token: string) => void
  abortSignal?: AbortSignal
}

interface CliRunResult {
  code: number | null
  stdout: string
  stderr: string
  aborted: boolean
}

/** Run a CLI to completion, feeding `prompt` on stdin. */
function runCli(bin: string, args: string[], prompt: string, abortSignal?: AbortSignal): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let aborted = false
    const onAbort = () => {
      aborted = true
      child.kill("SIGTERM")
    }
    if (abortSignal) {
      if (abortSignal.aborted) onAbort()
      else abortSignal.addEventListener("abort", onAbort, { once: true })
    }
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", (error) => reject(error))
    child.on("close", (code) => {
      abortSignal?.removeEventListener("abort", onAbort)
      resolve({ code, stdout, stderr, aborted })
    })
    child.stdin.on("error", () => {
      // The CLI may close stdin early; that surfaces through the exit code.
    })
    child.stdin.end(prompt)
  })
}

/** Compose the single prompt text handed to a CLI. */
function composePrompt(options: SubscriptionQueryOptions): string {
  const parts: string[] = []
  if (options.systemPrompt) parts.push(options.systemPrompt)
  parts.push(options.question)
  return parts.join("\n\n---\n\n")
}

interface CodexEvent {
  type?: string
  message?: string
  error?: { message?: string }
  /** Some codex versions name the model on thread.started / turn.started. */
  model?: string
  item?: { type?: string; text?: string }
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
}

interface CodexParse {
  text: string
  usage?: ModelResponse["usage"]
  failure?: string
  /** The model codex named as the one running, when its JSONL reports one. */
  model?: string
}

/** Parse `codex exec --json` JSONL: last agent_message is the answer. */
function parseCodexJsonl(jsonl: string): CodexParse {
  let text = ""
  let usage: ModelResponse["usage"]
  let failure: string | undefined
  let model: string | undefined
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event: CodexEvent
    try {
      event = JSON.parse(trimmed) as CodexEvent
    } catch {
      continue // Non-JSON chatter on stdout is not the answer; ignore.
    }
    if (event.type === "thread.started" || event.type === "turn.started") {
      if (typeof event.model === "string" && event.model) model = event.model
    } else if (event.type === "item.completed" && event.item?.type === "agent_message") {
      if (typeof event.item.text === "string") text = event.item.text
    } else if (event.type === "turn.completed" && event.usage) {
      const prompt = event.usage.input_tokens ?? 0
      const completion = event.usage.output_tokens ?? 0
      usage = { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, estimatedCost: 0 }
    } else if (event.type === "error" && typeof event.message === "string") {
      failure = event.message
    } else if (event.type === "turn.failed") {
      failure = event.error?.message ?? "codex exec turn failed"
    }
  }
  return { text, usage, failure, model }
}

async function queryCodex(model: Model, options: SubscriptionQueryOptions): Promise<ModelResponse> {
  const startedAt = Date.now()
  const row = codexSubscriptionRow(model.modelId)
  if (row === undefined) {
    return {
      model,
      content: "",
      durationMs: Date.now() - startedAt,
      error: `no codex model is declared for OpenAI SKU ${model.modelId} (subscription route refused before spawn)`,
    }
  }
  const workdir = mkdtempSync(join(tmpdir(), "llm-codex-"))
  const lastMessageFile = join(workdir, "last-message.txt")
  try {
    const args = [
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "-C",
      workdir,
      "-m",
      row.model,
      "-c",
      `model_reasoning_effort=${row.effort}`,
      "-o",
      lastMessageFile,
    ]
    const run = await runCli(SPECS.codex.bin, args, composePrompt(options), options.abortSignal)
    const parsed = parseCodexJsonl(run.stdout)
    // `-o` is the authoritative final message; the JSONL mirror is the fallback.
    let content = parsed.text
    try {
      const written = readFileSync(lastMessageFile, "utf8")
      if (written.trim()) content = written
    } catch (error) {
      // Only an absent -o file (turn failed before any message) permits the JSONL answer.
      // silent-fallback-allow: an absent -o file only means the turn failed before writing
      // any message; the JSONL mirror already carries the answer.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof Error) error.message += ` (reading ${lastMessageFile})`
        throw error
      }
    }
    if (run.aborted || run.code !== 0 || parsed.failure) {
      const detail = parsed.failure ?? run.stderr.trim().split("\n").slice(-3).join(" | ")
      return {
        model,
        content: "",
        durationMs: Date.now() - startedAt,
        error:
          `codex CLI (${SPECS.codex.subscription}) failed for ${model.displayName}` +
          `${run.aborted ? " (aborted)" : ` (exit ${run.code ?? "signal"})`}: ${detail || "no stderr"}`,
      }
    }
    if (!content.trim()) {
      return {
        model,
        content: "",
        durationMs: Date.now() - startedAt,
        error: `codex CLI (${SPECS.codex.subscription}) returned an empty answer for ${model.displayName}`,
      }
    }
    // codex's JSONL usually does not name the answering model; when it does
    // (thread.started/turn.started), prefer it over the slug we requested (N2).
    const servedBy: ServedBy = { route: "subscription-cli", cli: "codex", model: parsed.model ?? row.model }
    return { model, content, usage: parsed.usage, durationMs: Date.now() - startedAt, servedBy }
  } finally {
    safeRemoveSync(workdir, { within: tmpdir(), allowMissing: true })
  }
}

interface AgyResultEvent {
  event?: string
  result?: {
    status?: string
    response?: string
    error?: string
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
  }
}

interface AgyParse {
  text: string
  status?: string
  error?: string
  usage?: ModelResponse["usage"]
}

/** Parse `agy --input-format stream-json --output-format stream-json` NDJSON. */
function parseAgyStreamJson(ndjson: string): AgyParse {
  let text = ""
  let status: string | undefined
  let error: string | undefined
  let usage: ModelResponse["usage"]
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event: AgyResultEvent
    try {
      event = JSON.parse(trimmed) as AgyResultEvent
    } catch {
      continue // Non-JSON chatter (banners) is not the answer; ignore.
    }
    if (event.event !== "result" || !event.result) continue
    status = event.result.status
    text = event.result.response ?? ""
    error = event.result.error
    const u = event.result.usage
    if (u) {
      const prompt = u.input_tokens ?? 0
      const completion = u.output_tokens ?? 0
      usage = {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: u.total_tokens ?? prompt + completion,
        estimatedCost: 0,
      }
    }
  }
  return { text, status, error, usage }
}

async function queryAgy(model: Model, options: SubscriptionQueryOptions): Promise<ModelResponse> {
  const startedAt = Date.now()
  const workdir = mkdtempSync(join(tmpdir(), "llm-agy-"))
  try {
    // The prompt travels on STDIN via stream-json, NOT as a `-p <prompt>` argv
    // string: a single argv argument over MAX_ARG_STRLEN (131072 bytes on Linux)
    // dies with E2BIG, and a /pro context file is routinely larger. stream-json
    // also reports token usage, which `-p` does not.
    const args = ["--model", AGY_SUBSCRIPTION_MODEL, "--input-format", "stream-json", "--output-format", "stream-json"]
    const input = `${JSON.stringify({
      event: "user",
      message: { role: "user", content: [{ type: "text", text: composePrompt(options) }] },
    })}\n`
    const run = await runCli(SPECS.agy.bin, args, input, options.abortSignal)
    const parsed = parseAgyStreamJson(run.stdout)
    const failedStatus = parsed.status !== undefined && parsed.status !== "SUCCESS"
    if (run.aborted || run.code !== 0 || failedStatus) {
      const detail = parsed.error ?? run.stderr.trim().split("\n").slice(-3).join(" | ")
      const exit = run.aborted
        ? " (aborted)"
        : ` (exit ${run.code ?? "signal"}${failedStatus ? `, status ${parsed.status}` : ""})`
      return {
        model,
        content: "",
        durationMs: Date.now() - startedAt,
        error: `agy CLI (${SPECS.agy.subscription}) failed for ${model.displayName}${exit}: ${detail || "no stderr"}`,
      }
    }
    const content = parsed.text.trim()
    if (!content) {
      return {
        model,
        content: "",
        durationMs: Date.now() - startedAt,
        error: `agy CLI (${SPECS.agy.subscription}) returned an empty answer for ${model.displayName}`,
      }
    }
    const servedBy: ServedBy = { route: "subscription-cli", cli: "agy", model: AGY_SUBSCRIPTION_MODEL }
    return { model, content, usage: parsed.usage, durationMs: Date.now() - startedAt, servedBy }
  } finally {
    safeRemoveSync(workdir, { within: tmpdir(), allowMissing: true })
  }
}

/**
 * Answer `model` through its subscription CLI. The caller must have confirmed
 * {@link subscriptionCliAvailable}; this throws rather than falling back so a
 * broken route is loud, never a silent switch to another provider.
 */
export async function querySubscriptionCli(model: Model, options: SubscriptionQueryOptions): Promise<ModelResponse> {
  const id = subscriptionCliFor(model.provider)
  if (!id) {
    throw new Error(`No subscription CLI route for provider ${model.provider}`)
  }
  const response = id === "codex" ? await queryCodex(model, options) : await queryAgy(model, options)
  if (response.content && options.onToken) options.onToken(response.content)
  return response
}

/** Human-readable description of the route a dispatch took, for the loud route line. */
export function describeSubscriptionRoute(model: Model): string {
  const id = subscriptionCliFor(model.provider)
  if (!id) return "no subscription route"
  if (id === "codex") {
    const row = codexSubscriptionRow(model.modelId)
    const target = row ? `, model ${row.model} (effort ${row.effort})` : ""
    // Name the profile that decides the route, so a luna seat is visible.
    return `codex CLI one-shot (${SPECS.codex.subscription}); profile ${codexProfile().path}${target}`
  }
  return `agy CLI one-shot (${SPECS.agy.subscription}), model ${AGY_SUBSCRIPTION_MODEL}`
}
