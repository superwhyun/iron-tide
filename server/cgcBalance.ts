import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  type Address,
} from "viem";

/** Token deployment published by Metanomic's public `GET /assets`. */
export interface CgcDeployment {
  deploymentId: string;
  rpcUrl: string;
  token: Address;
  decimals: number;
}
interface AssetsResponse {
  assets?: {
    assetId: string;
    decimals: number;
    activeDeploymentId: string;
    deployments: {
      id: string;
      rpcUrl: string;
      token: string;
    }[];
  }[];
}

const CACHE_MS = 5_000;
const RETRY_MS = 60_000;
const TIMEOUT_MS = 5_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Reads a wallet's CGC straight from the token contract. Metanomic's balance
 * API is for portal sessions only, so the game reads the chain itself. It
 * reads the latest block, so a reward shows as soon as it is included rather
 * than after finality.
 */
export class CgcBalance {
  private deployment: Promise<CgcDeployment> | null = null;
  private failedAt = 0;
  private cache = new Map<string, { at: number; value: bigint }>();
  constructor(
    private apiUrl: string,
    private assetId: string,
    private read?: (d: CgcDeployment, wallet: Address) => Promise<bigint>,
  ) {}
  private async loadDeployment(): Promise<CgcDeployment> {
    const response = await fetch(`${this.apiUrl}/assets`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`Metanomic assets request failed (${response.status})`);
    const body = (await response.json()) as AssetsResponse;
    const asset = body.assets?.find((a) => a.assetId === this.assetId);
    const d = asset?.deployments.find((x) => x.id === asset.activeDeploymentId);
    if (!asset || !d || !ADDRESS.test(d.token))
      throw new Error(`Metanomic에 ${this.assetId} 활성 배포가 없습니다.`);
    return {
      deploymentId: d.id,
      rpcUrl: d.rpcUrl,
      token: d.token as Address,
      decimals: asset.decimals,
    };
  }
  /** Deployment info, fetched once; a failure is retried after a minute. */
  private resolve() {
    if (
      !this.deployment ||
      (this.failedAt && Date.now() - this.failedAt > RETRY_MS)
    ) {
      this.failedAt = 0;
      this.deployment = this.loadDeployment().catch((error) => {
        this.failedAt = Date.now();
        throw error;
      });
    }
    return this.deployment;
  }
  private async readChain(d: CgcDeployment, wallet: Address) {
    const client = createPublicClient({
      transport: http(d.rpcUrl, { timeout: TIMEOUT_MS }),
    });
    return client.readContract({
      address: d.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet],
      blockTag: "latest",
    });
  }
  /** Balance as a decimal string, cached briefly per wallet. */
  async balance(wallet: string) {
    if (!ADDRESS.test(wallet)) throw new Error("잘못된 지갑 주소입니다.");
    const d = await this.resolve();
    const key = wallet.toLowerCase(),
      hit = this.cache.get(key);
    let value = hit && Date.now() - hit.at < CACHE_MS ? hit.value : undefined;
    if (value === undefined) {
      value = await (this.read ?? this.readChain)(d, wallet as Address);
      this.cache.set(key, { at: Date.now(), value });
    }
    return {
      amount: formatUnits(value, d.decimals),
      deploymentId: d.deploymentId,
    };
  }
}
