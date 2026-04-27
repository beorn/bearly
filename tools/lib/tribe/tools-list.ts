/**
 * Tribe MCP tools list — tool definitions for ListToolsRequest.
 *
 * Names live in the canonical `tribe.*` namespace. The legacy `tribe_*`
 * forms were removed in @bearly/tribe 0.10.0.
 */

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const TOOLS_LIST = [
  {
    name: "tribe.send",
    description: "Send a message to a specific tribe member",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient session name" },
        message: { type: "string", description: "Message content" },
        type: {
          type: "string",
          description: "Message type",
          enum: ["assign", "status", "query", "response", "notify", "request", "verdict"],
          default: "notify",
        },
        bead: { type: "string", description: "Associated bead ID (optional)" },
        ref: { type: "string", description: "Reference to a previous message ID (optional)" },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "tribe.broadcast",
    description: "Broadcast a message to all tribe members",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "Message content" },
        type: {
          type: "string",
          description: "Message type",
          enum: ["notify", "status"],
          default: "notify",
        },
        bead: { type: "string", description: "Associated bead ID (optional)" },
      },
      required: ["message"],
    },
  },
  {
    name: "tribe.members",
    description: "List active tribe sessions with their roles and domains",
    inputSchema: {
      type: "object" as const,
      properties: {
        all: { type: "boolean", description: "Include dead sessions (default: false)" },
      },
    },
  },
  {
    name: "tribe.history",
    description: "View recent message history",
    inputSchema: {
      type: "object" as const,
      properties: {
        with: { type: "string", description: "Filter to messages involving this session" },
        limit: { type: "number", description: "Max messages to return (default: 20)" },
      },
    },
  },
  {
    name: "tribe.rename",
    description: "Rename this session in the tribe",
    inputSchema: {
      type: "object" as const,
      properties: {
        new_name: { type: "string", description: "New session name" },
      },
      required: ["new_name"],
    },
  },
  {
    name: "tribe.health",
    description: "Diagnostic: check for silent members, stale beads, unread messages",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "tribe.join",
    description: "Re-announce this session's name, role, and domains (e.g. after compaction/rejoin)",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Session name" },
        role: {
          type: "string",
          description:
            "Session role. 'chief' = coordinator, 'member' = default worker, 'watch' = read-only observer (never chief-eligible).",
          enum: ["chief", "member", "watch"],
        },
        domains: {
          type: "array",
          items: { type: "string" },
          description: "Domain expertise areas (e.g. ['silvery', 'flexily'])",
        },
      },
      required: ["name", "role"],
    },
  },
  {
    name: "tribe.reload",
    description:
      "Hot-reload the tribe MCP server — re-exec with latest code from disk. Use after tribe code is updated to pick up fixes without restarting the Claude Code session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "Why the reload is needed (logged to events)",
        },
      },
    },
  },
  {
    name: "tribe.retro",
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
  },
  {
    name: "tribe.chief",
    description: "Show the current chief — derived from connection order, or explicitly claimed via tribe.claim-chief.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "tribe.debug",
    description:
      "Dump daemon internals for troubleshooting — clients, chief derivation, chief claim, per-session cursors.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "tribe.claim-chief",
    description:
      "Claim the chief role explicitly. Idempotent. Overrides the default connection-order derivation until released (or this session disconnects).",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "tribe.release-chief",
    description:
      "Release an explicit chief claim, letting the role fall back to connection-order derivation. Idempotent — no-op if this session did not hold an explicit claim.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "tribe.inbox",
    description:
      "Pull pending tribe events that did NOT push to the channel (ambient: commits, joins/leaves, routine github events, low-severity health warnings). Returns events newer than the per-session pull cursor; advances the cursor on call. " +
      "Empty response is the correct behavior for most tribe channel events you do see — the tool returns inbox data; you decide whether to act. Do not generate acknowledgement text just because a message arrived. Each event carries a `responseExpected` hint (`yes` / `optional` / `no`) — `no` means silent read is correct.",
    inputSchema: {
      type: "object" as const,
      properties: {
        since: {
          type: "number",
          description: "Pull rows with rowid > since. Default: per-session cursor.",
        },
        kinds: {
          type: "array",
          items: { type: "string" },
          description: "Optional plugin_kind globs to filter (e.g. ['github:*', 'git:commit']).",
        },
        limit: { type: "number", description: "Max rows to return (default: 50)." },
      },
    },
  },
  {
    name: "tribe.mode",
    description:
      "Set the per-session focus mode. `focus` = only direct DMs and threshold-escalated alerts reach the channel; `normal` = kind-based default; `ambient` = everything to channel (escape hatch). Persisted across reconnects.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mode: { type: "string", enum: ["focus", "normal", "ambient"] },
      },
      required: ["mode"],
    },
  },
  {
    name: "tribe.snooze",
    description:
      "Time-bounded silence on channel events for this session. duration_sec=0 cancels any active snooze. Optional `kinds` is a list of plugin_kind globs (e.g. ['github:*']) to silence; omit to silence everything. Direct messages always bypass snooze.",
    inputSchema: {
      type: "object" as const,
      properties: {
        duration_sec: { type: "number", description: "Snooze for this many seconds; 0 = wake." },
        kinds: { type: "array", items: { type: "string" }, description: "Optional plugin_kind globs." },
      },
      required: ["duration_sec"],
    },
  },
  {
    name: "tribe.dismiss",
    description:
      "Acknowledge an actionable event without replying. Inserts a row into the dismissals audit table (used as classifier-training signal — high dismiss rate on a kind suggests it should be reclassified ambient). Optional `reason` describes why.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: { type: "string", description: "ID of the message to dismiss." },
        reason: { type: "string", description: "Optional free-form reason." },
      },
      required: ["message_id"],
    },
  },
]
