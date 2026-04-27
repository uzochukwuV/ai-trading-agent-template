/**
 * TradingStrategy implementations — Momentum + LLM (OpenRouter)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LLM Strategy
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses OpenRouter to access models (Nemotron, Claude, Llama, etc.).
 * Called conditionally by the scanner when technical signals are ambiguous.
 *
 * Env variables:
 *   OPENROUTER_API_KEY   - Your OpenRouter API key
 *   LLM_MODEL            - Model to use (default: nvidia/nemotron-4-340b-instruct)
 *   LLM_ENABLED          - Set "true" to enable LLM fallback (default: true)
 *
 * Models available on OpenRouter:
 *   nvidia/nemotron-4-340b-instruct   (free tier available)
 *   anthropic/claude-3.5-haiku        (cheap, fast)
 *   meta-llama/llama-3.3-70b-instruct (good quality)
 *   google/gemini-2.0-flash-lite      (fast, cheap)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import axios from "axios";
import { MarketData, TradeDecision, TradingStrategy, EnrichedMarketData } from "../types/index";
import { calculateAllIndicators, IndicatorSummary } from "./indicators";

// ─────────────────────────────────────────────────────────────────────────────
// OpenRouter LLM client
// ─────────────────────────────────────────────────────────────────────────────

interface LLMConfig {
  apiKey: string;
  model: string;
  enabled: boolean;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  apiKey: process.env.OPENROUTER_API_KEY || "",
  model: process.env.LLM_MODEL || "nvidia/nemotron-4-340b-instruct",
  enabled: process.env.LLM_ENABLED === "true",
  maxTokens: 500,
  temperature: 0.7,
  timeoutMs: 30000,
};

/**
 * System prompt that defines the trading agent's role and constraints.
 */
const SYSTEM_PROMPT = `You are a professional crypto trading analyst. Your job is to analyze market data and provide clear, decisive trade recommendations.

RULES:
1. ALWAYS respond with valid JSON only — no markdown, no explanations, no code blocks.
2. Your JSON must have exactly these fields:
   {
     "action": "BUY" or "SELL" or "HOLD",
     "amount": number (USD, between 50 and 500, 0 for HOLD),
     "confidence": number between 0.0 and 1.0,
     "reasoning": string (brief explanation, max 200 characters)
   }
3. Be conservative — prefer HOLD if signals are unclear.
4. Consider ALL data provided: price action, indicators, order book, trade flow.
5. Factor in risk: don't recommend large positions in uncertain conditions.`;

/**
 * Build a comprehensive prompt from enriched market data and technical indicators.
 * Exported for use by ScannerStrategy and HybridStrategy.
 */
