import {
  HULLS,
  ISLANDS,
  RULES,
  throttleSpeed,
  UPGRADE_KEYS,
  xpRequired,
  respawnDelay,
  mainCaliber,
  NPC_MODELS,
} from "../shared/config";
import {
  angleDiff,
  approachAngle,
  bearing,
  clamp,
  dist,
  localPoint,
  segmentDistance,
} from "../shared/math";
import type {
  Ammo,
  Contact,
  GameEvent,
  HitResult,
  Hull,
  Input,
  LastSeen,
  Lobby,
  Phase,
  Projectile,
  Ship,
  Smoke,
  Snapshot,
  Upgrade,
  Vec2,
  NpcModel,
  GameMode,
  Zone,
  BuffKind,
} from "../shared/types";
import { islandBlocksLine, terrainHeight } from "../shared/terrain";
import { moveAlongShore, nearShore } from "../shared/navigation";
import { armorOutcome } from "../shared/armor";

/** Minimum share of the normal turn rate available while touching a coast. */
const GROUNDED_PIVOT = 0.7;
/** Citadel hits deal this share of the shell's damage (a full share deleted cruisers in two salvos). */
const CITADEL_SHARE = 0.6;
import { BotCaptain, isBotSkill, type BotSkill } from "./bots";
import { breakModule, repairModules, tickModules } from "./modules";
import { createZones, DOMINATION, updateZones } from "./objectives";
import { intersectShip, type ShipHit } from "./shipCollision";
import { Ordnance } from "./ordnance";
import {
  ORDNANCE,
  aimSolution,
  dispersionRadius,
  gunRangeFor,
  randomImpact,
} from "../shared/ballistics";
import {
  damageBoost,
  damageTaken,
  engineBoost,
  reloadBoost,
} from "../shared/powerups";
import { SupplyDrops, tickBuffs } from "./pickups";

export function makeShip(
  id: string,
  name: string,
  hull: Hull = "cruiser",
): Ship {
  const c = HULLS[hull];
  return {
    id,
    bot: false,
    name,
    hull,
    x: 0,
    z: 0,
    heading: 0,
    speed: 0,
    grounded: false,
    turn: 0,
    hp: c.hp,
    maxHp: c.hp,
    alive: true,
    respawnAt: 0,
    connected: true,
    disconnectedAt: 0,
    input: {
      throttle: 1,
      rudder: 0,
      aim: { x: 0, z: 500 },
      weapon: "HE",
      firing: false,
      target: null,
    },
    turrets: c.turrets.map((offset) => ({
      offset,
      angle: offset >= 0 ? 0 : Math.PI,
      reload: 0,
    })),
    torpedoReload: 0,
    mineReload: 0,
    minesLeft: ORDNANCE.mine.charges,
    rocketReload: 0,
    rocketsLeft: ORDNANCE.rbu.charges,
    secondaryReload: 0,
    secondaries: true,
    status: {
      fire: [0, 0],
      flood: 0,
      immune: 0,
      dcp: 0,
      special: 0,
      charges: c.charges,
      smoke: 0,
      sonar: 0,
      heal: 0,
      healPool: 0,
      protection: 0,
      rudderJam: 0,
      engineHit: 0,
    },
    bloom: 0,
    level: 1,
    xp: 0,
    points: 0,
    upgrades: {
      range: 0,
      salvo: 0,
      reload: 0,
      secondary: 0,
      torpedo: 0,
      engine: 0,
      accuracy: 0,
    },
    stats: { damage: 0, kills: 0, deaths: 0, shots: 0, hits: 0, score: 0 },
    buffs: {},
  };
}
export const gunRange = gunRangeFor;
export const gunReload = (s: Ship) =>
  HULLS[s.hull].reload * (1 - 0.07 * s.upgrades.reload) * reloadBoost(s);
export function canTurretFire(s: Ship, i: number) {
  const t = s.turrets[i];
  if (!t || t.reload > 0 || (t.disabled ?? 0) > 0 || !s.alive) return false;
  const wanted = bearing(s, s.input.aim),
    relative = Math.abs(angleDiff(wanted, s.heading));
  return (
    Math.abs(angleDiff(wanted, t.angle)) < 0.065 &&
    (t.offset >= 0 ? relative < 2.45 : relative > 0.65)
  );
}
export function resolveArmor(
  target: Ship,
  kind: Ammo | "SECONDARY",
  caliber: number,
  damage: number,
  point: Vec2,
  velocity: Vec2,
  vertical = 0,
  surface?: Pick<ShipHit, "normal" | "zone" | "armor">,
): { result: HitResult; damage: number } {
  if (kind === "TORP")
    return {
      result: "torpedo",
      damage: damage * (target.hull === "battleship" ? 0.8 : 1),
    };
  const cfg = HULLS[target.hull],
    p = localPoint(point, target),
    belt = surface
      ? surface.zone === "side"
      : Math.abs(p.z) < cfg.length * 0.36,
    side = belt || surface?.zone === "upper";
  const deck = surface ? surface.zone === "deck" : vertical < -0.4;
  const armor =
    surface?.armor ??
    (deck ? cfg.armor.deck : side ? cfg.armor.side : cfg.armor.bow);
  if (kind === "HE" || kind === "SECONDARY") {
    const pierced = armorOutcome("HE", caliber, armor, 0) === "penetration";
    return {
      result:
        kind === "SECONDARY"
          ? "secondary"
          : pierced
            ? "penetration"
            : "shatter",
      damage: pierced ? damage * 0.33 : 0,
    };
  }
  const incoming = Math.atan2(velocity.x, velocity.z),
    normal = deck ? 0 : target.heading + (side ? Math.PI / 2 : 0);
  const horizontal = Math.hypot(velocity.x, velocity.z) || 1;
  const dot = surface
    ? ((surface.normal.x * velocity.x) / horizontal +
        (surface.normal.z * velocity.z) / horizontal) *
        Math.sqrt(Math.max(0, 1 - vertical * vertical)) +
      surface.normal.y * vertical
    : 0;
  const angle = surface
    ? Math.acos(clamp(Math.abs(dot), 0, 1))
    : deck
      ? Math.acos(clamp(Math.abs(vertical), 0, 1))
      : Math.acos(clamp(Math.abs(Math.cos(incoming - normal)), 0, 1));
  // Anything that is not SAP follows the AP rules, as before.
  const outcome = armorOutcome(
    kind === "SAP" ? "SAP" : "AP",
    caliber,
    armor,
    angle,
  );
  if (outcome === "ricochet" || outcome === "shatter")
    return { result: outcome, damage: 0 };
  if (kind === "SAP") return { result: "penetration", damage: damage * 0.5 };
  if (outcome === "overpen") return { result: "overpen", damage: damage * 0.1 };
  // Magazines and machinery sit behind the waterline belt, not the upper plating.
  if (
    belt &&
    !deck &&
    target.hull !== "destroyer" &&
    Math.abs(p.z) < cfg.length * 0.26
  )
    return { result: "citadel", damage: damage * CITADEL_SHARE };
  return { result: "penetration", damage: damage * 0.33 };
}

