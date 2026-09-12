/**
 * Is each CONFIGURED model still served? — @hh/tooling/24533 acceptance row 4.
 *
 * THE DEFECT THIS CLOSES. The preflight probed each PROVIDER, not each MODEL.
 * A dead model passes an API-key probe and fails only at dispatch, which is
 * exactly how `moonshotai/kimi-k3` survived three days as the `/pro` anchor
 * across three recorded specimens (2026-09-08, 09-10, 09-11). The other half
 * of the preflight, `assertDispatchableModelIds`, checks a HAND-MAINTAINED
 * retirement map — so it can only catch a model somebody already knew was
 * dead. Neither half asks the provider.
 *
 * ONE CATALOG READ PER PROVIDER, NEVER ONE PROBE PER MODEL. The obvious
 * implementation — a cheap completion per configured model — buys the check at
 * the price of the thing it protects: N round trips and N billable calls
 * before every dispatch. A provider's model list answers the same question for
 * every model at once, costs no tokens, and is the exact shape of the observed
 * failure ("Model X is unavailable or renamed"). Priced before it was built.
 *
 * THREE OUTCOMES, AND THE THIRD IS THE ONE THAT KEEPS THIS HONEST:
 *   served      — the catalog lists it. Dispatch.
 *   absent      — the catalog was read and does NOT list it. This is the
 *                 finding: refuse the leg here rather than at dispatch.
 *   unverified  — no catalog reader for that provider, no credential, or the
 *                 fetch failed. NEVER counted as served. The caller is told
 *                 which models these are and why, because a preflight that
 *                 silently passes what it could not check reports health it
 *                 never established.
 *
 * IT MUST NOT BE ABLE TO STOP A RUN BY FAILING. A catalog endpoint that is
 * down is not a reason to refuse work — it is a reason to say the check did
 * not run. Every fetch here is caught, bounded by a timeout, and degrades to
 * `unverified` with the cause attached.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Model, Provider } from "./types"
import { PROVIDER_ENDPOINTS } from "./types"

/** How long a served-model list stays usable. A model retired inside this
 *  window is still caught after dispatch by the error classifier, so the cost
 *  of a stale entry is one bad leg — against a catalog fetch on every run. */
export const CATALOG_TTL_MS = 60 * 60 * 1_000

const CATALOG_TIMEOUT_MS = 10_000
const CACHE_DIR = join(process.env.HOME ?? "~", ".cache", "bearly-llm")

export type LivenessVerdict = "served" | "absent" | "unverified"

export interface ModelLiveness {
  /** The SKU id the operator wrote in dual-pro-config.json. Measured
   *  2026-09-11: all 57 registry endpoints are keyed by exactly this, so it is
   *  also the `PROVIDER_ENDPOINTS` lookup key. */
  readonly modelId: string
  /** The string actually sent to the provider — what the catalog must list. */
  readonly wireId: string
  readonly provider: Provider
  readonly verdict: LivenessVerdict
  /** Why, for `unverified` and `absent`. Absent on `served`. */
  readonly reason?: string
}

export interface CatalogRead {
  readonly servedIds?: ReadonlySet<string>
  /** Present when the catalog could not be read. Never thrown at the caller. */
  readonly failure?: string
}

/** The wire id a dispatch would send for this model — the endpoint override
 *  when one exists, the SKU id otherwise. Checking the SKU id instead would
 *  report every aliased Pro tier absent; exactly 2 of 57 registry entries carry
 *  an override today (`gpt-5.4`, `gpt-5.4-pro`), which is few enough to get
 *  wrong and never notice. */
export function wireModelId(model: Model): string {
  return PROVIDER_ENDPOINTS[model.modelId]?.apiModelId ?? model.modelId
}

interface CatalogSource {
  readonly url: string
  readonly envVar: string
  readonly headers: (key: string) => Record<string, string>
  readonly ids: (body: unknown) => string[]
}

/** `{data: [{id}]}` — the OpenAI list shape, which OpenRouter and Anthropic
 *  both follow. Kept as one reader so a new provider on that shape is a table
 *  row, not another fetch block. */
const openAiShape = (body: unknown): string[] => {
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  return data.map((entry) => (entry as { id?: unknown })?.id).filter((id): id is string => typeof id === "string")
}

/**
 * Providers whose catalog we can read, and how.
 *
 * A provider ABSENT from this table is not a failure — it is `unverified`,
 * reported by name. Google, xAI, Perplexity and Ollama sit outside it today;
 * adding one is a row here plus an arm in the test.
 */
const CATALOG_SOURCES: Partial<Record<Provider, CatalogSource>> = {
  anthropic: {
    envVar: "ANTHROPIC_API_KEY",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    ids: openAiShape,
    url: "https://api.anthropic.com/v1/models",
  },
  openai: {
    envVar: "OPENAI_API_KEY",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    ids: openAiShape,
    url: "https://api.openai.com/v1/models",
  },
  openrouter: {
    envVar: "OPENROUTER_API_KEY",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    ids: openAiShape,
    url: "https://openrouter.ai/api/v1/models",
  },
}

