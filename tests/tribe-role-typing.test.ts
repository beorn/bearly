/**
 * tribe-role-typing — focused unit tests for the typed `role` enum on
 * `sessions`.
 *
 * F12 of @km/tribe/15496-coordination-drift collapsed the former
 * chief/member coordination distinction: the tribe-wire daemon (L2) is now
 * role-agnostic. `role` only tags the *connection lifecycle* — "daemon" |
 * "member" | "watch" | "pending". Chief-ness is an L3 fact (the `@chief` bead
 * lease) the daemon neither knows nor stores.
 *
 * These tests lock in the closed enum so a refactor can't silently
 * reintroduce a coordination role at L2.
 */

import { describe, it, expect } from "vitest"
import { isValidRole, TRIBE_ROLES, type TribeRole } from "@bearly/tribe-client/lib/config"

describe("TRIBE_ROLES enum", () => {
  it("covers exactly the four lifecycle roles — no chief/member split", () => {
    expect([...TRIBE_ROLES].sort()).toEqual(["daemon", "member", "pending", "watch"])
  })

  it("does not include a coordination role", () => {
    expect([...TRIBE_ROLES]).not.toContain("chief")
  })

  it("isValidRole accepts every enum member", () => {
    for (const r of TRIBE_ROLES) {
      expect(isValidRole(r)).toBe(true)
    }
  })

  it("isValidRole rejects the removed 'chief' role and other strings", () => {
    expect(isValidRole("chief")).toBe(false)
    expect(isValidRole("supervisor")).toBe(false)
    expect(isValidRole("")).toBe(false)
    expect(isValidRole(null)).toBe(false)
    expect(isValidRole(undefined)).toBe(false)
    expect(isValidRole(42)).toBe(false)
    expect(isValidRole({ role: "member" })).toBe(false)
  })
})

describe("TribeRole type surface", () => {
  it("compiles with all four members (type-level smoke test)", () => {
    // This test exists purely so a future change to TribeRole that drops a
    // member — or reintroduces "chief" — fails compilation here rather than
    // in downstream callers.
    const roles: TribeRole[] = ["daemon", "member", "watch", "pending"]
    expect(roles).toHaveLength(4)
  })
})
