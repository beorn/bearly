#!/usr/bin/env bun
/**
 * purge-corrupted — quarantine corrupted/decayed/stuck-loop chats.
 *
 * Scans an exported-chats directory, runs the quality gate over each .md,
 * and *moves* (not deletes) failures to a sibling quarantine dir with a
 * .reason sidecar. Reversible: an operator can audit and restore.
 *
 * Defaults to ~/Bear/Vault/raw/chats/ → ~/Bear/Vault/raw/chats-quarantine/.
 * Override with --chats / --quarantine for other vaults or test runs.
 *
 * Safety: prompts for confirmation unless --yes. Always prints a summary.
 *
 * Usage:
 *   bun src/lib/purge-corrupted.ts                    # ~/Bear/Vault/raw/chats/
 *   bun src/lib/purge-corrupted.ts --yes              # skip confirm
 *   bun src/lib/purge-corrupted.ts --dry-run          # report only, move nothing
 *   bun src/lib/purge-corrupted.ts --chats /tmp/...   # custom source
 */
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { analyzeQuality } from "./quality-gate.ts"

const HOME = homedir()
const DEFAULT_CHATS = `${HOME}/Bear/Vault/raw/chats`
const DEFAULT_QUARANTINE = `${HOME}/Bear/Vault/raw/chats-quarantine`

interface Options {
  chatsDir: string
  quarantineDir: string
  yes: boolean
  dryRun: boolean
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    chatsDir: DEFAULT_CHATS,
    quarantineDir: DEFAULT_QUARANTINE,
    yes: false,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--yes" || a === "-y") opts.yes = true
    else if (a === "--dry-run" || a === "-n") opts.dryRun = true
    else if (a === "--chats") opts.chatsDir = argv[++i] ?? opts.chatsDir
    else if (a === "--quarantine") opts.quarantineDir = argv[++i] ?? opts.quarantineDir
    else if (a === "--help" || a === "-h") {
      process.stderr.write(
        `purge-corrupted — quarantine corrupted recall exports\n\n` +
          `usage: purge-corrupted [--chats DIR] [--quarantine DIR] [--yes] [--dry-run]\n\n` +
          `  --chats DIR        source of .md chats (default ${DEFAULT_CHATS})\n` +
          `  --quarantine DIR   destination for bad chats (default ${DEFAULT_QUARANTINE})\n` +
          `  --yes, -y          skip confirmation prompt\n` +
          `  --dry-run, -n      report only, move nothing\n` +
          `  --help, -h         this message\n`,
      )
      process.exit(0)
    } else {
      process.stderr.write(`purge-corrupted: unknown arg "${a}"\n`)
      process.exit(2)
    }
  }
  return opts
}

interface ScanResult {
  file: string
  reason: string
  signals: ReturnType<typeof analyzeQuality>["signals"]
}

export function scanChats(chatsDir: string): ScanResult[] {
  if (!existsSync(chatsDir)) return []
  const files = readdirSync(chatsDir).filter((f) => f.endsWith(".md"))
  const bad: ScanResult[] = []
  for (const f of files) {
    const path = join(chatsDir, f)
    let text: string
    try {
      text = readFileSync(path, "utf-8")
    } catch {
      continue
    }
    const verdict = analyzeQuality(text)
    if (verdict.rejectReason) {
      bad.push({ file: f, reason: verdict.rejectReason, signals: verdict.signals })
    }
  }
  return bad
}

function prompt(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(question)
    let buf = ""
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8")
      if (buf.includes("\n")) {
        process.stdin.off("data", onData)
        process.stdin.pause()
        resolve(/^\s*y(es)?\s*$/i.test(buf.trim()))
      }
    }
    process.stdin.on("data", onData)
    process.stdin.resume()
  })
}

function summarizeReasons(bad: ScanResult[]): string {
  const counts = new Map<string, number>()
  for (const b of bad) counts.set(b.reason, (counts.get(b.reason) ?? 0) + 1)
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  return sorted.map(([r, c]) => `  ${c.toString().padStart(4, " ")}  ${r}`).join("\n")
}

async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv)

  if (!existsSync(opts.chatsDir)) {
    process.stderr.write(`purge-corrupted: chats dir does not exist: ${opts.chatsDir}\n`)
    process.exit(1)
  }
  if (!statSync(opts.chatsDir).isDirectory()) {
    process.stderr.write(`purge-corrupted: not a directory: ${opts.chatsDir}\n`)
    process.exit(1)
  }

  process.stderr.write(`Scanning ${opts.chatsDir} ...\n`)
  const bad = scanChats(opts.chatsDir)
  const totalFiles = readdirSync(opts.chatsDir).filter((f) => f.endsWith(".md")).length
  process.stderr.write(`Scanned ${totalFiles} chats; ${bad.length} flagged.\n`)

  if (bad.length === 0) {
    process.stderr.write("Nothing to quarantine.\n")
    return
  }

  process.stderr.write(`\nReason breakdown:\n${summarizeReasons(bad)}\n\n`)

  if (opts.dryRun) {
    process.stderr.write("Dry run — listing flagged files (no changes made):\n")
    for (const b of bad.slice(0, 20)) {
      process.stderr.write(`  ${b.reason.padEnd(32)} ${b.file}\n`)
    }
    if (bad.length > 20) process.stderr.write(`  ... and ${bad.length - 20} more\n`)
    return
  }

  if (!opts.yes) {
    const confirmed = await prompt(
      `Move ${bad.length} corrupted chat(s) from ${opts.chatsDir} to ${opts.quarantineDir}? [y/N] `,
    )
    if (!confirmed) {
      process.stderr.write("Aborted.\n")
      return
    }
  }

  if (!existsSync(opts.quarantineDir)) mkdirSync(opts.quarantineDir, { recursive: true })

  let moved = 0
  let failed = 0
  for (const b of bad) {
    const src = join(opts.chatsDir, b.file)
    const dst = join(opts.quarantineDir, b.file)
    try {
      renameSync(src, dst)
      writeFileSync(
        `${dst}.reason`,
        JSON.stringify(
          {
            file: b.file,
            quarantinedAt: new Date().toISOString(),
            reason: b.reason,
            signals: b.signals,
          },
          null,
          2,
        ),
        "utf-8",
      )
      moved++
    } catch (err) {
      process.stderr.write(`  failed to move ${b.file}: ${(err as Error).message}\n`)
      failed++
    }
  }

  process.stderr.write(`\nMoved ${moved} chat(s) to ${opts.quarantineDir}.\n`)
  if (failed > 0) process.stderr.write(`${failed} failure(s).\n`)
}

if (import.meta.main) {
  await main(process.argv.slice(2))
}
