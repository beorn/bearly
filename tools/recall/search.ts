/**
 * Unified search command — FTS5 search with optional LLM synthesis, grep, and raw filters.
 */

import * as path from "path"
import * as fs from "fs"
import {
  getDb,
  closeDb,
  PROJECTS_DIR,
  ftsSearchWithSnippet,
  searchAll,
  getAllSessionTitles,
  type MessageSearchOptions,
} from "../lib/history/db"
import { recall, type RecallOptions, type RecallResult } from "../lib/history/recall"
import { findSessionFiles, extractTextContent } from "../lib/history/indexer"
import type { ContentType, ContentRecord, MessageRecord, JsonlRecord } from "../lib/history/types"
import {
  BOLD,
  RESET,
  DIM,
  CYAN,
  YELLOW,
  GREEN,
  MAGENTA,
  THIRTY_DAYS_MS,
  parseTime,
  parseInclude,
  formatBytes,
  formatTime,
  formatRelativeTime,
  displayProjectPath,
  formatSessionId,
  highlightMatch,
  groupBy,
} from "./format"

// ============================================================================
// Search options
// ============================================================================

export interface SearchOptions {
  raw?: boolean
  json?: boolean
  since?: string
  limit?: string
  timeout?: string
  project?: string
  grep?: boolean
  question?: boolean
  response?: boolean
  tool?: string
  session?: string
  include?: string
}

// ============================================================================
// Main search command
// ============================================================================

export async function cmdSearch(query: string | undefined, options: SearchOptions): Promise<void> {
  const {
    raw,
    json,
    since,
    limit: limitStr,
    timeout: timeoutStr,
    project,
    grep: regexMode,
    question,
    response,
    tool,
    session,
    include,
  } = options

  // Power-user flags imply raw mode
  const impliedRaw = raw || !!question || !!response || !!tool || !!session || !!include || !!regexMode

  // Regex mode delegates to grep
  if (regexMode) {
    if (!query) {
      console.error("Regex mode requires a search pattern")
      process.exit(1)
    }
    const limit = limitStr ? parseInt(limitStr, 10) : 50
    await cmdGrep(query, { project, limit })
    return
  }

  // No query and no filters → show help
  if (!query && !question && !response && !tool && !since) {
    console.error("Usage: recall <query> [options]")
    console.error("Run `recall --help` for all options.")
    process.exit(1)
  }

  // If raw/implied-raw with query → direct FTS5 search (old `bun history` behavior)
  if (impliedRaw) {
    await rawSearch(query, {
      ...options,
      limit: limitStr ? parseInt(limitStr, 10) : 10,
    })
    return
  }

  // Default: LLM synthesis mode via recall()
  const recallOpts: RecallOptions = {
    raw: false,
    json: json,
    since,
    limit: limitStr ? parseInt(limitStr, 10) : 10,
    timeout: timeoutStr ? parseInt(timeoutStr, 10) : 10000,
    projectFilter: project,
  }

  const result = await recall(query!, recallOpts)
  formatRecallOutput(result, { json })
}

// ============================================================================
// Recall output (synthesis mode)
// ============================================================================

function formatRecallOutput(result: RecallResult, options: { json?: boolean }): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.results.length === 0) {
    console.log(`No results found for "${result.query}"`)
    console.log(`${DIM}(searched in ${result.durationMs}ms)${RESET}`)
    return
  }

  if (result.synthesis) {
    console.log(result.synthesis)
    console.log()
    const uniqueSessions = new Set(result.results.map((r) => r.sessionId)).size
    const timingParts = [`${result.durationMs}ms`]
    if (result.timing) {
      timingParts.push(`search=${result.timing.searchMs}ms`)
      if (result.timing.llmMs !== undefined) timingParts.push(`llm=${result.timing.llmMs}ms`)
    }
    console.log(
      `${DIM}${result.results.length} results from ${uniqueSessions} sessions (${timingParts.join(", ")})${RESET}`,
    )
    if (result.llmCost !== undefined && result.llmCost > 0) {
      console.log(`${DIM}LLM cost: $${result.llmCost.toFixed(4)}${RESET}`)
    }
    return
  }

  // Fallback: synthesis failed/aborted, show raw results
  formatRawRecallResults(result)
}

