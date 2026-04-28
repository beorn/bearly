/**
 * `bun llm pro --discover-models [--classify] [--apply]` — Stage 2 of the
 * auto-discovery pipeline (km-bearly.llm-registry-auto-update).
 *
 * Reads `~/.cache/bearly-llm/new-models.json` (written by `performPricingUpdate`).
 *
 * **Default mode**: emit raw discovery list — every candidate with its
 * regex-detected capability hints, grouped by provider. Free, fast.
 *
 * **`--classify` mode**: also fire the cheap classifier (gpt-5-nano) per
 * candidate to produce yes/no/needs-review decisions in a markdown table.
 * Cost: ~$0.0005 × N candidates (~$0.02 for ~30). Use when you want a
 * pre-filtered table to feed into review.
 *
 * **`--apply` mode**: write a unified diff to `<outputDir>/llm-new-models.patch`
 * (default os.tmpdir()). Without `--classify`, includes ALL candidates;
 * with `--classify`, only the `yes` decisions. Either way the user reviews
 * and runs `git apply <patchPath>` themselves — never auto-applied.
 *
 * The classifier is opt-in (Phase 6 over-engineering review, 2026-04-27):
 * its yes/no decisions had unproven empirical value vs. raw discovery +
 * human review, so default behavior is now "show me the candidates" with
 * `--classify` for the LLM-pre-filter when actually wanted.
 */

import { emitJson, isJsonMode } from "../lib/output-mode"

export async function runDiscoverModels(opts: { apply?: boolean; classify?: boolean } = {}): Promise<void> {
  const fs = await import("fs")
  const {
    loadNewModelsArtifact,
    classifyCandidates,
    formatDecisionTable,
    formatRawDiscoveryTable,
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

  // Raw mode (default): no classifier — emit the candidate list and stop.
  if (!opts.classify) {
    console.log("# Auto-discovered model candidates (raw)\n")
    console.log(`Discovered: ${artifact.discoveredAt}`)
    console.log(`Classifier: disabled (use --classify to pre-filter via LLM, ~$0.02 / 30 candidates)\n`)
    console.log(formatRawDiscoveryTable(artifact.candidates))

    if (opts.apply) {
      const typesTsPath = new URL("../lib/types.ts", import.meta.url).pathname
      const typesTsContent = fs.readFileSync(typesTsPath, "utf-8")
      const patch = generateRegistryPatch(artifact.candidates, typesTsContent)
      const path = await import("path")
      const { getOutputDir } = await import("../lib/format")
      const outPath = path.join(getOutputDir(), "llm-new-models.patch")
      fs.writeFileSync(outPath, patch)
      console.error(`\n✓ Wrote ${outPath} (${artifact.candidates.length} entries — ALL candidates, no LLM filter)`)
      console.error(`  Review with: cat ${outPath}`)
      console.error(`  Apply with:  git apply ${outPath}`)
    }

    if (isJsonMode()) {
      emitJson({
        status: "completed",
        mode: "raw",
        candidates: artifact.candidates.length,
        classified: false,
      })
    }
    return
  }

  // Classify mode: opt-in via --classify flag.
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
      const path = await import("path")
      const { getOutputDir } = await import("../lib/format")
      const outPath = path.join(getOutputDir(), "llm-new-models.patch")
      fs.writeFileSync(outPath, patch)
      console.error(`\n✓ Wrote ${outPath} (${approved.length} approved entries)`)
      console.error(`  Review with: cat ${outPath}`)
      console.error(`  Apply with:  git apply ${outPath}`)
    }
  }

  if (isJsonMode()) {
    let patchPath: string | undefined
    if (opts.apply && approved.length > 0) {
      const path = await import("path")
      const { getOutputDir } = await import("../lib/format")
      patchPath = path.join(getOutputDir(), "llm-new-models.patch")
    }
    emitJson({
      status: "completed",
      candidates: artifact.candidates.length,
      approved: approved.length,
      pending: pending.length,
      rejected,
      patchPath,
    })
  }
}
