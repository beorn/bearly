/**
 * Session list, show, and index commands.
 */

import * as path from "path"
import * as fs from "fs"
import * as readline from "readline"
import { getDb, closeDb, PROJECTS_DIR, getAllSessionTitles, getSessionTitle } from "../history/db"
import { rebuildIndex, findSessionFiles } from "../history/indexer"
import type { JsonlRecord } from "../history/types"
import {
  THIRTY_DAYS_MS,
  formatBytes,
  formatRelativeTime,
  displayProjectPath,
  formatSessionId,
  matchProjectGlob,
  BOLD,
  RESET,
  DIM,
} from "./format"
import * as os from "os"

// ============================================================================
// Index
// ============================================================================

export async function cmdIndex(opts: { incremental?: boolean; projectRoot?: string }): Promise<void> {
  console.log(opts.incremental ? "Updating session index..." : "Building session index...")
  console.log("(indexing sessions from the last 30 days)\n")

  const db = getDb()

  let lastProgressUpdate = 0
  const result = await rebuildIndex(db, {
    incremental: opts.incremental,
    projectRoot: opts.projectRoot,
    onProgress: (progress) => {
      if (progress.filesProcessed - lastProgressUpdate >= 50) {
        lastProgressUpdate = progress.filesProcessed
        process.stdout.write(`\r${progress.filesProcessed} files, ${progress.messagesIndexed} messages...`)
      }
    },
  })
  process.stdout.write("\r" + " ".repeat(60) + "\r")

  console.log(`\n\n\u2713 Indexed content:`)
  console.log(`  ${result.messages.toLocaleString()} messages from ${result.files} session files`)
  if (result.writes > 0) {
    console.log(`  ${result.writes.toLocaleString()} file writes`)
  }
  if (result.summaries > 0) {
    console.log(`  ${result.summaries.toLocaleString()} session summaries`)
  }
  if (result.firstPrompts > 0) {
    console.log(`  ${result.firstPrompts.toLocaleString()} first prompts`)
  }
  if (result.plans > 0) {
    console.log(`  ${result.plans.toLocaleString()} plan files`)
  }
  if (result.todos > 0) {
    console.log(`  ${result.todos.toLocaleString()} todo lists`)
  }
  if (result.beads > 0) {
    console.log(`  ${result.beads.toLocaleString()} beads (issues)`)
  }
  if (result.sessionMemory > 0) {
    console.log(`  ${result.sessionMemory.toLocaleString()} session memory files`)
  }
  if (result.projectMemory > 0) {
    console.log(`  ${result.projectMemory.toLocaleString()} project memory files`)
  }
  if (result.docs > 0) {
    console.log(`  ${result.docs.toLocaleString()} documentation files`)
  }
  if (result.claudeMd > 0) {
    console.log(`  ${result.claudeMd.toLocaleString()} CLAUDE.md files`)
  }
  if (result.skippedOld > 0) {
    console.log(`  (skipped ${result.skippedOld} sessions older than 30 days)`)
  }

  closeDb()
}

// ============================================================================
// List sessions
// ============================================================================

