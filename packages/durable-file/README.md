# @bearly/durable-file

Crash-durable file publication for Node and Bun. `atomicWriteFileSync` writes
complete bytes to a unique sibling, fsyncs the file, renames it over the target,
and fsyncs the parent directory.

`atomicPublishFileSync(path, body)` uses the same byte-writing and durability
barriers, with an exclusive hard link instead of replacement. It returns
`"published"` for the winning creator or `"exists"` when a destination already
exists. It never overwrites that destination or creates its parent directory.
The caller owns the directory's permissions and location policy.

A failure after the link throws an error named `AtomicPublicationError`, with
`published: true` and the destination `path`. The destination contains complete
bytes; callers read it and report the durability failure, rather than retrying
publication with different bytes. Unsupported hard links and other filesystem
failures throw without a replacement fallback. Temporary files use mode 0600
and are removed on success, a lost race, and failure; cleanup failures are loud.

`@bearly/durable-file/cas` adds cooperating exact-byte file mutation under an
adjacent `<path>.lock`: `commitFileBytesIfUnchanged`, `writeFileBytesLocked`,
`removeFileBytesIfUnchanged`, and `removeFileBytesAndLockIfUnchanged`. A CAS
compares the exact observed UTF-8 bytes (`null` means observed absence); a
changed file returns `{ok:false,reason:"changed",currentRaw}`, and contention
returns `{ok:false,reason:"locked"}`. Other failures throw. All cooperating
writers must use this lock; an unconditional external rename can bypass it.
Replacement uses the same complete-write/fsync/rename/directory-fsync core as
`atomicWriteFileSync`. Withdrawal fsyncs the directory after removal. Only the
retired-path withdrawal variant removes its lock file, while still holding it;
callers must not reuse that retired path with an unconditional writer.

The CAS subpath uses `@bearly/flock` on local Linux/macOS filesystems with
Bun 1.3.13+ or Node 24+. Root atomic APIs remain independent of the lock module.

The `@bearly/durable-file/verdict` subpath adds one strict, subject-bound verdict
artifact shared by test and release harnesses. Artifact paths always come from
the caller; the package creates no global store and infers nothing from cwd.

> Install from npm; a git install resolves the TypeScript source and runs only under Bun.
