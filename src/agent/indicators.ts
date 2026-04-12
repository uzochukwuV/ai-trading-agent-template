/**
 * Technical indicators for crypto trading analysis.
 *
 * All indicators accept arrays of price/volume data and return
 * normalized values where applicable.
 */

import { OHLCV } from "../types/index";

// ─────────────────────────────────────────────────────────────────────────────
// RSI — Relative Strength Index
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate RSI (Relative Strength Index).
 *
 * @param closes Array of closing prices
 * @param period Lookback period (default 14)
 * @returns RSI value 0-100. >70 = overbought, <30 = oversold
 */
export function calculateRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  // Calculate initial averages
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }

  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Calculate Wilder's smoothed RSI (the standard implementation).
 * Uses exponential smoothing for more accurate results.
 */
export function calculateRSIWilder(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  // First pass: calculate initial average gain/loss
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[closes.length - period + i - 1] - closes[closes.length - period + i - 2];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }

  avgGain /= period;
  avgLoss /= period;

  // Smooth with remaining data
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ─────────────────────────────────────────────────────────────────────────────
// MACD — Moving Average Convergence Divergence
// ─────────────────────────────────────────────────────────────────────────────

export interface MACDResult {
  macd: number;        // MACD line (fast EMA - slow EMA)
  signal: number;      // Signal line (EMA of MACD)
  histogram: number;   // MACD - Signal
}

/**
 * Calculate MACD.
 *
 * @param closes Array of closing prices
 * @param fastPeriod Fast EMA period (default 12)
 * @param slowPeriod Slow EMA period (default 26)
 * @param signalPeriod Signal line EMA period (default 9)
 */
export function calculateMACD(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): MACDResult | null {
  if (closes.length < slowPeriod + signalPeriod) return null;

  const fastEMA = calculateEMA(closes, fastPeriod);
  const slowEMA = calculateEMA(closes, slowPeriod);

  if (fastEMA === null || slowEMA === null) return null;

  // Calculate MACD line for each point where we have both EMAs
  const macdLine: number[] = [];
  const minLen = Math.min(
    closes.length - fastPeriod + 1,
    closes.length - slowPeriod + 1
  );

  for (let i = 0; i < minLen; i++) {
    macdLine.push(fastEMA[i] - slowEMA[i]);
  }

  // Calculate signal line (EMA of MACD)
  const signalEMA = calculateEMAFromArray(macdLine, signalPeriod);
  if (signalEMA === null) return null;

  const macd = macdLine[macdLine.length - 1];
  const signal = signalEMA[signalEMA.length - 1];

  return { macd, signal, histogram: macd - signal };
}

// ─────────────────────────────────────────────────────────────────────────────
// EMA — Exponential Moving Average
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate EMA for an array of prices.
 * Returns array of EMA values (same length as input, nulls at start).
 */
export function calculateEMA(prices: number[], period: number): number[] | null {
  if (prices.length < period) return null;

  const result: number[] = new Array(prices.length).fill(0);
  const multiplier = 2 / (period + 1);

  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  result[period - 1] = sum / period;

  // Calculate EMA
  for (let i = period; i < prices.length; i++) {
    result[i] = (prices[i] - result[i - 1]) * multiplier + result[i - 1];
  }

  // Zero out the first (period-1) values
  for (let i = 0; i < period - 1; i++) result[i] = 0;

  return result;
}

/**
 * Calculate EMA from an already-computed array (for signal line).
 */
