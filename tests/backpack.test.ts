import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSET_REGISTRY } from "../src/assets.js";
import {
  BackpackQuoteProvider,
  backpackSigningPayload,
  calculateVwap,
  sortDepthLevels,
} from "../src/providers/backpack.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Backpack helpers", () => {
  it("按字段名排序生成签名正文", () => {
    expect(
      backpackSigningPayload(
        "rfqSubmit",
        {
          symbol: "MU.US_USDC_RFQ",
          side: "Ask",
          quantity: "2",
          executionMode: "AwaitAccept",
        },
        1_750_000_000_000,
        5_000,
      ),
    ).toBe(
      "instruction=rfqSubmit&executionMode=AwaitAccept&quantity=2&side=Ask&symbol=MU.US_USDC_RFQ&timestamp=1750000000000&window=5000",
    );
  });

  it("按指定数量计算多档 VWAP", () => {
    const result = calculateVwap(
      [
        ["100", "1"],
        ["101", "2"],
      ],
      2,
    );
    expect(result.totalUsdc).toBe(201);
    expect(result.unitPrice).toBe(100.5);
    expect(result.topPrice).toBe(100);
  });

  it("深度不足时拒绝报价", () => {
    expect(() => calculateVwap([["100", "0.5"]], 1)).toThrow("深度不足");
  });

  it("卖出前显式把 bids 按价格降序排列", () => {
    const levels = sortDepthLevels(
      [
        ["100", "1"],
        ["102", "1"],
        ["101", "1"],
      ],
      "SELL_ASSET",
    );
    expect(calculateVwap(levels, 2)).toEqual({
      totalUsdc: 203,
      unitPrice: 101.5,
      topPrice: 102,
    });
  });

  it("深度不足时使用盘口顶价生成不可执行参考报价", async () => {
    const timestamp = Date.now() * 1_000;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            asks: [],
            bids: [
              ["100", "0.2"],
              ["102", "0.3"],
            ],
            timestamp,
            lastUpdateId: "1",
          }),
          { status: 200 },
        ),
      ),
    );
    const provider = new BackpackQuoteProvider({
      mode: "auto",
      rfqPollMs: 75,
      rfqTimeoutMs: 1_500,
    });

    const quote = await provider.quoteReference(
      ASSET_REGISTRY.SKHY,
      "SELL_ASSET",
      5,
    );

    expect(quote.source).toBe("BACKPACK_TOP_OF_BOOK");
    expect(quote.unitPrice).toBe(102);
    expect(quote.usdcAmount).toBe(510);
    expect(quote.executable).toBe(false);
    expect(quote.note).toContain("0.5 / 5");
  });

  it("订单簿对应方向为空时回退到 Venue 最新成交价", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            asks: [["101", "1"]],
            bids: [],
            timestamp: Date.now() * 1_000,
            lastUpdateId: "1",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            symbol: "SKHY.US_USDC",
            firstPrice: "99",
            lastPrice: "100.25",
            priceChange: "1.25",
            priceChangePercent: "0.0126",
            high: "102",
            low: "98",
            volume: "5",
            quoteVolume: "500",
            trades: "3",
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new BackpackQuoteProvider({
      mode: "auto",
      rfqPollMs: 75,
      rfqTimeoutMs: 1_500,
    });

    const quote = await provider.quoteReference(
      ASSET_REGISTRY.SKHY,
      "SELL_ASSET",
      2,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("source=Venue");
    expect(quote.source).toBe("BACKPACK_TICKER_VENUE");
    expect(quote.unitPrice).toBe(100.25);
    expect(quote.executable).toBe(false);
  });
});
