import { HULLS, ISLANDS, RULES } from "./config";
import { shoreRadius } from "./terrain";
import type { Ship, Vec2, Island } from "./types";

function coast(island: Island, p: Vec2, padding: number) {
  const x = p.x - island.x,
    z = p.z - island.z;
  const distance = Math.hypot(x, z),
    angle = Math.atan2(x, z);
  const derivative =
    island.radius *
    (0.285 * Math.cos(angle * 3 + island.seed) +
      0.275 * Math.cos(angle * 5 - island.seed * 1.7) +
      0.09 * Math.cos(angle * 9 + island.seed * 0.4));
  const gx =
    Math.sin(angle) - (derivative * Math.cos(angle)) / Math.max(1, distance);
  const gz =
    Math.cos(angle) + (derivative * Math.sin(angle)) / Math.max(1, distance);
  const length = Math.hypot(gx, gz);
  return {
    gap: distance - shoreRadius(island, angle) - padding,
    x: gx / length,
    z: gz / length,
    gradient: length,
  };
}
export function nearShore(s: Pick<Ship, "x" | "z" | "hull">) {
  return ISLANDS.some(
    (i) => coast(i, s, HULLS[s.hull].length * 0.35).gap < 0.75,
  );
}
export function moveAlongShore(s: Ship, next: Vec2) {
  const padding = HULLS[s.hull].length * 0.35;
  let blocked = false;
  const requested = Math.hypot(next.x - s.x, next.z - s.z);
  for (const island of ISLANDS) {
    const current = coast(island, s, padding);
    const candidate = coast(island, next, padding);
    if (candidate.gap >= 0.02) continue;
    const dx = next.x - s.x,
      dz = next.z - s.z;
    const inward = dx * current.x + dz * current.z;
    // Discard motion into land, while keeping motion along or away from shore.
    if (current.gap < 0.75 && inward < 0) {
      next.x -= current.x * inward;
      next.z -= current.z * inward;
      blocked = true;
    }
    // Recover overlaps too (e.g. another ship pushes us onto the coast).
    for (let n = 0; n < 12; n++) {
      const contact = coast(island, next, padding);
      if (contact.gap >= 0.019) break;
      const correction = (0.02 - contact.gap) / contact.gradient;
      next.x += contact.x * correction;
      next.z += contact.z * correction;
      blocked = true;
    }
  }
  const edge = RULES.world - 45;
  const x = Math.max(-edge, Math.min(edge, next.x));
  const z = Math.max(-edge, Math.min(edge, next.z));
  if (x !== next.x || z !== next.z) blocked = true;
  next.x = x;
  next.z = z;
  // Only the blocked part loses speed. A genuine reverse command can accelerate.
  if (blocked && requested > 1e-8) {
    const actual = Math.hypot(next.x - s.x, next.z - s.z);
    s.speed *= Math.min(1, actual / requested);
  }
  s.x = next.x;
  s.z = next.z;
  s.grounded = nearShore(s);
}
