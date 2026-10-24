import { HULLS } from "../shared/config";
import type { Ammo, HitResult, ModuleKind, Ship } from "../shared/types";

/** Seconds each component stays out of action unless damage control fixes it. */
export const MODULE_DOWN: Record<ModuleKind, number> = {
  turret: 15,
  rudder: 8,
  engine: 12,
};
interface DamagingHit {
  kind: Ammo | "SECONDARY";
  result: HitResult;
  zone?: string;
  /** Hit position along the hull, + toward the bow. */
  along: number;
}

/**
 * Rolls component damage for a hit that actually hurt the ship. At most one
 * component breaks per shell: turret, then machinery, then steering gear.
 */
export function breakModule(
  target: Ship,
  hit: DamagingHit,
  random: () => number,
): ModuleKind | null {
  if (hit.kind === "SECONDARY") return null;
  const length = HULLS[target.hull].length;
  if (hit.zone === "turret" && random() < 0.5) {
    const turret = target.turrets.reduce((best, t) =>
      Math.abs(t.offset - hit.along) < Math.abs(best.offset - hit.along)
        ? t
        : best,
    );
    turret.disabled = MODULE_DOWN.turret;
    return "turret";
  }
  const machinery =
    hit.kind === "TORP" ? 0.5 : hit.result === "citadel" ? 0.4 : 0;
  if (machinery && random() < machinery) {
    target.status.engineHit = MODULE_DOWN.engine;
    return "engine";
  }
  if (hit.along < -length * 0.3 && random() < (hit.kind === "HE" ? 0.2 : 0.3)) {
    target.status.rudderJam = MODULE_DOWN.rudder;
    return "rudder";
  }
  return null;
}
export function tickModules(s: Ship, dt: number) {
  s.status.rudderJam = Math.max(0, s.status.rudderJam - dt);
  s.status.engineHit = Math.max(0, s.status.engineHit - dt);
  for (const t of s.turrets) t.disabled = Math.max(0, (t.disabled ?? 0) - dt);
}
export function repairModules(s: Ship) {
  s.status.rudderJam = 0;
  s.status.engineHit = 0;
  for (const t of s.turrets) t.disabled = 0;
}
