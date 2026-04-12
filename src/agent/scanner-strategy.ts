/**
 * Multi-Pair Scanner Strategy
 *
 * Scans through a curated watchlist of liquid USD pairs on Kraken,
 * analyzes each with the composite indicator suite, and returns
 * the highest-conviction signal.
 *
 * Also tracks open positions for ongoing monitoring — if a held
 * position shows deteriorating signals, recommends SELL.
 */

import { EnrichedMarketData, TradeDecision, TradingStrategy, MarketData, RecentTrade } from "../types/index";
import { KrakenClient } from "../exchange/kraken";
import {
  calculateAllIndicators,
  calculateRSIWilder,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
} from "./indicators";
import { LLMStrategy, callOpenRouter, parseLLMResponse, buildLLMPrompt, DEFAULT_LLM_CONFIG } from "./strategy";

// ─────────────────────────────────────────────────────────────────────────────
// Watchlist — curated liquid USD pairs on Kraken
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_WATCHLIST = [
  "XBTUSD",   // BTC
  "ETHUSD",   // ETH
  "SOLUSD",   // SOL
  "XRPUSD",   // XRP
  "ADAUSD",   // ADA
  "DOGEUSD",  // DOGE
  "AVAXUSD",  // AVAX
  "DOTUSD",   // DOT
  "LINKUSD",  // LINK
  "MATICUSD", // MATIC (now POL)
  "POLUSD",   // POL
  "ATOMUSD",  // ATOM
  "LTCUSD",   // LTC
  "UNIUSD",   // UNI
  "NEARUSD",  // NEAR
  "FILUSD",   // FIL
  "APTUSD",   // APT
  "ARBUSDT",  // ARB (USDT pair)
  "OPUSD",    // OP
  "PEPEUSD",  // PEPE
];

// Pairs to skip (illiquid, cancel-only, or problematic)
const SKIP_PAIRS = new Set(["STABLEEUR", "WARUSD", "WAREUR", "XNAPUSD", "XNAPEUR", "STEPUSD", "STEPEUR"]);

// ─────────────────────────────────────────────────────────────────────────────
// Position tracking
// ─────────────────────────────────────────────────────────────────────────────

