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

The `@bearly/durable-file/verdict` subpath adds one strict, subject-bound verdict
artifact shared by test and release harnesses. Artifact paths always come from
the caller; the package creates no global store and infers nothing from cwd.

> Install from npm; a git install resolves the TypeScript source and runs only under Bun.
