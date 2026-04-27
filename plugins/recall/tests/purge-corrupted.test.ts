/**
 * purge-corrupted — end-to-end test for the one-shot quarantine script.
 *
 * Sets up a temp chats dir with mixed clean/corrupted markdown, runs
 * scanChats(), and asserts that only the corrupted files are flagged.
 * Then exercises the CLI with --dry-run and --yes paths.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readFileSync } from "node:fs"
import { scanChats } from "../src/lib/purge-corrupted.ts"

const PURGE_BIN = join(import.meta.dirname, "..", "src", "lib", "purge-corrupted.ts")

let tmpRoot: string
let chatsDir: string
let quarantineDir: string

function writeChat(name: string, content: string): void {
  writeFileSync(join(chatsDir, name), content, "utf-8")
}

const STUCK_LOOP = `# Session 2026-04-26

## Assistant
${"so back to the vault reorg!\n".repeat(30)}`

const CLEAN = readFileSync(
  join(import.meta.dirname, "quality-gate.fixtures", "clean-good.txt"),
  "utf-8",
)

const DECAYED = readFileSync(
  join(import.meta.dirname, "quality-gate.fixtures", "decayed-llm.txt"),
  "utf-8",
)

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "purge-test-"))
  chatsDir = join(tmpRoot, "chats")
  quarantineDir = join(tmpRoot, "chats-quarantine")
  mkdirSync(chatsDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe("scanChats", () => {
  test("returns empty for empty dir", () => {
    expect(scanChats(chatsDir)).toEqual([])
  })

  test("returns empty for non-existent dir", () => {
    expect(scanChats(join(tmpRoot, "does-not-exist"))).toEqual([])
  })

  test("flags only corrupted chats", () => {
    writeChat("clean-1.md", CLEAN)
    writeChat("clean-2.md", CLEAN)
    writeChat("stuck-loop.md", STUCK_LOOP)
    writeChat("decayed.md", DECAYED)
    const bad = scanChats(chatsDir)
    expect(bad).toHaveLength(2)
    const names = bad.map((b) => b.file).sort()
    expect(names).toEqual(["decayed.md", "stuck-loop.md"])
    const reasons = new Set(bad.map((b) => b.reason.split(":")[0]))
    expect(reasons.has("stuck-loop")).toBe(true)
    expect(reasons.has("decayed-llm")).toBe(true)
  })
})

describe("purge-corrupted CLI", () => {
  test("--dry-run reports but moves nothing", () => {
    writeChat("clean.md", CLEAN)
    writeChat("stuck-loop.md", STUCK_LOOP)
    const r = spawnSync(
      "bun",
      [PURGE_BIN, "--chats", chatsDir, "--quarantine", quarantineDir, "--dry-run"],
      { encoding: "utf-8", timeout: 15_000 },
    )
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/2 chats; 1 flagged/)
    expect(r.stderr).toMatch(/Dry run/)
    // Source dir untouched
    const remaining = readdirSync(chatsDir).sort()
    expect(remaining).toEqual(["clean.md", "stuck-loop.md"])
    // Quarantine dir not created
    expect(existsSync(quarantineDir)).toBe(false)
  })

  test("--yes moves corrupted chats and writes .reason sidecars", () => {
    writeChat("clean.md", CLEAN)
    writeChat("stuck-loop.md", STUCK_LOOP)
    writeChat("decayed.md", DECAYED)
    const r = spawnSync(
      "bun",
      [PURGE_BIN, "--chats", chatsDir, "--quarantine", quarantineDir, "--yes"],
      { encoding: "utf-8", timeout: 15_000 },
    )
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/Moved 2 chat\(s\)/)

    // Source dir keeps only the clean one
    const remaining = readdirSync(chatsDir).sort()
    expect(remaining).toEqual(["clean.md"])

    // Quarantine has both bad chats + sidecars
    const quarantined = readdirSync(quarantineDir).sort()
    expect(quarantined).toContain("stuck-loop.md")
    expect(quarantined).toContain("stuck-loop.md.reason")
    expect(quarantined).toContain("decayed.md")
    expect(quarantined).toContain("decayed.md.reason")

    const reason = JSON.parse(readFileSync(join(quarantineDir, "stuck-loop.md.reason"), "utf-8")) as {
      reason: string
      file: string
    }
    expect(reason.reason).toMatch(/^stuck-loop:/)
    expect(reason.file).toBe("stuck-loop.md")
  })

  test("nothing to do when source has only clean chats", () => {
    writeChat("clean-1.md", CLEAN)
    writeChat("clean-2.md", CLEAN)
    const r = spawnSync(
      "bun",
      [PURGE_BIN, "--chats", chatsDir, "--quarantine", quarantineDir, "--yes"],
      { encoding: "utf-8", timeout: 15_000 },
    )
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/Nothing to quarantine/)
    expect(existsSync(quarantineDir)).toBe(false)
  })
})
