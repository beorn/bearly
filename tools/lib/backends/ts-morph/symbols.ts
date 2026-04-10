import { Project, Node, SourceFile, Identifier } from "ts-morph"
import type { SymbolInfo, SymbolMatch, Reference, RefKind } from "../../core/types"
import { computeChecksum, computeRefId } from "../../core/apply"

// Default context lines before/after match
const DEFAULT_CONTEXT_LINES = 2

/**
 * Get symbol info at a specific location
 */
export function getSymbolAt(project: Project, filePath: string, line: number, column: number): SymbolInfo | null {
  const sourceFile = project.getSourceFile(filePath)
  if (!sourceFile) return null

  const pos = sourceFile.compilerNode.getPositionOfLineAndCharacter(line - 1, column - 1)
  const node = findIdentifierAt(sourceFile, pos)
  if (!node) return null

  const name = node.getText()
  const kind = getSymbolKind(node)
  const startLine = node.getStartLineNumber()
  const startCol = node.getStart() - sourceFile.compilerNode.getPositionOfLineAndCharacter(startLine - 1, 0) + 1

  return {
    symbolKey: `${filePath}:${startLine}:${startCol}:${name}`,
    name,
    kind,
    file: filePath,
    line: startLine,
    column: startCol,
  }
}

/**
 * Find all references to a symbol
 */
export function getReferences(project: Project, symbolKey: string, contextLines = DEFAULT_CONTEXT_LINES): Reference[] {
  const [filePath, lineStr, colStr, name] = symbolKey.split(":")
  const line = parseInt(lineStr!, 10)
  const column = parseInt(colStr!, 10)

  const sourceFile = project.getSourceFile(filePath!)
  if (!sourceFile) return []

  const pos = sourceFile.compilerNode.getPositionOfLineAndCharacter(line - 1, column - 1)
  const node = findIdentifierAt(sourceFile, pos)
  if (!node) return []

  const refs = node.findReferencesAsNodes?.() || []
  const references: Reference[] = []

  for (const ref of refs) {
    const refFile = ref.getSourceFile()
    const refFilePath = refFile.getFilePath().replace(process.cwd() + "/", "")
    const startLine = ref.getStartLineNumber()
    const endLine = ref.getEndLineNumber()
    const lineStart = refFile.compilerNode.getPositionOfLineAndCharacter(startLine - 1, 0)
    const startCol = ref.getStart() - lineStart + 1
    const endCol = ref.getEnd() - refFile.compilerNode.getPositionOfLineAndCharacter(endLine - 1, 0) + 1

    // Get all lines for context
    const allLines = refFile.getFullText().split("\n")
    const preview = allLines[startLine - 1]?.trim() || ""

    // Build context with ► marker
    const ctx = buildContext(allLines, startLine, contextLines)

    // Get semantic kind and scope
    const kind = getRefKind(ref)
    const scope = getEnclosingScope(ref)

    // Compute file checksum
    const checksum = computeChecksum(refFile.getFullText())

    // Stable refId
    const refId = computeRefId(refFilePath, startLine, startCol, endLine, endCol)

    references.push({
      refId,
      file: refFilePath,
      line: startLine,
      range: [startLine, startCol, endLine, endCol],
      preview,
      checksum,
      selected: true,
      kind,
      scope,
      ctx,
      replace: null, // Will be set to default replacement later
    })
  }

  return references
}

/**
 * Find ALL symbols in the codebase (for conflict detection)
 */
export function findAllSymbols(project: Project): SymbolMatch[] {
  return findSymbols(project, /.*/) // Match everything
}

/**
 * Find all symbols matching a pattern
 */
