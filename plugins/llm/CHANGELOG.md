# Changelog

## 0.1.0 (2026-04-17)

Initial extraction into a first-class package. The LLM dispatcher was
previously at `vendor/bearly/tools/lib/llm/` with a CLI at
`vendor/bearly/tools/llm.ts`. Promoted to `@bearly/llm` at
`plugins/llm/` so `@bearly/recall` and `@bearly/lore` can depend on it
cleanly and so the library is reusable standalone.

### Contents

- `src/lib/` — multi-provider dispatch: types (Model registry), providers
  (availability detection), research (queryModel), consensus (multi-model
  agreement), dispatch (cheap-model race), format, persistence, pricing,
  mock (vi.mock harness for tests), ollama, openai-deep, gemini-deep, index
- `src/cli.ts` — the `bun llm` CLI (multi-LLM research + deep research)
- `src/index.ts` — barrel export

### Verification

- 0 new TypeScript errors
- Consumers under `plugins/{lore,recall}/src/*` use `../../../llm/src/lib/`
  (relative workspace path)
- `bun vendor/bearly/tools/llm.ts` shim still works via `main` export

### Notes

- `private: true` at this version — published when the tribe family
  stabilizes and the llm dispatcher is ready for public use.
- Exports `buildMockQueryModel`, `alwaysAvailable`, and related test
  helpers used by `@bearly/recall` and `@bearly/lore` test suites.
