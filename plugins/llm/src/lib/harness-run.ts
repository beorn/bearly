import { join } from "node:path"
import {
  buildPairwiseJudgePrompt,
  getMemoryDir,
  parsePairwiseJudgeResponseDetailed,
  type HarnessLeg,
  type PairwiseJudgeResult,
  type Rubric,
} from "./dual-pro"

/** A harness leg never waits longer than this, whatever the API leg timeout is. */
export const HARNESS_RUN_TIMEOUT_CAP_MS = 300_000

/** How many stderr lines an incomplete leg keeps. */
const STDERR_TAIL_LINES = 20

export interface HarnessRunRequest {
  readonly launcher: string | undefined
  readonly leg: HarnessLeg
  readonly account: string
  readonly question: string
  readonly timeoutMs: number
  /** Ask the harness for its own live web search. `/deep` sets this. `/pro` does not. */
  readonly webSearch?: boolean
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
    webSearch?: boolean
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
  const timeoutMs = harnessTimeoutMs(request.timeoutMs)
  let native: NativeRunModule
  try {
    if (!request.launcher?.trim()) throw new Error("launcher is unset")
    const loaded: unknown = await import(request.launcher)
    if (
      !loaded ||
      typeof loaded !== "object" ||
      !("harnessLegLaunch" in loaded) ||
      typeof loaded.harnessLegLaunch !== "function" ||
      !("agCodeRunner" in loaded) ||
      typeof loaded.agCodeRunner !== "function"
    ) {
      throw new Error("module must export harnessLegLaunch and agCodeRunner functions")
    }
    native = loaded as NativeRunModule
  } catch (error) {
    return {
      provider: "harness",
      harness: request.leg.provider,
      model: request.leg.model,
      account: request.account,
      ok: false,
      error: `harnessLauncher ${JSON.stringify(request.launcher) ?? "unset"} in ${join(getMemoryDir(env), "dual-pro-config.json")} for leg ${request.leg.provider} ${request.leg.model}: ${error instanceof Error ? error.message : String(error)}; set harnessLauncher to a module exporting harnessLegLaunch and agCodeRunner`,
      notes: [],
      argv: [],
      timeoutMs,
    }
  }
  const harness = request.leg.provider === "codex" ? "codex" : "claude"
  const launch = native.harnessLegLaunch({
    harness,
    account: request.account,
    model: request.leg.model,
    prompt: request.question,
    env,
    ...(request.webSearch ? { webSearch: true } : {}),
  })
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

/** Score two harness opinions with the same pairwise prompt the API legs use. */
export async function judgeHarnessTexts(args: {
  question: string
  rubric: Rubric
  left: { model: string; content: string }
  right: { model: string; content: string }
  ask: (prompt: string) => Promise<string>
}): Promise<{ ok: true; value: PairwiseJudgeResult } | { ok: false; error: string }> {
  const prompt = buildPairwiseJudgePrompt({
    question: args.question,
    pair: { a: args.left, b: args.right },
    rubric: args.rubric,
  })
  let raw: string
  try {
    raw = await args.ask(prompt)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const parsed = parsePairwiseJudgeResponseDetailed(raw)
  if (!parsed.ok) return { ok: false, error: `${parsed.kind}: ${parsed.message}` }
  return { ok: true, value: parsed.value }
}
