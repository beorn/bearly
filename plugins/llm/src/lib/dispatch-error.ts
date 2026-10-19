import type { ProviderObservation, PersistedProviderRefusalKind } from "./provider-availability"
import { getProviderEnvVar, type Model, type Provider } from "./types"

const RETIRED_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
  "grok-4": "grok-4-1-fast-reasoning",
})

export type DispatchFailureKind =
  | PersistedProviderRefusalKind
  | "model-unavailable"
  | "timeout"
  | "output-budget"
  | "context-length"
  | "unknown"

export const MIN_USEFUL_OUTPUT_TOKENS = 2048

export interface DispatchFailureDescription {
  kind: DispatchFailureKind
  scope: "provider" | "model" | "call"
  message: string
  /** HTTP status the provider returned, when the failure carried one (27038).
   *  The message names it too; a caller that branches should not parse prose. */
  httpStatus?: number
  /** The provider's own error code, verbatim and bounded (27038). Absent when
   *  the provider supplied none — never guessed. */
  providerCode?: string
  remedy?: string
  requestedOutputTokens?: number
  affordableOutputTokens?: number
  retryOutputTokens?: number
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
  // The request echo is NEVER evidence about the provider's cause (27977). `APICallError` carries
  // `requestBodyValues` — the whole prompt — as an own enumerable property, so `JSON.stringify(error)`
  // reproduces the user's text verbatim. Matching a provider pattern against it means a prompt that
  // merely mentions "auth failed", "unauthorized" or "permission" turns any failure of that call into an
  // auth refusal (measured 2026-10-07), and a panel whose own reported text quotes such a phrase poisons
  // every later leg that receives it as context. The response side — the error's message, its body and
  // its data — is the only thing that can name what the provider refused.
  const echo =
    error && typeof error === "object"
      ? stringify({ ...(error as Record<string, unknown>), requestBodyValues: undefined, requestBody: undefined })
      : stringify(error)
  const parts = [rawErrorMessage(error), echo]
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

// 29473: a subscription CLI route fails with no HTTP status, in a sentence bearly writes itself
// (subscription-cli.ts): "<cli> CLI (<subscription>) failed for <model> (<aborted | exit N[, status S]>): <detail>".
// Name the route and its outcome; only "aborted", a numeric exit or a signal is rendered. The CLI's own status S is
// its unvalidated output, so it is reduced to "a non-success status", and the detail after the colon stays out, like
// any other raw payload. Before this, recall's planner said only "dispatch failed … matched none" while agy was being
// aborted by its 8 s budget.
function subscriptionCliFailure(
  message: string,
  target: DispatchFailureTarget,
): DispatchFailureDescription | undefined {
  const cli = /^(agy|codex) CLI \(.+?\) failed for (.+?) \((aborted|exit (?:\d+|signal))(, status [^)]*)?\)/u.exec(
    message,
  )
  if (!cli) return undefined
  const [, bin, model, ending, status] = cli
  const aborted = ending === "aborted"
  const outcome = aborted
    ? "aborted: the caller's time budget or signal stopped it"
    : `${ending}${status ? ", a non-success status" : ""}`
  return {
    kind: "unknown",
    scope: "call",
    message: `${providerDisplayName(target.provider)} dispatch through the ${bin} CLI one-shot failed for ${model} (${outcome}).`,
    remedy: aborted ? "give the call more time, or use a faster route" : `run the ${bin} CLI by hand to see its error`,
  }
}

/** An error code names a class and carries no payload: uppercase letters, digits and underscores only. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,40}$/u

/**
 * 29483: the class of a failure that arrived with no HTTP status, read from the error's own name or code, on the
 * error or on its cause (a fetch wrapper keeps the socket's code there), never from its message text. Undefined when
 * neither names one, so the failure stays unmatched. It describes the call: no provider refusal is recorded, so one
 * reset never marks a provider refusing.
 */