function cachePath(provider: Provider): string {
  return join(CACHE_DIR, `served-models.${provider}.json`)
}

function readCache(provider: Provider, now: number): string[] | undefined {
  const path = cachePath(provider)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { fetchedAt?: unknown; ids?: unknown }
    if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.ids)) return undefined
    if (now - parsed.fetchedAt >= CATALOG_TTL_MS) return undefined
    return parsed.ids.filter((id): id is string => typeof id === "string")
  } catch {
    // silent-fallback-allow: a corrupt cache file is a cache miss, not an error
    // worth surfacing. The caller re-fetches and overwrites it on the next line,
    // so nothing a caller could act on is swallowed and no liveness answer is
    // lost — only the saved copy of one.
    return undefined
  }
}

function writeCache(provider: Provider, ids: readonly string[], now: number): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(cachePath(provider), JSON.stringify({ fetchedAt: now, ids: [...ids] }), "utf-8")
  } catch {
    // silent-fallback-allow: an unwritable cache costs one extra fetch next run
    // and must never cost the run itself. The preflight's answer is already
    // computed and returned; this is the write of a convenience copy.
  }
}

/**
 * The served-model ids for one provider, from cache when fresh.
 *
 * Returns a failure string rather than throwing: every caller of this is a
 * check, and a check that throws becomes the outage it was meant to prevent.
 */
export async function readServedModelIds(
  provider: Provider,
  options: {
    readonly env?: NodeJS.ProcessEnv
    readonly fetchImpl?: typeof fetch
    readonly now?: number
    readonly useCache?: boolean
  } = {},
): Promise<CatalogRead> {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  const useCache = options.useCache ?? true

  const source = CATALOG_SOURCES[provider]
  if (source === undefined) return { failure: `no model catalog reader for provider ${provider}` }

  if (useCache) {
    const cached = readCache(provider, now)
    if (cached !== undefined) return { servedIds: new Set(cached) }
  }

  const key = env[source.envVar]
  if (key === undefined || key === "") {
    return { failure: `${source.envVar} is not set, so ${provider}'s catalog cannot be read` }
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(source.url, {
      headers: source.headers(key),
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    })
    if (!response.ok) {
      return { failure: `${provider} catalog returned HTTP ${response.status}` }
    }
    const ids = source.ids(await response.json())
    if (ids.length === 0) {
      // An empty list would mark every configured model absent — a catastrophic
      // false positive. Refuse to believe it rather than act on it.
      return { failure: `${provider} catalog returned no model ids; treating as unreadable rather than empty` }
    }
    if (useCache) writeCache(provider, ids, now)
    return { servedIds: new Set(ids) }
  } catch (error) {
    return { failure: `${provider} catalog fetch failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Judge every configured model against its provider's catalog.
 *
 * One read per DISTINCT provider, reused across that provider's models — the
 * whole point of the catalog shape.
 */
export async function checkModelLiveness(
  models: readonly Model[],
  options: {
    readonly env?: NodeJS.ProcessEnv
    readonly fetchImpl?: typeof fetch
    readonly now?: number
    readonly useCache?: boolean
  } = {},
): Promise<ModelLiveness[]> {
  const providers = [...new Set(models.map((model) => model.provider))]
  const reads = new Map<Provider, CatalogRead>()
  await Promise.all(
    providers.map(async (provider) => {
      reads.set(provider, await readServedModelIds(provider, options))
    }),
  )

  return models.map((model) => {
    const wireId = wireModelId(model)
    const read = reads.get(model.provider)
    const base = { modelId: model.modelId, provider: model.provider, wireId } as const
    if (read?.servedIds === undefined) {
      return { ...base, reason: read?.failure ?? "catalog was not read", verdict: "unverified" as const }
    }
    if (read.servedIds.has(wireId)) return { ...base, verdict: "served" as const }
    return {
      ...base,
      reason: `${model.provider} does not serve "${wireId}"; it is renamed or retired`,
      verdict: "absent" as const,
    }
  })
}

/**
 * The operator-facing lines for one liveness pass.
 *
 * Every unverified model is named. A preflight whose quiet cases and whose
 * unchecked cases look the same is the defect this bead is about.
 */
export function describeLiveness(results: readonly ModelLiveness[]): string[] {
  const lines: string[] = []
  for (const result of results.filter((r) => r.verdict === "absent")) {
    lines.push(`  ✗ ${result.modelId} (${result.wireId}) — ${result.reason}`)
  }
  const unverified = results.filter((r) => r.verdict === "unverified")
  if (unverified.length > 0) {
    const served = results.filter((r) => r.verdict === "served").length
    lines.push(
      `  ⚠ preflight verified ${served}/${results.length} configured models; NOT verified: ` +
        unverified.map((r) => `${r.modelId} (${r.reason})`).join("; "),
    )
  }
  return lines
}
