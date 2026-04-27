/**
 * `bun llm pro --judge-history` — retroactively score historical
 * ab-pro.jsonl entries that have responses available (either inline
 * `content` field added 2026-04-27, or alive `outputFile` path).
 *
 * Read ab-pro.jsonl → filter unjudged entries with recoverable content →
 * fire judge on each (gpt-5-mini default; gpt-5-nano if --quick) → in
 * --apply mode, rewrite the file in place with augmented entries (with
 * .bak backup); otherwise dry-run reports counts only.
 */

import { ask } from "../lib/research"
import { isProviderAvailable, getProviderEnvVar } from "../lib/providers"
import { estimateCost, formatCost, getModel } from "../lib/types"
import { emitJson, isJsonMode } from "../lib/output-mode"
import { confirmOrExit } from "../ui/confirm"

/**
 * Parse the markdown output file written by runProDual into per-leg content
 * sections. Format (see formatDualProResponse):
 *
 *   # Dual-Pro Response
 *   <preamble>
 *   ---
 *   ## GPT-5.4 Pro
 *   _5921 tokens · 107s · $0.018_
 *   <content>
 *   ---
 *   ## Kimi K2.6
 *   ...
 *
 * Maps the first three `## ` sections to legs a/b/c by order. Strips the
 * cost-summary line and "## Judge breakdown" tail. Skips legs that show
 * the failure marker `⚠️ Failed:`. Returns whatever subset is recoverable.
 */
