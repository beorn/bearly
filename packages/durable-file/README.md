# @bearly/durable-file

Crash-durable file publication for Node and Bun. `atomicWriteFileSync` writes
complete bytes to a unique sibling, fsyncs the file, renames it over the target,
and fsyncs the parent directory.

The `@bearly/durable-file/verdict` subpath adds one strict, subject-bound verdict
artifact shared by test and release harnesses. Artifact paths always come from
the caller; the package creates no global store and infers nothing from cwd.
