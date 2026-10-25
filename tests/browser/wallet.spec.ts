import { test, expect } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import "./helpers";

// Anvil test key: a throwaway wallet, never holds funds.
const wallet = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

test("wallet sign-in names the captain, survives reload and records the match", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  // The extension's signing happens in Node with the test key.
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

  // The game budget is reported as short: captains are told before playing.
  await page.route("**/api/rewards/outlook", (route) =>
    route.fulfill({ json: { outlook: "LOW_BUDGET" } }),
  );
  await page.goto("/");
  await expect(page.locator("#wallet-login")).toBeVisible();
  await expect(
    page.locator('.reward-outlook[data-place="harbor"]'),
  ).toBeHidden();
  await page.locator("#wallet-login").click();
  await expect(page.locator(".account-row strong")).toHaveText(
    `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`,
  );
  await expect(page.locator(".account-stats")).toContainText("0전 0승");
  await expect(
    page.locator('.reward-outlook[data-place="harbor"]'),
  ).toContainText("게임 예산 부족");
  // CGC held by the wallet, read from the (fake) token contract.
  await expect(page.locator("#cgc-balance")).toBeVisible();
  await expect(page.locator("#cgc-balance strong")).toHaveText("0");
  // The session is an HttpOnly cookie: scripts cannot read it.
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "it_session",
  );

  await page.reload();
  await expect(page.locator(".account-row strong")).toBeVisible();
  await page.locator("#captain-name").fill("지갑 함장");
  await page.locator("#create-room").click();
  await expect(page.locator("#lobby-code")).not.toBeEmpty();
  const room = await page.locator("#lobby-code").innerText();
  await expect(page.locator(".player-row").first()).toContainText("지갑 함장");
  await expect(page.locator(".player-row small.verified")).toHaveCount(1);
  await expect(
    page.locator('.reward-outlook[data-place="lobby"]'),
  ).toContainText("경기는 정상적으로 할 수 있습니다");
  await page.screenshot({ path: "artifacts/browser-wallet-lobby.png" });

  await page.locator("#add-bot").click();
  await page.locator("#ready").click();
  await page.locator("#start").click();
  await expect(page.locator("#battle")).toBeVisible();
  // Fast-forward the whole match on the test server.
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
  // The server reports this match's CGC right on the results card.
  await expect(page.locator("#result-reward")).toHaveAttribute(
    "data-state",
    "queued",
  );
  await expect(page.locator("#result-reward")).toContainText("참가");
  await expect(
    page.locator("#result-reward .reward-head strong"),
  ).toContainText(/^\+[\d.]+ CGC$/);
  await page.screenshot({ path: "artifacts/browser-match-reward.png" });
  await page.locator("#result-leave").click();
  await expect(page.locator(".account-stats")).toContainText("1전");
  // The automatic match reward shows up in the header once it is on chain.
  await expect(page.locator("#cgc-balance strong")).not.toHaveText("0", {
    timeout: 30000,
  });
  await expect(page.locator("#captain-name")).toHaveValue("지갑 함장");
  await page.screenshot({ path: "artifacts/browser-wallet-account.png" });

  await page.locator("#wallet-logout").click();
  await expect(page.locator("#wallet-login")).toBeVisible();
  expect(errors).toEqual([]);
});
