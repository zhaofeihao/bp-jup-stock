export type AssetSymbol =
  | "SPCX"
  | "MU"
  | "SNDK"
  | "DRAM"
  | "BOT"
  | "SKHY"
  | "HOOD"
  | "INTC"
  | "MSTR";

export interface AssetDefinition {
  symbol: AssetSymbol;
  name: string;
  mint: string;
  decimals: number;
  backpackAsset: string;
  backpackRfqSymbol: string;
  backpackSpotSymbol?: string;
  initialMockPrice: number;
}

export type Venue = "BACKPACK" | "JUPITER";
export type AssetSide = "BUY_ASSET" | "SELL_ASSET";
export type QuoteSource =
  | "BACKPACK_RFQ"
  | "BACKPACK_DEPTH"
  | "BACKPACK_TOP_OF_BOOK"
  | "BACKPACK_TICKER_VENUE"
  | "BACKPACK_TICKER_EXTERNAL"
  | "JUPITER_SWAP_V2"
  | "MOCK";

export interface ExecutableQuote {
  venue: Venue;
  source: QuoteSource;
  asset: AssetSymbol;
  side: AssetSide;
  assetQuantity: number;
  usdcAmount: number;
  unitPrice: number;
  priceImpactBps: number;
  latencyMs: number;
  observedAt: number;
  validUntil: number | null;
  executable: boolean;
  note?: string;
  raw: unknown;
}

export type OpportunityDirection =
  | "JUPITER_BUY_BACKPACK_SELL"
  | "BACKPACK_BUY_JUPITER_SELL";
export type AlertMode = "EXECUTABLE" | "QUOTE_ONLY";
export type OpportunityStage = "REFERENCE" | "RFQ_VERIFIED";

export interface OpportunityInput {
  asset: AssetDefinition;
  direction: OpportunityDirection;
  stage: OpportunityStage;
  requestedQuantity: number;
  quantity: number;
  buyQuote: ExecutableQuote;
  sellQuote: ExecutableQuote;
  now: number;
}

export interface Opportunity {
  asset: AssetSymbol;
  direction: OpportunityDirection;
  stage: OpportunityStage;
  requestedQuantity: number;
  quantity: number;
  buyVenue: Venue;
  sellVenue: Venue;
  buySource: QuoteSource;
  sellSource: QuoteSource;
  buyQuoteNote?: string;
  sellQuoteNote?: string;
  buyUsdc: number;
  sellUsdc: number;
  buyUnitPrice: number;
  sellUnitPrice: number;
  grossProfitUsdc: number;
  totalCostUsdc: number;
  netProfitUsdc: number;
  grossSpreadBps: number;
  netSpreadBps: number;
  maxQuoteAgeMs: number;
  jupiterPriceImpactBps: number;
  alertMode: AlertMode;
  executionVerified: boolean;
  eligible: boolean;
  rejectReasons: string[];
  createdAt: number;
}

export type PaperExecutionState =
  | "BOTH_FILLED"
  | "JUP_ONLY_FILLED"
  | "BACKPACK_ONLY_FILLED"
  | "COMPENSATING"
  | "MANUAL_INTERVENTION";

export interface PaperTrade {
  opportunityId: number;
  asset: AssetSymbol;
  direction: OpportunityDirection;
  quantity: number;
  expectedProfitUsdc: number;
  realizedProfitUsdc: number;
  finalState: PaperExecutionState;
  stateHistory: Array<{ state: PaperExecutionState; at: number }>;
  createdAt: number;
}

export interface MarketDataProvider {
  beginCycle?(): void | Promise<void>;
  quoteBackpackReference(
    asset: AssetDefinition,
    side: AssetSide,
    quantity: number,
  ): Promise<ExecutableQuote>;
  quoteBackpack(
    asset: AssetDefinition,
    side: AssetSide,
    quantity: number,
  ): Promise<ExecutableQuote>;
  quoteJupiterSell(
    asset: AssetDefinition,
    quantity: number,
  ): Promise<ExecutableQuote>;
  quoteJupiterBuy(
    asset: AssetDefinition,
    targetQuantity: number,
    referenceUnitPrice: number,
  ): Promise<ExecutableQuote>;
}
