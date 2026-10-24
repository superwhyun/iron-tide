/** Server-only Metanomic client. The game API key never leaves this process. */
export interface MetanomicConfig {
  apiUrl: string;
  gameId: string;
  gameKey: string;
  assetId: string;
}
export function metanomicConfig(
  env: NodeJS.ProcessEnv = process.env,
): MetanomicConfig | null {
  const apiUrl = env.METANOMIC_API_URL?.replace(/\/$/, ""),
    gameId = env.METANOMIC_GAME_ID,
    gameKey = env.METANOMIC_GAME_KEY,
    assetId = env.METANOMIC_ASSET_ID ?? "common-game-credit";
  return apiUrl && gameId && gameKey
    ? { apiUrl, gameId, gameKey, assetId }
    : null;
}

export class MetanomicError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
  /** Timeouts, 5xx and network drops: the outcome is unknown, retry with the same key. */
  get transient() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export type OperationStatus =
  | "QUEUED"
  | "PREPARED"
  | "SUBMITTED"
  | "INCLUDED"
  | "RECONCILING"
  | "FINALIZED"
  | "FAILED";
export interface RewardReceipt {
  rewardId: string;
  operationId: string;
  status: string;
}
export interface Budget {
  onchain?: string;
  reserved?: string;
  available?: string;
}

export class MetanomicClient {
  constructor(readonly config: MetanomicConfig) {}
  private async call<T>(
    path: string,
    options: { body?: unknown; key?: string } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.config.apiUrl}${path}`, {
        method: options.body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.config.gameKey}`,
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(options.key ? { "Idempotency-Key": options.key } : {}),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new MetanomicError(
        error instanceof Error ? error.message : "Metanomic unreachable",
        0,
        "NETWORK",
      );
    }
    const result = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    if (!response.ok)
      throw new MetanomicError(
        result.error?.message ??
          `Metanomic request failed (${response.status})`,
        response.status,
        result.error?.code,
      );
    return result as T;
  }
  private get game() {
    return `/games/${encodeURIComponent(this.config.gameId)}`;
  }
  budget() {
    return this.call<Budget>(`${this.game}/budget`);
  }
  /** §5: one reward per rewardRef; retries reuse the same key and body. */
  reward(body: { recipient: string; amount: string; rewardRef: string }) {
    return this.call<RewardReceipt>(`${this.game}/rewards`, {
      key: body.rewardRef,
      body: { ...body, assetId: this.config.assetId },
    });
  }
  operation(operationId: string) {
    return this.call<{ status: OperationStatus }>(
      `/operations/${encodeURIComponent(operationId)}`,
    );
  }
}
