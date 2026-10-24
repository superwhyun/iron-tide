import { HULLS, ISLANDS, RULES, UPGRADE_KEYS } from "../shared/config";
import {
  angleDiff,
  bearing,
  clamp,
  dist,
  intercept,
  segmentDistance,
} from "../shared/math";
import { gunRangeFor } from "../shared/ballistics";
import type { Ship, Vec2, Zone } from "../shared/types";
import type { Game } from "./game";

const CELL = 85,
  LIMIT = 1360,
  WIDTH = 33;
const point = (id: number): Vec2 => ({
  x: (id % WIDTH) * CELL - LIMIT,
  z: Math.floor(id / WIDTH) * CELL - LIMIT,
});
function clear(a: Vec2, b: Vec2, margin: number) {
  return (
    Math.abs(b.x) < RULES.world - 85 &&
    Math.abs(b.z) < RULES.world - 85 &&
    !ISLANDS.some((i) => segmentDistance(a, b, i) < i.radius + margin)
  );
}
function nearest(p: Vec2, margin: number) {
  let best = -1,
    distance = Infinity;
  for (let id = 0; id < WIDTH * WIDTH; id++) {
    const q = point(id),
      d = dist(p, q);
    if (d < distance && clear(q, q, margin)) {
      best = id;
      distance = d;
    }
  }
  return best;
}
// Small A* graph of the public map; no hidden player coordinates are used for patrols.
export function navigationPath(
  start: Vec2,
  goal: Vec2,
  margin: number,
): Vec2[] {
  if (clear(start, goal, margin)) return [goal];
  const first = nearest(start, margin),
    last = nearest(goal, margin);
  if (first < 0 || last < 0) return [];
  const open = new Set([first]),
    cost = new Map([[first, 0]]),
    from = new Map<number, number>();
  while (open.size) {
    let current = first,
      best = Infinity;
    for (const id of open) {
      const estimate = cost.get(id)! + dist(point(id), point(last));
      if (estimate < best) {
        best = estimate;
        current = id;
      }
    }
    if (current === last) {
      const path = [point(last)];
      while (from.has(current)) {
        current = from.get(current)!;
        path.unshift(point(current));
      }
      if (clear(point(last), goal, margin)) path.push(goal);
      return path;
    }
    open.delete(current);
    const x = current % WIDTH,
      z = Math.floor(current / WIDTH);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        if (
          (!dx && !dz) ||
          x + dx < 0 ||
          x + dx >= WIDTH ||
          z + dz < 0 ||
          z + dz >= WIDTH
        )
          continue;
        const next = (z + dz) * WIDTH + x + dx;
        if (!clear(point(current), point(next), margin)) continue;
        const value = cost.get(current)! + CELL * Math.hypot(dx, dz);
        if (value >= (cost.get(next) ?? Infinity)) continue;
        cost.set(next, value);
        from.set(next, current);
        open.add(next);
      }
  }
  return [];
}

export type BotSkill = 1 | 2 | 3 | 4 | 5;
export const BOT_SKILLS: BotSkill[] = [1, 2, 3, 4, 5];
interface SkillProfile {
  /** Seconds between decisions (reaction time). */
  think: number;
  /** Max fractional error when judging the target's speed for the lead. */
  lead: number;
  /** Max heading misread of the target, radians. */
  heading: number;
  /** Aim scatter radius as a fraction of range. */
  scatter: number;
  /** Share of gun range at which it opens fire. */
  range: number;
  torpedoes: boolean;
  dodge: boolean;
  repair: boolean;
  special: boolean;
  gadgets: boolean;
}
// Level 5 is the original captain: instant, perfect lead and full equipment use.
const SKILL: Record<BotSkill, SkillProfile> = {
  1: {
    think: 0.9,
    lead: 0.7,
    heading: 0.5,
    scatter: 0.05,
    range: 0.6,
    torpedoes: false,
    dodge: false,
    repair: false,
    special: false,
    gadgets: false,
  },
  2: {
    think: 0.7,
    lead: 0.5,
    heading: 0.35,
    scatter: 0.035,
    range: 0.7,
    torpedoes: true,
    dodge: false,
    repair: true,
    special: false,
    gadgets: false,
  },
  3: {
    think: 0.5,
    lead: 0.32,
    heading: 0.22,
    scatter: 0.022,
    range: 0.8,
    torpedoes: true,
    dodge: true,
    repair: true,
    special: true,
    gadgets: false,
  },
  4: {
    think: 0.35,
    lead: 0.15,
    heading: 0.1,
    scatter: 0.01,
    range: 0.9,
    torpedoes: true,
    dodge: true,
    repair: true,
    special: true,
    gadgets: true,
  },
  5: {
    think: 0.25,
    lead: 0,
    heading: 0,
    scatter: 0,
    range: 0.95,
    torpedoes: true,
    dodge: true,
    repair: true,
    special: true,
    gadgets: true,
  },
};
export const isBotSkill = (value: unknown): value is BotSkill =>
  BOT_SKILLS.includes(value as BotSkill);

