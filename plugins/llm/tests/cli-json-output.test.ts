/**
 * Regression: --json flag produces the canonical envelope on stdout.
 * @reach fs-walk <fixture-only: enumerates isolated per-test LLM cache files>
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
 *   { file, model, tokens: {prompt, completion, total}, cost_usd?, cost_usd_reason?,
 *     list_equivalent_usd?, list_equivalent_reason?, list_equivalent_basis,
 *     durationMs, responseId?, status, chars, query? }
 *
 * For dual-pro, additionally: { a: {...}, b: {...} }
 */

import { describe, it, expect, vi } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { makeTestEnv } from "./helpers"
import { buildResultJson } from "../src/lib/format"

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

function resetMocks(stopped = false, empty = false) {
  generateTextMock.mockReset()
  generateTextMock.mockResolvedValue({
    text: empty ? "" : "ok",
    finishReason: stopped ? "length" : "stop",
    rawFinishReason: stopped ? "max_output_tokens" : undefined,
    finalStep: { reasoningText: undefined },
    usage: { inputTokens: 10, outputTokens: 5, raw: { cost_usd: 0.125 } },
  })
  streamTextMock.mockReset()
  streamTextMock.mockImplementation(() => ({
    textStream: (async function* () {
      if (!empty) yield "ok"
    })(),
    finalStep: Promise.resolve({ response: undefined }),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, raw: { cost_usd: 0.125 } }),
    finishReason: Promise.resolve(stopped ? "length" : "stop"),
    rawFinishReason: Promise.resolve(stopped ? "max_output_tokens" : undefined),
  }))
  queryBackgroundMock.mockReset()
  queryBackgroundMock.mockImplementation(async ({ model }: { model: { displayName: string } }) => ({
    model,
    content: "ok",
    responseId: `resp_${Math.random().toString(36).slice(2, 10)}`,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    cost_usd: 0.125,
    durationMs: 100,
  }))
}

describe("buildResultJson — envelope schema", () => {
  it("preserves tokens and distinct charged/list-equivalent amounts with their basis", () => {
    const env = buildResultJson("response body", {
      query: "test",
      model: "GPT-5.4",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost_usd: 0.05,
      list_equivalent_usd: 0.000037,
      list_equivalent_basis: [{ rateSource: "litellm", rateDate: "2026-10-19", matchedModelId: "openai/gpt-5.4" }],
      durationMs: 1234,
      responseId: "resp_abc",
      status: "completed",
    })

    expect(env.tokens).toEqual({ prompt: 100, completion: 50, total: 150 })
    // Charged dollars and a different token estimate must survive independently.
    expect(env.cost_usd).toBe(0.05)
    expect(env.list_equivalent_usd).toBe(0.000037)
    expect(env.list_equivalent_basis).toEqual([
      { rateSource: "litellm", rateDate: "2026-10-19", matchedModelId: "openai/gpt-5.4" },
    ])
    expect(env).not.toHaveProperty("cost")
    expect(env).not.toHaveProperty("costUsd")
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
        cost_usd: 0.05,
        list_equivalent_usd: 0.1,
        list_equivalent_basis: [],
        durationMs: 1000,
        status: "completed",
      },
      b: {
        model: "Kimi K2.6",
        tokens: { prompt: 100, completion: 50, total: 150 },
        cost_usd_reason: "provider did not state a charge",
        list_equivalent_usd: 0.0001,
        list_equivalent_basis: [],
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
    expect(a.cost_usd).toBe(0.05)
    expect(a.list_equivalent_usd).toBe(0.1)
    expect(b.cost_usd_reason).toBe("provider did not state a charge")
    expect(b.list_equivalent_usd).toBe(0.0001)
    expect(b).not.toHaveProperty("cost")
  })

  it("omits status when caller didn't set one (callers add their own default)", () => {
    const env = buildResultJson("body", {})
    expect(env.status).toBeUndefined()
  })

  // @failure A missing column becomes zero, or a genuine stated zero is lost.
  // @level l1 @consumer Canonical CLI JSON serialization, not cost arithmetic.
  // Existing precedence coverage merges the two meanings and cannot prove this.
  it.each([
    {
      name: "stated zero with unavailable rates",
      fields: {
        cost_usd: 0,
        list_equivalent_reason: "rates unavailable",
        list_equivalent_basis: [],
      },
    },
    {
      name: "known estimate without a stated charge",
      fields: {
        cost_usd_reason: "provider did not state a charge",
        list_equivalent_usd: 0.000037,
        list_equivalent_basis: [{ rateSource: "sku" as const, matchedModelId: "fixture-model" }],
      },
    },
  ])("preserves independent cost columns: $name", ({ fields }) => {
    const env = buildResultJson("body", fields)
    expect(env).toMatchObject(fields)
    if (!("cost_usd" in fields)) expect(env).not.toHaveProperty("cost_usd")
    if (!("list_equivalent_usd" in fields)) expect(env).not.toHaveProperty("list_equivalent_usd")
    expect(env).not.toHaveProperty("cost")
    expect(env).not.toHaveProperty("costUsd")
  })
})

