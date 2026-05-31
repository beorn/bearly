/**
 * Validates the contract suite against the reference {@link createInMemoryMux}.
 * Runs the full case set TWICE — once with all capabilities, once with
 * `renameTab` + `multiPane` disabled — so both the happy paths AND the
 * capability-negotiation branches (typed UnsupportedCapabilityError) are
 * exercised. Any backend (e.g. @bearly/mux-cmux-adapter) runs this same suite.
 */
import { describe, test } from "vitest"
import { ALL_CAPABILITIES, createInMemoryMux } from "../src/index.ts"
import { muxContractCases } from "../src/contract.ts"

describe("MuxBackend contract — in-memory reference (full capabilities)", () => {
  for (const c of muxContractCases(() => createInMemoryMux())) test(c.name, c.run)
})

describe("MuxBackend contract — capabilities renameTab+multiPane DISABLED (negotiation paths)", () => {
  const caps = { ...ALL_CAPABILITIES, renameTab: false, multiPane: false }
  for (const c of muxContractCases(() => createInMemoryMux(caps))) test(c.name, c.run)
})
