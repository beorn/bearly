/** @fakes @bearly/mux-protocol */
/**
 * `@bearly/mux-protocol/testing/in-memory-mux` — the owner's reference double
 * for {@link MuxBackend}: the behavioral spec the contract suite is validated
 * against, and a zero-dependency mux for any consumer that wants one without
 * spawning a real multiplexer. Kept off the package's production entry: nothing
 * under `src/testing/` is a production entry, so a symbol only the tests consume
 * gets its own `testing/` subpath and is never folded back into `index.ts`.
 */
import {
  type MuxBackend,
  type MuxCapability,
  type MuxCapabilities,
  MuxRefNotFoundError,
  UnsupportedCapabilityError,
} from "../index.ts"

/** Full capability set — the reference backend's default, and a test default. */
export const ALL_CAPABILITIES: MuxCapabilities = {
  multiPane: true,
  renameTab: true,
  browserPane: true,
  scrollback: true,
}

interface InMemorySurface {
  id: string
  paneId: string
  lines: string[]
}
interface InMemoryPane {
  id: string
  workspace: string
  title: string
  surfaces: InMemorySurface[]
}

/**
 * Reference {@link MuxBackend} — a faithful in-memory multiplexer. It is the
 * behavioral spec the contract suite is validated against, and a zero-dependency
 * test double for any consumer that wants a mux without spawning a real one.
 *
 * `capabilities` is overridable so callers can prove capability-negotiation
 * paths (e.g. construct one with `renameTab: false` and assert the typed throw).
 */
export function createInMemoryMux(capabilities: MuxCapabilities = ALL_CAPABILITIES): MuxBackend {
  const name = "in-memory"
  const panes = new Map<string, InMemoryPane>()
  let serial = 0

  const findPane = (id: string): InMemoryPane => {
    const p = panes.get(id)
    if (!p) throw new MuxRefNotFoundError(name, "pane", id)
    return p
  }
  const findSurface = (id: string): InMemorySurface => {
    for (const p of panes.values()) {
      const s = p.surfaces.find((s) => s.id === id)
      if (s) return s
    }
    throw new MuxRefNotFoundError(name, "surface", id)
  }
  const requireCap = (cap: MuxCapability): void => {
    if (!capabilities[cap]) throw new UnsupportedCapabilityError(name, cap)
  }

  return {
    name,
    capabilities: () => capabilities,

    async spawnPane(opts) {
      if (panes.size >= 1) requireCap("multiPane")
      serial += 1
      const paneId = `pane-${serial}`
      const surfaceId = `surf-${serial}`
      panes.set(paneId, {
        id: paneId,
        workspace: opts.workspace,
        title: opts.title ?? opts.command,
        surfaces: [{ id: surfaceId, paneId, lines: [] }],
      })
      return { id: paneId, workspace: opts.workspace, primarySurfaceId: surfaceId }
    },

    async closePane(ref) {
      findPane(ref.id) // throws if unknown
      panes.delete(ref.id)
    },

    async listPanes(workspace) {
      return [...panes.values()]
        .filter((p) => p.workspace === workspace)
        .map((p) => ({ id: p.id, workspace: p.workspace }))
    },

    async listSurfaces(workspace, paneId) {
      const p = findPane(paneId)
      if (p.workspace !== workspace) return []
      return p.surfaces.map((s) => ({ id: s.id, paneId: s.paneId }))
    },

    async sendText(surface, text) {
      findSurface(surface.id).lines.push(text)
    },

    async sendKey(surface, key) {
      // Keys are recorded as bracketed markers so reads can prove routing.
      findSurface(surface.id).lines.push(`<key:${key}>`)
    },

    async readScreen(surface, opts) {
      const s = findSurface(surface.id)
      if (!capabilities.scrollback && opts?.lines === undefined) {
        // Without scrollback, only the last line is "visible".
        return s.lines.at(-1) ?? ""
      }
      const lines = opts?.lines === undefined ? s.lines : s.lines.slice(-opts.lines)
      return lines.join("\n")
    },

    async renameTab(pane, title) {
      requireCap("renameTab")
      findPane(pane.id).title = title
    },
  } satisfies MuxBackend
}
