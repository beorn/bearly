/**
 * `bun llm install-skills [<target-dir>]` — copy bundled skill markdowns into
 * a Claude Code skills directory.
 *
 * Why: @bearly/llm ships SKILL.md files for /ask, /pro, /deep, /fresh, /big
 * inside `skills/`. Standalone consumers who want the slash-command UX in
 * Claude Code need them under `~/.claude/skills/`. This subcommand bridges
 * the published-tarball → user-skills-dir gap with a tiny copier.
 *
 * Resolution:
 *   - Default target: `process.env.CLAUDE_SKILLS_DIR` || `~/.claude/skills`
 *   - First positional argv (if non-flag) overrides the env/default.
 *   - With `--yes`/`-y`, overwrites without prompting (read on stderr/TTY).
 *   - Without `--yes`, prompts per-collision and skips when answer ≠ "y".
 *
 * Output: stderr human-readable lines per skill (✓ copied, ↻ overwrote,
 * — skipped). JSON envelope on stdout if `--json` is set.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { emitJson, isJsonMode } from "../lib/output-mode"

/** Directory inside the npm tarball that holds the bundled skills. Resolved
 * via import.meta.url so it works when @bearly/llm is installed under
 * node_modules and when running from source. */
function getBundledSkillsDir(): string {
  // src/cmd/install-skills.ts → ../../skills (when running from src/) or
  // dist/cmd/install-skills.mjs → ../../skills (when running from dist/).
  const here = new URL(".", import.meta.url).pathname
  // Walk up two levels — `cmd` → `src`/`dist` → package root.
  return path.resolve(here, "..", "..", "skills")
}

/** The skills we ship and their layout. Only the SKILL.md is required;
 * helper docs (templates/, *.md) are copied if present. */
const BUNDLED_SKILL_NAMES = ["ask", "pro", "deep", "fresh", "big"] as const

interface CopyResult {
  skill: string
  status: "copied" | "overwrote" | "skipped" | "missing-source"
  destination: string
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDirRecursive(s, d)
    else if (entry.isFile()) fs.copyFileSync(s, d)
  }
}

async function promptOverwrite(skill: string): Promise<boolean> {
  // Best-effort interactive prompt. In non-TTY contexts (CI, scripts), default
  // to "no overwrite" so we never silently clobber user-customized skills.
  if (!process.stdin.isTTY) return false
  process.stderr.write(`  ↳ ${skill} already exists — overwrite? [y/N] `)
  return await new Promise<boolean>((resolve) => {
    const onData = (chunk: Buffer): void => {
      const answer = chunk.toString("utf-8").trim().toLowerCase()
      process.stdin.removeListener("data", onData)
      try {
        if (process.stdin.setRawMode) process.stdin.setRawMode(false)
      } catch {}
      process.stdin.pause()
      resolve(answer.startsWith("y"))
    }
    process.stdin.resume()
    process.stdin.once("data", onData)
  })
}

export async function runInstallSkills(opts: { targetDir?: string; yes?: boolean }): Promise<void> {
  const home = process.env.HOME || ""
  const target =
    opts.targetDir ?? process.env.CLAUDE_SKILLS_DIR ?? (home ? path.join(home, ".claude", "skills") : ".claude/skills")
  const sourceRoot = getBundledSkillsDir()

  if (!fs.existsSync(sourceRoot)) {
    const msg = `bundled skills dir not found at ${sourceRoot}`
    if (isJsonMode()) emitJson({ status: "failed", error: msg })
    console.error(`error: ${msg}`)
    process.exit(1)
  }

  fs.mkdirSync(target, { recursive: true })
  console.error(`Installing @bearly/llm skills → ${target}`)

  const results: CopyResult[] = []
  for (const skill of BUNDLED_SKILL_NAMES) {
    const src = path.join(sourceRoot, skill)
    const dest = path.join(target, skill)
    if (!fs.existsSync(src)) {
      results.push({ skill, status: "missing-source", destination: dest })
      console.error(`  — ${skill}: missing in bundle (skipped)`)
      continue
    }
    const exists = fs.existsSync(dest)
    if (exists && !opts.yes) {
      const ok = await promptOverwrite(skill)
      if (!ok) {
        results.push({ skill, status: "skipped", destination: dest })
        console.error(`  — ${skill}: kept existing (skipped)`)
        continue
      }
    }
    copyDirRecursive(src, dest)
    const status = exists ? "overwrote" : "copied"
    results.push({ skill, status, destination: dest })
    console.error(`  ${status === "copied" ? "✓" : "↻"} ${skill}: ${status}`)
  }

  const summary = {
    target,
    copied: results.filter((r) => r.status === "copied").length,
    overwrote: results.filter((r) => r.status === "overwrote").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    missing: results.filter((r) => r.status === "missing-source").length,
    skills: results,
  }
  console.error(
    `\nDone. copied=${summary.copied} overwrote=${summary.overwrote} skipped=${summary.skipped} missing=${summary.missing}`,
  )
  if (isJsonMode()) emitJson({ status: "completed", ...summary })
}
