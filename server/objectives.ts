import { dist } from "../shared/math";
import type { Ship, Zone } from "../shared/types";

export const DOMINATION = {
  /** Seconds a lone ship needs inside a zone to take it. */
  captureTime: 8,
  radius: 110,
  /** Points per second for each zone held. */
  holdRate: 1,
  capturePoints: 20,
  killPoints: 30,
  scoreLimit: 600,
};
// Edge midpoints between the islands: every corner spawn has two zones ~740 m away.
const LAYOUT = [
  { id: "A", x: -600, z: 0 },
  { id: "B", x: 600, z: 0 },
  { id: "C", x: 0, z: -620 },
  { id: "D", x: 0, z: 620 },
];
export function createZones(): Zone[] {
  return LAYOUT.map((z) => ({
    ...z,
    radius: DOMINATION.radius,
    owner: null,
    capturer: null,
    progress: 0,
    contested: false,
  }));
}

/**
 * Advances capture progress and pays holding points. Returns the zones that
 * changed hands this tick so the game can announce them.
 */
export function updateZones(zones: Zone[], ships: Ship[], dt: number) {
  const captured: { zone: Zone; by: Ship }[] = [];
  for (const zone of zones) {
    const inside = ships.filter((s) => s.alive && dist(s, zone) < zone.radius);
    zone.contested = inside.length > 1;
    if (inside.length === 1) {
      const [ship] = inside;
      if (zone.owner === ship.id) {
        zone.capturer = null;
        zone.progress = 0;
      } else {
        if (zone.capturer !== ship.id) {
          zone.capturer = ship.id;
          zone.progress = 0;
        }
        zone.progress += dt / DOMINATION.captureTime;
        if (zone.progress >= 1) {
          zone.owner = ship.id;
          zone.capturer = null;
          zone.progress = 0;
          ship.stats.score += DOMINATION.capturePoints;
          captured.push({ zone, by: ship });
        }
      }
    } else if (!inside.length && zone.progress > 0) {
      // An abandoned capture slowly drains away.
      zone.progress = Math.max(
        0,
        zone.progress - dt / (DOMINATION.captureTime * 2),
      );
      if (!zone.progress) zone.capturer = null;
    }
    const owner = ships.find((s) => s.id === zone.owner);
    if (owner) owner.stats.score += DOMINATION.holdRate * dt;
  }
  return captured;
}
