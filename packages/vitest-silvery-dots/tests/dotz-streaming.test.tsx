/**
 * DotzReporter Streaming Acceptance Test
 *
 * Verifies that the Report component renders incrementally via flush():
 * store updates → flush() → visible text changes in the output stream.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import React from "react"
import { render, createTerm } from "@silvery/ag-react"
import { stripAnsi } from "@silvery/test"
import { Writable } from "node:stream"

import { Report, DEFAULT_SYMBOLS, type Options } from "../src/index.tsx"
import { createTestStore } from "../src/store.js"

let prevActEnv: boolean | undefined

beforeEach(() => {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  prevActEnv = g.IS_REACT_ACT_ENVIRONMENT
  g.IS_REACT_ACT_ENVIRONMENT = false
  vi.spyOn(console, "info").mockImplementation(() => {})
})

afterEach(() => {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  g.IS_REACT_ACT_ENVIRONMENT = prevActEnv
  vi.restoreAllMocks()
})

function createMockStdout() {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  }) as NodeJS.WriteStream
  stream.isTTY = true
  stream.columns = 80
  stream.rows = 24
  return { stream, chunks }
}

const options: Options = {
  slowThreshold: 100,
  perfOutput: "",
  showSlow: true,
  symbols: DEFAULT_SYMBOLS,
}

describe("streaming", () => {
  it("renders incrementally: legend → pending dots → passed dots → failure", async () => {
    const { stream, chunks } = createMockStdout()
    const store = createTestStore(100)
    const term = createTerm({ stdout: stream })
    const app = await render(<Report store={store} options={options} width={80} />, term, {
      mode: "inline",
      alternateScreen: false,
    })

    const text = () => stripAnsi(chunks.join(""))

    // Initial render: legend visible
    expect(text()).toContain("Legend:")

    // Add tests + flush: pending dots appear, summary updates
    store.addTest("t1", "pkg-a", "file1.test.ts")
    store.addTest("t2", "pkg-a", "file1.test.ts")
    store.flushNotify()
    app.flush()
    expect(text()).toContain("pkg-a")

    // Complete tests + flush: summary shows pass count
    store.updateTest("t1", "passed", 10)
    store.updateTest("t2", "failed", 30, [{ message: "boom" }])
    store.flushNotify()
    app.flush()
    expect(text()).toContain("1 passed")
    expect(text()).toContain("1 failed")
    expect(text()).toContain("FAILURES")
    expect(text()).toContain("boom")

    app.unmount()
    term[Symbol.dispose]()
  })
})
