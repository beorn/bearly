/**
 * `bun llm pro --diagnostics` — speed, failure rate, and cost distribution
 * per model from ab-pro.jsonl. Display-only signals that the quality-first
 * leaderboard intentionally hides (km-bearly.llm-refactor Phase 1D).
 *
 * Plain-text mode prints three sections to stderr. JSON mode emits a
 * structured envelope on stdout (per output-mode contract).
 */

import { emitJson, isJsonMode } from "../lib/output-mode"

/** Per-model speed report row. Sourced from successful ab-pro.jsonl entries. */
export interface DiagnosticsSpeedRow {
  model: string
  calls: number
  avgMs: number
  p50Ms: number
  p95Ms: number
}

/** Per-model failure-rate report row. Includes a warn flag when fail rate is suspicious. */
export interface DiagnosticsFailureRow {
  model: string
  calls: number
  successCalls: number
  failureRate: number
  warn: boolean
}

/** Per-model cost-distribution report row. Successful calls only. */
export interface DiagnosticsCostRow {
  model: string
  calls: number
  avgUsd: number
  p50Usd: number
  p95Usd: number
  p99Usd: number
}

/** Aggregated diagnostics envelope — what `--diagnostics --json` emits. */
export interface DiagnosticsReport {
  status: "ok" | "empty"
  speed: DiagnosticsSpeedRow[]
  failureRate: DiagnosticsFailureRow[]
  costDist: DiagnosticsCostRow[]
}

const SPEED_MIN_CALLS = 5
const COST_MIN_CALLS = 10
const FAILURE_WARN_RATE = 0.3
const FAILURE_WARN_MIN_CALLS = 20

/** Quantile of an unsorted numeric array, linear interpolation between samples. */
function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]!
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

/**
 * Build the three diagnostic reports from raw ab-pro.jsonl entries. Pure —
 * no I/O, no side effects. Exported for testability and reuse.
 *
 * - Speed: avg/p50/p95 over successful calls; rows with calls ≥ 5.
 * - Failure rate: success/total per model; warn when >30% AND calls ≥ 20.
 * - Cost distribution: avg/p50/p95/p99 over successful calls; rows with calls ≥ 10.
 */
export function buildDiagnostics(entries: readonly import("../lib/dual-pro").AbProEntry[]): DiagnosticsReport {
  type Stat = { calls: number; success: number; durations: number[]; costs: number[] }
  const stats = new Map<string, Stat>()
  const bumpLeg = (leg?: import("../lib/dual-pro").AbProLegEntry) => {
    if (!leg?.model) return
    const s = stats.get(leg.model) ?? { calls: 0, success: 0, durations: [], costs: [] }
    s.calls += 1
    if (leg.ok) {
      s.success += 1
      if (leg.durationMs != null) s.durations.push(leg.durationMs)
      if (leg.cost != null) s.costs.push(leg.cost)
    }
    stats.set(leg.model, s)
  }
  for (const e of entries) {
    if (e.gpt) bumpLeg({ model: e.gpt.model, ok: e.gpt.ok, cost: e.gpt.cost, durationMs: e.gpt.durationMs })
    if (e.kimi) bumpLeg({ model: e.kimi.model, ok: e.kimi.ok, cost: e.kimi.cost, durationMs: e.kimi.durationMs })
    bumpLeg(e.a)
    bumpLeg(e.b)
    bumpLeg(e.c)
  }

  const speed: DiagnosticsSpeedRow[] = []
  const failureRate: DiagnosticsFailureRow[] = []
  const costDist: DiagnosticsCostRow[] = []

  for (const [model, s] of stats) {
    if (s.success >= SPEED_MIN_CALLS && s.durations.length > 0) {
      const sum = s.durations.reduce((a, b) => a + b, 0)
      speed.push({
        model,
        calls: s.success,
        avgMs: sum / s.durations.length,
        p50Ms: quantile(s.durations, 0.5),
        p95Ms: quantile(s.durations, 0.95),
      })
    }
    const fr = s.calls > 0 ? (s.calls - s.success) / s.calls : 0
    failureRate.push({
      model,
      calls: s.calls,
      successCalls: s.success,
      failureRate: fr,
      warn: fr > FAILURE_WARN_RATE && s.calls >= FAILURE_WARN_MIN_CALLS,
    })
    if (s.success >= COST_MIN_CALLS && s.costs.length > 0) {
      const sum = s.costs.reduce((a, b) => a + b, 0)
      costDist.push({
        model,
        calls: s.success,
        avgUsd: sum / s.costs.length,
        p50Usd: quantile(s.costs, 0.5),
        p95Usd: quantile(s.costs, 0.95),
        p99Usd: quantile(s.costs, 0.99),
      })
    }
  }

  speed.sort((a, b) => a.avgMs - b.avgMs)
  failureRate.sort((a, b) => b.failureRate - a.failureRate || b.calls - a.calls)
  costDist.sort((a, b) => a.avgUsd - b.avgUsd)

  return { status: "ok", speed, failureRate, costDist }
}

