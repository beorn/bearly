/**
 * DotzReporter Acceptance Tests
 *
 * Screen-level tests: render the Report component, check app.text output.
 * Each test exercises a complete scenario end-to-end through the store → render pipeline.
 */

import { describe, it, expect } from "vitest"
import React from "react"
import { createRenderer } from "@silvery/test"

import { Report, DEFAULT_SYMBOLS, type Options } from "../src/index.tsx"
import { createTestStore, type TestStore } from "../src/store.js"

const render = createRenderer({ cols: 80, rows: 50 })

function setup(overrides: Partial<Options> = {}) {
  const store = createTestStore(100)
  const options: Options = {
    slowThreshold: 100,
    perfOutput: "",
    showSlow: true,
    symbols: DEFAULT_SYMBOLS,
    ...overrides,
  }
  const show = (width = 80) => render(<Report store={store} options={options} width={width} />)
  return { store, options, show }
}

/** Add N tests to a package spread across files */
function addTests(
  store: TestStore,
  category: string,
  files: string[],
  count: number,
  state: "passed" | "failed" | "skipped" = "passed",
  duration = 10,
) {
  for (let i = 0; i < count; i++) {
    const id = `${category}-${i}`
    const file = files[i % files.length]!
    store.addTest(id, category, file)
    if (state === "failed") {
      store.updateTest(id, state, duration, [{ message: `Error in ${id}` }])
    } else {
      store.updateTest(id, state, duration)
    }
  }
}

describe("dotz report", () => {
  it("empty: shows legend and zero count", () => {
    const { show } = setup()
    const { text } = show()

    expect(text).toContain("Legend:")
    expect(text).toContain("fast")
    expect(text).toContain("slow")
    expect(text).toContain("fail")
    expect(text).toContain("skip")
    expect(text).toContain("Tests")
    expect(text).toContain("(0)")
    expect(text).not.toContain("PACKAGE")
  })

  it("passing: shows dots, count, and package name", () => {
    const { store, show } = setup()
    addTests(store, "my-pkg", ["a.test.ts"], 5)

    const { text } = show()

    expect(text).toContain("my-pkg")
    expect(text).toContain("5 passed")
    expect(text).toContain("(5)")
  })

  it("mixed states: shows pass/fail/skip counts and failure details", () => {
    const { store, show } = setup()
    store.addTest("t1", "pkg", "a.test.ts")
    store.addTest("t2", "pkg", "a.test.ts")
    store.addTest("t3", "pkg", "a.test.ts")
    store.updateTest("t1", "passed", 10)
    store.updateTest("t2", "failed", 15, [{ message: "Expected true to be false" }])
    store.updateTest("t3", "skipped", 0)

    const { text } = show()

    expect(text).toContain("1 passed")
    expect(text).toContain("1 failed")
    expect(text).toContain("1 skipped")
    expect(text).toContain("FAILURES")
    expect(text).toContain("Expected true to be false")
  })

  it("multiple packages: shows package table", () => {
    const { store, show } = setup()
    addTests(store, "package-alpha", ["a.test.ts"], 10)
    addTests(store, "package-beta", ["b.test.ts"], 5)

    const { text } = show()

    expect(text).toContain("PACKAGE")
    expect(text).toContain("TESTS")
    expect(text).toContain("TIME")
    expect(text).toContain("package-alpha")
    expect(text).toContain("package-beta")
  })

  it("slow tests: shows location and duration", () => {
    const { store, show } = setup()
    store.addTest("t1", "pkg", "slow.test.ts")
    store.updateTest("t1", "passed", 500)
    store.updateSlowest("very slow test", "slow.test.ts", 42, 500, 100)

    const { text } = show()

    expect(text).toContain("SLOW TESTS")
    expect(text).toContain("very slow test")
    expect(text).toContain("slow.test.ts:42")
  })

  it("slow tests hidden when showSlow=false", () => {
    const { store, show } = setup({ showSlow: false })
    store.addTest("t1", "pkg", "slow.test.ts")
    store.updateTest("t1", "passed", 500)
    store.updateSlowest("very slow test", "slow.test.ts", 42, 500, 100)

    expect(show().text).not.toContain("SLOW TESTS")
  })

  it("file breakout: many tests across files triggers per-file lines", () => {
    const { store, show } = setup()
    const files = ["alpha.test.ts", "beta.test.ts", "gamma.test.ts", "delta.test.ts"]
    // 200 tests across 4 files → >2 lines of dots → triggers breakout
    addTests(store, "big-package", files, 200)

    const { text } = show()

    // Package header + per-file labels (without .test.ts extension)
    expect(text).toContain("big-package")
    expect(text).toContain("alpha")
    expect(text).toContain("beta")
    expect(text).toContain("gamma")
    expect(text).toContain("delta")
  })

  it("file breakout: small package stays collapsed", () => {
    const { store, show } = setup()
    addTests(store, "small-pkg", ["one.test.ts", "two.test.ts"], 4)

    const { text } = show()

    expect(text).toContain("small-pkg")
    // File names should NOT appear (no breakout for 4 tests)
    expect(text).not.toContain("one")
    expect(text).not.toContain("two")
  })

  it("file breakout: >1 line with >3 files triggers breakout", () => {
    const { store, show } = setup()
    const files = ["aa.test.ts", "bb.test.ts", "cc.test.ts", "dd.test.ts"]
    // 70 tests across 4 files, >1 line with >3 files
    addTests(store, "medium-pkg", files, 70)

    const { text } = show()

    expect(text).toContain("medium-pkg")
    expect(text).toContain("aa")
    expect(text).toContain("bb")
    expect(text).toContain("cc")
    expect(text).toContain("dd")
  })

  it("retries: counter adjusts when test state changes", () => {
    const { store, show } = setup()
    store.addTest("t1", "pkg", "a.test.ts")
    // Simulate retry: fail then pass
    store.updateTest("t1", "failed", 50)
    store.updateTest("t1", "passed", 60)

    const { text } = show()
    expect(text).toContain("1 passed")
    expect(text).not.toContain("failed")
  })
})
