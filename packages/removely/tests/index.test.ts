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

import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { execFileSync, spawnSync } from "node:child_process"
import { lstat, mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, parse, relative } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  findAncestorWithin,
  findGitProjectRoot,
  findProjectAncestor,
  isStrictlyInside,
  resolveContainedPath,
  safeRemove,
  safeRemoveSync,
  tempTree,
} from "../src/index.ts"

const roots: string[] = []

async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), "fs-safe-test-")))
  roots.push(dir)
  return dir
}

function projectScratch(): string {
  const root = mkdtempSync(join(tmpdir(), "removely-project-boundary-"))
  roots.push(root)
  return root
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await safeRemove(root, { within: await realpath(tmpdir()), allowMissing: true })
  }
})

describe("isStrictlyInside — the containment question, exported", () => {
  // The literal trap. Every hand-rolled copy that got this wrong got it wrong
  // here, and two of them guarded a recursive delete.
  test("a sibling sharing a string prefix is NOT inside", () => {
    expect(isStrictlyInside("/repo-evil", "/repo")).toBe(false)
    expect(isStrictlyInside("/repo-evil/nested/deep", "/repo")).toBe(false)
  })

  test("a real descendant is inside", () => {
    expect(isStrictlyInside("/repo/pkg", "/repo")).toBe(true)
    expect(isStrictlyInside("/repo/pkg/src/index.ts", "/repo")).toBe(true)
  })

  test("strict: a path is not inside itself", () => {
    expect(isStrictlyInside("/repo", "/repo")).toBe(false)
  })

  test("a trailing separator on the root does not change the answer", () => {
    expect(isStrictlyInside("/repo/pkg", "/repo/")).toBe(true)
    expect(isStrictlyInside("/repo-evil", "/repo/")).toBe(false)
  })

  // `relative()`-based copies answered this one differently from each other:
  // one read the leading `..` of `..foo` as an escape and refused a path that
  // is genuinely inside. Prefix-plus-separator has no such ambiguity.
  test("a child whose name begins with dots is inside", () => {
    expect(isStrictlyInside("/repo/..foo", "/repo")).toBe(true)
  })

  test("the parent is not inside its own child", () => {
    expect(isStrictlyInside("/repo", "/repo/pkg")).toBe(false)
  })
})

describe("resolveContainedPath — one physical containment constructor", () => {
  test("proves existing and prospective descendants", async () => {
    const base = await scratch()
    const within = join(base, "within")
    await mkdir(within)

    expect(resolveContainedPath(join(within, "existing"), within)).toBe(join(within, "existing"))
    expect(resolveContainedPath(join(within, "new", "nested.md"), within)).toBe(join(within, "new", "nested.md"))
  })

  test("refuses traversal and a prospective write through a symlink ancestor", async () => {
    const base = await scratch()
    const within = join(base, "within")
    const outside = join(base, "outside")
    await mkdir(within)
    await mkdir(outside)
    await symlink(outside, join(within, "escape"))

    expect(() => resolveContainedPath(join(within, "..", "outside", "victim.md"), within)).toThrow(/REFUSED/u)
    expect(() => resolveContainedPath(join(within, "escape", "new.md"), within)).toThrow(/REFUSED/u)
  })

  test("root equality is explicit and symlink-leaf following is selectable", async () => {
    const base = await scratch()
    const within = join(base, "within")
    const outside = join(base, "outside")
    await mkdir(within)
    await mkdir(outside)
    await writeFile(join(outside, "target.md"), "keep")
    const link = join(within, "link.md")
    await symlink(join(outside, "target.md"), link)

    expect(() => resolveContainedPath(within, within)).toThrow(/REFUSED/u)
    expect(resolveContainedPath(within, within, { allowRoot: true })).toBe(await realpath(within))
    expect(() => resolveContainedPath(link, within)).toThrow(/REFUSED/u)
    expect(resolveContainedPath(link, within, { followLeaf: false })).toBe(link)
  })

  test("refuses a dangling symlink leaf instead of branding its unresolved destination", async () => {
    const base = await scratch()
    const within = join(base, "within")
    await mkdir(within)
    const link = join(within, "dangling.md")
    await symlink(join(base, "absent-outside.md"), link)

    expect(() => resolveContainedPath(link, within)).toThrow(/cannot prove physical containment/u)
    expect(resolveContainedPath(link, within, { followLeaf: false })).toBe(link)
  })
})

