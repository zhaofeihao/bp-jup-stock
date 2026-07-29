import { describe, expect, it } from "vitest";
import { toCsv } from "../src/csv.js";

describe("toCsv", () => {
  it("转义逗号、引号和对象", () => {
    expect(
      toCsv([
        {
          asset: "MU",
          reason: 'a,"b"',
          raw: { ok: true },
        },
      ]),
    ).toBe('asset,reason,raw\nMU,"a,""b""","{""ok"":true}"\n');
  });
});