export interface CombatLedger {
  player: { kills: number; damage: number };
  /** Index 0–4 = NPC skill 1–5. */
  npc: { kills: number[]; damage: number[] };
}
export const emptyLedger = (): CombatLedger => ({
  player: { kills: 0, damage: 0 },
  npc: { kills: [0, 0, 0, 0, 0], damage: [0, 0, 0, 0, 0] },
});

export class Game {
  players = new Map<string, Ship>();
  ready = new Set<string>();
  phase: Phase = "lobby";
  mode: GameMode = "deathmatch";
  /** Player id → wallet account id, for players who signed in. */
  accounts = new Map<string, string>();
  zones: Zone[] = [];
  time = 0;
  remaining: number;
  projectiles: Projectile[] = [];
  smokes: Smoke[] = [];
  events: GameEvent[] = [];
  host = "";
  private serial = 0;
  private botSerial = 0;
  private captains = new Map<string, BotCaptain>();
  ordnance = new Ordnance(this);
  supply = new SupplyDrops(this);
  get mines() {
    return this.ordnance.mines;
  }
  nextId() {
    return ++this.serial;
  }
  private lastSeen = new Map<string, Map<string, LastSeen>>();
  private dotOwners = new Map<string, { fire: string[]; flood: string }>();
  private damageCredit = new Map<string, Map<string, number>>();
  /** Per-match tally for CGC rewards: kills and damage split by victim type. */
  readonly ledger = new Map<string, CombatLedger>();
  constructor(
    public code: string,
    public duration = RULES.duration,
    public random: () => number = Math.random,
  ) {
    this.remaining = duration;
  }
  add(id: string, name: string, account?: string) {
    if (this.phase !== "lobby")
      throw Error("이미 출항한 함대입니다. 다음 경기에 참가해 주세요.");
    if (this.players.size >= RULES.maxPlayers)
      throw Error("함대 정원은 4명입니다.");
    const s = makeShip(id, name);
    this.players.set(id, s);
    if (account) this.accounts.set(id, account);
    if (!this.host) this.host = id;
    return s;
  }
  addBot(
    host: string,
    hull: Hull,
    model: NpcModel = "camouflage",
    skill: BotSkill = 5,
  ) {
    if (host !== this.host) throw Error("함대장만 NPC를 추가할 수 있습니다.");
    if (!Object.hasOwn(HULLS, hull)) throw Error("잘못된 함종입니다.");
    if (!Object.hasOwn(NPC_MODELS, model))
      throw Error("잘못된 NPC 모델입니다.");
    if (model === "wisconsin-golden" && hull !== "battleship")
      throw Error("Wisconsin Golden은 전함입니다.");
    if (!isBotSkill(skill)) throw Error("NPC 지능은 1–5 단계입니다.");
    const number = ++this.botSerial,
      id = `npc-${number}`;
    const ship = this.add(
      id,
      model === "wisconsin-golden"
        ? `NPC 위스콘신 ${number}`
        : `NPC 함장 ${number}`,
    );
    this.players.set(id, {
      ...makeShip(id, ship.name, hull),
      bot: true,
      npcModel: model,
    });
    this.ready.add(id);
    this.captains.set(id, new BotCaptain(id, number, skill));
    return id;
  }
  setMode(host: string, mode: GameMode) {
    if (host !== this.host)
      throw Error("함대장만 경기 방식을 바꿀 수 있습니다.");
    if (this.phase !== "lobby")
      throw Error("출항 전에만 경기 방식을 바꿀 수 있습니다.");
    if (mode !== "deathmatch" && mode !== "domination")
      throw Error("알 수 없는 경기 방식입니다.");
    this.mode = mode;
  }
  removeBot(host: string, id: string) {
    if (host !== this.host) throw Error("함대장만 NPC를 제외할 수 있습니다.");
    if (this.phase !== "lobby")
      throw Error("출항 전에만 NPC를 제외할 수 있습니다.");
    if (!this.players.get(id)?.bot)
      throw Error("NPC 함선만 제외할 수 있습니다.");
    this.remove(id);
  }
  remove(id: string) {
    this.players.delete(id);
    this.accounts.delete(id);
    this.captains.delete(id);
    this.ready.delete(id);
    this.lastSeen.delete(id);
    for (const s of this.players.values())
      if (s.input.target === id) s.input.target = null;
    if (this.host === id)
      this.host =
        [...this.players.values()].find((s) => s.connected && !s.bot)?.id ??
        [...this.players.values()].find((s) => !s.bot)?.id ??
        "";
  }
  select(id: string, hull: Hull) {
    if (this.phase !== "lobby") return;
    const s = this.players.get(id);
    if (!s) return;
    this.players.set(id, makeShip(id, s.name, hull));
    this.ready.delete(id);
  }
  start(id: string) {
    if (id !== this.host) throw Error("함대장만 출항할 수 있습니다.");
    if (this.phase !== "lobby") throw Error("이미 진행 중인 경기입니다.");
    if (this.players.size < 2) throw Error("최소 2명의 함장이 필요합니다.");
    if (
      [...this.players.values()].some(
        (s) => !s.connected || !this.ready.has(s.id),
      )
    )
      throw Error("모든 함장이 준비를 완료해야 합니다.");
    this.time = 0;
    this.remaining = this.duration;
    this.phase = "battle";
    this.events = [];
    this.projectiles = [];
    this.smokes = [];
    this.lastSeen.clear();
    this.damageCredit.clear();
    this.ledger.clear();
    this.dotOwners.clear();
    this.loadedAmmo.clear();
    this.ordnance.reset();
    this.zones = this.mode === "domination" ? createZones() : [];
    this.supply.reset();
    let i = 0;
    for (const [key, old] of this.players) {
      const s = {
        ...makeShip(key, old.name, old.hull),
        bot: old.bot,
        npcModel: old.npcModel,
      };
      this.players.set(key, s);
      this.captains.get(key)?.reset();
      this.spawn(s, i++);
    }
  }
  rematch(id: string) {
    if (id !== this.host || this.phase !== "results")
      throw Error("경기 종료 후 함대장이 다시 준비할 수 있습니다.");
    this.phase = "lobby";
    this.ready.clear();
    this.projectiles = [];
    this.smokes = [];
    this.events = [];
    this.remaining = this.duration;
    this.ordnance.reset();
    for (const [key, s] of this.players)
      this.players.set(key, {
        ...makeShip(key, s.name, s.hull),
        bot: s.bot,
        npcModel: s.npcModel,
        connected: s.connected,
        disconnectedAt: s.disconnectedAt,
      });
    for (const s of this.players.values()) if (s.bot) this.ready.add(s.id);
  }
  emit(e: Omit<GameEvent, "id" | "at">) {
    this.events.push({ ...e, id: ++this.serial, at: this.time });
  }
  private spawn(s: Ship, index?: number) {
    const points = [
      { x: -760, z: -700 },
      { x: 760, z: 700 },
      { x: 760, z: -700 },
      { x: -760, z: 700 },
      { x: -1200, z: 900 },
      { x: 1200, z: -900 },
    ];
    let p = points[index ?? 0];
    if (index === undefined)
      p = points.reduce((best, next) => {
        const score = (q: Vec2) =>
          Math.min(
            ...[...this.players.values()]
              .filter((t) => t.id !== s.id && t.alive)
              .map((t) => dist(t, q)),
            1e5,
          );
        return score(next) > score(best) ? next : best;
      }, points[0]);
    s.x = p.x;
    s.z = p.z;
    s.heading = bearing(p, { x: 0, z: 0 });
    s.speed = 0;
    s.grounded = false;
    s.turn = 0;
    s.hp = s.maxHp;
    s.alive = true;
    s.respawnAt = 0;
    s.bloom = 0;
    s.buffs = {};
    s.input = {
      throttle: 1,
      rudder: 0,
      aim: {
        x: s.x + Math.sin(s.heading) * 500,
        z: s.z + Math.cos(s.heading) * 500,
      },
      weapon: "HE",
      firing: false,
      target: null,
    };
    s.turrets = HULLS[s.hull].turrets.map((offset) => ({
      offset,
      angle: s.heading + (offset < 0 ? Math.PI : 0),
      reload: 0,
    }));
    s.torpedoReload = 0;
    s.mineReload = 0;
    s.minesLeft = ORDNANCE.mine.charges;
    s.rocketReload = 0;
    s.rocketsLeft = ORDNANCE.rbu.charges;
    s.secondaryReload = 0;
    s.status = {
      fire: [0, 0],
      flood: 0,
      immune: 0,
      dcp: 0,
      special: 0,
      charges: HULLS[s.hull].charges,
      smoke: 0,
      sonar: 0,
      heal: 0,
      healPool: 0,
      protection: 3,
      rudderJam: 0,
      engineHit: 0,
    };
    this.dotOwners.delete(s.id);
    this.damageCredit.delete(s.id);
    this.loadedAmmo.set(s.id, "HE");
    this.nextHeldFire.delete(s.id);
    this.emit({ type: "respawn", x: s.x, z: s.z, target: s.id });
  }
  setInput(id: string, input: Input) {
    const s = this.players.get(id);
    if (this.phase !== "battle" || !s?.alive) return;
    if (
      !input ||
      !Number.isFinite(input.throttle) ||
      !Number.isFinite(input.rudder) ||
      !input.aim ||
      !Number.isFinite(input.aim.x) ||
      !Number.isFinite(input.aim.z) ||
      !["HE", "AP", "SAP", "TORP", "MINE", "RBU"].includes(input.weapon)
    )
      return;
    const weapon =
      input.weapon === "TORP" && !HULLS[s.hull].torpedo
        ? s.input.weapon
        : input.weapon;
    // Remember the loaded shell while switching between guns and tubes.
    const previous = this.loadedAmmo.get(id) ?? "HE";
    if (["HE", "AP", "SAP"].includes(weapon) && weapon !== previous) {
      for (const t of s.turrets) t.reload = gunReload(s);
      this.loadedAmmo.set(id, weapon);
    }
    const target =
      typeof input.target === "string" &&
      this.players.has(input.target) &&
      this.visible(s, this.players.get(input.target)!)
        ? input.target
        : null;
    const wasFiring = s.input.firing;
    s.input = {
      throttle: Math.round(clamp(input.throttle, 0, 5)),
      rudder: clamp(input.rudder, -1, 1),
      aim: {
        x: clamp(input.aim.x, -RULES.world, RULES.world),
        z: clamp(input.aim.z, -RULES.world, RULES.world),
      },
      weapon,
      firing: input.firing === true,
      target,
    };
    // A quick click can begin and end between simulation ticks; do not drop it.
    if (s.input.firing && !wasFiring) this.fire(id);
  }
  private loadedAmmo = new Map<string, Ammo>();
  private nextHeldFire = new Map<string, number>();
  upgrade(id: string, key: Upgrade) {
    const s = this.players.get(id);
    if (
      this.phase !== "battle" ||
      !s ||
      s.points < 1 ||
      !UPGRADE_KEYS.includes(key) ||
      s.upgrades[key] >= 3
    )
      return false;
    if (
      (key === "torpedo" && !HULLS[s.hull].torpedo) ||
      (key === "secondary" && !HULLS[s.hull].secondaryRange)
    )
      return false;
    s.upgrades[key]++;
    s.points--;
    return true;
  }
  ability(id: string, kind: "dcp" | "special") {
    const s = this.players.get(id);
    if (this.phase !== "battle" || !s?.alive) return false;
    if (kind === "dcp") {
      if (s.status.dcp > 0) return false;
      s.status.fire = [0, 0];
      s.status.flood = 0;
      repairModules(s);
      s.status.immune = 5;
      s.status.dcp = 45;
      this.dotOwners.delete(id);
    } else {
      if (s.status.special > 0 || s.status.charges <= 0) return false;
      if (
        s.hull === "battleship" &&
        (s.status.healPool <= 0 || s.hp >= s.maxHp)
      )
        return false;
      s.status.charges--;
      s.status.special = 60;
      if (s.hull === "destroyer") s.status.smoke = 12;
      if (s.hull === "cruiser") s.status.sonar = 25;
      if (s.hull === "battleship") s.status.heal = 20;
    }
    this.emit({
      type: "ability",
      x: s.x,
      z: s.z,
      owner: id,
      text: kind === "dcp" ? "피해 복구" : HULLS[s.hull].special,
    });
    return true;
  }
  private inSmoke(p: Vec2) {
    return this.smokes.some((s) => dist(s, p) < s.radius);
  }
  private lineClear(a: Vec2, b: Vec2) {
    return !ISLANDS.some((i) => islandBlocksLine(i, a, b));
  }
  visible(observer: Ship, target: Ship) {
    if (!target.alive || observer.id === target.id)
      return observer.id === target.id && target.alive;
    const d = dist(observer, target);
    if (d < RULES.forcedDetection) return true;
    if (observer.status.sonar > 0 && d < 430) return true;
    if (!this.lineClear(observer, target)) return false;
    const smoke = this.smokes.some(
      (s) => segmentDistance(observer, target, s) < s.radius,
    );
    const detect = smoke
      ? target.bloom > 0
        ? HULLS[target.hull].detect * 0.45
        : 0
      : (target.bloom > 0 ? gunRange(target) : HULLS[target.hull].detect) +
        (target.status.fire.some((f) => f > 0) ? 100 : 0);
    return d <= detect;
  }
  fire(id: string, salvo = false) {
    const s = this.players.get(id);
    if (this.phase !== "battle" || !s?.alive) return false;
    if (s.input.weapon === "TORP") return this.launchTorpedoes(s);
    if (s.input.weapon === "MINE") return this.ordnance.lay(s);
    if (s.input.weapon === "RBU") return this.ordnance.launch(s);
    const available = s.turrets
      .map((_, i) => i)
      .filter((i) => canTurretFire(s, i));
    if (!available.length) return false;
    const list = salvo ? available : available.slice(0, 1),
      c = HULLS[s.hull];
    for (const i of list) {
      const t = s.turrets[i];
      t.reload = gunReload(s);
      const origin = {
        x: s.x + Math.sin(s.heading) * t.offset,
        z: s.z + Math.cos(s.heading) * t.offset,
      };
      for (let n = 0; n < c.barrels + s.upgrades.salvo; n++)
        this.shell(
          s,
          origin,
          s.input.aim,
          s.input.weapon,
          c.shellDamage * (1 - 0.08 * s.upgrades.salvo) * damageBoost(s),
          mainCaliber(s),
          c.shellSpeed,
          gunRange(s),
          1 + s.upgrades.salvo * 0.15,
        );
    }
    s.bloom = 20;
    this.nextHeldFire.set(id, this.time + 0.25);
    s.status.protection = 0;
    this.emit({
      type: "shot",
      x: s.x,
      z: s.z,
      owner: id,
      text: s.input.weapon,
      caliber: mainCaliber(s),
      turrets: list,
      elevation: Math.atan2(
        RULES.gravity *
          0.5 *
          (aimSolution(s, s.input.aim).distance / c.shellSpeed) -
          8 / (aimSolution(s, s.input.aim).distance / c.shellSpeed),
        c.shellSpeed,
      ),
    });
    return true;
  }
  private shell(
    s: Ship,
    origin: Vec2,
    target: Vec2,
    kind: Ammo | "SECONDARY",
    damage: number,
    caliber: number,
    speed: number,
    range: number,
    spread = 1,
  ) {
    const solution = aimSolution(s, target, kind === "SECONDARY" ? "HE" : kind);
    const radius =
      kind === "SECONDARY"
        ? (2 + dist(s, target) * 0.012) * spread
        : dispersionRadius(s, solution.distance, kind);
    const impact = randomImpact(solution.center, radius, this.random);
    const a = bearing(origin, impact),
      d = Math.max(1, dist(origin, impact)),
      flight = d / speed;
    const vy = (RULES.gravity * 0.5 * flight * flight - 8) / flight;
    this.projectiles.push({
      id: ++this.serial,
      owner: s.id,
      kind,
      x: origin.x,
      z: origin.z,
      y: 8,
      vx: Math.sin(a) * speed,
      vz: Math.cos(a) * speed,
      vy,
      age: 0,
      life: flight + 1,
      damage,
      caliber,
      range: range + radius + HULLS[s.hull].length,
      distance: 0,
      start: { ...origin },
    });
    s.stats.shots++;
  }
  private launchTorpedoes(s: Ship) {
    const c = HULLS[s.hull];
    if (!c.torpedo || s.torpedoReload > 0) return false;
    const rel = Math.abs(angleDiff(bearing(s, s.input.aim), s.heading));
    if (rel < 0.6 || rel > 2.55) return false;
    s.torpedoReload = c.torpedoReload * (1 - 0.06 * s.upgrades.torpedo);
    s.status.protection = 0;
    const a = bearing(s, s.input.aim),
      speed = 45 * (1 + 0.08 * s.upgrades.torpedo);
    for (let i = -1; i <= 1; i++) {
      const heading = a + i * 0.045;
      this.projectiles.push({
        id: ++this.serial,
        owner: s.id,
        kind: "TORP",
        x: s.x + Math.sin(a) * (c.beam + 3),
        z: s.z + Math.cos(a) * (c.beam + 3),
        y: 0.4,
        vx: Math.sin(heading) * speed,
        vz: Math.cos(heading) * speed,
        vy: 0,
        age: 0,
        life: c.torpedoRange / speed,
        damage: c.torpedoDamage,
        caliber: 533,
        range: c.torpedoRange,
        distance: 0,
        start: { x: s.x, z: s.z },
      });
      s.stats.shots++;
    }
    this.emit({ type: "shot", x: s.x, z: s.z, owner: s.id, text: "TORP" });
    return true;
  }
  award(s: Ship, amount: number, damage = true) {
    if (this.phase !== "battle" || !Number.isFinite(amount) || amount <= 0)
      return;
    if (damage) s.stats.damage += amount;
    s.xp += amount;
    while (s.level < RULES.maxLevel && s.xp >= xpRequired(s.level)) {
      s.xp -= xpRequired(s.level);
      s.level++;
      s.points++;
      this.emit({
        type: "level",
        x: s.x,
        z: s.z,
        owner: s.id,
        text: `함선 레벨 ${s.level}`,
      });
    }
    if (s.level >= RULES.maxLevel) s.xp = 0;
  }
  damage(
    target: Ship,
    amount: number,
    ownerId: string,
    result: HitResult,
    dot = false,
    details?: Pick<GameEvent, "y" | "weapon" | "zone" | "armor" | "angle"> &
      Vec2,
  ) {
    if (!target.alive || target.status.protection > 0 || amount <= 0) return 0;
    amount *= damageTaken(target);
    const actual = Math.min(target.hp, amount);
    target.hp -= actual;
    target.status.healPool = Math.min(
      target.maxHp - target.hp,
      target.status.healPool +
        actual * (dot ? 1 : result === "citadel" ? 0.1 : 0.5),
    );
    const owner = this.players.get(ownerId);
    if (owner && owner.id !== target.id) {
      this.award(owner, actual);
      this.tally(owner.id, target, "damage", actual);
      let credit = this.damageCredit.get(target.id);
      if (!credit) {
        credit = new Map();
        this.damageCredit.set(target.id, credit);
      }
      credit.set(ownerId, (credit.get(ownerId) ?? 0) + actual);
    }
    if (!dot)
      this.emit({
        type: "hit",
        x: target.x,
        z: target.z,
        ...details,
        owner: ownerId,
        target: target.id,
        result,
        damage: Math.round(actual),
      });
    if (target.hp <= 0) {
      target.alive = false;
      target.stats.deaths++;
      target.respawnAt = this.time + respawnDelay(target.stats.deaths);
      target.input.firing = false;
      if (owner && owner.id !== target.id) {
        owner.stats.kills++;
        this.tally(owner.id, target, "kills", 1);
        if (this.mode === "domination")
          owner.stats.score += DOMINATION.killPoints;
        this.award(owner, 500, false);
      }
      for (const [id, contribution] of this.damageCredit.get(target.id) ?? [])
        if (id !== ownerId && contribution >= target.maxHp * 0.1) {
          const helper = this.players.get(id);
          if (helper) this.award(helper, 250, false);
        }
      this.emit({
        type: "sink",
        x: target.x,
        z: target.z,
        owner: ownerId,
        target: target.id,
        text: `${owner?.name ?? "해역"} → ${target.name}`,
      });
    }
    return actual;
  }
  private impact(p: Projectile, target: Ship, contact: ShipHit) {
    const point = contact.point;
    const totalSpeed = Math.hypot(p.vx, p.vy, p.vz) || 1;
    const dot = Math.abs(
      (p.vx * contact.normal.x +
        p.vy * contact.normal.y +
        p.vz * contact.normal.z) /
        totalSpeed,
    );
    const details = {
      ...point,
      y: contact.y,
      weapon: p.kind,
      zone: contact.zone,
      armor: contact.armor,
      angle: (Math.acos(clamp(dot, 0, 1)) * 180) / Math.PI,
    };
    if (target.status.protection > 0) {
      this.emit({
        type: "hit",
        ...details,
        owner: p.owner,
        target: target.id,
        result: "protected",
        damage: 0,
      });
      return;
    }
    const speed = Math.hypot(p.vx, p.vz, p.vy);
    const resolved = resolveArmor(
      target,
      p.kind,
      p.caliber,
      p.damage,
      point,
      { x: p.vx, z: p.vz },
      p.vy / speed,
      contact,
    );
    const owner = this.players.get(p.owner);
    if (owner) owner.stats.hits++;
    this.damage(
      target,
      resolved.damage,
      p.owner,
      resolved.result,
      false,
      details,
    );
    if (resolved.damage === 0)
      this.emit({
        type: "hit",
        ...details,
        owner: p.owner,
        target: target.id,
        result: resolved.result,
        damage: 0,
      });
    if (target.alive && target.status.immune <= 0) {
      let dot = this.dotOwners.get(target.id);
      if (!dot) {
        dot = { fire: ["", ""], flood: "" };
        this.dotOwners.set(target.id, dot);
      }
      // A shell that shattered or bounced never reached anything flammable.
      if ((p.kind === "HE" || p.kind === "SECONDARY") && resolved.damage > 0) {
        const slot = localPoint(point, target).z > 0 ? 0 : 1;
        if (
          target.status.fire[slot] <= 0 &&
          this.random() < (p.kind === "SECONDARY" ? 0.035 : 0.18)
        ) {
          target.status.fire[slot] = 20;
          dot.fire[slot] = p.owner;
        }
      }
      if (
        p.kind === "TORP" &&
        target.status.flood <= 0 &&
        this.random() < 0.7
      ) {
        target.status.flood = 22;
        dot.flood = p.owner;
      }
      if (resolved.damage > 0) {
        const broken = breakModule(
          target,
          {
            kind: p.kind,
            result: resolved.result,
            zone: contact.zone,
            along: localPoint(point, target).z,
          },
          this.random,
        );
        if (broken)
          this.emit({
            type: "module",
            x: target.x,
            z: target.z,
            owner: p.owner,
            target: target.id,
            module: broken,
          });
      }
    }
  }
  step(dt: number) {
    if (this.phase !== "battle") return;
    dt = Math.min(0.1, Math.max(0, dt));
    this.time += dt;
    this.remaining = Math.max(0, this.duration - this.time);
    this.events = this.events.filter((e) => this.time - e.at < 3);
    this.smokes = this.smokes.filter((s) => s.expires > this.time);
    this.ordnance.cooldowns(dt);
    for (const captain of this.captains.values()) captain.update(this, dt);
    for (const s of this.players.values()) {
      if (!s.alive) {
        if (this.time >= s.respawnAt && s.connected) this.spawn(s);
        continue;
      }
      const c = HULLS[s.hull],
        st = s.status;
      for (const k of [
        "immune",
        "dcp",
        "special",
        "sonar",
        "protection",
      ] as const)
        st[k] = Math.max(0, st[k] - dt);
      if (st.smoke > 0) {
        st.smoke -= dt;
        if (
          !this.smokes.some(
            (p) => dist(p, s) < 40 && p.expires - this.time > 20,
          )
        )
          this.smokes.push({
            id: ++this.serial,
            x: s.x,
            z: s.z,
            radius: 100,
            expires: this.time + 32,
          });
      }
      const dot = this.dotOwners.get(s.id);
      for (let i = 0; i < 2; i++)
        if (st.fire[i] > 0) {
          st.fire[i] = Math.max(0, st.fire[i] - dt);
          this.damage(
            s,
            s.maxHp * 0.0025 * dt,
            dot?.fire[i] ?? "",
            "penetration",
            true,
          );
        }
      if (st.flood > 0) {
        st.flood = Math.max(0, st.flood - dt);
        this.damage(s, s.maxHp * 0.004 * dt, dot?.flood ?? "", "torpedo", true);
      }
      if (!s.alive) continue;
      if (st.heal > 0) {
        st.heal = Math.max(0, st.heal - dt);
        const heal = Math.min(
          s.maxHp * 0.006 * dt,
          st.healPool,
          s.maxHp - s.hp,
        );
        s.hp += heal;
        st.healPool -= heal;
      }
      s.bloom = Math.max(0, s.bloom - dt);
      s.torpedoReload = Math.max(0, s.torpedoReload - dt);
      s.secondaryReload = Math.max(0, s.secondaryReload - dt);
      const engine = 1 + 0.06 * s.upgrades.engine,
        targetSpeed =
          throttleSpeed[s.input.throttle] *
          c.speed *
          (1 + 0.05 * s.upgrades.engine) *
          (st.flood > 0 ? 0.7 : 1) *
          (st.engineHit > 0 ? 0.5 : 1) *
          engineBoost(s);
      s.speed += clamp(
        targetSpeed - s.speed,
        -c.accel * engine * dt,
        c.accel * engine * dt,
      );
      tickModules(s, dt);
      tickBuffs(s, dt);
      // A jammed steering gear holds whatever rudder angle it had.
      if (st.rudderJam <= 0)
        s.turn += clamp(s.input.rudder - s.turn, -dt * 0.7, dt * 0.7);
      s.heading -=
        s.turn *
        c.turn *
        engine *
        engineBoost(s) *
        Math.min(
          1,
          Math.max(
            Math.abs(s.speed) / 7,
            // Tugs-style pivot so a grounded ship can always swing its bow clear,
            // even with engines stopped.
            s.grounded || nearShore(s) ? GROUNDED_PIVOT : 0,
          ),
        ) *
        dt *
        (s.speed < 0 ? -1 : 1);
      const next = {
        x: s.x + Math.sin(s.heading) * s.speed * dt,
        z: s.z + Math.cos(s.heading) * s.speed * dt,
      };
      moveAlongShore(s, next);
      for (const t of s.turrets) {
        t.reload = Math.max(0, t.reload - dt);
        if ((t.disabled ?? 0) > 0) continue;
        const wanted = bearing(s, s.input.aim),
          relative = angleDiff(wanted, s.heading);
        let constrained = relative;
        if (t.offset >= 0) constrained = clamp(relative, -2.45, 2.45);
        else if (Math.abs(relative) < 0.65)
          constrained = (relative < 0 ? -1 : 1) * 0.65;
        t.angle = approachAngle(
          t.angle,
          s.heading + constrained,
          c.turretSpeed * dt,
        );
      }
      if (s.input.target) {
        const target = this.players.get(s.input.target);
        if (!target || !this.visible(s, target)) s.input.target = null;
      }
      if (s.input.firing && this.time >= (this.nextHeldFire.get(s.id) ?? 0))
        this.fire(s.id);
      if (s.secondaries && c.secondaryRange > 0 && s.secondaryReload <= 0) {
        const candidates = [...this.players.values()].filter(
          (t) =>
            t.id !== s.id &&
            t.alive &&
            this.visible(s, t) &&
            this.lineClear(s, t) &&
            dist(s, t) < c.secondaryRange * (1 + 0.1 * s.upgrades.secondary),
        );
        candidates.sort((a, b) =>
          a.id === s.input.target
            ? -1
            : b.id === s.input.target
              ? 1
              : dist(s, a) - dist(s, b),
        );
        const target = candidates[0];
        if (target) {
          this.shell(
            s,
            s,
            target,
            "SECONDARY",
            700,
            127,
            135,
            c.secondaryRange * (1 + 0.1 * s.upgrades.secondary),
            2.5,
          );
          s.secondaryReload = 1.6 * (1 - 0.1 * s.upgrades.secondary);
          st.protection = 0;
          this.emit({
            type: "shot",
            x: s.x,
            z: s.z,
            owner: s.id,
            text: "SECONDARY",
          });
        }
      }
    }
    const all = [...this.players.values()].filter((s) => s.alive);
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i],
          b = all[j],
          r = (HULLS[a.hull].length + HULLS[b.hull].length) * 0.28,
          d = dist(a, b);
        if (d < r) {
          const direction = bearing(a, b),
            push = (r - d) / 2 + 0.01;
          a.x -= Math.sin(direction) * push;
          a.z -= Math.cos(direction) * push;
          b.x += Math.sin(direction) * push;
          b.z += Math.cos(direction) * push;
          a.speed *= 0.9;
          b.speed *= 0.9;
        }
      }
    this.projectiles = this.projectiles.filter((p) => {
      if (p.delay && p.delay > 0) {
        p.delay = Math.max(0, p.delay - dt);
        return true;
      }
      const before = { x: p.x, z: p.z },
        oldY = p.y;
      p.age += dt;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.distance += Math.hypot(p.vx, p.vz) * dt;
      if (p.kind !== "TORP") {
        p.y += p.vy * dt - 0.5 * RULES.gravity * dt * dt;
        p.vy -= RULES.gravity * dt;
      }
      if (p.age > p.life || p.distance > p.range + 20) return false;
      for (const island of ISLANDS) {
        const hitTerrain =
          segmentDistance(before, p, island) < island.radius &&
          [0, 0.5, 1].some(
            (t) =>
              terrainHeight(island, {
                x: before.x + (p.x - before.x) * t,
                z: before.z + (p.z - before.z) * t,
              }) > Math.max(0, oldY + (p.y - oldY) * t),
          );
        if (hitTerrain) {
          this.emit({
            type: "splash",
            x: p.x,
            z: p.z,
            owner: p.owner,
            text: "island",
            caliber: p.caliber,
          });
          return false;
        }
      }
      let closest: ({ s: Ship } & ShipHit) | null = null;
      const waterFraction =
        p.kind !== "TORP" && p.y < 0 ? clamp(oldY / (oldY - p.y), 0, 1) : 1;
      const endpoint = {
        x: before.x + (p.x - before.x) * waterFraction,
        z: before.z + (p.z - before.z) * waterFraction,
        y: oldY + (p.y - oldY) * waterFraction,
      };
      for (const target of this.players.values()) {
        if (
          target.id === p.owner ||
          !target.alive ||
          (p.kind === "TORP" && p.distance < 35)
        )
          continue;
        const hit = intersectShip({ ...before, y: oldY }, endpoint, target);
        if (hit && (!closest || hit.t < closest.t))
          closest = { s: target, ...hit };
      }
      if (closest) {
        if (p.kind === "RBU") this.ordnance.rocketImpact(p, closest.point);
        else this.impact(p, closest.s, closest);
        return false;
      }
      if (p.kind !== "TORP" && p.y <= 0) {
        const fraction = clamp(oldY / (oldY - p.y), 0, 1);
        const point = {
          x: before.x + (p.x - before.x) * fraction,
          z: before.z + (p.z - before.z) * fraction,
        };
        if (p.kind === "RBU") this.ordnance.rocketImpact(p, point);
        else
          this.emit({
            type: "splash",
            ...point,
            owner: p.owner,
            caliber: p.caliber,
          });
        return false;
      }
      return true;
    });
    this.ordnance.tick();
    this.supply.tick();
    if (this.mode === "domination") this.updateObjectives(dt);
    if (this.remaining <= 0) {
      this.phase = "results";
      for (const s of this.players.values()) s.input.firing = false;
    }
  }
  private updateObjectives(dt: number) {
    const ships = [...this.players.values()];
    for (const { zone, by } of updateZones(this.zones, ships, dt))
      this.emit({
        type: "capture",
        x: zone.x,
        z: zone.z,
        owner: by.id,
        text: zone.id,
      });
    if (ships.some((s) => s.stats.score >= DOMINATION.scoreLimit))
      this.remaining = 0;
  }
  /** NPC skill (1–5) of a bot ship; undefined for people. */
  botSkill(id: string): BotSkill | undefined {
    return this.captains.get(id)?.skill;
  }
  private tally(
    ownerId: string,
    target: Ship,
    field: "kills" | "damage",
    amount: number,
  ) {
    if (this.phase !== "battle") return;
    let entry = this.ledger.get(ownerId);
    if (!entry) {
      entry = emptyLedger();
      this.ledger.set(ownerId, entry);
    }
    const skill = this.botSkill(target.id);
    if (skill) entry.npc[field][skill - 1] += amount;
    else entry.player[field] += amount;
  }
  /** Final order: score (domination), then kills, then damage dealt. */
  ranking() {
    return [...this.players.values()].sort(
      (a, b) =>
        (this.mode === "domination" ? b.stats.score - a.stats.score : 0) ||
        b.stats.kills - a.stats.kills ||
        b.stats.damage - a.stats.damage,
    );
  }
  lobby(): Lobby {
    return {
      type: "lobby",
      room: this.code,
      host: this.host,
      phase: this.phase,
      players: [...this.players.values()].map((s) => ({
        id: s.id,
        bot: s.bot,
        npcModel: s.npcModel,
        skill: this.captains.get(s.id)?.skill,
        verified: this.accounts.has(s.id),
        name: s.name,
        hull: s.hull,
        ready: this.ready.has(s.id),
        connected: s.connected,
        kills: s.stats.kills,
        deaths: s.stats.deaths,
      })),
      duration: this.duration,
      mode: this.mode,
    };
  }
  snapshot(id: string): Snapshot {
    const self = this.players.get(id)!;
    let seen = this.lastSeen.get(id);
    if (!seen) {
      seen = new Map();
      this.lastSeen.set(id, seen);
    }
    const visible = [...this.players.values()].filter(
        (s) => s.id !== id && this.visible(self, s),
      ),
      ids = new Set(visible.map((s) => s.id));
    const contacts: Contact[] = visible.map((s) => {
      seen!.set(s.id, {
        id: s.id,
        hull: s.hull,
        x: s.x,
        z: s.z,
        at: this.time,
      });
      return {
        id: s.id,
        bot: s.bot,
        npcModel: s.npcModel,
        name: s.name,
        hull: s.hull,
        x: s.x,
        z: s.z,
        heading: s.heading,
        speed: s.speed,
        hp: s.hp,
        maxHp: s.maxHp,
        alive: s.alive,
        level: s.level,
        turrets: s.turrets.map((t) => ({ angle: t.angle, offset: t.offset })),
        fire: s.status.fire.filter((f) => f > 0).length,
        protection: s.status.protection,
        buffs: Object.keys(s.buffs) as BuffKind[],
      };
    });
    const projectiles = this.projectiles
      .filter(
        (p) =>
          p.owner === id ||
          (p.kind === "TORP"
            ? dist(p, self) < (self.status.sonar > 0 ? 430 : 180)
            : dist(p, self) < 1600 && this.lineClear(self, p)),
      )
      .map((p) => ({
        ...p,
        owner: ids.has(p.owner) || p.owner === id ? p.owner : "",
        start:
          ids.has(p.owner) || p.owner === id ? p.start : { x: p.x, z: p.z },
      }));
    const events = this.events
      .filter(
        (e) =>
          e.owner === id ||
          e.target === id ||
          ids.has(e.owner ?? "") ||
          ids.has(e.target ?? "") ||
          (dist(e, self) < 250 && this.lineClear(self, e)),
      )
      .map((e) => ({
        ...e,
        owner: e.owner === id || ids.has(e.owner ?? "") ? e.owner : undefined,
        target:
          e.owner === id ||
          e.target === id ||
          ids.has(e.target ?? "") ||
          (e.type === "sink" &&
            this.time - (seen.get(e.target ?? "")?.at ?? -100) < 3)
            ? e.target
            : undefined,
      }));
    return {
      type: "snapshot",
      room: this.code,
      host: this.host,
      phase: this.phase,
      time: this.time,
      remaining: this.remaining,
      self: structuredClone(self),
      contacts,
      lastSeen: [...seen.values()].filter((s) => !ids.has(s.id)),
      projectiles,
      mines: this.ordnance.visible(self),
      smokes: this.smokes.map((s) => ({ ...s })),
      events,
      detected: [...this.players.values()].some(
        (s) => s.id !== id && s.alive && this.visible(s, self),
      ),
      scores: [...this.players.values()]
        .map((s) => ({
          id: s.id,
          bot: s.bot,
          npcModel: s.npcModel,
          name: s.name,
          hull: s.hull,
          connected: s.connected,
          ready: false,
          kills: s.stats.kills,
          deaths: s.stats.deaths,
          score: Math.floor(s.stats.score),
          verified: this.accounts.has(s.id),
          ...(this.phase === "results"
            ? {
                damage: Math.round(s.stats.damage),
                level: s.level,
                accuracy: s.stats.shots ? s.stats.hits / s.stats.shots : 0,
              }
            : {}),
        }))
        .sort(
          (a, b) =>
            (this.mode === "domination" ? b.score - a.score : 0) ||
            b.kills - a.kills ||
            (b.damage ?? 0) - (a.damage ?? 0),
        ),
      mode: this.mode,
      zones: this.zones.map((z) => ({ ...z })),
      scoreLimit: DOMINATION.scoreLimit,
      pickups: this.supply.items.map((p) => ({ ...p })),
    };
  }
}
