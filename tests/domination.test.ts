import { describe, it, expect } from "vitest";
import { Game } from "../server/game";
import { DOMINATION } from "../server/objectives";
import { RULES } from "../shared/config";
import { dist } from "../shared/math";

function match(mode: "deathmatch" | "domination" = "domination") {
  const g = new Game("DOM", 480, () => 0.5);
  g.add("a", "A");
  g.add("b", "B");
  g.setMode("a", mode);
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
const zone = (g: Game, id: string) => g.zones.find((z) => z.id === id)!;
// Park a ship inside a zone (it may drift; reapplied each call).
const park = (
  s: { x: number; z: number; speed: number },
  at: { x: number; z: number },
) => Object.assign(s, { x: at.x, z: at.z, speed: 0 });

describe("domination", () => {
  it("only the host can switch modes, and only in the lobby", () => {
    const g = new Game("M", 480);
    g.add("host", "H");
    g.add("guest", "G");
    expect(() => g.setMode("guest", "domination")).toThrow("함대장");
    g.setMode("host", "domination");
    expect(g.lobby().mode).toBe("domination");
  });
  it("deathmatch has no zones", () => {
    const { g } = match("deathmatch");
    expect(g.zones).toEqual([]);
    expect(g.snapshot("a").zones).toEqual([]);
  });
  it("a lone ship captures a zone and then earns points for holding it", () => {
    const { g, a, b } = match();
    const A = zone(g, "A");
    Object.assign(b, { x: 1300, z: 1300 });
    park(a, A);
    tick(g, DOMINATION.captureTime + 0.5);
    expect(A.owner).toBe("a");
    expect(g.events.some((e) => e.type === "capture" && e.owner === "a")).toBe(
      true,
    );
    const afterCapture = a.stats.score;
    expect(afterCapture).toBeGreaterThanOrEqual(DOMINATION.capturePoints);
    park(a, { x: -1300, z: -1300 });
    tick(g, 10);
    expect(a.stats.score - afterCapture).toBeCloseTo(
      10 * DOMINATION.holdRate,
      0,
    );
  });
  it("a second ship in the zone freezes the capture", () => {
    const { g, a, b } = match();
    const C = zone(g, "C");
    park(a, C);
    tick(g, 3);
    const progress = C.progress;
    park(b, { x: C.x + 20, z: C.z });
    tick(g, 3);
    expect(C.contested).toBe(true);
    expect(C.progress).toBeCloseTo(progress, 1);
    expect(C.owner).toBeNull();
  });
  it("kills score points and reaching the limit ends the match", () => {
    const { g, a, b } = match();
    g.damage(b, 1e6, "a", "penetration");
    expect(a.stats.score).toBe(DOMINATION.killPoints);
    a.stats.score = DOMINATION.scoreLimit;
    tick(g, 0.1);
    expect(g.phase).toBe("results");
    expect(g.snapshot("b").scores[0].id).toBe("a");
  });
  it("NPC captains head for a zone they do not hold", () => {
    const g = new Game("NPCDOM", 480, () => 0.5);
    g.add("human", "H");
    g.setMode("human", "domination");
    const id = g.addBot("human", "cruiser");
    g.ready.add("human");
    g.start("human");
    const human = g.players.get("human")!,
      bot = g.players.get(id)!;
    Object.assign(human, { x: -1300, z: 1300 });
    const nearest = () => Math.min(...g.zones.map((z) => dist(bot, z)));
    const start = nearest();
    tick(g, 30);
    expect(nearest()).toBeLessThan(start - 300);
  });
});

describe("reward ledger", () => {
  it("splits kills and damage between people and NPCs by skill", () => {
    const g = new Game("LEDGER", 480, () => 0.5);
    g.add("a", "A");
    g.add("b", "B");
    const npc = g.addBot("a", "cruiser", "camouflage", 3);
    g.ready.add("a");
    g.ready.add("b");
    g.start("a");
    for (const s of g.players.values()) s.status.protection = 0;
    const b = g.players.get("b")!,
      bot = g.players.get(npc)!;
    g.damage(b, 1e6, "a", "penetration");
    g.damage(bot, 1000, "a", "penetration");
    const ledger = g.ledger.get("a")!;
    expect(ledger.player).toEqual({ kills: 1, damage: b.maxHp });
    expect(ledger.npc.damage).toEqual([0, 0, 1000, 0, 0]);
    expect(g.botSkill(npc)).toBe(3);
    // A new match starts a fresh tally.
    g.phase = "results";
    g.rematch("a");
    g.ready.add("a");
    g.ready.add("b");
    g.start("a");
    expect(g.ledger.size).toBe(0);
  });
});
