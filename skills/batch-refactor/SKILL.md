---
name: batch-refactor
description: Batch operations across files with confidence-based auto-apply. Use for renaming, search-replace, refactoring code, updating text/markdown, migrating terminology, and API migrations. Run `bun tools/refactor.ts --help` for detailed command reference.
allowed-tools: Bash, Read, Edit, Grep, Glob, AskUserQuestion
---

# Batch Operations Skill

**Quick start:** Run `bun vendor/bearly/tools/refactor.ts --help` for command reference and examples.

Use this skill when the user wants to make changes across multiple files:

- **Code refactoring**: rename functions, variables, types
- **Text/markdown updates**: change terminology, update docs
- **File operations**: batch rename files with import path updates
- **Terminology migrations**: widget→gadget, vault→repo
- **API migrations**: old API patterns → new API patterns (LLM-powered)

**Trigger phrases**:

- "rename X to Y everywhere"
- "change all X to Y"
- "refactor X across the codebase"
- "batch replace"
- "update terminology"
- "migrate from X to Y"
- "rename function/variable everywhere"
- "change wording in all files"
- "migrate API" / "update API usage"
- "change how we call X"
- "update all uses of X to new pattern"
- "convert old pattern to new pattern"

---

## Why Use Batch Refactor (Not Manual Edit)

**⛔ NEVER use these for batch changes:** `sed`, `awk`, `perl`, `python -c`, or manual Edit loops.
These tools lack checksums, miss edge cases, and can corrupt files. See "Tips & Tricks → STOP: Manual Edit Tools" below.

**ALWAYS use this tool instead of manual editing when:**

| Situation                                  | Manual Edits           | Batch Refactor       |
| ------------------------------------------ | ---------------------- | -------------------- |
| Rename a function used in 47 files         | 47 separate Edit calls | 1 command            |
| Rename parameter in destructuring patterns | Miss edge cases        | Catches all patterns |
| Update terminology across codebase         | Hours of work          | Minutes              |
| Rename file + update all imports           | Break builds           | Atomic, safe         |

### Example: Why Manual Editing Fails

**Task**: Rename `createWidget` to `createGadget`

**Manual approach (WRONG)**:

```bash
# You'd miss these patterns:
const { createWidget } = api          # destructuring
const init = createWidget             # assignment
type Factory = typeof createWidget    # type reference
async ({ createWidget }: Deps) => {}  # parameter destructuring
```

**Batch refactor approach (CORRECT)**:

```bash
bun tools/refactor.ts rename.batch --pattern '/^createWidget$/' --replace createGadget --output edits.json
bun tools/refactor.ts editset.apply edits.json
# Finds ALL 127 references including destructuring, types, re-exports
```

### Regex Patterns — Case Handling Is Explicit

**CRITICAL: all `--pattern` and `--from` arguments must be regex literals in the form `/pattern/flags`.**

This is a forcing function: plain strings hide a decision about case-sensitivity, and the wrong
default silently corrupts camelCase identifiers. The regex form makes you choose:

| Use case                        | Flag    | Behavior                                                                               |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| **Code identifier rename**      | no `/i` | exact match, **literal** replacement — preserves the exact casing you typed            |
| **Prose terminology migration** | `/i`    | case-insensitive match, **case-preserving** replacement (widget→Gadget, WIDGET→GADGET) |

```bash
# Code rename — case-sensitive, literal. Use for identifiers like screenRect, useBoxRect.
bun tools/refactor.ts pattern.replace --pattern '/screenRect/' --replace 'scrollRect'
bun tools/refactor.ts rename.batch --pattern '/^useContentRect$/' --replace 'useBoxRect'
bun tools/refactor.ts migrate --from '/contentRect/' --to 'boxRect' --dry-run

# Prose migration — case-insensitive, case-preserving. Use for English words.
bun tools/refactor.ts pattern.replace --pattern '/widget/i' --replace 'gadget'
# widget → gadget, Widget → Gadget, WIDGET → GADGET

# Word boundaries are explicit (\b), never implicit.
bun tools/refactor.ts pattern.replace --pattern '/\buseLayout\b/' --replace 'useBoxRect'
```

**Why regex-first:** every `--pattern` invocation becomes a moment where you look at the flags
and consciously pick. Without this, you write `--pattern screenRect` and the tool silently
downcases your replacement to `scrollrect`. The extra characters (`/` and optional `/i`) are a
small cost for eliminating a whole class of bugs.

The `g` flag is implicit (always multi-match within a file).

### Quick Reference: When to Use Each Command

| You want to...                       | Command                             | Example                                                 |
| ------------------------------------ | ----------------------------------- | ------------------------------------------------------- |
| Rename TypeScript function/variable  | `rename.batch`                      | `--pattern '/^createWidget$/' --replace createGadget`   |
| Rename TypeScript type/interface     | `rename.batch`                      | `--pattern '/^WidgetConfig$/' --replace GadgetConfig`   |
| Rename files                         | `file.rename`                       | `--pattern widget --replace repo --glob "**/*.ts"`      |
| Update text in markdown              | `pattern.replace --backend ripgrep` | `--pattern '/widget/i' --replace repo --glob "**/*.md"` |
| Full terminology migration           | `migrate`                           | `--from '/widget/i' --to repo`                          |
| **API migration (complex patterns)** | `pattern.migrate`                   | `--patterns "oldApi()" --prompt "migrate to newApi"`    |

---

## Comprehensive Migration Workflow

For large terminology migrations (e.g., "rename widget to repo"), follow this phased approach:

### Phase 1: Conflict Analysis (BEFORE any changes)

**CRITICAL: Analyze ALL conflicts before making ANY changes.**

```bash
# Run from the batch plugin directory

# 1. Check file name conflicts
bun tools/refactor.ts file.rename --pattern widget --replace repo --glob "**/*.ts" --check-conflicts

# 2. Check symbol conflicts
bun tools/refactor.ts rename.batch --pattern '/widget/i' --replace repo --check-conflicts

# 3. Check for existing targets manually
ls **/repo*.ts 2>/dev/null || echo "No existing repo files"
```

**For each conflict**, document resolution:
| Conflict | Resolution |
|----------|------------|
| `widget.ts` → `repo.ts` (exists) | Merge and delete |
| `createWidget` → `createRepo` (exists) | Update references, keep new |

