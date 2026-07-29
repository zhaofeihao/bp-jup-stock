import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { selectAssets } from "./assets.js";
import type { AlertMode, AssetDefinition } from "./types.js";

loadDotenv({ quiet: true });

export interface AppConfig {
  dbPath: string;
  assets: AssetDefinition[];
  quantities: number[];
  monitorIntervalMs: number;
  alertMode: AlertMode;
  thresholds: {
    minGrossSpreadBps: number;
    minNetSpreadBps: number;
    minProfitUsdc: number;
    maxJupiterPriceImpactBps: number;
    maxQuoteAgeMs: number;
  };
  costs: {
    rebalanceUsdc: number;
    failureBufferUsdc: number;
    networkUsdc: number;
  };
  jupiter: {
    apiKey?: string;
    taker?: string;
    slippageBps: number;
    minRequestIntervalMs: number;
  };
  backpack: {
    mode: "auto" | "rfq" | "depth";
    apiKey?: string;
    apiSecret?: string;
    rfqPollMs: number;
    rfqTimeoutMs: number;
  };
  alerts: {
    telegramBotToken?: string;
    telegramChatId?: string;
    cooldownMs: number;
    onSourceError: boolean;
  };
  paperTrading: {
    enabled: boolean;
    maxLossUsdc: number;
  };
}

function numberFromEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} 必须是数字`);
  return value;
}

function booleanFromEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const backpackMode = (env.BACKPACK_QUOTE_MODE ?? "auto").toLowerCase();
  if (!["auto", "rfq", "depth"].includes(backpackMode)) {
    throw new Error("BACKPACK_QUOTE_MODE 只能是 auto、rfq 或 depth");
  }
  const alertMode = (env.ALERT_MODE ?? "EXECUTABLE").toUpperCase();
  if (!["EXECUTABLE", "QUOTE_ONLY"].includes(alertMode)) {
    throw new Error("ALERT_MODE 只能是 EXECUTABLE 或 QUOTE_ONLY");
  }

  const quantities = (env.QUANTITIES ?? "1,2,5")
    .split(",")
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (quantities.length === 0) throw new Error("QUANTITIES 至少需要一个正数");

  return {
    dbPath: path.resolve(process.cwd(), env.DB_PATH ?? "./data/monitor.sqlite"),
    assets: selectAssets(env.ASSETS),
    quantities,
    monitorIntervalMs: numberFromEnv(env, "MONITOR_INTERVAL_MS", 60_000),
    alertMode: alertMode as AlertMode,
    thresholds: {
      minGrossSpreadBps: numberFromEnv(env, "MIN_GROSS_SPREAD_BPS", 30),
      minNetSpreadBps: numberFromEnv(env, "MIN_NET_SPREAD_BPS", 60),
      minProfitUsdc: numberFromEnv(env, "MIN_PROFIT_USDC", 5),
      maxJupiterPriceImpactBps: numberFromEnv(
        env,
        "MAX_JUPITER_PRICE_IMPACT_BPS",
        30,
      ),
      maxQuoteAgeMs: numberFromEnv(env, "MAX_QUOTE_AGE_MS", 800),
    },
    costs: {
      rebalanceUsdc: numberFromEnv(env, "REBALANCE_COST_USDC", 0.5),
      failureBufferUsdc: numberFromEnv(env, "FAILURE_BUFFER_USDC", 0.5),
      networkUsdc: numberFromEnv(env, "NETWORK_COST_USDC", 0.02),
    },
    jupiter: {
      apiKey: optional(env.JUPITER_API_KEY),
      taker: optional(env.JUPITER_TAKER),
      slippageBps: numberFromEnv(env, "JUPITER_SLIPPAGE_BPS", 30),
      minRequestIntervalMs: numberFromEnv(
        env,
        "JUPITER_MIN_REQUEST_INTERVAL_MS",
        env.JUPITER_API_KEY ? 1_050 : 2_100,
      ),
    },
    backpack: {
      mode: backpackMode as AppConfig["backpack"]["mode"],
      apiKey: optional(env.BACKPACK_API_KEY),
      apiSecret: optional(env.BACKPACK_API_SECRET),
      rfqPollMs: numberFromEnv(env, "BACKPACK_RFQ_POLL_MS", 75),
      rfqTimeoutMs: numberFromEnv(env, "BACKPACK_RFQ_TIMEOUT_MS", 1_500),
    },
    alerts: {
      telegramBotToken: optional(env.TELEGRAM_BOT_TOKEN),
      telegramChatId: optional(env.TELEGRAM_CHAT_ID),
      cooldownMs: numberFromEnv(env, "ALERT_COOLDOWN_MS", 300_000),
      onSourceError: booleanFromEnv(env, "ALERT_ON_SOURCE_ERROR", true),
    },
    paperTrading: {
      enabled: booleanFromEnv(env, "PAPER_TRADING_ENABLED", false),
      maxLossUsdc: numberFromEnv(env, "PAPER_MAX_LOSS_USDC", 10),
    },
  };
}
