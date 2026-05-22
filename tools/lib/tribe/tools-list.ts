/**
 * Tribe MCP tools list — tool definitions for ListToolsRequest.
 *
 * Public coordination surface:
 *   tribe.send, tribe.fetch, tribe.members, tribe.filter, tribe.join.
 * Admin/diagnostic verbs remain separate.
 *
 * Every tool also declares an `outputSchema` that mirrors the
 * `structuredContent` shape emitted by `handlers.ts::jsonResult`. Hosts
 * with MCP structuredContent support render that payload natively
 * instead of the historical `[{type:"text",text:"<escaped-json>"}]`
 * envelope. See `@km/infra/15623-mcp-tools-structuredcontent`.
 *
 * Schema convention: outputSchemas are intentionally loose
 * (`additionalProperties: true`) so handler refinements don't break
 * already-deployed clients. The documented shape lives in the
 * `description`; full strict schemas can be tightened per-tool over
 * time without renaming the contract.
 */

const ERROR_SHAPE = {
  error: { type: "string", description: "Error message — present when the tool refused or hit an exception." },
} as const

const OBJ = (
  properties: Record<string, unknown>,
  description: string,
): {
  type: "object"
  description: string
  properties: Record<string, unknown>
  additionalProperties: true
} => ({
  type: "object",
  description,
  properties,
  additionalProperties: true,
})

