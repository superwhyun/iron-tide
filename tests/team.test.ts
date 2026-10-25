import { describe, it, expect } from "vitest";
import { Game } from "../server/game";
import { planTeamFill } from "../server/teamFill";
import { RULES, TEAM_MATCH, ISLANDS } from "../shared/config";
import { dist } from "../shared/math";

const tick = (g: Game, seconds: number) => {
  for (let i = 0; i < seconds * RULES.tick; i++) g.step(1 / RULES.tick);
};
/** Four people: a, c on red; b, d on blue (joined alternately). */
function teamMatch() {
  const g = new Game("TEAM", 480, () => 0.5);
  for (const id of ["a", "b", "c", "d"]) g.add(id, id.toUpperCase());
  g.setMode("a", "team");
  for (const id of ["a", "b", "c", "d"]) g.ready.add(id);
  g.start("a");
  for (const s of g.players.values()) {
    s.status.protection = 0;
    s.secondaries = false;
  }
  const ship = (id: string) => g.players.get(id)!;
  return { g, ship };
}

describe("team match", () => {
  it("balances joins across both fleets and caps each at four", () => {
    const g = new Game("BAL", 480);
    for (let i = 0; i < RULES.maxPlayers; i++) g.add(`p${i}`, `P${i}`);
    expect(() => g.add("p8", "P8")).toThrow(`정원은 ${RULES.maxPlayers}척`);
    const sizes = [0, 0];
    for (const id of g.players.keys()) sizes[g.teamOf(id)!]++;
    expect(sizes).toEqual([TEAM_MATCH.size, TEAM_MATCH.size]);
    expect(() => g.setTeam("p0", "p0", 1)).toThrow("최대 4척");
  });
  it("lets captains switch themselves and the host place NPCs", () => {
    const g = new Game("SWAP", 480);
    g.add("host", "H");
    g.add("guest", "G");
    const bot = g.addBot("host", "cruiser");
    expect(() => g.setTeam("guest", "host", 1)).toThrow("자기 팀");
    g.setTeam("guest", "guest", 0);
    expect(g.teamOf("guest")).toBe(0);
    g.setTeam("host", bot, 1);
    expect(g.teamOf(bot)).toBe(1);
    expect(g.ready.has(bot)).toBe(true);
    expect(g.lobby().players.map((p) => p.team)).toEqual([0, 0, 1]);
  });
  it("needs a ship on each side before launch", () => {
    const g = new Game("ONE", 480);
    g.add("a", "A");
    g.add("b", "B");
    g.setTeam("b", "b", 0);
    g.setMode("a", "team");
    g.ready.add("a");
    g.ready.add("b");
    expect(() => g.start("a")).toThrow("홍군과 청군");
  });
  it("spawns each fleet on its own edge", () => {
    const { g, ship } = teamMatch();
    expect(g.teamOf("a")).toBe(0);
    expect(ship("a").x).toBeLessThan(-1000);
    expect(ship("c").x).toBeLessThan(-1000);
    expect(ship("b").x).toBeGreaterThan(1000);
    expect(ship("d").x).toBeGreaterThan(1000);
  });
  it("gives eight free-for-all ships separate open-water spawns", () => {
    const g = new Game("FFA", 480);
    for (let i = 0; i < 8; i++) g.add(`p${i}`, `P${i}`);
    for (const id of g.players.keys()) g.ready.add(id);
    g.start("p0");
    const ships = [...g.players.values()];
    for (const s of ships) {
      for (const i of ISLANDS)
        expect(dist(s, i)).toBeGreaterThan(i.radius + 150);
      for (const t of ships)
        if (t !== s) expect(dist(s, t)).toBeGreaterThan(300);
    }
  });
  it("turns friendly fire off: allies take no damage and do not trip mines", () => {
    const { g, ship } = teamMatch();
    const c = ship("c");
    expect(g.damage(c, 5000, "a", "penetration")).toBe(0);
    expect(c.hp).toBe(c.maxHp);
    const b = ship("b");
    expect(g.damage(b, 5000, "a", "penetration")).toBe(5000);
    // An allied mine under c stays put; it is visible to the ally.
    g.mines.push({
      id: 99,
      owner: "a",
      x: c.x,
      z: c.z,
      armedAt: 0,
      expires: 999,
    });
    tick(g, 0.1);
    expect(g.mines.some((m) => m.id === 99)).toBe(true);
    expect(g.snapshot("c").mines.some((m) => m.id === 99)).toBe(true);
  });
  it("shares sight across the fleet and always shows allies", () => {
    const { g, ship } = teamMatch();
    const [a, b, c] = [ship("a"), ship("b"), ship("c")];
    Object.assign(a, { x: -1300, z: -1300 });
    Object.assign(c, { x: 600, z: -1300 });
    Object.assign(b, { x: 700, z: -1300 });
    expect(g.visible(a, b)).toBe(false);
    const contacts = g.snapshot("a").contacts;
    expect(contacts.find((x) => x.id === "b")).toMatchObject({ team: 1 });
    expect(contacts.find((x) => x.id === "c")).toMatchObject({ team: 0 });
    // Being seen by your own fleet is not "detected".
    expect(g.snapshot("c").detected).toBe(true);
    Object.assign(b, { x: 1300, z: 1300 });
    expect(g.snapshot("c").detected).toBe(false);
  });
  it("ends at the team kill limit with the winning fleet ranked first", () => {
    const { g, ship } = teamMatch();
    ship("b").stats.kills = 1;
    ship("a").stats.kills = TEAM_MATCH.killLimit - 2;
    ship("c").stats.kills = 1;
    tick(g, 0.1);
    expect(g.phase).toBe("battle");
    ship("c").stats.kills = 2;
    tick(g, 0.1);
    expect(g.phase).toBe("results");
    expect(g.winner()).toBe(0);
    expect(
      g
        .ranking()
        .slice(0, 2)
        .map((s) => s.id),
    ).toEqual(["a", "c"]);
    const snap = g.snapshot("b");
    expect(snap).toMatchObject({
      team: 1,
      teamKills: [TEAM_MATCH.killLimit, 1],
      winner: 0,
    });
  });
  it("breaks a kill tie on damage, then calls a dead heat", () => {
    const { g, ship } = teamMatch();
    expect(g.winner()).toBeNull();
    ship("d").stats.damage = 100;
    expect(g.winner()).toBe(1);
  });
});

