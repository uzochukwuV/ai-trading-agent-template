/**
 * Composite Multi-Signal Trading Strategy
 *
 * Combines multiple technical indicators into a weighted scoring system:
 *   - RSI (25%): Mean reversion — oversold = buy signal, overbought = sell
 *   - MACD (25%): Trend momentum — bullish/bearish crossovers
 *   - Bollinger Bands (15%): Volatility — price near bands = reversal potential
 *   - Order Book Imbalance (15%): Micro-structure — buy/sell pressure
 *   - Trade Flow (10%): Recent trade direction bias
 *   - Volume Confirmation (10%): Validates other signals with volume
 *
 * Signal strength must exceed threshold to act, preventing noise trading.
 */

import { EnrichedMarketData, TradeDecision, TradingStrategy } from "../types/index";
import {
  calculateAllIndicators,
  IndicatorSummary,
} from "./indicators";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

interface CompositeStrategyConfig {
  // Signal weights (must sum to 1.0)
  rsiWeight: number;
  macdWeight: number;
  bollingerWeight: number;
  orderBookWeight: number;
  tradeFlowWeight: number;
  volumeWeight: number;

  // Thresholds
  buyThreshold: number;    // Composite score to trigger BUY (default 0.55)
  sellThreshold: number;   // Composite score to trigger SELL (default 0.45)
  strongBuyThreshold: number; // High confidence BUY (default 0.70)
  strongSellThreshold: number; // High confidence SELL (default 0.30)

  // Trade sizing
  baseTradeAmountUsd: number;
  maxTradeAmountUsd: number;

  // RSI extremes
  rsiOverbought: number;  // Default 70
  rsiOversold: number;    // Default 30

  // Minimum OHLC candles required
  minCandles: number;
}

const DEFAULT_CONFIG: CompositeStrategyConfig = {
  rsiWeight: 0.25,
  macdWeight: 0.25,
  bollingerWeight: 0.15,
  orderBookWeight: 0.15,
  tradeFlowWeight: 0.10,
  volumeWeight: 0.10,

  buyThreshold: 0.55,
  sellThreshold: 0.45,
  strongBuyThreshold: 0.70,
  strongSellThreshold: 0.30,

  baseTradeAmountUsd: 100,
  maxTradeAmountUsd: 500,

  rsiOverbought: 70,
  rsiOversold: 30,

  minCandles: 30,
};

// ─────────────────────────────────────────────────────────────────────────────
// Signal scoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score a single signal from 0.0 (strong sell) to 1.0 (strong buy).
 */

function scoreRSI(rsi: number | null, config: CompositeStrategyConfig): { score: number; detail: string } {
  if (rsi === null) return { score: 0.5, detail: "RSI: insufficient data" };

  // Normalize RSI to 0-1 scale where 50 = neutral
  // RSI < 30 (oversold) → bullish (buy the dip)
  // RSI > 70 (overbought) → bearish (take profits)
  let score: number;
  if (rsi <= config.rsiOversold) {
    score = 1.0 - (rsi / config.rsiOversold) * 0.3; // 0.7 to 1.0
  } else if (rsi >= config.rsiOverbought) {
    score = (100 - rsi) / (100 - config.rsiOverbought) * 0.3; // 0.0 to 0.3
  } else {
    // Linear interpolation: 30→0.7, 50→0.5, 70→0.3
    score = 0.7 - ((rsi - config.rsiOversold) / (config.rsiOverbought - config.rsiOversold)) * 0.4;
  }

  let signal = "neutral";
  if (rsi < 35) signal = "oversold (bullish)";
  else if (rsi > 65) signal = "overbought (bearish)";

  return {
    score,
    detail: `RSI: ${rsi.toFixed(1)} → ${signal}`,
  };
}

function scoreMACD(macd: ReturnType<typeof import("./indicators").calculateMACD>): { score: number; detail: string } {
  if (macd === null) return { score: 0.5, detail: "MACD: insufficient data" };

  let score = 0.5;
  let signal = "neutral";

  // MACD histogram direction and magnitude
  const histNormalized = macd.histogram / Math.abs(macd.macd || 1);

  if (macd.histogram > 0) {
    score = 0.5 + Math.min(0.5, Math.abs(histNormalized) * 5);
    signal = `bullish (hist +${macd.histogram.toFixed(2)})`;
  } else if (macd.histogram < 0) {
    score = 0.5 - Math.min(0.5, Math.abs(histNormalized) * 5);
    signal = `bearish (hist ${macd.histogram.toFixed(2)})`;
  }

  // Bonus for MACD crossover (histogram crossing zero)
  if (Math.abs(histNormalized) < 0.05) {
    signal += " [near crossover]";
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    detail: `MACD: ${signal}`,
  };
}

