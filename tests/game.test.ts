import { describe, it, expect } from "vitest";
import { Vector3 } from "three";
import {
  Game,
  makeShip,
  resolveArmor,
  canTurretFire,
  gunRange,
} from "../server/game";
import { HULLS, ISLANDS, RULES, xpRequired } from "../shared/config";
import { bearing, intersectsHull } from "../shared/math";
import { shoreRadius } from "../shared/terrain";

function battle() {
  const g = new Game("TEST", 480, () => 0.5);
  g.add("a", "함장 A");
  g.add("b", "함장 B");
  g.ready.add("a");
  g.ready.add("b");
  g.start("a");
  const a = g.players.get("a")!,
    b = g.players.get("b")!;
  a.x = -250;
  a.z = -700;
  b.x = 250;
  b.z = -700;
  for (const s of [a, b]) {
    s.status.protection = 0;
    s.heading = 0;
    s.secondaries = false;
  }
  return { g, a, b };
}
function tick(g: Game, seconds: number) {
  for (let i = 0; i < seconds * RULES.tick; i++) g.step(1 / RULES.tick);
}

describe("room and match lifecycle", () => {
  it("requires two ready players and the host", () => {
    const g = new Game("X");
    g.add("a", "A");
    expect(() => g.start("a")).toThrow();
    g.add("b", "B");
    g.ready.add("a");
    expect(() => g.start("a")).toThrow();
    g.ready.add("b");
    expect(() => g.start("b")).toThrow();
    g.start("a");
    expect(g.phase).toBe("battle");
    expect(() => g.add("c", "C")).toThrow();
  });
  it("ends by time, ranks kills then damage and resets all progression on rematch", () => {
    const { g, a, b } = battle();
    a.stats.damage = 100;
    b.stats.damage = 200;
    a.level = 4;
    a.points = 3;
    g.duration = 0.1;
    tick(g, 0.2);
    expect(g.phase).toBe("results");
    expect(g.snapshot("a").scores[0].id).toBe("b");
    g.rematch("a");
    expect(g.phase).toBe("lobby");
    expect(g.players.get("a")!.level).toBe(1);
    expect(g.ready.size).toBe(0);
  });
});
describe("navigation and weapon authority", () => {
  it("does not drop a quick down/up click between simulation ticks", () => {
    const { g, a } = battle();
    a.input.weapon = "TORP";
    a.input.aim = { x: 250, z: -700 };
    g.setInput("a", { ...a.input, firing: true });
    g.setInput("a", { ...a.input, firing: false });
    expect(g.projectiles).toHaveLength(3);
    expect(a.torpedoReload).toBeGreaterThan(0);
  });
  it("keeps throttle set, accelerates slowly, turns with inertia and rejects non-finite inputs", () => {
    const { g, a } = battle();
    g.setInput("a", { ...a.input, throttle: 5, rudder: 1 });
    tick(g, 2);
    expect(a.speed).toBeGreaterThan(0);
    expect(a.speed).toBeLessThan(HULLS.cruiser.speed);
    expect(a.heading).toBeLessThan(0);
    const old = a.input;
    g.setInput("a", { ...old, aim: { x: NaN, z: 0 } });
    expect(a.input).toBe(old);
  });
  it("cannot pass through an island", () => {
    const { g, a } = battle();
    a.x = 0;
    a.z = -180;
    a.heading = 0;
    g.setInput("a", { ...a.input, throttle: 5 });
    tick(g, 15);
    // The hull may scrape sideways along the coast, but never inside it.
    const island = ISLANDS[0],
      angle = Math.atan2(a.x - island.x, a.z - island.z);
    expect(a.z).toBeLessThan(0);
    expect(Math.hypot(a.x - island.x, a.z - island.z)).toBeGreaterThan(
      shoreRadius(island, angle) + HULLS.cruiser.length * 0.35 - 1,
    );
  });
  it("each sinking waits longer to respawn, up to 20 seconds", () => {
    const { g, a, b } = battle();
    const waits: number[] = [];
    for (let n = 0; n < 5; n++) {
      b.status.protection = 0;
      g.damage(b, 1e6, "a", "penetration");
      waits.push(Math.round(b.respawnAt - g.time));
      while (!b.alive) tick(g, 1);
    }
    expect(waits).toEqual([5, 10, 15, 20, 20]);
    expect(a.stats.kills).toBe(5);
  });
  it("a grounded ship can pivot with engines stopped and scrape free with rudder", () => {
    const { g, a } = battle();
    Object.assign(a, { x: 0, z: -180, heading: 0 });
    g.setInput("a", { ...a.input, throttle: 5, rudder: 0 });
    tick(g, 15);
    expect(a.grounded).toBe(true);
    const pinned = a.heading;
    g.setInput("a", { ...a.input, throttle: 1, rudder: 1 });
    tick(g, 5);
    expect(Math.abs(a.heading - pinned)).toBeGreaterThan(0.3);
    g.setInput("a", { ...a.input, throttle: 5, rudder: 1 });
    tick(g, 20);
    expect(a.grounded).toBe(false);
  });
  it("turrets rotate and respect arcs, reload and salvo cannot duplicate shots", () => {
    const { g, a } = battle();
    a.input.aim = { x: 250, z: -700 };
    expect(canTurretFire(a, 0)).toBe(false);
    tick(g, 5);
    expect(canTurretFire(a, 0)).toBe(true);
    expect(g.fire("a", true)).toBe(true);
    const n = g.projectiles.length;
    expect(n).toBe(9);
    expect(g.fire("a", true)).toBe(false);
    expect(g.projectiles.length).toBe(n);
  });
  it("switching shells adds no wait: rammed rounds fire as loaded, the next load is the new shell", () => {
    const { g, a } = battle();
    a.turrets[1].reload = 3; // turret 2 is mid-load
    g.setInput("a", { ...a.input, weapon: "AP" });
    expect(a.turrets.map((t) => t.reload)).toEqual([
      0,
      3,
      ...a.turrets.slice(2).map(() => 0),
    ]);
    expect(a.turrets[0].ammo).toBe("HE");
    expect(a.turrets[1].ammo).toBe("AP");
    // Turret 1 still fires the HE round in its breech, then loads AP.
    a.input.aim = {
      x: a.x + Math.sin(a.heading) * 600,
      z: a.z + Math.cos(a.heading) * 600,
    };
    tick(g, 3);
    const before = g.projectiles.length;
    expect(g.fire("a")).toBe(true);
    const fired = g.projectiles.slice(before);
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.every((p) => p.kind === "HE")).toBe(true);
    expect(a.turrets.find((t) => t.reload > 0 && t.reload > 6)?.ammo).toBe(
      "AP",
    );
    // Torpedoes in between do not forget the selected shell.
    g.setInput("a", { ...a.input, weapon: "TORP" });
    g.setInput("a", { ...a.input, weapon: "AP" });
    expect(a.turrets.some((t) => t.reload > 6 && t.ammo === "AP")).toBe(true);
  });
  it("main battery shells actually traverse the sea and hit a target", () => {
    const { g, a, b } = battle();
    g.setInput("a", { ...a.input, weapon: "AP", aim: { x: b.x, z: b.z } });
    tick(g, 8);
    g.fire("a", true);
    tick(g, 4);
    expect(b.hp).toBeLessThan(b.maxHp);
    expect(a.stats.hits).toBeGreaterThan(0);
    expect(a.stats.damage).toBeGreaterThan(0);
  });
  it("torpedoes have side launch arcs, cooldown and a simulated collision", () => {
    const { g, a, b } = battle();
    a.input.weapon = "TORP";
    a.input.aim = { x: b.x, z: b.z };
    expect(g.fire("a")).toBe(true);
    expect(g.fire("a")).toBe(false);
    tick(g, 12);
    expect(b.hp).toBeLessThan(b.maxHp);
    expect(b.status.flood).toBeGreaterThan(0);
  });
  it("battleships cannot equip torpedoes or buy an unavailable upgrade", () => {
    const { g } = battle();
    g.players.set("a", makeShip("a", "A", "battleship"));
    const s = g.players.get("a")!;
    g.setInput("a", { ...s.input, weapon: "TORP" });
    expect(s.input.weapon).toBe("HE");
    s.points = 1;
    expect(g.upgrade("a", "torpedo")).toBe(false);
    expect(s.points).toBe(1);
  });
});
describe("armor, concealment and defensive choices", () => {
  it("only HE that actually damages the ship can start a fire", () => {
    const g = new Game("FIRE", 480, () => 0);
    g.add("a", "A");
    g.add("b", "B");
    g.select("b", "battleship");
    g.ready.add("a");
    g.ready.add("b");
    g.start("a");
    const b = g.players.get("b")!;
    b.status.protection = 0;
    const shell = {
      id: 1,
      owner: "a",
      kind: "HE" as const,
      x: b.x - 10,
      z: b.z,
      y: 4,
      vx: 120,
      vy: -5,
      vz: 0,
      age: 1,
      life: 5,
      damage: 2300,
      caliber: 203,
      range: 1150,
      distance: 300,
      start: { x: b.x - 300, z: b.z },
    };
    const contact = (zone: "side" | "superstructure", armor: number) => ({
      t: 0.5,
      point: { x: b.x - 7, z: b.z },
      y: 4,
      normal: new Vector3(-1, 0, 0),
      zone,
      armor,
    });
    const impact = (
      g as unknown as {
        impact: (
          p: typeof shell,
          t: typeof b,
          c: ReturnType<typeof contact>,
        ) => void;
      }
    ).impact.bind(g);
    impact(shell, b, contact("side", 260));
    expect(b.status.fire).toEqual([0, 0]);
    impact(shell, b, contact("superstructure", 19));
    expect(b.status.fire.some((f) => f > 0)).toBe(true);
  });
  it("distinguishes broadside citadel, angled ricochet, HE shatter and overpenetration", () => {
    const s = makeShip("b", "B", "cruiser");
    expect(
      resolveArmor(s, "AP", 380, 1000, { x: 5, z: 0 }, { x: 1, z: 0 }).result,
    ).toBe("citadel");
    expect(
      resolveArmor(s, "AP", 203, 1000, { x: 5, z: 0 }, { x: 0.1, z: 1 }).result,
    ).toBe("ricochet");
    expect(
      resolveArmor(s, "HE", 127, 1000, { x: 5, z: 0 }, { x: 1, z: 0 }).result,
    ).toBe("shatter");
    expect(
      resolveArmor(s, "AP", 380, 1000, { x: 0, z: 29 }, { x: 0, z: 1 }).result,
    ).toBe("overpen");
  });
  it("swept hull collision catches a projectile crossing the full ship in one frame", () => {
    const s = makeShip("x", "X");
    expect(
      intersectsHull({ x: -30, z: 0 }, { x: 30, z: 0 }, s, 59, 10)?.point.x,
    ).toBe(-5);
  });
  it("withholds hidden coordinates, health, level and projectile launch positions", () => {
    const { g, a, b } = battle();
    b.x = 800;
    b.z = -700;
    expect(g.visible(a, b)).toBe(false);
    g.fire("b");
    const snap = g.snapshot("a");
    expect(snap.contacts).toHaveLength(0);
    expect(snap.scores.find((s) => s.id === "b")!.damage).toBeUndefined();
    expect(snap.scores.find((s) => s.id === "b")!.level).toBeUndefined();
    for (const p of snap.projectiles.filter((p) => p.owner !== a.id))
      expect(p.start).toEqual({ x: p.x, z: p.z });
  });
  it("gun bloom reveals ships but does not see through islands; sonar can", () => {
    const { g, a, b } = battle();
    b.x = 800;
    b.z = -700;
    b.bloom = 20;
    expect(g.visible(a, b)).toBe(true);
    a.x = 0;
    a.z = -200;
    b.x = 0;
    b.z = 200;
    expect(g.visible(a, b)).toBe(false);
    a.status.sonar = 10;
    expect(g.visible(a, b)).toBe(true);
  });
  it("smoke hides both inward and outward sight, close detection still works", () => {
    const { g, a, b } = battle();
    g.smokes.push({ id: 1, x: a.x, z: a.z, radius: 100, expires: 30 });
    expect(g.visible(a, b)).toBe(false);
    expect(g.visible(b, a)).toBe(false);
    b.x = a.x + 70;
    expect(g.visible(a, b)).toBe(true);
  });
  it("records last seen separately and erases real-time hidden contacts", () => {
    const { g, a, b } = battle();
    expect(g.snapshot("a").contacts).toHaveLength(1);
    b.x = 1000;
    const s = g.snapshot("a");
    expect(s.contacts).toHaveLength(0);
    expect(s.lastSeen[0].x).toBe(250);
  });
  it("damage control clears DOT, provides immunity, and does not heal", () => {
    const { g, b } = battle();
    b.status.fire = [20, 20];
    b.status.flood = 20;
    b.hp -= 1000;
    const hp = b.hp;
    expect(g.ability("b", "dcp")).toBe(true);
    expect(b.status.fire).toEqual([0, 0]);
    expect(b.status.flood).toBe(0);
    expect(b.hp).toBe(hp);
    expect(b.status.immune).toBe(5);
    expect(g.ability("b", "dcp")).toBe(false);
  });
  it("repair party consumes a charge and restores only the recoverable pool", () => {
    const { g } = battle();
    const b = makeShip("b", "B", "battleship");
    g.players.set("b", b);
    b.x = 1000;
    b.z = 1000;
    b.hp -= 10000;
    b.status.healPool = 500;
    expect(g.ability("b", "special")).toBe(true);
    tick(g, 5);
    expect(b.hp).toBe(40500);
    expect(b.status.healPool).toBe(0);
    expect(b.status.charges).toBe(2);
  });
});
describe("progression and respawn invariants", () => {
  it("uses actual damage, one kill, no duplicate rewards and preserves upgrades after respawn", () => {
    const { g, a, b } = battle();
    a.upgrades.range = 2;
    b.hp = 10;
    g.damage(b, 100000, "a", "penetration");
    g.damage(b, 100000, "a", "penetration");
    expect(a.stats.damage).toBe(10);
    expect(a.stats.kills).toBe(1);
    expect(b.stats.deaths).toBe(1);
    b.level = 3;
    b.upgrades.engine = 1;
    tick(g, 5.1);
    expect(b.alive).toBe(true);
    expect(b.level).toBe(3);
    expect(b.upgrades.engine).toBe(1);
    expect(b.status.protection).toBeGreaterThan(0);
    expect(g.damage(b, 10, "a", "penetration")).toBe(0);
  });
  it("spends points atomically, caps three tiers and raises gun bloom range too", () => {
    const { g, a } = battle();
    g.award(a, xpRequired(1), false);
    expect(a.level).toBe(2);
    expect(a.points).toBe(1);
    expect(g.upgrade("a", "range")).toBe(true);
    expect(g.upgrade("a", "range")).toBe(false);
    a.points = 10;
    g.upgrade("a", "range");
    g.upgrade("a", "range");
    expect(g.upgrade("a", "range")).toBe(false);
    expect(gunRange(a)).toBe(HULLS.cruiser.range * 1.24);
  });
  it("caps level and awards points only for real level transitions", () => {
    const { g, a } = battle();
    g.award(a, 1e8, false);
    expect(a.level).toBe(10);
    expect(a.points).toBe(9);
    g.award(a, 1e8, false);
    expect(a.points).toBe(9);
    expect(a.xp).toBe(0);
  });
});
