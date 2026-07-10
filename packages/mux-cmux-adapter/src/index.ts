/**
 * `@bearly/mux-cmux-adapter` — wraps cmux's CLI behind the backend-agnostic
 * {@link MuxBackend} interface. No behavior change to cmux; this is the seam
 * that lets tent/chief talk to "a mux" instead of shelling out to `cmux`
 * directly. Sibling to `@bearly/mux-protocol`. @si/mux/19260-proto/17273 (Phase 1).
 *
 * The cmux verb surface mapped here is exactly what tent ACTUALLY calls (audit
 * in 17273): `list-panes`, `list-pane-surfaces`, `read-screen`, `send-*`,
 * `new-pane`, `close-pane`, `rename-tab`. Argv shapes for the read/enumerate
 * verbs are confirmed from `.claude/skills/tent/scripts/chief.ts`
 * (`read-screen --surface <id> --lines <n>`, `list-panes --workspace <ws>`,
 * `list-pane-surfaces --workspace <ws> --pane <p>`). The terminal lifecycle
 * argv (`new-pane --workspace <ws> --type terminal`) is confirmed from the real
 * `cmux new-pane --help` surface and tent's current spawn path.
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

const tokenFromOutput = (stdout: string, kind: "pane" | "surface"): string | null => {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "")
  return new RegExp(`(${kind}:\\S+)`).exec(clean)?.[1] ?? null
}

/**
 * Parse `cmux list-panes` output into pane ids. Real cmux embeds the id as a
 * `pane:<id>` token inside a titled line — `  pane:106  [1 surface]`,
 * `* pane:107  [1 surface]  [focused]` (ANSI possible, a `*` selected marker,
 * bracketed suffixes) — NOT a bare id. Strip ANSI and extract the token; a line
 * with no token falls back to the bare trimmed line so simple / fake backends
 * that emit one bare id per line still work. (km 17273)
 */
const paneIdLines = (stdout: string): string[] => {
  const ids: string[] = []
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim()
    if (line.length === 0) continue
    const m = /(pane:\S+)/.exec(line)
    ids.push(m?.[1] ?? line)
  }
  return ids
}

/**
 * Parse `cmux list-pane-surfaces` output into surface refs. Real cmux titles
 * each surface with its tenant — `* surface:145  @chief  [selected]`,
 * `  surface:30  @agent/4` (ANSI possible, `*` selected marker, `[selected]`
 * suffix) — so a line carries both the `surface:<id>` token AND an `@owner`.
 * Strip ANSI, extract the token (bare-line fallback for simple/fake backends),
 * and the leading `@owner` when present. (km 17273 / 19506)
 */
const surfaceRefLines = (stdout: string, workspace: string, paneId: string): SurfaceRef[] => {
  const refs: SurfaceRef[] = []
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim()
    if (line.length === 0) continue
    const id = /(surface:\S+)/.exec(line)?.[1] ?? line
    const owner = /(@\S+)/.exec(line)?.[1]
    refs.push(owner ? { id, paneId, workspace, owner } : { id, paneId, workspace })
  }
  return refs
}

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
      const args = ["new-pane", "--workspace", o.workspace, "--type", "terminal"]
      const out = await run(args)
      const primarySurfaceId = tokenFromOutput(out, "surface") ?? undefined
      let id: string | undefined = tokenFromOutput(out, "pane") ?? idLines(out)[0]
      if (id?.startsWith("surface:")) {
        // Some cmux builds report only the newly-created surface. Preserve the
        // surface for callers that need it immediately, then infer the pane from
        // the post-create listing so MuxBackend still returns a PaneRef.
        id = paneIdLines(await run(["list-panes", "--workspace", o.workspace])).at(-1)
      }
      if (!id) throw new Error(`cmux new-pane returned no pane id (stdout: ${JSON.stringify(out)})`)
      return primarySurfaceId ? { id, workspace: o.workspace, primarySurfaceId } : { id, workspace: o.workspace }
    },

    async closePane(ref: PaneRef): Promise<void> {
      await run(["close-pane", "--workspace", ref.workspace, "--pane", ref.id], { kind: "pane", id: ref.id })
    },

    async listPanes(workspace: string): Promise<PaneRef[]> {
      const out = await run(["list-panes", "--workspace", workspace])
      return paneIdLines(out).map((id) => ({ id, workspace }))
    },

    async listSurfaces(workspace: string, paneId: string): Promise<SurfaceRef[]> {
      const out = await run(["list-pane-surfaces", "--workspace", workspace, "--pane", paneId], {
        kind: "pane",
        id: paneId,
      })
      return surfaceRefLines(out, workspace, paneId)
    },

    async sendText(surface: SurfaceRef, text: string): Promise<void> {
      // Real cmux verb is `send` (there is no `send-text`), and the text is
      // positional after `--` so a flag-shaped payload isn't parsed as a flag.
      await run(["send", "--surface", surface.id, "--", text], { kind: "surface", id: surface.id })
    },

    async sendKey(surface: SurfaceRef, key: string): Promise<void> {
      // `cmux send-key` takes the key positionally (`[--] <key>`), not `--key`.
      await run(["send-key", "--surface", surface.id, key], { kind: "surface", id: surface.id })
    },

    async readScreen(surface: SurfaceRef, ro?: ReadScreenOptions): Promise<string> {
      const args = ["read-screen"]
      if (surface.workspace !== undefined) args.push("--workspace", surface.workspace)
      args.push("--surface", surface.id)
      if (ro?.lines !== undefined) args.push("--lines", String(ro.lines))
      return run(args, { kind: "surface", id: surface.id })
    },

    async renameTab(pane: PaneRef, title: string): Promise<void> {
      await run(["rename-tab", "--pane", pane.id, "--title", title], { kind: "pane", id: pane.id })
    },
  }
}
