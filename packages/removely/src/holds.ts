/**
 * Holds: the caller's authority that a target is still referenced.
 *
 * removely knows no repository, rail or ruling. A caller that must not delete referenced data builds two things
 * once per run and passes them as `holds`:
 *   - `tracked(path)`: a tracked file at or under `path`, or null. It is the caller's own inventory (for example a
 *     version-control tree at a recorded commit). A predicate that throws refuses the removal.
 *   - `citations`: a {@link CitationIndex} built here from the caller's corpus text.
 * The shared refusal predicate in `index.ts` evaluates both for every removal that carries `holds` (#34952).
 *
 * The citation boundary is exact (#34952 plan §3, judged review). A mention starts at an anchor after a line start,
 * whitespace or one of `( [ { < > " ' \` = : | , ; *`, and runs to its line end. A target is cited when a mention
 * starts with the target's own text and the next character ends a path: the line end, `/`, whitespace, one of
 * `` ` ) ] } > " ' * | # ~ ``, a `:line[:col]` suffix, or a run of `. , ; : ! ?` followed by one of those. So
 * `…/candidate-vault.` at a sentence end cites `…/candidate-vault`, `…/25194-report.md` and `…/x.md` do not cite
 * `…/25194` or `…/x`, and a name with a space or a bracket (`run (1).log`) is matched as written. A cited path
 * holds itself, every descendant and every ancestor up to (not including) a declared container, so citing a seat
 * folder does not freeze everything inside it.
 */

export interface CitationAnchor {
  /** The text a citation starts with in prose, e.g. `/hh/var/@` or the root-relative `var/@`. */
  readonly text: string
  /** The absolute prefix that text stands for. */
  readonly absolute: string
}

export interface CorpusText {
  /** The corpus file's own name (repo-relative), printed in a refusal. */
  readonly file: string
  readonly text: string
}

/** A corpus file whose citations the caller already read with {@link citationsIn} (one scan, several indexes). */
export interface CorpusFound {
  readonly file: string
  readonly found: readonly FoundCitation[]
}

/** One citation as found in one text: the absolute path (or abbreviated tail) and where it was written. */
export interface FoundCitation {
  /** The path as far as a hard delimiter, for display: the mention trimmed of trailing punctuation. */
  readonly path: string
  /** The mention from its anchor (made absolute) to its line end, capped: what targets are matched against. */
  readonly raw: string
  /** 1-based. */
  readonly line: number
  /** 1-based, in UTF-16 units from the line start. */
  readonly column: number
  readonly lineText: string
  /** A `.../tail` or `…/tail` mention: `path` is the tail, starting with `/`. */
  readonly abbreviated: boolean
}

export interface Citation {
  readonly file: string
  readonly path: string
  readonly line: number
  readonly column: number
  readonly lineText: string
}

export interface TrackedHold {
  /** The tracked file at or under the target. */
  readonly path: string
  /** Which inventory said so, e.g. `root var/** at 078b5cde`. */
  readonly source: string
}

declare const citationIndexBrand: unique symbol

export interface CitationIndex {
  readonly [citationIndexBrand]: true
  /** Distinct absolute cited paths. */
  readonly paths: number
  /** Distinct abbreviated tails. */
  readonly tails: number
  readonly files: number
}

export interface RemovalHolds {
  readonly tracked: (path: string) => TrackedHold | null
  readonly citations: CitationIndex
}

interface IndexState {
  /** Raw mentions, sorted, so every mention starting with a candidate is one contiguous range. */
  readonly sorted: readonly string[]
  readonly first: ReadonlyMap<string, Citation>
  readonly containers: ReadonlySet<string>
  /** Abbreviated tails by each segment name they contain, with that segment's position. */
  readonly bySegment: ReadonlyMap<
    string,
    readonly { readonly prefix: string; readonly last: boolean; readonly citation: Citation }[]
  >
  /**
   * Caches only, keyed by folder. A walk asks about the same parent folders once per file under them, and each answer
   * was a scan of every mention under the folder (34952: host-store-cleanup's census reached 11.6 GB, 04:27 PST).
   * `ancestorHits`: the citations naming the folder as an ancestor. `ancestorFirst` / `tailFirst`: the first citation
   * of the folder's whole ancestor chain / abbreviated-tail chain, up to the nearest container.
   */
  readonly ancestorHits: Map<string, readonly Citation[]>
  readonly ancestorFirst: Map<string, Citation | null>
  readonly tailFirst: Map<string, Citation | null>
}

