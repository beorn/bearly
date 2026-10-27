import type { HarnessLeg } from "./dual-pro"

/** A harness leg never waits longer than this, whatever the API leg timeout is. */
export const HARNESS_RUN_TIMEOUT_CAP_MS = 300_000

/** How many stderr lines an incomplete leg keeps. */
const STDERR_TAIL_LINES = 20

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
  readonly notes: readonly string[]
  readonly stderrTail?: string
  readonly argv: readonly string[]
  readonly timeoutMs: number
}

type NativeExit = {
  exitCode: number | null
  timedOut: boolean
  stdout?: string
  stdoutOverCap?: boolean
  stderrTail?: string
  spawnError?: string
  ms: number
}

type NativeRunModule = {
  harnessLegLaunch: (input: {
    harness: "claude" | "codex"
    account: string
    model: string
    prompt: string
    env?: NodeJS.ProcessEnv
  }) => { argv: readonly string[]; env: NodeJS.ProcessEnv; notes: readonly string[] }
  agCodeRunner: (
    timeoutMs?: number,
    options?: { stdout?: "full" },
  ) => (argv: readonly string[], env: NodeJS.ProcessEnv) => Promise<NativeExit>
}

export function harnessTimeoutMs(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return HARNESS_RUN_TIMEOUT_CAP_MS
  return Math.min(requested, HARNESS_RUN_TIMEOUT_CAP_MS)
}

function stderrTail(text: string | undefined): string | undefined {
  if (!text) return undefined
  const lines = text.split("\n").slice(-STDERR_TAIL_LINES).join("\n").trim()
  return lines.length > 0 ? lines : undefined
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
  const launch = native.harnessLegLaunch({
    harness,
    account: request.account,
    model: request.leg.model,
    prompt: request.question,
    env,
  })
  const timeoutMs = harnessTimeoutMs(request.timeoutMs)
  const result = await native.agCodeRunner(timeoutMs, { stdout: "full" })(launch.argv, launch.env)
  const base = {
    provider: "harness" as const,
    harness: request.leg.provider,
    model: request.leg.model,
    account: request.account,
    notes: launch.notes,
    stderrTail: stderrTail(result.stderrTail),
    argv: launch.argv,
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