function formatRawRecallResults(result: RecallResult): void {
  console.log(`${BOLD}${result.results.length} results${RESET} for "${result.query}":\n`)

  for (const r of result.results) {
    const date = new Date(r.timestamp)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "Z")
    const typeLabel = formatType(r.type)
    const sessionLabel = r.sessionTitle ? `${r.sessionTitle}` : `${r.sessionId.slice(0, 8)}...`

    console.log(`${typeLabel} ${BOLD}${sessionLabel}${RESET} ${DIM}(${date})${RESET}`)

    const highlighted = r.snippet.replace(/>>>/g, `${BOLD}${YELLOW}`).replace(/<<</g, RESET)
    const indented = highlighted
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")
    console.log(indented)
    console.log()
  }

  const timingParts = [`${result.durationMs}ms`]
  if (result.timing) {
    timingParts.push(`search=${result.timing.searchMs}ms`)
    if (result.timing.llmMs !== undefined) timingParts.push(`llm=${result.timing.llmMs}ms`)
  }
  console.log(`${DIM}(${timingParts.join(", ")})${RESET}`)
}

function formatType(type: string): string {
  switch (type) {
    case "message":
      return `${CYAN}[msg]${RESET}`
    case "plan":
      return `${GREEN}[plan]${RESET}`
    case "summary":
      return `${YELLOW}[summary]${RESET}`
    case "todo":
      return `${YELLOW}[todo]${RESET}`
    case "first_prompt":
      return `${CYAN}[prompt]${RESET}`
    case "bead":
      return `${MAGENTA}[bead]${RESET}`
    case "session_memory":
      return `${GREEN}[memory]${RESET}`
    case "project_memory":
      return `${GREEN}[proj-mem]${RESET}`
    case "doc":
      return `${CYAN}[doc]${RESET}`
    case "claude_md":
      return `${DIM}[claude]${RESET}`
    default:
      return `[${type}]`
  }
}

// ============================================================================
// Raw FTS5 search (old `bun history` behavior)
// ============================================================================

interface RawSearchOptions extends Omit<SearchOptions, "limit"> {
  limit: number
}

