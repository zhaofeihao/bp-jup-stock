import type { AppConfig } from "../config.js";
import type {
  AssetDefinition,
  AssetSide,
  ExecutableQuote,
  MarketDataProvider,
} from "../types.js";
import { BackpackQuoteProvider } from "./backpack.js";
import { JupiterQuoteProvider } from "./jupiter.js";

export class LiveMarketDataProvider implements MarketDataProvider {
  private readonly backpack: BackpackQuoteProvider;
  private readonly jupiter: JupiterQuoteProvider;

  constructor(config: AppConfig) {
    this.backpack = new BackpackQuoteProvider(config.backpack);
    this.jupiter = new JupiterQuoteProvider(
      config.alertMode === "QUOTE_ONLY"
        ? { ...config.jupiter, taker: undefined }
        : config.jupiter,
    );
  }

  quoteBackpackReference(
    asset: AssetDefinition,
    side: AssetSide,
    quantity: number,
  ): Promise<ExecutableQuote> {
    return this.backpack.quoteReference(asset, side, quantity);
  }

  quoteBackpack(
    asset: AssetDefinition,
    side: AssetSide,
    quantity: number,
  ): Promise<ExecutableQuote> {
    return this.backpack.quote(asset, side, quantity);
  }

  quoteJupiterSell(
    asset: AssetDefinition,
    quantity: number,
  ): Promise<ExecutableQuote> {
    return this.jupiter.quoteSell(asset, quantity);
  }

  quoteJupiterBuy(
    asset: AssetDefinition,
    targetQuantity: number,
    referenceUnitPrice: number,
  ): Promise<ExecutableQuote> {
    return this.jupiter.quoteBuy(asset, targetQuantity, referenceUnitPrice);
  }
}
