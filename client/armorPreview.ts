import { HULLS } from "../shared/config";
import { armorOutcome, SUPERSTRUCTURE_ARMOR } from "../shared/armor";
import type { ArmorOutcome } from "../shared/armor";
import { bearing } from "../shared/math";
import type { Ammo, Contact, Hull, Vec2 } from "../shared/types";

type Shell = Extract<Ammo, "HE" | "AP" | "SAP">;
const SHELLS: Shell[] = ["HE", "AP", "SAP"];
const SHELL_NAME: Record<Shell, string> = {
  HE: "고폭탄",
  AP: "철갑탄",
  SAP: "반철갑탄",
};
const OUTCOME: Record<ArmorOutcome, string> = {
  penetration: "관통",
  overpen: "과관통",
  shatter: "비관통",
  ricochet: "도탄",
};
export const isShell = (ammo: Ammo): ammo is Shell =>
  SHELLS.includes(ammo as Shell);

/** Horizontal impact angle from a plate normal; 0 = square-on. */
function impactAngle(incoming: number, normal: number) {
  return Math.acos(Math.min(1, Math.abs(Math.cos(incoming - normal))));
}

/**
 * Expected result per armor zone for the selected shell, using the same rules
 * the server applies. Horizontal approximation: deck hits are not previewed.
 */
export function armorPreview(
  shooter: Vec2 & { hull: Hull },
  target: Pick<Contact, "x" | "z" | "hull" | "heading">,
  shell: Shell,
) {
  const caliber = HULLS[shooter.hull].caliber,
    armor = HULLS[target.hull].armor,
    incoming = bearing(shooter, target);
  const sideAngle = impactAngle(incoming, target.heading + Math.PI / 2),
    bowAngle = impactAngle(incoming, target.heading);
  const zones = [
    { name: "주장갑대", mm: armor.side, angle: sideAngle },
    { name: "상부 측면", mm: armor.upper, angle: sideAngle },
    { name: "선수·함미", mm: armor.bow, angle: bowAngle },
    {
      name: "상부 구조물",
      mm: SUPERSTRUCTURE_ARMOR[target.hull],
      angle: sideAngle,
    },
  ].map((z) => ({
    ...z,
    outcome: armorOutcome(shell, caliber, z.mm, z.angle),
  }));
  const [belt, upper] = zones;
  const pierces = (s: Shell, z: { mm: number; angle: number }) =>
    armorOutcome(s, caliber, z.mm, z.angle) === "penetration";
  let hint = "";
  if (belt.outcome !== "penetration") {
    const better = SHELLS.find((s) => s !== shell && pierces(s, belt));
    const upperShell = SHELLS.find((s) => pierces(s, upper));
    hint = better
      ? `주장갑대는 ${SHELL_NAME[better]} 권장 (핵심 구획 노림)`
      : belt.outcome === "ricochet" && upper.outcome === "ricochet"
        ? "표적이 각을 세움 · 측면이 보일 때 사격"
        : upper.outcome === "penetration" || upper.outcome === "overpen"
          ? "주장갑대 비관통 · 수선 위 상부 측면에는 피해"
          : upperShell
            ? `상부 측면은 ${SHELL_NAME[upperShell]} 권장`
            : "선체 관통 불가 · 어뢰 권장";
  }
  return {
    angle: Math.round((sideAngle * 180) / Math.PI),
    zones,
    hint,
    html:
      `<span class="pen-title">${SHELL_NAME[shell]} ${caliber}mm → 측면 입사 ${Math.round((sideAngle * 180) / Math.PI)}°</span>` +
      zones
        .map(
          (z) =>
            `<span class="pen-chip" data-outcome="${z.outcome}">${z.name} ${z.mm}mm <b>${OUTCOME[z.outcome]}</b></span>`,
        )
        .join("") +
      (hint ? `<em>${hint}</em>` : ""),
  };
}
