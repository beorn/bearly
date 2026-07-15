import { generateText } from "ai"
import { getLanguageModel } from "./providers"
import { getModel, getProviderEnvVar, type Model, type Provider } from "./types"

export const DEFAULT_LEG_TIMEOUT_MS = 15 * 60 * 1_000
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 30_000

const RETIRED_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
  "grok-4": "grok-4-1-fast-reasoning",
})

const PREFLIGHT_MODEL_IDS: Readonly<Partial<Record<Provider, string>>> = Object.freeze({
  openai: "gpt-5-nano",
  anthropic: "claude-haiku-4-5-20251001",
  google: "gemini-2.0-flash-lite",
  xai: "grok-3-fast",
  perplexity: "sonar",
  openrouter: "deepseek/deepseek-chat",
})

type ProviderProbe = (provider: Provider, signal: AbortSignal) => Promise<void>

function oneLineError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/^Error:\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim()
}

function providerDisplayName(provider: Provider): string {
  switch (provider) {
    case "openai":
      return "OpenAI"
    case "anthropic":
      return "Anthropic"
    case "google":
      return "Google"
    case "xai":
      return "xAI"
    case "perplexity":
      return "Perplexity"
    case "openrouter":
      return "OpenRouter"
    case "ollama":
      return "Ollama"
  }
}

function formatDuration(milliseconds: number): string {
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`
  return `${milliseconds}ms`
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new Error(typeof reason === "string" && reason.length > 0 ? reason : "aborted")
}

export function getLegTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LLM_LEG_TIMEOUT_MS
  if (raw === undefined || raw === "") return DEFAULT_LEG_TIMEOUT_MS
  const timeoutMs = Number(raw)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("LLM_LEG_TIMEOUT_MS must be a positive finite number of milliseconds")
  }
  return Math.floor(timeoutMs)
}

export function assertDispatchableModelIds(modelIds: readonly string[]): void {
  for (const modelId of modelIds) {
    const replacement = RETIRED_MODEL_REPLACEMENTS[modelId]
    if (replacement) {
      throw new Error(
        `Model "${modelId}" is unavailable or renamed; replace it with "${replacement}" in dual-pro-config.json.`,
      )
    }
  }
}

export async function runWithTimeout<T>({
  label,
  timeoutMs,
  outerSignal,
  run,
}: {
  label: string
  timeoutMs: number
  outerSignal?: AbortSignal
  run(signal: AbortSignal): Promise<T>
}): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive finite number")
  }
  if (outerSignal?.aborted) throw abortError(outerSignal.reason)

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onOuterAbort: (() => void) | undefined
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `${label} timed out after ${formatDuration(timeoutMs)}; partial results will be reported.`,
      )
      controller.abort(error)
      reject(error)
    }, timeoutMs)
    if (outerSignal) {
      onOuterAbort = () => {
        const error = abortError(outerSignal.reason)
        controller.abort(error)
        reject(error)
      }
      outerSignal.addEventListener("abort", onOuterAbort, { once: true })
    }
  })

  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), boundary])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (outerSignal && onOuterAbort) outerSignal.removeEventListener("abort", onOuterAbort)
  }
}

async function probeProvider(provider: Provider, signal: AbortSignal): Promise<void> {
  if (provider === "ollama") return
  const modelId = PREFLIGHT_MODEL_IDS[provider]
  const model = modelId ? getModel(modelId) : undefined
  if (!model) throw new Error(`preflight model is not registered for provider ${provider}`)
  await generateText({
    model: getLanguageModel(model),
    prompt: "Reply OK.",
    maxOutputTokens: 1,
    abortSignal: signal,
  })
}

function formatProviderPreflightError(provider: Provider, error: unknown): string {
  const message = oneLineError(error)
  const name = providerDisplayName(provider)
  const envVar = getProviderEnvVar(provider)
  if (/insufficient[_ -]?quota|billing hard limit|exceeded (?:your )?quota/iu.test(message)) {
    return `${name} quota preflight failed: insufficient quota; top up ${envVar} billing before retrying.`
  }
  if (/invalid[_ -]?(?:api[_ -]?)?key|unauthori[sz]ed|authentication/iu.test(message)) {
    return `${name} auth preflight failed; verify ${envVar} before retrying.`
  }
  return `${name} provider preflight failed: ${message}`
}

export async function preflightProviders(
  providers: readonly Provider[],
  options: {
    probe?: ProviderProbe
    signal?: AbortSignal
    timeoutMs?: number
  } = {},
): Promise<void> {
  const uniqueProviders = Array.from(new Set(providers)).filter((provider) => provider !== "ollama")
  const probe = options.probe ?? probeProvider
  const settled = await Promise.allSettled(
    uniqueProviders.map((provider) =>
      runWithTimeout({
        label: `${providerDisplayName(provider)} quota preflight`,
        timeoutMs: options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS,
        outerSignal: options.signal,
        run: (signal) => probe(provider, signal),
      }),
    ),
  )
  const failures = settled.flatMap((result, index) =>
    result.status === "rejected" ? [formatProviderPreflightError(uniqueProviders[index]!, result.reason)] : [],
  )
  if (failures.length > 0) throw new Error(failures.join(" | "))
}

export function formatLegDispatchError(
  model: Pick<Model, "displayName" | "modelId" | "provider">,
  error: unknown,
): string {
  const message = oneLineError(error)
  if (message.endsWith("partial results will be reported.")) return message
  if (/insufficient[_ -]?quota|billing hard limit|exceeded (?:your )?quota/iu.test(message)) {
    return `${providerDisplayName(model.provider)} insufficient quota; top up ${getProviderEnvVar(model.provider)} billing before retrying.`
  }
  if (/model.{0,40}(?:not found|does not exist|unavailable|renamed)|unknown model/iu.test(message)) {
    const replacement = RETIRED_MODEL_REPLACEMENTS[model.modelId]
    return replacement
      ? `Model "${model.modelId}" is unavailable or renamed; replace it with "${replacement}" in dual-pro-config.json.`
      : `Model "${model.modelId}" is unavailable or renamed; run "bun llm discover" and update dual-pro-config.json.`
  }
  return message
}
