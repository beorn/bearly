/**
 * Re-export from the modular summarization system.
 *
 * The old monolithic summarize.ts has been replaced by:
 * - extract.ts: session content extraction
 * - summarize-session.ts: per-session LLM summaries with caching
 * - summarize-daily.ts: daily rollup from per-session summaries
 */

export { summarizeDay, summarizeUnprocessedDays, cmdSummarize, type DailySummaryResult } from "./summarize-daily"