describe("findAncestorWithin — bounded physical ancestor discovery", () => {
  test("walks inclusively through the boundary and never visits its parent", async () => {
    const base = await scratch()
    const within = join(base, "within")
    const start = join(within, "nested", "leaf")
    await mkdir(start, { recursive: true })

    expect(findAncestorWithin(start, within, (directory) => directory === start)).toBe(start)

    const visited: string[] = []
    expect(
      findAncestorWithin(start, within, (directory) => {
        visited.push(directory)
        return directory === base
      }),
    ).toBeNull()
    expect(visited).toEqual([start, join(within, "nested"), within])
  })

  test("follows an internal symlink physically and refuses an escaping symlink", async () => {
    const base = await scratch()
    const within = join(base, "within")
    const physical = join(within, "physical")
    const nested = join(physical, "nested")
    const outside = join(base, "outside")
    await mkdir(nested, { recursive: true })
    await mkdir(outside)
    await symlink(physical, join(within, "alias"))
    await symlink(outside, join(within, "escape"))

    expect(findAncestorWithin(join(within, "alias", "nested"), within, (directory) => directory === physical)).toBe(
      physical,
    )
    expect(() => findAncestorWithin(join(within, "escape"), within, () => true)).toThrow(/REFUSED/u)
  })

  test("terminates at the platform filesystem root when no ancestor matches", async () => {
    const base = await scratch()
    expect(findAncestorWithin(base, parse(base).root, () => false)).toBeNull()
  })
})

describe("findGitProjectRoot — not-repo is distinct from probe failure", () => {
  test("returns null only for an existing directory outside Git", async () => {
    const base = await scratch()
    expect(findGitProjectRoot(base)).toBeNull()
  })

  test("returns null for a nonexistent directory", async () => {
    const base = await scratch()
    expect(findGitProjectRoot(join(base, "missing"))).toBeNull()
  })

  test("inherits the nearest Git island for a prospective path", async () => {
    const base = await scratch()
    const outer = join(base, "outer")
    const nested = join(outer, "nested")
    await mkdir(nested, { recursive: true })
    execFileSync("git", ["init", "--quiet", outer])
    execFileSync("git", ["init", "--quiet", nested])

    expect(findGitProjectRoot(join(nested, "future", "deep"))).toBe(nested)
  })

  test("throws when the requested path exists but is not a directory", async () => {
    const base = await scratch()
    const file = join(base, "file.txt")
    await writeFile(file, "not a directory")
    expect(() => findGitProjectRoot(file)).toThrow(/git project boundary probe failed/u)
  })

  test("throws when a prospective path crosses an existing non-directory", async () => {
    const base = await scratch()
    const file = join(base, "file.txt")
    await writeFile(file, "not a directory")
    expect(() => findGitProjectRoot(join(file, "missing"))).toThrow()
  })

  test("throws for a blank working directory", () => {
    expect(() => findGitProjectRoot("   ")).toThrow(/git project boundary probe failed.*empty cwd/u)
  })
})

/**
 * @failure Ancestor discovery crosses an independent project island or stops at a superproject boundary.
 * @level l0 — exercises project-boundary resolution against real temporary Git repositories.
 * @consumer Hab config and Ag controller/materialization project discovery.
 */
