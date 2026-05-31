/**
 * `@bearly/mux-protocol` — the backend-agnostic multiplexer interface that lets
 * a coordinator (tent/chief) drive agent panes without knowing whether it is
 * talking to cmux, tmux-directly, or silvermux underneath.
 *
 * Extracted BOTTOM-UP from tent/chief's ACTUAL cmux usage (audit:
 * `@km/silvery/19260-silvermux-prototype/17273`), not designed from first
 * principles. The surface is deliberately minimal — only the verbs tent calls:
 *
 *   - lifecycle: {@link MuxBackend.spawnPane}, {@link MuxBackend.closePane}
 *   - enumerate: {@link MuxBackend.listPanes}, {@link MuxBackend.listSurfaces}
 *   - io:        {@link MuxBackend.sendText}, {@link MuxBackend.sendKey},
 *                {@link MuxBackend.readScreen}
 *   - metadata:  {@link MuxBackend.renameTab}
 *   - negotiation: {@link MuxBackend.capabilities}
 *
 * NO event/subscribe verb: the audit found tent is poll-only (it scrapes via
 * `read-screen` on a cadence; nothing consumes cmux's NDJSON event stream), so
 * adding `subscribe()` would be speculative over-design. @km/silvery/17273.
 *
 * Addressing model mirrors cmux: a **pane** is the lifecycle/metadata unit; a
 * **surface** is the addressable I/O unit inside a pane (tent reads via
 * `read-screen --surface <id>`). A freshly spawned pane has one primary surface.
 *
 * The contract suite ({@link ./contract}) defines behavioral invariants any
 * backend must satisfy; {@link createInMemoryMux} is the reference backend the
 * suite is validated against and a ready-made test double for consumers.
 */

/** A multiplexer pane — the lifecycle + metadata unit. */
export interface PaneRef {
  readonly id: string
  readonly workspace: string
}

/** An addressable I/O surface inside a pane (what `read-screen --surface` targets). */
export interface SurfaceRef {
  readonly id: string
  readonly paneId: string
}

/**
 * What a backend can do. tent negotiates against these instead of branching on
 * backend name; a backend throws {@link UnsupportedCapabilityError} when a
 * caller uses a verb it cannot honor.
 */
export interface MuxCapabilities {
  /** Can spawn panes beyond the first (silvermux: yes; a single-pane host: no). */
  readonly multiPane: boolean
  /** Can rename a pane/tab title. */
  readonly renameTab: boolean
  /** Can host a non-terminal (e.g. browser) pane (cmux: yes; silvermux today: no). */
  readonly browserPane: boolean
  /** Can read scrollback beyond the visible viewport. */
  readonly scrollback: boolean
}

export type MuxCapability = keyof MuxCapabilities

/** Thrown when a caller uses a verb the active backend does not support. */
export class UnsupportedCapabilityError extends Error {
  readonly capability: MuxCapability
  readonly backend: string
  constructor(backend: string, capability: MuxCapability) {
    super(`mux backend '${backend}' does not support capability '${capability}'`)
    this.name = "UnsupportedCapabilityError"
    this.capability = capability
    this.backend = backend
  }
}

/** Thrown when a pane/surface ref does not exist on the backend. */
export class MuxRefNotFoundError extends Error {
  readonly ref: string
  constructor(backend: string, kind: "pane" | "surface", id: string) {
    super(`mux backend '${backend}': ${kind} '${id}' not found`)
    this.name = "MuxRefNotFoundError"
    this.ref = id
  }
}

export interface SpawnPaneOptions {
  readonly workspace: string
  readonly command: string
  readonly cwd?: string
  readonly title?: string
}

export interface ReadScreenOptions {
  /** Max trailing lines to return. Omit for the full visible buffer. */
  readonly lines?: number
}

/**
 * The backend-agnostic multiplexer surface. Every method is async (cmux/silvermux
 * are out-of-process). Implementations MUST throw {@link UnsupportedCapabilityError}
 * (never crash) when a verb exceeds {@link MuxBackend.capabilities}, and
 * {@link MuxRefNotFoundError} for unknown pane/surface refs.
 */
export interface MuxBackend {
  /** Stable backend identifier, e.g. `"cmux"` / `"silvermux"` / `"in-memory"`. */
  readonly name: string
  capabilities(): MuxCapabilities
  spawnPane(opts: SpawnPaneOptions): Promise<PaneRef>
  closePane(ref: PaneRef): Promise<void>
  listPanes(workspace: string): Promise<PaneRef[]>
  listSurfaces(workspace: string, paneId: string): Promise<SurfaceRef[]>
  sendText(surface: SurfaceRef, text: string): Promise<void>
  sendKey(surface: SurfaceRef, key: string): Promise<void>
  readScreen(surface: SurfaceRef, opts?: ReadScreenOptions): Promise<string>
  renameTab(pane: PaneRef, title: string): Promise<void>
}

/** Full capability set — used by the reference backend and as a test default. */
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
      return { id: paneId, workspace: opts.workspace }
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
  }
}
