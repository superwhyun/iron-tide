import { test, expect } from "@playwright/test";
import {
  crew,
  fixture,
  state,
  control,
  aimAt,
  mousePositions,
} from "./helpers";
test("dispersion circle, accuracy upgrade, SAP, armed mine and selectable anti-torpedo rockets", async ({
  browser,
}) => {
  test.setTimeout(180000);
  const { a, b, room, contexts, errors, eventLog } = await crew(
    browser,
    "cruiser",
    "cruiser",
  );
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
          points: 1,
          status: { protection: 0 },
        },
        {
          id: B,
          x: 250,
          z: -700,
          heading: Math.PI / 2,
          speed: 0,
          status: { protection: 0 },
        },
      ],
    });
    await control(b);
    await b.keyboard.press("p");
    await b.keyboard.press("Escape");
    await control(a);
    await a.keyboard.press("p");
    await aimAt(a, 250, -700);
    await expect
      .poll(() =>
        a.evaluate(() => window.__IRON_TIDE__.view.graphics.aimArea.visible),
      )
      .toBe(true);
    const near = await a.evaluate(
      () => window.__IRON_TIDE__.view.graphics.aimArea.radius,
    );
    await a.screenshot({ path: "artifacts/browser-dispersion-circle.png" });
    await a.keyboard.press("Control");
    await a.locator("[data-upgrade=accuracy]").click();
    await expect
      .poll(async () => (await state(a)).self.upgrades.accuracy)
      .toBe(1);
    await a.locator("#upgrade-close").click();
    await control(a);
    await aimAt(a, 250, -700);
    await expect
      .poll(() =>
        a.evaluate(() => window.__IRON_TIDE__.view.graphics.aimArea.radius),
      )
      .toBeLessThan(near * 0.91);
    await aimAt(a, 800, -700);
    await expect
      .poll(() =>
        a.evaluate(() => window.__IRON_TIDE__.view.graphics.aimArea.radius),
      )
      .toBeGreaterThan(near * 1.4);
    await a.keyboard.press("4");
    await aimAt(a, 250, -700);
    await expect
      .poll(async () => (await state(a)).self.input.weapon)
      .toBe("SAP");
    await expect
      .poll(async () => (await state(a)).self.turrets[0].reload, {
        timeout: 12000,
      })
      .toBe(0);
    await a.mouse.dblclick(mousePositions.get(a)!.x, mousePositions.get(a)!.y);
    await expect
      .poll(async () => (await state(a)).self.stats.hits, { timeout: 12000 })
      .toBeGreaterThan(0);
    expect((await state(b)).self.status.fire).toEqual([0, 0]);
    await a.keyboard.press("5");
    await expect
      .poll(() =>
        a.evaluate(() => window.__IRON_TIDE__.view.graphics.aimArea.weapon),
      )
      .toBe("MINE");
    await a.mouse.click(mousePositions.get(a)!.x, mousePositions.get(a)!.y);
    await expect.poll(async () => (await state(a)).mines.length).toBe(1);
    expect((await state(a)).self.minesLeft).toBe(2);
    await a.screenshot({ path: "artifacts/browser-mine-laid.png" });
    await a.waitForTimeout(2200);
    const mine = (await state(a)).mines[0],
      hp = (await state(a)).self.hp;
    await fixture(room, {
      players: [
        {
          id: B,
          x: mine.x,
          z: mine.z,
          hp: 20000,
          speed: 0,
          status: { protection: 0 },
        },
      ],
    });
    await expect
      .poll(() =>
        [...eventLog.get(a)!.values()].some((e) => e.result === "mine"),
      )
      .toBe(true);
    await expect.poll(async () => (await state(b)).self.hp).toBeLessThan(15000);
    expect((await state(a)).self.hp).toBe(hp);
    await expect.poll(async () => (await state(a)).mines.length).toBe(0);
    await a.keyboard.press("Escape");
    await fixture(room, {
      players: [
        {
          id: A,
          x: -250,
          z: -700,
          heading: 0,
          speed: 0,
          hp: 27000,
          status: { protection: 0 },
        },
        {
          id: B,
          x: 100,
          z: -700,
          heading: 0,
          speed: 0,
          status: { protection: 0 },
        },
      ],
    });
    // Pre-aim the defended water sector before launch. Software rendering makes
    // three mouse correction passes slower than the final torpedo approach.
    await control(a);
    await a.keyboard.press("6");
    await aimAt(a, -145, -700);
    await a.keyboard.press("Escape");
    await control(b);
    await b.keyboard.press("3");
    await aimAt(b, -250, -700);
    await b.mouse.click(mousePositions.get(b)!.x, mousePositions.get(b)!.y);
    await expect
      .poll(async () => (await state(b)).self.torpedoReload)
      .toBeGreaterThan(0);
    await b.keyboard.press("Escape");
    await control(a);
    await a.keyboard.press("6");
    await expect
      .poll(
        async () =>
          (await state(a)).projectiles.some(
            (p) =>
              p.kind === "TORP" &&
              p.owner !== A &&
              Math.hypot(p.x + 250, p.z + 700) < 180,
          ),
        { timeout: 12000 },
      )
      .toBe(true);
    // Keep the prepared aim; moving back to the old pointer would rotate it.
    await a.mouse.down();
    await a.mouse.up();
    await expect
      .poll(
        () =>
          [...eventLog.get(a)!.values()].some(
            (e) =>
              e.type === "intercept" && e.owner === A && (e.count ?? 0) > 0,
          ),
        { timeout: 10000 },
      )
      .toBe(true);
    await a.screenshot({ path: "artifacts/browser-rbu-interception.png" });
    expect((await state(a)).self.rocketsLeft).toBe(5);
    expect((await state(a)).self.hp).toBe(27000);
    expect(errors).toEqual([]);
  } finally {
    for (const c of contexts) await c.close();
  }
});
