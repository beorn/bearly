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

import { beforeEach, describe, expect, it, vi } from "vitest"
import * as path from "node:path"
import { makeTestEnv } from "./helpers"

/**
 * The output-mode shim holds two module-level singletons (`_fullPaths`, and the
 * default DispatchContext it shares with context.ts). A fresh module graph is
 * the reset the tests used to get from the deleted `resetOutputMode()`: each
 * test re-imports the module, so it starts at the defaults and no state leaks
 * between tests or parallel workers.
 */
type OutputMode = typeof import("../src/lib/output-mode")
let outputMode: OutputMode
beforeEach(async () => {
  vi.resetModules()
  outputMode = await import("../src/lib/output-mode")
})

const generateTextMock = vi.fn()
const streamTextMock = vi.fn()
vi.mock("ai", () => ({ generateText: generateTextMock, streamText: streamTextMock }))

function resetMocks() {
  generateTextMock.mockReset()
  generateTextMock.mockResolvedValue({
    text: "ok",
    finalStep: { reasoningText: undefined },
    usage: { inputTokens: 10, outputTokens: 5 },
  })
  streamTextMock.mockReset()
  streamTextMock.mockImplementation(() => ({
    textStream: (async function* () {
      yield "ok"
    })(),
    finalStep: Promise.resolve({ response: undefined }),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
  }))
}

describe("formatEnvelopeFile — pure relativization helper", () => {
  it("returns basename for absolute /tmp path under default mode", () => {
    const out = outputMode.formatEnvelopeFile("/tmp/llm-abc12345-something-1234.txt", {
      fullPaths: false,
      cwd: "/Users/me/project",
    })
    expect(out).toBe("llm-abc12345-something-1234.txt")
    expect(out.startsWith("/")).toBe(false)
  })

  it("returns cwd-relative path when file lives under cwd", () => {
    const out = outputMode.formatEnvelopeFile("/Users/me/project/out/llm-x.txt", {
      fullPaths: false,
      cwd: "/Users/me/project",
    })
    // path.relative produces "out/llm-x.txt"
    expect(out).toBe(path.join("out", "llm-x.txt"))
    expect(out.startsWith("/")).toBe(false)
  })

  it("returns basename when relative path would escape cwd (../...)", () => {
    const out = outputMode.formatEnvelopeFile("/var/folders/abc/llm-foo.txt", {
      fullPaths: false,
      cwd: "/Users/me/project",
    })
    expect(out).toBe("llm-foo.txt")
    expect(out.startsWith("/")).toBe(false)
    expect(out.includes("..")).toBe(false)
  })

  it("returns absolute path verbatim when fullPaths=true", () => {
    const abs = "/tmp/llm-abc12345-something-1234.txt"
    const out = outputMode.formatEnvelopeFile(abs, { fullPaths: true, cwd: "/Users/me/project" })
    expect(out).toBe(abs)
  })

  it("preserves non-absolute input verbatim (already relative)", () => {
    const out = outputMode.formatEnvelopeFile("./foo.txt", { fullPaths: false, cwd: "/Users/me/project" })
    expect(out).toBe("./foo.txt")
  })
})

describe("setFullPaths / isFullPaths", () => {
  it("flips on the live module, and a fresh import starts false again", async () => {
    expect(outputMode.isFullPaths()).toBe(false)
    outputMode.setFullPaths(true)
    expect(outputMode.isFullPaths()).toBe(true)
    // Guard the invariant the deleted reset existed for: a new module graph
    // starts with the flag off, so no test can inherit another's setting.
    vi.resetModules()
    outputMode = await import("../src/lib/output-mode")
    expect(outputMode.isFullPaths()).toBe(false)
  })
})

describe("--full-paths CLI flag end-to-end", () => {
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
