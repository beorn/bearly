/**
 * kanban-bridge listener — forwards bearly hook events to Cline Kanban.
 *
 * When present in `~/.claude/hooks.d/` (or a project's `.claude/hooks.d/`),
 * every bearly hook the router dispatches is also forwarded to the
 * `kanban hooks notify` CLI so that km (or any bearly-wired agent) appears
 * as a first-class runtime on any Cline Kanban board.
 *
 * Mapping:
 *   session_start           -> to_in_progress
 *   user_prompt_submit      -> to_in_progress
 *   pre_tool_use            -> activity
 *   post_tool_use           -> activity
 *   post_tool_use_failure   -> activity
 *   subagent_stop           -> activity
 *   stop                    -> to_review
 *   permission_request      -> to_review
 *   notification (permission_prompt) -> to_review
 *   notification (other)             -> activity
 *   session_end             -> activity
 *
 * The bridge is opt-in: users copy or symlink this file into `~/.claude/hooks.d/`.
 * It accepts any source (the router decides who fires), and gracefully no-ops
 * when the `kanban` binary is not on PATH.
 *
 * Resolution order for the binary:
 *   1. $KANBAN_BIN if set
 *   2. `which kanban` (PATH lookup)
 *
 * Source label sent to kanban defaults to "km"; override via $KANBAN_BRIDGE_SOURCE.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { existsSync } from "node:fs"
import { defineListener, type HookEvent, type Listener, type ListenerContext } from "../types.ts"

export type KanbanEvent = "to_in_progress" | "to_review" | "activity"

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess | { pid?: number; unref?: () => void }

export interface CreateKanbanBridgeOptions {
  /**
   * Spawn override — use to inject a mock in tests. Defaults to node:child_process spawn.
   */
  spawn?: SpawnLike
  /**
   * Binary resolver override. Return the absolute path to the kanban binary,
   * or undefined if the binary is missing. Defaults to $KANBAN_BIN / PATH lookup.
   */
  resolveBinary?: () => string | undefined
  /**
   * Source label sent to `kanban hooks notify --source <source>`.
   * Defaults to $KANBAN_BRIDGE_SOURCE, falling back to "km".
   */
  source?: string
  /**
   * Listener name. Defaults to "kanban-bridge".
   */
  name?: string
}

const EVENT_MAP: Record<HookEvent, KanbanEvent> = {
  session_start: "to_in_progress",
  user_prompt_submit: "to_in_progress",
  pre_tool_use: "activity",
  post_tool_use: "activity",
  post_tool_use_failure: "activity",
  subagent_stop: "activity",
  stop: "to_review",
  permission_request: "to_review",
  notification: "activity", // overridden below for permission_prompt subtype
  session_end: "activity",
}

export function mapEvent(ctx: Pick<ListenerContext, "event" | "notificationType">): KanbanEvent {
  if (ctx.event === "notification" && ctx.notificationType === "permission_prompt") {
    return "to_review"
  }
  return EVENT_MAP[ctx.event]
}

function debugEnabled(): boolean {
  return Boolean(process.env.BEARLY_HOOKS_DEBUG || process.env.KM_HOOKS_DEBUG)
}

function warn(message: string): void {
  if (debugEnabled()) process.stderr.write(`[kanban-bridge] ${message}\n`)
}

function defaultResolveBinary(): string | undefined {
  const envBin = process.env.KANBAN_BIN
  if (envBin && existsSync(envBin)) return envBin
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean)
  for (const dir of pathDirs) {
    const candidate = `${dir}/kanban`
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function buildArgs(ctx: ListenerContext, kanbanEvent: KanbanEvent, source: string): string[] {
  const args = ["hooks", "notify", "--event", kanbanEvent, "--source", source]
  if (ctx.activityText) args.push("--activity-text", ctx.activityText)
  if (ctx.toolName) args.push("--tool-name", ctx.toolName)
  if (ctx.finalMessage) args.push("--final-message", ctx.finalMessage)
  if (ctx.hookEventName) args.push("--hook-event-name", ctx.hookEventName)
  if (ctx.notificationType) args.push("--notification-type", ctx.notificationType)
  if (ctx.metadata !== undefined && ctx.metadata !== null) {
    try {
      const b64 = Buffer.from(JSON.stringify(ctx.metadata), "utf8").toString("base64")
      args.push("--metadata-base64", b64)
    } catch {
      // non-serialisable metadata — skip silently
    }
  }
  return args
}

export function createKanbanBridge(opts: CreateKanbanBridgeOptions = {}): Listener {
  const spawnFn: SpawnLike = opts.spawn ?? (nodeSpawn as SpawnLike)
  const resolveBinary = opts.resolveBinary ?? defaultResolveBinary
  const name = opts.name ?? "kanban-bridge"
  const source = opts.source ?? process.env.KANBAN_BRIDGE_SOURCE ?? "km"

  return defineListener({
    name,
    // No `events` filter — we forward every known event.
    // No `sources` filter — accept any agent.
    timeoutMs: 200,
    handle: (ctx) => {
      const bin = resolveBinary()
      if (!bin) {
        warn("kanban binary not found on PATH (set $KANBAN_BIN to override)")
        return
      }
      const kanbanEvent = mapEvent(ctx)
      const args = buildArgs(ctx, kanbanEvent, source)
      try {
        const child = spawnFn(bin, args, {
          detached: true,
          stdio: "ignore",
        })
        // Detach so a slow/hung kanban ingest can't block the agent session.
        if (typeof child?.unref === "function") child.unref()
      } catch (err) {
        warn(`spawn failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  })
}

// Internal exports for tests only — not part of the public surface.
export const __test = {
  EVENT_MAP,
  buildArgs,
  defaultResolveBinary,
}

const defaultBridge: Listener = createKanbanBridge()
export default defaultBridge
