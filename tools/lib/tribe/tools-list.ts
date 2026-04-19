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
]
