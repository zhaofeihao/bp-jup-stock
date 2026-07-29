import type {
  Opportunity,
  PaperExecutionState,
  PaperTrade,
} from "./types.js";

export class PaperTrader {
  constructor(
    private readonly random: () => number,
    private readonly maxLossUsdc: number,
  ) {}

  execute(opportunityId: number, opportunity: Opportunity): PaperTrade {
    const createdAt = Date.now();
    const roll = this.random();
    const history: PaperTrade["stateHistory"] = [];
    let finalState: PaperExecutionState;
    let realizedProfitUsdc: number;

    if (roll < 0.965) {
      history.push({ state: "BOTH_FILLED", at: createdAt });
      finalState = "BOTH_FILLED";
      realizedProfitUsdc =
        opportunity.netProfitUsdc - this.random() * 0.25;
    } else {
      const oneLeg: PaperExecutionState =
        this.random() < 0.5 ? "JUP_ONLY_FILLED" : "BACKPACK_ONLY_FILLED";
      history.push({ state: oneLeg, at: createdAt });
      history.push({ state: "COMPENSATING", at: createdAt + 100 });

      if (roll < 0.995) {
        history.push({ state: "BOTH_FILLED", at: createdAt + 350 });
        finalState = "BOTH_FILLED";
        realizedProfitUsdc =
          opportunity.netProfitUsdc - (0.5 + this.random() * 2.5);
      } else {
        history.push({
          state: "MANUAL_INTERVENTION",
          at: createdAt + 500,
        });
        finalState = "MANUAL_INTERVENTION";
        realizedProfitUsdc =
          -this.maxLossUsdc * (0.5 + this.random() * 0.5);
      }
    }

    return {
      opportunityId,
      asset: opportunity.asset,
      direction: opportunity.direction,
      quantity: opportunity.quantity,
      expectedProfitUsdc: opportunity.netProfitUsdc,
      realizedProfitUsdc,
      finalState,
      stateHistory: history,
      createdAt,
    };
  }
}
