/**
 * `bun llm debate` — multi-model consensus dispatch with synthesis.
 */

import { consensus } from "../lib/consensus"
import { isProviderAvailable } from "../lib/providers"
import { emitJson } from "../lib/output-mode"
import { withSignalAbort } from "../lib/signals"
import { confirmOrExit } from "../ui/confirm"
import { checkAndRecoverPartials } from "./recover"
import { safeCurrentSeat, declaredHabitatEnvFile } from "../lib/env-preflight"

/** Run multi-model debate command */
export async function runDebate(options: {
  question: string
  buildContext: (topic: string) => Promise<string | undefined>
  outputFile: string
  sessionTag: string
  skipRecover: boolean
  skipConfirm: boolean
  dryRun: boolean
}): Promise<void> {
  const { question, outputFile, sessionTag, skipRecover, skipConfirm, dryRun } = options
  const { finalizeOutput, estimateFleetCost } = await import("../lib/format")

  const contextDebate = await options.buildContext(question)
  const enrichedQuestion = contextDebate ? `${contextDebate}\n\n---\n\n${question}` : question

  const shouldContinueDebate = await checkAndRecoverPartials(skipRecover, skipConfirm)
  if (!shouldContinueDebate) {
    console.error("Cancelled.")
    process.exit(0)
  }

  const { getBestAvailableModels } = await import("../lib/types")
  const { models: debateModels, warning: debateWarning } = getBestAvailableModels("debate", isProviderAvailable, 3)
  if (debateModels.length < 2) {
    const seat = safeCurrentSeat()
    const envFile = declaredHabitatEnvFile()
    const msg =
      `Need at least 2 models for debate for seat ${seat}: provider keys not found in declared env file (${envFile}) or launch environment. ${debateWarning || ""}`.trim()
    emitJson({ error: msg, status: "failed" })
    console.error(`error: ${msg}`)
    process.exit(1)
  }

  console.error(`Multi-model debate: ${question}`)
  console.error(`Models: ${debateModels.map((m) => m.displayName).join(", ")}`)
  const costEstimate = `${estimateFleetCost(debateModels, Math.max(200, Math.ceil(enrichedQuestion.length / 4)), 1_000).text}; initial opinions only, synthesis excluded (reply lengths unknown)`
  const consentPrompt = `⚠️  This queries multiple models (${costEstimate}). Proceed? [Y/n] `
  console.error(`Estimated cost: ${costEstimate}\n`)
  if (debateWarning) console.error(`⚠️  ${debateWarning}\n`)
  if (contextDebate) {
    console.error(`📎 Context provided (${contextDebate.length} chars)\n`)
  }

  if (dryRun) {
    console.error("🔍 Dry run - would query these models:")
    for (const m of debateModels) {
      console.error(`   • ${m.displayName} (${m.provider})`)
    }
    if (contextDebate) {
      console.error(`   Context: ${contextDebate.slice(0, 100)}...`)
    }
    console.error(`   Would ask: ${consentPrompt.trim()}`)
    process.exit(0)
  }

  await confirmOrExit(consentPrompt, skipConfirm)

  // SIGINT/SIGTERM aborts all three parallel queryModel calls inside
  // consensus(). A $1-3 multi-model run that the user wants to kill should
  // stop billing immediately, not run every leg to completion.
  const result = await withSignalAbort((signal) =>
    consensus({
      question: enrichedQuestion,
      modelIds: debateModels.map((m) => m.modelId),
      synthesize: true,
      abortSignal: signal,
      onModelComplete: (response) => {
        if (response.error) {
          console.error(`[${response.model.displayName}] Error: ${response.error}`)
        } else {
          console.error(`[${response.model.displayName}] ✓`)
        }
      },
    }),
  )

  // Build full debate output
  const parts: string[] = []
  parts.push("--- Synthesis ---\n")
  parts.push(result.synthesis || "(No synthesis)")
  if (result.agreements?.length) {
    parts.push("\n--- Agreements ---")
    result.agreements.forEach((a) => parts.push(`• ${a}`))
  }
  if (result.disagreements?.length) {
    parts.push("\n--- Disagreements ---")
    result.disagreements.forEach((d) => parts.push(`• ${d}`))
  }
  const debateContent = parts.join("\n")

  // Print debate summary to stderr for progress visibility (if interactive)
  if (process.stderr.isTTY) {
    console.error("\n" + debateContent)
  }
  const { cost_usd, cost_usd_reason, list_equivalent_usd, list_equivalent_reason, list_equivalent_basis } = result
  await finalizeOutput(debateContent, outputFile, sessionTag, {
    query: question,
    model: `${result.responses.length} models`,
    cost_usd,
    cost_usd_reason,
    list_equivalent_usd,
    list_equivalent_reason,
    list_equivalent_basis,
    durationMs: result.totalDurationMs,
    status: "completed",
  })
}