interface OpenPosition {
  pair: string;
  entryPrice: number;
  entryTime: number;
  amountUsd: number;
  volume: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scanner result
// ─────────────────────────────────────────────────────────────────────────────

interface ScanResult {
  pair: string;
  price: number;
  compositeScore: number;   // 0-1, >0.5 = bullish, <0.5 = bearish
  rsi: number | null;
  trend: string;
  volatility: string | null;
  atr: number | null;
  // Signal components
  rsiScore: number;
  macdScore: number;
  bbScore: number;
  volumeScore: number;
  // Decision
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  reasoning: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite scoring (shared logic from composite-strategy)
// ─────────────────────────────────────────────────────────────────────────────

function computeCompositeScore(
  data: EnrichedMarketData,
  indicators: ReturnType<typeof calculateAllIndicators>
): { score: number; breakdown: Record<string, number> } {
  const { rsi, macd, bollinger, atr, vwap, trend } = indicators;

  // RSI scoring
  let rsiScore = 0.5;
  if (rsi !== null) {
    if (rsi <= 30) rsiScore = 1.0 - (rsi / 30) * 0.3;
    else if (rsi >= 70) rsiScore = (100 - rsi) / 30 * 0.3;
    else rsiScore = 0.7 - ((rsi - 30) / 40) * 0.4;
  }

  // MACD scoring
  let macdScore = 0.5;
  if (macd !== null) {
    const histNorm = macd.histogram / Math.abs(macd.macd || 1);
    macdScore = 0.5 + Math.max(-0.5, Math.min(0.5, histNorm * 5));
  }

  // Bollinger Bands scoring
  let bbScore = 0.5;
  if (bollinger !== null) {
    if (bollinger.percentB < 0) bbScore = 0.85;
    else if (bollinger.percentB > 1) bbScore = 0.15;
    else if (bollinger.percentB < 0.2) bbScore = 0.7;
    else if (bollinger.percentB > 0.8) bbScore = 0.3;
    else bbScore = 0.5 + (0.5 - bollinger.percentB) * 0.3;
  }

  // Volume scoring
  let volScore = 0.5;
  if (trend === "bullish") volScore = 0.6;
  else if (trend === "bearish") volScore = 0.4;

  // Composite
  const score =
    rsiScore * 0.25 +
    macdScore * 0.25 +
    bbScore * 0.15 +
    volScore * 0.10 +
    // Additional signals from enriched data
    (data.orderBookImbalance !== undefined ? ((data.orderBookImbalance + 1) / 2) : 0.5) * 0.15 +
    (data.tradeVolumeBias !== undefined ? ((data.tradeVolumeBias + 1) / 2) : 0.5) * 0.10;

  return {
    score: Math.max(0, Math.min(1, score)),
    breakdown: {
      rsi: rsiScore,
      macd: macdScore,
      bb: bbScore,
      volume: volScore,
      orderBook: data.orderBookImbalance !== undefined ? ((data.orderBookImbalance + 1) / 2) : 0.5,
      tradeFlow: data.tradeVolumeBias !== undefined ? ((data.tradeVolumeBias + 1) / 2) : 0.5,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scanner Strategy
// ─────────────────────────────────────────────────────────────────────────────

export class ScannerStrategy implements TradingStrategy {
  private readonly kraken: KrakenClient;

  /** Exposed for the agent loop to report watchlist size */
  public readonly watchlist: string[];

  private readonly positions: Map<string, OpenPosition> = new Map();

  // Config
  private readonly minScoreToBuy: number;    // Default 0.60
  private readonly maxScoreToSell: number;   // Default 0.40 (for positions)
  private readonly baseTradeAmountUsd: number;
  private readonly maxConcurrentPositions: number;
  private readonly llm: LLMStrategy | null;

  constructor(
    kraken: KrakenClient,
    options?: {
      watchlist?: string[];
      minScoreToBuy?: number;
      maxScoreToSell?: number;
      baseTradeAmountUsd?: number;
      maxConcurrentPositions?: number;
      useLLM?: boolean;
    }
  ) {
    this.kraken = kraken;
    this.watchlist = options?.watchlist || DEFAULT_WATCHLIST;
    this.minScoreToBuy = options?.minScoreToBuy ?? 0.60;
    this.maxScoreToSell = options?.maxScoreToSell ?? 0.40;
    this.baseTradeAmountUsd = options?.baseTradeAmountUsd ?? 100;
    this.maxConcurrentPositions = options?.maxConcurrentPositions ?? 3;
    this.llm = options?.useLLM ? new LLMStrategy() : null;
  }

  // Legacy interface — just returns HOLD
  async analyze(_data: MarketData): Promise<TradeDecision> {
    return {
      action: "HOLD",
      asset: _data.pair.replace("USD", "").replace("USDT", ""),
      pair: _data.pair,
      amount: 0,
      confidence: 0.5,
      reasoning: "ScannerStrategy requires scanAndDecide() for multi-pair analysis.",
    };
  }

  /**
   * Full scan: analyze all watchlist pairs and return the best opportunity.
   */
  async scanAndDecide(): Promise<TradeDecision & { allResults: ScanResult[] }> {
    const results: ScanResult[] = [];

    // 1. Scan all watchlist pairs in parallel
    const scanPromises = this.watchlist
      .filter(pair => !SKIP_PAIRS.has(pair))
      .map(async (pair) => {
        try {
          const data = await this.kraken.getEnrichedMarketData(pair, 15, 50, 5, 20);
          const indicators = calculateAllIndicators(data.ohlc, data.price);
          const { score, breakdown } = computeCompositeScore(data, indicators);

          let action: "BUY" | "SELL" | "HOLD" = "HOLD";
          let confidence = 0.5;

          // Check if we hold this position
          const heldPosition = this.positions.get(pair);
          if (heldPosition) {
            // Position monitoring: sell if score drops too low
            if (score <= this.maxScoreToSell) {
              action = "SELL";
              confidence = 1 - score;
            }
          } else if (score >= this.minScoreToBuy) {
            action = "BUY";
            confidence = score;
          }

          // Build reasoning
          const reasoningParts = [
            `RSI: ${indicators.rsi?.toFixed(1) ?? "N/A"} (score: ${breakdown.rsi.toFixed(2)})`,
            `MACD: ${indicators.macd ? (indicators.macd.histogram > 0 ? "bullish" : "bearish") : "N/A"} (score: ${breakdown.macd.toFixed(2)})`,
            `BB %B: ${indicators.bollinger?.percentB.toFixed(2) ?? "N/A"} (score: ${breakdown.bb.toFixed(2)})`,
            `Order Book: ${data.orderBookImbalance !== undefined ? (data.orderBookImbalance > 0 ? "bid-heavy" : "ask-heavy") : "N/A"} (score: ${breakdown.orderBook.toFixed(2)})`,
            `Trade Flow: ${data.tradeVolumeBias !== undefined ? (data.tradeVolumeBias > 0 ? "buy-heavy" : "sell-heavy") : "N/A"} (score: ${breakdown.tradeFlow.toFixed(2)})`,
          ];

          if (heldPosition) {
            reasoningParts.unshift(
              `[POSITION] Entry: $${heldPosition.entryPrice.toFixed(2)} → Current: $${data.price.toFixed(2)} (${((data.price / heldPosition.entryPrice - 1) * 100).toFixed(2)}%)`
            );
          }

          return {
            pair: data.pair,
            price: data.price,
            compositeScore: score,
            rsi: indicators.rsi,
            trend: indicators.trend,
            volatility: indicators.volatility,
            atr: indicators.atr,
            rsiScore: breakdown.rsi,
            macdScore: breakdown.macd,
            bbScore: breakdown.bb,
            volumeScore: breakdown.volume,
            action,
            confidence,
            reasoning: reasoningParts.join(" | "),
          };
        } catch {
          return null;
        }
      });

    const scanResults = (await Promise.all(scanPromises)).filter(Boolean) as ScanResult[];
    results.push(...scanResults);

    // 2. Sort by conviction (distance from 0.5)
    const sorted = [...results].sort((a, b) => {
      const aDist = Math.abs(a.compositeScore - 0.5);
      const bDist = Math.abs(b.compositeScore - 0.5);
      return bDist - aDist;
    });

    // 3. LLM fallback: if top signal is ambiguous or signals conflict, call LLM
    const topResult = sorted[0];
    if (topResult && this.llm && DEFAULT_LLM_CONFIG.enabled) {
      const isAmbiguous = Math.abs(topResult.compositeScore - 0.5) < 0.10;
      const hasConflict = topResult.rsiScore > 0.6 && topResult.macdScore < 0.4 ||
                          topResult.rsiScore < 0.4 && topResult.macdScore > 0.6;

      if (isAmbiguous || hasConflict) {
        console.log(`[scanner] Ambiguous signal for ${topResult.pair} (score: ${(topResult.compositeScore * 100).toFixed(1)}%) — calling LLM for tiebreaker...`);
        try {
          // Fetch enriched data for the top pair
          const enrichedData = await this.kraken.getEnrichedMarketData(topResult.pair, 15, 50, 5, 20);
          const indicators = calculateAllIndicators(enrichedData.ohlc, enrichedData.price);
          const prompt = buildLLMPrompt(enrichedData, indicators);
          const extra = hasConflict
            ? `\n\nNOTE: Technical indicators are CONFLICTING (RSI: ${topResult.rsiScore.toFixed(2)}, MACD: ${topResult.macdScore.toFixed(2)}). Please resolve this conflict.`
            : `\n\nNOTE: Technical analysis is ambiguous (composite: ${(topResult.compositeScore * 100).toFixed(1)}%). Please provide clarity.`;

          const llmContent = await callOpenRouter(DEFAULT_LLM_CONFIG, prompt + extra);
          if (llmContent) {
            const llmDecision = parseLLMResponse(llmContent, topResult.pair);
            // Blend LLM confidence with TA score
            const blendedConfidence = (topResult.compositeScore + llmDecision.confidence) / 2;

            if (llmDecision.action === "BUY") {
              const amount = this.baseTradeAmountUsd * Math.min(2, blendedConfidence * 2);
              return {
                action: "BUY",
                asset: topResult.pair.replace("USD", "").replace("USDT", ""),
                pair: topResult.pair,
                amount: Math.round(amount * 100) / 100,
                confidence: blendedConfidence,
                reasoning: `[LLM Tiebreaker] ${llmDecision.reasoning}\nTA: ${(topResult.compositeScore * 100).toFixed(1)}% | LLM: ${(llmDecision.confidence * 100).toFixed(1)}%\n\n--- Full scan ---\n${sorted.filter(r => r.action !== "HOLD").slice(0, 4).map(r => `  ${r.pair}: ${r.action} (${(r.compositeScore * 100).toFixed(1)}%)`).join("\n") || "  No other strong signals"}`,
                allResults: sorted,
              };
            }
          }
        } catch (e) {
          console.warn(`[scanner] LLM fallback failed: ${(e as Error).message} — using TA only`);
        }
      }
    }

    // 4. Pick the best actionable signal
    for (const result of sorted) {
      if (result.action === "BUY" && this.positions.size < this.maxConcurrentPositions) {
        const amount = this.baseTradeAmountUsd * Math.min(2, result.confidence * 2);
        return {
          action: "BUY",
          asset: result.pair.replace("USD", "").replace("USDT", ""),
          pair: result.pair,
          amount: Math.round(amount * 100) / 100,
          confidence: result.confidence,
          reasoning: `Scanner selected ${result.pair} as highest-conviction BUY:\n  Score: ${(result.compositeScore * 100).toFixed(1)}%\n  ${result.reasoning}\n\n--- Other top signals ---\n${sorted.filter(r => r.action !== "HOLD").slice(0, 4).map(r => `  ${r.pair}: ${r.action} (${(r.compositeScore * 100).toFixed(1)}%)`).join("\n") || "  No other strong signals"}`,
          allResults: sorted,
        };
      }
      if (result.action === "SELL" && this.positions.has(result.pair)) {
        const pos = this.positions.get(result.pair)!;
        return {
          action: "SELL",
          asset: result.pair.replace("USD", "").replace("USDT", ""),
          pair: result.pair,
          amount: pos.amountUsd,
          confidence: result.confidence,
          reasoning: `SELL signal for held position ${result.pair}:\n  Entry: $${pos.entryPrice.toFixed(2)} → Current: $${result.price.toFixed(2)}\n  Score dropped to ${(result.compositeScore * 100).toFixed(1)}% (threshold: ${(this.maxScoreToSell * 100).toFixed(0)}%)\n  ${result.reasoning}`,
          allResults: sorted,
        };
      }
    }

    // 4. No strong signals — HOLD
    const topSignals = sorted.slice(0, 5).map(r =>
      `  ${r.pair}: ${(r.compositeScore * 100).toFixed(1)}% (RSI: ${r.rsi?.toFixed(1) ?? "N/A"}, ${r.trend})`
    ).join("\n");

    return {
      action: "HOLD",
      asset: "ALL",
      pair: "SCAN",
      amount: 0,
      confidence: 0.5,
      reasoning: `Scanner: no signals exceed thresholds (buy≥${(this.minScoreToBuy * 100).toFixed(0)}%, sell≤${(this.maxScoreToSell * 100).toFixed(0)}%). Positions: ${this.positions.size}/${this.maxConcurrentPositions}.\n\nTop 5 scores:\n${topSignals}`,
      allResults: sorted,
    };
  }

  /**
   * Record a position after executing a BUY order.
   */
  recordPosition(pair: string, entryPrice: number, amountUsd: number, volume: number): void {
    this.positions.set(pair, {
      pair,
      entryPrice,
      entryTime: Date.now(),
      amountUsd,
      volume,
    });
  }

  /**
   * Remove a position after executing a SELL order.
   */
  removePosition(pair: string): void {
    this.positions.delete(pair);
  }

  /**
   * Get current positions.
   */
  getPositions(): ReadonlyMap<string, OpenPosition> {
    return this.positions;
  }

  /**
   * Quick scan of a single pair (for position monitoring).
   */
  async scanPair(pair: string): Promise<ScanResult | null> {
    try {
      const data = await this.kraken.getEnrichedMarketData(pair, 15, 50, 5, 20);
      const indicators = calculateAllIndicators(data.ohlc, data.price);
      const { score, breakdown } = computeCompositeScore(data, indicators);

      return {
        pair: data.pair,
        price: data.price,
        compositeScore: score,
        rsi: indicators.rsi,
        trend: indicators.trend,
        volatility: indicators.volatility,
        atr: indicators.atr,
        rsiScore: breakdown.rsi,
        macdScore: breakdown.macd,
        bbScore: breakdown.bb,
        volumeScore: breakdown.volume,
        action: score >= this.minScoreToBuy ? "BUY" : score <= this.maxScoreToSell ? "SELL" : "HOLD",
        confidence: score >= 0.5 ? score : 1 - score,
        reasoning: Object.entries(breakdown).map(([k, v]) => `${k}: ${v.toFixed(2)}`).join(" | "),
      };
    } catch {
      return null;
    }
  }
}
