import type { AppConfig } from "./config.js";
import type { Recorder } from "./db.js";
import type { Opportunity } from "./types.js";

export class AlertDispatcher {
  constructor(
    private readonly recorder: Recorder,
    private readonly config: AppConfig["alerts"],
  ) {}

  async opportunity(
    opportunityId: number,
    opportunity: Opportunity,
  ): Promise<void> {
    const quoteOnly = opportunity.alertMode === "QUOTE_ONLY";
    const alertType = quoteOnly
      ? "QUOTE_ONLY_OPPORTUNITY"
      : "EXECUTABLE_OPPORTUNITY";
    const dedupeKey = [
      alertType,
      opportunity.asset,
      opportunity.direction,
      opportunity.requestedQuantity,
    ].join(":");
    const now = Date.now();
    if (
      this.recorder.recentlyAlerted(
        dedupeKey,
        now - this.config.cooldownMs,
      )
    ) {
      this.recorder.recordAlert({
        opportunityId,
        type: alertType,
        dedupeKey,
        status: "SKIPPED_COOLDOWN",
        message: "相同机会仍在冷却期",
        now,
      });
      return;
    }

    const message = formatOpportunity(opportunity);
    console.log(`\n${message}\n`);
    await this.deliver({
      opportunityId,
      type: alertType,
      dedupeKey,
      message,
      now,
    });
  }

  async sourceError(
    asset: string,
    stage: string,
    error: unknown,
  ): Promise<void> {
    if (!this.config.onSourceError) return;
    const dedupeKey = `SOURCE_ERROR:${asset}:${stage}`;
    const now = Date.now();
    if (
      this.recorder.recentlyAlerted(
        dedupeKey,
        now - this.config.cooldownMs,
      )
    ) {
      return;
    }
    const message = [
      "⚠️ 行情源异常",
      `标的：${asset}`,
      `阶段：${stage}`,
      `错误：${errorMessage(error)}`,
    ].join("\n");
    console.error(message);
    await this.deliver({
      type: "SOURCE_ERROR",
      dedupeKey,
      message,
      now,
    });
  }

  private async deliver(input: {
    opportunityId?: number;
    type: string;
    dedupeKey: string;
    message: string;
    now: number;
  }): Promise<void> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) {
      this.recorder.recordAlert({
        ...input,
        status: "CONSOLE",
      });
      return;
    }

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.config.telegramChatId,
            text: input.message,
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) {
        throw new Error(`Telegram ${response.status}: ${await response.text()}`);
      }
      this.recorder.recordAlert({ ...input, status: "SENT" });
    } catch (error) {
      this.recorder.recordAlert({
        ...input,
        status: "FAILED",
        error: errorMessage(error),
      });
      console.error(`Telegram 提醒失败：${errorMessage(error)}`);
    }
  }
}

export function formatOpportunity(opportunity: Opportunity): string {
  const quoteOnly = opportunity.alertMode === "QUOTE_ONLY";
  const direction =
    opportunity.direction === "JUPITER_BUY_BACKPACK_SELL"
      ? "Jupiter 买 / Backpack 卖"
      : "Backpack 买 / Jupiter 卖";
  return [
    quoteOnly ? "📊 观察价差提醒（需人工确认）" : "🚨 可执行套利机会",
    `标的：${opportunity.asset}`,
    `方向：${direction}`,
    quoteOnly
      ? `交易组装检查：${opportunity.executionVerified ? "已通过，但本提醒仍仅供观察" : "未通过或未执行（不作为提醒门槛）"}`
      : "可执行性：已通过报价组装检查",
    `档位 / 匹配数量：${format(opportunity.requestedQuantity, 4)} / ${format(opportunity.quantity, 6)}`,
    `买入：${format(opportunity.buyUsdc, 4)} USDC @ ${format(opportunity.buyUnitPrice, 4)}`,
    `卖出：${format(opportunity.sellUsdc, 4)} USDC @ ${format(opportunity.sellUnitPrice, 4)}`,
    `预计净利润：${format(opportunity.netProfitUsdc, 4)} USDC`,
    `净价差：${format(opportunity.netSpreadBps, 2)} bps`,
    `Jupiter 冲击：${format(opportunity.jupiterPriceImpactBps, 2)} bps`,
    `报价年龄：${Math.round(opportunity.maxQuoteAgeMs)} ms`,
  ].join("\n");
}

function format(value: number, digits: number): string {
  return value.toFixed(digits);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