export async function runDiagnostics(): Promise<void> {
  const dualPro = await import("../lib/dual-pro")
  const entries = await dualPro.readAbProLog()
  if (entries.length === 0) {
    console.error("No ab-pro.jsonl entries yet. Run `bun llm pro <question>` to start collecting data.")
    if (isJsonMode()) emitJson({ status: "empty", speed: [], failureRate: [], costDist: [] })
    return
  }

  const report = buildDiagnostics(entries)

  if (isJsonMode()) {
    emitJson({
      status: report.status,
      speed: report.speed,
      failureRate: report.failureRate,
      costDist: report.costDist,
    })
    return
  }

  const fmtMs = (n: number) => `${(n / 1000).toFixed(1)}s`
  const fmtPct = (n: number) => `${(n * 100).toFixed(0)}%`
  const fmtCost = (n: number) => `$${n.toFixed(4)}`

  console.error(`\nDiagnostics — ${entries.length} runs from ab-pro.jsonl\n`)

  // ---- Speed ----
  console.error(`Speed (successful calls, ≥${SPEED_MIN_CALLS} per model)`)
  if (report.speed.length === 0) {
    console.error(`  (no models meet the ≥${SPEED_MIN_CALLS}-call threshold yet)`)
  } else {
    console.error(
      `  ${"Model".padEnd(34)} ${"Calls".padStart(6)} ${"Avg".padStart(8)} ${"P50".padStart(8)} ${"P95".padStart(8)}`,
    )
    console.error(`  ${"-".repeat(68)}`)
    for (const r of report.speed) {
      console.error(
        `  ${r.model.padEnd(34)} ${String(r.calls).padStart(6)} ${fmtMs(r.avgMs).padStart(8)} ${fmtMs(r.p50Ms).padStart(8)} ${fmtMs(r.p95Ms).padStart(8)}`,
      )
    }
  }
  console.error("")

  // ---- Failure rate ----
  console.error(`Failure rate (warn: >${(FAILURE_WARN_RATE * 100).toFixed(0)}% with ≥${FAILURE_WARN_MIN_CALLS} calls)`)
  console.error(
    `  ${"Model".padEnd(34)} ${"Calls".padStart(6)} ${"Success".padStart(8)} ${"FailRate".padStart(9)} ${"".padStart(4)}`,
  )
  console.error(`  ${"-".repeat(64)}`)
  for (const r of report.failureRate) {
    const flag = r.warn ? " ⚠" : ""
    console.error(
      `  ${r.model.padEnd(34)} ${String(r.calls).padStart(6)} ${String(r.successCalls).padStart(8)} ${fmtPct(r.failureRate).padStart(9)}${flag}`,
    )
  }
  console.error("")

  // ---- Cost distribution ----
  console.error(`Cost distribution (successful calls, ≥${COST_MIN_CALLS} per model)`)
  if (report.costDist.length === 0) {
    console.error(`  (no models meet the ≥${COST_MIN_CALLS}-call threshold yet)`)
  } else {
    console.error(
      `  ${"Model".padEnd(34)} ${"Calls".padStart(6)} ${"Avg".padStart(10)} ${"P50".padStart(10)} ${"P95".padStart(10)} ${"P99".padStart(10)}`,
    )
    console.error(`  ${"-".repeat(82)}`)
    for (const r of report.costDist) {
      console.error(
        `  ${r.model.padEnd(34)} ${String(r.calls).padStart(6)} ${fmtCost(r.avgUsd).padStart(10)} ${fmtCost(r.p50Usd).padStart(10)} ${fmtCost(r.p95Usd).padStart(10)} ${fmtCost(r.p99Usd).padStart(10)}`,
      )
    }
  }
  console.error("")
}
