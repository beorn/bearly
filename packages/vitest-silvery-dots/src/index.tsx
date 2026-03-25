/**
 * DotzReporter - silvery-based Vitest Reporter
 *
 * Renders test results using silvery React components.
 * All output goes through silvery - layout, colors, everything.
 * Zero manual ANSI. Every color, alignment, spacing is a component prop or flex layout.
 */

import * as fs from "node:fs"
import React, { useMemo, useSyncExternalStore, type ReactNode } from "react"
import type { Reporter, TestCase, TestModule, TestSpecification, TestSuite, Vitest } from "vitest/node"
import {
  Box,
  Text,
  Console,
  useContentRect,
  patchConsole,
  type Instance,
  type Term,
  type PatchedConsole,
} from "@silvery/ag-react"
import { createLogger } from "loggily"

import { createTestStore, type TestState, type TestStore, type TestStoreState } from "./store.js"

const log = createLogger("vitestx:dotz")

// =============================================================================
// Constants & Types (exported for testing)
// =============================================================================

export const MAX_SLOW_TESTS = 20
export const DURATION_MULTIPLIER = 10 // Symbol range: 0x to 10x threshold
export const UNMOUNT_DELAY_MS = 50
export const DEFAULT_SYMBOLS = ["·", "•", "●"]

/** Status dot definitions: char, Text style props, legend label */
export const STATUS_DOTS = {
  failed: { char: "x", color: "red" as const, label: "fail" },
  skipped: {
    char: "-",
    color: "gray" as const,
    dim: true as const,
    label: "skip",
  },
  pending: { char: "*", color: "yellow" as const, label: "pending" },
  noisy: { char: "!", color: "magenta" as const, label: "noisy" },
} as const

export type StatusKey = keyof typeof STATUS_DOTS

export interface ReporterOptions {
  slowThreshold?: number
  perfOutput?: string
  showSlow?: boolean
  symbols?: string[]
}

export type Options = Required<ReporterOptions>

// =============================================================================
// Core Algorithm: Duration → Symbol (exported for testing)
// =============================================================================

/**
 * Maps test duration to a symbol index and brightness.
 * Duration range [0, threshold * DURATION_MULTIPLIER] maps to symbol indices [0, n-1].
 * Tests exceeding the range get the last symbol with bright styling.
 */
export function durationToSymbol(duration: number, threshold: number, symbols: string[]) {
  const stage = Math.floor(((duration / threshold) * symbols.length) / DURATION_MULTIPLIER)
  const maxIndex = symbols.length - 1
  return {
    char: symbols[Math.min(stage, maxIndex)] ?? "●",
    bright: stage > maxIndex,
  }
}

// =============================================================================
// React Components
// =============================================================================

