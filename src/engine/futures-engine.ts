/**
 * FuturesEngine — Kraken Futures (demo) trading desk.
 *
 * Responsibilities:
 *   1. Poll the demo REST API for account state, open positions, tickers, funding rates
 *   2. Track an equity curve and basic perf stats for the futures bucket
 *   3. Expose imperative actions: openPosition, closePosition, closeAll
 *   4. Enforce its own risk caps (max leverage, max positions, daily loss, liq buffer)
 *   5. Persist a small amount of local state (entry timestamps, equity curve, daily pnl baseline)
 *
 * Execution model:
 *   - All orders are placed via REST against the demo environment. The demo
 *     account is the source of truth for positions and equity.
 *   - We size by USD notional and convert to contract qty using the current
 *     mark price (PF_ multi-collateral perps are linear, 1 contract = 1 unit
 *     of underlying).
 */

import { EventEmitter } from "events";
import { KrakenFuturesClient, FuturesTicker, FuturesOpenPosition, spotToPerp, perpToSpot, listPerpsForWatchlist } from "./kraken-futures";
import { FuturesPositionView, FuturesEquityPoint, ClosedTrade } from "./types";
import { appendJsonl, dataPath, statePath, readJson, writeJson } from "./persistence";

const FUTURES_TRADES_FILE = dataPath("futures-trades.jsonl");
const FUTURES_STATE_FILE = statePath("futures-engine-state.json");

export interface FuturesRiskCfg {
  maxLeverage: number;            // hard cap on requested leverage (e.g. 5)
  defaultLeverage: number;        // when not specified (e.g. 2)
  maxPositions: number;           // open at once
  maxNotionalPerTradeUsd: number; // hard absolute cap
  maxNotionalPerTradePctOfEquity: number; // % cap relative to bucket equity
  dailyLossLimitPct: number;      // % of bucket equity (kill switch)
  liqBufferPct: number;           // refuse / close if liq within X% of mark
  pollMs: number;                 // poll interval
}

export const DEFAULT_FUTURES_RISK: FuturesRiskCfg = {
  maxLeverage: 5,
  defaultLeverage: 2,
  maxPositions: 4,
  maxNotionalPerTradeUsd: 5_000,
  maxNotionalPerTradePctOfEquity: 30,
  dailyLossLimitPct: 5,
  liqBufferPct: 5,
  pollMs: 20_000,
};

export interface FuturesEngineEvents {
  "tick": { ts: number };
  "trade": { kind: "open" | "close"; pair: string; symbol: string };
  "error": { where: string; msg: string };
}

interface OpenMeta {
  symbol: string;
  pair: string;
  openedAt: number;
  entryPrice: number;
  leverage: number;
  reasoning: string;
}

export class FuturesEngine extends EventEmitter {
  client: KrakenFuturesClient;
  cfg: FuturesRiskCfg;
  watchlist: string[];                       // spot pairs we're allowed to trade as perps
  perpSymbols: string[];                     // mapped PF_ symbols
  enabled: boolean = true;
  paused: boolean = false;
  pauseReason: string | undefined;
  killSwitch: boolean = false;
  killReason: string | undefined;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  startedAt = 0;
  lastPollAt = 0;
  lastError: { ts: number; where: string; msg: string } | null = null;

  // Cached state from last poll
  portfolioValue = 0;
  marginEquity = 0;
  availableMargin = 0;
  initialMargin = 0;
  unrealizedPnl = 0;
  tickers = new Map<string, FuturesTicker>();
  openPositions: FuturesOpenPosition[] = [];
  positionViews: FuturesPositionView[] = [];

  // Local-only metadata
  private openMeta = new Map<string, OpenMeta>();        // symbol -> meta
  closedTrades: ClosedTrade[] = [];
  equityCurve: FuturesEquityPoint[] = [];
  dailyBaselineEquity = 0;                                // start-of-day portfolio value
  dailyBaselineAt = 0;
  feesPaid = 0;
  fundingPaid = 0;