describe("output-mode singleton", () => {
  it("setJsonMode flips isJsonMode, and a fresh module graph starts false", async () => {
    // A fresh import replaces the deleted resetOutputMode(): the shim's default
    // DispatchContext starts at jsonMode:false and cannot leak between tests.
    vi.resetModules()
    const outputMode = await import("../src/lib/output-mode")
    expect(outputMode.isJsonMode()).toBe(false)
    outputMode.setJsonMode(true)
    expect(outputMode.isJsonMode()).toBe(true)
    vi.resetModules()
    const fresh = await import("../src/lib/output-mode")
    expect(fresh.isJsonMode()).toBe(false)
  })
})

describe("--json mode end-to-end", () => {
  it.each([
    { name: "ask", argv: ["ping"], stopped: false, empty: false },
    {
      name: "explicit single-model pro",
      argv: ["pro", "--model", "moonshotai/kimi-k2.6", "ping"],
      stopped: false,
      empty: false,
    },
    { name: "token-limited ask", argv: ["ping"], stopped: true, empty: false },
    {
      name: "token-limited explicit pro",
      argv: ["pro", "--model", "moonshotai/kimi-k2.6", "ping"],
      stopped: true,
      empty: false,
    },
    // 30170: the error writer bypasses finalizeOutput, so successful-result coverage misses its charge facts.
    { name: "empty billed ask", argv: ["ping"], stopped: false, empty: true },
  ])(
    "$name path: stdout has exactly one JSON line; envelope has the canonical schema",
    async ({ argv, stopped, empty }) => {
      const env = makeTestEnv()
      resetMocks(stopped, empty)

      vi.resetModules()
      process.argv = ["node", "cli.ts", "--json", ...argv]
      const mod = await import("../src/cli")
      if (stopped || empty) await expect(mod.main()).rejects.toThrow("__exit_1")
      else await mod.main()

      // Exactly one JSON line on stdout — this is the contract.
      const jsonLines = env.stdout.filter((l) => l.trim().startsWith("{"))
      expect(jsonLines).toHaveLength(1)

      const envelope = JSON.parse(jsonLines[0]!) as Record<string, unknown>
      // Required fields per the bead schema.
      // Output dir resolves via getOutputDir() — defaults to os.tmpdir() which
      // is /var/folders/.../T on macOS, /tmp on Linux. Just match the trailing
      // llm-…txt naming, not the prefix.
      expect(envelope.file).toMatch(/llm-.*\.txt$/)
      expect(typeof envelope.model).toBe("string")
      expect(envelope.tokens).toEqual({ prompt: 10, completion: 5, total: 15 })
      expect(envelope.status).toBe(empty ? "failed" : stopped ? "incomplete" : "completed")
      expect(env.exitCodes).toEqual(stopped || empty ? [1] : [])
      // Adapter-only tests cannot detect a real command dropping charge facts on finalization.
      expect(envelope.cost_usd).toBe(0.125)
      expect(envelope.list_equivalent_usd).toEqual(expect.any(Number))
      expect(envelope.list_equivalent_usd).toBeGreaterThan(0)
      expect(envelope.list_equivalent_usd).not.toBe(0.125)
      expect(envelope.list_equivalent_basis).toEqual([{ rateSource: "sku", matchedModelId: expect.any(String) }])
      expect(envelope).not.toHaveProperty("cost")
      expect(envelope).not.toHaveProperty("costUsd")
      if (stopped) {
        expect(envelope.rawFinishReason).toBe("max_output_tokens")
        expect(envelope.finishReason).toBe("length")
      }
      // durationMs is omitted when 0 (mocked stream completes instantly); just
      // verify the field is absent or numeric — never a string or object.
      if (envelope.durationMs !== undefined) expect(typeof envelope.durationMs).toBe("number")
      if (!empty) expect(envelope.chars).toBe("ok".length)

      // The "Output written to: ..." path line is suppressed in JSON mode (stderr
      // is for progress only — file path lives in envelope.file).
      const pathLines = env.stderr.filter((l) => l.includes("Output written to:"))
      expect(pathLines).toHaveLength(0)
    },
    10_000,
  )

  it("legacy mode (no --json): stdout still has one JSON line + stderr has the path", async () => {
    const env = makeTestEnv()
    vi.stubEnv("LLM_NO_CACHE", "0")
    vi.stubEnv("XDG_CACHE_HOME", env.tmpDir)
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
    // 30170: replay must not bill an original call again, and read-time rates must not mutate raw facts.
    // Generic cache round trips never pass through the actual command's output/accounting boundary.
    const { getCacheDir } = await import("../src/lib/cache")
    const files = readdirSync(getCacheDir()).filter((name) => name.endsWith(".json"))
    expect(files).toHaveLength(1)
    const cacheFile = join(getCacheDir(), files[0]!)
    const original = readFileSync(cacheFile, "utf8")
    const entry = JSON.parse(original) as { envelope: { cost_usd: number; model: { modelId: string } } }
    expect(entry.envelope.cost_usd).toBe(0.125)
    const { savePricingCache } = await import("../src/lib/pricing")
    savePricingCache({
      updatedAt: "2026-10-19T00:00:00Z",
      models: {
        [entry.envelope.model.modelId]: {
          inputPricePerM: 1,
          outputPricePerM: 2,
          rateSource: "litellm",
          rateDate: "2026-10-19T00:00:00Z",
          matchedModelId: "fixture/actual-row",
        },
      },
    })
    await mod.main()
    const replay = JSON.parse(env.stdout.filter((line) => line.trim().startsWith("{")).at(-1)!) as Record<
      string,
      unknown
    >
    expect(replay).not.toHaveProperty("cost_usd")
    expect(replay.cost_usd_reason).toEqual(expect.stringContaining("cached"))
    expect(replay.list_equivalent_usd).toBe(0.00002)
    expect(replay.list_equivalent_basis).toEqual([
      { rateSource: "litellm", rateDate: "2026-10-19T00:00:00Z", matchedModelId: "fixture/actual-row" },
    ])
    expect(readFileSync(cacheFile, "utf8")).toBe(original)
    expect(streamTextMock).toHaveBeenCalledOnce()
  }, 10_000)

  // @failure Debate loses the synthesis call's charge, including an unparseable billed answer.
  // @level l3 @consumer Actual debate CLI envelope; single-model cases never invoke synthesis.
  it.each([true, false])(
    "debate accounts for all calls when synthesis charge is known=%s",
    async (known) => {
      const env = makeTestEnv()
      vi.stubEnv("BEARLY_LLM_OUTPUT_DIR", env.tmpDir)
      resetMocks()
      generateTextMock.mockImplementation(async ({ messages }: { messages: { content: unknown }[] }) => {
        const synthesis = messages.some(
          (message) => typeof message.content === "string" && message.content.includes("You are synthesizing"),
        )
        return {
          text:
            synthesis && known
              ? JSON.stringify({ synthesis: "unified", agreements: [], disagreements: [], confidence: 85 })
              : "opinion",
          finishReason: "stop",
          finalStep: { reasoningText: undefined },
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            raw: synthesis ? (known ? { cost_usd: 0.5 } : {}) : { cost_usd: 0.125 },
          },
        }
      })
      vi.resetModules()
      process.argv = ["node", "cli.ts", "--json", "--full-paths", "debate", "-y", "test"]
      const mod = await import("../src/cli")
      await mod.main()

      const lines = env.stdout.filter((line) => line.trim().startsWith("{"))
      expect(lines).toHaveLength(1)
      const envelope = JSON.parse(lines[0]!) as Record<string, unknown>
      expect(envelope.status).toBe("completed")
      expect(generateTextMock).toHaveBeenCalledTimes(4)
      for (const [options] of generateTextMock.mock.calls) expect(options.abortSignal).toBeInstanceOf(AbortSignal)
      if (known) {
        expect(envelope.cost_usd).toBe(0.875)
        expect(envelope).not.toHaveProperty("cost_usd_reason")
      } else {
        expect(envelope).not.toHaveProperty("cost_usd")
        expect(envelope.cost_usd_reason).toBe("charged unavailable for 1 of 4 invoked calls")
      }
      expect(envelope.list_equivalent_usd).toBeGreaterThan(0)
      expect(envelope.list_equivalent_basis).toHaveLength(4)
      expect(envelope).not.toHaveProperty("cost")
      expect(envelope).not.toHaveProperty("costUsd")
      const output = readFileSync(envelope.file as string, "utf8")
      expect(output).toContain(known ? "unified" : "opinion")
    },
    10_000,
  )

  it("pro (dual): envelope has a/b sections with per-leg tokens/cost/status", async () => {
    const env = makeTestEnv()
    resetMocks()

    vi.resetModules()
    // -y skips the cost-confirmation prompt
    process.argv = ["node", "cli.ts", "--json", "pro", "-y", "--no-judge", "test"]
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
    // Actual Pro dispatch, serialization and saved history must retain both columns.
    // Single-model envelopes never pass through this separate multi-call writer.
    const legs = [envelope.a, envelope.b, envelope.c, envelope.d].filter(Boolean)
    expect(envelope.cost_usd).toBeCloseTo(0.125 * legs.length)
    for (const leg of [a, b]) {
      expect(leg.cost_usd).toBe(0.125)
      expect(leg.list_equivalent_usd).toBeGreaterThan(0)
      expect(leg.list_equivalent_basis).toHaveLength(1)
      expect(leg).not.toHaveProperty("cost")
    }
    const { readAbProLog, getMemoryDir } = await import("../src/lib/dual-pro")
    const saved = (await readAbProLog()).at(-1)!
    expect(saved.a).toMatchObject({ cost_usd: 0.125, list_equivalent_basis: expect.any(Array) })
    expect(saved.a).not.toHaveProperty("cost")
    const historyFile = join(getMemoryDir(), "ab-pro.jsonl")
    const originalHistory = readFileSync(historyFile, "utf8")
    const { savePricingCache } = await import("../src/lib/pricing")
    savePricingCache({
      updatedAt: "2026-10-20T00:00:00Z",
      models: {
        [saved.a!.model]: {
          inputPricePerM: 1,
          outputPricePerM: 2,
          rateSource: "litellm",
          rateDate: "2026-10-20",
          matchedModelId: "history/selected-row",
        },
      },
    })
    const { runLeaderboard } = await import("../src/cmd/leaderboard")
    await runLeaderboard()
    const ranked = JSON.parse(env.stdout.at(-1)!) as { rows: { model: string; average: Record<string, unknown> }[] }
    const row = ranked.rows.find((item) => item.model === saved.a!.model)!
    expect(row.average.cost_usd).toBe(0.125)
    expect(row.average.list_equivalent_usd).toBe(0.00002)
    expect(row.average.list_equivalent_basis).toEqual([
      { rateSource: "litellm", rateDate: "2026-10-20", matchedModelId: "history/selected-row" },
    ])
    expect(readFileSync(historyFile, "utf8")).toBe(originalHistory)
  }, 10_000)

  // @failure A paid schema-retry judge disappears from Pro totals or saved history.
  // @level l3 @consumer Actual Pro command including its judge retry and log writer.
  it.each([
    { known: true, valid: true },
    { known: false, valid: true },
    { known: true, valid: false },
  ])(
    "pro retains judge retries: known=$known, valid=$valid",
    async ({ known, valid }) => {
      const env = makeTestEnv()
      resetMocks()
      let judgeCalls = 0
      generateTextMock.mockImplementation(async ({ messages }: { messages: { content: unknown }[] }) => {
        const judge = messages.some((m) => typeof m.content === "string" && m.content.includes('"scoreA"'))
        if (judge) judgeCalls++
        const score = { scores: { specificity: 4, actionability: 4, correctness: 4, depth: 4 }, total: 16 }
        return {
          text:
            judge && judgeCalls > 1 && valid
              ? JSON.stringify({ scoreA: score, scoreB: score, winner: "tie", reasoning: "equal" })
              : "{}",
          finishReason: "stop",
          finalStep: { reasoningText: undefined },
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            raw: !judge ? { cost_usd: 0.125 } : judgeCalls === 1 ? { cost_usd: 0.3 } : known ? { cost_usd: 0.4 } : {},
          },
        }
      })
      vi.resetModules()
      process.argv = ["node", "cli.ts", "--json", "pro", "--legs", "2", "-y", "test"]
      const mod = await import("../src/cli")
      if (valid) await mod.main()
      else await expect(mod.main()).rejects.toThrow("__exit_1")
      const lines = env.stdout.filter((line) => line.trim().startsWith("{"))
      expect(lines).toHaveLength(1)
      const result = JSON.parse(lines[0]!) as Record<string, unknown>
      expect(result.status).toBe(valid ? "completed" : "incomplete")
      expect(judgeCalls).toBe(2)
      if (known) expect(result.cost_usd).toBeCloseTo(0.95)
      else {
        expect(result).not.toHaveProperty("cost_usd")
        expect(result.cost_usd_reason).toBe("charged unavailable for 1 of 4 invoked calls")
      }
      expect(result.list_equivalent_basis).toHaveLength(4)
      const judgeEnvelope = result.judge as Record<string, unknown>
      if (known) expect(judgeEnvelope.cost_usd).toBeCloseTo(0.7)
      else expect(judgeEnvelope.cost_usd_reason).toBe("charged unavailable for 1 of 2 invoked calls")
      const { readAbProLog } = await import("../src/lib/dual-pro")
      const saved = (await readAbProLog()).at(-1)! as unknown as Record<string, unknown>
      const judge = saved.judge as Record<string, unknown>
      expect(judge.responses).toHaveLength(2)
      expect(judge).not.toHaveProperty("cost")
    },
    10_000,
  )

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
    expect(envelope.error).toMatch(/not in registry/i)
  }, 10_000)
})
