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

const temporaryDirectories: string[] = [];

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
});
