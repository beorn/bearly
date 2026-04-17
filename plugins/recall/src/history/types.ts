/**
 * Claude Session types and schemas
 */

import { z } from "zod"

// Message types from Claude Code session JSONL files
export const MessageTypeSchema = z.enum([
  "user",
  "assistant",
  "progress",
  "bash_progress",
  "tool_use",
  "tool_result",
  "agent_progress",
  "file-history-snapshot",
  "system",
  "summary",
])
export type MessageType = z.infer<typeof MessageTypeSchema>

// Database record schemas
export interface SessionRecord {
  id: string
  project_path: string
  jsonl_path: string
  created_at: number
  updated_at: number
  message_count: number
  title: string | null
}

// Entry from sessions-index.json
export interface SessionIndexEntry {
  sessionId: string
  customTitle?: string
  firstPrompt?: string
  summary?: string
  fileMtime?: number
  messageCount?: number
  created?: string
  modified?: string
  gitBranch?: string
  projectPath?: string
}

// Content types for unified search
export type ContentType =
  | "message"
  | "plan"
  | "summary"
  | "todo"
  | "first_prompt"
  | "bead"
  | "session_memory"
  | "project_memory"
  | "doc"
  | "claude_md"
  | "llm_research"

// Bead record from issues.jsonl
export interface BeadRecord {
  id: string
  title: string
  description?: string
  status: string
  priority?: number
  issue_type?: string
  notes?: string
  design?: string
  close_reason?: string
  created_at?: string
  updated_at?: string
  closed_at?: string
  parent?: string
}

// Unified content record for FTS
export interface ContentRecord {
  id: number
  content_type: ContentType
  source_id: string // session_id, plan filename, or todo id
  project_path: string | null
  title: string | null
  content: string
  timestamp: number
}

// Plan file metadata
export interface PlanRecord {
  filename: string
  path: string
  content: string
  mtime: number
}

// Todo item
export interface TodoItem {
  content: string
  status: "pending" | "completed"
  activeForm?: string
}

export interface MessageRecord {
  id: number
  uuid: string
  session_id: string
  type: string
  content: string | null
  tool_name: string | null
  file_paths: string | null
  timestamp: number
}

export interface WriteRecord {
  id: number
  session_id: string
  session_file: string
  tool_use_id: string
  timestamp: string
  file_path: string
  content_hash: string
  content_size: number
  content: string | null
}

// Parsed JSONL record
export interface JsonlRecord {
  type: string
  sessionId?: string
  uuid?: string
  parentUuid?: string
  timestamp?: string
  cwd?: string
  gitBranch?: string
  isSidechain?: boolean
  message?: {
    content?: (ToolUse | { type: string; text?: string; thinking?: string })[]
  }
  content?: string | unknown[]
  toolName?: string
}

export interface ToolUse {
  type: "tool_use"
  id: string
  name: string
  input: {
    file_path?: string
    content?: string
    command?: string
    [key: string]: unknown
  }
}

// Search result
export interface FtsSearchResult {
  sessionId: string
  projectPath: string
  type: string
  content: string
  timestamp: number
  rank: number
  snippet?: string
}

// Activity summary
export interface ActivitySummary {
  projectPath: string
  displayPath: string
  messageCount: number
  sessionCount: number
  lastActivity: number
}

// Similar query result
export interface SimilarResult {
  userMessage: string
  assistantResponse: string
  sessionId: string
  projectPath: string
  timestamp: number
  rank: number
}
