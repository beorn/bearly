/**
 * withProjectRoot — resolve the daemon's project root path.
 *
 * The project root is the filesystem scope that determines "one tribe daemon
 * per project root." Today it's just `process.cwd()` at boot — a single field,
 * but isolated as its own withX so tests can override it without touching env.
 */

import type { BaseTribe } from "./base.ts"

export interface WithProjectRoot {
  readonly projectRoot: string
}

export function withProjectRoot<T extends BaseTribe>(
  root: string = process.cwd(),
): (t: T) => T & WithProjectRoot {
  return (t) => ({ ...t, projectRoot: root })
}
