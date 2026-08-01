import type { AppConfig } from "./config.js";
import type { Recorder } from "./db.js";
import { OpportunityEngine } from "./engine.js";
import type {
  AssetDefinition,
  ExecutableQuote,
  MarketDataProvider,
  Opportunity,
  OpportunityDirection,
  OpportunityStage,
} from "./types.js";
import { AlertDispatcher } from "./alerts.js";
import { PaperTrader } from "./paper.js";

export interface ScanResult {
  runId: number;
  opportunities: Opportunity[];
  errors: number;
}

interface SavedQuote {
  quote: ExecutableQuote;
  id: number;
}

interface SavedOpportunity {
  opportunity: Opportunity;
  id: number;
}

export class Monitor {
  private readonly engine: OpportunityEngine;

  constructor(
    private readonly config: AppConfig,
    private readonly recorder: Recorder,
    private readonly provider: MarketDataProvider,
    private readonly alerts: AlertDispatcher,
    private readonly paperTrader?: PaperTrader,
  ) {
    this.engine = new OpportunityEngine(
      config.thresholds,
      config.costs,
      config.alertMode,
    );
  }

  async scanOnce(mode: "SIMULATED" | "LIVE"): Promise<ScanResult> {
    const runId = this.recorder.startRun(mode);
    const opportunities: Opportunity[] = [];
    let errors = 0;

    try {
      await this.provider.beginCycle?.();
      for (const asset of this.config.assets) {
        for (const requestedQuantity of this.config.quantities) {
          const result = await this.scanSize(runId, asset, requestedQuantity);
          opportunities.push(...result.opportunities);
          errors += result.errors;
        }
      }
      this.recorder.finishRun(runId, errors > 0 ? "PARTIAL" : "COMPLETED");
      return { runId, opportunities, errors };
    } catch (error) {
      this.recorder.finishRun(runId, "FAILED", errorMessage(error));
      throw error;
    }
  }

  private async scanSize(
    runId: number,
    asset: AssetDefinition,
    requestedQuantity: number,
  ): Promise<{ opportunities: Opportunity[]; errors: number }> {
    const opportunities: Opportunity[] = [];
    let errors = 0;

    const [jupiterSell, backpackBuyReference] = await Promise.all([
      this.tryQuote(
        runId,
        asset,
        "JUPITER_SELL",
        requestedQuantity,
        () => this.provider.quoteJupiterSell(asset, requestedQuantity),
      ),
      this.tryQuote(
        runId,
        asset,
        "BACKPACK_BUY_REFERENCE",
        requestedQuantity,
        () =>
          this.provider.quoteBackpackReference(
            asset,
            "BUY_ASSET",
            requestedQuantity,
          ),
      ),
    ]);
    if (!jupiterSell) errors += 1;
    if (!backpackBuyReference) errors += 1;

    if (backpackBuyReference && jupiterSell) {
      const reference = await this.persistOpportunity(
        runId,
        requestedQuantity,
        backpackBuyReference,
        jupiterSell,
        asset,
        "BACKPACK_BUY_JUPITER_SELL",
        "REFERENCE",
      );
      opportunities.push(reference.opportunity);

      if (
        reference.opportunity.eligible &&
        this.config.alertMode === "EXECUTABLE"
      ) {
        const backpackBuy = await this.tryVerificationQuote(
          runId,
          asset,
          "BACKPACK_BUY_VERIFY",
          requestedQuantity,
          reference,
          () =>
            this.provider.quoteBackpack(
              asset,
              "BUY_ASSET",
              requestedQuantity,
            ),
        );
        if (!backpackBuy) {
          errors += 1;
        } else {
          const verified = await this.persistOpportunity(
            runId,
            requestedQuantity,
            backpackBuy,
            jupiterSell,
            asset,
            "BACKPACK_BUY_JUPITER_SELL",
            "RFQ_VERIFIED",
          );
          opportunities.push(verified.opportunity);
        }
      }
    }

    const referencePrice =
      backpackBuyReference?.quote.unitPrice ?? jupiterSell?.quote.unitPrice;
    if (referencePrice !== undefined) {
      const jupiterBuy = await this.tryQuote(
        runId,
        asset,
        "JUPITER_BUY",
        requestedQuantity,
        () =>
          this.provider.quoteJupiterBuy(
            asset,
            requestedQuantity,
            referencePrice,
          ),
      );
      if (!jupiterBuy) {
        errors += 1;
      } else {
        const backpackSellReference = await this.tryQuote(
          runId,
          asset,
          "BACKPACK_SELL_REFERENCE",
          requestedQuantity,
          () =>
            this.provider.quoteBackpackReference(
              asset,
              "SELL_ASSET",
              jupiterBuy.quote.assetQuantity,
            ),
        );
        if (!backpackSellReference) {
          errors += 1;
        } else {
          const reference = await this.persistOpportunity(
            runId,
            requestedQuantity,
            jupiterBuy,
            backpackSellReference,
            asset,
            "JUPITER_BUY_BACKPACK_SELL",
            "REFERENCE",
          );
          opportunities.push(reference.opportunity);

          if (
            reference.opportunity.eligible &&
            this.config.alertMode === "EXECUTABLE"
          ) {
            const backpackSell = await this.tryVerificationQuote(
              runId,
              asset,
              "BACKPACK_SELL_VERIFY",
              requestedQuantity,
              reference,
              () =>
                this.provider.quoteBackpack(
                  asset,
                  "SELL_ASSET",
                  jupiterBuy.quote.assetQuantity,
                ),
            );
            if (!backpackSell) {
              errors += 1;
            } else {
              const verified = await this.persistOpportunity(
                runId,
                requestedQuantity,
                jupiterBuy,
                backpackSell,
                asset,
                "JUPITER_BUY_BACKPACK_SELL",
                "RFQ_VERIFIED",
              );
              opportunities.push(verified.opportunity);
            }
          }
        }
      }
    }

    return { opportunities, errors };
  }