**Never use --skip without explicit user approval.**

### Phase 2: File Renames

Rename files FIRST (before symbol renames) because:

- Import paths need to be valid for ts-morph to work
- File renames update import paths automatically

```bash
# Create file rename proposal
bun tools/refactor.ts file.rename --pattern widget --replace repo \
  --glob "**/*.{ts,tsx}" \
  --output file-editset.json

# Preview
bun tools/refactor.ts file.apply file-editset.json --dry-run

# Apply
bun tools/refactor.ts file.apply file-editset.json
```

### Phase 3: Symbol Renames (TypeScript)

After files are renamed, rename symbols:

```bash
# Create symbol rename proposal
bun tools/refactor.ts rename.batch --pattern '/widget/i' --replace repo \
  --output symbol-editset.json

# Preview
bun tools/refactor.ts editset.apply symbol-editset.json --dry-run

# Apply
bun tools/refactor.ts editset.apply symbol-editset.json
```

### Phase 4: Text/Comment Renames

Rename remaining mentions in comments, strings, markdown:

```bash
# TypeScript comments and strings
bun tools/refactor.ts pattern.replace --pattern '/widget/i' --replace repo \
  --glob "**/*.{ts,tsx}" \
  --backend ripgrep \
  --output text-editset.json

# Markdown documentation
bun tools/refactor.ts pattern.replace --pattern '/widget/i' --replace repo \
  --glob "**/*.md" \
  --backend ripgrep \
  --output docs-editset.json

# Preview and apply each
bun tools/refactor.ts editset.apply text-editset.json --dry-run
bun tools/refactor.ts editset.apply text-editset.json
```

### Phase 5: Vendor Submodules

For changes in git submodules:

```bash
# For each vendor submodule with matches
cd vendor/<submodule>

# Run the same workflow (conflicts, files, symbols, text)
bun ../tools/plugins/batch/tools/refactor.ts rename.batch \
  --pattern '/widget/i' --replace repo --check-conflicts

# After applying
git add -A
git commit -m "refactor: rename widget → repo"
git push

# Return to main repo
cd ../..
git add vendor/<submodule>
git commit -m "chore(vendor): update <submodule> with repo terminology"
```

### Phase 6: Verification

```bash
# Check for remaining mentions
grep -ri widget . --include="*.ts" --include="*.tsx" | grep -v node_modules | wc -l

# Type check
bun tsc --noEmit

# Lint and fix
bun fix

# Run tests
bun run test:all
```

---

## Tool Selection

| What you're changing                 | File Type            | Backend       | Command           |
| ------------------------------------ | -------------------- | ------------- | ----------------- |
| **File names**                       | any                  | file-ops      | `file.rename`     |
| TypeScript/JS identifiers            | .ts, .tsx, .js, .jsx | ts-morph      | `rename.batch`    |
| **API patterns (complex)**           | .ts, .tsx            | LLM           | `pattern.migrate` |
| Go, Rust, Python structural patterns | .go, .rs, .py        | ast-grep      | `pattern.replace` |
| JSON/YAML values                     | .json, .yaml         | ast-grep      | `pattern.replace` |
| Text/markdown/comments               | .md, .txt, any       | ripgrep       | `pattern.replace` |
| Wiki links only                      | .md                  | wikilink      | `wikilink.rename` |
| package.json paths                   | package.json         | package-json  | `package.rename`  |
| tsconfig.json paths                  | tsconfig\*.json      | tsconfig-json | `tsconfig.rename` |

**`file.rename` auto-detects file type** and updates references:

- `.ts/.tsx/.js/.jsx` → updates import paths
- `.md/.markdown/.mdx` → updates `[[wikilinks]]` (Obsidian, Foam, etc.)
- `package.json` → updates exports, main, types, bin paths
- `tsconfig.json` → updates paths mappings, includes, references

**CRITICAL for TypeScript**: Always use ts-morph (via `rename.batch`) for identifiers. It handles destructuring, arrow function params, and nested scopes that text-based tools miss.

**Dependencies:**

- ts-morph: bundled (no external CLI)
- ast-grep: requires `sg` CLI (`brew install ast-grep`)
- ripgrep: requires `rg` CLI (usually pre-installed)

---

## CLI Reference

### File Operations

| Command                                                                           | Purpose                            |
| --------------------------------------------------------------------------------- | ---------------------------------- |
| `file.find --pattern <p> --replace <r> [--glob]`                                  | Find files to rename               |
| `file.rename --pattern <p> --replace <r> [--glob] [--output] [--check-conflicts]` | Create file rename proposal        |
| `file.verify <file>`                                                              | Verify file editset can be applied |
| `file.apply <file> [--dry-run]`                                                   | Apply file renames                 |

### TypeScript/JavaScript (ts-morph)

| Command                                                        | Purpose                         |
| -------------------------------------------------------------- | ------------------------------- |
| `symbol.at <file> <line> [col]`                                | Find symbol at location         |
| `refs.list <symbolKey>`                                        | List all references to a symbol |
| `symbols.find --pattern <regex>`                               | Find symbols matching pattern   |
| `rename.propose <key> <new>`                                   | Single symbol rename proposal   |
| `rename.batch --pattern <p> --replace <r> [--check-conflicts]` | Batch rename proposal           |

### Multi-Language (ast-grep/ripgrep)

| Command                                                            | Purpose                   |
| ------------------------------------------------------------------ | ------------------------- |
| `pattern.find --pattern <p> [--glob] [--backend]`                  | Find structural patterns  |
| `pattern.replace --pattern <p> --replace <r> [--glob] [--backend]` | Pattern replace proposal  |
| `pattern.migrate --patterns <p1,p2> --prompt <text> [--glob]`      | LLM-powered API migration |
| `backends.list`                                                    | List available backends   |

### Editset Operations

| Command                                     | Purpose                          |
| ------------------------------------------- | -------------------------------- |
| `editset.select <file> --include/--exclude` | Filter editset refs              |
| `editset.verify <file>`                     | Check editset can be applied     |
| `editset.apply <file> [--dry-run]`          | Apply with checksum verification |

### Package.json Operations

