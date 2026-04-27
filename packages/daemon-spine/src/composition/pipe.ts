/**
 * pipe() — left-to-right function composition.
 *
 * Each step receives the previous step's value and returns a new value (typically
 * an extended type). Used to compose tribe-daemon and other long-lived systems
 * out of small `withX` capability factories. See `hub/composition.md` for the
 * full strategy.
 */

export type Plugin<A, B> = (a: A) => B

export function pipe<A>(a: A): A
export function pipe<A, B>(a: A, p1: Plugin<A, B>): B
export function pipe<A, B, C>(a: A, p1: Plugin<A, B>, p2: Plugin<B, C>): C
export function pipe<A, B, C, D>(a: A, p1: Plugin<A, B>, p2: Plugin<B, C>, p3: Plugin<C, D>): D
export function pipe<A, B, C, D, E>(
  a: A,
  p1: Plugin<A, B>,
  p2: Plugin<B, C>,
  p3: Plugin<C, D>,
  p4: Plugin<D, E>,
): E
export function pipe<A, B, C, D, E, F>(
  a: A,
  p1: Plugin<A, B>,
  p2: Plugin<B, C>,
  p3: Plugin<C, D>,
  p4: Plugin<D, E>,
  p5: Plugin<E, F>,
): F
export function pipe<A, B, C, D, E, F, G>(
  a: A,
  p1: Plugin<A, B>,
  p2: Plugin<B, C>,
  p3: Plugin<C, D>,
  p4: Plugin<D, E>,
  p5: Plugin<E, F>,
  p6: Plugin<F, G>,
): G
export function pipe<A, B, C, D, E, F, G, H>(
  a: A,
  p1: Plugin<A, B>,
  p2: Plugin<B, C>,
  p3: Plugin<C, D>,
  p4: Plugin<D, E>,
  p5: Plugin<E, F>,
  p6: Plugin<F, G>,
  p7: Plugin<G, H>,
): H
export function pipe<A, B, C, D, E, F, G, H, I>(
  a: A,
  p1: Plugin<A, B>,
  p2: Plugin<B, C>,
  p3: Plugin<C, D>,
  p4: Plugin<D, E>,
  p5: Plugin<E, F>,
  p6: Plugin<F, G>,
  p7: Plugin<G, H>,
  p8: Plugin<H, I>,
): I
export function pipe<A, B, C, D, E, F, G, H, I, J>(
  a: A,
  p1: Plugin<A, B>,
  p2: Plugin<B, C>,
  p3: Plugin<C, D>,
  p4: Plugin<D, E>,
  p5: Plugin<E, F>,
  p6: Plugin<F, G>,
  p7: Plugin<G, H>,
  p8: Plugin<H, I>,
  p9: Plugin<I, J>,
): J
export function pipe<A, B, C, D, E, F, G, H, I, J, K>(
  a: A,
  p1: Plugin<A, B>,
  p2: Plugin<B, C>,
  p3: Plugin<C, D>,
  p4: Plugin<D, E>,
  p5: Plugin<E, F>,
  p6: Plugin<F, G>,
  p7: Plugin<G, H>,
  p8: Plugin<H, I>,
  p9: Plugin<I, J>,
  p10: Plugin<J, K>,
): K
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L>(
  a: A,
  p1: Plugin<A, B>,
  p2: Plugin<B, C>,
  p3: Plugin<C, D>,
  p4: Plugin<D, E>,
  p5: Plugin<E, F>,
  p6: Plugin<F, G>,
  p7: Plugin<G, H>,
  p8: Plugin<H, I>,
  p9: Plugin<I, J>,
  p10: Plugin<J, K>,
  p11: Plugin<K, L>,
): L
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M>(
  a: A,
  p1: Plugin<A, B>,
  p2: Plugin<B, C>,
  p3: Plugin<C, D>,
  p4: Plugin<D, E>,
  p5: Plugin<E, F>,
  p6: Plugin<F, G>,
  p7: Plugin<G, H>,
  p8: Plugin<H, I>,
  p9: Plugin<I, J>,
  p10: Plugin<J, K>,
  p11: Plugin<K, L>,
  p12: Plugin<L, M>,
): M
export function pipe(a: unknown, ...fns: Array<(x: unknown) => unknown>): unknown {
  let v = a
  for (const fn of fns) v = fn(v)
  return v
}
