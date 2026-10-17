# Changelog

## Unreleased

- Added: file-CAS writes (moved from Inhab, CTO ruling3304645a), through `@bearly/durable-file/cas` for exact-byte compare-and-swap, locked replacement, and conditional withdrawal using an adjacent kernel lock.
- Share complete writes and file/directory durability barriers with the existing atomic replacement and exclusive publication APIs.
- Move the file CAS implementation and its native lock, crash, short-write, and durability coverage from Inhab into this neutral package.
