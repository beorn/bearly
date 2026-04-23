import { describe, expect, it } from "vitest"
import { parseLsofCwd, isOrphan } from "./dolt-reaper-plugin.ts"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("parseLsofCwd", () => {
	it("extracts a live cwd path from lsof output", () => {
		// Use a real tmp dir so existsSync returns true.
		const dir = mkdtempSync(join(tmpdir(), "dolt-reaper-test-"))
		try {
			const lsof = [
				"COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF    NODE NAME",
				`dolt    12345 user  cwd    DIR    1,16      640 1234567 ${dir}`,
			].join("\n")
			const info = parseLsofCwd(12345, lsof)
			expect(info.pid).toBe(12345)
			expect(info.cwd).toBe(dir)
			expect(info.cwdExists).toBe(true)
			expect(info.cwdDeletedMarker).toBe(false)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("detects the (deleted) marker", () => {
		const lsof = [
			"COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF    NODE NAME",
			"dolt    99999 user  cwd    DIR    1,16      640 1234567 /tmp/gone-long-ago/.beads/dolt (deleted)",
		].join("\n")
		const info = parseLsofCwd(99999, lsof)
		expect(info.cwd).toBe("/tmp/gone-long-ago/.beads/dolt")
		expect(info.cwdDeletedMarker).toBe(true)
		expect(info.cwdExists).toBe(false) // unlikely to exist on test host
	})

	it("detects cwdExists=false when the path is missing but no (deleted) marker", () => {
		// Some lsof versions don't emit the marker; path-existence still catches it.
		const lsof = [
			"COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF    NODE NAME",
			"dolt    77777 user  cwd    DIR    1,16      640 1234567 /absolutely/does/not/exist/dolt",
		].join("\n")
		const info = parseLsofCwd(77777, lsof)
		expect(info.cwd).toBe("/absolutely/does/not/exist/dolt")
		expect(info.cwdExists).toBe(false)
		expect(info.cwdDeletedMarker).toBe(false)
	})

	it("returns null cwd on malformed output", () => {
		const info = parseLsofCwd(1, "just a garbage line")
		expect(info.cwd).toBeNull()
		expect(info.cwdExists).toBe(false)
	})
})

describe("isOrphan", () => {
	it("orphan when lsof marks (deleted)", () => {
		expect(isOrphan({ pid: 1, cwd: "/gone", cwdExists: false, cwdDeletedMarker: true })).toBe(true)
	})

	it("orphan when cwd path does not exist on disk", () => {
		expect(isOrphan({ pid: 1, cwd: "/does/not/exist", cwdExists: false, cwdDeletedMarker: false })).toBe(true)
	})

	it("NOT orphan when cwd exists and no deleted marker", () => {
		expect(isOrphan({ pid: 1, cwd: "/tmp", cwdExists: true, cwdDeletedMarker: false })).toBe(false)
	})

	it("NOT orphan when cwd couldn't be resolved (safety: don't reap on unknown)", () => {
		expect(isOrphan({ pid: 1, cwd: null, cwdExists: false, cwdDeletedMarker: false })).toBe(false)
	})
})
