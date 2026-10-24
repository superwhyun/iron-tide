import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AccountStore } from "../server/accounts";
import { MetanomicClient } from "../server/metanomic";
import { RewardQueue, fromMicro, toMicro } from "../server/rewardQueue";
import { FakeMetanomic } from "./support/fakeMetanomic";

const alice = {
  id: "acct-a",
  wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  name: "청람",
};
const bob = {
  id: "acct-b",
  wallet: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  name: "태산",
};

let fake: FakeMetanomic, store: AccountStore, queue: RewardQueue;
beforeEach(async () => {
  fake = new FakeMetanomic();
  const apiUrl = await fake.listen();
  store = new AccountStore(":memory:");
  queue = new RewardQueue(
    store.db,
    new MetanomicClient({
      apiUrl,
      gameId: fake.gameId,
      gameKey: fake.key,
      assetId: "common-game-credit",
    }),
  );
});
afterEach(() => {
  fake.close();
  store.close();
});
const statuses = () => queue.list().map((r) => r.status);

describe("coin amounts", () => {
  it("are exact decimal strings with at most six places", () => {
    expect(fromMicro(toMicro("1.5")!)).toBe("1.500000");
    expect(fromMicro(toMicro("0.000001")! * 3n)).toBe("0.000003");
    for (const bad of ["0", "-1", "1.0000001", "1e3", "abc", "", "01"])
      expect(toMicro(bad)).toBeNull();
  });
});

describe("reward queue", () => {
  it("sends each reward to its wallet once and marks it paid when finalized", async () => {
    queue.enqueue([alice, bob], "2.5", "주간 1위", null);
    await queue.tick();
    expect(statuses()).toEqual(["DONE", "DONE"]);
    expect(fake.rewards.size).toBe(2);
    const sent = JSON.parse([...fake.rewards.values()][0].body);
    expect(sent).toMatchObject({
      amount: "2.500000",
      assetId: "common-game-credit",
    });
    expect([alice.wallet, bob.wallet]).toContain(sent.recipient);
    expect(queue.list().map((r) => r.rewardId).sort()).toEqual(
      [...fake.rewards.keys()].map((k) => `rw-${k}`).sort(),
    );
    expect(queue.totals().get(alice.id)).toEqual({
      paid: toMicro("2.5"),
      pending: 0n,
    });
  });
  it("keeps the request through an outage and resends the identical body", async () => {
    fake.outages = 2;
    queue.enqueue([alice], "1", "", null);
    await queue.tick();
    await queue.tick();
    expect(statuses()).toEqual(["PENDING"]);
    expect(queue.list()[0].error).toBe("UNAVAILABLE");
    await queue.tick();
    expect(statuses()).toEqual(["DONE"]);
    // Three posts, one reward: the retries carried the same idempotency key and body.
    expect(fake.posts).toBe(3);
    expect(fake.rewards.size).toBe(1);
  });
  it("waits for finality before calling a reward paid", async () => {
    fake.finalizeAfterPolls = 3;
    queue.enqueue([alice], "1", "", null);
    await queue.tick();
    expect(statuses()).toEqual(["SUBMITTED"]);
    expect(queue.totals().get(alice.id)).toEqual({
      paid: 0n,
      pending: toMicro("1"),
    });
  });
  it("marks budget refusals failed and reissues them under a new reference", async () => {
    fake.budgetExceeded = true;
    queue.enqueue([alice], "5", "보상", null);
    await queue.tick();
    const [failed] = queue.list();
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toBe("BUDGET_EXCEEDED");
    fake.budgetExceeded = false;
    expect(queue.reissue(failed.id)).toBe(true);
    await queue.tick();
    const rows = queue.list();
    expect(rows.map((r) => r.status).sort()).toEqual(["DONE", "FAILED"]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });
  it("never reissues a reference conflict, which may already hold a reward", async () => {
    queue.enqueue([alice], "5", "보상", null);
    const [row] = queue.list();
    // Metanomic already holds this reference with a different body.
    fake.rewards.set(row.id, { body: "{}", operationId: "op-old" });
    await queue.tick();
    const [failed] = queue.list();
    expect(failed).toMatchObject({
      status: "FAILED",
      error: "IDEMPOTENCY_CONFLICT",
    });
    expect(queue.reissue(failed.id)).toBe(false);
    expect(queue.list()).toHaveLength(1);
  });
  it("adds the rewardId column to a database from before it existed", () => {
    const old = new AccountStore(":memory:");
    old.db.exec(`CREATE TABLE rewards(id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
      wallet TEXT NOT NULL, name TEXT NOT NULL, amount TEXT NOT NULL, memo TEXT NOT NULL,
      match_id INTEGER, status TEXT NOT NULL, operation_id TEXT, error TEXT,
      checked_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    const migrated = new RewardQueue(old.db, null);
    migrated.enqueue([alice], "1", "", null);
    expect(migrated.list()[0].rewardId).toBeNull();
    old.close();
  });
  it("holds rewards locally while Metanomic is not configured", async () => {
    const offline = new RewardQueue(store.db, null);
    offline.enqueue([alice], "1", "", null);
    await offline.tick();
    expect(offline.list().find((r) => r.status === "PENDING")).toBeTruthy();
    expect(fake.posts).toBe(0);
  });
});
