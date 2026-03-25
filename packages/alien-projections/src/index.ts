import { computed } from "alien-signals"

/** A readable signal accessor — callable to get current value. */
type Accessor<T> = () => T

/**
 * Options for creating a projection over a reactive collection.
 *
 * @typeParam T - Source item type
 * @typeParam K - Key type (must be usable as a Map key)
 * @typeParam U - Mapped output type (defaults to T if no map provided)
 */
export interface ProjectionOptions<T, K, U = T> {
  /** Extract a stable identity key from each item. */
  key: (item: T) => K
  /** Transform each item. Only re-executed for items whose identity or value changed. */
  map?: (item: T) => U
  /** Filter items after mapping. Items failing the predicate are excluded from output. */
  filter?: (mapped: U) => boolean
  /** Sort the final output. Applied after map and filter. */
  sort?: (a: U, b: U) => number
}

interface CacheEntry<T, U> {
  input: T
  output: U
}

/**
 * Create an incremental reactive projection over a signal-backed collection.
 *
 * When the source signal changes, only items that were added or whose value
 * changed (by reference) are re-mapped. Removed items are dropped from the
 * cache. Filter and sort are applied to the full output after incremental
 * map updates.
 *
 * @returns A computed signal that produces the projected collection.
 */
export function createProjection<T, K, U = T>(
  source: Accessor<T[]>,
  options: ProjectionOptions<T, K, U>,
): Accessor<U[]> {
  const { key: keyFn, map: mapFn, filter: filterFn, sort: sortFn } = options

  // Identity map when no map function provided
  const effectiveMap = mapFn ?? ((item: T) => item as unknown as U)

  // Cache keyed by item identity
  const cache = new Map<K, CacheEntry<T, U>>()

  return computed(() => {
    const items = source()
    const seenKeys = new Set<K>()
    const results: U[] = []

    for (const item of items) {
      const k = keyFn(item)

      // Handle duplicate keys: last occurrence wins (first is overwritten)
      seenKeys.add(k)

      const existing = cache.get(k)

      let output: U
      if (existing !== undefined && existing.input === item) {
        // Same reference — reuse cached output
        output = existing.output
      } else {
        // New or changed — re-map
        output = effectiveMap(item)
        cache.set(k, { input: item, output })
      }

      if (filterFn !== undefined) {
        if (!filterFn(output)) continue
      }

      results.push(output)
    }

    // Evict stale cache entries for removed items
    if (cache.size > seenKeys.size) {
      for (const k of cache.keys()) {
        if (!seenKeys.has(k)) {
          cache.delete(k)
        }
      }
    }

    // Sort if requested
    if (sortFn !== undefined) {
      results.sort(sortFn)
    }

    return results
  })
}
