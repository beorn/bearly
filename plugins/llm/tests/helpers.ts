/**
 * Shared test helpers for the @bearly/llm regression suite.
 *
 * Responsibilities:
 *   - Set API-key env vars so `isProviderAvailable` resolves to true, without
 *     ever reaching a real provider (all network calls are mocked).
 *   - Stub process.exit so `error()` calls inside the CLI don't kill the vitest
 *     worker. Exit codes surface as a `__exit_<code>` Error for assertions.
 *   - Redirect file output to a tmpdir to keep /tmp clean and enable per-test
 *     leakage checks (exactly-one-file assertions).
 *
 * Every helper is idempotent — the main() tests call `vi.resetModules()` between
 * invocations to re-run cli.ts's module-scope argv parsing with a fresh argv.
 */

import { afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface TestEnv {
  /** Isolated /tmp substitute for this test — LLM output files end up here. */
  tmpDir: string
  /** Isolated HOME so pricing/partial caches stay contained. */
  homeDir: string
  /** Captured process.exit codes (null = no exit call). */
  exitCodes: number[]
  /** Collected stderr output. */
  stderr: string[]
  /** Collected stdout output. */
  stdout: string[]
}

/**
 * Capture a clean test environment: isolated dirs, API keys set, exit/stdio
 * spied. Call inside a test's top-level scope; cleanup registered via afterEach.
 */
export function makeTestEnv(): TestEnv {
  const tmpDir = mkdtempSync(join(tmpdir(), "bearly-llm-test-"))
  const homeDir = mkdtempSync(join(tmpdir(), "bearly-llm-home-"))

  // Redirect the CLI's tmp output. buildOutputPath() hardcodes "/tmp/llm-…"
  // but we can't easily retarget it mid-test; instead we check the set of
  // /tmp/llm-* files created during the call window (before/after diff).
  process.env.HOME = homeDir
  process.env.CLAUDE_SESSION_ID = "testsess12345678"

  // Keys so `isProviderAvailable` returns true. The providers never actually
  // connect — `ai.generateText` / `ai.streamText` are mocked at the import layer.
  process.env.OPENAI_API_KEY = "sk-test-openai"
  process.env.ANTHROPIC_API_KEY = "sk-test-anthropic"
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google"
  process.env.OPENROUTER_API_KEY = "sk-test-openrouter"
  // Prevent the auto-update-pricing post-run side-effect from firing.
  process.env.LLM_NO_AUTO_PRICING = "1"

  const exitCodes: number[] = []
  const stderr: string[] = []
  const stdout: string[] = []

  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0)
    // Throw so the CLI short-circuits — otherwise execution continues past
    // `error()` calls and we'd see spurious downstream failures.
    throw new Error(`__exit_${code ?? 0}`)
  }) as any)

  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "))
  })
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(" "))
  })
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  }) as any)

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
      rmSync(homeDir, { recursive: true, force: true })
    } catch {}
    vi.restoreAllMocks()
    vi.resetModules()
  })

  return { tmpDir, homeDir, exitCodes, stderr, stdout }
}

/** List llm-*.txt files in /tmp at call time (baseline for diff-assertions). */
export function listLlmTmpFiles(): string[] {
  if (!existsSync("/tmp")) return []
  return readdirSync("/tmp").filter((f) => f.startsWith("llm-") && f.endsWith(".txt"))
}

/**
 * Run one CLI invocation with a fresh module graph and argv.
 *
 * cli.ts does work at module scope (argv parse, model override resolution, etc.)
 * so each invocation requires `vi.resetModules()` + a re-import. `await main()`
 * mirrors the tools/llm.ts wrapper.
 */
export async function runCli(argv: readonly string[]): Promise<{
  returned: string | undefined
  exited: number | undefined
  error?: Error
}> {
  vi.resetModules()
  const prevArgv = process.argv
  // The CLI reads process.argv.slice(2) — first two entries are discarded.
  process.argv = ["node", "cli.ts", ...argv]
  // cli.ts parses argv at module-scope and resolves --model / --image there,
  // so import() itself can throw via the mocked process.exit. Wrap both phases.
  try {
    const mod = await import("../src/cli")
    const returned = await mod.main()
    return { returned, exited: undefined }
  } catch (e) {
    const err = e as Error
    const match = /^__exit_(\d+)$/.exec(err.message)
    if (match) return { returned: undefined, exited: parseInt(match[1]!, 10) }
    return { returned: undefined, exited: undefined, error: err }
  } finally {
    process.argv = prevArgv
  }
}
