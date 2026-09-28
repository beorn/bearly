/**
 * Drift detector for src/bun-ffi.d.ts. This program holds bun-types and the
 * slice's named shapes, but not the ambient slice itself: there, the slice
 * would merge into `bun:ffi` as another overload and every comparison would
 * pass by comparing the slice with itself. Each row asserts that real Bun
 * satisfies the slice, so a slice that promises what Bun does not fails
 * `bun run typecheck`. Re-prove on every bun-types bump (written against 1.4.1).
 */
import type { dlopen, read } from "bun:ffi"
import type { SliceDlopen, SliceReadI32 } from "../../src/bun-ffi-slice.ts"

type BunSatisfies<Real, Slice> = Real extends Slice ? true : false

export const dlopenSatisfiesSlice: BunSatisfies<typeof dlopen, SliceDlopen> = true
export const readI32SatisfiesSlice: BunSatisfies<typeof read.i32, SliceReadI32> = true
