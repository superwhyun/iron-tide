import { describe, it, expect } from "vitest";
import { Game, makeShip, resolveArmor } from "../server/game";
import {
  aimSolution,
  dispersionRadius,
  minePosition,
  ORDNANCE,
  randomImpact,
} from "../shared/ballistics";
import { dist } from "../shared/math";
function duel(random: () => number = () => 0.5) {
  const g = new Game("WEAPONS", 480, random);
  g.add("a", "A");
  g.add("b", "B");
  g.ready.add("a");
  g.ready.add("b");
  g.start("a");
  const a = g.players.get("a")!,
    b = g.players.get("b")!;
  Object.assign(a, { x: -250, z: -700, heading: 0 });
  Object.assign(b, { x: 100, z: -700, heading: 0 });
  for (const s of [a, b]) {
    s.status.protection = 0;
    s.secondaries = false;
  }
  return { g, a, b };
}
function tick(g: Game, seconds: number) {
  for (let n = 0; n < seconds * 30; n++) g.step(1 / 30);
}
function rng() {
  let seed = 8712;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
describe("aiming and real dispersion", () => {
  it("changes spread by gun, shell, distance and accuracy upgrades", () => {
    const cruiser = makeShip("a", "A"),
      destroyer = makeShip("d", "D", "destroyer"),
      battleship = makeShip("b", "B", "battleship");
    expect(dispersionRadius(cruiser, 1000)).toBeGreaterThan(
      dispersionRadius(cruiser, 400) * 1.5,
    );
    expect(dispersionRadius(battleship, 400)).toBeGreaterThan(
      dispersionRadius(destroyer, 400),
    );
    expect(dispersionRadius(cruiser, 400, "SAP")).toBeLessThan(
      dispersionRadius(cruiser, 400, "HE"),
    );
    const before = dispersionRadius(cruiser, 700);
    cruiser.upgrades.accuracy = 3;
    expect(dispersionRadius(cruiser, 700)).toBeCloseTo(before * 0.64, 6);
  });
  it("samples across the area of the circle, with no corner escapes or center-only bias", () => {
    const random = rng(),
      center = { x: 100, z: -20 };
    let square = 0;
    for (let n = 0; n < 6000; n++) {
      const p = randomImpact(center, 30, random),
        d = dist(center, p);
      expect(d).toBeLessThanOrEqual(30.00001);
      square += d * d;
    }
    expect(square / 6000).toBeGreaterThan(425);
    expect(square / 6000).toBeLessThan(475);
  });
  it("lands actual fired shells inside the same displayed circle", () => {
    const { g, a, b } = duel(rng());
    Object.assign(a, { x: -800, z: -700 });
    Object.assign(b, { x: 1200, z: 1200 });
    a.input.aim = { x: -300, z: -700 };
    a.upgrades.accuracy = 2;
    const solution = aimSolution(a, a.input.aim),
      splashes = new Map<number, { x: number; z: number }>();
    for (let salvo = 0; salvo < 8; salvo++) {
      a.turrets.forEach((t) => {
        t.angle = Math.PI / 2;
        t.reload = 0;
      });
      expect(g.fire(a.id, true)).toBe(true);
      for (let n = 0; n < 3.2 * 30; n++) {
        g.step(1 / 30);
        for (const e of g.events)
          if (e.type === "splash" && e.owner === a.id) {
            expect(e.text).not.toBe("island");
            splashes.set(e.id, e);
          }
      }
    }
    expect(splashes.size).toBe(72);
    for (const p of splashes.values())
      expect(dist(p, solution.center)).toBeLessThanOrEqual(
        solution.radius + 0.15,
      );
  });
  it("makes SAP useful on thin armor without fire or full AP-style citadel damage", () => {
    const dd = makeShip("d", "D", "destroyer"),
      bb = makeShip("b", "B", "battleship");
    const sap = resolveArmor(
      dd,
      "SAP",
      380,
      4000,
      { x: 0, z: 0 },
      { x: 1, z: 0 },
    );
    const ap = resolveArmor(
      dd,
      "AP",
      380,
      4000,
      { x: 0, z: 0 },
      { x: 1, z: 0 },
    );
    expect(sap.damage).toBeGreaterThan(ap.damage);
    expect(
      resolveArmor(bb, "SAP", 203, 2000, { x: 0, z: 0 }, { x: 1, z: 0 }).result,
    ).toBe("shatter");
  });
});
describe("mines and anti-torpedo rockets", () => {
  it("arms a mine, conceals it at distance, damages an enemy once and never its owner", () => {
    const { g, a, b } = duel();
    b.x = 500;
    g.setInput(a.id, { ...a.input, weapon: "MINE" });
    expect(g.fire(a.id)).toBe(true);
    expect(g.fire(a.id)).toBe(false);
    expect(a.minesLeft).toBe(2);
    const mine = g.mines[0];
    expect(mine).toMatchObject(minePosition(a));
    expect(g.snapshot(a.id).mines).toHaveLength(1);
    expect(g.snapshot(b.id).mines).toHaveLength(0);
    Object.assign(b, { x: mine.x, z: mine.z });
    tick(g, 1);
    expect(b.hp).toBe(b.maxHp);
    expect(g.mines).toHaveLength(1);
    tick(g, 1.2);
    expect(b.hp).toBe(b.maxHp - ORDNANCE.mine.damage);
    expect(a.hp).toBe(a.maxHp);
    expect(g.mines).toHaveLength(0);
    tick(g, 2);
    expect(b.hp).toBe(b.maxHp - ORDNANCE.mine.damage);
    expect(a.stats.hits).toBe(1);
  });
  it("cleans up expired mines, limits supply and resets hazards for a rematch", () => {
    const { g, a, b } = duel();
    b.x = 1000;
    g.setInput(a.id, { ...a.input, weapon: "MINE" });
    for (let n = 0; n < 3; n++) {
      expect(g.fire(a.id)).toBe(true);
      tick(g, 6.1);
    }
    expect(a.minesLeft).toBe(0);
    expect(g.fire(a.id)).toBe(false);
    expect(g.mines).toHaveLength(3);
    tick(g, 91);
    expect(g.mines).toHaveLength(0);
    g.phase = "results";
    g.rematch(a.id);
    expect(g.mines).toHaveLength(0);
    expect(g.players.get(a.id)?.minesLeft).toBe(3);
  });
  it("intercepts a real incoming spread with a limited, reloading six-rocket volley", () => {
    const { g, a, b } = duel();
    g.setInput(b.id, { ...b.input, weapon: "TORP", aim: { x: a.x, z: a.z } });
    expect(g.fire(b.id)).toBe(true);
    tick(g, 3.5);
    expect(g.projectiles.filter((p) => p.kind === "TORP")).toHaveLength(3);
    g.setInput(a.id, { ...a.input, weapon: "RBU", aim: { x: -120, z: -700 } });
    expect(g.fire(a.id)).toBe(true);
    expect(g.fire(a.id)).toBe(false);
    expect(g.projectiles.filter((p) => p.kind === "RBU")).toHaveLength(6);
    expect(a.rocketsLeft).toBe(5);
    tick(g, 1.6);
    expect(g.projectiles.filter((p) => p.kind === "TORP")).toHaveLength(0);
    expect(
      g.events
        .filter((e) => e.type === "intercept")
        .reduce((count, e) => count + (e.count ?? 0), 0),
    ).toBe(3);
    expect(g.events.find((e) => e.type === "intercept")).not.toHaveProperty(
      "start",
    );
    tick(g, 5);
    expect(a.hp).toBe(a.maxHp);
    expect(a.rocketReload).toBeGreaterThan(0);
  });
  it("does not reset loaded gun shells while switching to defensive equipment", () => {
    const { g, a } = duel();
    g.setInput(a.id, { ...a.input, weapon: "SAP" });
    tick(g, 2);
    const reload = a.turrets[0].reload;
    g.setInput(a.id, { ...a.input, weapon: "RBU" });
    g.setInput(a.id, { ...a.input, weapon: "SAP" });
    expect(a.turrets[0].reload).toBe(reload);
  });
});
