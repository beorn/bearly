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
import type { Model } from "../src/lib/types"

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
    modelOverride: modelAt(costTier),
    outputFile: "/dev/null",
    sessionTag: "test",
    skipConfirm: true,
    skipRecover: true,
    streamToken: () => {},
    topic: "a topic",
  })
  return errors
}

const PRICE = /(~\$[0-9]+-[0-9]+)/u

describe("the /deep consent gate states the price the command computed (24577)", () => {
  it.each(["very-high", "high"] as const)(
    "the printed estimate and the gate's question carry the SAME number (%s tier)",
    async (costTier) => {
      const out = await deepDryRun(costTier)

      const printed = out.find((line) => line.startsWith("Estimated cost:"))
      const wouldAsk = out.find((line) => line.includes("Would ask:"))
      expect(printed, `no estimate line in:\n${out.join("\n")}`).toBeDefined()
      expect(wouldAsk, `no gate line in:\n${out.join("\n")}`).toBeDefined()

      const printedPrice = PRICE.exec(String(printed))?.[1]
      const gatePrice = PRICE.exec(String(wouldAsk))?.[1]
      expect(printedPrice).toBeDefined()
      expect(gatePrice).toBeDefined()
      expect(gatePrice, "the consent must not name a price the command already contradicted").toBe(printedPrice)
    },
  )

  it("the dry run states the question it would ask, because the gate is past its own early return", async () => {
    // The unobservability IS the defect's survival mechanism: the dry run
    // returns before the gate, so the only safe way to inspect this command
    // never reached the wrong line.
    const out = await deepDryRun("very-high")
    expect(out.some((line) => line.includes("Would ask:") && line.includes("Proceed?"))).toBe(true)
  })
})
