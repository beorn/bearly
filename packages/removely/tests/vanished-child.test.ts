/**
 * A child that vanishes mid-walk is not a missing target.
 *
 * Bun's recursive `rm` reports a child removed underneath it — git's detached
 * auto-maintenance, a sibling cleanup — as ENOENT on the ROOT, while the root
 * and its other children survive (measured on Bun 1.4.2: 2 of 60 rounds with a
 * concurrent deleter inside `project/.git`; bearly CI run 36965995135 threw
 * "still exists after removal … Survivors: project, xdg-data … ENOENT").
 * The remover must retry that case, not read it as `allowMissing` absence.
 * The race is mocked here so the row is deterministic.
 *
 * @failure  a cleanup racing a background writer throws "still exists after removal" instead of retrying
 * @level    l1
 * @consumer safeRemove / safeRemoveSync; bearly CI run 36965995135 (cursor-store teardown)
 * @reach    fs-walk <fixture-only: tmpdir fixtures>
 * @testonly none
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"

// Root setup imports Removely before this suite; reload it so `rm` binds to the mock below.
vi.hoisted(() => vi.resetModules())
const vanish = vi.hoisted(() => ({ pending: 0, target: "", probes: 0, error: "", dangling: false }))

function rootEnoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, rm '${path}'`), {
    code: "ENOENT",
    path,
    syscall: "rm",
  })
}

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>()
  return {
    ...real,
    lstatSync: (...args: Parameters<typeof real.lstatSync>) => {
      const result = real.lstatSync(...args)
      if (args[0] === vanish.target && ++vanish.probes === 2) {
        // Initial presence was checked; this is the containment anchor's probe.
        const target = vanish.target
        vanish.target = ""
        if (vanish.error !== "") throw Object.assign(new Error(vanish.error), { code: vanish.error })
        safeRemoveSync(target, { within: base })
        if (vanish.dangling) real.symlinkSync("missing-target", target, "dir")
      }
      return result
    },
    rmSync: (path: string, options?: import("node:fs").RmOptions) => {
      if (vanish.pending > 0) {
        vanish.pending--
        throw rootEnoent(path)
      }
      return real.rmSync(path, options)
    },
  }
})

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...real,
    rm: async (path: string, options?: import("node:fs").RmOptions) => {
      if (vanish.pending > 0) {
        vanish.pending--
        throw rootEnoent(path)
      }
      return real.rm(path, options)
    },
  }
})

const { safeRemove, safeRemoveSync } = await import("../src/index.ts")

const base = realpathSync(tmpdir())
let root = ""

function fixture(): string {
  root = mkdtempSync(join(base, "removely-vanished-child-"))
  mkdirSync(join(root, "project/.git"), { recursive: true })
  mkdirSync(join(root, "xdg-data"), { recursive: true })
  writeFileSync(join(root, "xdg-data/cursor.json"), "{}")
  return root
}

afterEach(() => {
  vanish.pending = 0
  vanish.target = ""
  vanish.probes = 0
  vanish.error = ""
  vanish.dangling = false
  if (root !== "" && existsSync(root)) safeRemoveSync(root, { within: base })
  root = ""
})

describe("ENOENT on a root that still exists", () => {
  test.each([true, false])("is retried, not taken as absence (sync=%s)", async (synchronous) => {
    const target = fixture()
    vanish.pending = 1
    if (synchronous) safeRemoveSync(target, { within: base, allowMissing: true })
    else await safeRemove(target, { within: base, allowMissing: true })
    expect(vanish.pending).toBe(0)
    expect(existsSync(target)).toBe(false)
  })

  test.each([true, false])("still fails loud once retries are spent (sync=%s)", async (synchronous) => {
    const target = fixture()
    vanish.pending = 10
    const options = { within: base, allowMissing: true, retries: 2 }
    if (synchronous) expect(() => safeRemoveSync(target, options)).toThrow(/still exists after removal.*ENOENT/su)
    else await expect(safeRemove(target, options)).rejects.toThrow(/still exists after removal.*ENOENT/su)
    expect(existsSync(target)).toBe(true)
  })
})

describe("absence during containment validation", () => {
  test.each([
    { synchronous: true, allowMissing: true },
    { synchronous: false, allowMissing: true },
    { synchronous: true, allowMissing: false },
    { synchronous: false, allowMissing: false },
  ])("sync=$synchronous, allowMissing=$allowMissing", async ({ synchronous, allowMissing }) => {
    const target = fixture()
    vanish.target = target
    // Unlike the retries getter in the after-validation suite, the second
    // lstat removes the anchor BEFORE realpath can resolve it (#28672).
    if (synchronous) {
      if (allowMissing) expect(() => safeRemoveSync(target, { within: base, allowMissing })).not.toThrow()
      else expect(() => safeRemoveSync(target, { within: base, allowMissing })).toThrow(/containment/u)
    } else if (allowMissing) {
      await expect(safeRemove(target, { within: base, allowMissing })).resolves.toBeUndefined()
    } else {
      await expect(safeRemove(target, { within: base, allowMissing })).rejects.toThrow(/containment/u)
    }
    expect(vanish.probes).toBe(2)
    expect(existsSync(target)).toBe(false)
  })

  test.each([true, false])("permission errors stay loud (sync=%s)", async (synchronous) => {
    const target = fixture()
    vanish.target = target
    vanish.error = "EACCES"
    if (synchronous) expect(() => safeRemoveSync(target, { within: base, allowMissing: true })).toThrow(/EACCES/u)
    else await expect(safeRemove(target, { within: base, allowMissing: true })).rejects.toThrow(/EACCES/u)
    expect(vanish.probes).toBe(2)
    expect(existsSync(target)).toBe(true)
  })
})

test.each([true, false])("a raced-in dangling symlink stays loud (sync=%s)", async (synchronous) => {
  const target = fixture()
  vanish.target = target
  vanish.dangling = true
  try {
    if (synchronous) expect(() => safeRemoveSync(target, { within: base, allowMissing: true })).toThrow(/containment/u)
    else await expect(safeRemove(target, { within: base, allowMissing: true })).rejects.toThrow(/containment/u)
    expect(vanish.probes).toBe(2)
    // existsSync follows links, so the fresh entry check must use lstat.
    const entry = await (await import("node:fs/promises")).lstat(target)
    expect(entry.isSymbolicLink()).toBe(true)
  } finally {
    safeRemoveSync(target, { within: base, symlinkLeaf: "unlink", allowMissing: true })
  }
})
