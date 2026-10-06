/**
 * @reach fs-walk <fixture-only: scratch creates a mkdtempSync verdict directory>
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  classifyErrno,
  exitCodeForVerdict,
  readVerdictArtifact,
  writeVerdictArtifact,
  type VerdictArtifact,
} from "../src/verdict.ts"

const faults = vi.hoisted(() => ({ short: false, failure: "", syncs: 0 }))
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>()
  return {
    ...real,
    writeSync: (fd: number, bytes: Uint8Array, offset: number, length: number) => {
      if (faults.failure === "write") throw new Error("injected write failure")
      return real.writeSync(fd, bytes, offset, faults.short ? Math.min(3, length) : length)
    },
    fsyncSync: (fd: number) => {
      faults.syncs += 1
      if (faults.failure === "directory" && faults.syncs === 2) throw new Error("injected directory fsync failure")
      return real.fsyncSync(fd)
    },
    linkSync: (...args: Parameters<typeof real.linkSync>) => {
      if (faults.failure === "link") throw Object.assign(new Error("injected link refusal"), { code: "EPERM" })
      return real.linkSync(...args)
    },
  }
})
// A setup file can load this module before the mock above registers (the superproject's root vitest
// setup reaches it through habitat.ts), and a cached instance keeps the real node:fs. A fresh instance
// after resetModules binds the mocked one, so the injected faults reach the code under test.
vi.resetModules()
const { atomicPublishFileSync, atomicWriteFileSync } = await import("../src/index.ts")

const roots: string[] = []
const OBSERVED_AT = "2026-08-14T20:00:00.000Z"

afterEach(() => {
  faults.short = false
  faults.failure = ""
  faults.syncs = 0
  for (const root of roots.splice(0)) {
    safeRemoveSync(root, { within: tmpdir(), allowMissing: true })
  }
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "durable-file-test-"))
  roots.push(root)
  return root
}

function artifact(overrides: Partial<VerdictArtifact> = {}): VerdictArtifact {
  return {
    schema: "bearly.verdict/v1",
    subject: "commit:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    verdict: "OK",
    domain: "product",
    reason: { kind: "PRODUCT_PASSED" },
    observedAt: OBSERVED_AT,
    ...overrides,
  }
}

describe("atomicWriteFileSync", () => {
  test("publishes complete replacement bytes and leaves no sibling temp file", () => {
    const root = scratch()
    const path = join(root, "verdict.json")
    writeFileSync(path, "old")

    atomicWriteFileSync(path, Buffer.from("new verdict\n"))

    expect(readFileSync(path, "utf8")).toBe("new verdict\n")
    expect(readdirSync(root)).toEqual(["verdict.json"])
  })
})

/** @failure Exclusive first publication overwrites, tears bytes or hides durability failure. @level l2 @consumer habitat scratch marker and signing-key creator */
describe("atomicPublishFileSync", () => {
  test("publishes once with private mode and never overwrites the winner", () => {
    const root = scratch(),
      path = join(root, "marker")
    expect(atomicPublishFileSync(path, "first")).toBe("published")
    expect(atomicPublishFileSync(path, "second")).toBe("exists")
    expect(readFileSync(path, "utf8")).toBe("first")
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(root)).toEqual(["marker"])
  })
  test("requires the caller's parent directory and a nonempty path", () => {
    const root = scratch()
    expect(() => atomicPublishFileSync(join(root, "missing", "marker"), "body")).toThrow()
    expect(existsSync(join(root, "missing"))).toBe(false)
    expect(() => atomicPublishFileSync(" ", "body")).toThrow(/path must not be empty/)
  })
  test("writes all bytes despite short writes", () => {
    faults.short = true
    const path = join(scratch(), "marker")
    expect(atomicPublishFileSync(path, "complete marker bytes")).toBe("published")
    expect(readFileSync(path, "utf8")).toBe("complete marker bytes")
  })
  test.each(["write", "link"])("cleans temporary bytes after a %s failure without publishing", (phase) => {
    const root = scratch(),
      path = join(root, "marker")
    faults.failure = phase
    expect(() => atomicPublishFileSync(path, "body")).toThrow(/injected/)
    expect(readdirSync(root)).toEqual([])
  })
  test("names a post-publication durability failure and retains the complete destination", () => {
    const root = scratch(),
      path = join(root, "marker")
    faults.failure = "directory"
    try {
      atomicPublishFileSync(path, "complete")
      throw new Error("publication should fail")
    } catch (error) {
      expect(error).toMatchObject({ name: "AtomicPublicationError", published: true, path })
      expect(String(error)).toContain("destination exists complete")
    }
    expect(readFileSync(path, "utf8")).toBe("complete")
    expect(readdirSync(root)).toEqual(["marker"])
  })
  test("concurrent publishers elect one winner and readers see only its complete bytes", async () => {
    const root = scratch(),
      path = join(root, "marker")
    const modulePath = fileURLToPath(new URL("../src/index.ts", import.meta.url))
    const script = join(root, "publisher.ts")
    writeFileSync(
      script,
      `import { atomicPublishFileSync } from ${JSON.stringify(modulePath)}; await new Response(Bun.stdin).text(); const body=Bun.argv[3].repeat(250000); console.log(JSON.stringify({result:atomicPublishFileSync(Bun.argv[2], body),body:Bun.argv[3]}))`,
    )
    const children = Array.from({ length: 6 }, (_, i) =>
      spawn(process.execPath, [script, path, String(i)], { stdio: ["pipe", "pipe", "pipe"] }),
    )
    const results = children.map(
      (child) =>
        new Promise<{ result: string; body: string }>((resolve, reject) => {
          let out = "",
            err = ""
          child.stdout.on("data", (data) => {
            out += data
          })
          child.stderr.on("data", (data) => {
            err += data
          })
          child.on("error", reject)
          child.on("close", (code) => {
            if (code !== 0) {
              reject(new Error(`publisher ${code}: ${err}`))
              return
            }
            try {
              const value: unknown = JSON.parse(out)
              if (
                typeof value !== "object" ||
                value === null ||
                !("result" in value) ||
                !("body" in value) ||
                typeof value.result !== "string" ||
                typeof value.body !== "string"
              ) {
                throw new Error(`invalid publisher receipt: ${out}`)
              }
              resolve({ result: value.result, body: value.body })
            } catch (error) {
              reject(error)
            }
          })
        }),
    )
    let done = false
    const finished = Promise.allSettled(results).finally(() => {
      done = true
    })
    for (const child of children) child.stdin.end("go")
    const observed = new Set<string>()
    while (!done) {
      if (existsSync(path)) observed.add(readFileSync(path, "utf8"))
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const settled = await finished
    for (const row of settled) if (row.status === "rejected") throw row.reason
    const rows = settled.flatMap((row) => (row.status === "fulfilled" ? [row.value] : []))
    expect(rows.filter((row) => row.result === "published")).toHaveLength(1)
    expect(rows.filter((row) => row.result === "exists")).toHaveLength(5)
    const winner = rows.find((row) => row.result === "published")!.body.repeat(250000)
    expect(observed.size).toBeGreaterThan(0)
    observed.add(readFileSync(path, "utf8"))
    expect([...observed]).toEqual([winner])
    expect(readdirSync(root).sort()).toEqual(["marker", "publisher.ts"])
  })
})

