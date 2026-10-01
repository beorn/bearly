/**
 * @failure A process chrooted into a disposable path is invisible to teardown, so the path can be removed under a live holder.
 * @level l2
 * @consumer Removely inspectPathHolderCensus and Bucketeer guarded pruning
 * @reach fs-walk <fixture-only: each census reads a tmpdir proc fixture; readdir is spied, never walked over the repo>
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import * as fsPromises from "node:fs/promises"
import * as childProcess from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  clearedByIdentity,
  inspectPathHolderCensus,
  pathHolderRefusal,
  safeRemoveSync,
  type PathHolder,
  type UnreadableProcess,
} from "../src/index.ts"
import {
  inspectPathHolderCensusInProc,
  inspectProcessCensusInProc,
  inspectProcessCwdsInProc,
} from "../src/path-holders.ts"

// Root setup imports Removely before this suite; reload it so the I/O controls
// below bind to the collector under test rather than its cached real adapters.
vi.hoisted(() => vi.resetModules())
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}))
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}))

const temporary: string[] = []
const actualPlatform = process.platform

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(process, "platform", { value: actualPlatform })
  for (const path of temporary.splice(0)) safeRemoveSync(path, { within: dirname(path), allowMissing: true })
})

describe("inspectPathHolderCensus", () => {
  test("the public refusal preserves the holder source and target", () => {
    expect(inspectPathHolderCensus).toBeTypeOf("function")
    const holders: PathHolder[] = [
      { pid: 42, source: "cwd", target: "/tmp/bay" },
      { pid: 57, source: "fd/7", target: "/tmp/bay/output.log" },
    ]

    expect(pathHolderRefusal(holders)).toBe(
      "path remains held by pid 42 via cwd (/tmp/bay); pid 57 via fd/7 (/tmp/bay/output.log)",
    )
    expect(pathHolderRefusal([])).toBeUndefined()
  })

  test.runIf(process.platform === "linux")("reports a process whose filesystem root holds the owned path", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "yrd-path-holders-"))
    temporary.push(fixture)
    const ownedPath = join(fixture, "owned")
    const procRoot = join(fixture, "proc")
    const processRoot = join(procRoot, "4242")
    mkdirSync(ownedPath)
    mkdirSync(join(processRoot, "fd"), { recursive: true })
    symlinkSync("/", join(processRoot, "cwd"))
    symlinkSync("/bin/sh", join(processRoot, "exe"))
    symlinkSync(ownedPath, join(processRoot, "root"))
    writeFileSync(join(processRoot, "maps"), "")
    writeFileSync(join(processRoot, "cmdline"), "")

    const kill = vi.spyOn(process, "kill")
    const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })
    expect(census.holders).toEqual([{ pid: 4242, source: "root", target: ownedPath }])
    expect(kill).not.toHaveBeenCalled()
  })

  test.runIf(process.platform === "linux")("reports mapped files below the owned path", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "yrd-path-maps-"))
    temporary.push(fixture)
    const ownedPath = join(fixture, "owned")
    const mappedFile = join(ownedPath, "native.node")
    const procRoot = join(fixture, "proc")
    const processRoot = join(procRoot, "4242")
    mkdirSync(ownedPath)
    writeFileSync(mappedFile, "mapped fixture\n")
    mkdirSync(join(processRoot, "fd"), { recursive: true })
    symlinkSync("/", join(processRoot, "cwd"))
    symlinkSync("/bin/sh", join(processRoot, "exe"))
    symlinkSync("/", join(processRoot, "root"))
    writeFileSync(join(processRoot, "maps"), `7f000000-7f001000 r--p 00000000 00:00 0 ${mappedFile}\n`)
    writeFileSync(join(processRoot, "cmdline"), "")

    const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })
    expect(census.holders).toEqual([{ pid: 4242, source: "fd/maps", target: mappedFile }])
  })

  test.runIf(process.platform === "linux")(
    "reports reduced same-UID coverage instead of a clean empty census when a source is denied",
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-denied-"))
      temporary.push(fixture)
      const ownedPath = join(fixture, "owned")
      const procRoot = join(fixture, "proc")
      const processRoot = join(procRoot, "4242")
      mkdirSync(ownedPath)
      mkdirSync(join(processRoot, "fd"), { recursive: true })
      symlinkSync("/", join(processRoot, "cwd"))
      symlinkSync("/bin/sh", join(processRoot, "exe"))
      symlinkSync("/", join(processRoot, "root"))
      writeFileSync(join(processRoot, "maps"), "")
      writeFileSync(join(processRoot, "cmdline"), "")
      // Readable stat decorates a live process denial; it does not grant a waiver.
      writeFileSync(join(processRoot, "stat"), "4242 (probe) S 1 0 0 0\n")
      chmodSync(join(processRoot, "maps"), 0o000)

      const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })

      expect(census.holders).toEqual([])
      expect(census.coverage).toMatchObject({
        platform: "linux",
        scope: "same-uid",
        complete: false,
        processes: { enumerated: 1, sameUid: 1, otherUid: 0, sourceDenied: 1, unavailable: { exited: 0, denied: 0 } },
        sources: {
          cwd: { readable: 1, unavailable: { exited: 0, denied: 0 } },
          exe: { readable: 1, unavailable: { exited: 0, denied: 0 } },
          root: { readable: 1, unavailable: { exited: 0, denied: 0 } },
          argv: { readable: 1, unavailable: { exited: 0, denied: 0 } },
          maps: { readable: 0, unavailable: { exited: 0, denied: 1 } },
          fd: { readable: 1, unavailable: { exited: 0, denied: 0 } },
        },
      })
      // The counts say HOW MANY observations were hidden; this names WHO.
      expect(census.coverage).toMatchObject({
        unreadable: [{ pid: 4242, comm: "probe", ppid: 1, denied: ["maps"] }],
      })
    },
  )

  test.runIf(process.platform === "linux")(
    "an incomplete census names each gap in the serialized head, before the per-source tail",
    async () => {
      // hh 24638: a hab page truncated this census's JSON mid-`sources`, leaving a head that read complete:false
      // beside all-zero process counters — the reason lived only in the tail the evidence bound cut off. Each
      // reason has its own head counter, and every one precedes `sources`, so any bounded prefix still names why.
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-head-"))
      temporary.push(fixture)
      const ownedPath = join(fixture, "owned")
      const procRoot = join(fixture, "proc")
      mkdirSync(ownedPath)
      const processRoot = (pid: number) => join(procRoot, String(pid))
      for (const pid of [4242, 4243, 4244, 4245]) {
        mkdirSync(join(processRoot(pid), "fd"), { recursive: true })
        symlinkSync("/", join(processRoot(pid), "cwd"))
        symlinkSync("/bin/sh", join(processRoot(pid), "exe"))
        symlinkSync("/", join(processRoot(pid), "root"))
        writeFileSync(join(processRoot(pid), "maps"), "")
        writeFileSync(join(processRoot(pid), "cmdline"), "")
        writeFileSync(join(processRoot(pid), "stat"), `${pid} (probe) S 1 0 0 0\n`)
      }
      // 4242 denies maps; 4243's cmdline never answers (a FIFO with no writer, as in the deadline row below);
      // 4244 lost maps while it stayed present; 4245's cwd is a relative target no path rule can read.
      chmodSync(join(processRoot(4242), "maps"), 0o000)
      const fifo = join(processRoot(4243), "cmdline")
      unlinkSync(fifo)
      expect(childProcess.spawnSync("mkfifo", [fifo]).status).toBe(0)
      unlinkSync(join(processRoot(4244), "maps"))
      unlinkSync(join(processRoot(4245), "cwd"))
      symlinkSync("relative/target", join(processRoot(4245), "cwd"))

      try {
        const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid", deadlineMs: 300 })
        expect(census.coverage).toMatchObject({
          complete: false,
          processes: { sourceDenied: 1, sourceUnanswered: 1, sourceMissing: 1, sourceAmbiguous: 1 },
        })
        const json = JSON.stringify(census.coverage)
        for (const counter of ["sourceDenied", "sourceUnanswered", "sourceMissing", "sourceAmbiguous"]) {
          expect(json).toContain(`"${counter}":1`)
          expect(json.indexOf(`"${counter}"`)).toBeLessThan(json.indexOf('"sources"'))
        }
      } finally {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK))
      }
    },
  )

  test.runIf(process.platform === "linux")(
    "a ZOMBIE is not a gap at all — it is counted and skipped, and only the live denial blocks",
    async () => {
      // A zombie has been reaped by the kernel: its address space, descriptors
      // and cwd are already released, so /proc/N/fd answers EACCES because there
      // is NOTHING TO LIST, not because permission is withheld.
      //
      // This test used to assert the opposite half — that the census merely
      // RECORDED the state beside the denial, leaving the zombie in `unreadable`
      // and `complete` false either way. Recording it was never enough: a
      // process that provably holds nothing was still making every caller
      // refuse. That false gap is invisible because it errs safe, and a guard
      // that refuses too often looks exactly like one that works.
      //
      // Observed on hab1 2026-09-10, blocking a whole-estate reap of 107 rows:
      // pids 286562 (claude), 1794340 (bun), 659207/659240/659270 (git) and
      // 4034727 (sh) — every one state Z, every one denying only `fd`.
      //
      // The live sibling below is the control: it denies the same source and it
      // MUST still block, or this fix would have bought completeness by going
      // blind.
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-zombie-"))
      temporary.push(fixture)
      const ownedPath = join(fixture, "owned")
      const procRoot = join(fixture, "proc")
      mkdirSync(ownedPath)
      for (const [pid, state] of [
        [4242, "Z"],
        [4243, "S"],
      ] as const) {
        const processRoot = join(procRoot, String(pid))
        mkdirSync(join(processRoot, "fd"), { recursive: true })
        symlinkSync("/", join(processRoot, "cwd"))
        symlinkSync("/bin/sh", join(processRoot, "exe"))
        symlinkSync("/", join(processRoot, "root"))
        writeFileSync(join(processRoot, "maps"), "")
        writeFileSync(join(processRoot, "cmdline"), "")
        writeFileSync(join(processRoot, "stat"), `${pid} (probe) ${state} 1 0 0 0\n`)
        // Deny exactly one source, the way a released fd table denies /proc/N/fd.
        chmodSync(join(processRoot, "maps"), 0o000)
      }

      const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })
      expect(census.holders).toEqual([])
      // The zombie is counted, never probed, and never listed as unreadable.
      // The live one is the only thing left blocking.
      expect(census.coverage).toMatchObject({
        complete: false,
        processes: { enumerated: 2, sameUid: 2, otherUid: 0, zombie: 1 },
        unreadable: [{ pid: 4243, comm: "probe", state: "S", denied: ["maps"] }],
      })
    },
  )

  test.runIf(process.platform === "linux")("a census whose ONLY denials are zombies is COMPLETE", async () => {
    // The other direction, and the one that actually unblocks a caller: with
    // the live sibling removed, nothing is hiding a holder and the census may
    // say so. Without this the fix above is unobservable — `complete` would
    // stay false for a different reason and no caller would ever notice.
    const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-zombies-only-"))
    temporary.push(fixture)
    const ownedPath = join(fixture, "owned")
    const procRoot = join(fixture, "proc")
    mkdirSync(ownedPath)
    for (const pid of [4242, 4243]) {
      const processRoot = join(procRoot, String(pid))
      mkdirSync(join(processRoot, "fd"), { recursive: true })
      symlinkSync("/", join(processRoot, "cwd"))
      symlinkSync("/bin/sh", join(processRoot, "exe"))
      symlinkSync("/", join(processRoot, "root"))
      writeFileSync(join(processRoot, "maps"), "")
      writeFileSync(join(processRoot, "cmdline"), "")
      writeFileSync(join(processRoot, "stat"), `${pid} (probe) Z 1 0 0 0\n`)
      chmodSync(join(processRoot, "maps"), 0o000)
    }

    const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })
    expect(census.holders).toEqual([])
    expect(census.coverage).toMatchObject({
      complete: true,
      processes: { enumerated: 2, sameUid: 2, otherUid: 0, zombie: 2 },
    })
    expect(census.coverage).not.toHaveProperty("unreadable")
  })

  // Not ported from @yrd/process (hh 26990, @cto 2e553d4c): "a gap whose proc exited between the denied read and the
  // identity read clears itself" and "keeps an exited source separate from denial without reducing coverage". Both
  // encode yrd's laxer rule, where a missing stat or source read as exit. Here only an absent process directory
  // proves exit; the two rows below assert that stricter contract instead.
  test.runIf(process.platform === "linux")("missing optional identity never clears a denied observation", async () => {
    // A missing stat file is optional metadata, not proof its process directory vanished.
    const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-exited-between-reads-"))
    temporary.push(fixture)
    const ownedPath = join(fixture, "owned")
    const procRoot = join(fixture, "proc")
    mkdirSync(ownedPath)
    const deniedFdTables: string[] = []
    for (const [pid, stat] of [
      [4242, undefined],
      [4243, "4243 (probe) S 1 0 0 0\n"],
    ] as const) {
      const processRoot = join(procRoot, String(pid))
      mkdirSync(join(processRoot, "fd"), { recursive: true })
      symlinkSync("/", join(processRoot, "cwd"))
      symlinkSync("/bin/sh", join(processRoot, "exe"))
      symlinkSync("/", join(processRoot, "root"))
      writeFileSync(join(processRoot, "maps"), "")
      writeFileSync(join(processRoot, "cmdline"), "")
      if (stat !== undefined) writeFileSync(join(processRoot, "stat"), stat)
      // Deny the fd table itself, the way a dying process denies /proc/N/fd.
      chmodSync(join(processRoot, "fd"), 0o000)
      deniedFdTables.push(join(processRoot, "fd"))
    }

    try {
      const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })
      expect(census.holders).toEqual([])
      expect(census.coverage).toMatchObject({
        complete: false,
        unreadable: [
          { pid: 4242, denied: ["fd"] },
          { pid: 4243, comm: "probe", state: "S", denied: ["fd"] },
        ],
      })
    } finally {
      // A 000 directory cannot be recursed into by the afterEach cleanup.
      for (const table of deniedFdTables) chmodSync(table, 0o755)
    }
  })

  test.runIf(process.platform === "linux")(
    "a denied source is named with its comm, ppid and start time from the same stat read",
    async () => {
      // Identity is whatever the world-readable stat gives: comm, ppid, and
      // the start time from field 22 against the host's boot time — for a
      // zombie, a live proc, and one that was gone before it could be read.
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-tolerated-record-"))
      temporary.push(fixture)
      const ownedPath = join(fixture, "owned")
      const procRoot = join(fixture, "proc")
      mkdirSync(ownedPath)
      mkdirSync(procRoot)
      const bootSeconds = 1_770_000_000
      writeFileSync(join(procRoot, "stat"), `cpu  1 2 3\nbtime ${bootSeconds}\nprocesses 42\n`)
      // After comm: state, ppid, seventeen fields of filler, then starttime (field 22).
      const statLine = (pid: number, state: string, ticks: number) =>
        `${pid} (probe) ${state} 1 ${Array.from({ length: 17 }, () => "0").join(" ")} ${ticks} 0 0\n`
      const startedAt = (afterBootMs: number) => new Date(bootSeconds * 1_000 + afterBootMs).toISOString()
      const deniedFdTables: string[] = []
      for (const [pid, stat] of [
        // Live (S), not Z: a zombie is no longer a denial at all — it is counted
        // and skipped — so a zombie fixture would exercise nothing here. This
        // test is about the IDENTITY decoration on a real gap, and it needs a
        // real gap to decorate.
        [4242, statLine(4242, "S", 9_000)],
        [4243, statLine(4243, "S", 12_000)],
        [4244, undefined],
      ] as const) {
        const processRoot = join(procRoot, String(pid))
        mkdirSync(join(processRoot, "fd"), { recursive: true })
        symlinkSync("/", join(processRoot, "cwd"))
        symlinkSync("/bin/sh", join(processRoot, "exe"))
        symlinkSync("/", join(processRoot, "root"))
        writeFileSync(join(processRoot, "maps"), "")
        writeFileSync(join(processRoot, "cmdline"), "")
        if (stat !== undefined) writeFileSync(join(processRoot, "stat"), stat)
        chmodSync(join(processRoot, "fd"), 0o000)
        deniedFdTables.push(join(processRoot, "fd"))
      }

      try {
        const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })
        expect(census.coverage).toMatchObject({
          complete: false,
          unreadable: [
            { pid: 4242, comm: "probe", ppid: 1, state: "S", startedAt: startedAt(90_000), denied: ["fd"] },
            { pid: 4243, comm: "probe", ppid: 1, state: "S", startedAt: startedAt(120_000), denied: ["fd"] },
            { pid: 4244, denied: ["fd"] },
          ],
        })
      } finally {
        for (const table of deniedFdTables) chmodSync(table, 0o755)
      }
    },
  )

  test.runIf(process.platform === "linux")(
    "a missing maps source under a present process is incomplete evidence",
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-exited-"))
      temporary.push(fixture)
      const ownedPath = join(fixture, "owned")
      const procRoot = join(fixture, "proc")
      const processRoot = join(procRoot, "4242")
      mkdirSync(ownedPath)
      mkdirSync(join(processRoot, "fd"), { recursive: true })
      symlinkSync("/", join(processRoot, "cwd"))
      symlinkSync("/bin/sh", join(processRoot, "exe"))
      symlinkSync("/", join(processRoot, "root"))
      writeFileSync(join(processRoot, "cmdline"), "")
      // The PID remains alive: a source disappearing is not proof the process exited.
      writeFileSync(join(processRoot, "stat"), "4242 (probe) S 1 0 0 0\n")

      const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })

      expect(census.holders).toEqual([])
      expect(census.coverage).toMatchObject({
        platform: "linux",
        complete: false,
        sources: {
          maps: { readable: 0, unavailable: { exited: 0, denied: 0, missing: 1 } },
        },
      })
    },
  )

  test.runIf(process.platform === "linux")(
    "a complete empty census says what proc root and same-UID scope were searched",
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-empty-"))
      temporary.push(fixture)
      const ownedPath = join(fixture, "owned")
      const procRoot = join(fixture, "proc")
      mkdirSync(ownedPath)
      mkdirSync(procRoot)

      const none = { exited: 0, denied: 0, missing: 0, ambiguous: 0, unanswered: 0 }
      const source = { readable: 0, notApplicable: 0, unavailable: none }
      await expect(inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })).resolves.toEqual({
        holders: [],
        coverage: {
          platform: "linux",
          scope: "same-uid",
          procRoot,
          complete: true,
          processes: {
            enumerated: 0,
            sameUid: 0,
            otherUid: 0,
            admitted: 0,
            inspected: 0,
            excluded: 0,
            zombie: 0,
            sourceDenied: 0,
            sourceUnanswered: 0,
            sourceMissing: 0,
            sourceAmbiguous: 0,
            unavailable: none,
          },
          sources: { cwd: source, exe: source, root: source, argv: source, maps: source, fd: source },
        },
      })
    },
  )

  test.runIf(process.platform === "linux")("fails loudly when the required proc root is missing", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-missing-"))
    temporary.push(fixture)
    const ownedPath = join(fixture, "owned")
    const procRoot = join(fixture, "missing-proc")
    mkdirSync(ownedPath)

    await expect(inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })).rejects.toThrow(
      `Linux path-holder census requires readable proc root '${procRoot}'`,
    )
  })

  // hh 26947 (@cto a2bfdf39): a supervisor started as `bun <tree>/entry.ts` holds its tree by argv alone (cwd
  // elsewhere, nothing mapped, no descriptor) and later resolves files beside its entry. Judged per argv element.
  describe("argv holds a path only through an element that is itself a path under it", () => {
    function argvFixture(): { ownedPath: string; procRoot: string; processRoot: string } {
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-argv-"))
      temporary.push(fixture)
      const ownedPath = join(fixture, "owned")
      const procRoot = join(fixture, "proc")
      const processRoot = join(procRoot, "4242")
      mkdirSync(ownedPath)
      mkdirSync(join(processRoot, "fd"), { recursive: true })
      symlinkSync("/", join(processRoot, "cwd"))
      symlinkSync("/bin/sh", join(processRoot, "exe"))
      symlinkSync("/", join(processRoot, "root"))
      writeFileSync(join(processRoot, "maps"), "")
      writeFileSync(join(processRoot, "stat"), "4242 (bun) S 1 0 0 0\n")
      writeFileSync(join(processRoot, "cmdline"), "bun\0")
      return { ownedPath, procRoot, processRoot }
    }

    test.runIf(process.platform === "linux")("an argv element under the root holds it", async () => {
      const probe = argvFixture()
      const entry = join(probe.ownedPath, "ag", "inhab.ts")
      writeFileSync(join(probe.processRoot, "cmdline"), `bun\0${entry}\0--name\0@dev.5\0`)
      const census = await inspectPathHolderCensusInProc(probe.ownedPath, probe.procRoot, { scope: "same-uid" })
      expect(census.holders).toEqual([{ pid: 4242, source: "argv", target: entry }])
      expect(census.coverage).toMatchObject({ complete: true, sources: { argv: { readable: 1 } } })
    })

    test.runIf(process.platform === "linux")(
      "script text or a flag value that mentions the path holds nothing",
      async () => {
        const probe = argvFixture()
        writeFileSync(
          join(probe.processRoot, "cmdline"),
          `sh\0-c\0cd ${probe.ownedPath} && run\0--config=${probe.ownedPath}/x.json\0`,
        )
        const census = await inspectPathHolderCensusInProc(probe.ownedPath, probe.procRoot, { scope: "same-uid" })
        expect(census.holders).toEqual([])
        expect(census.coverage).toMatchObject({ complete: true })
      },
    )

    // hh 26947 (@cto 3a61d4df): reading a live cmdline waits on the target's mmap lock, once for 23 minutes (hh 24248).
    // A FIFO with no writer stands in for that lock: the open never returns until a writer arrives.
    test.runIf(process.platform === "linux")(
      "a source that does not answer by the deadline is named, the census answers, and the other pids are read",
      async () => {
        const probe = argvFixture()
        const fifo = join(probe.processRoot, "cmdline")
        unlinkSync(fifo)
        expect(childProcess.spawnSync("mkfifo", [fifo]).status).toBe(0)
        const neighbour = join(probe.procRoot, "4343")
        mkdirSync(join(neighbour, "fd"), { recursive: true })
        symlinkSync(probe.ownedPath, join(neighbour, "cwd"))
        symlinkSync("/bin/sh", join(neighbour, "exe"))
        symlinkSync("/", join(neighbour, "root"))
        writeFileSync(join(neighbour, "maps"), "")
        writeFileSync(join(neighbour, "stat"), "4343 (sh) S 1 0 0 0\n")
        writeFileSync(join(neighbour, "cmdline"), "sh\0")
        try {
          const started = performance.now()
          const census = await inspectPathHolderCensusInProc(probe.ownedPath, probe.procRoot, {
            scope: "same-uid",
            deadlineMs: 300,
          })
          expect(performance.now() - started).toBeLessThan(5_000)
          expect(census.holders).toEqual([{ pid: 4343, source: "cwd", target: probe.ownedPath }])
          // maps waits on the same mmap lock as cmdline, so it is never issued once cmdline has not answered: one stuck
          // process pins one I/O-pool thread, not two (hh 26990, @cto adce5a62 point 7).
          expect(census.coverage).toMatchObject({
            complete: false,
            processes: { sameUid: 2, sourceDenied: 0, sourceUnanswered: 1 },
            sources: {
              argv: { readable: 1, unavailable: { exited: 0, denied: 0, unanswered: 1 } },
              maps: { readable: 1, unavailable: { unanswered: 1 } },
            },
            unreadable: [
              {
                pid: 4242,
                comm: "bun",
                denied: [],
                unanswered: ["argv", "maps"],
                issues: [
                  { source: "argv", reason: "unanswered" },
                  { source: "maps", reason: "unanswered" },
                ],
              },
            ],
          })
        } finally {
          // Release the abandoned read so the worker can exit: a reader waiting in open() already counts as a reader,
          // so a non-blocking writer open succeeds and its close hands the reader EOF.
          closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK))
        }
      },
    )

    test.runIf(process.platform === "linux")("an unreadable cmdline is a denial, never an empty argv", async () => {
      const probe = argvFixture()
      chmodSync(join(probe.processRoot, "cmdline"), 0o000)
      const census = await inspectPathHolderCensusInProc(probe.ownedPath, probe.procRoot, { scope: "same-uid" })
      expect(census.holders).toEqual([])
      expect(census.coverage).toMatchObject({
        complete: false,
        processes: { sourceDenied: 1 },
        sources: { argv: { readable: 0, unavailable: { exited: 0, denied: 1 } } },
        unreadable: [{ pid: 4242, comm: "bun", denied: ["argv"] }],
      })
    })
  })
})

/**
 * @failure Incomplete process observations or foreign-UID holders disappear from the action gate.
 * @level l2
 * @consumer Bucketeer all-visible census and Yrd compatibility census
 */