function noStatusFailureClass(error: unknown): { said: string; remedy: string } | undefined {
  const cause = error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined
  for (const layer of [error, cause]) {
    if (!layer || typeof layer !== "object") continue
    const { name, code } = layer as { name?: unknown; code?: unknown }
    if (name === "AbortError") {
      return {
        said: "aborted by its caller (its time budget or signal)",
        remedy: "give the call more time, or use a faster route",
      }
    }
    if (typeof code === "string" && ERROR_CODE.test(code)) {
      return { said: `error code ${code}`, remedy: "retry; if it repeats, check the provider endpoint and network" }
    }
  }
  return undefined
}

/**
 * 29534: how long a 429 from an upstream provider's shared pool holds its refusal when the response names no
 * Retry-After. OpenRouter marks it with metadata.limit_source "upstream_provider_shared_pool". Measured 2026-10-15
 * (@cto 80f17a10): StreamLake refused deepseek-chat on 7 of 30 calls 20 s apart, every refusal at :10 past a minute,
 * and 7 of 7 cleared within 20 s (/hh/var/@dev12/29534/probe-run1.jsonl). The default rate-limited record refuses the
 * whole provider, for every process on the host, for 10 minutes; an account-level 429 still does.
 */
export const UPSTREAM_SHARED_POOL_RETRY_MS = 30_000
const UPSTREAM_SHARED_POOL = /"limit_source"\s*:\s*"upstream_provider_shared_pool"/u

