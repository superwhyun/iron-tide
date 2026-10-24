import type { DatabaseSync } from "node:sqlite";
import type { AccountStore, MatchSummary } from "./accounts";
import type { MetanomicClient } from "./metanomic";
import { fromMicro, toMicro, type RewardQueue } from "./rewardQueue";
import {
  computeMatchRewards,
  DEFAULT_RULES,
  fitDailyCaps,
  normalizeRules,
  type RewardItem,
  type RewardRules,
} from "./rewardRules";

const RULES_KEY = "reward_rules";
export const RULE_PREFIX = "iron-tide:match:";
/** Whole-match row (skipped matches) uses this account id. */
const MATCH_ROW = "*";

/** QUEUED: handed to the reward queue. HELD: budget short, admin releases. */
export type MatchRewardStatus = "QUEUED" | "HELD" | "SKIPPED";
export interface MatchRewardRow {
  matchId: number;
  accountId: string;
  name: string;
  earned: string;
  amount: string;
  items: RewardItem[];
  status: MatchRewardStatus;
  note: string | null;
}

export function startOfDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Applies the admin's reward rules to every finished match and hands the
 * results to the reward queue. Matches are processed one at a time so the
 * daily caps and budget check never race. The server's reward timer sends
 * what this queues.
 */
export class AutoRewards {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private store: AccountStore,
    private queue: RewardQueue,
    private metanomic: MetanomicClient | null,
    private db: DatabaseSync = store.db,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS match_rewards(
        match_id INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        earned TEXT NOT NULL,
        amount TEXT NOT NULL,
        items TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(match_id, account_id)
      );
    `);
  }
  rules(): RewardRules {
    const saved = this.store.setting(RULES_KEY);
    if (!saved) return DEFAULT_RULES;
    try {
      return normalizeRules(JSON.parse(saved));
    } catch (error) {
      console.error("저장된 보상 규칙을 읽지 못해 기본값을 씁니다:", error);
      return DEFAULT_RULES;
    }
  }
  saveRules(input: unknown) {
    const rules = normalizeRules(input);
    this.store.putSetting(RULES_KEY, JSON.stringify(rules));
    return rules;
  }
  /** Queues `match` behind any match still being processed. */
  settle(match: MatchSummary) {
    const run = this.chain.then(() => this.process(match));
    this.chain = run.catch((error) =>
      console.error(`경기 #${match.id} 보상 처리 실패:`, error),
    );
    return run;
  }
  private save(
    matchId: number,
    accountId: string,
    name: string,
    earned: bigint,
    amount: bigint,
    items: RewardItem[],
    status: MatchRewardStatus,
    note: string | null,
  ) {
    this.db
      .prepare("INSERT OR REPLACE INTO match_rewards VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        matchId,
        accountId,
        name,
        fromMicro(earned),
        fromMicro(amount),
        JSON.stringify(items),
        status,
        note,
        Date.now(),
      );
  }
  private async process(match: MatchSummary) {
    const rules = this.rules();
    if (!rules.enabled) return;
    const result = computeMatchRewards(match, rules);
    if (result.skipped) {
      this.save(match.id, MATCH_ROW, "", 0n, 0n, [], "SKIPPED", result.skipped);
      return;
    }
    const { perAccount, total } = this.queue.committedSince(
      RULE_PREFIX,
      startOfDay(),
    );
    let used = total;
    const plan = result.players.map((p) => {
      let amount = p.payable,
        note = p.note ?? null;
      if (amount > 0n) {
        const fit = fitDailyCaps(
          amount,
          perAccount.get(p.accountId) ?? 0n,
          used,
          rules,
        );
        if (fit < amount) note = fit > 0n ? "일일 상한 적용" : "일일 상한 도달";
        amount = fit;
      }
      used += amount;
      return { ...p, amount, note };
    });
    const due = plan.reduce((n, p) => n + p.amount, 0n);
    const held = due > 0n && !(await this.budgetCovers(due));
    for (const p of plan) {
      const account = this.store.account(p.accountId);
      if (p.amount === 0n || !account) {
        this.save(
          match.id,
          p.accountId,
          p.name,
          p.earned,
          0n,
          p.items,
          "SKIPPED",
          p.note ?? "지급액 없음",
        );
        continue;
      }
      if (held) {
        this.save(
          match.id,
          p.accountId,
          p.name,
          p.earned,
          p.amount,
          p.items,
          "HELD",
          "예산 부족으로 보류",
        );
        continue;
      }
      this.queue.enqueueFixed(
        `${RULE_PREFIX}${match.id}:${p.accountId}`,
        account,
        p.amount,
        `경기 #${match.id} 자동 보상`,
        match.id,
      );
      this.save(
        match.id,
        p.accountId,
        p.name,
        p.earned,
        p.amount,
        p.items,
        "QUEUED",
        p.note,
      );
    }
  }
  /**
   * Unknown budget (network error) does not block: the contract still refuses
   * an overdraft and the reward shows as failed.
   */
  private async budgetCovers(amount: bigint) {
    if (!this.metanomic) return true;
    try {
      const { available } = await this.metanomic.budget();
      if (available === undefined) return true;
      return (toMicro(available) ?? 0n) - this.queue.unsent() >= amount;
    } catch {
      return true;
    }
  }
  /** Releases a match's held rewards to the queue (admin decision). */
  release(matchId: number) {
    const rows = this.forMatch(matchId).filter((r) => r.status === "HELD");
    for (const r of rows) {
      const account = this.store.account(r.accountId);
      if (!account) continue;
      this.queue.enqueueFixed(
        `${RULE_PREFIX}${matchId}:${r.accountId}`,
        account,
        toMicro(r.amount) ?? 0n,
        `경기 #${matchId} 자동 보상`,
        matchId,
      );
      this.db
        .prepare(
          "UPDATE match_rewards SET status='QUEUED', note='관리자 승인' WHERE match_id=? AND account_id=?",
        )
        .run(matchId, r.accountId);
    }
    return rows.length;
  }
  forMatch(matchId: number): MatchRewardRow[] {
    return this.rows("WHERE match_id=?", matchId);
  }
  /** Reward rows for the given matches, grouped by match id. */
  forMatches(ids: number[]) {
    const byMatch = new Map<number, MatchRewardRow[]>();
    if (!ids.length) return byMatch;
    for (const r of this.rows(
      `WHERE match_id IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    ))
      byMatch.set(r.matchId, [...(byMatch.get(r.matchId) ?? []), r]);
    return byMatch;
  }
  heldCount() {
    return (
      this.db
        .prepare(
          "SELECT COUNT(DISTINCT match_id) AS n FROM match_rewards WHERE status='HELD'",
        )
        .get() as { n: number }
    ).n;
  }
  private rows(where: string, ...params: number[]): MatchRewardRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM match_rewards ${where} ORDER BY match_id DESC`)
        .all(...params) as Record<string, string | number | null>[]
    ).map((r) => ({
      matchId: Number(r.match_id),
      accountId: String(r.account_id),
      name: String(r.name),
      earned: String(r.earned),
      amount: String(r.amount),
      items: JSON.parse(String(r.items)) as RewardItem[],
      status: r.status as MatchRewardStatus,
      note: r.note === null ? null : String(r.note),
    }));
  }
}
