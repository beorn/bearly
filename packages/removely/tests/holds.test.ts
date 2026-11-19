/**
 * A removal can be held by tracked files and by prose that cites the target.
 *
 * Two of the three 2026-11-18 deletions went wrong this way (#34952):
 * - a sweep removed directories that tracked prose cited, one of them only at a sentence end
 *   (`…/candidate-vault.`), which a "/, whitespace or EOL" boundary misses;
 * - a sweep removed a directory whose files the root repository tracked, though no tracked file named the directory.
 *
 * `holds` is opt-in. The caller supplies the authority (a tracked predicate and a citation index built from its
 * corpus); removely evaluates it inside the one shared refusal predicate, so `safeRemove` and `safeRemoveSync`
 * cannot disagree.
 *
 * @failure  a removal deletes a directory that tracked prose cites (at any punctuation boundary) or that holds tracked files
 * @level    l1
 * @consumer safeRemove / safeRemoveSync with holds; tools/host-store-cleanup.ts scratch arm and --remove (#34952)
 * @reach    fs-walk <fixture-only: tmpdir fixtures>
 * @testonly none
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  buildCitationIndex,
  citationsIn,
  citationsOf,
  firstCitationOf,
  type RemovalHolds,
  RemovalHeldError,
  safeRemove,
  safeRemoveSync,
} from "../src/index.ts"

const ROOT = "/hh/var"
const ANCHORS = [
  { text: "/hh/var/@", absolute: "/hh/var/@" },
  { text: "var/@", absolute: "/hh/var/@" },
]

function cited(text: string, target: string): boolean {
  const index = buildCitationIndex([{ file: "doc.md", text }], { anchors: ANCHORS, containers: [ROOT] })
  return citationsOf(index, target).length > 0
}

describe("the citation boundary", () => {
  const T = "/hh/var/@x/candidate-vault"
  test.each([
    ["a sentence-end period", `kept in ${T}.`, true],
    ["a sentence-end period before more text", `kept in ${T}. Then more.`, true],
    ["backticks", `see \`${T}\` here`, true],
    ["a Markdown link", `[run](${T})`, true],
    ["a comma", `${T}, and more`, true],
    ["parentheses", `(${T})`, true],
    ["a line suffix", `${T}:12`, true],
    ["a line and column suffix", `${T}:12:4 says`, true],
    ["a fragment", `${T}#L12`, true],
    ["braces", `{{${T}}}`, true],
    ["a closing brace", `${T}}`, true],
    ["a tilde", `${T}~`, true],
    ["emphasis", `**${T}**`, true],
    ["the root-relative form", `\`var/@x/candidate-vault\``, true],
    ["a descendant", `${T}/a/b.json`, true],
    ["a sibling with a suffix", `${T}-report.md`, false],
    ["a sibling with an extension", `${T}.md`, false],
    ["an unrelated path", "/hh/var/@x/other", false],
    ["the relative anchor inside another path", "/srv/var/@x/candidate-vault", false],
  ])("%s", (_name, text, expected) => {
    expect(cited(text, T)).toBe(expected)
  })

  test.each([
    ["a space", "/hh/var/@x/c++ notes.txt", "/hh/var/@x/c notes.txt"],
    ["parentheses", "/hh/var/@x/run (1).log", "/hh/var/@x/run 1.log"],
    ["brackets", "/hh/var/@x/probe[2].json", "/hh/var/@x/probe2.json"],
  ])("a name with %s is matched as written, and its near-miss is not", (_name, path, nearMiss) => {
    const text = `- ${path}\n`
    expect(cited(text, path)).toBe(true)
    expect(cited(text, nearMiss)).toBe(false)
  })

  test("an underscore sibling is its own name", () => {
    expect(cited("see /hh/var/@x/run_old for the old one", "/hh/var/@x/run")).toBe(false)
  })

  test("an ancestor's citation holds a child target", () => {
    expect(cited("everything under /hh/var/@x/run is evidence", "/hh/var/@x/run/a.log")).toBe(true)
  })

  test("a container's citation does not hold everything inside it", () => {
    const index = buildCitationIndex([{ file: "doc.md", text: "seat scratch lives in /hh/var/@x/" }], {
      anchors: ANCHORS,
      containers: [ROOT, "/hh/var/@x"],
    })
    expect(citationsOf(index, "/hh/var/@x/old.log")).toEqual([])
    expect(citationsOf(index, "/hh/var/@x")).toHaveLength(1)
  })

  test.each([
    ["three dots", "smoke at .../smoke-linux/run1/raw.json"],
    ["an ellipsis", "smoke at …/smoke-linux/run1/raw.json"],
  ])("an abbreviated tail with %s holds the path it ends and that path's ancestors", (_name, text) => {
    expect(cited(text, "/hh/var/@x/smoke-linux/run1/raw.json")).toBe(true)
    expect(cited(text, "/hh/var/@x/smoke-linux/run1")).toBe(true)
    expect(cited(text, "/hh/var/@x/ke-linux/run1/raw.json")).toBe(false)
  })

  test("a match keeps its file, line, column and line text", () => {
    const text = "first line\nsecond cites /hh/var/@x/run. Done\n"
    expect(citationsIn(text, ANCHORS)).toEqual([
      {
        path: "/hh/var/@x/run",
        raw: "/hh/var/@x/run. Done",
        line: 2,
        column: 14,
        lineText: "second cites /hh/var/@x/run. Done",
        abbreviated: false,
      },
    ])
    const index = buildCitationIndex([{ file: "pm/a.md", text }], { anchors: ANCHORS, containers: [ROOT] })
    expect(citationsOf(index, "/hh/var/@x/run")).toEqual([
      { file: "pm/a.md", path: "/hh/var/@x/run", line: 2, column: 14, lineText: "second cites /hh/var/@x/run. Done" },
    ])
  })
})

// 34952 (04:27 PST 2026-11-19): host-store-cleanup's census reached 11.6 GB. It asked once per walked file whether
// anything cited it, and every answer re-scanned every mention under each ancestor of the file and built a list.
describe("an index stays small and fast under a whole-tree walk", () => {
  test("lookups under a heavily cited folder stay fast and exact", () => {
    const text = Array.from({ length: 2000 }, (_, at) => `- /hh/var/@x/big/n${at}/out.json`).join("\n")
    const index = buildCitationIndex([{ file: "doc.md", text: `${text}\nall of /hh/var/@x/big/sub is kept\n` }], {
      anchors: ANCHORS,
      containers: [ROOT, "/hh/var/@x"],
    })
    const started = performance.now()
    let held = 0
    for (let at = 0; at < 50_000; at++) {
      const found = citationsOf(index, `/hh/var/@x/big/sub/d${at % 500}/f${at}.log`)
      if (found.length === 1 && found[0]?.lineText === "all of /hh/var/@x/big/sub is kept") held++
    }
    expect(held).toBe(50_000)
    expect(performance.now() - started).toBeLessThan(5000)
    for (let at = 0; at < 50_000; at++) {
      const first = firstCitationOf(index, `/hh/var/@x/big/sub/d${at % 500}/f${at}.log`)
      if (first?.lineText !== "all of /hh/var/@x/big/sub is kept") throw new Error(`firstCitationOf missed f${at}`)
    }
    // Past the cache's cap the answers are still exact: an uncited sibling stays free, a cited child stays held.
    for (let at = 0; at < 100_100; at++) citationsOf(index, `/hh/var/@x/other/d${at}/f.log`)
    expect(citationsOf(index, "/hh/var/@x/other/d1/f.log")).toEqual([])
    expect(citationsOf(index, "/hh/var/@x/big/n5/out.json/x")).toHaveLength(1)
  })
})

describe("firstCitationOf is the first of citationsOf", () => {
  // Mentions, a sentence end, a descendant, an ancestor, a container, abbreviated tails (target and ancestor forms).
  const text = [
    "kept: /hh/var/@x/run. Then /hh/var/@x/deep/a/b/c.json and `var/@x/tree`",
    "see /hh/var/@x/run-report.md and /hh/var/@y/ for the home",
    "smoke at .../smoke-linux/run1/raw.json and …/only/leaf",
    "and /hh/var/@x/tree/sub is also named",
  ].join("\n")
  const index = buildCitationIndex([{ file: "doc.md", text }], { anchors: ANCHORS, containers: [ROOT, "/hh/var/@y"] })
  const targets = [
    "/hh/var/@x/run",
    "/hh/var/@x/run/",
    "/hh/var/@x/run/a.log",
    "/hh/var/@x/run-report.md",
    "/hh/var/@x/run-report",
    "/hh/var/@x/deep",
    "/hh/var/@x/deep/a/b",
    "/hh/var/@x/deep/a/b/c.json/z",
    "/hh/var/@x/tree/sub/f",
    "/hh/var/@x/tree/other",
    "/hh/var/@y",
    "/hh/var/@y/old.log",
    "/hh/var/@x/q/smoke-linux/run1/raw.json",
    "/hh/var/@x/q/smoke-linux/run1",
    "/hh/var/@x/q/smoke-linux/run1/raw.json/inner",
    "/hh/var/@x/q/ke-linux/run1/raw.json",
    "/hh/var/@x/only/leaf",
    // Held only by a tail naming its grandparent: the tail chain must walk past the parent (review2 mutant).
    "/hh/var/@x/only/leaf/a/b.log",
    "/hh/var/@x/only",
    "/hh/var/@x/unrelated",
  ]
  test("a path held only by its grandparent's tail is held", () => {
    expect(firstCitationOf(index, "/hh/var/@x/only/leaf/a/b.log")).not.toBeNull()
  })
  test.each(targets)("%s", (target) => {
    // Twice: the second answer comes from the folder caches.
    expect(firstCitationOf(index, target)).toEqual(citationsOf(index, target)[0] ?? null)
    expect(firstCitationOf(index, target)).toEqual(citationsOf(index, target)[0] ?? null)
  })
})

describe("holds in the shared removal predicate", () => {
  const scratch: string[] = []
  afterEach(() => {
    scratch.length = 0
  })

  function fixture(): { root: string; target: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "removely-holds-")))
    scratch.push(root)
    const target = join(root, "run")
    mkdirSync(join(target, "raw"), { recursive: true })
    writeFileSync(join(target, "raw", "a.json"), "{}")
    return { root, target }
  }

  function holdsFor(root: string, text: string, tracked: readonly string[] = []): RemovalHolds {
    const anchors = [{ text: `${root}/`, absolute: `${root}/` }]
    return {
      tracked: (path) => {
        const hit = tracked.find((file) => file === path || file.startsWith(`${path}/`))
        return hit === undefined ? null : { path: hit, source: "fixture index" }
      },
      citations: buildCitationIndex([{ file: "pm/doc.md", text }], { anchors, containers: [root] }),
    }
  }

  test.each([
    [
      "safeRemoveSync",
      (target: string, options: Parameters<typeof safeRemoveSync>[1]) => safeRemoveSync(target, options),
    ],
    ["safeRemove", (target: string, options: Parameters<typeof safeRemoveSync>[1]) => safeRemove(target, options)],
  ])("%s refuses a target cited at a sentence end and keeps it", async (_name, remove) => {
    const { root, target } = fixture()
    const holds = holdsFor(root, `The run is kept in ${target}.\n`)
    let caught: unknown
    try {
      await remove(target, { within: root, allowedRoots: [root], holds })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RemovalHeldError)
    const held = caught as RemovalHeldError
    expect(held.code).toBe("removely/held-cited")
    expect(held.target).toBe(target)
    expect(held.citations[0]).toMatchObject({ file: "pm/doc.md", line: 1 })
    expect(held.message).toContain(target)
    expect(held.message).toContain("pm/doc.md:1:")
    expect(existsSync(join(target, "raw", "a.json"))).toBe(true)
  })

  test("a directory whose tracked file never names it is held (incident 2)", () => {
    const { root, target } = fixture()
    const holds = holdsFor(root, "nothing cites it\n", [join(target, "raw", "a.json")])
    expect(() => safeRemoveSync(target, { within: root, allowedRoots: [root], holds })).toThrow(RemovalHeldError)
    try {
      safeRemoveSync(target, { within: root, allowedRoots: [root], holds })
    } catch (error) {
      expect((error as RemovalHeldError).code).toBe("removely/held-tracked")
      expect((error as RemovalHeldError).tracked?.path).toBe(join(target, "raw", "a.json"))
    }
    expect(existsSync(join(target, "raw", "a.json"))).toBe(true)
  })

  test("a target under a cited ancestor is held; an uncited sibling is removed", () => {
    const { root, target } = fixture()
    mkdirSync(join(root, "run-report"))
    const holds = holdsFor(root, `see ${target} for the raw files\n`)
    expect(() => safeRemoveSync(join(target, "raw"), { within: root, allowedRoots: [root], holds })).toThrow(
      RemovalHeldError,
    )
    safeRemoveSync(join(root, "run-report"), { within: root, allowedRoots: [root], holds })
    expect(existsSync(join(root, "run-report"))).toBe(false)
    expect(existsSync(target)).toBe(true)
  })

  test("a tracked predicate that throws refuses the removal, never reads as untracked", () => {
    const { root, target } = fixture()
    const holds: RemovalHolds = {
      tracked: () => {
        throw new Error("tracked inventory unreadable")
      },
      citations: buildCitationIndex([], { anchors: [{ text: `${root}/`, absolute: `${root}/` }], containers: [root] }),
    }
    expect(() => safeRemoveSync(target, { within: root, allowedRoots: [root], holds })).toThrow(
      /tracked inventory unreadable/u,
    )
    expect(existsSync(target)).toBe(true)
  })

  test("a malformed holds argument is a programming error before any removal", () => {
    const { root, target } = fixture()
    const holds = { citations: buildCitationIndex([], { anchors: ANCHORS, containers: [] }) } as unknown as RemovalHolds
    expect(() => safeRemoveSync(target, { within: root, allowedRoots: [root], holds })).toThrow(/holds\.tracked/u)
    expect(existsSync(target)).toBe(true)
  })

  test("without holds, removal behaves exactly as before", () => {
    const { root, target } = fixture()
    safeRemoveSync(target, { within: root, allowedRoots: [root] })
    expect(existsSync(target)).toBe(false)
  })
})
