/**
 * `bun llm quota` — provider quota / balance / rate-limit snapshot.
 *
 * Hits each provider's quota endpoint where one exists (OpenRouter, OpenAI
 * org-usage), falls back to cached `x-ratelimit-*` headers from a recent call
 * for providers without a balance API (Anthropic), and prints a one-line
 * "no quota API" row for the rest (Google, xAI, Perplexity).
 *
 * `--json` flag emits a structured envelope; default mode prints a fixed-
 * width table to stderr (so the JSON envelope is always the only thing on
 * stdout — matches the rest of the CLI contract).
 */

import { emitJson, isJsonMode } from "../lib/output-mode"

export async function runQuota(): Promise<void> {
  const { getAllQuotas, renderQuotaTable, buildQuotaEnvelope } = await import("../lib/quota")
  const snapshots = await getAllQuotas()
  const envelope = buildQuotaEnvelope(snapshots)
  if (isJsonMode()) {
    emitJson(envelope)
    return
  }
  // Legacy mode: human table on stderr, envelope on stdout (consistent with
  // the rest of the CLI — JSON is always available; stderr is human-readable).
  process.stderr.write(renderQuotaTable(snapshots))
  emitJson(envelope)
}
