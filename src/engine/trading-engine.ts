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
import { AICallBudget, BudgetReason } from "./budget";
import { NewsFeed } from "./news-feed";
import { PrismSignals, prismToAction, PrismSignalEntry } from "./prism-signals";
import { evaluateSession, SessionState } from "./time-filter";
import { AIStrategist, StrategistBriefing, StrategistDecision, StrategistResult } from "./ai-strategist";
import { OnchainCheckpointer } from "./onchain-checkpoint";
import { appendJsonl, dataPath, statePath, readJson, writeJson } from "./persistence";

const TRADES_FILE = dataPath("trades.jsonl");
const SIGNALS_FILE = dataPath("signals.jsonl");
const AI_LOG_FILE = dataPath("ai-decisions.jsonl");
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
  ai: AIStrategist;
  news: NewsFeed;
  prismSignals: PrismSignals;
  onchain: OnchainCheckpointer;

  private candles = new Map<string, PairCandle[]>();
  private ticks = new Map<string, Tick>();
  private scanner = new Map<string, ScannerRow>();
  private cooldownUntil = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private syntheticMode = false;
  private lastTickAt = 0;
  private startedAt = 0;

  // AI / regime tracking
  private session: SessionState = evaluateSession();
  private lastPeriodicAiAt = 0;
  private periodicAiMs = 50 * 60 * 1000;        // ~28-30 calls/day baseline
  private lastEmergencyAiAt = 0;
  private emergencyCooldownMs = 15 * 60 * 1000;
  private emergencyDdTriggerPct = 5;            // %
  private emergencyLossPerPositionPct = 4;      // % of equity
  private aiInflight = false;
  private lastDecision: StrategistDecision | null = null;
  private lastAlert: { ts: number; text: string } | null = null;
  private newsCheckTimer: NodeJS.Timeout | null = null;

  // Prism signals
  private prismRefreshTimer: NodeJS.Timeout | null = null;
  private prismRefreshMs = 10 * 60 * 1000;     // refresh every 10 min
  private prismSignalTtlMs = 12 * 60 * 1000;   // bus signals expire after 12 min
  private prismInflight = false;

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

    const budget = new AICallBudget({
      dailyMax: Number(process.env.AI_DAILY_MAX) || 30,
    });
    this.news = new NewsFeed(process.env.PRISM_API_KEY);
    this.prismSignals = new PrismSignals(process.env.PRISM_API_KEY);
    this.ai = new AIStrategist({
      budget,
      news: this.news,
      mistralKey: process.env.MISTRAL_API_KEY,
      nvidiaKey: process.env.NVIDIA_API_KEY,
      model: process.env.MISTRAL_MODEL || "mistral-large-latest",
    });
    this.onchain = new OnchainCheckpointer(process.env.SEPOLIA_RPC_URL, process.env.SEPOLIA_PRIVATE_KEY);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    void this.warmup().then(() => {
      this.scheduleNext();
      // Background news refresh every 30 min (cached internally)
      this.newsCheckTimer = setInterval(() => { void this.news.get().catch(() => undefined); }, 30 * 60_000);
      void this.news.get().catch(() => undefined);
      // Background Prism signals refresh + bus injection
      this.prismRefreshTimer = setInterval(() => { void this.refreshPrismSignals().catch(() => undefined); }, this.prismRefreshMs);
      void this.refreshPrismSignals().catch(() => undefined);
    });
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.newsCheckTimer) clearInterval(this.newsCheckTimer);
    this.newsCheckTimer = null;
    if (this.prismRefreshTimer) clearInterval(this.prismRefreshTimer);
    this.prismRefreshTimer = null;
    this.persist();
  }

  /**
   * Pull latest signals from Prism for our watchlist and republish them on
   * the signal bus as `source: "prism"`. Throttled by Prism's free tier
   * (1 QPS, 10 RPM) inside the PrismSignals class.
   */
  async refreshPrismSignals(force = false): Promise<{ entries: PrismSignalEntry[]; published: number }> {
    if (!this.prismSignals.isConfigured()) return { entries: [], published: 0 };
    if (this.prismInflight) return { entries: this.prismSignals.cached()?.entries ?? [], published: 0 };
    this.prismInflight = true;
    try {
      const snap = await this.prismSignals.get(this.cfg.watchlist, force);
      let published = 0;
      for (const e of snap.entries) {
        const { action, confidence } = prismToAction(e);
        if (action === "HOLD") continue;
        const reasons = e.activeSignals.length
          ? e.activeSignals.map(s => `${s.type}:${s.signal}`).join(", ")
          : `score ${e.netScore >= 0 ? "+" : ""}${e.netScore}`;
        this.submitSignal({
          source: "prism",
          origin: "prismapi",
          pair: e.pair,
          action,
          confidence,
          reasoning: `Prism ${e.overall} (${e.strength}) — ${reasons}`,
          ttlMs: this.prismSignalTtlMs,
        });
        published++;
      }
      return { entries: snap.entries, published };
    } finally {
      this.prismInflight = false;
    }
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
      session: this.session,
      ai: this.ai.publicStatus(),
      news: this.news.cached() ? {
        fetchedAt: this.news.cached()!.fetchedAt,
        articles: this.news.cached()!.articles.slice(0, 12),
        sentiment: this.news.cached()!.sentiment,
      } : null,
      prism: this.prismSignals.cached() ? {
        fetchedAt: this.prismSignals.cached()!.fetchedAt,
        cacheUntil: this.prismSignals.cached()!.cacheUntil,
        entries: this.prismSignals.cached()!.entries,
        errors: this.prismSignals.cached()!.errors,
        degraded: this.prismSignals.cached()!.degraded,
      } : null,
      onchain: this.onchain.publicState(),
      lastAlert: this.lastAlert,
      lastDecision: this.lastDecision,
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

  // ─── AI strategist controls ────────────────────────────────────────────────

  async runAI(reason: BudgetReason = "manual"): Promise<StrategistResult> {
    if (this.aiInflight) {
      return { ok: false, reason, ts: Date.now(), error: "AI call already in flight" };
    }
    this.aiInflight = true;
    try {
      const briefing = await this.buildBriefing(reason);
      const result = await this.ai.run(reason, briefing);
      if (result.ok && result.decision) {
        this.applyDecision(result.decision, reason);
        try { appendJsonl(AI_LOG_FILE, { at: result.ts, reason, decision: result.decision, model: result.model, latencyMs: result.latencyMs }); } catch { /* ignore */ }
      }
      return result;
    } finally {
      this.aiInflight = false;
    }
  }

  private async buildBriefing(reason: BudgetReason): Promise<StrategistBriefing> {
    const equity = this.portfolio.equity(this.ticks);
    const exposureUsd = this.portfolio.positionsValue(this.ticks);
    const risk = this.risk.updateState({ equity, cash: this.portfolio.cash, exposureUsd });
    const perf = this.portfolio.performance();
    const open = this.openPositionsView().map(p => ({
      pair: p.pair, side: p.side, qty: p.qty,
      entryPrice: p.entryPrice, currentPrice: p.currentPrice,
      unrealizedPnl: p.unrealizedPnl, unrealizedPnlPct: p.unrealizedPnlPct,
      holdMinutes: (Date.now() - p.openedAt) / 60_000,
      stopPrice: p.stopPrice, takeProfit: p.takeProfit,
    }));
    const recentClosed = this.portfolio.closed.slice(-15).map(c => ({
      pair: c.pair, side: c.side, pnlUsd: c.pnlUsd, pnlPct: c.pnlPct,
      reasonClose: c.reasonClose,
      holdMinutes: (c.closedAt - c.openedAt) / 60_000,
    }));
    const newsSnap = await this.news.get().catch(() => null);
    const news = {
      headlines: newsSnap?.articles.slice(0, 12).map(a => `${a.title}${a.source ? ` (${a.source})` : ""}`) ?? [],
      fearGreed: newsSnap?.sentiment.fearGreed?.value ?? null,
      fearGreedLabel: newsSnap?.sentiment.fearGreed?.label ?? null,
      trending: newsSnap?.sentiment.trending?.map(t => t.symbol) ?? [],
    };
    // Include Prism's vendor signals so the AI can corroborate or argue against them.
    const prismCached = this.prismSignals.cached();
    const prism = prismCached ? prismCached.entries.map(e => ({
      pair: e.pair, signal: e.overall, strength: e.strength,
      net: e.netScore, rsi: e.indicators.rsi, macdHist: e.indicators.macdHistogram,
      reasons: e.activeSignals.map(s => `${s.type}:${s.signal}`),
    })) : [];
    return {
      ts: Date.now(),
      session: this.session,
      portfolio: {
        equity, cash: this.portfolio.cash,
        realizedPnl: this.portfolio.realizedPnl,
        unrealizedPnl: this.portfolio.unrealizedPnl(this.ticks),
        feesPaid: this.portfolio.feesPaid,
        closedCount: perf.closedCount,
        winRate: perf.winRate,
        profitFactor: isFinite(perf.profitFactor) ? perf.profitFactor : 0,
        sharpe: perf.sharpe,
        maxDrawdownPct: perf.maxDrawdownPct,
      },
      risk,
      cfg: this.cfg,
      open,
      scanner: this.scannerView(),
      recentClosed,
      news,
      prism,
    };
  }

  private applyDecision(d: StrategistDecision, reason: BudgetReason): void {
    this.lastDecision = d;
    if (d.alert) this.lastAlert = { ts: Date.now(), text: d.alert };

    if (d.pause && !this.risk.state.paused) {
      this.pause("AI: " + (d.alert ?? d.thesis ?? "regime change"));
    } else if (d.resume && this.risk.state.paused) {
      this.resume();
    }

    if (d.configPatch && Object.keys(d.configPatch).length) {
      this.cfg = { ...this.cfg, ...d.configPatch };
    }

    // Force-exit positions the AI flagged. high urgency = immediate close.
    for (const ex of d.exits) {
      const pos = this.portfolio.open.find(p => p.pair === ex.pair);
      if (!pos) continue;
      const tk = this.ticks.get(pos.pair);
      if (!tk) continue;
      if (ex.urgency === "high") {
        this.closePosition(pos, tk, `AI exit (${ex.urgency}): ${ex.reason}`);
      } else {
        // For low/med urgency, tighten the stop aggressively instead of
        // closing immediately — gives the position a chance if it recovers.
        const ref = pos.side === "BUY" ? tk.bid : tk.ask;
        const tighten = ex.urgency === "med" ? 0.4 : 0.8;     // % away
        if (pos.side === "BUY") {
          const candidate = ref * (1 - tighten / 100);
          pos.stopPrice = Math.max(pos.stopPrice, candidate);
        } else {
          const candidate = ref * (1 + tighten / 100);
          pos.stopPrice = Math.min(pos.stopPrice, candidate);
        }
      }
    }

    // Inject AI-published signals as weighted entries on the bus.
    for (const s of d.signals) {
      if (s.action === "HOLD") continue;
      this.submitSignal({
        source: "llm",
        origin: "ai-strategist",
        pair: s.pair,
        action: s.action,
        confidence: s.confidence,
        reasoning: `[${d.regime}] ${s.reasoning}`,
        ttlMs: 20 * 60_000,
        weight: 1.2,
      });
    }
    this.persist();
  }

  setAIBudget(dailyMax: number) {
    this.ai.budget.cfg.dailyMax = Math.max(1, Math.min(500, Math.floor(dailyMax)));
    (this.ai.budget as any).persist?.();
  }

  // ─── On-chain checkpointing controls ───────────────────────────────────────

  setOnchainEnabled(on: boolean) { this.onchain.setEnabled(on); }
  setOnchainIntervalMs(ms: number) { this.onchain.setIntervalMs(ms); }
  async writeOnchainCheckpoint() {
    return this.onchain.writeCheckpoint({
      equity: this.portfolio.equity(this.ticks),
      trades: this.portfolio.closed.length,
      positions: this.portfolio.open.length,
      extra: { ts: Date.now() },
    });
  }

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
    const risk = this.risk.updateState({ equity, cash: this.portfolio.cash, exposureUsd: this.portfolio.positionsValue(this.ticks) });

    // 4) refresh session info
    this.session = evaluateSession();

    // 5) AI strategist triggers (rate-limited and budgeted)
    void this.maybeTriggerAI(risk).catch(e => console.warn("[engine] ai trigger:", e));

    // 6) on-chain checkpoint (opt-in, every N hours)
    if (this.onchain.shouldCheckpoint()) {
      void this.writeOnchainCheckpoint().catch(e => console.warn("[engine] onchain:", e));
    }

    this.persistThrottled();
    this.emit("tick", { ts });
  }

  /**
   * Decide whether to spend an AI call this tick. Three triggers:
   *   1. Periodic   — at most once per `periodicAiMs` (default 50 min)
   *   2. Drawdown   — current drawdown crosses threshold and we haven't
   *                   asked the AI in `emergencyCooldownMs`
   *   3. Position   — any open position is more than `emergencyLossPerPositionPct`
   *                   underwater relative to equity (a real loser)
   */
  private async maybeTriggerAI(risk: { drawdownPct: number; killSwitch: boolean; paused: boolean }): Promise<void> {
    if (!this.ai.isConfigured()) return;
    if (this.aiInflight) return;
    const now = Date.now();
    const equity = this.portfolio.equity(this.ticks);

    // Emergency: drawdown crossed
    if (!risk.killSwitch && risk.drawdownPct >= this.emergencyDdTriggerPct
        && now - this.lastEmergencyAiAt > this.emergencyCooldownMs) {
      this.lastEmergencyAiAt = now;
      await this.runAI("emergency");
      return;
    }

    // Emergency: a single position is bleeding badly
    for (const p of this.openPositionsView()) {
      const lossPctEquity = equity > 0 ? -Math.min(0, p.unrealizedPnl) / equity * 100 : 0;
      if (lossPctEquity >= this.emergencyLossPerPositionPct
          && now - this.lastEmergencyAiAt > this.emergencyCooldownMs) {
        this.lastEmergencyAiAt = now;
        await this.runAI("event");
        return;
      }
    }

    // Periodic
    if (now - this.lastPeriodicAiAt >= this.periodicAiMs) {
      this.lastPeriodicAiAt = now;
      await this.runAI("periodic");
    }
  }

  private async evaluatePair(pair: string): Promise<void> {
    if (this.risk.state.killSwitch || this.risk.state.paused) return;
    if (this.portfolio.open.some(p => p.pair === pair)) return; // managed elsewhere
    if (!this.session.allowEntries) return;                     // time-of-day filter
    const decision = this.bus.aggregate(pair);
    if (decision.action === "HOLD") return;
    const tk = this.ticks.get(pair);
    if (!tk) return;
    const cs = this.candles.get(pair);
    const atr = cs ? scoreMarket(cs).indicators.atr : null;
    const exposureByPair = this.portfolio.exposureByPair(this.ticks);
    // Apply session sizing multiplier by adjusting confidence (which feeds risk budget)
    const sessionAdjConf = Math.max(0.1, Math.min(1, decision.confidence * (this.session.sizingMultiplier ?? 1)));
    const sizing = this.risk.evaluateEntry({
      side: decision.action,
      pair,
      tick: tk,
      atr,
      confidence: sessionAdjConf,
      cashUsd: this.portfolio.cash,
      equityUsd: this.portfolio.equity(this.ticks),
      exposureByPair,
      openPositions: this.portfolio.open,
      cooldownUntil: this.cooldownUntil,
    });
    if (!sizing.ok || !sizing.qty || !sizing.notionalUsd) return;
    this.openPosition(decision.action, pair, tk, sizing.qty!, sizing.stopPrice!, sizing.takeProfit!,
      `${decision.reasoning} | session ${this.session.session}`,
      decision.contributing[0]?.source ?? "technical");
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
