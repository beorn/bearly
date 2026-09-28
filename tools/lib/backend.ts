import path from "path"
import type { SymbolInfo, SymbolMatch, Reference, Editset } from "./core/types"

/**
 * Backend interface for refactoring operations.
 * Each backend (ts-morph, ast-grep, etc.) implements this interface.
 */
export interface RefactorBackend {
  name: string
  extensions: string[] // Files this backend handles (e.g., [".ts", ".tsx"])
  priority: number // Higher = preferred when multiple match

  // Discovery
  getSymbolAt?(file: string, line: number, col: number): SymbolInfo | null
  getReferences?(symbolKey: string): Reference[]
  findSymbols?(pattern: RegExp): SymbolMatch[]

  // Pattern-based (ast-grep style)
  findPatterns?(pattern: string, glob?: string): Reference[]

  // Proposal generation
  createRenameProposal?(symbolKey: string, newName: string): Editset
  createBatchRenameProposal?(pattern: RegExp, replacement: string): Editset
  createPatternReplaceProposal?(pattern: string, replacement: string, glob?: string): Editset
}

// Registry of backends
const backends: RefactorBackend[] = []

/**
 * Register a backend
 */
export function registerBackend(backend: RefactorBackend): void {
  backends.push(backend)
  backends.sort((a, b) => b.priority - a.priority) // Higher priority first
}

/**
 * Get backend for a specific file extension
 */
export function getBackendForFile(file: string): RefactorBackend | null {
  const ext = path.extname(file)
  return backends.find((b) => b.extensions.includes(ext) || b.extensions.includes("*")) ?? null
}

/**
 * Get all registered backends
 */
export function getBackends(): RefactorBackend[] {
  return [...backends]
}
