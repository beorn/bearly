/**
 * Provider quota / rate-limit tracking.
 *
 * Two layers, both opt-in:
 *
 *   1. `bun llm quota` — one-shot snapshot. Hits each provider's quota /
 *      balance endpoint where one exists (OpenRouter, OpenAI org-usage),
 *      and falls back to the cached `x-ratelimit-*` headers from a recent
 *      call for providers that ship rate limits but no balance API
 *      (Anthropic, sometimes OpenAI). Providers with no quota surface at
 *      all (Google, xAI, Perplexity, Ollama) report `null` and render as
 *      "no quota API" rows — graceful, not an error.
 *
 *   2. `--quota` flag on `ask` / `pro` / `--deep` / `opinion` / `debate` /
 *      `research` — drops the rate-limit headers from THE call you just
 *      made into the JSON envelope. Zero extra HTTP — the headers were
 *      already on the response. The runtime cache is updated unconditionally
 *      so layer 1 has fresh fallback data even when the user didn't pass
 *      `--quota`.
 *
 * Cache file: `~/.cache/bearly-llm/last-quota-by-provider.json` (override
 * via XDG_CACHE_HOME, or `_setCachePathForTesting` for tests). Atomic write
 * (temp + rename) so a crash mid-write can't corrupt the cache.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { Provider } from "./types"

// ============================================================================
// Snapshot type
// ============================================================================

export interface QuotaSnapshot {
  provider: Provider
  // Balance / spend (optional — only providers with a balance API have these)
  balanceUsd?: number
  spentMonthUsd?: number
  remainingCreditUsd?: number
  // Rate limits (from `x-ratelimit-*` / `anthropic-ratelimit-*` headers)
  remainingRequests?: number
  requestsPerWindow?: number
  remainingTokens?: number
  tokensPerWindow?: number
  resetRequestsAt?: string
  resetTokensAt?: string
  // Free-form provider-specific label (e.g. OpenRouter key label)
  label?: string
  // Provenance
  source: "api" | "headers-cache"
  fetchedAt: string
  // Error message if the quota fetch failed (so the table can show "set $KEY").
  error?: string
}

// ============================================================================
// Cache I/O
// ============================================================================

let cachePathOverride: string | undefined

/**
 * Resolve the on-disk cache path. Honors XDG_CACHE_HOME so users with custom
 * cache layouts work; falls back to `$HOME/.cache/bearly-llm/`. Tests can
 * pin the path via `_setCachePathForTesting`.
 */
export function getCachePath(): string {
  if (cachePathOverride) return cachePathOverride
  const xdg = process.env.XDG_CACHE_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache")
  return join(base, "bearly-llm", "last-quota-by-provider.json")
}

/** @internal — pin the cache path for the duration of a test. */
export function _setCachePathForTesting(path: string | undefined): void {
  cachePathOverride = path
}

/**
 * Load the cached snapshot map (provider → snapshot). Returns an empty map
 * on missing file or parse error — callers always merge against an empty
 * baseline rather than failing.
 */
export function loadQuotaCache(): Record<string, QuotaSnapshot> {
  const path = getCachePath()
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, "utf-8")
    const parsed = JSON.parse(raw) as Record<string, QuotaSnapshot>
    if (parsed && typeof parsed === "object") return parsed
    return {}
  } catch {
    return {}
  }
}

/**
 * Atomically write the snapshot map. Temp file + rename so a crash mid-write
 * leaves the previous snapshot intact rather than a half-written JSON blob.
 */
