import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AccountStore,
  type MatchEntry,
  type MatchSummary,
} from "../server/accounts";
import { emptyLedger, type CombatLedger } from "../server/game";
import { MetanomicClient } from "../server/metanomic";
import { RewardQueue } from "../server/rewardQueue";
import { AutoRewards, RULE_PREFIX } from "../server/autoRewards";
import { preview } from "../server/adminRoutes";
import {
  computeMatchRewards,
  DEFAULT_RULES,
  fitDailyCaps,
  micro,
  normalizeRules,
  RuleError,
  type RewardRules,
} from "../server/rewardRules";
import { FakeMetanomic } from "./support/fakeMetanomic";

function entry(
  place: number,
  accountId: string | null,
  ledger: Partial<CombatLedger["player"]> & {
    npcKills?: number[];
    npcDamage?: number[];
  } = {},
  extra: Partial<MatchEntry> = {},
): MatchEntry {
  const l = emptyLedger();
  l.player.kills = ledger.kills ?? 0;
  l.player.damage = ledger.damage ?? 0;
  if (ledger.npcKills) l.npc.kills = ledger.npcKills;
  if (ledger.npcDamage) l.npc.damage = ledger.npcDamage;
  return {
    accountId,
    name: accountId ?? `NPC ${place}`,
    hull: "cruiser",
    place,
    kills: 0,
    deaths: 1,
    damage: 0,
    score: 0,
    ledger: l,
    ...extra,
  };
}
let nextId = 1;
const match = (
  entries: MatchEntry[],
  extra: Partial<MatchSummary> = {},
): MatchSummary => ({
  id: nextId++,
  room: "ROOM",
  mode: "deathmatch",
  endedAt: Date.now(),
  duration: 480,
  entries,
  ...extra,
});
const paid = (m: MatchSummary, rules: RewardRules = DEFAULT_RULES) =>
  Object.fromEntries(
    computeMatchRewards(m, rules).players.map((p) => [p.accountId, p.payable]),
  );
const rules = (patch: object) => normalizeRules({ ...DEFAULT_RULES, ...patch });

