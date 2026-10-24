import type { CombatLedger } from "./game";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const SESSION_HOURS = 8;

export interface Account {
  id: string;
  wallet: string;
  name: string;
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
  damage: number;
}
export interface MatchRecord {
  kills: number;
  deaths: number;
  damage: number;
  won: boolean;
}
/** What a signed message authorizes: a normal login or claiming the admin seat. */
export type ChallengePurpose = "login" | "admin";
export interface MatchEntry {
  /** Wallet account, or null for guests and NPCs. */
  accountId: string | null;
  name: string;
  hull: string;
  place: number;
  kills: number;
  deaths: number;
  damage: number;
  score: number;
  /** NPC skill 1–5; absent for people. */
  npcSkill?: number;
  /** Kills and damage split by victim type, for reward rules. */
  ledger?: CombatLedger;
}
export interface MatchSummary {
  id: number;
  room: string;
  mode: string;
  endedAt: number;
  /** Battle length in seconds (0 for matches saved before it was recorded). */
  duration: number;
  entries: MatchEntry[];
}
export interface Challenge {
  id: string;
  purpose: ChallengePurpose;
  address: string;
  message: string;
  origin: string;
  chainId: number;
  expiresAt: number;
}

export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const opaqueToken = () => randomBytes(32).toString("hex");

/**
 * Wallet accounts, login challenges and sessions. Session tokens are stored
 * hashed; the raw token only ever lives in the player's HttpOnly cookie.
 */
export class AccountStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS accounts(
        id TEXT PRIMARY KEY,
        wallet TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        matches INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        kills INTEGER NOT NULL DEFAULT 0,
        deaths INTEGER NOT NULL DEFAULT 0,
        damage INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallet_challenges(
        id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        message TEXT NOT NULL,
        origin TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions(
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS matches(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL,
        mode TEXT NOT NULL,
        ended_at INTEGER NOT NULL,
        entries TEXT NOT NULL
      );
    `);
    // Databases created before admin sign-in existed lack the purpose column.
    const columns = this.db
      .prepare("PRAGMA table_info(wallet_challenges)")
      .all() as { name: string }[];
    if (!columns.some((c) => c.name === "purpose"))
      this.db.exec(
        "ALTER TABLE wallet_challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login'",
      );
    const matchColumns = this.db
      .prepare("PRAGMA table_info(matches)")
      .all() as { name: string }[];
    if (!matchColumns.some((c) => c.name === "duration"))
      this.db.exec(
        "ALTER TABLE matches ADD COLUMN duration REAL NOT NULL DEFAULT 0",
      );
  }
  close() {
    this.db.close();
  }
  saveChallenge(c: Challenge) {
    const now = Date.now();
    this.db
      .prepare("DELETE FROM wallet_challenges WHERE expires_at<=? OR used=1")
      .run(now);
    this.db
      .prepare(
        `INSERT INTO wallet_challenges(id,address,message,origin,chain_id,expires_at,purpose)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        c.id,
        c.address,
        c.message,
        c.origin,
        c.chainId,
        c.expiresAt,
        c.purpose,
      );
  }
  pendingChallenge(id: string): Challenge | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM wallet_challenges WHERE id=? AND used=0 AND expires_at>?",
      )
      .get(id, Date.now()) as Record<string, string | number> | undefined;
    return row
      ? {
          id: String(row.id),
          purpose: row.purpose === "admin" ? "admin" : "login",
          address: String(row.address),
          message: String(row.message),
          origin: String(row.origin),
          chainId: Number(row.chain_id),
          expiresAt: Number(row.expires_at),
        }
      : undefined;
  }
  /**
   * Consumes a verified challenge exactly once and opens a session for its
   * wallet, creating the account on first login. Returns null if the
   * challenge was already used or expired in the meantime.
   */
  consumeChallenge(id: string, address: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used = this.db
        .prepare(
          "UPDATE wallet_challenges SET used=1 WHERE id=? AND used=0 AND expires_at>?",
        )
        .run(id, Date.now());
      if (used.changes !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      let account = this.byWallet(address);
      if (!account) {
        this.db
          .prepare(
            "INSERT INTO accounts(id,wallet,name,created_at) VALUES(?,?,?,?)",
          )
          .run(
            `acct-${randomBytes(8).toString("hex")}`,
            address,
            `함장 ${address.slice(2, 6)}`,
            Date.now(),
          );
        account = this.byWallet(address)!;
      }
      const token = opaqueToken(),
        expiresAt = Date.now() + SESSION_HOURS * 3600_000;
      this.db
        .prepare("INSERT INTO sessions VALUES(?,?,?)")
        .run(hashToken(token), account.id, expiresAt);
      this.db.exec("COMMIT");
      return { token, account, expiresAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private byWallet(address: string) {
    return this.db
      .prepare("SELECT * FROM accounts WHERE wallet=? COLLATE NOCASE")
      .get(address) as Account | undefined;
  }
  accountForToken(token: string | undefined): Account | undefined {
    if (!token) return undefined;
    return this.db
      .prepare(
        `SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.account_id
         WHERE s.token_hash=? AND s.expires_at>?`,
      )
      .get(hashToken(token), Date.now()) as Account | undefined;
  }
  endSession(token: string) {
    this.db
      .prepare("DELETE FROM sessions WHERE token_hash=?")
      .run(hashToken(token));
  }
  rename(accountId: string, name: string) {
    this.db
      .prepare("UPDATE accounts SET name=? WHERE id=?")
      .run(name, accountId);
  }
  recordMatch(accountId: string, r: MatchRecord) {
    this.db
      .prepare(
        `UPDATE accounts SET matches=matches+1, wins=wins+?, kills=kills+?,
         deaths=deaths+?, damage=damage+? WHERE id=?`,
      )
      .run(r.won ? 1 : 0, r.kills, r.deaths, Math.round(r.damage), accountId);
  }
  accounts(): Account[] {
    return this.db
      .prepare("SELECT * FROM accounts ORDER BY created_at")
      .all() as unknown as Account[];
  }
  setting(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }
  /** Writes a setting only if absent; returns false when it already existed. */
  claimSetting(key: string, value: string) {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO settings VALUES(?,?)")
        .run(key, value).changes === 1
    );
  }
  putSetting(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  saveMatch(
    room: string,
    mode: string,
    entries: MatchEntry[],
    duration = 0,
  ): MatchSummary {
    const endedAt = Date.now();
    const id = Number(
      this.db
        .prepare(
          "INSERT INTO matches(room,mode,ended_at,entries,duration) VALUES(?,?,?,?,?)",
        )
        .run(room, mode, endedAt, JSON.stringify(entries), duration)
        .lastInsertRowid,
    );
    return { id, room, mode, endedAt, duration, entries };
  }
  recentMatches(limit = 30): MatchSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM matches ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, string | number>[];
    return rows.map((r) => ({
      id: Number(r.id),
      room: String(r.room),
      mode: String(r.mode),
      endedAt: Number(r.ended_at),
      duration: Number(r.duration ?? 0),
      entries: JSON.parse(String(r.entries)) as MatchEntry[],
    }));
  }
  account(id: string) {
    return this.db.prepare("SELECT * FROM accounts WHERE id=?").get(id) as
      Account | undefined;
  }
}
