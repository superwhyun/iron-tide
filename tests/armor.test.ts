import { describe, it, expect } from "vitest";
import { armorPreview } from "../client/armorPreview";
import { makeShip, resolveArmor } from "../server/game";

const broadside = { x: 300, z: 0, heading: 0 };
const outcome = (zones: { name: string; outcome: string }[], name: string) =>
  zones.find((z) => z.name === name)?.outcome;

describe("aim armor preview", () => {
  it("cruiser shells bounce off a battleship belt but hurt its upper plating", () => {
    const shooter = { x: 0, z: 0, hull: "cruiser" as const };
    const ap = armorPreview(
      shooter,
      { ...broadside, hull: "battleship" },
      "AP",
    );
    expect(outcome(ap.zones, "주장갑대")).toBe("shatter");
    expect(outcome(ap.zones, "상부 측면")).toBe("penetration");
    expect(ap.hint).toContain("상부 측면에는 피해");
    const he = armorPreview(
      shooter,
      { ...broadside, hull: "battleship" },
      "HE",
    );
    expect(outcome(he.zones, "상부 측면")).toBe("penetration");
  });
  it("shows a broadside cruiser as an AP target and a bow-on one as a ricochet", () => {
    const shooter = { x: 0, z: 0, hull: "battleship" as const };
    expect(
      outcome(
        armorPreview(shooter, { ...broadside, hull: "cruiser" }, "AP").zones,
        "주장갑대",
      ),
    ).toBe("penetration");
    const angled = armorPreview(
      { x: 0, z: 0, hull: "cruiser" },
      { x: 300, z: 0, heading: -Math.PI / 2, hull: "cruiser" },
      "AP",
    );
    expect(outcome(angled.zones, "주장갑대")).toBe("ricochet");
    expect(angled.hint).toContain("각");
  });
  it("matches the server's ruling for a broadside belt hit", () => {
    for (const [hull, shooter] of [
      ["battleship", "cruiser"],
      ["cruiser", "battleship"],
    ] as const) {
      const target = { ...makeShip("t", "T", hull), x: 300, z: 0, heading: 0 };
      const preview = armorPreview({ x: 0, z: 0, hull: shooter }, target, "AP");
      const server = resolveArmor(
        target,
        "AP",
        shooter === "cruiser" ? 203 : 380,
        1000,
        { x: 300, z: 0 },
        { x: 1, z: 0 },
        0,
      );
      const side = outcome(preview.zones, "주장갑대");
      expect(server.result === "citadel" ? "penetration" : server.result).toBe(
        side,
      );
    }
  });
});
