import type { MatchEntry, MatchSummary } from "./accounts";
import { fromMicro } from "./rewardQueue";

/** Which match modes a rule pays in. */
export type ModeScope = "all" | "deathmatch" | "domination";
interface Rule {
  enabled: boolean;
  modes: ModeScope;
}
export interface RewardRules {
  /** Master switch: pay automatically when a match ends. */
  enabled: boolean;
  /** CGC per place among people (index 0 = 1st). */
  rank: Rule & { amounts: string[]; minWallets: number };
  playerKill: Rule & { amount: string };
  /** NPC kills and damage pay `share`% of the player rate, times the skill percent. */
  npc: { enabled: boolean; share: number; skillPercent: number[] };
  damage: Rule & { amount: string; per: number };
  domination: Rule & { amount: string; per: number };
  survival: Rule & { amount: string; minWallets: number };
  participation: Rule & { amount: string };
  conditions: { minWallets: number; minDuration: number };
  caps: {
    perMatch: string;
    perPlayerDaily: string;
    dailyTotal: string;
    minPayout: string;
  };
}

export const DEFAULT_RULES: RewardRules = {
  enabled: true,
  rank: {
    enabled: true,
    modes: "all",
    amounts: ["5", "3", "1"],
    minWallets: 2,
  },
  playerKill: { enabled: true, modes: "all", amount: "1" },
  npc: { enabled: true, share: 20, skillPercent: [10, 25, 50, 75, 100] },
  damage: { enabled: true, modes: "all", amount: "0.2", per: 10000 },
  domination: { enabled: true, modes: "domination", amount: "0.3", per: 100 },
  survival: { enabled: true, modes: "all", amount: "1", minWallets: 2 },
  participation: { enabled: true, modes: "all", amount: "0.5" },
  conditions: { minWallets: 1, minDuration: 120 },
  caps: {
    perMatch: "15",
    perPlayerDaily: "30",
    dailyTotal: "150",
    minPayout: "0.1",
  },
};

export class RuleError extends Error {}

