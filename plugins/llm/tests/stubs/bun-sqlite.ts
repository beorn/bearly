/**
 * No-op shim for `bun:sqlite` under vitest (node runtime).
 *
 * @bearly/llm transitively imports `bun:sqlite` through @bearly/recall (history
 * search + FTS5). The regression suite never touches history, so we satisfy the
 * import with a stub that throws loudly if any test path actually tries to open
 * a database. Swap to `better-sqlite3` if that changes.
 */

class Stmt {
  all(): unknown[] {
    return []
  }
  get(): undefined {
    return undefined
  }
  run(): { changes: number; lastInsertRowid: number } {
    return { changes: 0, lastInsertRowid: 0 }
  }
  iterate(): Iterable<unknown> {
    return [][Symbol.iterator]()
  }
  values(): unknown[] {
    return []
  }
  as(): this {
    return this
  }
}

export class Database {
  constructor(_path?: string, _options?: unknown) {
    /* no-op */
  }
  query(_sql: string): Stmt {
    return new Stmt()
  }
  prepare(_sql: string): Stmt {
    return new Stmt()
  }
  exec(_sql: string): void {
    /* no-op */
  }
  run(_sql: string, ..._params: unknown[]): void {
    /* no-op */
  }
  close(): void {
    /* no-op */
  }
  transaction<T extends (...args: any[]) => any>(fn: T): T {
    return fn
  }
}

export default { Database }
