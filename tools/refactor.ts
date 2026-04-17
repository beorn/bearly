#!/usr/bin/env bun
/**
 * refactor.ts - Multi-language refactoring CLI
 *
 * Editset workflow: propose → select → apply
 *
 * Backends:
 *   ts-morph  - TypeScript/JavaScript identifiers (priority 100)
 *   ast-grep  - Structural patterns for Go, Rust, Python, JSON, YAML (priority 50)
 *   ripgrep   - Text patterns for any file (priority 10)
 *
 * Commands:
 *   symbol.at <file> <line> [col]     Find symbol at location (ts-morph)
 *   refs.list <symbolKey>             List all references (ts-morph)
 *   symbols.find --pattern <regex>    Find all symbols matching pattern (ts-morph)
 *   rename.propose <symbolKey> <new>  Create rename editset (ts-morph)
 *   rename.batch --pattern <p> --replace <r>  Batch rename proposal (ts-morph)
 *   pattern.find --pattern <p>        Find structural patterns (ast-grep/ripgrep)
 *   pattern.replace --pattern <p> --replace <r>  Create pattern replace editset
 *   editset.select <file> --exclude   Filter editset
 *   editset.apply <file>              Apply editset with checksums
 *   editset.verify <file>             Verify editset can be applied
 *   migrate --from <p> --to <r>       Orchestrate full terminology migration
 */

// Import backends (they register themselves)
import {
  getProject,
  getSymbolAt,
  getReferences,
  findSymbols,
  createRenameProposal,
  createBatchRenameProposal,
  createBatchRenameProposalFiltered,
  checkConflicts,
} from "./lib/backends/ts-morph"
import {
  findPatterns as astGrepFindPatterns,
  createPatternReplaceProposal as astGrepReplace,
} from "./lib/backends/ast-grep"
import { findPatterns as rgFindPatterns, createPatternReplaceProposal as rgReplace } from "./lib/backends/ripgrep"
import { findLinksToFile, createFileRenameEditset, findBrokenLinks } from "./lib/backends/wikilink"
import { findPackageJsonRefs, createPackageJsonEditset, findBrokenPackageJsonPaths } from "./lib/backends/package-json"
import { findTsConfigRefs, createTsConfigEditset } from "./lib/backends/tsconfig-json"
import { getBackendByName, getBackends } from "./lib/backend"
import {
  findPatterns as migrateFindPatterns,
  formatForLLM,
  buildMigrationPrompt,
  parseReplacements,
  createEditset as migrateCreateEditset,
  summarizeMatches,
} from "./lib/pattern-migrate"
import { ask } from "../plugins/llm/src/lib/research"
import { isProviderAvailable } from "../plugins/llm/src/lib/providers"
import { getBestAvailableModel } from "../plugins/llm/src/lib/types"

// Import core utilities
import { filterEditset, saveEditset, loadEditset } from "./lib/core/editset"
import { applyEditset, verifyEditset } from "./lib/core/apply"
import { applyPatch, parsePatch } from "./lib/core/patch"
import { parseRegexLiteral, buildRegex } from "./lib/core/regex"
import {
  findFilesToRename,
  checkFileConflicts,
  createFileRenameProposal,
  verifyFileEditset,
  applyFileRenames,
  saveFileEditset,
  loadFileEditset,
} from "./lib/core/file-ops"

const args = process.argv.slice(2)
const command = args[0]

