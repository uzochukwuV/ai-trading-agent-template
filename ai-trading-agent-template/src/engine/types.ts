export type Side = "BUY" | "SELL";
export type Action = Side | "HOLD";

/** Which trading desk a signal/position belongs to. */
export type Bucket = "spot" | "futures";

export interface Tick {
  pair: string;
  price: number;
  bid: number;
  ask: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  vwap24h: number;
  timestamp: number;
}

export interface PairCandle {
  t: number;     // ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Indicators {
  rsi: number | null;
  macdHist: number | null;
  bbPercentB: number | null;
  atr: number | null;
  ema20: number | null;
  ema50: number | null;
  trend: "up" | "down" | "flat";
  vol: number;            // realized vol estimate
}

export type SignalSource =
  | "technical"
  | "llm"
  | "prism"
  | "external"
  | "trailing-stop"
  | "stop-loss"
  | "take-profit"
  | "manual";

export interface Signal {
  id: string;
  source: SignalSource;
  origin?: string;             // who submitted it (bot id, user, "engine")
  pair: string;
  action: Action;
  confidence: number;          // 0..1
  reasoning: string;
  ttlMs?: number;              // expires after this many ms from createdAt
  createdAt: number;
  weight?: number;             // applied during aggregation (default 1)
}

export interface Position {
  id: string;
  pair: string;
  side: Side;
  qty: number;                 // base asset qty
  entryPrice: number;
  entryNotional: number;       // USD at entry
  openedAt: number;
  stopPrice: number;
  takeProfit: number;
  trailingStop?: number;       // moves with favorable price action
  highWaterPrice?: number;     // best price reached since open
  reasoning: string;
  source: SignalSource;
}

export interface ClosedTrade {
  id: string;
  pair: string;
  side: Side;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: number;
  closedAt: number;
  pnlUsd: number;
  pnlPct: number;
  reasonOpen: string;
  reasonClose: string;
  source: SignalSource;
}

export interface EquityPoint {
  t: number;
  equity: number;
  cash: number;
  positionsValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

export interface RiskState {
  killSwitch: boolean;
  killReason?: string;
  paused: boolean;
  dailyPnl: number;
  dailyPnlPct: number;
  drawdownPct: number;
  exposureUsd: number;
  exposurePct: number;
  freeCashUsd: number;
  resetsAt: number;       // ts when daily counters reset
}

export interface ScannerRow {
  pair: string;
  price: number;
  changePct24h: number;
  rsi: number | null;
  macdHist: number | null;
  trend: string;
  score: number;
  action: Action;
  updatedAt: number;
}

export interface FuturesPositionView {
  symbol: string;            // e.g. PF_XBTUSD
  pair: string;              // mapped spot pair, e.g. XBTUSD
  side: "long" | "short";
  size: number;              // contract qty
  entryPrice: number;
  markPrice: number;
  notionalUsd: number;       // size * markPrice (linear approx)
  leverage: number | null;   // effective leverage from exchange, may be null
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;  // % of notional
  liquidationPrice: number | null;
  liqDistancePct: number | null;
  unrealizedFundingUsd: number;
  fundingRate: number | null;       // current per-period funding rate
  openedAt: number;
}

export interface FuturesEquityPoint {
  t: number;
  portfolioValue: number;    // USD-equiv from flex account
  marginEquity: number;
  availableMargin: number;
  initialMargin: number;
  unrealizedPnl: number;
}

export interface AllocatorState {
  enabled: boolean;
  spotTargetPct: number;        // 0..100
  futuresTargetPct: number;     // 0..100
  spotEquityUsd: number;        // observed
  futuresEquityUsd: number;     // observed
  combinedEquityUsd: number;
  spotActualPct: number;
  futuresActualPct: number;
  leverageBias: number;         // -1..+1, AI macro tilt
  lastRebalanceAt: number;
  nextRebalanceAt: number;
  frozenUntil: number;          // 0 if not frozen
  reason: string;               // explanation for current state
  history: { t: number; spotPct: number; futuresPct: number; tilt: number; reason: string }[];
}

export interface EngineConfig {
  watchlist: string[];
  pollIntervalMs: number;
  startingCashUsd: number;
  maxPositions: number;
  maxNotionalPerTradePct: number;     // % of equity
  maxNotionalPerPairPct: number;      // % of equity
  minNotionalPerTradeUsd: number;
  riskPerTradePct: number;            // % of equity risked per trade
  dailyLossLimitPct: number;          // kill-switch trigger
  maxDrawdownPct: number;             // kill-switch trigger
  takerFeeBps: number;                // simulated fees
  slippageBps: number;
  buyThreshold: number;               // composite score >= triggers BUY
  sellThreshold: number;              // composite score <= triggers SELL
  cooldownMs: number;                 // per-pair cooldown after closing
  trailingActivatePct: number;        // unrealized % to activate trailing
  trailingDistancePct: number;        // trailing stop distance
}
