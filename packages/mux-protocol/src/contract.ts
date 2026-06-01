/**
 * `@bearly/mux-protocol/contract` — the backend-agnostic contract suite.
 *
 * {@link muxContractCases} returns a framework-agnostic list of named cases
 * (each `{ name, run }`) asserting the behavioral invariants ANY
 * {@link MuxBackend} must satisfy. A backend's test file iterates the cases
 * with its own runner:
 *
 * ```ts
 * import { test } from "vitest"
 * import { muxContractCases } from "@bearly/mux-protocol/contract"
 * for (const c of muxContractCases(makeBackend)) test(c.name, c.run)
 * ```
 *
 * Cases are CAPABILITY-ADAPTIVE: a single case asserts the happy path when the
 * backend declares the capability, and the typed {@link UnsupportedCapabilityError}
 * when it does not. Same suite, any backend — divergence beyond `capabilities()`
 * is a bug (the kill-criterion for @km/silvery/17273).
 *
 * Zero test-framework dependency — assertions use `node:assert/strict`.
 */
import assert from "node:assert/strict"
import { type MuxBackend, MuxRefNotFoundError, UnsupportedCapabilityError } from "./index.ts"

export interface ContractCase {
  readonly name: string
  readonly run: () => Promise<void>
}

/** Assert that `fn` rejects with an instance of `ctor`. */
async function rejectsWith(fn: () => Promise<unknown>, ctor: new (...a: never[]) => Error): Promise<Error> {
  try {
    await fn()
  } catch (err) {
    assert.ok(err instanceof ctor, `expected ${ctor.name}, got ${(err as Error)?.name}: ${String(err)}`)
    return err as Error
  }
  throw new assert.AssertionError({ message: `expected ${ctor.name} to be thrown, but nothing was` })
}

/**
 * Build the contract cases for `makeBackend`. Each case calls `makeBackend()`
 * for a FRESH, isolated backend, so cases never share state.
 */
