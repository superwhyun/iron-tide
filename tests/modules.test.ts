import { describe, it, expect } from "vitest";
import { Game, canTurretFire } from "../server/game";
import { breakModule } from "../server/modules";
import { RULES } from "../shared/config";

function duel() {
  const g = new Game("MOD", 480, () => 0);
  g.add("a", "A");
  g.add("b", "B");
  g.ready.add("a");
  g.ready.add("b");
  g.start("a");
  const a = g.players.get("a")!;
  Object.assign(a, { x: -250, z: -700, heading: 0 });
  a.status.protection = 0;
  return { g, a };
}
const tick = (g: Game, seconds: number) => {
  for (let i = 0; i < seconds * RULES.tick; i++) g.step(1 / RULES.tick);
};

describe("component damage", () => {
  it("a stern hit jams the rudder at its angle until damage control fixes it", () => {
    const { g, a } = duel();
    a.input = { ...a.input, throttle: 5, rudder: 1 };
    tick(g, 3);
    const held = a.turn;
    expect(
      breakModule(
        a,
        { kind: "AP", result: "penetration", along: -25 },
        () => 0,
      ),
    ).toBe("rudder");
    a.input = { ...a.input, rudder: -1 };
    tick(g, 2);
    expect(a.turn).toBeCloseTo(held, 5);
    expect(g.ability("a", "dcp")).toBe(true);
    tick(g, 1);
    expect(a.turn).toBeLessThan(held);
  });
  it("a citadel can cripple the engines to half speed", () => {
    const { g, a } = duel();
    a.input = { ...a.input, throttle: 5 };
    tick(g, 20);
    const full = a.speed;
    breakModule(a, { kind: "AP", result: "citadel", along: 0 }, () => 0);
    expect(a.status.engineHit).toBeGreaterThan(0);
    tick(g, 10);
    expect(a.speed).toBeLessThan(full * 0.55);
  });
  it("a turret hit silences the nearest turret", () => {
    const { g, a } = duel();
    a.input.aim = { x: 250, z: -700 };
    tick(g, 5);
    const aft = a.turrets.findIndex((t) => t.offset < 0);
    expect(canTurretFire(a, aft)).toBe(true);
    breakModule(
      a,
      {
        kind: "HE",
        result: "penetration",
        zone: "turret",
        along: a.turrets[aft].offset,
      },
      () => 0,
    );
    expect(canTurretFire(a, aft)).toBe(false);
    expect(a.turrets.filter((t) => (t.disabled ?? 0) > 0)).toHaveLength(1);
  });
  it("secondary guns never break components", () => {
    const { a } = duel();
    expect(
      breakModule(
        a,
        { kind: "SECONDARY", result: "secondary", zone: "turret", along: 0 },
        () => 0,
      ),
    ).toBeNull();
  });
});
