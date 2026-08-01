import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AlertDispatcher } from "../src/alerts.js";
import { ASSET_REGISTRY } from "../src/assets.js";
import type { AppConfig } from "../src/config.js";
import { Recorder } from "../src/db.js";
import { Monitor } from "../src/monitor.js";
import {
  createSeededRandom,
  MockMarketDataProvider,
} from "../src/providers/mock.js";
import type {
  AlertMode,
  AssetDefinition,
  AssetSide,
  ExecutableQuote,
  MarketDataProvider,
} from "../src/types.js";

const temporaryDirectories: string[] = [];
const PROTECTED_JUPITER_OUTPUT = 0.984326;

interface BackpackVerificationCall {
  side: AssetSide;
  quantity: number;
}

class DeterministicMarketDataProvider implements MarketDataProvider {
  readonly backpackVerificationCalls: BackpackVerificationCall[] = [];

  constructor(
    private readonly backpackSellReferenceUnitPrice: number,
    private readonly verificationError?: Error,
  ) {}

  async quoteBackpackReference(
    asset: AssetDefinition,
    side: AssetSide,
    quantity: number,
  ): Promise<ExecutableQuote> {
    return fixedQuote({
      asset,
      venue: "BACKPACK",
      source: "BACKPACK_TOP_OF_BOOK",
      side,
      quantity,
      unitPrice:
        side === "BUY_ASSET" ? 101 : this.backpackSellReferenceUnitPrice,
      executable: false,
    });
  }

  async quoteBackpack(
    asset: AssetDefinition,
    side: AssetSide,
    quantity: number,
  ): Promise<ExecutableQuote> {
    this.backpackVerificationCalls.push({ side, quantity });
    if (this.verificationError) throw this.verificationError;
    return fixedQuote({
      asset,
      venue: "BACKPACK",
      source: "BACKPACK_RFQ",
      side,
      quantity,
      unitPrice:
        side === "BUY_ASSET" ? 101 : this.backpackSellReferenceUnitPrice,
      executable: true,
    });
  }

  async quoteJupiterSell(
    asset: AssetDefinition,
    quantity: number,
  ): Promise<ExecutableQuote> {
    return fixedQuote({
      asset,
      venue: "JUPITER",
      source: "JUPITER_SWAP_V2",
      side: "SELL_ASSET",
      quantity,
      unitPrice: 100,
      executable: true,
    });
  }

  async quoteJupiterBuy(
    asset: AssetDefinition,
    _targetQuantity: number,
    _referenceUnitPrice: number,
  ): Promise<ExecutableQuote> {
    const quote = fixedQuote({
      asset,
      venue: "JUPITER",
      source: "JUPITER_SWAP_V2",
      side: "BUY_ASSET",
      quantity: PROTECTED_JUPITER_OUTPUT,
      unitPrice: 100 / PROTECTED_JUPITER_OUTPUT,
      executable: true,
    });
    quote.usdcAmount = 100;
    return quote;
  }
}

function fixedQuote(input: {
  asset: AssetDefinition;
  venue: ExecutableQuote["venue"];
  source: ExecutableQuote["source"];
  side: AssetSide;
  quantity: number;
  unitPrice: number;
  executable: boolean;
}): ExecutableQuote {
  const now = Date.now();
  return {
    venue: input.venue,
    source: input.source,
    asset: input.asset.symbol,
    side: input.side,
    assetQuantity: input.quantity,
    usdcAmount: input.quantity * input.unitPrice,
    unitPrice: input.unitPrice,
    priceImpactBps: input.venue === "JUPITER" ? 1 : 0,
    latencyMs: 1,
    observedAt: now,
    validUntil: now + 60_000,
    executable: input.executable,
    raw: { deterministic: true },
  };
}

