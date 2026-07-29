import { Decimal } from "decimal.js";
import type { AppConfig } from "./config.js";
import type {
  AlertMode,
  Opportunity,
  OpportunityInput,
} from "./types.js";

export class OpportunityEngine {
  constructor(
    private readonly thresholds: AppConfig["thresholds"],
    private readonly costs: AppConfig["costs"],
    private readonly alertMode: AlertMode = "EXECUTABLE",
  ) {}

  evaluate(input: OpportunityInput): Opportunity {
    const buyUsdc = new Decimal(input.buyQuote.usdcAmount);
    const sellUsdc = new Decimal(input.sellQuote.usdcAmount);
    const grossProfit = sellUsdc.minus(buyUsdc);
    const totalCost = new Decimal(this.costs.rebalanceUsdc)
      .plus(this.costs.failureBufferUsdc)
      .plus(this.costs.networkUsdc);
    const netProfit = grossProfit.minus(totalCost);
    const grossSpreadBps = buyUsdc.eq(0)
      ? new Decimal(0)
      : grossProfit.div(buyUsdc).mul(10_000);
    const netSpreadBps = buyUsdc.eq(0)
      ? new Decimal(0)
      : netProfit.div(buyUsdc).mul(10_000);
    const maxQuoteAgeMs = Math.max(
      0,
      input.now - input.buyQuote.observedAt,
      input.now - input.sellQuote.observedAt,
    );
    const jupiterQuote =
      input.buyQuote.venue === "JUPITER" ? input.buyQuote : input.sellQuote;
    const jupiterPriceImpactBps = Math.abs(jupiterQuote.priceImpactBps);
    const executionVerified =
      input.buyQuote.executable && input.sellQuote.executable;

    const rejectReasons: string[] = [];
    if (this.alertMode === "EXECUTABLE" && !executionVerified) {
      rejectReasons.push("报价未形成可执行交易");
    }
    if (grossSpreadBps.lt(this.thresholds.minGrossSpreadBps)) {
      rejectReasons.push(`毛价差低于 ${this.thresholds.minGrossSpreadBps} bps`);
    }
    if (netSpreadBps.lt(this.thresholds.minNetSpreadBps)) {
      rejectReasons.push(`净价差低于 ${this.thresholds.minNetSpreadBps} bps`);
    }
    if (netProfit.lt(this.thresholds.minProfitUsdc)) {
      rejectReasons.push(`净利润低于 ${this.thresholds.minProfitUsdc} USDC`);
    }
    if (
      jupiterPriceImpactBps > this.thresholds.maxJupiterPriceImpactBps
    ) {
      rejectReasons.push(
        `Jupiter 价格冲击超过 ${this.thresholds.maxJupiterPriceImpactBps} bps`,
      );
    }
    if (maxQuoteAgeMs > this.thresholds.maxQuoteAgeMs) {
      rejectReasons.push(`报价年龄超过 ${this.thresholds.maxQuoteAgeMs} ms`);
    }
    if (
      input.buyQuote.validUntil !== null &&
      input.buyQuote.validUntil <= input.now
    ) {
      rejectReasons.push("买入报价已过期");
    }
    if (
      input.sellQuote.validUntil !== null &&
      input.sellQuote.validUntil <= input.now
    ) {
      rejectReasons.push("卖出报价已过期");
    }

    return {
      asset: input.asset.symbol,
      direction: input.direction,
      requestedQuantity: input.requestedQuantity,
      quantity: input.quantity,
      buyVenue: input.buyQuote.venue,
      sellVenue: input.sellQuote.venue,
      buyUsdc: buyUsdc.toNumber(),
      sellUsdc: sellUsdc.toNumber(),
      buyUnitPrice: input.buyQuote.unitPrice,
      sellUnitPrice: input.sellQuote.unitPrice,
      grossProfitUsdc: grossProfit.toNumber(),
      totalCostUsdc: totalCost.toNumber(),
      netProfitUsdc: netProfit.toNumber(),
      grossSpreadBps: grossSpreadBps.toNumber(),
      netSpreadBps: netSpreadBps.toNumber(),
      maxQuoteAgeMs,
      jupiterPriceImpactBps,
      alertMode: this.alertMode,
      executionVerified,
      eligible: rejectReasons.length === 0,
      rejectReasons,
      createdAt: input.now,
    };
  }
}
