/**
 * Regression: JSON envelope `file` field is relativized by default to avoid
 * leaking absolute /tmp paths (which can carry username/hostname/project
 * hashes) into CI logs and log aggregators.
 *
 * Bead: km-bearly.llm-path-leakage.
 *
 * Contract:
 *   - Default mode: `envelope.file` is the basename (or cwd-relative path
 *     if the file lives under cwd). No absolute leading slash for /tmp/
 *     paths (which is the canonical output dir).
 *   - `--full-paths`: restores the absolute path verbatim.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as path from "node:path"
import { makeTestEnv } from "./helpers"
import { resetOutputMode, isFullPaths, setFullPaths, formatEnvelopeFile } from "../src/lib/output-mode"

const generateTextMock = vi.fn()
const streamTextMock = vi.fn()
vi.mock("ai", () => ({ generateText: generateTextMock, streamText: streamTextMock }))

function resetMocks() {
  generateTextMock.mockReset()
  generateTextMock.mockResolvedValue({
    text: "ok",
    reasoning: [],
    usage: { inputTokens: 10, outputTokens: 5 },
  })
  streamTextMock.mockReset()
  streamTextMock.mockImplementation(() => ({
    textStream: (async function* () {
      yield "ok"
    })(),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
  }))
}

describe("formatEnvelopeFile — pure relativization helper", () => {
  beforeEach(() => {
    resetOutputMode()
  })

  it("returns basename for absolute /tmp path under default mode", () => {
    const out = formatEnvelopeFile("/tmp/llm-abc12345-something-1234.txt", {
      fullPaths: false,
      cwd: "/Users/me/project",
    })
    expect(out).toBe("llm-abc12345-something-1234.txt")
    expect(out.startsWith("/")).toBe(false)
  })

  it("returns cwd-relative path when file lives under cwd", () => {
    const out = formatEnvelopeFile("/Users/me/project/out/llm-x.txt", { fullPaths: false, cwd: "/Users/me/project" })
    // path.relative produces "out/llm-x.txt"
    expect(out).toBe(path.join("out", "llm-x.txt"))
    expect(out.startsWith("/")).toBe(false)
  })

  it("returns basename when relative path would escape cwd (../...)", () => {
    const out = formatEnvelopeFile("/var/folders/abc/llm-foo.txt", { fullPaths: false, cwd: "/Users/me/project" })
    expect(out).toBe("llm-foo.txt")
    expect(out.startsWith("/")).toBe(false)
    expect(out.includes("..")).toBe(false)
  })

  it("returns absolute path verbatim when fullPaths=true", () => {
    const abs = "/tmp/llm-abc12345-something-1234.txt"
    const out = formatEnvelopeFile(abs, { fullPaths: true, cwd: "/Users/me/project" })
    expect(out).toBe(abs)
  })

  it("preserves non-absolute input verbatim (already relative)", () => {
    const out = formatEnvelopeFile("./foo.txt", { fullPaths: false, cwd: "/Users/me/project" })
    expect(out).toBe("./foo.txt")
  })
})

describe("setFullPaths / isFullPaths", () => {
  it("flips correctly and resets", () => {
    resetOutputMode()
    expect(isFullPaths()).toBe(false)
    setFullPaths(true)
    expect(isFullPaths()).toBe(true)
    resetOutputMode()
    expect(isFullPaths()).toBe(false)
  })
})

describe("--full-paths CLI flag end-to-end", () => {
  afterEach(() => {
    resetOutputMode()
  })

  it("default mode: envelope.file is basename only (no absolute leading slash for /tmp paths)", async () => {
    const env = makeTestEnv()
    resetMocks()

    vi.resetModules()
    process.argv = ["node", "cli.ts", "--json", "ping"]
    const mod = await import("../src/cli")
    await mod.main()

    const jsonLines = env.stdout.filter((l) => l.trim().startsWith("{"))
    expect(jsonLines).toHaveLength(1)
    const envelope = JSON.parse(jsonLines[0]!) as Record<string, unknown>

    const file = envelope.file as string
    expect(file).toBeTruthy()
    // Core invariant: no leading absolute slash for the canonical /tmp path.
    expect(file.startsWith("/")).toBe(false)
    // Still recognizable as an llm output file.
    expect(file).toMatch(/^llm-.*\.txt$/)
  }, 10_000)

  it("--full-paths restores absolute path", async () => {
    const env = makeTestEnv()
    resetMocks()

    vi.resetModules()
    process.argv = ["node", "cli.ts", "--json", "--full-paths", "ping"]
    const mod = await import("../src/cli")
    await mod.main()

    const jsonLines = env.stdout.filter((l) => l.trim().startsWith("{"))
    expect(jsonLines).toHaveLength(1)
    const envelope = JSON.parse(jsonLines[0]!) as Record<string, unknown>

    const file = envelope.file as string
    expect(file).toBeTruthy()
    expect(file.startsWith("/")).toBe(true)
    expect(file).toMatch(/llm-.*\.txt$/)
  }, 10_000)
})