export async function cmdSessions(id?: string, opts?: { project?: string }): Promise<void> {
  if (id) {
    await showSession(id)
    return
  }

  const projectFilter = opts?.project
  console.log("Scanning sessions...\n")

  interface SessionInfo {
    file: string
    sessionId: string
    project: string
    size: number
    mtime: Date
  }

  const sessions: SessionInfo[] = []

  for await (const sessionFile of findSessionFiles()) {
    const relativePath = path.relative(PROJECTS_DIR, sessionFile)
    const project = relativePath.split(path.sep)[0] || ""

    if (projectFilter) {
      if (projectFilter.includes("*")) {
        if (!matchProjectGlob(project, projectFilter)) continue
      } else if (!project.toLowerCase().includes(projectFilter.toLowerCase())) {
        continue
      }
    }

    const stats = fs.statSync(sessionFile)
    sessions.push({
      file: relativePath,
      sessionId: path.basename(sessionFile, ".jsonl"),
      project,
      size: stats.size,
      mtime: stats.mtime,
    })
  }

  sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

  const cutoffTime = Date.now() - THIRTY_DAYS_MS
  const recentSessions = sessions.filter((s) => s.mtime.getTime() >= cutoffTime)
  const olderSessions = sessions.filter((s) => s.mtime.getTime() < cutoffTime)

  const sessionTitles = getAllSessionTitles()

  if (recentSessions.length === 0) {
    console.log("No sessions in the last 30 days")
  } else {
    const maxNameLen = Math.min(
      40,
      Math.max(
        ...recentSessions.map((s) => {
          const title = sessionTitles.get(s.sessionId)
          return (title || displayProjectPath(s.project)).length
        }),
      ),
    )

    for (const s of recentSessions) {
      const title = sessionTitles.get(s.sessionId)
      const displayProject = displayProjectPath(s.project)
      const date = s.mtime.toLocaleDateString() + " " + s.mtime.toLocaleTimeString()
      const size = formatBytes(s.size).padStart(8)
      const nameDisplay = (title || displayProject).slice(0, 40).padEnd(maxNameLen)
      console.log(`${nameDisplay}  ${s.sessionId}  ${size}  ${date}`)
    }
  }

  const recentTotalSize = recentSessions.reduce((sum, s) => sum + s.size, 0)
  console.log(`Showing ${recentSessions.length} sessions (${formatBytes(recentTotalSize)}) from the last 30 days`)

  if (olderSessions.length > 0) {
    const olderTotalSize = olderSessions.reduce((sum, s) => sum + s.size, 0)
    console.log(`\nNot shown: ${olderSessions.length} sessions (${formatBytes(olderTotalSize)}) older than 30 days`)
  }
}

// ============================================================================
// Show session details
// ============================================================================

async function showSession(sessionIdOrFile: string): Promise<void> {
  let sessionFile: string | undefined

  for await (const file of findSessionFiles()) {
    const basename = path.basename(file, ".jsonl")
    if (basename.startsWith(sessionIdOrFile) || file.includes(sessionIdOrFile)) {
      sessionFile = file
      break
    }
  }

  if (!sessionFile) {
    console.error(`Session not found: ${sessionIdOrFile}`)
    process.exit(1)
  }

  console.log(`Session: ${path.relative(PROJECTS_DIR, sessionFile)}\n`)

  const stats = fs.statSync(sessionFile)
  const relativePath = path.relative(PROJECTS_DIR, sessionFile)
  const project = relativePath.split(path.sep)[0] || "unknown"
  const sessionId = path.basename(sessionFile, ".jsonl")

  let messageCount = 0
  let firstTimestamp: string | undefined
  let lastTimestamp: string | undefined

  const fileStream = fs.createReadStream(sessionFile)
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as JsonlRecord
      if (record.timestamp) {
        if (!firstTimestamp) firstTimestamp = record.timestamp
        lastTimestamp = record.timestamp
      }
      if (record.type === "assistant" || record.type === "user") messageCount++
    } catch {
      // Skip malformed lines
    }
  }

  const db = getDb()
  const title = getSessionTitle(db, sessionId)

  console.log(`Session ID:    ${sessionId}`)
  if (title) console.log(`Title:         ${title}`)
  console.log(`Project:       ${displayProjectPath(project)}`)
  console.log(`Size:          ${formatBytes(stats.size)}`)
  console.log(`Messages:      ${messageCount}`)
  if (firstTimestamp) {
    console.log(`Started:       ${new Date(firstTimestamp).toLocaleString()}`)
  }
  if (lastTimestamp) {
    console.log(`Last activity: ${new Date(lastTimestamp).toLocaleString()}`)
  }

  const writes = db
    .prepare("SELECT file_path, timestamp, content_size FROM writes WHERE session_id = ? ORDER BY timestamp")
    .all(sessionId) as {
    file_path: string
    timestamp: string
    content_size: number
  }[]

  if (writes.length > 0) {
    console.log(`\nFile writes (${writes.length}):`)
    for (const w of writes.slice(0, 20)) {
      const time = new Date(w.timestamp).toLocaleTimeString()
      const size = formatBytes(w.content_size)
      const shortPath = w.file_path.replace(os.homedir(), "~")
      console.log(`  ${time}  ${size.padStart(8)}  ${shortPath}`)
    }
    if (writes.length > 20) {
      console.log(`  ... and ${writes.length - 20} more writes`)
    }
  }

  closeDb()
}
