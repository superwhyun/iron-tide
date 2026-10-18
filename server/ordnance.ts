import { HULLS, ISLANDS, RULES } from "../shared/config";
import {
  ORDNANCE,
  aimSolution,
  minePosition,
  randomImpact,
} from "../shared/ballistics";
import { dist } from "../shared/math";
import { islandBlocksLine, terrainHeight } from "../shared/terrain";
import type { Mine, Projectile, Ship, Vec2 } from "../shared/types";
import type { Game } from "./game";

export class Ordnance {
  mines: Mine[] = [];
  private pending: { point: Vec2; owner: string; mine: boolean }[] = [];
  constructor(private game: Game) {}
  reset() {
    this.mines = [];
    this.pending = [];
  }
  cooldowns(dt: number) {
    for (const s of this.game.players.values()) {
      s.mineReload = Math.max(0, s.mineReload - dt);
      s.rocketReload = Math.max(0, s.rocketReload - dt);
    }
  }
  visible(self: Ship) {
    return this.mines
      .filter(
        (m) =>
          m.owner === self.id ||
          (dist(m, self) < (self.status.sonar > 0 ? 430 : 110) &&
            !ISLANDS.some((i) => islandBlocksLine(i, self, m))),
      )
      .map((m) => ({ ...m }));
  }
  lay(s: Ship) {
    if (s.minesLeft <= 0 || s.mineReload > 0) return false;
    const p = minePosition(s);
    if (
      Math.abs(p.x) > RULES.world - 30 ||
      Math.abs(p.z) > RULES.world - 30 ||
      ISLANDS.some((i) => terrainHeight(i, p) > 0)
    )
      return false;
    // A player can maintain three live mines; laying another replaces the oldest.
    const owned = this.mines.filter((m) => m.owner === s.id);
    if (owned.length >= 3)
      this.mines = this.mines.filter((m) => m.id !== owned[0].id);
    this.mines.push({
      id: this.game.nextId(),
      owner: s.id,
      ...p,
      armedAt: this.game.time + ORDNANCE.mine.arm,
      expires: this.game.time + ORDNANCE.mine.lifetime,
    });
    s.minesLeft--;
    s.mineReload = ORDNANCE.mine.cooldown;
    s.stats.shots++;
    s.status.protection = 0;
    this.game.emit({ type: "shot", owner: s.id, ...p, text: "MINE" });
    return true;
  }
  launch(s: Ship) {
    if (s.rocketsLeft <= 0 || s.rocketReload > 0) return false;
    const c = ORDNANCE.rbu,
      solution = aimSolution(s, s.input.aim, "RBU");
    const origin = {
      x: s.x + Math.sin(s.heading) * 8,
      z: s.z + Math.cos(s.heading) * 8,
    };
    for (let n = 0; n < c.rockets; n++) {
      const impact = randomImpact(
        solution.center,
        solution.radius,
        this.game.random,
      );
      const angle = Math.atan2(impact.x - origin.x, impact.z - origin.z),
        flight = Math.max(0.15, dist(origin, impact) / c.speed);
      this.game.projectiles.push({
        id: this.game.nextId(),
        owner: s.id,
        kind: "RBU",
        ...origin,
        y: 6,
        vx: Math.sin(angle) * c.speed,
        vz: Math.cos(angle) * c.speed,
        vy: RULES.gravity * 0.5 * flight - 6 / flight,
        age: 0,
        life: flight + 1,
        delay: n * 0.075,
        damage: c.damage,
        caliber: 213,
        range: c.range + solution.radius + HULLS[s.hull].length,
        distance: 0,
        start: { ...origin },
      });
    }
    s.rocketsLeft--;
    s.rocketReload = c.cooldown;
    s.stats.shots += c.rockets;
    s.status.protection = 0;
    this.game.emit({
      type: "shot",
      x: s.x,
      z: s.z,
      owner: s.id,
      text: "RBU",
      count: c.rockets,
      caliber: 213,
    });
    return true;
  }
  rocketImpact(p: Projectile, point: Vec2) {
    this.pending.push({
      point: { x: point.x, z: point.z },
      owner: p.owner,
      mine: false,
    });
  }
  private blast(
    point: Vec2,
    owner: string,
    mine: boolean,
    removed: Set<number>,
  ) {
    const cfg = mine ? ORDNANCE.mine : ORDNANCE.rbu;
    this.game.emit({
      type: "splash",
      ...point,
      owner,
      text: mine ? "MINE" : "RBU",
      caliber: mine ? 533 : 213,
    });
    let intercepted = 0;
    if (!mine) {
      for (const p of this.game.projectiles) {
        if (p.kind !== "TORP" || p.owner === owner || removed.has(p.id))
          continue;
        if (
          dist(point, p) <= cfg.blast &&
          !ISLANDS.some((i) => islandBlocksLine(i, point, p))
        ) {
          removed.add(p.id);
          intercepted++;
        }
      }
      this.mines = this.mines.filter(
        (m) => m.owner === owner || dist(point, m) > cfg.blast,
      );
    }
    if (intercepted)
      this.game.emit({
        type: "intercept",
        ...point,
        owner,
        count: intercepted,
        text: "어뢰 요격",
      });
    let hit = false;
    for (const target of this.game.players.values()) {
      if (!target.alive || target.id === owner || target.status.protection > 0)
        continue;
      const d = dist(target, point),
        reach = cfg.blast + HULLS[target.hull].beam * 0.5;
      if (d > reach || ISLANDS.some((i) => islandBlocksLine(i, point, target)))
        continue;
      const damage = cfg.damage * (mine ? 1 : Math.max(0.25, 1 - d / reach));
      if (
        this.game.damage(target, damage, owner, mine ? "mine" : "penetration") >
        0
      )
        hit = true;
    }
    if (hit) {
      const s = this.game.players.get(owner);
      if (s) s.stats.hits++;
    }
  }
  tick() {
    this.mines = this.mines.filter((m) => m.expires > this.game.time);
    const detonated = new Set<number>();
    for (const m of this.mines) {
      if (this.game.time < m.armedAt) continue;
      if (
        [...this.game.players.values()].some(
          (s) =>
            s.id !== m.owner &&
            s.alive &&
            dist(s, m) < HULLS[s.hull].beam * 0.5 + 7,
        )
      ) {
        detonated.add(m.id);
        this.pending.push({
          point: { x: m.x, z: m.z },
          owner: m.owner,
          mine: true,
        });
      }
    }
    this.mines = this.mines.filter((m) => !detonated.has(m.id));
    const removed = new Set<number>();
    for (const p of this.game.projectiles) {
      if (p.kind !== "RBU" || (p.delay && p.delay > 0) || p.y > 4) continue;
      if (
        this.game.projectiles.some(
          (t) => t.kind === "TORP" && t.owner !== p.owner && dist(t, p) < 12,
        )
      ) {
        removed.add(p.id);
        this.rocketImpact(p, p);
      }
    }
    for (const explosion of this.pending)
      this.blast(explosion.point, explosion.owner, explosion.mine, removed);
    this.pending = [];
    this.game.projectiles = this.game.projectiles.filter(
      (p) => !removed.has(p.id),
    );
  }
}