export function buildLLMPrompt(data: EnrichedMarketData, indicators: IndicatorSummary): string {
  const parts: string[] = [];

  // Market overview
  parts.push(`ANALYZE the following crypto market data and provide a trade recommendation:\n`);
  parts.push(`PAIR: ${data.pair}`);
  parts.push(`Current Price: $${data.price.toLocaleString()}`);
  parts.push(`Spread: ${data.spreadBps.toFixed(1)} bps`);
  parts.push(`24h Volume: ${data.volume24h.toFixed(2)}`);
  parts.push(`24h VWAP: $${data.vwap24h.toFixed(2)}`);
  parts.push(`24h Range: $${data.low24h.toFixed(2)} — $${data.high24h.toFixed(2)}`);

  // Technical indicators
  parts.push(`\nTECHNICAL INDICATORS:`);
  parts.push(`  RSI(14): ${indicators.rsi?.toFixed(1) ?? "N/A"} ${indicators.rsi !== null ? (indicators.rsi < 30 ? "[OVERSOLD]" : indicators.rsi > 70 ? "[OVERBOUGHT]" : "[NEUTRAL]") : ""}`);
  if (indicators.macd) {
    parts.push(`  MACD: ${indicators.macd.histogram > 0 ? "BULLISH" : "BEARISH"} (histogram: ${indicators.macd.histogram.toFixed(2)}, signal: ${indicators.macd.signal.toFixed(2)})`);
  }
  if (indicators.bollinger) {
    const bb = indicators.bollinger;
    parts.push(`  Bollinger Bands: %B=${bb.percentB.toFixed(2)} (${bb.percentB < 0.2 ? "near lower — potential bounce" : bb.percentB > 0.8 ? "near upper — potential reversal" : "within bands"}), bandwidth=${(bb.bandwidth * 100).toFixed(2)}%`);
  }
  parts.push(`  ATR(14): ${indicators.atr?.toFixed(2) ?? "N/A"}`);
  parts.push(`  VWAP: ${indicators.vwap ? `$${indicators.vwap.toFixed(2)} (price ${data.price > indicators.vwap ? "above" : "below"})` : "N/A"}`);
  parts.push(`  Trend: ${indicators.trend.toUpperCase()}`);
  if (indicators.volatility) {
    parts.push(`  Volatility: ${indicators.volatility.toUpperCase()}`);
  }

  // Order book
  if (data.orderBookImbalance !== undefined) {
    parts.push(`\nORDER BOOK:`);
    parts.push(`  Imbalance: ${(data.orderBookImbalance * 100).toFixed(1)}% ${data.orderBookImbalance > 0.2 ? "[BID-HEAVY — buying pressure]" : data.orderBookImbalance < -0.2 ? "[ASK-HEAVY — selling pressure]" : "[BALANCED]"}`);
    parts.push(`  Bid depth: ${data.bidDepth?.toFixed(2) ?? "N/A"} | Ask depth: ${data.askDepth?.toFixed(2) ?? "N/A"}`);
  }

  // Trade flow
  if (data.tradeVolumeBias !== undefined) {
    parts.push(`\nTRADE FLOW:`);
    parts.push(`  Volume bias: ${(data.tradeVolumeBias * 100).toFixed(1)}% ${data.tradeVolumeBias > 0.2 ? "[BUY-DOMINATED]" : data.tradeVolumeBias < -0.2 ? "[SELL-DOMINATED]" : "[BALANCED]"}`);
  }

  // OHLC context
  if (data.ohlc.length >= 5) {
    const recent = data.ohlc.slice(-5);
    const change = ((recent[4].close - recent[0].open) / recent[0].open * 100).toFixed(2);
    parts.push(`\nRECENT PRICE ACTION (last 5 candles):`);
    parts.push(`  Change: ${change}%`);
    parts.push(`  Candles: ${recent.map((c, i) => `${i + 1}. O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)}`).join(" | ")}`);
  }

  parts.push(`\nRespond with JSON only. No other text.`);

  return parts.join("\n");
}

/**
 * Parse LLM response with validation and fallback.
 * Exported for use by ScannerStrategy and HybridStrategy.
 */
export function parseLLMResponse(content: string, pair: string): TradeDecision {
  // Strip markdown code blocks if present
  let cleaned = content.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
  }

  try {
    const parsed = JSON.parse(cleaned);

    const action = ["BUY", "SELL", "HOLD"].includes(parsed.action) ? parsed.action : "HOLD";
    const rawAmount = Number(parsed.amount) || 0;
    const amount = action === "HOLD" ? 0 : Math.min(Math.max(rawAmount, 50), 500);
    const confidence = Math.min(Math.max(Number(parsed.confidence) || 0.5, 0), 1);
    const reasoning = String(parsed.reasoning || "LLM recommendation").slice(0, 500);

    return {
      action: action as TradeDecision["action"],
      asset: pair.replace("USD", "").replace("USDT", ""),
      pair,
      amount,
      confidence,
      reasoning: `[LLM] ${reasoning}`,
    };
  } catch {
    // LLM returned invalid JSON — fallback to HOLD
    return {
      action: "HOLD",
      asset: pair.replace("USD", "").replace("USDT", ""),
      pair,
      amount: 0,
      confidence: 0.5,
      reasoning: "[LLM] Failed to parse LLM response — defaulting to HOLD.",
    };
  }
}

