import type {
  AssetDefinition,
  AssetSide,
  AssetSymbol,
  ExecutableQuote,
  MarketDataProvider,
} from "../types.js";

interface SimulatedState {
  backpackMid: number;
  jupiterBasisBps: number;
}

export function createSeededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let current = value;
    current = Math.imul(current ^ (current >>> 15), current | 1);
    current ^= current + Math.imul(current ^ (current >>> 7), current | 61);
    return ((current ^ (current >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export class MockMarketDataProvider implements MarketDataProvider {
  private readonly states = new Map<AssetSymbol, SimulatedState>();
  private cycle = 0;

  constructor(
    private readonly random: () => number,
    assets: AssetDefinition[],
  ) {
    for (const asset of assets) {
      this.states.set(asset.symbol, {
        backpackMid: asset.initialMockPrice,
        jupiterBasisBps: 0,
      });
    }
  }

  beginCycle(): void {
    this.cycle += 1;
    for (const state of this.states.values()) {
      const returnBps = (this.random() - 0.5) * 18;
      state.backpackMid *= 1 + returnBps / 10_000;

      const ordinaryShock = (this.random() - 0.5) * 35;
      const opportunityShock =
        this.random() < 0.12
          ? (this.random() < 0.5 ? -1 : 1) * (70 + this.random() * 150)
          : 0;
      state.jupiterBasisBps =
        state.jupiterBasisBps * 0.62 + ordinaryShock + opportunityShock;
    }
  }

  async quoteBackpack(
    asset: AssetDefinition,
    side: AssetSide,
    quantity: number,
  ): Promise<ExecutableQuote> {
    const state = this.state(asset);
    const halfSpreadBps = 5 + this.random() * 4;
    const depthBps = Math.max(0, quantity - 1) * 0.8;
    const adjustment =
      side === "BUY_ASSET"
        ? halfSpreadBps + depthBps
        : -(halfSpreadBps + depthBps);
    const unitPrice = state.backpackMid * (1 + adjustment / 10_000);
    return this.mockQuote(
      "BACKPACK",
      asset,
      side,
      quantity,
      unitPrice,
      depthBps,
    );
  }

  async quoteBackpackReference(
    asset: AssetDefinition,
    side: AssetSide,
    quantity: number,
  ): Promise<ExecutableQuote> {
    const quote = await this.quoteBackpack(asset, side, quantity);
    return {
      ...quote,
      executable: false,
      raw: { kind: "REFERENCE", quote: quote.raw },
    };
  }

  async quoteJupiterSell(
    asset: AssetDefinition,
    quantity: number,
  ): Promise<ExecutableQuote> {
    const state = this.state(asset);
    const impactBps = 4 + quantity * 1.4 + this.random() * 5;
    const unitPrice =
      state.backpackMid *
      (1 + (state.jupiterBasisBps - 7 - impactBps) / 10_000);
    return this.mockQuote(
      "JUPITER",
      asset,
      "SELL_ASSET",
      quantity,
      unitPrice,
      impactBps,
    );
  }

  async quoteJupiterBuy(
    asset: AssetDefinition,
    targetQuantity: number,
    referenceUnitPrice: number,
  ): Promise<ExecutableQuote> {
    const state = this.state(asset);
    const impactBps = 4 + targetQuantity * 1.4 + this.random() * 5;
    const unitPrice =
      state.backpackMid *
      (1 + (state.jupiterBasisBps + 7 + impactBps) / 10_000);
    const usdcInput = targetQuantity * referenceUnitPrice;
    // ExactIn：使用最小保证输出，与 Backpack 的卖出数量严格匹配。
    const protectedQuantity =
      (usdcInput / unitPrice) * (1 - 30 / 10_000);
    const quote = this.mockQuote(
      "JUPITER",
      asset,
      "BUY_ASSET",
      protectedQuantity,
      unitPrice,
      impactBps,
    );
    quote.usdcAmount = usdcInput;
    quote.unitPrice = usdcInput / protectedQuantity;
    quote.raw = {
      cycle: this.cycle,
      targetQuantity,
      protectedQuantity,
      jupiterBasisBps: state.jupiterBasisBps,
    };
    return quote;
  }

  private state(asset: AssetDefinition): SimulatedState {
    const state = this.states.get(asset.symbol);
    if (!state) throw new Error(`模拟器没有 ${asset.symbol} 状态`);
    return state;
  }

  private mockQuote(
    venue: "BACKPACK" | "JUPITER",
    asset: AssetDefinition,
    side: AssetSide,
    quantity: number,
    unitPrice: number,
    priceImpactBps: number,
  ): ExecutableQuote {
    const now = Date.now();
    return {
      venue,
      source: "MOCK",
      asset: asset.symbol,
      side,
      assetQuantity: quantity,
      usdcAmount: quantity * unitPrice,
      unitPrice,
      priceImpactBps,
      latencyMs: 1 + this.random() * 8,
      observedAt: now,
      validUntil: now + 1_500,
      executable: true,
      raw: {
        cycle: this.cycle,
        jupiterBasisBps: this.state(asset).jupiterBasisBps,
      },
    };
  }
}
