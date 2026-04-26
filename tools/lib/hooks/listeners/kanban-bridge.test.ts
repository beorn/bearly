import { describe, expect, it } from "vitest"
import { runIngest, runNotify } from "../router.ts"
import type { ListenerContext } from "../types.ts"
import { __test, createKanbanBridge, mapEvent, type SpawnLike } from "./kanban-bridge.ts"

interface SpawnCall {
  command: string
  args: readonly string[]
}

function makeSpawn(): { spawn: SpawnLike; calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const spawn: SpawnLike = (command, args) => {
    calls.push({ command, args })
    return { pid: 1, unref: () => {} }
  }
  return { spawn, calls }
}

const fakeBin = "/fake/bin/kanban"

function makeCtx(partial: Partial<ListenerContext> & Pick<ListenerContext, "event">): ListenerContext {
  return {
    source: "claude",
    now: new Date(),
    ...partial,
  } as ListenerContext
}

describe("kanban-bridge listener", () => {
  it("maps session_start to to_in_progress", async () => {
    const { spawn, calls } = makeSpawn()
    const listener = createKanbanBridge({ spawn, resolveBinary: () => fakeBin })
    await runIngest([listener], "session_start", "claude")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe(fakeBin)
    expect(calls[0]?.args).toEqual(["hooks", "notify", "--event", "to_in_progress", "--source", "km"])
  })

  it("maps stop to to_review", async () => {
    const { spawn, calls } = makeSpawn()
    const listener = createKanbanBridge({ spawn, resolveBinary: () => fakeBin })
    await runIngest([listener], "stop", "claude")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args.slice(0, 5)).toEqual(
      ["hooks", "notify", "--event", "to_review", "--source", "km"].slice(0, 5),
    )
    expect(calls[0]?.args).toContain("to_review")
  })

  it("maps notification with permission_prompt to to_review", () => {
    const kanbanEvent = mapEvent(makeCtx({ event: "notification", notificationType: "permission_prompt" }))
    expect(kanbanEvent).toBe("to_review")
  })

  it("maps notification without a recognised subtype to activity", async () => {
    const { spawn, calls } = makeSpawn()
    const listener = createKanbanBridge({ spawn, resolveBinary: () => fakeBin })
    await runIngest([listener], "notification", "claude")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toContain("activity")
    expect(calls[0]?.args).not.toContain("to_review")
  })

  it("returns ok without throwing when the kanban binary is missing", async () => {
    const { spawn, calls } = makeSpawn()
    const listener = createKanbanBridge({
      spawn,
      resolveBinary: () => undefined,
    })
    const result = await runIngest([listener], "session_start", "claude")
    expect(calls).toHaveLength(0)
    expect(result.listeners).toHaveLength(1)
    expect(result.listeners[0]?.status).toBe("ok")
  })

  it("never throws via runNotify even when spawn explodes", async () => {
    const explodingSpawn: SpawnLike = () => {
      throw new Error("spawn EACCES")
    }
    const listener = createKanbanBridge({ spawn: explodingSpawn, resolveBinary: () => fakeBin })
    const result = await runNotify([listener], "pre_tool_use", "claude")
    // handler catches spawn failures internally so status is "ok", not "error"
    expect(result.listeners[0]?.status).toBe("ok")
  })

  it("passes through activityText, toolName, finalMessage, and notificationType", async () => {
    const { spawn, calls } = makeSpawn()
    const listener = createKanbanBridge({ spawn, resolveBinary: () => fakeBin })
    await runIngest([listener], "pre_tool_use", "claude", {
      activityText: "editing foo.ts",
      toolName: "Edit",
      finalMessage: "done",
      notificationType: "info",
    })
    const args = calls[0]?.args ?? []
    expect(args).toContain("--activity-text")
    expect(args[args.indexOf("--activity-text") + 1]).toBe("editing foo.ts")
    expect(args).toContain("--tool-name")
    expect(args[args.indexOf("--tool-name") + 1]).toBe("Edit")
    expect(args).toContain("--final-message")
    expect(args[args.indexOf("--final-message") + 1]).toBe("done")
    expect(args).toContain("--notification-type")
    expect(args[args.indexOf("--notification-type") + 1]).toBe("info")
  })

  it("encodes metadata as base64 JSON", async () => {
    const { spawn, calls } = makeSpawn()
    const listener = createKanbanBridge({ spawn, resolveBinary: () => fakeBin })
    await runIngest([listener], "pre_tool_use", "claude", {
      metadata: { foo: "bar", n: 1 },
    })
    const args = calls[0]?.args ?? []
    const idx = args.indexOf("--metadata-base64")
    expect(idx).toBeGreaterThan(-1)
    const b64 = args[idx + 1]
    expect(b64).toBeDefined()
    const decoded = JSON.parse(Buffer.from(b64 as string, "base64").toString("utf8"))
    expect(decoded).toEqual({ foo: "bar", n: 1 })
  })

  it("honours source override (KANBAN_BRIDGE_SOURCE-like)", async () => {
    const { spawn, calls } = makeSpawn()
    const listener = createKanbanBridge({ spawn, resolveBinary: () => fakeBin, source: "tribe-member" })
    await runIngest([listener], "session_start", "claude")
    const args = calls[0]?.args ?? []
    const idx = args.indexOf("--source")
    expect(args[idx + 1]).toBe("tribe-member")
  })

  it("covers every HookEvent in the mapping table", () => {
    const covered = Object.keys(__test.EVENT_MAP).sort()
    const expected = [
      "notification",
      "permission_request",
      "post_tool_use",
      "post_tool_use_failure",
      "pre_tool_use",
      "session_end",
      "session_start",
      "stop",
      "subagent_stop",
      "user_prompt_submit",
    ]
    expect(covered).toEqual(expected)
  })
})
