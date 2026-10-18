import { test, expect } from "@playwright/test";
import "./helpers";

test("harbor renders all hulls and plays recorded broadside with working volume", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("/");
  for (const hull of ["destroyer", "cruiser", "battleship"]) {
    await page.locator(`[data-hull=${hull}]`).click();
    await expect(page.locator(`[data-hull=${hull}]`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.waitForTimeout(400);
  }
  await page.locator("#preview-salvo").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__IRON_TIDE__.view.audio.recordedAssets.length,
      ),
    )
    .toBe(7);
  await expect
    .poll(() =>
      page.evaluate(() => window.__IRON_TIDE__.view.audio.radioAssets.length),
    )
    .toBe(12);
  await expect
    .poll(() =>
      page.evaluate(() => window.__IRON_TIDE__.view.audio.shotsPlayed),
    )
    .toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.__IRON_TIDE__.view.graphics.emitted))
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.__IRON_TIDE__.view.audio.activeVoices),
    )
    .toBeGreaterThan(0);
  await page.locator("#volume").fill("40");
  await expect
    .poll(() => page.evaluate(() => window.__IRON_TIDE__.view.audio.volume))
    .toBe(0.4);
  await page.screenshot({ path: "artifacts/browser-realism-broadside.png" });
  expect(errors).toEqual([]);
});