const AMOUNT = /^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/;
/** Decimal CGC string → micro-units; zero allowed (a rule may pay nothing). */
export function micro(amount: string) {
  if (!AMOUNT.test(amount)) throw new RuleError(`금액 형식 오류: ${amount}`);
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
function amountOf(v: unknown, label: string, fallback: string) {
  const text = v === undefined ? fallback : String(v).trim();
  if (!AMOUNT.test(text))
    throw new RuleError(
      `${label}: 0 이상, 소수점 6자리 이하 숫자로 입력하세요.`,
    );
  return text;
}
function intOf(
  v: unknown,
  label: string,
  fallback: number,
  min: number,
  max: number,
) {
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new RuleError(`${label}: ${min}–${max} 사이 정수로 입력하세요.`);
  return n;
}
const bool = (v: unknown, fallback: boolean) =>
  typeof v === "boolean" ? v : fallback;
function scope(v: unknown, fallback: ModeScope): ModeScope {
  if (v === undefined) return fallback;
  if (v === "all" || v === "deathmatch" || v === "domination") return v;
  throw new RuleError("적용 경기 방식이 올바르지 않습니다.");
}
function rule<T extends Rule>(input: unknown, base: T) {
  const v = isObject(input) ? input : {};
  return {
    v,
    enabled: bool(v.enabled, base.enabled),
    modes: scope(v.modes, base.modes),
  };
}

/** Validates admin input; missing fields fall back to the defaults. */
export function normalizeRules(input: unknown): RewardRules {
  if (!isObject(input)) throw new RuleError("규칙 형식이 올바르지 않습니다.");
  const d = DEFAULT_RULES;
  const rank = rule(input.rank, d.rank);
  const amounts = Array.isArray(rank.v.amounts)
    ? rank.v.amounts
    : d.rank.amounts;
  if (amounts.length > 10)
    throw new RuleError("순위 보상은 10위까지 정할 수 있습니다.");
  const kill = rule(input.playerKill, d.playerKill);
  const npc = isObject(input.npc) ? input.npc : {};
  const percents = Array.isArray(npc.skillPercent)
    ? npc.skillPercent
    : d.npc.skillPercent;
  if (percents.length !== 5)
    throw new RuleError("NPC 지능별 비율은 1–5단계 다섯 개입니다.");
  const damage = rule(input.damage, d.damage);
  const dom = rule(input.domination, d.domination);
  const survival = rule(input.survival, d.survival);
  const join = rule(input.participation, d.participation);
  const cond = isObject(input.conditions) ? input.conditions : {};
  const caps = isObject(input.caps) ? input.caps : {};
  return {
    enabled: bool(input.enabled, d.enabled),
    rank: {
      enabled: rank.enabled,
      modes: rank.modes,
      amounts: amounts.map((a, i) => amountOf(a, `${i + 1}위 보상`, "0")),
      minWallets: intOf(
        rank.v.minWallets,
        "순위 보상 최소 인원",
        d.rank.minWallets,
        1,
        4,
      ),
    },
    playerKill: {
      enabled: kill.enabled,
      modes: kill.modes,
      amount: amountOf(kill.v.amount, "플레이어 격침", d.playerKill.amount),
    },
    npc: {
      enabled: bool(npc.enabled, d.npc.enabled),
      share: intOf(npc.share, "NPC 보상 비율", d.npc.share, 0, 100),
      skillPercent: percents.map((p, i) =>
        intOf(p, `NPC 지능 ${i + 1} 비율`, 0, 0, 100),
      ),
    },
    damage: {
      enabled: damage.enabled,
      modes: damage.modes,
      amount: amountOf(damage.v.amount, "피해량 보상", d.damage.amount),
      per: intOf(damage.v.per, "피해량 기준", d.damage.per, 1, 1_000_000),
    },
    domination: {
      enabled: dom.enabled,
      modes: dom.modes,
      amount: amountOf(dom.v.amount, "거점 점수 보상", d.domination.amount),
      per: intOf(dom.v.per, "거점 점수 기준", d.domination.per, 1, 10_000),
    },
    survival: {
      enabled: survival.enabled,
      modes: survival.modes,
      amount: amountOf(survival.v.amount, "무침몰 보너스", d.survival.amount),
      minWallets: intOf(
        survival.v.minWallets,
        "무침몰 최소 인원",
        d.survival.minWallets,
        1,
        4,
      ),
    },
    participation: {
      enabled: join.enabled,
      modes: join.modes,
      amount: amountOf(join.v.amount, "참가 보상", d.participation.amount),
    },
    conditions: {
      minWallets: intOf(
        cond.minWallets,
        "최소 지갑 함장 수",
        d.conditions.minWallets,
        1,
        4,
      ),
      minDuration: intOf(
        cond.minDuration,
        "최소 경기 시간",
        d.conditions.minDuration,
        0,
        480,
      ),
    },
    caps: {
      perMatch: amountOf(caps.perMatch, "경기당 1인 상한", d.caps.perMatch),
      perPlayerDaily: amountOf(
        caps.perPlayerDaily,
        "1인 일일 상한",
        d.caps.perPlayerDaily,
      ),
      dailyTotal: amountOf(
        caps.dailyTotal,
        "게임 전체 일일 상한",
        d.caps.dailyTotal,
      ),
      minPayout: amountOf(caps.minPayout, "최소 지급액", d.caps.minPayout),
    },
  };
}

export interface RewardItem {
  label: string;
  amount: string;
}
export interface PlayerReward {
  accountId: string;
  name: string;
  /** Sum of all rules before caps. */
  earned: bigint;
  /** What will be paid after the per-match cap and minimum. */
  payable: bigint;
  items: RewardItem[];
  note?: string;
}
export interface MatchRewards {
  matchId: number;
  /** Set when the whole match pays nothing. */
  skipped?: string;
  players: PlayerReward[];
}

const applies = (r: Rule, mode: string) =>
  r.enabled && (r.modes === "all" || r.modes === mode);
const count = (n: number) => Math.round(n).toLocaleString("ko-KR");

function entryItems(
  e: MatchEntry,
  humanPlace: number,
  wallets: number,
  mode: string,
  rules: RewardRules,
) {
  const items: { label: string; micro: bigint }[] = [];
  const add = (label: string, value: bigint) => {
    if (value > 0n) items.push({ label, micro: value });
  };
  const ledger = e.ledger!;
  const npcRate = (skill: number) =>
    rules.npc.enabled
      ? BigInt(rules.npc.share * rules.npc.skillPercent[skill])
      : 0n;
  const rankAmount = rules.rank.amounts[humanPlace - 1];
  if (
    applies(rules.rank, mode) &&
    rankAmount &&
    wallets >= rules.rank.minWallets
  )
    add(`${humanPlace}위`, micro(rankAmount));
  if (applies(rules.playerKill, mode)) {
    const each = micro(rules.playerKill.amount);
    add(
      `플레이어 격침 ${ledger.player.kills}척`,
      each * BigInt(ledger.player.kills),
    );
    ledger.npc.kills.forEach((n, skill) =>
      add(
        `NPC 격침 (지능 ${skill + 1}) ${n}척`,
        (each * BigInt(n) * npcRate(skill)) / 10_000n,
      ),
    );
  }
  if (applies(rules.damage, mode)) {
    const rate = micro(rules.damage.amount),
      per = BigInt(rules.damage.per);
    const player = BigInt(Math.floor(ledger.player.damage));
    add(`피해량 ${count(ledger.player.damage)}`, (player * rate) / per);
    ledger.npc.damage.forEach((d, skill) =>
      add(
        `NPC 피해 (지능 ${skill + 1}) ${count(d)}`,
        (BigInt(Math.floor(d)) * rate * npcRate(skill)) / per / 10_000n,
      ),
    );
  }
  if (mode === "domination" && applies(rules.domination, mode))
    add(
      `거점 ${e.score}점`,
      (BigInt(Math.floor(e.score)) * micro(rules.domination.amount)) /
        BigInt(rules.domination.per),
    );
  if (
    applies(rules.survival, mode) &&
    e.deaths === 0 &&
    wallets >= rules.survival.minWallets
  )
    add("무침몰", micro(rules.survival.amount));
  if (applies(rules.participation, mode))
    add("참가", micro(rules.participation.amount));
  return items;
}

/** Rewards one finished match earns under `rules`, before daily caps. */
export function computeMatchRewards(
  match: MatchSummary,
  rules: RewardRules,
): MatchRewards {
  const result: MatchRewards = { matchId: match.id, players: [] };
  const people = match.entries
    .filter((e) => e.npcSkill === undefined)
    .sort((a, b) => a.place - b.place);
  const wallets = people.filter((e) => e.accountId).length;
  if (people.some((e) => e.accountId && !e.ledger))
    result.skipped = "보상 기록 이전의 경기입니다.";
  else if (match.duration < rules.conditions.minDuration)
    result.skipped = `경기 시간이 ${rules.conditions.minDuration}초보다 짧습니다.`;
  else if (wallets < rules.conditions.minWallets)
    result.skipped = `지갑 함장이 ${rules.conditions.minWallets}명보다 적습니다.`;
  if (result.skipped) return result;
  const perMatch = micro(rules.caps.perMatch),
    minimum = micro(rules.caps.minPayout);
  people.forEach((e, i) => {
    if (!e.accountId) return;
    const items = entryItems(e, i + 1, wallets, match.mode, rules);
    const earned = items.reduce((n, item) => n + item.micro, 0n);
    let payable = earned < perMatch ? earned : perMatch,
      note: string | undefined;
    if (earned > perMatch) note = "경기당 상한 적용";
    if (payable < minimum) {
      payable = 0n;
      note = earned > 0n ? "최소 지급액 미만" : undefined;
    }
    result.players.push({
      accountId: e.accountId,
      name: e.name,
      earned,
      payable,
      items: items.map((x) => ({ label: x.label, amount: fromMicro(x.micro) })),
      note,
    });
  });
  return result;
}

/** Remaining daily room: trims `amount` to both caps; 0 when nothing fits. */
export function fitDailyCaps(
  amount: bigint,
  paidToPlayer: bigint,
  paidTotal: bigint,
  rules: RewardRules,
) {
  const room = (cap: string, used: bigint) => {
    const left = micro(cap) - used;
    return left > 0n ? left : 0n;
  };
  let fit = amount;
  const player = room(rules.caps.perPlayerDaily, paidToPlayer),
    total = room(rules.caps.dailyTotal, paidTotal);
  if (fit > player) fit = player;
  if (fit > total) fit = total;
  return fit < micro(rules.caps.minPayout) ? 0n : fit;
}
