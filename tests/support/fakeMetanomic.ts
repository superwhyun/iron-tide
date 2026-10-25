import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

/**
 * Stand-in for the Metanomic game API (§5, §9): bearer auth, idempotent
 * rewards keyed by rewardRef, operations that finalize after a few polls,
 * plus switches to simulate outages and an exhausted budget.
 */
export class FakeMetanomic {
  rewards = new Map<string, { body: string; operationId: string }>();
  operations = new Map<string, { polls: number }>();
  /** Fail this many reward posts with 503 before accepting. */
  outages = 0;
  budgetExceeded = false;
  finalizeAfterPolls = 1;
  posts = 0;
  /** CGC per wallet (lower-case) in micro-units; rewards land here at once. */
  balances = new Map<string, bigint>();
  static readonly contractAddress =
    "0x8cb7b084470ab1d945586052a586b093fc1235d0";
  private server: http.Server;
  constructor(
    readonly key = "test-game-key",
    readonly gameId = "game-test",
  ) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }
  async listen(port = 0) {
    await new Promise<void>((done) =>
      this.server.listen(port, "127.0.0.1", done),
    );
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }
  close() {
    this.server.close();
  }
  private send(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
  private error(res: http.ServerResponse, status: number, code: string) {
    this.send(res, status, { error: { code, message: code } });
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.url === "/health") return this.send(res, 200, { ok: true });
    // Public: token deployment, pointing its RPC at this same server.
    if (req.method === "GET" && req.url === "/v1/assets") {
      const host = `http://${req.headers.host}`;
      return this.send(res, 200, {
        assets: [
          {
            assetId: "common-game-credit",
            decimals: 6,
            activeDeploymentId: "test-chain",
            deployments: [
              {
                id: "test-chain",
                chainId: 31337,
                rpcUrl: `${host}/rpc`,
                token: FakeMetanomic.contractAddress,
              },
            ],
          },
        ],
      });
    }
    if (req.method === "POST" && req.url === "/rpc") return this.rpc(req, res);
    if (req.headers.authorization !== `Bearer ${this.key}`)
      return this.error(res, 401, "UNAUTHENTICATED");
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const game = `/v1/games/${this.gameId}`;
    if (req.method === "GET" && path === `${game}/budget`)
      return this.send(res, 200, {
        onchain: "1000.000000",
        reserved: "0.000000",
        available: this.budgetExceeded ? "0.000000" : "1000.000000",
      });
    if (req.method === "POST" && path === `${game}/rewards`) {
      let body = "";
      for await (const chunk of req) body += chunk;
      this.posts++;
      if (this.outages > 0) {
        this.outages--;
        return this.error(res, 503, "UNAVAILABLE");
      }
      const key = String(req.headers["idempotency-key"] ?? "");
      const parsed = JSON.parse(body);
      if (!key || key !== parsed.rewardRef)
        return this.error(res, 422, "INVALID_REQUEST");
      const existing = this.rewards.get(key);
      if (existing && existing.body !== body)
        return this.error(res, 409, "IDEMPOTENCY_CONFLICT");
      if (!existing && this.budgetExceeded)
        return this.error(res, 409, "BUDGET_EXCEEDED");
      const record = existing ?? {
        body,
        operationId: `op-${this.operations.size + 1}`,
      };
      if (!existing) {
        this.rewards.set(key, record);
        this.operations.set(record.operationId, { polls: 0 });
        const to = String(parsed.recipient).toLowerCase(),
          [whole, fraction = ""] = String(parsed.amount).split(".");
        this.balances.set(
          to,
          (this.balances.get(to) ?? 0n) +
            BigInt(whole) * 1_000_000n +
            BigInt(fraction.padEnd(6, "0")),
        );
      }
      return this.send(res, 202, {
        rewardId: `rw-${key}`,
        operationId: record.operationId,
        status: "QUEUED",
      });
    }
    const op = path.match(/^\/v1\/operations\/([^/]+)$/);
    if (req.method === "GET" && op) {
      const entry = this.operations.get(op[1]);
      if (!entry) return this.error(res, 404, "NOT_FOUND");
      entry.polls++;
      return this.send(res, 200, {
        status:
          entry.polls >= this.finalizeAfterPolls ? "FINALIZED" : "SUBMITTED",
      });
    }
    this.error(res, 404, "NOT_FOUND");
  }
  /** Minimal JSON-RPC: `eth_call` answers ERC-20 `balanceOf` from `balances`. */
  private async rpc(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = "";
    for await (const chunk of req) body += chunk;
    const calls = [JSON.parse(body)].flat() as {
      id: number;
      method: string;
      params: { to?: string; data?: string }[];
    }[];
    const answer = (c: (typeof calls)[number]) => {
      if (c.method === "eth_chainId") return { result: "0x7a69" };
      if (c.method === "eth_blockNumber") return { result: "0x1" };
      const call = c.params?.[0];
      if (
        c.method === "eth_call" &&
        call?.to?.toLowerCase() === FakeMetanomic.contractAddress &&
        call.data?.startsWith("0x70a08231")
      ) {
        const wallet = `0x${call.data.slice(-40)}`.toLowerCase();
        const value = this.balances.get(wallet) ?? 0n;
        return { result: `0x${value.toString(16).padStart(64, "0")}` };
      }
      return { error: { code: -32601, message: "unsupported" } };
    };
    const out = calls.map((c) => ({ jsonrpc: "2.0", id: c.id, ...answer(c) }));
    this.send(res, 200, Array.isArray(JSON.parse(body)) ? out : out[0]);
  }
}

// `tsx tests/support/fakeMetanomic.ts <port>` runs it standalone for browser tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fake = new FakeMetanomic();
  void fake
    .listen(Number(process.argv[2] ?? 3390))
    .then((url) => console.log(`fake Metanomic · ${url}`));
}