export function calculateEMAFromArray(values: number[], period: number): number[] | null {
  return calculateEMA(values, period);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bollinger Bands
// ─────────────────────────────────────────────────────────────────────────────

export interface BollingerBands {
  upper: number;
  middle: number; // SMA
  lower: number;
  bandwidth: number;  // (upper - lower) / middle
  percentB: number;   // Where current price sits within bands (0-1)
}

/**
 * Calculate Bollinger Bands.
 *
 * @param closes Array of closing prices
 * @param period Lookback period (default 20)
 * @param stdDevMultiplier Standard deviation multiplier (default 2)
 * @param currentPrice Current price for %B calculation
 */
export function calculateBollingerBands(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2,
  currentPrice?: number
): BollingerBands | null {
  if (closes.length < period) return null;

  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;

  // Standard deviation
  const variance = slice.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = sma + stdDevMultiplier * stdDev;
  const lower = sma - stdDevMultiplier * stdDev;
  const bandwidth = sma > 0 ? (upper - lower) / sma : 0;

  let percentB = 0.5;
  if (currentPrice !== undefined && bandwidth > 0) {
    percentB = (currentPrice - lower) / (upper - lower);
  }

  return { upper, middle: sma, lower, bandwidth, percentB };
}

// ─────────────────────────────────────────────────────────────────────────────
// ATR — Average True Range
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate ATR (Average True Range) for volatility measurement.
 *
 * @param ohlc OHLCV candles
 * @param period Lookback period (default 14)
 * @returns ATR value (in price units)
 */
export function calculateATR(ohlc: OHLCV[], period = 14): number | null {
  if (ohlc.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = ohlc.length - period; i < ohlc.length; i++) {
    const candle = ohlc[i];
    const prevClose = i > 0 ? ohlc[i - 1].close : candle.open;
    const tr = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prevClose),
      Math.abs(candle.low - prevClose)
    );
    trueRanges.push(tr);
  }

  return trueRanges.reduce((a, b) => a + b, 0) / period;
}

// ─────────────────────────────────────────────────────────────────────────────
// VWAP — Volume Weighted Average Price (from OHLC)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate session VWAP from OHLCV candles.
 * Uses typical price = (high + low + close) / 3.
 *
 * @param ohlc OHLCV candles (assumed to be within a session)
 * @returns Current VWAP value
 */
export function calculateVWAP(ohlc: OHLCV[]): number | null {
  if (ohlc.length === 0) return null;

  let cumulativeTPV = 0; // Typical Price × Volume
  let cumulativeVolume = 0;

  for (const candle of ohlc) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativeTPV += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;
  }

  return cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Momentum / Rate of Change
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate Rate of Change (momentum as percentage).
 *
 * @param closes Array of closing prices
 * @param period Lookback period
 * @returns Percentage change over the period
 */
export function calculateROC(closes: number[], period: number): number | null {
  if (closes.length <= period || closes[closes.length - period - 1] === 0) return null;
  const current = closes[closes.length - 1];
  const previous = closes[closes.length - period - 1];
  return ((current - previous) / previous) * 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite indicator summary
// ─────────────────────────────────────────────────────────────────────────────

export interface IndicatorSummary {
  rsi: number | null;
  macd: MACDResult | null;
  bollinger: BollingerBands | null;
  atr: number | null;
  vwap: number | null;
  roc5: number | null;
  roc20: number | null;
  trend: "bullish" | "bearish" | "neutral";
  volatility: "high" | "medium" | "low" | null;
}

/**
 * Calculate all indicators from OHLCV data and return a summary.
 */
export function calculateAllIndicators(ohlc: OHLCV[], currentPrice: number): IndicatorSummary {
  const closes = ohlc.map(c => c.close);

  const rsi = calculateRSIWilder(closes, 14);
  const macd = calculateMACD(closes);
  const bollinger = calculateBollingerBands(closes, 20, 2, currentPrice);
  const atr = calculateATR(ohlc, 14);
  const vwap = calculateVWAP(ohlc);
  const roc5 = calculateROC(closes, 5);
  const roc20 = calculateROC(closes, 20);

  // Determine trend
  let trend: "bullish" | "bearish" | "neutral" = "neutral";
  if (macd !== null && macd.histogram > 0 && roc5 !== null && roc5 > 0) trend = "bullish";
  else if (macd !== null && macd.histogram < 0 && roc5 !== null && roc5 < 0) trend = "bearish";
  else if (rsi !== null && rsi > 55) trend = "bullish";
  else if (rsi !== null && rsi < 45) trend = "bearish";

  // Determine volatility
  let volatility: "high" | "medium" | "low" | null = null;
  if (bollinger !== null && currentPrice > 0) {
    const bw = bollinger.bandwidth;
    if (bw > 0.05) volatility = "high";
    else if (bw > 0.02) volatility = "medium";
    else volatility = "low";
  }

  return { rsi, macd, bollinger, atr, vwap, roc5, roc20, trend, volatility };
}