| Command                                    | Purpose                           |
| ------------------------------------------ | --------------------------------- |
| `package.find --target <file>`             | Find package.json refs to a file  |
| `package.rename --old <path> --new <path>` | Update paths when file renamed    |
| `package.broken`                           | Find broken paths in package.json |

### TSConfig.json Operations

| Command                                     | Purpose                           |
| ------------------------------------------- | --------------------------------- |
| `tsconfig.find --target <file>`             | Find tsconfig.json refs to a file |
| `tsconfig.rename --old <path> --new <path>` | Update paths when file renamed    |

---

## Concrete Examples by Operation Type

### Example 1: Batch File Rename

**Scenario**: Rename all files containing "user-service" to "account-service"

```bash
# 1. Find files that would be renamed
bun tools/refactor.ts file.find --pattern "user-service" --replace "account-service" --glob "**/*.ts"

# 2. Check for conflicts (target files already exist?)
bun tools/refactor.ts file.rename --pattern "user-service" --replace "account-service" \
  --glob "**/*.ts" --check-conflicts

# 3. Create editset
bun tools/refactor.ts file.rename --pattern "user-service" --replace "account-service" \
  --glob "**/*.ts" --output file-renames.json

# 4. Preview (dry run)
bun tools/refactor.ts file.apply file-renames.json --dry-run

# 5. Apply
bun tools/refactor.ts file.apply file-renames.json
```

**Result**:

- `src/user-service.ts` → `src/account-service.ts`
- `src/testing/mock-user-service.ts` → `src/testing/mock-account-service.ts`
- `UserServiceConfig.ts` → `AccountServiceConfig.ts` (case preserved)

---

### Example 2: Import Path Updates (after file renames)

**Scenario**: Update all imports that reference renamed files

```bash
# After renaming user-service.ts → account-service.ts, update imports:
bun tools/refactor.ts pattern.replace \
  --pattern "user-service" \
  --replace "account-service" \
  --glob "**/*.ts" \
  --backend ripgrep \
  --output import-updates.json

bun tools/refactor.ts editset.apply import-updates.json --dry-run
bun tools/refactor.ts editset.apply import-updates.json
```

**Before**:

```typescript
import { createUser } from "./user-service"
import { UserService } from "../services/user-service"
```

**After**:

```typescript
import { createUser } from "./account-service"
import { UserService } from "../services/account-service"
```

---

### Example 3: TypeScript Symbol Rename (ts-morph)

**Scenario**: Rename function `createWidget` to `createGadget` across codebase

```bash
# 1. Check for conflicts (does createGadget already exist?)
bun tools/refactor.ts rename.batch --pattern "createWidget" --replace "createGadget" --check-conflicts

# 2. Create editset
bun tools/refactor.ts rename.batch --pattern "createWidget" --replace "createGadget" \
  --output symbol-renames.json

# 3. Preview
bun tools/refactor.ts editset.apply symbol-renames.json --dry-run

# 4. Apply
bun tools/refactor.ts editset.apply symbol-renames.json
```

**Handles correctly**:

```typescript
// Function declaration
export function createWidget(config: Config) { }  → createGadget

// Arrow function
const createWidget = (opts) => { }  → createGadget

// Destructuring
const { createWidget } = api  → createGadget

// Parameter
function init({ createWidget }: Deps) { }  → createGadget

// Type reference
type Factory = typeof createWidget  → createGadget
```

---

### Example 4: Type/Interface Rename

**Scenario**: Rename `ApiClient` to `HttpClient` across codebase

```bash
# Check conflicts
bun tools/refactor.ts rename.batch --pattern "ApiClient" --replace "HttpClient" --check-conflicts

# Create and apply
bun tools/refactor.ts rename.batch --pattern "ApiClient" --replace "HttpClient" \
  --output type-renames.json
bun tools/refactor.ts editset.apply type-renames.json
```

**Handles correctly**:

```typescript
// Interface definition
export interface ApiClient { }  → HttpClient

// Type alias
type Client = ApiClient  → HttpClient

// Variable type annotation
const client: ApiClient = ...  → HttpClient

// Generic constraint
function fetch<T extends ApiClient>()  → HttpClient

// Import
import type { ApiClient } from "./api"  → HttpClient
```

---

### Example 5: Text/Comment/String Replace (ripgrep)

**Scenario**: Update documentation and comments from "widget" to "gadget"

```bash
# Markdown docs
bun tools/refactor.ts pattern.replace \
  --pattern "widget" \
  --replace "gadget" \
  --glob "**/*.md" \
  --backend ripgrep \
  --output docs-updates.json

# TypeScript comments and strings
bun tools/refactor.ts pattern.replace \
  --pattern "widget" \
  --replace "gadget" \
  --glob "**/*.ts" \
  --backend ripgrep \
  --output comment-updates.json

# Preview and apply
bun tools/refactor.ts editset.apply docs-updates.json --dry-run
bun tools/refactor.ts editset.apply docs-updates.json
```

**Updates**:

```typescript
// This creates a new widget  → gadget
const msg = "Widget not found"  → "Gadget not found"
/** @description Widget factory */  → Gadget factory
```

```markdown
# Widget Guide → Gadget Guide

Create a widget with... → Create a gadget with...
```

---

### Example 6: Structural Pattern Replace (ast-grep)

**Scenario**: Migrate Go logging from `fmt.Println` to `log.Info`

```bash
bun tools/refactor.ts pattern.replace \
  --pattern 'fmt.Println($MSG)' \
  --replace 'log.Info($MSG)' \
  --glob "**/*.go" \
  --backend ast-grep \
  --output go-logging.json

bun tools/refactor.ts editset.apply go-logging.json
```

**Before**:

```go
fmt.Println("Starting server")
fmt.Println(err.Error())
```

**After**:

```go
log.Info("Starting server")
log.Info(err.Error())
```

---

### Example 7: Complete Terminology Migration

**Scenario**: Migrate entire codebase from "user" terminology to "account"

