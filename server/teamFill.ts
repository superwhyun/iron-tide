import { HULLS } from "../shared/config";
import type { Hull } from "../shared/types";

const HULL_KINDS: Hull[] = ["destroyer", "cruiser", "battleship"];
/** Fleet strength proxy: a hull's hit points. */
const power = (hull: Hull) => HULLS[hull].hp;

/** Every multiset of `n` hulls, largest first (n ≤ 4: at most 15). */
function multisets(n: number): Hull[][] {
  const out: Hull[][] = [];
  const walk = (start: number, picked: Hull[]) => {
    if (picked.length === n) {
      out.push(picked);
      return;
    }
    for (let i = start; i < HULL_KINDS.length; i++)
      walk(i, [...picked, HULL_KINDS[i]]);
  };
  walk(0, []);
  return out;
}
const counts = (hulls: Hull[]) =>
  HULL_KINDS.map((h) => hulls.filter((x) => x === h).length);
/** Lexicographic "a sorts before b". */
function before(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
const sum = (hulls: Hull[]) => hulls.reduce((n, h) => n + power(h), 0);

/** Lower when a fleet mixes hull types evenly (sum of squared counts). */
const lumpiness = (hulls: Hull[]) =>
  counts(hulls).reduce((n, c) => n + c * c, 0);

/**
 * NPC hulls to add to each fleet so both end up as alike as possible.
 * Identical compositions win, mixing destroyers, cruisers and battleships as
 * evenly as possible with `preferred` taking any odd seat. Otherwise the
 * closest total strength, and on a tie the bigger ships.
 */
export function planTeamFill(
  red: Hull[],
  blue: Hull[],
  seats: [number, number],
  preferred: Hull,
): [Hull[], Hull[]] {
  let best: { add: [Hull[], Hull[]]; key: number[] } | null = null;
  for (const a of multisets(seats[0]))
    for (const b of multisets(seats[1])) {
      const ra = [...red, ...a],
        rb = [...blue, ...b];
      const ca = counts(ra),
        cb = counts(rb);
      const mismatch = ca.reduce((n, c, i) => n + Math.abs(c - cb[i]), 0);
      const added = [...a, ...b];
      const chosen = -added.filter((h) => h === preferred).length;
      const key =
        mismatch === 0
          ? // Identical fleets: as varied as possible, then the chosen hull.
            [0, 0, 0, lumpiness(ra), chosen]
          : [1, Math.abs(sum(ra) - sum(rb)), mismatch, -sum(added), chosen];
      if (!best || before(key, best.key)) best = { add: [a, b], key };
    }
  return best ? best.add : [[], []];
}
