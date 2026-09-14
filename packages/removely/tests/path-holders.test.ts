/**
 * @failure A process chrooted into a disposable path is invisible to teardown, so the path can be removed under a live holder.
 * @level l2
 * @consumer Removely inspectPathHolderCensus and Bucketeer guarded pruning
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import * as childProcess from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectPathHolderCensus, pathHolderRefusal, type PathHolder } from "../src/index.ts"
import { inspectPathHolderCensusInProc } from "../src/path-holders.ts"

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
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
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
      // Readable stat decorates a live process denial; it does not grant a waiver.
      writeFileSync(join(processRoot, "stat"), "4242 (probe) S 1 0 0 0\n")
      chmodSync(join(processRoot, "maps"), 0o000)

      const census = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })

      expect(census.holders).toEqual([])
      expect(census.coverage).toMatchObject({
        platform: "linux",
        scope: "same-uid",
        complete: false,
        processes: { enumerated: 1, sameUid: 1, otherUid: 0, unavailable: { exited: 0, denied: 0 } },
        sources: {
          cwd: { readable: 1, unavailable: { exited: 0, denied: 0 } },
          exe: { readable: 1, unavailable: { exited: 0, denied: 0 } },
          root: { readable: 1, unavailable: { exited: 0, denied: 0 } },
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

      await expect(inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "same-uid" })).resolves.toMatchObject({
        holders: [],
        coverage: {
          platform: "linux",
          scope: "same-uid",
          procRoot,
          complete: true,
          processes: { enumerated: 0, sameUid: 0, otherUid: 0, zombie: 0, unavailable: { exited: 0, denied: 0 } },
          sources: {
            cwd: { readable: 0, unavailable: { exited: 0, denied: 0 } },
            exe: { readable: 0, unavailable: { exited: 0, denied: 0 } },
            root: { readable: 0, unavailable: { exited: 0, denied: 0 } },
            maps: { readable: 0, unavailable: { exited: 0, denied: 0 } },
            fd: { readable: 0, unavailable: { exited: 0, denied: 0 } },
          },
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
    writeFileSync(join(processRoot, "stat"), `${pid} (probe) S 1 0 0 0\n`)
    return { ownedPath, procRoot, processRoot }
  }

  test.each(["exe", "maps", "fd"] as const)(
    "missing %s under a live PID names the resource and remains incomplete",
    async (source) => {
      const { ownedPath, procRoot, processRoot } = fixture()
      const resource = join(processRoot, source)
      if (source === "fd") rmSync(resource, { recursive: true })
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
    const afterExit = await inspectPathHolderCensusInProc(ownedPath, procRoot, { scope: "all-visible" })
    expect(afterExit.coverage).toMatchObject({
      complete: false,
      sources: { fd: { unavailable: { denied: 1, missing: 0, ambiguous: 1 } } },
      unreadable: [
        {
          pid: 4242,
          issues: expect.arrayContaining([
            expect.objectContaining({ source: "fd", resource: join(processRoot, "fd", "7"), reason: "denied" }),
            expect.objectContaining({ source: "fd", resource: join(processRoot, "fd", "9"), reason: "ambiguous" }),
          ]),
        },
      ],
    })
  })

  test("source disappearance counts as exit only after the process directory disappears", async () => {
    const { ownedPath, procRoot, processRoot } = fixture()
    const resource = join(processRoot, "maps")
    const readFile = fsPromises.readFile
    vi.spyOn(fsPromises, "readFile").mockImplementation(async (...args: Parameters<typeof fsPromises.readFile>) => {
      if (String(args[0]) === resource) rmSync(processRoot, { recursive: true })
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

  test("unexpected source I/O names the exact resource", async () => {
    const { ownedPath, procRoot, processRoot } = fixture()
    const resource = join(processRoot, "maps")
    unlinkSync(resource)
    mkdirSync(resource)
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