function scoreBollinger(bands: ReturnType<typeof import("./indicators").calculateBollingerBands>, price: number): { score: number; detail: string } {
  if (bands === null) return { score: 0.5, detail: "BB: insufficient data" };

  let score = 0.5;
  let signal = "neutral";

  // %B: 0 = at lower band, 1 = at upper band
  // Mean reversion: near lower = bullish, near upper = bearish
  if (bands.percentB < 0) {
    score = 0.85; // Below lower band — strong buy signal
    signal = `below lower band (${bands.percentB.toFixed(2)}) — oversold`;
  } else if (bands.percentB > 1) {
    score = 0.15; // Above upper band — strong sell signal
    signal = `above upper band (${bands.percentB.toFixed(2)}) — overbought`;
  } else if (bands.percentB < 0.2) {
    score = 0.7;
    signal = `near lower band (${bands.percentB.toFixed(2)})`;
  } else if (bands.percentB > 0.8) {
    score = 0.3;
    signal = `near upper band (${bands.percentB.toFixed(2)})`;
  } else {
    score = 0.5 + (0.5 - bands.percentB) * 0.3; // Center = neutral
    signal = `within bands (${bands.percentB.toFixed(2)})`;
  }

  return {
    score,
    detail: `BB: ${signal}, bandwidth ${(bands.bandwidth * 100).toFixed(2)}%`,
  };
}

function scoreOrderBook(imbalance: number | undefined): { score: number; detail: string } {
  if (imbalance === undefined) return { score: 0.5, detail: "OB: no order book data" };

  // Imbalance: -1 (all asks) to +1 (all bids)
  // Normalize to 0-1: (-1→0, 0→0.5, 1→1)
  const score = (imbalance + 1) / 2;
  const signal = imbalance > 0.2 ? "bid-heavy (bullish)" : imbalance < -0.2 ? "ask-heavy (bearish)" : "balanced";

  return {
    score: Math.max(0, Math.min(1, score)),
    detail: `OB: ${signal} (${(imbalance * 100).toFixed(1)}%)`,
  };
}

function scoreTradeFlow(bias: number | undefined): { score: number; detail: string } {
  if (bias === undefined) return { score: 0.5, detail: "TF: no trade flow data" };

  // Bias: -1 (all sells) to +1 (all buys)
  const score = (bias + 1) / 2;
  const signal = bias > 0.2 ? "buy-dominated" : bias < -0.2 ? "sell-dominated" : "balanced";

  return {
    score: Math.max(0, Math.min(1, score)),
    detail: `TF: ${signal} (${(bias * 100).toFixed(1)}%)`,
  };
}

