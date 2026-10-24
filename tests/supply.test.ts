import { describe, it, expect } from "vitest";
import { Game, gunRange, gunReload } from "../server/game";
import { SUPPLY } from "../server/pickups";
import { BUFF_SECONDS } from "../shared/powerups";
import { ISLANDS, RULES } from "../shared/config";
import { dist } from "../shared/math";
import type { PickupKind } from "../shared/types";

function match(seed = 1) {
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const g = new Game("SUP", 480, random);
  g.add("a", "A");
  g.add("b", "B");
  g.ready.add("a");
  g.ready.add("b");
  g.start("a");
  const a = g.players.get("a")!,
    b = g.players.get("b")!;
  for (const s of [a, b]) {
    s.status.protection = 0;
    s.secondaries = false;
  }
  return { g, a, b };
}
const tick = (g: Game, seconds: number) => {
  for (let i = 0; i < seconds * RULES.tick; i++) g.step(1 / RULES.tick);
};
function drop(g: Game, kind: PickupKind, at: { x: number; z: number }) {
  g.supply.items.push({ id: 99, kind, ...at, expires: g.time + 60 });
}

describe("supply crates", () => {
  it("drop on a timer in open water and sink after their lifetime", () => {
    const { g } = match();
    tick(g, SUPPLY.interval[1] + 1);
    expect(g.supply.items.length).toBeGreaterThan(0);
    for (const c of g.supply.items)
      for (const i of ISLANDS)
        expect(dist(c, i)).toBeGreaterThan(i.radius * 1.3);
    const first = g.supply.items[0];
    Object.assign(g.players.get("a")!, { x: -1400, z: -1400 });
    Object.assign(g.players.get("b")!, { x: 1400, z: 1400 });
    tick(g, SUPPLY.lifetime + 1);
    expect(g.supply.items.some((c) => c.id === first.id)).toBe(false);
    expect(g.snapshot("a").pickups.length).toBeLessThanOrEqual(
      SUPPLY.maxFloating,
    );
  });
  it("sailing over a crate grants a timed boost that expires", () => {
    const { g, a } = match();
    const base = { range: gunRange(a), reload: gunReload(a) };
    drop(g, "range", a);
    drop(g, "reload", { x: a.x + 5, z: a.z });
    tick(g, 0.1);
    expect(g.events.some((e) => e.type === "pickup" && e.owner === "a")).toBe(
      true,
    );
    tick(g, 0.1);
    expect(gunRange(a)).toBeCloseTo(base.range * 1.2);
    expect(gunReload(a)).toBeCloseTo(base.reload * 0.6);
    tick(g, BUFF_SECONDS);
    expect(a.buffs).toEqual({});
    expect(gunRange(a)).toBeCloseTo(base.range);
  });
  it("armor and firepower change damage; repair heals and puts out fires", () => {
    const { g, a, b } = match();
    a.buffs.armor = 10;
    const before = a.hp;
    g.damage(a, 1000, "b", "penetration");
    expect(before - a.hp).toBeCloseTo(700);
    a.status.fire = [20, 0];
    a.hp = a.maxHp * 0.5;
    drop(g, "repair", a);
    tick(g, 0.1);
    expect(a.hp).toBeGreaterThan(a.maxHp * 0.69);
    expect(a.status.fire).toEqual([0, 0]);
    b.buffs.firepower = 10;
    Object.assign(b, { x: 0, z: -700 });
    b.input.aim = { x: 300, z: -700 };
    tick(g, 6);
    g.fire("b", true);
    const shell = g.projectiles.find((p) => p.owner === "b")!;
    expect(shell.damage).toBeCloseTo(2300 * 1.25);
  });
  it("boosts are lost when the ship sinks", () => {
    const { g, a } = match();
    a.buffs.engine = 15;
    g.damage(a, 1e6, "b", "penetration");
    tick(g, 6);
    expect(a.alive).toBe(true);
    expect(a.buffs).toEqual({});
  });
});
