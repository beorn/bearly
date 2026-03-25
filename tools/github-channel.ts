#!/usr/bin/env bun
/**
 * GitHub Channel — GitHub notifications for Claude Code
 *
 * An MCP channel plugin that polls the GitHub REST API for events
 * (pushes, PRs, workflow runs, issues) and delivers them as channel
 * notifications to Claude Code sessions.
 *
 * Usage:
 *   # In .mcp.json:
 *   { "command": "bun", "args": ["vendor/bearly/tools/github-channel.ts"] }
 *
 *   # With options:
 *   bun vendor/bearly/tools/github-channel.ts --repos beorn/km --poll-interval 30
 *
 *   # Launch Claude Code with the channel:
 *   claude --dangerously-load-development-channels server:github
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { execSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    repos: { type: "string", default: process.env.GITHUB_REPOS },
    "poll-interval": { type: "string", default: process.env.GITHUB_POLL_INTERVAL ?? "30" },
    events: { type: "string", default: process.env.GITHUB_EVENTS ?? "push,workflow_run,pull_request,issues" },
  },
  strict: false,
})

const POLL_INTERVAL_SEC = parseInt(String(args["poll-interval"]), 10) || 30
const EVENT_TYPES = String(args.events ?? "push,workflow_run,pull_request,issues")
  .split(",")
  .filter(Boolean)

// ---------------------------------------------------------------------------
// GitHub auth
// ---------------------------------------------------------------------------

function getGitHubToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    return execSync("gh auth token", { encoding: "utf-8" }).trim()
  } catch {
    throw new Error("No GITHUB_TOKEN env var and `gh auth token` failed. Set GITHUB_TOKEN or run `gh auth login`.")
  }
}

const GITHUB_TOKEN = getGitHubToken()
const GITHUB_HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "bearly-github-channel/0.1.0",
}

// ---------------------------------------------------------------------------
// Repo detection
// ---------------------------------------------------------------------------

function detectRepoFromGit(): string | null {
  try {
    const url = execSync("git remote get-url origin", { encoding: "utf-8" }).trim()
    // Handle SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/github\.com[:/](.+?)(?:\.git)?$/)
    if (sshMatch) return sshMatch[1]
    // Handle HTTPS: https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com\/(.+?)(?:\.git)?$/)
    if (httpsMatch) return httpsMatch[1]
  } catch {
    // Not a git repo or no remote
  }
  return null
}

async function fetchUserRepos(): Promise<string[]> {
  const repos: string[] = []
  let page = 1
  while (true) {
    const batch = await ghFetch<Array<{ full_name: string; archived: boolean; fork: boolean }>>(
      `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
    )
    if (batch.length === 0) break
    for (const r of batch) {
      if (!r.archived && !r.fork) repos.push(r.full_name)
    }
    if (batch.length < 100) break
    page++
  }
  return repos
}

function getReposSync(): string[] {
  if (args.repos && String(args.repos) !== "all") return String(args.repos).split(",").filter(Boolean)
  const detected = detectRepoFromGit()
  if (detected) return [detected]
  throw new Error("No --repos specified and could not auto-detect from git remote. Pass --repos owner/repo,owner/repo2 or --repos all.")
}

// Resolve repos — "all" fetches from GitHub API, otherwise synchronous
let REPOS: string[]
if (String(args.repos) === "all") {
  REPOS = await fetchUserRepos()
  process.stderr.write(`[github] Discovered ${REPOS.length} repos for authenticated user\n`)
} else {
  REPOS = getReposSync()
}

// ---------------------------------------------------------------------------
// Cursor persistence
// ---------------------------------------------------------------------------

function findBeadsDir(): string {
  let dir = process.cwd()
  while (dir !== "/") {
    const candidate = resolve(dir, ".beads")
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  const fallback = resolve(process.cwd(), ".beads")
  mkdirSync(fallback, { recursive: true })
  return fallback
}

const CURSOR_PATH = resolve(findBeadsDir(), "github-cursor.json")

interface CursorState {
  // Per-repo last-seen event ID
  repos: Record<string, { lastEventId: string; lastPollAt: string }>
}

function loadCursor(): CursorState {
  try {
    if (existsSync(CURSOR_PATH)) {
      return JSON.parse(readFileSync(CURSOR_PATH, "utf-8"))
    }
  } catch {
    // Corrupt file — start fresh
  }
  return { repos: {} }
}

function saveCursor(state: CursorState): void {
  writeFileSync(CURSOR_PATH, JSON.stringify(state, null, 2))
}

const cursorState = loadCursor()

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

interface GitHubEvent {
  id: string
  type: string
  actor: { login: string }
  repo: { name: string }
  payload: Record<string, unknown>
  created_at: string
}

interface WorkflowRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  html_url: string
  head_branch: string
  head_sha: string
  run_number: number
  created_at: string
  updated_at: string
  actor: { login: string }
}

interface PullRequest {
  number: number
  title: string
  state: string
  html_url: string
  user: { login: string }
  draft: boolean
  created_at: string
  updated_at: string
  head: { ref: string }
  base: { ref: string }
  requested_reviewers: Array<{ login: string }>
  mergeable_state?: string
}

async function ghFetch<T>(path: string): Promise<T> {
  const url = path.startsWith("https://") ? path : `https://api.github.com${path}`
  const res = await fetch(url, { headers: GITHUB_HEADERS })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

async function fetchRepoEvents(repo: string): Promise<GitHubEvent[]> {
  return ghFetch<GitHubEvent[]>(`/repos/${repo}/events?per_page=30`)
}

async function fetchWorkflowRuns(repo: string, status?: string): Promise<WorkflowRun[]> {
  const params = new URLSearchParams({ per_page: "20" })
  if (status) params.set("status", status)
  const data = await ghFetch<{ workflow_runs: WorkflowRun[] }>(`/repos/${repo}/actions/runs?${params}`)
  return data.workflow_runs
}

async function fetchOpenPRs(repo: string): Promise<PullRequest[]> {
  return ghFetch<PullRequest[]>(`/repos/${repo}/pulls?state=open&per_page=20&sort=updated&direction=desc`)
}

// ---------------------------------------------------------------------------
// Event formatting
// ---------------------------------------------------------------------------

function formatEvent(event: GitHubEvent): { line: string; type: string; url: string } | null {
  const actor = event.actor.login
  const repo = event.repo.name
  const payload = event.payload

  switch (event.type) {
    case "PushEvent": {
      if (!EVENT_TYPES.includes("push")) return null
      const commits = payload.commits as Array<{ sha: string; message: string }> | undefined
      const count = (payload.size as number) ?? commits?.length ?? 0
      const branch = (payload.ref as string)?.replace("refs/heads/", "") ?? "unknown"
      const lastMsg = commits?.[commits.length - 1]?.message?.split("\n")[0] ?? ""
      const url = `https://github.com/${repo}/compare/${(payload.before as string)?.slice(0, 7)}...${(payload.head as string)?.slice(0, 7)}`
      return {
        line: `[push] ${actor} pushed ${count} commit${count !== 1 ? "s" : ""} to ${branch} — ${lastMsg}`,
        type: "push",
        url,
      }
    }

    case "PullRequestEvent": {
      if (!EVENT_TYPES.includes("pull_request")) return null
      const pr = payload.pull_request as { number: number; title: string; html_url: string } | undefined
      const action = payload.action as string
      if (!pr) return null
      return {
        line: `[pr] ${actor} ${action} PR #${pr.number}: ${pr.title}`,
        type: "pr",
        url: pr.html_url,
      }
    }

    case "PullRequestReviewEvent": {
      if (!EVENT_TYPES.includes("pull_request")) return null
      const review = payload.review as { state: string; html_url: string } | undefined
      const prNum = (payload.pull_request as { number: number })?.number
      const prTitle = (payload.pull_request as { title: string })?.title
      if (!review) return null
      return {
        line: `[review] ${actor} ${review.state} review on PR #${prNum}: ${prTitle}`,
        type: "pr",
        url: review.html_url,
      }
    }

    case "PullRequestReviewCommentEvent": {
      if (!EVENT_TYPES.includes("pull_request")) return null
      const comment = payload.comment as { html_url: string; body: string } | undefined
      const prNumC = (payload.pull_request as { number: number })?.number
      if (!comment) return null
      const body = comment.body.split("\n")[0].slice(0, 80)
      return {
        line: `[pr-comment] ${actor} commented on PR #${prNumC}: ${body}`,
        type: "pr",
        url: comment.html_url,
      }
    }

    case "IssuesEvent": {
      if (!EVENT_TYPES.includes("issues")) return null
      const issue = payload.issue as { number: number; title: string; html_url: string } | undefined
      const issueAction = payload.action as string
      if (!issue) return null
      return {
        line: `[issue] ${actor} ${issueAction} #${issue.number}: ${issue.title}`,
        type: "issue",
        url: issue.html_url,
      }
    }

    case "IssueCommentEvent": {
      if (!EVENT_TYPES.includes("issues")) return null
      const issueC = payload.issue as { number: number; title: string } | undefined
      const commentC = payload.comment as { html_url: string; body: string } | undefined
      if (!issueC || !commentC) return null
      const bodyC = commentC.body.split("\n")[0].slice(0, 80)
      return {
        line: `[issue-comment] ${actor} on #${issueC.number}: ${bodyC}`,
        type: "issue",
        url: commentC.html_url,
      }
    }

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Recent events buffer (for github_status tool)
// ---------------------------------------------------------------------------

interface RecentEvent {
  repo: string
  line: string
  type: string
  url: string
  ts: string
}

const recentEvents: RecentEvent[] = []
const MAX_RECENT = 50

function addRecentEvent(event: RecentEvent): void {
  recentEvents.unshift(event)
  if (recentEvents.length > MAX_RECENT) recentEvents.length = MAX_RECENT
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const instructions = `GitHub notifications arrive as <channel source="github" type="push|pr|workflow|issue" repo="..." url="...">.

This channel monitors GitHub for:
- **Push events** — new commits pushed to branches
- **Workflow runs** — CI/CD completions (especially failures)
- **Pull request activity** — opened, merged, review requested, comments
- **Issue activity** — opened, closed, assigned, commented

Use the tools to query GitHub directly:
- \`github_status\` — recent events summary
- \`github_runs\` — workflow runs (filter by status: failure, success, in_progress)
- \`github_prs\` — open PRs with review status

Repos being monitored: ${REPOS.join(", ")}

React to workflow failures immediately — they likely need attention. PR reviews and comments
may need a response. Push events are informational unless they conflict with your current work.`

const mcp = new Server(
  { name: "github", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions,
  },
)

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "github_status",
      description: "Show recent GitHub events summary across monitored repos",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string", description: "Filter to specific repo (owner/name)" },
          limit: { type: "number", description: "Max events to show (default: 20)" },
        },
      },
    },
    {
      name: "github_runs",
      description: "List recent workflow runs with status/conclusion",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string", description: "Repo to query (default: first monitored repo)" },
          status: {
            type: "string",
            description: "Filter by status",
            enum: ["completed", "in_progress", "queued", "failure", "success"],
          },
          limit: { type: "number", description: "Max runs to show (default: 10)" },
        },
      },
    },
    {
      name: "github_prs",
      description: "List open PRs with review status",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string", description: "Repo to query (default: first monitored repo)" },
        },
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: toolArgs } = req.params
  const a = (toolArgs ?? {}) as Record<string, unknown>

  switch (name) {
    case "github_status": {
      const limit = (a.limit as number) ?? 20
      const repo = a.repo as string | undefined
      const filtered = repo ? recentEvents.filter((e) => e.repo === repo) : recentEvents
      const events = filtered.slice(0, limit)

      if (events.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                events: [],
                repos: REPOS,
                message: "No events captured yet. Events arrive via polling every " + POLL_INTERVAL_SEC + "s.",
              }),
            },
          ],
        }
      }

      const lines = events.map((e) => `${e.ts}  ${e.repo}  ${e.line}  ${e.url}`)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ repos: REPOS, count: events.length, events: lines }, null, 2),
          },
        ],
      }
    }

    case "github_runs": {
      const repo = (a.repo as string) ?? REPOS[0]
      const limit = (a.limit as number) ?? 10
      const statusFilter = a.status as string | undefined

      // The API status param only accepts: completed, in_progress, queued, waiting, requested, pending
      // "failure" and "success" are conclusions, not statuses
      let apiStatus: string | undefined
      let conclusionFilter: string | undefined
      if (statusFilter === "failure" || statusFilter === "success") {
        apiStatus = "completed"
        conclusionFilter = statusFilter
      } else {
        apiStatus = statusFilter
      }

      const runs = await fetchWorkflowRuns(repo, apiStatus)
      let filtered = runs
      if (conclusionFilter) {
        filtered = runs.filter((r) => r.conclusion === conclusionFilter)
      }
      filtered = filtered.slice(0, limit)

      const formatted = filtered.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        branch: r.head_branch,
        run: r.run_number,
        actor: r.actor.login,
        url: r.html_url,
        updated: r.updated_at,
      }))

      return { content: [{ type: "text", text: JSON.stringify({ repo, runs: formatted }, null, 2) }] }
    }

    case "github_prs": {
      const repo = (a.repo as string) ?? REPOS[0]
      const prs = await fetchOpenPRs(repo)

      const formatted = prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        author: pr.user.login,
        branch: `${pr.head.ref} → ${pr.base.ref}`,
        draft: pr.draft,
        reviewers: pr.requested_reviewers.map((r) => r.login),
        url: pr.html_url,
        updated: pr.updated_at,
      }))

      return { content: [{ type: "text", text: JSON.stringify({ repo, prs: formatted }, null, 2) }] }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
})

// ---------------------------------------------------------------------------
// Polling loop — fetch GitHub events and push as channel notifications
// ---------------------------------------------------------------------------

async function pollGitHubEvents(): Promise<void> {
  for (const repo of REPOS) {
    try {
      const events = await fetchRepoEvents(repo)
      const repoCursor = cursorState.repos[repo]
      const lastSeenId = repoCursor?.lastEventId

      // Find new events (events are newest-first from the API)
      const newEvents: GitHubEvent[] = []
      for (const event of events) {
        if (event.id === lastSeenId) break
        newEvents.push(event)
      }

      // On first poll, don't deliver historical events — just set the cursor
      if (!lastSeenId) {
        if (events.length > 0) {
          cursorState.repos[repo] = {
            lastEventId: events[0].id,
            lastPollAt: new Date().toISOString(),
          }
          saveCursor(cursorState)
        }
        continue
      }

      // Process newest-last so notifications arrive in chronological order
      for (const event of newEvents.reverse()) {
        const formatted = formatEvent(event)
        if (!formatted) continue

        const meta: Record<string, string> = {
          from: "github",
          type: formatted.type,
          repo,
          url: formatted.url,
        }

        await mcp.notification({
          method: "notifications/claude/channel",
          params: { content: formatted.line, meta },
        })

        addRecentEvent({
          repo,
          line: formatted.line,
          type: formatted.type,
          url: formatted.url,
          ts: event.created_at,
        })
      }

      // Update cursor
      if (events.length > 0) {
        cursorState.repos[repo] = {
          lastEventId: events[0].id,
          lastPollAt: new Date().toISOString(),
        }
        saveCursor(cursorState)
      }
    } catch (err) {
      process.stderr.write(`[github] Error polling ${repo}: ${err instanceof Error ? err.message : err}\n`)
    }
  }
}

// Also poll workflow runs for failures (events API doesn't always capture these promptly)
async function pollWorkflowFailures(): Promise<void> {
  for (const repo of REPOS) {
    if (!EVENT_TYPES.includes("workflow_run")) continue
    try {
      const runs = await fetchWorkflowRuns(repo, "completed")
      const failures = runs.filter((r) => r.conclusion === "failure")

      // Only notify about recent failures (last 5 minutes)
      const cutoff = Date.now() - 5 * 60 * 1000
      const recent = failures.filter((r) => new Date(r.updated_at).getTime() > cutoff)

      for (const run of recent.slice(0, 3)) {
        // Check if we already notified about this run
        const key = `workflow-${run.id}`
        if (recentEvents.some((e) => e.url === run.html_url)) continue

        const line = `[workflow] ${run.name} #${run.run_number} FAILED on ${run.head_branch} (${run.actor.login})`

        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: line,
            meta: {
              from: "github",
              type: "workflow",
              repo,
              url: run.html_url,
            },
          },
        })

        addRecentEvent({
          repo,
          line,
          type: "workflow",
          url: run.html_url,
          ts: run.updated_at,
        })
      }
    } catch (err) {
      process.stderr.write(
        `[github] Error polling workflows for ${repo}: ${err instanceof Error ? err.message : err}\n`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

process.stderr.write(`[github] Monitoring repos: ${REPOS.join(", ")}\n`)
process.stderr.write(`[github] Poll interval: ${POLL_INTERVAL_SEC}s\n`)
process.stderr.write(`[github] Event types: ${EVENT_TYPES.join(", ")}\n`)
process.stderr.write(`[github] Cursor file: ${CURSOR_PATH}\n`)

// Initial poll
void pollGitHubEvents()

// Regular polling
const eventPollInterval = setInterval(() => void pollGitHubEvents(), POLL_INTERVAL_SEC * 1000)

// Workflow failure polling (every 60s — separate from events since it's a different endpoint)
const workflowPollInterval = setInterval(() => void pollWorkflowFailures(), 60_000)
// Initial workflow poll after a short delay
setTimeout(() => void pollWorkflowFailures(), 5_000)

// Cleanup on exit
let cleaned = false
function cleanup(): void {
  if (cleaned) return
  cleaned = true
  clearInterval(eventPollInterval)
  clearInterval(workflowPollInterval)
  saveCursor(cursorState)
}

process.on("SIGINT", () => {
  cleanup()
  process.exit(0)
})
process.on("SIGTERM", () => {
  cleanup()
  process.exit(0)
})
process.on("exit", cleanup)

// Connect to Claude Code
await mcp.connect(new StdioServerTransport())