/** Pure owner of provider/model/call failure classification and rendering. */
function classifyDispatchFailure(
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
  // A 402 from a credit-metered route is a BUDGET refusal, not a credentials
  // one. OpenRouter prices `max_tokens` as a RESERVATION, so an over-large
  // output budget is refused once `requested × outputPrice` exceeds the
  // balance. Until 2026-09-11 that fell through to the auth branch below and
  // printed "check <PROVIDER>_API_KEY" for a key that was working in the same
  // run — and two mainstays were retired as "dead models" on that message
  // (DeepSeek R1 2026-08-19, Kimi K3 2026-09-11, the latter provably alive).
  //
  // Scope is "call", deliberately: the same credential and route serve every
  // other model in the same dispatch, so this must never mark the PROVIDER
  // refusing. It is a property of this request's parameters. Bead 22972.
  if (
    responseStatus === 402 ||
    /requires more credits|can only afford|fewer max_tokens|account-balance limit/iu.test(blob)
  ) {
    const requestedText = /(?:requested up to|asked for) (\d+)(?: output)? tokens/iu.exec(blob)?.[1]
    const affordableText = /(?:can only afford|balance covers) (\d+)/iu.exec(blob)?.[1]
    const requested = requestedText === undefined ? undefined : Number(requestedText)
    const affordable = affordableText === undefined ? undefined : Number(affordableText)
    const amounts = [
      requested === undefined ? "" : ` It asked for ${requested} output tokens.`,
      affordable === undefined ? "" : ` The balance covers ${affordable}.`,
    ].join("")
    const who = target.modelId
      ? `${providerDisplayName(target.provider)} (${target.modelId})`
      : providerDisplayName(target.provider)
    const retryOutputTokens =
      affordable !== undefined && affordable >= MIN_USEFUL_OUTPUT_TOKENS ? affordable : undefined
    const remedy =
      retryOutputTokens !== undefined
        ? `Retry only this call with --max-output-tokens ${retryOutputTokens} (library: maxOutputTokens: ${retryOutputTokens}).`
        : affordable !== undefined
          ? `The affordable output count is below the useful floor of ${MIN_USEFUL_OUTPUT_TOKENS} tokens; no useful smaller retry is available.`
          : `An affordable output count was not supplied; no exact smaller retry can be calculated.`
    return {
      kind: "output-budget",
      scope: "call",
      requestedOutputTokens: requested,
      affordableOutputTokens: affordable,
      retryOutputTokens,
      message: `${who} refused this call's output reservation (402) because of the account-balance limit — NOT a credentials problem.${amounts} ${remedy}`,
      remedy,
    }
  }
  // A context-length refusal is a property of THIS request, and providers deliver it in three shapes.
  // The documented one is 400/413 with a "context length" body. The one that cost 27727 its leg is an
  // HTTP 200 envelope whose body reports the failure itself (`status: "failed"`, `error.code:
  // "invalid_prompt"`, "The sum of prompt length (34094.0) … should not exceed max_num_tokens (32768)"
  // — OpenRouter in front of DeepInfra, measured 2026-10-07 in pro run 0581). A status gate of
  // 400/413 alone missed it, the wording matched none of the old patterns, and the request-echo blob
  // handed the leg to the auth branch below. The third shape is our own pre-dispatch estimate.
  const contextBody =
    /context.{0,30}(?:length|window)|maximum.{0,30}context|prompt.{0,30}too long/iu.test(blob) ||
    /invalid_prompt/iu.test(blob) ||
    /(?:prompt|input|query).{0,60}(?:should|must|may|can)\s+not\s+exceed/iu.test(blob) ||
    /max(?:imum)?[_ ]?(?:num_)?tokens/iu.test(blob)
  if (/^Estimated input \d+ tokens exceeds /u.test(message) || (responseStatus !== undefined && contextBody)) {
    const who = target.modelId
      ? `${providerDisplayName(target.provider)} (${target.modelId})`
      : providerDisplayName(target.provider)
    const promptTokens = /prompt length \((\d+(?:\.\d+)?)\)/iu.exec(blob)?.[1]
    const limit =
      /max(?:imum)?[_ ]?(?:num_)?tokens\D{0,12}?\((\d+)\)/iu.exec(blob)?.[1] ??
      /maximum context length is (\d+)/iu.exec(blob)?.[1]
    const amounts =
      promptTokens !== undefined && limit !== undefined
        ? ` The prompt is ${Math.floor(Number(promptTokens))} tokens; this route's limit is ${limit}.`
        : ""
    return {
      kind: "context-length",
      scope: "call",
      message: /^Estimated input /u.test(message)
        ? message
        : `${who} rejected this request's CONTEXT LENGTH — this is NOT a credentials problem.${amounts} Trim the context or pick a model whose context window fits.`,
      remedy: "trim the context or pick a model whose context window fits",
    }
  }
  // Only the timer-owned partial-results message above proves our budget
  // elapsed. A fast provider failure can itself say "timed out".
  if (/insufficient[_ -]?(?:quota|credits)|billing hard limit|exceeded (?:your )?(?:current )?quota/iu.test(blob)) {
    const rendered = target.modelId
      ? `${providerDisplayName(target.provider)} insufficient quota; top up ${envVar} billing before retrying.`
      : `${target.provider} quota exhausted (insufficient_quota) — check plan & billing for ${envVar}. Retry with another provider: ${alt}.`
    return refusing("quota", target, rendered, `check plan and billing for ${envVar}`)
  }
  if (/\b(?:not set|loaded no env file|did not reach this process)\b/iu.test(blob)) {
    const rendered = oneLineError(error)
    return refusing("auth", target, rendered, `load ${envVar}`)
  }
  const rateLimited = (): DispatchFailureDescription =>
    refusing(
      "rate-limited",
      target,
      `${target.provider} rate-limited (429) — wait and retry, or use another provider: ${alt}.`,
      "wait and retry, or use another provider",
      retryAtFromError(error, now) ??
        (UPSTREAM_SHARED_POOL.test(blob) ? now + UPSTREAM_SHARED_POOL_RETRY_MS : undefined),
    )
  // 29057: an EXPLICIT 429 outranks every wording-based auth match, and nothing else moves. A
  // shared-pool 429 is a fact the provider asserted about its own rate limit, while the auth
  // wording is a guess about a key THIS call never questioned — @dev/6's /pro run on 2026-10-13
  // 10:22 PDT reported two live models (deepseek/deepseek-chat, moonshotai/kimi-k2.7-code, both
  // `limit_source: upstream_provider_shared_pool`) as "auth failed — check OPENROUTER_API_KEY" for
  // an HTTP 429. Deliberately narrow: an explicit 401/403 and the Google 400 API_KEY_INVALID body
  // stay auth below, even when such a body also mentions a rate limit, and the wording-only
  // fallback keeps its old position AFTER the auth branch (a statusless error whose text names both
  // still reads as auth, exactly as before).
  if (responseStatus === 429) {
    return rateLimited()
  }
  // Google answers a bad key with HTTP 400 and "API key not valid. Please pass a valid API key."
  // plus `reason: "API_KEY_INVALID"` — a 400, not a 401, so the status gate missed it and the
  // wording matched none of the older patterns. It fell through to the terminal branch and printed
  // the generic bucket for ten days of dead OpenAI/Google calls (28886).
  if (
    /invalid[_ ]?api[_ ]?key|api[_ ]?key[_ ]?(?:not[_ ]?valid|invalid)|API_KEY_INVALID|unauthorized|permission|auth failed|organization not verified/iu.test(
      blob,
    ) ||
    responseStatus === 401 ||
    responseStatus === 403
  ) {
    return refusing("auth", target, `${target.provider} auth failed — check ${envVar}.`, `check ${envVar}`)
  }
  // The wording-only fallback, in its old position: a body that merely names a rate limit is still
  // weaker evidence than a credentials wording above, and stronger than the terminal bucket below.
  if (/rate[ _-]?limit|too many requests|\b429\s+too many requests\b/iu.test(blob)) {
    return rateLimited()
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
  const cli = subscriptionCliFailure(message, target)
  if (cli) return cli
  // Unowned timeout wording gives retry advice, without certifying elapsed
  // budget or credential health. Concrete evidence above keeps precedence.
  if (/timed? out|timeout/iu.test(blob)) {
    const who = target.modelId
      ? `${providerDisplayName(target.provider)} (${target.modelId})`
      : providerDisplayName(target.provider)
    return {
      kind: "unknown",
      scope: "call",
      message: `${who} reported a timeout; retry with more time, or use a faster model.`,
      remedy: "retry with more time, or use a faster model",
    }
  }
  const targetDescription = target.modelId ? ` for model ${target.modelId}` : ""
  // 28886: this branch used to answer "unclassified provider error" and nothing else. That named no
  // class, carried no status, and quoted none of the provider's own words, so an invalid Google key,
  // an exhausted OpenAI balance and a bare 400 all read as the same dead end. State what was checked
  // and what evidence exists; `describeDispatchFailure` appends the HTTP status and response body
  // whenever the provider supplied one, which is where the provider's own message appears.
  const noStatus = responseStatus === undefined ? noStatusFailureClass(error) : undefined
  if (noStatus) {
    return {
      kind: "unknown",
      scope: "call",
      message: `${providerDisplayName(target.provider)} dispatch failed${targetDescription} with no HTTP status: ${noStatus.said}.`,
      remedy: noStatus.remedy,
    }
  }
  const statusNote = responseStatus === undefined ? "with no HTTP status" : `with HTTP ${responseStatus}`
  return {
    kind: "unknown",
    scope: "call",
    message: `${providerDisplayName(target.provider)} dispatch failed${targetDescription} ${statusNote}; its error matched none of the known failure classes (auth, quota, model, transport).`,
    remedy: "run `llm quota` for the provider's latest balance/rate-limit snapshot, or retry with another provider",
  }
}

/** One redaction pass, so every surface that shows provider text shows the
 *  same, already-redacted value — the message, the envelope field and the
 *  cached response record all read from here (27038). */
function redactSecrets(text: string): string {
  return text
    .replace(/("(?:api[_-]?key|access[_-]?token|token|authorization|password|secret)"\s*:\s*")[^"]*/giu, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s"',}]+/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[a-zA-Z0-9_-]+/gu, "[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|access[_-]?token)=)[^&\s]+/giu, "$1[REDACTED]")
}

