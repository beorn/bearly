/**
 * Dispatch context — replaces the `output-mode.ts` singleton with an
 * explicit object that flows through the dispatch chain.
 *
 * Why: the singleton (process-level mutable state via setJsonMode/isJsonMode)
 * is non-reentrant. Two parallel test workers, two threads in the same
 * process, or library embedding (a daemon that handles concurrent llm
 * requests with different output modes) all see each other's mode
 * mutations. A context object makes the mode explicit at every dispatch
 * boundary.
 *
 * Migration shape:
 *   - createDispatchContext({ jsonMode }) → returns { jsonMode, emit, content, stderr }
 *   - cli.ts builds one ctx at startup and threads it through
 *   - output-mode.ts is kept as a deprecated shim that calls into a default
 *     global ctx so library callers that haven't migrated still work
 *
 * The shim is marked deprecated; new code should accept ctx as a parameter.
 */

export interface DispatchContext {
  /** True when --json was passed. Library code reads this to route output. */
  readonly jsonMode: boolean
  /** Emit the final JSON envelope on stdout. Always exactly ONE line. */
  emit(envelope: Record<string, unknown>): void
  /** Emit response content. Legacy mode → stdout; JSON mode → stderr. */
  content(text: string): void
  /** Emit human-readable progress to stderr. Mode-agnostic. */
  stderr(text: string): void
}

export function createDispatchContext(opts: { jsonMode: boolean }): DispatchContext {
  const jsonMode = opts.jsonMode
  return {
    jsonMode,
    emit(envelope) {
      console.log(JSON.stringify(envelope))
    },
    content(text) {
      if (jsonMode) {
        console.error(text)
      } else {
        console.log(text)
      }
    },
    stderr(text) {
      console.error(text)
    },
  }
}

/**
 * Default global context — backs the deprecated `output-mode.ts` shim.
 * Mutated by setJsonMode() in the shim. Internal-only; new code should
 * thread an explicit ctx via createDispatchContext.
 */
let _defaultCtx: DispatchContext = createDispatchContext({ jsonMode: false })

/** @internal — used by output-mode.ts shim only. */
export function _setDefaultDispatchContext(ctx: DispatchContext): void {
  _defaultCtx = ctx
}

/** @internal — used by output-mode.ts shim only. */
export function _getDefaultDispatchContext(): DispatchContext {
  return _defaultCtx
}
