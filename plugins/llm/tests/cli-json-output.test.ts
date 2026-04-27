/**
 * Regression: --json flag produces the canonical envelope on stdout.
 *
 * Bead km-bearly.llm-cli-json-output. Skill consumers (pro / deep / ask)
 * used to regex stderr for the output path, which broke whenever the
 * format drifted. The contract is now:
 *
 *   --json mode:
 *     stdout = exactly ONE JSON line (the envelope)
 *     stderr = all human progress text
 *
 *   default mode:
 *     stdout = the same JSON envelope (legacy behavior; back-compat)
 *     stderr = "Output written to: ..." + progress
 *
 * Schema:
 *   { file, model, tokens: {prompt, completion, total}, cost,
 *     durationMs, responseId?, status, chars, query? }
 *
 * For dual-pro, additionally: { a: {...}, b: {...} }
 */

import { describe, it, expect, vi } from "vitest"
import { makeTestEnv } from "./helpers"
import { buildResultJson } from "../src/lib/format"
import { resetOutputMode, setJsonMode, isJsonMode } from "../src/lib/output-mode"

// Mock `ai` so dispatch never hits the network; route both pro legs through
// the cheap inline mocks (mirrors cli-single-fire.test.ts setup).
const generateTextMock = vi.fn()
const streamTextMock = vi.fn()
vi.mock("ai", () => ({ generateText: generateTextMock, streamText: streamTextMock }))

const queryBackgroundMock = vi.fn()
vi.mock("../src/lib/openai-deep", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/openai-deep")>("../src/lib/openai-deep")
  return { ...actual, queryOpenAIBackground: queryBackgroundMock }
})

function resetMocks() {
  generateTextMock.mockReset()
  generateTextMock.mockResolvedValue({
    text: "ok",
    reasoning: [],
    usage: { inputTokens: 10, outputTokens: 5 },
  })
  streamTextMock.mockReset()
  streamTextMock.mockImplementation(() => ({
    textStream: (async function* () {
      yield "ok"
    })(),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
  }))
  queryBackgroundMock.mockReset()
  queryBackgroundMock.mockImplementation(async ({ model }: { model: { displayName: string } }) => ({
    model,
    content: "ok",
    responseId: `resp_${Math.random().toString(36).slice(2, 10)}`,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    durationMs: 100,
  }))
}

describe("buildResultJson — envelope schema", () => {
  it("produces tokens as {prompt, completion, total} from structured input", () => {
    const env = buildResultJson("response body", {
      query: "test",
      model: "GPT-5.4",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: "$0.05",
      costUsd: 0.05,
      durationMs: 1234,
      responseId: "resp_abc",
      status: "completed",
    })

    expect(env.tokens).toEqual({ prompt: 100, completion: 50, total: 150 })
    expect(env.cost).toBe(0.05) // numeric, not string (costUsd preferred)
    expect(env.responseId).toBe("resp_abc")
    expect(env.status).toBe("completed")
    expect(env.durationMs).toBe(1234)
    expect(env.chars).toBe("response body".length)
    expect(env.query).toBe("test")
    expect(env.model).toBe("GPT-5.4")
  })

  it("falls back to total-only when given legacy number tokens", () => {
    const env = buildResultJson("body", { tokens: 42 })
    expect(env.tokens).toEqual({ total: 42 })
  })

  it("computes total from prompt+completion when total omitted", () => {
    const env = buildResultJson("body", { tokens: { prompt: 7, completion: 3 } })
    expect(env.tokens).toEqual({ prompt: 7, completion: 3, total: 10 })
  })

  it("emits a/b leg sections for dual-pro", () => {
    const env = buildResultJson("combined", {
      model: "dual-pro",
      a: {
        model: "GPT-5.4 Pro",
        tokens: { prompt: 100, completion: 50, total: 150 },
        cost: 0.05,
        durationMs: 1000,
        status: "completed",
      },
      b: {
        model: "Kimi K2.6",
        tokens: { prompt: 100, completion: 50, total: 150 },
        cost: 0.0001,
        durationMs: 800,
        status: "completed",
      },
    })

    const a = env.a as Record<string, unknown>
    const b = env.b as Record<string, unknown>
    expect(a.model).toBe("GPT-5.4 Pro")
    expect((a.tokens as { total: number }).total).toBe(150)
    expect(a.status).toBe("completed")
    expect(b.model).toBe("Kimi K2.6")
    expect(b.cost).toBe(0.0001)
  })

  it("omits status when caller didn't set one (callers add their own default)", () => {
    const env = buildResultJson("body", {})
    expect(env.status).toBeUndefined()
  })

  it("uses cost string when costUsd is absent (back-compat)", () => {
    const env = buildResultJson("body", { cost: "$0.05" })
    expect(env.cost).toBe("$0.05")
  })
})