/** Folder answers kept at most per cache; a depth-first walk revisits only its current branch, so clearing loses little. */
const FOLDER_CACHE_MAX = 100_000
const NO_CITATIONS: readonly Citation[] = Object.freeze([])

function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= FOLDER_CACHE_MAX) cache.clear()
  cache.set(key, value)
  return value
}

const STATE = new WeakMap<CitationIndex, IndexState>()

/** One path is capped so an unbroken blob cannot become one giant token. */
const MAX_PATH_CHARS = 4096
const LEFT_BOUNDARY = new Set("([{<>\"'`=:|,;*")
const HARD_END = /[\s`'"()[\]{}<>|#~*$?]/u
const TRAILING = /(?::\d+(?::\d+)?|[.,;:!?]+|\/+)$/u
/** What may follow a cited path's text: a delimiter that ends it, a `:line[:col]` suffix, or punctuation then one. */
const ENDS_PATH = /^(?:$|[\s/`)\]}>"'*|#~]|:\d|[.,;:!?]+(?:$|[\s`)\]}>"'*|#~]))/u
/** For an ancestor: the same, but a `/` must be a trailing slash, never the start of another child's name. */
const ENDS_ANCESTOR = /^(?:\/*(?:$|[\s`)\]}>"'*|#~])|:\d|[.,;:!?]+(?:$|[\s`)\]}>"'*|#~]))/u
/** The same two tests, sticky: checked at an offset in the mention, so a lookup slices nothing. */
const ENDS_PATH_AT = new RegExp(ENDS_PATH.source.slice(1), "uy")
const ENDS_ANCESTOR_AT = new RegExp(ENDS_ANCESTOR.source.slice(1), "uy")

function endsAt(ends: RegExp, raw: string, at: number): boolean {
  ends.lastIndex = at
  return ends.test(raw)
}

/** An ellipsis that starts a path: at a line start or after a delimiter, never inside one (`/v/.../x`, `a...`). */
const ABBREVIATED_LEAD = /(?<=^|[\s`'"([{<,;:|=>*])(?:\.\.\.|…)(?=\/)/gmu
const ABBREVIATED_RUN = /[^\s`'"()[\]{}<>,;|*$?#~]*/uy
/** A run stopped by one of these runs into a placeholder or a glob, so no literal path is proven. */
const ABBREVIATED_PLACEHOLDER = "<{*$"

function stripTrailing(path: string): string {
  let current = path
  for (;;) {
    const next = current.replace(TRAILING, "")
    if (next === current) return current
    current = next
  }
}

function isBoundaryBefore(text: string, at: number): boolean {
  if (at === 0) return true
  const previous = text[at - 1] ?? ""
  return /\s/u.test(previous) || LEFT_BOUNDARY.has(previous)
}

/** The concrete tail when it is two or more whole segments with no placeholder or interior ellipsis; else null. */
function concreteTail(run: string): string | null {
  if (run.endsWith("...") || run.endsWith("…")) return null
  const tail = stripTrailing(run)
  const segments = tail.split("/").slice(1)
  if (segments.length < 2) return null
  if (segments.some((segment) => segment === "" || segment.includes("...") || segment.includes("…"))) return null
  return tail
}

class LineIndex {
  private readonly starts: number[] = [0]
  constructor(private readonly text: string) {
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) this.starts.push(at + 1)
  }
  locate(offset: number): { line: number; column: number; lineText: string } {
    let low = 0
    let high = this.starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >>> 1
      if ((this.starts[mid] ?? 0) <= offset) low = mid
      else high = mid - 1
    }
    const start = this.starts[low] ?? 0
    const next = this.text.indexOf("\n", start)
    return {
      line: low + 1,
      column: offset - start + 1,
      lineText: this.text.slice(start, next === -1 ? undefined : next),
    }
  }
}

/**
 * Every citation in `text`, in order: absolute paths for each anchor, then abbreviated tails. Pure; the caller
 * decides what the text is (and removes generated lines it must not count) before calling.
 */
export function citationsIn(text: string, anchors: readonly CitationAnchor[]): FoundCitation[] {
  // Checked at run time without narrowing `anchors` (Array.isArray would widen its elements to any).
  const given: unknown = anchors
  if (!Array.isArray(given) || anchors.some((anchor) => typeof anchor?.text !== "string" || anchor.text === "")) {
    throw new Error("citationsIn: anchors must be a non-empty text and absolute prefix each")
  }
  const lines = new LineIndex(text)
  const found: { offset: number; citation: FoundCitation }[] = []
  for (const anchor of anchors) {
    for (let at = text.indexOf(anchor.text); at !== -1; at = text.indexOf(anchor.text, at + 1)) {
      if (!isBoundaryBefore(text, at)) continue
      const lineEnd = text.indexOf("\n", at)
      const rest = text.slice(
        at + anchor.text.length,
        Math.min(lineEnd === -1 ? text.length : lineEnd, at + MAX_PATH_CHARS),
      )
      const end = rest.search(HARD_END)
      const path = stripTrailing(anchor.absolute + (end === -1 ? rest : rest.slice(0, end)))
      const raw = (anchor.absolute + rest).replace(/\r$/u, "")
      found.push({ offset: at, citation: { path, raw, ...lines.locate(at), abbreviated: false } })
    }
  }
  for (const match of text.matchAll(ABBREVIATED_LEAD)) {
    const start = match.index + match[0].length
    ABBREVIATED_RUN.lastIndex = start
    const run = ABBREVIATED_RUN.exec(text)?.[0] ?? ""
    const stop = text[start + run.length]
    if (stop !== undefined && ABBREVIATED_PLACEHOLDER.includes(stop)) continue
    const tail = concreteTail(run)
    if (tail === null) continue
    found.push({
      offset: match.index,
      citation: { path: tail, raw: tail, ...lines.locate(match.index), abbreviated: true },
    })
  }
  return found.sort((a, b) => a.offset - b.offset).map(({ citation }) => citation)
}

/**
 * Index the corpus once per run. `containers` are folders whose own citation holds nothing inside them (a seat
 * home, the swept root); a container is still held when it is itself the target.
 */
export function buildCitationIndex(
  files: readonly (CorpusText | CorpusFound)[],
  options: { readonly anchors: readonly CitationAnchor[]; readonly containers: readonly string[] },
): CitationIndex {
  const given: unknown = files
  if (!Array.isArray(given)) throw new Error("buildCitationIndex: files must be an array of { file, text | found }")
  const first = new Map<string, Citation>()
  const tails = new Map<string, Citation>()
  for (const entry of files) {
    const file: unknown = entry?.file
    // Checked at run time: a caller outside TypeScript can hand anything here, and a missing list must refuse.
    let list: readonly FoundCitation[] | null = null
    const found: unknown = "found" in entry ? entry.found : undefined
    if (Array.isArray(found)) list = found as readonly FoundCitation[]
    else if ("text" in entry && typeof entry.text === "string") list = citationsIn(entry.text, options.anchors)
    if (typeof file !== "string" || list === null) {
      throw new Error(`buildCitationIndex: corpus entry ${String(file)} has neither text nor found citations`)
    }
    for (const found of list) {
      const citation: Citation = {
        file,
        path: found.path,
        line: found.line,
        column: found.column,
        lineText: found.lineText,
      }
      if (found.abbreviated) {
        if (!tails.has(found.path)) tails.set(found.path, citation)
      } else if (!first.has(found.raw)) first.set(found.raw, citation)
    }
  }
  const bySegment = new Map<string, { prefix: string; last: boolean; citation: Citation }[]>()
  for (const [tail, citation] of tails) {
    const segments = tail.split("/").slice(1)
    for (let index = 1; index < segments.length; index++) {
      const name = segments[index] ?? ""
      const list = bySegment.get(name) ?? []
      list.push({ prefix: `/${segments.slice(0, index + 1).join("/")}`, last: index === segments.length - 1, citation })
      bySegment.set(name, list)
    }
  }
  const index = { paths: first.size, tails: tails.size, files: files.length } as unknown as CitationIndex
  STATE.set(index, {
    sorted: [...first.keys()].sort(),
    first,
    containers: new Set(options.containers.map((path) => stripTrailing(path))),
    bySegment,
    ancestorHits: new Map(),
    ancestorFirst: new Map(),
    tailFirst: new Map(),
  })
  return index
}

function stateOf(index: CitationIndex): IndexState {
  const state = STATE.get(index)
  if (state === undefined) throw new Error("holds.citations is not a CitationIndex from buildCitationIndex")
  return state
}

/** Whether `value` is an index this module built. */
export function isCitationIndex(value: unknown): value is CitationIndex {
  return typeof value === "object" && value !== null && STATE.has(value as CitationIndex)
}

function parentOf(path: string): string | null {
  const at = path.lastIndexOf("/")
  return at <= 0 ? null : path.slice(0, at)
}

/** Every citation that holds `target`: the target itself, a descendant, an ancestor below a container, or a tail. */
export function citationsOf(index: CitationIndex, target: string): Citation[] {
  const state = stateOf(index)
  const path = target.length > 1 ? target.replace(/\/+$/u, "") : target
  const held: Citation[] = []
  mentions(state, path, ENDS_PATH_AT, held)
  for (let ancestor = parentOf(path); ancestor !== null; ancestor = parentOf(ancestor)) {
    if (state.containers.has(ancestor)) break
    // A loop, not a spread: a folder cited a million times would overflow the argument list.
    for (const citation of ancestorMentions(state, ancestor)) held.push(citation)
  }
  for (let candidate: string | null = path; candidate !== null; candidate = parentOf(candidate)) {
    if (candidate !== path && state.containers.has(candidate)) break
    const name = candidate.slice(candidate.lastIndexOf("/") + 1)
    for (const entry of state.bySegment.get(name) ?? []) {
      if (candidate !== path && !entry.last) continue
      if (candidate === entry.prefix || candidate.endsWith(entry.prefix)) held.push(entry.citation)
    }
    if (state.containers.has(candidate)) break
  }
  return held
}

/**
 * Each mention starting with `candidate` whose rest passes `ends`, in sorted order, pushed onto `into`; with `firstOnly`
 * it stops at the first.
 */
function mentions(state: IndexState, candidate: string, ends: RegExp, into: Citation[], firstOnly = false): void {
  let low = 0
  let high = state.sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if ((state.sorted[mid] ?? "") < candidate) low = mid + 1
    else high = mid
  }
  for (let at = low; at < state.sorted.length; at++) {
    const raw = state.sorted[at] ?? ""
    if (!raw.startsWith(candidate)) break
    if (!endsAt(ends, raw, candidate.length)) continue
    const citation = state.first.get(raw)
    if (citation === undefined) continue
    into.push(citation)
    if (firstOnly) return
  }
}

