import { Decimal } from "decimal.js";
import type { AppConfig } from "../config.js";
import type { AssetDefinition, ExecutableQuote } from "../types.js";

const JUPITER_ORDER_URL = "https://api.jup.ag/swap/v2/order";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;

interface JupiterOrderResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  slippageBps?: number;
  priceImpact?: number;
  priceImpactPct?: string;
  transaction: string | null;
  requestId: string;
  router: string;
  mode: string;
  expireAt?: string | number;
  lastValidBlockHeight?: number;
  errorCode?: number;
  errorMessage?: string;
  [key: string]: unknown;
}

export class JupiterQuoteProvider {
  private lastRequestAt = 0;
  private throttleTail: Promise<void> = Promise.resolve();

  constructor(private readonly config: AppConfig["jupiter"]) {}

  async quoteSell(
    asset: AssetDefinition,
    quantity: number,
  ): Promise<ExecutableQuote> {
    const amount = toAtomic(quantity, asset.decimals, Decimal.ROUND_DOWN);
    const { order, latencyMs, observedAt } = await this.order(
      asset.mint,
      USDC_MINT,
      amount,
    );
    const protectedOutput = new Decimal(
      order.otherAmountThreshold ?? order.outAmount,
    ).div(new Decimal(10).pow(USDC_DECIMALS));
    const assetQuantity = new Decimal(order.inAmount)
      .div(new Decimal(10).pow(asset.decimals))
      .toNumber();

    return {
      venue: "JUPITER",
      source: "JUPITER_SWAP_V2",
      asset: asset.symbol,
      side: "SELL_ASSET",
      assetQuantity,
      usdcAmount: protectedOutput.toNumber(),
      unitPrice: protectedOutput.div(assetQuantity).toNumber(),
      priceImpactBps: priceImpactBps(order),
      latencyMs,
      observedAt,
      validUntil: parseExpiry(order.expireAt),
      executable: Boolean(order.transaction),
      raw: sanitizeOrder(order),
    };
  }

  async quoteBuy(
    asset: AssetDefinition,
    targetQuantity: number,
    referenceUnitPrice: number,
  ): Promise<ExecutableQuote> {
    const usdcInput = new Decimal(targetQuantity).mul(referenceUnitPrice);
    const amount = toAtomic(
      usdcInput.toNumber(),
      USDC_DECIMALS,
      Decimal.ROUND_UP,
    );
    const { order, latencyMs, observedAt } = await this.order(
      USDC_MINT,
      asset.mint,
      amount,
    );
    // V2 为 ExactIn。以 otherAmountThreshold 的最小保证输出作为另一腿数量。
    const protectedQuantity = new Decimal(
      order.otherAmountThreshold ?? order.outAmount,
    ).div(new Decimal(10).pow(asset.decimals));
    const actualUsdcInput = new Decimal(order.inAmount).div(
      new Decimal(10).pow(USDC_DECIMALS),
    );

    return {
      venue: "JUPITER",
      source: "JUPITER_SWAP_V2",
      asset: asset.symbol,
      side: "BUY_ASSET",
      assetQuantity: protectedQuantity.toNumber(),
      usdcAmount: actualUsdcInput.toNumber(),
      unitPrice: actualUsdcInput.div(protectedQuantity).toNumber(),
      priceImpactBps: priceImpactBps(order),
      latencyMs,
      observedAt,
      validUntil: parseExpiry(order.expireAt),
      executable: Boolean(order.transaction),
      raw: sanitizeOrder(order),
    };
  }

  private async order(
    inputMint: string,
    outputMint: string,
    amount: string,
  ): Promise<{
    order: JupiterOrderResponse;
    latencyMs: number;
    observedAt: number;
  }> {
    await this.throttle();
    const startedAt = Date.now();
    const url = new URL(JUPITER_ORDER_URL);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount);
    url.searchParams.set("slippageBps", String(this.config.slippageBps));
    if (this.config.taker) url.searchParams.set("taker", this.config.taker);

    const headers: Record<string, string> = {};
    if (this.config.apiKey) headers["x-api-key"] = this.config.apiKey;
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    this.lastRequestAt = Date.now();
    if (!response.ok) {
      throw new Error(`Jupiter order ${response.status}: ${await response.text()}`);
    }
    const order = (await response.json()) as JupiterOrderResponse;
    if (!order.inAmount || !order.outAmount) {
      throw new Error(`Jupiter 没有有效路由：${JSON.stringify(order)}`);
    }
    return {
      order,
      latencyMs: Date.now() - startedAt,
      observedAt: Date.now(),
    };
  }

  private async throttle(): Promise<void> {
    const waitForTurn = this.throttleTail.then(async () => {
      const remaining =
        this.config.minRequestIntervalMs - (Date.now() - this.lastRequestAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
    });
    this.throttleTail = waitForTurn.catch(() => undefined);
    await waitForTurn;
  }
}

function toAtomic(
  amount: number,
  decimals: number,
  rounding: Decimal.Rounding,
): string {
  return new Decimal(amount)
    .mul(new Decimal(10).pow(decimals))
    .toDecimalPlaces(0, rounding)
    .toFixed(0);
}

function priceImpactBps(order: JupiterOrderResponse): number {
  if (typeof order.priceImpact === "number") {
    // V2 的 priceImpact 是百分数，例如 0.3 表示 30 bps。
    return Math.abs(order.priceImpact * 100);
  }
  if (order.priceImpactPct !== undefined) {
    return Math.abs(Number(order.priceImpactPct) * 10_000);
  }
  return 0;
}

function parseExpiry(expireAt: string | number | undefined): number | null {
  if (expireAt === undefined) return null;
  if (typeof expireAt === "number") {
    return expireAt < 10_000_000_000 ? expireAt * 1_000 : expireAt;
  }
  const numeric = Number(expireAt);
  if (Number.isFinite(numeric)) {
    return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(expireAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeOrder(order: JupiterOrderResponse): JupiterOrderResponse {
  return {
    ...order,
    transaction: order.transaction
      ? `<base64 transaction, ${order.transaction.length} chars>`
      : order.transaction,
  };
}
