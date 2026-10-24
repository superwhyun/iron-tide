import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { AccountStore } from "../server/accounts";
import { WalletAuth } from "../server/walletAuth";
import { createAuthRoutes } from "../server/authRoutes";

// Well-known test keys (Anvil defaults): never hold real funds.
const alice = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const mallory = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

let store: AccountStore, server: http.Server, base: string;
beforeEach(async () => {
  store = new AccountStore(":memory:");
  const routes = createAuthRoutes(store, new WalletAuth(store, 2021));
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
  store.close();
});

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { origin: base },
) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    cookie: res.headers.get("set-cookie"),
    body: await res.json(),
  };
}
async function signIn(wallet = alice, signer = wallet) {
  const challenge = await api("POST", "/api/auth/challenge", {
    address: wallet.address,
  });
  const signature = await signer.signMessage({
    message: challenge.body.message,
  });
  return {
    challenge,
    result: await api("POST", "/api/auth/session", {
      challengeId: challenge.body.challengeId,
      signature,
    }),
  };
}
const cookieOf = (setCookie: string | null) => setCookie!.split(";")[0];

describe("wallet login", () => {
  it("issues a SIWE message bound to this origin, chain and a one-time request", async () => {
    const { body } = await api("POST", "/api/auth/challenge", {
      address: alice.address.toLowerCase(),
    });
    expect(body.address).toBe(alice.address);
    expect(body.chainId).toBe(2021);
    expect(body.message).toContain(
      `${new URL(base).host} wants you to sign in`,
    );
    expect(body.message).toContain("Chain ID: 2021");
    expect(body.message).toContain(`Request ID: ${body.challengeId}`);
    expect(body.message).toContain("거래나 토큰 사용 승인이 아닌");
  });
  it("signs in with the wallet signature, sets an HttpOnly cookie and remembers the account", async () => {
    const { result } = await signIn();
    expect(result.status).toBe(200);
    expect(result.body.account.wallet).toBe(alice.address);
    expect(result.cookie).toMatch(
      /it_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict/,
    );
    const me = await api("GET", "/api/me", undefined, {
      cookie: cookieOf(result.cookie),
    });
    expect(me.body.account.wallet).toBe(alice.address);
    // The raw token is never stored, only its hash.
    expect(
      store.accountForToken(cookieOf(result.cookie).split("=")[1])?.wallet,
    ).toBe(alice.address);
  });
  it("rejects a signature from a different wallet and a reused challenge", async () => {
    const forged = await signIn(alice, mallory);
    expect(forged.result.status).toBe(422);
    expect(forged.result.body.error.code).toBe("INVALID_SIGNATURE");
    const { challenge, result } = await signIn();
    expect(result.status).toBe(200);
    const signature = await alice.signMessage({
      message: challenge.body.message,
    });
    const replay = await api("POST", "/api/auth/session", {
      challengeId: challenge.body.challengeId,
      signature,
    });
    expect(replay.status).toBe(422);
  });
  it("refuses requests from another site", async () => {
    const res = await api(
      "POST",
      "/api/auth/challenge",
      { address: alice.address },
      { origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ORIGIN_DENIED");
  });
  it("renames the captain, records matches and logs out", async () => {
    const { result } = await signIn();
    const cookie = cookieOf(result.cookie);
    const renamed = await api(
      "PATCH",
      "/api/me",
      { name: "  <b>태산</b>  " },
      { origin: base, cookie },
    );
    expect(renamed.body.account.name).toBe("b태산/b");
    const id = store.accountForToken(cookie.split("=")[1])!.id;
    store.recordMatch(id, { kills: 3, deaths: 1, damage: 12345.6, won: true });
    const me = await api("GET", "/api/me", undefined, { cookie });
    expect(me.body.account).toMatchObject({
      matches: 1,
      wins: 1,
      kills: 3,
      deaths: 1,
      damage: 12346,
    });
    const out = await api("DELETE", "/api/auth/session", undefined, {
      origin: base,
      cookie,
    });
    expect(out.cookie).toContain("Max-Age=0");
    expect(
      (await api("GET", "/api/me", undefined, { cookie })).body.account,
    ).toBeNull();
  });
  it("keeps one account per wallet across logins", async () => {
    const first = await signIn();
    const second = await signIn();
    expect(second.result.body.account.name).toBe(
      first.result.body.account.name,
    );
    expect(first.result.cookie).not.toBe(second.result.cookie);
  });
});