describe("explicit scope and source evidence", () => {
  function fixture(pid = 4242) {
    const base = mkdtempSync(join(tmpdir(), "removely-path-holders-"))
    temporary.push(base)
    const ownedPath = join(base, "owned")
    const procRoot = join(base, "proc")
    const processRoot = join(procRoot, String(pid))
    mkdirSync(ownedPath)
    mkdirSync(join(processRoot, "fd"), { recursive: true })
    symlinkSync("/", join(processRoot, "cwd"))
    symlinkSync("/bin/sh", join(processRoot, "exe"))
    symlinkSync("/", join(processRoot, "root"))
    writeFileSync(join(processRoot, "maps"), "")
    writeFileSync(join(processRoot, "cmdline"), "")
    writeFileSync(join(processRoot, "stat"), `${pid} (probe) S 1 0 0 0\n`)
    return { ownedPath, procRoot, processRoot }
  }

  test.each(["exe", "maps", "fd"] as const)(
    "missing %s under a live PID names the resource and remains incomplete",
    async (source) => {
      const { ownedPath, procRoot, processRoot } = fixture()
      const resource = join(processRoot, source)
      if (source === "fd") safeRemoveSync(resource, { within: processRoot })
      else unlinkSync(resource)
      const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })
      expect(census.coverage).toMatchObject({
        complete: false,
        sources: { [source]: { unavailable: { exited: 0, missing: 1 } } },
        unreadable: [{ pid: 4242, state: "S", issues: [{ source, resource, reason: "missing", code: "ENOENT" }] }],
      })
    },
  )

  test("a vanished descriptor does not prove its owning process exited", async () => {
    const { ownedPath, procRoot, processRoot } = fixture()
    const descriptor = join(processRoot, "fd", "7")
    symlinkSync(ownedPath, descriptor)
    const readlink = fsPromises.readlink
    vi.spyOn(fsPromises, "readlink").mockImplementation(async (...args: Parameters<typeof fsPromises.readlink>) => {
      if (String(args[0]) === descriptor) {
        unlinkSync(descriptor)
      }
      return readlink(...args)
    })
    const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })
    expect(census.coverage).toMatchObject({
      complete: false,
      sources: { fd: { unavailable: { missing: 1, exited: 0 } } },
      unreadable: [{ pid: 4242, issues: [{ source: "fd", resource: descriptor, reason: "missing" }] }],
    })
  })

  test("mixed descriptor failures retain every unresolved category and resource", async () => {
    const { ownedPath, procRoot, processRoot } = fixture()
    for (const name of ["7", "8", "9"]) {
      symlinkSync(name === "9" ? `${ownedPath}/file (deleted)` : ownedPath, join(processRoot, "fd", name))
    }
    const readlink = fsPromises.readlink
    vi.spyOn(fsPromises, "readlink").mockImplementation(async (...args: Parameters<typeof fsPromises.readlink>) => {
      const resource = String(args[0])
      if (resource === join(processRoot, "fd", "7")) throw Object.assign(new Error("denied fd"), { code: "EACCES" })
      if (resource === join(processRoot, "fd", "8")) throw Object.assign(new Error("missing fd"), { code: "ENOENT" })
      return readlink(...args)
    })
    const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })
    expect(census.coverage).toMatchObject({
      complete: false,
      sources: { fd: { unavailable: { denied: 1, missing: 1, ambiguous: 1, exited: 0 } } },
      unreadable: [
        {
          pid: 4242,
          issues: expect.arrayContaining([
            expect.objectContaining({ source: "fd", resource: join(processRoot, "fd", "7"), reason: "denied" }),
            expect.objectContaining({ source: "fd", resource: join(processRoot, "fd", "8"), reason: "missing" }),
            expect.objectContaining({ source: "fd", resource: join(processRoot, "fd", "9"), reason: "ambiguous" }),
          ]),
        },
      ],
    })
    const stat = fsPromises.stat
    let presenceReads = 0
    vi.spyOn(fsPromises, "stat").mockImplementation(async (...args: Parameters<typeof fsPromises.stat>) => {
      if (String(args[0]) === processRoot && ++presenceReads > 1) {
        throw Object.assign(new Error("process exited"), { code: "ENOENT" })
      }
      return stat(...args)
    })
    // The absent process directory proves exit for the vanished and the denied descriptor alike, since an exited
    // process holds nothing; the ambiguous name was read and still says what it says (hh 26990).
    const afterExit = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })
    expect(afterExit.coverage).toMatchObject({
      complete: false,
      sources: { fd: { unavailable: { denied: 0, missing: 0, ambiguous: 1 } } },
      unreadable: [
        {
          pid: 4242,
          issues: [
            expect.objectContaining({ source: "fd", resource: join(processRoot, "fd", "9"), reason: "ambiguous" }),
          ],
        },
      ],
    })
  })

  /** One readdir of `path` is denied, as while its process execs; `during` runs inside that denial. */
  function denyOnce(path: string, during: () => void = () => {}) {
    const readdir = fsPromises.readdir
    let denials = 0
    vi.spyOn(fsPromises, "readdir").mockImplementation((async (...args: Parameters<typeof fsPromises.readdir>) => {
      if (String(args[0]) === path && denials++ === 0) {
        during()
        throw Object.assign(new Error("denied fd"), { code: "EACCES" })
      }
      return readdir(...args)
    }) as typeof fsPromises.readdir)
  }

  function statLine(pid: number, startTicks: number): string {
    // Field 22 is the start time: state is field 3, so 18 fields sit between them.
    return `${pid} (probe) S 1 ${Array.from({ length: 17 }, () => "0").join(" ")} ${startTicks} 0\n`
  }

  test("a source denied once and read on the second try is read, not reported", async () => {
    const { ownedPath, procRoot, processRoot } = fixture()
    symlinkSync(ownedPath, join(processRoot, "fd", "7"))
    denyOnce(join(processRoot, "fd"))
    const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })
    expect(census.holders).toEqual([{ pid: 4242, source: "fd/7", target: ownedPath }])
    expect(census.coverage).toMatchObject({ complete: true, sources: { fd: { readable: 1 } } })
    expect(census.coverage).not.toHaveProperty("unreadable")
  })

  test("a denied source whose process directory has gone by the second read counts as exited", async () => {
    const { ownedPath, procRoot, processRoot } = fixture()
    denyOnce(join(processRoot, "fd"), () => safeRemoveSync(processRoot, { within: procRoot }))
    const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })
    expect(census.coverage).toMatchObject({
      complete: true,
      sources: { fd: { unavailable: { denied: 0, exited: 1 } } },
    })
    expect(census.coverage).not.toHaveProperty("unreadable")
  })

  test("a pid that names another process by the second read proves the denied one exited", async () => {
    const { ownedPath, procRoot, processRoot } = fixture()
    writeFileSync(join(processRoot, "stat"), statLine(4242, 100))
    symlinkSync(ownedPath, join(processRoot, "fd", "7"))
    denyOnce(join(processRoot, "fd"), () => writeFileSync(join(processRoot, "stat"), statLine(4242, 200)))
    const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })
    // The second read belongs to the new process, which this census never listed, so it holds nothing here.
    expect(census.holders).toEqual([])
    expect(census.coverage).toMatchObject({
      complete: true,
      sources: { fd: { unavailable: { denied: 0, exited: 1 } } },
    })
  })

  test("source disappearance counts as exit only after the process directory disappears", async () => {
    const { ownedPath, procRoot, processRoot } = fixture()
    const resource = join(processRoot, "maps")
    const readFile = fsPromises.readFile
    vi.spyOn(fsPromises, "readFile").mockImplementation(async (...args: Parameters<typeof fsPromises.readFile>) => {
      if (String(args[0]) === resource) safeRemoveSync(processRoot, { within: procRoot })
      return readFile(...args)
    })
    const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })
    expect(census.coverage).toMatchObject({
      complete: true,
      sources: { maps: { unavailable: { exited: 1, missing: 0 } } },
    })
    expect(census.coverage).not.toHaveProperty("unreadable")
  })

  test("kernel-thread flags prove an absent executable non-applicable", async () => {
    const { ownedPath, procRoot, processRoot } = fixture()
    unlinkSync(join(processRoot, "exe"))
    // /proc/PID/stat field 9 is PF_KTHREAD; a bare missing executable has no such proof.
    writeFileSync(join(processRoot, "stat"), "4242 (kworker) S 1 0 0 0 0 2097152 0\n")
    const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })
    expect(census.coverage).toMatchObject({
      complete: true,
      sources: { exe: { notApplicable: 1, unavailable: { exited: 0, missing: 0 } } },
    })
  })

  test.each(["fd", "maps"] as const)("an independently denied %s source is counted and named", async (source) => {
    const { ownedPath, procRoot, processRoot } = fixture()
    const resource = join(processRoot, source)
    chmodSync(resource, 0o000)
    try {
      const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })
      expect(census.coverage).toMatchObject({
        complete: false,
        sources: { [source]: { unavailable: { denied: 1, missing: 0 } } },
        unreadable: [{ pid: 4242, denied: [source], issues: [{ source, resource, reason: "denied", code: "EACCES" }] }],
      })
    } finally {
      chmodSync(resource, source === "fd" ? 0o755 : 0o644)
    }
  })

  test("all-visible admits a foreign-UID holder while same-uid names its exclusion", async () => {
    const { ownedPath, procRoot, processRoot } = fixture()
    unlinkSync(join(processRoot, "cwd"))
    symlinkSync(ownedPath, join(processRoot, "cwd"))
    const stat = fsPromises.stat
    vi.spyOn(fsPromises, "stat").mockImplementation(async (...args: Parameters<typeof fsPromises.stat>) => {
      const result = await stat(...args)
      if (String(args[0]) === processRoot) {
        Object.defineProperty(result, "uid", { value: (process.getuid?.() ?? 0) + 1 })
      }
      return result
    })
    const all = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })
    expect(all.holders).toEqual([{ pid: 4242, source: "cwd", target: ownedPath }])
    expect(all.coverage).toMatchObject({
      complete: true,
      scope: "all-visible",
      processes: { enumerated: 1, sameUid: 0, otherUid: 1, admitted: 1, inspected: 1, excluded: 0 },
    })
    const same = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })
    expect(same.holders).toEqual([])
    expect(same.coverage).toMatchObject({
      complete: true,
      scope: "same-uid",
      processes: { enumerated: 1, sameUid: 0, otherUid: 1, admitted: 0, inspected: 0, excluded: 1 },
    })
    chmodSync(join(processRoot, "maps"), 0o000)
    const denied = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })
    expect(denied.coverage).toMatchObject({
      complete: false,
      processes: { otherUid: 1, admitted: 1 },
      sources: { maps: { unavailable: { denied: 1 } } },
    })
  })

  test("unreadable UID metadata remains incomplete but all-visible still observes its holder", async () => {
    const { ownedPath, procRoot, processRoot } = fixture()
    symlinkSync(ownedPath, join(processRoot, "fd", "7"))
    const stat = fsPromises.stat
    vi.spyOn(fsPromises, "stat").mockImplementation(async (...args: Parameters<typeof fsPromises.stat>) => {
      if (String(args[0]) === processRoot) {
        throw Object.assign(new Error("synthetic UID metadata denial"), { code: "EACCES" })
      }
      return stat(...args)
    })
    const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })
    expect(census.holders).toEqual([{ pid: 4242, source: "fd/7", target: ownedPath }])
    expect(census.coverage).toMatchObject({
      complete: false,
      processes: { enumerated: 1, admitted: 1, inspected: 1, unavailable: { denied: 1 } },
      unreadable: [
        { pid: 4242, denied: ["process"], issues: [{ source: "process", resource: processRoot, reason: "denied" }] },
      ],
    })
  })

  test.each(["/elsewhere/file\\012name", "/elsewhere/file (deleted)", "unparseable maps record"])(
    "ambiguous maps evidence refuses: %s",
    async (target) => {
      const { ownedPath, procRoot, processRoot } = fixture()
      const resource = join(processRoot, "maps")
      writeFileSync(
        resource,
        target.startsWith("/")
          ? `7f000000-7f001000 r--p 00000000 00:00 0 ${join(ownedPath, target.slice("/elsewhere/".length))}\n`
          : `${target}\n`,
      )
      const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })
      expect(census.coverage).toMatchObject({
        complete: false,
        sources: { maps: { unavailable: { ambiguous: 1 } } },
        unreadable: [{ pid: 4242, issues: [{ source: "maps", resource, reason: "ambiguous" }] }],
      })
    },
  )

  // hh 26990 (@cto 2e553d4c): an anonymous inode names no path, in maps as in a descriptor link. The relative
  // target beside it is the control: the exemption is that one form, not every non-absolute mapping.
  test("an anon_inode mapping is readable evidence, while another relative mapping stays ambiguous", async () => {
    const { ownedPath, procRoot, processRoot } = fixture()
    const resource = join(processRoot, "maps")
    writeFileSync(resource, "7f000000-7f001000 rw-s 00000000 00:0e 1234 anon_inode:i915.gem\n")
    const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })
    expect(census.coverage).toMatchObject({ complete: true, sources: { maps: { readable: 1 } } })
    writeFileSync(resource, "7f000000-7f001000 rw-s 00000000 00:0e 1234 relative/mapping\n")
    const control = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })
    expect(control.coverage).toMatchObject({
      complete: false,
      processes: { sourceAmbiguous: 1 },
      sources: { maps: { unavailable: { ambiguous: 1 } } },
    })
  })

  test("ambiguous paths provably outside the selected root do not invent a coverage gap", async () => {
    const { ownedPath, procRoot, processRoot } = fixture()
    writeFileSync(
      join(processRoot, "maps"),
      "7f000000-7f001000 r--p 00000000 00:00 0 /elsewhere/file (deleted)\n7f002000-7f003000 r--p 00000000 00:00 0 /elsewhere/file\\012name\n",
    )
    symlinkSync("/elsewhere/fd (deleted)", join(processRoot, "fd", "7"))
    const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })
    expect(census.holders).toEqual([])
    expect(census.coverage).toMatchObject({
      complete: true,
      sources: {
        maps: { readable: 1, unavailable: { ambiguous: 0 } },
        fd: { readable: 1, unavailable: { ambiguous: 0 } },
      },
    })
    expect(census.coverage).not.toHaveProperty("unreadable")
  })

  test("filesystem root includes descendants while a sibling prefix does not", async () => {
    const { ownedPath, procRoot, processRoot } = fixture()
    symlinkSync(`${ownedPath}-other/file`, join(processRoot, "fd", "7"))
    expect((await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })).holders).toEqual([])
    const census = await inspectPathHolderCensusInProc("/", procRoot, { scope: "all-visible" })
    expect(census.holders).toContainEqual({ pid: 4242, source: "exe", target: "/bin/sh" })
  })

  // #26885: an absent error code must still throw, rather than invent source availability.
  test.each(["EISDIR", undefined])("unexpected source I/O with code %s names the exact resource", async (code) => {
    const { ownedPath, procRoot, processRoot } = fixture()
    const resource = join(processRoot, "maps")
    unlinkSync(resource)
    mkdirSync(resource)
    if (code === undefined) {
      const readFile = fsPromises.readFile
      vi.spyOn(fsPromises, "readFile").mockImplementation(async (...args: Parameters<typeof fsPromises.readFile>) => {
        if (String(args[0]) === resource) throw new Error("source failed without an error code")
        return readFile(...args)
      })
    }
    await expect(inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })).rejects.toThrow(
      `path-holder observation failed at '${resource}'`,
    )
  })
})

