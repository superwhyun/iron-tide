import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { SESSION_HOURS, type AccountStore } from "./accounts";
import { AuthError, type WalletAuth } from "./walletAuth";
import { fromMicro, type RewardQueue } from "./rewardQueue";
import type { MetanomicClient } from "./metanomic";
import { startOfDay, type AutoRewards } from "./autoRewards";
import {
  computeMatchRewards,
  DEFAULT_RULES,
  fitDailyCaps,
  normalizeRules,
  RuleError,
  type RewardRules,
} from "./rewardRules";
import type { MatchSummary } from "./accounts";
import {
  createLimiter,
  json,
  readCookie,
  readJson,
  sameOrigin,
  sendError,
  SESSION_COOKIE,
  sessionCookie,
} from "./authRoutes";

const ADMIN_WALLET = "admin_wallet";
const MAX_RECIPIENTS = 100;
const MEMO_LIMIT = 80;

/**
 * One-time code that lets whoever started the server claim the admin seat.
 * Printed to the server terminal only; cleared once an admin exists.
 */
export class AdminSetup {
  code: string | null;
  constructor(store: AccountStore, preset = process.env.ADMIN_SETUP_CODE) {
    this.code = store.setting(ADMIN_WALLET)
      ? null
      : (preset ??
        randomBytes(4)
          .toString("hex")
          .toUpperCase()
          .replace(/(.{4})/, "$1-"));
  }
  matches(input: unknown) {
    if (!this.code || typeof input !== "string") return false;
    const a = Buffer.from(input.trim().toUpperCase()),
      b = Buffer.from(this.code.toUpperCase());
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

const deny = (status: number, code: string, message: string) =>
  new AuthError(status, code, message);

export function createAdminRoutes(
  store: AccountStore,
  auth: WalletAuth,
  setup: AdminSetup,
  rewards: RewardQueue,
  metanomic: MetanomicClient | null,
  auto: AutoRewards,
) {
  const limit = createLimiter(10);
  const adminWallet = () => store.setting(ADMIN_WALLET);
  function adminOf(req: IncomingMessage) {
    const account = store.accountForToken(
      readCookie(req.headers.cookie, SESSION_COOKIE),
    );
    const wallet = adminWallet();
    return account &&
      wallet &&
      account.wallet.toLowerCase() === wallet.toLowerCase()
      ? account
      : undefined;
  }
  async function overview() {
    let budget: unknown = null,
      budgetError: string | null = null;
    if (metanomic)
      try {
        budget = await metanomic.budget();
      } catch (error) {
        budgetError = error instanceof Error ? error.message : String(error);
      }
    // Read all local state after the network call so totals and history agree.
    const totals = rewards.totals();
    return {
      players: store.accounts().map((a) => {
        const t = totals.get(a.id);
        return {
          id: a.id,
          wallet: a.wallet,
          name: a.name,
          matches: a.matches,
          wins: a.wins,
          kills: a.kills,
          deaths: a.deaths,
          damage: a.damage,
          paid: fromMicro(t?.paid ?? 0n),
          pending: fromMicro(t?.pending ?? 0n),
        };
      }),
      matches: withRewards(store.recentMatches()),
      heldMatches: auto.heldCount(),
      autoEnabled: auto.rules().enabled,
      rewards: rewards.list(),
      budget,
      budgetError,
    };
  }
  function withRewards(matches: MatchSummary[]) {
    const rows = auto.forMatches(matches.map((m) => m.id));
    return matches.map((m) => ({ ...m, rewards: rows.get(m.id) ?? [] }));
  }
  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/admin/")) return false;
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === "GET /api/admin/status") {
        const admin = adminOf(req);
        json(res, 200, {
          hasAdmin: Boolean(adminWallet()),
          isAdmin: Boolean(admin),
          wallet: admin?.wallet ?? null,
          metanomic: metanomic
            ? {
                connected: true,
                gameId: metanomic.config.gameId,
                assetId: metanomic.config.assetId,
              }
            : { connected: false },
        });
        return true;
      }
      // Browsers omit Origin on same-origin GETs; only state changes need it.
      const origin = sameOrigin(req);
      if (!origin && req.method !== "GET")
        throw deny(403, "ORIGIN_DENIED", "허용되지 않은 요청입니다.");
      if (route === "POST /api/admin/setup/challenge") {
        limit(req);
        const body = await readJson(req);
        if (adminWallet())
          throw deny(409, "ADMIN_EXISTS", "이미 관리자가 등록되었습니다.");
        if (!setup.matches(body.setupCode))
          throw deny(
            403,
            "INVALID_SETUP_CODE",
            "등록 코드가 맞지 않습니다. 서버 터미널에 출력된 코드를 입력하세요.",
          );
        json(res, 200, auth.challenge(body.address, origin!, "admin"));
        return true;
      }
      if (route === "POST /api/admin/setup") {
        limit(req);
        const body = await readJson(req);
        if (!setup.matches(body.setupCode))
          throw deny(403, "INVALID_SETUP_CODE", "등록 코드가 맞지 않습니다.");
        const session = await auth.finish(
          body.challengeId,
          body.signature,
          origin!,
          "admin",
        );
        // First signature wins atomically; a racing second claim is refused.
        if (!store.claimSetting(ADMIN_WALLET, session.account.wallet)) {
          store.endSession(session.token);
          throw deny(409, "ADMIN_EXISTS", "이미 관리자가 등록되었습니다.");
        }
        setup.code = null;
        console.log(`관리자 지갑 등록: ${session.account.wallet}`);
        json(
          res,
          200,
          { wallet: session.account.wallet },
          sessionCookie(session.token, origin!, SESSION_HOURS * 3600),
        );
        return true;
      }
      const admin = adminOf(req);
      if (!admin) throw deny(403, "NOT_ADMIN", "관리자 지갑으로 로그인하세요.");
      if (route === "GET /api/admin/overview") {
        json(res, 200, await overview());
        return true;
      }
      if (route === "POST /api/admin/rewards") {
        const body = await readJson(req);
        const ids = Array.isArray(body.accountIds)
          ? [
              ...new Set(
                body.accountIds.filter(
                  (v): v is string => typeof v === "string",
                ),
              ),
            ]
          : [];
        if (!ids.length || ids.length > MAX_RECIPIENTS)
          throw deny(
            422,
            "INVALID_RECIPIENTS",
            `받을 플레이어를 1–${MAX_RECIPIENTS}명 선택하세요.`,
          );
        const recipients = ids.map((id) => store.account(id));
        if (recipients.some((a) => !a))
          throw deny(
            422,
            "INVALID_RECIPIENTS",
            "없는 플레이어가 포함되었습니다.",
          );
        const memo =
          typeof body.memo === "string"
            ? body.memo.trim().slice(0, MEMO_LIMIT)
            : "";
        const matchId = Number.isInteger(body.matchId)
          ? Number(body.matchId)
          : null;
        try {
          rewards.enqueue(
            recipients.map((a) => a!),
            String(body.amount ?? ""),
            memo,
            matchId,
          );
        } catch {
          throw deny(
            422,
            "INVALID_AMOUNT",
            "금액은 0보다 크고 소수점 6자리 이하인 숫자여야 합니다.",
          );
        }
        void rewards.tick();
        json(res, 200, await overview());
        return true;
      }
      if (route === "GET /api/admin/rules") {
        json(res, 200, { rules: auto.rules(), defaults: DEFAULT_RULES });
        return true;
      }
      if (route === "PUT /api/admin/rules") {
        const body = await readJson(req);
        const rules = auto.saveRules(body.rules);
        console.log(
          `보상 규칙 변경: 자동 지급 ${rules.enabled ? "켜짐" : "꺼짐"} (${admin.wallet})`,
        );
        json(res, 200, { rules });
        return true;
      }
      if (route === "POST /api/admin/rules/preview") {
        const body = await readJson(req);
        json(
          res,
          200,
          preview(normalizeRules(body.rules), store.recentMatches()),
        );
        return true;
      }
      const release = url.pathname.match(
        /^\/api\/admin\/match-rewards\/(\d+)\/release$/,
      );
      if (req.method === "POST" && release) {
        if (!auto.release(Number(release[1])))
          throw deny(409, "NOTHING_HELD", "보류된 보상이 없습니다.");
        void rewards.tick();
        json(res, 200, await overview());
        return true;
      }
      const reissue = url.pathname.match(
        /^\/api\/admin\/rewards\/([^/]+)\/reissue$/,
      );
      if (req.method === "POST" && reissue) {
        if (!rewards.reissue(decodeURIComponent(reissue[1])))
          throw deny(
            409,
            "NOT_REISSUABLE",
            "실패한 지급만 다시 보낼 수 있습니다. 요청 참조 충돌은 Metanomic에서 기존 보상을 먼저 확인하세요.",
          );
        void rewards.tick();
        json(res, 200, await overview());
        return true;
      }
      throw deny(404, "NOT_FOUND", "없는 경로입니다.");
    } catch (error) {
      if (error instanceof RuleError)
        return (
          json(res, 422, {
            error: { code: "INVALID_RULES", message: error.message },
          }),
          true
        );
      sendError(res, error);
    }
    return true;
  };
}