function useStore(store: TestStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

export interface ReportProps {
  store: TestStore
  options: Options
  /** Override width for testing (bypasses useContentRect) */
  width?: number
  /** Patched console for capturing output */
  console?: PatchedConsole
}

export function Report({ store, options, width, console: patched }: ReportProps) {
  const state = useStore(store)
  // During live streaming, only show dots + summary to avoid exceeding terminal height.
  // Full report (package table, slow tests, failures) is shown in final static output.
  const isLive = state.isRunning
  return (
    <Box id="report" flexDirection="column">
      {patched && <Console console={patched} />}
      <DotsSection state={state} options={options} width={width} />
      <Summary state={state} />
      {!isLive && <PackageTable state={state} />}
      {!isLive && <SlowTests state={state} options={options} />}
      <Failures state={state} />
    </Box>
  )
}

// --- Dot rendering ---

export function StatusDot({ status }: { status: StatusKey }) {
  const { char, label: _, ...style } = STATUS_DOTS[status]
  return <Text {...style}>{char}</Text>
}

/** Single dot for legend use only. Bulk rendering uses DotStrip. */
type DotProps = { status: "passed"; duration: number; options: Options } | { status: StatusKey }

export function Dot(props: DotProps) {
  if (props.status !== "passed") return <StatusDot status={props.status} />
  const { char, bright } = durationToSymbol(props.duration, props.options.slowThreshold, props.options.symbols)
  return (
    <Text color="green" dim={!bright}>
      {char}
    </Text>
  )
}

/** Style key for grouping consecutive dots */
type DotStyle = { color: string; dim: boolean; bold?: boolean }

/** Resolve a test ID to its dot character and style */
function resolveDot(id: string, state: TestStoreState, options: Options): { char: string; style: DotStyle } {
  const testState = state.testStates.get(id) ?? "pending"
  const isNoisy = state.noisyTestIds.has(id)

  // Noisy (unless failed)
  if (isNoisy && testState !== "failed") {
    const dot = STATUS_DOTS.noisy
    return { char: dot.char, style: { color: dot.color, dim: false } }
  }

  // Status dots (failed, skipped, pending)
  if (testState in STATUS_DOTS) {
    const dot = STATUS_DOTS[testState as StatusKey]
    return {
      char: dot.char,
      style: { color: dot.color, dim: "dim" in dot && !!dot.dim },
    }
  }

  // Passed: duration-based symbol
  const duration = state.testDurations.get(id) ?? 0
  const { char, bright } = durationToSymbol(duration, options.slowThreshold, options.symbols)
  return { char, style: { color: "green", dim: !bright } }
}

function styleKey(s: DotStyle): string {
  return `${s.color}:${s.dim ? 1 : 0}`
}

/**
 * Bulk dot renderer: renders a list of test IDs as grouped <Text> elements.
 * Batches consecutive dots with the same style into single <Text> nodes.
 * For 4700 tests, this produces ~10-50 React elements instead of 4700.
 */
export function DotStrip({ testIds, state, options }: { testIds: string[]; state: TestStoreState; options: Options }) {
  const groups: ReactNode[] = []
  let currentChars = ""
  let currentStyle: DotStyle | null = null
  let currentKey = ""

  for (const id of testIds) {
    const { char, style } = resolveDot(id, state, options)
    const key = styleKey(style)
    if (key === currentKey) {
      currentChars += char
    } else {
      if (currentStyle && currentChars) {
        groups.push(
          <Text key={groups.length} color={currentStyle.color} dim={currentStyle.dim}>
            {currentChars}
          </Text>,
        )
      }
      currentChars = char
      currentStyle = style
      currentKey = key
    }
  }
  if (currentStyle && currentChars) {
    groups.push(
      <Text key={groups.length} color={currentStyle.color} dim={currentStyle.dim}>
        {currentChars}
      </Text>,
    )
  }

  return <>{groups}</>
}

export function DurationSymbol({ duration, options }: { duration: number; options: Options }) {
  const { char, bright } = durationToSymbol(duration, options.slowThreshold, options.symbols)
  return (
    <Text color="green" dim={!bright}>
      {char}
    </Text>
  )
}

// --- Layout components ---

function LegendItem({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Box flexDirection="row" gap={1}>
      {children}
      <Text dim>{label}</Text>
    </Box>
  )
}

export function DotsLegend({ options }: { options: Options }) {
  return (
    <Box flexDirection="row" gap={2} marginBottom={1}>
      <Text dim>Legend:</Text>
      <LegendItem label="fast">
        <Dot status="passed" duration={0} options={options} />
      </LegendItem>
      <LegendItem label="slow">
        <Dot status="passed" duration={options.slowThreshold * DURATION_MULTIPLIER} options={options} />
      </LegendItem>
      {(Object.keys(STATUS_DOTS) as StatusKey[]).map((status) => (
        <LegendItem key={status} label={STATUS_DOTS[status].label}>
          <Dot status={status} />
        </LegendItem>
      ))}
    </Box>
  )
}

export interface DotsSectionProps {
  state: TestStoreState
  options: Options
  /** Override width for testing (bypasses useContentRect) */
  width?: number
}

/** Wrapper that uses useContentRect when width is not provided */
export function DotsSection({ width, ...props }: DotsSectionProps) {
  if (width !== undefined) {
    return <DotsSectionInner {...props} width={width} />
  }
  return <DotsSectionWithLayout {...props} />
}

function DotsSectionWithLayout(props: Omit<DotsSectionProps, "width">) {
  const contentRect = useContentRect()
  return <DotsSectionInner {...props} width={contentRect.width ?? 80} />
}

/** Per-package breakout analysis */
interface PackageLayout {
  category: string
  wantsBreakout: boolean
  linesIfBreakout: number
  linesIfNot: number
  fileCount: number
}

/** Screen-aware file breakout: breaks out files dynamically based on visual pressure and screen budget */
function computeBreakouts(
  state: TestStoreState,
  maxLabelWidth: number,
  dotsWidth: number,
  screenHeight: number,
): Set<string> {
  const packages: PackageLayout[] = []

  for (const category of state.categoryOrder) {
    const catStats = state.categoryStats.get(category)
    if (!catStats) continue

    const totalDots = catStats.testIds.length
    const packageLines = Math.ceil(totalDots / Math.max(1, dotsWidth))
    const fileCount = catStats.fileOrder.length

    // Break out when: >2 lines of dots, or >1 line with >3 files
    const wantsBreakout = fileCount > 1 && (packageLines > 2 || (packageLines > 1 && fileCount > 3))

    // Lines if broken out: 1 header + 1 per file (each file's dots may wrap)
    const linesIfBreakout = wantsBreakout
      ? 1 +
        catStats.fileOrder.reduce((sum, file) => {
          const fileStats = catStats.files.get(file)
          if (!fileStats) return sum + 1
          const fileDotsWidth = dotsWidth
          return sum + Math.max(1, Math.ceil(fileStats.testIds.length / Math.max(1, fileDotsWidth)))
        }, 0)
      : packageLines

    packages.push({
      category,
      wantsBreakout,
      linesIfBreakout,
      linesIfNot: packageLines,
      fileCount,
    })
  }

  // Budget: available screen lines for dots section (leave room for legend, summary, etc.)
  const availableLines = Math.max(10, screenHeight - 10)
  let totalLines = packages.reduce((sum, p) => sum + (p.wantsBreakout ? p.linesIfBreakout : p.linesIfNot), 0)

  // If over budget, disable breakouts starting with smallest packages first
  if (totalLines > availableLines) {
    const sorted = [...packages].filter((p) => p.wantsBreakout).sort((a, b) => a.fileCount - b.fileCount)

    for (const pkg of sorted) {
      if (totalLines <= availableLines) break
      pkg.wantsBreakout = false
      totalLines -= pkg.linesIfBreakout - pkg.linesIfNot
    }
  }

  return new Set(packages.filter((p) => p.wantsBreakout).map((p) => p.category))
}

function DotsSectionInner({ state, options, width: cols }: Omit<DotsSectionProps, "width"> & { width: number }) {
  const maxLabelWidth = Math.min(Math.max(...state.categoryOrder.map((c) => c.length), 12) + 1, 24)
  const dotsWidth = cols - maxLabelWidth - 1

  // Screen-aware file breakout (recomputed each render — cheap O(categories) scan)
  const fileBreakouts = computeBreakouts(state, maxLabelWidth, dotsWidth, process.stdout.rows || 40)

  return (
    <Box id="dots" flexDirection="column">
      <DotsLegend options={options} />
      {state.categoryOrder.map((category) => {
        const catStats = state.categoryStats.get(category)
        if (!catStats) return null

        if (fileBreakouts.has(category)) {
          return (
            <Box key={category} flexDirection="column">
              <Text bold color="cyan">
                {category}
              </Text>
              {catStats.fileOrder.map((file) => {
                const fileStats = catStats.files.get(file)
                if (!fileStats) return null
                const name = file.replace(/\.(test|spec)\.(ts|tsx|js|jsx|md)$/, "")
                return (
                  <Box key={file} flexDirection="row">
                    <Box width={maxLabelWidth}>
                      <Text dim>
                        {"  "}
                        {name}
                      </Text>
                    </Box>
                    <Box flexDirection="row" flexWrap="wrap" width={dotsWidth}>
                      <DotStrip testIds={fileStats.testIds} state={state} options={options} />
                    </Box>
                  </Box>
                )
              })}
            </Box>
          )
        }

        return (
          <Box key={category} flexDirection="row">
            <Box width={maxLabelWidth}>
              <Text color="cyan">{category}</Text>
            </Box>
            <Box flexDirection="row" flexWrap="wrap" width={dotsWidth}>
              <DotStrip testIds={catStats.testIds} state={state} options={options} />
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function Sep() {
  return <Text dim>{" | "}</Text>
}

export function Summary({ state }: { state: TestStoreState }) {
  const { passed, failed, skipped } = state
  const total = passed + failed + skipped
  const elapsed = Date.now() - state.startTime
  const sum = [...state.testDurations.values()].reduce((a, b) => a + b, 0)

  const counts: ReactNode[] = []
  if (failed > 0)
    counts.push(
      <Text key="f" bold color="red">
        {failed} failed
      </Text>,
    )
  if (passed > 0)
    counts.push(
      <Text key="p" bold color="green">
        {passed} passed
      </Text>,
    )
  if (skipped > 0)
    counts.push(
      <Text key="s" color="yellow">
        {skipped} skipped
      </Text>,
    )

  return (
    <Box id="summary" flexDirection="row" marginTop={1}>
      <Text dim>Tests </Text>
      {counts.length > 0 ? (
        counts.map((node, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Sep />}
            {node}
          </React.Fragment>
        ))
      ) : (
        <Text dim>0</Text>
      )}
      <Text color="gray">{` (${total})`}</Text>
      <Text>{"  "}</Text>
      <Text dim>Time </Text>
      <Text>{fmtDuration(elapsed)}</Text>
      <Text color="gray">{` (sum ${fmtDuration(sum)})`}</Text>
    </Box>
  )
}

export function PackageTable({ state }: { state: TestStoreState }) {
  const w = useMemo(() => Math.max(...state.categoryOrder.map((c) => c.length), 12), [state.categoryOrder])

  if (state.categoryOrder.length <= 1) return null

  return (
    <Box id="package-table" flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Box width={w}>
          <Text bold color="white">
            PACKAGE
          </Text>
        </Box>
        <Box width={7}>
          <Text bold color="white">
            {" TESTS".padStart(7)}
          </Text>
        </Box>
        <Box width={10}>
          <Text bold color="white">
            {"TIME".padStart(10)}
          </Text>
        </Box>
        <Box width={8}>
          <Text bold color="white">
            {"SLOW".padStart(8)}
          </Text>
        </Box>
      </Box>
      {state.categoryOrder.map((cat) => {
        const st = state.categoryStats.get(cat)
        if (!st) return null
        const n = st.passed + st.failed + st.skipped
        const slow = st.slowCount > 0 ? String(st.slowCount).padStart(6) : "     -"
        const rowColor = st.failed > 0 ? ("red" as const) : undefined
        const rowDim = st.failed <= 0
        return (
          <Box key={cat} flexDirection="row">
            <Box width={w}>
              <Text color={rowColor} dim={rowDim}>
                {cat}
              </Text>
            </Box>
            <Box width={7}>
              <Text color={rowColor} dim={rowDim}>
                {String(n).padStart(7)}
              </Text>
            </Box>
            <Box width={10}>
              <Text color={rowColor} dim={rowDim}>
                {fmtDuration(st.duration).padStart(10)}
              </Text>
            </Box>
            <Box width={8}>
              <Text color={rowColor} dim={rowDim}>
                {slow.padStart(8)}
              </Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

export function SlowTests({ state, options }: { state: TestStoreState; options: Options }) {
  if (!options.showSlow || state.topSlowest.length === 0) return null

  const { symbols, slowThreshold } = options
  const rangePerSymbol = DURATION_MULTIPLIER / symbols.length

  return (
    <Box id="slow-tests" flexDirection="column" marginTop={1}>
      <Box flexDirection="row" gap={2}>
        <Text bold>SLOW TESTS</Text>
        {symbols.slice(1).map((sym, i) => {
          const minMs = Math.round(slowThreshold * (i + 1) * rangePerSymbol)
          return (
            <Box key={i} flexDirection="row" gap={1}>
              <Text color="green" dim>
                {sym}
              </Text>
              <Text dim>≥{fmtMs(minMs)}</Text>
            </Box>
          )
        })}
        <Box flexDirection="row" gap={1}>
          <Text color="green">{symbols.at(-1) ?? "●"}</Text>
          <Text dim>≥{fmtMs(slowThreshold * DURATION_MULTIPLIER)}</Text>
        </Box>
      </Box>
      {state.topSlowest.slice(0, MAX_SLOW_TESTS).map((test, i) => {
        const loc = test.line ? `${test.file}:${test.line}` : test.file
        return (
          <Box key={i} flexDirection="row" gap={1}>
            <DurationSymbol duration={test.duration} options={options} />
            <Text color="green">{fmtDuration(test.duration).padStart(6)}</Text>
            <Text color="gray">{loc} &gt;</Text>
            <Text>{test.name}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

export function Failures({ state }: { state: TestStoreState }) {
  if (state.testErrors.size === 0) return null

  return (
    <Box id="failures" flexDirection="column" marginTop={1}>
      <Text bold color="red">
        FAILURES
      </Text>
      {[...state.testErrors.values()].map((err, i) => (
        <Box key={i} flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Text color="red">✗</Text>
            <Text bold>{err.name}</Text>
          </Box>
          <Box marginLeft={2}>
            <Text dim>{err.file}</Text>
          </Box>
          {err.errors.map((e, j) => (
            <Box key={j} flexDirection="column">
              <Box marginLeft={2}>
                <Text>{e.message}</Text>
              </Box>
              {e.stack?.split("\n").map((line, k) => (
                <Text key={k} dim>
                  {line}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

// =============================================================================
// Reporter Class
// =============================================================================

const packageNameCache = new Map<string, string>()

class DotzReporter implements Reporter {
  private store: TestStore
  private options: Options
  private finishedTests = new Set<string>()
  private finishedCalled = false
  private app: Instance | null = null
  private term: Term | null = null
  private patchedConsole: PatchedConsole | null = null
  private disposables: DisposableStack | null = null
  private isTTY = process.stdout.isTTY === true
  private prevActEnv: boolean | undefined

  constructor(opts: ReporterOptions = {}) {
    this.options = {
      slowThreshold: opts.slowThreshold ?? 100,
      perfOutput: opts.perfOutput ?? "",
      showSlow: opts.showSlow ?? true,
      symbols: opts.symbols ?? DEFAULT_SYMBOLS,
    }
    this.store = createTestStore(this.options.slowThreshold)
    log.debug?.(`reporter initialized: ${JSON.stringify(this.options)}, isTTY: ${this.isTTY}`)
  }

  onInit(_ctx: Vitest) {
    log.debug?.("onInit")
  }

  async onTestRunStart(_specs: readonly TestSpecification[]) {
    log.debug?.(`onTestRunStart: ${_specs.length} specs`)
    this.store.reset()
    this.store.setRunning(true)
    this.finishedTests.clear()
    this.finishedCalled = false
    if (this.isTTY && !this.app) await this.startStreaming()
  }

  private async startStreaming() {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    this.prevActEnv = g.IS_REACT_ACT_ENVIRONMENT
    g.IS_REACT_ACT_ENVIRONMENT = false

    const { render, createTerm } = await import("@silvery/ag-react")
    const stack = new DisposableStack()
    this.disposables = stack
    this.term = stack.use(createTerm())
    this.patchedConsole = stack.use(patchConsole(console))
    this.app = stack.use(
      await render(<Report store={this.store} options={this.options} console={this.patchedConsole} />, this.term, {
        // mode: "inline",
        // alternateScreen: false,
      }),
    )
  }

  onTestModuleCollected(module: TestModule) {
    log.debug?.(`onTestModuleCollected: ${getModuleId(module)}`)
    for (const test of module.children.allTests()) this.onTestCaseReady(test)
  }

  onTestSuiteReady(suite: TestSuite) {
    log.debug?.(`onTestSuiteReady: ${suite.name}`)
    for (const test of suite.children.allTests()) this.onTestCaseReady(test)
  }

  onTestCaseReady(testCase: TestCase) {
    if (this.finishedTests.has(testCase.id)) return
    const moduleId = getModuleId(testCase.module)
    this.store.addTest(testCase.id, extractCategory(moduleId), extractFileName(moduleId))
  }

  onTestCaseResult(testCase: TestCase) {
    const result = testCase.result()
    if (!result) return

    const { id, name, module } = testCase
    const diagnostic = testCase.diagnostic()
    const duration = diagnostic?.duration ?? 0
    const moduleId = getModuleId(module)

    const testState: TestState = result.state === "passed" ? "passed" : result.state === "failed" ? "failed" : "skipped"

    this.finishedTests.add(id)

    const errors =
      testState === "failed" && result.errors?.length
        ? result.errors.map((e) => ({
            message: e.message ?? "Unknown error",
            stack: e.stack,
          }))
        : undefined

    const logs = diagnostic as { stdout?: string; stderr?: string } | undefined
    const isNoisy = Boolean(logs?.stdout || logs?.stderr)
    const line = extractLineNumber(testCase)

    this.store.updateTest(id, testState, duration, errors, isNoisy)
    this.store.updateSlowest(name, relativePath(moduleId), line, duration, this.options.slowThreshold)
  }

  onTestModuleEnd(_: TestModule) {}

  async onTestRunEnd(testModules?: Iterable<TestModule>, errors?: readonly unknown[]) {
    log.debug?.(`onTestRunEnd testModules=${!!testModules} errors=${(errors as unknown[])?.length}`)
    await this.finishRun()
  }

  async onFinished() {
    log.debug?.("onFinished")
    await this.finishRun()
  }

  private async finishRun() {
    if (this.finishedCalled) return
    this.finishedCalled = true
    this.store.setRunning(false)

    if (this.app) {
      // Flush any pending throttled store notifications + render
      this.store.flushNotify()
      this.app.flush()
      await new Promise<void>((resolve) => {
        setTimeout(resolve, UNMOUNT_DELAY_MS)
      })
      this.disposables?.[Symbol.dispose]()
      this.disposables = null
      this.app = null
      this.term = null
      this.patchedConsole = null
      ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = this.prevActEnv

      // Print summary to console after clearing fullscreen
      await printSummary(this.store, this.options)
    } else {
      await printSummary(this.store, this.options)
    }

    if (this.options.perfOutput) {
      exportPerformance(this.store.getSnapshot(), this.options)
    }
  }
}

export default DotzReporter

// =============================================================================
// Helpers
// =============================================================================

function getModuleId(module: unknown) {
  return (module as { moduleId?: string }).moduleId ?? "unknown"
}

function relativePath(path: string) {
  const cwd = process.cwd()
  return path.startsWith(cwd) ? path.slice(cwd.length + 1) : path
}

function extractFileName(moduleId: string) {
  return relativePath(moduleId).split("/").pop() || "unknown"
}

function extractCategory(moduleId: string) {
  const rel = relativePath(moduleId)
  const parts = rel.split("/")
  const cwd = process.cwd()

  for (let i = parts.length - 1; i >= 0; i--) {
    const dirPath = parts.slice(0, i + 1).join("/")
    const cached = packageNameCache.get(dirPath)
    if (cached !== undefined) return cached

    try {
      const pkgPath = `${cwd}/${dirPath}/package.json`
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
          name?: string
        }
        const name = pkg.name ?? dirPath
        packageNameCache.set(dirPath, name)
        return name
      }
    } catch {}
  }

  const groupingDirs = ["packages", "apps", "vendor", "tests"]
  const fallback =
    parts.length >= 2 && parts[0] && groupingDirs.includes(parts[0]) ? `${parts[0]}/${parts[1]}` : parts[0] || "root"
  packageNameCache.set(fallback, fallback)
  return fallback
}

function extractLineNumber(testCase: TestCase) {
  const meta = testCase.meta() as { mdtestLocation?: { line?: number } } | undefined
  const loc = (testCase as { location?: { line?: number } }).location
  return meta?.mdtestLocation?.line ?? loc?.line
}

async function printSummary(store: TestStore, options: Options) {
  const { renderStatic } = await import("@silvery/ag-react")
  const width = process.stdout.columns || 80
  // Use large height to avoid truncation - static output doesn't need fixed height
  const output = await renderStatic(<Report store={store} options={options} width={width} />, { width, height: 1000 })
  // Trim trailing empty lines from the buffer output
  console.log(output.replace(/\n+$/, ""))
}

function exportPerformance(state: TestStoreState, options: Options) {
  const allTests = [...state.testDurations.entries()].map(([id, duration]) => ({
    id,
    duration,
    state: state.testStates.get(id) ?? "pending",
    file: state.testToFile.get(id) ?? "unknown",
  }))

  fs.writeFileSync(
    options.perfOutput,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        summary: {
          passed: state.passed,
          failed: state.failed,
          skipped: state.skipped,
          elapsed: Date.now() - state.startTime,
          testDuration: [...state.testDurations.values()].reduce((a, b) => a + b, 0),
        },
        slowTests: allTests.filter((t) => t.duration >= options.slowThreshold).sort((a, b) => b.duration - a.duration),
        allTests,
      },
      null,
      2,
    ),
  )
}

export function fmtDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`
}

export function fmtMs(ms: number) {
  return ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`
}