/**
 * The provider's own error code, when it supplied one — the field a caller
 * branches on ("provider_internal", "rate_limit_exceeded", …). Read from the
 * error object first (Node/SDK errors carry `code`), then from the response
 * body's `error.code` / `code`. Only a STRING is a provider code: OpenRouter
 * sends a numeric `error.code` equal to the HTTP status, which the status
 * field already carries, so it is never restated as a code. Never guessed:
 * absent stays undefined, and the value is redacted here so no caller has to
 * remember to (27038).
 */
function providerCodeFrom(source: unknown, body: string): string | undefined {
  const fromObject = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") return undefined
    const item = value as { code?: unknown; error?: { code?: unknown } }
    for (const candidate of [item.error?.code, item.code]) {
      if (typeof candidate === "string" && candidate.trim().length > 0 && candidate.length <= 80) {
        return redactSecrets(candidate.trim())
      }
    }
    return undefined
  }
  const direct = fromObject(source)
  if (direct !== undefined) return direct
  try {
    return fromObject(JSON.parse(body) as unknown)
  } catch {
    // silent-fallback-allow: the body is not JSON, so the provider named no error code; the
    // full bounded body is already on the message, and the absence is reported as "no code"
    return undefined
  }
}

export type DispatchFailureModelTarget = Pick<Model, "displayName" | "modelId" | "provider">

