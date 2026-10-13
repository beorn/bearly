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
 * The contract suite and its reference backend are test kits, kept off this
 * entry: `@bearly/mux-protocol/testing/contract-cases` defines the behavioral
 * invariants any backend must satisfy (and the `ContractCase` shape it
 * builds), and
 * `@bearly/mux-protocol/testing/in-memory-mux` is the reference backend the
 * suite is validated against and a ready-made test double for consumers.
 */

/** A multiplexer pane — the lifecycle + metadata unit. */
export interface PaneRef {
  readonly id: string
  readonly workspace: string
  /**
   * Primary surface created with this pane, when the backend reports it from
   * the lifecycle call. cmux's terminal `new-pane` reports a surface token,
   * which tent can use immediately without broadening this slice into send/list
   * behavior. Backends that only report pane ids omit it; callers can still use
   * `listSurfaces(workspace, pane.id)`.
   */
  readonly primarySurfaceId?: string
}

/** An addressable I/O surface inside a pane (what `read-screen --surface` targets). */
export interface SurfaceRef {
  readonly id: string
  readonly paneId: string
  /**
   * Workspace containing this surface when the backend can report it.
   * cmux requires this for reliable cross-workspace `read-screen` /
   * send-key addressing; omitting it preserves the global-surface fallback.
   */
  readonly workspace?: string
  /**
   * Optional owner/title the backend reports for the surface, when its listing
   * carries one. cmux's `list-pane-surfaces` titles a surface with its tenant —
   * e.g. `@chief` / `@agent/5` in `* surface:145  @chief  [selected]` — which
   * tent uses to map an agent hat to its surface. Additive + optional: backends
   * (and surfaces) without a title omit it; callers that only need `{ id,
   * paneId }` are unaffected. @km/silvery/17273 (19506).
   */
  readonly owner?: string
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
