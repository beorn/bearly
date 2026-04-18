/**
 * Tests for `tribe install` / `tribe uninstall` / `tribe doctor`.
 *
 * These tests operate purely on plan objects — no real filesystem writes,
 * no daemon connections. Each test constructs an `InstallEnv` with fixture
 * paths and asserts on the structured plan.
 *
 * The canonical hook-paths in fixtures look like:
 *   `/bun /tmp/bearly/tools/tribe-cli.ts hook <event>`
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import {
  TRIBE_HOOK_MARKER,
  TRIBE_HOOK_EVENTS,
  planInstall,
  applyInstall,
  planUninstall,
  doctorReport,
  formatInstallPlan,
  formatUninstallPlan,
  formatDoctorReport,
  type InstallEnv,
} from "../../../tools/lib/tribe/install.ts"
import { readTribeConfig } from "../../../tools/lib/tribe/autostart-config.ts"

function makeEnv(dir: string, overrides: Partial<InstallEnv> = {}): InstallEnv {
  return {
    claudeSettingsPath: resolve(dir, "claude/settings.json"),
    tribeCliPath: resolve(dir, "bearly/tools/tribe-cli.ts"),
    bunPath: "/usr/local/bin/bun",
    cwd: resolve(dir, "project"),
    loreServerPath: resolve(dir, "bearly/plugins/tribe/lore/server.ts"),
    mcpName: "tribe",
    autostartConfigPath: resolve(dir, "claude/tribe/config.json"),
    ...overrides,
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8")
}

function setupFixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), "tribe-install-test-"))
  mkdirSync(resolve(root, "bearly/tools/lib/tribe"), { recursive: true })
  mkdirSync(resolve(root, "bearly/plugins/tribe/lore"), { recursive: true })
  mkdirSync(resolve(root, "project"), { recursive: true })
  // Create the tribe-cli.ts and server.ts files so existence checks pass.
  writeFileSync(resolve(root, "bearly/tools/tribe-cli.ts"), "// stub")
  writeFileSync(resolve(root, "bearly/plugins/tribe/lore/server.ts"), "// stub")
  return root
}

describe("planInstall", () => {
  let root: string
  let env: InstallEnv

  beforeEach(() => {
    root = setupFixture()
    env = makeEnv(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("adds all four hooks when settings.json doesn't exist", () => {
    const plan = planInstall(env)
    expect(plan.settingsExists).toBe(false)
    expect(plan.hooks).toHaveLength(4)
    for (const h of plan.hooks) {
      expect(h.action).toBe("add")
      expect(h.command).toContain(TRIBE_HOOK_MARKER)
    }
    // Check the merged settings
    const hooks = plan.nextSettings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    for (const { claudeName, tribeArg } of TRIBE_HOOK_EVENTS) {
      expect(hooks[claudeName]).toBeDefined()
      expect(hooks[claudeName]![0]!.hooks[0]!.command).toContain(`hook ${tribeArg}`)
    }
  })

  test("is a no-op when already installed with same paths", () => {
    // Seed settings.json with the canonical install
    writeJson(env.claudeSettingsPath, {
      hooks: Object.fromEntries(
        TRIBE_HOOK_EVENTS.map(({ claudeName, tribeArg }) => [
          claudeName,
          [
            {
              matcher: "",
              hooks: [{ type: "command", command: `${env.bunPath} ${env.tribeCliPath} hook ${tribeArg}` }],
            },
          ],
        ]),
      ),
    })
    const plan = planInstall(env)
    for (const h of plan.hooks) {
      expect(h.action).toBe("unchanged")
    }
  })

  test("updates in place when tribe hook path has changed", () => {
    const oldCli = resolve(root, "other/tribe-cli.ts")
    writeJson(env.claudeSettingsPath, {
      hooks: Object.fromEntries(
        TRIBE_HOOK_EVENTS.map(({ claudeName, tribeArg }) => [
          claudeName,
          [
            {
              matcher: "",
              hooks: [{ type: "command", command: `/old/bun ${oldCli} hook ${tribeArg}` }],
            },
          ],
        ]),
      ),
    })
    const plan = planInstall(env)
    for (const h of plan.hooks) {
      expect(h.action).toBe("update")
      expect(h.previousCommand).toContain(oldCli)
      expect(h.command).toContain(env.tribeCliPath)
    }
    // No duplicate entries were added
    const hooks = plan.nextSettings.hooks as Record<string, unknown[]>
    for (const { claudeName } of TRIBE_HOOK_EVENTS) {
      expect(hooks[claudeName]).toHaveLength(1)
    }
  })

  test("preserves unrelated hook entries", () => {
    writeJson(env.claudeSettingsPath, {
      hooks: {
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "/usr/local/bin/user-script.sh" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/user/dcg" }] }],
      },
      permissions: { allow: ["Bash"] },
    })
    const plan = planInstall(env)
    const hooks = plan.nextSettings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    // SessionStart should have both the user script AND the tribe hook.
    expect(hooks.SessionStart).toHaveLength(2)
    expect(hooks.SessionStart![0]!.hooks[0]!.command).toBe("/usr/local/bin/user-script.sh")
    expect(hooks.SessionStart![1]!.hooks[0]!.command).toContain("hook session-start")
    // PreToolUse (not a tribe event) is untouched.
    expect(hooks.PreToolUse).toHaveLength(1)
    expect(hooks.PreToolUse![0]!.hooks[0]!.command).toBe("/user/dcg")
    // Other top-level keys preserved.
    expect(plan.nextSettings.permissions).toEqual({ allow: ["Bash"] })
  })

  test("skips .mcp.json when absent", () => {
    const plan = planInstall(env)
    expect(plan.mcp.action).toBe("skip")
    expect(plan.nextMcp).toBeNull()
  })

  test("adds mcpServers.tribe when .mcp.json exists without it", () => {
    writeJson(resolve(env.cwd, ".mcp.json"), { mcpServers: { tty: { command: "bun", args: ["foo.ts"] } } })
    const plan = planInstall(env)
    expect(plan.mcp.action).toBe("add")
    const servers = plan.nextMcp!.mcpServers as Record<string, unknown>
    expect(servers.tty).toBeDefined()
    expect(servers.tribe).toEqual({ command: "bun", args: [env.loreServerPath] })
  })

  test("plans autostart: daemon when no config file exists", () => {
    const plan = planInstall(env, { autostart: "daemon" })
    expect(plan.autostart.action).toBe("add")
    expect(plan.autostart.requested).toBe("daemon")
    expect(plan.autostart.current).toBeNull()
    const formatted = formatInstallPlan(plan, true)
    expect(formatted).toMatch(/\[ add\] autostart: daemon/)
  })

  test("plans autostart: unchanged when existing config matches requested daemon", () => {
    writeJson(env.autostartConfigPath, { autostart: "daemon" })
    const plan = planInstall(env, { autostart: "daemon" })
    expect(plan.autostart.action).toBe("unchanged")
    expect(plan.autostart.current).toBe("daemon")
    const formatted = formatInstallPlan(plan, true)
    expect(formatted).toMatch(/\[  ok\] autostart: daemon/)
  })

  test("plans autostart: update when existing library and requested daemon", () => {
    writeJson(env.autostartConfigPath, { autostart: "library" })
    const plan = planInstall(env, { autostart: "daemon" })
    expect(plan.autostart.action).toBe("update")
    expect(plan.autostart.current).toBe("library")
    expect(plan.autostart.requested).toBe("daemon")
    const formatted = formatInstallPlan(plan, true)
    expect(formatted).toMatch(/\[ upd\] autostart: library → daemon/)
  })

  test("defaults to daemon when opts.autostart is omitted", () => {
    const plan = planInstall(env)
    expect(plan.autostart.requested).toBe("daemon")
  })

  test("applyInstall writes the autostart config file", () => {
    const plan = planInstall(env, { autostart: "library" })
    applyInstall(plan)
    expect(existsSync(env.autostartConfigPath)).toBe(true)
    const content = JSON.parse(readFileSync(env.autostartConfigPath, "utf-8")) as { autostart: string }
    expect(content.autostart).toBe("library")
  })

  test("applyInstall does not rewrite the config when unchanged", () => {
    writeJson(env.autostartConfigPath, { autostart: "never" })
    const beforeMtime = readFileSync(env.autostartConfigPath, "utf-8")
    const plan = planInstall(env, { autostart: "never" })
    expect(plan.autostart.action).toBe("unchanged")
    applyInstall(plan)
    // File content identical — writeTribeConfig wasn't called
    expect(readFileSync(env.autostartConfigPath, "utf-8")).toBe(beforeMtime)
  })

  test("readTribeConfig returns default { autostart: 'daemon' } when file missing", () => {
    const cfg = readTribeConfig(env.autostartConfigPath)
    expect(cfg.autostart).toBe("daemon")
  })

  test("readTribeConfig returns default for malformed file", () => {
    writeJson(env.autostartConfigPath, { autostart: "bogus-mode" })
    expect(readTribeConfig(env.autostartConfigPath).autostart).toBe("daemon")
  })

  test("readTribeConfig returns default for non-JSON file", () => {
    mkdirSync(resolve(env.autostartConfigPath, ".."), { recursive: true })
    writeFileSync(env.autostartConfigPath, "not json {", "utf-8")
    expect(readTribeConfig(env.autostartConfigPath).autostart).toBe("daemon")
  })

  test("CLI rejects invalid --autostart value", async () => {
    const { spawnSync } = await import("node:child_process")
    const cli = resolve(__dirname, "../../../tools/tribe-cli.ts")
    const r = spawnSync(process.execPath, [cli, "install", "--autostart", "bogus", "--dry-run"], {
      encoding: "utf-8",
      env: { ...process.env, HOME: root }, // isolate against user ~/.claude
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("Invalid --autostart value")
  })
})

describe("planUninstall", () => {
  let root: string
  let env: InstallEnv

  beforeEach(() => {
    root = setupFixture()
    env = makeEnv(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("removes tribe hooks, leaves user hooks alone", () => {
    writeJson(env.claudeSettingsPath, {
      hooks: {
        SessionStart: [
          { matcher: "", hooks: [{ type: "command", command: "/usr/local/bin/user-script.sh" }] },
          {
            matcher: "",
            hooks: [{ type: "command", command: `${env.bunPath} ${env.tribeCliPath} hook session-start` }],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [{ type: "command", command: `${env.bunPath} ${env.tribeCliPath} hook prompt` }],
          },
        ],
      },
    })
    const plan = planUninstall(env)
    const hooks = plan.nextSettings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    // User hook still there, tribe hook gone
    expect(hooks.SessionStart).toHaveLength(1)
    expect(hooks.SessionStart![0]!.hooks[0]!.command).toBe("/usr/local/bin/user-script.sh")
    // UserPromptSubmit entirely removed (only had tribe entries)
    expect(hooks.UserPromptSubmit).toBeUndefined()

    // Plan actions
    const ss = plan.hooks.find((h) => h.event === "SessionStart")
    expect(ss?.action).toBe("remove")
    const se = plan.hooks.find((h) => h.event === "SessionEnd")
    expect(se?.action).toBe("none")
  })

  test("removes mcpServers.tribe and legacy mcpServers.lore if it points at tribe/lore server", () => {
    writeJson(resolve(env.cwd, ".mcp.json"), {
      mcpServers: {
        tribe: { command: "bun", args: [env.loreServerPath] },
        lore: { command: "bun", args: ["vendor/bearly/plugins/tribe/lore/server.ts"] },
        other: { command: "bun", args: ["unrelated.ts"] },
      },
    })
    const plan = planUninstall(env)
    expect(plan.mcp.action).toBe("remove")
    const servers = plan.nextMcp!.mcpServers as Record<string, unknown>
    expect(servers.tribe).toBeUndefined()
    expect(servers.lore).toBeUndefined()
    expect(servers.other).toBeDefined()
  })

  test("leaves unrelated `lore` entries alone", () => {
    writeJson(resolve(env.cwd, ".mcp.json"), {
      mcpServers: { lore: { command: "bun", args: ["some-other-lore.ts"] } },
    })
    const plan = planUninstall(env)
    const servers = plan.nextMcp!.mcpServers as Record<string, unknown>
    // Shouldn't touch a `lore` server that doesn't point at tribe/lore/server.ts
    expect(servers.lore).toBeDefined()
  })
})

describe("doctorReport", () => {
  let root: string
  let env: InstallEnv

  beforeEach(() => {
    root = setupFixture()
    env = makeEnv(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("reports FAIL when settings.json missing", () => {
    const report = doctorReport(env)
    const s = report.checks.find((c) => c.name === "claude-settings")
    expect(s?.level).toBe("fail")
    expect(report.hasFailures).toBe(true)
  })

  test("reports PASS for all hooks when installed correctly", () => {
    writeJson(env.claudeSettingsPath, {
      hooks: Object.fromEntries(
        TRIBE_HOOK_EVENTS.map(({ claudeName, tribeArg }) => [
          claudeName,
          [
            {
              matcher: "",
              hooks: [{ type: "command", command: `${env.bunPath} ${env.tribeCliPath} hook ${tribeArg}` }],
            },
          ],
        ]),
      ),
    })
    writeJson(resolve(env.cwd, ".mcp.json"), {
      mcpServers: { tribe: { command: "bun", args: [env.loreServerPath] } },
    })
    const report = doctorReport(env)
    for (const { claudeName } of TRIBE_HOOK_EVENTS) {
      const c = report.checks.find((x) => x.name === `hook-${claudeName}`)
      expect(c?.level).toBe("pass")
    }
    const mcp = report.checks.find((c) => c.name.startsWith("mcp-"))
    expect(mcp?.level).toBe("pass")
  })

  test("reports FAIL when hook points at a missing file", () => {
    const missing = resolve(root, "deleted/tribe-cli.ts")
    writeJson(env.claudeSettingsPath, {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [{ type: "command", command: `/bun ${missing} hook session-start` }],
          },
        ],
      },
    })
    const report = doctorReport(env)
    const c = report.checks.find((c) => c.name === "hook-SessionStart")
    expect(c?.level).toBe("fail")
    expect(c?.message).toContain(missing)
    expect(report.hasFailures).toBe(true)
  })

  test("reports WARN when .mcp.json is missing", () => {
    writeJson(env.claudeSettingsPath, {
      hooks: Object.fromEntries(
        TRIBE_HOOK_EVENTS.map(({ claudeName, tribeArg }) => [
          claudeName,
          [
            {
              matcher: "",
              hooks: [{ type: "command", command: `${env.bunPath} ${env.tribeCliPath} hook ${tribeArg}` }],
            },
          ],
        ]),
      ),
    })
    const report = doctorReport(env)
    const mcp = report.checks.find((c) => c.name === "mcp-json")
    expect(mcp?.level).toBe("warn")
  })

  test("formatDoctorReport prints a readable summary", () => {
    writeJson(env.claudeSettingsPath, { hooks: {} })
    const report = doctorReport(env)
    const text = formatDoctorReport(report)
    expect(text).toContain("tribe doctor")
    expect(text).toMatch(/pass|warn|fail/i)
  })

  test("formatInstallPlan and formatUninstallPlan are string-producing", () => {
    expect(formatInstallPlan(planInstall(env), true)).toContain("tribe install")
    expect(formatUninstallPlan(planUninstall(env), true)).toContain("tribe uninstall")
  })
})
