import { z } from "zod"

// Symbol found at a location
export const SymbolInfo = z.object({
  symbolKey: z.string(), // stable ID: "file:line:col:name"
  name: z.string(),
  kind: z.enum(["variable", "function", "type", "interface", "property", "class", "method", "parameter"]),
  file: z.string(),
  line: z.number(),
  column: z.number(),
})
export type SymbolInfo = z.infer<typeof SymbolInfo>

// Semantic kind of a reference (simplified for LLM)
export const RefKind = z.enum(["call", "decl", "type", "string", "comment"])
export type RefKind = z.infer<typeof RefKind>

// A reference to a symbol
export const Reference = z.object({
  refId: z.string(), // stable ID: hash(file + range)
  file: z.string(),
  range: z.tuple([z.number(), z.number(), z.number(), z.number()]), // [startLine, startCol, endLine, endCol]
  preview: z.string(), // context line (legacy, kept for compatibility)
  checksum: z.string(), // file checksum at proposal time
  selected: z.boolean().default(true),
  // Enriched fields for LLM (all optional for backwards compatibility)
  line: z.number().optional(), // 1-indexed line number (defaults to range[0])
  kind: RefKind.optional(), // semantic kind: call, decl, type, string, comment
  scope: z.string().nullable().optional(), // enclosing function/class or null
  ctx: z.array(z.string()).optional(), // context lines with ► marker
  replace: z.string().nullable().optional(), // null = skip, string = replacement
})
export type Reference = z.infer<typeof Reference>

// A single edit operation.
//
// Offsets are CHARACTER offsets — JS string indices, the unit `String.slice` uses.
// Never byte offsets: a backend that searches in bytes (ripgrep, ast-grep) converts
// at its own boundary. `before` is what makes that claim checkable — the applier
// re-reads the file and refuses to write when the text at the offset isn't the text
// the backend said it matched.
export const Edit = z.object({
  file: z.string(),
  offset: z.number(), // character offset (JS string index, NOT byte offset)
  length: z.number(), // characters to replace (JS string length, NOT byte length)
  replacement: z.string(),
  // The exact text at [offset, offset+length) when the edit was proposed.
  // Optional only so editsets written by older versions still parse; the applier
  // rejects an edit that lacks it rather than writing something it cannot check.
  before: z.string().optional(),
  // The refId of the Reference this edit implements. This is what lets selection work
  // per-reference instead of per-file: a producer sets it to the SAME refId it gave the
  // matching Reference, and filterEditset()/applyPatch() key off it to keep or drop this
  // exact edit — never "every edit in a file that has at least one selected ref".
  // Optional only so editsets written by older versions still parse; filterEditset() and
  // applyPatch() refuse to scope selection on an edit that lacks it rather than silently
  // falling back to file-granularity (the bug this field exists to close).
  refId: z.string().optional(),
})
export type Edit = z.infer<typeof Edit>

// Complete editset (rename proposal)
export const Editset = z.object({
  id: z.string(), // "rename-widget-to-gadget-1706000000"
  operation: z.literal("rename"),
  symbolKey: z.string().optional(), // for single-symbol renames
  pattern: z.string().optional(), // for batch renames
  from: z.string(),
  to: z.string(),
  refs: z.array(Reference),
  edits: z.array(Edit),
  createdAt: z.string(),
})
export type Editset = z.infer<typeof Editset>

// Symbol discovery result (for batch operations)
export const SymbolMatch = z.object({
  symbolKey: z.string(),
  name: z.string(),
  kind: z.string(),
  file: z.string(),
  line: z.number(),
  refCount: z.number(),
})
export type SymbolMatch = z.infer<typeof SymbolMatch>

// Command outputs
export const SymbolAtOutput = SymbolInfo
export type SymbolAtOutput = SymbolInfo

export const RefsListOutput = z.array(Reference.omit({ selected: true }))
export type RefsListOutput = z.infer<typeof RefsListOutput>

export const ProposeOutput = z.object({
  editsetPath: z.string(),
  refCount: z.number(),
  fileCount: z.number(),
  symbolCount: z.number().optional(), // for batch renames
})
export type ProposeOutput = z.infer<typeof ProposeOutput>

export const ApplyOutput = z.object({
  applied: z.number(),
  skipped: z.number(),
  driftDetected: z.array(
    z.object({
      file: z.string(),
      reason: z.string(),
    }),
  ),
})
export type ApplyOutput = z.infer<typeof ApplyOutput>

export const SymbolsFindOutput = z.array(SymbolMatch)
export type SymbolsFindOutput = z.infer<typeof SymbolsFindOutput>

// Conflict detection for batch renames
export const Conflict = z.object({
  from: z.string(), // original name
  to: z.string(), // proposed new name
  existingSymbol: z.string(), // symbolKey of conflicting existing symbol
  suggestion: z.string(), // suggested resolution
})
export type Conflict = z.infer<typeof Conflict>

export const SafeRename = z.object({
  from: z.string(),
  to: z.string(),
})
export type SafeRename = z.infer<typeof SafeRename>

export const ConflictReport = z.object({
  conflicts: z.array(Conflict),
  safe: z.array(SafeRename),
})
export type ConflictReport = z.infer<typeof ConflictReport>

// File operation types
export const FileOp = z.object({
  opId: z.string(), // unique ID for this operation
  type: z.enum(["rename", "move"]),
  oldPath: z.string(), // absolute or relative path
  newPath: z.string(),
  checksum: z.string(), // file checksum at proposal time
})
export type FileOp = z.infer<typeof FileOp>

export const FileEditset = z.object({
  id: z.string(), // "file-rename-repo-to-repo-1706000000"
  operation: z.literal("file-rename"),
  pattern: z.string().optional(), // glob pattern used
  replacement: z.string().optional(), // replacement pattern
  fileOps: z.array(FileOp), // files to rename
  importEdits: z.array(Edit), // import path updates
  createdAt: z.string(),
})
export type FileEditset = z.infer<typeof FileEditset>

export const FileConflict = z.object({
  oldPath: z.string(),
  newPath: z.string(),
  reason: z.enum(["target_exists", "same_path"]),
  existingPath: z.string().optional(),
})
export type FileConflict = z.infer<typeof FileConflict>

export const FileRenameReport = z.object({
  conflicts: z.array(FileConflict),
  safe: z.array(FileOp),
})
export type FileRenameReport = z.infer<typeof FileRenameReport>
