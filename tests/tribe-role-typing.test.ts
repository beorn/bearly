/**
 * tribe-role-typing — focused unit tests for the typed `role` enum that
 * replaced the former name-prefix eligibility magic.
 *
 * Before km-tribe.polish-sweep item 2, chief eligibility (and several related
 * checks) was decided by `name.startsWith("watch-") || name.startsWith("pending-") ||
 * name === "daemon"`. That was error-prone and typo-risky. The `role` column
 * on `sessions` already existed — we repurposed it into a closed enum
 * ("daemon" | "chief" | "member" | "watch" | "pending") and every eligibility
 * check now consults role only.
 *
 * These tests lock in the contract so a future refactor can't silently
 * regress back to name-prefix logic.
 */

import { describe, it, expect } from "vitest"
import { isChiefEligible } from "../tools/lib/tribe/chief.ts"
import { isValidRole, TRIBE_ROLES, type TribeRole } from "../tools/lib/tribe/config.ts"

describe("isChiefEligible (role-based)", () => {
  it("rejects role=daemon", () => {
    expect(isChiefEligible({ role: "daemon" })).toBe(false)
  })

  it("rejects role=watch (dashboard / observer)", () => {
    expect(isChiefEligible({ role: "watch" })).toBe(false)
  })

  it("rejects role=pending (half-registered placeholder)", () => {
    expect(isChiefEligible({ role: "pending" })).toBe(false)
  })

  it("accepts role=member (regular worker)", () => {
    expect(isChiefEligible({ role: "member" })).toBe(true)
  })

  it("accepts role=chief (already the coordinator)", () => {
    expect(isChiefEligible({ role: "chief" })).toBe(true)
  })

  it("rejects unknown role strings (closed enum)", () => {
    // Forward-compat: unexpected role values from an old DB or a confused
    // client shouldn't accidentally grant chief eligibility.
    expect(isChiefEligible({ role: "supervisor" })).toBe(false)
    expect(isChiefEligible({ role: "" })).toBe(false)
    expect(isChiefEligible({ role: "MEMBER" })).toBe(false) // case-sensitive
  })

  it("ignores name entirely — eligibility is by role only", () => {
    // A client named "watch-whatever" that somehow has role=member is still
    // eligible. This proves we're no longer doing name-prefix heuristics.
    const c = { role: "member", name: "watch-imposter" } as unknown as { role: string }
    expect(isChiefEligible(c)).toBe(true)
  })
})

describe("TRIBE_ROLES enum", () => {
  it("covers exactly the five tagged roles", () => {
    expect([...TRIBE_ROLES].sort()).toEqual(["chief", "daemon", "member", "pending", "watch"])
  })

  it("isValidRole accepts every enum member", () => {
    for (const r of TRIBE_ROLES) {
      expect(isValidRole(r)).toBe(true)
    }
  })

  it("isValidRole rejects other strings, numbers, null, undefined", () => {
    expect(isValidRole("supervisor")).toBe(false)
    expect(isValidRole("")).toBe(false)
    expect(isValidRole(null)).toBe(false)
    expect(isValidRole(undefined)).toBe(false)
    expect(isValidRole(42)).toBe(false)
    expect(isValidRole({ role: "chief" })).toBe(false)
  })
})

describe("TribeRole type surface", () => {
  it("compiles with all five members (type-level smoke test)", () => {
    // This test exists purely so a future change to TribeRole that drops a
    // member fails compilation here rather than in downstream callers.
    const roles: TribeRole[] = ["daemon", "chief", "member", "watch", "pending"]
    expect(roles).toHaveLength(5)
  })
})