/**
 * Call OpenRouter LLM with enriched market data.
 * Exported for use by ScannerStrategy and HybridStrategy.
 */
export async function callOpenRouter(
  config: LLMConfig,
  prompt: string
): Promise<string | null> {
  if (!config.apiKey) return null;

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: config.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        stream: false,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/ai-trading-agent",
          "X-Title": "AI Trading Agent",
          Authorization: `Bearer ${config.apiKey}`,
        },
        timeout: config.timeoutMs,
      }
    );

    const content = response.data.choices?.[0]?.message?.content || "";
    return content;
  } catch (err: unknown) {
    const msg = (err as any)?.response?.data?.error?.message || (err as Error)?.message || "Unknown error";
    console.warn(`[LLM] OpenRouter call failed: ${msg}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Momentum Strategy (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

export class MomentumStrategy implements TradingStrategy {
  private priceHistory: number[] = [];
  private readonly windowSize: number;
  private readonly tradeAmountUsd: number;

  constructor(windowSize = 5, tradeAmountUsd = 100) {
    this.windowSize = windowSize;
    this.tradeAmountUsd = tradeAmountUsd;
  }

  async analyze(data: MarketData): Promise<TradeDecision> {
    this.priceHistory.push(data.price);
    if (this.priceHistory.length > this.windowSize) {
      this.priceHistory.shift();
    }

    if (this.priceHistory.length < this.windowSize) {
      return {
        action: "HOLD",
        asset: data.pair.replace("USD", ""),
        pair: data.pair,
        amount: 0,
        confidence: 0.5,
        reasoning: `Warming up: have ${this.priceHistory.length}/${this.windowSize} price samples. Holding.`,
      };
    }

    const first = this.priceHistory[0];
    const last = this.priceHistory[this.priceHistory.length - 1];
    const changePct = ((last - first) / first) * 100;
    const spread = ((data.ask - data.bid) / data.price) * 100;

    let action: TradeDecision["action"] = "HOLD";
    let confidence = 0.5;
    let reasoning = "";

    if (changePct > 0.5 && spread < 0.1) {
      action = "BUY";
      confidence = Math.min(0.9, 0.5 + Math.abs(changePct) / 10);
      reasoning = `Upward momentum: price rose ${changePct.toFixed(2)}% over last ${this.windowSize} ticks. Spread is tight at ${spread.toFixed(3)}%. Buying.`;
    } else if (changePct < -0.5) {
      action = "SELL";
      confidence = Math.min(0.9, 0.5 + Math.abs(changePct) / 10);
      reasoning = `Downward momentum: price fell ${Math.abs(changePct).toFixed(2)}% over last ${this.windowSize} ticks. Selling to avoid further loss.`;
    } else {
      reasoning = `No clear momentum (${changePct.toFixed(2)}% change). Holding current position.`;
    }

    return {
      action,
      asset: data.pair.replace("USD", ""),
      pair: data.pair,
      amount: action === "HOLD" ? 0 : this.tradeAmountUsd,
      confidence,
      reasoning,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM Strategy — OpenRouter-backed
// ─────────────────────────────────────────────────────────────────────────────

export class LLMStrategy implements TradingStrategy {
  public readonly config: LLMConfig;
  private callCount = 0;

  constructor(config?: Partial<LLMConfig>) {
    this.config = { ...DEFAULT_LLM_CONFIG, ...config };
  }

  /**
   * Main entry — accepts basic MarketData (fetches enriched internally).
   */
  async analyze(data: MarketData): Promise<TradeDecision> {
    // For basic MarketData, we need enriched data for the LLM
    // This requires a KrakenClient which we don't have here — return HOLD
    return {
      action: "HOLD",
      asset: data.pair.replace("USD", ""),
      pair: data.pair,
      amount: 0,
      confidence: 0.5,
      reasoning: "LLMStrategy requires enriched data. Use analyzeEnriched() instead.",
    };
  }

  /**
   * Analyze enriched market data with LLM.
   */
  async analyzeEnriched(data: EnrichedMarketData): Promise<TradeDecision> {
    if (!this.config.enabled) {
      return {
        action: "HOLD",
        asset: data.pair.replace("USD", ""),
        pair: data.pair,
        amount: 0,
        confidence: 0.5,
        reasoning: "[LLM] Disabled — set LLM_ENABLED=true to enable.",
      };
    }

    this.callCount++;
    const indicators = calculateAllIndicators(data.ohlc, data.price);
    const prompt = buildLLMPrompt(data, indicators);

    console.log(`[LLM] #${this.callCount} — Calling ${this.config.model} for ${data.pair}...`);
    const content = await callOpenRouter(this.config, prompt);

    if (!content) {
      return {
        action: "HOLD",
        asset: data.pair.replace("USD", ""),
        pair: data.pair,
        amount: 0,
        confidence: 0.5,
        reasoning: "[LLM] API call failed — defaulting to HOLD.",
      };
    }

    const decision = parseLLMResponse(content, data.pair);
    console.log(`[LLM] #${this.callCount} — ${decision.action} ${decision.pair} (${(decision.confidence * 100).toFixed(0)}%)`);

    return decision;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hybrid Strategy — Technical analysis + LLM fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Uses composite technical analysis as the primary signal.
 * Falls back to LLM when:
 *   - Composite score is ambiguous (0.40–0.60)
 *   - Indicators conflict (e.g., RSI says BUY but MACD says SELL)
 *   - High-confidence position management decision needed
 */
export class HybridStrategy {
  private readonly llm: LLMStrategy;
  private readonly llmThreshold: number;   // Call LLM when score is in [0.5 - threshold, 0.5 + threshold]
  private callCount = 0;

  constructor(options?: { llmConfig?: Partial<LLMConfig>; llmThreshold?: number }) {
    this.llm = new LLMStrategy(options?.llmConfig);
    this.llmThreshold = options?.llmThreshold ?? 0.10; // LLM when score within ±0.10 of 0.50
  }

  /**
   * Analyze enriched data: technical analysis first, LLM fallback if ambiguous.
   */
  async analyzeEnriched(data: EnrichedMarketData): Promise<TradeDecision> {
    const indicators = calculateAllIndicators(data.ohlc, data.price);

    // Technical composite score
    let score = 0.5;
    const breakdown: Record<string, number> = {};

    // RSI
    let rsiScore = 0.5;
    if (indicators.rsi !== null) {
      if (indicators.rsi <= 30) rsiScore = 1.0 - (indicators.rsi / 30) * 0.3;
      else if (indicators.rsi >= 70) rsiScore = (100 - indicators.rsi) / 30 * 0.3;
      else rsiScore = 0.7 - ((indicators.rsi - 30) / 40) * 0.4;
    }
    breakdown.rsi = rsiScore;

    // MACD
    let macdScore = 0.5;
    if (indicators.macd) {
      const histNorm = indicators.macd.histogram / Math.abs(indicators.macd.macd || 1);
      macdScore = 0.5 + Math.max(-0.5, Math.min(0.5, histNorm * 5));
    }
    breakdown.macd = macdScore;

    // Bollinger
    let bbScore = 0.5;
    if (indicators.bollinger) {
      const { percentB } = indicators.bollinger;
      if (percentB < 0) bbScore = 0.85;
      else if (percentB > 1) bbScore = 0.15;
      else if (percentB < 0.2) bbScore = 0.7;
      else if (percentB > 0.8) bbScore = 0.3;
      else bbScore = 0.5 + (0.5 - percentB) * 0.3;
    }
    breakdown.bb = bbScore;

    // Order book
    const obScore = data.orderBookImbalance !== undefined ? (data.orderBookImbalance + 1) / 2 : 0.5;
    breakdown.orderBook = obScore;

    // Trade flow
    const tfScore = data.tradeVolumeBias !== undefined ? (data.tradeVolumeBias + 1) / 2 : 0.5;
    breakdown.tradeFlow = tfScore;

    // Weighted composite
    score = rsiScore * 0.25 + macdScore * 0.25 + bbScore * 0.15 + obScore * 0.20 + tfScore * 0.15;
    score = Math.max(0, Math.min(1, score));

    // Check if signals conflict
    const scores = [rsiScore, macdScore, bbScore, obScore, tfScore];
    const bullish = scores.filter(s => s > 0.6).length;
    const bearish = scores.filter(s => s < 0.4).length;
    const conflicting = bullish > 0 && bearish > 0;

    // Determine if we should call the LLM
    const ambiguous = Math.abs(score - 0.5) < this.llmThreshold;
    const shouldCallLLM = this.llm.config.enabled && (ambiguous || conflicting);

    // Build base reasoning
    const taReasoning = [
      `RSI: ${indicators.rsi?.toFixed(1) ?? "N/A"} (score: ${rsiScore.toFixed(2)})`,
      `MACD: ${indicators.macd ? (macdScore > 0.5 ? "bullish" : "bearish") : "N/A"} (score: ${macdScore.toFixed(2)})`,
      `BB %B: ${indicators.bollinger?.percentB.toFixed(2) ?? "N/A"} (score: ${bbScore.toFixed(2)})`,
      `Order Book: ${(obScore * 100).toFixed(0)}%`,
      `Trade Flow: ${(tfScore * 100).toFixed(0)}%`,
      `Composite: ${(score * 100).toFixed(1)}%`,
      conflicting ? `[CONFLICTING SIGNALS: ${bullish} bullish, ${bearish} bearish]` : `[${indicators.trend.toUpperCase()}]`,
    ].join(" | ");

    if (shouldCallLLM) {
      this.callCount++;
      console.log(`[Hybrid] Ambiguous/conflicting signals (score: ${(score * 100).toFixed(1)}%) — calling LLM...`);

      const prompt = buildLLMPrompt(data, indicators);
      prompt + `\n\nNOTE: Technical analysis is ambiguous (composite: ${(score * 100).toFixed(1)}%). Signals ${conflicting ? "are CONFLICTING" : "are unclear"}. Please provide a definitive recommendation based on your full analysis.`;

      const llmContent = await callOpenRouter(this.llm.config, prompt);

      if (llmContent) {
        const llmDecision = parseLLMResponse(llmContent, data.pair);
        llmDecision.reasoning = `[Hybrid LLM Override] TA was ambiguous. ${llmDecision.reasoning}\nTA Context: ${taReasoning}`;
        console.log(`[Hybrid] LLM recommends: ${llmDecision.action} (${(llmDecision.confidence * 100).toFixed(0)}%)`);
        return llmDecision;
      }
    }

    // Technical analysis decision
    let action: TradeDecision["action"] = "HOLD";
    let confidence = 0.5;

    if (score >= 0.60) {
      action = "BUY";
      confidence = score;
    } else if (score <= 0.40) {
      action = "SELL";
      confidence = 1 - score;
    }

    const amount = action === "HOLD" ? 0 : 100 + Math.round((score - 0.5) * 800);

    return {
      action,
      asset: data.pair.replace("USD", ""),
      pair: data.pair,
      amount: Math.max(0, Math.min(500, amount)),
      confidence: action === "HOLD" ? 0.5 : confidence,
      reasoning: shouldCallLLM
        ? `[Hybrid] LLM unavailable, fell back to TA. ${taReasoning}`
        : taReasoning,
    };
  }
}
