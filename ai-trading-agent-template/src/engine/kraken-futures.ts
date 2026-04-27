/**
 * Kraken Futures REST client (DEMO environment by default).
 *
 * Auth scheme (from Kraken Futures docs):
 *   1. Concatenate: postData + nonce + endpointPath
 *      where endpointPath is e.g. "/api/v3/sendorder" (no /derivatives prefix)
 *   2. SHA-256 hash that string
 *   3. Base64-decode the API secret
 *   4. HMAC-SHA512 the SHA-256 digest using the decoded secret
 *   5. Base64-encode the HMAC result -> "Authent" header
 *
 * Headers:
 *   APIKey:  <public key>
 *   Nonce:   <ms timestamp string>
 *   Authent: <base64 HMAC>
 *
 * Demo:
 *   REST:  https://demo-futures.kraken.com/derivatives/api/v3
 *   WS:    wss://demo-futures.kraken.com/derivatives/ws/v1
 */

import * as crypto from "crypto";

const DEMO_BASE = "https://demo-futures.kraken.com/derivatives";
const LIVE_BASE = "https://futures.kraken.com/derivatives";

export type FuturesEnv = "demo" | "live";

export interface FuturesInstrument {
  symbol: string;
  type: string;                    // "flexible_futures" | "futures_inverse" etc.
  tradeable: boolean;
  underlying?: string;
  tickSize?: number;
  contractSize?: number;
  marginLevels?: Array<{ contracts: number; initialMargin: number; maintenanceMargin: number }>;
  fundingRateCoefficient?: number;
  maxRelativeFundingRate?: number;
  category?: string;
  isin?: string;
  pair?: string;
}

export interface FuturesTicker {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  vol24h: number;
  markPrice: number;
  indexPrice?: number;
  fundingRate?: number;            // current 8h funding (per period)
  fundingRatePrediction?: number;
  openInterest?: number;
  change24h?: number;
}

export interface FuturesAccountBalance {
  currency: string;                // e.g. "USD", "xbt"
  available: number;               // free margin in that currency
  collateralValue?: number;        // USD value
}

export interface FuturesAccount {
  type: string;                    // "marginAccount" | "cashAccount" | "multiCollateralMarginAccount"
  currency?: string;
  // For multi-collateral accounts:
  balances?: Record<string, number>;             // currency -> qty
  marginEquity?: number;                         // USD-equivalent
  portfolioValue?: number;                       // USD-equivalent (incl. unrealized)
  initialMargin?: number;                        // USD-equivalent
  maintenanceMargin?: number;                    // USD-equivalent
  availableMargin?: number;                      // USD-equivalent
  // For single-currency margin accounts:
  auxiliary?: { pv?: number; pnl?: number; af?: number; usd?: number };
  marginRequirements?: { im?: number; mm?: number; lt?: number; tt?: number };
  raw?: any;
}

export interface FuturesOpenPosition {
  symbol: string;
  side: "long" | "short";
  size: number;                    // contract qty
  price: number;                   // entry price
  fillTime?: string;
  unrealizedFunding?: number;
  pnlCurrency?: string;
  liquidationThreshold?: number;   // liquidation price approx
  effectiveLeverage?: number;
  raw?: any;
}

export interface FuturesOrderResult {
  ok: boolean;
  status?: string;                 // "placed" | "partiallyFilled" | "filled" | "cancelled" | error
  orderId?: string;
  filledSize?: number;
  averagePrice?: number;
  reason?: string;
  raw?: any;
}

export interface FuturesClientOpts {
  env?: FuturesEnv;
  apiKey?: string;
  apiSecret?: string;
  baseUrlOverride?: string;
  timeoutMs?: number;
}

export class KrakenFuturesClient {
  readonly base: string;
  readonly env: FuturesEnv;
  private apiKey?: string;
  private apiSecret?: string;
  private timeoutMs: number;
  // Track recent errors for surfacing in the dashboard
  errors: { ts: number; where: string; msg: string }[] = [];