async function rawSearch(query: string | undefined, options: RawSearchOptions): Promise<void> {
  const { include, question, response, tool, since, project, session, limit, json } = options

  // Parse time filter
  let sinceTime: number | undefined
  if (since) {
    sinceTime = parseTime(since)
    if (sinceTime === undefined) {
      console.error(`Invalid time format: ${since}`)
      console.error("Valid formats: 1h, 1d, 1w, today, yesterday")
      process.exit(1)
    }
  } else {
    sinceTime = Date.now() - THIRTY_DAYS_MS
  }

  // Parse content types
  let types: ContentType[] | undefined
  if (include) {
    types = parseInclude(include)
    if (types.length === 0) {
      console.error(`Invalid include types: ${include}`)
      console.error("Valid types: p,m,s,t or plans,messages,summaries,todos")
      process.exit(1)
    }
  }

  // Determine message type filter
  const messageType: "user" | "assistant" | undefined =
    question && response ? undefined : question ? "user" : response ? "assistant" : undefined

  // Allow searching without query if filters are provided
  if (!query && !question && !response && !tool && !since) {
    console.error("Usage: recall <query> [options]")
    process.exit(1)
  }

  // Build search description
  const searchDesc: string[] = []
  if (query) searchDesc.push(`"${query}"`)
  if (types) {
    const typeNames = types.map((t) => (t === "message" ? "messages" : t + "s"))
    searchDesc.push(`in ${typeNames.join(", ")}`)
  }
  if (messageType === "user") searchDesc.push("(questions only)")
  else if (messageType === "assistant") searchDesc.push("(responses only)")
  if (tool) searchDesc.push(`with tool ${tool}`)
  if (since) searchDesc.push(`since ${since}`)
  else searchDesc.push("last 30d")
  if (project) searchDesc.push(`in project ${project}`)
  if (session) searchDesc.push(`session ${session.slice(0, 8)}...`)

  console.log(`${DIM}Searching: ${searchDesc.join(" ")}${RESET}\n`)

  const startTime = Date.now()
  const db = getDb()

  // Determine which sources to search
  const searchMessages = !types || types.includes("message")
  const contentTypes = types?.filter((t) => t !== "message") as ContentType[] | undefined
  const searchContent = !types || (contentTypes && contentTypes.length > 0)

  // Build search options
  const messageOpts: MessageSearchOptions = {
    limit,
    sinceTime,
    messageType,
    toolName: tool,
    sessionId: session,
  }

  if (project) {
    messageOpts.projectFilter = project.replace(/\*/g, "")
  }

  // Search messages table if needed
  let messageResults: {
    results: (MessageRecord & {
      snippet: string
      project_path: string
      rank: number
    })[]
    total: number
  } = { results: [], total: 0 }
  if (searchMessages && query) {
    messageResults = ftsSearchWithSnippet(db, query, messageOpts)
  } else if (searchMessages && !query) {
    const recentQuery = `
      SELECT m.*, s.project_path, '' as snippet, 0 as rank
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE 1=1
      ${sinceTime ? "AND m.timestamp >= ?" : ""}
      ${messageType ? "AND m.type = ?" : ""}
      ${tool ? "AND m.tool_name = ?" : ""}
      ${session ? "AND m.session_id = ?" : ""}
      ${project ? "AND s.project_path LIKE ?" : ""}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `
    const params: (string | number)[] = []
    if (sinceTime) params.push(sinceTime)
    if (messageType) params.push(messageType)
    if (tool) params.push(tool)
    if (session) params.push(session)
    if (project) params.push(`%${project.replace(/\*/g, "")}%`)
    params.push(limit)

    const results = db.prepare(recentQuery).all(...params) as (MessageRecord & {
      snippet: string
      project_path: string
      rank: number
    })[]
    messageResults = { results, total: results.length }
  }

  // Search content table if needed
  // Project source types (bead, session_memory, project_memory, doc, claude_md)
  // are not time-filtered — they represent persistent project knowledge
  const PROJECT_SOURCE_TYPES = new Set(["bead", "session_memory", "project_memory", "doc", "claude_md"])
  const hasOnlyProjectTypes = contentTypes?.every((t) => PROJECT_SOURCE_TYPES.has(t))
  const contentSinceTime = hasOnlyProjectTypes ? undefined : sinceTime

  let contentResults: {
    results: (ContentRecord & { snippet: string; rank: number })[]
    total: number
  } = { results: [], total: 0 }
  if (searchContent && contentTypes?.length !== 0 && query) {
    contentResults = searchAll(db, query, {
      limit,
      projectFilter: project?.replace(/\*/g, ""),
      types: contentTypes,
      sinceTime: contentSinceTime,
    })
  }

  const total = messageResults.total + contentResults.total
  const duration = Date.now() - startTime
  const sessionTitles = getAllSessionTitles()

  const typeIcons: Record<string, string> = {
    message: "\u{1F4AC}",
    user: "\u{1F464}",
    assistant: "\u{1F916}",
    plan: "\u{1F4CB}",
    summary: "\u{1F4DD}",
    todo: "\u2705",
    bead: "\u{1F41E}",
    session_memory: "\u{1F4A1}",
    project_memory: "\u{1F4A1}",
    doc: "\u{1F4D6}",
    claude_md: "\u{1F4D1}",
  }
  const typeColors: Record<string, string> = {
    message: CYAN,
    user: CYAN,
    assistant: CYAN,
    plan: GREEN,
    summary: YELLOW,
    todo: MAGENTA,
    bead: MAGENTA,
    session_memory: GREEN,
    project_memory: GREEN,
    doc: CYAN,
    claude_md: "",
  }

  if (json) {
    const allResults = [
      ...messageResults.results.map((r) => ({
        contentType: "message" as const,
        sourceId: r.session_id,
        projectPath: r.project_path,
        title: sessionTitles.get(r.session_id) || null,
        timestamp: r.timestamp,
        snippet: r.snippet,
        rank: r.rank,
        type: r.type,
      })),
      ...contentResults.results.map((r) => ({
        contentType: r.content_type,
        sourceId: r.source_id,
        projectPath: r.project_path,
        title: r.title,
        timestamp: r.timestamp,
        snippet: r.snippet,
        rank: r.rank,
      })),
    ]
    console.log(JSON.stringify({ query, total, durationMs: duration, results: allResults }, null, 2))
    closeDb()
    return
  }

  if (messageResults.results.length === 0 && contentResults.results.length === 0) {
    const queryPart = query ? ` for "${query}"` : ""
    console.log(`No matches found${queryPart} (searched in ${duration}ms)`)
    closeDb()
    return
  }

  const queryPart = query ? ` for "${query}"` : ""
  console.log(`Found ${total} matches${queryPart} in ${duration}ms:\n`)

  // Display message results grouped by session
  if (messageResults.results.length > 0) {
    const bySession = groupBy(messageResults.results, (r) => r.session_id)

    for (const [sessionId, sessionResults] of bySession) {
      const first = sessionResults[0]!
      const displayProject = displayProjectPath(first.project_path)
      const relTime = formatRelativeTime(first.timestamp)
      const sessionDisplay = formatSessionId(sessionId, sessionTitles)

      console.log(
        `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`,
      )
      console.log(`\u{1F4C1} ${sessionDisplay}  |  ${displayProject}  |  ${relTime}`)
      console.log(
        `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`,
      )

      for (const r of sessionResults.slice(0, 3)) {
        const time = formatTime(r.timestamp)
        const icon = typeIcons[r.type] || "\u{1F4AC}"
        const role = r.type === "user" ? "User" : r.type === "assistant" ? "Assistant" : r.type
        console.log(`\n${icon} ${role} (${time}):`)
        console.log("\u2500".repeat(60))
        if (r.snippet) {
          const highlighted = r.snippet.replace(/>>>/g, "\x1b[1m\x1b[33m").replace(/<<</g, "\x1b[0m")
          console.log(highlighted)
        } else if (r.content) {
          const content = r.content.slice(0, 300)
          console.log(content + (r.content.length > 300 ? "..." : ""))
        }
      }

      if (sessionResults.length > 3) {
        console.log(`\n  ... and ${sessionResults.length - 3} more matches in this session`)
      }
      console.log()
    }
  }

  // Display content results
  if (contentResults.results.length > 0) {
    if (messageResults.results.length > 0) {
      console.log(`\n${"─".repeat(60)}`)
      console.log(`${BOLD}Other Content${RESET}\n`)
    }

    for (const r of contentResults.results) {
      const icon = typeIcons[r.content_type] || "\u{1F4C4}"
      const color = typeColors[r.content_type] || ""
      const relTime = formatRelativeTime(r.timestamp)

      const titleDisplay = r.title || r.source_id.slice(0, 20)
      const projectPart = r.project_path ? ` ${DIM}${displayProjectPath(r.project_path)}${RESET}` : ""

      console.log(
        `${icon} ${color}[${r.content_type}]${RESET} ${BOLD}${titleDisplay}${RESET}${projectPart} ${DIM}(${relTime})${RESET}`,
      )

      const highlighted = r.snippet.replace(/>>>/g, "\x1b[1m\x1b[33m").replace(/<<</g, "\x1b[0m")
      const indentedSnippet = highlighted
        .split("\n")
        .map((line) => `   ${line}`)
        .join("\n")
      console.log(indentedSnippet)
      console.log()
    }
  }

  const shownCount = messageResults.results.length + contentResults.results.length
  if (total > limit) {
    console.log(`${DIM}(showing ${shownCount} of ${total} matches, use -n/--limit <num> to see more)${RESET}`)
  } else if (shownCount === limit && total === limit) {
    console.log(`${DIM}(showing ${shownCount} matches, use -n/--limit <num> to see more if needed)${RESET}`)
  }

  closeDb()
}