  private async tryQuote(
    runId: number,
    asset: AssetDefinition,
    stage: string,
    requestedQuantity: number,
    load: () => Promise<ExecutableQuote>,
  ): Promise<SavedQuote | undefined> {
    try {
      const quote = await load();
      const id = this.recorder.saveQuote(runId, requestedQuantity, quote);
      return { quote, id };
    } catch (error) {
      this.recorder.recordSourceError(
        runId,
        asset.symbol,
        stage,
        errorMessage(error),
      );
      await this.alerts.sourceError(asset.symbol, stage, error);
      return undefined;
    }
  }

  private async tryVerificationQuote(
    runId: number,
    asset: AssetDefinition,
    stage: string,
    requestedQuantity: number,
    reference: SavedOpportunity,
    load: () => Promise<ExecutableQuote>,
  ): Promise<SavedQuote | undefined> {
    try {
      const quote = await load();
      const id = this.recorder.saveQuote(runId, requestedQuantity, quote);
      return { quote, id };
    } catch (error) {
      this.recorder.recordSourceError(
        runId,
        asset.symbol,
        stage,
        errorMessage(error),
      );
      await this.alerts.verificationError(
        reference.id,
        reference.opportunity,
        stage,
        error,
      );
      return undefined;
    }
  }

  private async persistOpportunity(
    runId: number,
    requestedQuantity: number,
    buy: SavedQuote,
    sell: SavedQuote,
    asset: AssetDefinition,
    direction: OpportunityDirection,
    stage: OpportunityStage,
  ): Promise<SavedOpportunity> {
    const now = Date.now();
    const opportunity = this.engine.evaluate({
      asset,
      direction,
      stage,
      requestedQuantity,
      quantity: Math.min(
        buy.quote.assetQuantity,
        sell.quote.assetQuantity,
      ),
      buyQuote: buy.quote,
      sellQuote: sell.quote,
      now,
    });
    const opportunityId = this.recorder.saveOpportunity(
      runId,
      buy.id,
      sell.id,
      opportunity,
    );
    if (opportunity.eligible) {
      if (stage === "RFQ_VERIFIED" && this.paperTrader) {
        this.recorder.savePaperTrade(
          this.paperTrader.execute(opportunityId, opportunity),
        );
      }
      await this.alerts.opportunity(opportunityId, opportunity);
    }
    return { opportunity, id: opportunityId };
  }
}

export async function runMonitorLoop(
  monitor: Monitor,
  mode: "SIMULATED" | "LIVE",
  intervalMs: number,
  signal: AbortSignal,
  cycles = Number.POSITIVE_INFINITY,
): Promise<void> {
  let completed = 0;
  while (!signal.aborted && completed < cycles) {
    const startedAt = Date.now();
    const result = await monitor.scanOnce(mode);
    completed += 1;
    printCycleSummary(completed, result);

    if (completed >= cycles || signal.aborted) break;
    const remaining = Math.max(0, intervalMs - (Date.now() - startedAt));
    await abortableDelay(remaining, signal);
  }
}

function printCycleSummary(cycle: number, result: ScanResult): void {
  const referenceCandidates = result.opportunities.filter(
    (opportunity) =>
      opportunity.stage === "REFERENCE" && opportunity.eligible,
  );
  const verified = result.opportunities.filter(
    (opportunity) =>
      opportunity.stage === "RFQ_VERIFIED" && opportunity.eligible,
  );
  const best = [...result.opportunities].sort(
    (left, right) => right.netSpreadBps - left.netSpreadBps,
  )[0];
  console.log(
    [
      `[cycle ${cycle}] run=${result.runId}`,
      `samples=${result.opportunities.length}`,
      `reference=${referenceCandidates.length}`,
      `verified=${verified.length}`,
      `errors=${result.errors}`,
      best
        ? `best=${best.asset}/${best.direction} ${best.netSpreadBps.toFixed(2)}bps`
        : "best=n/a",
    ].join(" "),
  );
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