describe("output-mode singleton", () => {
  it("setJsonMode flips isJsonMode", () => {
    resetOutputMode()
    expect(isJsonMode()).toBe(false)
    setJsonMode(true)
    expect(isJsonMode()).toBe(true)
    resetOutputMode()
    expect(isJsonMode()).toBe(false)
  })
})

describe("--json mode end-to-end", () => {
  it("ask path: stdout has exactly one JSON line; envelope has the canonical schema", async () => {
    const env = makeTestEnv()
    resetMocks()

    vi.resetModules()
    process.argv = ["node", "cli.ts", "--json", "ping"]
    const mod = await import("../src/cli")
    await mod.main()

    // Exactly one JSON line on stdout — this is the contract.
    const jsonLines = env.stdout.filter((l) => l.trim().startsWith("{"))
    expect(jsonLines).toHaveLength(1)

    const envelope = JSON.parse(jsonLines[0]!) as Record<string, unknown>
    // Required fields per the bead schema.
    expect(envelope.file).toMatch(/^\/tmp\/llm-.*\.txt$/)
    expect(envelope.model).toBeTruthy()
    expect(envelope.tokens).toEqual({ prompt: 10, completion: 5, total: 15 })
    expect(envelope.status).toBe("completed")
    // durationMs is omitted when 0 (mocked stream completes instantly); just
    // verify the field is absent or numeric — never a string or object.
    if (envelope.durationMs !== undefined) expect(typeof envelope.durationMs).toBe("number")
    expect(envelope.chars).toBe("ok".length)

    // The "Output written to: ..." path line is suppressed in JSON mode (stderr
    // is for progress only — file path lives in envelope.file).
    const pathLines = env.stderr.filter((l) => l.includes("Output written to:"))
    expect(pathLines).toHaveLength(0)
  }, 10_000)

  it("legacy mode (no --json): stdout still has one JSON line + stderr has the path", async () => {
    const env = makeTestEnv()
    resetMocks()

    vi.resetModules()
    process.argv = ["node", "cli.ts", "ping"]
    const mod = await import("../src/cli")
    await mod.main()

    // Back-compat: scripts that scrape JSON from stdout keep working in
    // legacy mode (no --json). The envelope is identical.
    const jsonLines = env.stdout.filter((l) => l.trim().startsWith("{"))
    expect(jsonLines).toHaveLength(1)
    const envelope = JSON.parse(jsonLines[0]!) as Record<string, unknown>
    expect(envelope.status).toBe("completed")

    // In legacy mode, the human-readable "Output written to: ..." line goes
    // to stderr (long-standing UX). Skill consumers that grep stderr keep
    // working until they migrate to --json.
    const pathLines = env.stderr.filter((l) => l.includes("Output written to:"))
    expect(pathLines.length).toBeGreaterThanOrEqual(1)
  }, 10_000)

  it("pro (dual): envelope has a/b sections with per-leg tokens/cost/status", async () => {
    const env = makeTestEnv()
    resetMocks()

    vi.resetModules()
    // -y skips the cost-confirmation prompt
    process.argv = ["node", "cli.ts", "--json", "pro", "-y", "test"]
    const mod = await import("../src/cli")
    await mod.main()

    const jsonLines = env.stdout.filter((l) => l.trim().startsWith("{"))
    expect(jsonLines).toHaveLength(1)

    const envelope = JSON.parse(jsonLines[0]!) as Record<string, unknown>
    expect(envelope.a).toBeTruthy()
    expect(envelope.b).toBeTruthy()
    const a = envelope.a as Record<string, unknown>
    const b = envelope.b as Record<string, unknown>
    // Each leg ships its own tokens/status — skill consumers can rank A vs B
    // without parsing the combined report content.
    expect(a.tokens).toBeTruthy()
    expect(a.status).toBe("completed")
    expect(b.tokens).toBeTruthy()
    expect(b.status).toBe("completed")
    expect(envelope.status).toBe("completed")
  }, 10_000)

  it("invalid argv: error envelope on stdout (status: failed) + human msg on stderr", async () => {
    const env = makeTestEnv()
    resetMocks()

    vi.resetModules()
    process.argv = ["node", "cli.ts", "--json", "--model", "nonexistent-model-xyz", "ping"]
    let caught: Error | undefined
    // error() fires at module-scope during --model resolution, so the throw
    // happens during import (not main()). Wrap both phases.
    try {
      const mod = await import("../src/cli")
      await mod.main()
    } catch (e) {
      caught = e as Error
    }
    // The mocked process.exit throws __exit_1.
    expect(caught?.message).toBe("__exit_1")

    const jsonLines = env.stdout.filter((l) => l.trim().startsWith("{"))
    expect(jsonLines).toHaveLength(1)
    const envelope = JSON.parse(jsonLines[0]!) as Record<string, unknown>
    expect(envelope.status).toBe("failed")
    expect(envelope.error).toMatch(/Unknown model/i)
  }, 10_000)
})
