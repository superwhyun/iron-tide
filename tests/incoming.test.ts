import { describe, it, expect } from "vitest";
import { predictIncoming, incomingSide } from "../client/incoming";
import { makeShip } from "../server/game";
import { RULES } from "../shared/config";
import type { Projectile } from "../shared/types";

// Same launch as the server: 8 m muzzle height, landing exactly at the aim point.
function shellAt(target: { x: number; z: number }, speed = 180): Projectile {
  const d = Math.hypot(target.x, target.z),
    flight = d / speed;
  return {
    id: 1,
    owner: "enemy",
    kind: "AP",
    x: 0,
    z: 0,
    y: 8,
    vx: (target.x / d) * speed,
    vz: (target.z / d) * speed,
    vy: (RULES.gravity * 0.5 * flight * flight - 8) / flight,
    age: 0,
    life: flight + 1,
    damage: 2300,
    caliber: 203,
    range: 1150,
    distance: 0,
    start: { x: 0, z: 0 },
  };
}

describe("incoming salvo warning", () => {
  it("flags a shell that will land on a ship holding still", () => {
    const ship = { ...makeShip("me", "Me"), x: 0, z: 700, speed: 0 };
    const [shell] = predictIncoming(ship, [shellAt(ship)], 0);
    expect(shell.threat).toBe(true);
    expect(shell.eta).toBeCloseTo(700 / 180, 1);
  });
  it("clears the threat once the ship moves out of the splash zone", () => {
    const ship = {
      ...makeShip("me", "Me"),
      x: 0,
      z: 700,
      heading: Math.PI / 2,
      speed: 22,
    };
    const [shell] = predictIncoming(ship, [shellAt({ x: 0, z: 700 })], 0);
    expect(shell.threat).toBe(false);
  });
  it("ignores our own shells, torpedoes and far-away splashes", () => {
    const ship = { ...makeShip("me", "Me"), x: 0, z: 700 };
    const own = { ...shellAt(ship), owner: "me" };
    const torpedo = { ...shellAt(ship), kind: "TORP" as const };
    const far = shellAt({ x: 600, z: 400 });
    expect(predictIncoming(ship, [own, torpedo, far], 0)).toEqual([]);
  });
  it("names the side the salvo comes from", () => {
    const ship = { ...makeShip("me", "Me"), heading: 0 };
    expect(incomingSide(ship, { x: 0, z: 500 })).toBe("선수");
    expect(incomingSide(ship, { x: 500, z: 0 })).toBe("좌현");
    expect(incomingSide(ship, { x: -500, z: 0 })).toBe("우현");
  });
});