export function saveQuotaCache(map: Record<string, QuotaSnapshot>): void {
  const path = getCachePath()
  const lastSlash = path.lastIndexOf("/")
  const dir = lastSlash > 0 ? path.slice(0, lastSlash) : "."
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* may already exist */
  }
  // Temp file in the same dir so rename is atomic on the same fs.
  const tmp = join(dir, `.last-quota-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(map, null, 2), "utf-8")
    renameSync(tmp, path)
  } catch {
    // Best-effort — if we can't write, in-memory snapshot still surfaces via
    // the JSON envelope. Cache miss is recoverable; corruption is not.
  }
}

/** Update the cache with a single snapshot. Idempotent. */
export function updateQuotaCache(snapshot: QuotaSnapshot): void {
  const map = loadQuotaCache()
  map[snapshot.provider] = snapshot
  saveQuotaCache(map)
}

// ============================================================================
// Header parsing
// ============================================================================

/** Lower-cased header bag — providers ship inconsistent casing. */
type HeaderBag = Record<string, string | string[] | undefined> | Headers | undefined

function readHeader(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as Headers).get === "function") {
    const v = (headers as Headers).get(name)
    return v ?? undefined
  }
  // Plain object — case-insensitive lookup.
  const lower = name.toLowerCase()
  const bag = headers as Record<string, string | string[] | undefined>
  for (const k of Object.keys(bag)) {
    if (k.toLowerCase() === lower) {
      const v = bag[k]
      if (Array.isArray(v)) return v[0]
      return v
    }
  }
  return undefined
}

function parseIntSafe(v: string | undefined): number | undefined {
  if (v == null) return undefined
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Parse `x-ratelimit-*` headers into a partial QuotaSnapshot. Works for any
 * provider that ships the OpenAI-style names (OpenAI, OpenRouter, xAI). The
 * Anthropic shape uses a different prefix and is handled separately.
 */
export function parseOpenAIStyleRateLimitHeaders(
  provider: Provider,
  headers: HeaderBag,
): Partial<QuotaSnapshot> & { provider: Provider } {
  const remainingRequests = parseIntSafe(readHeader(headers, "x-ratelimit-remaining-requests"))
  const requestsPerWindow = parseIntSafe(readHeader(headers, "x-ratelimit-limit-requests"))
  const remainingTokens = parseIntSafe(readHeader(headers, "x-ratelimit-remaining-tokens"))
  const tokensPerWindow = parseIntSafe(readHeader(headers, "x-ratelimit-limit-tokens"))
  const resetRequestsAt = parseResetHeader(readHeader(headers, "x-ratelimit-reset-requests"))
  const resetTokensAt = parseResetHeader(readHeader(headers, "x-ratelimit-reset-tokens"))
  return {
    provider,
    ...(remainingRequests != null && { remainingRequests }),
    ...(requestsPerWindow != null && { requestsPerWindow }),
    ...(remainingTokens != null && { remainingTokens }),
    ...(tokensPerWindow != null && { tokensPerWindow }),
    ...(resetRequestsAt != null && { resetRequestsAt }),
    ...(resetTokensAt != null && { resetTokensAt }),
  }
}

/**
 * Anthropic ships `anthropic-ratelimit-*-{remaining,limit,reset}`. The
 * reset value is already ISO-8601 (not seconds-until-reset like OpenAI).
 */
export function parseAnthropicRateLimitHeaders(headers: HeaderBag): Partial<QuotaSnapshot> & { provider: "anthropic" } {
  const remainingRequests = parseIntSafe(readHeader(headers, "anthropic-ratelimit-requests-remaining"))
  const requestsPerWindow = parseIntSafe(readHeader(headers, "anthropic-ratelimit-requests-limit"))
  const remainingTokens = parseIntSafe(readHeader(headers, "anthropic-ratelimit-tokens-remaining"))
  const tokensPerWindow = parseIntSafe(readHeader(headers, "anthropic-ratelimit-tokens-limit"))
  const resetRequestsAt = readHeader(headers, "anthropic-ratelimit-requests-reset")
  const resetTokensAt = readHeader(headers, "anthropic-ratelimit-tokens-reset")
  return {
    provider: "anthropic",
    ...(remainingRequests != null && { remainingRequests }),
    ...(requestsPerWindow != null && { requestsPerWindow }),
    ...(remainingTokens != null && { remainingTokens }),
    ...(tokensPerWindow != null && { tokensPerWindow }),
    ...(resetRequestsAt && { resetRequestsAt }),
    ...(resetTokensAt && { resetTokensAt }),
  }
}

/**
 * OpenAI's reset headers are sometimes ISO-8601 (`2026-04-27T08:00:00Z`),
 * sometimes seconds-until-reset (`60`), sometimes a duration string
 * (`6m0s`). Normalize to ISO-8601 — relative formats are converted using
 * "now + N seconds". Unknown shapes pass through verbatim.
 */
export function parseResetHeader(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  // Already ISO-8601-ish.
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return trimmed
  // Pure seconds.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = parseFloat(trimmed)
    return new Date(Date.now() + seconds * 1000).toISOString()
  }
  // Duration string like "6m0s" / "1h30m" / "2ms" — best-effort parse.
  // Order matters: `ms` BEFORE `m`+`s`, otherwise "2ms" parses as 2 minutes.
  const msMatch = trimmed.match(/^(\d+(?:\.\d+)?)ms$/i)
  if (msMatch) {
    const ms = parseFloat(msMatch[1]!)
    if (ms >= 0) return new Date(Date.now() + ms).toISOString()
  }
  const durMatch = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i)
  if (durMatch && (durMatch[1] || durMatch[2] || durMatch[3])) {
    const h = parseInt(durMatch[1] ?? "0", 10)
    const m = parseInt(durMatch[2] ?? "0", 10)
    const s = parseFloat(durMatch[3] ?? "0")
    const totalMs = (h * 3600 + m * 60 + s) * 1000
    if (totalMs > 0) return new Date(Date.now() + totalMs).toISOString()
  }
  return trimmed
}

/**
 * Capture rate-limit headers from a finished request and update the runtime
 * cache. Called after each call. Provider-aware so we use the right header
 * prefix. Returns the snapshot if any rate-limit fields were present;
 * `undefined` otherwise.
 *
 * Best-effort — failures are silently absorbed. Quota tracking must never
 * fail the actual model call.
 */
export function captureRateLimitFromHeaders(provider: Provider, headers: HeaderBag): QuotaSnapshot | undefined {
  if (!headers) return undefined
  const partial =
    provider === "anthropic"
      ? parseAnthropicRateLimitHeaders(headers)
      : parseOpenAIStyleRateLimitHeaders(provider, headers)
  const hasData =
    partial.remainingRequests != null ||
    partial.requestsPerWindow != null ||
    partial.remainingTokens != null ||
    partial.tokensPerWindow != null
  if (!hasData) return undefined
  const snapshot: QuotaSnapshot = {
    ...partial,
    source: "headers-cache",
    fetchedAt: new Date().toISOString(),
  }
  try {
    updateQuotaCache(snapshot)
  } catch {
    /* best-effort */
  }
  return snapshot
}

// ============================================================================
// Provider-specific quota fetchers
// ============================================================================

/**
 * OpenRouter — `GET /api/v1/auth/key` returns:
 *   { data: { label, limit, limit_remaining, usage, is_free_tier, ... } }
 * Auth via the same OPENROUTER_API_KEY we already use. No admin scope needed.
 */
export async function getOpenRouterQuota(signal?: AbortSignal): Promise<QuotaSnapshot | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return null
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    })
    if (!resp.ok) {
      return {
        provider: "openrouter",
        source: "api",
        fetchedAt: new Date().toISOString(),
        error: `HTTP ${resp.status} ${resp.statusText}`,
      }
    }
    const json = (await resp.json()) as {
      data?: {
        label?: string
        limit?: number | null
        limit_remaining?: number | null
        usage?: number
        is_free_tier?: boolean
      }
    }
    const data = json.data ?? {}
    return {
      provider: "openrouter",
      label: data.label,
      balanceUsd: typeof data.limit === "number" ? data.limit : undefined,
      remainingCreditUsd: typeof data.limit_remaining === "number" ? data.limit_remaining : undefined,
      spentMonthUsd: typeof data.usage === "number" ? data.usage : undefined,
      source: "api",
      fetchedAt: new Date().toISOString(),
    }
  } catch (err) {
    return {
      provider: "openrouter",
      source: "api",
      fetchedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * OpenAI — there's no public consumer balance endpoint. The org-usage admin
 * API (`/v1/organization/usage/completions`) requires an admin key, which
 * is rare. We try the admin endpoint best-effort; on 401/403/etc. we fall
 * back to "header-only" with cached rate limits from prior calls.
 */
export async function getOpenAIQuota(signal?: AbortSignal): Promise<QuotaSnapshot | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null

  try {
    const start = new Date()
    start.setUTCDate(1)
    start.setUTCHours(0, 0, 0, 0)
    const startUnix = Math.floor(start.getTime() / 1000)
    const resp = await fetch(`https://api.openai.com/v1/organization/usage/completions?start_time=${startUnix}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    })
    if (resp.ok) {
      const json = (await resp.json()) as {
        data?: Array<{ results?: Array<{ amount?: { value?: number } }> }>
      }
      let spent = 0
      for (const bucket of json.data ?? []) {
        for (const r of bucket.results ?? []) {
          if (typeof r.amount?.value === "number") spent += r.amount.value
        }
      }
      return mergeFromCache("openai", {
        provider: "openai",
        spentMonthUsd: spent,
        source: "api",
        fetchedAt: new Date().toISOString(),
      })
    }
    // 401 / 403 / 404 — no admin access. Fall through to cache.
  } catch {
    /* fall through to cache */
  }

  return mergeFromCache("openai", {
    provider: "openai",
    source: "headers-cache",
    fetchedAt: new Date().toISOString(),
    error: "no balance API (admin key required for usage)",
  })
}

