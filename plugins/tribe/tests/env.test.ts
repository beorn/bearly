/**
 * Tests for the TRIBE_* / LORE_* env var resolver.
 *
 * The resolver has module-level `warned` + `usedOld` state, so each case
 * uses `vi.resetModules()` + dynamic `import()` to get a fresh copy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

type EnvModule = typeof import("../lore/lib/env.ts")

const SAVED_ENV = { ...process.env }

function cleanEnv(): void {
  for (const key of [
    "TRIBE_NO_DAEMON",
    "TRIBE_LOG",
    "TRIBE_LORE_SOCKET",
    "TRIBE_LORE_DB",
    "TRIBE_SUMMARIZER_MODEL",
    "TRIBE_FOCUS_POLL_MS",
    "TRIBE_SUMMARY_POLL_MS",
    "LORE_NO_DAEMON",
    "LORE_LOG",
    "LORE_SOCKET",
    "LORE_DB",
    "LORE_SUMMARIZER_MODEL",
    "LORE_FOCUS_POLL_MS",
    "LORE_SUMMARY_POLL_MS",
  ]) {
    delete process.env[key]
  }
}

async function freshEnv(): Promise<EnvModule> {
  vi.resetModules()
  return (await import("../lore/lib/env.ts")) as EnvModule
}

async function flushMicrotasks(): Promise<void> {
  // queueMicrotask callback has to run; two awaits is enough to drain.
  await Promise.resolve()
  await Promise.resolve()
}

describe("getEnv — TRIBE_* / LORE_* resolution", () => {
  beforeEach(() => {
    cleanEnv()
  })

  afterEach(() => {
    // Restore the original env so other tests don't see our mutations.
    for (const key of Object.keys(process.env)) {
      if (!(key in SAVED_ENV)) delete process.env[key]
    }
    for (const [key, value] of Object.entries(SAVED_ENV)) {
      if (value !== undefined) process.env[key] = value
    }
  })

  it("returns TRIBE_* value when only the new name is set (no warning)", async () => {
    process.env.TRIBE_NO_DAEMON = "1"
    const { getEnv } = await freshEnv()
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    expect(getEnv("TRIBE_NO_DAEMON")).toBe("1")
    await flushMicrotasks()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it("falls back to LORE_* when only the old name is set, and warns once", async () => {
    process.env.LORE_NO_DAEMON = "1"
    const { getEnv } = await freshEnv()
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    expect(getEnv("TRIBE_NO_DAEMON")).toBe("1")
    await flushMicrotasks()
    expect(spy).toHaveBeenCalledTimes(1)
    const msg = String(spy.mock.calls[0]?.[0] ?? "")
    expect(msg).toMatch(/\[deprecated\]/)
    expect(msg).toMatch(/LORE_NO_DAEMON/)
    expect(msg).toMatch(/TRIBE_NO_DAEMON/)
    expect(msg).toMatch(/@bearly\/tribe 0\.10/)
    spy.mockRestore()
  })

  it("prefers the new name when both are set (no warning)", async () => {
    process.env.TRIBE_NO_DAEMON = "new"
    process.env.LORE_NO_DAEMON = "old"
    const { getEnv } = await freshEnv()
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    expect(getEnv("TRIBE_NO_DAEMON")).toBe("new")
    await flushMicrotasks()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it("aggregates multiple old-name reads into a single warning line", async () => {
    process.env.LORE_NO_DAEMON = "1"
    process.env.LORE_LOG = "1"
    process.env.LORE_SOCKET = "/tmp/x.sock"
    const { getEnv } = await freshEnv()
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    getEnv("TRIBE_NO_DAEMON")
    getEnv("TRIBE_LOG")
    getEnv("TRIBE_LORE_SOCKET")
    await flushMicrotasks()
    expect(spy).toHaveBeenCalledTimes(1)
    const msg = String(spy.mock.calls[0]?.[0] ?? "")
    expect(msg).toMatch(/LORE_NO_DAEMON/)
    expect(msg).toMatch(/LORE_LOG/)
    expect(msg).toMatch(/LORE_SOCKET/)
    expect(msg).toMatch(/TRIBE_NO_DAEMON/)
    expect(msg).toMatch(/TRIBE_LOG/)
    expect(msg).toMatch(/TRIBE_LORE_SOCKET/)
    spy.mockRestore()
  })

  it("does not warn a second time even after more old-name reads", async () => {
    process.env.LORE_NO_DAEMON = "1"
    const { getEnv } = await freshEnv()
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    getEnv("TRIBE_NO_DAEMON")
    await flushMicrotasks()
    expect(spy).toHaveBeenCalledTimes(1)
    // Subsequent reads don't re-trigger the warning
    getEnv("TRIBE_NO_DAEMON")
    getEnv("TRIBE_NO_DAEMON")
    await flushMicrotasks()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it("returns undefined for unknown / unmapped names (no warning)", async () => {
    const { getEnv } = await freshEnv()
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    expect(getEnv("TRIBE_NOT_A_THING")).toBeUndefined()
    expect(getEnv("TRIBE_NO_DAEMON")).toBeUndefined()
    await flushMicrotasks()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it("covers every documented rename (sanity)", async () => {
    process.env.LORE_NO_DAEMON = "a"
    process.env.LORE_LOG = "b"
    process.env.LORE_SOCKET = "c"
    process.env.LORE_DB = "d"
    process.env.LORE_SUMMARIZER_MODEL = "e"
    process.env.LORE_FOCUS_POLL_MS = "f"
    process.env.LORE_SUMMARY_POLL_MS = "g"
    const { getEnv } = await freshEnv()
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    expect(getEnv("TRIBE_NO_DAEMON")).toBe("a")
    expect(getEnv("TRIBE_LOG")).toBe("b")
    expect(getEnv("TRIBE_LORE_SOCKET")).toBe("c")
    expect(getEnv("TRIBE_LORE_DB")).toBe("d")
    expect(getEnv("TRIBE_SUMMARIZER_MODEL")).toBe("e")
    expect(getEnv("TRIBE_FOCUS_POLL_MS")).toBe("f")
    expect(getEnv("TRIBE_SUMMARY_POLL_MS")).toBe("g")
    await flushMicrotasks()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