  constructor(opts: {
    apiKey?: string;
    apiSecret?: string;
    watchlist: string[];
    riskCfg?: Partial<FuturesRiskCfg>;
  }) {
    super();
    this.client = new KrakenFuturesClient({
      env: "demo",
      apiKey: opts.apiKey,
      apiSecret: opts.apiSecret,
    });
    this.cfg = { ...DEFAULT_FUTURES_RISK, ...(opts.riskCfg ?? {}) };
    this.watchlist = opts.watchlist;
    this.perpSymbols = listPerpsForWatchlist(opts.watchlist);

    const persisted = readJson<{
      openMeta?: Array<[string, OpenMeta]>;
      closedTrades?: ClosedTrade[];
      equityCurve?: FuturesEquityPoint[];
      dailyBaselineEquity?: number;
      dailyBaselineAt?: number;
      cfg?: Partial<FuturesRiskCfg>;
      enabled?: boolean;
      paused?: boolean;
    }>(FUTURES_STATE_FILE, {});
    if (persisted.openMeta) for (const [k, v] of persisted.openMeta) this.openMeta.set(k, v);
    if (persisted.closedTrades) this.closedTrades = persisted.closedTrades;
    if (persisted.equityCurve) this.equityCurve = persisted.equityCurve;
    if (persisted.dailyBaselineEquity) this.dailyBaselineEquity = persisted.dailyBaselineEquity;
    if (persisted.dailyBaselineAt) this.dailyBaselineAt = persisted.dailyBaselineAt;
    if (persisted.cfg) this.cfg = { ...this.cfg, ...persisted.cfg };
    if (persisted.enabled === false) this.enabled = false;
    if (persisted.paused) this.paused = true;
  }

  isConfigured(): boolean { return this.client.isAuthed(); }

