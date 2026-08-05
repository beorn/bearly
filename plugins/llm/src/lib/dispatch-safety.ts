import { getProviderEnvVar, type Model, type Provider } from "./types"

export const DEFAULT_LEG_TIMEOUT_MS = 15 * 60 * 1_000

const RETIRED_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
  "grok-4": "grok-4-1-fast-reasoning",
})

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

export function formatLegDispatchError(
  model: Pick<Model, "displayName" | "modelId" | "provider">,
  error: unknown,
): string {
  const message = oneLineError(error)
  // Exact passthrough for runWithTimeout's OWN wrapper message — it already
  // explains pro's specific semantics (other legs still report), so don't
  // rewrite it into the generic timeout advice below.
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
  // Generic timeout — covers callers with their OWN timeout wrapper (recall's
  // per-batch race, e.g.) whose message doesn't match the exact passthrough
  // above. A timeout is not a credentials problem; say so explicitly so a
  // caller doesn't point the user at billing/API-key fixes for a slow model.
  if (/\btimed?[ -]?out\b/iu.test(message)) {
    return `${providerDisplayName(model.provider)} (${model.modelId}) was too slow for the time it was given (${message}) — not a credentials problem; retry with more time, or use a faster model.`
  }
  return message
}