export function findSymbols(project: Project, pattern: RegExp): SymbolMatch[] {
  const matches: SymbolMatch[] = []
  const seen = new Set<string>()

  // The incoming pattern may have the `g` flag (required upstream for
  // .replace() case-preserving semantics). `.test()` on a global regex is
  // stateful — it advances lastIndex and skips matches on subsequent calls,
  // so we build a local non-global copy for match testing only.
  const testPattern = new RegExp(pattern.source, pattern.flags.replace("g", ""))

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath().replace(process.cwd() + "/", "")
    if (filePath.includes("node_modules")) continue

    // Interfaces
    for (const intf of sourceFile.getInterfaces()) {
      const name = intf.getName()
      if (testPattern.test(name)) {
        addMatch(intf.getNameNode(), "interface")
      }
      // Properties within interfaces
      for (const prop of intf.getProperties()) {
        const propName = prop.getName()
        if (testPattern.test(propName)) {
          addMatch(prop.getNameNode(), "property")
        }
      }
    }

    // Type aliases
    for (const typeAlias of sourceFile.getTypeAliases()) {
      if (testPattern.test(typeAlias.getName())) {
        addMatch(typeAlias.getNameNode(), "type")
      }
    }

    // Functions
    for (const func of sourceFile.getFunctions()) {
      const name = func.getName()
      if (name && testPattern.test(name)) {
        addMatch(func.getNameNode()!, "function")
      }
    }

    // Variables and parameters (including destructuring patterns)
    sourceFile.forEachDescendant((node) => {
      // Variable declarations: const foo = ... or const { foo } = ...
      if (Node.isVariableDeclaration(node)) {
        const nameNode = node.getNameNode()
        if (Node.isIdentifier(nameNode)) {
          const name = nameNode.getText()
          if (testPattern.test(name)) {
            addMatch(nameNode, "variable")
          }
        } else if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
          addBindingPatternMatches(nameNode)
        }
      }
      // Function/arrow parameters: (foo) => ... or ({ foo }) => ...
      else if (Node.isParameterDeclaration(node)) {
        const nameNode = node.getNameNode()
        if (Node.isIdentifier(nameNode)) {
          const name = nameNode.getText()
          if (testPattern.test(name)) {
            addMatch(nameNode, "parameter")
          }
        } else if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
          addBindingPatternMatches(nameNode)
        }
      }
    })

    // Helper to extract identifiers from destructuring patterns
    function addBindingPatternMatches(bindingPattern: Node) {
      bindingPattern.forEachDescendant((bindingNode) => {
        if (Node.isBindingElement(bindingNode)) {
          const bindingName = bindingNode.getNameNode()
          if (Node.isIdentifier(bindingName)) {
            const name = bindingName.getText()
            if (testPattern.test(name)) {
              addMatch(bindingName, "variable")
            }
          }
        }
      })
    }

    // Classes and class members
    for (const cls of sourceFile.getClasses()) {
      const name = cls.getName()
      if (name && testPattern.test(name)) {
        addMatch(cls.getNameNode()!, "class")
      }
      // Class methods
      for (const method of cls.getMethods()) {
        const methodName = method.getName()
        if (testPattern.test(methodName)) {
          addMatch(method.getNameNode(), "method")
        }
      }
      // Class properties
      for (const prop of cls.getProperties()) {
        const propName = prop.getName()
        if (testPattern.test(propName)) {
          addMatch(prop.getNameNode(), "property")
        }
      }
    }
  }

  // Sort by reference count (most used first)
  return matches.sort((a, b) => b.refCount - a.refCount)

  function addMatch(node: Node, kind: string) {
    const name = node.getText()
    const startLine = node.getStartLineNumber()
    const sf = node.getSourceFile()
    const fp = sf.getFilePath().replace(process.cwd() + "/", "")
    const lineStart = sf.compilerNode.getPositionOfLineAndCharacter(startLine - 1, 0)
    const startCol = node.getStart() - lineStart + 1

    const key = `${fp}:${startLine}:${startCol}:${name}`
    if (seen.has(key)) return
    seen.add(key)

    // Cast to Identifier since all nodes passed here are identifiers
    const identifier = node as Identifier
    const refCount = identifier.findReferencesAsNodes?.()?.length || 0
    matches.push({
      symbolKey: key,
      name,
      kind,
      file: fp,
      line: startLine,
      refCount,
    })
  }
}

/**
 * Compute the new name for a symbol rename.
 *
 * Case handling is driven by the pattern's flags:
 *
 * - **No `i` flag (case-sensitive)**: replacement applied literally. This is the
 *   correct behavior for code identifier renames, where mixed case like
 *   `screenRect` must be preserved exactly as the user wrote it.
 *
 * - **With `i` flag (case-insensitive)**: replacement case-matches the match.
 *   This is the correct behavior for prose terminology migrations, where
 *   `widget`/`Widget`/`WIDGET` all need to become `gadget`/`Gadget`/`GADGET`.
 *
 * Examples:
 *   computeNewName("screenRect",   /screenRect/,  "scrollRect") → "scrollRect"
 *   computeNewName("useScreenRect",/screenRect/,  "scrollRect") → "useScrollRect"
 *   computeNewName("widget",       /widget/i,     "gadget")     → "gadget"
 *   computeNewName("Widget",       /widget/i,     "gadget")     → "Gadget"
 *   computeNewName("WIDGET",       /widget/i,     "gadget")     → "GADGET"
 */
