/**
 * Example listener — harmless, copy-paste starter.
 *
 * To activate: copy this file to `~/.claude/hooks.d/example.ts`
 *              (user-global) or `<project>/.claude/hooks.d/example.ts`
 *              (project-local), then run any `tribe hook ingest/notify`
 *              with `BEARLY_HOOKS_DEBUG=1` or `BEARLY_HOOKS_EXAMPLE=1`.
 *
 * It logs dispatch events to stderr. That's it. Use it as a template for
 * real integrations — telemetry, kanban bridges, notification forwarders.
 *
 * Plain-object form: no imports, no type gymnastics. Ships anywhere Bun
 * can run it. For typed DX, replace with `defineListener({ ... })` from
 * `@bearly/hook-router` once the package is published.
 *
 * NOTE: deliberately NO `import type {ListenerContext}` here — this file
 * is meant to be copy-pasted into `~/.claude/hooks.d/example.ts`, where
 * the `../types.ts` path would not resolve. `ctx` is `any` at the copy
 * site; that's fine for a template.
 */

export default {
  // Shown in `RouterResult` and `BEARLY_HOOKS_DEBUG=1` dispatch logs.
  // Must be unique per loaded listener; use a kebab-case slug.
  name: "example",

  // Only react to these events. Omit to react to every event.
  // Vocabulary: session_start | session_end | user_prompt_submit |
  // pre_tool_use | post_tool_use | post_tool_use_failure | stop |
  // subagent_stop | notification | permission_request
  events: ["session_start", "stop", "user_prompt_submit"],

  // Only react to these sources. Omit for all sources.
  // Typical: "claude" | "codex" | "gemini" | "opencode" | "km"
  sources: ["claude"],

  // Optional per-listener timeout override. Defaults: 5000ms (ingest),
  // 100ms (notify). Keep listeners well under the outer budget.
  timeoutMs: 250,

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handle(ctx: any) {
    // Gate on env var so copying this file doesn't spam stderr. Flip
    // BEARLY_HOOKS_DEBUG=1 (global) or BEARLY_HOOKS_EXAMPLE=1 (this
    // listener only) to see output.
    if (!process.env.BEARLY_HOOKS_DEBUG && !process.env.BEARLY_HOOKS_EXAMPLE) return

    // `ctx` carries normalized enrichment fields — see `types.ts` for
    // the full shape (event, source, now, sessionId?, projectPath?,
    // activityText?, toolName?, finalMessage?, hookEventName?,
    // notificationType?, metadata?).
    const bits = [
      ctx.event,
      `source=${ctx.source}`,
      ctx.toolName && `tool=${ctx.toolName}`,
      ctx.activityText && `activity="${ctx.activityText.slice(0, 60)}"`,
      ctx.sessionId && `session=${ctx.sessionId.slice(0, 8)}`,
    ].filter(Boolean)

    // Wrap side effects in try/catch — the router already isolates
    // failures, but local try/catch keeps dispatch logs clean.
    try {
      process.stderr.write(`[example] ${bits.join(" ")}\n`)
    } catch {
      // Swallow — listeners must never crash the dispatcher.
    }
  },
}
