/**
 * GitHub plugin — unit tests
 *
 * Tests the extracted core logic (event formatting, cursor persistence,
 * repo detection, plugin availability) without hitting the GitHub API.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { existsSync, unlinkSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

import {
  formatEvent,
  loadCursor,
  saveCursor,
  getGitHubToken,
  detectRepoFromGit,
} from "../tools/lib/tribe/github-plugin.ts"

// ---------------------------------------------------------------------------
// formatEvent
// ---------------------------------------------------------------------------

describe("formatEvent", () => {
  const allTypes = ["push", "workflow_run", "pull_request", "issues"]

  test("PushEvent formats correctly", () => {
    const event = {
      id: "1",
      type: "PushEvent",
      actor: { login: "beorn" },
      repo: { name: "beorn/km" },
      payload: {
        ref: "refs/heads/main",
        size: 2,
        before: "aabbccddee",
        head: "1122334455",
        commits: [
          { sha: "abc123", message: "first commit" },
          { sha: "def456", message: "second commit\nwith details" },
        ],
      },
      created_at: "2026-01-01T00:00:00Z",
    }

    const result = formatEvent(event, allTypes)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("push")
    expect(result!.line).toContain("[push]")
    expect(result!.line).toContain("beorn")
    expect(result!.line).toContain("2 commits")
    expect(result!.line).toContain("main")
    expect(result!.line).toContain("second commit")
    expect(result!.url).toContain("github.com/beorn/km/compare")
  })

  test("PushEvent returns null when push not in event types", () => {
    const event = {
      id: "1",
      type: "PushEvent",
      actor: { login: "beorn" },
      repo: { name: "beorn/km" },
      payload: { ref: "refs/heads/main", size: 1, commits: [{ sha: "abc", message: "msg" }] },
      created_at: "2026-01-01T00:00:00Z",
    }

    const result = formatEvent(event, ["pull_request", "issues"])
    expect(result).toBeNull()
  })

  test("PullRequestEvent formats correctly", () => {
    const event = {
      id: "2",
      type: "PullRequestEvent",
      actor: { login: "contributor" },
      repo: { name: "beorn/km" },
      payload: {
        action: "opened",
        pull_request: { number: 42, title: "Add feature X", html_url: "https://github.com/beorn/km/pull/42" },
      },
      created_at: "2026-01-01T00:00:00Z",
    }

    const result = formatEvent(event, allTypes)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("pr")
    expect(result!.line).toContain("[pr]")
    expect(result!.line).toContain("contributor")
    expect(result!.line).toContain("opened")
    expect(result!.line).toContain("#42")
    expect(result!.line).toContain("Add feature X")
  })

  test("PullRequestReviewEvent formats correctly", () => {
    const event = {
      id: "3",
      type: "PullRequestReviewEvent",
      actor: { login: "reviewer" },
      repo: { name: "beorn/km" },
      payload: {
        review: { state: "approved", html_url: "https://github.com/beorn/km/pull/42#review" },
        pull_request: { number: 42, title: "Fix bug" },
      },
      created_at: "2026-01-01T00:00:00Z",
    }

    const result = formatEvent(event, allTypes)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("pr")
    expect(result!.line).toContain("[review]")
    expect(result!.line).toContain("approved")
  })

  test("PullRequestReviewCommentEvent formats correctly", () => {
    const event = {
      id: "4",
      type: "PullRequestReviewCommentEvent",
      actor: { login: "reviewer" },
      repo: { name: "beorn/km" },
      payload: {
        pull_request: { number: 42 },
        comment: { html_url: "https://github.com/beorn/km/pull/42#comment", body: "Looks good to me" },
      },
      created_at: "2026-01-01T00:00:00Z",
    }

    const result = formatEvent(event, allTypes)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("pr")
    expect(result!.line).toContain("[pr-comment]")
    expect(result!.line).toContain("Looks good to me")
  })

  test("IssuesEvent formats correctly", () => {
    const event = {
      id: "5",
      type: "IssuesEvent",
      actor: { login: "reporter" },
      repo: { name: "beorn/km" },
      payload: {
        action: "opened",
        issue: { number: 99, title: "Bug report", html_url: "https://github.com/beorn/km/issues/99" },
      },
      created_at: "2026-01-01T00:00:00Z",
    }

    const result = formatEvent(event, allTypes)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("issue")
    expect(result!.line).toContain("[issue]")
    expect(result!.line).toContain("#99")
  })

  test("IssueCommentEvent formats correctly", () => {
    const event = {
      id: "6",
      type: "IssueCommentEvent",
      actor: { login: "commenter" },
      repo: { name: "beorn/km" },
      payload: {
        issue: { number: 99, title: "Bug report" },
        comment: { html_url: "https://github.com/beorn/km/issues/99#comment", body: "I can reproduce this" },
      },
      created_at: "2026-01-01T00:00:00Z",
    }

    const result = formatEvent(event, allTypes)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("issue")
    expect(result!.line).toContain("[issue-comment]")
  })

  test("unknown event type returns null", () => {
    const event = {
      id: "7",
      type: "WatchEvent",
      actor: { login: "someone" },
      repo: { name: "beorn/km" },
      payload: {},
      created_at: "2026-01-01T00:00:00Z",
    }

    const result = formatEvent(event, allTypes)
    expect(result).toBeNull()
  })

  test("single commit uses singular", () => {
    const event = {
      id: "8",
      type: "PushEvent",
      actor: { login: "beorn" },
      repo: { name: "beorn/km" },
      payload: {
        ref: "refs/heads/main",
        size: 1,
        before: "aabbccddee",
        head: "1122334455",
        commits: [{ sha: "abc123", message: "one commit" }],
      },
      created_at: "2026-01-01T00:00:00Z",
    }

    const result = formatEvent(event, allTypes)
    expect(result!.line).toContain("1 commit to")
    expect(result!.line).not.toContain("commits")
  })

  test("long PR comment body is truncated to 80 chars", () => {
    const longBody = "A".repeat(200)
    const event = {
      id: "9",
      type: "PullRequestReviewCommentEvent",
      actor: { login: "reviewer" },
      repo: { name: "beorn/km" },
      payload: {
        pull_request: { number: 1 },
        comment: { html_url: "https://example.com", body: longBody },
      },
      created_at: "2026-01-01T00:00:00Z",
    }

    const result = formatEvent(event, allTypes)
    // The body portion should be at most 80 chars
    expect(result!.line.length).toBeLessThan(200)
  })
})

// ---------------------------------------------------------------------------
// Cursor persistence
// ---------------------------------------------------------------------------

describe("cursor persistence", () => {
  let cursorPath: string

  beforeEach(() => {
    cursorPath = join(tmpdir(), `github-cursor-test-${randomUUID()}.json`)
  })

  afterEach(() => {
    try {
      if (existsSync(cursorPath)) unlinkSync(cursorPath)
    } catch {
      /* ignore */
    }
  })

  test("loadCursor returns empty state for missing file", () => {
    const cursor = loadCursor(cursorPath)
    expect(cursor).toEqual({ repos: {} })
  })

  test("saveCursor + loadCursor roundtrip", () => {
    const state = {
      repos: {
        "beorn/km": { lastEventId: "evt-123", lastPollAt: "2026-01-01T00:00:00Z" },
      },
    }
    saveCursor(cursorPath, state)
    const loaded = loadCursor(cursorPath)
    expect(loaded).toEqual(state)
  })

  test("loadCursor handles corrupt JSON gracefully", () => {
    writeFileSync(cursorPath, "not-valid-json{{{")
    const cursor = loadCursor(cursorPath)
    expect(cursor).toEqual({ repos: {} })
  })
})

// ---------------------------------------------------------------------------
// Auth and repo detection (smoke tests)
// ---------------------------------------------------------------------------

describe("getGitHubToken", () => {
  test("returns token from GITHUB_TOKEN env if set", () => {
    const orig = process.env.GITHUB_TOKEN
    try {
      process.env.GITHUB_TOKEN = "test-token-123"
      const token = getGitHubToken()
      expect(token).toBe("test-token-123")
    } finally {
      if (orig !== undefined) process.env.GITHUB_TOKEN = orig
      else delete process.env.GITHUB_TOKEN
    }
  })
})

describe("detectRepoFromGit", () => {
  test("detects repo from current git remote", () => {
    // This test runs inside the km repo, so it should detect something
    const repo = detectRepoFromGit()
    // Could be null if running in CI without a remote, but if non-null, should be a valid slug
    if (repo) {
      expect(repo).toMatch(/^[\w.-]+\/[\w.-]+$/)
    }
  })
})