describe("findProjectAncestor — project-bounded ancestor discovery", () => {
  test("uses an independent nested repository as its own discovery island", () => {
    const outer = projectScratch()
    git(outer, "init", "-q")
    const nestedRepo = join(outer, "foreign")
    mkdirSync(nestedRepo)
    git(nestedRepo, "init", "-q")
    const cwd = join(nestedRepo, "deep", "work")
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(outer, "marker"), "outer\n")

    expect(findProjectAncestor(cwd, (directory) => existsSync(join(directory, "marker")))).toBeNull()
  })

  test("uses the enclosing repository for ordinary same-project nesting", () => {
    const root = projectScratch()
    git(root, "init", "-q")
    const cwd = join(root, "apps", "silver")
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(root, "marker"), "project\n")

    expect(findProjectAncestor(cwd, (directory) => existsSync(join(directory, "marker")))).toBe(root)
  })

  test("uses the superproject boundary for a product submodule", () => {
    const fixture = projectScratch()
    const productSource = join(fixture, "product-source")
    const superproject = join(fixture, "superproject")
    mkdirSync(productSource)
    mkdirSync(superproject)
    git(productSource, "init", "-q")
    git(productSource, "config", "user.email", "test@example.com")
    git(productSource, "config", "user.name", "Test")
    writeFileSync(join(productSource, "README.md"), "product\n")
    git(productSource, "add", "README.md")
    git(productSource, "commit", "-qm", "fixture")
    git(superproject, "init", "-q")
    git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", "-q", productSource, "product")
    const cwd = join(superproject, "product", "packages", "app")
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(superproject, "marker"), "superproject\n")

    expect(findProjectAncestor(cwd, (directory) => existsSync(join(directory, "marker")))).toBe(superproject)
  })

  test("keeps filesystem-root ancestry available outside Git", () => {
    const root = projectScratch()
    const cwd = join(root, "plain", "nested")
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(root, "marker"), "filesystem\n")

    expect(
      findProjectAncestor(relative(process.cwd(), cwd), (directory) => existsSync(join(directory, "marker"))),
    ).toBe(root)
  })

  test("keeps filesystem-root ancestry available from a prospective missing directory", () => {
    const root = projectScratch()
    writeFileSync(join(root, "marker"), "filesystem\n")

    expect(findProjectAncestor(join(root, "missing"), (directory) => existsSync(join(directory, "marker")))).toBe(root)
  })

  test("an operational Git probe failure does not widen discovery to filesystem root", () => {
    const root = projectScratch()
    const notDirectory = join(root, "not-directory")
    writeFileSync(notDirectory, "file\n")

    expect(() => findProjectAncestor(notDirectory, () => false)).toThrow(/git project boundary probe failed/u)
  })
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

  test("explicitly unlinks a symlink leaf without following its outside target", async () => {
    const base = await scratch()
    const within = join(base, "inside")
    const outside = join(base, "outside")
    const link = join(within, "outside-link")
    await mkdir(within)
    await mkdir(outside)
    await writeFile(join(outside, "must-survive.txt"), "survives")
    await symlink(outside, link)

    await safeRemove(link, { within, symlinkLeaf: "unlink" })

    await expect(lstat(link)).rejects.toThrow()
    expect(await readdir(outside)).toEqual(["must-survive.txt"])
  })

  test("refuses a symlink leaf by default without deleting its target", async () => {
    const base = await scratch()
    const within = join(base, "inside")
    const target = join(within, "target")
    const link = join(within, "target-link")
    await mkdir(target, { recursive: true })
    await writeFile(join(target, "must-survive.txt"), "survives")
    await symlink(target, link)

    await expect(safeRemove(link, { within })).rejects.toThrow(/symlink leaf.*symlinkLeaf: "unlink"/u)

    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readdir(target)).toEqual(["must-survive.txt"])
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

  test("explicitly unlinks a symlink leaf without following its outside target", async () => {
    const base = await scratch()
    const within = join(base, "inside")
    const outside = join(base, "outside")
    const link = join(within, "outside-link")
    await mkdir(within)
    await mkdir(outside)
    await writeFile(join(outside, "must-survive.txt"), "survives")
    await symlink(outside, link)

    safeRemoveSync(link, { within, symlinkLeaf: "unlink" })

    await expect(lstat(link)).rejects.toThrow()
    expect(await readdir(outside)).toEqual(["must-survive.txt"])
  })

  test("refuses a symlink leaf by default without deleting its target", async () => {
    const base = await scratch()
    const within = join(base, "inside")
    const target = join(within, "target")
    const link = join(within, "target-link")
    await mkdir(target, { recursive: true })
    await writeFile(join(target, "must-survive.txt"), "survives")
    await symlink(target, link)

    expect(() => safeRemoveSync(link, { within })).toThrow(/symlink leaf.*symlinkLeaf: "unlink"/u)

    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readdir(target)).toEqual(["must-survive.txt"])
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
