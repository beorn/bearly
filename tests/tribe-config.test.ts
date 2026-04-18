/**
 * Tribe config — resolveDbPath behavior, especially the legacy `.beads/tribe.db`
 * migration (see km-tribe.decouple-db-location).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { resolveDbPath } from "../tools/lib/tribe/config.ts"

function makeTmp(): string {
  return mkdtempSync(resolve(tmpdir(), "tribe-config-test-"))
}

describe("resolveDbPath", () => {
  let tmp: string
  let originalHome: string | undefined
  let originalXdg: string | undefined
  let originalDb: string | undefined

  beforeEach(() => {
    tmp = makeTmp()
    originalHome = process.env.HOME
    originalXdg = process.env.XDG_DATA_HOME
    originalDb = process.env.TRIBE_DB
    delete process.env.TRIBE_DB
    // Route XDG into our tmp so the test never touches real data.
    process.env.XDG_DATA_HOME = resolve(tmp, "xdg")
    // Same for HOME — findBeadsDir walks up from cwd, so the test's cwd
    // controls whether a legacy .beads/ is found.
    process.env.HOME = resolve(tmp, "home")
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = originalXdg
    if (originalDb === undefined) delete process.env.TRIBE_DB
    else process.env.TRIBE_DB = originalDb
    rmSync(tmp, { recursive: true, force: true })
  })

  test("--db flag wins", () => {
    const explicit = resolve(tmp, "explicit.db")
    expect(resolveDbPath({ db: explicit } as { db: string })).toBe(explicit)
  })

  test("TRIBE_DB env wins when flag absent", () => {
    const viaEnv = resolve(tmp, "via-env.db")
    process.env.TRIBE_DB = viaEnv
    expect(resolveDbPath({})).toBe(viaEnv)
  })

  test("defaults to user-global XDG path (not .beads/)", () => {
    const got = resolveDbPath({})
    expect(got).toBe(resolve(process.env.XDG_DATA_HOME!, "tribe", "tribe.db"))
    expect(existsSync(resolve(process.env.XDG_DATA_HOME!, "tribe"))).toBe(true)
  })

  test("migrates legacy .beads/tribe.db forward when XDG is empty", () => {
    // Set up a legacy layout: cwd has .beads/tribe.db with content.
    const originalCwd = process.cwd()
    const project = resolve(tmp, "project")
    const legacyBeads = resolve(project, ".beads")
    mkdirSync(legacyBeads, { recursive: true })
    const legacyDb = resolve(legacyBeads, "tribe.db")
    writeFileSync(legacyDb, "LEGACY-DB-BYTES")
    writeFileSync(`${legacyDb}-wal`, "LEGACY-WAL-BYTES")

    try {
      process.chdir(project)
      const resolved = resolveDbPath({})
      const xdgDb = resolve(process.env.XDG_DATA_HOME!, "tribe", "tribe.db")
      expect(resolved).toBe(xdgDb)
      // Legacy files moved.
      expect(existsSync(legacyDb)).toBe(false)
      expect(existsSync(`${legacyDb}-wal`)).toBe(false)
      // XDG holds the original bytes.
      expect(existsSync(xdgDb)).toBe(true)
      expect(existsSync(`${xdgDb}-wal`)).toBe(true)
      // Breadcrumb points at new location.
      expect(existsSync(`${legacyDb}.moved`)).toBe(true)
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("XDG path wins when both legacy and XDG exist (no migration)", () => {
    // XDG DB exists with one set of bytes; legacy DB has different bytes.
    const xdgTribeDir = resolve(process.env.XDG_DATA_HOME!, "tribe")
    mkdirSync(xdgTribeDir, { recursive: true })
    const xdgDb = resolve(xdgTribeDir, "tribe.db")
    writeFileSync(xdgDb, "XDG-DB-BYTES")

    const originalCwd = process.cwd()
    const project = resolve(tmp, "project")
    const legacyBeads = resolve(project, ".beads")
    mkdirSync(legacyBeads, { recursive: true })
    const legacyDb = resolve(legacyBeads, "tribe.db")
    writeFileSync(legacyDb, "LEGACY-DB-BYTES")

    try {
      process.chdir(project)
      const resolved = resolveDbPath({})
      expect(resolved).toBe(xdgDb)
      // Legacy is untouched — XDG wins without migration.
      expect(existsSync(legacyDb)).toBe(true)
    } finally {
      process.chdir(originalCwd)
    }
  })
})
