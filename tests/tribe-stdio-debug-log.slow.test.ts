import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const cleanupDirs: string[] = []
const BEARLY_ROOT = fileURLToPath(new URL("..", import.meta.url))

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tribe-stdio-debug-log-"))
  cleanupDirs.push(dir)
  return dir
}

async function runServerBriefly(env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["plugins/tribe/server.ts"], {
    cwd: BEARLY_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    stdout += chunk
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })

  const timer = setTimeout(() => {
    child.kill("SIGTERM")
  }, 300)

  await new Promise<void>((resolve) => {
    child.on("close", () => {
      clearTimeout(timer)
      resolve()
    })
  })

  return { stdout, stderr }
}

describe("tribe stdio adapter DEBUG_LOG", () => {
  it("keeps MCP stdout clean while writing diagnostics to DEBUG_LOG", async () => {
    const dir = tmpDir()
    const logPath = join(dir, "tribe-mcp.log")
    const socketPath = join(dir, "missing.sock")
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEBUG: "tribe:*,tribe-client:*",
      DEBUG_LOG: logPath,
      TRIBE_NAME: "stdio-debug-log-test",
      TRIBE_SOCKET: socketPath,
    }
    delete env.LOG_FILE

    const { stdout, stderr } = await runServerBriefly(env)

    expect(stdout).toBe("")
    expect(stderr).toBe("")
    expect(existsSync(logPath)).toBe(true)
    expect(readFileSync(logPath, "utf8")).toContain("Connecting to daemon")
  })
})