describe("reward rules", () => {
  it("pays rank, player kills, damage and participation with the defaults", () => {
    const m = match([
      entry(1, "a", { kills: 3, damage: 90_000 }),
      entry(2, "b", { kills: 2, damage: 60_000 }),
      entry(3, "c", { kills: 1, damage: 40_000 }),
      entry(4, "d", { kills: 1, damage: 30_000 }),
    ]);
    // a: rank 5 + kills 3 + damage 1.8 + join 0.5
    expect(paid(m)).toEqual({
      a: micro("10.3"),
      b: micro("6.7"),
      c: micro("3.3"),
      d: micro("2.1"),
    });
    const items = computeMatchRewards(m, DEFAULT_RULES).players[0].items;
    expect(items.map((i) => i.label)).toEqual([
      "1위",
      "플레이어 격침 3척",
      "피해량 90,000",
      "참가",
    ]);
  });
  it("pays NPC kills and damage at a fifth of the player rate, scaled by skill", () => {
    const m = match([
      entry(1, "a", {
        npcKills: [1, 0, 0, 0, 2],
        npcDamage: [0, 0, 0, 0, 100_000],
      }),
      entry(2, "b"),
      entry(3, null, {}, { npcSkill: 5 }),
    ]);
    const a = computeMatchRewards(m, DEFAULT_RULES).players[0];
    expect(a.items).toEqual([
      { label: "1위", amount: "5.000000" },
      { label: "NPC 격침 (지능 1) 1척", amount: "0.020000" },
      { label: "NPC 격침 (지능 5) 2척", amount: "0.400000" },
      // 100,000 damage → 2 CGC at the player rate, 1/5 of it.
      { label: "NPC 피해 (지능 5) 100,000", amount: "0.400000" },
      { label: "참가", amount: "0.500000" },
    ]);
  });
  it("ranks people only, so NPC places do not push a captain down", () => {
    const m = match([
      entry(1, null, {}, { npcSkill: 5 }),
      entry(2, "a"),
      entry(3, "b"),
    ]);
    const labels = computeMatchRewards(m, DEFAULT_RULES).players.map(
      (p) => p.items[0].label,
    );
    expect(labels).toEqual(["1위", "2위"]);
  });
  it("gives a solo captain against NPCs no rank or survival bonus", () => {
    const m = match([
      entry(1, "a", { npcKills: [0, 0, 0, 0, 6] }, { deaths: 0 }),
      entry(2, null, {}, { npcSkill: 5 }),
    ]);
    expect(paid(m)).toEqual({ a: micro("1.7") });
  });
  it("adds the survival bonus and domination points only where they apply", () => {
    const m = match(
      [
        entry(1, "a", {}, { deaths: 0, score: 600 }),
        entry(2, "b", {}, { score: 250 }),
      ],
      { mode: "domination" },
    );
    // a: rank 5 + zone 1.8 + no sinking 1 + join 0.5
    expect(paid(m)).toEqual({ a: micro("8.3"), b: micro("4.25") });
  });
  it("skips short matches, too few wallet captains and pre-ledger matches", () => {
    expect(
      computeMatchRewards(
        match([entry(1, "a"), entry(2, "b")], { duration: 60 }),
        DEFAULT_RULES,
      ).skipped,
    ).toContain("120초");
    expect(
      computeMatchRewards(
        match([entry(1, null), entry(2, null)]),
        DEFAULT_RULES,
      ).skipped,
    ).toContain("지갑 함장");
    const legacy = entry(1, "a");
    delete legacy.ledger;
    expect(
      computeMatchRewards(match([legacy]), DEFAULT_RULES).skipped,
    ).toContain("이전");
  });
  it("caps one match per captain and drops dust below the minimum", () => {
    const m = match([entry(1, "a", { kills: 30 }), entry(2, "b")]);
    const [a, b] = computeMatchRewards(m, DEFAULT_RULES).players;
    expect(a.payable).toBe(micro("15"));
    expect(a.note).toBe("경기당 상한 적용");
    expect(b.payable).toBe(micro("3.5"));
    const strict = rules({ caps: { ...DEFAULT_RULES.caps, minPayout: "4" } });
    expect(paid(m, strict).b).toBe(0n);
  });
  it("lets the admin turn rules off and restrict them to a mode", () => {
    const off = rules({
      rank: { ...DEFAULT_RULES.rank, enabled: false },
      participation: { ...DEFAULT_RULES.participation, modes: "domination" },
    });
    expect(
      paid(match([entry(1, "a", { kills: 1 }), entry(2, "b")]), off),
    ).toEqual({
      a: micro("1"),
      b: 0n,
    });
  });
  it("validates admin input and fills missing fields from the defaults", () => {
    expect(normalizeRules({})).toEqual(DEFAULT_RULES);
    expect(() => rules({ playerKill: { amount: "-1" } })).toThrow(RuleError);
    expect(() => rules({ playerKill: { amount: "1.0000001" } })).toThrow(
      RuleError,
    );
    expect(() => rules({ rank: { amounts: Array(11).fill("1") } })).toThrow(
      RuleError,
    );
    expect(() => rules({ npc: { skillPercent: [1, 2] } })).toThrow(RuleError);
    expect(() => rules({ conditions: { minDuration: 9999 } })).toThrow(
      RuleError,
    );
    expect(rules({ playerKill: { amount: "2" } }).playerKill).toEqual({
      enabled: true,
      modes: "all",
      amount: "2",
    });
  });
  it("trims to the player and game daily caps", () => {
    expect(fitDailyCaps(micro("10"), micro("25"), 0n, DEFAULT_RULES)).toBe(
      micro("5"),
    );
    expect(fitDailyCaps(micro("10"), 0n, micro("148"), DEFAULT_RULES)).toBe(
      micro("2"),
    );
    expect(fitDailyCaps(micro("10"), micro("30"), 0n, DEFAULT_RULES)).toBe(0n);
  });
  it("previews recent matches oldest first with simulated daily caps", () => {
    const matches = [1, 2, 3].map((i) =>
      match([entry(1, "a", { kills: 9 }), entry(2, "b")], {
        endedAt: 1_000 * i,
      }),
    );
    const result = preview(DEFAULT_RULES, matches);
    // a earns 14.5 each match: 14.5 + 14.5 + 1 (30 daily cap).
    expect(result.players[0]).toEqual({ name: "a", amount: "30.000000" });
    expect(result.matches[0].players[0].note).toBe("일일 상한 적용");
    expect(result.total).toBe("40.500000");
  });
});