/**
 * Anthropic — no balance endpoint. Always serves cached rate limits from a
 * recent call. Empty cache → "no quota API; make a call first".
 */
export async function getAnthropicQuota(): Promise<QuotaSnapshot | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null
  return mergeFromCache("anthropic", {
    provider: "anthropic",
    source: "headers-cache",
    fetchedAt: new Date().toISOString(),
    error: "header-only — make a call to populate rate limits",
  })
}

/**
 * Generic "no quota API" fetcher for providers that don't expose anything
 * (Google, xAI, Perplexity). Falls back to the cache; if empty, returns a
 * row that renders as "no quota API" in the table.
 */
export async function getNoApiQuota(provider: Provider): Promise<QuotaSnapshot | null> {
  const envVar =
    provider === "google"
      ? "GOOGLE_GENERATIVE_AI_API_KEY"
      : provider === "xai"
        ? "XAI_API_KEY"
        : provider === "perplexity"
          ? "PERPLEXITY_API_KEY"
          : ""
  if (!envVar || !process.env[envVar]) return null
  return mergeFromCache(provider, {
    provider,
    source: "headers-cache",
    fetchedAt: new Date().toISOString(),
    error: "no quota API",
  })
}

/**
 * Read the cache for `provider` and merge over the supplied default. Cached
 * rate-limit fields win; the default supplies the "this provider has no
 * balance API" error if nothing's cached.
 */
