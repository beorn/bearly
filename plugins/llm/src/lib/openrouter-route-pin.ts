/**
 * OpenRouter per-route context pinning.
 *
 * The SKU registry advertises `top_provider.context_length` (128k for
 * DeepSeek Chat). OpenRouter still load-balances onto other endpoints of
 * the same model whose window is smaller. Specimen 28425: prompt 117114
 * tokens, DeepInfra `max_num_tokens` 32768, DeepSeek opinion lost.
 *
 * Pin `provider.only` to providers whose *minimum* listed context is at
 * least the prompt, or refuse before dispatch. A provider that also hosts
 * a too-small endpoint is excluded: `only` is a provider slug, not an
 * endpoint, so including it would still allow the 32k route.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface OpenRouterRoute {
  readonly providerSlug: string
  readonly contextLength: number
}

export interface OpenRouterProviderPin {
  readonly only: readonly string[]
  readonly allow_fallbacks: false
}

const ENDPOINTS_TTL_MS = 60 * 60 * 1_000
const ENDPOINTS_TIMEOUT_MS = 10_000
const CACHE_DIR = join(process.env.HOME ?? "~", ".cache", "bearly-llm")

/**
 * OpenRouter `/endpoints` `context_length` is not the enforced prompt window.
 * Specimen 27977 and 28425: DeepInfra lists 128000–163840 for
 * `deepseek/deepseek-chat` and then rejects at `max_num_tokens` 32768.
 * Clamp at pin time; the cache still stores the catalog bytes.
 */
const OBSERVED_PROMPT_CEILINGS: ReadonlyArray<{
  readonly modelId: string
  readonly providerSlug: string
  readonly maxPromptTokens: number
}> = [{ modelId: "deepseek/deepseek-chat", providerSlug: "DeepInfra", maxPromptTokens: 32_768 }]

function clampObservedPromptCeilings(modelId: string, routes: readonly OpenRouterRoute[]): OpenRouterRoute[] {
  return routes.map((route) => {
    const observed = OBSERVED_PROMPT_CEILINGS.find(
      (row) => row.modelId === modelId && row.providerSlug === route.providerSlug,
    )
    if (!observed) return route
    return { providerSlug: route.providerSlug, contextLength: Math.min(route.contextLength, observed.maxPromptTokens) }
  })
}

export function pinOpenRouterRoutesForPrompt(
  promptTokens: number,
  routes: readonly OpenRouterRoute[],
): OpenRouterProviderPin {
  const minBySlug = new Map<string, number>()
  for (const route of routes) {
    if (!route.providerSlug || !Number.isFinite(route.contextLength) || route.contextLength <= 0) continue
    const prev = minBySlug.get(route.providerSlug)
    minBySlug.set(route.providerSlug, prev === undefined ? route.contextLength : Math.min(prev, route.contextLength))
  }
  const fitting = [...minBySlug.entries()].filter(([, minWindow]) => minWindow >= promptTokens).map(([slug]) => slug)
  if (fitting.length === 0) {
    const windows = [...minBySlug.values()]
    const maxWindow = windows.length > 0 ? Math.max(...windows) : 0
    throw new OpenRouterRouteTooSmallError(promptTokens, maxWindow)
  }
  return { only: fitting, allow_fallbacks: false }
}

export class OpenRouterRouteTooSmallError extends Error {
  readonly promptTokens: number
  readonly routeWindow: number
  constructor(promptTokens: number, routeWindow: number) {
    super(`The prompt is ${promptTokens} tokens; this route's limit is ${routeWindow}.`)
    this.name = "OpenRouterRouteTooSmallError"
    this.promptTokens = promptTokens
    this.routeWindow = routeWindow
  }
}

export function parseOpenRouterEndpoints(body: unknown): OpenRouterRoute[] {
  const root = body && typeof body === "object" ? (body as { data?: unknown }) : undefined
  const data = root?.data
  const endpointsRaw =
    data && typeof data === "object" && "endpoints" in data
      ? (data as { endpoints?: unknown }).endpoints
      : Array.isArray(data)
        ? data
        : undefined
  if (!Array.isArray(endpointsRaw)) return []
  const routes: OpenRouterRoute[] = []
  for (const entry of endpointsRaw) {
    if (!entry || typeof entry !== "object") continue
    const row = entry as { provider_name?: unknown; context_length?: unknown }
    if (typeof row.provider_name !== "string" || row.provider_name.length === 0) continue
    if (typeof row.context_length !== "number" || !Number.isFinite(row.context_length)) continue
    routes.push({ providerSlug: row.provider_name, contextLength: row.context_length })
  }
  return routes
}

function cachePath(modelId: string): string {
  return join(CACHE_DIR, `openrouter-endpoints.${modelId.replaceAll("/", "_")}.json`)
}

