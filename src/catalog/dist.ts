import type { Dist } from '../types.js';

/** Fraction of all votes that landed in `key` (0..1). 0 when there are no votes. */
export function share<K extends string>(d: Dist<K>, key: K): number {
  const total = sum(d);
  return total > 0 ? (d[key] ?? 0) / total : 0;
}

/** Votes for `key` relative to the leading bucket (0..1) - FragDB's display scale. */
export function rel<K extends string>(d: Dist<K>, key: K): number {
  const max = Math.max(0, ...Object.values<number>(d));
  return max > 0 ? (d[key] ?? 0) / max : 0;
}

export function sum<K extends string>(d: Dist<K>): number {
  let s = 0;
  for (const v of Object.values<number>(d)) s += v;
  return s;
}

/**
 * Vote-weighted mean position on an ordered scale, 0..1.
 * e.g. longevity [very_weak..eternal] -> 0 means "very weak", 1 means "eternal".
 */
export function meanLevel<K extends string>(d: Dist<K>, order: readonly K[]): number {
  const total = sum(d);
  if (total <= 0 || order.length < 2) return NaN;
  let acc = 0;
  order.forEach((k, i) => { acc += (d[k] ?? 0) * i; });
  return acc / total / (order.length - 1);
}

/** Bucket with the most votes, or undefined if unvoted. */
export function top<K extends string>(d: Dist<K>): K | undefined {
  let best: K | undefined;
  let bv = 0;
  for (const [k, v] of Object.entries<number>(d)) if (v > bv) { bv = v; best = k as K; }
  return best;
}

export function emptyDist<K extends string>(keys: readonly K[]): Dist<K> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Dist<K>;
}
