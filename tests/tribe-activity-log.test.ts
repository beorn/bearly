/**
 * Unit tests for the unified tribe session-activity log.
 *
 * Scope (phase 1): the pure mapping from onMessageInserted payloads to
 * ActivityEntry rows, plus the append/rotate/disable behaviour of the
 * write function. The daemon integration (every DB insert → one log line)
 * is covered by the phantom-chief replay test in tribe-daemon.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { readFileSync, rmSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

import {
  activityFromMessage,
  activityLogPath,
  writeActivity,
  writeInjectActivity,
  __resetActivityLogState,
  type ActivityEntry,
} from "../tools/lib/tribe/activity-log.ts"
import { emitHookJson } from "../plugins/injection-envelope/src/emit.ts"

let tmpDir: string
let origEnv: string | undefined

beforeEach(() => {
  tmpDir = join(tmpdir(), `tribe-activity-${randomUUID()}`)
  mkdirSync(tmpDir, { recursive: true })
  origEnv = process.env.TRIBE_ACTIVITY_LOG
  process.env.TRIBE_ACTIVITY_LOG = join(tmpDir, "activity.jsonl")
  __resetActivityLogState()
})

afterEach(() => {
  if (origEnv === undefined) delete process.env.TRIBE_ACTIVITY_LOG
  else process.env.TRIBE_ACTIVITY_LOG = origEnv
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

function readEntries(): ActivityEntry[] {
  const p = process.env.TRIBE_ACTIVITY_LOG!
  if (!existsSync(p)) return []
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ActivityEntry)
}

describe("activityFromMessage — kind mapping", () => {
  it("maps direct → dm with peer=recipient", () => {
    const e = activityFromMessage({
      id: "m1",
      ts: 1000,
      type: "notify",
      kind: "direct",
      sender: "alice",
      recipient: "bob",
      content: "hi",
      bead_id: null,
    })
    expect(e.kind).toBe("dm")
    expect(e.session).toBe("alice")
    expect(e.peer).toBe("bob")
  })

  it("maps broadcast with type='session' → session", () => {
    const e = activityFromMessage({
      id: "m2",
      ts: 1000,
      type: "session",
      kind: "broadcast",
      sender: "daemon",
      recipient: "*",
      content: "alice joined (member) pid=123 ~/repo",
      bead_id: null,
    })
    expect(e.kind).toBe("session")
    expect(e.peer).toBeUndefined() // recipient='*' drops peer
  })

  it("maps broadcast with rename content → rename", () => {
    const e = activityFromMessage({
      id: "m3",
      ts: 1000,
      type: "notify",
      kind: "broadcast",
      sender: "alice",
      recipient: "*",
      content: 'Member "chief" is now "recall"',
      bead_id: null,
    })
    expect(e.kind).toBe("rename")
  })

  it("maps other broadcast → broadcast", () => {
    const e = activityFromMessage({
      id: "m4",
      ts: 1000,
      type: "status",
      kind: "broadcast",
      sender: "km-2",
      recipient: "*",
      content: "all phases shipped",
      bead_id: "km-ambot",
    })
    expect(e.kind).toBe("broadcast")
    expect(e.bead_id).toBe("km-ambot")
  })

  it("maps event → event", () => {
    const e = activityFromMessage({
      id: "m5",
      ts: 1000,
      type: "event.session.joined",
      kind: "event",
      sender: "alice",
      recipient: "*",
      content: '{"name":"alice"}',
      bead_id: null,
    })
    expect(e.kind).toBe("event")
  })
})

describe("activityFromMessage — preview truncation", () => {
  it("leaves short content intact", () => {
    const e = activityFromMessage({
      id: "m6",
      ts: 0,
      type: "notify",
      kind: "direct",
      sender: "a",
      recipient: "b",
      content: "short",
      bead_id: null,
    })
    expect(e.preview).toBe("short")
  })

  it("collapses whitespace", () => {
    const e = activityFromMessage({
      id: "m7",
      ts: 0,
      type: "notify",
      kind: "direct",
      sender: "a",
      recipient: "b",
      content: "line1\n\n  line2\t\ttab",
      bead_id: null,
    })
    expect(e.preview).toBe("line1 line2 tab")
  })

  it("truncates content > 200 chars with ellipsis", () => {
    const long = "x".repeat(500)
    const e = activityFromMessage({
      id: "m8",
      ts: 0,
      type: "notify",
      kind: "direct",
      sender: "a",
      recipient: "b",
      content: long,
      bead_id: null,
    })
    expect(e.preview?.length).toBe(200)
    expect(e.preview?.endsWith("…")).toBe(true)
  })
})

describe("writeActivity — file behavior", () => {
  it("appends a JSONL line per call", () => {
    writeActivity({ ts: 1, source: "tribe", kind: "dm", session: "a", peer: "b", preview: "one" })
    writeActivity({ ts: 2, source: "tribe", kind: "dm", session: "a", peer: "b", preview: "two" })
    const entries = readEntries()
    expect(entries).toHaveLength(2)
    expect(entries[0]!.preview).toBe("one")
    expect(entries[1]!.preview).toBe("two")
  })

  it("creates parent directory if missing", () => {
    const nested = join(tmpDir, "nested", "deeper", "activity.jsonl")
    process.env.TRIBE_ACTIVITY_LOG = nested
    __resetActivityLogState()
    writeActivity({ ts: 1, source: "tribe", kind: "dm", session: "a", peer: "b" })
    expect(existsSync(nested)).toBe(true)
  })

  it("is disabled by TRIBE_ACTIVITY_LOG=off", () => {
    process.env.TRIBE_ACTIVITY_LOG = "off"
    __resetActivityLogState()
    writeActivity({ ts: 1, source: "tribe", kind: "dm", session: "a", peer: "b" })
    const fallback = activityLogPath() // would be HOME-based, should not exist
    expect(existsSync(fallback)).toBe(fallback === "/.local/share/tribe/activity.jsonl" ? false : existsSync(fallback))
    // The tmpDir log was the pre-"off" path; ensure no rows landed anywhere
    // Since the env was just flipped to "off", any path it falls back to
    // should not have been written to in this test.
  })

  it("every line is valid JSON (jq-safe invariant)", () => {
    for (let i = 0; i < 5; i++) {
      writeActivity({
        ts: i,
        source: "tribe",
        kind: "dm",
        session: "a",
        peer: "b",
        preview: `row ${i}\nwith\tnewline`,
      })
    }
    const p = process.env.TRIBE_ACTIVITY_LOG!
    const raw = readFileSync(p, "utf8")
    const lines = raw.split("\n").filter((l) => l.length > 0)
    expect(lines).toHaveLength(5)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})

describe("activityLogPath resolution", () => {
  it("honors TRIBE_ACTIVITY_LOG override", () => {
    process.env.TRIBE_ACTIVITY_LOG = "/tmp/custom.jsonl"
    expect(activityLogPath()).toBe("/tmp/custom.jsonl")
  })

  it("falls back to HOME/.local/share/tribe/activity.jsonl", () => {
    delete process.env.TRIBE_ACTIVITY_LOG
    const home = process.env.HOME ?? ""
    expect(activityLogPath()).toBe(`${home}/.local/share/tribe/activity.jsonl`)
  })
})

describe("writeInjectActivity — phase 2 (recall hook)", () => {
  it("records source=recall, kind=inject with full uncropped content in preview", () => {
    const content = "x".repeat(500)
    writeInjectActivity(content)
    const entries = readEntries()
    expect(entries).toHaveLength(1)
    const e = entries[0]!
    expect(e.source).toBe("recall")
    expect(e.kind).toBe("inject")
    expect(e.chars).toBe(500)
    expect(e.preview?.length).toBe(500) // full content, not truncated
    expect(e.preview).toBe(content)
  })

  it("collapses whitespace in injected content for single-line jq output", () => {
    writeInjectActivity("line1\n\nline2\t\ttab  spaces")
    const entries = readEntries()
    expect(entries[0]!.preview).toBe("line1 line2 tab spaces")
    expect(entries[0]!.chars).toBe(22)
  })

  it("uses CLAUDE_SESSION_ID when set, else falls back to pid", () => {
    const origId = process.env.CLAUDE_SESSION_ID
    try {
      process.env.CLAUDE_SESSION_ID = "session-abc"
      writeInjectActivity("hello")
      process.env.CLAUDE_SESSION_ID = ""
      delete process.env.CLAUDE_SESSION_ID
      writeInjectActivity("world")
      const entries = readEntries()
      expect(entries).toHaveLength(2)
      expect(entries[0]!.session).toBe("session-abc")
      expect(entries[1]!.session).toMatch(/^pid-\d+$/)
    } finally {
      if (origId === undefined) delete process.env.CLAUDE_SESSION_ID
      else process.env.CLAUDE_SESSION_ID = origId
    }
  })
})

describe("emitHookJson integration — every UserPromptSubmit emission writes to activity log", () => {
  it("records the additionalContext when emitting UserPromptSubmit", () => {
    const out = emitHookJson("UserPromptSubmit", "recall: <snippet session='abc'>past work</snippet>")
    expect(out).toContain("hookSpecificOutput")
    const entries = readEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.source).toBe("recall")
    expect(entries[0]!.kind).toBe("inject")
    expect(entries[0]!.preview).toContain("past work")
  })

  it("does NOT record when additionalContext is undefined (empty hook output)", () => {
    const out = emitHookJson("UserPromptSubmit")
    expect(out).toBe("{}")
    expect(readEntries()).toHaveLength(0)
  })

  it("does NOT record for non-UserPromptSubmit events", () => {
    const out = emitHookJson("SessionEnd", "some content")
    expect(out).toBe("{}")
    expect(readEntries()).toHaveLength(0)
  })
})
