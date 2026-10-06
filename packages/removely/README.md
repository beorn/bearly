# removely

Guarded removal, temporary trees, and process-holder evidence for Node.js.

```ts
import { safeRemove, tempTree, inspectPathHolderCensus } from "removely"

await safeRemove("/tmp/build/output", { within: "/tmp/build" })

await using fixture = await tempTree("build-test-")
const output = fixture.resolve("output.json")

const census = await inspectPathHolderCensus("/tmp/build", {
  scope: "all-visible",
})
console.log(census.holders, census.coverage)
```

Removal requires an explicit containment root. Missing targets throw unless
`allowMissing: true` is supplied. Containment is a cooperative guard; it does
not prevent concurrent filesystem changes or constrain another process.

The async holder census checks cwd, executable, process root, argv (an element
that is itself a path under the target), mappings and open descriptors. Its
scope is required:

- `all-visible` admits every numeric process directory visible in the Linux
  proc view, including other users. A restricted proc mount may hide processes.
- `same-uid` restricts Linux admission to the caller's UID. On Darwin this
  selects the legacy, unfiltered `/usr/sbin/lsof +D` mechanism; it does not
  establish same-UID or host-wide coverage. Darwin rejects `all-visible`.

The target and platform inspection resources must exist and be readable.
Missing required resources and unexpected I/O errors throw with their location.
Denied, missing or ambiguous observations make Linux `coverage.complete` false
and name the affected process, source and resource. A Linux census answers by a
deadline (`deadlineMs`, default `PATH_HOLDER_CENSUS_DEADLINE_MS` = 2000 ms of
wall clock from its start, shared by every `/proc` read): a read still pending
then is `unanswered`, which is incomplete too. A read given up on keeps running
in the runtime and may keep the process alive until the kernel answers it, so a
one-shot caller exits explicitly once it has the census. argv is compared as
written, never resolved: an element that reaches the target through a symlink
is not seen, and resolving it at census time would name whatever the link
points at then. `coverage.processes` counts the
processes with each reason (`sourceDenied`, `sourceUnanswered`, `sourceMissing`,
`sourceAmbiguous`) ahead of the per-source table. An individual missing source
does not prove its process exited. `holders: []` alone never establishes absence.

A complete census describes a non-atomic observation of its stated scope.
It cannot exclude later producers, translate mount aliases or establish inode
identity, and does not authorize a destructive operation.

The path census is one projection of `inspectProcessCensus`, which returns one
row per admitted Linux process: its owner uid, the kernel's start ticks as read,
and the sources asked for (`sources`, default all six). A row's argv comes back
only with `includeArgv: true`, since a command line can carry a secret. A row is
not a stable identity: a caller that signals a pid re-checks it first.
`inspectProcessCwds()` is the cwd projection. It lists every readable same-uid
cwd and names each process it could not read in `unreadable`, with its uid and
argv; `clearedByIdentity(entry)` clears four identities of the current uid
(`systemd` with `--user`, `(sd-pam)`, `sshd-session` and `ssh-agent`), and every
other entry is for the caller to refuse on.
`maps` is read after `cmdline` and never once `cmdline` has not answered, so one
process stuck on its mmap lock pins one I/O-pool thread. A source that went missing or was
denied is resolved by one exit proof: the process directory gone, or another
start time, counts it exited, and a one-thread zombie holds nothing. A denied
source with no reading is then read once more, a retry for a process that
denied its `/proc` entries for a moment; a reading is never taken away.

`inspectProcessSources(pid, options)` reads only that PID's selected `argv`
and/or `cwd` (both by default), without a census. It shares source parsing with
the census; argv preserves empty elements, whitespace and long arguments.
`procRoot` selects an alternate proc view. `readFile` and `readlink` callbacks
let production callers admit and track I/O in their existing budget. The caller
owns deadlines and before/after birth fencing; this function does not establish
a stable incarnation or infer exit from a missing source. Successful empty argv
is readable evidence, distinct from missing or denied argv. Unexpected I/O throws
with the source path. Values are unredacted: callers must redact before writing
or rendering and restrict their exposure and persisted permissions.

The CLI uses the same removal guard:

```sh
removely /tmp/build/output --within /tmp/build
```

`--within` is mandatory and has no default: the target must resolve to a path
_strictly_ inside it, so `--within` pointing at the target itself is refused,
and so is a sibling that merely shares its prefix. A target that is itself a
symlink is refused rather than followed. The root you name must in turn sit
inside an allowed root — the system temporary directory by default, and
`--allowed-root` (repeatable) **replaces** that default rather than adding to
it. `--allow-missing` makes an absent target exit 0.

```sh
removely --help     # the whole contract: arguments, what is refused and why,
                    # exit codes, and runnable examples
```

Exit codes are the shell contract: `0` removed (or absent under
`--allow-missing`, and `--help` itself), `2` refused or the removal failed,
`64` you called it wrong and nothing was removed.

> Install from npm; a git install resolves the TypeScript source and runs only under Bun.