```bash
# Phase 1: Conflict Analysis
bun tools/refactor.ts file.rename --pattern "user" --replace "account" --check-conflicts
bun tools/refactor.ts rename.batch --pattern "user" --replace "account" --check-conflicts

# Phase 2: File Renames (FIRST)
bun tools/refactor.ts file.rename --pattern "user" --replace "account" \
  --glob "**/*.ts" --output phase2-files.json
bun tools/refactor.ts file.apply phase2-files.json

# Phase 3: Symbol Renames
bun tools/refactor.ts rename.batch --pattern "user" --replace "account" \
  --output phase3-symbols.json
bun tools/refactor.ts editset.apply phase3-symbols.json

# Phase 4: Text/Comments
bun tools/refactor.ts pattern.replace --pattern "user" --replace "account" \
  --glob "**/*.ts" --backend ripgrep --output phase4-text.json
bun tools/refactor.ts editset.apply phase4-text.json

# Phase 5: Documentation
bun tools/refactor.ts pattern.replace --pattern "user" --replace "account" \
  --glob "**/*.md" --backend ripgrep --output phase5-docs.json
bun tools/refactor.ts editset.apply phase5-docs.json

# Phase 6: Verify
grep -ri user . --include="*.ts" | wc -l  # Should be 0
bun tsc --noEmit
bun fix
bun run test:all
```

---

### Example 8: Selective Rename with Filtering

**Scenario**: Rename only specific occurrences, not all

```bash
# Create full editset
bun tools/refactor.ts rename.batch --pattern "config" --replace "options" \
  --output full-editset.json

# Filter to only certain files
bun tools/refactor.ts editset.select full-editset.json \
  --include "src/core/**" \
  --exclude "src/core/legacy/**" \
  --output filtered-editset.json

# Apply filtered set
bun tools/refactor.ts editset.apply filtered-editset.json
```

---

## Case Preservation

The tool preserves case during renames:

| Original          | Pattern  | Replacement | Result            |
| ----------------- | -------- | ----------- | ----------------- |
| `widget`          | `widget` | `repo`      | `repo`            |
| `Repo`            | `widget` | `repo`      | `Repo`            |
| `REPO`            | `widget` | `repo`      | `REPO`            |
| `widgetPath`      | `widget` | `repo`      | `repoPath`        |
| `WidgetConfig.ts` | `widget` | `repo`      | `GadgetConfig.ts` |

---

## Conflict Resolution

**Never skip conflicts without understanding them.**

### File Conflicts

| Conflict Type             | Resolution Strategy          |
| ------------------------- | ---------------------------- |
| Target exists (duplicate) | Merge content, delete source |
| Target exists (different) | Rename to avoid collision    |
| Same path (no-op)         | Skip (no change needed)      |

### Symbol Conflicts

| Conflict Type              | Resolution Strategy                                              |
| -------------------------- | ---------------------------------------------------------------- |
| Target name exists         | Check if same symbol (safe to merge) or different (needs rename) |
| Multiple symbols same name | May be scoped (function-local vs module) - often safe            |

**Process:**

1. Run `--check-conflicts` first
2. Document each conflict and its resolution
3. Get user approval on resolution strategy
4. Execute with explicit handling (no blind --skip)

---

## Safety Checks

**Before making batch changes:**

```bash
git rev-parse --is-inside-work-tree 2>/dev/null
git status --porcelain
```

| Situation                     | Action                      |
| ----------------------------- | --------------------------- |
| Git repo, clean working tree  | ✅ Proceed                  |
| Git repo, uncommitted changes | ⚠️ Ask user to commit first |
| Not a git repo                | ⚠️ Warn: no undo available  |

---

## Context Gathering

Before making changes, gather project context:

1. **Read CLAUDE.md** - look for:
   - Mentioned migrations or refactoring plans
   - ADR references
   - Terminology notes

2. **Check for migration scripts** (optional):
   - `scripts/check-migration.ts` or similar
   - May have ALLOWED_PATTERNS for exclusions

3. **Understand scope**:
   ```bash
   grep -ri <pattern> . --include="*.ts" | wc -l  # Total mentions
   find . -name "*<pattern>*" -not -path "./node_modules/*"  # File names
   ```

---

## Confidence Philosophy

**Be aggressive. Tests catch mistakes.**

| Context                                  | Confidence             |
| ---------------------------------------- | ---------------------- |
| Our code (`const widgetRoot`)            | HIGH                   |
| Our compound identifier (`widgetHelper`) | HIGH                   |
| Our error message (`"widget not found"`) | HIGH                   |
| External reference (`"Obsidian widget"`) | LOW - may need to keep |
| URL/path (`widget.example.com`)          | LOW                    |

**Default to HIGH** unless clearly external.

---

## Why ast-grep Fails for TypeScript Identifiers

ast-grep misses TypeScript-specific patterns:

```typescript
// ast-grep renames this ✓
const widgetDir = "/path"

// But MISSES these ✗
interface TestEnv { widgetDir: string }  // property definition
({ widgetDir }) => { ... }               // destructuring
```

**Rule**: If it shows up in "Find All References" in your IDE, use ts-morph.

---

## Example: Complete Migration

**User request:** "rename widget to repo everywhere"

**Claude's plan:**

1. **Analyze scope**

   ```bash
   grep -ri widget . --include="*.ts" | wc -l
   find . -name "*widget*" -not -path "./node_modules/*"
   ```

2. **Check ALL conflicts**

   ```bash
   # File conflicts
   bun tools/refactor.ts file.rename --pattern widget --replace repo --check-conflicts

   # Symbol conflicts
   bun tools/refactor.ts rename.batch --pattern '/widget/i' --replace repo --check-conflicts
   ```

3. **Document conflict resolutions** (ask user if unclear)

4. **Execute in phases:**
   - Phase 2: File renames
   - Phase 3: Symbol renames
   - Phase 4: Text/comment renames
   - Phase 5: Vendor submodules

5. **Verify:**
   ```bash
   grep -ri widget . --include="*.ts" | wc -l  # Should be 0 (or only allowed)
   bun tsc --noEmit
   bun fix
   bun run test:all
   ```

---

## Important Rules

1. **Check conflicts FIRST** - never blind rename
2. **File renames BEFORE symbol renames** - import paths must be valid
3. **Use editset workflow** for TypeScript identifiers
4. **Always run tsc** after batch changes
5. **Preview with --dry-run** before applying
6. **Trust checksums** - editset won't apply to modified files
7. **Vendor submodules** - commit and push separately, then update reference
8. **Be aggressive** - apply all matches, let tests catch mistakes

