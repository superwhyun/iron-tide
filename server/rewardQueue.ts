import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Account } from "./accounts";
import { MetanomicError, type MetanomicClient } from "./metanomic";

/** PENDING: saved, not yet accepted. SUBMITTED: accepted, waiting for finality. */
export type RewardStatus = "PENDING" | "SUBMITTED" | "DONE" | "FAILED";
export interface RewardRow {
  id: string;
  accountId: string;
  wallet: string;
  name: string;
  amount: string;
  memo: string;
  matchId: number | null;
  status: RewardStatus;
  rewardId: string | null;
  operationId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const DECIMALS = 6;
const AMOUNT = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;
const POLL_INTERVAL_MS = 5000;
const BATCH = 20;
/** §9: the reference may already hold a reward, so never re-issue under a new one. */
export const REFERENCE_CONFLICTS = new Set([
  "IDEMPOTENCY_CONFLICT",
  "BUSINESS_REFERENCE_CONFLICT",
]);

/** Coin amounts as integer micro-units: never floating point (§9). */
export function toMicro(amount: string) {
  if (!AMOUNT.test(amount)) return null;
  const [whole, fraction = ""] = amount.split(".");
  const micro =
    BigInt(whole) * 10n ** 6n + BigInt(fraction.padEnd(DECIMALS, "0"));
  return micro > 0n ? micro : null;
}
export function fromMicro(micro: bigint) {
  const whole = micro / 10n ** 6n,
    fraction = (micro % 10n ** 6n).toString().padStart(DECIMALS, "0");
  return `${whole}.${fraction}`;
}

const rowOf = (r: Record<string, unknown>): RewardRow => ({
  id: String(r.id),
  accountId: String(r.account_id),
  wallet: String(r.wallet),
  name: String(r.name),
  amount: String(r.amount),
  memo: String(r.memo),
  matchId: r.match_id === null ? null : Number(r.match_id),
  status: r.status as RewardStatus,
  rewardId: r.reward_id == null ? null : String(r.reward_id),
  operationId: r.operation_id === null ? null : String(r.operation_id),
  error: r.error === null ? null : String(r.error),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

/**
 * Durable reward queue. Each reward is written (with its fixed request body)
 * before any network call, then sent to Metanomic with its rewardRef as the
 * idempotency key, so restarts and retries never pay twice.
 */
export class RewardQueue {
  private running = false;
  constructor(
    private db: DatabaseSync,
    private client: MetanomicClient | null,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rewards(
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        name TEXT NOT NULL,
        amount TEXT NOT NULL,
        memo TEXT NOT NULL,
        match_id INTEGER,
        status TEXT NOT NULL,
        operation_id TEXT,
        error TEXT,
        checked_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rewards_status ON rewards(status);
    `);
    // §8: keep Metanomic's rewardId; added after the first release.
    const columns = db.prepare("PRAGMA table_info(rewards)").all() as {
      name: string;
    }[];
    if (!columns.some((c) => c.name === "reward_id"))
      db.exec("ALTER TABLE rewards ADD COLUMN reward_id TEXT");
  }
  get connected() {
    return Boolean(this.client);
  }
  enqueue(
    recipients: Pick<Account, "id" | "wallet" | "name">[],
    amount: string,
    memo: string,
    matchId: number | null,
  ) {
    const micro = toMicro(amount);
    if (!micro) throw new Error("INVALID_AMOUNT");
    // Stored and resent in canonical form so every retry has the same body.
    const canonical = fromMicro(micro);
    const batch = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`,
      now = Date.now();
    const insert = this.db.prepare(
      `INSERT INTO rewards(id,account_id,wallet,name,amount,memo,match_id,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,'PENDING',?,?)`,
    );
    for (const a of recipients)
      insert.run(
        `iron-tide:${batch}:${a.id}`,
        a.id,
        a.wallet,
        a.name,
        canonical,
        memo,
        matchId,
        now,
        now,
      );
    return recipients.length;
  }
  /**
   * Rule rewards use a fixed reference per match and account, so a repeated
   * call (restart, double trigger) never creates a second reward.
   */
  enqueueFixed(
    id: string,
    recipient: Pick<Account, "id" | "wallet" | "name">,
    micro: bigint,
    memo: string,
    matchId: number,
  ) {
    const now = Date.now();
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO rewards(id,account_id,wallet,name,amount,memo,match_id,status,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,'PENDING',?,?)`,
        )
        .run(
          id,
          recipient.id,
          recipient.wallet,
          recipient.name,
          fromMicro(micro),
          memo,
          matchId,
          now,
          now,
        ).changes === 1
    );
  }
  /** Coins already committed since `since` for ids starting with `prefix`. */
  committedSince(prefix: string, since: number) {
    const perAccount = new Map<string, bigint>();
    let total = 0n;
    const rows = this.db
      .prepare(
        "SELECT account_id, amount FROM rewards WHERE status!='FAILED' AND created_at>=? AND substr(id,1,?)=?",
      )
      .all(since, prefix.length, prefix) as {
      account_id: string;
      amount: string;
    }[];
    for (const r of rows) {
      const m = toMicro(r.amount) ?? 0n;
      perAccount.set(r.account_id, (perAccount.get(r.account_id) ?? 0n) + m);
      total += m;
    }
    return { perAccount, total };
  }
  /** Saved but not yet accepted by Metanomic, so not yet in its reserved budget. */
  unsent() {
    const rows = this.db
      .prepare("SELECT amount FROM rewards WHERE status='PENDING'")
      .all() as { amount: string }[];
    return rows.reduce((n, r) => n + (toMicro(r.amount) ?? 0n), 0n);
  }
  list(limit = 100): RewardRow[] {
    return (
      this.db
        .prepare("SELECT * FROM rewards ORDER BY created_at DESC, id LIMIT ?")
        .all(limit) as Record<string, unknown>[]
    ).map(rowOf);
  }
  /** Coins per account: paid (finalized) and still on the way. */
  totals() {
    const totals = new Map<string, { paid: bigint; pending: bigint }>();
    const rows = this.db
      .prepare(
        "SELECT account_id, amount, status FROM rewards WHERE status!='FAILED'",
      )
      .all() as { account_id: string; amount: string; status: RewardStatus }[];
    for (const r of rows) {
      const t = totals.get(r.account_id) ?? { paid: 0n, pending: 0n };
      const micro = toMicro(r.amount) ?? 0n;
      if (r.status === "DONE") t.paid += micro;
      else t.pending += micro;
      totals.set(r.account_id, t);
    }
    return totals;
  }
  /**
   * A failed reward is re-issued as a new reward (new reference), never resent.
   * Reference conflicts are refused: that reward may already exist.
   */
  reissue(id: string) {
    const row = this.db
      .prepare("SELECT * FROM rewards WHERE id=? AND status='FAILED'")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return false;
    const old = rowOf(row);
    if (old.error && REFERENCE_CONFLICTS.has(old.error)) return false;
    this.enqueue(
      [{ id: old.accountId, wallet: old.wallet, name: old.name }],
      old.amount,
      old.memo,
      old.matchId,
    );
    return true;
  }
  private update(id: string, fields: Record<string, string | number | null>) {
    const keys = Object.keys(fields);
    this.db
      .prepare(
        `UPDATE rewards SET ${keys.map((k) => `${k}=?`).join(",")}, updated_at=? WHERE id=?`,
      )
      .run(...keys.map((k) => fields[k]), Date.now(), id);
  }
  /** One pass: submit pending rewards, then check operations in flight. */
  async tick() {
    if (!this.client || this.running) return;
    this.running = true;
    try {
      const pending = (
        this.db
          .prepare(
            "SELECT * FROM rewards WHERE status='PENDING' ORDER BY created_at LIMIT ?",
          )
          .all(BATCH) as Record<string, unknown>[]
      ).map(rowOf);
      for (const r of pending) await this.submit(r);
      const due = (
        this.db
          .prepare(
            "SELECT * FROM rewards WHERE status='SUBMITTED' AND checked_at<=? ORDER BY checked_at LIMIT ?",
          )
          .all(Date.now() - POLL_INTERVAL_MS, BATCH) as Record<
          string,
          unknown
        >[]
      ).map(rowOf);
      for (const r of due) await this.check(r);
    } finally {
      this.running = false;
    }
  }
  private async submit(r: RewardRow) {
    try {
      const receipt = await this.client!.reward({
        recipient: r.wallet,
        amount: r.amount,
        rewardRef: r.id,
      });
      this.update(r.id, {
        status: "SUBMITTED",
        reward_id: receipt.rewardId,
        operation_id: receipt.operationId,
        error: null,
        checked_at: 0,
      });
    } catch (error) {
      const e =
        error instanceof MetanomicError
          ? error
          : new MetanomicError(String(error), 0);
      // Unknown outcome: keep PENDING and resend the identical request later.
      if (e.transient) this.update(r.id, { error: e.message });
      else this.update(r.id, { status: "FAILED", error: e.code ?? e.message });
    }
  }
  private async check(r: RewardRow) {
    try {
      const { status } = await this.client!.operation(r.operationId!);
      if (status === "FINALIZED")
        this.update(r.id, { status: "DONE", error: null });
      else if (status === "FAILED")
        this.update(r.id, { status: "FAILED", error: "OPERATION_FAILED" });
      else this.update(r.id, { checked_at: Date.now() });
    } catch (error) {
      this.update(r.id, {
        checked_at: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
