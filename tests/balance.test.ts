import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { AccountStore } from "../server/accounts";
import { WalletAuth } from "../server/walletAuth";
import { createAuthRoutes, type BalanceView } from "../server/authRoutes";
import { CgcBalance } from "../server/cgcBalance";
import { MetanomicClient } from "../server/metanomic";
import { FakeMetanomic } from "./support/fakeMetanomic";

// Anvil test key: a throwaway wallet, never holds funds.
const alice = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

let fake: FakeMetanomic,
  store: AccountStore,
  server: http.Server,
  base: string,
  apiUrl: string,
  cgc: CgcBalance | null;
beforeEach(async () => {
  fake = new FakeMetanomic();
  apiUrl = await fake.listen();
  store = new AccountStore(":memory:");
  cgc = new CgcBalance(apiUrl, "common-game-credit");
  const balanceOf = async (a: { wallet: string }): Promise<BalanceView> => {
    if (!cgc) return { balance: null, error: "미설정" };
    try {
      return { balance: (await cgc.balance(a.wallet)).amount };
    } catch {
      return { balance: null, error: "잔액을 읽지 못했습니다." };
    }
  };
  const routes = createAuthRoutes(
    store,
    new WalletAuth(store, 2021),
    balanceOf,
  );
  server = http.createServer(async (req, res) => {
    if (!(await routes(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  server.close();
  fake.close();
  store.close();
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      origin: base,
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    cookie: res.headers.get("set-cookie")?.split(";")[0],
    body: await res.json(),
  };
}
async function login() {
  const challenge = await call("POST", "/api/auth/challenge", {
    address: alice.address,
  });
  const signature = await alice.signMessage({
    message: challenge.body.message,
  });
  return (
    await call("POST", "/api/auth/session", {
      challengeId: challenge.body.challengeId,
      signature,
    })
  ).cookie!;
}

describe("wallet CGC balance", () => {
  it("needs a signed-in captain", async () => {
    expect((await call("GET", "/api/me/balance")).status).toBe(401);
  });
  it("reads the wallet's CGC from the token contract the moment a reward lands", async () => {
    const cookie = await login();
    expect(
      (await call("GET", "/api/me/balance", undefined, cookie)).body,
    ).toEqual({
      balance: "0",
    });
    // A reward accepted by Metanomic is in a block straight away.
    await new MetanomicClient({
      apiUrl,
      gameId: fake.gameId,
      gameKey: fake.key,
      assetId: "common-game-credit",
    }).reward({
      recipient: alice.address,
      amount: "2.608892",
      rewardRef: "test:1",
    });
    // A fresh reader skips the short per-wallet cache.
    cgc = new CgcBalance(apiUrl, "common-game-credit");
    expect(
      (await call("GET", "/api/me/balance", undefined, cookie)).body,
    ).toEqual({
      balance: "2.608892",
    });
  });
  it("reports an unreadable chain instead of failing the page", async () => {
    const cookie = await login();
    cgc = new CgcBalance("http://127.0.0.1:1/v1", "common-game-credit");
    const res = await call("GET", "/api/me/balance", undefined, cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      balance: null,
      error: "잔액을 읽지 못했습니다.",
    });
  });
});
