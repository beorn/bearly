/**
 * Runs the shared {@link muxContractCases} against the cmux adapter wired to a
 * STATEFUL FAKE cmux — proving the adapter + a faithful cmux simulator satisfy
 * the exact same behavioral contract as the in-memory reference (the
 * kill-criterion for 17273: divergence beyond capabilities() is a bug). Plus
 * explicit argv-translation + error-mapping assertions that pin how the adapter
 * speaks cmux. The fake encodes the cmux argv contract Phase 2 verifies against
 * the real binary before any tent refactor. @km/silvery/17273 (Phase 1).
 */
import { describe, expect, test } from "vitest"
import { MuxRefNotFoundError } from "@bearly/mux-protocol"
import { muxContractCases } from "@bearly/mux-protocol/contract"
import { type CmuxExec, type CmuxExecResult, createCmuxBackend } from "../src/index.ts"

// ── Stateful fake cmux: implements the argv contract the adapter emits ──
interface FakePane {
  workspace: string
  title: string
  surfaces: Map<string, string[]>
}
function parse(args: string[]): { verb: string; flags: Record<string, string> } {
  const [verb, ...rest] = args
  const flags: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a.startsWith("--")) {
      flags[a.slice(2)] = rest[i + 1] ?? ""
      i++
    }
  }
  return { verb: verb ?? "", flags }
}
const ok = (stdout = ""): CmuxExecResult => ({ stdout, stderr: "", code: 0 })
const notFound = (what: string): CmuxExecResult => ({ stdout: "", stderr: `cmux: ${what} not found`, code: 1 })

function createFakeCmux(): CmuxExec {
  const panes = new Map<string, FakePane>()
  const surfaceOwner = new Map<string, { paneId: string }>()
  let serial = 0
  const findSurface = (id: string): string[] | null => {
    const owner = surfaceOwner.get(id)
    if (!owner) return null
    return panes.get(owner.paneId)?.surfaces.get(id) ?? null
  }
  return async (args) => {
    const { verb, flags } = parse(args)
    switch (verb) {
      case "new-pane": {
        serial += 1
        const paneId = `cpane-${serial}`
        const surfaceId = `csurf-${serial}`
        const pane: FakePane = {
          workspace: flags.workspace!,
          title: flags.title ?? flags.command ?? "",
          surfaces: new Map(),
        }
        pane.surfaces.set(surfaceId, [])
        surfaceOwner.set(surfaceId, { paneId })
        panes.set(paneId, pane)
        return ok(paneId)
      }
      case "close-pane": {
        const id = flags.pane!
        if (!panes.has(id)) return notFound(`pane ${id}`)
        for (const sid of panes.get(id)!.surfaces.keys()) surfaceOwner.delete(sid)
        panes.delete(id)
        return ok()
      }
      case "list-panes": {
        const ids = [...panes.entries()].filter(([, p]) => p.workspace === flags.workspace).map(([id]) => id)
        return ok(ids.join("\n"))
      }
      case "list-pane-surfaces": {
        const pane = panes.get(flags.pane!)
        if (!pane) return notFound(`pane ${flags.pane}`)
        if (pane.workspace !== flags.workspace) return ok("") // exists, other workspace → empty
        return ok([...pane.surfaces.keys()].join("\n"))
      }
      case "read-screen": {
        const lines = findSurface(flags.surface!)
        if (lines === null) return notFound(`surface ${flags.surface}`)
        const n = flags.lines === undefined ? undefined : Number(flags.lines)
        return ok((n === undefined ? lines : lines.slice(-n)).join("\n"))
      }
      case "send-text": {
        const lines = findSurface(flags.surface!)
        if (lines === null) return notFound(`surface ${flags.surface}`)
        lines.push(flags.text ?? "")
        return ok()
      }
      case "send-key": {
        const lines = findSurface(flags.surface!)
        if (lines === null) return notFound(`surface ${flags.surface}`)
        lines.push(`<key:${flags.key}>`)
        return ok()
      }
      case "rename-tab": {
        const pane = panes.get(flags.pane!)
        if (!pane) return notFound(`pane ${flags.pane}`)
        pane.title = flags.title ?? ""
        return ok()
      }
      default:
        return { stdout: "", stderr: `cmux: unknown verb ${verb}`, code: 2 }
    }
  }
}

describe("MuxBackend contract — cmux adapter over a stateful fake cmux", () => {
  // Fresh fake per case so the shared contract suite stays isolated.
  for (const c of muxContractCases(() => createCmuxBackend({ exec: createFakeCmux() }))) test(c.name, c.run)
})

