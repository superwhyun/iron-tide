import { test, expect, type Page } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

// Anvil test key #1: a throwaway wallet, never holds funds.
const wallet = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f7603b6b78690d",
);

async function useTestWallet(page: Page) {
  await page.exposeFunction("testWalletSign", (hex: string) =>
    wallet.signMessage({ message: { raw: hex as Hex } }),
  );
  await page.addInitScript((address) => {
    const provider = {
      request: async ({
        method,
        params,
      }: {
        method: string;
        params?: unknown[];
      }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts")
          return [address];
        if (method === "personal_sign")
          return (window as any).testWalletSign(params![0]);
        throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
      },
    };
    window.addEventListener("eip6963:requestProvider", () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: { info: { name: "Test Wallet", uuid: "test" }, provider },
        }),
      ),
    );
  }, wallet.address);
}

test("first run registers the admin wallet and pays a CGC reward", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await useTestWallet(page);
  await page.goto("/admin.html");
  await expect(page.locator("h1")).toHaveText("관리자 지갑 등록");
  // A wrong code is refused before any signature is stored.
  await page.locator("#setup-code").fill("WRONG-000");
  await page.locator("[data-act=setup]").click();
  await expect(page.locator(".notice.error")).toContainText("등록 코드");
  await page.locator("#setup-code").fill("test-0001");
  await page.locator("[data-act=setup]").click();
  await expect(page.locator(".notice.ok")).toContainText("관리자 지갑을 등록");
  await expect(page.locator(".who")).toContainText(wallet.address.slice(0, 6));
  await expect(page.locator(".tile.ok", { hasText: "Metanomic" })).toContainText("연결됨");
  await expect(page.locator(".tile").nth(1)).toContainText("1,000 CGC");

  // The admin's own wallet account is the only player: pay it.
  await page.locator("[data-pick]").first().check();
  await page.locator("#pay-amount").fill("12.5");
  await page.locator("#pay-memo").fill("테스트 보상");
  await expect(page.locator(".total strong")).toHaveText("12.5 CGC");
  await page.locator("[data-act=pay]").click();
  await expect(page.locator("[data-act=pay]")).toContainText("확인");
  await page.locator("[data-act=pay]").click();
  await expect(page.locator(".notice.ok")).toContainText("12.5 CGC");
  await expect(page.locator(".pill").first()).toHaveText("지급 완료", {
    timeout: 30000,
  });
  await expect(page.locator("tbody tr").first()).toContainText("12.5 CGC");
  await page.screenshot({
    path: "artifacts/browser-admin-rewards.png",
    fullPage: true,
  });

  // The seat is taken: a reload stays on the dashboard, never the setup screen.
  await page.reload();
  await expect(page.locator(".brand")).toContainText("관리자 콘솔");
  expect(errors).toEqual([]);
});

test("reward rules are edited, previewed, saved and paid automatically after a match", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await useTestWallet(page);
  await page.goto("/admin.html");
  // The setup test already registered this wallet; sign in again if needed.
  const login = page.locator("[data-act=login]");
  if (await login.isVisible()) await login.click();
  await page.locator("[data-tab=rules]").click();
  await expect(page.locator("#rule-playerKill-amount")).toHaveValue("1");
  await expect(page.locator(".npc-levels li").last()).toContainText("0.2 CGC");
  await page.locator("#rule-participation-amount").fill("0.7");
  await expect(page.locator(".dirty")).toBeVisible();
  await page.locator("[data-rules-act=preview]").click();
  await expect(page.locator(".preview")).toContainText(
    "끝난 경기가 아직 없습니다",
  );
  await page.locator("[data-rules-act=save]").click();
  await expect(page.locator(".notice.ok")).toContainText("보상 규칙을 저장");
  await expect(page.locator(".dirty")).toHaveCount(0);

  // Play a solo match against an NPC as the signed-in admin captain.
  await page.goto("/");
  await page.locator("#create-room").click();
  await expect(page.locator("#lobby-code")).not.toBeEmpty();
  const room = await page.locator("#lobby-code").innerText();
  await page.locator("#add-bot").click();
  await page.locator("#ready").click();
  await page.locator("#start").click();
  await expect(page.locator("#battle")).toBeVisible();
  const res = await fetch("http://127.0.0.1:3100/__test__/fixture", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-e2e-secret": "local-browser-verification",
    },
    body: JSON.stringify({ room, advance: 481 }),
  });
  expect(res.ok).toBe(true);
  await expect(page.locator("#results")).toBeVisible();

  await page.goto("/admin.html");
  const chip = page.locator(".match").first().locator("i.auto");
  await expect(chip).toContainText("자동 지급");
  await expect(chip).toContainText("0.7");
  await page.locator("[data-tab=rules]").click();
  await page.locator("[data-rules-act=preview]").click();
  await expect(page.locator(".preview-match").first()).toContainText("참가");
  await page.screenshot({
    path: "artifacts/browser-admin-rules.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
