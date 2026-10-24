import { describe, it, expect } from "vitest";
import { Game } from "../server/game";
import { navigationPath } from "../server/bots";
import { ISLANDS } from "../shared/config";
import { dist, intercept, segmentDistance } from "../shared/math";
import { HULLS } from "../shared/config";
function solo(hull: "cruiser" | "destroyer" | "battleship" = "cruiser") {
  const g = new Game("NPC", 480, () => 0.5);
  g.add("human", "함장");
  const id = g.addBot("human", hull);
  g.ready.add("human");
  g.start("human");
  return { g, human: g.players.get("human")!, bot: g.players.get(id)! };
}
const step = (g: Game, seconds: number) => {
  for (let i = 0; i < seconds * 30; i++) g.step(1 / 30);
};
describe("NPC captains", () => {
  it("keeps Wisconsin Golden separate and fires nine 406 mm shells from three turrets", () => {
    const g = new Game("GOLDEN", 480, () => 0.5);
    g.add("human", "H");
    expect(() => g.addBot("human", "destroyer", "wisconsin-golden")).toThrow(
      "전함",
    );
    const id = g.addBot("human", "battleship", "wisconsin-golden");
    expect(g.lobby().players.find((p) => p.id === id)?.npcModel).toBe(
      "wisconsin-golden",
    );
    g.ready.add("human");
    g.start("human");
    const ship = g.players.get(id)!;
    ship.input.aim = { x: ship.x + 400, z: ship.z };
    ship.heading = 0;
    ship.turrets.forEach((t) => {
      t.angle = Math.PI / 2;
      t.reload = 0;
    });
    expect(g.fire(id, true)).toBe(true);
    const shells = g.projectiles.filter((p) => p.owner === id);
    expect(shells).toHaveLength(9);
    expect(shells.every((p) => p.caliber === 406)).toBe(true);
    g.remaining = 0;
    g.phase = "results";
    g.rematch("human");
    expect(g.players.get(id)?.npcModel).toBe("wisconsin-golden");
  });
  it("requires host control, shares the four slots, and preserves NPC readiness across rematches", () => {
    const g = new Game("LOBBY", 1);
    g.add("host", "H");
    g.add("guest", "G");
    expect(() => g.addBot("guest", "cruiser")).toThrow("함대장");
    const bot = g.addBot("host", "battleship");
    g.addBot("host", "destroyer");
    expect(g.lobby().players.find((p) => p.id === bot)).toMatchObject({
      bot: true,
      ready: true,
      hull: "battleship",
    });
    expect(() => g.addBot("host", "cruiser")).toThrow("정원");
    expect(() => g.removeBot("host", "guest")).toThrow("NPC");
    expect(() => g.removeBot("guest", bot)).toThrow("함대장");
    g.ready.add("host");
    g.ready.add("guest");
    g.start("host");
    expect(() => g.removeBot("host", bot)).toThrow("출항 전");
    step(g, 1.1);
    g.rematch("host");
    expect(g.players.get(bot)?.bot).toBe(true);
    expect(g.ready.has(bot)).toBe(true);
    expect(g.ready.has("host")).toBe(false);
    g.removeBot("host", bot);
    expect(g.players.size).toBe(3);
    g.remove("host");
    expect(g.host).toBe("guest");
  });
  it("routes around the central island with hull clearance", () => {
    const start = { x: -300, z: 0 },
      end = { x: 300, z: 0 },
      margin = 50;
    const path = navigationPath(start, end, margin);
    expect(path.length).toBeGreaterThan(2);
    let previous = start;
    for (const point of path) {
      for (const island of ISLANDS)
        expect(segmentDistance(previous, point, island)).toBeGreaterThanOrEqual(
          island.radius + margin,
        );
      previous = point;
    }
    expect(dist(previous, end)).toBeLessThan(1);
  });
  it("sails and damages a visible opponent using live guns and torpedoes", () => {
    const { g, human, bot } = solo("destroyer");
    Object.assign(human, { x: -650, z: -700, heading: 0 });
    Object.assign(bot, { x: -250, z: -700, heading: -Math.PI / 2 });
    human.status.protection = bot.status.protection = 0;
    const initial = { x: bot.x, z: bot.z };
    let torpedo = false;
    for (let i = 0; i < 60 * 30; i++) {
      g.step(1 / 30);
      torpedo ||= g.projectiles.some(
        (p) => p.owner === bot.id && p.kind === "TORP",
      );
    }
    expect(dist(bot, initial)).toBeGreaterThan(100);
    expect(bot.stats.shots).toBeGreaterThan(0);
    expect(bot.stats.damage).toBeGreaterThan(0);
    expect(torpedo).toBe(true);
  });
  it("does not steer toward unseen players' coordinates", () => {
    const one = solo(),
      two = solo();
    for (const { human, bot } of [one, two]) {
      Object.assign(bot, { x: 1000, z: 900 });
      Object.assign(human, { x: -1000, z: -900 });
    }
    two.human.x = -1100;
    step(one.g, 5);
    step(two.g, 5);
    expect(one.bot.input.target).toBeNull();
    expect(one.bot.stats.shots).toBe(0);
    expect(one.bot.input).toEqual(two.bot.input);
    expect(one.bot.x).toBeCloseTo(two.bot.x, 6);
  });
  it("validates intelligence 1-5, reports it in the lobby and defaults to 5", () => {
    const g = new Game("SKILL", 480, () => 0.5);
    g.add("host", "H");
    const sharp = g.addBot("host", "cruiser");
    const novice = g.addBot("host", "cruiser", "camouflage", 1);
    expect(() => g.addBot("host", "cruiser", "camouflage", 6 as never)).toThrow(
      "1–5",
    );
    const skill = (id: string) =>
      g.lobby().players.find((p) => p.id === id)?.skill;
    expect(skill(sharp)).toBe(5);
    expect(skill(novice)).toBe(1);
  });
  it("level 5 leads perfectly while lower levels misjudge the lead", () => {
    let seed = 7;
    const random = () =>
      ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const misses: number[] = [];
    for (const level of [5, 1] as const) {
      const g = new Game("AIM", 480, random);
      g.add("human", "H");
      const id = g.addBot("human", "cruiser", "camouflage", level);
      g.ready.add("human");
      g.start("human");
      const human = g.players.get("human")!,
        bot = g.players.get(id)!;
      Object.assign(human, { x: -200, z: -700, heading: 0, speed: 15 });
      Object.assign(bot, { x: 200, z: -700, heading: 0 });
      human.input.throttle = 4;
      g.step(1 / 30);
      const exact = intercept(
        bot,
        human,
        human.heading,
        human.speed,
        HULLS.cruiser.shellSpeed,
      );
      misses.push(dist(bot.input.aim, exact));
    }
    expect(misses[0]).toBeLessThan(1);
    expect(misses[1]).toBeGreaterThan(5);
  });
  it("uses repair and upgrades and remains an NPC after sinking and respawning", () => {
    const { g, human, bot } = solo("battleship");
    bot.status.protection = 0;
    g.damage(bot, bot.maxHp * 0.4, human.id, "penetration");
    bot.status.flood = 10;
    bot.points = 1;
    step(g, 0.5);
    expect(bot.status.flood).toBe(0);
    expect(bot.status.heal).toBeGreaterThan(0);
    expect(bot.upgrades.reload).toBe(1);
    g.damage(bot, 1e6, human.id, "penetration");
    step(g, 5.5);
    expect(bot.alive).toBe(true);
    expect(bot.bot).toBe(true);
    expect(bot.input.throttle).toBeGreaterThan(1);
  });
});
