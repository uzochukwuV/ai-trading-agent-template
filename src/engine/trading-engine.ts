/**
 * Trading Engine — orchestrates the loop:
 *   1. Fetch market data for all watchlist pairs
 *   2. Compute indicators + technical signals
 *   3. Mix in external/manual signals via the SignalBus
 *   4. Manage open positions (trailing stops, stop-loss, take-profit)
 *   5. Open new positions through the RiskManager + PaperBroker
 *   6. Snapshot equity, persist trades, expose state to the API
 */

import { EventEmitter } from "events";
import {
  EngineConfig, Tick, PairCandle, Signal, ScannerRow, Position, Action,
} from "./types";
import { fetchTickers, fetchOHLC, generateSyntheticTick, generateSyntheticCandles } from "./market-data";
import { scoreMarket, buildTechnicalSignal } from "./strategy";
import { SignalBus } from "./signal-bus";
import { RiskManager } from "./risk-manager";
import { PaperBroker } from "./paper-broker";
import { Portfolio } from "./portfolio";
import { appendJsonl, dataPath, statePath, readJson, writeJson } from "./persistence";

const TRADES_FILE = dataPath("trades.jsonl");
const SIGNALS_FILE = dataPath("signals.jsonl");
const ENGINE_STATE_FILE = statePath("engine-state.json");

export interface EngineEvents {
  tick: { ts: number };
  decision: { pair: string; action: Action };
  trade: { kind: "open" | "close"; pair: string };
  signal: Signal;
}

export class TradingEngine extends EventEmitter {
  cfg: EngineConfig;
  bus = new SignalBus();
  portfolio: Portfolio;
  risk: RiskManager;
  broker: PaperBroker;

  private candles = new Map<string, PairCandle[]>();
  private ticks = new Map<string, Tick>();
  private scanner = new Map<string, ScannerRow>();
  private cooldownUntil = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private syntheticMode = false;
  private lastTickAt = 0;
  private startedAt = 0;

