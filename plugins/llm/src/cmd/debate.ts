/**
 * `bun llm debate` — multi-model consensus dispatch with synthesis.
 */

import { consensus } from "../lib/consensus"
import { isProviderAvailable } from "../lib/providers"
import { formatCost } from "../lib/types"
import { emitJson } from "../lib/output-mode"
import { withSignalAbort } from "../lib/signals"
import { confirmOrExit } from "../ui/confirm"
import { checkAndRecoverPartials } from "./recover"

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
  const { finalizeOutput, totalResponseCost } = await import("../lib/format")

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
    emitJson({ error: "Need at least 2 models for debate. " + (debateWarning || ""), status: "failed" })
    process.exit(1)
  }

  console.error(`Multi-model debate: ${question}`)
  console.error(`Models: ${debateModels.map((m) => m.displayName).join(", ")}`)
  console.error(`Estimated cost: ~$1-3\n`)
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
    process.exit(0)
  }

  await confirmOrExit("⚠️  This queries multiple models (~$1-3). Proceed? [Y/n] ", skipConfirm)

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
  const debateCost = totalResponseCost(result.responses)
  await finalizeOutput(debateContent, outputFile, sessionTag, {
    query: question,
    model: `${result.responses.length} models`,
    cost: formatCost(debateCost),
    costUsd: debateCost,
    durationMs: result.totalDurationMs,
    status: "completed",
  })
}