function output(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

function error(message: string): never {
  console.error(JSON.stringify({ error: message }))
  process.exit(1)
}

async function getProjectStats(): Promise<{
  tsFiles: number
  mdFiles: number
  hasAstGrep: boolean
  hasTsConfig: boolean
}> {
  const fs = await import("fs")

  // Count files using Bun's built-in glob
  const tsGlob = new Bun.Glob("**/*.{ts,tsx}")
  const mdGlob = new Bun.Glob("**/*.md")

  let tsFiles = 0
  let mdFiles = 0

  for await (const _file of tsGlob.scan({ cwd: ".", onlyFiles: true })) {
    if (!_file.includes("node_modules") && !_file.includes("dist")) tsFiles++
  }

  for await (const _file of mdGlob.scan({ cwd: ".", onlyFiles: true })) {
    if (!_file.includes("node_modules")) mdFiles++
  }

  const hasTsConfig = fs.existsSync("tsconfig.json")

  // Check if ast-grep is available
  let hasAstGrep = false
  try {
    const proc = Bun.spawnSync(["sg", "--version"])
    hasAstGrep = proc.exitCode === 0
  } catch {
    hasAstGrep = false
  }

  return { tsFiles, mdFiles, hasAstGrep, hasTsConfig }
}

async function usage(): Promise<never> {
  const stats = await getProjectStats()

  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║              Refactor - Batch Rename, Replace, and API Migration             ║
╚══════════════════════════════════════════════════════════════════════════════╝

PROJECT STATS
  TypeScript files: ${stats.tsFiles.toLocaleString().padStart(6)}  │  tsconfig.json: ${stats.hasTsConfig ? "✓ found" : "✗ missing"}
  Markdown files:   ${stats.mdFiles.toLocaleString().padStart(6)}  │  ast-grep (sg): ${stats.hasAstGrep ? "✓ installed" : "○ not found"}

WHEN TO USE EACH COMMAND

  migrate           Simple terminology change (widgetPath → repoPath)
  rename.batch      TypeScript symbol rename (catches destructuring, re-exports)
  pattern.replace   Text search/replace (comments, markdown, strings)
  pattern.migrate   Complex API migration (LLM figures out transformations)
                    Use when old→new patterns have different structures

PATTERN SYNTAX: regex literals are required

  \`--pattern\` and \`--from\` take regex literals in the form /pattern/flags.
  Plain strings are rejected. This forces an explicit decision about case.

    /screenRect/     → case-sensitive match, LITERAL replacement
                       (use for code identifier renames — preserves mixed case)

    /widget/i        → case-insensitive match, CASE-PRESERVING replacement
                       (use for prose: widget→gadget, Widget→Gadget, WIDGET→GADGET)

    /\\buseLayout\\b/ → word-boundary match (explicit, no hidden behavior)

  The \`g\` flag is always set internally. Only \`i\` is user-meaningful.

TERMINOLOGY MIGRATION: Rename "widget" → "gadget" everywhere

  Step 1: Check for conflicts (will "gadget" clash with existing names?)
    $ bun refactor rename.batch --pattern '/widget/i' --replace gadget --check-conflicts
    $ bun refactor file.rename --pattern widget --replace gadget --check-conflicts

  Step 2: Create editsets (proposes changes, doesn't apply yet)
    $ bun refactor migrate --from '/widget/i' --to gadget --dry-run --output /tmp/edits
    Creates: /tmp/edits/01-file-renames.json
             /tmp/edits/02-symbol-renames.json
             /tmp/edits/03-text-patterns.json

  Step 3: Preview each phase
    $ bun refactor file.apply /tmp/edits/01-file-renames.json --dry-run
    $ bun refactor editset.apply /tmp/edits/02-symbol-renames.json --dry-run

  Step 4: Apply (checksum-protected, skips drifted files)
    $ bun refactor file.apply /tmp/edits/01-file-renames.json
    $ bun refactor editset.apply /tmp/edits/02-symbol-renames.json
    $ bun refactor editset.apply /tmp/edits/03-text-patterns.json

  Step 5: Verify
    $ bun tsc --noEmit && bun test

CODE IDENTIFIER RENAME: Rename a function/type across the codebase

    $ bun refactor rename.batch --pattern '/^useContentRect$/' --replace useBoxRect
    $ bun refactor pattern.replace --pattern '/\\bscreenRect\\b/' --replace scrollRect
    # No /i → exact match, literal replacement (mixed case preserved)

QUICK COMMANDS

  migrate --from /X/flags --to Y [--dry-run]      Full migration (files + symbols + text)
  rename.batch --pattern /X/flags --replace Y     TypeScript symbols only
  file.rename --pattern X --replace Y             File names + import paths (plain strings)
  pattern.replace --pattern /X/flags --replace Y  Text search/replace (comments, strings, md)
  pattern.migrate --patterns X --prompt Y         LLM-powered API migration (complex patterns)

API MIGRATION EXAMPLE: Migrate test framework API

  # Old: const { lastFrame, stdin } = render(<App />)
  #      stdin.write('\\x1b[A')
  # New: const app = render(<App />)
  #      await app.press('ArrowUp')

  $ bun refactor pattern.migrate \\
      --patterns "lastFrame(),stdin.write" \\
      --glob "**/*.test.tsx" \\
      --prompt "Migrate render API:
        - const { lastFrame, stdin } = render(...) → const app = render(...)
        - lastFrame() → app.ansi
        - stdin.write('\\x1b[A') → await app.press('ArrowUp')" \\
      --output /tmp/migrate.json

  $ bun refactor editset.apply /tmp/migrate.json

EDITSET FORMAT (JSON)

  Editsets are JSON files containing proposed changes with checksums:
  {
    "refs": [{ "refId": "abc123", "file": "src/foo.ts", "line": 42,
               "kind": "call", "scope": "initApp", "replace": "gadget" }],
    "edits": [{ "file": "src/foo.ts", "checksum": "...", ... }]
  }

  Fields: refId (unique ID), kind (call|decl|type|string|comment),
          scope (enclosing function), replace (null to skip)

  Patch editsets with LLM decisions:
    $ bun refactor editset.patch edits.json <<< '{"abc123": null, "def456": "Gadget"}'

COMMANDS

  pattern.migrate                         LLM-powered API migration
    --patterns <p1,p2,...>                Required: patterns to search for
    --prompt <text>                       Required: migration instructions for LLM
    --glob <glob>                         File filter (default: **/*.{ts,tsx})
    --output <file>                       Editset file (default: /tmp/migrate.json)
    --model <model>                       LLM model override
    --dry-run                             Preview without calling LLM

  migrate                                 Full terminology migration
    --from <pattern> --to <replacement>   Required: pattern and replacement
    --glob <glob>                         File filter (default: **/*.{ts,tsx})
    --dry-run                             Preview without applying
    --output <dir>                        Editset directory (default: .editsets/)

  rename.batch                            TypeScript symbol rename (ts-morph)
    --pattern <regex> --replace <string>  Required: pattern and replacement
    --check-conflicts                     Check for naming conflicts only
    --skip <names>                        Comma-separated names to skip
    --output <file>                       Editset file (default: editset.json)

  file.rename                             Rename files + update imports
    --pattern <string> --replace <string> Required: pattern and replacement
    --glob <glob>                         File filter (default: **/*.{ts,tsx})
    --check-conflicts                     Check for conflicts only
    --output <file>                       Editset file (default: file-editset.json)

  pattern.replace                         Text/structural search-replace
    --pattern <pattern> --replace <text>  Required: pattern and replacement
    --glob <glob>                         File filter
    --backend <name>                      ast-grep (structural) or ripgrep (text)
    --output <file>                       Editset file (default: editset.json)

  editset.apply <file> [--dry-run] [--verify]  Apply editset (checksums protect against drift, --verify runs tsc before/after)
  editset.verify <file>                   Check if editset can be applied
  editset.patch <file>                    Apply LLM patch from stdin
  file.apply <file> [--dry-run]           Apply file rename editset

EXPLORATION

  symbol.at <file> <line> [col]           Find symbol at location
  refs.list <symbolKey>                   List all references
  symbols.find --pattern <regex>          Find symbols matching pattern
  pattern.find --pattern <p> --glob <g>   Find text/structural patterns
  wikilink.find --target <file>           Find wiki-links to file
  wikilink.broken                         Find broken wiki-links
  backends.list                           List available backends

DOCUMENTATION

  Full documentation with examples, edge cases, and LLM patch workflow:
    skills/batch-refactor/SKILL.md

  Topics covered:
    • Why ts-morph catches patterns that grep/sed miss (destructuring, re-exports)
    • Case preservation (widget→gadget, Widget→Gadget, WIDGET→GADGET)
    • Conflict resolution strategies
    • LLM patch workflow for selective replacements
    • Multi-package monorepo migrations
    • Checksum-based drift protection
`)
  process.exit(1)
}

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx === -1) return undefined
  return args[idx + 1]
}