// ============================================================================
// Grep (regex search through raw session files)
// ============================================================================

async function cmdGrep(pattern: string, options: { project?: string; limit?: number }): Promise<void> {
  const { project, limit = 50 } = options
  const contextLines = 2

  console.log(`Searching for "${pattern}" in session content...\n`)

  const regex = new RegExp(pattern, "i")
  interface GrepMatch {
    sessionFile: string
    sessionId: string
    timestamp: string
    type: string
    lineNumber: number
    context: string
    matchLine: string
  }
  const matches: GrepMatch[] = []
  let filesSearched = 0

  for await (const sessionFile of findSessionFiles()) {
    const relativePath = path.relative(PROJECTS_DIR, sessionFile)
    const projectName = relativePath.split(path.sep)[0] || ""

    if (project && !projectName.toLowerCase().includes(project.toLowerCase())) {
      continue
    }

    filesSearched++

    const fileContent = fs.readFileSync(sessionFile, "utf8")
    const lines = fileContent.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line?.trim()) continue

      try {
        const record = JSON.parse(line) as JsonlRecord
        const textContent = extractTextContent(record)
        if (!textContent || !regex.test(textContent)) continue

        const contentLines = textContent.split("\n")
        for (let j = 0; j < contentLines.length; j++) {
          const contentLine = contentLines[j]
          if (!contentLine || !regex.test(contentLine)) continue

          const startIdx = Math.max(0, j - contextLines)
          const endIdx = Math.min(contentLines.length, j + contextLines + 1)
          const contextText = contentLines.slice(startIdx, endIdx).join("\n")

          matches.push({
            sessionFile: relativePath,
            sessionId: record.sessionId || path.basename(sessionFile, ".jsonl"),
            timestamp: record.timestamp || "",
            type: record.type || "unknown",
            lineNumber: j + 1,
            context: contextText,
            matchLine: contentLine,
          })

          if (matches.length >= limit) break
        }
        if (matches.length >= limit) break
      } catch {
        // Skip malformed JSON
      }
    }
    if (matches.length >= limit) break
  }

  if (matches.length === 0) {
    console.log(`No matches found for "${pattern}" in ${filesSearched} session files.`)
    return
  }

  console.log(`Found ${matches.length} matches in ${filesSearched} files:\n`)

  const bySession = groupBy(matches, (m) => m.sessionId)

  for (const [sessionId, sessionMatches] of bySession) {
    const firstMatch = sessionMatches[0]!
    const displayProject = displayProjectPath(firstMatch.sessionFile.split(path.sep)[0] || "")
    const date = firstMatch.timestamp
      ? new Date(firstMatch.timestamp)
          .toISOString()
          .replace("T", " ")
          .replace(/\.\d+Z$/, "Z")
      : "unknown date"

    console.log(
      `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`,
    )
    console.log(`\u{1F4C1} Session: ${sessionId.slice(0, 12)}...  |  Project: ${displayProject}  |  ${date}`)
    console.log(
      `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`,
    )

    for (const match of sessionMatches.slice(0, 5)) {
      const time = match.timestamp ? new Date(match.timestamp).toLocaleTimeString() : ""
      const role =
        match.type === "user" ? "\u{1F464} User" : match.type === "assistant" ? "\u{1F916} Assistant" : match.type

      console.log(`\n${role} (${time}):`)
      console.log("\u2500".repeat(60))
      console.log(highlightMatch(match.context, regex))
    }

    if (sessionMatches.length > 5) {
      console.log(`\n  ... and ${sessionMatches.length - 5} more matches in this session`)
    }
    console.log()
  }

  if (matches.length >= limit) {
    console.log(`\n(showing first ${limit} matches, use -n/--limit for more)`)
  }
}
