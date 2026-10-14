import { homedir } from "node:os"
import { join } from "node:path"

/** Native home observation for comparisons, never a path builder. */
export function nativeHome(): string {
  return homedir()
}

/** Resolve the configured home from the caller's environment. */
export function userHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const configured = (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim()
  return configured || nativeHome()
}

/** Expand a leading bare tilde or tilde slash using the caller's home. */
export function expandHomePath(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (path === "~") return userHome(env, platform)
  if (path.startsWith("~/")) return join(userHome(env, platform), path.slice(2))
  return path
}
