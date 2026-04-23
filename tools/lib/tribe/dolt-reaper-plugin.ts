//
// Tribe plugin: orphan dolt sql-server reaper.
//
// Problem: `bd` spawns `dolt sql-server` daemons that reparent to launchd
// (PID 1) and outlive the session that started them. When a worktree is
// removed by anything other than `bun worktree remove` (raw `git worktree
// remove`, session crash, `rm -rf`, bd-side removal that doesn't kill its
// own daemon), the dolt server lives on forever — cwd pointing at a
// deleted directory, zero clients, contributing to `.git/index.lock`
// contention and health-monitor noise.
//
// Fix: periodically check every `dolt sql-server` process's cwd. If the
// cwd path no longer exists on disk (detected either via lsof's "(deleted)"
// marker or a direct existsSync check), the daemon is a confirmed orphan
// and can be reaped. SIGTERM first, SIGKILL after a short grace for any
// straggler.
//
// Runs once on daemon boot (catches leftover orphans from before the
// daemon started) and then every 30 minutes.
//
// What this does NOT do:
//   - Kill dolt servers whose cwd still exists. A daemon with a live cwd
//     and no current client may just be idle-between-requests; killing it
//     would cause the next `bd` invocation to re-spawn (wasteful but
//     harmless) or, worse, race with an active-but-momentarily-quiet
//     session. Path-exists is the definitive safe signal.
//   - Handle non-dolt daemons (node/bun zombies are a separate concern).
//

import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createLogger } from "loggily"
import { createTimers } from "./timers.ts"
import type { TribePluginApi, TribeClientApi } from "./plugin-api.ts"

const log = createLogger("tribe:dolt-reaper")

const REAP_INTERVAL_MS = 30 * 60 * 1000 // 30 min
const TERM_GRACE_MS = 1500

interface DoltServerInfo {
	pid: number
	cwd: string | null
	cwdExists: boolean
	cwdDeletedMarker: boolean
}

/**
 * List every dolt sql-server process and its resolved cwd + liveness state.
 * Exported for testing.
 */
export function inspectDoltServers(): DoltServerInfo[] {
	let pgrepOut = ""
	try {
		pgrepOut = execSync(`pgrep -f "dolt sql-server"`, { encoding: "utf8" }).toString()
	} catch {
		// pgrep exits non-zero when nothing matches — that's fine, no servers.
		return []
	}
	const pids = pgrepOut
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((p) => parseInt(p, 10))
		.filter((p) => !Number.isNaN(p))

	const infos: DoltServerInfo[] = []
	for (const pid of pids) {
		let cwdOut = ""
		try {
			cwdOut = execSync(`lsof -p ${pid} -a -d cwd 2>/dev/null`, { encoding: "utf8" }).toString()
		} catch {
			// lsof failed (process disappeared, permission denied). Skip — we
			// cannot confirm orphan status, so we don't reap.
			continue
		}
		const info = parseLsofCwd(pid, cwdOut)
		infos.push(info)
	}
	return infos
}

/**
 * Parse `lsof -p <pid> -a -d cwd` output for the cwd path and deleted marker.
 * Exported for testing.
 *
 * Example lsof output (2nd line is the cwd row):
 *   COMMAND   PID  USER   FD   TYPE DEVICE ... NAME
 *   dolt    12345 beorn  cwd    DIR    1,16 ... /path/to/.beads/dolt
 *
 * When the directory has been deleted but the daemon still holds the cwd,
 * lsof appends " (deleted)" to the NAME column.
 */
export function parseLsofCwd(pid: number, lsofOutput: string): DoltServerInfo {
	const line = lsofOutput
		.split("\n")
		.slice(1) // skip header
		.find((l) => /\bcwd\b/.test(l))
	if (!line) return { pid, cwd: null, cwdExists: false, cwdDeletedMarker: false }

	// lsof's NAME column is everything after the device column. Paths can
	// contain spaces; " (deleted)" is the marker we care about. Conservative
	// extraction: find the first "/" and take the rest up to optional marker.
	const slashIdx = line.indexOf("/")
	if (slashIdx < 0) return { pid, cwd: null, cwdExists: false, cwdDeletedMarker: false }
	let rawPath = line.slice(slashIdx).trim()
	let cwdDeletedMarker = false
	if (rawPath.endsWith("(deleted)")) {
		cwdDeletedMarker = true
		rawPath = rawPath.replace(/\s*\(deleted\)\s*$/, "").trim()
	}
	const cwdExists = existsSync(rawPath)
	return { pid, cwd: rawPath, cwdExists, cwdDeletedMarker }
}

/**
 * Given a DoltServerInfo, should we reap it?
 * Exported for testing.
 */
export function isOrphan(info: DoltServerInfo): boolean {
	// Orphan if lsof explicitly marks the cwd as deleted, or the path no
	// longer exists. Either signal is sufficient — path-exists is the
	// definitive check; the marker is a fast fallback.
	if (info.cwdDeletedMarker) return true
	if (info.cwd && !info.cwdExists) return true
	return false
}

export interface ReapResult {
	scanned: number
	orphans: number
	killed: number
}

export function reapOrphanDoltServers(): ReapResult {
	const servers = inspectDoltServers()
	const orphans = servers.filter(isOrphan)

	for (const o of orphans) {
		try {
			process.kill(o.pid, "SIGTERM")
			log.info?.(
				`reaped orphan dolt pid=${o.pid} cwd=${o.cwd} deleted=${o.cwdDeletedMarker}`,
			)
		} catch {
			// already gone / permission — ignore
		}
	}

	if (orphans.length > 0) {
		// Schedule the SIGKILL escalation for 1.5s later — we don't need it
		// in the same tick and a synchronous sleep would block the daemon.
		globalThis.setTimeout(() => {
			for (const o of orphans) {
				try {
					process.kill(o.pid, 0) // probe; throws if dead
					process.kill(o.pid, "SIGKILL")
					log.warn?.(`SIGKILL dolt that survived SIGTERM pid=${o.pid}`)
				} catch {
					// already dead — good
				}
			}
		}, TERM_GRACE_MS)
	}

	return { scanned: servers.length, orphans: orphans.length, killed: orphans.length }
}

export const doltReaperPlugin: TribePluginApi = {
	name: "dolt-reaper",

	available() {
		// Only active if `dolt` binary is installed. If not, no servers will
		// ever exist and the reaper is a no-op — disable entirely to keep
		// daemon startup clean.
		try {
			execSync("command -v dolt", { encoding: "utf8" })
			return true
		} catch {
			return false
		}
	},

	start(_api: TribeClientApi) {
		const ac = new AbortController()
		const timers = createTimers(ac.signal)

		// Boot sweep — catches leftover orphans from before the daemon started.
		try {
			const result = reapOrphanDoltServers()
			if (result.orphans > 0) {
				log.info?.(
					`boot sweep reaped scanned=${result.scanned} orphans=${result.orphans} killed=${result.killed}`,
				)
			}
		} catch (err) {
			log.warn?.(`boot sweep failed: ${err instanceof Error ? err.message : err}`)
		}

		// Periodic sweep every 30 min.
		timers.setInterval(() => {
			try {
				const result = reapOrphanDoltServers()
				if (result.orphans > 0) {
					log.info?.(
						`periodic sweep reaped scanned=${result.scanned} orphans=${result.orphans} killed=${result.killed}`,
					)
				}
			} catch (err) {
				log.warn?.(`periodic sweep failed: ${err instanceof Error ? err.message : err}`)
			}
		}, REAP_INTERVAL_MS)

		return () => ac.abort()
	},
}
