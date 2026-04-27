/**
 * Observability — emitInjectionDebugEvent now routes through loggily's
 * `injection:*` namespace tree. Validates the in-memory writer pattern
 * (preferred for tests) and the back-compat INJECTION_DEBUG_LOG env var
 * which lazily installs a JSONL file writer on first emit.
 *
 * The library is pure-import — no daemon startup — so the lazy install
 * happens on first emit. Each test runs in its own file (vitest worker
 * isolation) but inside this file the lazy-install flag is module-level,
 * so we order tests carefully and use synchronous `require` like the rest
 * of loggily's tests.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { addWriter, setLogLevel, setSuppressConsole, type LogLevel } from "loggily"
import { emitInjectionDebugEvent, installInjectionFileWriter } from "../src/debug.ts"

const unsubs: Array<() => void> = []
let prevLevel: string | undefined

beforeEach(() => {
  // km's vitest setup pins LOG_LEVEL=warn; emitInjectionDebugEvent uses info.
  prevLevel = process.env.LOG_LEVEL
  setLogLevel("info")
  setSuppressConsole(true)
})

afterEach(() => {
  while (unsubs.length) unsubs.pop()?.()
  setSuppressConsole(false)
  setLogLevel((prevLevel as LogLevel) ?? "warn")
})

function track(unsub: () => void): void {
  unsubs.push(unsub)
}

describe("injection-envelope observability — namespace routing", () => {
  test("emit goes to injection:wrap, skip + empty go to injection:skip", () => {
    const captured: Array<{ ns: string; msg: string; props?: Record<string, unknown> }> = []
    track(
      addWriter({ ns: "injection:*" }, (_fmt, _lvl, ns, event) => {
        if (event.kind === "log") {
          captured.push({ ns, msg: event.message, props: event.props })
        }
      }),
    )

    emitInjectionDebugEvent({ source: "recall", action: "emit", chars: 42 })
    emitInjectionDebugEvent({ source: "recall", action: "skip", reason: "no_results" })
    emitInjectionDebugEvent({ source: "tribe", action: "empty", reason: "no_items" })

    expect(captured).toHaveLength(3)
    expect(captured[0]).toMatchObject({
      ns: "injection:wrap",
      msg: "emit",
      props: { source: "recall", action: "emit", chars: 42 },
    })
    expect(captured[1]).toMatchObject({
      ns: "injection:skip",
      msg: "skip",
      props: { source: "recall", reason: "no_results" },
    })
    expect(captured[2]).toMatchObject({
      ns: "injection:skip",
      msg: "empty",
      props: { source: "tribe", reason: "no_items" },
    })
  })

  test("structured props (sessionId, prompt, additionalContext) survive the writer", () => {
    const captured: Record<string, unknown>[] = []
    track(
      addWriter({ ns: "injection:*" }, (_fmt, _lvl, _ns, event) => {
        if (event.kind === "log") captured.push(event.props ?? {})
      }),
    )

    emitInjectionDebugEvent({
      source: "recall",
      sessionId: "abc-1234",
      action: "emit",
      prompt: "tell me about kitchen",
      itemCount: 2,
      chars: 137,
      additionalContext: "<recall>...</recall>",
    })

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      source: "recall",
      sessionId: "abc-1234",
      prompt: "tell me about kitchen",
      itemCount: 2,
      chars: 137,
      additionalContext: "<recall>...</recall>",
    })
  })
})

describe("injection-envelope observability — installInjectionFileWriter", () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "inj-debug-"))
    file = join(dir, "injection.log")
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("explicit installInjectionFileWriter routes injection:* events to JSONL", async () => {
    track(installInjectionFileWriter(file))

    emitInjectionDebugEvent({
      source: "recall",
      sessionId: "abc-1234",
      action: "emit",
      prompt: "what's the kitchen plan",
      itemCount: 2,
      chars: 137,
    })
    emitInjectionDebugEvent({ source: "tribe", action: "skip", reason: "all_seen" })

    // Wait for the buffered file writer's interval to flush.
    await new Promise((r) => setTimeout(r, 250))

    const lines = readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)

    expect(lines.length).toBeGreaterThanOrEqual(2)
    const wrap = lines.find((l) => l.namespace === "injection:wrap")
    const skip = lines.find((l) => l.namespace === "injection:skip")
    expect(wrap).toMatchObject({
      msg: "emit",
      source: "recall",
      sessionId: "abc-1234",
      itemCount: 2,
      chars: 137,
    })
    expect(skip).toMatchObject({
      msg: "skip",
      source: "tribe",
      reason: "all_seen",
    })
  })
})