  constructor(cfg: EngineConfig) {
    super();
    this.cfg = cfg;
    const persisted = readJson<{ portfolio?: any; cooldown?: Record<string, number>; cfg?: Partial<EngineConfig> }>(ENGINE_STATE_FILE, {});
    if (persisted.cfg) this.cfg = { ...this.cfg, ...persisted.cfg };
    this.portfolio = new Portfolio(this.cfg.startingCashUsd);
    if (persisted.portfolio) {
      this.portfolio.cash = persisted.portfolio.cash ?? this.portfolio.cash;
      this.portfolio.realizedPnl = persisted.portfolio.realizedPnl ?? 0;
      this.portfolio.feesPaid = persisted.portfolio.feesPaid ?? 0;
      this.portfolio.open = persisted.portfolio.open ?? [];
      this.portfolio.closed = persisted.portfolio.closed ?? [];
      this.portfolio.equityCurve = persisted.portfolio.equityCurve ?? [];
    }
    if (persisted.cooldown) {
      for (const [k, v] of Object.entries(persisted.cooldown)) this.cooldownUntil.set(k, v);
    }
    this.risk = new RiskManager(this.cfg, this.portfolio.equity(this.ticks) || this.cfg.startingCashUsd);
    this.broker = new PaperBroker(this.cfg);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    void this.warmup().then(() => {
      this.scheduleNext();
    });
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
      this.tick().catch(e => console.error("[engine] tick error:", e)).finally(() => this.scheduleNext());
    }, this.cfg.pollIntervalMs);
  }

  // ─── Public state accessors ────────────────────────────────────────────────

  snapshot() {
    const equity = this.portfolio.equity(this.ticks);
    const exposureUsd = this.portfolio.positionsValue(this.ticks);
    const riskState = this.risk.updateState({ equity, cash: this.portfolio.cash, exposureUsd });
    return {
      runningSince: this.startedAt,
      lastTickAt: this.lastTickAt,
      syntheticMode: this.syntheticMode,
      cfg: this.cfg,
      cash: this.portfolio.cash,
      equity,
      positionsValue: exposureUsd,
      realizedPnl: this.portfolio.realizedPnl,
      unrealizedPnl: this.portfolio.unrealizedPnl(this.ticks),
      feesPaid: this.portfolio.feesPaid,
      open: this.openPositionsView(),
      closedCount: this.portfolio.closed.length,
      risk: riskState,
      performance: this.portfolio.performance(),
      ticksTracked: this.ticks.size,
      cooldownUntil: Object.fromEntries(this.cooldownUntil),
    };
  }

  openPositionsView() {
    return this.portfolio.open.map(p => {
      const tk = this.ticks.get(p.pair);
      const px = tk ? (p.side === "BUY" ? tk.bid : tk.ask) : p.entryPrice;
      const upnl = p.side === "BUY" ? (px - p.entryPrice) * p.qty : (p.entryPrice - px) * p.qty;
      const pct = p.entryPrice > 0 ? (upnl / (p.entryPrice * p.qty)) * 100 : 0;
      return { ...p, currentPrice: px, unrealizedPnl: upnl, unrealizedPnlPct: pct };
    });
  }

  scannerView(): ScannerRow[] {
    return Array.from(this.scanner.values()).sort((a, b) => Math.abs(b.score - 0.5) - Math.abs(a.score - 0.5));
  }

  recentTrades(limit = 50) {
    return this.portfolio.closed.slice(-limit).reverse();
  }

  equityCurve() {
    return this.portfolio.equityCurve;
  }

  // ─── External signal ingestion ─────────────────────────────────────────────

  submitSignal(s: Omit<Signal, "id" | "createdAt"> & { id?: string; createdAt?: number }): Signal {
    const sig = this.bus.publish({
      ...s,
      id: s.id ?? `${s.source}-${s.pair}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: s.createdAt ?? Date.now(),
    } as Signal);
    appendJsonl(SIGNALS_FILE, sig);
    this.emit("signal", sig);
    // If the signal is decisive enough we evaluate immediately for that pair.
    if (sig.action !== "HOLD" && sig.confidence >= 0.4) {
      void this.evaluatePair(sig.pair).catch(() => undefined);
    }
    return sig;
  }

  recentSignals(limit = 100, pair?: string) {
    return this.bus.recent(limit, pair);
  }

  // ─── Risk controls ─────────────────────────────────────────────────────────

  pause(reason?: string) { this.risk.pause(reason); this.persist(); }
  resume() { this.risk.resume(); this.persist(); }

  closeAll(reason = "manual flatten"): number {
    let n = 0;
    for (const p of [...this.portfolio.open]) {
      const tk = this.ticks.get(p.pair);
      if (!tk) continue;
      this.closePosition(p, tk, reason);
      n++;
    }
    this.persist();
    return n;
  }

  // ─── Inner loop ────────────────────────────────────────────────────────────

  private async warmup(): Promise<void> {
    // Pre-load OHLC for indicator calculations
    await Promise.all(this.cfg.watchlist.map(async pair => {
      let candles = await fetchOHLC(pair, 5);
      if (!candles.length) {
        this.syntheticMode = true;
        candles = generateSyntheticCandles(pair, 100);
      }
      this.candles.set(pair, candles);
    }));
    await this.tick();
  }

  private async tick(): Promise<void> {
    const ts = Date.now();
    this.lastTickAt = ts;
    let tickers = await fetchTickers(this.cfg.watchlist);
    if (tickers.size === 0) {
      this.syntheticMode = true;
      tickers = new Map(this.cfg.watchlist.map(p => [p, generateSyntheticTick(p)]));
    } else if (tickers.size < this.cfg.watchlist.length) {
      // Fill missing ones with synthetic to keep the dashboard alive
      for (const p of this.cfg.watchlist) if (!tickers.has(p)) tickers.set(p, generateSyntheticTick(p));
    }
    for (const [k, v] of tickers) this.ticks.set(k, v);

    // Update / extend candles using the latest tick (cheap incremental update)
    for (const pair of this.cfg.watchlist) {
      const tk = tickers.get(pair);
      if (!tk) continue;
      const cs = this.candles.get(pair) ?? [];
      const last = cs[cs.length - 1];
      const bucket = Math.floor(ts / (5 * 60_000)) * (5 * 60_000);
      if (!last || last.t !== bucket) {
        const o = last ? last.c : tk.price;
        cs.push({ t: bucket, o, h: Math.max(o, tk.price), l: Math.min(o, tk.price), c: tk.price, v: 0 });
        if (cs.length > 200) cs.splice(0, cs.length - 200);
      } else {
        last.c = tk.price;
        last.h = Math.max(last.h, tk.price);
        last.l = Math.min(last.l, tk.price);
      }
      this.candles.set(pair, cs);
    }

    // 1) manage existing positions for stops
    for (const p of [...this.portfolio.open]) {
      const tk = tickers.get(p.pair);
      if (!tk) continue;
      this.managePosition(p, tk);
    }

    // 2) compute indicators, score, push technical signals, populate scanner
    for (const pair of this.cfg.watchlist) {
      const cs = this.candles.get(pair) ?? [];
      const analysis = scoreMarket(cs, this.cfg.buyThreshold, this.cfg.sellThreshold);
      const tk = tickers.get(pair);
      const change = cs.length > 1 ? ((cs[cs.length - 1].c - cs[0].c) / cs[0].c) * 100 : 0;
      this.scanner.set(pair, {
        pair,
        price: tk?.price ?? cs[cs.length - 1]?.c ?? 0,
        changePct24h: change,
        rsi: analysis.indicators.rsi,
        macdHist: analysis.indicators.macdHist,
        trend: analysis.indicators.trend,
        score: analysis.score,
        action: analysis.action,
        updatedAt: ts,
      });
      const sig = buildTechnicalSignal(pair, analysis);
      if (sig) {
        this.bus.publish(sig);
        this.emit("signal", sig);
      }
      await this.evaluatePair(pair);
    }

    // 3) snapshot equity + risk state
    this.portfolio.recordEquity(this.ticks);
    const equity = this.portfolio.equity(this.ticks);
    this.risk.updateState({ equity, cash: this.portfolio.cash, exposureUsd: this.portfolio.positionsValue(this.ticks) });
    this.persistThrottled();
    this.emit("tick", { ts });
  }

  private async evaluatePair(pair: string): Promise<void> {
    if (this.risk.state.killSwitch || this.risk.state.paused) return;
    if (this.portfolio.open.some(p => p.pair === pair)) return; // managed elsewhere
    const decision = this.bus.aggregate(pair);
    if (decision.action === "HOLD") return;
    const tk = this.ticks.get(pair);
    if (!tk) return;
    const cs = this.candles.get(pair);
    const atr = cs ? scoreMarket(cs).indicators.atr : null;
    const exposureByPair = this.portfolio.exposureByPair(this.ticks);
    const sizing = this.risk.evaluateEntry({
      side: decision.action,
      pair,
      tick: tk,
      atr,
      confidence: decision.confidence,
      cashUsd: this.portfolio.cash,
      equityUsd: this.portfolio.equity(this.ticks),
      exposureByPair,
      openPositions: this.portfolio.open,
      cooldownUntil: this.cooldownUntil,
    });
    if (!sizing.ok || !sizing.qty || !sizing.notionalUsd) return;
    this.openPosition(decision.action, pair, tk, sizing.qty!, sizing.stopPrice!, sizing.takeProfit!, decision.reasoning, decision.contributing[0]?.source ?? "technical");
  }

  private openPosition(side: Action, pair: string, tick: Tick, qty: number, stop: number, tp: number, reasoning: string, source: any) {
    if (side === "HOLD") return;
    const { position, fillPrice, feeUsd } = this.broker.open({
      side: side as "BUY" | "SELL",
      pair, qty, tick,
      stopPrice: stop, takeProfit: tp,
      reasoning, source,
    });
    const fillNotional = fillPrice * qty;
    this.portfolio.applyOpen(position, fillNotional, feeUsd);
    appendJsonl(TRADES_FILE, { kind: "open", at: position.openedAt, pos: position, fillPrice, feeUsd });
    this.emit("trade", { kind: "open", pair });
  }

  private managePosition(pos: Position, tk: Tick): void {
    const refPrice = pos.side === "BUY" ? tk.bid : tk.ask;
    if (pos.side === "BUY") {
      if (!pos.highWaterPrice || refPrice > pos.highWaterPrice) pos.highWaterPrice = refPrice;
      const unrealizedPct = ((refPrice - pos.entryPrice) / pos.entryPrice) * 100;
      if (unrealizedPct >= this.cfg.trailingActivatePct) {
        const candidate = (pos.highWaterPrice ?? refPrice) * (1 - this.cfg.trailingDistancePct / 100);
        pos.trailingStop = pos.trailingStop ? Math.max(pos.trailingStop, candidate) : candidate;
      }
      if (refPrice <= pos.stopPrice) return this.closePosition(pos, tk, `stop-loss @ ${refPrice.toFixed(4)}`);
      if (pos.trailingStop && refPrice <= pos.trailingStop) return this.closePosition(pos, tk, `trailing-stop @ ${refPrice.toFixed(4)}`);
      if (refPrice >= pos.takeProfit) return this.closePosition(pos, tk, `take-profit @ ${refPrice.toFixed(4)}`);
    } else {
      if (!pos.highWaterPrice || refPrice < pos.highWaterPrice) pos.highWaterPrice = refPrice;
      const unrealizedPct = ((pos.entryPrice - refPrice) / pos.entryPrice) * 100;
      if (unrealizedPct >= this.cfg.trailingActivatePct) {
        const candidate = (pos.highWaterPrice ?? refPrice) * (1 + this.cfg.trailingDistancePct / 100);
        pos.trailingStop = pos.trailingStop ? Math.min(pos.trailingStop, candidate) : candidate;
      }
      if (refPrice >= pos.stopPrice) return this.closePosition(pos, tk, `stop-loss @ ${refPrice.toFixed(4)}`);
      if (pos.trailingStop && refPrice >= pos.trailingStop) return this.closePosition(pos, tk, `trailing-stop @ ${refPrice.toFixed(4)}`);
      if (refPrice <= pos.takeProfit) return this.closePosition(pos, tk, `take-profit @ ${refPrice.toFixed(4)}`);
    }
  }

  private closePosition(pos: Position, tk: Tick, reason: string): void {
    const { closed, fillPrice, feeUsd } = this.broker.close(pos, tk, reason);
    const fillNotional = fillPrice * pos.qty;
    this.portfolio.applyClose(pos, closed, fillNotional, feeUsd);
    this.cooldownUntil.set(pos.pair, Date.now() + this.cfg.cooldownMs);
    appendJsonl(TRADES_FILE, { kind: "close", at: closed.closedAt, closed, fillPrice, feeUsd });
    this.emit("trade", { kind: "close", pair: pos.pair });
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  private persistTimer: NodeJS.Timeout | null = null;
  private persistThrottled(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persist(); }, 10_000);
  }
  private persist(): void {
    try {
      writeJson(ENGINE_STATE_FILE, {
        cfg: this.cfg,
        cooldown: Object.fromEntries(this.cooldownUntil),
        portfolio: {
          cash: this.portfolio.cash,
          realizedPnl: this.portfolio.realizedPnl,
          feesPaid: this.portfolio.feesPaid,
          open: this.portfolio.open,
          closed: this.portfolio.closed.slice(-200),
          equityCurve: this.portfolio.equityCurve,
        },
      });
    } catch (e) {
      console.warn("[engine] persist failed:", (e as Error).message);
    }
  }

  // ─── Config tuning ─────────────────────────────────────────────────────────

  updateConfig(patch: Partial<EngineConfig>): EngineConfig {
    this.cfg = { ...this.cfg, ...patch };
    this.persist();
    return this.cfg;
  }
}

export const DEFAULT_CONFIG: EngineConfig = {
  watchlist: ["XBTUSD", "ETHUSD", "SOLUSD", "XRPUSD", "ADAUSD", "DOGEUSD", "AVAXUSD", "LINKUSD"],
  pollIntervalMs: 15_000,
  startingCashUsd: 10_000,
  maxPositions: 4,
  maxNotionalPerTradePct: 25,
  maxNotionalPerPairPct: 35,
  minNotionalPerTradeUsd: 25,
  riskPerTradePct: 1.0,
  dailyLossLimitPct: 5.0,
  maxDrawdownPct: 15.0,
  takerFeeBps: 26,
  slippageBps: 5,
  buyThreshold: 0.58,
  sellThreshold: 0.42,
  cooldownMs: 90_000,
  trailingActivatePct: 1.5,
  trailingDistancePct: 1.0,
};
