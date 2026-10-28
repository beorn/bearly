/**
 * @failure two harness opinions are stored without pairwise scores.
 * @level l1
 * @consumer seats comparing a Claude harness leg with a Codex harness leg.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { judgeHarnessTexts } from "../src/lib/harness-run"

const JUDGED = JSON.stringify({
  scoreA: { scores: { specificity: 4, actionability: 4, correctness: 5, depth: 4 }, total: 17 },
  scoreB: { scores: { specificity: 3, actionability: 3, correctness: 3, depth: 3 }, total: 12 },
  winner: "A",
  reasoning: "A answers the question.",
})

describe("judgeHarnessTexts", () => {
  it("scores two assistant texts with the pairwise judge", async () => {
    let sawLeft = false
    let sawRight = false
    const result = await judgeHarnessTexts({
      question: "what is 2+2",
      rubric: "default",
      left: { model: "claude-code fable", content: "The answer is 4." },
      right: { model: "codex gpt-6-astra", content: "It is 5." },
      ask: async (prompt) => {
        sawLeft = prompt.includes("The answer is 4.")
        sawRight = prompt.includes("It is 5.")
        return JUDGED
      },
    })
    expect(sawLeft).toBe(true)
    expect(sawRight).toBe(true)
    expect(result).toMatchObject({
      ok: true,
      value: { winner: "A", scoreA: { total: 17 }, scoreB: { total: 12 } },
    })
  })
})
