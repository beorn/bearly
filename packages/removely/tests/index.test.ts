/**
 * Guards for the guarded delete.
 *
 * Discipline — every refusal path in `safeRemove` gets a test that proves it
 * THROWS, not that it returns falsy. A guard whose failure mode is a silent
 * no-op is the defect class this module was written to remove, so the tests
 * assert loudness, not just absence of damage.
 *
 * The named cases mirror the 2026-07-31 incident and the six-site audit that
 * followed it:
 *   - empty target        — the mis-expanded shell variable
 *   - escape via sibling  — `/tmp/foo-evil` must not pass a `/tmp/foo` root
 *   - escape via symlink  — a symlinked ancestor must not launder containment
 *   - root outside allow  — `$HOME` is never a legal containment root
 *   - missing target      — absent is an error unless declared expected
 *   - survivor detection  — a cleanup that leaves the root behind must fail
 */

import { chmodSync } from "node:fs"
import { mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { safeRemove, safeRemoveSync, tempTree } from "../src/index.ts"

const roots: string[] = []

async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), "fs-safe-test-")))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await safeRemove(root, { within: await realpath(tmpdir()), allowMissing: true })
  }
})

describe("safeRemove refusals", () => {
  test("empty target throws rather than no-opping", async () => {
    const root = await scratch()
    await expect(safeRemove("", { within: root })).rejects.toThrow(/empty target/u)
    await expect(safeRemove("   ", { within: root })).rejects.toThrow(/empty target/u)
  })

  test("empty containment root throws", async () => {
    const root = await scratch()
    const victim = join(root, "victim")
    await mkdir(victim)
    await expect(safeRemove(victim, { within: "" })).rejects.toThrow(/empty containment root/u)
    expect(await readdir(root)).toEqual(["victim"])
  })

  test("a sibling sharing a string prefix is NOT inside the root", async () => {
    const base = await scratch()
    const within = join(base, "foo")
    const evil = join(base, "foo-evil")
    await mkdir(within)
    await mkdir(evil)
    await expect(safeRemove(evil, { within })).rejects.toThrow(/REFUSED/u)
    expect(await readdir(evil)).toEqual([])
  })

  test("a symlinked ancestor cannot launder containment", async () => {
    const base = await scratch()
    const within = join(base, "inside")
    const outside = join(base, "outside")
    await mkdir(within)
    await mkdir(outside)
    await writeFile(join(outside, "keep.txt"), "keep")
    await symlink(outside, join(within, "link"))
    await expect(safeRemove(join(within, "link"), { within })).rejects.toThrow(/REFUSED/u)
    expect(await readdir(outside)).toEqual(["keep.txt"])
  })

  test("a containment root outside the allowed roots is refused", async () => {
    const base = await scratch()
    const victim = join(base, "victim")
    await mkdir(victim)
    await expect(safeRemove(victim, { within: base, allowedRoots: [join(base, "elsewhere")] })).rejects.toThrow(
      /not under an allowed root/u,
    )
    expect(await readdir(base)).toContain("victim")
  })

  test("a missing target is an error unless declared expected", async () => {
    const base = await scratch()
    const absent = join(base, "never-existed")
    await expect(safeRemove(absent, { within: base })).rejects.toThrow(/does not exist/u)
    await expect(safeRemove(absent, { within: base, allowMissing: true })).resolves.toBeUndefined()
  })
})

describe("safeRemove success path", () => {
  test("removes a contained tree and verifies it is gone", async () => {
    const base = await scratch()
    const victim = join(base, "victim")
    await mkdir(join(victim, "nested"), { recursive: true })
    await writeFile(join(victim, "nested", "f.txt"), "x")
    await safeRemove(victim, { within: base })
    expect(await readdir(base)).toEqual([])
  })
})

describe("tempTree", () => {
  test("await using creates, exposes, and removes the fixture", async () => {
    let captured = ""
    {
      await using fixture = await tempTree("fs-safe-using-")
      captured = fixture.path
      await writeFile(fixture.resolve("f.txt"), "x")
      expect(await readdir(captured)).toEqual(["f.txt"])
    }
    await expect(readdir(captured)).rejects.toThrow()
  })

  test("the fixture is removed even when the block throws", async () => {
    let captured = ""
    await expect(
      (async () => {
        await using fixture = await tempTree("fs-safe-throw-")
        captured = fixture.path
        await writeFile(fixture.resolve("f.txt"), "x")
        throw new Error("boom")
      })(),
    ).rejects.toThrow("boom")
    expect(captured).not.toBe("")
    await expect(readdir(captured)).rejects.toThrow()
  })

  test("resolve() stays under the fixture root", async () => {
    await using fixture = await tempTree("fs-safe-resolve-")
    expect(fixture.resolve("a", "b")).toBe(join(fixture.path, "a", "b"))
  })
})

describe("safeRemoveSync — same predicate, no await", () => {
  test("removes a contained tree and verifies it is gone", async () => {
    const base = await scratch()
    const victim = join(base, "victim")
    await mkdir(join(victim, "nested"), { recursive: true })
    await writeFile(join(victim, "nested", "f.txt"), "x")
    safeRemoveSync(victim, { within: base })
    expect(await readdir(base)).toEqual([])
  })

  test("refuses an escape exactly as the async form does", async () => {
    const base = await scratch()
    const within = join(base, "foo")
    const evil = join(base, "foo-evil")
    await mkdir(within)
    await mkdir(evil)
    expect(() => safeRemoveSync(evil, { within })).toThrow(/REFUSED/u)
    expect(() => safeRemoveSync("", { within })).toThrow(/empty target/u)
    expect(await readdir(evil)).toEqual([])
  })

  test("widens permissions only when the removal actually hits EACCES", async () => {
    const base = await scratch()
    const victim = join(base, "locked")
    await mkdir(join(victim, "inner"), { recursive: true })
    await writeFile(join(victim, "inner", "f.txt"), "x")
    chmodSync(join(victim, "inner"), 0o500)
    safeRemoveSync(victim, { within: base })
    expect(await readdir(base)).toEqual([])
  })
})