export const TOOLS_LIST = [
  {
    name: "send",
    description: 'Send a message to one tribe member, or to everyone with to: "*".',
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: 'Recipient session name, or "*" for broadcast' },
        message: { type: "string", description: "Message content" },
        type: {
          type: "string",
          description:
            "Message type. The tribe-wire daemon delivers every type to every session — no type is role-gated.",
          enum: ["assign", "status", "query", "response", "notify", "request", "verdict"],
          default: "notify",
        },
        bead: { type: "string", description: "Associated bead ID (optional)" },
        ref: { type: "string", description: "Reference to a previous message ID (optional)" },
      },
      required: ["to", "message"],
    },
    outputSchema: OBJ(
      {
        sent: { type: "boolean", description: "True on successful send." },
        id: { type: "string", description: "Message id assigned by the daemon." },
        ...ERROR_SHAPE,
      },
      "Send result: { sent, id } on success, { error } on validation failure.",
    ),
  },
  {
    name: "fetch",
    description:
      "Read tribe messages. Default drains this session's pending queue and advances its cursor. ids/with/from/to reads are snapshots. since scans the journal and advances only with advance:true.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Fetch specific message IDs without advancing the cursor.",
        },
        topics: {
          type: "array",
          items: { type: "string" },
          description: "Optional topic globs, e.g. ['github:*', 'git:commit'].",
        },
        since: {
          type: "number",
          description: "Scan rows with rowid > since. Default mode uses the session cursor.",
        },
        with: { type: "string", description: "Bilateral history with this session name." },
        from: { type: "string", description: "One-sided history from this sender." },
        to: { type: "string", description: "One-sided history to this recipient." },
        limit: { type: "number", description: "Max rows to return (default 50, max 500)." },
        advance: {
          type: "boolean",
          description: "Advance the session cursor after a since/default scan. Default: true only for default drain.",
        },
      },
    },
    outputSchema: OBJ(
      {
        events: {
          type: "array",
          description:
            "Visible messages. Each: { id, rowid, type, from, to, content, bead?, ref?, ts (ISO), delivery, topic?, room_id? }.",
          items: { type: "object", additionalProperties: true },
        },
        cursor: { type: "number", description: "Highest rowid returned (or unchanged when no rows matched)." },
        ...ERROR_SHAPE,
      },
      "Fetch result: { events, cursor } on success, { error } on argument validation failure.",
    ),
  },
  {
    name: "members",
    description: "List active tribe sessions with their domains",
    inputSchema: {
      type: "object" as const,
      properties: {
        all: { type: "boolean", description: "Include dead sessions (default: false)" },
      },
    },
    outputSchema: OBJ(
      {
        sessions: {
          type: "array",
          description:
            "Per-session rows: { name, role, domains, pid, cwd, claude_session_id?, claude_session_name?, alive, uptime_min, last_seen_sec, parent? }.",
          items: { type: "object", additionalProperties: true },
        },
      },
      "Members list — array of session records under `sessions`.",
    ),
  },
  {
    name: "rename",
    description: "Rename this session in the tribe",
    inputSchema: {
      type: "object" as const,
      properties: {
        new_name: { type: "string", description: "New session name" },
      },
      required: ["new_name"],
    },
    outputSchema: OBJ(
      {
        renamed: { type: "boolean" },
        old_name: { type: "string" },
        new_name: { type: "string" },
        name: { type: "string", description: "Present on rename-to-self no-op." },
        existing_names: {
          type: "array",
          items: { type: "string" },
          description: "On collision: active session names already in use.",
        },
        ...ERROR_SHAPE,
      },
      "Rename result: { renamed, old_name, new_name } on success, { renamed:false, name } on no-op, { error, existing_names? } on collision.",
    ),
  },
  {
    name: "health",
    description: "Diagnostic: check for silent members, stale beads, unread messages",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    outputSchema: OBJ(
      {
        members: {
          type: "array",
          description: "Per-member diagnostic: { name, role, domains, pid, alive, warnings: string[], ... }.",
          items: { type: "object", additionalProperties: true },
        },
        stale_beads: { type: "number", description: "Count of beads claimed but idle past threshold." },
        unread: { type: "number", description: "Messages addressed to this session not yet drained." },
        reconciler: {
          type: "object",
          description:
            "Optional chief-reconciler snapshot (opt-in via TRIBE_RECONCILER_SNAPSHOT env var). Field shape mirrors @km/tribe/stable-coordination L4.",
          additionalProperties: true,
        },
      },
      "Health snapshot — members + counts + optional reconciler snapshot.",
    ),
  },
  {
    name: "join",
    description: "Re-announce this session's name and domains after compaction or rejoin.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Session name" },
        domains: {
          type: "array",
          items: { type: "string" },
          description: "Domain expertise areas, e.g. ['silvery', 'flexily'].",
        },
        delivery: {
          type: "string",
          description:
            "How this session consumes messages. 'push' sends channel notifications. 'pull' queues rows for tribe.fetch. Sender is transport-blind.",
          enum: ["push", "pull"],
        },
      },
      required: ["name"],
    },
    outputSchema: OBJ(
      {
        joined: { type: "boolean" },
        name: { type: "string" },
        role: { type: "string" },
        domains: { type: "array", items: { type: "string" } },
        delivery: { type: "string", enum: ["push", "pull"] },
        previous_name: {
          type: "string",
          description: "Set when this join performed a rename relative to the prior session name.",
        },
        ...ERROR_SHAPE,
      },
      "Join result: { joined, name, role, domains, delivery, previous_name? }. { error } on name validation failure.",
    ),
  },
  {
    name: "reload",
    description:
      "Hot-reload the tribe MCP server — re-exec with latest code from disk. Use after tribe code is updated to pick up fixes without restarting the Claude Code session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reason: { type: "string", description: "Why the reload is needed (logged to events)" },
      },
    },
    outputSchema: OBJ(
      {
        reloading: { type: "boolean" },
        reason: { type: "string" },
        pid: { type: "number", description: "PID of the daemon about to re-exec." },
      },
      "Reload acknowledgment — the actual re-exec happens shortly after this response flushes.",
    ),
  },
  {
    name: "retro",
    description:
      "Generate a retrospective report analyzing tribe message history, coordination health, and per-member activity",
    inputSchema: {
      type: "object" as const,
      properties: {
        since: {
          type: "string",
          description: 'Duration to look back (e.g. "2h", "30m", "1d"). Default: entire session.',
        },
        format: {
          type: "string",
          description: "Output format",
          enum: ["markdown", "json"],
          default: "markdown",
        },
      },
    },
    outputSchema: OBJ(
      {
        text: {
          type: "string",
          description:
            "Markdown retro report. Present when format=markdown (default). For format=json the structured payload is the full retro report object instead — properties such as session count, message volume, per-member breakdowns.",
        },
        ...ERROR_SHAPE,
      },
      "Retro result: { text } for markdown, full report object for json, { error } on invalid duration.",
    ),
  },
  {
    name: "debug",
    description: "Dump daemon internals for troubleshooting — clients, per-session cursors.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    outputSchema: OBJ(
      {
        clients: { type: "array", items: { type: "object", additionalProperties: true } },
        cursors: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      "Daemon internals — shape varies by daemon build; always at least { clients, cursors }.",
    ),
  },
  {
    name: "filter",
    description:
      "Per-session filter for incoming channel events. mode controls focus level; mute stores topic globs to silence until the optional timestamp. Empty args clears the filter.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string",
          enum: ["focus", "normal", "ambient"],
          description: "Persistent filter mode. Defaults to 'normal' when args are empty.",
        },
        mute: {
          type: "array",
          items: { type: "string" },
          description: "Optional topic globs to silence, e.g. ['github:*'].",
        },
        until: {
          type: "number",
          description: "Optional unix-ms timestamp at which mute expires. Absent = persistent.",
        },
      },
      required: [],
    },
    outputSchema: OBJ(
      {
        set: { type: "boolean" },
        mode: { type: "string", enum: ["focus", "normal", "ambient"] },
        until: {
          type: ["string", "null"],
          description: "ISO timestamp at which mute expires; null when no expiry.",
        },
        mute: {
          type: ["array", "null"],
          items: { type: "string" },
          description: "Topic globs being silenced; null when not muting anything.",
        },
        ...ERROR_SHAPE,
      },
      "Filter result: { set, mode, until, mute } on success, { error } on argument validation failure.",
    ),
  },
]
