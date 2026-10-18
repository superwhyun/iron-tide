import { test, expect } from "@playwright/test";
import {
  state,
  fixture,
  crew,
  control,
  aimAt,
  mousePositions,
} from "./helpers";

test("two browser sessions: lobby, hulls, camera, throttle, rudder, reconnect", async ({
  browser,
}) => {
  const { a, b, room, contexts, errors } = await crew(browser);
  try {
    expect((await state(a)).self.hull).toBe("cruiser");
    expect((await state(b)).self.hull).toBe("destroyer");
    await control(a);
    await a.keyboard.press("w");
    await a.keyboard.press("w");
    await expect
      .poll(async () => (await state(a)).self.speed)
      .toBeGreaterThan(1);
    const initialHeading = (await state(a)).self.heading;
    await a.keyboard.down("d");
    await a.waitForTimeout(800);
    await a.keyboard.up("d");
    expect((await state(a)).self.turn).toBeGreaterThan(0);
    expect((await state(a)).self.heading).toBeLessThan(initialHeading);
    // Opposite input must overcome the existing rudder inertia and turn left.
    await a.keyboard.down("a");
    await expect
      .poll(async () => (await state(a)).self.turn)
      .toBeLessThan(-0.8);
    const rightHeading = (await state(a)).self.heading;
    await a.waitForTimeout(700);
    await a.keyboard.up("a");
    expect((await state(a)).self.heading).toBeGreaterThan(rightHeading);
    await a.keyboard.press("q");
    await expect.poll(async () => (await state(a)).self.input.rudder).toBe(-1);
    await a.keyboard.press("e");
    await expect.poll(async () => (await state(a)).self.input.rudder).toBe(0);
    const order = (await state(a)).self.input.throttle;
    await a.evaluate(() => {
      document.querySelector("#ocean")!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ㅈ",
          code: "KeyW",
          bubbles: true,
        }),
      );
      document.querySelector("#ocean")!.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "ㅈ",
          code: "KeyW",
          bubbles: true,
        }),
      );
    });
    await expect
      .poll(async () => (await state(a)).self.input.throttle)
      .toBe(order + 1);
    const before = await a.evaluate(() => window.__IRON_TIDE__.view);
    await a.mouse.move(800, 450);
    await expect
      .poll(
        async () =>
          (await a.evaluate(() => window.__IRON_TIDE__.view)).yaw - before.yaw,
      )
      .toBeLessThan(-0.05);
    const rightYaw = await a.evaluate(() => window.__IRON_TIDE__.view.yaw);
    await a.mouse.move(640, 450);
    await expect
      .poll(
        async () =>
          (await a.evaluate(() => window.__IRON_TIDE__.view)).yaw - rightYaw,
      )
      .toBeGreaterThan(0.05);
    await a.mouse.wheel(0, 220);
    await expect
      .poll(() => a.evaluate(() => window.__IRON_TIDE__.view.distance))
      .toBeGreaterThan(before.distance);
    await a.keyboard.press("Shift");
    await expect
      .poll(() => a.evaluate(() => window.__IRON_TIDE__.view.binocular))
      .toBe(true);
    const old = await a.evaluate(() => window.__IRON_TIDE__.view);
    await a.mouse.down({ button: "right" });
    await a.mouse.move(950, 500);
    await a.mouse.up({ button: "right" });
    expect((await a.evaluate(() => window.__IRON_TIDE__.view)).yaw).toBeCloseTo(
      old.yaw,
      2,
    );
    await a.keyboard.press("Escape");
    await a.screenshot({ path: "artifacts/browser-navigation.png" });
    const identity = (await state(b)).self.id;
    await b.reload();
    await expect(b.locator("#battle")).toBeVisible();
    await expect.poll(async () => (await state(b))?.self.id).toBe(identity);
    expect((await state(b)).room).toBe(room);
    expect(errors).toEqual([]);
  } finally {
    for (const c of contexts) await c.close();
  }
});

