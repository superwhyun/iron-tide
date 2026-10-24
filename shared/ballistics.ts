import { HULLS } from "./config";
import { clamp, dist } from "./math";
import { rangeBoost } from "./powerups";
import type { Ammo, Ship, Vec2 } from "./types";

export const ORDNANCE = {
  mine: {
    charges: 3,
    cooldown: 6,
    arm: 2,
    lifetime: 90,
    damage: 6000,
    blast: 22,
  },
  rbu: {
    charges: 6,
    cooldown: 10,
    range: 240,
    speed: 170,
    rockets: 6,
    blast: 22,
    damage: 280,
  },
};
export function gunRangeFor(s: Ship) {
  return HULLS[s.hull].range * (1 + 0.08 * s.upgrades.range) * rangeBoost(s);
}
export function dispersionRadius(
  s: Ship,
  distance: number,
  weapon: Ammo = s.input.weapon,
) {
  if (weapon === "RBU")
    return 10 + clamp(distance, 0, ORDNANCE.rbu.range) * 0.055;
  const range = gunRangeFor(s),
    optimal = range * 0.55;
  const base = s.hull === "destroyer" ? 8 : s.hull === "cruiser" ? 11 : 16;
  const ratio = clamp(distance, 0, range) / optimal;
  const beyond = Math.max(0, distance - optimal) / (range - optimal);
  const shell = weapon === "HE" ? 1.12 : weapon === "SAP" ? 0.9 : 1;
  return (
    base *
    (0.35 + 0.65 * Math.pow(ratio, 1.35)) *
    (1 + 0.5 * beyond * beyond) *
    shell *
    (1 + 0.15 * s.upgrades.salvo) *
    (1 - 0.12 * s.upgrades.accuracy)
  );
}
export function minePosition(s: Ship): Vec2 {
  const aft = HULLS[s.hull].length * 0.5 + 7;
  return {
    x: s.x - Math.sin(s.heading) * aft,
    z: s.z - Math.cos(s.heading) * aft,
  };
}
export function aimSolution(s: Ship, aim: Vec2, weapon: Ammo = s.input.weapon) {
  if (weapon === "MINE")
    return {
      center: minePosition(s),
      radius: ORDNANCE.mine.blast,
      distance: 0,
      range: 0,
    };
  const range = weapon === "RBU" ? ORDNANCE.rbu.range : gunRangeFor(s);
  const distance = clamp(dist(s, aim), weapon === "RBU" ? 15 : 35, range);
  const angle = Math.atan2(aim.x - s.x, aim.z - s.z);
  return {
    center: {
      x: s.x + Math.sin(angle) * distance,
      z: s.z + Math.cos(angle) * distance,
    },
    radius: dispersionRadius(s, distance, weapon),
    distance,
    range,
  };
}
// Area-uniform concentric-square mapping. The midpoint maps exactly to the aim point.
export function randomImpact(
  center: Vec2,
  radius: number,
  random: () => number,
): Vec2 {
  const x = random() * 2 - 1,
    z = random() * 2 - 1;
  if (x === 0 && z === 0) return { ...center };
  const r = Math.abs(x) > Math.abs(z) ? x : z;
  const a =
    Math.abs(x) > Math.abs(z)
      ? ((Math.PI / 4) * z) / x
      : Math.PI / 2 - ((Math.PI / 4) * x) / z;
  return {
    x: center.x + Math.cos(a) * r * radius,
    z: center.z + Math.sin(a) * r * radius,
  };
}
