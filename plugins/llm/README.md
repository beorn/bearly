# llm

Multi-LLM research for Claude Code. Get second opinions, deep research with web search, and multi-model consensus from GPT, Gemini, Grok, and Perplexity.

## Install

```bash
claude plugin install llm@beorn-tools
```

## Commands

```bash
# Quick question (~$0.02)
bunx @beorn/tools llm "question"

# Deep research with web search (~$2-5)
bunx @beorn/tools llm --deep -y "topic"

# Second opinion from another model (~$0.02)
bunx @beorn/tools llm opinion "Is this approach reasonable?"

# Multi-model debate with synthesis (~$1-3)
bunx @beorn/tools llm debate -y "Monorepo vs polyrepo?"
```

## Context

```bash
# From string
bunx @beorn/tools llm --context "relevant code" "question"

# From file
bunx @beorn/tools llm --context-file ./src/module.ts "Review this"

# Include session history
bunx @beorn/tools llm --with-history "topic"
```

## Output

Response always written to a file. JSON metadata on stdout:

```json
{
  "file": "/tmp/llm-abc12345.txt",
  "model": "GPT-5.4",
  "cost": "$0.02",
  "durationMs": 3200
}
```

Read the output file — streaming tokens go to stderr only in interactive terminals.

## API Keys

Set the API keys for providers you want to use:

```bash
export OPENAI_API_KEY="sk-..."
export GOOGLE_GENERATIVE_AI_API_KEY="..."
export XAI_API_KEY="..."
export PERPLEXITY_API_KEY="pplx-..."
```

## License

MIT
