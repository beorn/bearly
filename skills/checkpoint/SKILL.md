---
name: checkpoint
effort: max
description: "Save active session context, git state, recent commits, and next steps to one tracking issue before compaction or handoff."
triggers: ["/checkpoint", "checkpoint", "compact", "resume", "context"]
argument-hint: "[message]"
---

# Checkpoint

Read [/agent-system](../agent-system/SKILL.md) before editing this doc.

Save session context to a single tracking issue (in whichever tracker the project uses) so it survives compaction and can be recovered by the next session or post-compact continuation.

**Argument**: $ARGUMENTS

## What It Does

1. **Find or create ONE tracking issue** for this session
2. **Gather all context**: active issues, git status, recent commits, uncommitted changes
3. **Update the issue** with a structured checkpoint including next steps
4. **Report** the issue ID so the user (or post-compact) can recover it

## Instructions

### Step 1: Find the tracking issue

Look for an existing in-progress issue that serves as the session's tracking issue. Prefer:

1. An issue the user explicitly mentioned as the tracking/epic issue
2. The most recently claimed in-progress issue by this session
3. If none exists, create one with a great first-paragraph description: 1-3 sentences (50-400 chars) saying WHAT this session is tracking + WHY it matters. That first paragraph is what the issue tracker's quick-list view surfaces. Make it scannable cold (precise prose, no headers/lists).

If you're reusing an existing tracking issue whose first paragraph is missing/weak/stale relative to the session's actual focus, refresh it before appending the checkpoint notes below.

There must be exactly ONE tracking issue. If multiple candidates exist, pick the one most relevant to the current work.

**IMPORTANT**: The tracking issue must be claimed by this session so the pre-compact hook can find it.

### Step 2: Gather context

Collect ALL of these:

- Active issues (whatever your tracker calls in-progress)
- `git status --short | head -20`
- `git log --oneline -10`
- `git branch --show-current`
- Any open issues this session created or closed

### Step 3: Build the checkpoint

Update the tracking issue with structured notes. The **first line MUST be the RESUME directive** — this is what post-compact agents see first:

```
RESUME: <recover-command-for-your-tracker> <ISSUE_ID>
After compact, run the command above FIRST. Do not list all issues or start new work.

## Session Checkpoint
**Session:** <session-id>
**Branch:** <branch>
**Time:** <timestamp>

### What was done
<1-3 bullet summary of session work>

### Active issues
<list of in-progress issues with titles>

### Open issues (created this session)
<any new issues that need future work>

### Recent commits
<last 10 commits>

### Uncommitted changes
<git status>

### Next steps
<what should be picked up next — be specific>
<reference file paths, issue IDs, function names>

### Key context
<anything that would be lost in compaction — design decisions, failed approaches, gotchas>
```

If the user provided an argument (message), include it as the primary "Next steps" content.

### Step 4: Report

Tell the user:

- Which issue was updated (ID + title)
- The exact command to recover it
- That post-compact will automatically see the RESUME directive

## Multi-session awareness

Multiple sessions share the same repo. The tracking issue is identified by a "claimed by current session" marker. The pre-compact hook searches for issues claimed by the current session — if the issue isn't claimed, the hook can't find it and context is lost.

## Auto-trigger

This skill runs automatically via the pre-compact hook when the user types `/compact`.
It can also be invoked manually with `/checkpoint` at any time.

## Pairs with

- **`/merge`** — orthogonal axis. `/checkpoint` preserves narrative for _resume_; `/merge` integrates _work_ back to main. They compose: `/checkpoint` before `/compact`, `/merge` before stopping the workday.
- **`/verify`** — different question. `/verify` audits whether the work is finished; `/checkpoint` saves the context whether or not it's finished.
- **`/discuss`** — `/discuss` checkpoints to the tracking issue automatically when entering discussion mode; uses the same machinery.
- **`/recall`** — recovers checkpoint content in a future session by ID.