/** The citations naming `folder` as an ancestor of a target, cached per folder. */
function ancestorMentions(state: IndexState, folder: string): readonly Citation[] {
  const cached = state.ancestorHits.get(folder)
  if (cached !== undefined) return cached
  const found: Citation[] = []
  mentions(state, folder, ENDS_ANCESTOR_AT, found)
  return remember(state.ancestorHits, folder, found.length === 0 ? NO_CITATIONS : found)
}

/** The first abbreviated tail ending `candidate`; for an ancestor only a tail's last segment counts. */
function tailAt(state: IndexState, candidate: string, isTarget: boolean): Citation | null {
  const name = candidate.slice(candidate.lastIndexOf("/") + 1)
  for (const entry of state.bySegment.get(name) ?? []) {
    if (!isTarget && !entry.last) continue
    if (candidate === entry.prefix || candidate.endsWith(entry.prefix)) return entry.citation
  }
  return null
}

/** The first citation naming `folder` or an ancestor of it as an ancestor, nearest first, below the nearest container. */
function ancestorChainFirst(state: IndexState, folder: string | null): Citation | null {
  if (folder === null || state.containers.has(folder)) return null
  const cached = state.ancestorFirst.get(folder)
  if (cached !== undefined) return cached
  const here = ancestorMentions(state, folder)[0] ?? ancestorChainFirst(state, parentOf(folder))
  return remember(state.ancestorFirst, folder, here)
}

