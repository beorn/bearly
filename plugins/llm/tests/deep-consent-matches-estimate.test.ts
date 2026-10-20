/**
 * 24577: `/deep` printed a tier-aware cost estimate and then asked the user to
 * consent to a DIFFERENT, hardcoded one. For a very-high-tier model the same
 * command said `~$5-15` on screen and `~$2-5` in the prompt, seconds apart, and
 * the number attached to the consent was the one that had ignored the model.
 *
 * `costEstimate` had exactly two references — the assignment and the print.
 * The gate carried its own literal and never read it.
 *
 * BOTH TIERS ARE ASSERTED. A single-tier test passes on the bug for whichever
 * tier happens to match the hardcoded literal: under the old code the standard
 * tier agreed (`~$2-5` both places) and only very-high disagreed. One arm would
 * have read as a clean pass.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runDeep } from "../src/cmd/deep"
import { runDebate } from "../src/cmd/debate"
import { getModel, type Model } from "../src/lib/types"

function modelAt(costTier: Model["costTier"]): Model {
  return {
    costTier,
    displayName: `Fixture ${costTier}`,
    inputPricePerM: 1,
    isDeepResearch: true,
    modelId: `fixture-${costTier}`,
    outputPricePerM: 2,
    provider: "openai",
    typicalLatencyMs: 1000,
  } as Model
}

let errors: string[]
let stderr: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errors = []
  stderr = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    errors.push(parts.map(String).join(" "))
  })
})
afterEach(() => {
  stderr.mockRestore()
})

/** The dry run returns before any provider call, so this never spends. */
async function deepDryRun(costTier: Model["costTier"]): Promise<string[]> {
  await runDeep({
    buildContext: async () => undefined,
    dryRun: true,
    modelOverride: costTier === "very-high" ? getModel("gpt-5.4-pro")! : modelAt(costTier),
    outputFile: "/dev/null",
    sessionTag: "test",
    skipConfirm: true,
    skipRecover: true,
    streamToken: () => {},
    topic: "a topic",
  })
  return errors
}

describe("the /deep consent gate states the price the command computed (24577)", () => {
  it.each(["very-high", "high"] as const)(
    "the printed estimate and the gate's question carry the SAME number (%s tier)",
    async (costTier) => {
      const out = await deepDryRun(costTier)

      const printed = out.find((line) => line.startsWith("Estimated cost:"))
      const wouldAsk = out.find((line) => line.includes("Would ask:"))
      expect(printed, `no estimate line in:\n${out.join("\n")}`).toBeDefined()
      expect(wouldAsk, `no gate line in:\n${out.join("\n")}`).toBeDefined()

      const forecast = printed!.replace("Estimated cost: ", "").trim()
      expect(forecast).toContain("charged unknown (forecast; no call dispatched)")
      expect(forecast).toContain("list-equivalent")
      expect(forecast).toContain("assumed")
      if (costTier === "very-high") {
        expect(forecast).toContain("list-equivalent $")
        expect(forecast).toMatch(/date .+; model gpt-5\.4-pro/)
      } else expect(forecast).toContain("list-equivalent unknown (rates unavailable for Fixture high)")
      expect(wouldAsk).toContain(forecast)
      expect(forecast).not.toMatch(/~\$\d+-\d+/)
    },
  )

  it("the dry run states the question it would ask, because the gate is past its own early return", async () => {
    // The unobservability IS the defect's survival mechanism: the dry run
    // returns before the gate, so the only safe way to inspect this command
    // never reached the wrong line.
    const out = await deepDryRun("very-high")
    expect(out.some((line) => line.includes("Would ask:") && line.includes("Proceed?"))).toBe(true)
  })

  it("debate names the same independent forecast and synthesis limit at consent", async () => {
    vi.stubEnv("LLM_NO_ENV_AUTOLOAD", "1")
    vi.stubEnv("OPENAI_API_KEY", "sk-offline-test")
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-offline-test")
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "offline-test")
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("dry-run-exit")
    }) as never)
    try {
      await expect(
        runDebate({
          question: "forecast fixture",
          buildContext: async () => "context fixture",
          outputFile: "/dev/null",
          sessionTag: "test",
          skipRecover: true,
          skipConfirm: true,
          dryRun: true,
        }),
      ).rejects.toThrow("dry-run-exit")
      const forecast = errors
        .find((line) => line.startsWith("Estimated cost:"))!
        .replace("Estimated cost: ", "")
        .trim()
      expect(forecast).toContain("charged unknown (forecast; no call dispatched)")
      expect(forecast).toContain("list-equivalent $")
      expect(forecast).toContain("assumed")
      expect(forecast).toContain("synthesis excluded")
      expect(errors.find((line) => line.includes("Would ask:"))).toContain(forecast)
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
    }
  })
})
