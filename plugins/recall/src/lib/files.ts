/**
 * File write commands — list, search, and restore file writes.
 */

import * as os from "os"
import { getDb, closeDb } from "../history/db"
import type { WriteRecord } from "../history/types"
import { formatBytes, groupBy, BOLD, DIM, RESET } from "./format"

// ============================================================================
// List/search writes
// ============================================================================

export async function cmdFiles(pattern?: string, opts?: { date?: string; restore?: string }): Promise<void> {
  // --restore takes priority
  if (opts?.restore) {
    await restoreFile(opts.restore)
    return
  }

  // With pattern: search writes by file path
  if (pattern) {
    await searchWrites(pattern)
    return
  }

  // No pattern: list recent writes
  await listWrites(opts?.date)
}

// ============================================================================
// List recent writes
// ============================================================================

async function listWrites(date?: string): Promise<void> {
  const db = getDb()

  let query = `SELECT file_path, timestamp, content_hash, content_size, session_id FROM writes`
  const params: string[] = []

  if (date) {
    query += ` WHERE timestamp LIKE ?`
    params.push(`${date}%`)
  }

  query += ` ORDER BY timestamp DESC LIMIT 100`

  const rows = db.prepare(query).all(...params) as WriteRecord[]

  if (rows.length === 0) {
    console.log(date ? `No writes found for date: ${date}` : "No writes found")
    closeDb()
    return
  }

  console.log(`Recent writes${date ? ` on ${date}` : ""}:\n`)

  for (const row of rows) {
    const d = new Date(row.timestamp).toLocaleString()
    const size = formatBytes(row.content_size)
    const shortPath = row.file_path.replace(os.homedir(), "~")
    console.log(`${d}  ${size.padStart(8)}  ${shortPath}`)
  }

  if (rows.length === 100) console.log("\n(showing first 100 results)")
  closeDb()
}

// ============================================================================
// Search writes by file path
// ============================================================================

async function searchWrites(pattern: string): Promise<void> {
  const db = getDb()

  const sqlPattern = pattern.replace(/\*\*/g, "%").replace(/\*/g, "%").replace(/\?/g, "_")

  const rows = db
    .prepare(`
    SELECT file_path, timestamp, content_hash, content_size, session_id
    FROM writes WHERE file_path LIKE ? ORDER BY timestamp DESC
  `)
    .all(`%${sqlPattern}%`) as WriteRecord[]

  if (rows.length === 0) {
    console.log(`No writes found matching: ${pattern}`)
    closeDb()
    return
  }

  console.log(`Found ${rows.length} writes matching "${pattern}":\n`)

  const byPath = groupBy(rows, (r) => r.file_path)

  for (const [fp, versions] of byPath) {
    console.log(`\u{1F4C4} ${fp}`)
    for (const v of versions.slice(0, 5)) {
      const d = new Date(v.timestamp).toLocaleString()
      const size = formatBytes(v.content_size)
      console.log(`   ${d}  ${size}  [${v.content_hash}]  session:${v.session_id.slice(0, 8)}`)
    }
    if (versions.length > 5) {
      console.log(`   ... and ${versions.length - 5} more versions`)
    }
    console.log()
  }

  closeDb()
}

// ============================================================================
// Restore file content
// ============================================================================

async function restoreFile(filePath: string): Promise<void> {
  const db = getDb()

  const rows = db
    .prepare(`SELECT * FROM writes WHERE file_path LIKE ? ORDER BY timestamp DESC`)
    .all(`%${filePath}`) as WriteRecord[]

  if (rows.length === 0) {
    console.log(`No writes found for: ${filePath}`)
    closeDb()
    return
  }

  const firstRow = rows[0]!
  if (rows.length === 1 || firstRow.content) {
    if (firstRow.content) {
      console.log(`// File: ${firstRow.file_path}`)
      console.log(`// Written: ${new Date(firstRow.timestamp).toLocaleString()}`)
      console.log(`// Session: ${firstRow.session_id}`)
      console.log(`// Hash: ${firstRow.content_hash}`)
      console.log(`// Size: ${formatBytes(firstRow.content_size)}`)
      console.log("// " + "=".repeat(70))
      console.log(firstRow.content)
    } else {
      console.log(`Content not stored (file was ${formatBytes(firstRow.content_size)}, exceeds 1MB limit)`)
      console.log(`Session file: ${firstRow.session_file}`)
      console.log(`Tool use ID: ${firstRow.tool_use_id}`)
      console.log("\nTo extract manually, search the session file for the tool_use_id")
    }
  } else {
    console.log(`Found ${rows.length} versions of files matching "${filePath}":\n`)

    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const row = rows[i]!
      const d = new Date(row.timestamp).toLocaleString()
      const hasContent = row.content ? "\u2713" : "\u2717"
      console.log(`${i + 1}. ${d}  [${row.content_hash}]  ${hasContent}content  session:${row.session_id.slice(0, 8)}`)
      if (row.file_path !== filePath) console.log(`   ${row.file_path}`)
    }

    console.log("\nTo restore a specific version, use:")
    console.log(`  bun recall files --restore "${firstRow.file_path}" --session <session-id>`)
  }

  closeDb()
}
