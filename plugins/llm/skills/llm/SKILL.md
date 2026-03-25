---
name: llm
description: "Multi-LLM research — deep research, second opinions, and multi-model debate. Use when user says /llm."
allowed-tools: Bash, Read
---

# LLM Skill

Multi-LLM research with deep research, second opinions, and multi-model debate.

## When to Use

- Getting a second opinion from other AI models
- Deep research requiring web search capabilities
- Building consensus across multiple models
- Research tasks needing citations and sources

## Commands

```bash
# Standard question (~$0.02)
bun tools/llm.ts "What is the capital of France?"

# Deep research with web search (~$2-5)
bun tools/llm.ts --deep -y "Best practices for TUI testing in 2026"

# Second opinion from a different provider (~$0.02)
bun tools/llm.ts opinion "Is my caching approach reasonable?"

# Multi-model debate with synthesis (~$1-3)
bun tools/llm.ts debate -y "Monorepo vs polyrepo for our use case?"

# Quick/cheap model (~$0.01)
bun tools/llm.ts quick "What port does postgres use?"
```

## Context Flags

```bash
# Explicit context
bun tools/llm.ts --deep -y --context "relevant code or info" "topic"

# Context from file
bun tools/llm.ts --deep -y --context-file ./src/module.ts "Review this code"

# Include session history
bun tools/llm.ts --deep -y --with-history "topic"
```

## Output

Response is ALWAYS written to a file. JSON metadata goes to stdout (single line):

```json
{
  "query": "What is the capital of France?",
  "file": "/tmp/llm-abc12345-1738800000000-x1y2.txt",
  "chars": 5432,
  "model": "GPT-5.2",
  "tokens": 1234,
  "cost": "$0.02",
  "durationMs": 3200
}
```

File path also printed on stderr: `Output written to: <path>`.
Streaming tokens go to stderr ONLY if it's a TTY (interactive terminal).
In background tasks, stderr is quiet -- just the file path line. No truncation risk.

Read the output file with `Read` tool. Stale files (>7 days) are auto-cleaned on next run.

## Agent Usage: Background & Async Patterns

### Quick queries (~$0.02) -- run foreground

Fast enough to run synchronously. Stdout contains JSON with file path:

```bash
bun tools/llm.ts "question"
# stdout = JSON with "file" key -- Read the file
```

### Deep research (~$2-5) -- run in background, wait with TaskOutput

Deep research takes 2-15 minutes. **Never poll output files manually** (sleep + read loops waste turns). Use the Task tool with `run_in_background=true`, then `TaskOutput` with `block=true`:

```
# Step 1: Launch background task
Task(subagent_type="Bash", run_in_background=true,
     prompt='bun tools/llm.ts --deep -y "topic"')
-> Returns task_id

# Step 2: Do other work while it runs...

# Step 3: Block-wait for completion (up to 10 min)
TaskOutput(task_id=<id>, block=true, timeout=600000)

# Step 4: Find the output file
# Look for "Output written to: /tmp/llm-*.txt" in the last lines.
# If truncated (deep research streams thousands of tokens to stderr):
#   ls -lt /tmp/llm-*.txt | head -1
# Read the OUTPUT FILE -- NOT the task output (which is just streaming tokens).
```

**CRITICAL**: Background task output captures stderr (streaming tokens) + stdout (JSON).
For deep research this can exceed 30KB, causing Claude Code to truncate it.
The actual response is ALWAYS in the output file. Read the file, not the task output.

**Anti-pattern** -- do NOT do this:

```
# BAD: Manual polling wastes 5+ turns on sleep/read cycles
Bash("sleep 30 && wc -l /tmp/output")
Read("/tmp/output")
Bash("sleep 30 && wc -l /tmp/output")  # still not done...
```

### Debate (~$1-3) -- run foreground or background

Similar to deep research timing-wise. Use the same `TaskOutput` pattern for background execution.

## Recovery

```bash
bun tools/llm.ts recover              # List incomplete responses
bun tools/llm.ts recover <id>         # Retrieve by ID from OpenAI
bun tools/llm.ts partials --clean     # Clean up old partial files
```

## Environment Variables

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_GENERATIVE_AI_API_KEY="..."
export XAI_API_KEY="..."
export PERPLEXITY_API_KEY="pplx-..."
```

## Trigger Phrases

- "ask another model"
- "get a second opinion"
- "research this topic"
- "what do other models think"
- "deep research"
- "multi-model query"
