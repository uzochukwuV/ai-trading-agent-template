/**
 * Prism API trading signals.
 *
 * Endpoint: GET /signals/{symbol}
 *   Returns one entry per symbol with overall_signal in
 *   {strong_bullish, bullish, neutral, bearish, strong_bearish}, plus
 *   indicators (rsi, macd, bollinger), active_signals[], and a net_score.
 *
 * Free tier is 10 req/min and 1 QPS, so we throttle (1.2s spacing) and
 * cache the full snapshot for cacheTtlMs (default 10 min).
 *
 * Pair → symbol mapping: Kraken pairs end in USD and use XBT for BTC.
 *   XBTUSD → BTC, ETHUSD → ETH, etc.
 */

import { Action } from "./types";

const PRISM_BASE = "https://api.prismapi.ai";

export type PrismSignalLabel =
  | "strong_bullish" | "bullish" | "neutral" | "bearish" | "strong_bearish";

export interface PrismSignalEntry {
  pair: string;                 // engine pair (e.g. XBTUSD)
  symbol: string;               // prism symbol (e.g. BTC)
  overall: PrismSignalLabel;
  direction: "bullish" | "bearish" | "neutral";
  strength: "weak" | "moderate" | "strong";
  netScore: number;             // bullish_score - bearish_score
  bullishScore: number;
  bearishScore: number;
  currentPrice: number | null;
  indicators: {
    rsi?: number;
    macd?: number;
    macdHistogram?: number;
    bollingerUpper?: number;
    bollingerLower?: number;
  };
  activeSignals: Array<{ type: string; signal: string; value?: number }>;
  signalCount: number;
  timestamp: number;            // ms epoch
  raw?: any;                    // original payload for debugging (only the latest)
}

export interface PrismSignalsSnapshot {
  fetchedAt: number;
  cacheUntil: number;
  entries: PrismSignalEntry[];
  errors: string[];
  degraded: string[];           // symbols Prism flagged degraded
}

/**
 * Convert a Kraken pair like "XBTUSD" → Prism symbol like "BTC".
 * Returns null if the pair doesn't end in USD (we only trade USD pairs).
 */
export function pairToSymbol(pair: string): string | null {
  if (!pair.endsWith("USD")) return null;
  let base = pair.slice(0, -3);
  if (base === "XBT") base = "BTC";
  if (base === "XDG") base = "DOGE";
  return base;
}

/**
 * Map Prism's overall label → trading action + 0..1 confidence.
 *   strong_*   → 0.85
 *   bullish    → 0.65
 *   bearish    → 0.65
 *   neutral    → HOLD (0.0)
 */
export function prismToAction(entry: PrismSignalEntry): { action: Action; confidence: number } {
  switch (entry.overall) {
    case "strong_bullish": return { action: "BUY",  confidence: 0.85 };
    case "bullish":        return { action: "BUY",  confidence: 0.65 };
    case "strong_bearish": return { action: "SELL", confidence: 0.85 };
    case "bearish":        return { action: "SELL", confidence: 0.65 };
    case "neutral":
    default:               return { action: "HOLD", confidence: 0 };
  }
}

export class PrismSignals {
  private snap: PrismSignalsSnapshot | null = null;
  private inflight: Promise<PrismSignalsSnapshot> | null = null;

  constructor(
    private apiKey: string | undefined,
    private cacheTtlMs = 10 * 60 * 1000,
    private requestSpacingMs = 1200,        // ~50 req/min ceiling, well under 60/min
    private timeoutMs = 8000,
  ) {}

  isConfigured(): boolean { return !!this.apiKey; }
  cached(): PrismSignalsSnapshot | null { return this.snap; }

  /** Get cached snapshot, or fetch fresh data for the given pairs. */
  async get(pairs: string[], force = false): Promise<PrismSignalsSnapshot> {
    if (!force && this.snap && Date.now() < this.snap.cacheUntil) return this.snap;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchAll(pairs).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async fetchAll(pairs: string[]): Promise<PrismSignalsSnapshot> {
    const errors: string[] = [];
    const degraded: string[] = [];
    const entries: PrismSignalEntry[] = [];

    if (!this.apiKey) {
      this.snap = {
        fetchedAt: Date.now(),
        cacheUntil: Date.now() + this.cacheTtlMs,
        entries: [],
        errors: ["PRISM_API_KEY not configured"],
        degraded: [],
      };
      return this.snap;
    }

    // Sequential with spacing — Prism free tier is 1 QPS / 10 RPM.
    for (const pair of pairs) {
      const sym = pairToSymbol(pair);
      if (!sym) continue;
      try {
        const data = await this.safeGet<any>(`/signals/${sym}`);
        const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
        if (data?.metadata?.degraded_sources?.length) degraded.push(sym);
        for (const d of list) {
          const e = parseEntry(pair, sym, d);
          if (e) entries.push(e);
        }
      } catch (e: any) {
        errors.push(`${sym}: ${e.message}`);
      }
      // Throttle between requests, but skip the wait after the last pair.
      await sleep(this.requestSpacingMs);
    }

    this.snap = {
      fetchedAt: Date.now(),
      cacheUntil: Date.now() + this.cacheTtlMs,
      entries,
      errors,
      degraded,
    };
    return this.snap;
  }

  private async safeGet<T>(p: string): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await fetch(PRISM_BASE + p, {
        signal: ctrl.signal,
        headers: { "X-API-Key": this.apiKey!, "Accept": "application/json" },
      });
      const body = await r.text();
      if (!r.ok) {
        // Try to surface the API's structured error.
        try { const j = JSON.parse(body); throw new Error(j.message || j.detail || `HTTP ${r.status}`); }
        catch { throw new Error(`HTTP ${r.status}: ${body.slice(0, 120)}`); }
      }
      return JSON.parse(body) as T;
    } finally {
      clearTimeout(t);
    }
  }
}

function parseEntry(pair: string, sym: string, d: any): PrismSignalEntry | null {
  if (!d || typeof d !== "object") return null;
  const overall = String(d.overall_signal ?? "neutral") as PrismSignalLabel;
  const ts = parseTime(d.timestamp) ?? Date.now();
  const ind = d.indicators ?? {};
  return {
    pair,
    symbol: sym,
    overall,
    direction: (d.direction ?? "neutral") as PrismSignalEntry["direction"],
    strength: (d.strength ?? "weak") as PrismSignalEntry["strength"],
    netScore: Number(d.net_score ?? 0),
    bullishScore: Number(d.bullish_score ?? 0),
    bearishScore: Number(d.bearish_score ?? 0),
    currentPrice: Number.isFinite(d.current_price) ? Number(d.current_price) : null,
    indicators: {
      rsi: numOrUndef(ind.rsi),
      macd: numOrUndef(ind.macd),
      macdHistogram: numOrUndef(ind.macd_histogram),
      bollingerUpper: numOrUndef(ind.bollinger_upper),
      bollingerLower: numOrUndef(ind.bollinger_lower),
    },
    activeSignals: Array.isArray(d.active_signals) ? d.active_signals.map((s: any) => ({
      type: String(s.type ?? ""),
      signal: String(s.signal ?? ""),
      value: numOrUndef(s.value),
    })) : [],
    signalCount: Number(d.signal_count ?? 0),
    timestamp: ts,
  };
}

function numOrUndef(v: unknown): number | undefined {
  return Number.isFinite(v as number) ? Number(v) : undefined;
}
function parseTime(v: unknown): number | undefined {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") { const t = Date.parse(v); if (!isNaN(t)) return t; }
  return undefined;
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
