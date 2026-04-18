/**
 * Phase 4 — daemon-internal RPC protocol rename.
 *
 * The lore daemon and the tribe coordination daemon both accept their
 * respective legacy wire-level method names as silent aliases (no stderr
 * warning — wire protocol, not user-facing). This file pins those
 * invariants so we don't regress during the 0.9 upgrade window.
 */

import { describe, test, expect } from "vitest"

import {
  TRIBE_METHODS,
  LORE_METHODS,
  LEGACY_METHOD_ALIASES,
  LORE_PROTOCOL_VERSION,
} from "../lore/lib/rpc.ts"
import {
  TRIBE_COORD_METHODS,
  TRIBE_LEGACY_METHOD_ALIASES,
} from "../../../tools/lib/tribe/handlers.ts"

describe("TRIBE_METHODS (lore daemon RPC)", () => {
  test("uses the canonical tribe.* namespace", () => {
    for (const value of Object.values(TRIBE_METHODS)) {
      expect(value.startsWith("tribe.")).toBe(true)
    }
  })

  test("all method strings are unique", () => {
    const values = Object.values(TRIBE_METHODS)
    expect(new Set(values).size).toBe(values.length)
  })

  test("LORE_METHODS is a deprecated alias resolving to the new values", () => {
    // NOT the historical 'lore.*' strings — the same-values re-export
    // exists so external callers keep compiling.
    expect(LORE_METHODS).toBe(TRIBE_METHODS)
    expect(LORE_METHODS.ask).toBe(TRIBE_METHODS.ask)
    expect(LORE_METHODS.ask).toBe("tribe.ask")
  })

  test("LEGACY_METHOD_ALIASES covers every TRIBE_METHODS entry", () => {
    const legacyTargets = new Set(Object.values(LEGACY_METHOD_ALIASES))
    for (const value of Object.values(TRIBE_METHODS)) {
      expect(legacyTargets.has(value)).toBe(true)
    }
  })

  test("legacy lore.* aliases resolve to tribe.* values", () => {
    expect(LEGACY_METHOD_ALIASES["lore.ask"]).toBe("tribe.ask")
    expect(LEGACY_METHOD_ALIASES["lore.inject_delta"]).toBe("tribe.inject_delta")
    expect(LEGACY_METHOD_ALIASES["lore.current_brief"]).toBe("tribe.brief")
    expect(LEGACY_METHOD_ALIASES["lore.plan_only"]).toBe("tribe.plan")
    expect(LEGACY_METHOD_ALIASES["lore.workspace_state"]).toBe("tribe.workspace")
    expect(LEGACY_METHOD_ALIASES["lore.session_state"]).toBe("tribe.session")
  })

  test("LORE_PROTOCOL_VERSION bumped to v3 (Phase 4)", () => {
    expect(LORE_PROTOCOL_VERSION).toBe(3)
  })
})

describe("TRIBE_COORD_METHODS (tribe coordination daemon RPC)", () => {
  test("uses the canonical tribe.* namespace", () => {
    for (const value of Object.values(TRIBE_COORD_METHODS)) {
      expect(value.startsWith("tribe.")).toBe(true)
    }
  })

  test("all method strings are unique", () => {
    const values = Object.values(TRIBE_COORD_METHODS)
    expect(new Set(values).size).toBe(values.length)
  })

  test("TRIBE_LEGACY_METHOD_ALIASES covers every coord method", () => {
    const legacyTargets = new Set(Object.values(TRIBE_LEGACY_METHOD_ALIASES))
    for (const value of Object.values(TRIBE_COORD_METHODS)) {
      expect(legacyTargets.has(value)).toBe(true)
    }
  })

  test("legacy tribe_* aliases resolve to tribe.* values", () => {
    expect(TRIBE_LEGACY_METHOD_ALIASES.tribe_send).toBe("tribe.send")
    expect(TRIBE_LEGACY_METHOD_ALIASES.tribe_broadcast).toBe("tribe.broadcast")
    expect(TRIBE_LEGACY_METHOD_ALIASES.tribe_sessions).toBe("tribe.members")
    expect(TRIBE_LEGACY_METHOD_ALIASES.tribe_history).toBe("tribe.history")
    expect(TRIBE_LEGACY_METHOD_ALIASES.tribe_rename).toBe("tribe.rename")
    expect(TRIBE_LEGACY_METHOD_ALIASES.tribe_health).toBe("tribe.health")
    expect(TRIBE_LEGACY_METHOD_ALIASES.tribe_join).toBe("tribe.join")
    expect(TRIBE_LEGACY_METHOD_ALIASES.tribe_reload).toBe("tribe.reload")
    expect(TRIBE_LEGACY_METHOD_ALIASES.tribe_retro).toBe("tribe.retro")
    expect(TRIBE_LEGACY_METHOD_ALIASES.tribe_leadership).toBe("tribe.leadership")
  })
})
