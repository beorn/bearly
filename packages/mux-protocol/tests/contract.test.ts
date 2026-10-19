/**
 * Validates the contract suite against the reference {@link createInMemoryMux}.
 * Runs the full case set TWICE — once with all capabilities, once with
 * `renameTab` + `multiPane` disabled — so both the happy paths AND the
 * capability-negotiation branches (typed UnsupportedCapabilityError) are
 * exercised. Any backend (e.g. @bearly/mux-cmux-adapter) runs this same suite.
 *
 * @assertions ../src/testing/contract-cases.ts — the cases assert with
 * node:assert/strict; this file only iterates them.
 */
import { describe, test } from "vitest"
import { muxContractCases } from "../src/testing/contract-cases.ts"
import { ALL_CAPABILITIES, createInMemoryMux } from "../src/testing/in-memory-mux.ts"

describe("MuxBackend contract — in-memory reference (full capabilities)", () => {
  for (const c of muxContractCases(() => createInMemoryMux())) test(c.name, c.run)
})

describe("MuxBackend contract — capabilities renameTab+multiPane DISABLED (negotiation paths)", () => {
  const caps = { ...ALL_CAPABILITIES, renameTab: false, multiPane: false }
  for (const c of muxContractCases(() => createInMemoryMux(caps))) test(c.name, c.run)
})