const PATROL: Vec2[] = [
  { x: -600, z: -600 },
  { x: 600, z: -600 },
  { x: 600, z: 600 },
  { x: -600, z: 600 },
];
export class BotCaptain {
  private decision = 0;
  private routeAt = -10;
  private route: Vec2[] = [];
  private goal: Vec2 | null = null;
  private patrol = 0;
  private target = "";
  constructor(
    private id: string,
    private seed: number,
    readonly skill: BotSkill = 5,
  ) {
    this.reset();
  }
  private get profile() {
    return SKILL[this.skill];
  }
  /** Where the captain believes the target will be; imperfect below level 5. */
  private judgeLead(game: Game, ship: Ship, target: Ship, speed: number) {
    const p = this.profile;
    if (!p.lead && !p.heading && !p.scatter)
      return intercept(ship, target, target.heading, target.speed, speed);
    const spread = () => game.random() * 2 - 1;
    const aim = intercept(
      ship,
      target,
      target.heading + spread() * p.heading,
      target.speed * (1 + spread() * p.lead),
      speed,
    );
    const radius = dist(ship, target) * p.scatter * Math.sqrt(game.random()),
      angle = game.random() * Math.PI * 2;
    return {
      x: aim.x + Math.cos(angle) * radius,
      z: aim.z + Math.sin(angle) * radius,
    };
  }
  reset() {
    this.decision = 0;
    this.routeAt = -10;
    this.route = [];
    this.goal = null;
    this.target = "";
    this.patrol = this.seed % PATROL.length;
  }
  /** Nearest zone we do not hold; otherwise the nearest of ours under threat. */
  private pickZone(game: Game, ship: Ship): Zone | null {
    const byDistance = [...game.zones].sort(
      (a, b) => dist(ship, a) - dist(ship, b),
    );
    return (
      byDistance.find((z) => z.owner !== ship.id) ??
      byDistance.find(
        (z) => z.contested || (z.capturer && z.capturer !== ship.id),
      ) ??
      byDistance[0] ??
      null
    );
  }
  update(game: Game, dt: number) {
    this.decision -= dt;
    if (this.decision > 0) return;
    this.decision = this.profile.think;
    const ship = game.players.get(this.id);
    if (!ship?.alive) {
      this.route = [];
      this.routeAt = -10;
      return;
    }
    const cfg = HULLS[ship.hull];
    const contacts = [...game.players.values()].filter(
      (t) => t.id !== ship.id && t.alive && game.visible(ship, t),
    );
    contacts.sort((a, b) => dist(ship, a) - dist(ship, b));
    const target = contacts.find((t) => t.id === this.target) ?? contacts[0];
    this.target = target?.id ?? "";
    let goal: Vec2 = PATROL[this.patrol];
    if (dist(ship, goal) < 140) {
      this.patrol = (this.patrol + 1) % PATROL.length;
      goal = PATROL[this.patrol];
    }
    let desired: number | null = null;
    const zone = game.mode === "domination" ? this.pickZone(game, ship) : null;
    if (zone) {
      // Objectives first: sail to the zone and circle inside it; guns still fire.
      goal = zone;
      if (dist(ship, zone) < zone.radius * 0.7)
        desired =
          bearing(ship, zone) + (this.seed % 2 ? 1 : -1) * (Math.PI / 2 + 0.25);
    } else if (target) {
      const d = dist(ship, target),
        preferred =
          ship.hull === "destroyer" ? 360 : ship.hull === "cruiser" ? 460 : 620;
      goal = target;
      if (d < preferred * 1.2) {
        const direction = this.seed % 2 ? 1 : -1;
        desired =
          bearing(ship, target) +
          direction * (Math.PI / 2 + clamp((preferred - d) / 300, -0.5, 0.7));
      }
    }
    // Capable captains detour for a nearby supply crate.
    const crateReach = zone ? 200 : 350;
    const crate = this.profile.special
      ? game.supply.items
          .filter((c) => dist(ship, c) < crateReach)
          .sort((a, b) => dist(ship, a) - dist(ship, b))[0]
      : undefined;
    if (crate) {
      goal = crate;
      desired = null;
    }
    const margin = cfg.length * 0.35 + 32;
    if (desired === null) {
      if (
        !this.goal ||
        dist(this.goal, goal) > 100 ||
        game.time - this.routeAt > 2
      ) {
        this.route = navigationPath(ship, goal, margin);
        this.routeAt = game.time;
        this.goal = { x: goal.x, z: goal.z };
      }
      while (this.route.length > 1 && dist(ship, this.route[0]) < 120)
        this.route.shift();
      let waypoint = this.route[0];
      for (const p of this.route) {
        if (clear(ship, p, margin)) waypoint = p;
        else break;
      }
      desired = waypoint ? bearing(ship, waypoint) : ship.heading + Math.PI / 2;
    }
    const forward = {
      x: ship.x + Math.sin(desired) * 180,
      z: ship.z + Math.cos(desired) * 180,
    };
    if (!clear(ship, forward, margin)) {
      const candidates = [0, 0.55, -0.55, 1.1, -1.1, 1.7, -1.7, Math.PI].map(
        (a) => desired! + a,
      );
      desired =
        candidates.find((a) =>
          clear(
            ship,
            { x: ship.x + Math.sin(a) * 180, z: ship.z + Math.cos(a) * 180 },
            margin,
          ),
        ) ?? desired + Math.PI / 2;
    }
    let rudder = clamp(
      -angleDiff(desired, ship.heading) * 2.8 - ship.turn * 0.65,
      -1,
      1,
    );
    const skill = this.profile;
    const threat = !skill.dodge
      ? undefined
      : game.projectiles.find(
          (p) =>
            p.kind === "TORP" &&
            p.owner !== ship.id &&
            dist(ship, p) < 180 &&
            (ship.x - p.x) * p.vx + (ship.z - p.z) * p.vz > 0,
        );
    if (threat)
      rudder =
        Math.sin(angleDiff(bearing(ship, threat), ship.heading)) > 0 ? 1 : -1;
    const aim = target
      ? this.judgeLead(game, ship, target, cfg.shellSpeed)
      : goal;
    game.setInput(ship.id, {
      throttle:
        Math.abs(angleDiff(desired, ship.heading)) > 0.55 || threat ? 3 : 5,
      rudder,
      aim,
      target: target?.id ?? null,
      weapon: "HE",
      firing: false,
    });
    if (
      skill.gadgets &&
      threat &&
      ship.rocketReload <= 0 &&
      ship.rocketsLeft > 0
    ) {
      const saved = { ...ship.input },
        flight = dist(ship, threat) / 170;
      game.setInput(ship.id, {
        ...saved,
        weapon: "RBU",
        aim: {
          x: threat.x + threat.vx * flight,
          z: threat.z + threat.vz * flight,
        },
      });
      game.fire(ship.id);
      game.setInput(ship.id, saved);
    }
    if (
      skill.gadgets &&
      target &&
      dist(ship, target) < 180 &&
      ship.minesLeft > 0 &&
      ship.mineReload <= 0
    ) {
      const saved = { ...ship.input };
      game.setInput(ship.id, { ...saved, weapon: "MINE" });
      game.fire(ship.id);
      game.setInput(ship.id, saved);
    }
    if (target && dist(ship, target) < gunRangeFor(ship) * skill.range)
      game.fire(ship.id, true);
    if (
      skill.torpedoes &&
      target &&
      cfg.torpedo &&
      ship.torpedoReload <= 0 &&
      dist(ship, target) < cfg.torpedoRange * 0.82
    ) {
      const torpedoAim = this.judgeLead(
        game,
        ship,
        target,
        45 * (1 + 0.08 * ship.upgrades.torpedo),
      );
      const relative = Math.abs(
        angleDiff(bearing(ship, torpedoAim), ship.heading),
      );
      if (relative > 0.65 && relative < 2.5 && clear(ship, torpedoAim, 0)) {
        game.setInput(ship.id, {
          ...ship.input,
          weapon: "TORP",
          aim: torpedoAim,
        });
        game.fire(ship.id);
        game.setInput(ship.id, { ...ship.input, weapon: "HE", aim });
      }
    }
    if (
      skill.repair &&
      (ship.status.flood > 0 ||
        ship.status.rudderJam > 0 ||
        ship.status.engineHit > 0 ||
        ship.status.fire.filter((f) => f > 0).length > 1 ||
        (ship.hp < ship.maxHp * 0.4 && ship.status.fire.some((f) => f > 0)))
    )
      game.ability(ship.id, "dcp");
    if (
      skill.special &&
      ((ship.hull === "battleship" && ship.hp < ship.maxHp * 0.75) ||
        (ship.hull === "destroyer" && target && ship.hp < ship.maxHp * 0.5) ||
        (ship.hull === "cruiser" &&
          ((target && dist(ship, target) < 430) || threat)))
    )
      game.ability(ship.id, "special");
    if (ship.points) {
      const key = ["reload", "engine", "range", ...UPGRADE_KEYS].find(
        (k) =>
          ship.upgrades[k as keyof Ship["upgrades"]] < 3 &&
          (k !== "torpedo" || cfg.torpedo) &&
          (k !== "secondary" || cfg.secondaryRange),
      );
      if (key) game.upgrade(ship.id, key as keyof Ship["upgrades"]);
    }
  }
}
