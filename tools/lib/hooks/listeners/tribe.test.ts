import { describe, expect, it } from "vitest"
import { runIngest } from "../router.ts"
import type { HookEvent } from "../types.ts"
import { createTribeListener, mapToLegacyEvent, type DispatchHookFn } from "./tribe.ts"

interface DispatchCall {
  event: string
}

function makeDispatchHook(): { fn: DispatchHookFn; calls: DispatchCall[] } {
  const calls: DispatchCall[] = []
  const fn: DispatchHookFn = async (event) => {
    calls.push({ event })
  }
  return { fn, calls }
}

describe("tribe listener", () => {
  it("forwards session_start to dispatchHook('session-start')", async () => {
    const { fn, calls } = makeDispatchHook()
    const listener = createTribeListener({ dispatchHook: fn })
    const result = await runIngest([listener], "session_start", "claude")
    expect(calls).toEqual([{ event: "session-start" }])
    expect(result.listeners[0]?.status).toBe("ok")
  })

  it("forwards user_prompt_submit to dispatchHook('prompt')", async () => {
    const { fn, calls } = makeDispatchHook()
    const listener = createTribeListener({ dispatchHook: fn })
    const result = await runIngest([listener], "user_prompt_submit", "claude")
    expect(calls).toEqual([{ event: "prompt" }])
    expect(result.listeners[0]?.status).toBe("ok")
  })

  it("forwards session_end to dispatchHook('session-end')", async () => {
    const { fn, calls } = makeDispatchHook()
    const listener = createTribeListener({ dispatchHook: fn })
    const result = await runIngest([listener], "session_end", "claude")
    expect(calls).toEqual([{ event: "session-end" }])
    expect(result.listeners[0]?.status).toBe("ok")
  })

  it("forwards notification+pre-compact to dispatchHook('pre-compact')", async () => {
    const { fn, calls } = makeDispatchHook()
    const listener = createTribeListener({ dispatchHook: fn })
    const result = await runIngest([listener], "notification", "claude", {
      notificationType: "pre-compact",
    })
    expect(calls).toEqual([{ event: "pre-compact" }])
    expect(result.listeners[0]?.status).toBe("ok")
  })

  it("ignores notification with a non-pre-compact subtype", async () => {
    const { fn, calls } = makeDispatchHook()
    const listener = createTribeListener({ dispatchHook: fn })
    const result = await runIngest([listener], "notification", "claude", {
      notificationType: "permission_prompt",
    })
    expect(calls).toEqual([])
    // Listener handle ran and returned cleanly — no dispatch, status ok.
    expect(result.listeners[0]?.status).toBe("ok")
  })

  it("ignores unrelated events (pre_tool_use, stop, post_tool_use, ...)", async () => {
    const { fn, calls } = makeDispatchHook()
    const listener = createTribeListener({ dispatchHook: fn })
    const ignored: HookEvent[] = [
      "pre_tool_use",
      "post_tool_use",
      "post_tool_use_failure",
      "stop",
      "subagent_stop",
      "permission_request",
    ]
    for (const event of ignored) {
      await runIngest([listener], event, "claude")
    }
    expect(calls).toEqual([])
  })

  it("isolates dispatchHook failures — listener still returns ok", async () => {
    const throwing: DispatchHookFn = async () => {
      throw new Error("tribe daemon unreachable")
    }
    const listener = createTribeListener({ dispatchHook: throwing })
    const result = await runIngest([listener], "session_start", "claude")
    // Failure MUST NOT propagate. The router sees a clean return.
    expect(result.listeners).toHaveLength(1)
    expect(result.listeners[0]?.status).toBe("ok")
    expect(result.listeners[0]?.error).toBeUndefined()
  })

  it("only fires for the configured sources (default: claude)", async () => {
    const { fn, calls } = makeDispatchHook()
    const listener = createTribeListener({ dispatchHook: fn })
    await runIngest([listener], "session_start", "codex")
    await runIngest([listener], "session_start", "gemini")
    expect(calls).toEqual([])
    await runIngest([listener], "session_start", "claude")
    expect(calls).toEqual([{ event: "session-start" }])
  })

  it("mapToLegacyEvent returns the expected mapping", () => {
    expect(mapToLegacyEvent({ event: "session_start" })).toBe("session-start")
    expect(mapToLegacyEvent({ event: "user_prompt_submit" })).toBe("prompt")
    expect(mapToLegacyEvent({ event: "session_end" })).toBe("session-end")
    expect(mapToLegacyEvent({ event: "notification", notificationType: "pre-compact" })).toBe("pre-compact")
    expect(mapToLegacyEvent({ event: "notification", notificationType: "permission_prompt" })).toBeUndefined()
    expect(mapToLegacyEvent({ event: "notification" })).toBeUndefined()
    expect(mapToLegacyEvent({ event: "pre_tool_use" })).toBeUndefined()
    expect(mapToLegacyEvent({ event: "stop" })).toBeUndefined()
  })
})
