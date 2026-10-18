import { test, expect } from "@playwright/test";
import {
  crew,
  state,
  fixture,
  control,
  aimAt,
  mousePositions,
} from "./helpers";

test("browser armor and spotting: ricochet vs broadside damage, islands and sonar", async ({
  browser,
}) => {
  test.setTimeout(180000);
  const { a, b, room, contexts, errors, eventLog } = await crew(
    browser,
    "cruiser",
    "battleship",
  );
  try {
    const A = (await state(a)).self.id,
      B = (await state(b)).self.id;
    await fixture(room, {
      players: [
        { id: A, x: -60, z: -700, heading: 1.055, status: { protection: 0 } },
        { id: B, x: 60, z: -700, heading: 0, status: { protection: 0 } },
      ],
    });
    // Isolate armor at close range with equal full salvos; automatic secondaries
    // and a single long-range shot would confound the dispersion comparison.
    await control(a);
    await a.keyboard.press("p");
    await a.keyboard.press("Escape");
    await control(b);
    await b.keyboard.press("p");
    await b.keyboard.press("2");
    await aimAt(b, -60, -700);
    await expect
      .poll(async () => (await state(b)).self.turrets[0].reload, {
        timeout: 16000,
      })
      .toBe(0);
    let cursor = mousePositions.get(b)!;
    await b.mouse.dblclick(cursor.x, cursor.y);
    await expect
      .poll(
        () =>
          [...eventLog.get(b)!.values()].some((e) => e.result === "ricochet"),
        { timeout: 10000 },
      )
      .toBe(true);
    const angledDamage = (await state(b)).self.stats.damage;
    // Some shells can still penetrate the thin bow despite angled side armor.
    expect(angledDamage).toBeLessThan(20000);
    await fixture(room, {
      players: [{ id: A, heading: 0, hp: 27000 }],
      advance: 13,
    });
    await b.mouse.dblclick(cursor.x, cursor.y);
    await expect
      .poll(async () => (await state(b)).self.stats.damage, { timeout: 10000 })
      .toBeGreaterThan(angledDamage * 2 + 1000);
    await expect
      .poll(
        async () =>
          (await state(b)).projectiles.filter((p) => p.owner === B).length,
      )
      .toBe(0);
    // A full close-range broadside can sink the cruiser. Finish respawning
    // before placing the two living ships for the independent sonar check.
    await expect.poll(async () => (await state(a)).self.alive).toBe(true);
    await b.keyboard.press("Escape");
    await b.screenshot({ path: "artifacts/browser-armor.png" });
    await fixture(room, {
      players: [
        { id: A, x: 0, z: -200, heading: 0, bloom: 0, status: { sonar: 0 } },
        { id: B, x: 0, z: 200, heading: 0, bloom: 0 },
      ],
    });
    await expect.poll(async () => (await state(a)).contacts.length).toBe(0);
    await expect.poll(async () => (await state(b)).contacts.length).toBe(0);
    await expect(a.locator(".contact")).toHaveCount(0);
    await control(a);
    await a.keyboard.press("t");
    await expect.poll(async () => (await state(a)).contacts.length).toBe(1);
    await expect.poll(async () => (await state(b)).detected).toBe(true);
    expect((await state(b)).contacts.length).toBe(0);
    await aimAt(a, 0, 0);
    await a.screenshot({ path: "artifacts/browser-island.png" });
    await a.keyboard.press("Escape");
    await a.screenshot({ path: "artifacts/browser-sonar.png" });
    expect(errors).toEqual([]);
  } finally {
    for (const c of contexts) await c.close();
  }
});

test("four actual browser sessions join, ready and receive the same live match", async ({
  browser,
}) => {
  const contexts = await Promise.all(
    [0, 1, 2, 3].map(() =>
      browser.newContext({ viewport: { width: 1100, height: 850 } }),
    ),
  );
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const errors: string[] = [];
  try {
    for (const p of pages) p.on("pageerror", (e) => errors.push(e.message));
    await pages[0].goto("/");
    await pages[0].locator("#captain-name").fill("함대장");
    await pages[0].locator("#create-room").click();
    await expect(pages[0].locator("#lobby-code")).not.toBeEmpty();
    const code = await pages[0].locator("#lobby-code").innerText();
    for (let i = 1; i < 4; i++) {
      const p = pages[i];
      await p.goto("/");
      await p.locator("#captain-name").fill(`함장 ${i}`);
      await p.locator("#room-code").fill(code);
      await p.locator("#join-room").click();
      await expect(p.locator("#lobby-code")).toHaveText(code);
      await p
        .locator(
          `[data-hull=${i === 1 ? "destroyer" : i === 2 ? "battleship" : "cruiser"}]`,
        )
        .click();
    }
    await expect(pages[0].locator(".player-row")).toHaveCount(4);
    await pages[0].screenshot({
      path: "artifacts/browser-four-player-lobby.png",
    });
    for (const p of pages) await p.locator("#ready").click();
    await pages[0].locator("#start").click();
    for (const p of pages) {
      await expect(p.locator("#battle")).toBeVisible();
      await expect.poll(async () => (await state(p))?.scores.length).toBe(4);
    }
    const snapshots = await Promise.all(pages.map(state));
    expect(new Set(snapshots.map((s) => s.self.id)).size).toBe(4);
    expect(new Set(snapshots.map((s) => s.room))).toEqual(new Set([code]));
    await pages[0].screenshot({
      path: "artifacts/browser-four-player-battle.png",
    });
    expect(errors).toEqual([]);
    // Software-rendered CI measurements are recorded, not presented as a hardware 60fps claim.
    console.log(
      "Four-browser software-rendering FPS:",
      await Promise.all(
        pages.map((p) =>
          p.evaluate(() => Math.round(window.__IRON_TIDE__.view.fps)),
        ),
      ),
    );
  } finally {
    for (const c of contexts) await c.close();
  }
});