/**
 * @failure Moving the collector into a public Node package silently retains Bun-only lsof I/O or widens supported scope.
 * @level l2
 * @consumer Removely Node imports and the Yrd Darwin compatibility adapter
 */
describe("Node lsof adapter and scope boundary", () => {
  function lsofResult(code: number | string, stdout = "", stderr = "") {
    Object.defineProperty(process, "platform", { value: "darwin" })
    return vi.spyOn(childProcess, "execFile").mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
      queueMicrotask(() =>
        callback(code === 0 ? null : Object.assign(new Error(`lsof fixture ${code}`), { code }), stdout, stderr),
      )
      return new childProcess.ChildProcess()
    })
  }
  test("Node lsof preserves the unfiltered command and source mappings", async () => {
    const spawn = lsofResult(0, "p42\nfcwd\nn/\nftxt\nn/bin/sh\nfrtd\nn/\nf7\nn/tmp/held\n")
    const census = await inspectPathHolderCensus("/", { scope: "same-uid" })
    expect(census).toEqual({
      holders: [
        { pid: 42, source: "cwd", target: "/" },
        { pid: 42, source: "exe", target: "/bin/sh" },
        { pid: 42, source: "fd/7", target: "/tmp/held" },
        { pid: 42, source: "root", target: "/" },
      ],
      coverage: { platform: "darwin", mechanism: "lsof", complete: true },
    })
    expect(spawn).toHaveBeenCalledWith(
      "/usr/sbin/lsof",
      ["+D", "/", "-Fpfn"],
      expect.objectContaining({ cwd: "/", encoding: "utf8" }),
      expect.any(Function),
    )
  })
  test.each([0, 1])("lsof exit %s with an empty selection and no diagnostic succeeds", async (code) => {
    lsofResult(code)
    await expect(inspectPathHolderCensus("/", { scope: "same-uid" })).resolves.toEqual({
      holders: [],
      coverage: { platform: "darwin", mechanism: "lsof", complete: true },
    })
  })
  test.each([
    [0, "permission denied"],
    [1, "cannot stat"],
    [2, ""],
  ] as const)("lsof exit %s diagnostic '%s' refuses", async (code, diagnostic) => {
    lsofResult(code, "", diagnostic)
    await expect(inspectPathHolderCensus("/", { scope: "same-uid" })).rejects.toThrow(`lsof exited ${code} for '/'`)
  })
  test("missing lsof names the required executable", async () => {
    lsofResult("ENOENT")
    await expect(inspectPathHolderCensus("/", { scope: "same-uid" })).rejects.toThrow(
      "path-holder census requires /usr/sbin/lsof for '/'",
    )
  })
  test("all-visible Darwin refuses before invoking lsof", async () => {
    const spawn = lsofResult(0)
    await expect(inspectPathHolderCensus("/", { scope: "all-visible" })).rejects.toThrow(
      "unsupported path-holder scope 'all-visible' on platform darwin",
    )
    expect(spawn).not.toHaveBeenCalled()
  })
  test("unsupported platform and omitted or unknown scope fail loudly", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd" })
    await expect(inspectPathHolderCensus("/", { scope: "same-uid" })).rejects.toThrow("platform freebsd")
    // @ts-expect-error Scope must also be rejected for untyped JavaScript callers.
    await expect(inspectPathHolderCensus("/")).rejects.toThrow("requires explicit scope")
    // @ts-expect-error Unknown scope cannot silently default to a supported one.
    await expect(inspectPathHolderCensus("/", { scope: "unknown" })).rejects.toThrow("requires explicit scope")
  })
})

