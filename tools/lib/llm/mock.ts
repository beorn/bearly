/**
 * mock.ts — Test-only LLM mock helpers.
 *
 * Purpose: unit-test code paths that call queryModel() / isProviderAvailable()
 * without burning API credits or requiring network access.
 *
 * Usage (in a test file):
 *
 *   import { vi } from "vitest"
 *   import { buildMockQueryModel, alwaysAvailable } from "../../tools/lib/llm/mock"
 *
 *   vi.mock("../../tools/lib/llm/research", () => ({
 *     queryModel: buildMockQueryModel([
 *       { match: /planner/i, content: JSON.stringify({ keywords: ["foo"] }) },
 *       { content: "synthesized answer" },  // default for other calls
 *     ]),
 *   }))
 *   vi.mock("../../tools/lib/llm/providers", async (importOriginal) => ({
 *     ...(await importOriginal<typeof import("../../tools/lib/llm/providers")>()),
 *     isProviderAvailable: alwaysAvailable,
 *   }))
 *
 * NOT imported from source code — tests only. Keep it dependency-light.
 */

import type { Model, ModelResponse } from "./types.ts"

// ============================================================================
// Scenario-based mock for queryModel
// ============================================================================

export interface MockScenario {
  /** If set, this scenario matches when the system prompt OR question contains it. */
  match?: string | RegExp
  /** The content the mock response returns. */
  content: string
  /** Optional simulated duration (ms); default 10ms. */
  durationMs?: number
  /** Optional simulated error — when set, content is ignored. */
  error?: string
  /** Optional usage tokens for cost-estimation tests. */
  usage?: { promptTokens: number; completionTokens: number }
}

export interface MockCall {
  question: string
  systemPrompt?: string
  modelId: string
  aborted: boolean
}

/**
 * Build a stub `queryModel` that matches the caller's question/systemPrompt
 * against the scenarios in order and returns the first match's content.
 * A scenario without `match` is treated as a default (fallback).
 *
 * Also exposes `.calls` on the returned function so tests can assert call
 * counts, inspect system prompts, etc.
 */
export function buildMockQueryModel(scenarios: MockScenario[]) {
  const calls: MockCall[] = []

  const mock = async (opts: {
    question: string
    model: Model
    systemPrompt?: string
    abortSignal?: AbortSignal
  }): Promise<{ response: ModelResponse }> => {
    calls.push({
      question: opts.question,
      systemPrompt: opts.systemPrompt,
      modelId: opts.model.modelId,
      aborted: opts.abortSignal?.aborted ?? false,
    })

    // If aborted already, short-circuit to a timeout-like response
    if (opts.abortSignal?.aborted) {
      return {
        response: {
          model: opts.model,
          content: "",
          durationMs: 0,
          error: "aborted",
        },
      }
    }

    // Find the first matching scenario
    const haystack = `${opts.systemPrompt ?? ""}\n${opts.question}`
    const scenario =
      scenarios.find((s) => s.match && matches(s.match, haystack)) ?? scenarios.find((s) => !s.match) ?? null

    if (!scenario) {
      return {
        response: {
          model: opts.model,
          content: "",
          durationMs: 1,
          error: "no mock scenario matched (add a default scenario to buildMockQueryModel)",
        },
      }
    }

    const duration = scenario.durationMs ?? 10
    // Simulate a tiny async gap so race logic / timeouts behave realistically
    await new Promise((r) => setTimeout(r, duration))

    if (scenario.error) {
      return {
        response: {
          model: opts.model,
          content: "",
          durationMs: duration,
          error: scenario.error,
        },
      }
    }

    return {
      response: {
        model: opts.model,
        content: scenario.content,
        durationMs: duration,
        usage: scenario.usage ?? { promptTokens: 100, completionTokens: 50 },
      },
    }
  }

  ;(mock as unknown as { calls: MockCall[] }).calls = calls
  return mock
}

/**
 * Helper: the mock above treats `match` as a regex OR a substring match.
 */
function matches(pattern: string | RegExp, text: string): boolean {
  if (typeof pattern === "string") return text.includes(pattern)
  return pattern.test(text)
}

// ============================================================================
// Provider availability stubs
// ============================================================================

/** Replace `isProviderAvailable` with this to make every provider available. */
export function alwaysAvailable(): boolean {
  return true
}

/** Replace `isProviderAvailable` with this to make every provider unavailable. */
export function neverAvailable(): boolean {
  return false
}

/** Make only named providers available. */
export function onlyAvailable(providers: string[]): (p: string) => boolean {
  const set = new Set(providers)
  return (p: string) => set.has(p)
}

// ============================================================================
// Plan scenario helpers (common patterns)
// ============================================================================

/**
 * Build a canned planner JSON response matching the QueryPlan shape.
 * Accepts partial input; fills in empty arrays / nulls for the rest.
 */
export function buildPlanJson(
  partial: Partial<{
    keywords: string[]
    phrases: string[]
    concepts: string[]
    paths: string[]
    errors: string[]
    bead_ids: string[]
    time_hint: string | null
    notes: string
  }>,
): string {
  return JSON.stringify({
    keywords: partial.keywords ?? [],
    phrases: partial.phrases ?? [],
    concepts: partial.concepts ?? [],
    paths: partial.paths ?? [],
    errors: partial.errors ?? [],
    bead_ids: partial.bead_ids ?? [],
    time_hint: partial.time_hint ?? null,
    notes: partial.notes ?? undefined,
  })
}
