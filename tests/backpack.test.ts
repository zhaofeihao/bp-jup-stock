import { describe, expect, it } from "vitest";
import {
  backpackSigningPayload,
  calculateVwap,
} from "../src/providers/backpack.js";

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
});