test("real browser weapons: gun hit, XP upgrade, torpedo kill, respawn, abilities and results", async ({
  browser,
}) => {
  const { a, b, room, contexts, errors } = await crew(browser);
  try {
    const A = (await state(a)).self.id,
      B = (await state(b)).self.id;
    await fixture(room, {
      players: [
        {
          id: A,
          x: -250,
          z: -700,
          heading: 0,
          speed: 0,
          status: { protection: 0 },
        },
        {
          id: B,
          x: 250,
          z: -700,
          heading: 0,
          speed: 0,
          status: { protection: 0 },
        },
      ],
    });
    await control(a);
    await a.keyboard.press("2");
    await aimAt(a, 250, -700);
    await expect
      .poll(async () =>
        Math.hypot(
          (await a.evaluate(() => window.__IRON_TIDE__.view.aim)).x - 250,
          (await a.evaluate(() => window.__IRON_TIDE__.view.aim)).z + 700,
        ),
      )
      .toBeLessThan(12);
    await expect
      .poll(async () => (await state(a)).self.turrets[0].reload, {
        timeout: 12000,
      })
      .toBe(0);
    await a.mouse.dblclick(mousePositions.get(a)!.x, mousePositions.get(a)!.y);
    await expect
      .poll(async () => (await state(a)).self.stats.hits, { timeout: 12000 })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await state(a)).self.points)
      .toBeGreaterThan(0);
    expect((await state(b)).self.hp).toBeLessThan(14000);
    await a.keyboard.press("Control");
    await expect(a.locator("#upgrade-panel")).toBeVisible();
    await a.locator("[data-upgrade=range]").click();
    await expect.poll(async () => (await state(a)).self.upgrades.range).toBe(1);
    await a.locator("#upgrade-close").click();
    await a.screenshot({ path: "artifacts/browser-gun-hit.png" });
    // Keep the duel reproducible: position ships in a clear lane; weapons still use live inputs and flight/collision.
    await fixture(room, {
      players: [
        {
          id: B,
          x: 250,
          z: -700,
          heading: 0,
          hp: 1000,
          speed: 0,
          status: { protection: 0 },
        },
        { id: A, x: -250, z: -700, heading: 0, speed: 0 },
      ],
    });
    await control(a);
    await a.keyboard.press("3");
    await aimAt(a, 250, -700);
    await a.screenshot({ path: "artifacts/browser-torpedo.png" });
    await a.mouse.click(mousePositions.get(a)!.x, mousePositions.get(a)!.y);
    await expect
      .poll(async () => (await state(a)).self.torpedoReload)
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await state(a)).self.stats.kills, { timeout: 18000 })
      .toBe(1);
    await expect
      .poll(async () => (await state(b)).self.alive, { timeout: 10000 })
      .toBe(true);
    expect((await state(b)).self.stats.deaths).toBe(1);
    expect((await state(a)).self.upgrades.range).toBe(1);
    await a.keyboard.press("Escape");
    await control(b);
    await b.keyboard.press("t");
    await expect
      .poll(async () => (await state(b)).self.status.smoke)
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await state(b)).smokes.length)
      .toBeGreaterThan(0);
    await fixture(room, {
      players: [{ id: B, status: { fire: [15, 0], flood: 15, dcp: 0 } }],
    });
    await b.keyboard.press("r");
    await expect
      .poll(async () => (await state(b)).self.status.dcp)
      .toBeGreaterThan(0);
    expect((await state(b)).self.status.flood).toBe(0);
    expect((await state(b)).self.status.fire).toEqual([0, 0]);
    await b.keyboard.press("Escape");
    await control(a);
    await a.keyboard.press("t");
    await expect
      .poll(async () => (await state(a)).self.status.sonar)
      .toBeGreaterThan(0);
    await fixture(room, { advance: 480 });
    await expect(a.locator("#results")).toBeVisible();
    await expect(b.locator("#results")).toBeVisible();
    await a.screenshot({ path: "artifacts/browser-results.png" });
    expect((await state(a)).phase).toBe("results");
    await expect(a.locator("#result-scores")).toContainText("청람 함장");
    expect(errors).toEqual([]);
    await a.locator("#rematch").click();
    await expect(a.locator("#harbor")).toBeVisible();
    await expect(b.locator("#harbor")).toBeVisible();
    await b.locator("[data-hull=battleship]").click();
    await a.locator("#ready").click();
    await b.locator("#ready").click();
    await a.locator("#start").click();
    await expect(b.locator("#battle")).toBeVisible();
    await expect.poll(async () => (await state(a)).self.level).toBe(1);
    expect((await state(a)).self.upgrades.range).toBe(0);
    await fixture(room, {
      players: [
        { id: B, hp: 40000, status: { healPool: 5000, protection: 0 } },
      ],
    });
    await control(b);
    await b.keyboard.press("t");
    await expect
      .poll(async () => (await state(b)).self.hp)
      .toBeGreaterThan(40000);
    expect((await state(b)).self.status.charges).toBe(2);
    await b.keyboard.press("Escape");
    await b.screenshot({ path: "artifacts/browser-repair.png" });
  } finally {
    for (const c of contexts) await c.close();
  }
});
