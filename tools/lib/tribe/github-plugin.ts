/**
 * Tribe plugin: GitHub — polls GitHub API for events and broadcasts to all sessions.
 *
 * Extracts the core polling/formatting logic from github-channel.ts (the standalone
 * MCP server) and wraps it as a TribePlugin. One daemon process becomes the GitHub
 * provider; all connected sessions receive notifications via the tribe message bus.
 *
 * Config via env vars (same as github-channel.ts):
 *   GITHUB_TOKEN / `gh auth token`  — authentication
 *   GITHUB_POLL_INTERVAL            — seconds between polls (default: 30)
 *   GITHUB_EVENTS                   — comma-separated event types (default: push,workflow_run,pull_request,issues)
 *   GITHUB_WORKFLOW_NOTIFY          — "all" | "failure" | "success" (default: "all")
 */

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { createLogger } from "loggily"
import { findBeadsDir } from "./config.ts"
import type { TribePlugin, PluginContext } from "./plugins.ts"

const log = createLogger("tribe:github")

// ---------------------------------------------------------------------------
// GitHub auth
// ---------------------------------------------------------------------------

export function getGitHubToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    return execSync("gh auth token", { encoding: "utf-8", stdio: "pipe" }).trim()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Repo detection
// ---------------------------------------------------------------------------

export function detectRepoFromGit(dir?: string): string | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd: dir ?? process.cwd(),
      encoding: "utf-8",
      stdio: "pipe",
    }).trim()
    const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/** Detect GitHub repo from cwd's git remote (for fast startup before API call) */
function detectLocalRepo(): string | null {
  return detectRepoFromGit()
}

