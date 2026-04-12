/**
 * Shared TypeScript interfaces for the AI trading agent.
 *
 * Key change from v1: agentId is now a uint256 (ERC-721 token ID), not bytes32.
 * In TypeScript we represent it as a bigint for contract calls, or number for display.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Market data
// ─────────────────────────────────────────────────────────────────────────────

export interface MarketData {
  pair: string;       // e.g. "XBTUSD"
  price: number;      // Last traded price
  bid: number;        // Best bid
  ask: number;        // Best ask
  volume: number;     // 24h volume
  vwap: number;       // 24h volume-weighted average price
  high: number;       // 24h high
  low: number;        // 24h low
  timestamp: number;  // Unix timestamp (ms)
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade decision
// ─────────────────────────────────────────────────────────────────────────────

export type TradeAction = "BUY" | "SELL" | "HOLD";

export interface TradeDecision {
  action: TradeAction;
  asset: string;       // e.g. "XBT"
  pair: string;        // e.g. "XBTUSD"
  amount: number;      // In USD
  confidence: number;  // 0.0 – 1.0
  reasoning: string;   // Plain-language explanation of the decision
}

// ─────────────────────────────────────────────────────────────────────────────
// Trading strategy interface — swap this out for your own model
// ─────────────────────────────────────────────────────────────────────────────

export interface TradingStrategy {
  /**
   * Analyze market data and return a trade decision.
   * This is the only method you need to implement to plug in your own model.
   */
  analyze(data: MarketData): Promise<TradeDecision>;
}

// ─────────────────────────────────────────────────────────────────────────────
// ERC-8004 Agent identity (ERC-721)
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentRegistration {
  agentId: bigint;         // ERC-721 token ID
  operatorWallet: string;  // Wallet that owns the token
  agentWallet: string;     // Hot wallet for signing
  name: string;
  description: string;
  capabilities: string[];
  registeredAt: number;    // Unix timestamp
  active: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// EIP-712 TradeIntent — signed by agentWallet, submitted to RiskRouter
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeIntent {
  agentId: bigint;
  agentWallet: string;
  pair: string;
  action: "BUY" | "SELL";
  amountUsdScaled: bigint; // amountUsd * 100
  maxSlippageBps: bigint;  // e.g. 50n = 0.5%
  nonce: bigint;
  deadline: bigint;        // Unix timestamp (seconds)
}

export interface SignedTradeIntent {
  intent: TradeIntent;
  signature: string;       // EIP-712 signature
  intentHash: string;      // for logging/correlation
}

// ─────────────────────────────────────────────────────────────────────────────
// On-chain checkpoint (EIP-712)
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeCheckpoint {
  agentId: string;        // decimal string of uint256 token ID
  timestamp: number;      // Unix timestamp (seconds)
  action: TradeAction;
  asset: string;
  pair: string;
  amountUsd: number;
  priceUsd: number;
  reasoning: string;
  reasoningHash: string;  // keccak256 of reasoning
  confidence: number;
  intentHash: string;     // intentHash from the approved TradeIntent
  signature: string;      // EIP-712 signature over the checkpoint
  signerAddress: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kraken CLI types
// ─────────────────────────────────────────────────────────────────────────────

export interface KrakenOrder {
  pair: string;
  type: "buy" | "sell";
  ordertype: "market" | "limit";
  volume: string;   // Base asset volume
  price?: string;   // For limit orders only
}

export interface KrakenOrderResult {
  txid: string[];
  descr: { order: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extended market data types
// ─────────────────────────────────────────────────────────────────────────────

export interface OHLCV {
  timestamp: number;    // Unix timestamp (ms)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  count?: number;       // Number of trades
}

export interface OrderBookLevel {
  price: number;
  volume: number;
}

export interface OrderBook {
  pair: string;
  bids: OrderBookLevel[];  // Sorted descending by price
  asks: OrderBookLevel[];  // Sorted ascending by price
  timestamp: number;
}

export interface RecentTrade {
  price: number;
  volume: number;
  timestamp: number;
  side: "buy" | "sell";
}

export interface PaperBalance {
  currency: string;
  balance: number;
  available: number;
}

export interface PaperAccountStatus {
  initialBalance: number;
  currentBalance: number;
  equity: number;
  pnl: number;
  pnlPercent: number;
  positions: PaperPosition[];
}

export interface PaperPosition {
  asset: string;
  volume: number;
  avgEntryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

/**
 * Enriched market data combining ticker, OHLC, order book, and trades.
 * This is what advanced strategies should consume.
 */
export interface EnrichedMarketData {
  // Basic ticker
  pair: string;
  price: number;
  bid: number;
  ask: number;
  spreadBps: number;       // Spread in basis points
  volume24h: number;
  vwap24h: number;
  high24h: number;
  low24h: number;

  // OHLC history
  ohlc: OHLCV[];           // Recent candles (ascending time order)

  // Order book
  orderBook?: OrderBook;
  bidDepth?: number;       // Total bid volume (top 10 levels)
  askDepth?: number;       // Total ask volume (top 10 levels)
  orderBookImbalance?: number; // (bidDepth - askDepth) / (bidDepth + askDepth)

  // Recent trades
  recentTrades?: RecentTrade[];
  tradeVolumeBias?: number;  // Net buy volume / total volume (-1 to 1)

  timestamp: number;
}
