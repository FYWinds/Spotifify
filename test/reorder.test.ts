import { describe, expect, test } from "bun:test";
import { applyMove, planMoves } from "../src/sync/reorder.ts";

/** Deterministic LCG so failures are reproducible by seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function shuffled<T>(arr: readonly T[], rand: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function lisLength(seq: number[]): number {
  const tails: number[] = [];
  for (const v of seq) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tails[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
  }
  return tails.length;
}

describe("applyMove", () => {
  test("moving first item to the end (Spotify docs example)", () => {
    expect(applyMove(["a", "b", "c", "d"], { rangeStart: 0, insertBefore: 4 })).toEqual(["b", "c", "d", "a"]);
  });

  test("moving last item to the start (Spotify docs example)", () => {
    expect(applyMove(["a", "b", "c", "d"], { rangeStart: 3, insertBefore: 0 })).toEqual(["d", "a", "b", "c"]);
  });

  test("insert_before lands before the element that was there before the move", () => {
    expect(applyMove(["a", "b", "c", "d"], { rangeStart: 0, insertBefore: 2 })).toEqual(["b", "a", "c", "d"]);
    expect(applyMove(["a", "b", "c", "d"], { rangeStart: 2, insertBefore: 1 })).toEqual(["a", "c", "b", "d"]);
  });
});

describe("planMoves", () => {
  test("identical arrays need no moves", () => {
    expect(planMoves(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
    expect(planMoves([], [])).toEqual([]);
  });

  test("a single displaced element takes exactly one move", () => {
    for (const [current, target] of [
      [["a", "b", "c", "d"], ["b", "c", "d", "a"]],
      [["a", "b", "c", "d"], ["d", "a", "b", "c"]],
      [["a", "b", "c", "d"], ["a", "c", "b", "d"]],
    ] as const) {
      const moves = planMoves([...current], [...target]);
      expect(moves.length).toBe(1);
      expect(applyMove(current, moves[0]!)).toEqual([...target]);
    }
  });

  test("rejects non-permutations", () => {
    expect(() => planMoves(["a", "b"], ["a"])).toThrow();
    expect(() => planMoves(["a", "b"], ["a", "c"])).toThrow();
    expect(() => planMoves(["a", "a"], ["a", "b"])).toThrow();
  });

  test("handles duplicate values by occurrence", () => {
    const current = ["x", "y", "x", "z", "y"];
    const target = ["y", "x", "y", "z", "x"];
    let w = current;
    for (const m of planMoves(current, target)) w = applyMove(w, m);
    expect(w).toEqual(target);
  });

  test("random permutations: sequential application reaches target with n - LIS moves", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      const n = 1 + Math.floor(rand() * 40);
      const current = Array.from({ length: n }, (_, i) => `t${i}`);
      const target = shuffled(current, rand);
      const moves = planMoves(current, target);

      const indexInTarget = new Map(target.map((v, j) => [v, j]));
      expect(moves.length).toBe(n - lisLength(current.map((v) => indexInTarget.get(v)!)));

      let w = current;
      for (const m of moves) {
        expect(m.rangeStart).toBeGreaterThanOrEqual(0);
        expect(m.rangeStart).toBeLessThan(n);
        expect(m.insertBefore).toBeGreaterThanOrEqual(0);
        expect(m.insertBefore).toBeLessThanOrEqual(n);
        // A no-op move would waste an API call.
        expect(m.insertBefore === m.rangeStart || m.insertBefore === m.rangeStart + 1).toBe(false);
        w = applyMove(w, m);
      }
      expect(w).toEqual(target);
    }
  });
});