export function muxContractCases(makeBackend: () => MuxBackend): ContractCase[] {
  const WS = "ws-main"
  const spawn1 = async (b: MuxBackend, ws = WS) => b.spawnPane({ workspace: ws, command: "bash" })
  const primarySurface = async (b: MuxBackend, ws: string, paneId: string) => {
    const surfaces = await b.listSurfaces(ws, paneId)
    assert.ok(surfaces.length >= 1, "spawned pane must expose at least one surface")
    return surfaces[0]!
  }

  return [
    // ── A. capabilities + identity ──
    {
      name: "capabilities() exposes all four boolean discriminants",
      run: async () => {
        const caps = makeBackend().capabilities()
        for (const k of ["multiPane", "renameTab", "browserPane", "scrollback"] as const) {
          assert.equal(typeof caps[k], "boolean", `capability '${k}' must be boolean`)
        }
      },
    },
    {
      name: "capabilities() is stable across calls",
      run: async () => {
        const b = makeBackend()
        assert.deepEqual(b.capabilities(), b.capabilities())
      },
    },
    {
      name: "backend exposes a non-empty name",
      run: async () => {
        assert.ok(makeBackend().name.length > 0)
      },
    },

    // ── B. spawn + list lifecycle ──
    {
      name: "spawnPane returns a pane in the requested workspace",
      run: async () => {
        const pane = await spawn1(makeBackend())
        assert.equal(pane.workspace, WS)
      },
    },
    {
      name: "spawnPane returns a non-empty pane id",
      run: async () => {
        const pane = await spawn1(makeBackend())
        assert.ok(pane.id.length > 0)
      },
    },
    {
      name: "spawned pane appears in listPanes(workspace)",
      run: async () => {
        const b = makeBackend()
        const pane = await spawn1(b)
        const ids = (await b.listPanes(WS)).map((p) => p.id)
        assert.ok(ids.includes(pane.id))
      },
    },
    {
      name: "listPanes is empty for an unknown workspace",
      run: async () => {
        const b = makeBackend()
        await spawn1(b)
        assert.deepEqual(await b.listPanes("ws-nonexistent"), [])
      },
    },
    {
      name: "listPanes is scoped to its workspace",
      run: async () => {
        const b = makeBackend()
        const a = await spawn1(b, "ws-a")
        assert.ok(!(await b.listPanes("ws-b")).some((p) => p.id === a.id))
      },
    },
    {
      name: "second spawnPane honors multiPane capability (or throws UnsupportedCapability)",
      run: async () => {
        const b = makeBackend()
        await spawn1(b)
        if (b.capabilities().multiPane) {
          await spawn1(b)
          assert.ok((await b.listPanes(WS)).length >= 2)
        } else {
          const err = await rejectsWith(() => spawn1(b), UnsupportedCapabilityError)
          assert.equal((err as UnsupportedCapabilityError).capability, "multiPane")
        }
      },
    },
    {
      name: "spawned pane exposes at least one surface",
      run: async () => {
        const b = makeBackend()
        const pane = await spawn1(b)
        assert.ok((await b.listSurfaces(WS, pane.id)).length >= 1)
      },
    },
    {
      name: "each surface reports its owning paneId",
      run: async () => {
        const b = makeBackend()
        const pane = await spawn1(b)
        for (const s of await b.listSurfaces(WS, pane.id)) assert.equal(s.paneId, pane.id)
      },
    },

    // ── C. close ──
    {
      name: "closePane removes the pane from listPanes",
      run: async () => {
        const b = makeBackend()
        const pane = await spawn1(b)
        await b.closePane(pane)
        assert.ok(!(await b.listPanes(WS)).some((p) => p.id === pane.id))
      },
    },
    {
      name: "closePane on an unknown pane throws MuxRefNotFoundError",
      run: async () => {
        const b = makeBackend()
        await rejectsWith(() => b.closePane({ id: "pane-ghost", workspace: WS }), MuxRefNotFoundError)
      },
    },
    {
      name: "closing one pane leaves siblings intact (multiPane backends)",
      run: async () => {
        const b = makeBackend()
        if (!b.capabilities().multiPane) return
        const a = await spawn1(b)
        const c = await spawn1(b)
        await b.closePane(a)
        const ids = (await b.listPanes(WS)).map((p) => p.id)
        assert.ok(!ids.includes(a.id) && ids.includes(c.id))
      },
    },
    {
      name: "listSurfaces after close throws MuxRefNotFoundError",
      run: async () => {
        const b = makeBackend()
        const pane = await spawn1(b)
        await b.closePane(pane)
        await rejectsWith(() => b.listSurfaces(WS, pane.id), MuxRefNotFoundError)
      },
    },

    // ── D. io: send + read ──
    {
      name: "readScreen of a fresh surface is empty",
      run: async () => {
        const b = makeBackend()
        const pane = await spawn1(b)
        const s = await primarySurface(b, WS, pane.id)
        assert.equal(await b.readScreen(s), "")
      },
    },
    {
      name: "sendText then readScreen reflects the text",
      run: async () => {
        const b = makeBackend()
        const pane = await spawn1(b)
        const s = await primarySurface(b, WS, pane.id)
        await b.sendText(s, "HELLO_MUX")
        assert.ok((await b.readScreen(s)).includes("HELLO_MUX"))
      },
    },
    {
      name: "two sendText calls appear in order",
      run: async () => {
        const b = makeBackend()
        const pane = await spawn1(b)
        const s = await primarySurface(b, WS, pane.id)
        await b.sendText(s, "FIRST")
        await b.sendText(s, "SECOND")
        const out = await b.readScreen(s)
        assert.ok(out.indexOf("FIRST") < out.indexOf("SECOND"))
      },
    },
    {
      name: "readScreen {lines:1} returns only the last line",
      run: async () => {
        const b = makeBackend()
        const pane = await spawn1(b)
        const s = await primarySurface(b, WS, pane.id)
        await b.sendText(s, "OLD")
        await b.sendText(s, "NEW")
        const out = await b.readScreen(s, { lines: 1 })
        assert.ok(out.includes("NEW") && !out.includes("OLD"))
      },
    },
    {
      name: "sendKey is delivered to the surface",
      run: async () => {
        const b = makeBackend()
        const pane = await spawn1(b)
        const s = await primarySurface(b, WS, pane.id)
        await b.sendKey(s, "Enter")
        // Contract: sendKey must not throw and must reach the surface; backends
        // render keys differently, so we only assert no-throw + surface readable.
        assert.equal(typeof (await b.readScreen(s)), "string")
      },
    },
    {
      name: "input is isolated between panes (multiPane backends)",
      run: async () => {
        const b = makeBackend()
        if (!b.capabilities().multiPane) return
        const a = await spawn1(b)
        const c = await spawn1(b)
        const sa = await primarySurface(b, WS, a.id)
        const sc = await primarySurface(b, WS, c.id)
        await b.sendText(sa, "ONLY_IN_A")
        assert.ok(!(await b.readScreen(sc)).includes("ONLY_IN_A"))
      },
    },
    {
      name: "readScreen of an unknown surface throws MuxRefNotFoundError",
      run: async () => {
        const b = makeBackend()
        await rejectsWith(() => b.readScreen({ id: "surf-ghost", paneId: "pane-ghost" }), MuxRefNotFoundError)
      },
    },
    {
      name: "sendText to an unknown surface throws MuxRefNotFoundError",
      run: async () => {
        const b = makeBackend()
        await rejectsWith(() => b.sendText({ id: "surf-ghost", paneId: "p" }, "x"), MuxRefNotFoundError)
      },
    },
    {
      name: "sendKey to an unknown surface throws MuxRefNotFoundError",
      run: async () => {
        const b = makeBackend()
        await rejectsWith(() => b.sendKey({ id: "surf-ghost", paneId: "p" }, "Enter"), MuxRefNotFoundError)
      },
    },

    // ── E. surfaces ──
    {
      name: "listSurfaces on an unknown pane throws MuxRefNotFoundError",
      run: async () => {
        const b = makeBackend()
        await rejectsWith(() => b.listSurfaces(WS, "pane-ghost"), MuxRefNotFoundError)
      },
    },
    {
      name: "listSurfaces for a pane in another workspace is empty",
      run: async () => {
        const b = makeBackend()
        const pane = await spawn1(b, "ws-a")
        assert.deepEqual(await b.listSurfaces("ws-b", pane.id), [])
      },
    },
    {
      name: "surface ids are non-empty",
      run: async () => {
        const b = makeBackend()
        const pane = await spawn1(b)
        for (const s of await b.listSurfaces(WS, pane.id)) assert.ok(s.id.length > 0)
      },
    },

    // ── F. metadata + capability negotiation ──
    {
      name: "renameTab honors capability (succeeds, or throws UnsupportedCapability with .capability)",
      run: async () => {
        const b = makeBackend()
        const pane = await spawn1(b)
        if (b.capabilities().renameTab) {
          await b.renameTab(pane, "new-title") // must not throw
        } else {
          const err = await rejectsWith(() => b.renameTab(pane, "new-title"), UnsupportedCapabilityError)
          assert.equal((err as UnsupportedCapabilityError).capability, "renameTab")
        }
      },
    },
    {
      name: "renameTab on an unknown pane throws (RefNotFound when supported, Unsupported otherwise)",
      run: async () => {
        const b = makeBackend()
        const ghost = { id: "pane-ghost", workspace: WS }
        if (b.capabilities().renameTab) {
          await rejectsWith(() => b.renameTab(ghost, "t"), MuxRefNotFoundError)
        } else {
          await rejectsWith(() => b.renameTab(ghost, "t"), UnsupportedCapabilityError)
        }
      },
    },
    {
      name: "UnsupportedCapabilityError carries the backend name and capability",
      run: async () => {
        const b = makeBackend()
        if (b.capabilities().renameTab) return // only meaningful when a cap is OFF
        const pane = await spawn1(b)
        const err = (await rejectsWith(
          () => b.renameTab(pane, "t"),
          UnsupportedCapabilityError,
        )) as UnsupportedCapabilityError
        assert.equal(err.backend, b.name)
        assert.ok(["multiPane", "renameTab", "browserPane", "scrollback"].includes(err.capability))
      },
    },
    {
      name: "browserPane capability is a declared boolean (negotiable, never a crash)",
      run: async () => {
        assert.equal(typeof makeBackend().capabilities().browserPane, "boolean")
      },
    },
  ]
}