describe("ship contact", () => {
  const drive = (g: Game, id: string, rudder = 0, throttle = 4) =>
    g.setInput(id, {
      ...g.players.get(id)!.input,
      throttle,
      rudder,
    });
  it("gives every ship of a full 4-vs-4 its own spawn", () => {
    const g = new Game("SEATS", 480);
    for (let i = 0; i < 8; i++) g.add(`p${i}`, `P${i}`);
    g.setMode("p0", "team");
    for (const id of g.players.keys()) g.ready.add(id);
    g.start("p0");
    const ships = [...g.players.values()];
    for (const s of ships)
      for (const t of ships)
        if (s !== t) expect(dist(s, t)).toBeGreaterThan(400);
  });
  it("lets allies sail close abeam without losing way", () => {
    const { g, ship } = teamMatch();
    const [a, c] = [ship("a"), ship("c")];
    Object.assign(a, { x: 0, z: -700, heading: 0, speed: 16 });
    Object.assign(c, { x: 18, z: -700, heading: 0, speed: 16 });
    for (let i = 0; i < 3 * RULES.tick; i++) {
      drive(g, "a");
      drive(g, "c");
      g.step(1 / RULES.tick);
    }
    expect(a.speed).toBeGreaterThan(16);
    expect(c.speed).toBeGreaterThan(16);
  });
  it("frees a ship spawned on top of an ally instead of pinning it", () => {
    const { g, ship } = teamMatch();
    const [a, c] = [ship("a"), ship("c")];
    Object.assign(c, { x: a.x + 10, z: a.z, heading: a.heading });
    for (let i = 0; i < 20 * RULES.tick; i++) {
      drive(g, "a", 0.5);
      g.step(1 / RULES.tick);
    }
    expect(a.speed).toBeGreaterThan(15);
  });
  it("stops a ship ramming another hull but lets it back away", () => {
    const { g, ship } = teamMatch();
    const [a, b] = [ship("a"), ship("b")];
    Object.assign(a, { x: 0, z: -760, heading: 0, speed: 16 });
    Object.assign(b, { x: 0, z: -700, heading: Math.PI / 2, speed: 0 });
    for (let i = 0; i < 4 * RULES.tick; i++) {
      drive(g, "a");
      drive(g, "b", 0, 2);
      g.step(1 / RULES.tick);
    }
    // Never passes through the other hull.
    expect(a.z).toBeLessThan(b.z);
    expect(a.speed).toBeLessThan(4);
    for (let i = 0; i < 4 * RULES.tick; i++) {
      drive(g, "a", 0, 0);
      g.step(1 / RULES.tick);
    }
    expect(a.speed).toBeLessThan(-1);
  });
});

