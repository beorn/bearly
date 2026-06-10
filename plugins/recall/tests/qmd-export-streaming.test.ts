import { describe, test, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { forEachJsonlLine, readSessionMeta, renderSessionMarkdown } from "../src/qmd-export.ts"

// 19775 (@km/silvercode/19775-claude-resume-rss-runaway): `recall export
// --catchup --hook` runs on every Claude SessionStart and used to
// readFileSync + split("\n") EVERY session jsonl under ~/.claude/projects
// (4.3GB / 1445 files on the reporting machine) just to derive the export
// filename for the skip-existing check. In a tight sync loop Bun RSS
// ballooned to ~7GB, tripping Silver Code's ACP backend RSS watchdog and
// killing the session shortly after `--resume`. The fix streams jsonl
// line-by-line with a bounded buffer and stops the meta scan as soon as
// every meta field is known. These tests pin (a) the streaming reader's
// contract, (b) meta/render semantic equivalence with the old whole-file
// reader, and (c) the memory bound itself.

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "qmd-export-streaming-"))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function entryLine(fields: Record<string, unknown>): string {
  return JSON.stringify(fields)
}

function userEntry(text: string, extra: Record<string, unknown> = {}): string {
  return entryLine({
    type: "user",
    sessionId: "11111111-2222-3333-4444-555555555555",
    timestamp: "2026-06-01T10:00:00.000Z",
    cwd: "/Users/test/project",
    message: { role: "user", content: [{ type: "text", text }] },
    ...extra,
  })
}

function assistantEntry(text: string, extra: Record<string, unknown> = {}): string {
  return entryLine({
    type: "assistant",
    sessionId: "11111111-2222-3333-4444-555555555555",
    timestamp: "2026-06-01T10:00:05.000Z",
    cwd: "/Users/test/project",
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...extra,
  })
}

