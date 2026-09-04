import type { ProviderObservation, PersistedProviderRefusalKind } from "./provider-availability"
import { getProviderEnvVar, type Model, type Provider } from "./types"

const RETIRED_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
  "grok-4": "grok-4-1-fast-reasoning",
})

export type DispatchFailureKind = PersistedProviderRefusalKind | "model-unavailable" | "timeout" | "unknown"

export interface DispatchFailureDescription {
  kind: DispatchFailureKind
  scope: "provider" | "model" | "call"
  message: string
  remedy?: string
  retryAt?: number
  observation?: ProviderObservation
}

export interface DispatchFailureTarget {
  provider: Provider
  modelId?: string
  displayName?: string
}

export function getRetiredModelReplacement(modelId: string): string | undefined {
  return RETIRED_MODEL_REPLACEMENTS[modelId]
}

function stringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    const object = error as Record<string, unknown>
    const nested =
      object.error && typeof object.error === "object" ? (object.error as Record<string, unknown>) : undefined
    return (
      (typeof object.message === "string" && object.message) ||
      (nested && typeof nested.message === "string" && nested.message) ||
      stringify(error)
    )
  }
  return String(error)
}

function oneLineError(error: unknown): string {
  return rawErrorMessage(error)
    .replace(/^Error:\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim()
}

function errorBlob(error: unknown): string {
  const parts = [rawErrorMessage(error), stringify(error)]
  if (error && typeof error === "object") {
    const item = error as { responseBody?: unknown; data?: unknown; cause?: unknown }
    if (typeof item.responseBody === "string") parts.push(item.responseBody)
    if (item.data !== undefined) parts.push(stringify(item.data))
    if (item.cause) parts.push(item.cause instanceof Error ? item.cause.message : stringify(item.cause))
  }
  return parts.join(" | ")
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

function alternateModel(provider: Provider): string {
  return provider === "openai"
    ? "--model moonshotai/kimi-k2.6 (OpenRouter) or --model gemini-2.5-pro (Google)"
    : "--model gpt-5.4 (OpenAI) or --model moonshotai/kimi-k2.6 (OpenRouter)"
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined
  const getter = (headers as { get?: unknown }).get
  if (typeof getter === "function") {
    const value: unknown = (getter as (name: string) => unknown).call(headers, name)
    return value === null || value === undefined ? undefined : String(value)
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== name.toLowerCase() || value === undefined || value === null) continue
    return Array.isArray(value) ? value.map(String).join(",") : String(value)
  }
  return undefined
}

function retryAtFromError(error: unknown, now: number): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const item = error as {
    responseHeaders?: unknown
    headers?: unknown
    response?: { headers?: unknown }
  }
  const headerSets = [item.responseHeaders, item.headers, item.response?.headers]
  for (const headers of headerSets) {
    const retryAfter = headerValue(headers, "retry-after")
    if (retryAfter !== undefined) {
      const seconds = Number(retryAfter)
      if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1_000
      const date = Date.parse(retryAfter)
      if (Number.isFinite(date)) return date
    }
    const reset = headerValue(headers, "x-ratelimit-reset")
    if (reset !== undefined) {
      const numeric = Number(reset)
      if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric
      const date = Date.parse(reset)
      if (Number.isFinite(date)) return date
    }
  }
  return undefined
}

function responseStatusFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const item = error as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown; statusCode?: unknown }
  }
  for (const candidate of [item.status, item.statusCode, item.response?.status, item.response?.statusCode]) {
    const numeric = typeof candidate === "number" ? candidate : Number(candidate)
    if (Number.isInteger(numeric) && numeric >= 100 && numeric <= 599) return numeric
  }
  return undefined
}

function refusing(
  kind: PersistedProviderRefusalKind,
  target: DispatchFailureTarget,
  message: string,
  remedy?: string,
  retryAt?: number,
  observationReason = message,
): DispatchFailureDescription {
  const observation: ProviderObservation = {
    provider: target.provider,
    status: "refusing",
    kind,
    source: "dispatch",
    reason: observationReason,
    ...(retryAt !== undefined ? { retryAt } : {}),
  }
  return {
    kind,
    scope: "provider",
    message,
    ...(remedy ? { remedy } : {}),
    ...(retryAt !== undefined ? { retryAt } : {}),
    observation,
  }
}

