export type ProcessLinkKind = "path" | "socket" | "pipe" | "anonymous" | "malformed"
export type ProcessSourceFailure = Readonly<{
  reason: "vanished" | "denied" | "unsupported" | "unexpected"
  code?: string
  detail: string
}>
export type ProcessFdLink = Readonly<{ name: string; target?: string }>
export type ProcessFdSummary = Readonly<{
  entryCount: number
  targets: readonly Readonly<{ name: string; target: string; kind: ProcessLinkKind }>[]
  unreadableCount: number
}>

/** A final NUL terminates the vector; other empty fields are real arguments. */
export function parseProcessArgv(contents: string): readonly string[] {
  const argv = contents.split("\0")
  if (argv.at(-1) === "") argv.pop()
  return argv
}

export function classifyProcessLink(target: string): ProcessLinkKind {
  if (target.startsWith("/")) return "path"
  if (/^socket:\[\d+\]$/u.test(target)) return "socket"
  if (/^pipe:\[\d+\]$/u.test(target)) return "pipe"
  if (target.startsWith("anon_inode:")) return "anonymous"
  return "malformed"
}

export function classifyProcessSourceError(error: unknown): ProcessSourceFailure {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
  const reason =
    code === "ENOENT" || code === "ESRCH"
      ? "vanished"
      : code === "EACCES" || code === "EPERM"
        ? "denied"
        : code === "ENOSYS" || code === "EOPNOTSUPP"
          ? "unsupported"
          : "unexpected"
  return {
    reason,
    ...(code === undefined ? {} : { code }),
    detail: error instanceof Error ? error.message : String(error),
  }
}

/** Called only after a successful listing, with one acquisition outcome per name. */
export function summarizeProcessFileDescriptors(links: readonly ProcessFdLink[]): ProcessFdSummary {
  const targets: Array<{ name: string; target: string; kind: ProcessLinkKind }> = []
  let unreadableCount = 0
  for (const link of links) {
    if (link.target === undefined) unreadableCount += 1
    else targets.push({ name: link.name, target: link.target, kind: classifyProcessLink(link.target) })
  }
  return { entryCount: links.length, targets, unreadableCount }
}