---

## LLM Patch Workflow

Editsets now include enriched context fields that allow an LLM to review and selectively modify replacements before applying. This enables intelligent, context-aware refactoring decisions.

### Enriched Reference Fields

Each reference in an editset includes:

| Field     | Type                                                          | Description                                                    |
| --------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| `kind`    | `"call"` \| `"decl"` \| `"type"` \| `"string"` \| `"comment"` | What kind of reference this is                                 |
| `scope`   | `string \| null`                                              | Enclosing function/class name, or null for module-level        |
| `ctx`     | `string[]`                                                    | Array of context lines with `►` marker on the matching line    |
| `replace` | `string \| null`                                              | `null` to skip this reference, `string` for custom replacement |

### Workflow

```bash
# Run from the batch plugin directory

# 1. Generate editset with enriched context
bun tools/refactor.ts rename.batch --pattern '/widget/i' --replace repo -o editset.json

# 2. LLM reviews the editset and patches specific references
#    - Set replace to null to skip a reference
#    - Set replace to a custom string for non-standard replacement
bun tools/refactor.ts editset.patch editset.json <<'EOF'
{ "b2c3": "Repository", "c3d4": null }
EOF

# 3. Apply the patched editset
bun tools/refactor.ts editset.apply editset.json
```

### Example: Selective Replacement

Given an editset with these references:

```json
{
  "refs": [
    {
      "id": "a1b2",
      "kind": "decl",
      "scope": "createWidget",
      "replace": "repo"
    },
    { "id": "b2c3", "kind": "type", "scope": null, "replace": "repo" },
    { "id": "c3d4", "kind": "comment", "scope": null, "replace": "repo" }
  ]
}
```

An LLM might decide:

- Keep `a1b2` as-is (standard replacement)
- Change `b2c3` to `"Repository"` (capitalize for type name)
- Set `c3d4` to `null` (skip comment, it refers to external Obsidian widget)

```bash
bun tools/refactor.ts editset.patch editset.json <<'EOF'
{ "b2c3": "Repository", "c3d4": null }
EOF
```

### Context Lines

The `ctx` field shows surrounding lines with the match marked:

```json
{
  "ctx": ["  // Create a new widget for the user", "► const vault = createVault(config)", "  return widget"]
}
```

This helps LLMs understand whether a reference is:

- Internal code (safe to rename)
- External reference (may need to preserve)
- Documentation (may need different wording)

---

## Migrate Command

The `migrate` command orchestrates a full terminology migration in phases:

```bash
# Run from the batch plugin directory

# Preview what would be migrated
bun tools/refactor.ts migrate --from '/widget/i' --to repo --dry-run

# Run migration (creates editsets in .editsets/ directory)
bun tools/refactor.ts migrate --from '/widget/i' --to repo

# Custom output directory
bun tools/refactor.ts migrate --from '/widget/i' --to repo --output ./my-editsets

# Custom file glob
bun tools/refactor.ts migrate --from '/widget/i' --to repo --glob "**/*.{ts,tsx,md}"
```

### What Migrate Does

| Phase             | Description                         | Output File              |
| ----------------- | ----------------------------------- | ------------------------ |
| 1. File renames   | Rename files containing pattern     | `01-file-renames.json`   |
| 2. Symbol renames | TypeScript identifiers via ts-morph | `02-symbol-renames.json` |
| 3. Text patterns  | Comments, strings via ripgrep       | `03-text-patterns.json`  |

After running, review each editset and apply:

```bash
# Review and apply each phase
bun tools/refactor.ts file.apply .editsets/01-file-renames.json --dry-run
bun tools/refactor.ts file.apply .editsets/01-file-renames.json

bun tools/refactor.ts editset.apply .editsets/02-symbol-renames.json --dry-run
bun tools/refactor.ts editset.apply .editsets/02-symbol-renames.json

bun tools/refactor.ts editset.apply .editsets/03-text-patterns.json --dry-run
bun tools/refactor.ts editset.apply .editsets/03-text-patterns.json
```

### Migrate Command Flags

| Flag                 | Description                       | Default         |
| -------------------- | --------------------------------- | --------------- |
| `--from <pattern>`   | Pattern to match (required)       | -               |
| `--to <replacement>` | Replacement string (required)     | -               |
| `--glob <glob>`      | File glob filter                  | `**/*.{ts,tsx}` |
| `--dry-run`          | Preview without creating editsets | false           |
| `--output <dir>`     | Output directory for editsets     | `.editsets`     |

---

## LLM-Powered API Migration (pattern.migrate)

For complex API migrations where simple find/replace isn't enough, use `pattern.migrate`. This command:

1. **Searches** for patterns using ripgrep
2. **Gathers context** around each match
3. **Sends to LLM** in one call to determine correct replacements
4. **Generates editset** for review and application

### When to Use pattern.migrate

Use `pattern.migrate` instead of `pattern.replace` when:

- Transformations require **understanding context** (e.g., adding `await`, changing variable names)
- Multiple **related patterns** need coordinated changes
- Replacements involve **value mapping** (e.g., ANSI codes → key names)
- The old and new patterns have **different structures** (destructuring → single variable)

### Example: Test Framework API Migration

```bash
# OLD API:
# const { lastFrame, stdin } = render(<App />)
# expect(stripAnsi(lastFrame())).toContain('Hello')
# stdin.write('\x1b[A')

# NEW API:
# const app = render(<App />)
# expect(app.text).toContain('Hello')
# await app.press('ArrowUp')

bun tools/refactor.ts pattern.migrate \
  --patterns "lastFrame(),stdin.write,= render(" \
  --glob "**/*.test.tsx" \
  --prompt "Migrate old render() API to new App API:
    - const { lastFrame, stdin } = render(...) → const app = render(...)
    - lastFrame() → app.ansi
    - stripAnsi(lastFrame()) → app.text
    - stdin.write('\\x1b[A') → await app.press('ArrowUp')
    - stdin.write('\\x1b[B') → await app.press('ArrowDown')" \
  --output /tmp/migrate.json

# Review
jq '.refs[:5]' /tmp/migrate.json

# Apply
bun tools/refactor.ts editset.apply /tmp/migrate.json
```

### Command Flags

