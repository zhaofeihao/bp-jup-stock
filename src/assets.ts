import type { AssetDefinition, AssetSymbol } from "./types.js";

export const ASSET_REGISTRY: Record<AssetSymbol, AssetDefinition> = {
  SPCX: {
    symbol: "SPCX",
    name: "SpaceX",
    mint: "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb",
    decimals: 6,
    backpackAsset: "SPCX.US",
    backpackRfqSymbol: "SPCX.US_USDC_RFQ",
    backpackSpotSymbol: "SPCX.US_USDC",
    initialMockPrice: 420,
  },
  MU: {
    symbol: "MU",
    name: "Micron",
    mint: "MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1",
    decimals: 6,
    backpackAsset: "MU.US",
    backpackRfqSymbol: "MU.US_USDC_RFQ",
    backpackSpotSymbol: "MU.US_USDC",
    initialMockPrice: 180,
  },
  SNDK: {
    symbol: "SNDK",
    name: "Sandisk",
    mint: "SNDKbwMUQvZhnLnxLduradgLHG5KrPuKwpnrkkGRhfH",
    decimals: 6,
    backpackAsset: "SNDK.US",
    backpackRfqSymbol: "SNDK.US_USDC_RFQ",
    backpackSpotSymbol: "SNDK.US_USDC",
    initialMockPrice: 350,
  },
  DRAM: {
    symbol: "DRAM",
    name: "Roundhill Memory ETF",
    mint: "DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw",
    decimals: 6,
    backpackAsset: "DRAM.US",
    backpackRfqSymbol: "DRAM.US_USDC_RFQ",
    initialMockPrice: 90,
  },
  BOT: {
    symbol: "BOT",
    name: "RoboStrategy",
    mint: "BoTx8y9ynfdxf5ZjWtCoBVkff52qKA82ysaLU8ZM6d8T",
    decimals: 6,
    backpackAsset: "BOT.US",
    backpackRfqSymbol: "BOT.US_USDC_RFQ",
    initialMockPrice: 55,
  },
  SKHY: {
    symbol: "SKHY",
    name: "SK hynix ADR",
    mint: "SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3",
    decimals: 6,
    backpackAsset: "SKHY.US",
    backpackRfqSymbol: "SKHY.US_USDC_RFQ",
    backpackSpotSymbol: "SKHY.US_USDC",
    initialMockPrice: 260,
  },
  HOOD: {
    symbol: "HOOD",
    name: "Robinhood",
    mint: "HooDYv5RewLRiMLnEVq3VJqdqxhuE6c5eYvqejMC3e9A",
    decimals: 6,
    backpackAsset: "HOOD.US",
    backpackRfqSymbol: "HOOD.US_USDC_RFQ",
    initialMockPrice: 145,
  },
  INTC: {
    symbol: "INTC",
    name: "Intel",
    mint: "iNTCy1qTsUEZQe3DSocLz1ZXXai34Gdw8THQh5rxFaF",
    decimals: 6,
    backpackAsset: "INTC.US",
    backpackRfqSymbol: "INTC.US_USDC_RFQ",
    initialMockPrice: 45,
  },
  MSTR: {
    symbol: "MSTR",
    name: "Strategy",
    mint: "MSTRdWXMeZxdE8osAQy3fA4rvTY5rgummDSMEx6U7Nz",
    decimals: 6,
    backpackAsset: "MSTR.US",
    backpackRfqSymbol: "MSTR.US_USDC_RFQ",
    initialMockPrice: 560,
  },
};

export const DEFAULT_ASSETS: AssetSymbol[] = [
  "MU",
  "SKHY",
  "SNDK",
  "INTC",
  "MSTR",
];

export function selectAssets(value: string | undefined): AssetDefinition[] {
  const requested =
    !value || value.trim() === ""
      ? DEFAULT_ASSETS
      : value.trim().toUpperCase() === "ALL"
        ? (Object.keys(ASSET_REGISTRY) as AssetSymbol[])
        : value
            .split(",")
            .map((part) => part.trim().toUpperCase())
            .filter(Boolean) as AssetSymbol[];

  return requested.map((symbol) => {
    const asset = ASSET_REGISTRY[symbol];
    if (!asset) {
      throw new Error(`未知标的 ${symbol}，仅允许：${Object.keys(ASSET_REGISTRY).join(", ")}`);
    }
    return asset;
  });
}
