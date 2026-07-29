import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  ExecutableQuote,
  Opportunity,
  PaperTrade,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL CHECK (mode IN ('SIMULATED', 'LIVE')),
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES scan_runs(id),
  asset TEXT NOT NULL,
  requested_quantity REAL NOT NULL,
  venue TEXT NOT NULL,
  side TEXT NOT NULL,
  source TEXT NOT NULL,
  asset_quantity REAL NOT NULL,
  usdc_amount REAL NOT NULL,
  unit_price REAL NOT NULL,
  price_impact_bps REAL NOT NULL,
  latency_ms INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  valid_until INTEGER,
  executable INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES scan_runs(id),
  asset TEXT NOT NULL,
  direction TEXT NOT NULL,
  requested_quantity REAL NOT NULL,
  quantity REAL NOT NULL,
  buy_quote_id INTEGER NOT NULL REFERENCES quotes(id),
  sell_quote_id INTEGER NOT NULL REFERENCES quotes(id),
  buy_venue TEXT NOT NULL,
  sell_venue TEXT NOT NULL,
  buy_usdc REAL NOT NULL,
  sell_usdc REAL NOT NULL,
  buy_unit_price REAL NOT NULL,
  sell_unit_price REAL NOT NULL,
  gross_profit_usdc REAL NOT NULL,
  total_cost_usdc REAL NOT NULL,
  net_profit_usdc REAL NOT NULL,
  gross_spread_bps REAL NOT NULL,
  net_spread_bps REAL NOT NULL,
  max_quote_age_ms INTEGER NOT NULL,
  jupiter_price_impact_bps REAL NOT NULL,
  alert_mode TEXT NOT NULL CHECK (alert_mode IN ('EXECUTABLE', 'QUOTE_ONLY')),
  execution_verified INTEGER NOT NULL,
  eligible INTEGER NOT NULL,
  reject_reasons_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id INTEGER REFERENCES opportunities(id),
  type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS source_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES scan_runs(id),
  asset TEXT,
  stage TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id),
  asset TEXT NOT NULL,
  direction TEXT NOT NULL,
  quantity REAL NOT NULL,
  expected_profit_usdc REAL NOT NULL,
  realized_profit_usdc REAL NOT NULL,
  final_state TEXT NOT NULL,
  state_history_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset TEXT NOT NULL,
  expected_mint TEXT NOT NULL,
  actual_mint TEXT,
  mint_matches INTEGER NOT NULL,
  deposit_enabled INTEGER NOT NULL,
  withdraw_enabled INTEGER NOT NULL,
  security_tradable INTEGER NOT NULL,
  spot_market_available INTEGER NOT NULL,
  jupiter_price_available INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quotes_asset_time
  ON quotes(asset, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_asset_time
  ON opportunities(asset, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_eligible
  ON opportunities(eligible, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_dedupe_time
  ON alerts(dedupe_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_trades_time
  ON paper_trades(created_at DESC);
`;

export interface OpportunityReportRow {
  asset: string;
  direction: string;
  requested_quantity: number;
  alert_mode: string;
  samples: number;
  eligible_samples: number;
  execution_verified_samples: number;
  average_net_spread_bps: number;
  maximum_net_spread_bps: number;
  total_expected_profit_usdc: number;
}

export class Recorder {
  readonly sqlite: Database.Database;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.sqlite = new Database(filePath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.sqlite.exec(SCHEMA);
    this.migrateSchema();
  }

  close(): void {
    this.sqlite.close();
  }

  startRun(mode: "SIMULATED" | "LIVE", now = Date.now()): number {
    const result = this.sqlite
      .prepare(
        `INSERT INTO scan_runs (mode, status, started_at)
         VALUES (?, 'RUNNING', ?)`,
      )
      .run(mode, now);
    return Number(result.lastInsertRowid);
  }

  finishRun(
    runId: number,
    status: "COMPLETED" | "PARTIAL" | "FAILED",
    error?: string,
    now = Date.now(),
  ): void {
    this.sqlite
      .prepare(
        `UPDATE scan_runs
         SET status = ?, finished_at = ?, error = ?
         WHERE id = ?`,
      )
      .run(status, now, error ?? null, runId);
  }

  saveQuote(
    runId: number,
    requestedQuantity: number,
    quote: ExecutableQuote,
  ): number {
    const result = this.sqlite
      .prepare(
        `INSERT INTO quotes (
          run_id, asset, requested_quantity, venue, side, source,
          asset_quantity, usdc_amount, unit_price, price_impact_bps,
          latency_ms, observed_at, valid_until, executable, raw_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        quote.asset,
        requestedQuantity,
        quote.venue,
        quote.side,
        quote.source,
        quote.assetQuantity,
        quote.usdcAmount,
        quote.unitPrice,
        quote.priceImpactBps,
        Math.round(quote.latencyMs),
        quote.observedAt,
        quote.validUntil,
        quote.executable ? 1 : 0,
        JSON.stringify(quote.raw),
        Date.now(),
      );
    return Number(result.lastInsertRowid);
  }

  saveOpportunity(
    runId: number,
    buyQuoteId: number,
    sellQuoteId: number,
    opportunity: Opportunity,
  ): number {
    const result = this.sqlite
      .prepare(
        `INSERT INTO opportunities (
          run_id, asset, direction, requested_quantity, quantity,
          buy_quote_id, sell_quote_id, buy_venue, sell_venue,
          buy_usdc, sell_usdc, buy_unit_price, sell_unit_price,
          gross_profit_usdc, total_cost_usdc, net_profit_usdc,
          gross_spread_bps, net_spread_bps, max_quote_age_ms,
          jupiter_price_impact_bps, alert_mode, execution_verified,
          eligible, reject_reasons_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        opportunity.asset,
        opportunity.direction,
        opportunity.requestedQuantity,
        opportunity.quantity,
        buyQuoteId,
        sellQuoteId,
        opportunity.buyVenue,
        opportunity.sellVenue,
        opportunity.buyUsdc,
        opportunity.sellUsdc,
        opportunity.buyUnitPrice,
        opportunity.sellUnitPrice,
        opportunity.grossProfitUsdc,
        opportunity.totalCostUsdc,
        opportunity.netProfitUsdc,
        opportunity.grossSpreadBps,
        opportunity.netSpreadBps,
        Math.round(opportunity.maxQuoteAgeMs),
        opportunity.jupiterPriceImpactBps,
        opportunity.alertMode,
        opportunity.executionVerified ? 1 : 0,
        opportunity.eligible ? 1 : 0,
        JSON.stringify(opportunity.rejectReasons),
        opportunity.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  recordAlert(input: {
    opportunityId?: number;
    type: string;
    dedupeKey: string;
    status: string;
    message: string;
    error?: string;
    now?: number;
  }): void {
    this.sqlite
      .prepare(
        `INSERT INTO alerts (
          opportunity_id, type, dedupe_key, status, message, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.opportunityId ?? null,
        input.type,
        input.dedupeKey,
        input.status,
        input.message,
        input.error ?? null,
        input.now ?? Date.now(),
      );
  }

  recentlyAlerted(dedupeKey: string, since: number): boolean {
    const row = this.sqlite
      .prepare(
        `SELECT 1
         FROM alerts
         WHERE dedupe_key = ?
           AND created_at >= ?
           AND status IN ('CONSOLE', 'SENT')
         LIMIT 1`,
      )
      .get(dedupeKey, since);
    return row !== undefined;
  }

  recordSourceError(
    runId: number | null,
    asset: string | null,
    stage: string,
    message: string,
    now = Date.now(),
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO source_errors (run_id, asset, stage, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(runId, asset, stage, message, now);
  }

  savePaperTrade(trade: PaperTrade): number {
    const result = this.sqlite
      .prepare(
        `INSERT INTO paper_trades (
          opportunity_id, asset, direction, quantity,
          expected_profit_usdc, realized_profit_usdc,
          final_state, state_history_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trade.opportunityId,
        trade.asset,
        trade.direction,
        trade.quantity,
        trade.expectedProfitUsdc,
        trade.realizedProfitUsdc,
        trade.finalState,
        JSON.stringify(trade.stateHistory),
        trade.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  saveAssetCheck(check: {
    asset: string;
    expectedMint: string;
    actualMint?: string;
    mintMatches: boolean;
    depositEnabled: boolean;
    withdrawEnabled: boolean;
    securityTradable: boolean;
    spotMarketAvailable: boolean;
    jupiterPriceAvailable: boolean;
    raw: unknown;
    checkedAt?: number;
  }): void {
    this.sqlite
      .prepare(
        `INSERT INTO asset_checks (
          asset, expected_mint, actual_mint, mint_matches,
          deposit_enabled, withdraw_enabled, security_tradable,
          spot_market_available, jupiter_price_available, checked_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        check.asset,
        check.expectedMint,
        check.actualMint ?? null,
        check.mintMatches ? 1 : 0,
        check.depositEnabled ? 1 : 0,
        check.withdrawEnabled ? 1 : 0,
        check.securityTradable ? 1 : 0,
        check.spotMarketAvailable ? 1 : 0,
        check.jupiterPriceAvailable ? 1 : 0,
        check.checkedAt ?? Date.now(),
        JSON.stringify(check.raw),
      );
  }

  opportunityReport(): OpportunityReportRow[] {
    return this.sqlite
      .prepare(
        `SELECT
          asset,
          direction,
          requested_quantity,
          alert_mode,
          COUNT(*) AS samples,
          SUM(eligible) AS eligible_samples,
          SUM(execution_verified) AS execution_verified_samples,
          ROUND(AVG(net_spread_bps), 2) AS average_net_spread_bps,
          ROUND(MAX(net_spread_bps), 2) AS maximum_net_spread_bps,
          ROUND(SUM(CASE WHEN eligible = 1 THEN net_profit_usdc ELSE 0 END), 4)
            AS total_expected_profit_usdc
        FROM opportunities
        GROUP BY asset, direction, requested_quantity, alert_mode
        ORDER BY asset, direction, requested_quantity, alert_mode`,
      )
      .all() as OpportunityReportRow[];
  }

  paperReport(): Array<Record<string, string | number>> {
    return this.sqlite
      .prepare(
        `SELECT
          final_state,
          COUNT(*) AS trades,
          ROUND(SUM(expected_profit_usdc), 4) AS expected_profit_usdc,
          ROUND(SUM(realized_profit_usdc), 4) AS realized_profit_usdc
        FROM paper_trades
        GROUP BY final_state
        ORDER BY trades DESC`,
      )
      .all() as Array<Record<string, string | number>>;
  }

  recentOpportunities(limit: number): Array<Record<string, string | number>> {
    return this.sqlite
      .prepare(
        `SELECT
          datetime(created_at / 1000, 'unixepoch', 'localtime') AS time,
          asset,
          direction,
          ROUND(requested_quantity, 6) AS requested_qty,
          ROUND(quantity, 6) AS matched_qty,
          ROUND(net_profit_usdc, 4) AS net_profit,
          ROUND(net_spread_bps, 2) AS net_bps,
          alert_mode,
          execution_verified,
          eligible
        FROM opportunities
        ORDER BY created_at DESC
        LIMIT ?`,
      )
      .all(limit) as Array<Record<string, string | number>>;
  }

  allOpportunities(): Array<Record<string, unknown>> {
    return this.sqlite
      .prepare(
        `SELECT
          o.*,
          b.source AS buy_source,
          s.source AS sell_source
        FROM opportunities o
        JOIN quotes b ON b.id = o.buy_quote_id
        JOIN quotes s ON s.id = o.sell_quote_id
        ORDER BY o.created_at`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  private migrateSchema(): void {
    const columns = this.sqlite
      .prepare("PRAGMA table_info(opportunities)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("alert_mode")) {
      this.sqlite.exec(
        "ALTER TABLE opportunities ADD COLUMN alert_mode TEXT NOT NULL DEFAULT 'EXECUTABLE'",
      );
    }
    if (!names.has("execution_verified")) {
      this.sqlite.exec(
        "ALTER TABLE opportunities ADD COLUMN execution_verified INTEGER NOT NULL DEFAULT 0",
      );
      this.sqlite.exec(`
        UPDATE opportunities
        SET execution_verified =
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM quotes buy_quote
              JOIN quotes sell_quote
                ON sell_quote.id = opportunities.sell_quote_id
              WHERE buy_quote.id = opportunities.buy_quote_id
                AND buy_quote.executable = 1
                AND sell_quote.executable = 1
            )
            THEN 1
            ELSE 0
          END
      `);
    }
  }
}