| Flag                     | Description                                | Default             |
| ------------------------ | ------------------------------------------ | ------------------- |
| `--patterns <p1,p2,...>` | Comma-separated search patterns (required) | -                   |
| `--prompt <text>`        | Migration instructions for LLM (required)  | -                   |
| `--glob <glob>`          | File filter                                | `**/*.{ts,tsx}`     |
| `--output <file>`        | Editset output file                        | `/tmp/migrate.json` |
| `--model <model>`        | Override LLM model                         | best available      |
| `--dry-run`              | Preview prompt without calling LLM         | false               |

### Workflow

```bash
# 1. Dry run - see what would be sent to LLM
bun tools/refactor.ts pattern.migrate \
  --patterns "oldPattern" \
  --glob "**/*.ts" \
  --prompt "Migrate to new pattern" \
  --dry-run

# 2. Run migration
bun tools/refactor.ts pattern.migrate \
  --patterns "oldPattern" \
  --glob "**/*.ts" \
  --prompt "Migrate to new pattern" \
  --output /tmp/migrate.json

# 3. Review editset
jq '.refs | length' /tmp/migrate.json        # Count changes
jq '.refs[:3]' /tmp/migrate.json             # Preview first 3

# 4. Apply
bun tools/refactor.ts editset.apply /tmp/migrate.json

# 5. Verify
bun tsc --noEmit && bun run test:fast
```

### Writing Good Migration Prompts

The LLM sees each match with ~3 lines of context. Write prompts that:

1. **List all transformation rules** clearly with before → after
2. **Include edge cases** (e.g., what to do with `stripAnsi()` wrappers)
3. **Specify async handling** if needed (when to add `await`)
4. **Include value mappings** if applicable (ANSI codes to key names)

```bash
# Good prompt example:
--prompt "Migrate test API:
  - const { lastFrame, stdin } = render(...) → const app = render(...)
  - lastFrame() → app.ansi
  - stripAnsi(lastFrame()) → app.text (remove stripAnsi wrapper)
  - stdin.write('x') → await app.press('x')
  - stdin.write('\\x1b[A') → await app.press('ArrowUp')
  - stdin.write('\\x1b[B') → await app.press('ArrowDown')
  - stdin.write('\\x1b[C') → await app.press('ArrowRight')
  - stdin.write('\\x1b[D') → await app.press('ArrowLeft')
  - stdin.write('\\r') → await app.press('Enter')"
```

---

## Enriched Editset JSON Format

When an LLM reviews an editset, it sees enriched context for each reference:

```json
{
  "id": "rename-widget-to-repo-1706123456789",
  "operation": "rename",
  "from": "widget",
  "to": "repo",
  "refs": [
    {
      "refId": "a1b2c3d4",
      "file": "src/storage.ts",
      "line": 45,
      "range": [45, 12, 45, 17],
      "kind": "call",
      "scope": "initStorage",
      "ctx": ["  function initStorage() {", "► const root = createVault(config);", "  return root;"],
      "replace": "repo",
      "preview": "const root = createWidget(config);",
      "checksum": "abc123...",
      "selected": true
    },
    {
      "refId": "b2c3d4e5",
      "file": "src/errors.ts",
      "line": 12,
      "range": [12, 25, 12, 30],
      "kind": "string",
      "scope": "errorHandler",
      "ctx": ["► throw new Error(\"vault not found\");"],
      "replace": "repo",
      "preview": "throw new Error(\"widget not found\");",
      "checksum": "def456...",
      "selected": true
    }
  ],
  "edits": [
    /* ... byte-level edits */
  ],
  "createdAt": "2024-01-24T12:00:00.000Z"
}
```

### Field Reference

| Field     | Type                                                          | Description                                        |
| --------- | ------------------------------------------------------------- | -------------------------------------------------- |
| `refId`   | string                                                        | Stable identifier for this reference               |
| `kind`    | `"call"` \| `"decl"` \| `"type"` \| `"string"` \| `"comment"` | Semantic kind                                      |
| `scope`   | string \| null                                                | Enclosing function/class, or null for module-level |
| `ctx`     | string[]                                                      | Context lines with `►` marker on match line        |
| `replace` | string \| null                                                | Replacement text, or null to skip                  |
| `line`    | number                                                        | 1-indexed line number                              |
| `range`   | [number, number, number, number]                              | [startLine, startCol, endLine, endCol]             |

---

## editset.patch Command

Apply LLM-generated patches to editsets via stdin (heredoc):

```bash
# Minimal patch format: refId → replacement or null
bun tools/refactor.ts editset.patch editset.json <<'EOF'
{
  "b2c3d4e5": "repository",
  "c3d4e5f6": null
}
EOF

# Or pipe from a file
cat my-patch.json | bun tools/refactor.ts editset.patch editset.json

# Output to different file
bun tools/refactor.ts editset.patch editset.json --output patched.json <<'EOF'
{ "b2c3": null }
EOF
```

### Patch Format

The patch is a simple JSON object mapping refIds to actions:

```json
{
  "refId1": "custom replacement", // Use this replacement instead of default
  "refId2": null // Skip this reference
  // refId3 not mentioned           // Apply with default replacement
}
```

