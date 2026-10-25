import type { Hull, Island, Upgrade, NpcModel } from "./types";
export const NPC_MODELS: Record<
  NpcModel,
  { title: string; file: string; waterline: number }
> = {
  camouflage: {
    title: "위장 함선",
    file: "/models/npc-battleship.glb",
    waterline: 0.19,
  },
  "wisconsin-golden": {
    title: "Wisconsin Golden",
    file: "/models/npc-wisconsin-golden.glb",
    waterline: 0.095,
  },
};
export const mainCaliber = (ship: { hull: Hull; npcModel?: NpcModel }) =>
  ship.npcModel === "wisconsin-golden" ? 406 : HULLS[ship.hull].caliber;
export const RULES = {
  tick: 30,
  snapshot: 15,
  duration: 480,
  maxPlayers: 8,
  respawn: 5,
  reconnect: 30,
  world: 1500,
  gravity: 30,
  maxLevel: 10,
  forcedDetection: 100,
};
/**
 * Changing shell type reloads the guns for this fraction of the full reload:
 * HE rams fastest, armour-piercing AP slowest. A turret already further from
 * ready keeps its own timer.
 */
export const SHELL_SWITCH: Record<"HE" | "SAP" | "AP", number> = {
  HE: 0.4,
  SAP: 0.5,
  AP: 0.6,
};
/** Team match: the first fleet to sink this many ships wins. */
export const TEAM_MATCH = { killLimit: 15, size: RULES.maxPlayers / 2 };
export interface HullConfig {
  name: string;
  title: string;
  role: string;
  hp: number;
  speed: number;
  accel: number;
  turn: number;
  length: number;
  beam: number;
  detect: number;
  range: number;
  reload: number;
  shellSpeed: number;
  caliber: number;
  shellDamage: number;
  barrels: number;
  turrets: number[];
  turretSpeed: number;
  /** side = waterline belt, upper = thin plating between belt and deck. */
  armor: { bow: number; side: number; upper: number; deck: number };
  torpedo: boolean;
  torpedoDamage: number;
  torpedoReload: number;
  torpedoRange: number;
  secondaryRange: number;
  special: string;
  charges: number;
  color: string;
}
export const HULLS: Record<Hull, HullConfig> = {
  destroyer: {
    name: "해무",
    title: "구축함",
    role: "은폐 · 어뢰 기습",
    hp: 14000,
    speed: 28,
    accel: 3.5,
    turn: 0.21,
    length: 44,
    beam: 7,
    detect: 530,
    range: 900,
    reload: 4,
    shellSpeed: 155,
    caliber: 127,
    shellDamage: 1200,
    barrels: 2,
    turrets: [14, -13],
    turretSpeed: 0.9,
    armor: { bow: 13, side: 19, upper: 13, deck: 13 },
    torpedo: true,
    torpedoDamage: 7500,
    torpedoReload: 24,
    torpedoRange: 1150,
    secondaryRange: 0,
    special: "연막 생성기",
    charges: 3,
    color: "#5ed6c4",
  },
  cruiser: {
    name: "청람",
    title: "순양함",
    role: "정밀 포격 · 다목적 전투",
    hp: 27000,
    speed: 22,
    accel: 2.3,
    turn: 0.15,
    length: 59,
    beam: 10,
    detect: 740,
    range: 1150,
    reload: 7,
    shellSpeed: 180,
    caliber: 203,
    shellDamage: 2300,
    barrels: 3,
    turrets: [20, 10, -18],
    turretSpeed: 0.57,
    armor: { bow: 25, side: 100, upper: 19, deck: 30 },
    torpedo: true,
    torpedoDamage: 6500,
    torpedoReload: 32,
    torpedoRange: 850,
    secondaryRange: 290,
    special: "수중 음향 탐지",
    charges: 3,
    color: "#7bb9ee",
  },
  battleship: {
    name: "태산",
    title: "전함",
    role: "대구경 주포 · 중장갑",
    hp: 50000,
    speed: 16,
    accel: 1.3,
    turn: 0.1,
    length: 76,
    beam: 15,
    detect: 940,
    range: 1350,
    reload: 12,
    shellSpeed: 195,
    caliber: 380,
    shellDamage: 4400,
    barrels: 3,
    turrets: [27, 15, -24],
    turretSpeed: 0.33,
    armor: { bow: 32, side: 260, upper: 32, deck: 50 },
    torpedo: false,
    torpedoDamage: 0,
    torpedoReload: 0,
    torpedoRange: 0,
    secondaryRange: 390,
    special: "수리반",
    charges: 3,
    color: "#edc083",
  },
};
export const ISLANDS: Island[] = [
  { x: 0, z: 0, radius: 125, height: 60, seed: 1 },
  { x: -490, z: -350, radius: 100, height: 80, seed: 2 },
  { x: 490, z: 350, radius: 100, height: 80, seed: 3 },
  { x: 400, z: -510, radius: 75, height: 35, seed: 4 },
  { x: -400, z: 510, radius: 75, height: 35, seed: 5 },
  { x: -920, z: 280, radius: 120, height: 100, seed: 6 },
  { x: 920, z: -280, radius: 120, height: 100, seed: 7 },
  { x: 100, z: -1050, radius: 100, height: 55, seed: 8 },
  { x: -100, z: 1050, radius: 100, height: 55, seed: 9 },
];
export const UPGRADE_INFO: Record<
  Upgrade,
  { name: string; description: string }
> = {
  accuracy: {
    name: "사격 관제 · 정확도",
    description: "주포 분산 반경 −12% / 단계 · 최대 −36%",
  },
  range: {
    name: "주포 사거리",
    description: "사거리 +8% / 단계 · 발포 피탐지 거리도 증가",
  },
  salvo: {
    name: "일제사격 포탄 수",
    description: "포탑당 포탄 +1 · 분산 +15%, 포탄 피해 −8%",
  },
  reload: { name: "주포 재장전", description: "재장전 시간 −7% / 단계" },
  secondary: {
    name: "부포 성능",
    description: "부포 사거리 +10%, 재장전 −10% / 단계",
  },
  torpedo: {
    name: "어뢰 성능",
    description: "어뢰 속도 +8%, 재장전 −6% / 단계",
  },
  engine: {
    name: "기관과 조타",
    description: "최고속력 +5%, 가속·선회 +6% / 단계",
  },
};
export const UPGRADE_KEYS = Object.keys(UPGRADE_INFO) as Upgrade[];
/** Each sinking in a match waits 5 s longer to respawn, capped at 20 s. */
export const respawnDelay = (deaths: number) =>
  Math.min(20, RULES.respawn + 5 * Math.max(0, deaths - 1));
export const xpRequired = (level: number) => 1600 + (level - 1) * 900;
export const throttleSpeed = [-0.3, 0, 0.25, 0.5, 0.75, 1];
export const THROTTLE_LABELS = ["후진", "정지", "¼", "½", "¾", "전속"];