/** Render retained HTTP evidence through the existing query/Pro error string. */
export function describeDispatchFailure(
  error: unknown,
  target: DispatchFailureTarget,
  now = Date.now(),
): DispatchFailureDescription {
  let source = error
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 8 && source && typeof source === "object"; depth++) {
    if (seen.has(source) || responseStatusFromError(source) !== undefined) break
    seen.add(source)
    const nested = source as { cause?: unknown; lastError?: unknown; error?: unknown }
    const next = nested.cause ?? nested.lastError ?? nested.error
    if (!next || typeof next !== "object") break
    source = next
  }
  const described = classifyDispatchFailure(source, target, now)
  const status = responseStatusFromError(source)
  if (status === undefined) return described
  const item = source as { responseBody?: unknown; data?: unknown }
  const body =
    item.responseBody !== undefined
      ? stringify(item.responseBody)
      : item.data !== undefined
        ? stringify(item.data)
        : rawErrorMessage(source)
  // Redact before bounding so a partial credential cannot escape truncation.
  const bounded = (text: string): string => {
    const safe = redactSecrets(text).replace(/\s+/gu, " ")
    return safe.length > 1_000 ? safe.slice(0, 1_000) + " [truncated]" : safe
  }
  const providerCode = providerCodeFrom(source, body)
  // providerCodeFrom already redacted and bounded the value; restating the raw
  // string here was the one surface that could still leak it (27038).
  const codeNote = providerCode === undefined ? "" : `; provider code ${providerCode}`
  const message = `${bounded(described.message)} | HTTP ${status}${codeNote}; body: ${bounded(body)}`
  // 29495 (@cto e60d240d): a 429's refusal record keeps the head of the upstream body beside bearly's own text. The
  // record outlives the call and refuses every model of the provider for its window, so it must show whose limit
  // refused (OpenRouter names it in `limit_source` and `provider_name`). Measurement only: the key stays the provider.
  const facts = {
    httpStatus: status,
    ...(providerCode === undefined ? {} : { providerCode }),
  }
  if (described.observation?.status !== "refusing" || described.observation.kind !== "rate-limited") {
    return { ...described, message, ...facts }
  }
  const head = redactSecrets(body).replace(/\s+/gu, " ").slice(0, 512)
  const reason = `${described.observation.reason} | HTTP ${status}; upstream body: ${head}`
  return { ...described, message, ...facts, observation: { ...described.observation, reason } }
}
