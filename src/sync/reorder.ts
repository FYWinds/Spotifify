import type { Move } from "./plan.ts";

/**
 * Spotify `PUT /playlists/{id}/tracks` semantics for a single item: remove the item at `rangeStart`,
 * then insert it before the element that sat at `insertBefore` in the pre-move array.
 */
export function applyMove(arr: readonly string[], m: Move): string[] {
  const out = arr.slice();
  const [item] = out.splice(m.rangeStart, 1);
  out.splice(m.insertBefore > m.rangeStart ? m.insertBefore - 1 : m.insertBefore, 0, item!);
  return out;
}

/** Indices (into `seq`) of one longest strictly increasing subsequence. */
function longestIncreasingSubsequence(seq: number[]): number[] {
  const tails: number[] = []; // tails[k] = index in seq of the smallest tail of an increasing subsequence of length k+1
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i]!;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (seq[tails[mid]!]! < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out = new Array<number>(tails.length);
  for (let k = tails.length - 1, i = tails[k] ?? -1; k >= 0; k--, i = prev[i]!) out[k] = i;
  return out;
}

/**
 * Minimal single-item move sequence turning `current` into `target` (a permutation of `current`; duplicates are
 * paired by occurrence). Elements on a longest increasing subsequence stay put; every other element is moved into
 * place once, so `moves.length === n - |LIS|`. Moves are expressed against the array as it is at application time.
 */
export function planMoves(current: string[], target: string[]): Move[] {
  if (current.length !== target.length) throw new Error(`reorder: length mismatch (${current.length} vs ${target.length})`);
  const slots = new Map<string, number[]>();
  for (let j = target.length - 1; j >= 0; j--) {
    const v = target[j]!;
    const list = slots.get(v);
    if (list) list.push(j);
    else slots.set(v, [j]);
  }
  const n = current.length;
  // Working order expressed as target indices; the goal state is the identity.
  const w = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const j = slots.get(current[i]!)?.pop();
    if (j === undefined) throw new Error(`reorder: target is not a permutation of current (extra ${JSON.stringify(current[i])})`);
    w[i] = j;
  }
  const kept = new Uint8Array(n);
  for (const i of longestIncreasingSubsequence(w)) kept[w[i]!] = 1;

  const moves: Move[] = [];
  for (let t = 0; t < n; t++) {
    if (kept[t]) continue;
    // Every element with target index < t is already placed and in final relative order, so t belongs right after t-1.
    const rangeStart = w.indexOf(t);
    const insertBefore = t === 0 ? 0 : w.indexOf(t - 1) + 1;
    moves.push({ rangeStart, insertBefore });
    w.splice(rangeStart, 1);
    w.splice(insertBefore > rangeStart ? insertBefore - 1 : insertBefore, 0, t);
  }
  for (let i = 0; i < n; i++) if (w[i] !== i) throw new Error("reorder: internal error, planned moves do not reach target");
  return moves;
}
