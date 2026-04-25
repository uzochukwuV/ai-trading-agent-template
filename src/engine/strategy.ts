/**
 * Strategy engine — turns candles + indicators into a composite score and
 * a candidate signal. Reuses indicator math from src/agent/indicators.ts.
 */

import {
  calculateRSIWilder,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
  calculateEMA,
  calculateROC,
} from "../agent/indicators";
import { OHLCV } from "../types/index";
import { PairCandle, Indicators, Signal, Action } from "./types";

function toOHLCV(c: PairCandle[]): OHLCV[] {
  return c.map(x => ({ timestamp: x.t, open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v }));
}

function realizedVol(closes: number[], lookback = 20): number {
  if (closes.length < lookback + 1) return 0;
  const slice = closes.slice(-lookback - 1);
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) rets.push(Math.log(slice[i] / slice[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(v);
}

export function computeIndicators(candles: PairCandle[]): Indicators {
  if (!candles.length) {
    return { rsi: null, macdHist: null, bbPercentB: null, atr: null, ema20: null, ema50: null, trend: "flat", vol: 0 };
  }
  const closes = candles.map(c => c.c);
  const ohlc = toOHLCV(candles);
  const rsi = calculateRSIWilder(closes, 14);
  const macd = calculateMACD(closes, 12, 26, 9);
  const bb = calculateBollingerBands(closes, 20, 2);
  const atr = calculateATR(ohlc, 14);
  const ema20arr = calculateEMA(closes, 20);
  const ema50arr = calculateEMA(closes, 50);
  const ema20 = ema20arr ? ema20arr[ema20arr.length - 1] : null;
  const ema50 = ema50arr ? ema50arr[ema50arr.length - 1] : null;
  let trend: "up" | "down" | "flat" = "flat";
  if (ema20 != null && ema50 != null) {
    if (ema20 > ema50 * 1.001) trend = "up";
    else if (ema20 < ema50 * 0.999) trend = "down";
  }
  return {
    rsi,
    macdHist: macd?.histogram ?? null,
    bbPercentB: bb?.percentB ?? null,
    atr,
    ema20,
    ema50,
    trend,
    vol: realizedVol(closes, 20),
  };
}

export interface ScoreBreakdown {
  rsi: number;
  macd: number;
  bb: number;
  trend: number;
  momentum: number;
}

export interface ScoredAnalysis {
  score: number;            // 0..1 (>0.5 bullish, <0.5 bearish)
  confidence: number;       // 0..1, magnitude of |score - 0.5| with agreement boost
  action: Action;
  reasoning: string;
  breakdown: ScoreBreakdown;
  indicators: Indicators;
}

export function scoreMarket(
  candles: PairCandle[],
  buyThreshold = 0.6,
  sellThreshold = 0.4,
): ScoredAnalysis {
  const ind = computeIndicators(candles);
  const closes = candles.map(c => c.c);
  const roc = calculateROC(closes, 10) ?? 0;

  // RSI bullishness 0..1 (30 -> bullish, 70 -> bearish)
  let rsiScore = 0.5;
  if (ind.rsi != null) {
    if (ind.rsi <= 30) rsiScore = 0.85;
    else if (ind.rsi >= 70) rsiScore = 0.15;
    else rsiScore = 1 - (ind.rsi - 30) / 40 * 0.7 - 0.15 + 0.15 + 0.0; // smooth
    // simple smoother:
    rsiScore = 1 - (ind.rsi / 100);
    // pull toward extremes
    rsiScore = Math.max(0, Math.min(1, rsiScore));
  }

  let macdScore = 0.5;
  if (ind.macdHist != null) {
    macdScore = ind.macdHist > 0 ? 0.5 + Math.min(0.4, Math.abs(ind.macdHist) * 5)
                                  : 0.5 - Math.min(0.4, Math.abs(ind.macdHist) * 5);
    macdScore = Math.max(0, Math.min(1, macdScore));
  }

  let bbScore = 0.5;
  if (ind.bbPercentB != null) {
    // %B near 0 is oversold (bullish); near 1 is overbought (bearish)
    bbScore = 1 - Math.max(0, Math.min(1, ind.bbPercentB));
  }

  let trendScore = 0.5;
  if (ind.trend === "up") trendScore = 0.7;
  else if (ind.trend === "down") trendScore = 0.3;

  let momScore = 0.5;
  if (roc != null) {
    momScore = 0.5 + Math.max(-0.4, Math.min(0.4, roc / 4));
  }

  // Weighted composite
  const w = { rsi: 0.25, macd: 0.25, bb: 0.15, trend: 0.20, momentum: 0.15 };
  const score = w.rsi * rsiScore + w.macd * macdScore + w.bb * bbScore + w.trend * trendScore + w.momentum * momScore;

  // Confidence = distance from 0.5, boosted by agreement among signals
  const components = [rsiScore, macdScore, bbScore, trendScore, momScore];
  const bullishCount = components.filter(x => x > 0.55).length;
  const bearishCount = components.filter(x => x < 0.45).length;
  const agreement = Math.max(bullishCount, bearishCount) / components.length;
  const distance = Math.abs(score - 0.5) * 2; // 0..1
  const confidence = Math.max(0, Math.min(1, distance * 0.6 + agreement * 0.4));

  let action: Action = "HOLD";
  if (score >= buyThreshold) action = "BUY";
  else if (score <= sellThreshold) action = "SELL";

  const parts: string[] = [];
  if (ind.rsi != null) parts.push(`RSI ${ind.rsi.toFixed(1)}`);
  if (ind.macdHist != null) parts.push(`MACD ${ind.macdHist >= 0 ? "+" : ""}${ind.macdHist.toFixed(3)}`);
  if (ind.bbPercentB != null) parts.push(`%B ${ind.bbPercentB.toFixed(2)}`);
  parts.push(`trend ${ind.trend}`);
  parts.push(`mom ${roc.toFixed(2)}%`);
  const reasoning = `${action} (score ${(score * 100).toFixed(0)}/100): ${parts.join(", ")}`;

  return {
    score,
    confidence,
    action,
    reasoning,
    breakdown: { rsi: rsiScore, macd: macdScore, bb: bbScore, trend: trendScore, momentum: momScore },
    indicators: ind,
  };
}

export function buildTechnicalSignal(pair: string, analysis: ScoredAnalysis): Signal | null {
  if (analysis.action === "HOLD") return null;
  return {
    id: `tech-${pair}-${Date.now()}`,
    source: "technical",
    origin: "engine",
    pair,
    action: analysis.action,
    confidence: analysis.confidence,
    reasoning: analysis.reasoning,
    createdAt: Date.now(),
    weight: 1.0,
  };
}
