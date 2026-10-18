import type { Island, Vec2 } from "./types";
import { dist, segmentDistance } from "./math";
export function shoreRadius(i: Island, angle: number) {
  return (
    i.radius *
    (0.84 +
      0.095 * Math.sin(angle * 3 + i.seed) +
      0.055 * Math.sin(angle * 5 - i.seed * 1.7) +
      0.01 * Math.sin(angle * 9 + i.seed * 0.4))
  );
}
function noise(x: number, z: number, seed: number) {
  return (
    (Math.sin(x * 1.71 + seed) * Math.cos(z * 1.37 - seed * 0.3) +
      Math.sin(x * 3.92 + z * 2.3 + seed) * 0.45 +
      Math.sin(x * 8.7 - z * 7.2 + seed) * 0.19) /
    1.64
  );
}
export function terrainHeight(i: Island, p: Vec2) {
  const x = (p.x - i.x) / i.radius,
    z = (p.z - i.z) / i.radius,
    a = Math.atan2(x, z),
    r = dist(p, i) / shoreRadius(i, a);
  if (r > 1.1) return -8;
  const edge = Math.max(0, 1 - r * r);
  const ridge =
    0.68 +
    0.38 * noise(x * 3, z * 3, i.seed) +
    0.25 * Math.sin(x * 4 + z * 2 + i.seed) +
    0.075 * noise(x * 12, z * 12, i.seed);
  // Different exposure on each coast gives steep headlands and gentler beach approaches.
  const coastProfile = 0.76 + 0.23 * Math.sin(a * 2 + i.seed);
  const h = i.height * Math.pow(edge, coastProfile) * Math.max(0.12, ridge);
  return r < 1 ? Math.max(0.1, h) : -(r - 1) * 80;
}
export function islandBlocksLine(i: Island, a: Vec2, b: Vec2) {
  if (segmentDistance(a, b, i) > i.radius) return false;
  const dx = b.x - a.x,
    dz = b.z - a.z,
    length = Math.hypot(dx, dz),
    steps = Math.max(1, Math.ceil(length / 10));
  for (let s = 0; s <= steps; s++) {
    const p = { x: a.x + (dx * s) / steps, z: a.z + (dz * s) / steps };
    if (terrainHeight(i, p) > 1) return true;
  }
  return false;
}
