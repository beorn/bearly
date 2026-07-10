#!/usr/bin/env bun
// chief-integrate — mechanical-not-agentic integration of an agent's bead-close commit(s).
//
// Replaces the manual cherry-pick-push-confirm dance from chief runbook §3.
// Frame A from a 2026-05-08 retro: chief integration
// was costing ~5 min × 25 cherry-picks/rotation = ~2h of chief work; this collapses
// each one to ~30s.
//
// Usage:
//   bun tools/chief-integrate.ts <slot> [<sha-or-range>] [--dry-run]
//
// Examples:
//   bun tools/chief-integrate.ts wt3 abc1234       # cherry-pick single SHA
//   bun tools/chief-integrate.ts wt3 abc..def      # cherry-pick range
//   bun tools/chief-integrate.ts wt3                # cherry-pick everything wt3 has ahead of origin/main
//   bun tools/chief-integrate.ts wt3 --dry-run      # print plan, do not cherry-pick or push
//
// What it does (in order):
//   1. Validates slot exists at sibling path (../<repo>-<slot>)
//   2. Fetches slot's branch into main repo as a local ref
//   3. Computes commits-to-cherry-pick: explicit arg OR origin/main..wtN
//   4. Cherry-picks each commit with -X theirs for submodule conflicts (default)
//   5. Pushes origin/main
//   6. Tells caller to broadcast the new SHA via tribe.send so the agent can refresh

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
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
    proc.stdout.on("data", (b: Buffer) => (stdout += b.toString()))
    proc.stderr.on("data", (b: Buffer) => (stderr += b.toString()))
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }))
  })
}

/**
 * Resolve the MAIN repo's toplevel — the worktree that owns the .git directory,
 * not a linked worktree. `git worktree list --porcelain` always lists the main
 * repo first. Necessary because chief-integrate is sometimes invoked from a
 * sibling worktree (e.g. ag chief integrate from inside wt1), where
 * `--show-toplevel` would return the wt path and slot-path construction would
 * compute a wrong sibling like `km-wt1-wt5`.
 */
async function gitMainRepo(): Promise<string> {
  const r = await run("git", ["worktree", "list", "--porcelain"])
  if (r.exitCode !== 0) throw new Error("git worktree list failed")
  const m = /^worktree (.+)$/m.exec(r.stdout)
  if (!m?.[1]) throw new Error("could not parse main repo path from git worktree list")
  return m[1].trim()
}

async function main() {
  const rawArgs = process.argv.slice(2)
  const dryRun = rawArgs.includes("--dry-run") || rawArgs.includes("-n")
  const positional = rawArgs.filter((a) => a !== "--dry-run" && a !== "-n")
  const [slotArg, shaArg] = positional
  if (!slotArg) {
    console.error("usage: bun tools/chief-integrate.ts <slot> [<sha-or-range>] [--dry-run]")
    process.exit(2)
  }
  const slot = slotArg.replace(/^wt/, "wt") // accept wt3 or 3
  const main = await gitMainRepo()
  const repoBasename = basename(main)
  const repoParent = dirname(main)
  const slotPath = resolve(repoParent, `${repoBasename}-${slot}`)

  if (!existsSync(slotPath)) {
    console.error(`slot not found at ${slotPath}`)
    process.exit(2)
  }

  console.log(`[chief-integrate] slot=${slot} path=${slotPath}${dryRun ? " (DRY RUN)" : ""}`)

  // 1. Fetch slot's branch into main repo
  const slotBranch = (await run("git", ["-C", slotPath, "branch", "--show-current"])).stdout.trim()
  console.log(`[chief-integrate] slot branch=${slotBranch}`)
  const fetch = await run("git", ["fetch", slotPath, `${slotBranch}:${slotBranch}`, "-f"], { cwd: main })
  if (fetch.exitCode !== 0 && !fetch.stderr.includes("refusing to fetch")) {
    console.error(`fetch failed: ${fetch.stderr}`)
    process.exit(1)
  }

  // 2. Determine cherry-pick range
  const range = shaArg ?? `origin/main..${slotBranch}`
  const log = await run("git", ["log", "--oneline", range], { cwd: main })
  if (log.exitCode !== 0 || !log.stdout.trim()) {
    console.log(`[chief-integrate] nothing to integrate (range=${range})`)
    process.exit(0)
  }
  const commits = log.stdout.trim().split("\n").reverse()
  console.log(`[chief-integrate] commits to cherry-pick (${commits.length}):`)
  commits.forEach((c) => console.log(`  ${c}`))

  if (dryRun) {
    console.log(
      `\n[chief-integrate] DRY RUN — would cherry-pick the ${commits.length} commit(s) above onto main with -X theirs, then push origin/main.`,
    )
    console.log(`[chief-integrate] re-run without --dry-run to apply.`)
    return
  }

  // 3. Cherry-pick with -X theirs for submodule conflicts
  const shas = commits.map((c) => {
    const sha = c.split(" ")[0]
    if (sha === undefined) throw new Error(`chief-integrate: could not parse a SHA from log line "${c}"`)
    return sha
  })
  const cp = await run("git", ["cherry-pick", "-X", "theirs", ...shas], { cwd: main })
  if (cp.exitCode !== 0) {
    console.error(`[chief-integrate] cherry-pick had conflicts:\n${cp.stderr}`)
    console.error(`[chief-integrate] resolve manually with 'git cherry-pick --continue' or 'git cherry-pick --abort'`)
    process.exit(1)
  }

  // 4. Push origin/main
  const push = await run("git", ["push", "origin", "main"], { cwd: main })
  if (push.exitCode !== 0) {
    console.error(`[chief-integrate] push failed: ${push.stderr}`)
    process.exit(1)
  }
  console.log(`[chief-integrate] pushed: ${push.stderr.split("\n").slice(-3).join(" ")}`)

  // 5. Report final SHA so caller can broadcast via tribe
  const finalSha = (await run("git", ["rev-parse", "HEAD"], { cwd: main })).stdout.trim()
  console.log(`\n[chief-integrate] DONE. Final main SHA: ${finalSha}`)
  console.log(`[chief-integrate] Suggested tribe broadcast:`)
  console.log(`  integrated ${slot} → main ${finalSha.slice(0, 9)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
