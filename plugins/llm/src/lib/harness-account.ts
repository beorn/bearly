import { lstatSync, readlinkSync } from "node:fs"
import { join } from "node:path"

/** Printed on a Claude harness leg when no login can be named. */
export const NO_CLAUDE_LOGIN = "no Claude login resolved"

/**
 * Account encoded by a CLAUDE_CONFIG_DIR path.
 *
 * ag names the profile directory `…/profiles/claude/<account>/`
 * (hab-core `CALLER_ACCOUNT_PROFILE_ENV_KEYS`). The path string is the
 * source. This never calls `ag status`.
 */
export function claudeAccountFromConfigDir(configDir: string): string | undefined {
  const parts = configDir.split("/").filter((part) => part.length > 0)
  for (let i = 0; i < parts.length - 2; i++) {
    if (parts[i] === "profiles" && parts[i + 1] === "claude") {
      const account = parts[i + 2]
      if (!account || account === "default" || account === "." || account === "..") return undefined
      return account
    }
  }
  return undefined
}

/**
 * ag's configured default Claude profile: basename of the `default` symlink.
 *
 * Same read as `getDefaultProfile` in ag-accounts-core `profile-slots.ts`.
 * `CLAUDE_PROFILE_ROOT` is that package's escape hatch. Otherwise the root is
 * `~/.config/ag/profiles/claude`, matching `primaryClaudeProfilesRoot`.
 */
export function agDefaultClaudeProfile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = env.HOME ?? ""
  const root = env.CLAUDE_PROFILE_ROOT || (home ? join(home, ".config", "ag", "profiles", "claude") : "")
  if (!root) return undefined
  const link = join(root, "default")
  try {
    if (!lstatSync(link).isSymbolicLink()) return undefined
    const target = readlinkSync(link)
    const base = target.includes("/") ? target.split("/").filter(Boolean).pop() : target
    if (!base || base === "default" || base === "." || base === "..") return undefined
    if (base.length > 128 || !/^[A-Za-z0-9._+@-]+$/.test(base)) return undefined
    return base
  } catch {
    // silent-fallback-allow: an absent default symlink is ag's normal no-default state, and the dry-run line says "no Claude login resolved".
    return undefined
  }
}

/**
 * Claude account for a harness dry-run leg.
 * CLAUDE_CONFIG_DIR wins. Unset falls through to ag's default profile.
 * A set path that does not encode an account does not fall through.
 */
export function resolveClaudeHarnessAccount(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim()
  if (dir) return claudeAccountFromConfigDir(dir) ?? NO_CLAUDE_LOGIN
  return agDefaultClaudeProfile(env) ?? NO_CLAUDE_LOGIN
}