function hasFlag(name: string): boolean {
  return args.includes(name)
}

async function main() {
  if (!command || command === "--help" || command === "-h") {
    await usage()
  }

  // Lazy project loading - only load when needed
  const tsConfigPath = getArg("--tsconfig") || "tsconfig.json"
  const lazyProject = () => getProject(tsConfigPath)

  switch (command) {
    case "symbol.at": {
      const file = args[1]
      const line = parseInt(args[2]!, 10)
      const col = parseInt(args[3] || "1", 10)

      if (!file || isNaN(line)) {
        error("Usage: symbol.at <file> <line> [col]")
      }

      const symbol = getSymbolAt(lazyProject(), file, line, col)
      if (!symbol) {
        error(`No symbol found at ${file}:${line}:${col}`)
      }
      output(symbol)
      break
    }

    case "refs.list": {
      const symbolKey = args[1]
      if (!symbolKey) {
        error("Usage: refs.list <symbolKey>")
      }

      const refs = getReferences(lazyProject(), symbolKey)
      output(refs)
      break
    }

    case "symbols.find": {
      const pattern = getArg("--pattern")
      if (!pattern) {
        error(
          "Usage: symbols.find --pattern /regex/flags\n\nExamples:\n  /^useLayout$/   — exact symbol name\n  /^use.*Rect$/i  — any use*Rect (case-insensitive)",
        )
      }

      const regex = buildRegex(parseRegexLiteral(pattern, "--pattern"))
      const symbols = findSymbols(lazyProject(), regex)
      output(symbols)
      break
    }

    case "rename.propose": {
      const symbolKey = args[1]
      const newName = args[2]
      const outputFile = getArg("--output") || "editset.json"

      if (!symbolKey || !newName) {
        error("Usage: rename.propose <symbolKey> <newName> [--output file]")
      }

      const editset = createRenameProposal(lazyProject(), symbolKey, newName)
      saveEditset(editset, outputFile)
      output({
        editsetPath: outputFile,
        refCount: editset.refs.length,
        fileCount: new Set(editset.refs.map((r) => r.file)).size,
      })
      break
    }

    case "rename.batch": {
      const pattern = getArg("--pattern")
      const replacement = getArg("--replace")
      const outputFile = getArg("--output") || "editset.json"
      const checkConflictsFlag = hasFlag("--check-conflicts")
      const skipNames = getArg("--skip")?.split(",") || []

      if (!pattern || !replacement) {
        error(
          `Usage: rename.batch --pattern /regex/flags --replace <string> [--output file] [--check-conflicts] [--skip names]

Examples:
  # Code identifier rename (case-sensitive, literal replacement):
  rename.batch --pattern '/^useContentRect$/' --replace 'useBoxRect'

  # Terminology migration (case-insensitive, case-preserving):
  rename.batch --pattern '/widget/i' --replace 'gadget'
  # Renames widget→gadget, Widget→Gadget, WIDGET→GADGET

The /i flag controls both match-case AND replacement-case:
  no /i → exact match, literal replacement (use for code)
  /i   → any case, case-preserving (use for prose)`,
        )
      }

      const regex = buildRegex(parseRegexLiteral(pattern, "--pattern"))

      // Check for conflicts mode
      if (checkConflictsFlag) {
        const report = checkConflicts(lazyProject(), regex, replacement)
        output(report)
        break
      }

      // Normal batch rename (with optional skip)
      const symbols = findSymbols(lazyProject(), regex)
      const skippedCount = skipNames.length > 0 ? symbols.filter((s) => skipNames.includes(s.name)).length : 0
      console.error(`Found ${symbols.length} symbols matching /${pattern}/i`)
      if (skippedCount > 0) {
        console.error(`Skipping ${skippedCount} symbols: ${skipNames.join(", ")}`)
      }

      const editset =
        skipNames.length > 0
          ? createBatchRenameProposalFiltered(lazyProject(), regex, replacement, skipNames)
          : createBatchRenameProposal(lazyProject(), regex, replacement)
      saveEditset(editset, outputFile)

      output({
        editsetPath: outputFile,
        refCount: editset.refs.length,
        fileCount: new Set(editset.refs.map((r) => r.file)).size,
        symbolCount: symbols.length - skippedCount,
        skippedSymbols: skipNames.length > 0 ? skipNames : undefined,
      })
      break
    }

    case "editset.select": {
      const inputFile = args[1]
      const include = getArg("--include")?.split(",")
      const exclude = getArg("--exclude")?.split(",")
      const outputFile = getArg("--output") || inputFile

      if (!inputFile) {
        error("Usage: editset.select <file> [--include refIds] [--exclude refIds] [--output file]")
      }

      const editset = loadEditset(inputFile!)
      const filtered = filterEditset(editset, include, exclude)
      saveEditset(filtered, outputFile!)

      const selectedCount = filtered.refs.filter((r) => r.selected).length
      output({
        editsetPath: outputFile,
        selectedRefs: selectedCount,
        totalRefs: filtered.refs.length,
      })
      break
    }

    case "editset.apply": {
      const inputFile = args[1]
      const dryRun = hasFlag("--dry-run")
      const verify = hasFlag("--verify")

      if (!inputFile) {
        error("Usage: editset.apply <file> [--dry-run] [--verify]")
      }

      // Capture tsc baseline before apply (if --verify)
      let tscBefore = 0
      if (verify && !dryRun) {
        const baseline = Bun.spawnSync(["npx", "tsc", "--noEmit"], { stdout: "pipe", stderr: "pipe" })
        tscBefore = (baseline.stderr.toString() + baseline.stdout.toString())
          .split("\n")
          .filter((l) => l.includes("error TS")).length
        console.error(`[verify] tsc errors before: ${tscBefore}`)
      }

      const editset = loadEditset(inputFile)
      const result = applyEditset(editset, dryRun)

      if (dryRun) {
        console.error("[DRY RUN - no changes applied]")
      }

      // Verify tsc after apply (if --verify)
      if (verify && !dryRun) {
        const after = Bun.spawnSync(["npx", "tsc", "--noEmit"], { stdout: "pipe", stderr: "pipe" })
        const tscAfter = (after.stderr.toString() + after.stdout.toString())
          .split("\n")
          .filter((l) => l.includes("error TS")).length
        const delta = tscAfter - tscBefore
        console.error(`[verify] tsc errors after: ${tscAfter} (${delta >= 0 ? "+" : ""}${delta})`)
        if (delta > 0) {
          console.error(`[verify] WARNING: tsc errors INCREASED by ${delta} — review changes carefully`)
        } else if (delta < 0) {
          console.error(`[verify] tsc errors decreased by ${Math.abs(delta)}`)
        } else {
          console.error(`[verify] tsc errors unchanged`)
        }
      }

      output(result)
      break
    }

    case "editset.verify": {
      const inputFile = args[1]

      if (!inputFile) {
        error("Usage: editset.verify <file>")
      }

      const editset = loadEditset(inputFile)
      const result = verifyEditset(editset)
      output(result)
      break
    }

    case "editset.patch": {
      const inputFile = args[1]
      const outputFile = getArg("--output") || inputFile

      if (!inputFile) {
        error("Usage: editset.patch <file> [--output file] < patch.json")
      }

      // Read patch from stdin
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) {
        chunks.push(chunk)
      }
      const stdinContent = Buffer.concat(chunks).toString("utf-8").trim()

      if (!stdinContent) {
        error('No patch provided on stdin. Usage: editset.patch <file> <<\'EOF\'\n{"refId": "replacement"}\nEOF')
      }

      const editset = loadEditset(inputFile!)
      const patch = parsePatch(stdinContent)
      const patched = applyPatch(editset, patch)
      saveEditset(patched, outputFile!)

      const selectedCount = patched.refs.filter((r) => r.selected).length
      const skippedCount = patched.refs.filter((r) => !r.selected || r.replace === null).length
      output({
        editsetPath: outputFile,
        patchedRefs: Object.keys(patch).length,
        selectedRefs: selectedCount,
        skippedRefs: skippedCount,
        totalRefs: patched.refs.length,
      })
      break
    }

    case "pattern.find": {
      const pattern = getArg("--pattern")
      const glob = getArg("--glob")
      const backendName = getArg("--backend")

      if (!pattern) {
        error("Usage: pattern.find --pattern <pattern> [--glob <glob>] [--backend ast-grep|ripgrep]")
      }

      // Choose backend
      let refs
      if (backendName === "ast-grep") {
        refs = astGrepFindPatterns(pattern, glob)
      } else if (backendName === "ripgrep") {
        refs = rgFindPatterns(pattern, glob)
      } else {
        // Auto-detect: prefer ast-grep for structural patterns, ripgrep for text
        // Heuristic: if pattern contains $METAVAR, use ast-grep
        if (pattern.includes("$")) {
          refs = astGrepFindPatterns(pattern, glob)
        } else {
          refs = rgFindPatterns(pattern, glob)
        }
      }

      output(refs)
      break
    }

    case "pattern.replace": {
      const pattern = getArg("--pattern")
      const replacement = getArg("--replace")
      const glob = getArg("--glob")
      const backendName = getArg("--backend")
      const outputFile = getArg("--output") || "editset.json"

      if (!pattern || !replacement) {
        error(
          `Usage: pattern.replace --pattern /regex/flags --replace <replacement> [--glob <glob>] [--backend ast-grep|ripgrep] [--output file]

Examples:
  # Exact match, literal replacement (code migrations):
  pattern.replace --pattern '/screenRect/' --replace 'scrollRect'
  pattern.replace --pattern '/\\buseContentRect\\b/' --replace 'useBoxRect'

  # Case-insensitive match, case-preserving replacement (prose migrations):
  pattern.replace --pattern '/widget/i' --replace 'gadget'
  # → widget/Widget/WIDGET become gadget/Gadget/GADGET

  # With file filter:
  pattern.replace --pattern '/foo/' --replace 'bar' --glob '**/*.md'

The /i flag controls both match-case AND replacement-case:
  no /i → exact match, literal replacement (use for code identifiers)
  /i   → any case, case-preserving replacement (use for prose terminology)

Note: the 'g' flag is always set internally (multi-match per file).`,
        )
      }

      // Parse the regex literal. The `/i` flag drives case handling for both the
      // search and the replacement — no hidden tool logic.
      const parsed = parseRegexLiteral(pattern, "--pattern")

      // Choose backend
      let editset
      if (backendName === "ast-grep") {
        // ast-grep uses its own pattern language; pass the raw source through.
        editset = astGrepReplace(parsed.source, replacement, glob)
      } else if (backendName === "ripgrep") {
        editset = rgReplace(parsed.source, replacement, glob, parsed.caseInsensitive)
      } else {
        // Auto-detect: prefer ast-grep for structural patterns (contain `$`)
        if (parsed.source.includes("$")) {
          editset = astGrepReplace(parsed.source, replacement, glob)
        } else {
          editset = rgReplace(parsed.source, replacement, glob, parsed.caseInsensitive)
        }
      }

      saveEditset(editset, outputFile)
      output({
        editsetPath: outputFile,
        refCount: editset.refs.length,
        fileCount: new Set(editset.refs.map((r) => r.file)).size,
        backend: backendName || (parsed.source.includes("$") ? "ast-grep" : "ripgrep"),
      })
      break
    }

    case "backends.list": {
      const backends = getBackends()
      output(
        backends.map((b) => ({
          name: b.name,
          extensions: b.extensions,
          priority: b.priority,
          capabilities: {
            findPatterns: !!b.findPatterns,
            createPatternReplaceProposal: !!b.createPatternReplaceProposal,
            getSymbolAt: !!b.getSymbolAt,
            getReferences: !!b.getReferences,
            findSymbols: !!b.findSymbols,
            createRenameProposal: !!b.createRenameProposal,
            createBatchRenameProposal: !!b.createBatchRenameProposal,
          },
        })),
      )
      break
    }

    // Wiki-link operations (for markdown repos: Obsidian, Foam, Dendron, etc.)
    case "wikilink.find": {
      const target = getArg("--target")
      const glob = getArg("--glob") || "**/*.md"

      if (!target) {
        error("Usage: wikilink.find --target <file> [--glob <glob>]")
      }

      const refs = findLinksToFile(target, ".", glob)
      output({
        target,
        glob,
        links: refs.map((r) => ({
          file: r.file,
          line: r.range[0],
          preview: r.preview,
        })),
        count: refs.length,
      })
      break
    }

    case "wikilink.rename": {
      const oldPath = getArg("--old")
      const newPath = getArg("--new")
      const outputFile = getArg("--output") || "wikilink-editset.json"

      if (!oldPath || !newPath) {
        error("Usage: wikilink.rename --old <path> --new <path> [--output <file>]")
      }

      const editset = createFileRenameEditset(oldPath, newPath, ".")
      saveFileEditset(editset, outputFile)
      output({
        editsetPath: outputFile,
        oldPath,
        newPath,
        linkCount: editset.importEdits.length,
        fileCount: new Set(editset.importEdits.map((e) => e.file)).size,
      })
      break
    }

    case "wikilink.broken": {
      const glob = getArg("--glob") || "**/*.md"

      const refs = findBrokenLinks(".", glob)
      output({
        glob,
        brokenLinks: refs.map((r) => ({
          file: r.file,
          line: r.range[0],
          preview: r.preview,
        })),
        count: refs.length,
      })
      break
    }

    // Package.json operations
    case "package.find": {
      const target = getArg("--target")
      const glob = getArg("--glob") || "**/package.json"

      if (!target) {
        error("Usage: package.find --target <file> [--glob <glob>]")
      }

      const refs = findPackageJsonRefs(target, ".", glob)
      output({
        target,
        glob,
        refs: refs.map((r) => ({
          file: r.file,
          line: r.range[0],
          preview: r.preview,
        })),
        count: refs.length,
      })
      break
    }

    case "package.rename": {
      const oldPath = getArg("--old")
      const newPath = getArg("--new")
      const outputFile = getArg("--output") || "package-editset.json"

      if (!oldPath || !newPath) {
        error("Usage: package.rename --old <path> --new <path> [--output <file>]")
      }

      const editset = createPackageJsonEditset(oldPath, newPath, ".")
      saveEditset(editset, outputFile)
      output({
        editsetPath: outputFile,
        oldPath,
        newPath,
        editCount: editset.edits.length,
        fileCount: new Set(editset.edits.map((e) => e.file)).size,
      })
      break
    }

    case "package.broken": {
      const refs = findBrokenPackageJsonPaths(".")
      output({
        brokenPaths: refs.map((r) => ({
          file: r.file,
          line: r.range[0],
          preview: r.preview,
        })),
        count: refs.length,
      })
      break
    }

    // TSConfig.json operations
    case "tsconfig.find": {
      const target = getArg("--target")
      const glob = getArg("--glob") || "**/tsconfig*.json"

      if (!target) {
        error("Usage: tsconfig.find --target <file> [--glob <glob>]")
      }

      const refs = findTsConfigRefs(target, ".", glob)
      output({
        target,
        glob,
        refs: refs.map((r) => ({
          file: r.file,
          line: r.range[0],
          preview: r.preview,
        })),
        count: refs.length,
      })
      break
    }

    case "tsconfig.rename": {
      const oldPath = getArg("--old")
      const newPath = getArg("--new")
      const outputFile = getArg("--output") || "tsconfig-editset.json"

      if (!oldPath || !newPath) {
        error("Usage: tsconfig.rename --old <path> --new <path> [--output <file>]")
      }

      const editset = createTsConfigEditset(oldPath, newPath, ".")
      saveEditset(editset, outputFile)
      output({
        editsetPath: outputFile,
        oldPath,
        newPath,
        editCount: editset.edits.length,
        fileCount: new Set(editset.edits.map((e) => e.file)).size,
      })
      break
    }

    // File operations
    case "file.find": {
      const pattern = getArg("--pattern")
      const replacement = getArg("--replace")
      const glob = getArg("--glob") || "**/*.{ts,tsx,js,jsx}"

      if (!pattern || !replacement) {
        error("Usage: file.find --pattern <string> --replace <string> [--glob <glob>]")
      }

      const fileOps = await findFilesToRename(pattern, replacement, glob)
      output({
        pattern,
        replacement,
        glob,
        files: fileOps.map((op) => ({
          oldPath: op.oldPath,
          newPath: op.newPath,
        })),
        count: fileOps.length,
      })
      break
    }

    case "file.rename": {
      const pattern = getArg("--pattern")
      const replacement = getArg("--replace")
      const glob = getArg("--glob") || "**/*.{ts,tsx,js,jsx}"
      const outputFile = getArg("--output") || "file-editset.json"
      const checkConflictsFlag = hasFlag("--check-conflicts")

      if (!pattern || !replacement) {
        error(
          "Usage: file.rename --pattern <string> --replace <string> [--glob <glob>] [--output file] [--check-conflicts]",
        )
      }

      // Find files to rename
      const fileOps = await findFilesToRename(pattern, replacement, glob)

      if (fileOps.length === 0) {
        output({ message: "No files found matching pattern", pattern, glob })
        break
      }

      // Check conflicts mode
      if (checkConflictsFlag) {
        const report = checkFileConflicts(fileOps)
        output({
          conflicts: report.conflicts,
          safe: report.safe.map((op) => ({
            oldPath: op.oldPath,
            newPath: op.newPath,
          })),
          conflictCount: report.conflicts.length,
          safeCount: report.safe.length,
        })
        break
      }

      // Create editset
      const editset = await createFileRenameProposal(pattern, replacement, glob)
      saveFileEditset(editset, outputFile)

      output({
        editsetPath: outputFile,
        fileCount: editset.fileOps.length,
        importEditCount: editset.importEdits.length,
        files: editset.fileOps.map((op) => ({
          oldPath: op.oldPath,
          newPath: op.newPath,
        })),
      })
      break
    }

    case "file.verify": {
      const inputFile = args[1]

      if (!inputFile) {
        error("Usage: file.verify <file>")
      }

      const editset = loadFileEditset(inputFile)
      const result = verifyFileEditset(editset)
      output({
        valid: result.valid,
        drifted: result.drifted,
        fileCount: editset.fileOps.length,
      })
      break
    }

    case "file.apply": {
      const inputFile = args[1]
      const dryRun = hasFlag("--dry-run")

      if (!inputFile) {
        error("Usage: file.apply <file> [--dry-run]")
      }

      const editset = loadFileEditset(inputFile)
      const result = applyFileRenames(editset, dryRun)

      if (dryRun) {
        console.error("[DRY RUN - no files renamed]")
      }

      output({
        applied: result.applied,
        skipped: result.skipped,
        errors: result.errors,
        dryRun,
      })
      break
    }

    // Migration orchestration command
    case "migrate": {
      const from = getArg("--from")
      const to = getArg("--to")
      const glob = getArg("--glob") || "**/*.{ts,tsx}"
      const dryRun = hasFlag("--dry-run")
      const outputDir = getArg("--output") || ".editsets"

      if (!from || !to) {
        error(
          `Usage: migrate --from /regex/flags --to <replacement> [--glob <glob>] [--dry-run] [--output <dir>]

Examples:
  # Code rename (case-sensitive, literal — for identifier renames):
  migrate --from '/contentRect/' --to 'boxRect' --dry-run

  # Prose terminology migration (case-insensitive, case-preserving):
  migrate --from '/widget/i' --to 'gadget' --dry-run
  # Renames widget→gadget, Widget→Gadget, WIDGET→GADGET across files + symbols + text

  # Scope to markdown only:
  migrate --from '/oldTerm/' --to 'newTerm' --glob '**/*.md'

Phases:
  1. File renames        — files whose name contains the pattern
  2. Symbol renames      — TypeScript identifiers (via ts-morph)
  3. Text replacements   — strings, comments, markdown (via ripgrep)

The /i flag propagates through all phases. Without /i, all phases are exact.
With /i, all phases apply case-preservation.`,
        )
      }

      // Parse the regex literal. The `/i` flag is propagated through all three
      // migration phases (file renames, symbol renames, text patterns).
      const parsedFrom = parseRegexLiteral(from, "--from")

      // Ensure output directory exists
      const fs = await import("fs")
      const path = await import("path")
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      const results: {
        phase: string
        editsetPath?: string
        count: number
        files: number
        details?: string[]
      }[] = []

      console.error(`\n=== Migration: ${from} → ${to} ===\n`)
      console.error(
        `Case handling: ${parsedFrom.caseInsensitive ? "case-insensitive (/i) — replacement will case-match source" : "case-sensitive — literal replacement"}\n`,
      )

      // Phase 1: File renames
      console.error("Phase 1: Finding files to rename...")
      const fileOps = await findFilesToRename(parsedFrom.source, to, glob)
      if (fileOps.length > 0) {
        const fileEditset = await createFileRenameProposal(parsedFrom.source, to, glob)
        const fileEditsetPath = path.join(outputDir, "01-file-renames.json")
        saveFileEditset(fileEditset, fileEditsetPath)
        results.push({
          phase: "file-renames",
          editsetPath: fileEditsetPath,
          count: fileEditset.fileOps.length,
          files: fileEditset.fileOps.length,
          details: fileEditset.fileOps.map((op) => `${op.oldPath} → ${op.newPath}`),
        })
        console.error(`  Found ${fileEditset.fileOps.length} files to rename`)
      } else {
        results.push({ phase: "file-renames", count: 0, files: 0 })
        console.error("  No files to rename")
      }

      // Phase 2: Symbol renames (TypeScript identifiers)
      console.error("\nPhase 2: Finding TypeScript symbols to rename...")
      const symbolRegex = buildRegex(parsedFrom)
      const symbols = findSymbols(lazyProject(), symbolRegex)
      if (symbols.length > 0) {
        const symbolEditset = createBatchRenameProposal(lazyProject(), symbolRegex, to)
        const symbolEditsetPath = path.join(outputDir, "02-symbol-renames.json")
        saveEditset(symbolEditset, symbolEditsetPath)
        results.push({
          phase: "symbol-renames",
          editsetPath: symbolEditsetPath,
          count: symbolEditset.refs.length,
          files: new Set(symbolEditset.refs.map((r) => r.file)).size,
        })
        console.error(
          `  Found ${symbols.length} symbols, ${symbolEditset.refs.length} references across ${new Set(symbolEditset.refs.map((r) => r.file)).size} files`,
        )
      } else {
        results.push({ phase: "symbol-renames", count: 0, files: 0 })
        console.error("  No symbols to rename")
      }

      // Phase 3: Text/comment replacements (strings, comments, docs)
      console.error("\nPhase 3: Finding text patterns (strings/comments)...")
      const textEditset = rgReplace(parsedFrom.source, to, glob, parsedFrom.caseInsensitive)
      if (textEditset.refs.length > 0) {
        const textEditsetPath = path.join(outputDir, "03-text-patterns.json")
        saveEditset(textEditset, textEditsetPath)
        results.push({
          phase: "text-patterns",
          editsetPath: textEditsetPath,
          count: textEditset.refs.length,
          files: new Set(textEditset.refs.map((r) => r.file)).size,
        })
        console.error(
          `  Found ${textEditset.refs.length} text matches across ${new Set(textEditset.refs.map((r) => r.file)).size} files`,
        )
      } else {
        results.push({ phase: "text-patterns", count: 0, files: 0 })
        console.error("  No text patterns to replace")
      }

      // Summary
      const totalCount = results.reduce((sum, r) => sum + r.count, 0)

      console.error("\n=== Summary ===")
      for (const r of results) {
        if (r.editsetPath) {
          console.error(`  ${r.phase}: ${r.count} edits in ${r.files} files → ${r.editsetPath}`)
        } else {
          console.error(`  ${r.phase}: no changes`)
        }
      }
      console.error(`  Total: ${totalCount} potential edits`)

      if (dryRun) {
        console.error("\n[DRY RUN - no changes applied]")
        console.error("Review editsets and apply with:")
        for (const r of results) {
          if (r.editsetPath) {
            if (r.phase === "file-renames") {
              console.error(`  refactor.ts file.apply ${r.editsetPath}`)
            } else {
              console.error(`  refactor.ts editset.apply ${r.editsetPath}`)
            }
          }
        }
      } else {
        console.error("\nApplying changes...")

        // Apply in order: files first (to update paths), then symbols, then text
        const applyResults: {
          phase: string
          applied: number
          skipped: number
          errors: string[]
        }[] = []

        // Apply file renames
        const fileResult = results.find((r) => r.phase === "file-renames")
        if (fileResult?.editsetPath) {
          console.error("\n  Applying file renames...")
          const fileEditset = loadFileEditset(fileResult.editsetPath)
          const result = applyFileRenames(fileEditset, false)
          applyResults.push({
            phase: "file-renames",
            applied: result.applied,
            skipped: result.skipped,
            errors: result.errors,
          })
          console.error(`    Applied: ${result.applied}, Skipped: ${result.skipped}`)
        }

        // Apply symbol renames
        const symbolResult = results.find((r) => r.phase === "symbol-renames")
        if (symbolResult?.editsetPath) {
          console.error("\n  Applying symbol renames...")
          const symbolEditset = loadEditset(symbolResult.editsetPath)
          const result = applyEditset(symbolEditset, false)
          applyResults.push({
            phase: "symbol-renames",
            applied: result.applied,
            skipped: result.skipped,
            errors: [],
          })
          console.error(`    Applied: ${result.applied}, Skipped: ${result.skipped}`)
        }

        // Apply text patterns
        const textResult = results.find((r) => r.phase === "text-patterns")
        if (textResult?.editsetPath) {
          console.error("\n  Applying text patterns...")
          const textEditset = loadEditset(textResult.editsetPath)
          const result = applyEditset(textEditset, false)
          applyResults.push({
            phase: "text-patterns",
            applied: result.applied,
            skipped: result.skipped,
            errors: [],
          })
          console.error(`    Applied: ${result.applied}, Skipped: ${result.skipped}`)
        }

        console.error("\n=== Migration Complete ===")
      }

      output({
        from,
        to,
        glob,
        dryRun,
        outputDir,
        phases: results.map((r) => ({
          phase: r.phase,
          editsetPath: r.editsetPath,
          count: r.count,
          files: r.files,
        })),
        totalEdits: totalCount,
      })
      break
    }

    // LLM-powered pattern migration
    case "pattern.migrate": {
      const patternsArg = getArg("--patterns")
      const prompt = getArg("--prompt")
      const glob = getArg("--glob") || "**/*.{ts,tsx}"
      const outputFile = getArg("--output") || "/tmp/migrate.json"
      const modelOverride = getArg("--model")
      const dryRun = hasFlag("--dry-run")

      if (!patternsArg) {
        error("Usage: pattern.migrate --patterns <p1,p2,...> --prompt <text> [--glob <glob>] [--output <file>]")
      }
      if (!prompt) {
        error("--prompt is required: migration instructions for the LLM")
      }

      const patterns = patternsArg.split(",").map((p) => p.trim())

      // 1. Find all matches
      console.error(`Searching for ${patterns.length} patterns in ${glob}...`)
      const matches = migrateFindPatterns(patterns, glob)

      if (matches.length === 0) {
        console.error("No matches found.")
        output({ patterns, glob, matchCount: 0 })
        break
      }

      const fileSummary = summarizeMatches(matches)
      console.error(`Found ${matches.length} matches in ${fileSummary.size} files:`)
      for (const [file, count] of fileSummary.entries()) {
        console.error(`  ${file}: ${count} matches`)
      }

      // 2. Dry run - just show what would be sent
      if (dryRun) {
        console.error("\n[DRY RUN - showing LLM prompt preview]")
        const llmPrompt = buildMigrationPrompt(matches, prompt)
        console.error(`\nPrompt length: ${llmPrompt.length} chars`)
        console.error("\n--- First 2000 chars of prompt ---")
        console.error(llmPrompt.slice(0, 2000))
        if (llmPrompt.length > 2000) {
          console.error(`\n... (${llmPrompt.length - 2000} more chars)`)
        }
        output({
          dryRun: true,
          patterns,
          glob,
          matchCount: matches.length,
          fileCount: fileSummary.size,
          promptLength: llmPrompt.length,
        })
        break
      }

      // 3. Get LLM model
      let model
      if (modelOverride) {
        const { getModel } = await import("../plugins/llm/src/lib/types")
        model = getModel(modelOverride)
        if (!model) error(`Unknown model: ${modelOverride}`)
      } else {
        const result = getBestAvailableModel("default", isProviderAvailable)
        model = result.model
        if (!model) {
          error("No LLM model available. Set OPENAI_API_KEY or similar.")
        }
        if (result.warning) console.error(`⚠️  ${result.warning}`)
      }

      // 4. Send to LLM
      const llmPrompt = buildMigrationPrompt(matches, prompt)
      console.error(`\nSending ${matches.length} matches to ${model.displayName}...`)

      const response = await ask(llmPrompt, "standard", {
        modelOverride: model.modelId,
        stream: false,
      })

      if (response.error) {
        error(`LLM error: ${response.error}`)
      }

      // 5. Parse response
      console.error("Parsing LLM response...")
      let replacements
      try {
        replacements = parseReplacements(response.content)
      } catch (e) {
        console.error("\n--- Raw LLM response ---")
        console.error(response.content)
        error(`Failed to parse LLM response: ${e instanceof Error ? e.message : String(e)}`)
      }

      const activeReplacements = replacements.filter((r) => r.new !== null)
      console.error(
        `LLM proposed ${activeReplacements.length} replacements (${replacements.length - activeReplacements.length} skipped)`,
      )

      // 6. Create editset
      const editset = migrateCreateEditset(matches, replacements)
      saveEditset(editset, outputFile)

      console.error(`\nSaved editset to ${outputFile}`)
      console.error(`Apply with: bun tools/refactor.ts editset.apply ${outputFile}`)

      output({
        editsetPath: outputFile,
        patterns,
        glob,
        matchCount: matches.length,
        fileCount: fileSummary.size,
        replacementCount: activeReplacements.length,
        skippedCount: replacements.length - activeReplacements.length,
        model: model.displayName,
        usage: response.usage,
      })
      break
    }

    default:
      error(`Unknown command: ${command}`)
  }
}

main().catch((err) => {
  error(err instanceof Error ? err.message : String(err))
})
