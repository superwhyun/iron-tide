import type { Ammo, Hull } from "./types";

// Armor rules shared by the server's hit resolution and the client's aim preview.
/** Plating over bridges, funnels and masts; thin on every hull. */
export const SUPERSTRUCTURE_ARMOR: Record<Hull, number> = {
  destroyer: 13,
  cruiser: 16,
  battleship: 19,
};
export const hePenetration = (caliber: number) => caliber / 6;
export const sapPenetration = (caliber: number) => caliber * 0.22;
export const apPenetration = (caliber: number) => caliber * 1.25;
export const SAP_RICOCHET = Math.PI * 0.42;
export const AP_RICOCHET = Math.PI / 3;
export const overmatches = (caliber: number, armor: number) =>
  caliber > armor * 14.3;
/** Line-of-sight thickness; the first 5° of obliquity are free. */
export const effectiveArmor = (armor: number, angle: number) =>
  armor / Math.max(0.15, Math.cos(Math.max(0, angle - Math.PI / 36)));
export const overpenetrates = (caliber: number, armor: number) =>
  armor < caliber / 12;

export type ArmorOutcome = "penetration" | "overpen" | "shatter" | "ricochet";

/**
 * Outcome of a shell against one armor plate, before citadel placement.
 * `angle` is the impact angle from the plate normal in radians.
 */
export function armorOutcome(
  ammo: Extract<Ammo, "HE" | "AP" | "SAP">,
  caliber: number,
  armor: number,
  angle: number,
): ArmorOutcome {
  if (ammo === "HE")
    return hePenetration(caliber) >= armor ? "penetration" : "shatter";
  if (ammo === "SAP") {
    if (angle > SAP_RICOCHET) return "ricochet";
    return sapPenetration(caliber) >= armor ? "penetration" : "shatter";
  }
  if (!overmatches(caliber, armor) && angle > AP_RICOCHET) return "ricochet";
  if (apPenetration(caliber) < effectiveArmor(armor, angle)) return "shatter";
  return overpenetrates(caliber, armor) ? "overpen" : "penetration";
}
