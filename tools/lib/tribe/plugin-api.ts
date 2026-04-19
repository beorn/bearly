/**
 * Tribe plugin boundary — the clean interface that separates optional observer
 * plugins (git, beads, github, health, accountly) from the coordination daemon
 * core (tribe-daemon.ts).
 *
 * Plugins observe external signals (git commits, bead state, GitHub API,
 * system health, account quotas) and push messages onto the tribe wire. They
 * are NOT part of the daemon's core coordination responsibilities — a daemon
 * with zero plugins is a complete coordination server.
 *
 * Scope of this interface:
 *   - A plugin identifies itself with a stable `name` (also used as the sender
 *     when it broadcasts).
 *   - A plugin reports `available()` so the daemon can skip it silently when
 *     its dependencies (git repo, .beads/, gh auth, accountly config, …) are
 *     absent.
 *   - `start(api)` wires the plugin to the tribe wire via `TribeClientApi`
 *     and returns a cleanup closure.
 *
 * What the plugin does NOT get:
 *   - Access to the SQLite database.
 *   - Access to the connected-clients map.
 *   - The daemon's session UUID.
 *   - The ability to trigger hot-reloads (the source watcher handles that).
 *
 * This matches what a future out-of-process plugin would have access to if it
 * connected as a regular tribe client: `tribe.send`, `tribe.broadcast`, a
 * dedup primitive, and an optional members roster for targeted alerts.
 */

export interface TribePluginApi {
  /** Stable identifier — also the sender name when broadcasting. */
  readonly name: string

  /** Return true if the plugin's dependencies are present. */
  available(): boolean

  /** Start observing. Returns a disposer called on daemon shutdown / hot-reload. */
  start(api: TribeClientApi): (() => void) | void

  /** Optional text appended to the MCP system prompt for connected sessions. */
  instructions?(): string
}

/** Short plugin identity used when the daemon cares only about the membership. */
export interface TribePluginHandle {
  readonly name: string
  readonly active: boolean
}

export interface TribeClientApi {
  /** Direct message to a single recipient (name) or the daemon's dispatcher. */
  send(recipient: string, content: string, type: string, beadId?: string): void

  /** Broadcast to all connected sessions (recipient = '*'). */
  broadcast(content: string, type: string, beadId?: string): void

  /**
   * Idempotent dedup claim — returns true if this caller won the claim for
   * `key`, false if another caller (or a prior run) already claimed it.
   * Used to prevent duplicate broadcasts across plugin reloads and multi-
   * instance races.
   */
  claimDedup(key: string): boolean

  /**
   * Content-prefix dedup — true if any session broadcast a message whose
   * content starts with `contentPrefix` in the recent window (≈5 min). Used
   * by plugins that want to avoid piling alerts on top of each other.
   */
  hasRecentMessage(contentPrefix: string): boolean

  /**
   * Optional: lightweight roster snapshot for plugins that need to DM a
   * specific session (e.g. CI alerts → responsible repo owner, reaper →
   * the session owning a runaway PID). Mirrors what `tribe.members` would
   * return if the plugin were an out-of-process client.
   */
  getActiveSessions(): Array<{ name: string; pid: number; role: string }>

  /** Optional: bare list of currently-connected session names. */
  getSessionNames(): string[]

  /** Optional: is a chief currently connected? (alert targeting shortcut) */
  hasChief(): boolean
}