describe("forEachJsonlLine", () => {
  test("yields every non-blank line and skips blank lines", () => {
    const p = join(dir, "basic.jsonl")
    writeFileSync(p, '{"a":1}\n\n{"b":2}\n   \n{"c":3}\n', "utf-8")
    const seen: string[] = []
    forEachJsonlLine(p, (line) => {
      seen.push(line)
    })
    expect(seen).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  test("returning false stops the scan early", () => {
    const p = join(dir, "early-stop.jsonl")
    const lines = Array.from({ length: 50_000 }, (_, i) => `{"i":${i}}`)
    writeFileSync(p, lines.join("\n") + "\n", "utf-8")
    let calls = 0
    forEachJsonlLine(p, () => {
      calls++
      return calls >= 3 ? false : undefined
    })
    expect(calls).toBe(3)
  })

  test("handles a final line without trailing newline", () => {
    const p = join(dir, "no-trailing.jsonl")
    writeFileSync(p, '{"a":1}\n{"b":2}', "utf-8")
    const seen: string[] = []
    forEachJsonlLine(p, (line) => {
      seen.push(line)
    })
    expect(seen).toEqual(['{"a":1}', '{"b":2}'])
  })

  test("multibyte UTF-8 survives chunk boundaries", () => {
    // Lines sized so 4-byte emoji and 3-byte CJK straddle the 256KB read
    // boundary somewhere in the file regardless of alignment.
    const p = join(dir, "multibyte.jsonl")
    const payload = "héllo🤖世界".repeat(40)
    const line = JSON.stringify({ text: payload })
    const count = Math.ceil((512 * 1024) / (line.length + 1))
    writeFileSync(p, Array.from({ length: count }, () => line).join("\n") + "\n", "utf-8")
    let bad = 0
    let total = 0
    forEachJsonlLine(p, (l) => {
      total++
      if (l.includes("�")) bad++
      if ((JSON.parse(l) as { text: string }).text !== payload) bad++
    })
    expect(total).toBe(count)
    expect(bad).toBe(0)
  })
})

describe("readSessionMeta (streaming)", () => {
  test("extracts the same meta the whole-file reader produced", () => {
    const p = join(dir, "meta.jsonl")
    writeFileSync(
      p,
      [
        entryLine({ type: "summary", summary: "irrelevant" }),
        userEntry("fix the failing test in storage"),
        assistantEntry("on it"),
      ].join("\n") + "\n",
      "utf-8",
    )
    const meta = readSessionMeta(p)
    expect(meta).toBeDefined()
    expect(meta?.sessionId).toBe("11111111-2222-3333-4444-555555555555")
    expect(meta?.startTime.toISOString()).toBe("2026-06-01T10:00:00.000Z")
    expect(meta?.project).toBe("/Users/test/project")
    expect(meta?.firstUserText).toBe("fix the failing test in storage")
  })

  test("skips synthetic user turns when picking firstUserText", () => {
    const p = join(dir, "synthetic.jsonl")
    writeFileSync(
      p,
      [userEntry("<system-reminder>noise</system-reminder>"), userEntry("[tool result]"), userEntry("real ask")].join(
        "\n",
      ) + "\n",
      "utf-8",
    )
    expect(readSessionMeta(p)?.firstUserText).toBe("real ask")
  })

  test("returns undefined for an empty file", () => {
    const p = join(dir, "empty.jsonl")
    writeFileSync(p, "", "utf-8")
    expect(readSessionMeta(p)).toBeUndefined()
  })

  test("returns undefined for a missing file", () => {
    expect(readSessionMeta(join(dir, "does-not-exist.jsonl"))).toBeUndefined()
  })

  test("meta scan of a huge transcript stays memory-bounded (19775)", () => {
    // 64MB file whose meta completes in the first 3 lines. The old
    // implementation materialized the whole file as one string PLUS a
    // split("\n") string array (≥4x the byte size in JS heap); the
    // streaming reader's peak is one 256KB chunk + one line.
    const p = join(dir, "huge.jsonl")
    writeFileSync(p, [userEntry("big session opener"), assistantEntry("ack")].join("\n") + "\n", "utf-8")
    const filler = entryLine({
      type: "assistant",
      sessionId: "11111111-2222-3333-4444-555555555555",
      timestamp: "2026-06-01T10:00:06.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(64 * 1024) }] },
    })
    const block = Array.from({ length: 64 }, () => filler).join("\n") + "\n"
    for (let written = 0; written < 64 * 1024 * 1024; written += block.length) {
      appendFileSync(p, block, "utf-8")
    }

    // Best-effort GC so `before` isn't inflated by setup garbage. Works under
    // both bun (Bun.gc) and node (--expose-gc); absent either, the generous
    // threshold still separates streaming (a few MB) from whole-file (≥128MB).
    const maybeBun = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun
    if (typeof maybeBun?.gc === "function") maybeBun.gc(true)
    ;(globalThis as { gc?: () => void }).gc?.()
    const before = process.memoryUsage().rss
    const meta = readSessionMeta(p)
    const deltaMb = (process.memoryUsage().rss - before) / (1024 * 1024)

    expect(meta?.firstUserText).toBe("big session opener")
    // Old reader: ≥ 128MB delta for a 64MB file (string + split copies).
    // Streaming reader: a few MB. 48MB is a generous flake-proof ceiling.
    expect(deltaMb, `rss delta ${Math.round(deltaMb)}MB`).toBeLessThan(48)
  })
})

describe("catchup skips quarantined sessions (19775)", () => {
  // The other half of the 19775 runaway: chats-rejected/ copies did not
  // count as "existing", so every catchup re-rendered + re-quality-gated +
  // re-rejected every quarantined session — and quarantined sessions are
  // dominated by stuck-loop monsters (hundreds of MB each). The rejected
  // copy must count as handled.
  test("a rejected session is not re-rendered by the next catchup", () => {
    const home = mkdtempSync(join(tmpdir(), "qmd-export-catchup-"))
    const projects = join(home, ".claude", "projects", "-test-project")
    const chats = join(home, "chats")
    const rejectedDir = join(home, "chats-rejected")
    mkdirSync(projects, { recursive: true })
    mkdirSync(chats, { recursive: true })

    // Stuck-loop session: one line repeated ≥10x contiguously → quality
    // gate rejects with stuck-loop:repeated-line.
    const loop = Array.from({ length: 40 }, () => assistantEntry("the same line over and over again"))
    writeFileSync(
      join(projects, "22222222-3333-4444-5555-666666666666.jsonl"),
      [
        userEntry("kick off", { sessionId: "22222222-3333-4444-5555-666666666666" }),
        ...loop.map((l) => l.replace(/11111111-2222-3333-4444-555555555555/g, "22222222-3333-4444-5555-666666666666")),
      ].join("\n") + "\n",
      "utf-8",
    )

    const env = {
      ...process.env,
      HOME: home,
      RECALL_SESSIONS_DIR: chats,
      RECALL_REJECTED_DIR: rejectedDir,
    }
    const script = fileURLToPath(new URL("../src/qmd-export.ts", import.meta.url))
    const run = () => spawnSync("bun", [script, "export", "--catchup"], { env, encoding: "utf-8" })

    const first = run()
    expect(first.status, first.stderr).toBe(0)
    const rejectedFiles = readdirSync(rejectedDir).filter((f) => f.endsWith(".md"))
    expect(rejectedFiles).toHaveLength(1)
    const rejectedPath = join(rejectedDir, rejectedFiles[0]!)
    const mtimeAfterFirst = statSync(rejectedPath).mtimeMs

    const second = run()
    expect(second.status).toBe(0)
    // Old behavior: catchup re-rendered + rewrote the rejected file every
    // run (mtime moves). Fixed behavior: the quarantined copy counts as
    // existing, so the second catchup never touches it.
    expect(statSync(rejectedPath).mtimeMs).toBe(mtimeAfterFirst)

    rmSync(home, { recursive: true, force: true })
  })
})

describe("renderSessionMarkdown (streaming)", () => {
  test("renders the same shape as the whole-file renderer, with message count", () => {
    const p = join(dir, "render.jsonl")
    writeFileSync(
      p,
      [
        userEntry("first ask"),
        assistantEntry("answer one"),
        // Cross-session contamination — must be filtered from the body but
        // still counted by the legacy messageCount semantics (count happens
        // before the contamination filter, as in the old implementation).
        assistantEntry("contaminated", { sessionId: "99999999-8888-7777-6666-555555555555" }),
        entryLine({ type: "system", sessionId: "11111111-2222-3333-4444-555555555555", content: "sys note" }),
        userEntry("[tool result wrapped]"),
      ].join("\n") + "\n",
      "utf-8",
    )
    const meta = readSessionMeta(p)
    expect(meta).toBeDefined()
    const md = renderSessionMarkdown(meta!)
    expect(md).toContain("session_id: 11111111-2222-3333-4444-555555555555")
    expect(md).toContain("messages: 4")
    expect(md).toContain("# Session 2026-06-01 10:00")
    expect(md).toContain("> first ask")
    expect(md).toContain("## User\n\nfirst ask")
    expect(md).toContain("## Assistant\n\nanswer one")
    expect(md).not.toContain("contaminated")
    expect(md).not.toContain("[tool result wrapped]")
  })
})
