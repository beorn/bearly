import { describe, expect, it } from "vitest"
import { resolveDeliveryMode } from "../src/lib/config.ts"

describe("resolveDeliveryMode", () => {
  it("honors an explicit TRIBE_DELIVERY override", () => {
    expect(resolveDeliveryMode({ TRIBE_DELIVERY: "push", CODEX_SHELL: "1" })).toBe("push")
    expect(resolveDeliveryMode({ TRIBE_DELIVERY: "pull" })).toBe("pull")
  })

  it("defaults Claude-compatible channel consumers to push", () => {
    expect(resolveDeliveryMode({})).toBe("push")
    expect(resolveDeliveryMode({ TRIBE_PROVIDER: "claude" })).toBe("push")
  })

  it("defaults Codex Desktop MCP sessions to pull because they do not consume Claude channel notifications", () => {
    expect(resolveDeliveryMode({ CODEX_SHELL: "1" })).toBe("pull")
    expect(resolveDeliveryMode({ CODEX_THREAD_ID: "019e610b-4888-7f73-9f78-6007fb25dfd5" })).toBe("pull")
    expect(resolveDeliveryMode({ __CFBundleIdentifier: "com.openai.codex" })).toBe("pull")
  })

  it("defaults known MCP-only providers to pull", () => {
    expect(resolveDeliveryMode({ TRIBE_PROVIDER: "codex" })).toBe("pull")
    expect(resolveDeliveryMode({ TRIBE_PROVIDER: "gemini" })).toBe("pull")
  })
})
