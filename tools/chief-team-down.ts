#!/usr/bin/env bun
// chief-team-down — full rotation wind-down: integrate everything + verify + retro skeleton.
//
// Runs the close-of-rotation sweep mechanically:
//   1. Broadcast wind-down via tribe-cli (asks agents to /complete + sound offline)
//   2. For each pool slot: chief-integrate (cherry-pick anything ahead)
//   3. test:ci as final gate
//   4. If friction-class incidents tracked: generate retro doc skeleton
//
// Usage:
//   bun tools/chief-team-down.ts                      # full sweep
//   bun tools/chief-team-down.ts --skip-test-ci       # skip the gate (faster, less safe)
//   bun tools/chief-team-down.ts --retro              # always generate retro skeleton
//   bun tools/chief-team-down.ts --slots wt0 wt2 wt5  # only these slots
//
// What it does NOT do:
//   - Wait synchronously for agents to /complete (they're interactive)
//   - Force-shutdown any agent session (they self-offline per §17)
//   - Reset slot branches if commits were already integrated (chief-cleanup-slot exists for that)

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, dirname, basename } from "node:path"

async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (b) => (stdout += b.toString()))
    proc.stderr.on("data", (b) => (stderr += b.toString()))
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }))
  })
}

async function gitToplevel(): Promise<string> {
  const r = await run("git", ["rev-parse", "--show-toplevel"])
  if (r.exitCode !== 0) throw new Error("not in a git repo")
  return r.stdout.trim()
}

function parseArgs(): { slots: string[] | null; skipTestCi: boolean; forceRetro: boolean } {
  const args = process.argv.slice(2)
  const skipTestCi = args.includes("--skip-test-ci")
  const forceRetro = args.includes("--retro")
  const slotsIdx = args.indexOf("--slots")
  let slots: string[] | null = null
  if (slotsIdx !== -1) {
    slots = args.slice(slotsIdx + 1).filter((a) => /^wt\d+$/.test(a))
    if (slots.length === 0) {
      console.error("--slots requires at least one slot name (wt0, wt1, ...)")
      console.error("if you want all pool slots, omit --slots entirely")
      process.exit(2)
    }
  }
  return { slots, skipTestCi, forceRetro }
}

async function listPoolSlots(mainRoot: string): Promise<string[]> {
  const repoBasename = basename(mainRoot)
  const repoParent = dirname(mainRoot)
  const slots: string[] = []
  for (let i = 0; i < 10; i++) {
    const slot = `wt${i}`
    const slotPath = resolve(repoParent, `${repoBasename}-${slot}`)
    if (existsSync(slotPath)) slots.push(slot)
  }
  return slots
}

async function broadcastWindDown(): Promise<void> {
  console.log("[team-down] broadcasting wind-down to tribe...")
  const message =
    "winding down — finish active beads, run /complete, sound off offline @agent/N when done. chief integrating after."
  // Sibling tribe-cli.ts in this bearly tools/ directory.
  const tribeCliPath = resolve(import.meta.dir, "tribe-cli.ts")
  const r = await run("bun", [tribeCliPath, "send", "*", message])
  if (r.exitCode !== 0) {
    console.warn(`[team-down] tribe broadcast failed (continuing): ${r.stderr}`)
  } else {
    console.log("[team-down] broadcast sent.")
  }
}

async function integrateSlot(
  slot: string,
  mainRoot: string,
): Promise<{ slot: string; integrated: boolean; sha?: string; reason?: string }> {
  // chief-integrate exits 0 even if nothing to integrate; capture stdout for the SHA
  const r = await run("bun", ["tools/chief-integrate.ts", slot], { cwd: mainRoot })
  if (r.exitCode !== 0) {
    return { slot, integrated: false, reason: r.stderr.trim().split("\n").pop() ?? "exit non-zero" }
  }
  if (r.stdout.includes("nothing to integrate")) {
    return { slot, integrated: false, reason: "nothing to integrate" }
  }
  const shaMatch = r.stdout.match(/Final main SHA: ([a-f0-9]+)/)
  return { slot, integrated: true, sha: shaMatch?.[1] }
}

