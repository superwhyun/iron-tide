import { AutoRewards } from "../server/autoRewards";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { AccountStore } from "../server/accounts";
import { WalletAuth } from "../server/walletAuth";
import { createAuthRoutes } from "../server/authRoutes";
import { AdminSetup, createAdminRoutes } from "../server/adminRoutes";
import { RewardQueue } from "../server/rewardQueue";
import { MetanomicClient } from "../server/metanomic";
import { FakeMetanomic } from "./support/fakeMetanomic";

// Anvil test keys: throwaway wallets.
const owner = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const player = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

let fake: FakeMetanomic,
  store: AccountStore,
  server: http.Server,
  base: string,
  queue: RewardQueue,
  auto: AutoRewards;
beforeEach(async () => {
  fake = new FakeMetanomic();
  const apiUrl = await fake.listen();
  store = new AccountStore(":memory:");
  const auth = new WalletAuth(store, 2021);
  const client = new MetanomicClient({
    apiUrl,
    gameId: fake.gameId,
    gameKey: fake.key,
    assetId: "cgc",
  });
  queue = new RewardQueue(store.db, client);
  auto = new AutoRewards(store, queue, client);
  const admin = createAdminRoutes(
    store,
    auth,
    new AdminSetup(store, "ABCD-1234"),
    queue,
    client,
    auto,
  );
  const login = createAuthRoutes(store, auth);
  server = http.createServer(async (req, res) => {
    if (!(await admin(req, res)) && !(await login(req, res))) {
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

async function api(
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
async function claimAdmin(wallet = owner, setupCode = "ABCD-1234") {
  const challenge = await api("POST", "/api/admin/setup/challenge", {
    address: wallet.address,
    setupCode,
  });
  if (challenge.status !== 200) return challenge;
  const signature = await wallet.signMessage({
    message: challenge.body.message,
  });
  return api("POST", "/api/admin/setup", {
    challengeId: challenge.body.challengeId,
    signature,
    setupCode,
  });
}
async function login(wallet = player) {
  const challenge = await api("POST", "/api/auth/challenge", {
    address: wallet.address,
  });
  const signature = await wallet.signMessage({
    message: challenge.body.message,
  });
  return api("POST", "/api/auth/session", {
    challengeId: challenge.body.challengeId,
    signature,
  });
}

describe("admin console", () => {
  it("starts without an admin and needs the server's setup code", async () => {
    expect((await api("GET", "/api/admin/status")).body).toMatchObject({
      hasAdmin: false,
      isAdmin: false,
      metanomic: { connected: true, gameId: "game-test" },
    });
    const wrong = await claimAdmin(owner, "WRONG-CODE");
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe("INVALID_SETUP_CODE");
  });
  it("registers the first admin wallet once, with a message that says so", async () => {
    const challenge = await api("POST", "/api/admin/setup/challenge", {
      address: owner.address,
      setupCode: "abcd-1234",
    });
    expect(challenge.body.message).toContain("관리자로 등록");
    const done = await claimAdmin();
    expect(done.status).toBe(200);
    expect(done.body.wallet).toBe(owner.address);
    const status = await api(
      "GET",
      "/api/admin/status",
      undefined,
      done.cookie,
    );
    expect(status.body).toMatchObject({
      hasAdmin: true,
      isAdmin: true,
      wallet: owner.address,
    });
    // The code is spent: nobody else can claim the seat.
    const again = await claimAdmin(player);
    expect(again.status).toBe(409);
  });
  it("does not accept an ordinary login signature as an admin claim", async () => {
    const challenge = await api("POST", "/api/auth/challenge", {
      address: owner.address,
    });
    const signature = await owner.signMessage({
      message: challenge.body.message,
    });
    const res = await api("POST", "/api/admin/setup", {
      challengeId: challenge.body.challengeId,
      signature,
      setupCode: "ABCD-1234",
    });
    expect(res.status).toBe(422);
  });
  it("keeps players out of the admin API", async () => {
    await claimAdmin();
    const guest = await login(player);
    expect(
      (await api("GET", "/api/admin/overview", undefined, guest.cookie)).status,
    ).toBe(403);
    expect(
      (
        await api(
          "POST",
          "/api/admin/rewards",
          { accountIds: [], amount: "1" },
          guest.cookie,
        )
      ).status,
    ).toBe(403);
  });
  it("reads with a same-origin GET (no Origin header) but refuses writes without one", async () => {
    const admin = (await claimAdmin()).cookie!;
    const read = await fetch(`${base}/api/admin/overview`, {
      headers: { cookie: admin },
    });
    expect(read.status).toBe(200);
    const write = await fetch(`${base}/api/admin/rewards`, {
      method: "POST",
      headers: { cookie: admin, "content-type": "application/json" },
      body: JSON.stringify({ accountIds: ["x"], amount: "1" }),
    });
    expect(write.status).toBe(403);
  });
  it("lets the admin pay selected players and shows budget, totals and history", async () => {
    const admin = (await claimAdmin()).cookie;
    await login(player);
    const overview = await api("GET", "/api/admin/overview", undefined, admin);
    expect(overview.body.budget.available).toBe("1000.000000");
    const target = overview.body.players.find(
      (p: { wallet: string }) => p.wallet === player.address,
    );
    const bad = await api(
      "POST",
      "/api/admin/rewards",
      { accountIds: [target.id], amount: "1.1234567" },
      admin,
    );
    expect(bad.body.error.code).toBe("INVALID_AMOUNT");
    const paid = await api(
      "POST",
      "/api/admin/rewards",
      { accountIds: [target.id], amount: "3", memo: "1위 보상" },
      admin,
    );
    expect(paid.status).toBe(200);
    expect(paid.body.rewards[0]).toMatchObject({
      wallet: player.address,
      amount: "3.000000",
      memo: "1위 보상",
    });
    await queue.tick();
    const after = await api("GET", "/api/admin/overview", undefined, admin);
    expect(after.body.rewards[0].status).toBe("DONE");
    expect(
      after.body.players.find((p: { id: string }) => p.id === target.id).paid,
    ).toBe("3.000000");
  });
  it("lets only the admin read, preview and save reward rules", async () => {
    const admin = (await claimAdmin()).cookie;
    const guest = await login(player);
    expect(
      (await api("GET", "/api/admin/rules", undefined, guest.cookie)).status,
    ).toBe(403);
    const current = await api("GET", "/api/admin/rules", undefined, admin);
    expect(current.body.rules).toEqual(current.body.defaults);
    const rules = {
      ...current.body.rules,
      playerKill: { enabled: true, modes: "all", amount: "2.5" },
    };
    const bad = await api(
      "PUT",
      "/api/admin/rules",
      { rules: { ...rules, caps: { ...rules.caps, perMatch: "abc" } } },
      admin,
    );
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toContain("경기당 1인 상한");
    const previewed = await api(
      "POST",
      "/api/admin/rules/preview",
      { rules },
      admin,
    );
    expect(previewed.body).toMatchObject({ total: "0.000000", matches: [] });
    const saved = await api("PUT", "/api/admin/rules", { rules }, admin);
    expect(saved.status).toBe(200);
    expect(auto.rules().playerKill.amount).toBe("2.5");
  });
});
