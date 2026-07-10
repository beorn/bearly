#!/usr/bin/env bun
// chief-team-up — prep N pool slots clean + print per-agent session-start manifest.
//
// Spawning claude sessions can't be scripted directly (each is interactive).
// This tool does the prep work that has to happen BEFORE you open the windows,
// and prints a copy-pasteable manifest for each agent's first message.
//
// Usage:
//   bun tools/chief-team-up.ts <count>             # prep slots wt0..wt<count-1>
//   bun tools/chief-team-up.ts wt0 wt3 wt5         # prep specific slots
//
// What it does:
//   1. For each slot: ensure path exists (../<repo>-wtN), branch is wtN
//      (creates via `bun worktree create wtN` if missing per skills/worktree)
//   2. Cleans each slot via chief-cleanup-slot.ts --target=origin/main
//   3. Prints per-agent manifest: cwd + tribe.rename + online broadcast
//
// What it does NOT do:
//   - Spawn claude windows (interactive; you do this in your terminal manager)
//   - Send tribe messages on agents' behalf (each agent self-onboards via §17)

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve, dirname, basename } from "node:path"

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

async function ensureSlot(slot: string, mainRoot: string): Promise<{ path: string; ok: boolean }> {
  const repoBasename = basename(mainRoot)
  const repoParent = dirname(mainRoot)
  const slotPath = resolve(repoParent, `${repoBasename}-${slot}`)
  if (!existsSync(slotPath)) {
    console.log(`[team-up] slot ${slot} missing — creating via 'bun worktree create ${slot}'`)
    const create = await run("bun", ["worktree", "create", slot], { cwd: mainRoot })
    if (create.exitCode !== 0) {
      console.error(`[team-up] worktree create failed for ${slot}: ${create.stderr}`)
      return { path: slotPath, ok: false }
    }
  }
  return { path: slotPath, ok: existsSync(slotPath) }
}

async function cleanSlot(slot: string, mainRoot: string): Promise<boolean> {
  console.log(`[team-up] cleaning ${slot}...`)
  const r = await run("bun", ["tools/chief-cleanup-slot.ts", slot, "--target=origin/main"], { cwd: mainRoot })
  if (r.exitCode !== 0) {
    console.warn(`[team-up] cleanup warned for ${slot}:\n${r.stderr || r.stdout}`)
    return false
  }
  console.log(
    r.stdout
      .trim()
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  )
  return true
}

function manifest(slot: string, slotPath: string): string {
  const n = slot.replace(/^wt/, "")
  return [
    "─".repeat(72),
    `MANIFEST for @agent/${n}`,
    "─".repeat(72),
    `Spawn claude in slot with display name (auto-rename via daemon argv parse):`,
    `  cd ${slotPath} && claude --name @agent/${n}`,
    "",
    `--name sets prompt-box / /resume / terminal title AND tribe handle:`,
    `the MCP server reads claude's argv (PPID parse) to get the name`,
    `→ no manual /tribe rename, no env-var prefix.`,
    "",
    `In the session:`,
    `  /tribe send * "online @agent/${n} — ready, awaiting work"`,
    `  # check your queue via your issue tracker, scoped to @agent/${n}`,
    "",
    "Per §17 sound off at: claimed / working / blocked / closed / paused / online / idle / offline",
    "Per §6a clean slot before AND after — chief-cleanup-slot.ts handles it",
    "Per reality-check: read bead body + grep named SHAs at origin/main before claim on any bead older than 24h",
    "",
  ].join("\n")
}

async function main() {
  const args = process.argv.slice(2)
  const slots = parseArgs(args)
  const mainRoot = await gitToplevel()

  console.log(`[team-up] preparing ${slots.length} slot(s): ${slots.join(", ")}`)

  // Prep each slot
  const ready: { slot: string; path: string }[] = []
  for (const slot of slots) {
    const ensure = await ensureSlot(slot, mainRoot)
    if (!ensure.ok) continue
    await cleanSlot(slot, mainRoot)
    ready.push({ slot, path: ensure.path })
  }

  console.log("\n[team-up] DONE. Manifests below — open each in its own claude session:\n")
  for (const { slot, path } of ready) {
    console.log(manifest(slot, path))
  }

  console.log("─".repeat(72))
  console.log(`Chief continues in main repo: cd ${mainRoot}`)
  console.log("Then: /tribe rename chief; sound off online; survey idle slots; fill sigil-board (§14).")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