/**
 * What `rules` would have paid over `matches`, oldest first, with the daily
 * caps simulated from zero. Nothing is stored or sent.
 */
export function preview(rules: RewardRules, matches: MatchSummary[]) {
  const days = new Map<
    number,
    { total: bigint; players: Map<string, bigint> }
  >();
  let total = 0n,
    paidMatches = 0;
  const perPlayer = new Map<string, { name: string; amount: bigint }>();
  const result = [...matches]
    .sort((a, b) => a.endedAt - b.endedAt)
    .map((m) => {
      const r = computeMatchRewards(m, rules);
      const day = startOfDay(m.endedAt);
      const used = days.get(day) ?? { total: 0n, players: new Map() };
      days.set(day, used);
      const players = r.players.map((p) => {
        const amount = fitDailyCaps(
          p.payable,
          used.players.get(p.accountId) ?? 0n,
          used.total,
          rules,
        );
        used.total += amount;
        used.players.set(
          p.accountId,
          (used.players.get(p.accountId) ?? 0n) + amount,
        );
        total += amount;
        const sum = perPlayer.get(p.accountId) ?? { name: p.name, amount: 0n };
        perPlayer.set(p.accountId, {
          name: p.name,
          amount: sum.amount + amount,
        });
        return {
          name: p.name,
          earned: fromMicro(p.earned),
          amount: fromMicro(amount),
          items: p.items,
          note:
            amount < p.payable
              ? amount > 0n
                ? "일일 상한 적용"
                : "일일 상한 도달"
              : p.note,
        };
      });
      if (players.some((p) => p.amount !== "0.000000")) paidMatches++;
      return {
        id: m.id,
        mode: m.mode,
        endedAt: m.endedAt,
        duration: m.duration,
        skipped: r.skipped,
        players,
      };
    })
    .reverse();
  return {
    matches: result,
    total: fromMicro(total),
    paidMatches,
    players: [...perPlayer.values()]
      .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
      .map((p) => ({ name: p.name, amount: fromMicro(p.amount) })),
  };
}