function parseOutputFileSections(raw: string): { a?: string; b?: string; c?: string } {
  // Drop everything from "## Judge breakdown" onward — it's the judge output,
  // not a model leg.
  const beforeJudge = raw.split(/\n## Judge breakdown/)[0] ?? raw
  const parts = beforeJudge.split(/\n## /).slice(1) // drop preamble; sections start with "## "
  if (parts.length < 2) return {}
  const result: { a?: string; b?: string; c?: string } = {}
  const slot: ("a" | "b" | "c")[] = ["a", "b", "c"]
  for (let i = 0; i < Math.min(parts.length, 3); i++) {
    const lines = parts[i]!.split("\n")
    let start = 1
    while (start < lines.length) {
      const t = (lines[start] ?? "").trim()
      if (t === "" || /^_.*_$/.test(t) || /^---/.test(t)) start++
      else break
    }
    const content = lines.slice(start).join("\n").trim()
    if (!content) continue
    if (/^⚠️\s+Failed:/.test(content) || /^Failed:/.test(content)) continue
    result[slot[i]!] = content
  }
  return result
}

export async function runJudgeHistory(opts: {
  limit?: number
  quick?: boolean
  apply?: boolean
  skipConfirm?: boolean
}): Promise<void> {
  const dualPro = await import("../lib/dual-pro")
  const cfg = await dualPro.loadConfig()
  const fs = await import("fs")
  const os = await import("os")
  const entries = await dualPro.readAbProLog()
  const judgeModelId = opts.quick ? "gpt-5-nano" : cfg.judge
  const judgeModel = getModel(judgeModelId)
  if (!judgeModel) {
    console.error(`Judge model not in registry: ${judgeModelId}`)
    return
  }
  if (!isProviderAvailable(judgeModel.provider)) {
    console.error(`Judge unavailable: set ${getProviderEnvVar(judgeModel.provider)}`)
    return
  }

  type Cand = {
    idx: number
    entry: import("../lib/dual-pro").AbProEntry
    aModel: string
    bModel: string
    cModel?: string
    aContent: string
    bContent: string
    cContent?: string
  }
  const candidates: Cand[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    if (e.judge) continue
    const aModel = e.a?.model ?? e.gpt?.model
    const bModel = e.b?.model ?? e.kimi?.model
    const cModel = e.c?.model
    if (!aModel || !bModel) continue
    let aContent = e.a?.content
    let bContent = e.b?.content
    let cContent = e.c?.content
    const outputFile = (e as { outputFile?: string }).outputFile
    if ((!aContent || !bContent) && outputFile && fs.existsSync(outputFile)) {
      try {
        const raw = fs.readFileSync(outputFile, "utf-8")
        const parsed = parseOutputFileSections(raw)
        aContent = aContent ?? parsed.a
        bContent = bContent ?? parsed.b
        cContent = cContent ?? parsed.c
      } catch {
        // unreadable — skip
      }
    }
    if (!aContent || !bContent) continue
    candidates.push({ idx: i, entry: e, aModel, bModel, cModel, aContent, bContent, cContent })
  }

  if (candidates.length === 0) {
    console.error("No entries eligible for retroactive judging.")
    console.error(`(Total: ${entries.length}, already-judged: ${entries.filter((e) => e.judge).length},`)
    console.error(` missing content: ${entries.length - entries.filter((e) => e.judge).length - candidates.length})`)
    if (isJsonMode()) emitJson({ status: "empty", judged: 0, eligible: 0 })
    return
  }

  const limit = Math.min(opts.limit ?? candidates.length, candidates.length)
  const todo = candidates.slice(0, limit)

  const perCallCost = estimateCost(judgeModel, 3000, 400)
  const totalEst = perCallCost * todo.length
  console.error(
    `\nRetroactive judging: ${todo.length} entries (of ${candidates.length} eligible / ${entries.length} total)`,
  )
  console.error(`  Judge: ${judgeModel.displayName}${opts.quick ? " (quick)" : ""}`)
  console.error(`  Estimated cost: ${formatCost(totalEst)}\n`)

  if (totalEst > 5 && !opts.skipConfirm) {
    await confirmOrExit(`⚠️  Estimated cost ${formatCost(totalEst)}. Proceed? [Y/n] `, !!opts.skipConfirm)
  }

  const BATCH = 5
  type Result = {
    idx: number
    judge?: import("../lib/dual-pro").JudgeResult
    cost: number
    error?: string
  }
  const results: Result[] = []
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH)
    const settled = await Promise.allSettled(
      batch.map(async (c): Promise<Result> => {
        const responses: { id: "a" | "b" | "c"; model: string; content: string }[] = []
        responses.push({ id: "a", model: c.aModel, content: c.aContent })
        responses.push({ id: "b", model: c.bModel, content: c.bContent })
        if (c.cContent && c.cModel) {
          responses.push({ id: "c", model: c.cModel, content: c.cContent })
        }
        const prompt = dualPro.buildJudgePrompt({
          question: c.entry.question ?? "",
          responses,
          rubric: cfg.rubric,
        })
        const r = await ask(prompt, "quick", { modelOverride: judgeModel.modelId, stream: false })
        const parsed = dualPro.parseJudgeResponse(r.content)
        const cost = r.usage ? estimateCost(judgeModel, r.usage.promptTokens, r.usage.completionTokens) : 0
        return { idx: c.idx, judge: parsed, cost }
      }),
    )
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j]!
      if (s.status === "fulfilled") results.push(s.value)
      else results.push({ idx: batch[j]!.idx, cost: 0, error: String(s.reason) })
    }
    process.stderr.write(`  ${Math.min(i + BATCH, todo.length)}/${todo.length} judged\n`)
  }

  const judgedCount = results.filter((r) => r.judge).length
  const totalCost = results.reduce((s, r) => s + r.cost, 0)
  console.error(`\n${judgedCount}/${todo.length} judged successfully (cost: ${formatCost(totalCost)})`)

  if (opts.apply && judgedCount > 0) {
    const updated = entries.map((e) => ({ ...e })) as Array<import("../lib/dual-pro").AbProEntry>
    for (const r of results) {
      if (!r.judge) continue
      const e = updated[r.idx]
      if (!e) continue
      e.judge = { model: judgeModel.modelId, result: r.judge }
      if (e.a) e.a = { ...e.a, score: r.judge.a }
      if (e.b) e.b = { ...e.b, score: r.judge.b }
      if (e.c && r.judge.c) e.c = { ...e.c, score: r.judge.c }
      if (e.d && r.judge.d) e.d = { ...e.d, score: r.judge.d }
    }
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd()
    const encoded = projectRoot.replace(/\//g, "-")
    const home = process.env.HOME || os.homedir()
    const file = `${home}/.claude/projects/${encoded}/memory/ab-pro.jsonl`
    fs.copyFileSync(file, `${file}.bak`)
    fs.writeFileSync(file, updated.map((e) => JSON.stringify(e)).join("\n") + "\n")
    console.error(`\n✓ Rewrote ${file}`)
    console.error(`  Backup: ${file}.bak`)
    console.error(`  Augmented ${judgedCount} entries with judge scores.`)
  } else if (judgedCount > 0) {
    console.error(`\nDry run — re-run with --apply to write augmented entries to ab-pro.jsonl`)
  }

  if (isJsonMode()) {
    emitJson({
      status: "completed",
      eligible: candidates.length,
      judged: judgedCount,
      totalCostUsd: totalCost,
      applied: !!opts.apply && judgedCount > 0,
    })
  }
}
