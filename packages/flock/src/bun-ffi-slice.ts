/**
 * The slice of `bun:ffi` this package calls, as named types. Source: bun-types
 * 1.4.1, ffi.d.ts — `dlopen` narrowed to the type labels native.ts binds, and
 * `read.i32` exactly. bun-ffi.d.ts declares the module from these;
 * tests/ffi-drift proves real Bun satisfies them, and must be re-proven on
 * every bun-types bump.
 */
export type FfiTypeLabel = "i32" | "u64" | "ptr"

export type FfiSymbolDefinitions = Readonly<
  Record<string, { readonly args?: readonly FfiTypeLabel[]; readonly returns?: FfiTypeLabel }>
>

/** Bun's pointer brand, byte-identical to bun-types' `Pointer`. */
export type BunPointer = number & { __pointer__: null }

export type SliceDlopen = (name: string, symbols: FfiSymbolDefinitions) => { readonly symbols: unknown; close(): void }

export type SliceReadI32 = (ptr: BunPointer | number | bigint, byteOffset?: number) => number