/** The first abbreviated tail ending `folder` or an ancestor of it, nearest first, below the nearest container. */
function tailChainFirst(state: IndexState, folder: string | null): Citation | null {
  if (folder === null || state.containers.has(folder)) return null
  const cached = state.tailFirst.get(folder)
  if (cached !== undefined) return cached
  const here = tailAt(state, folder, false) ?? tailChainFirst(state, parentOf(folder))
  return remember(state.tailFirst, folder, here)
}

/**
 * `citationsOf(index, target)[0] ?? null`, without building the list: for a walk that asks once per file whether
 * anything holds it (34952). The order is the list's: the target's own mentions, then its ancestors' (nearest first),
 * then abbreviated tails (the target, then its ancestors).
 */
export function firstCitationOf(index: CitationIndex, target: string): Citation | null {
  const state = stateOf(index)
  const path = target.length > 1 && target.endsWith("/") ? target.replace(/\/+$/u, "") : target
  const own: Citation[] = []
  mentions(state, path, ENDS_PATH_AT, own, true)
  if (own[0] !== undefined) return own[0]
  const parent = parentOf(path)
  const ancestor = ancestorChainFirst(state, parent)
  if (ancestor !== null) return ancestor
  const tail = tailAt(state, path, true)
  if (tail !== null || state.containers.has(path)) return tail
  return tailChainFirst(state, parent)
}

