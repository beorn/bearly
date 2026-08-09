import { createNativeFlockRuntime } from "./native.ts"
import { createFlockRuntime, type FlockHandle, type FlockOpenOptions } from "./runtime.ts"

export type { FlockHandle, FlockOpenOptions } from "./runtime.ts"

const native = createNativeFlockRuntime()
const runtime = createFlockRuntime(native.io, native)

/** Try one exclusive fd-held flock. Returns null only when another owner holds it. */
export function tryAcquireFlock(path: string, options?: FlockOpenOptions): FlockHandle | null {
  return runtime.tryAcquire(path, options)
}

/** Block in the kernel until one exclusive fd-held flock is acquired. */
export function acquireFlockBlocking(path: string, options?: FlockOpenOptions): FlockHandle {
  return runtime.acquireBlocking(path, options)
}

/** Observe flock liveness. Durable pathname/body presence is never authority. */
export function isFlockHeld(path: string): boolean {
  return runtime.isHeld(path)
}
