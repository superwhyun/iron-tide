import { randomBytes } from "node:crypto";
import { getAddress, isAddress, verifyMessage, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { AccountStore, SESSION_HOURS, type ChallengePurpose } from "./accounts";

const CHALLENGE_MS = 5 * 60_000;
const ZERO = "0x0000000000000000000000000000000000000000";
const STATEMENTS: Record<ChallengePurpose, string> = {
  login:
    "IRON TIDE에 로그인합니다. 거래나 토큰 사용 승인이 아닌 로그인 서명입니다.",
  admin:
    "이 지갑을 IRON TIDE 게임 관리자로 등록하고 로그인합니다. 거래나 토큰 사용 승인이 아닙니다.",
};

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Sign-In with Ethereum for the game's own accounts. The message is bound to
 * the page origin, chain, a one-time nonce and a 5-minute window; the wallet
 * only signs text (no transaction, no token approval).
 */
export class WalletAuth {
  constructor(
    private store: AccountStore,
    private chainId: number,
  ) {}
  challenge(
    value: unknown,
    origin: string,
    purpose: ChallengePurpose = "login",
  ) {
    if (typeof value !== "string" || !isAddress(value, { strict: false }))
      throw new AuthError(
        422,
        "INVALID_WALLET",
        "지갑 주소가 올바르지 않습니다.",
      );
    const address = getAddress(value.toLowerCase());
    if (address === ZERO)
      throw new AuthError(
        422,
        "INVALID_WALLET",
        "지갑 주소가 올바르지 않습니다.",
      );
    const site = new URL(origin),
      now = Date.now(),
      id = `login-${randomBytes(12).toString("hex")}`;
    const message = createSiweMessage({
      address,
      chainId: this.chainId,
      domain: site.host,
      uri: site.origin,
      scheme: site.protocol.slice(0, -1),
      version: "1",
      nonce: randomBytes(16).toString("hex"),
      issuedAt: new Date(now),
      expirationTime: new Date(now + SESSION_HOURS * 3600_000),
      requestId: id,
      statement: STATEMENTS[purpose],
    });
    const expiresAt = now + CHALLENGE_MS;
    this.store.saveChallenge({
      id,
      purpose,
      address,
      message,
      origin: site.origin,
      chainId: this.chainId,
      expiresAt,
    });
    return {
      challengeId: id,
      message,
      address,
      chainId: this.chainId,
      expiresAt,
    };
  }
  async finish(
    challengeId: unknown,
    signature: unknown,
    origin: string,
    purpose: ChallengePurpose = "login",
  ) {
    if (typeof challengeId !== "string" || typeof signature !== "string")
      throw new AuthError(
        422,
        "INVALID_REQUEST",
        "로그인 요청이 올바르지 않습니다.",
      );
    const challenge = this.store.pendingChallenge(challengeId);
    // A challenge issued for another origin or chain is never accepted here.
    if (
      !challenge ||
      challenge.purpose !== purpose ||
      challenge.origin !== new URL(origin).origin ||
      challenge.chainId !== this.chainId
    )
      throw new AuthError(
        422,
        "INVALID_CHALLENGE",
        "로그인 요청이 만료되었습니다. 다시 시도해 주세요.",
      );
    const valid = await verifyMessage({
      address: challenge.address as Hex,
      message: challenge.message,
      signature: signature as Hex,
    }).catch(() => false);
    if (!valid)
      throw new AuthError(
        422,
        "INVALID_SIGNATURE",
        "지갑 서명을 확인하지 못했습니다.",
      );
    const session = this.store.consumeChallenge(
      challenge.id,
      challenge.address,
    );
    if (!session)
      throw new AuthError(
        409,
        "CHALLENGE_USED",
        "이미 사용한 로그인 요청입니다. 다시 시도해 주세요.",
      );
    return session;
  }
}