/** Pure owner of provider/model/call failure classification and rendering. */
export function describeDispatchFailure(
  error: unknown,
  target: DispatchFailureTarget,
  now = Date.now(),
): DispatchFailureDescription {
  const message = oneLineError(error)
  const blob = errorBlob(error)
  const envVar = getProviderEnvVar(target.provider)
  const alt = alternateModel(target.provider)
  const responseStatus = responseStatusFromError(error)

  // runWithTimeout already describes Pro's partial-results semantics exactly.
  if (message.endsWith("partial results will be reported.")) {
    return { kind: "timeout", scope: "call", message }
  }
  if (/\btimed?[ -]?out\b/iu.test(blob)) {
    const rendered = target.modelId
      ? `${providerDisplayName(target.provider)} (${target.modelId}) was too slow for the time it was given — not a credentials problem; retry with more time, or use a faster model.`
      : `${providerDisplayName(target.provider)} dispatch timed out — not a credentials problem; retry with more time, or use a faster model.`
    return {
      kind: "timeout",
      scope: "call",
      message: rendered,
      remedy: "retry with more time, or use a faster model",
    }
  }
  if (/insufficient[_ -]?(?:quota|credits)|billing hard limit|exceeded (?:your )?(?:current )?quota/iu.test(blob)) {
    const rendered = target.modelId
      ? `${providerDisplayName(target.provider)} insufficient quota; top up ${envVar} billing before retrying.`
      : `${target.provider} quota exhausted (insufficient_quota) — check plan & billing for ${envVar}. Retry with another provider: ${alt}.`
    return refusing("quota", target, rendered, `check plan and billing for ${envVar}`)
  }
  if (/rate[ _-]?limit|too many requests|\b429\s+too many requests\b/iu.test(blob) || responseStatus === 429) {
    const rendered = `${target.provider} rate-limited (429) — wait and retry, or use another provider: ${alt}.`
    return refusing(
      "rate-limited",
      target,
      rendered,
      "wait and retry, or use another provider",
      retryAtFromError(error, now),
    )
  }
  if (
    /model.{0,40}(?:not found|does not exist|unavailable|renamed)|no such model|unknown model|invalid model/iu.test(
      blob,
    )
  ) {
    const replacement = target.modelId ? getRetiredModelReplacement(target.modelId) : undefined
    const rendered = target.modelId
      ? replacement
        ? `Model "${target.modelId}" is unavailable or renamed; replace it with "${replacement}" in dual-pro-config.json.`
        : `Model "${target.modelId}" is unavailable or renamed; run "bun llm pro --discover-models" and update dual-pro-config.json.`
      : `${target.provider} rejected the model id (renamed or unavailable). Run \`llm quota\` for live providers; the registry is plugins/llm/src/lib/types.ts.`
    return {
      kind: "model-unavailable",
      scope: "model",
      message: rendered,
      remedy: replacement ? `replace it with ${replacement}` : "discover current model ids and update the registry",
    }
  }
  if (
    /invalid[_ ]?api[_ ]?key|unauthorized|permission|auth failed|organization not verified/iu.test(blob) ||
    responseStatus === 401 ||
    responseStatus === 403
  ) {
    const rendered = `${target.provider} auth failed — check ${envVar}.`
    return refusing("auth", target, rendered, `check ${envVar}`)
  }
  if (
    /internal server error|bad gateway|service unavailable|\b(?:http(?: status)?|status(?: code)?|response)\s*[:=]?\s*(?:500|502|503|504)\b/iu.test(
      blob,
    ) ||
    responseStatus === 500 ||
    responseStatus === 502 ||
    responseStatus === 503 ||
    responseStatus === 504
  ) {
    const rendered = `${target.provider} server error during dispatch — retry later or use another provider.`
    return refusing(
      "server-error",
      target,
      rendered,
      "retry later or use another provider",
      undefined,
      `${target.provider} server error during dispatch`,
    )
  }
  if (/econnrefused|enotfound|connection refused|network error|socket hang up|fetch failed/iu.test(blob)) {
    const rendered = `${target.provider} transport failure during dispatch — check the provider endpoint and network, then retry.`
    return refusing(
      "transport",
      target,
      rendered,
      "check the provider endpoint and network, then retry",
      undefined,
      `${target.provider} transport failure during dispatch`,
    )
  }
  const targetDescription = target.modelId ? ` for model ${target.modelId}` : ""
  return {
    kind: "unknown",
    scope: "call",
    message: `${providerDisplayName(target.provider)} dispatch failed${targetDescription}: unclassified provider error.`,
  }
}

export type DispatchFailureModelTarget = Pick<Model, "displayName" | "modelId" | "provider">
