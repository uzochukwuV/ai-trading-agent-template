/**
 * Lightweight Kraken public-API market data client.
 *
 * Uses only public endpoints — no API key, no CLI binary required.
 *   - GET /0/public/Ticker?pair=...
 *   - GET /0/public/OHLC?pair=...&interval=...
 *
 * If the network is unavailable, falls back to a deterministic random walk
 * so the dashboard always has data to show during local development.
 */

import { Tick, PairCandle } from "./types";

const KRAKEN_BASE = "https://api.kraken.com/0/public";

// Kraken returns altname-keyed responses that don't always match what we sent.
// Map our display pair -> the expected response key (XBT pairs use XXBTZ...).
const PAIR_TO_RESPONSE_KEY: Record<string, string> = {
  XBTUSD: "XXBTZUSD",
  ETHUSD: "XETHZUSD",
  XRPUSD: "XXRPZUSD",
  LTCUSD: "XLTCZUSD",
};

function responseKey(pair: string): string[] {
  // Try the mapped key first, then the raw pair name.
  const k = PAIR_TO_RESPONSE_KEY[pair];
  return k ? [k, pair] : [pair];
}

async function safeFetch(url: string, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { error?: string[]; result?: unknown };
    if (j.error && Array.isArray(j.error) && j.error.length) {
      throw new Error(`Kraken error: ${j.error.join("; ")}`);
    }
    return j.result ?? j;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchTickers(pairs: string[]): Promise<Map<string, Tick>> {
  const out = new Map<string, Tick>();
  if (!pairs.length) return out;
  const url = `${KRAKEN_BASE}/Ticker?pair=${encodeURIComponent(pairs.join(","))}`;
  try {
    const result = await safeFetch(url);
    const now = Date.now();
    for (const pair of pairs) {
      let row: any = null;
      for (const k of responseKey(pair)) {
        if (result[k]) { row = result[k]; break; }
      }
      if (!row) continue;
      const last = parseFloat(row.c?.[0] ?? row.p?.[0] ?? "0");
      const bid = parseFloat(row.b?.[0] ?? `${last}`);
      const ask = parseFloat(row.a?.[0] ?? `${last}`);
      const vol = parseFloat(row.v?.[1] ?? "0");
      const high = parseFloat(row.h?.[1] ?? `${last}`);
      const low = parseFloat(row.l?.[1] ?? `${last}`);
      const vwap = parseFloat(row.p?.[1] ?? `${last}`);
      out.set(pair, { pair, price: last, bid, ask, volume24h: vol, high24h: high, low24h: low, vwap24h: vwap, timestamp: now });
    }
  } catch (e) {
    // Soft-fail: caller will fall back to synthetic data.
  }
  return out;
}

export async function fetchOHLC(pair: string, intervalMin = 5, sinceMs?: number): Promise<PairCandle[]> {
  const sinceSec = sinceMs ? Math.floor(sinceMs / 1000) : undefined;
  const params = new URLSearchParams({ pair, interval: String(intervalMin) });
  if (sinceSec) params.set("since", String(sinceSec));
  const url = `${KRAKEN_BASE}/OHLC?${params.toString()}`;
  try {
    const result = await safeFetch(url);
    let rows: any[] | null = null;
    for (const k of responseKey(pair)) {
      if (Array.isArray(result[k])) { rows = result[k]; break; }
    }
    if (!rows) {
      // The OHLC response sometimes uses a different first key — pick the first array value.
      for (const v of Object.values(result)) {
        if (Array.isArray(v)) { rows = v as any[]; break; }
      }
    }
    if (!rows) return [];
    return rows.map(r => ({
      t: Number(r[0]) * 1000,
      o: parseFloat(r[1]),
      h: parseFloat(r[2]),
      l: parseFloat(r[3]),
      c: parseFloat(r[4]),
      v: parseFloat(r[6]),
    }));
  } catch {
    return [];
  }
}

// ─── Fallback synthetic generator (for offline/dev) ──────────────────────────

const SYNTH_BASE: Record<string, number> = {
  XBTUSD: 65000, ETHUSD: 3200, SOLUSD: 145, XRPUSD: 0.6,
  ADAUSD: 0.42, DOGEUSD: 0.13, AVAXUSD: 32, LINKUSD: 14,
  DOTUSD: 7.4, MATICUSD: 0.78, LTCUSD: 88, NEARUSD: 6.1,
};
const synthState = new Map<string, { price: number; trend: number }>();

export function generateSyntheticTick(pair: string): Tick {
  let s = synthState.get(pair);
  if (!s) {
    s = { price: SYNTH_BASE[pair] ?? 100, trend: 0 };
    synthState.set(pair, s);
  }
  // Random walk with mean-reverting trend.
  s.trend = s.trend * 0.92 + (Math.random() - 0.5) * 0.004;
  const drift = s.trend;
  const noise = (Math.random() - 0.5) * 0.003;
  s.price = Math.max(1e-6, s.price * (1 + drift + noise));
  const spread = s.price * 0.0006;
  const now = Date.now();
  return {
    pair,
    price: s.price,
    bid: s.price - spread / 2,
    ask: s.price + spread / 2,
    volume24h: 1000,
    high24h: s.price * 1.02,
    low24h: s.price * 0.98,
    vwap24h: s.price,
    timestamp: now,
  };
}

export function generateSyntheticCandles(pair: string, count = 100): PairCandle[] {
  let price = SYNTH_BASE[pair] ?? 100;
  const out: PairCandle[] = [];
  const now = Date.now();
  for (let i = count - 1; i >= 0; i--) {
    const t = now - i * 5 * 60_000;
    const drift = (Math.random() - 0.5) * 0.006;
    const o = price;
    const c = price * (1 + drift);
    const h = Math.max(o, c) * (1 + Math.random() * 0.002);
    const l = Math.min(o, c) * (1 - Math.random() * 0.002);
    out.push({ t, o, h, l, c, v: 100 + Math.random() * 200 });
    price = c;
  }
  return out;
}