function deterministicConfig(
  directory: string,
  alertMode: AlertMode,
): AppConfig {
  return {
    dbPath: path.join(directory, "test.sqlite"),
    assets: [ASSET_REGISTRY.MSTR],
    quantities: [1],
    monitorIntervalMs: 0,
    alertMode,
    thresholds: {
      minGrossSpreadBps: 100,
      minNetSpreadBps: 100,
      minProfitUsdc: 1,
      maxJupiterPriceImpactBps: 30,
      maxQuoteAgeMs: 60_000,
    },
    costs: {
      rebalanceUsdc: 0,
      failureBufferUsdc: 0,
      networkUsdc: 0,
    },
    jupiter: {
      slippageBps: 30,
      minRequestIntervalMs: 0,
    },
    backpack: {
      mode: "auto",
      rfqPollMs: 75,
      rfqTimeoutMs: 1_500,
    },
    alerts: {
      cooldownMs: 300_000,
      onSourceError: true,
    },
    paperTrading: {
      enabled: false,
      maxLossUsdc: 10,
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Monitor integration", () => {
  it("一轮扫描写入四条报价和两个方向的机会", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-jup-test-"));
    temporaryDirectories.push(directory);
    const config: AppConfig = {
      dbPath: path.join(directory, "test.sqlite"),
      assets: [ASSET_REGISTRY.MSTR],
      quantities: [1],
      monitorIntervalMs: 0,
      alertMode: "EXECUTABLE",
      thresholds: {
        minGrossSpreadBps: 30,
        minNetSpreadBps: 60,
        minProfitUsdc: 5,
        maxJupiterPriceImpactBps: 30,
        maxQuoteAgeMs: 800,
      },
      costs: {
        rebalanceUsdc: 0.5,
        failureBufferUsdc: 0.5,
        networkUsdc: 0.02,
      },
      jupiter: {
        slippageBps: 30,
        minRequestIntervalMs: 0,
      },
      backpack: {
        mode: "auto",
        rfqPollMs: 75,
        rfqTimeoutMs: 1_500,
      },
      alerts: {
        cooldownMs: 300_000,
        onSourceError: true,
      },
      paperTrading: {
        enabled: false,
        maxLossUsdc: 10,
      },
    };
    const recorder = new Recorder(config.dbPath);
    try {
      const provider = new MockMarketDataProvider(
        createSeededRandom(42),
        config.assets,
      );
      const monitor = new Monitor(
        config,
        recorder,
        provider,
        new AlertDispatcher(recorder, config.alerts),
      );
      const result = await monitor.scanOnce("SIMULATED");

      expect(result.errors).toBe(0);
      expect(result.opportunities).toHaveLength(2);
      expect(
        recorder.sqlite.prepare("SELECT COUNT(*) AS count FROM quotes").get(),
      ).toEqual({ count: 4 });
      expect(
        recorder.sqlite
          .prepare("SELECT COUNT(*) AS count FROM opportunities")
          .get(),
      ).toEqual({ count: 2 });
      expect(
        recorder.sqlite
          .prepare("SELECT status FROM scan_runs WHERE id = ?")
          .get(result.runId),
      ).toEqual({ status: "COMPLETED" });
    } finally {
      recorder.close();
    }
  });

  it("参考价差未达标时不调用 Backpack 可执行报价验证", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-jup-test-"));
    temporaryDirectories.push(directory);
    const config = deterministicConfig(directory, "EXECUTABLE");
    const recorder = new Recorder(config.dbPath);
    const provider = new DeterministicMarketDataProvider(101);

    try {
      const monitor = new Monitor(
        config,
        recorder,
        provider,
        new AlertDispatcher(recorder, config.alerts),
      );
      const result = await monitor.scanOnce("LIVE");

      expect(result.errors).toBe(0);
      expect(result.opportunities).toHaveLength(2);
      expect(result.opportunities.every((opportunity) => !opportunity.eligible))
        .toBe(true);
      expect(provider.backpackVerificationCalls).toEqual([]);
    } finally {
      recorder.close();
    }
  });

  it("Jupiter 买方向按保护输出验证，RFQ 余额不足时保留参考机会并记录价差", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-jup-test-"));
    temporaryDirectories.push(directory);
    const config = deterministicConfig(directory, "EXECUTABLE");
    const insufficientFunds = new Error(
      'Backpack /api/v1/rfq 400: {"code":"INSUFFICIENT_FUNDS","message":"Insufficient funds"}',
    );
    const recorder = new Recorder(config.dbPath);
    const provider = new DeterministicMarketDataProvider(
      110,
      insufficientFunds,
    );

    try {
      const monitor = new Monitor(
        config,
        recorder,
        provider,
        new AlertDispatcher(recorder, config.alerts),
      );
      const result = await monitor.scanOnce("LIVE");
      const reference = result.opportunities.find(
        (opportunity) =>
          opportunity.direction === "JUPITER_BUY_BACKPACK_SELL" &&
          opportunity.stage === "REFERENCE",
      );

      expect(provider.backpackVerificationCalls).toHaveLength(1);
      expect(provider.backpackVerificationCalls[0]?.side).toBe("SELL_ASSET");
      expect(provider.backpackVerificationCalls[0]?.quantity).toBe(
        PROTECTED_JUPITER_OUTPUT,
      );
      expect(result.errors).toBe(1);
      expect(reference).toBeDefined();
      expect(reference?.eligible).toBe(true);
      expect(
        result.opportunities.some(
          (opportunity) => opportunity.stage === "RFQ_VERIFIED",
        ),
      ).toBe(false);

      const sourceError = recorder.sqlite
        .prepare(
          `SELECT stage, message
           FROM source_errors
           WHERE run_id = ?`,
        )
        .get(result.runId) as { stage: string; message: string };
      expect(sourceError.stage).toBe("BACKPACK_SELL_VERIFY");
      expect(sourceError.message).toContain("INSUFFICIENT_FUNDS");

      const verificationAlert = recorder.sqlite
        .prepare(
          `SELECT type, message
           FROM alerts
           WHERE type = 'RFQ_VERIFICATION_FAILED'`,
        )
        .get() as { type: string; message: string };
      expect(verificationAlert.type).toBe("RFQ_VERIFICATION_FAILED");
      expect(verificationAlert.message).toContain("INSUFFICIENT_FUNDS");
      expect(verificationAlert.message).toContain(
        `参考净价差：${reference?.netSpreadBps.toFixed(2)} bps`,
      );
    } finally {
      recorder.close();
    }
  });

  it("QUOTE_ONLY 模式下参考价差达标也不调用 Backpack 验证", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-jup-test-"));
    temporaryDirectories.push(directory);
    const config = deterministicConfig(directory, "QUOTE_ONLY");
    const recorder = new Recorder(config.dbPath);
    const provider = new DeterministicMarketDataProvider(110);

    try {
      const monitor = new Monitor(
        config,
        recorder,
        provider,
        new AlertDispatcher(recorder, config.alerts),
      );
      const result = await monitor.scanOnce("LIVE");
      const reference = result.opportunities.find(
        (opportunity) =>
          opportunity.direction === "JUPITER_BUY_BACKPACK_SELL",
      );

      expect(reference?.stage).toBe("REFERENCE");
      expect(reference?.eligible).toBe(true);
      expect(provider.backpackVerificationCalls).toEqual([]);
      expect(result.errors).toBe(0);
    } finally {
      recorder.close();
    }
  });

  it("参考机会与 RFQ 复核机会分别提醒且互不占用冷却键", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-jup-test-"));
    temporaryDirectories.push(directory);
    const config = deterministicConfig(directory, "EXECUTABLE");
    const recorder = new Recorder(config.dbPath);
    const provider = new DeterministicMarketDataProvider(110);

    try {
      const monitor = new Monitor(
        config,
        recorder,
        provider,
        new AlertDispatcher(recorder, config.alerts),
      );
      const result = await monitor.scanOnce("LIVE");
      const candidateStages = result.opportunities
        .filter(
          (opportunity) =>
            opportunity.direction === "JUPITER_BUY_BACKPACK_SELL" &&
            opportunity.eligible,
        )
        .map((opportunity) => opportunity.stage);
      const alertTypes = recorder.sqlite
        .prepare(
          `SELECT type
           FROM alerts
           WHERE type IN ('REFERENCE_OPPORTUNITY', 'RFQ_VERIFIED_OPPORTUNITY')
           ORDER BY id`,
        )
        .all() as Array<{ type: string }>;

      expect(candidateStages).toEqual(["REFERENCE", "RFQ_VERIFIED"]);
      expect(alertTypes.map((alert) => alert.type)).toEqual([
        "REFERENCE_OPPORTUNITY",
        "RFQ_VERIFIED_OPPORTUNITY",
      ]);
      expect(provider.backpackVerificationCalls).toEqual([
        { side: "SELL_ASSET", quantity: PROTECTED_JUPITER_OUTPUT },
      ]);
    } finally {
      recorder.close();
    }
  });
});