describe("automatic match rewards", () => {
  let fake: FakeMetanomic,
    store: AccountStore,
    queue: RewardQueue,
    auto: AutoRewards;
  const wallets = {
    a: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    b: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  };
  beforeEach(async () => {
    fake = new FakeMetanomic();
    const apiUrl = await fake.listen();
    store = new AccountStore(":memory:");
    for (const [id, wallet] of Object.entries(wallets))
      store.db
        .prepare(
          "INSERT INTO accounts(id,wallet,name,created_at) VALUES(?,?,?,?)",
        )
        .run(id, wallet, `함장 ${id}`, Date.now());
    const client = new MetanomicClient({
      apiUrl,
      gameId: fake.gameId,
      gameKey: fake.key,
      assetId: "common-game-credit",
    });
    queue = new RewardQueue(store.db, client);
    auto = new AutoRewards(store, queue, client);
  });
  afterEach(() => {
    fake.close();
    store.close();
  });
  const saved = (entries: MatchEntry[], mode = "deathmatch") =>
    store.saveMatch("ROOM", mode, entries, 480);

  it("pays each wallet captain once per match under a fixed reference", async () => {
    const m = saved([
      entry(1, "a", { kills: 2 }),
      entry(2, "b"),
      entry(3, null),
    ]);
    await auto.settle(m);
    await auto.settle(m);
    const rows = queue.list();
    expect(rows.map((r) => [r.id, r.amount]).sort()).toEqual([
      [`${RULE_PREFIX}${m.id}:a`, "7.500000"],
      [`${RULE_PREFIX}${m.id}:b`, "3.500000"],
    ]);
    await queue.tick();
    expect(queue.list().every((r) => r.status === "DONE")).toBe(true);
    expect(auto.forMatch(m.id).map((r) => r.status)).toEqual([
      "QUEUED",
      "QUEUED",
    ]);
  });
  it("stops at the daily cap per captain across matches", async () => {
    for (let i = 0; i < 3; i++)
      await auto.settle(saved([entry(1, "a", { kills: 9 }), entry(2, "b")]));
    const totals = queue.committedSince(RULE_PREFIX, 0).perAccount;
    expect(totals.get("a")).toBe(micro("30"));
    const last = auto.forMatches([3]).get(3)!;
    expect(last.find((r) => r.accountId === "a")?.note).toBe("일일 상한 적용");
  });
  it("does nothing while automatic payout is off", async () => {
    auto.saveRules({ ...DEFAULT_RULES, enabled: false });
    await auto.settle(saved([entry(1, "a"), entry(2, "b")]));
    expect(queue.list()).toEqual([]);
  });
  it("holds a match the budget cannot cover until the admin releases it", async () => {
    fake.budgetExceeded = true;
    const m = saved([entry(1, "a"), entry(2, "b")]);
    await auto.settle(m);
    expect(queue.list()).toEqual([]);
    expect(auto.heldCount()).toBe(1);
    fake.budgetExceeded = false;
    expect(auto.release(m.id)).toBe(2);
    expect(auto.heldCount()).toBe(0);
    expect(queue.list()).toHaveLength(2);
  });
  it("records why a whole match was skipped", async () => {
    const m = saved([entry(1, "a"), entry(2, null)]);
    store.db.prepare("UPDATE matches SET duration=10 WHERE id=?").run(m.id);
    await auto.settle({ ...m, duration: 10 });
    expect(auto.forMatch(m.id)).toMatchObject([
      { accountId: "*", status: "SKIPPED" },
    ]);
  });
});
