import type { HarnessLeg } from "./dual-pro"

/** A harness leg never waits longer than this, whatever the API leg timeout is. */
export const HARNESS_RUN_TIMEOUT_CAP_MS = 300_000

/** Print-mode turns. The ruled cap is 3. */
export const HARNESS_MAX_TURNS = 1

export interface HarnessRunRequest {
  readonly leg: HarnessLeg
  readonly account: string
  readonly question: string
  readonly timeoutMs: number
}

export interface HarnessRunOutcome {
  readonly provider: "harness"
  readonly harness: "claude-code" | "codex"
  readonly model: string
  readonly account: string
  readonly ok: boolean
  readonly content?: string
  readonly error?: string
  readonly argv: readonly string[]
  readonly timeoutMs: number
}

type NativeRunModule = {
  agCodeArgv: (
    selection: {
      kind: "account"
      provider: "claude" | "codex"
      label: string
      current: boolean
      default: boolean
      stock: boolean
      harness: "claude" | "codex"
    },
    options: { flags?: readonly string[]; prompt?: string; hooks?: "none" },
  ) => string[]
  agCodeRunner: (
    timeoutMs?: number,
    options?: { stdout?: "full" },
  ) => (
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<{
    exitCode: number | null
    timedOut: boolean
    stdout?: string
    stdoutOverCap?: boolean
    spawnError?: string
    ms: number
  }>
}

export function harnessTimeoutMs(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return HARNESS_RUN_TIMEOUT_CAP_MS
  return Math.min(requested, HARNESS_RUN_TIMEOUT_CAP_MS)
}

export async function runHarnessLeg(
  request: HarnessRunRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HarnessRunOutcome> {
  let native: NativeRunModule
  try {
    native = (await import("@ag/cli/native-run")) as NativeRunModule
  } catch (error) {
    throw new Error(
      `harness leg ${request.leg.provider} ${request.leg.model} cannot load @ag/cli/native-run: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const harness = request.leg.provider === "codex" ? "codex" : "claude"
  const flags =
    harness === "codex"
      ? ["--skip-git-repo-check", "-c", "mcp_servers={}", "--max-turns", String(HARNESS_MAX_TURNS)]
      : ["--max-turns", String(HARNESS_MAX_TURNS), "--output-format", "json"]
  const argv = native.agCodeArgv(
    {
      kind: "account",
      provider: harness,
      label: request.account,
      current: false,
      default: false,
      stock: false,
      harness,
    },
    { flags, prompt: request.question, hooks: "none" },
  )
  const timeoutMs = harnessTimeoutMs(request.timeoutMs)
  const result = await native.agCodeRunner(timeoutMs, { stdout: "full" })(argv, env)
  const base = {
    provider: "harness" as const,
    harness: request.leg.provider,
    model: request.leg.model,
    account: request.account,
    argv,
    timeoutMs,
  }
  if (result.spawnError) return { ...base, ok: false, error: `spawn failed: ${result.spawnError}` }
  if (result.timedOut) return { ...base, ok: false, error: `timed out after ${timeoutMs}ms` }
  if (result.stdoutOverCap) return { ...base, ok: false, error: "stdout exceeded 1 MiB" }
  if (result.exitCode !== 0) {
    return { ...base, ok: false, error: `exit ${result.exitCode ?? "null"}`, content: result.stdout }
  }
  const content = result.stdout?.trim() ?? ""
  if (content.length === 0) return { ...base, ok: false, error: "empty stdout" }
  return { ...base, ok: true, content }
}
