#!/usr/bin/env bun
// chief-team-up — prep N idle pool slots + print managed Hab launch instructions.
//
// Managed sessions launch through Hab. This tool only prepares their slots,
// then prints the one supported launch command for each dev seat.
//
// Usage:
//   bun tools/chief-team-up.ts <count>             # prep slots wt0..wt<count-1>
//   bun tools/chief-team-up.ts wt0 wt3 wt5         # prep specific slots
//
// What it does:
//   1. Refuses the whole operation when any selected path is a live Tribe cwd
//   2. For each slot: ensure its configured pool path exists, branch is wtN
//      (creates via `bun worktree create wtN` if missing per skills/worktree)
//   3. Cleans each slot via chief-cleanup-slot.ts --target=origin/main
//   4. Prints the sanctioned `hab up @dev/N` command
//
// What it does NOT do:
//   - Launch a session directly (Hab is the only managed-seat actuator)
//   - Mutate any slot when membership cannot be proved or one selected slot is live

import { spawn } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { resolve } from "node:path"

import { resolvePoolRoot, resolveWorktreeTargetPath } from "bearly/tools/worktree"

async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; pipe?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: opts.pipe === false ? "inherit" : ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    if (opts.pipe !== false) {
      proc.stdout?.on("data", (b: Buffer) => (stdout += b.toString()))
      proc.stderr?.on("data", (b: Buffer) => (stderr += b.toString()))
    }
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }))
  })
}

async function gitToplevel(): Promise<string> {
  const r = await run("git", ["rev-parse", "--show-toplevel"])
  if (r.exitCode !== 0) throw new Error("not in a git repo")
  return r.stdout.trim()
}

interface LiveMember {
  readonly name: string
  readonly cwd: string
}

function parseLiveMembers(raw: string): LiveMember[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`tribe members returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (typeof value !== "object" || value === null || !Array.isArray((value as { sessions?: unknown }).sessions)) {
    throw new Error("tribe members returned invalid membership: missing sessions array")
  }
  return (value as { sessions: unknown[] }).sessions.map((row, index) => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`tribe members returned invalid membership row ${index}: expected object`)
    }
    const { name, cwd } = row as { name?: unknown; cwd?: unknown }
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`tribe members returned invalid membership row ${index}: missing name`)
    }
    if (typeof cwd !== "string" || cwd.trim() === "") {
      throw new Error(`tribe members returned invalid membership row ${index}: missing cwd for ${name}`)
    }
    return { name, cwd }
  })
}

async function readLiveMembers(mainRoot: string): Promise<LiveMember[]> {
  const result = await run("tribe", ["members"], { cwd: mainRoot })
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
    throw new Error(`tribe members failed; cannot prove selected slots idle: ${detail}`)
  }
  return parseLiveMembers(result.stdout)
}

function canonicalPath(path: string): string {
  const absolute = resolve(path)
  return existsSync(absolute) ? realpathSync(absolute) : absolute
}

interface SlotPlan {
  readonly slot: string
  readonly path: string
}

function liveSlotConflicts(plans: readonly SlotPlan[], members: readonly LiveMember[]) {
  const membersByPath = new Map<string, string[]>()
  for (const member of members) {
    const path = canonicalPath(member.cwd)
    const names = membersByPath.get(path) ?? []
    names.push(member.name)
    membersByPath.set(path, names)
  }
  return plans.flatMap((plan) => {
    const membersAtPath = membersByPath.get(canonicalPath(plan.path))
    return membersAtPath === undefined ? [] : [{ ...plan, members: membersAtPath }]
  })
}

function parseArgs(args: string[]): string[] {
  if (args.length === 0) {
    console.error("usage: bun tools/chief-team-up.ts <count> | <wt0> <wt1> ...")
    process.exit(2)
  }
  const first = args[0]
  if (args.length === 1 && first !== undefined && /^\d+$/.test(first)) {
    const count = parseInt(first, 10)
    return Array.from({ length: count }, (_, i) => `wt${i}`)
  }
  return args.map((s) => s.replace(/^wt?/, "wt"))
}

async function ensureSlot(slot: string, mainRoot: string, slotPath: string): Promise<string> {
  if (!existsSync(slotPath)) {
    console.log(`[team-up] slot ${slot} missing — creating via 'bun worktree create ${slot}'`)
    const create = await run("bun", ["worktree", "create", slot], { cwd: mainRoot })
    if (create.exitCode !== 0) {
      throw new Error(`[team-up] worktree create failed for ${slot}: ${create.stderr || create.stdout}`)
    }
  }
  if (!existsSync(slotPath)) {
    throw new Error(`[team-up] worktree create reported success but ${slot} is absent at ${slotPath}`)
  }
  return slotPath
}

async function cleanSlot(slot: string, mainRoot: string): Promise<void> {
  console.log(`[team-up] cleaning ${slot}...`)
  const r = await run("bun", ["tools/chief-cleanup-slot.ts", slot, "--target=origin/main"], { cwd: mainRoot })
  if (r.exitCode !== 0) {
    throw new Error(`[team-up] cleanup failed for ${slot}:\n${r.stderr || r.stdout}`)
  }
  console.log(
    r.stdout
      .trim()
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  )
}

function manifest(slot: string, slotPath: string): string {
  const n = slot.replace(/^wt/, "")
  return [
    "─".repeat(72),
    `READY for @dev/${n}`,
    "─".repeat(72),
    `Prepared slot: ${slotPath}`,
    "Launch or resume the managed seat through Hab:",
    `  hab up @dev/${n}`,
    "",
  ].join("\n")
}

async function main() {
  const args = process.argv.slice(2)
  const slots = parseArgs(args)
  const mainRoot = await gitToplevel()
  const poolRoot = resolvePoolRoot(mainRoot)
  const plans = slots.map((slot) => ({
    slot,
    path: resolveWorktreeTargetPath(mainRoot, slot, { poolRoot }),
  }))

  console.log(`[team-up] preparing ${slots.length} slot(s): ${slots.join(", ")}`)

  // Safety is an all-or-nothing preflight. A later failure must never leave an
  // earlier live slot rewritten before the tool discovers another live cwd.
  const conflicts = liveSlotConflicts(plans, await readLiveMembers(mainRoot))
  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      console.error(
        `[team-up] SKIPPED ${conflict.slot} path=${conflict.path}: live Tribe member cwd belongs to ${conflict.members.join(", ")}`,
      )
    }
    throw new Error(
      `[team-up] refusing to prepare ${conflicts.length} live slot(s); no selected slot was created or cleaned`,
    )
  }

  // Prep each slot
  const ready: { slot: string; path: string }[] = []
  for (const plan of plans) {
    const path = await ensureSlot(plan.slot, mainRoot, plan.path)
    await cleanSlot(plan.slot, mainRoot)
    ready.push({ slot: plan.slot, path })
  }

  console.log("\n[team-up] DONE. Managed launch instructions:\n")
  for (const { slot, path } of ready) {
    console.log(manifest(slot, path))
  }

  console.log("─".repeat(72))
  console.log(`Chief continues in main repo: cd ${mainRoot}`)
  console.log("Hab remains the only actuator for managed seat launch and resume.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
