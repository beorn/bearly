/**
 * Tribe install / uninstall / doctor — Claude Code setup automation.
 *
 * Goal: one command to wire up the hooks in `~/.claude/settings.json` and the
 * `tribe` MCP server in the project's `.mcp.json`, so users don't have to
 * hand-edit JSON to get the tribe running.
 *
 * Shape:
 *  - `planInstall(env)` produces an `InstallPlan` — pure, no writes.
 *  - `applyInstall(plan)` performs the writes.
 *  - `planUninstall(env)` / `applyUninstall(plan)` are the inverse.
 *  - `doctorReport(env)` is read-only diagnostics.
 *
 * The split lets us surface `--dry-run` trivially and keeps testing easy:
 * construct an `env` with fixture paths, call `planInstall`, assert on the
 * returned plan without touching the real filesystem.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, relative, resolve } from "node:path"
import { resolveSocketPath, probeDaemonPid } from "./socket.ts"
import {
  DEFAULT_AUTOSTART,
  readTribeConfig,
  resolveConfigPath,
  writeTribeConfig,
  type TribeAutostart,
} from "./autostart-config.ts"
import { resolveLoreSocketPath } from "../../../plugins/tribe/lore/lib/config.ts"

// ---------------------------------------------------------------------------
// Marker — used to identify tribe-installed hook entries
// ---------------------------------------------------------------------------

/** Stable substring we look for to identify "our" hook entries in settings.json. */
export const TRIBE_HOOK_MARKER = "tribe-cli.ts hook "

/** Claude Code hook events we install handlers for. */
export const TRIBE_HOOK_EVENTS = [
  { claudeName: "SessionStart", tribeArg: "session-start" },
  { claudeName: "UserPromptSubmit", tribeArg: "prompt" },
  { claudeName: "SessionEnd", tribeArg: "session-end" },
  { claudeName: "PreCompact", tribeArg: "pre-compact" },
] as const

// ---------------------------------------------------------------------------
// Environment — everything the install/doctor logic depends on
// ---------------------------------------------------------------------------

export interface InstallEnv {
  /** Path to `~/.claude/settings.json` (overridable for tests). */
  claudeSettingsPath: string
  /** Path to the tribe-cli.ts entry point. Absolute. Used in hook commands. */
  tribeCliPath: string
  /** `bun` executable path. Used to prefix hook commands. */
  bunPath: string
  /** Current working directory — where to look for `.mcp.json`. */
  cwd: string
  /** Absolute path to the tribe lore MCP server script. */
  loreServerPath: string
  /** Key under `mcpServers` to use (default `tribe`). */
  mcpName: string
  /** Path to the autostart config file (default `~/.claude/tribe/config.json`). */
  autostartConfigPath: string
}

