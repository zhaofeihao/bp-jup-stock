import {
  createPrivateKey,
  sign as signEd25519,
  type KeyObject,
} from "node:crypto";
import { Decimal } from "decimal.js";
import type { AppConfig } from "../config.js";
import type {
  AssetDefinition,
  AssetSide,
  ExecutableQuote,
} from "../types.js";

const BACKPACK_BASE_URL = "https://api.backpack.exchange";
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

interface DepthResponse {
  asks: [string, string][];
  bids: [string, string][];
  timestamp: number;
  lastUpdateId: string;
}

interface TickerResponse {
  symbol: string;
  firstPrice: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
  high: string;
  low: string;
  volume: string;
  quoteVolume: string;
  trades: string;
}

interface RfqResponse {
  rfqId: string;
  expiryTime: number;
  submissionTime: number;
  createdAt: number;
}

interface QuoteResponse {
  quoteId: string;
  bidPrice: string;
  askPrice: string;
  createdAt: number;
  status: string;
}

interface RfqWithQuotes {
  rfq: RfqResponse;
  quotes: QuoteResponse[];
}

export function createBackpackPrivateKey(secretBase64: string): KeyObject {
  const decoded = Buffer.from(secretBase64, "base64");
  if (decoded.length !== 32 && decoded.length !== 64) {
    throw new Error("BACKPACK_API_SECRET 必须是 Base64 编码的 32 或 64 字节密钥");
  }
  const seed = decoded.subarray(0, 32);
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

export function backpackSigningPayload(
  instruction: string,
  values: Record<string, string | number | boolean | undefined>,
  timestamp: number,
  window: number,
): string {
  const parameters = Object.entries(values)
    .filter((entry): entry is [string, string | number | boolean] =>
      entry[1] !== undefined,
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`);
  return [
    `instruction=${instruction}`,
    ...parameters,
    `timestamp=${timestamp}`,
    `window=${window}`,
  ].join("&");
}

export function calculateVwap(
  levels: [string, string][],
  quantity: number,
): { totalUsdc: number; unitPrice: number; topPrice: number } {
  let remaining = new Decimal(quantity);
  let total = new Decimal(0);
  let topPrice: Decimal | undefined;

  for (const [rawPrice, rawQuantity] of levels) {
    const price = new Decimal(rawPrice);
    const available = new Decimal(rawQuantity);
    if (price.lte(0) || available.lte(0)) continue;
    topPrice ??= price;
    const used = Decimal.min(remaining, available);
    total = total.plus(used.mul(price));
    remaining = remaining.minus(used);
    if (remaining.lte(0)) break;
  }

  if (remaining.gt(0) || !topPrice) {
    throw new Error(`订单簿深度不足，需要 ${quantity} 股，缺少 ${remaining.toString()} 股`);
  }
  return {
    totalUsdc: total.toNumber(),
    unitPrice: total.div(quantity).toNumber(),
    topPrice: topPrice.toNumber(),
  };
}

export function sortDepthLevels(
  levels: [string, string][],
  side: AssetSide,
): [string, string][] {
  return [...levels].sort((left, right) => {
    const leftPrice = Number(left[0]);
    const rightPrice = Number(right[0]);
    return side === "BUY_ASSET"
      ? leftPrice - rightPrice
      : rightPrice - leftPrice;
  });
}

export class BackpackQuoteProvider {
  private readonly privateKey?: KeyObject;

  constructor(private readonly config: AppConfig["backpack"]) {
    if (config.apiSecret) {
      this.privateKey = createBackpackPrivateKey(config.apiSecret);
    }
  }

  async quoteReference(
    asset: AssetDefinition,
    side: AssetSide,
    quantity: number,
  ): Promise<ExecutableQuote> {
    const failures: string[] = [];

    if (asset.backpackSpotSymbol) {
      try {
        const { depth, latencyMs } = await this.fetchDepth(
          asset.backpackSpotSymbol,
        );
        const levels = sortDepthLevels(
          side === "BUY_ASSET" ? depth.asks : depth.bids,
          side,
        );
        const validLevels = levels.filter(([price, available]) =>
          new Decimal(price).gt(0) && new Decimal(available).gt(0),
        );
        if (validLevels.length > 0) {
          try {
            const quote = this.depthQuote(
              asset,
              side,
              quantity,
              depth,
              validLevels,
              latencyMs,
            );
            return {
              ...quote,
              executable: false,
              note: "公开订单簿足量 VWAP；尚未验证账户与最终交易组装",
            };
          } catch (error) {
            const coveredQuantity = validLevels
              .reduce(
                (sum, [, available]) => sum.plus(available),
                new Decimal(0),
              )
              .toNumber();
            const topPrice = Number(validLevels[0]![0]);
            return {
              venue: "BACKPACK",
              source: "BACKPACK_TOP_OF_BOOK",
              asset: asset.symbol,
              side,
              assetQuantity: quantity,
              usdcAmount: topPrice * quantity,
              unitPrice: topPrice,
              priceImpactBps: 0,
              latencyMs,
              observedAt: normalizeTimestamp(depth.timestamp),
              validUntil: null,
              executable: false,
              note: `盘口仅覆盖 ${formatQuantity(coveredQuantity)} / ${formatQuantity(quantity)} 股，按顶价外推，不保证整档成交`,
              raw: {
                depth,
                reference: {
                  kind: "TOP_OF_BOOK",
                  coveredQuantity,
                  requestedQuantity: quantity,
                  fallbackReason: errorMessage(error),
                },
              },
            };
          }
        }
        failures.push("订单簿对应方向没有有效档位");
      } catch (error) {
        failures.push(`订单簿：${errorMessage(error)}`);
      }
    } else {
      failures.push("没有现货订单簿市场");
    }

    for (const source of ["Venue", "External"] as const) {
      try {
        return await this.quoteTicker(asset, side, quantity, source);
      } catch (error) {
        failures.push(`${source} ticker：${errorMessage(error)}`);
      }
    }

    throw new Error(`Backpack 参考行情不可用：${failures.join("；")}`);
  }

  async quote(
    asset: AssetDefinition,
    side: AssetSide,
    quantity: number,
  ): Promise<ExecutableQuote> {
    if (this.config.mode === "depth") {
      return this.quoteDepth(asset, side, quantity);
    }
    if (this.config.mode === "rfq") {
      return this.quoteRfq(asset, side, quantity);
    }

    if (this.config.apiKey && this.privateKey) {
      try {
        return await this.quoteRfq(asset, side, quantity);
      } catch (rfqError) {
        try {
          return await this.quoteDepth(asset, side, quantity);
        } catch (depthError) {
          throw new Error(
            `RFQ 失败：${errorMessage(rfqError)}；订单簿回退失败：${errorMessage(depthError)}`,
          );
        }
      }
    }
    return this.quoteDepth(asset, side, quantity);
  }

  private async quoteDepth(
    asset: AssetDefinition,
    side: AssetSide,
    quantity: number,
  ): Promise<ExecutableQuote> {
    if (!asset.backpackSpotSymbol) {
      throw new Error(
        `${asset.symbol} 没有已确认的 Backpack 现货订单簿；请配置 RFQ API 密钥`,
      );
    }
    const { depth, latencyMs } = await this.fetchDepth(asset.backpackSpotSymbol);
    const levels = sortDepthLevels(
      side === "BUY_ASSET" ? depth.asks : depth.bids,
      side,
    );
    return this.depthQuote(
      asset,
      side,
      quantity,
      depth,
      levels,
      latencyMs,
    );
  }

  private depthQuote(
    asset: AssetDefinition,
    side: AssetSide,
    quantity: number,
    depth: DepthResponse,
    levels: [string, string][],
    latencyMs: number,
  ): ExecutableQuote {
    const vwap = calculateVwap(levels, quantity);
    const adverseImpact =
      side === "BUY_ASSET"
        ? (vwap.unitPrice / vwap.topPrice - 1) * 10_000
        : (1 - vwap.unitPrice / vwap.topPrice) * 10_000;
    const observedAt = Math.floor(depth.timestamp / 1_000);

    return {
      venue: "BACKPACK",
      source: "BACKPACK_DEPTH",
      asset: asset.symbol,
      side,
      assetQuantity: quantity,
      usdcAmount: vwap.totalUsdc,
      unitPrice: vwap.unitPrice,
      priceImpactBps: Math.max(0, adverseImpact),
      latencyMs,
      observedAt,
      validUntil: null,
      executable: true,
      raw: depth,
    };
  }

  private async fetchDepth(
    symbol: string,
  ): Promise<{ depth: DepthResponse; latencyMs: number }> {
    const startedAt = Date.now();
    const url = new URL("/api/v1/depth", BACKPACK_BASE_URL);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("limit", "1000");
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      throw new Error(
        `Backpack depth ${response.status}: ${await response.text()}`,
      );
    }
    return {
      depth: (await response.json()) as DepthResponse,
      latencyMs: Date.now() - startedAt,
    };
  }

  private async quoteTicker(
    asset: AssetDefinition,
    side: AssetSide,
    quantity: number,
    tickerSource: "Venue" | "External",
  ): Promise<ExecutableQuote> {
    const startedAt = Date.now();
    const tickerSymbol =
      asset.backpackSpotSymbol ?? asset.backpackRfqSymbol.replace(/_RFQ$/, "");
    const url = new URL("/api/v1/ticker", BACKPACK_BASE_URL);
    url.searchParams.set("symbol", tickerSymbol);
    url.searchParams.set("interval", "1d");
    url.searchParams.set("source", tickerSource);
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      throw new Error(
        `Backpack ticker ${response.status}: ${await response.text()}`,
      );
    }
    if (response.status === 204) {
      throw new Error("没有 ticker 数据");
    }
    const ticker = (await response.json()) as TickerResponse;
    const unitPrice = Number(ticker.lastPrice);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new Error(`返回无效 lastPrice：${ticker.lastPrice}`);
    }
    return {
      venue: "BACKPACK",
      source:
        tickerSource === "Venue"
          ? "BACKPACK_TICKER_VENUE"
          : "BACKPACK_TICKER_EXTERNAL",
      asset: asset.symbol,
      side,
      assetQuantity: quantity,
      usdcAmount: unitPrice * quantity,
      unitPrice,
      priceImpactBps: 0,
      latencyMs: Date.now() - startedAt,
      observedAt: Date.now(),
      validUntil: null,
      executable: false,
      note:
        tickerSource === "Venue"
          ? "Backpack 最新成交价，成交时间未知且没有整档深度保证"
          : "外部市场参考价，不是 Backpack 可成交报价",
      raw: { tickerSource, ticker },
    };
  }

  private async quoteRfq(
    asset: AssetDefinition,
    side: AssetSide,
    quantity: number,
  ): Promise<ExecutableQuote> {
    if (!this.config.apiKey || !this.privateKey) {
      throw new Error("RFQ 模式需要 BACKPACK_API_KEY 和 BACKPACK_API_SECRET");
    }
    const startedAt = Date.now();
    const payload = {
      executionMode: "AwaitAccept",
      quantity: new Decimal(quantity).toFixed(),
      side: side === "BUY_ASSET" ? "Bid" : "Ask",
      symbol: asset.backpackRfqSymbol,
    };
    const rfq = await this.signedFetch<RfqResponse>(
      "POST",
      "/api/v1/rfq",
      "rfqSubmit",
      payload,
    );

    const deadline = Math.min(
      rfq.expiryTime,
      startedAt + this.config.rfqTimeoutMs,
    );
    let best: QuoteResponse | undefined;
    while (Date.now() < deadline) {
      const open = await this.signedFetch<RfqWithQuotes[]>(
        "GET",
        "/api/v1/rfqs",
        "rfqQuery",
        { rfqId: rfq.rfqId },
      );
      const quotes = open.find((item) => item.rfq.rfqId === rfq.rfqId)?.quotes;
      if (quotes && quotes.length > 0) {
        best = selectBestQuote(quotes, side);
        break;
      }
      await sleep(this.config.rfqPollMs);
    }
    if (!best) {
      throw new Error(`${asset.symbol} RFQ 在 ${this.config.rfqTimeoutMs}ms 内没有报价`);
    }

    const unitPrice = Number(
      side === "BUY_ASSET" ? best.askPrice : best.bidPrice,
    );
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new Error(`RFQ 返回无效价格：${JSON.stringify(best)}`);
    }
    return {
      venue: "BACKPACK",
      source: "BACKPACK_RFQ",
      asset: asset.symbol,
      side,
      assetQuantity: quantity,
      usdcAmount: unitPrice * quantity,
      unitPrice,
      priceImpactBps: 0,
      latencyMs: Date.now() - startedAt,
      observedAt: normalizeTimestamp(best.createdAt),
      validUntil: rfq.expiryTime,
      executable: best.status.toLowerCase() !== "expired",
      raw: { rfq, quote: best },
    };
  }

  private async signedFetch<T>(
    method: "GET" | "POST",
    pathname: string,
    instruction: string,
    values: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    if (!this.config.apiKey || !this.privateKey) {
      throw new Error("Backpack 签名请求缺少密钥");
    }
    const timestamp = Date.now();
    const window = 5_000;
    const signingPayload = backpackSigningPayload(
      instruction,
      values,
      timestamp,
      window,
    );
    const signature = signEd25519(
      null,
      Buffer.from(signingPayload),
      this.privateKey,
    ).toString("base64");
    const url = new URL(pathname, BACKPACK_BASE_URL);
    if (method === "GET") {
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.config.apiKey,
        "X-Signature": signature,
        "X-Timestamp": String(timestamp),
        "X-Window": String(window),
      },
      body: method === "POST" ? JSON.stringify(values) : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(
        `Backpack ${pathname} ${response.status}: ${await response.text()}`,
      );
    }
    return (await response.json()) as T;
  }
}

function selectBestQuote(
  quotes: QuoteResponse[],
  side: AssetSide,
): QuoteResponse | undefined {
  return [...quotes]
    .filter((quote) => {
      const price = Number(
        side === "BUY_ASSET" ? quote.askPrice : quote.bidPrice,
      );
      return Number.isFinite(price) && price > 0;
    })
    .sort((left, right) => {
      const leftPrice = Number(
        side === "BUY_ASSET" ? left.askPrice : left.bidPrice,
      );
      const rightPrice = Number(
        side === "BUY_ASSET" ? right.askPrice : right.bidPrice,
      );
      return side === "BUY_ASSET"
        ? leftPrice - rightPrice
        : rightPrice - leftPrice;
    })[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTimestamp(timestamp: number): number {
  return timestamp > 10_000_000_000_000
    ? Math.floor(timestamp / 1_000)
    : timestamp;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatQuantity(quantity: number): string {
  return new Decimal(quantity).toDecimalPlaces(6).toFixed();
}