describe("errno classification", () => {
  test.each([
    [{ code: "ENOSPC" }, "disk-space"],
    [{ code: "EDQUOT" }, "disk-quota"],
    [{ code: "EMFILE" }, "process-file-descriptors"],
    [{ code: "ENFILE" }, "system-file-descriptors"],
    [{ code: "ENOMEM" }, "memory"],
    [{ code: "EAGAIN", syscall: "spawn" }, "process-slots"],
  ] as const)("maps $0.code to a typed resource refusal", (fields, resource) => {
    expect(classifyErrno(Object.assign(new Error("boom"), fields))).toEqual({
      kind: "RESOURCE_EXHAUSTED",
      errno: fields.code,
      resource,
    })
  })

  test("does not treat non-process EAGAIN as exhausted process slots", () => {
    expect(classifyErrno(Object.assign(new Error("try again"), { code: "EAGAIN", syscall: "read" }))).toBeNull()
  })

  test("walks a bounded cause chain and gives wrapped and direct errnos the same result", () => {
    const direct = Object.assign(new Error("disk full"), { code: "ENOSPC" })
    const wrapped = new Error("outer", { cause: new Error("middle", { cause: direct }) })

    expect(classifyErrno(wrapped)).toEqual(classifyErrno(direct))
  })

  test("does not classify arbitrary message text as an errno", () => {
    expect(classifyErrno(new Error("ENOSPC while doing something unrelated"))).toBeNull()
  })
})