function readCachedRoutes(modelId: string, now: number): OpenRouterRoute[] | undefined {
  const path = cachePath(modelId)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { fetchedAt?: unknown; routes?: unknown }
    if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.routes)) return undefined
    if (now - parsed.fetchedAt >= ENDPOINTS_TTL_MS) return undefined
    const routes = parseOpenRouterEndpoints({ data: { endpoints: parsed.routes } })
    return routes.length > 0 ? routes : undefined
  } catch {
    // silent-fallback-allow: a corrupt cache file is a cache miss, not an error
    // worth surfacing. The caller re-fetches and overwrites it on the next line,
    // so nothing a caller could act on is swallowed and no pin answer is lost —
    // only the saved copy of one.
    return undefined
  }
}

function writeCachedRoutes(modelId: string, routes: readonly OpenRouterRoute[], now: number): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(
      cachePath(modelId),
      JSON.stringify({
        fetchedAt: now,
        routes: routes.map((route) => ({
          provider_name: route.providerSlug,
          context_length: route.contextLength,
        })),
      }),
    )
  } catch {
    // silent-fallback-allow: an unwritable cache costs one extra fetch next run
    // and must never cost the run itself. The pin decision is already computed
    // and returned; this is the write of a convenience copy.
  }
}

export async function readOpenRouterRoutes(
  modelId: string,
  options: {
    readonly env?: NodeJS.ProcessEnv
    readonly fetchImpl?: typeof fetch
    readonly now?: number
    readonly useCache?: boolean
  } = {},
): Promise<OpenRouterRoute[] | undefined> {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  const useCache = options.useCache ?? true
  if (useCache) {
    const cached = readCachedRoutes(modelId, now)
    if (cached) return cached
  }
  const key = env.OPENROUTER_API_KEY
  if (!key) {
    console.warn(
      `[openrouter-route-pin] skipped endpoints fetch for ${modelId}: OPENROUTER_API_KEY is unset. ` +
        `Pinning is skipped; 27977 still classifies a too-small route after dispatch.`,
    )
    return undefined
  }
  const url = `https://openrouter.ai/api/v1/models/${modelId}/endpoints`
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(ENDPOINTS_TIMEOUT_MS),
    })
    if (!response.ok) {
      console.warn(
        `[openrouter-route-pin] GET ${url} returned HTTP ${response.status}. ` +
          `Queried OpenRouter endpoints for ${modelId}; pinning is skipped so the leg still dispatches. ` +
          `27977 still classifies a too-small route after dispatch.`,
      )
      return undefined
    }
    const routes = parseOpenRouterEndpoints(await response.json())
    if (routes.length === 0) {
      console.warn(
        `[openrouter-route-pin] GET ${url} returned no provider_name/context_length endpoints for ${modelId}. ` +
          `Pinning is skipped; 27977 still classifies a too-small route after dispatch.`,
      )
      return undefined
    }
    writeCachedRoutes(modelId, routes, now)
    return routes
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.warn(
      `[openrouter-route-pin] GET ${url} failed (${detail}). ` +
        `Queried OpenRouter endpoints for ${modelId}; pinning is skipped so the leg still dispatches. ` +
        `27977 still classifies a too-small route after dispatch.`,
    )
    return undefined
  }
}

export type OpenRouterPinDecision =
  | { readonly kind: "pin"; readonly pin: OpenRouterProviderPin }
  | { readonly kind: "refuse"; readonly promptTokens: number; readonly routeWindow: number }
  | { readonly kind: "unknown" }

/**
 * Pin fitting OpenRouter providers, refuse when every listed window is too
 * small, or `unknown` when the endpoints catalog is missing so the leg still
 * dispatches (27977 classifies after).
 */
export async function decideOpenRouterRoutePin(
  modelId: string,
  promptTokens: number,
  options: Parameters<typeof readOpenRouterRoutes>[1] = {},
): Promise<OpenRouterPinDecision> {
  const routes = await readOpenRouterRoutes(modelId, options)
  if (!routes || routes.length === 0) return { kind: "unknown" }
  try {
    return {
      kind: "pin",
      pin: pinOpenRouterRoutesForPrompt(promptTokens, clampObservedPromptCeilings(modelId, routes)),
    }
  } catch (error) {
    if (error instanceof OpenRouterRouteTooSmallError) {
      return { kind: "refuse", promptTokens: error.promptTokens, routeWindow: error.routeWindow }
    }
    throw error
  }
}

export function injectOpenRouterProviderPin(pin: OpenRouterProviderPin, fetchImpl: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body
    if (typeof body !== "string") return fetchImpl(input, init)
    try {
      const parsed = JSON.parse(body) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return await fetchImpl(input, init)
      }
      const next = { ...(parsed as Record<string, unknown>), provider: pin }
      return await fetchImpl(input, { ...init, body: JSON.stringify(next) })
    } catch {
      return fetchImpl(input, init)
    }
  }) as typeof fetch
}

export function openRouterContextLengthRefusal(modelId: string, promptTokens: number, routeWindow: number): string {
  return (
    `OpenRouter (${modelId}) rejected this request's CONTEXT LENGTH — this is NOT a credentials problem. ` +
    `The prompt is ${promptTokens} tokens; this route's limit is ${routeWindow}. ` +
    `Trim the context or pick a model whose context window fits.`
  )
}