export function computeNewName(oldName: string, pattern: RegExp, replacement: string): string {
  const caseInsensitive = pattern.flags.includes("i")

  return oldName.replace(pattern, (match) => {
    if (!caseInsensitive) {
      // Case-sensitive match → literal replacement. Do not touch the casing of
      // the user-supplied replacement string.
      return replacement
    }
    // Case-insensitive match → case-match the replacement to the original.
    // SCREAMING_CASE: entire match is uppercase
    if (match === match.toUpperCase() && match.length > 1) {
      return replacement.toUpperCase()
    }
    // PascalCase: first char is uppercase
    if (match[0] === match[0]!.toUpperCase()) {
      return replacement[0]!.toUpperCase() + replacement.slice(1)
    }
    // camelCase/lowercase
    return replacement.toLowerCase()
  })
}

// Helper functions

function findIdentifierAt(sourceFile: SourceFile, pos: number): Identifier | null {
  let result: Identifier | null = null

  sourceFile.forEachDescendant((node) => {
    if (node.getStart() <= pos && pos < node.getEnd()) {
      if (Node.isIdentifier(node)) {
        result = node
      }
    }
  })

  return result
}

function getSymbolKind(
  node: Node,
): "variable" | "function" | "type" | "interface" | "property" | "class" | "method" | "parameter" {
  const parent = node.getParent()
  if (!parent) return "variable"

  if (Node.isInterfaceDeclaration(parent)) return "interface"
  if (Node.isTypeAliasDeclaration(parent)) return "type"
  if (Node.isFunctionDeclaration(parent)) return "function"
  if (Node.isClassDeclaration(parent)) return "class"
  if (Node.isMethodDeclaration(parent)) return "method"
  if (Node.isPropertySignature(parent)) return "property"
  if (Node.isPropertyDeclaration(parent)) return "property"
  if (Node.isParameterDeclaration(parent)) return "parameter"
  if (Node.isVariableDeclaration(parent)) return "variable"

  return "variable"
}

/**
 * Build context lines with ► marker on match line
 */
function buildContext(allLines: string[], matchLine: number, contextLines: number): string[] {
  const startLine = Math.max(0, matchLine - 1 - contextLines)
  const endLine = Math.min(allLines.length, matchLine + contextLines)

  const ctx: string[] = []
  for (let i = startLine; i < endLine; i++) {
    const line = allLines[i] ?? ""
    if (i === matchLine - 1) {
      ctx.push(`► ${line}`)
    } else {
      ctx.push(`  ${line}`)
    }
  }
  return ctx
}

/**
 * Get semantic kind of a reference (simplified for LLM)
 */
function getRefKind(node: Node): RefKind {
  const parent = node.getParent()
  if (!parent) return "decl"

  // Call expressions: foo(), obj.foo()
  if (Node.isCallExpression(parent)) return "call"
  if (Node.isPropertyAccessExpression(parent) && Node.isCallExpression(parent.getParent())) {
    return "call"
  }

  // Type references: : Foo, <Foo>, extends Foo
  if (Node.isTypeReference(parent)) return "type"
  if (Node.isTypeAliasDeclaration(parent)) return "type"
  if (Node.isInterfaceDeclaration(parent)) return "type"

  // String literals
  if (Node.isStringLiteral(node) || Node.isTemplateExpression(node)) {
    return "string"
  }

  // Comments would need special handling - for now treat as decl
  // (ts-morph doesn't easily expose comments as nodes)

  // Everything else is a declaration/reference
  return "decl"
}

/**
 * Get enclosing scope (function/class name or null for top-level)
 */
function getEnclosingScope(node: Node): string | null {
  let current = node.getParent()

  while (current) {
    // Function declaration: function foo() {}
    if (Node.isFunctionDeclaration(current)) {
      return current.getName() ?? null
    }
    // Arrow function / function expression in variable: const foo = () => {}
    if (Node.isVariableDeclaration(current)) {
      const init = current.getInitializer()
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        return current.getName()
      }
    }
    // Method: class Foo { bar() {} }
    if (Node.isMethodDeclaration(current)) {
      return current.getName()
    }
    // Class
    if (Node.isClassDeclaration(current)) {
      return current.getName() ?? null
    }

    current = current.getParent()
  }

  return null // Top-level
}
