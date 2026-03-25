# batch-refactor

Batch rename, refactor, and migrate across files for Claude Code. TypeScript symbols, file renames, text/markdown updates, terminology migrations, and LLM-powered API migrations.

## Install

```bash
claude plugin install batch-refactor@bearly
```

## Features

| Feature                       | What                                                                    |
| ----------------------------- | ----------------------------------------------------------------------- |
| **TypeScript/JS refactoring** | Rename functions, variables, types — catches destructuring, re-exports  |
| **File renames**              | Batch rename files with automatic import path updates                   |
| **Multi-language patterns**   | Go, Rust, Python, Ruby via ast-grep structural patterns                 |
| **Text/markdown replace**     | Fast search/replace across any files via ripgrep                        |
| **Terminology migration**     | `widget`→`gadget` with case preservation (Widget→Gadget, WIDGET→GADGET) |
| **API migrations**            | LLM-powered pattern transformation for complex API changes              |
| **Checksum verification**     | Never corrupts files — drifted files are skipped                        |

## Usage

Claude uses the skill automatically when you ask:

```
"rename createWidget to createGadget across the codebase"
"change all widget mentions to gadget in packages/"
"migrate from oldAPI to newAPI everywhere"
```

Or invoke directly:

```bash
# Full help
bun tools/refactor.ts --help

# Batch rename TypeScript symbols
bun tools/refactor.ts rename.batch --pattern foo --replace bar

# Full terminology migration (files + symbols + text)
bun tools/refactor.ts migrate --from widget --to gadget

# Structural pattern replace
bun tools/refactor.ts pattern.replace --pattern "oldFn($$$)" --replace "newFn($$$)"
```

## Why not sed/awk/manual edits?

- **sed/awk** lack checksums, miss edge cases, can corrupt files
- **Manual Edit loops** over 47 files = 47 separate calls
- **batch-refactor** does it in one command with conflict detection and rollback safety

## License

MIT