  start(): void {
    if (this.running) return;
    if (!this.isConfigured()) {
      console.warn("[futures] not starting: KRAKEN_FUTURES_DEMO_KEY/SECRET missing");
      return;
    }
    this.running = true;
    this.startedAt = Date.now();
    void this.poll().finally(() => this.scheduleNext());
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.persist();
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.poll().catch(e => {
        this.lastError = { ts: Date.now(), where: "poll", msg: (e as Error).message };
        this.emit("error", this.lastError);
      }).finally(() => this.scheduleNext());
    }, this.cfg.pollMs);
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  async poll(): Promise<void> {
    if (!this.isConfigured()) return;
    this.lastPollAt = Date.now();
    // 1) accounts
    const acc = await this.client.getAccounts();
    const flex = acc.flex;
    if (flex) {
      this.portfolioValue = Number(flex.portfolioValue ?? flex.marginEquity ?? 0);
      this.marginEquity = Number(flex.marginEquity ?? 0);
      this.availableMargin = Number(flex.availableMargin ?? 0);
      this.initialMargin = Number(flex.initialMargin ?? 0);
    }
    // 2) tickers
    try {
      this.tickers = await this.client.getTickers();
    } catch (e) {
      // non-fatal
      this.lastError = { ts: Date.now(), where: "tickers", msg: (e as Error).message };
    }
    // 3) open positions
    try {
      this.openPositions = await this.client.getOpenPositions();
    } catch (e) {
      this.lastError = { ts: Date.now(), where: "openPositions", msg: (e as Error).message };
    }
    // 4) build views
    this.positionViews = this.buildPositionViews();
    this.unrealizedPnl = this.positionViews.reduce((s, p) => s + p.unrealizedPnlUsd, 0);

    // 5) daily baseline
    this.maybeRollDailyBaseline();

    // 6) record equity point (capped)
    this.equityCurve.push({
      t: this.lastPollAt,
      portfolioValue: this.portfolioValue,
      marginEquity: this.marginEquity,
      availableMargin: this.availableMargin,
      initialMargin: this.initialMargin,
      unrealizedPnl: this.unrealizedPnl,
    });
    if (this.equityCurve.length > 1000) this.equityCurve.splice(0, this.equityCurve.length - 1000);

    // 7) check kill switch
    this.checkKillSwitch();

    // 8) check liq buffer on each open position
    if (!this.killSwitch) {
      for (const v of this.positionViews) {
        if (v.liqDistancePct != null && v.liqDistancePct < this.cfg.liqBufferPct) {
          // close immediately to avoid liquidation
          void this.closePosition(v.symbol, `liq buffer breached (${v.liqDistancePct.toFixed(2)}% < ${this.cfg.liqBufferPct}%)`);
        }
      }
    }

    this.persistThrottled();
    this.emit("tick", { ts: this.lastPollAt });
  }

  private buildPositionViews(): FuturesPositionView[] {
    const out: FuturesPositionView[] = [];
    for (const p of this.openPositions) {
      const tk = this.tickers.get(p.symbol);
      const mark = tk?.markPrice ?? p.price;
      const notional = Math.abs(p.size) * mark;
      // long: (mark - entry) * qty ; short: (entry - mark) * qty
      const upnl = p.side === "long"
        ? (mark - p.price) * Math.abs(p.size)
        : (p.price - mark) * Math.abs(p.size);
      const upnlPct = notional > 0 ? (upnl / notional) * 100 : 0;
      const liq = p.liquidationThreshold ?? null;
      let liqDistPct: number | null = null;
      if (liq != null && mark > 0) {
        liqDistPct = p.side === "long"
          ? ((mark - liq) / mark) * 100
          : ((liq - mark) / mark) * 100;
      }
      const meta = this.openMeta.get(p.symbol);
      out.push({
        symbol: p.symbol,
        pair: perpToSpot(p.symbol) ?? p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.price,
        markPrice: mark,
        notionalUsd: notional,
        leverage: p.effectiveLeverage ?? meta?.leverage ?? null,
        unrealizedPnlUsd: upnl,
        unrealizedPnlPct: upnlPct,
        liquidationPrice: liq,
        liqDistancePct: liqDistPct,
        unrealizedFundingUsd: p.unrealizedFunding ?? 0,
        fundingRate: tk?.fundingRate ?? null,
        openedAt: meta?.openedAt ?? (p.fillTime ? Date.parse(p.fillTime) : 0),
      });
    }
    return out;
  }

  private maybeRollDailyBaseline(): void {
    const now = Date.now();
    const dayMs = 24 * 60 * 60_000;
    if (this.dailyBaselineAt === 0 || now - this.dailyBaselineAt > dayMs) {
      this.dailyBaselineEquity = this.portfolioValue;
      this.dailyBaselineAt = now;
    }
  }

  private checkKillSwitch(): void {
    if (this.dailyBaselineEquity <= 0) return;
    const dailyPnl = this.portfolioValue - this.dailyBaselineEquity;
    const dailyPnlPct = (dailyPnl / this.dailyBaselineEquity) * 100;
    if (dailyPnlPct <= -this.cfg.dailyLossLimitPct) {
      if (!this.killSwitch) {
        this.killSwitch = true;
        this.killReason = `daily loss ${dailyPnlPct.toFixed(2)}% <= -${this.cfg.dailyLossLimitPct}%`;
        console.warn(`[futures] kill switch: ${this.killReason}`);
      }
    }
  }

  pause(reason?: string) { this.paused = true; this.pauseReason = reason; this.persist(); }
  resume() { this.paused = false; this.pauseReason = undefined; this.persist(); }
  resetKillSwitch() { this.killSwitch = false; this.killReason = undefined; this.persist(); }
  setEnabled(on: boolean) { this.enabled = on; this.persist(); }

  // ─── Trading actions ──────────────────────────────────────────────────────

  /**
   * Open a market position.
   *   pair: spot pair (e.g. "XBTUSD") — we map to PF_XBTUSD
   *   side: "BUY" -> long ; "SELL" -> short
   *   notionalUsd: target USD notional. We size = notionalUsd / markPrice.
   *   leverage: requested leverage (clamped to maxLeverage)
   *   reasoning: human-readable
   *
   * Returns the order result and the symbol used.
   */
  async openPosition(opts: {
    pair: string;
    side: "BUY" | "SELL";
    notionalUsd: number;
    leverage?: number;
    reasoning: string;
  }): Promise<{ ok: boolean; symbol: string | null; reason?: string; orderId?: string; fillPrice?: number; size?: number }> {
    if (!this.enabled) return { ok: false, symbol: null, reason: "futures disabled" };
    if (this.paused) return { ok: false, symbol: null, reason: `futures paused: ${this.pauseReason ?? ""}` };
    if (this.killSwitch) return { ok: false, symbol: null, reason: `kill switch: ${this.killReason ?? ""}` };
    const symbol = spotToPerp(opts.pair);
    if (!symbol) return { ok: false, symbol: null, reason: `no perp for ${opts.pair}` };
    if (this.positionViews.length >= this.cfg.maxPositions) {
      return { ok: false, symbol, reason: `max positions reached (${this.cfg.maxPositions})` };
    }
    if (this.positionViews.some(p => p.symbol === symbol)) {
      return { ok: false, symbol, reason: `already have a position on ${symbol}` };
    }
    const tk = this.tickers.get(symbol);
    if (!tk || !tk.markPrice) return { ok: false, symbol, reason: `no ticker for ${symbol}` };

    // Risk caps
    const equity = this.portfolioValue;
    const maxByPct = (equity * this.cfg.maxNotionalPerTradePctOfEquity) / 100;
    const cappedNotional = Math.min(opts.notionalUsd, this.cfg.maxNotionalPerTradeUsd, maxByPct);
    if (cappedNotional < 25) return { ok: false, symbol, reason: `notional too small after caps (${cappedNotional.toFixed(2)})` };

    const leverage = Math.max(1, Math.min(this.cfg.maxLeverage, opts.leverage ?? this.cfg.defaultLeverage));

    // Margin check: required initial margin ≈ notional / leverage. Need < availableMargin.
    const requiredMargin = cappedNotional / leverage;
    if (requiredMargin > this.availableMargin * 0.95) {
      return { ok: false, symbol, reason: `insufficient margin (need ~$${requiredMargin.toFixed(2)}, avail $${this.availableMargin.toFixed(2)})` };
    }

    // Size in contracts. PF_ pairs are linear, contractSize=1, denominated in underlying.
    // size = notional / markPrice. Round to a sensible precision.
    const rawSize = cappedNotional / tk.markPrice;
    const size = roundToTick(rawSize, sizePrecisionFor(symbol));
    if (size <= 0) return { ok: false, symbol, reason: `computed size is zero` };

    const side = opts.side === "BUY" ? "buy" : "sell";

    let result;
    try {
      result = await this.client.sendOrder({
        orderType: "mkt",
        symbol,
        side,
        size,
      });
    } catch (e) {
      return { ok: false, symbol, reason: (e as Error).message };
    }
    if (!result.ok) return { ok: false, symbol, reason: result.reason || result.status || "order rejected" };

    // Record meta for our own tracking
    const fillPrice = result.averagePrice ?? tk.markPrice;
    this.openMeta.set(symbol, {
      symbol,
      pair: opts.pair,
      openedAt: Date.now(),
      entryPrice: fillPrice,
      leverage,
      reasoning: opts.reasoning,
    });
    appendJsonl(FUTURES_TRADES_FILE, {
      kind: "open",
      at: Date.now(),
      symbol,
      pair: opts.pair,
      side,
      size,
      requestedNotionalUsd: opts.notionalUsd,
      cappedNotionalUsd: cappedNotional,
      leverage,
      fillPrice,
      reasoning: opts.reasoning,
      orderId: result.orderId,
    });
    this.emit("trade", { kind: "open", pair: opts.pair, symbol });
    // Trigger an immediate poll to refresh state
    void this.poll().catch(() => undefined);
    return { ok: true, symbol, orderId: result.orderId, fillPrice, size };
  }

  /**
   * Close an open position by symbol (PF_XBTUSD). Sends a reduce-only market
   * order in the opposite direction with the exact open size.
   */
  async closePosition(symbol: string, reason: string): Promise<{ ok: boolean; reason?: string }> {
    const pos = this.openPositions.find(p => p.symbol === symbol);
    if (!pos) return { ok: false, reason: `no position on ${symbol}` };
    const side: "buy" | "sell" = pos.side === "long" ? "sell" : "buy";
    const size = Math.abs(pos.size);
    let result;
    try {
      result = await this.client.sendOrder({
        orderType: "mkt",
        symbol,
        side,
        size,
        reduceOnly: true,
      });
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    if (!result.ok) return { ok: false, reason: result.reason || result.status || "close rejected" };
    // Record the closed trade locally
    const meta = this.openMeta.get(symbol);
    const tk = this.tickers.get(symbol);
    const exitPrice = result.averagePrice ?? tk?.markPrice ?? pos.price;
    const pnlUsd = pos.side === "long"
      ? (exitPrice - pos.price) * Math.abs(pos.size)
      : (pos.price - exitPrice) * Math.abs(pos.size);
    const notional = Math.abs(pos.size) * pos.price;
    const pnlPct = notional > 0 ? (pnlUsd / notional) * 100 : 0;
    const closed: ClosedTrade = {
      id: `fut-${Date.now()}-${symbol}`,
      pair: meta?.pair ?? perpToSpot(symbol) ?? symbol,
      side: pos.side === "long" ? "BUY" : "SELL",
      qty: Math.abs(pos.size),
      entryPrice: pos.price,
      exitPrice,
      openedAt: meta?.openedAt ?? (pos.fillTime ? Date.parse(pos.fillTime) : Date.now()),
      closedAt: Date.now(),
      pnlUsd,
      pnlPct,
      reasonOpen: meta?.reasoning ?? "futures position",
      reasonClose: reason,
      source: "external",
    };
    this.closedTrades.push(closed);
    if (this.closedTrades.length > 500) this.closedTrades.splice(0, this.closedTrades.length - 500);
    this.openMeta.delete(symbol);
    appendJsonl(FUTURES_TRADES_FILE, { kind: "close", at: closed.closedAt, closed, orderId: result.orderId });
    this.emit("trade", { kind: "close", pair: closed.pair, symbol });
    void this.poll().catch(() => undefined);
    return { ok: true };
  }

  async closeAll(reason = "manual flatten"): Promise<{ closed: number; errors: string[] }> {
    const errors: string[] = [];
    let n = 0;
    for (const p of [...this.openPositions]) {
      const r = await this.closePosition(p.symbol, reason);
      if (r.ok) n++; else if (r.reason) errors.push(`${p.symbol}: ${r.reason}`);
    }
    return { closed: n, errors };
  }

  // ─── Public state ────────────────────────────────────────────────────────

  publicState() {
    const dailyPnl = this.portfolioValue - (this.dailyBaselineEquity || this.portfolioValue);
    const dailyPnlPct = this.dailyBaselineEquity > 0 ? (dailyPnl / this.dailyBaselineEquity) * 100 : 0;
    return {
      configured: this.isConfigured(),
      enabled: this.enabled,
      paused: this.paused,
      pauseReason: this.pauseReason,
      killSwitch: this.killSwitch,
      killReason: this.killReason,
      lastPollAt: this.lastPollAt,
      portfolioValue: this.portfolioValue,
      marginEquity: this.marginEquity,
      availableMargin: this.availableMargin,
      initialMargin: this.initialMargin,
      unrealizedPnl: this.unrealizedPnl,
      dailyPnl,
      dailyPnlPct,
      dailyBaselineAt: this.dailyBaselineAt,
      positions: this.positionViews,
      closedCount: this.closedTrades.length,
      cfg: this.cfg,
      lastError: this.lastError,
      perpSymbols: this.perpSymbols,
    };
  }

  recentTrades(limit = 50): ClosedTrade[] {
    return this.closedTrades.slice(-limit).reverse();
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private persistTimer: NodeJS.Timeout | null = null;
  private persistThrottled(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persist(); }, 10_000);
  }
  private persist(): void {
    try {
      writeJson(FUTURES_STATE_FILE, {
        openMeta: Array.from(this.openMeta.entries()),
        closedTrades: this.closedTrades.slice(-200),
        equityCurve: this.equityCurve.slice(-500),
        dailyBaselineEquity: this.dailyBaselineEquity,
        dailyBaselineAt: this.dailyBaselineAt,
        cfg: this.cfg,
        enabled: this.enabled,
        paused: this.paused,
      });
    } catch (e) {
      console.warn("[futures] persist failed:", (e as Error).message);
    }
  }
}

// ─── Sizing helpers ─────────────────────────────────────────────────────────

/** Per-symbol size precision (decimals of contract qty). PF_ perps generally
 * accept up to 4 decimals; very high-priced symbols can do more. */
function sizePrecisionFor(symbol: string): number {
  if (/PF_(XBT|ETH)USD/.test(symbol)) return 4;
  if (/PF_(SOL|LINK|AVAX|XRP|DOGE|ADA|DOT|ATOM|LTC|BCH)USD/.test(symbol)) return 2;
  return 4;
}

function roundToTick(x: number, decimals: number): number {
  const p = Math.pow(10, decimals);
  return Math.floor(x * p) / p;
}