export type RemovalHeldCode = "removely/held-tracked" | "removely/held-cited"

/** A removal refused because the caller's authority still references the target. */
export class RemovalHeldError extends Error {
  readonly code: RemovalHeldCode
  readonly target: string
  readonly tracked: TrackedHold | null
  readonly citations: readonly Citation[]

  constructor(caller: string, target: string, tracked: TrackedHold | null, citations: readonly Citation[]) {
    const parts: string[] = []
    if (tracked !== null) parts.push(`tracked file ${tracked.path} (${tracked.source})`)
    if (citations.length > 0) {
      const first = citations[0] as Citation
      parts.push(
        `${citations.length} citation${citations.length === 1 ? "" : "s"}; first ${first.file}:${first.line}:${first.column} ${first.lineText.trim().slice(0, 200)}`,
      )
    }
    super(`${caller}: REFUSED ${target}: held by ${parts.join("; ")}`)
    this.name = "RemovalHeldError"
    this.code = tracked !== null ? "removely/held-tracked" : "removely/held-cited"
    this.target = target
    this.tracked = tracked
    this.citations = citations
  }
}

/** Evaluate `holds` for one resolved target; throws {@link RemovalHeldError}, or the caller's own read failure. */
export function enforceHolds(caller: string, holds: RemovalHolds, paths: readonly string[]): void {
  if (typeof holds?.tracked !== "function") {
    throw new Error(`${caller}: holds.tracked must be a function (path) => TrackedHold | null`)
  }
  if (!isCitationIndex(holds.citations)) {
    throw new Error(`${caller}: holds.citations must be an index from buildCitationIndex`)
  }
  for (const path of new Set(paths)) {
    let tracked: TrackedHold | null
    try {
      tracked = holds.tracked(path)
    } catch (error) {
      throw new Error(
        `${caller}: holds.tracked(${path}) failed, so the removal is refused: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    const citations = citationsOf(holds.citations, path)
    if (tracked !== null || citations.length > 0) throw new RemovalHeldError(caller, path, tracked, citations)
  }
}
