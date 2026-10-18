import { HULLS, ISLANDS, RULES, UPGRADE_KEYS } from "../shared/config";
import {
  angleDiff,
  bearing,
  clamp,
  dist,
  intercept,
  segmentDistance,
} from "../shared/math";
import type { Ship, Vec2 } from "../shared/types";
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
  ) {
    this.reset();
  }
  reset() {
    this.decision = 0;
    this.routeAt = -10;
    this.route = [];
    this.goal = null;
    this.target = "";
    this.patrol = this.seed % PATROL.length;
  }
  update(game: Game, dt: number) {
    this.decision -= dt;
    if (this.decision > 0) return;
    this.decision = 0.25;
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
    if (target) {
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
    const threat = game.projectiles.find(
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
      ? intercept(ship, target, target.heading, target.speed, cfg.shellSpeed)
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
    if (threat && ship.rocketReload <= 0 && ship.rocketsLeft > 0) {
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
    if (
      target &&
      dist(ship, target) < cfg.range * (1 + ship.upgrades.range * 0.08) * 0.95
    )
      game.fire(ship.id, true);
    if (
      target &&
      cfg.torpedo &&
      ship.torpedoReload <= 0 &&
      dist(ship, target) < cfg.torpedoRange * 0.82
    ) {
      const torpedoAim = intercept(
        ship,
        target,
        target.heading,
        target.speed,
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
      ship.status.flood > 0 ||
      ship.status.fire.filter((f) => f > 0).length > 1 ||
      (ship.hp < ship.maxHp * 0.4 && ship.status.fire.some((f) => f > 0))
    )
      game.ability(ship.id, "dcp");
    if (
      (ship.hull === "battleship" && ship.hp < ship.maxHp * 0.75) ||
      (ship.hull === "destroyer" && target && ship.hp < ship.maxHp * 0.5) ||
      (ship.hull === "cruiser" &&
        ((target && dist(ship, target) < 430) || threat))
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
