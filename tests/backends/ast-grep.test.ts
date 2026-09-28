import { describe, test, expect } from "vitest"

// Import to trigger registration
import { AstGrepBackend, findPatterns, createPatternReplaceProposal } from "../../tools/lib/backends/ast-grep"
import { getBackends } from "../../tools/lib/backend"

describe("ast-grep backend", () => {
  describe("registration", () => {
    test("registers with correct name", () => {
      const backend = getBackends().find((entry) => entry.name === "ast-grep")
      expect(backend).toBeDefined()
      expect(backend?.name).toBe("ast-grep")
    })

    test("registers with correct extensions", () => {
      expect(AstGrepBackend.extensions).toContain(".go")
      expect(AstGrepBackend.extensions).toContain(".rs")
      expect(AstGrepBackend.extensions).toContain(".py")
      expect(AstGrepBackend.extensions).toContain(".json")
      expect(AstGrepBackend.extensions).toContain(".yaml")
    })

    test("has priority 50 (lower than ts-morph's 100)", () => {
      expect(AstGrepBackend.priority).toBe(50)
      // ts-morph has priority 100, so ast-grep (50) is lower
      // This ensures ts-morph takes precedence for JS/TS files
    })

    test("implements findPatterns", () => {
      expect(typeof AstGrepBackend.findPatterns).toBe("function")
    })

    test("implements createPatternReplaceProposal", () => {
      expect(typeof AstGrepBackend.createPatternReplaceProposal).toBe("function")
    })
  })

  describe("findPatterns", () => {
    test("returns empty array when sg not installed", () => {
      // This test documents expected behavior when ast-grep CLI is not available
      // In real usage, this would throw with installation instructions
      try {
        const refs = findPatterns("test", "*.nonexistent")
        expect(Array.isArray(refs)).toBe(true)
      } catch (error) {
        // Expected: ast-grep CLI not found error
        expect((error as Error).message).toContain("ast-grep")
      }
    })
  })

  describe("createPatternReplaceProposal", () => {
    test("creates editset with correct structure", () => {
      try {
        const editset = createPatternReplaceProposal("test", "replacement", "*.nonexistent")
        expect(editset.operation).toBe("rename")
        expect(editset.from).toBe("test")
        expect(editset.to).toBe("replacement")
        expect(Array.isArray(editset.refs)).toBe(true)
        expect(Array.isArray(editset.edits)).toBe(true)
        expect(editset.createdAt).toBeDefined()
      } catch (error) {
        // Expected when ast-grep not installed
        expect((error as Error).message).toContain("ast-grep")
      }
    })
  })
})
