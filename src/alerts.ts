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
    const alertType =
      opportunity.stage === "REFERENCE"
        ? "REFERENCE_OPPORTUNITY"
        : "RFQ_VERIFIED_OPPORTUNITY";
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

  async verificationError(
    opportunityId: number,
    opportunity: Opportunity,
    stage: string,
    error: unknown,
  ): Promise<void> {
    if (!this.config.onSourceError) return;
    const alertType = "RFQ_VERIFICATION_FAILED";
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
      return;
    }
    const message = [
      "⚠️ RFQ 可执行性验证失败",
      `标的：${opportunity.asset}`,
      `方向：${formatDirection(opportunity)}`,
      `档位 / 匹配数量：${format(opportunity.requestedQuantity, 4)} / ${format(opportunity.quantity, 6)}`,
      `参考买价：${format(opportunity.buyUnitPrice, 4)}（${formatQuoteSource(opportunity.buySource)}）`,
      `参考卖价：${format(opportunity.sellUnitPrice, 4)}（${formatQuoteSource(opportunity.sellSource)}）`,
      `参考净利润：${format(opportunity.netProfitUsdc, 4)} USDC`,
      `参考净价差：${format(opportunity.netSpreadBps, 2)} bps`,
      `验证阶段：${stage}`,
      `失败原因：${errorMessage(error)}`,
      "结论：参考价差仍保留，但未取得可执行的 Backpack 报价。",
    ].join("\n");
    console.error(message);
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
  const reference = opportunity.stage === "REFERENCE";
  const lines = [
    reference
      ? "📊 参考价差提醒（公开行情初筛）"
      : "🚨 RFQ 复核后的可执行套利机会",
    `标的：${opportunity.asset}`,
    `方向：${formatDirection(opportunity)}`,
    reference
      ? "阶段：公开行情初筛；不代表整档可成交"
      : "阶段：RFQ / 足量订单簿复核；报价组装检查已通过",
    `档位 / 匹配数量：${format(opportunity.requestedQuantity, 4)} / ${format(opportunity.quantity, 6)}`,
    `买入：${format(opportunity.buyUsdc, 4)} USDC @ ${format(opportunity.buyUnitPrice, 4)}（${formatQuoteSource(opportunity.buySource)}）`,
    `卖出：${format(opportunity.sellUsdc, 4)} USDC @ ${format(opportunity.sellUnitPrice, 4)}（${formatQuoteSource(opportunity.sellSource)}）`,
    `${reference ? "参考" : "预计"}净利润：${format(opportunity.netProfitUsdc, 4)} USDC`,
    `${reference ? "参考" : ""}净价差：${format(opportunity.netSpreadBps, 2)} bps`,
    `Jupiter 冲击：${format(opportunity.jupiterPriceImpactBps, 2)} bps`,
    `报价年龄：${Math.round(opportunity.maxQuoteAgeMs)} ms`,
  ];
  if (opportunity.buyQuoteNote) {
    lines.push(`买价说明：${opportunity.buyQuoteNote}`);
  }
  if (opportunity.sellQuoteNote) {
    lines.push(`卖价说明：${opportunity.sellQuoteNote}`);
  }
  if (reference && opportunity.alertMode === "EXECUTABLE") {
    lines.push("后续：已达到初筛门槛，程序将继续尝试 RFQ 可执行性验证。");
  }
  return lines.join("\n");
}

function formatDirection(opportunity: Opportunity): string {
  return opportunity.direction === "JUPITER_BUY_BACKPACK_SELL"
    ? "Jupiter 买 / Backpack 卖"
    : "Backpack 买 / Jupiter 卖";
}

function formatQuoteSource(source: Opportunity["buySource"]): string {
  switch (source) {
    case "BACKPACK_RFQ":
      return "Backpack RFQ";
    case "BACKPACK_DEPTH":
      return "Backpack 订单簿 VWAP";
    case "BACKPACK_TOP_OF_BOOK":
      return "Backpack 盘口顶价（深度不足）";
    case "BACKPACK_TICKER_VENUE":
      return "Backpack 最新成交价";
    case "BACKPACK_TICKER_EXTERNAL":
      return "Backpack External 参考价";
    case "JUPITER_SWAP_V2":
      return "Jupiter 指定数量路由";
    case "MOCK":
      return "模拟行情";
  }
}

function format(value: number, digits: number): string {
  return value.toFixed(digits);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
