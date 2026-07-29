import { describe, expect, it } from "vitest";
import { formatOpportunity } from "../src/alerts.js";
import { ASSET_REGISTRY } from "../src/assets.js";
import { OpportunityEngine } from "../src/engine.js";
import type { ExecutableQuote } from "../src/types.js";

function quote(
  venue: "BACKPACK" | "JUPITER",
  side: "BUY_ASSET" | "SELL_ASSET",
  usdcAmount: number,
  now: number,
): ExecutableQuote {
  return {
    venue,
    source: "MOCK",
    asset: "MSTR",
    side,
    assetQuantity: 5,
    usdcAmount,
    unitPrice: usdcAmount / 5,
    priceImpactBps: venue === "JUPITER" ? 12 : 0,
    latencyMs: 10,
    observedAt: now - 100,
    validUntil: now + 1_000,
    executable: true,
    raw: {},
  };
}

describe("OpportunityEngine", () => {
  it("扣除成本并识别达标机会", () => {
    const now = 1_800_000_000_000;
    const engine = new OpportunityEngine(
      {
        minGrossSpreadBps: 30,
        minNetSpreadBps: 60,
        minProfitUsdc: 5,
        maxJupiterPriceImpactBps: 30,
        maxQuoteAgeMs: 800,
      },
      {
        rebalanceUsdc: 0.5,
        failureBufferUsdc: 0.5,
        networkUsdc: 0.02,
      },
    );
    const result = engine.evaluate({
      asset: ASSET_REGISTRY.MSTR,
      direction: "JUPITER_BUY_BACKPACK_SELL",
      requestedQuantity: 5,
      quantity: 5,
      buyQuote: quote("JUPITER", "BUY_ASSET", 2_500, now),
      sellQuote: quote("BACKPACK", "SELL_ASSET", 2_525, now),
      now,
    });

    expect(result.grossProfitUsdc).toBe(25);
    expect(result.netProfitUsdc).toBeCloseTo(23.98);
    expect(result.netSpreadBps).toBeCloseTo(95.92);
    expect(result.eligible).toBe(true);
    expect(result.rejectReasons).toEqual([]);
  });

  it("拒绝过期、冲击过高且利润不足的报价", () => {
    const now = 1_800_000_000_000;
    const engine = new OpportunityEngine(
      {
        minGrossSpreadBps: 30,
        minNetSpreadBps: 60,
        minProfitUsdc: 5,
        maxJupiterPriceImpactBps: 30,
        maxQuoteAgeMs: 800,
      },
      { rebalanceUsdc: 0.5, failureBufferUsdc: 0.5, networkUsdc: 0.02 },
    );
    const jupiter = quote("JUPITER", "SELL_ASSET", 501, now);
    jupiter.priceImpactBps = 45;
    jupiter.observedAt = now - 900;
    jupiter.validUntil = now - 1;
    const result = engine.evaluate({
      asset: ASSET_REGISTRY.MSTR,
      direction: "BACKPACK_BUY_JUPITER_SELL",
      requestedQuantity: 1,
      quantity: 1,
      buyQuote: quote("BACKPACK", "BUY_ASSET", 500, now),
      sellQuote: jupiter,
      now,
    });

    expect(result.eligible).toBe(false);
    expect(result.rejectReasons.join(" ")).toContain("价格冲击");
    expect(result.rejectReasons.join(" ")).toContain("报价年龄");
    expect(result.rejectReasons.join(" ")).toContain("过期");
  });

  it("QUOTE_ONLY 模式允许未组装交易触发观察提醒", () => {
    const now = 1_800_000_000_000;
    const engine = new OpportunityEngine(
      {
        minGrossSpreadBps: 30,
        minNetSpreadBps: 60,
        minProfitUsdc: 5,
        maxJupiterPriceImpactBps: 30,
        maxQuoteAgeMs: 800,
      },
      { rebalanceUsdc: 0.5, failureBufferUsdc: 0.5, networkUsdc: 0.02 },
      "QUOTE_ONLY",
    );
    const jupiter = quote("JUPITER", "BUY_ASSET", 2_500, now);
    jupiter.executable = false;
    const result = engine.evaluate({
      asset: ASSET_REGISTRY.MSTR,
      direction: "JUPITER_BUY_BACKPACK_SELL",
      requestedQuantity: 5,
      quantity: 5,
      buyQuote: jupiter,
      sellQuote: quote("BACKPACK", "SELL_ASSET", 2_525, now),
      now,
    });

    expect(result.eligible).toBe(true);
    expect(result.alertMode).toBe("QUOTE_ONLY");
    expect(result.executionVerified).toBe(false);
    expect(result.rejectReasons).not.toContain("报价未形成可执行交易");
    expect(formatOpportunity(result)).toContain("观察价差提醒（需人工确认）");
    expect(formatOpportunity(result)).toContain("不作为提醒门槛");
  });
});
