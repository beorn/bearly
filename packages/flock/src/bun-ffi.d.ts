/**
 * Declares the slice of `bun:ffi` this package calls, and nothing else: no Bun
 * globals, so a Node-typed program that type-checks this package's source does
 * not inherit Bun's environment. The shapes live in bun-ffi-slice.ts. Under
 * bun-types these merge as extra overloads, which is why FFIType and Pointer are
 * not declared here: an enum or a type alias cannot merge.
 */
declare module "bun:ffi" {
  function dlopen(
    ...args: Parameters<import("./bun-ffi-slice.ts").SliceDlopen>
  ): ReturnType<import("./bun-ffi-slice.ts").SliceDlopen>

  namespace read {
    function i32(
      ...args: Parameters<import("./bun-ffi-slice.ts").SliceReadI32>
    ): ReturnType<import("./bun-ffi-slice.ts").SliceReadI32>
  }
}