describe("filling both fleets with NPCs", () => {
  const sorted = (h: string[]) => [...h].sort();
  it("mirrors the fleets ship for ship with a mix of hull types", () => {
    // Red: a cruiser captain. Blue: empty. Battleship selected.
    const [red, blue] = planTeamFill(["cruiser"], [], [3, 4], "battleship");
    expect(sorted(["cruiser", ...red])).toEqual(sorted(blue));
    // One of each, with the chosen battleship taking the fourth seat.
    expect(sorted(blue)).toEqual(
      sorted(["battleship", "battleship", "cruiser", "destroyer"]),
    );
  });
  it("never fills an empty lobby with a single hull type", () => {
    const [red, blue] = planTeamFill([], [], [4, 4], "battleship");
    expect(sorted(red)).toEqual(sorted(blue));
    expect(new Set(red).size).toBe(3);
  });
  it("copies what the other side already has", () => {
    const [red, blue] = planTeamFill(
      ["battleship", "battleship", "destroyer"],
      ["cruiser"],
      [1, 3],
      "cruiser",
    );
    expect(sorted(["battleship", "battleship", "destroyer", ...red])).toEqual(
      sorted(["cruiser", ...blue]),
    );
  });
  it("gives the weaker side bigger ships when an identical fleet is impossible", () => {
    // Red has two battleships; blue already has three destroyers.
    const [red, blue] = planTeamFill(
      ["battleship", "battleship"],
      ["destroyer", "destroyer", "destroyer"],
      [2, 1],
      "cruiser",
    );
    expect(red).toEqual(["destroyer", "destroyer"]);
    expect(blue).toEqual(["battleship"]);
  });
  it("fills a team lobby to 4 vs 4 with matching NPC fleets", () => {
    const g = new Game("FILL", 480);
    g.add("host", "H");
    g.add("guest", "G");
    g.select("guest", "battleship");
    g.setMode("host", "team");
    expect(() => g.fillTeams("guest", "cruiser", "camouflage", 3)).toThrow(
      "함대장",
    );
    const added = g.fillTeams("host", "destroyer", "camouflage", 3);
    expect(added).toHaveLength(6);
    expect(g.players.size).toBe(8);
    const fleet = (t: 0 | 1) =>
      sorted(
        [...g.players.values()]
          .filter((s) => g.teamOf(s.id) === t)
          .map((s) => s.hull),
      );
    expect(fleet(0)).toEqual(fleet(1));
    expect(fleet(0)).toHaveLength(4);
    expect(
      g
        .lobby()
        .players.filter((p) => p.bot)
        .every((p) => p.ready),
    ).toBe(true);
    expect(g.lobby().players.find((p) => p.bot)?.skill).toBe(3);
    expect(() => g.fillTeams("host", "cruiser", "camouflage", 3)).toThrow(
      "빈자리",
    );
  });
});