/** Fetch all non-archived, non-fork repos owned by the authenticated user */
async function fetchUserRepos(headers: Record<string, string>): Promise<string[]> {
  const repos: string[] = []
  let page = 1
  while (true) {
    const batch = await ghFetch<Array<{ full_name: string; archived: boolean; fork: boolean }>>(
      `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner`,
      headers,
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

// ---------------------------------------------------------------------------
// Cursor persistence
// ---------------------------------------------------------------------------

interface CursorState {
  repos: Record<string, { lastEventId: string; lastPollAt: string }>
}

function resolveCursorPath(): string {
  const beadsDir = findBeadsDir()
  if (beadsDir) return resolve(beadsDir, "github-cursor.json")
  // Fallback to cwd .beads/
  const fallback = resolve(process.cwd(), ".beads")
  mkdirSync(fallback, { recursive: true })
  return resolve(fallback, "github-cursor.json")
}

export function loadCursor(cursorPath: string): CursorState {
  try {
    if (existsSync(cursorPath)) {
      return JSON.parse(readFileSync(cursorPath, "utf-8"))
    }
  } catch {
    // Corrupt file — start fresh
  }
  return { repos: {} }
}

export function saveCursor(cursorPath: string, state: CursorState): void {
  writeFileSync(cursorPath, JSON.stringify(state, null, 2))
}

// ---------------------------------------------------------------------------
// GitHub API
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

// ETag cache — 304 responses don't count against GitHub rate limit
const etagCache = new Map<string, { etag: string; data: unknown }>()

let apiCallsMade = 0
let apiCallsSaved = 0
let rateLimitRemaining = 5000
let rateLimitTotal = 5000

export async function ghFetch<T>(path: string, headers: Record<string, string>): Promise<T> {
  const url = path.startsWith("https://") ? path : `https://api.github.com${path}`
  const reqHeaders: Record<string, string> = { ...headers }
  const cached = etagCache.get(url)
  if (cached?.etag) reqHeaders["If-None-Match"] = cached.etag

  const res = await fetch(url, { headers: reqHeaders })

  // Track rate limit
  const remaining = res.headers.get("x-ratelimit-remaining")
  const limit = res.headers.get("x-ratelimit-limit")
  if (remaining) rateLimitRemaining = parseInt(remaining, 10)
  if (limit) rateLimitTotal = parseInt(limit, 10)

  if (res.status === 304 && cached) {
    apiCallsSaved++
    return cached.data as T
  }

  apiCallsMade++

  if (!res.ok) {
    const body = await res.text()
    if (res.status === 403 && body.includes("rate limit")) {
      const reset = res.headers.get("x-ratelimit-reset")
      const resetIn = reset ? Math.ceil((parseInt(reset, 10) * 1000 - Date.now()) / 60000) : "?"
      log.warn?.(
        `RATE LIMITED — resets in ${resetIn} min. Calls made: ${apiCallsMade}, saved by ETag: ${apiCallsSaved}`,
      )
    }
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = (await res.json()) as T
  const etag = res.headers.get("etag")
  if (etag) etagCache.set(url, { etag, data })
  return data
}

async function fetchRepoEvents(repo: string, headers: Record<string, string>): Promise<GitHubEvent[]> {
  return ghFetch<GitHubEvent[]>(`/repos/${repo}/events?per_page=30`, headers)
}

async function fetchWorkflowRuns(
  repo: string,
  headers: Record<string, string>,
  status?: string,
): Promise<WorkflowRun[]> {
  const params = new URLSearchParams({ per_page: "20" })
  if (status) params.set("status", status)
  const data = await ghFetch<{ workflow_runs: WorkflowRun[] }>(`/repos/${repo}/actions/runs?${params}`, headers)
  return data.workflow_runs
}

// ---------------------------------------------------------------------------
// Event formatting
// ---------------------------------------------------------------------------

export function formatEvent(
  event: GitHubEvent,
  eventTypes: string[],
): { line: string; type: string; url: string } | null {
  const actor = event.actor.login
  const repo = event.repo.name
  const payload = event.payload

  switch (event.type) {
    case "PushEvent": {
      if (!eventTypes.includes("push")) return null
      const commits = payload.commits as Array<{ sha: string; message: string }> | undefined
      const count = commits?.length ?? (payload.size as number) ?? 0
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
      if (!eventTypes.includes("pull_request")) return null
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
      if (!eventTypes.includes("pull_request")) return null
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
      if (!eventTypes.includes("pull_request")) return null
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
      if (!eventTypes.includes("issues")) return null
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
      if (!eventTypes.includes("issues")) return null
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
// Recent events buffer (dedup for workflow runs)
// ---------------------------------------------------------------------------

interface RecentEvent {
  repo: string
  line: string
  type: string
  url: string
  ts: string
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export function githubPlugin(): TribePlugin {
  return {
    name: "github",

    available() {
      const token = getGitHubToken()
      if (!token) {
        log.info?.("no GitHub token available (skipped)")
        return false
      }
      return true
    },

    start(ctx) {
      const token = getGitHubToken()
      if (!token) return

      const githubHeaders = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bearly-github-plugin/0.1.0",
      }

      const pollIntervalSec = parseInt(process.env.GITHUB_POLL_INTERVAL ?? "60", 10) || 60
      const eventTypes = (process.env.GITHUB_EVENTS ?? "push,workflow_run,pull_request,issues")
        .split(",")
        .filter(Boolean)
      const workflowNotify = (process.env.GITHUB_WORKFLOW_NOTIFY ?? "all") as "all" | "failure" | "success"

      const cursorPath = resolveCursorPath()
      const cursorState = loadCursor(cursorPath)

      // Track recently seen workflow URLs for dedup
      const seenWorkflowUrls = new Set<string>()

      // Start with local repo for fast startup, then discover all user repos via API
      const repos = new Set<string>()
      const local = detectLocalRepo()
      if (local) repos.add(local)
      log.info?.(`local repo: ${local ?? "none"}`)

      // Async: fetch all user repos and merge
      void fetchUserRepos(githubHeaders).then((userRepos) => {
        const before = repos.size
        for (const r of userRepos) repos.add(r)
        const added = repos.size - before
        if (added > 0) {
          log.info?.(`discovered ${added} additional repos (${repos.size} total)`)
          ctx.sendMessage("*", `GitHub monitoring ${repos.size} repos (${added} new from API)`, "github:status")
        } else {
          log.info?.(`${repos.size} repos total (no new from API)`)
        }
      }).catch((err) => {
        log.error?.(`failed to fetch user repos: ${err instanceof Error ? err.message : err}`)
      })

      log.info?.(`event types: ${eventTypes.join(", ")}, workflow notify: ${workflowNotify}`)
      log.info?.(`cursor: ${cursorPath}`)

      // --- Event polling ---

      async function pollEvents(): Promise<void> {
        for (const r of repos) {
          try {
            const events = await fetchRepoEvents(r, githubHeaders)
            const repoCursor = cursorState.repos[r]
            const lastSeenId = repoCursor?.lastEventId

            const newEvents: GitHubEvent[] = []
            for (const event of events) {
              if (event.id === lastSeenId) break
              newEvents.push(event)
            }

            // First poll: set cursor without delivering historical events
            if (!lastSeenId) {
              if (events.length > 0) {
                cursorState.repos[r] = {
                  lastEventId: events[0].id,
                  lastPollAt: new Date().toISOString(),
                }
                saveCursor(cursorPath, cursorState)
              }
              continue
            }

            // Process newest-last for chronological order
            for (const event of newEvents.reverse()) {
              const formatted = formatEvent(event, eventTypes)
              if (!formatted) continue

              ctx.sendMessage("*", `${formatted.line} ${formatted.url}`, `github:${formatted.type}`)
            }

            // Update cursor
            if (events.length > 0) {
              cursorState.repos[r] = {
                lastEventId: events[0].id,
                lastPollAt: new Date().toISOString(),
              }
              saveCursor(cursorPath, cursorState)
            }
          } catch (err) {
            log.error?.(`error polling ${r}: ${err instanceof Error ? err.message : err}`)
          }
        }
      }

      // --- Workflow run polling ---

      async function pollWorkflows(): Promise<void> {
        for (const r of repos) {
          if (!eventTypes.includes("workflow_run")) continue
          try {
            const runs = await fetchWorkflowRuns(r, githubHeaders, "completed")

            const matching = runs.filter((run) => {
              if (workflowNotify === "all") return run.conclusion !== null
              return run.conclusion === workflowNotify
            })

            // Only notify about recent runs (last 5 minutes)
            const cutoff = Date.now() - 5 * 60 * 1000
            const recent = matching.filter((run) => new Date(run.updated_at).getTime() > cutoff)

            for (const run of recent.slice(0, 5)) {
              if (seenWorkflowUrls.has(run.html_url)) continue
              seenWorkflowUrls.add(run.html_url)

              const status =
                run.conclusion === "success"
                  ? "PASSED"
                  : run.conclusion === "failure"
                    ? "FAILED"
                    : String(run.conclusion).toUpperCase()
              const emoji = run.conclusion === "success" ? "✓" : run.conclusion === "failure" ? "✗" : "?"
              const line = `[workflow] ${emoji} ${run.name} #${run.run_number} ${status} on ${run.head_branch} (${run.actor.login})`

              ctx.sendMessage("*", `${line} ${run.html_url}`, `github:workflow`)
            }
          } catch (err) {
            log.error?.(`error polling workflows for ${r}: ${err instanceof Error ? err.message : err}`)
          }
        }
      }

      // Rate limit status logging
      const rateLimitInterval = setInterval(
        () => {
          log.info?.(
            `rate limit: ${rateLimitRemaining}/${rateLimitTotal} remaining. Calls: ${apiCallsMade} made, ${apiCallsSaved} saved by ETag`,
          )
        },
        5 * 60 * 1000,
      )

      // Initial poll
      void pollEvents()

      // Regular polling
      const eventPollInterval = setInterval(() => void pollEvents(), pollIntervalSec * 1000)

      // Workflow polling (every 60s, separate endpoint)
      const workflowPollInterval = setInterval(() => void pollWorkflows(), 60_000)
      // Initial workflow poll after short delay
      const workflowInitTimeout = setTimeout(() => void pollWorkflows(), 5_000)

      // Cleanup
      return () => {
        clearInterval(eventPollInterval)
        clearInterval(workflowPollInterval)
        clearInterval(rateLimitInterval)
        clearTimeout(workflowInitTimeout)
        saveCursor(cursorPath, cursorState)
      }
    },

    instructions() {
      const repo = detectRepoFromGit()
      return `- GitHub integration active: push, PR, CI, and issue notifications are delivered automatically for ${repo ?? "detected repo"}`
    },
  }
}