export function defaultInstallEnv(overrides: Partial<InstallEnv> = {}): InstallEnv {
  const claudeDir = overrides.claudeSettingsPath ? dirname(overrides.claudeSettingsPath) : resolve(homedir(), ".claude")
  const cliDir = dirname(new URL(import.meta.url).pathname)
  // tools/lib/tribe → tools
  const toolsDir = resolve(cliDir, "..", "..")
  const bearlyRoot = resolve(toolsDir, "..")
  return {
    claudeSettingsPath: resolve(claudeDir, "settings.json"),
    tribeCliPath: resolve(toolsDir, "tribe-cli.ts"),
    bunPath: process.execPath,
    cwd: process.cwd(),
    loreServerPath: resolve(bearlyRoot, "plugins/tribe/lore/server.ts"),
    mcpName: "tribe",
    autostartConfigPath: resolveConfigPath(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// JSON helpers — safe read, in-memory patch
// ---------------------------------------------------------------------------

function readJsonOrEmpty(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, "utf-8")
    if (!raw.trim()) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8")
}

// ---------------------------------------------------------------------------
// Install — plan
// ---------------------------------------------------------------------------

export interface HookChange {
  event: string
  action: "add" | "update" | "unchanged"
  command: string
  previousCommand?: string
}

export interface McpChange {
  action: "add" | "update" | "unchanged" | "skip"
  reason?: string
  name: string
  command?: string
  args?: string[]
}

export interface AutostartChange {
  action: "add" | "update" | "unchanged"
  requested: TribeAutostart
  current: TribeAutostart | null
}

export interface InstallPlan {
  env: InstallEnv
  settingsExists: boolean
  mcpPath: string | null
  hooks: HookChange[]
  /** The merged settings object that applyInstall will write. */
  nextSettings: Record<string, unknown>
  /** The merged .mcp.json object (null if we're skipping). */
  nextMcp: Record<string, unknown> | null
  mcp: McpChange
  /** Autostart config change. */
  autostart: AutostartChange
}

interface HookEntry {
  type: string
  command: string
}
interface HookMatcher {
  matcher?: string
  hooks: HookEntry[]
}

function buildHookCommand(env: InstallEnv, tribeArg: string): string {
  return `${env.bunPath} ${env.tribeCliPath} hook ${tribeArg}`
}

function findTribeIndex(matchers: HookMatcher[], tribeArg: string): { mi: number; hi: number } | null {
  for (let mi = 0; mi < matchers.length; mi++) {
    const m = matchers[mi]
    if (!m || !Array.isArray(m.hooks)) continue
    for (let hi = 0; hi < m.hooks.length; hi++) {
      const h = m.hooks[hi]
      if (!h || typeof h.command !== "string") continue
      if (h.command.includes(TRIBE_HOOK_MARKER) && h.command.trimEnd().endsWith(` ${tribeArg}`)) {
        return { mi, hi }
      }
    }
  }
  return null
}

export function planInstall(env: InstallEnv, opts: { autostart?: TribeAutostart } = {}): InstallPlan {
  const requestedAutostart: TribeAutostart = opts.autostart ?? DEFAULT_AUTOSTART
  const settings = readJsonOrEmpty(env.claudeSettingsPath)
  const settingsExists = existsSync(env.claudeSettingsPath)

  // Deep-clone the hooks subtree so the plan's nextSettings is independent
  // of the source-of-truth — callers can dry-run freely.
  const hooksTree = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<
    string,
    HookMatcher[]
  >
  const nextHooks: Record<string, HookMatcher[]> = {}
  for (const [k, v] of Object.entries(hooksTree)) {
    nextHooks[k] = Array.isArray(v) ? v.map((m) => ({ ...m, hooks: [...(m.hooks ?? [])] })) : []
  }

  const hookChanges: HookChange[] = []
  for (const { claudeName, tribeArg } of TRIBE_HOOK_EVENTS) {
    const desiredCommand = buildHookCommand(env, tribeArg)
    const matchers = (nextHooks[claudeName] ?? []) as HookMatcher[]
    nextHooks[claudeName] = matchers
    const found = findTribeIndex(matchers, tribeArg)
    if (found) {
      const m = matchers[found.mi]!
      const existing = m.hooks[found.hi]!
      if (existing.command === desiredCommand) {
        hookChanges.push({ event: claudeName, action: "unchanged", command: desiredCommand })
      } else {
        hookChanges.push({
          event: claudeName,
          action: "update",
          command: desiredCommand,
          previousCommand: existing.command,
        })
        m.hooks[found.hi] = { type: "command", command: desiredCommand }
      }
    } else {
      hookChanges.push({ event: claudeName, action: "add", command: desiredCommand })
      matchers.push({ matcher: "", hooks: [{ type: "command", command: desiredCommand }] })
    }
  }

  const nextSettings: Record<string, unknown> = { ...settings, hooks: nextHooks }

  // MCP
  const mcpPath = resolve(env.cwd, ".mcp.json")
  let mcp: McpChange
  let nextMcp: Record<string, unknown> | null = null
  if (!existsSync(mcpPath)) {
    mcp = { action: "skip", name: env.mcpName, reason: "no .mcp.json in cwd" }
  } else {
    const mcpJson = readJsonOrEmpty(mcpPath)
    const servers = (
      mcpJson.mcpServers && typeof mcpJson.mcpServers === "object"
        ? { ...(mcpJson.mcpServers as Record<string, unknown>) }
        : {}
    ) as Record<string, { command?: string; args?: string[] }>
    // Emit a project-relative path if the server lives under cwd (portable
    // when the project is cloned with bearly as a submodule). Otherwise
    // absolute (e.g. bearly installed via npm in node_modules).
    const rel = relative(env.cwd, env.loreServerPath)
    const serverArg = rel.startsWith("..") ? env.loreServerPath : rel
    const desired = { command: "bun", args: [serverArg] }
    const existing = servers[env.mcpName]
    if (existing && existing.command === desired.command && sameArgs(existing.args, desired.args)) {
      mcp = { action: "unchanged", name: env.mcpName, command: desired.command, args: desired.args }
    } else if (existing) {
      mcp = { action: "update", name: env.mcpName, command: desired.command, args: desired.args }
      servers[env.mcpName] = desired
    } else {
      mcp = { action: "add", name: env.mcpName, command: desired.command, args: desired.args }
      servers[env.mcpName] = desired
    }
    nextMcp = { ...mcpJson, mcpServers: servers }
  }

  // Autostart config change
  const configFileExists = existsSync(env.autostartConfigPath)
  const currentAutostart: TribeAutostart | null = configFileExists
    ? readTribeConfig(env.autostartConfigPath).autostart
    : null
  let autostartChange: AutostartChange
  if (currentAutostart === null) {
    autostartChange = { action: "add", requested: requestedAutostart, current: null }
  } else if (currentAutostart === requestedAutostart) {
    autostartChange = { action: "unchanged", requested: requestedAutostart, current: currentAutostart }
  } else {
    autostartChange = { action: "update", requested: requestedAutostart, current: currentAutostart }
  }

  return {
    env,
    settingsExists,
    mcpPath: existsSync(mcpPath) ? mcpPath : null,
    hooks: hookChanges,
    nextSettings,
    nextMcp,
    mcp,
    autostart: autostartChange,
  }
}

function sameArgs(a?: string[], b?: string[]): boolean {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function applyInstall(plan: InstallPlan): void {
  writeJson(plan.env.claudeSettingsPath, plan.nextSettings)
  if (plan.mcpPath && plan.nextMcp) {
    writeJson(plan.mcpPath, plan.nextMcp)
  }
  if (plan.autostart.action !== "unchanged") {
    writeTribeConfig(plan.env.autostartConfigPath, { autostart: plan.autostart.requested })
  }
}

export function formatInstallPlan(plan: InstallPlan, dryRun: boolean): string {
  const lines: string[] = []
  lines.push(`${dryRun ? "[dry-run] " : ""}tribe install`)
  lines.push(`  settings: ${plan.env.claudeSettingsPath}${plan.settingsExists ? "" : " (will create)"}`)
  for (const h of plan.hooks) {
    const tag = h.action === "unchanged" ? "  ok" : h.action === "add" ? " add" : " upd"
    lines.push(`    [${tag}] ${h.event}: ${h.command}`)
    if (h.action === "update" && h.previousCommand) {
      lines.push(`          was: ${h.previousCommand}`)
    }
  }
  if (plan.mcp.action === "skip") {
    lines.push(`  mcp: skipped (${plan.mcp.reason ?? "no .mcp.json"})`)
  } else {
    lines.push(`  mcp: ${plan.mcpPath}`)
    const tag = plan.mcp.action === "unchanged" ? "  ok" : plan.mcp.action === "add" ? " add" : " upd"
    lines.push(`    [${tag}] mcpServers.${plan.mcp.name}: bun ${(plan.mcp.args ?? []).join(" ")}`)
  }
  lines.push(`  autostart: ${plan.env.autostartConfigPath}`)
  const a = plan.autostart
  if (a.action === "unchanged") {
    lines.push(`    [  ok] autostart: ${a.requested}`)
  } else if (a.action === "add") {
    lines.push(`    [ add] autostart: ${a.requested}`)
  } else {
    lines.push(`    [ upd] autostart: ${a.current} → ${a.requested}`)
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

export interface UninstallPlan {
  env: InstallEnv
  hooks: Array<{ event: string; action: "remove" | "none"; command?: string }>
  mcp: { action: "remove" | "none"; name?: string }
  mcpPath: string | null
  nextSettings: Record<string, unknown>
  nextMcp: Record<string, unknown> | null
}

export function planUninstall(env: InstallEnv): UninstallPlan {
  const settings = readJsonOrEmpty(env.claudeSettingsPath)
  const hooksTree = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<
    string,
    HookMatcher[]
  >
  const nextHooks: Record<string, HookMatcher[]> = {}
  for (const [k, v] of Object.entries(hooksTree)) {
    nextHooks[k] = Array.isArray(v) ? v.map((m) => ({ ...m, hooks: [...(m.hooks ?? [])] })) : []
  }
  const hookChanges: UninstallPlan["hooks"] = []
  for (const { claudeName, tribeArg } of TRIBE_HOOK_EVENTS) {
    const matchers = nextHooks[claudeName] ?? []
    let removed: string | undefined
    for (let mi = matchers.length - 1; mi >= 0; mi--) {
      const m = matchers[mi]!
      if (!Array.isArray(m.hooks)) continue
      for (let hi = m.hooks.length - 1; hi >= 0; hi--) {
        const h = m.hooks[hi]!
        if (
          typeof h.command === "string" &&
          h.command.includes(TRIBE_HOOK_MARKER) &&
          h.command.trimEnd().endsWith(` ${tribeArg}`)
        ) {
          removed = h.command
          m.hooks.splice(hi, 1)
        }
      }
      if (m.hooks.length === 0) matchers.splice(mi, 1)
    }
    if (matchers.length === 0) delete nextHooks[claudeName]
    else nextHooks[claudeName] = matchers
    hookChanges.push(
      removed ? { event: claudeName, action: "remove", command: removed } : { event: claudeName, action: "none" },
    )
  }

  const nextSettings: Record<string, unknown> = { ...settings, hooks: nextHooks }

  const mcpPath = resolve(env.cwd, ".mcp.json")
  let nextMcp: Record<string, unknown> | null = null
  let mcp: UninstallPlan["mcp"] = { action: "none" }
  if (existsSync(mcpPath)) {
    const mcpJson = readJsonOrEmpty(mcpPath)
    const servers = (
      mcpJson.mcpServers && typeof mcpJson.mcpServers === "object"
        ? { ...(mcpJson.mcpServers as Record<string, { command?: string; args?: string[] }>) }
        : {}
    ) as Record<string, { command?: string; args?: string[] }>
    const loreBasename = "tribe/lore/server.ts"
    const removeKey = (key: string): boolean => {
      const e = servers[key]
      if (!e) return false
      // Only remove if it looks like our tribe/lore server (guards against
      // users who happen to have an unrelated `lore` server configured).
      if (key === env.mcpName) {
        delete servers[key]
        return true
      }
      if (
        key === "lore" &&
        Array.isArray(e.args) &&
        e.args.some((a) => typeof a === "string" && a.includes(loreBasename))
      ) {
        delete servers[key]
        return true
      }
      return false
    }
    const removedTribe = removeKey(env.mcpName)
    const removedLore = env.mcpName !== "lore" ? removeKey("lore") : false
    if (removedTribe || removedLore) {
      mcp = { action: "remove", name: removedTribe ? env.mcpName : "lore" }
    }
    nextMcp = { ...mcpJson, mcpServers: servers }
  }

  return { env, hooks: hookChanges, mcp, mcpPath: existsSync(mcpPath) ? mcpPath : null, nextSettings, nextMcp }
}

export function applyUninstall(plan: UninstallPlan): void {
  writeJson(plan.env.claudeSettingsPath, plan.nextSettings)
  if (plan.mcpPath && plan.nextMcp) {
    writeJson(plan.mcpPath, plan.nextMcp)
  }
}

export function formatUninstallPlan(plan: UninstallPlan, dryRun: boolean): string {
  const lines: string[] = [`${dryRun ? "[dry-run] " : ""}tribe uninstall`]
  lines.push(`  settings: ${plan.env.claudeSettingsPath}`)
  for (const h of plan.hooks) {
    const tag = h.action === "remove" ? " rm " : "  ok"
    lines.push(`    [${tag}] ${h.event}${h.command ? `: ${h.command}` : ""}`)
  }
  if (plan.mcpPath) {
    lines.push(`  mcp: ${plan.mcpPath}`)
    if (plan.mcp.action === "remove") lines.push(`    [ rm ] mcpServers.${plan.mcp.name}`)
    else lines.push(`    [  ok] no tribe entry`)
  } else {
    lines.push(`  mcp: (no .mcp.json in cwd)`)
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Doctor — read-only diagnostics
// ---------------------------------------------------------------------------

export type DoctorLevel = "pass" | "warn" | "fail"

export interface DoctorCheck {
  name: string
  level: DoctorLevel
  message: string
  hint?: string
}

export interface DoctorReport {
  env: InstallEnv
  checks: DoctorCheck[]
  /** True if any check is "fail". */
  hasFailures: boolean
}

export async function doctorReport(env: InstallEnv): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []

  // 1. Claude settings.json
  if (!existsSync(env.claudeSettingsPath)) {
    checks.push({
      name: "claude-settings",
      level: "fail",
      message: `missing: ${env.claudeSettingsPath}`,
      hint: "run `tribe install` to create it",
    })
  } else {
    const settings = readJsonOrEmpty(env.claudeSettingsPath)
    const hooksTree = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<
      string,
      HookMatcher[]
    >
    for (const { claudeName, tribeArg } of TRIBE_HOOK_EVENTS) {
      const matchers = hooksTree[claudeName] ?? []
      const found = findTribeIndex(matchers, tribeArg)
      if (!found) {
        checks.push({
          name: `hook-${claudeName}`,
          level: "fail",
          message: `no tribe handler installed for ${claudeName}`,
          hint: "run `tribe install`",
        })
      } else {
        const cmd = matchers[found.mi]!.hooks[found.hi]!.command
        // Command format: `<bun> <tribe-cli> hook <event>`. Extract the path.
        const parts = cmd.split(/\s+/).filter(Boolean)
        const cliPath = parts.find((p) => p.endsWith("tribe-cli.ts"))
        if (!cliPath) {
          checks.push({
            name: `hook-${claudeName}`,
            level: "warn",
            message: `installed but command looks unusual: ${cmd}`,
          })
        } else if (!existsSync(cliPath)) {
          checks.push({
            name: `hook-${claudeName}`,
            level: "fail",
            message: `hook points at missing file: ${cliPath}`,
            hint: "run `tribe install` to refresh the path",
          })
        } else if (cliPath !== env.tribeCliPath) {
          checks.push({
            name: `hook-${claudeName}`,
            level: "warn",
            message: `hook path ${cliPath} differs from current cli ${env.tribeCliPath}`,
            hint: "run `tribe install` to refresh the path",
          })
        } else {
          checks.push({ name: `hook-${claudeName}`, level: "pass", message: `installed` })
        }
      }
    }
  }

  // 2. Project MCP
  const mcpPath = resolve(env.cwd, ".mcp.json")
  if (!existsSync(mcpPath)) {
    checks.push({
      name: "mcp-json",
      level: "warn",
      message: `no .mcp.json in ${env.cwd}`,
      hint: "not every project hosts MCP servers — this is only a problem if you expect tribe tools in Claude Code here",
    })
  } else {
    const mcpJson = readJsonOrEmpty(mcpPath)
    const servers = (
      mcpJson.mcpServers && typeof mcpJson.mcpServers === "object"
        ? (mcpJson.mcpServers as Record<string, { command?: string; args?: string[] }>)
        : {}
    ) as Record<string, { command?: string; args?: string[] }>
    const entry = servers[env.mcpName] ?? servers["lore"]
    const name = servers[env.mcpName] ? env.mcpName : "lore"
    if (!entry) {
      checks.push({
        name: "mcp-tribe",
        level: "fail",
        message: `mcpServers.${env.mcpName} missing from ${mcpPath}`,
        hint: "run `tribe install` to add it",
      })
    } else {
      const serverPath = Array.isArray(entry.args)
        ? entry.args.find((a) => typeof a === "string" && a.endsWith(".ts"))
        : undefined
      if (!serverPath) {
        checks.push({
          name: "mcp-tribe",
          level: "warn",
          message: `mcpServers.${name} has no .ts arg — unexpected`,
        })
      } else {
        // Resolve relative to project root (where .mcp.json lives).
        const absServer = resolve(dirname(mcpPath), serverPath)
        if (!existsSync(absServer)) {
          checks.push({
            name: "mcp-tribe",
            level: "fail",
            message: `mcpServers.${name} points at missing file: ${absServer}`,
            hint: "run `tribe install` to refresh the path",
          })
        } else {
          checks.push({ name: `mcp-${name}`, level: "pass", message: `points at ${absServer}` })
        }
      }
    }
  }

  // 3. Daemon — liveness = "can we connect to the socket and get a PID back"
  const socketPath = resolveSocketPath()
  const pid = await probeDaemonPid(socketPath)
  if (pid) {
    checks.push({ name: "daemon", level: "pass", message: `running (pid=${pid}, socket=${socketPath})` })
  } else if (existsSync(socketPath)) {
    checks.push({
      name: "daemon",
      level: "warn",
      message: `not running but stale socket present (${socketPath})`,
      hint: "run `tribe start` to start (or delete the stale socket)",
    })
  } else {
    checks.push({
      name: "daemon",
      level: "warn",
      message: `not running`,
      hint: "run `tribe start` if you want coordination live",
    })
  }

  // 4. Autostart mode
  const configExists = existsSync(env.autostartConfigPath)
  const mode = configExists ? readTribeConfig(env.autostartConfigPath).autostart : DEFAULT_AUTOSTART
  const envOverride = process.env.TRIBE_NO_DAEMON === "1"
  if (envOverride) {
    checks.push({
      name: "autostart",
      level: "pass",
      message: `library (TRIBE_NO_DAEMON=1 overrides ${mode}${configExists ? "" : " default"})`,
    })
  } else if (mode === "daemon") {
    const loreSocket = resolveLoreSocketPath()
    const loreAlive = existsSync(loreSocket)
    if (loreAlive) {
      checks.push({
        name: "autostart",
        level: "pass",
        message: `daemon (lore daemon alive at ${loreSocket})`,
      })
    } else {
      checks.push({
        name: "autostart",
        level: "pass",
        message: `daemon (lore daemon not running — will spawn on next hook)`,
      })
    }
  } else {
    checks.push({ name: "autostart", level: "pass", message: `${mode}` })
  }

  const hasFailures = checks.some((c) => c.level === "fail")
  return { env, checks, hasFailures }
}

export function formatDoctorReport(r: DoctorReport): string {
  const lines: string[] = ["tribe doctor"]
  for (const c of r.checks) {
    const tag = c.level === "pass" ? "PASS" : c.level === "warn" ? "WARN" : "FAIL"
    lines.push(`  [${tag}] ${c.name}: ${c.message}`)
    if (c.hint && c.level !== "pass") lines.push(`         hint: ${c.hint}`)
  }
  const summary = `  ${r.checks.filter((c) => c.level === "pass").length} pass, ${r.checks.filter((c) => c.level === "warn").length} warn, ${r.checks.filter((c) => c.level === "fail").length} fail`
  lines.push(summary)
  return lines.join("\n")
}
