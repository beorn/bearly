import { afterEach, describe, expect, test } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createFlockRuntime, type FlockIo } from "../src/runtime.ts"
import { isFlockHeld, tryAcquireFlock } from "../src/index.ts"
import { createNativeFlockRuntime, libcCandidates } from "../src/native.ts"

const fixture = fileURLToPath(new URL("./fixtures/writer.ts", import.meta.url))
const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("@bearly/flock", () => {
  test("a real writer killed with SIGKILL leaves an immediately acquirable flock", async () => {
    const root = tempRoot()
    const lockPath = join(root, "writer.lock")
    const readyPath = join(root, "ready")
    const holder = Bun.spawn([process.execPath, fixture, "hold", lockPath, readyPath], {
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      await waitForFile(readyPath, holder, "holder")
      expect(tryAcquireFlock(lockPath)).toBeNull()

      holder.kill("SIGKILL")
      expect(await holder.exited).not.toBe(0)

      const successor = Bun.spawn([process.execPath, fixture, "once", lockPath], {
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await successor.exited, await stderr(successor)).toBe(0)
      expect(existsSync(lockPath)).toBe(true)
    } finally {
      holder.kill("SIGKILL")
      await holder.exited
    }
  })

  test("a stale diagnostic pathname is not ownership", () => {
    const root = tempRoot()
    const lockPath = join(root, "writer.lock")
    writeFileSync(lockPath, "dead writer\n")

    using lock = tryAcquireFlock(lockPath, { body: "live writer\n" })
    expect(lock).not.toBeNull()
    expect(readFileSync(lockPath, "utf8")).toBe("live writer\n")
    lock?.replaceBody("successor\n")
    expect(readFileSync(lockPath, "utf8")).toBe("successor\n")
  })

  test("release closes only the parent copy and preserves an inherited fd owner", async () => {
    const root = tempRoot()
    const lockPath = join(root, "writer.lock")
    const childReady = join(root, "child-ready")
    const lock = tryAcquireFlock(lockPath)
    expect(lock).not.toBeNull()
    if (lock === null) return

    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(childReady)}, "ready"); await new Promise(() => {});`,
      ],
      { stdio: ["ignore", "pipe", "pipe", lock.fd] },
    )
    try {
      await waitForFile(childReady, child, "inherited-fd child")
      lock.release()
      expect(isFlockHeld(lockPath)).toBe(true)

      child.kill("SIGKILL")
      await child.exited
      using successor = tryAcquireFlock(lockPath)
      expect(successor).not.toBeNull()
    } finally {
      child.kill("SIGKILL")
      await child.exited
      lock.release()
    }
  })

  test("same-process aliases cannot reacquire the same inode", () => {
    const root = tempRoot()
    const lockPath = join(root, "writer.lock")
    const aliasPath = join(root, "writer-alias.lock")
    using lock = tryAcquireFlock(lockPath)
    expect(lock).not.toBeNull()
    symlinkSync(lockPath, aliasPath)

    expect(tryAcquireFlock(lockPath)).toBeNull()
    expect(tryAcquireFlock(aliasPath)).toBeNull()
    expect(isFlockHeld(aliasPath)).toBe(true)
  })

  test("diagnostics retry short writes and return a handle only after fsync", () => {
    const writes: Uint8Array[] = []
    const events: string[] = []
    const fake = fakeIo({
      write(fd, bytes, offset, length) {
        const accepted = Math.min(length, writes.length + 1)
        writes.push(bytes.slice(offset, offset + accepted))
        events.push(`write:${accepted}`)
        return accepted
      },
      fsync() {
        events.push("fsync")
      },
    })
    const runtime = createFlockRuntime(fake.io, { wouldBlockErrnos: [11, 35], interruptedErrno: 4 })

    using lock = runtime.tryAcquire("/lock", { body: "héllo" })
    expect(lock).not.toBeNull()
    expect(Buffer.concat(writes).toString("utf8")).toBe("héllo")
    expect(events.at(-1)).toBe("fsync")
  })

  test.each([
    ["zero progress", () => 0, /made no progress/],
    [
      "write error",
      () => {
        throw new Error("disk full")
      },
      /disk full/,
    ],
  ])("%s closes the claim and permits an immediate successor", (_label, write, expected) => {
    const fake = fakeIo({ write })
    const runtime = createFlockRuntime(fake.io, { wouldBlockErrnos: [11, 35], interruptedErrno: 4 })

    expect(() => runtime.tryAcquire("/lock", { body: "owner" })).toThrow(expected)
    expect(fake.closed).toEqual([10])
    using successor = runtime.tryAcquire("/lock")
    expect(successor).not.toBeNull()
  })

  test("fsync failure returns no claim and clears the process-local owner", () => {
    let fail = true
    const fake = fakeIo({
      fsync() {
        if (fail) throw new Error("fsync failed")
      },
    })
    const runtime = createFlockRuntime(fake.io, { wouldBlockErrnos: [11, 35], interruptedErrno: 4 })

    expect(() => runtime.tryAcquire("/lock", { body: "owner" })).toThrow("fsync failed")
    fail = false
    using successor = runtime.tryAcquire("/lock")
    expect(successor).not.toBeNull()
  })

  test("truncate failure returns no claim and clears the process-local owner", () => {
    let fail = true
    const fake = fakeIo({
      truncate() {
        if (fail) throw new Error("truncate failed")
      },
    })
    const runtime = createFlockRuntime(fake.io, { wouldBlockErrnos: [11, 35], interruptedErrno: 4 })

    expect(() => runtime.tryAcquire("/lock", { body: "owner" })).toThrow("truncate failed")
    expect(fake.closed).toEqual([10])
    fail = false
    using successor = runtime.tryAcquire("/lock")
    expect(successor).not.toBeNull()
  })

  test("only would-block is contention; other errno values throw", () => {
    const busy = fakeIo({ flock: () => ({ ok: false, errno: 11 }) })
    const busyRuntime = createFlockRuntime(busy.io, { wouldBlockErrnos: [11, 35], interruptedErrno: 4 })
    expect(busyRuntime.tryAcquire("/busy")).toBeNull()

    const fatal = fakeIo({ flock: () => ({ ok: false, errno: 9 }) })
    const fatalRuntime = createFlockRuntime(fatal.io, { wouldBlockErrnos: [11, 35], interruptedErrno: 4 })
    expect(() => fatalRuntime.tryAcquire("/fatal")).toThrow(/flock.*errno=9.*\/fatal/)
  })

  test("the local inode registry rejects a Darwin-like self-reacquire before flock", () => {
    const fake = fakeIo()
    const runtime = createFlockRuntime(fake.io, { wouldBlockErrnos: [11, 35], interruptedErrno: 4 })
    const first = runtime.tryAcquire("/first")
    expect(first).not.toBeNull()
    expect(runtime.tryAcquire("/alias")).toBeNull()
    expect(fake.flockCalls).toBe(1)
    first?.release()
    expect(runtime.tryAcquire("/alias")).not.toBeNull()
  })

  test("blocking acquisition retries EINTR and keeps policy out of the core", () => {
    const outcomes = [{ ok: false, errno: 4 } as const, { ok: true } as const]
    const fake = fakeIo({ flock: () => outcomes.shift() ?? { ok: true } })
    const runtime = createFlockRuntime(fake.io, { wouldBlockErrnos: [11, 35], interruptedErrno: 4 })

    using lock = runtime.acquireBlocking("/lock")
    expect(lock.held).toBe(true)
  })

  test("a thrown flock syscall closes the candidate and does not poison local ownership", () => {
    let fail = true
    const fake = fakeIo({
      flock() {
        if (fail) throw new Error("ffi exploded")
        return { ok: true }
      },
    })
    const runtime = createFlockRuntime(fake.io, { wouldBlockErrnos: [11, 35], interruptedErrno: 4 })

    expect(() => runtime.tryAcquire("/lock")).toThrow("ffi exploded")
    expect(fake.closed).toEqual([10])
    fail = false
    using successor = runtime.tryAcquire("/lock")
    expect(successor).not.toBeNull()
  })

  test("replaceBody failure closes the handle and release stays idempotent", () => {
    let failWrites = false
    const fake = fakeIo({
      write(_fd, _bytes, _offset, length) {
        return failWrites ? 0 : length
      },
    })
    const runtime = createFlockRuntime(fake.io, { wouldBlockErrnos: [11, 35], interruptedErrno: 4 })
    const lock = runtime.tryAcquire("/lock")
    expect(lock).not.toBeNull()
    if (lock === null) return

    failWrites = true
    expect(() => lock.replaceBody("new owner")).toThrow(/made no progress/)
    expect(lock.held).toBe(false)
    lock.release()
    expect(fake.closed).toEqual([10])
  })

  test("libc candidates cover glibc, musl fallback, and Darwin without unsupported fallback", () => {
    expect(libcCandidates("linux")).toEqual(["libc.so.6", "libc.so"])
    expect(libcCandidates("darwin")).toEqual(["/usr/lib/libSystem.B.dylib", "libSystem.B.dylib", "libc.dylib"])
    expect(() => createNativeFlockRuntime("win32")).toThrow(/unsupported platform: win32/)
  })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bearly-flock-"))
  scratch.push(root)
  return root
}

interface ProcessHandle {
  readonly exitCode: number | null
  readonly stderr: unknown
}

async function waitForFile(path: string, processHandle: ProcessHandle, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!existsSync(path)) {
    if (processHandle.exitCode !== null)
      throw new Error(`${label} exited before becoming ready: ${await stderr(processHandle)}`)
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

async function stderr(processHandle: ProcessHandle): Promise<string> {
  return processHandle.stderr instanceof ReadableStream ? await new Response(processHandle.stderr).text() : ""
}

function fakeIo(overrides: Partial<FlockIo> = {}): { io: FlockIo; closed: number[]; flockCalls: number } {
  const closed: number[] = []
  let flockCalls = 0
  let nextFd = 10
  const io: FlockIo = {
    createParent() {},
    exists: () => true,
    open: () => nextFd++,
    identity: () => "1:2",
    flock: () => {
      flockCalls += 1
      return { ok: true }
    },
    truncate() {},
    write: (_fd, _bytes, _offset, length) => length,
    fsync() {},
    close(fd) {
      closed.push(fd)
    },
    ...overrides,
  }
  return {
    io,
    closed,
    get flockCalls() {
      return flockCalls
    },
  }
}
