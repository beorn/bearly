#!/usr/bin/env bun
/**
 * @bearly/lore — MCP server bridging Claude Code to the lore daemon.
 *
 * Phase 2 of the lore workspace-daemon plan. Each MCP tool call is forwarded
 * to `lore-daemon` over a Unix socket via JSON-RPC, keeping the recall
 * library warm in the daemon process. If the daemon is unreachable we fall
 * through to an in-process library call (preserves Phase 1 behaviour).
 *
 * Tools:
 *   lore.ask           — wraps recallAgent()
 *   lore.current_brief — wraps getCurrentSessionContext()
 *   lore.plan_only     — wraps planQuery({ round: 1 })
 *
 * Env:
 *   LORE_NO_DAEMON=1   — skip the daemon entirely (library-only mode)
 *   LORE_LOG=1         — enable recall library logging (else silenced)
 *   LORE_SOCKET        — override socket path (default $XDG_RUNTIME_DIR/lore.sock)
 *
 * Usage (registered in .mcp.json):
 *   { "command": "bun", "args": ["vendor/bearly/plugins/lore/server.ts"] }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { recallAgent } from "../../recall/src/lib/agent.ts"
import { planQuery, planVariants } from "../../recall/src/lib/plan.ts"
import { buildQueryContext } from "../../recall/src/lib/context.ts"
import { getCurrentSessionContext } from "../../recall/src/lib/session-context.ts"
import { setRecallLogging } from "../../recall/src/history/recall-shared.ts"
import { createReconnectingClient, type LoreClient } from "./lib/socket.ts"
import { resolveLoreSocketPath } from "./lib/config.ts"
import {
  LORE_METHODS,
  LORE_PROTOCOL_VERSION,
  type AskResult,
  type CurrentBriefResult,
  type PlanOnlyResult,
  type WorkspaceStateResult,
  type SessionStateResult,
  type InjectDeltaResult,
} from "./lib/rpc.ts"
import { hookRecall } from "../../recall/src/history/recall.ts"

// Silence stderr logging — MCP stdio protocol allows stderr, but it's noisy.
// Re-enable by setting LORE_LOG=1.
if (process.env.LORE_LOG !== "1") setRecallLogging(false)

// ============================================================================
// Daemon client (lazy singleton, with fallback on failure)
// ============================================================================

const USE_DAEMON = process.env.LORE_NO_DAEMON !== "1"
let daemonClient: LoreClient | null = null
let daemonDisabled = false // Set after repeated connect failures

async function getDaemon(): Promise<LoreClient | null> {
  if (!USE_DAEMON || daemonDisabled) return null
  if (daemonClient) return daemonClient
  try {
    const socketPath = resolveLoreSocketPath()
    const client = await createReconnectingClient({ socketPath, maxAttempts: 5 })
    await client.call(LORE_METHODS.hello, {
      clientName: "@bearly/lore",
      clientVersion: "0.5.0",
      protocolVersion: LORE_PROTOCOL_VERSION,
    })
    daemonClient = client
    // If the reconnecting client eventually gives up, disable for this session.
    return daemonClient
  } catch (err) {
    if (process.env.LORE_LOG === "1") {
      process.stderr.write(
        `[lore] daemon unavailable, using library fallback: ${err instanceof Error ? err.message : err}\n`,
      )
    }
    daemonDisabled = true
    return null
  }
}

// ============================================================================
// Tool definitions (raw JSON schema — matches tribe-proxy house style)
// ============================================================================

const TOOLS = [
  {
    name: "lore.ask",
    description:
      "LLM-driven recall over Claude Code session history. Two-round planner + fanout + synthesis. Use for vague or multi-word queries where single FTS misses. Returns a synthesized answer plus the matched documents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The natural-language query to recall" },
        limit: { type: "number", description: "Max results (default 5)" },
        since: { type: "string", description: "Time filter: 1h, 1d, 1w, 30d, today, yesterday" },
        projectFilter: { type: "string", description: "Project path glob (e.g. *km*)" },
        round2: {
          type: "string",
          enum: ["auto", "wider", "deeper", "off"],
          description: "Round 2 mode (default auto)",
        },
        maxRounds: { type: "number", description: "Cap on rounds (1 or 2, default 2)" },
        speculativeSynth: {
          type: "boolean",
          description: "Run synth on round-1 results in parallel with round-2 planning (default true)",
        },
        rawTrace: { type: "boolean", description: "Include the full agent trace in the response (default false)" },
      },
      required: ["query"],
    },
  },
  {
    name: "lore.current_brief",
    description:
      "Summary of the current Claude Code session: paths, bead IDs, distinctive tokens, and a truncated conversation tail. Use to check 'what is the user doing right now' without running a full recall.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string",
          description: "Explicit session id to inspect. Omit to detect from the caller's environment.",
        },
      },
      required: [],
    },
  },
  {
    name: "lore.plan_only",
    description:
      "Run only the round-1 planner without fanout or synthesis. Returns the variant plan as JSON — fast (~3s) speculative context before committing to a full lore.ask call.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The natural-language query" },
      },
      required: ["query"],
    },
  },
  {
    name: "lore.session_state",
    description:
      "Detailed state of a single session by sessionId: focus tail + LLM summary (when LORE_SUMMARIZER_MODEL is enabled) + mentioned paths/beads/tokens. Returns error if the sessionId isn't registered. Daemon-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "The session id to inspect" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "lore.inject_delta",
    description:
      "Hook-side recall injection with per-session dedup held by the daemon. Returns additionalContext ready to splice into a Claude Code UserPromptSubmit hookSpecificOutput. Dedup is session-scoped with TTL in turns (default 10). Daemon-preferred; falls back to in-process hookRecall when the daemon is unreachable.",
    inputSchema: {
      type: "object" as const,
      properties: {
        prompt: { type: "string", description: "The user's prompt text" },
        sessionId: {
          type: "string",
          description: "Session id hint for dedup keying (defaults to the caller's registered session)",
        },
        limit: { type: "number", description: "Max snippets to inject (default 3)" },
        ttlTurns: { type: "number", description: "Turns a seen doc stays excluded (default 10)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "lore.workspace_state",
    description:
      "Snapshot of all Claude Code sessions currently registered with the lore daemon, each annotated with cached focus data (last activity, focus hint, mentioned paths/beads/tokens). Use to see what other sessions are doing without running a full recall. Daemon-only — returns empty sessions array if the daemon isn't running.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
]

// ============================================================================
// Tool handlers
// ============================================================================

async function handleAsk(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "")
  if (!query) throw new Error("lore.ask: `query` is required")

  const askParams = {
    query,
    limit: typeof args.limit === "number" ? args.limit : 5,
    since: typeof args.since === "string" ? args.since : undefined,
    projectFilter: typeof args.projectFilter === "string" ? args.projectFilter : undefined,
    round2:
      typeof args.round2 === "string" && ["auto", "wider", "deeper", "off"].includes(args.round2)
        ? (args.round2 as "auto" | "wider" | "deeper" | "off")
        : ("auto" as const),
    maxRounds: (args.maxRounds === 1 ? 1 : 2) as 1 | 2,
    speculativeSynth: typeof args.speculativeSynth === "boolean" ? args.speculativeSynth : undefined,
    rawTrace: args.rawTrace === true,
  }

  const daemon = await getDaemon()
  if (daemon) {
    try {
      const result = (await daemon.call(LORE_METHODS.ask, askParams)) as AskResult
      return JSON.stringify({ ...result, mode: "daemon" }, null, 2)
    } catch (err) {
      if (process.env.LORE_LOG === "1") {
        process.stderr.write(
          `[lore] daemon.ask failed, falling back to library: ${err instanceof Error ? err.message : err}\n`,
        )
      }
    }
  }

  // Library fallback (Phase 1 behaviour)
  const result = await recallAgent(query, {
    limit: askParams.limit,
    since: askParams.since,
    projectFilter: askParams.projectFilter,
    round2: askParams.round2,
    maxRounds: askParams.maxRounds,
    speculativeSynth: askParams.speculativeSynth,
  })
  const payload: Record<string, unknown> = {
    query: result.query,
    answer: result.synthesis,
    results: result.results.map((r) => ({
      type: r.type,
      sessionId: r.sessionId,
      sessionTitle: r.sessionTitle,
      timestamp: r.timestamp,
      snippet: r.snippet,
    })),
    durationMs: result.durationMs,
    cost: result.llmCost ?? 0,
    synthPath: result.trace?.synthPath ?? "no-synth",
    synthCallsUsed: result.trace?.synthCallsUsed ?? 0,
    fellThrough: result.fellThrough ?? false,
    mode: "library",
  }
  if (args.rawTrace === true) payload.trace = result.trace
  return JSON.stringify(payload, null, 2)
}

async function handleCurrentBrief(args: Record<string, unknown>): Promise<string> {
  const sessionIdOverride = typeof args.sessionId === "string" ? args.sessionId : undefined

  const daemon = await getDaemon()
  if (daemon) {
    try {
      const result = (await daemon.call(
        LORE_METHODS.currentBrief,
        sessionIdOverride ? { sessionIdOverride } : {},
      )) as CurrentBriefResult
      return JSON.stringify({ ...result, mode: "daemon" }, null, 2)
    } catch (err) {
      if (process.env.LORE_LOG === "1") {
        process.stderr.write(
          `[lore] daemon.current_brief failed, falling back: ${err instanceof Error ? err.message : err}\n`,
        )
      }
    }
  }

  const ctx = getCurrentSessionContext(sessionIdOverride ? { sessionIdOverride } : undefined)
  if (!ctx) {
    return JSON.stringify({
      sessionId: null,
      detected: false,
      mode: "library",
      message: "No active Claude Code session detected (CLAUDE_SESSION_ID not set, no sentinel file, no recent JSONL)",
    })
  }
  return JSON.stringify(
    {
      sessionId: ctx.sessionId,
      detected: true,
      mode: "library",
      ageMs: ctx.ageMs,
      exchangeCount: ctx.exchangeCount,
      mentionedPaths: ctx.mentionedPaths,
      mentionedBeads: ctx.mentionedBeads,
      mentionedTokens: ctx.mentionedTokens,
      recentMessages: ctx.recentMessages,
    },
    null,
    2,
  )
}

async function handlePlanOnly(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "")
  if (!query) throw new Error("lore.plan_only: `query` is required")

  const daemon = await getDaemon()
  if (daemon) {
    try {
      const result = (await daemon.call(LORE_METHODS.planOnly, { query })) as PlanOnlyResult
      return JSON.stringify({ ...result, mode: "daemon" }, null, 2)
    } catch (err) {
      if (process.env.LORE_LOG === "1") {
        process.stderr.write(
          `[lore] daemon.plan_only failed, falling back: ${err instanceof Error ? err.message : err}\n`,
        )
      }
    }
  }

  const context = buildQueryContext()
  const call = await planQuery(query, context, { round: 1 })

  if (!call.plan) {
    return JSON.stringify({
      ok: false,
      error: call.error ?? "plan-failed",
      model: call.model,
      elapsedMs: call.elapsedMs,
      mode: "library",
    })
  }

  return JSON.stringify(
    {
      ok: true,
      model: call.model,
      elapsedMs: call.elapsedMs,
      cost: call.cost,
      plan: call.plan,
      variants: planVariants(call.plan),
      mode: "library",
    },
    null,
    2,
  )
}

async function handleWorkspaceState(_args: Record<string, unknown>): Promise<string> {
  const daemon = await getDaemon()
  if (!daemon) {
    // No library fallback — this method only makes sense against the daemon
    // (there is no in-process equivalent of a cross-session registry).
    return JSON.stringify(
      {
        generatedAt: Date.now(),
        sessions: [],
        mode: "library",
        note: "lore daemon not reachable; workspace state is only available via the daemon",
      },
      null,
      2,
    )
  }
  try {
    const result = (await daemon.call(LORE_METHODS.workspaceState, {})) as WorkspaceStateResult
    return JSON.stringify({ ...result, mode: "daemon" }, null, 2)
  } catch (err) {
    return JSON.stringify(
      {
        generatedAt: Date.now(),
        sessions: [],
        mode: "error",
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      2,
    )
  }
}

async function handleInjectDelta(args: Record<string, unknown>): Promise<string> {
  const prompt = typeof args.prompt === "string" ? args.prompt : ""
  if (!prompt) throw new Error("lore.inject_delta: `prompt` is required")
  const sessionId = typeof args.sessionId === "string" ? args.sessionId : undefined
  const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : undefined
  const ttlTurns = typeof args.ttlTurns === "number" && args.ttlTurns > 0 ? args.ttlTurns : undefined

  const daemon = await getDaemon()
  if (daemon) {
    try {
      const result = (await daemon.call(LORE_METHODS.injectDelta, {
        prompt,
        sessionId,
        limit,
        ttlTurns,
      })) as InjectDeltaResult
      return JSON.stringify({ ...result, mode: "daemon" }, null, 2)
    } catch (err) {
      if (process.env.LORE_LOG === "1") {
        process.stderr.write(
          `[lore] daemon.inject_delta failed, falling back: ${err instanceof Error ? err.message : err}\n`,
        )
      }
    }
  }

  // Library fallback — existing hookRecall uses tmpfile-based dedup.
  // Observability fields (seenCount/turnNumber/newKeys) are daemon-only
  // and omitted here by design.
  const result = await hookRecall(prompt)
  if (result.skipped) {
    return JSON.stringify({ skipped: true, reason: result.reason, mode: "library" }, null, 2)
  }
  return JSON.stringify(
    {
      skipped: false,
      additionalContext: result.hookOutput?.hookSpecificOutput.additionalContext ?? "",
      mode: "library",
    },
    null,
    2,
  )
}

async function handleSessionState(args: Record<string, unknown>): Promise<string> {
  const sessionId = typeof args.sessionId === "string" ? args.sessionId : ""
  if (!sessionId) throw new Error("lore.session_state: `sessionId` is required")
  const daemon = await getDaemon()
  if (!daemon) {
    return JSON.stringify(
      { sessionId, detected: false, mode: "library", note: "lore daemon not reachable; session_state is daemon-only" },
      null,
      2,
    )
  }
  try {
    const result = (await daemon.call(LORE_METHODS.sessionState, { sessionId })) as SessionStateResult
    return JSON.stringify({ ...result, detected: true, mode: "daemon" }, null, 2)
  } catch (err) {
    return JSON.stringify(
      {
        sessionId,
        detected: false,
        mode: "error",
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      2,
    )
  }
}

// ============================================================================
// MCP server wiring
// ============================================================================

const server = new Server({ name: "@bearly/lore", version: "0.5.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const toolArgs = (args ?? {}) as Record<string, unknown>

  try {
    let text: string
    switch (name) {
      case "lore.ask":
        text = await handleAsk(toolArgs)
        break
      case "lore.current_brief":
        text = await handleCurrentBrief(toolArgs)
        break
      case "lore.plan_only":
        text = await handlePlanOnly(toolArgs)
        break
      case "lore.workspace_state":
        text = await handleWorkspaceState(toolArgs)
        break
      case "lore.session_state":
        text = await handleSessionState(toolArgs)
        break
      case "lore.inject_delta":
        text = await handleInjectDelta(toolArgs)
        break
      default:
        return {
          content: [{ type: "text" as const, text: `Error: unknown tool "${name}"` }],
          isError: true,
        }
    }
    return { content: [{ type: "text" as const, text }] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: "text" as const, text: `Error: ${msg}` }],
      isError: true,
    }
  }
})

// ============================================================================
// Bootstrap
// ============================================================================

// Process-level guards — MCP server must never crash the Claude Code session
process.on("uncaughtException", (err) => {
  process.stderr.write(`[lore] uncaughtException: ${err instanceof Error ? err.stack : String(err)}\n`)
})
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[lore] unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`)
})

// Support `--help` / `--list-tools` for the /complete criteria + humans
const arg = process.argv[2]
if (arg === "--help" || arg === "-h") {
  process.stdout.write(`@bearly/lore — MCP server. Tools:\n`)
  for (const t of TOOLS) process.stdout.write(`  ${t.name}  ${t.description}\n`)
  process.exit(0)
}
if (arg === "--list-tools") {
  for (const t of TOOLS) process.stdout.write(`${t.name}\n`)
  process.exit(0)
}

const transport = new StdioServerTransport()
await server.connect(transport)
