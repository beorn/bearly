/**
 * `bun llm pro --discover-models [--apply]` — Stage 2 of the auto-discovery
 * pipeline (km-bearly.llm-registry-auto-update).
 *
 * Reads `~/.cache/bearly-llm/new-models.json` (written by `performPricingUpdate`),
 * runs the cheap classifier (gpt-5-nano) over each candidate, and prints a
 * markdown decision table. With `--apply`, writes a unified diff to
 * `/tmp/llm-new-models.patch` containing the `yes`-decisions formatted as
 * SKUs_DATA + ENDPOINTS_DATA additions to types.ts. The user reviews and runs
 * `git apply /tmp/llm-new-models.patch` themselves — never auto-applied.
 *
 * Cost: ~$0.0005 × N candidates. For ~30 candidates that's ~$0.02. Run weekly
 * via `/sop infra` or cron.
 */

import { emitJson, isJsonMode } from "../lib/output-mode"

export async function runDiscoverModels(opts: { apply?: boolean } = {}): Promise<void> {
  const fs = await import("fs")
  const {
    loadNewModelsArtifact,
    classifyCandidates,
    formatDecisionTable,
    generateRegistryPatch,
    selectClassifierModel,
  } = await import("../lib/discover")

  const artifact = loadNewModelsArtifact()
  if (!artifact || artifact.candidates.length === 0) {
    console.error(
      "No candidates in ~/.cache/bearly-llm/new-models.json. Run `bun llm update-pricing` first to populate.",
    )
    if (isJsonMode()) emitJson({ status: "empty", candidates: 0 })
    return
  }

  console.error(`📋 Auto-discovery — ${artifact.candidates.length} candidates from ${artifact.discoveredAt}`)

  const classifierModel = await selectClassifierModel()
  if (!classifierModel) {
    console.error("⚠️  No classifier model available — set OPENAI_API_KEY for gpt-5-nano (or any quick-tier provider).")
    if (isJsonMode()) emitJson({ status: "no-classifier", candidates: artifact.candidates.length })
    return
  }
  console.error(`  classifier: ${classifierModel.displayName}`)

  const decisions = await classifyCandidates(artifact.candidates, classifierModel)

  // Print markdown table on stdout — pipe-friendly, can be redirected straight
  // into a doc / PR description.
  console.log("# Auto-discovered model candidates\n")
  console.log(`Discovered: ${artifact.discoveredAt}`)
  console.log(`Classifier: ${classifierModel.displayName}\n`)
  console.log(formatDecisionTable(decisions))

  // Pending review section — `needs-review` items don't enter the diff, but
  // surface separately so the human can act on them.
  const pending = decisions.filter((d) => d.result.decision === "needs-review")
  if (pending.length > 0) {
    console.log("## Pending review\n")
    for (const { candidate, result } of pending) {
      console.log(`- \`${candidate.id}\` (${candidate.provider}) — ${result.reason}`)
    }
    console.log("")
  }

  const approved = decisions.filter((d) => d.result.decision === "yes").map((d) => d.candidate)
  const rejected = decisions.filter((d) => d.result.decision === "no").length

  console.error(`\n  approved: ${approved.length}  needs-review: ${pending.length}  rejected: ${rejected}`)

  if (opts.apply) {
    if (approved.length === 0) {
      console.error("  no `yes` decisions — nothing to write.")
    } else {
      // Read types.ts via package-relative path. We deliberately compute the
      // path off this module's location so it works whether bearly is invoked
      // standalone or as a vendor submodule.
      const typesTsPath = new URL("../lib/types.ts", import.meta.url).pathname
      const typesTsContent = fs.readFileSync(typesTsPath, "utf-8")
      const patch = generateRegistryPatch(approved, typesTsContent)
      const outPath = "/tmp/llm-new-models.patch"
      fs.writeFileSync(outPath, patch)
      console.error(`\n✓ Wrote ${outPath} (${approved.length} approved entries)`)
      console.error(`  Review with: cat ${outPath}`)
      console.error(`  Apply with:  git apply ${outPath}`)
    }
  }

  if (isJsonMode()) {
    emitJson({
      status: "completed",
      candidates: artifact.candidates.length,
      approved: approved.length,
      pending: pending.length,
      rejected,
      patchPath: opts.apply && approved.length > 0 ? "/tmp/llm-new-models.patch" : undefined,
    })
  }
}
