import type { Model } from "./types"
import { describeDispatchFailure, getRetiredModelReplacement } from "./dispatch-error"

export const DEFAULT_LEG_TIMEOUT_MS = 15 * 60 * 1_000

function formatDuration(milliseconds: number): string {
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`
  return `${milliseconds}ms`
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new Error(typeof reason === "string" && reason.length > 0 ? reason : "aborted")
}

export function getLegTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LLM_LEG_TIMEOUT_MS
  if (raw === undefined || raw === "") return DEFAULT_LEG_TIMEOUT_MS
  const timeoutMs = Number(raw)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("LLM_LEG_TIMEOUT_MS must be a positive finite number of milliseconds")
  }
  return Math.floor(timeoutMs)
}

export function assertDispatchableModelIds(modelIds: readonly string[]): void {
  for (const modelId of modelIds) {
    const replacement = getRetiredModelReplacement(modelId)
    if (replacement) {
      throw new Error(
        `Model "${modelId}" is unavailable or renamed; replace it with "${replacement}" in dual-pro-config.json.`,
      )
    }
  }
}

export async function runWithTimeout<T>({
  label,
  timeoutMs,
  outerSignal,
  run,
}: {
  label: string
  timeoutMs: number
  outerSignal?: AbortSignal
  run(signal: AbortSignal): Promise<T>
}): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive finite number")
  }
  if (outerSignal?.aborted) throw abortError(outerSignal.reason)

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onOuterAbort: (() => void) | undefined
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `${label} timed out after ${formatDuration(timeoutMs)}; partial results will be reported.`,
      )
      controller.abort(error)
      reject(error)
    }, timeoutMs)
    if (outerSignal) {
      onOuterAbort = () => {
        const error = abortError(outerSignal.reason)
        controller.abort(error)
        reject(error)
      }
      outerSignal.addEventListener("abort", onOuterAbort, { once: true })
    }
  })

  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), boundary])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (outerSignal && onOuterAbort) outerSignal.removeEventListener("abort", onOuterAbort)
  }
}

export function formatLegDispatchError(
  model: Pick<Model, "displayName" | "modelId" | "provider">,
  error: unknown,
): string {
  return describeDispatchFailure(error, model).message
}
