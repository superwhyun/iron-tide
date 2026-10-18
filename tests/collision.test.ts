import { describe, it, expect } from "vitest";
import { Vector3 } from "three";
import { Game, makeShip, resolveArmor } from "../server/game";
import { intersectShip, shipMeshInfo } from "../server/shipCollision";
import { HULLS, ISLANDS } from "../shared/config";
import { shoreRadius } from "../shared/terrain";
import { viewForAim } from "../shared/cameraAim";
import type { Hull, NpcModel } from "../shared/types";
function tick(g: Game, t: number) {
  for (let n = 0; n < t * 30; n++) g.step(1 / 30);
}
function duel(hull: Hull = "cruiser") {
  const g = new Game("COLLISION", 480, () => 0.5);
  g.add("a", "A");
  g.add("b", "B");
  g.select("a", hull);
  g.ready.add("a");
  g.ready.add("b");
  g.start("a");
  for (const s of g.players.values()) {
    s.secondaries = false;
    s.status.protection = 0;
  }
  return { g, a: g.players.get("a")!, b: g.players.get("b")! };
}
describe("coastal escape", () => {
  it.each<Hull>(["destroyer", "cruiser", "battleship"])(
    "%s keeps powered helm control at contact and backs clear",
    (hull) => {
      const { g, a } = duel(hull),
        coast = shoreRadius(ISLANDS[0], Math.PI) + HULLS[hull].length * 0.35;
      Object.assign(a, { x: 0, z: -coast, heading: 0, speed: 0 });
      g.setInput(a.id, { ...a.input, throttle: 5, rudder: 1 });
      tick(g, 4);
      expect(a.grounded).toBe(true);
      expect(a.heading).toBeLessThan(-0.1);
      const start = { x: a.x, z: a.z };
      g.setInput(a.id, { ...a.input, throttle: 0, rudder: 0 });
      tick(g, 8);
      expect(a.speed).toBeLessThan(-3);
      expect(a.grounded).toBe(false);
      expect(Math.hypot(a.x - start.x, a.z - start.z)).toBeGreaterThan(20);
    },
  );
  it("recovers a ship pushed into the irregular coastline without pinning reverse", () => {
    const { g, a } = duel(),
      angle = 1.1,
      r = shoreRadius(ISLANDS[0], angle) + HULLS.cruiser.length * 0.35 - 4;
    Object.assign(a, {
      x: Math.sin(angle) * r,
      z: Math.cos(angle) * r,
      heading: angle + Math.PI,
      speed: 0,
    });
    g.setInput(a.id, { ...a.input, throttle: 0 });
    tick(g, 6);
    const a2 = Math.atan2(a.x, a.z),
      gap =
        Math.hypot(a.x, a.z) -
        shoreRadius(ISLANDS[0], a2) -
        HULLS.cruiser.length * 0.35;
    expect(gap).toBeGreaterThan(8);
    expect(a.grounded).toBe(false);
  });
});
describe("model surface collision and armor", () => {
  it.each<NpcModel>(["camouflage", "wisconsin-golden"])(
    "%s hits the GLB skin but not empty air inside the old box",
    (variant) => {
      const s = makeShip("n", "NPC", "battleship");
      Object.assign(s, {
        bot: true,
        npcModel: variant,
        x: 0,
        z: 0,
        heading: 0,
      });
      const hit = intersectShip(
        { x: -100, z: 0, y: 1 },
        { x: 100, z: 0, y: 1 },
        s,
      )!;
      expect(hit).not.toBeNull();
      expect(hit.point.x).toBeGreaterThan(-6.5);
      expect(hit.point.x).toBeLessThan(-4);
      expect(hit.zone).toBe("side");
      expect(hit.armor).toBe(260);
      expect(
        intersectShip({ x: -100, z: 0, y: 14 }, { x: 100, z: 0, y: 14 }, s),
      ).toBeNull();
      expect(
        shipMeshInfo(s.hull, variant).max.z -
          shipMeshInfo(s.hull, variant).min.z,
      ).toBeCloseTo(HULLS.battleship.length, 5);
    },
  );
  it("transforms GLB collision with the ship heading and world position", () => {
    const s = makeShip("n", "NPC", "battleship");
    Object.assign(s, {
      bot: true,
      npcModel: "camouflage",
      x: 310,
      z: -600,
      heading: 0.8,
    });
    const point = (x: number) => ({
      x: s.x + Math.cos(s.heading) * x,
      z: s.z - Math.sin(s.heading) * x,
      y: 1,
    });
    const hit = intersectShip(point(-100), point(100), s)!;
    const expected = point(-5.522947928918285);
    expect(hit.point.x).toBeCloseTo(expected.x, 4);
    expect(hit.point.z).toBeCloseTo(expected.z, 4);
  });
  it("detects a descending shell on the bridge rather than using its 2D entry height", () => {
    const s = makeShip("n", "C");
    Object.assign(s, { x: 0, z: 0, heading: 0 });
    const hit = intersectShip({ x: 0, z: 0, y: 30 }, { x: 0, z: 0, y: 0 }, s)!;
    expect(hit).not.toBeNull();
    expect(hit.zone).toBe("superstructure");
    expect(hit.y).toBeGreaterThan(3);
    expect(hit.armor).toBe(16);
  });
  it("uses actual plate normals and allows large AP shells to overmatch thin plating", () => {
    const s = makeShip("n", "C"),
      surface = {
        normal: new Vector3(1, 0, 0),
        zone: "superstructure" as const,
        armor: 19,
      };
    expect(
      resolveArmor(
        s,
        "AP",
        380,
        4400,
        { x: 0, z: 0 },
        { x: 0.1, z: 1 },
        0,
        surface,
      ).result,
    ).toBe("overpen");
    expect(
      resolveArmor(s, "AP", 203, 2300, { x: 0, z: 0 }, { x: 0.1, z: 1 }, 0, {
        ...surface,
        armor: 100,
      }).result,
    ).toBe("ricochet");
    expect(
      resolveArmor(s, "HE", 127, 1200, { x: 0, z: 0 }, { x: 1, z: 0 }, 0, {
        ...surface,
        armor: 260,
      }).result,
    ).toBe("shatter");
  });
  it("keeps the defeated ship identity in the attacker snapshot for hit confirmation and wreck rendering", () => {
    const { g, a, b } = duel();
    Object.assign(a, { x: -100, z: -700 });
    Object.assign(b, { x: 0, z: -700, hp: 500 });
    g.snapshot(a.id);
    g.damage(b, 1000, a.id, "citadel");
    const snap = g.snapshot(a.id);
    expect(snap.contacts.find((c) => c.id === b.id)).toBeUndefined();
    expect(snap.events.find((e) => e.type === "sink")?.target).toBe(b.id);
    expect(snap.events.find((e) => e.type === "hit")?.target).toBe(b.id);
  });
  it("reports a visible hit with a reason when respawn protection prevents damage", () => {
    const { g, a, b } = duel();
    Object.assign(a, { x: -100, z: -700, heading: 0 });
    Object.assign(b, { x: 0, z: -700, heading: 0 });
    b.status.protection = 2;
    g.projectiles.push({
      id: 999,
      owner: a.id,
      kind: "AP",
      x: -15,
      z: -700,
      y: 1,
      vx: 300,
      vz: 0,
      vy: 0,
      age: 0,
      life: 2,
      damage: 2000,
      caliber: 203,
      range: 1000,
      distance: 100,
      start: { x: -100, z: -700 },
    });
    tick(g, 0.1);
    const e = g.events.find((e) => e.type === "hit" && e.target === b.id)!;
    expect(e.result).toBe("protected");
    expect(e.damage).toBe(0);
    expect(e.y).toBeDefined();
    expect(e.x).not.toBe(b.x);
    expect(b.hp).toBe(b.maxHp);
  });
});
describe("stable binocular aim", () => {
  it.each([80, 500, 1400, 2100])(
    "keeps the same water point at %sm through both camera modes and wheel zoom",
    (range) => {
      const origin = { x: -300, z: 250 },
        aim = { x: origin.x + range * 0.6, z: origin.z + range * 0.8 };
      for (const binocular of [true, false, true, false])
        for (const distance of [90, 220, 650]) {
          const view = viewForAim(origin, aim, binocular, distance),
            offset = binocular ? 25 : distance * 0.7,
            height = binocular ? 18 : distance * 0.38 + 10;
          const actual = height / Math.tan(view.pitch) - offset;
          expect(origin.x + Math.sin(view.yaw) * actual).toBeCloseTo(aim.x, 6);
          expect(origin.z + Math.cos(view.yaw) * actual).toBeCloseTo(aim.z, 6);
        }
    },
  );
});