describe("strict verdict artifacts", () => {
  test("round-trips one canonical artifact through the atomic writer", () => {
    const path = join(scratch(), "verdict.json")
    const expected = artifact({
      observations: {
        headroom_at_start: { source: "statfs:/tmp", observedAt: OBSERVED_AT, detail: "427937 free inodes" },
      },
    })

    writeVerdictArtifact(path, expected)

    expect(readVerdictArtifact(path, { subject: expected.subject, exitCode: 0, observedAt: OBSERVED_AT })).toEqual(
      expected,
    )
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`)
  })

  test.each([
    ["absent", (path: string) => path],
    ["malformed", (path: string) => (writeFileSync(path, "not json"), path)],
    [
      "version-unknown",
      (path: string) => (writeFileSync(path, JSON.stringify({ ...artifact(), schema: "bearly.verdict/v2" })), path),
    ],
    [
      "subject-mismatch",
      (path: string) => (writeFileSync(path, JSON.stringify(artifact({ subject: "commit:other" }))), path),
    ],
    ["exit-inconsistent", (path: string) => (writeFileSync(path, JSON.stringify(artifact())), path)],
  ] as const)("derives REFUSE / VERDICT_MISSING for %s input", (issue, prepare) => {
    const path = prepare(join(scratch(), "verdict.json"))
    const exitCode = issue === "exit-inconsistent" ? 1 : 0

    const actual = readVerdictArtifact(path, {
      subject: artifact().subject,
      exitCode,
      observedAt: OBSERVED_AT,
    })

    expect(actual).toMatchObject({
      schema: "bearly.verdict/v1",
      subject: artifact().subject,
      verdict: "REFUSE",
      domain: "harness",
      reason: { kind: "VERDICT_MISSING", issue },
    })
  })

  test("rejects unknown fields rather than silently accepting a wider schema", () => {
    const path = join(scratch(), "verdict.json")
    writeFileSync(path, JSON.stringify({ ...artifact(), extra: true }))

    expect(
      readVerdictArtifact(path, { subject: artifact().subject, exitCode: 0, observedAt: OBSERVED_AT }),
    ).toMatchObject({
      verdict: "REFUSE",
      reason: { kind: "VERDICT_MISSING", issue: "malformed" },
    })
  })

  test("keeps REFUSE distinct while mapping the four verdicts onto advisory exit codes", () => {
    expect(exitCodeForVerdict("OK")).toBe(0)
    expect(exitCodeForVerdict("FAIL")).toBe(1)
    expect(exitCodeForVerdict("REFUSE")).toBe(2)
    expect(exitCodeForVerdict("ABORT")).toBe(2)
  })

  test("does not create the destination when schema validation rejects the artifact", () => {
    const path = join(scratch(), "verdict.json")
    const invalid = { ...artifact(), subject: "" } as VerdictArtifact

    expect(() => writeVerdictArtifact(path, invalid)).toThrow(/subject/u)
    expect(existsSync(path)).toBe(false)
  })
})
