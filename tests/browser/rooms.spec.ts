import { test, expect } from "@playwright/test";

test("open battles list: rename, join from the list, hide from the list", async ({
  browser,
}) => {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await host.goto("/");
  await expect(host.locator("#create-room")).toContainText("새 전장 생성");
  // Guests have no wallet balance box.
  await expect(host.locator("#cgc-balance")).toBeHidden();
  await host.locator("#captain-name").fill("목록 함장");
  await host.locator("#create-room").click();
  await expect(host.locator("#lobby-code")).not.toBeEmpty();
  const room = await host.locator("#lobby-code").innerText();

  await guest.goto("/");
  const row = guest.locator(".room-row", { hasText: room });
  await expect(row).toContainText("목록 함장");
  await expect(row).toContainText("1 / 8척 · 출항 대기");
  await guest.screenshot({ path: "artifacts/browser-room-list.png" });
  await row.locator("[data-join-room]").click();
  await expect(guest.locator("#lobby-code")).toHaveText(room);
  await expect(host.locator(".player-row")).toHaveCount(2);

  await host.locator("#room-listed").uncheck();
  await expect(guest.locator("#room-listed")).not.toBeChecked();
  await expect(guest.locator("#room-listed")).toBeDisabled();
  const other = await (await browser.newContext()).newPage();
  await other.goto("/");
  await expect(other.locator("#room-list")).not.toContainText(room);
});

for (const [width, height] of [
  [1280, 720],
  [1440, 780],
] as const)
  test(`open battles panel stays on screen at ${width}x${height}`, async ({
    browser,
  }) => {
    const host = await (await browser.newContext()).newPage();
    await host.goto("/");
    await host.locator("#create-room").click();
    await expect(host.locator("#lobby-code")).not.toBeEmpty();
    const page = await (
      await browser.newContext({ viewport: { width, height } })
    ).newPage();
    await page.goto("/");
    await expect(page.locator(".room-row").first()).toBeVisible();
    const box = (sel: string) =>
      page.evaluate((s) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      }, sel);
    const panel = await box("#room-panel"),
      card = await box("#connect-form"),
      fleet = await box(".fleet-selection");
    expect(panel.top).toBeGreaterThanOrEqual(0);
    expect(panel.bottom).toBeLessThanOrEqual(height);
    expect(panel.left).toBeGreaterThan(card.right);
    // At 720 px the hull cards were already clipped before this panel existed.
    if (height >= 780) expect(fleet.bottom).toBeLessThanOrEqual(height);
    expect(panel.bottom).toBeLessThanOrEqual(fleet.top);
    await page.screenshot({
      path: `artifacts/browser-room-list-${width}x${height}.png`,
    });
  });
