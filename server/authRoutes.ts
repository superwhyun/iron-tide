import type { IncomingMessage, ServerResponse } from "node:http";
import { SESSION_HOURS, type Account, type AccountStore } from "./accounts";
import { AuthError, type WalletAuth } from "./walletAuth";
import type { AccountView } from "../shared/types";

export const SESSION_COOKIE = "it_session";
const BODY_LIMIT = 4096;
const AUTH_ATTEMPTS_PER_MINUTE = 20;
const NAME_LIMIT = 18;

export const accountView = (a: Account): AccountView => ({
  wallet: a.wallet,
  name: a.name,
  matches: a.matches,
  wins: a.wins,
  kills: a.kills,
  deaths: a.deaths,
  damage: a.damage,
});
export const cleanName = (name: unknown) =>
  typeof name === "string"
    ? name
        .trim()
        .replace(/[<>\x00-\x1f]/g, "")
        .slice(0, NAME_LIMIT)
    : "";

export function readCookie(header: string | undefined, name: string) {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}
/**
 * The page origin, if it belongs to the host serving this request. Allows the
 * Vite proxy and LAN hosting while rejecting cross-site browser requests.
 */
export function sameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return null;
  try {
    const url = new URL(origin),
      host = new URL(`http://${req.headers.host ?? ""}`).hostname;
    const loopback = ["localhost", "127.0.0.1"];
    const ok =
      url.hostname === host ||
      (loopback.includes(url.hostname) && loopback.includes(host));
    return ok ? url.origin : null;
  } catch {
    return null;
  }
}
export async function readJson(req: IncomingMessage) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > BODY_LIMIT)
      throw new AuthError(413, "TOO_LARGE", "요청이 너무 큽니다.");
  }
  try {
    return body ? (JSON.parse(body) as Record<string, unknown>) : {};
  } catch {
    throw new AuthError(400, "INVALID_JSON", "요청 형식이 올바르지 않습니다.");
  }
}
export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  cookie?: string,
) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...(cookie ? { "Set-Cookie": cookie } : {}),
  });
  res.end(JSON.stringify(body));
}
export function sessionCookie(token: string, origin: string, maxAge: number) {
  const secure = origin.startsWith("https:") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

/** Game account API: wallet login, profile and logout under /api. */
/** Per-IP sliding minute limit for sign-in style endpoints. */
export function createLimiter(perMinute = AUTH_ATTEMPTS_PER_MINUTE) {
  const attempts = new Map<string, { window: number; count: number }>();
  return function limit(req: IncomingMessage) {
    const ip = req.socket.remoteAddress ?? "",
      now = Date.now(),
      entry = attempts.get(ip);
    if (!entry || now - entry.window > 60_000)
      attempts.set(ip, { window: now, count: 1 });
    else if (++entry.count > perMinute)
      throw new AuthError(
        429,
        "AUTH_RATE_LIMITED",
        "잠시 후 다시 시도해 주세요.",
      );
  };
}
/** Sends AuthErrors as `{ error: { code, message } }`; anything else is a 500. */
export function sendError(res: ServerResponse, error: unknown) {
  if (error instanceof AuthError)
    json(res, error.status, {
      error: { code: error.code, message: error.message },
    });
  else {
    console.error("account API failed", error);
    json(res, 500, {
      error: { code: "INTERNAL", message: "잠시 후 다시 시도해 주세요." },
    });
  }
}
/** Wallet CGC for the signed-in captain. */
export interface BalanceView {
  /** On-chain balance, or null when it cannot be read right now. */
  balance: string | null;
  error?: string;
}
export function createAuthRoutes(
  store: AccountStore,
  auth: WalletAuth,
  balanceOf?: (account: Account) => Promise<BalanceView>,
) {
  const limit = createLimiter();
  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    try {
      const route = `${req.method} ${url.pathname}`;
      if (route === "GET /api/me") {
        const account = store.accountForToken(token);
        json(res, 200, { account: account ? accountView(account) : null });
        return true;
      }
      if (route === "GET /api/me/balance") {
        const account = store.accountForToken(token);
        if (!account)
          throw new AuthError(
            401,
            "SIGN_IN_REQUIRED",
            "지갑으로 로그인하세요.",
          );
        if (!balanceOf)
          throw new AuthError(
            503,
            "BALANCE_UNAVAILABLE",
            "잔액 조회가 설정되지 않았습니다.",
          );
        json(res, 200, await balanceOf(account));
        return true;
      }
      // Every state change must come from this game's own page.
      const origin = sameOrigin(req);
      if (!origin)
        throw new AuthError(403, "ORIGIN_DENIED", "허용되지 않은 요청입니다.");
      if (route === "POST /api/auth/challenge") {
        limit(req);
        const body = await readJson(req);
        json(res, 200, auth.challenge(body.address, origin));
      } else if (route === "POST /api/auth/session") {
        limit(req);
        const body = await readJson(req);
        const session = await auth.finish(
          body.challengeId,
          body.signature,
          origin,
        );
        json(
          res,
          200,
          { account: accountView(session.account) },
          sessionCookie(session.token, origin, SESSION_HOURS * 3600),
        );
      } else if (route === "DELETE /api/auth/session") {
        if (token) store.endSession(token);
        json(res, 200, { account: null }, sessionCookie("", origin, 0));
      } else if (route === "PATCH /api/me") {
        const account = store.accountForToken(token);
        if (!account)
          throw new AuthError(401, "UNAUTHENTICATED", "다시 로그인해 주세요.");
        const name = cleanName((await readJson(req)).name);
        if (!name)
          throw new AuthError(422, "INVALID_NAME", "함장 이름을 입력하세요.");
        store.rename(account.id, name);
        json(res, 200, { account: accountView(store.account(account.id)!) });
      } else throw new AuthError(404, "NOT_FOUND", "없는 경로입니다.");
    } catch (error) {
      sendError(res, error);
    }
    return true;
  };
}