| Patch Value      | Action                              |
| ---------------- | ----------------------------------- |
| `"string"`       | Use this replacement text           |
| `null`           | Skip this reference (don't apply)   |
| _(not in patch)_ | Apply with default `to` replacement |

### Full Editset Patch

You can also pass a full editset with modified `replace` fields:

```json
{
  "refs": [
    { "refId": "a1b2", "replace": "Repository" },
    { "refId": "b2c3", "replace": null }
  ]
}
```

The patch command extracts `refId` and `replace` from each ref.

---

## More Examples: Edge Cases Manual Editing Misses

### Example 9: Destructuring Parameters (ts-morph REQUIRED)

**Scenario**: Rename `widgetPath` to `repoPath` — appears in destructuring patterns

**Manual grep would find:**

```typescript
const widgetPath = "/path/to/widget" // ✓ obvious
```

**But MISS these (ts-morph catches them):**

```typescript
// Destructuring in function parameter
export function init({ widgetPath, config }: Options) {
  return load(widgetPath)
}

// Nested destructuring
const {
  paths: { widgetPath },
} = config

// Arrow function parameter destructuring
const handler = ({ widgetPath }: Ctx) => widgetPath

// Object shorthand
return { widgetPath } // property AND value both renamed
```

**Command:**

```bash
bun tools/refactor.ts rename.batch --pattern '/^widgetPath$/' --replace repoPath --output edits.json
bun tools/refactor.ts editset.apply edits.json
# All 47 occurrences updated atomically
```

---

### Example 10: Re-exports and Barrel Files (ts-morph REQUIRED)

**Scenario**: Rename `Widget` to `Gadget` — used in index.ts re-exports

**Manual editing misses:**

```typescript
// src/index.ts - barrel file
export { Widget } from "./widget"
export type { Widget, WidgetConfig } from "./widget"

// src/components/index.ts - nested barrel
export * from "./Widget"
export { Widget as DefaultWidget } from "./Widget"
```

**ts-morph finds ALL of these:**

```bash
bun tools/refactor.ts rename.batch --pattern '/^Widget$/' --replace Gadget --output edits.json
# Found: 89 references across 23 files including all re-exports
```

---

### Example 11: Type-Only Imports

**Scenario**: Rename `UserService` interface — used in type-only imports

**Manual editing risks:**

```typescript
// Type-only import - easy to miss with grep
import type { UserService } from "./services"

// Inline type import
const fn = (service: import("./services").UserService) => {}

// Generic constraints
function process<T extends UserService>(svc: T) {}
```

**ts-morph finds all patterns:**

```bash
bun tools/refactor.ts rename.batch --pattern '/^UserService$/' --replace AccountService --check-conflicts
bun tools/refactor.ts rename.batch --pattern '/^UserService$/' --replace AccountService --output edits.json
```

---

### Example 12: JSDoc References

**Scenario**: Rename `parseConfig` — referenced in JSDoc comments

```typescript
/**
 * @see parseConfig for config format
 * @param {ReturnType<typeof parseConfig>} config
 */
function initApp(config) {}
```

**ripgrep backend catches JSDoc:**

```bash
bun tools/refactor.ts pattern.replace \
  --pattern '/^parseConfig$/' \
  --replace loadConfig \
  --glob "**/*.{ts,js}" \
  --backend ripgrep \
  --output jsdoc-updates.json
```

---

### Example 13: Dynamic Imports

**Scenario**: Rename file `user-api.ts` to `account-api.ts` — dynamic imports exist

```typescript
// Static import (caught by ts-morph file.rename)
import { getUser } from "./user-api"

// Dynamic import (caught by ripgrep pattern.replace)
const api = await import("./user-api")
const { handler } = await import(`./user-api`)
```

**Two-step approach:**

```bash
# 1. Rename file + static imports
bun tools/refactor.ts file.rename --pattern user-api --replace account-api --output files.json
bun tools/refactor.ts file.apply files.json

# 2. Catch dynamic imports
bun tools/refactor.ts pattern.replace \
  --pattern "user-api" \
  --replace "account-api" \
  --glob "**/*.ts" \
  --backend ripgrep \
  --output dynamic.json
bun tools/refactor.ts editset.apply dynamic.json
```

---

### Example 14: Test Mocks and Fixtures

**Scenario**: Rename `createWidget` — but test mocks use it too

```typescript
// src/widget.ts
export function createWidget() {}

// tests/widget.test.ts
vi.mock("../widget", () => ({
  createWidget: vi.fn(), // Mock uses same name
}))

// tests/fixtures/widget-fixture.ts
export const mockCreateWidget = () => {} // Compound identifier
```

**ts-morph renames ALL including mocks:**

```bash
bun tools/refactor.ts rename.batch --pattern '/^createWidget$/' --replace createGadget --output edits.json
# Found in: src/widget.ts, 12 test files, 3 fixture files
```

---

### Example 15: Partial Word Match with Case Preservation

**Scenario**: Rename all `widget` occurrences — different casings exist

```typescript
const widget = {} // lowercase
const Repo = {} // PascalCase
const REPO_PATH = "" // SCREAMING_CASE
const widgetConfig = {} // camelCase compound
class RepoManager {} // PascalCase compound
const REPO_OPTIONS = {} // SCREAMING compound
```

**Automatic case preservation:**

```bash
bun tools/refactor.ts rename.batch --pattern '/widget/i' --replace repo --output edits.json
```

**Result:**

```typescript
const repo = {} // lowercase preserved
const Repo = {} // PascalCase preserved
const REPO_PATH = "" // SCREAMING_CASE preserved
const repoConfig = {} // camelCase compound
class RepoManager {} // PascalCase compound
const REPO_OPTIONS = {} // SCREAMING compound
```

---

### Example 16: Multi-Package Monorepo

**Scenario**: Rename across multiple packages in a monorepo

```
packages/
  core/src/widget.ts
  cli/src/commands/widget.ts
  tui/src/views/widget-view.tsx
  storage/src/widget-loader.ts
```

**Single command handles all:**

```bash
bun tools/refactor.ts migrate --from '/widget/i' --to repo --glob "packages/**/*.{ts,tsx}"

# Creates editsets in .editsets/:
# - 01-file-renames.json (4 files)
# - 02-symbol-renames.json (234 symbols)
# - 03-text-patterns.json (89 text occurrences)
```

---

### Example 17: Rollback Safety with Checksums

**Scenario**: Someone edited a file after you created the editset

```bash
# Create editset
bun tools/refactor.ts rename.batch --pattern '/^Widget$/' --replace Gadget --output edits.json

# ... time passes, teammate edits src/widget.ts ...

# Apply fails safely with drift detection
bun tools/refactor.ts editset.apply edits.json
# Error: Drift detected in src/widget.ts (checksum mismatch)
# Skipped: 3 edits in src/widget.ts
# Applied: 45 edits in other files
```

The editset NEVER corrupts files — if the file changed, it skips that file.

---

## Decision Tree: Which Command to Use

```
Is this a terminology migration (file names + code + docs)?
├── YES → `migrate --from /X/ --to Y`
└── NO
    ├── Is this an API migration (complex pattern changes)?
    │   └── YES → `pattern.migrate --patterns X --prompt "..."` (LLM-powered)
    ├── Renaming files?
    │   └── YES → `file.rename --pattern X --replace Y`
    ├── Renaming TypeScript identifiers?
    │   └── YES → `rename.batch --pattern /X/ --replace Y`
    ├── Updating Go/Rust/Python structural patterns?
    │   └── YES → `pattern.replace --backend ast-grep`
    └── Updating text/markdown/comments?
        └── YES → `pattern.replace --backend ripgrep`
```

**Use `pattern.migrate` when:**

- Old → new patterns have different structures (not just name changes)
- Transformations need context awareness (adding `await`, changing variable scope)
- Multiple related patterns need coordinated changes
- Value mapping is required (e.g., escape codes → named keys)

---

## Performance Comparison

| Task                       | Manual Edits       | Batch Refactor        |
| -------------------------- | ------------------ | --------------------- |
| Rename function (50 refs)  | ~50 Edit calls     | 2 commands            |
| Rename file + imports      | Risk broken build  | Atomic update         |
| Full terminology migration | Hours              | Minutes               |
| Rollback on error          | Manual git restore | Automatic (checksums) |

**Rule of thumb**: If you'd make more than 5 edits, use batch refactor

---

## Tips & Tricks

### ⛔ STOP: Manual Edit Tools

**IMMEDIATELY STOP AND THINK** if you're about to use any of these:

| Tool                       | What it does       | Why you should stop                            |
| -------------------------- | ------------------ | ---------------------------------------------- |
| `sed`                      | Stream editing     | batch-refactor does this better with checksums |
| `awk`                      | Pattern processing | batch-refactor handles this                    |
| `perl -pe`                 | Regex replacement  | batch-refactor does this safely                |
| `python -c`                | Quick scripts      | batch-refactor is purpose-built for this       |
| Manual `Edit` tool in loop | Many small edits   | batch-refactor does this atomically            |

**Before using these, ask yourself:**

1. **Can batch-refactor do this?** → Use `pattern.replace` or `rename.batch`
2. **Is this a text pattern?** → Use `pattern.replace --backend ripgrep`
3. **Is this a TypeScript symbol?** → Use `rename.batch` (ts-morph)
4. **Is this a structural pattern?** → Use `pattern.replace --backend ast-grep`

**If batch-refactor CAN'T do what you need:**

1. **File a feature request** as a bead: `bd create --title "batch-refactor: support X" --type=task`
2. **Document the gap** in the bead description
3. **Only then** use the manual tool as a workaround

**The goal:** Every manual edit is a signal that batch-refactor is missing a feature.

---

### 1. Store editsets in /tmp

Storing editsets outside the repo avoids cluttering your working directory and needing `grep -v .editsets` when verifying:

```bash
# Instead of:
bun tools/refactor.ts migrate --from '/widget/i' --to repo -o .editsets
rg -l widget -g "*.ts" | grep -v .editsets | wc -l  # Annoying

# Do this:
bun tools/refactor.ts migrate --from '/widget/i' --to repo -o /tmp/editsets
rg -l widget -g "*.ts" | wc -l  # Clean
```

### 2. Preview editset contents

Before applying, inspect what an editset will do:

```bash
# Quick look at the editset structure and refs
cat /tmp/editset.json | head -50

# See how many refs/edits
cat /tmp/editset.json | jq '{refs: .refs | length, edits: .edits | length}'

# Dry-run shows what would be applied
bun tools/refactor.ts editset.apply /tmp/editset.json --dry-run
```

### 3. Use rg directly for exploration

Before running batch operations, verify your patterns find what you expect:

```bash
# Find files containing pattern
rg -l "useRepo" -g "*.ts"

# Show matches with line numbers
rg -n "useRepo" -g "*.ts"

# Count matches
rg -c "widget" -g "*.ts" | head -20

# Show context around matches
rg -C 2 "createWidget" -g "*.ts"
```

### 4. Use rg for file discovery too

`rg --files` lists files matching globs, respecting .gitignore. One tool for everything:

```bash
# Instead of find (slow, doesn't respect .gitignore):
find . -name "*widget*" -not -path "./node_modules/*"

# Use rg --files with glob:
rg --files -g "*widget*"           # Files with "widget" in name
rg --files -g "*.ts" | head -10   # All .ts files
rg --files -g "*widget*.ts"        # .ts files with "widget" in name
rg --files packages/              # All files in packages/
```

### 5. Avoid slow shell loops

Shell loops with rg are slow. Use rg's built-in features instead:

```bash
# SLOW - shell loop overhead - DON'T DO THIS
rg -l "widget" | while read f; do
  echo "=== $f ==="
  rg -n "widget" "$f"
done

# FAST - single rg invocation
rg -n "widget" -g "*.ts"                    # Filename:line:match
rg --heading -n "widget" -g "*.ts"          # Group by filename
rg --vimgrep "widget" -g "*.ts"             # file:line:col:match
```

### 6. Verify glob patterns work

Test glob patterns with rg directly before using them in batch commands:

```bash
# Test the glob finds expected files
rg --files -g "**/*.ts" | head -10
rg --files -g "apps/**/*.tsx" | head -10

# Then use same glob in batch command
bun tools/refactor.ts pattern.replace --pattern '/widget/i' --replace 'gadget' --glob "apps/**/*.tsx" -o /tmp/edits.json
```

### 6. Check remaining mentions efficiently

After migration, verify zero remaining mentions:

```bash
# Fast count of remaining mentions
rg -c "widget" -g "*.ts" --stats

# List files still containing pattern
rg -l "widget" -g "*.ts" -g "*.tsx"

# Exclude vendor/node_modules (fd-style filtering)
rg -l "widget" -g "*.ts" -g "!vendor/**" -g "!node_modules/**"
```

### 7. Debug batch-refactor commands

If a batch command returns 0 results unexpectedly:

```bash
# 1. Verify rg finds matches directly
rg -l "pattern" -g "*.ts"

# 2. Check the glob syntax
# Bad:  --glob "**/*.{ts,tsx}"   (shell may expand braces)
# Good: --glob "**/*.ts" --glob "**/*.tsx"  (separate globs)

# 3. Run with verbose output
DEBUG=* bun tools/refactor.ts pattern.replace --pattern '/widget/i' --replace 'gadget' --glob "**/*.ts"
```
