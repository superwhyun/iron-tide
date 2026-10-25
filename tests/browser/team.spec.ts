import { test, expect } from "@playwright/test";
import { state, fixture } from "./helpers";

test("team match: fleets in the lobby, ally labels, team score bar and fleet result", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.locator("#create-room").click();
  await expect(page.locator("#lobby-code")).not.toBeEmpty();
  const room = await page.locator("#lobby-code").innerText();

  await page.locator('[data-mode="team"]').click();
  await expect(page.locator(".team-group")).toHaveCount(2);
  await page.locator("#bot-hull").selectOption("cruiser");
  for (let i = 0; i < 3; i++) await page.locator("#add-bot").click();
  // Joins alternate between the fleets: 2 red, 2 blue.
  await expect(
    page.locator('.team-group[data-team="0"] .player-row'),
  ).toHaveCount(2);
  await expect(
    page.locator('.team-group[data-team="1"] .player-row'),
  ).toHaveCount(2);

  // Cross to blue, then send a blue NPC to red to even the sides again.
  await page.locator('[data-join-team="1"]').click();
  await expect(
    page.locator('.team-group[data-team="1"] .player-row'),
  ).toHaveCount(3);
  await page
    .locator('.team-group[data-team="1"] [data-move-bot]')
    .first()
    .click();
  await expect(
    page.locator('.team-group[data-team="0"] .player-row'),
  ).toHaveCount(2);
  await expect(page.locator('.team-group[data-team="1"]')).toContainText(
    "함대장",
  );
  await page.screenshot({ path: "artifacts/browser-team-lobby.png" });

  await page.locator("#ready").click();
  await page.locator("#start").click();
  await expect(page.locator("#battle")).toBeVisible();
  await expect(page.locator("#match-mode")).toContainText("팀전");
  await expect(page.locator("#team-bar")).toBeVisible();
  await expect(page.locator(".team-score[data-mine]")).toContainText("청군");

  await expect.poll(async () => (await state(page))?.scores.length).toBe(4);
  const snap = await state(page);
  const self = snap.self;
  const ally = snap.scores.find(
    (p) => p.id !== self.id && p.team === snap.team,
  )!;
  const enemy = snap.scores.find((p) => p.team !== snap.team)!;
  // Park one ally and one enemy in front of the bow, inside detection range.
  const ahead = (d: number, side: number) => ({
    x: self.x + Math.sin(self.heading) * d + Math.cos(self.heading) * side,
    z: self.z + Math.cos(self.heading) * d - Math.sin(self.heading) * side,
  });
  await fixture(room, {
    players: [
      { id: ally.id, ...ahead(260, -90), speed: 0 },
      { id: enemy.id, ...ahead(320, 110), speed: 0 },
    ],
  });
  await expect(
    page.locator(`.contact.ally[data-contact="${ally.id}"]`),
  ).toBeVisible();
  await expect(
    page.locator(`.contact:not(.ally)[data-contact="${enemy.id}"]`),
  ).toBeVisible();
  // Each label's chevron sits on its projected anchor above the ship
  // (regression: a transformed container once pushed labels 84 px down).
  const drift = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".contact")].map((el) => {
      const r = el.getBoundingClientRect();
      return Math.max(
        Math.abs(r.bottom - parseFloat(el.style.top)),
        Math.abs(r.left + r.width / 2 - parseFloat(el.style.left)),
      );
    }),
  );
  expect(drift.length).toBeGreaterThan(0);
  for (const d of drift) expect(d).toBeLessThan(2);
  // X locks the enemy, never the ally.
  await page.locator("#battle").click({ position: { x: 640, y: 400 } });
  await page.keyboard.press("x");
  await expect(page.locator(".contact.locked")).toHaveAttribute(
    "data-contact",
    enemy.id,
  );
  await page.screenshot({ path: "artifacts/browser-team-battle.png" });

  await fixture(room, { advance: 481 });
  await expect(page.locator("#results")).toBeVisible();
  await expect(page.locator("#winner")).toContainText(/승리|무승부/);
  await expect(page.locator('.result-row[data-team="1"]')).toHaveCount(2);
  await page.screenshot({ path: "artifacts/browser-team-results.png" });
  expect(errors).toEqual([]);
});
