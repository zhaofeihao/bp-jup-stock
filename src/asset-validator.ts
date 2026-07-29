import type { AssetDefinition } from "./types.js";

const BACKPACK_BASE_URL = "https://api.backpack.exchange";
const JUPITER_PRICE_URL = "https://api.jup.ag/price/v3";

interface BackpackAsset {
  symbol: string;
  tokens: Array<{
    blockchain: string;
    contractAddress: string;
    depositEnabled: boolean;
    withdrawEnabled: boolean;
    nativeDecimals: number;
  }>;
}

interface BackpackSecurity {
  asset: string;
  sessions: unknown[];
}

interface BackpackMarket {
  symbol: string;
  orderBookState: string;
  rwaMarketType?: string | null;
}

export interface AssetValidationResult {
  asset: string;
  expectedMint: string;
  actualMint?: string;
  mintMatches: boolean;
  depositEnabled: boolean;
  withdrawEnabled: boolean;
  securityTradable: boolean;
  spotMarketAvailable: boolean;
  jupiterPriceAvailable: boolean;
  healthy: boolean;
  raw: unknown;
}

export async function validateAssets(
  assets: AssetDefinition[],
  jupiterApiKey?: string,
): Promise<AssetValidationResult[]> {
  const priceUrl = new URL(JUPITER_PRICE_URL);
  priceUrl.searchParams.set(
    "ids",
    assets.map((asset) => asset.mint).join(","),
  );
  const jupiterHeaders: Record<string, string> = {};
  if (jupiterApiKey) jupiterHeaders["x-api-key"] = jupiterApiKey;

  const [backpackAssets, securities, markets, prices] = await Promise.all([
    fetchJson<BackpackAsset[]>(`${BACKPACK_BASE_URL}/api/v1/assets`),
    fetchJson<BackpackSecurity[]>(`${BACKPACK_BASE_URL}/api/v1/securities`),
    fetchJson<BackpackMarket[]>(`${BACKPACK_BASE_URL}/api/v1/markets`),
    fetchJson<Record<string, unknown>>(priceUrl.toString(), jupiterHeaders),
  ]);

  return assets.map((asset) => {
    const backpackAsset = backpackAssets.find(
      (candidate) => candidate.symbol === asset.backpackAsset,
    );
    const token = backpackAsset?.tokens.find(
      (candidate) => candidate.blockchain === "Solana",
    );
    const mintMatches =
      token?.contractAddress === asset.mint &&
      token?.nativeDecimals === asset.decimals;
    const securityTradable = securities.some(
      (security) =>
        security.asset === asset.backpackAsset &&
        security.sessions.length > 0,
    );
    const spotMarketAvailable = markets.some(
      (market) =>
        market.symbol === asset.backpackSpotSymbol &&
        market.orderBookState === "Open" &&
        market.rwaMarketType === "STOCK",
    );
    const jupiterPriceAvailable = prices[asset.mint] !== undefined;
    const healthy =
      mintMatches &&
      Boolean(token?.depositEnabled) &&
      Boolean(token?.withdrawEnabled) &&
      securityTradable &&
      jupiterPriceAvailable;

    return {
      asset: asset.symbol,
      expectedMint: asset.mint,
      actualMint: token?.contractAddress,
      mintMatches,
      depositEnabled: Boolean(token?.depositEnabled),
      withdrawEnabled: Boolean(token?.withdrawEnabled),
      securityTradable,
      spotMarketAvailable,
      jupiterPriceAvailable,
      healthy,
      raw: { backpackAsset, prices: prices[asset.mint] },
    };
  });
}

async function fetchJson<T>(
  url: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`${url} ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}
