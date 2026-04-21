/**
 * Registered sources for injected context.
 *
 * Every hook that injects `additionalContext` into a user-role turn must
 * declare its source from this closed set. Unknown sources fail at
 * compile-time — which is the point: the envelope library is the single
 * chokepoint for all injection emission, and the registry is the
 * compile-time gate that prevents ad-hoc callers from sneaking injected
 * text in under a new tag name.
 *
 * Adding a new source:
 *   1. Add it to the union below
 *   2. Update `tools/lint-injection-emitters.ts` if the new source needs
 *      any special audit rules
 *   3. Document the source in vendor/bearly/plugins/injection-envelope/README.md
 */
export type RegisteredSource =
  | "recall" // bearly session-history FTS (hookRecall daemon path)
  | "qmd" // qmd-backed vault markdown search (accountly recall)
  | "tribe" // tribe channel messages from other Claude sessions
  | "telegram" // telegram bot inbound messages
  | "github" // github notifications / PR comments / issue events
  | "beads" // beads issue claims/closures broadcast
  | "mcp" // MCP server instructions
  | "system-reminder" // system-reminder content from harness
