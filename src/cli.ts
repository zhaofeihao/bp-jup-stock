#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { selectAssets } from "./assets.js";
import { validateAssets } from "./asset-validator.js";
import { AlertDispatcher } from "./alerts.js";
import { loadConfig } from "./config.js";
import { toCsv } from "./csv.js";
import { Recorder } from "./db.js";
import { Monitor, runMonitorLoop } from "./monitor.js";
import { PaperTrader } from "./paper.js";
import { LiveMarketDataProvider } from "./providers/live.js";
import {
  createSeededRandom,
  MockMarketDataProvider,
} from "./providers/mock.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  const args = process.argv.slice(3);
  const config = loadConfig();
  const recorder = new Recorder(config.dbPath);

  try {
    switch (command) {
      case "db:init":
        console.log(`SQLite 已初始化：${config.dbPath}`);
        break;
      case "simulate":
        await simulate(config, recorder, args);
        break;
      case "monitor":
        await monitorLive(config, recorder, args);
        break;
      case "report":
        report(recorder, optionNumber(args, "--limit", 20));
        break;
      case "export":
        exportData(
          recorder,
          path.resolve(
            process.cwd(),
            optionString(args, "--out", "./data/opportunities.csv"),
          ),
        );
        break;
      case "validate-assets":
        await validateRegistry(config, recorder);
        break;
      case "help":
      case "--help":
      case "-h":
        printHelp();
        break;
      default:
        throw new Error(`未知命令：${command}`);
    }
  } finally {
    recorder.close();
  }
}

async function simulate(
  config: ReturnType<typeof loadConfig>,
  recorder: Recorder,
  args: string[],
): Promise<void> {
  const cycles = optionNumber(args, "--cycles", 100);
  const intervalMs = optionNumber(args, "--interval-ms", 0);
  const seed = optionNumber(args, "--seed", 42);
  const marketRandom = createSeededRandom(seed);
  const paperRandom = createSeededRandom(seed + 1);
  const provider = new MockMarketDataProvider(marketRandom, config.assets);
  const alerts = new AlertDispatcher(recorder, config.alerts);
  const paper = new PaperTrader(
    paperRandom,
    config.paperTrading.maxLossUsdc,
  );
  const monitor = new Monitor(config, recorder, provider, alerts, paper);
  const controller = processSignals();
  console.log(
    `开始模拟：assets=${config.assets.map((asset) => asset.symbol).join(",")} cycles=${cycles} seed=${seed}`,
  );
  await runMonitorLoop(
    monitor,
    "SIMULATED",
    intervalMs,
    controller.signal,
    cycles,
  );
  report(recorder, 10);
}

async function monitorLive(
  config: ReturnType<typeof loadConfig>,
  recorder: Recorder,
  args: string[],
): Promise<void> {
  if (config.alertMode === "QUOTE_ONLY") {
    console.warn(
      "当前为 QUOTE_ONLY 观察模式：仅使用公开行情初筛，不发 Backpack RFQ；提醒不是可执行报价。",
    );
  } else if (!config.jupiter.taker) {
    console.warn(
      "提示：未配置 JUPITER_TAKER，Jupiter 只返回价格而不组装交易，机会会被标记为不可执行。",
    );
  }
  if (
    config.alertMode === "EXECUTABLE" &&
    config.backpack.mode !== "depth" &&
    (!config.backpack.apiKey || !config.backpack.apiSecret)
  ) {
    console.warn(
      "提示：未配置 Backpack RFQ 密钥；参考价差仍会监控，第二阶段只能尝试足量现货订单簿。",
    );
  }

  const provider = new LiveMarketDataProvider(config);
  const alerts = new AlertDispatcher(recorder, config.alerts);
  const paper = config.paperTrading.enabled
    ? new PaperTrader(
        createSeededRandom(Date.now()),
        config.paperTrading.maxLossUsdc,
      )
    : undefined;
  const monitor = new Monitor(config, recorder, provider, alerts, paper);
  const once = args.includes("--once");
  const controller = processSignals();
  console.log(
    `开始实时监控：assets=${config.assets.map((asset) => asset.symbol).join(",")} interval=${config.monitorIntervalMs}ms alertMode=${config.alertMode}`,
  );
  await runMonitorLoop(
    monitor,
    "LIVE",
    config.monitorIntervalMs,
    controller.signal,
    once ? 1 : Number.POSITIVE_INFINITY,
  );
}

function report(recorder: Recorder, recentLimit: number): void {
  const opportunityRows = recorder.opportunityReport();
  console.log("\n机会统计");
  opportunityRows.length > 0
    ? console.table(opportunityRows)
    : console.log("暂无机会数据");

  const paperRows = recorder.paperReport();
  console.log("\n纸面成交统计");
  paperRows.length > 0 ? console.table(paperRows) : console.log("暂无纸面成交");

  const recent = recorder.recentOpportunities(recentLimit);
  console.log(`\n最近 ${recentLimit} 条机会`);
  recent.length > 0 ? console.table(recent) : console.log("暂无机会数据");
}

function exportData(recorder: Recorder, outputPath: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const rows = recorder.allOpportunities();
  fs.writeFileSync(outputPath, toCsv(rows), "utf8");
  console.log(`已导出 ${rows.length} 条机会：${outputPath}`);
}

async function validateRegistry(
  config: ReturnType<typeof loadConfig>,
  recorder: Recorder,
): Promise<void> {
  const assets = selectAssets("ALL");
  const results = await validateAssets(assets, config.jupiter.apiKey);
  for (const result of results) {
    recorder.saveAssetCheck(result);
  }
  console.table(
    results.map((result) => ({
      asset: result.asset,
      mint: result.mintMatches ? "OK" : "MISMATCH",
      deposit: result.depositEnabled,
      withdraw: result.withdrawEnabled,
      rfq_security: result.securityTradable,
      spot_book: result.spotMarketAvailable,
      jupiter_price: result.jupiterPriceAvailable,
      healthy: result.healthy,
    })),
  );
  const unhealthy = results.filter((result) => !result.healthy);
  if (unhealthy.length > 0) {
    process.exitCode = 2;
    console.error(
      `有 ${unhealthy.length} 个标的未通过动态检查：${unhealthy.map((item) => item.asset).join(", ")}`,
    );
  }
}

function processSignals(): AbortController {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return controller;
}

function optionString(
  args: string[],
  name: string,
  fallback: string,
): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
}

function optionNumber(
  args: string[],
  name: string,
  fallback: number,
): number {
  const raw = optionString(args, name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} 必须是非负数`);
  }
  return value;
}

function printHelp(): void {
  console.log(`
用法：
  npm run db:init
  npm run simulate -- --cycles 500 --seed 42 --interval-ms 0
  npm run monitor -- --once
  npm run monitor
  npm run validate:assets
  npm run report -- --limit 20
  npm run export -- --out ./data/opportunities.csv
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