describe("cmux adapter — argv translation (how the adapter speaks cmux)", () => {
  function recordingExec(): { exec: CmuxExec; calls: string[][] } {
    const calls: string[][] = []
    const exec: CmuxExec = async (args) => {
      calls.push(args)
      // Minimal canned replies so the adapter's parse step succeeds.
      if (args[0] === "new-pane") return ok("cpane-1")
      if (args[0] === "list-panes") return ok("cpane-1")
      if (args[0] === "list-pane-surfaces") return ok("csurf-1")
      if (args[0] === "read-screen") return ok("screen text")
      return ok()
    }
    return { exec, calls }
  }

  test("spawnPane → new-pane --workspace --command (+cwd/title when given)", async () => {
    const { exec, calls } = recordingExec()
    await createCmuxBackend({ exec }).spawnPane({ workspace: "w", command: "bash", cwd: "/tmp", title: "t" })
    expect(calls[0]).toEqual(["new-pane", "--workspace", "w", "--command", "bash", "--cwd", "/tmp", "--title", "t"])
  })

  test("listPanes → list-panes --workspace; parses one id per line", async () => {
    const { exec, calls } = recordingExec()
    const panes = await createCmuxBackend({ exec }).listPanes("w")
    expect(calls[0]).toEqual(["list-panes", "--workspace", "w"])
    expect(panes).toEqual([{ id: "cpane-1", workspace: "w" }])
  })

  test("listSurfaces → list-pane-surfaces --workspace --pane", async () => {
    const { exec, calls } = recordingExec()
    const surfaces = await createCmuxBackend({ exec }).listSurfaces("w", "cpane-1")
    expect(calls[0]).toEqual(["list-pane-surfaces", "--workspace", "w", "--pane", "cpane-1"])
    expect(surfaces).toEqual([{ id: "csurf-1", paneId: "cpane-1" }])
  })

  test("readScreen → read-screen --surface --lines; returns raw stdout", async () => {
    const { exec, calls } = recordingExec()
    const text = await createCmuxBackend({ exec }).readScreen({ id: "csurf-1", paneId: "cpane-1" }, { lines: 20 })
    expect(calls[0]).toEqual(["read-screen", "--surface", "csurf-1", "--lines", "20"])
    expect(text).toBe("screen text")
  })

  test("sendText / sendKey / renameTab → expected argv", async () => {
    const { exec, calls } = recordingExec()
    const b = createCmuxBackend({ exec })
    await b.sendText({ id: "csurf-1", paneId: "cpane-1" }, "hi")
    await b.sendKey({ id: "csurf-1", paneId: "cpane-1" }, "Enter")
    await b.renameTab({ id: "cpane-1", workspace: "w" }, "title")
    expect(calls).toEqual([
      ["send-text", "--surface", "csurf-1", "--text", "hi"],
      ["send-key", "--surface", "csurf-1", "--key", "Enter"],
      ["rename-tab", "--pane", "cpane-1", "--title", "title"],
    ])
  })

  test("capabilities() — cmux is the full-featured backend", async () => {
    expect(createCmuxBackend({ exec: recordingExec().exec }).capabilities()).toEqual({
      multiPane: true,
      renameTab: true,
      browserPane: true,
      scrollback: true,
    })
  })
})

describe("cmux adapter — error mapping (NO SILENT ERRORS)", () => {
  const failing =
    (res: CmuxExecResult): CmuxExec =>
    async () =>
      res

  test("cmux 'not found' → typed MuxRefNotFoundError", async () => {
    const b = createCmuxBackend({ exec: failing({ stdout: "", stderr: "cmux: pane x not found", code: 1 }) })
    await expect(b.closePane({ id: "x", workspace: "w" })).rejects.toBeInstanceOf(MuxRefNotFoundError)
  })

  test("other non-zero exit → loud Error (not swallowed)", async () => {
    const b = createCmuxBackend({ exec: failing({ stdout: "", stderr: "cmux: daemon offline", code: 3 }) })
    await expect(b.listPanes("w")).rejects.toThrow(/daemon offline/)
  })

  test("new-pane with empty stdout → loud Error (no phantom pane id)", async () => {
    const b = createCmuxBackend({ exec: failing({ stdout: "", stderr: "", code: 0 }) })
    await expect(b.spawnPane({ workspace: "w", command: "bash" })).rejects.toThrow(/no pane id/)
  })
})