/**
 * @failure Four readers walked /proc for holders, each with its own rules: a cwd census that skipped a denied process
 *          silently, and a second walk that re-read argv the census had already read and dropped (hh 26990 slice 4).
 */
describe("the process census rows and their projections (hh 26990 slice 4)", () => {
  // Field 22 (starttime) is the 20th field after comm.
  const STAT = "4242 (bun) S 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 987654 0 0\n"

  function processFixture(cmdline: string): { procRoot: string; processRoot: string; ownedPath: string } {
    const fixture = mkdtempSync(join(tmpdir(), "removely-rows-"))
    temporary.push(fixture)
    const ownedPath = join(fixture, "owned")
    const procRoot = join(fixture, "proc")
    const processRoot = join(procRoot, "4242")
    mkdirSync(ownedPath)
    mkdirSync(join(processRoot, "fd"), { recursive: true })
    symlinkSync(ownedPath, join(processRoot, "cwd"))
    symlinkSync("/bin/sh", join(processRoot, "exe"))
    symlinkSync("/", join(processRoot, "root"))
    writeFileSync(join(processRoot, "maps"), "")
    writeFileSync(join(processRoot, "stat"), STAT)
    writeFileSync(join(processRoot, "cmdline"), cmdline)
    return { procRoot, processRoot, ownedPath }
  }

  function denyCwd(processRoot: string): void {
    const readlink = fsPromises.readlink
    vi.spyOn(fsPromises, "readlink").mockImplementation((async (path: string) => {
      if (path === join(processRoot, "cwd")) {
        throw Object.assign(new Error(`EACCES: permission denied, readlink '${path}'`), { code: "EACCES" })
      }
      return readlink(path)
    }) as typeof fsPromises.readlink)
  }

  test.runIf(process.platform === "linux")(
    "a row carries the owner uid, the kernel's start ticks and only the sources asked for; argv only when asked",
    async () => {
      const probe = processFixture("bun\0--token=secret\0")
      const census = await inspectProcessCensusInProc(probe.procRoot, { scope: "same-uid", sources: ["cwd", "argv"] })
      expect(census.rows).toEqual([
        {
          pid: 4242,
          uid: process.getuid?.(),
          comm: "bun",
          ppid: 1,
          state: "S",
          startTicks: 987654,
          sources: {
            cwd: { availability: "readable", value: probe.ownedPath, issues: [] },
            argv: { availability: "readable", value: [], issues: [] },
          },
          issues: [],
        },
      ])
      expect(Object.keys(census.coverage.sources)).toEqual(["cwd", "argv"])
      const withArgv = await inspectProcessCensusInProc(probe.procRoot, {
        scope: "same-uid",
        sources: ["argv"],
        includeArgv: true,
      })
      expect(withArgv.rows[0]?.sources.argv?.value).toEqual(["bun", "--token=secret"])
    },
  )

  test.runIf(process.platform === "linux")(
    "a denied row's argv is read for its identity although the caller asked for cwd only, and the cwd projection names it",
    async () => {
      const probe = processFixture("/usr/lib/systemd/systemd\0--user\0--deserialize=12\0")
      denyCwd(probe.processRoot)
      const cwds = await inspectProcessCwdsInProc(probe.procRoot)
      expect(cwds).toMatchObject({ rows: [], complete: false, mechanism: "proc" })
      expect(cwds.unreadable).toEqual([
        expect.objectContaining({
          pid: 4242,
          uid: process.getuid?.(),
          comm: "bun",
          denied: ["cwd"],
          argv: ["/usr/lib/systemd/systemd", "--user", "--deserialize=12"],
        }),
      ])
      const entry = cwds.unreadable[0]
      if (entry === undefined) throw new Error("no unreadable entry")
      expect(clearedByIdentity(entry)).toBe("systemd --user")
    },
  )

  test.runIf(process.platform === "linux")("the cwd projection lists every readable same-uid cwd", async () => {
    const probe = processFixture("bun\0")
    expect(await inspectProcessCwdsInProc(probe.procRoot)).toEqual({
      rows: [{ pid: 4242, cwd: probe.ownedPath }],
      complete: true,
      unreadable: [],
      mechanism: "proc",
    })
  })

  test("clearedByIdentity clears the four carried identities on a denied same-uid entry, and nothing else", () => {
    const identity = { uid: 3001 }
    const denied = (comm: string, argv: string[], extra: Partial<UnreadableProcess> = {}): UnreadableProcess => ({
      pid: 7,
      uid: 3001,
      comm,
      denied: ["cwd"],
      issues: [{ source: "cwd", resource: "/proc/7/cwd", reason: "denied", code: "EACCES" }],
      argv,
      ...extra,
    })
    expect(clearedByIdentity(denied("systemd", ["/usr/lib/systemd/systemd", "--user"]), identity)).toBe(
      "systemd --user",
    )
    // --user anywhere in argv, as clean-root matched it (@cto c1e73bcd: carried, never narrowed).
    expect(
      clearedByIdentity(denied("systemd", ["/usr/lib/systemd/systemd", "--deserialize=12", "--user"]), identity),
    ).toBe("systemd --user")
    expect(clearedByIdentity(denied("(sd-pam)", ["(sd-pam)"]), identity)).toBe("(sd-pam)")
    expect(clearedByIdentity(denied("(sd-pam)", []), identity)).toBe("(sd-pam)")
    expect(clearedByIdentity(denied("sshd-session", ["sshd-session: hh@notty"]), identity)).toBe("sshd-session")
    // ssh-agent by name whatever its argv: an agent started another way would reopen 25342.
    expect(clearedByIdentity(denied("ssh-agent", ["ssh-agent", "-s"]), identity)).toBe("ssh-agent")
    expect(
      clearedByIdentity(denied("ssh-agent", ["/usr/bin/ssh-agent", "-D", "-a", "/run/agent.sock"]), identity),
    ).toBe("ssh-agent")
    // Every other entry is a refusal: another command, the system systemd, another uid, no uid, an unanswered read.
    expect(clearedByIdentity(denied("mystery", ["mystery"]), identity)).toBeUndefined()
    expect(clearedByIdentity(denied("systemd", ["/usr/lib/systemd/systemd"]), identity)).toBeUndefined()
    expect(clearedByIdentity(denied("sd-pam", ["sd-pam"]), identity)).toBeUndefined()
    expect(clearedByIdentity(denied("(sd-pam)", ["(sd-pam)"], { uid: 0 }), identity)).toBeUndefined()
    expect(clearedByIdentity(denied("(sd-pam)", ["(sd-pam)"], { uid: undefined }), identity)).toBeUndefined()
    expect(
      clearedByIdentity(
        denied("ssh-agent", ["ssh-agent"], {
          unanswered: ["maps"],
          issues: [{ source: "maps", resource: "/proc/7/maps", reason: "unanswered" }],
        }),
        identity,
      ),
    ).toBeUndefined()
  })
})
