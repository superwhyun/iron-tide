import type { Vec2, Ship } from "./types";
export const clamp = (v: number, a: number, b: number) =>
  Math.max(a, Math.min(b, v));
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
export const angleDiff = (a: number, b: number) =>
  Math.atan2(Math.sin(a - b), Math.cos(a - b));
export const bearing = (a: Vec2, b: Vec2) => Math.atan2(b.x - a.x, b.z - a.z);
export function approachAngle(current: number, target: number, step: number) {
  return current + clamp(angleDiff(target, current), -step, step);
}
export function segmentDistance(a: Vec2, b: Vec2, p: Vec2) {
  const dx = b.x - a.x,
    dz = b.z - a.z;
  const t = clamp(
    ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1),
    0,
    1,
  );
  return Math.hypot(a.x + t * dx - p.x, a.z + t * dz - p.z);
}
export function localPoint(
  point: Vec2,
  ship: Pick<Ship, "x" | "z" | "heading">,
) {
  const x = point.x - ship.x,
    z = point.z - ship.z;
  return {
    x: x * Math.cos(ship.heading) - z * Math.sin(ship.heading),
    z: x * Math.sin(ship.heading) + z * Math.cos(ship.heading),
  };
}
export function intersectsHull(
  a: Vec2,
  b: Vec2,
  ship: Pick<Ship, "x" | "z" | "heading">,
  length: number,
  beam: number,
) {
  const p = localPoint(a, ship),
    q = localPoint(b, ship);
  let lo = 0,
    hi = 1;
  for (const [v, d, r] of [
    [p.x, q.x - p.x, beam / 2],
    [p.z, q.z - p.z, length / 2],
  ]) {
    if (Math.abs(d) < 1e-8) {
      if (Math.abs(v) > r) return null;
    } else {
      let l = (-r - v) / d,
        h = (r - v) / d;
      if (l > h) [l, h] = [h, l];
      lo = Math.max(lo, l);
      hi = Math.min(hi, h);
      if (lo > hi) return null;
    }
  }
  return {
    t: lo,
    point: { x: a.x + (b.x - a.x) * lo, z: a.z + (b.z - a.z) * lo },
  };
}
export function intercept(
  shooter: Vec2,
  target: Vec2,
  heading: number,
  speed: number,
  projectileSpeed: number,
): Vec2 {
  const vx = Math.sin(heading) * speed,
    vz = Math.cos(heading) * speed,
    dx = target.x - shooter.x,
    dz = target.z - shooter.z;
  const a = vx * vx + vz * vz - projectileSpeed * projectileSpeed,
    b = 2 * (dx * vx + dz * vz),
    c = dx * dx + dz * dz;
  const det = b * b - 4 * a * c;
  let t = dist(shooter, target) / projectileSpeed;
  if (det >= 0 && Math.abs(a) > 1e-8) {
    const roots = [
      (-b - Math.sqrt(det)) / (2 * a),
      (-b + Math.sqrt(det)) / (2 * a),
    ].filter((v) => v > 0);
    if (roots.length) t = Math.min(...roots);
  }
  return { x: target.x + vx * t, z: target.z + vz * t };
}
