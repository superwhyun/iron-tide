import type { AccountView } from "../shared/types";

export type WalletProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};
export type WalletChoice = { name: string; provider: WalletProvider };
type WalletWindow = Window & {
  ronin?: { provider?: unknown };
  ethereum?: unknown;
};
const isProvider = (value: unknown): value is WalletProvider =>
  value != null && typeof (value as WalletProvider).request === "function";

/**
 * Finds browser wallets: EIP-6963 announcements first, then Ronin's injected
 * provider and legacy window.ethereum. Discovery starts at page load because
 * some extensions only answer the initial request.
 */
export class WalletDiscovery {
  private announced = new Map<WalletProvider, WalletChoice>();
  constructor(private host: WalletWindow = window) {
    host.addEventListener("eip6963:announceProvider", (event) => {
      const detail = (event as CustomEvent).detail;
      const name = detail?.info?.name;
      if (
        isProvider(detail?.provider) &&
        typeof name === "string" &&
        name.trim()
      )
        this.announced.set(detail.provider, {
          name: name.slice(0, 80),
          provider: detail.provider,
        });
    });
    this.request();
  }
  request() {
    this.host.dispatchEvent(new Event("eip6963:requestProvider"));
  }
  wallets(): WalletChoice[] {
    const found = new Map(this.announced);
    const add = (provider: unknown, name: string) => {
      if (isProvider(provider) && !found.has(provider))
        found.set(provider, { name, provider });
    };
    add(this.host.ronin?.provider, "Ronin Wallet");
    const ethereum = this.host.ethereum as
      | (WalletProvider & {
          providers?: unknown[];
          isRonin?: boolean;
          isMetaMask?: boolean;
        })
      | undefined;
    for (const provider of Array.isArray(ethereum?.providers)
      ? ethereum.providers
      : [ethereum]) {
      const p = provider as
        { isRonin?: boolean; isMetaMask?: boolean } | undefined;
      add(
        provider,
        p?.isRonin ? "Ronin Wallet" : p?.isMetaMask ? "MetaMask" : "EVM 지갑",
      );
    }
    return [...found.values()];
  }
}

export function walletErrorMessage(error: unknown): string {
  const code = Number((error as { code?: unknown })?.code);
  if (code === 4001) return "지갑 요청을 취소했습니다.";
  if (code === -32002)
    return "지갑에 처리 중인 요청이 있습니다. 지갑 앱에서 기존 요청을 승인하거나 취소하세요.";
  if ((error as { code?: unknown })?.code === "WALLET_IS_LOCKED")
    return "지갑이 잠겨 있습니다. 잠금을 해제하고 다시 시도하세요.";
  return error instanceof Error
    ? error.message
    : "지갑 요청을 처리하지 못했습니다.";
}

const utf8Hex = (text: string) =>
  `0x${[...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/** JSON call to this game's own server; errors carry the server's Korean message. */
export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(data?.error?.message ?? "서버 요청을 처리하지 못했습니다.");
  return data as T;
}

/** Current signed-in account, or null for guests. */
export const fetchAccount = () =>
  api<{ account: AccountView | null }>("GET", "/api/me").then((r) => r.account);
export const renameAccount = (name: string) =>
  api<{ account: AccountView }>("PATCH", "/api/me", { name }).then(
    (r) => r.account,
  );
export const logout = () => api("DELETE", "/api/auth/session");
/** The signed-in captain's CGC, read from the chain by the game server. */
export const fetchBalance = () =>
  api<{ balance: string | null; error?: string }>("GET", "/api/me/balance");

type Challenge = { challengeId: string; message: string; address: string };

/**
 * Has the wallet pick an account, asks the game server for a one-time SIWE
 * message for it (`issue`) and signs that exact text with personal_sign.
 * Nothing is broadcast to the chain.
 */
export async function signChallenge(
  provider: WalletProvider,
  issue: (address: string) => Promise<Challenge>,
) {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const address = Array.isArray(accounts)
    ? accounts.find((a) => typeof a === "string")
    : undefined;
  if (!address) throw new Error("지갑에서 연결할 계정을 선택하세요.");
  const challenge = await issue(address);
  const signature = await provider.request({
    method: "personal_sign",
    params: [utf8Hex(challenge.message), challenge.address],
  });
  return { challengeId: challenge.challengeId, signature };
}

/** Wallet sign-in: the signature is exchanged for an HttpOnly session cookie. */
export async function signInWithWallet(provider: WalletProvider) {
  const signed = await signChallenge(provider, (address) =>
    api<Challenge>("POST", "/api/auth/challenge", { address }),
  );
  return api<{ account: AccountView }>(
    "POST",
    "/api/auth/session",
    signed,
  ).then((r) => r.account);
}