function mergeFromCache(provider: Provider, fallback: QuotaSnapshot): QuotaSnapshot {
  const cache = loadQuotaCache()
  const cached = cache[provider]
  if (!cached) return fallback
  return {
    ...fallback,
    remainingRequests: cached.remainingRequests,
    requestsPerWindow: cached.requestsPerWindow,
    remainingTokens: cached.remainingTokens,
    tokensPerWindow: cached.tokensPerWindow,
    resetRequestsAt: cached.resetRequestsAt,
    resetTokensAt: cached.resetTokensAt,
    fetchedAt: cached.fetchedAt,
    error: cached.remainingTokens != null || cached.remainingRequests != null ? undefined : fallback.error,
  }
}

// ============================================================================
// Top-level: collect snapshots from every configured provider
// ============================================================================

/**
 * Get quota snapshots for all configured providers. Providers without an
 * API key return `null` and are filtered out. Network-bound calls (OpenAI,
 * OpenRouter) run in parallel.
 */
export async function getAllQuotas(signal?: AbortSignal): Promise<QuotaSnapshot[]> {
  const tasks: Array<Promise<QuotaSnapshot | null>> = [
    getOpenAIQuota(signal),
    getOpenRouterQuota(signal),
    getAnthropicQuota(),
    getNoApiQuota("google"),
    getNoApiQuota("xai"),
    getNoApiQuota("perplexity"),
  ]
  const results = await Promise.all(tasks)
  return results.filter((r): r is QuotaSnapshot => r !== null)
}

// ============================================================================
// Rendering
// ============================================================================