  constructor(opts: FuturesClientOpts = {}) {
    this.env = opts.env ?? "demo";
    this.base = opts.baseUrlOverride ?? (this.env === "demo" ? DEMO_BASE : LIVE_BASE);
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  isAuthed(): boolean { return !!(this.apiKey && this.apiSecret); }

  private sign(path: string, postData: string, nonce: string): string {
    if (!this.apiSecret) throw new Error("apiSecret missing");
    // path passed in must be the *endpoint* path (e.g. "/api/v3/sendorder"), not "/derivatives/..."
    const message = postData + nonce + path;
    const sha256 = crypto.createHash("sha256").update(message).digest();
    const secret = Buffer.from(this.apiSecret, "base64");
    const hmac = crypto.createHmac("sha512", secret).update(sha256).digest();
    return hmac.toString("base64");
  }

  private async request(method: "GET" | "POST", endpoint: string, params?: Record<string, string | number | boolean>, requireAuth = false): Promise<any> {
    // endpoint = "/api/v3/instruments"
    const url = new URL(this.base + endpoint);
    let body = "";
    let postData = "";

    if (method === "GET" && params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    } else if (method === "POST" && params) {
      // Kraken Futures sends POST params in the URL query string AND uses
      // that same query string (without the leading '?') as `postData` for signing.
      const qp = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) qp.set(k, String(v));
      postData = qp.toString();
      url.search = postData;
    }

    const headers: Record<string, string> = { "Accept": "application/json" };
    if (requireAuth) {
      if (!this.isAuthed()) throw new Error(`auth required but no API keys configured`);
      const nonce = String(Date.now()) + Math.floor(Math.random() * 1000).toString().padStart(3, "0");
      const sigPath = endpoint;                              // already "/api/v3/..."
      const authent = this.sign(sigPath, postData, nonce);
      headers["APIKey"] = this.apiKey!;
      headers["Nonce"] = nonce;
      headers["Authent"] = authent;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(url.toString(), { method, headers, body: body || undefined, signal: ac.signal });
      const text = await res.text();
      let json: any;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!res.ok) {
        const msg = json?.error || json?.errors?.join("; ") || `HTTP ${res.status}`;
        this.pushErr(endpoint, msg);
        throw new Error(`${endpoint}: ${msg}`);
      }
      // Kraken Futures envelopes successful responses with `result: "success"` or it returns data directly
      if (json && json.result === "error") {
        const msg = json.error || (json.errors && json.errors.join("; ")) || "unknown error";
        this.pushErr(endpoint, msg);
        throw new Error(`${endpoint}: ${msg}`);
      }
      return json;
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (!msg.includes(endpoint)) this.pushErr(endpoint, msg);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private pushErr(where: string, msg: string) {
    this.errors.push({ ts: Date.now(), where, msg });
    if (this.errors.length > 20) this.errors.splice(0, this.errors.length - 20);
  }

  // ─── Public endpoints ────────────────────────────────────────────────────

  async getInstruments(): Promise<FuturesInstrument[]> {
    const j = await this.request("GET", "/api/v3/instruments");
    const list = (j.instruments || []) as any[];
    return list.map(i => ({
      symbol: i.symbol,
      type: i.type,
      tradeable: i.tradeable !== false,
      underlying: i.underlying,
      tickSize: Number(i.tickSize),
      contractSize: Number(i.contractSize ?? 1),
      marginLevels: i.marginLevels,
      fundingRateCoefficient: i.fundingRateCoefficient,
      maxRelativeFundingRate: i.maxRelativeFundingRate,
      category: i.category,
      isin: i.isin,
      pair: i.pair,
    }));
  }

  async getTickers(): Promise<Map<string, FuturesTicker>> {
    const j = await this.request("GET", "/api/v3/tickers");
    const out = new Map<string, FuturesTicker>();
    for (const t of (j.tickers || []) as any[]) {
      out.set(t.symbol, {
        symbol: t.symbol,
        last: Number(t.last ?? t.markPrice ?? 0),
        bid: Number(t.bid ?? t.markPrice ?? 0),
        ask: Number(t.ask ?? t.markPrice ?? 0),
        vol24h: Number(t.vol24h ?? 0),
        markPrice: Number(t.markPrice ?? t.last ?? 0),
        indexPrice: Number(t.indexPrice ?? 0) || undefined,
        fundingRate: t.fundingRate != null ? Number(t.fundingRate) : undefined,
        fundingRatePrediction: t.fundingRatePrediction != null ? Number(t.fundingRatePrediction) : undefined,
        openInterest: t.openInterest != null ? Number(t.openInterest) : undefined,
        change24h: t.change24h != null ? Number(t.change24h) : undefined,
      });
    }
    return out;
  }

  // ─── Authed endpoints ────────────────────────────────────────────────────

  /**
   * Returns the multi-collateral margin account (or any other account) summary
   * with USD-equivalent balances. The demo defaults to a flex margin account.
   */
  async getAccounts(): Promise<{ raw: any; flex?: FuturesAccount; cash?: FuturesAccount }> {
    const j = await this.request("GET", "/api/v3/accounts", undefined, true);
    const accounts = j.accounts || {};
    const out: { raw: any; flex?: FuturesAccount; cash?: FuturesAccount } = { raw: accounts };
    // Kraken returns a map keyed by account type
    for (const [type, raw] of Object.entries(accounts) as [string, any][]) {
      const acc: FuturesAccount = {
        type,
        currency: raw.currency,
        balances: raw.balances,
        marginEquity: raw.marginEquity ?? raw.balanceValue,
        portfolioValue: raw.portfolioValue ?? raw.pv ?? raw.auxiliary?.pv,
        initialMargin: raw.initialMargin ?? raw.marginRequirements?.im,
        maintenanceMargin: raw.maintenanceMargin ?? raw.marginRequirements?.mm,
        availableMargin: raw.availableMargin ?? raw.auxiliary?.af,
        auxiliary: raw.auxiliary,
        marginRequirements: raw.marginRequirements,
        raw,
      };
      if (/flex|multi|fv|portfolio/i.test(type)) out.flex = acc;
      if (/cash/i.test(type)) out.cash = acc;
      // Always map the first one as flex if nothing matches
      if (!out.flex) out.flex = acc;
    }
    return out;
  }

  async getOpenPositions(): Promise<FuturesOpenPosition[]> {
    const j = await this.request("GET", "/api/v3/openpositions", undefined, true);
    const list = (j.openPositions || []) as any[];
    return list.map(p => ({
      symbol: p.symbol,
      side: (String(p.side).toLowerCase() === "short" ? "short" : "long") as "long" | "short",
      size: Number(p.size),
      price: Number(p.price),
      fillTime: p.fillTime,
      unrealizedFunding: p.unrealizedFunding != null ? Number(p.unrealizedFunding) : undefined,
      pnlCurrency: p.pnlCurrency,
      liquidationThreshold: p.liquidationThreshold != null ? Number(p.liquidationThreshold) : undefined,
      effectiveLeverage: p.effectiveLeverage != null ? Number(p.effectiveLeverage) : undefined,
      raw: p,
    }));
  }

  async getOpenOrders(): Promise<any[]> {
    const j = await this.request("GET", "/api/v3/openorders", undefined, true);
    return j.openOrders || [];
  }

  /**
   * Place a market or limit order.
   *   side: "buy" | "sell"
   *   symbol: "PF_XBTUSD" etc.
   *   size: contract qty (NOT USD)
   *   limitPrice: required for "lmt" type
   *   stopPrice: required for "stp"
   *   reduceOnly: only allowed to close
   */
  async sendOrder(params: {
    orderType: "mkt" | "lmt" | "stp" | "take_profit" | "trailing_stop";
    symbol: string;
    side: "buy" | "sell";
    size: number;
    limitPrice?: number;
    stopPrice?: number;
    reduceOnly?: boolean;
    triggerSignal?: "mark" | "index" | "last";
    cliOrdId?: string;
  }): Promise<FuturesOrderResult> {
    const body: Record<string, string | number | boolean> = {
      orderType: params.orderType,
      symbol: params.symbol,
      side: params.side,
      size: params.size,
    };
    if (params.limitPrice != null) body.limitPrice = params.limitPrice;
    if (params.stopPrice != null) body.stopPrice = params.stopPrice;
    if (params.reduceOnly) body.reduceOnly = true;
    if (params.triggerSignal) body.triggerSignal = params.triggerSignal;
    if (params.cliOrdId) body.cliOrdId = params.cliOrdId;
    const j = await this.request("POST", "/api/v3/sendorder", body, true);
    const status = j.sendStatus || j;
    return {
      ok: !!status && (status.status === "placed" || status.status === "partiallyFilled" || status.status === "filled"),
      status: status?.status,
      orderId: status?.order_id,
      filledSize: status?.orderEvents?.find((e: any) => e.type === "EXECUTION")?.amount,
      averagePrice: status?.orderEvents?.find((e: any) => e.type === "EXECUTION")?.price,
      reason: status?.reason,
      raw: j,
    };
  }

  async cancelOrder(orderId: string): Promise<any> {
    return this.request("POST", "/api/v3/cancelorder", { order_id: orderId }, true);
  }

  async cancelAllOrders(symbol?: string): Promise<any> {
    return this.request("POST", "/api/v3/cancelallorders", symbol ? { symbol } : {}, true);
  }

  async getHistoricalFundingRates(symbol: string): Promise<any[]> {
    const j = await this.request("GET", "/api/v3/historicalfundingrates", { symbol });
    return j.rates || [];
  }
}

// ─── Pair mapping (Kraken spot ↔ Kraken Futures perpetual) ─────────────────

const SPOT_TO_PERP: Record<string, string> = {
  XBTUSD: "PF_XBTUSD",
  ETHUSD: "PF_ETHUSD",
  SOLUSD: "PF_SOLUSD",
  XRPUSD: "PF_XRPUSD",
  ADAUSD: "PF_ADAUSD",
  DOGEUSD: "PF_DOGEUSD",
  AVAXUSD: "PF_AVAXUSD",
  LINKUSD: "PF_LINKUSD",
  DOTUSD: "PF_DOTUSD",
  ATOMUSD: "PF_ATOMUSD",
  LTCUSD: "PF_LTCUSD",
  BCHUSD: "PF_BCHUSD",
  UNIUSD: "PF_UNIUSD",
  XMRUSD: "PF_XMRUSD",
};

export function spotToPerp(spotPair: string): string | null {
  return SPOT_TO_PERP[spotPair.toUpperCase()] ?? null;
}

export function perpToSpot(perp: string): string | null {
  for (const [s, p] of Object.entries(SPOT_TO_PERP)) if (p === perp) return s;
  return null;
}

export function listPerpsForWatchlist(watchlist: string[]): string[] {
  return watchlist.map(spotToPerp).filter((x): x is string => !!x);
}
