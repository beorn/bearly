#!/usr/bin/env bun
/**
 * @bearly/bear — MCP server wrapping the bearly recall library.
 *
 * Phase 1 of the bear workspace-daemon plan: standalone stdio MCP server, no
 * persistent daemon yet. Each invocation is a short-lived Claude Code sub-
 * process, but accessed as MCP tools instead of shell commands — eliminates
 * the ~400ms subprocess-spawn cost of `bun recall` from inside a turn.
 *
 * Tools:
 *   bear.ask           — wraps recallAgent()
 *   bear.current_brief — wraps getCurrentSessionContext()
 *   bear.plan_only     — wraps planQuery({ round: 1 })
 *
 * Usage (registered in .mcp.json):
 *   { "command": "bun", "args": ["vendor/bearly/plugins/bear/server.ts"] }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { recallAgent } from "../../tools/recall/agent.ts"
import { planQuery, planVariants } from "../../tools/recall/plan.ts"
import { buildQueryContext } from "../../tools/recall/context.ts"
import { getCurrentSessionContext } from "../../tools/recall/session-context.ts"
import { setRecallLogging } from "../../tools/lib/history/recall-shared.ts"

// Silence stderr logging — MCP stdio protocol allows stderr, but it's noisy.
// Re-enable by setting BEAR_LOG=1.
if (process.env.BEAR_LOG !== "1") setRecallLogging(false)

// ============================================================================
// Tool definitions (raw JSON schema — matches tribe-proxy house style)
// ============================================================================

const TOOLS = [
  {
    name: "bear.ask",
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
    name: "bear.current_brief",
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
    name: "bear.plan_only",
    description:
      "Run only the round-1 planner without fanout or synthesis. Returns the variant plan as JSON — fast (~3s) speculative context before committing to a full bear.ask call.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The natural-language query" },
      },
      required: ["query"],
    },
  },
]

// ============================================================================
// Tool handlers
// ============================================================================

async function handleAsk(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "")
  if (!query) throw new Error("bear.ask: `query` is required")

  const result = await recallAgent(query, {
    limit: typeof args.limit === "number" ? args.limit : 5,
    since: typeof args.since === "string" ? args.since : undefined,
    projectFilter: typeof args.projectFilter === "string" ? args.projectFilter : undefined,
    round2:
      typeof args.round2 === "string" && ["auto", "wider", "deeper", "off"].includes(args.round2)
        ? (args.round2 as "auto" | "wider" | "deeper" | "off")
        : "auto",
    maxRounds: args.maxRounds === 1 ? 1 : 2,
    speculativeSynth: typeof args.speculativeSynth === "boolean" ? args.speculativeSynth : undefined,
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
    cost: result.llmCost,
    synthPath: result.trace.synthPath,
    synthCallsUsed: result.trace.synthCallsUsed,
    fellThrough: result.fellThrough ?? false,
  }
  if (args.rawTrace === true) payload.trace = result.trace

  return JSON.stringify(payload, null, 2)
}

async function handleCurrentBrief(args: Record<string, unknown>): Promise<string> {
  const sessionIdOverride = typeof args.sessionId === "string" ? args.sessionId : undefined
  const ctx = getCurrentSessionContext(sessionIdOverride ? { sessionIdOverride } : undefined)
  if (!ctx) {
    return JSON.stringify({
      sessionId: null,
      detected: false,
      message: "No active Claude Code session detected (CLAUDE_SESSION_ID not set, no sentinel file, no recent JSONL)",
    })
  }
  return JSON.stringify(
    {
      sessionId: ctx.sessionId,
      detected: true,
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
  if (!query) throw new Error("bear.plan_only: `query` is required")

  const context = buildQueryContext()
  const call = await planQuery(query, context, { round: 1 })

  if (!call.plan) {
    return JSON.stringify({
      ok: false,
      error: call.error ?? "plan-failed",
      model: call.model,
      elapsedMs: call.elapsedMs,
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
    },
    null,
    2,
  )
}

// ============================================================================
// MCP server wiring
// ============================================================================

const server = new Server(
  { name: "@bearly/bear", version: "0.1.0" },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const toolArgs = (args ?? {}) as Record<string, unknown>

  try {
    let text: string
    switch (name) {
      case "bear.ask":
        text = await handleAsk(toolArgs)
        break
      case "bear.current_brief":
        text = await handleCurrentBrief(toolArgs)
        break
      case "bear.plan_only":
        text = await handlePlanOnly(toolArgs)
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
  process.stderr.write(`[bear] uncaughtException: ${err instanceof Error ? err.stack : String(err)}\n`)
})
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[bear] unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`)
})

// Support `--help` / `--list-tools` for the /complete criteria + humans
const arg = process.argv[2]
if (arg === "--help" || arg === "-h") {
  process.stdout.write(`@bearly/bear — MCP server. Tools:\n`)
  for (const t of TOOLS) process.stdout.write(`  ${t.name}  ${t.description}\n`)
  process.exit(0)
}
if (arg === "--list-tools") {
  for (const t of TOOLS) process.stdout.write(`${t.name}\n`)
  process.exit(0)
}

const transport = new StdioServerTransport()
await server.connect(transport)