function fmtUsd(v: number | undefined): string {
  if (v == null) return "—"
  if (v < 0.01) return `$${(v * 100).toFixed(2)}¢`
  if (v < 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}

function fmtPair(remaining: number | undefined, limit: number | undefined, unit: string): string {
  if (remaining == null && limit == null) return "—"
  if (remaining == null) return `?/${formatNum(limit!)}${unit}`
  if (limit == null) return `${formatNum(remaining)}${unit}`
  return `${formatNum(remaining)}/${formatNum(limit)}${unit}`
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}K`
  return String(n)
}

function fmtBalance(s: QuotaSnapshot): string {
  const parts: string[] = []
  if (s.remainingCreditUsd != null) parts.push(`${fmtUsd(s.remainingCreditUsd)} credit`)
  else if (s.balanceUsd != null) parts.push(fmtUsd(s.balanceUsd))
  if (s.spentMonthUsd != null) parts.push(`${fmtUsd(s.spentMonthUsd)}/mo`)
  if (parts.length === 0) {
    if (s.error) return `(${s.error})`
    return "—"
  }
  return parts.join(" · ")
}

function fmtRateLimit(s: QuotaSnapshot): string {
  const parts: string[] = []
  const tokens = fmtPair(s.remainingTokens, s.tokensPerWindow, "")
  if (tokens !== "—") parts.push(`${tokens} TPM`)
  const reqs = fmtPair(s.remainingRequests, s.requestsPerWindow, "")
  if (reqs !== "—") parts.push(`${reqs} RPM`)
  if (parts.length === 0) return "—"
  return parts.join(", ")
}

function fmtFetchedAt(iso: string | undefined): string {
  if (!iso) return "never"
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toISOString().replace("T", " ").slice(0, 16)
  } catch {
    return iso
  }
}

/** Render snapshots as a fixed-width table. */
export function renderQuotaTable(snapshots: QuotaSnapshot[]): string {
  if (snapshots.length === 0) {
    return "No providers configured. Set at least one of: OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, XAI_API_KEY, PERPLEXITY_API_KEY.\n"
  }
  const rows = snapshots.map((s) => ({
    provider: providerDisplayName(s.provider),
    balance: fmtBalance(s),
    rate: fmtRateLimit(s),
    last: s.source === "api" ? "(live)" : fmtFetchedAt(s.fetchedAt),
  }))
  const header = { provider: "Provider", balance: "Balance / Used", rate: "Rate Limit", last: "Last Used" }
  const all = [header, ...rows]
  const w = {
    provider: Math.max(...all.map((r) => r.provider.length)),
    balance: Math.max(...all.map((r) => r.balance.length)),
    rate: Math.max(...all.map((r) => r.rate.length)),
    last: Math.max(...all.map((r) => r.last.length)),
  }
  const sep = `${"-".repeat(w.provider)}  ${"-".repeat(w.balance)}  ${"-".repeat(w.rate)}  ${"-".repeat(w.last)}\n`
  const fmt = (r: typeof header) =>
    `${r.provider.padEnd(w.provider)}  ${r.balance.padEnd(w.balance)}  ${r.rate.padEnd(w.rate)}  ${r.last.padEnd(w.last)}\n`
  return fmt(header) + sep + rows.map(fmt).join("")
}

function providerDisplayName(p: Provider): string {
  switch (p) {
    case "openai":
      return "OpenAI"
    case "openrouter":
      return "OpenRouter"
    case "anthropic":
      return "Anthropic"
    case "google":
      return "Google Gemini"
    case "xai":
      return "xAI (Grok)"
    case "perplexity":
      return "Perplexity"
    case "ollama":
      return "Ollama"
    default:
      return p
  }
}

/**
 * Build a structured envelope for the JSON-mode `bun llm quota --json` output.
 * Stable schema for skill consumers — list of snapshots + a tally of providers
 * with no quota API at all.
 */
export function buildQuotaEnvelope(snapshots: QuotaSnapshot[]): Record<string, unknown> {
  return {
    status: "ok",
    snapshots: snapshots.map((s) => ({ ...s })),
  }
}

/**
 * Build the per-call quota envelope fragment (the value of the `quota` key
 * on a single-call JSON envelope when `--quota` is set). Returns `undefined`
 * if the snapshot has no rate-limit data.
 */
export function buildPerCallQuota(snapshot: QuotaSnapshot | undefined): Record<string, unknown> | undefined {
  if (!snapshot) return undefined
  const out: Record<string, unknown> = {}
  if (snapshot.remainingRequests != null) out.remainingRequests = snapshot.remainingRequests
  if (snapshot.requestsPerWindow != null) out.requestsPerWindow = snapshot.requestsPerWindow
  if (snapshot.remainingTokens != null) out.remainingTokens = snapshot.remainingTokens
  if (snapshot.tokensPerWindow != null) out.tokensPerWindow = snapshot.tokensPerWindow
  if (snapshot.resetRequestsAt) out.resetRequestsAt = snapshot.resetRequestsAt
  if (snapshot.resetTokensAt) out.resetTokensAt = snapshot.resetTokensAt
  if (Object.keys(out).length === 0) return undefined
  return out
}
