import { HULLS, ISLANDS } from "../shared/config";
import { dist } from "../shared/math";
import { BUFF_SECONDS, PICKUP_KINDS } from "../shared/powerups";
import type { Pickup, Ship } from "../shared/types";
import type { Game } from "./game";

export const SUPPLY = {
  maxFloating: 3,
  /** Seconds between drops (random within the range). */
  interval: [20, 30] as const,
  lifetime: 60,
  /** Keep crates clear of coasts and away from the map edge. */
  coastMargin: 70,
  edge: 1150,
  /** Pickup reach beyond half the ship's beam. */
  reach: 22,
  repair: 0.2,
};

/** Floating supply crates: timed drops in open water, first ship to reach one takes it. */
export class SupplyDrops {
  items: Pickup[] = [];
  private nextDrop = 0;
  private serial = 0;
  constructor(private game: Game) {}
  reset() {
    this.items = [];
    this.nextDrop = this.game.time + this.interval();
  }
  private interval() {
    const [min, max] = SUPPLY.interval;
    return min + this.game.random() * (max - min);
  }
  private spot() {
    for (let attempt = 0; attempt < 30; attempt++) {
      const p = {
        x: (this.game.random() * 2 - 1) * SUPPLY.edge,
        z: (this.game.random() * 2 - 1) * SUPPLY.edge,
      };
      const clearOfLand = ISLANDS.every(
        (i) => dist(i, p) > i.radius * 1.35 + SUPPLY.coastMargin,
      );
      if (clearOfLand && this.items.every((c) => dist(c, p) > 250)) return p;
    }
    return null;
  }
  tick() {
    const now = this.game.time;
    this.items = this.items.filter((c) => c.expires > now);
    if (now >= this.nextDrop) {
      this.nextDrop = now + this.interval();
      const spot = this.items.length < SUPPLY.maxFloating ? this.spot() : null;
      if (spot) {
        const kind =
          PICKUP_KINDS[Math.floor(this.game.random() * PICKUP_KINDS.length)];
        this.items.push({
          id: ++this.serial,
          kind,
          ...spot,
          expires: now + SUPPLY.lifetime,
        });
      }
    }
    for (const ship of this.game.players.values()) {
      if (!ship.alive) continue;
      const reach = HULLS[ship.hull].beam / 2 + SUPPLY.reach;
      const crate = this.items.find((c) => dist(c, ship) < reach);
      if (crate) this.collect(ship, crate);
    }
  }
  private collect(ship: Ship, crate: Pickup) {
    this.items = this.items.filter((c) => c !== crate);
    if (crate.kind === "repair") {
      ship.hp = Math.min(ship.maxHp, ship.hp + ship.maxHp * SUPPLY.repair);
      ship.status.fire = [0, 0];
      ship.status.flood = 0;
    } else ship.buffs[crate.kind] = BUFF_SECONDS;
    this.game.emit({
      type: "pickup",
      x: crate.x,
      z: crate.z,
      owner: ship.id,
      text: crate.kind,
    });
  }
}
export function tickBuffs(ship: Ship, dt: number) {
  for (const key of Object.keys(ship.buffs) as (keyof Ship["buffs"])[]) {
    const left = (ship.buffs[key] ?? 0) - dt;
    if (left > 0) ship.buffs[key] = left;
    else delete ship.buffs[key];
  }
}
