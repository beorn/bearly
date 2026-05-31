/**
 * `@bearly/mux-cmux-adapter` — wraps cmux's CLI behind the backend-agnostic
 * {@link MuxBackend} interface. No behavior change to cmux; this is the seam
 * that lets tent/chief talk to "a mux" instead of shelling out to `cmux`
 * directly. Sibling to `@bearly/mux-protocol`. @km/silvery/17273 (Phase 1).
 *
 * The cmux verb surface mapped here is exactly what tent ACTUALLY calls (audit
 * in 17273): `list-panes`, `list-pane-surfaces`, `read-screen`, `send-*`,
 * `new-pane`, `close-pane`, `rename-tab`. Argv shapes for the read/enumerate
 * verbs are confirmed from `.claude/skills/tent/scripts/chief.ts`
 * (`read-screen --surface <id> --lines <n>`, `list-panes --workspace <ws>`,
 * `list-pane-surfaces --workspace <ws> --pane <p>`); the lifecycle/io/meta argv
 * shapes are the adapter's contract with cmux and are pinned by the contract
 * test's fake cmux — Phase 2 verifies them against the real `cmux` binary
 * before any tent call site is refactored.
 *
 * Execution is dependency-injected ({@link CmuxBackendOptions.exec}) so the
 * contract suite runs against a stateful fake cmux with no real binary present.
 */
import { spawnSync } from "node:child_process"
import {
  type MuxBackend,
  type MuxCapabilities,
  MuxRefNotFoundError,
  type PaneRef,
  type ReadScreenOptions,
  type SpawnPaneOptions,
  type SurfaceRef,
} from "@bearly/mux-protocol"

export interface CmuxExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

/** Run `cmux <...args>` and resolve its result. Injected for tests. */
export type CmuxExec = (args: string[]) => Promise<CmuxExecResult>

export interface CmuxBackendOptions {
  /** cmux runner. Default: `spawnSync(binary, args)`. Inject a fake for tests. */
  readonly exec?: CmuxExec
  /** cmux binary name/path. Default: `"cmux"`. */
  readonly binary?: string
}

/** cmux is the full-featured backend — it supports every capability tent negotiates. */
export const CMUX_CAPABILITIES: MuxCapabilities = {
  multiPane: true,
  renameTab: true,
  browserPane: true,
  scrollback: true,
}

const NOT_FOUND = /not found|no such|unknown (pane|surface)/i

function defaultExec(binary: string): CmuxExec {
  return async (args) => {
    const r = spawnSync(binary, args, { encoding: "utf-8" })
    if (r.error) throw r.error
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 0 }
  }
}

const idLines = (stdout: string): string[] =>
  stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

/**
 * Build a {@link MuxBackend} backed by cmux. Translates each verb to cmux argv,
 * parses cmux output, and maps cmux "not found" failures to
 * {@link MuxRefNotFoundError} (other non-zero exits surface as a loud Error —
 * NO SILENT ERRORS).
 */
export function createCmuxBackend(opts: CmuxBackendOptions = {}): MuxBackend {
  const name = "cmux"
  const exec = opts.exec ?? defaultExec(opts.binary ?? "cmux")

  /** Run cmux; throw on failure, mapping not-found to a typed ref error. */
  const run = async (args: string[], notFound?: { kind: "pane" | "surface"; id: string }): Promise<string> => {
    const r = await exec(args)
    if (r.code !== 0) {
      if (notFound && NOT_FOUND.test(r.stderr + r.stdout)) {
        throw new MuxRefNotFoundError(name, notFound.kind, notFound.id)
      }
      throw new Error(`cmux ${args[0]} failed (code ${r.code}): ${(r.stderr || r.stdout).trim()}`)
    }
    return r.stdout
  }

  return {
    name,
    capabilities: () => CMUX_CAPABILITIES,

    async spawnPane(o: SpawnPaneOptions): Promise<PaneRef> {
      const args = ["new-pane", "--workspace", o.workspace, "--command", o.command]
      if (o.cwd) args.push("--cwd", o.cwd)
      if (o.title) args.push("--title", o.title)
      const out = await run(args)
      const id = idLines(out)[0]
      if (!id) throw new Error(`cmux new-pane returned no pane id (stdout: ${JSON.stringify(out)})`)
      return { id, workspace: o.workspace }
    },

    async closePane(ref: PaneRef): Promise<void> {
      await run(["close-pane", "--workspace", ref.workspace, "--pane", ref.id], { kind: "pane", id: ref.id })
    },

    async listPanes(workspace: string): Promise<PaneRef[]> {
      const out = await run(["list-panes", "--workspace", workspace])
      return idLines(out).map((id) => ({ id, workspace }))
    },

    async listSurfaces(workspace: string, paneId: string): Promise<SurfaceRef[]> {
      const out = await run(["list-pane-surfaces", "--workspace", workspace, "--pane", paneId], {
        kind: "pane",
        id: paneId,
      })
      return idLines(out).map((id) => ({ id, paneId }))
    },

    async sendText(surface: SurfaceRef, text: string): Promise<void> {
      await run(["send-text", "--surface", surface.id, "--text", text], { kind: "surface", id: surface.id })
    },

    async sendKey(surface: SurfaceRef, key: string): Promise<void> {
      await run(["send-key", "--surface", surface.id, "--key", key], { kind: "surface", id: surface.id })
    },

    async readScreen(surface: SurfaceRef, ro?: ReadScreenOptions): Promise<string> {
      const args = ["read-screen", "--surface", surface.id]
      if (ro?.lines !== undefined) args.push("--lines", String(ro.lines))
      return run(args, { kind: "surface", id: surface.id })
    },

    async renameTab(pane: PaneRef, title: string): Promise<void> {
      await run(["rename-tab", "--pane", pane.id, "--title", title], { kind: "pane", id: pane.id })
    },
  }
}