function scoreVolume(
  currentVolume: number,
  ohlc: import("../types/index").OHLCV[],
  priceAboveVwap: boolean,
  trend: string
): { score: number; detail: string } {
  if (ohlc.length < 20) return { score: 0.5, detail: "Vol: insufficient data" };

  // Calculate average volume
  const avgVolume = ohlc.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
  const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;

  let score = 0.5;

  // High volume confirms the trend direction
  if (volumeRatio > 1.5) {
    // Strong volume — amplify existing trend
    score = trend === "bullish" ? 0.7 : trend === "bearish" ? 0.3 : 0.55;
  } else if (volumeRatio < 0.5) {
    // Low volume — signals are weak, revert toward neutral
    score = 0.5;
  } else {
    // Normal volume
    score = trend === "bullish" ? 0.6 : trend === "bearish" ? 0.4 : 0.5;
  }

  const detail = `Vol: ${(volumeRatio * 100).toFixed(0)}% of avg, price ${priceAboveVwap ? "above" : "below"} VWAP`;
  return { score, detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main strategy
// ─────────────────────────────────────────────────────────────────────────────

export class CompositeStrategy implements TradingStrategy {
  private readonly config: CompositeStrategyConfig;

  constructor(config?: Partial<CompositeStrategyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async analyze(rawData: import("../types/index").MarketData): Promise<TradeDecision> {
    // The old interface only gets basic MarketData.
    // We return a conservative HOLD since we need enriched data.
    return {
      action: "HOLD",
      asset: rawData.pair.replace("USD", ""),
      pair: rawData.pair,
      amount: 0,
      confidence: 0.5,
      reasoning: "CompositeStrategy requires enriched market data. Use analyzeEnriched() instead.",
    };
  }

  /**
   * Analyze enriched market data and return a trade decision.
   * This is the main entry point for this strategy.
   */
  async analyzeEnriched(data: EnrichedMarketData): Promise<TradeDecision> {
    const { ohlc, price, pair, volume24h, orderBookImbalance, tradeVolumeBias, bid, ask, spreadBps } = data;

    // Check minimum data requirement
    if (ohlc.length < this.config.minCandles) {
      return {
        action: "HOLD",
        asset: pair.replace("USD", ""),
        pair,
        amount: 0,
        confidence: 0.5,
        reasoning: `Warming up: ${ohlc.length}/${this.config.minCandles} OHLC candles. Need more data.`,
      };
    }

    // ── Calculate all indicators ──────────────────────────────────────
    const indicators = calculateAllIndicators(ohlc, price);
    const { rsi, macd, bollinger, atr, vwap, trend } = indicators;

    // ── Score each signal ─────────────────────────────────────────────
    const rsiScore = scoreRSI(rsi, this.config);
    const macdScore = scoreMACD(macd);
    const bbScore = scoreBollinger(bollinger, price);
    const obScore = scoreOrderBook(orderBookImbalance);
    const tfScore = scoreTradeFlow(tradeVolumeBias);
    const volScore = scoreVolume(
      volume24h,
      ohlc,
      vwap !== null ? price > vwap : false,
      trend
    );

    // ── Composite weighted score ──────────────────────────────────────
    const composite =
      rsiScore.score * this.config.rsiWeight +
      macdScore.score * this.config.macdWeight +
      bbScore.score * this.config.bollingerWeight +
      obScore.score * this.config.orderBookWeight +
      tfScore.score * this.config.tradeFlowWeight +
      volScore.score * this.config.volumeWeight;

    // ── Determine action ──────────────────────────────────────────────
    let action: "BUY" | "SELL" | "HOLD" = "HOLD";
    let confidence = 0.5;
    let reasoningParts: string[] = [];

    // Spread check — don't trade if spread is too wide
    if (spreadBps > 10) {
      reasoningParts.push(`Spread too wide (${spreadBps.toFixed(1)}bps). Skipping.`);
      return {
        action: "HOLD",
        asset: pair.replace("USD", ""),
        pair,
        amount: 0,
        confidence: 0.3,
        reasoning: reasoningParts.join(" "),
      };
    }

    if (composite >= this.config.strongBuyThreshold) {
      action = "BUY";
      confidence = composite;
      reasoningParts.push(`STRONG BUY signal (composite: ${(composite * 100).toFixed(1)}%).`);
    } else if (composite <= this.config.strongSellThreshold) {
      action = "SELL";
      confidence = 1 - composite;
      reasoningParts.push(`STRONG SELL signal (composite: ${((1 - composite) * 100).toFixed(1)}%).`);
    } else if (composite >= this.config.buyThreshold) {
      action = "BUY";
      confidence = composite;
      reasoningParts.push(`BUY signal (composite: ${(composite * 100).toFixed(1)}%).`);
    } else if (composite <= this.config.sellThreshold) {
      action = "SELL";
      confidence = 1 - composite;
      reasoningParts.push(`SELL signal (composite: ${((1 - composite) * 100).toFixed(1)}%).`);
    } else {
      reasoningParts.push(`No clear signal (composite: ${(composite * 100).toFixed(1)}%, range: ${this.config.sellThreshold}-${this.config.buyThreshold}).`);
    }

    // ── Build reasoning string ────────────────────────────────────────
    reasoningParts.push("");
    reasoningParts.push("Signal breakdown:");
    reasoningParts.push(`  • ${rsiScore.detail}`);
    reasoningParts.push(`  • ${macdScore.detail}`);
    reasoningParts.push(`  • ${bbScore.detail}`);
    reasoningParts.push(`  • ${obScore.detail}`);
    reasoningParts.push(`  • ${tfScore.detail}`);
    reasoningParts.push(`  • ${volScore.detail}`);
    reasoningParts.push(`  • Trend: ${trend}, ATR: ${atr?.toFixed(2) ?? "N/A"}, VWAP: ${vwap?.toFixed(2) ?? "N/A"}`);

    // ── Calculate trade size ──────────────────────────────────────────
    let amount = 0;
    if (action !== "HOLD") {
      // Scale trade size with confidence
      amount = this.config.baseTradeAmountUsd +
        (this.config.maxTradeAmountUsd - this.config.baseTradeAmountUsd) * (confidence - this.config.buyThreshold) / (1 - this.config.buyThreshold);
      amount = Math.round(amount * 100) / 100;
    }

    return {
      action,
      asset: pair.replace("USD", ""),
      pair,
      amount,
      confidence,
      reasoning: reasoningParts.join("\n"),
    };
  }
}
