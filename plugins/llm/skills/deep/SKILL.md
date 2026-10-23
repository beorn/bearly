---
description: "Provider-dependent deep web research with citations. Use when external sources or broad research matter; use /pro for multi-model judging without web research."
argument-hint: <topic>
---

# /deep — web research with citations

Use `/deep` when a question needs web research and cited evidence. The selected provider determines how the request runs: OpenAI and Gemini dedicated research models use their research APIs; Perplexity Sonar research models use the standard model request, which can stream. This is web research, while `/pro` compares model answers and uses a judge.

## Run

```bash
bearly-llm --deep --dry-run --no-recover "<topic>"
bearly-llm --deep --no-recover --context-file <path> "<topic>"
bearly-llm --deep --no-recover --model <model-id> "<topic>"
```

The first command previews the selected model and consent details without dispatching research. `--no-recover` prevents the preview from checking or recovering old partial requests. Without `--model`, the command uses the CLI's available-model selection. Use `--model <model-id>` to override that selection; use an ID supported by the CLI.

Use `--context-file` for relevant source, types, callers, tests, or observed errors. Include enough surrounding material to support the question, and keep the file focused. `--max-output-tokens N` can lower the output reservation; the default applies when omitted. Check `bearly-llm --help` for current flag syntax.

## Completion and recovery

Some provider paths continue server-side. When the CLI identifies a recoverable background request, preserve its response ID and use `bearly-llm recover <id>` or `bearly-llm await <id>`. A provider response ID alone does not establish that these commands can recover the request.

Other paths finish synchronously or stream the result. Perplexity Sonar deep research follows this shape and does not provide the OpenAI background response ID described above. If a run stops or reports an error, inspect its output file, status, and terminal error before deciding what to do. Do not blindly start a second paid request; recovery is possible only when the output provides a recoverable response ID.

## Report findings

Read the complete output file. Give a concise answer that distinguishes sourced facts from inference, preserves relevant citations and trade-offs, and points to the output file. Include code excerpts when they are needed to explain a technical finding; choose report length to fit the question and evidence.