async function runTestCi(mainRoot: string): Promise<{ passed: boolean; summary: string }> {
  console.log("[team-down] running test:ci as final gate (3-5 min)...")
  const r = await run("bun", ["run", "test:ci"], { cwd: mainRoot })
  const passed = r.exitCode === 0
  const summary = passed
    ? "test:ci GREEN"
    : `test:ci RED (exit ${r.exitCode}). Last lines:\n${r.stdout.split("\n").slice(-10).join("\n")}`
  return { passed, summary }
}

function retroSkeleton(date: string, integrated: { slot: string; sha?: string }[]): string {
  return `# Retro: ${date} rotation

**Session window**: <fill in>
**Active agents**: <fill in>
**Saga-class closures**: <count>
**Integrations**: ${integrated.filter((i) => i.sha).length} (${integrated
    .filter((i) => i.sha)
    .map((i) => `${i.slot}→${i.sha?.slice(0, 9)}`)
    .join(", ")})

## What went well

<5-7 concrete patterns with the agent + what was good>

## What went badly

<5-10 concrete frictions with the cost>

## Tribe responses (compiled)

<populates as agents reply to /tribe broadcast for retro>

## /big — reframe the whole-process design

<2-3 alternative models, ranked by leverage>

## /why — root-cause traces

<5-whys on top 3-5 problem categories, each ending with an ACTION line>

## Recommendations (ranked)

<biggest immediate-ROI first>

## Patterns to keep

<lock in what worked>

## Patterns to drop

<stop the bleeding>
`
}

async function main() {
  const { slots: requestedSlots, skipTestCi, forceRetro } = parseArgs()
  const mainRoot = await gitToplevel()

  console.log(`[team-down] starting full rotation wind-down`)

  // 1. Broadcast wind-down
  await broadcastWindDown()

  // 2. Integrate each slot (chief-integrate is idempotent)
  const slots = requestedSlots ?? (await listPoolSlots(mainRoot))
  console.log(`[team-down] sweeping ${slots.length} slot(s): ${slots.join(", ")}`)
  const results: { slot: string; integrated: boolean; sha?: string; reason?: string }[] = []
  for (const slot of slots) {
    const r = await integrateSlot(slot, mainRoot)
    results.push(r)
    const status = r.integrated ? `INTEGRATED → ${r.sha?.slice(0, 9)}` : `skipped (${r.reason})`
    console.log(`  ${slot}: ${status}`)
  }

  // 3. test:ci gate
  let testCiResult: { passed: boolean; summary: string } | null = null
  if (!skipTestCi) {
    testCiResult = await runTestCi(mainRoot)
    console.log(`[team-down] ${testCiResult.summary}`)
  } else {
    console.log("[team-down] skipping test:ci per --skip-test-ci")
  }

  // 4. Retro skeleton if forced or if friction observed
  const integratedCount = results.filter((r) => r.integrated).length
  const frictionObserved = (testCiResult && !testCiResult.passed) || integratedCount >= 5
  if (forceRetro || frictionObserved) {
    const date = new Date().toISOString().slice(0, 10)
    // Retro destination is project-configurable; consumers point CHIEF_RETRO_DIR
    // at wherever their workspace likes to keep these. Default: "retros/"
    // relative to repo root.
    const retroDir = process.env.CHIEF_RETRO_DIR ?? "retros"
    const retroPath = resolve(mainRoot, retroDir, `${date}-rotation.md`)
    mkdirSync(dirname(retroPath), { recursive: true })
    if (existsSync(retroPath)) {
      console.log(`[team-down] retro skeleton already exists at ${retroPath} — not overwriting`)
    } else {
      writeFileSync(retroPath, retroSkeleton(date, results))
      console.log(`[team-down] retro skeleton written to ${retroPath} — fill in details`)
    }
  }

  // 5. Summary
  console.log("\n" + "─".repeat(72))
  console.log(`[team-down] DONE`)
  console.log(`  integrations: ${integratedCount}`)
  if (testCiResult) console.log(`  test:ci: ${testCiResult.passed ? "GREEN" : "RED"}`)
  console.log(`  retro: ${forceRetro || frictionObserved ? "skeleton generated" : "skipped (no friction observed)"}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
