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

The async holder census checks cwd, executable, process root, mappings and
open descriptors. Its scope is required:

- `all-visible` admits every numeric process directory visible in the Linux
  proc view, including other users. A restricted proc mount may hide processes.
- `same-uid` restricts Linux admission to the caller's UID. On Darwin this
  selects the legacy, unfiltered `/usr/sbin/lsof +D` mechanism; it does not
  establish same-UID or host-wide coverage. Darwin rejects `all-visible`.

The target and platform inspection resources must exist and be readable.
Missing required resources and unexpected I/O errors throw with their location.
Denied, missing or ambiguous observations make Linux `coverage.complete` false
and name the affected process, source and resource. An individual missing source
does not prove its process exited. `holders: []` alone never establishes absence.

A complete census describes a non-atomic observation of its stated scope.
It cannot exclude later producers, translate mount aliases or establish inode
identity, and does not authorize a destructive operation. The synchronous
`censusProcessCwds` API retains its separate, weaker cwd-only contract.

The CLI uses the same removal guard:

```sh
removely /tmp/build/output --within /tmp/build
```
