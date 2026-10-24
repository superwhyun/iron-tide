import type { BuffKind, PickupKind } from "./types";

interface PowerupInfo {
  name: string;
  /** One-line effect shown in the HUD and on pickup. */
  effect: string;
  color: string;
  /** Glyph drawn on the floating crate and HUD chip. */
  glyph: string;
}
export const POWERUPS: Record<PickupKind, PowerupInfo> = {
  range: {
    name: "사거리 증폭",
    effect: "주포 사거리 +20%",
    color: "#7fc8ff",
    glyph: "⌖",
  },
  firepower: {
    name: "화력 증폭",
    effect: "포탄 피해 +25%",
    color: "#ff7a4f",
    glyph: "✸",
  },
  armor: {
    name: "장갑 강화",
    effect: "받는 피해 −30%",
    color: "#c9d4dc",
    glyph: "⛨",
  },
  engine: {
    name: "기관 과급",
    effect: "속력·선회 +25%",
    color: "#7fe0a8",
    glyph: "»",
  },
  reload: {
    name: "신속 장전",
    effect: "주포 재장전 −40%",
    color: "#f2c27a",
    glyph: "↻",
  },
  repair: {
    name: "응급 수리",
    effect: "체력 20% 회복 · 화재·침수 진화",
    color: "#ff9ec4",
    glyph: "✚",
  },
};
export const BUFF_KINDS: BuffKind[] = [
  "range",
  "firepower",
  "armor",
  "engine",
  "reload",
];
export const PICKUP_KINDS = Object.keys(POWERUPS) as PickupKind[];
export const BUFF_SECONDS = 20;

type Buffed = { buffs?: Partial<Record<BuffKind, number>> };
export const hasBuff = (s: Buffed, kind: BuffKind) =>
  (s.buffs?.[kind] ?? 0) > 0;
export const rangeBoost = (s: Buffed) => (hasBuff(s, "range") ? 1.2 : 1);
export const damageBoost = (s: Buffed) => (hasBuff(s, "firepower") ? 1.25 : 1);
export const damageTaken = (s: Buffed) => (hasBuff(s, "armor") ? 0.7 : 1);
export const engineBoost = (s: Buffed) => (hasBuff(s, "engine") ? 1.25 : 1);
export const reloadBoost = (s: Buffed) => (hasBuff(s, "reload") ? 0.6 : 1);
