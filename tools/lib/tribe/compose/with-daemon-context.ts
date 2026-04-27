/**
 * withDaemonContext — create the daemon's own TribeContext.
 *
 * The daemon writes broadcasts and activity through this context — it never
 * acts as chief or member. The `onMessageInserted` tap is wired here as a
 * placeholder; later `withX` factories may overwrite or wrap it (the tap
 * callback is set at the end of composition by `withBroadcastPipeline`).
 */

import { createTribeContext, type TribeContext, type MessageInsertedInfo } from "../context.ts"
import type { BaseTribe } from "./base.ts"
import type { WithDatabase } from "./with-database.ts"

export interface WithDaemonContext {
  readonly daemonCtx: TribeContext
}

export function withDaemonContext<T extends BaseTribe & WithDatabase>(): (
  t: T,
) => T & WithDaemonContext {
  return (t) => {
    const daemonCtx = createTribeContext({
      db: t.db,
      stmts: t.stmts,
      sessionId: t.daemonSessionId,
      sessionRole: "daemon",
      initialName: "daemon",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
      // Tap is installed by withBroadcastPipeline later; default no-op so
      // any pre-pipeline writes don't NPE.
      onMessageInserted: undefined as ((info: MessageInsertedInfo) => void) | undefined,
    })
    return { ...t, daemonCtx }
  }
}
