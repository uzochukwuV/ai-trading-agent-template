/**
 * Risk Manager — pre-trade gate, sizing, stops, kill-switch, daily limits.
 */

import { EngineConfig, Position, RiskState, Side, Tick } from "./types";

export interface SizingResult {
  ok: boolean;
  reason?: string;
  qty?: number;
  notionalUsd?: number;
  stopPrice?: number;
  takeProfit?: number;
}

export interface RiskGateInput {
  side: Side;
  pair: string;
  tick: Tick;
  atr: number | null;
  confidence: number;          // 0..1
  cashUsd: number;
  equityUsd: number;
  exposureByPair: Map<string, number>;
  openPositions: Position[];
  cooldownUntil: Map<string, number>;
}

export class RiskManager {
  state: RiskState;
  private equityHigh: number;
  private startOfDayEquity: number;

  constructor(private cfg: EngineConfig, startingEquity: number) {
    this.equityHigh = startingEquity;
    this.startOfDayEquity = startingEquity;
    this.state = {
      killSwitch: false,
      paused: false,
      dailyPnl: 0,
      dailyPnlPct: 0,
      drawdownPct: 0,
      exposureUsd: 0,
      exposurePct: 0,
      freeCashUsd: startingEquity,
      resetsAt: nextDailyReset(),
    };
  }

  updateState(opts: {
    equity: number;
    cash: number;
    exposureUsd: number;
  }): RiskState {
    if (opts.equity > this.equityHigh) this.equityHigh = opts.equity;
    if (Date.now() >= this.state.resetsAt) {
      this.startOfDayEquity = opts.equity;
      this.state.resetsAt = nextDailyReset();
    }
    const dailyPnl = opts.equity - this.startOfDayEquity;
    const dailyPnlPct = this.startOfDayEquity > 0 ? (dailyPnl / this.startOfDayEquity) * 100 : 0;
    const drawdownPct = this.equityHigh > 0 ? ((this.equityHigh - opts.equity) / this.equityHigh) * 100 : 0;

    // Kill-switch evaluation (only auto-trip; manual reset clears)
    if (!this.state.killSwitch) {
      if (dailyPnlPct <= -this.cfg.dailyLossLimitPct) {
        this.state.killSwitch = true;
        this.state.killReason = `Daily loss limit hit (${dailyPnlPct.toFixed(2)}%)`;
      } else if (drawdownPct >= this.cfg.maxDrawdownPct) {
        this.state.killSwitch = true;
        this.state.killReason = `Max drawdown hit (${drawdownPct.toFixed(2)}%)`;
      }
    }

    this.state.dailyPnl = dailyPnl;
    this.state.dailyPnlPct = dailyPnlPct;
    this.state.drawdownPct = drawdownPct;
    this.state.exposureUsd = opts.exposureUsd;
    this.state.exposurePct = opts.equity > 0 ? (opts.exposureUsd / opts.equity) * 100 : 0;
    this.state.freeCashUsd = opts.cash;
    return { ...this.state };
  }

  pause(reason = "Manual pause"): void {
    this.state.paused = true;
    this.state.killReason = reason;
  }
  resume(): void {
    this.state.paused = false;
    this.state.killSwitch = false;
    this.state.killReason = undefined;
  }

  /**
   * Decide whether a new trade is allowed and how big it should be.
   * Position size combines fixed-fractional risk (per-trade %) and an
   * ATR-derived stop, capped by per-trade and per-pair notional ceilings.
   */
  evaluateEntry(input: RiskGateInput): SizingResult {
    const cfg = this.cfg;
    if (this.state.killSwitch) return { ok: false, reason: `Kill switch on: ${this.state.killReason ?? ""}` };
    if (this.state.paused) return { ok: false, reason: "Trading paused" };

    if (input.openPositions.length >= cfg.maxPositions) {
      return { ok: false, reason: `Max positions reached (${cfg.maxPositions})` };
    }
    const cd = input.cooldownUntil.get(input.pair) ?? 0;
    if (cd > Date.now()) {
      return { ok: false, reason: `Pair cooling down for ${(Math.round((cd - Date.now()) / 1000))}s` };
    }
    if (input.openPositions.some(p => p.pair === input.pair)) {
      return { ok: false, reason: "Already holding this pair" };
    }

    const equity = input.equityUsd;
    const refPrice = input.side === "BUY" ? input.tick.ask : input.tick.bid;
    if (!refPrice || refPrice <= 0) return { ok: false, reason: "Invalid price" };

    // ATR-based stop (fall back to fixed %)
    const atrStopMult = 2.5;
    const atrPct = input.atr && refPrice ? (input.atr / refPrice) * 100 : null;
    const stopPct = atrPct ? Math.min(8, Math.max(0.6, atrPct * atrStopMult)) : 1.5;
    const stopPrice = input.side === "BUY"
      ? refPrice * (1 - stopPct / 100)
      : refPrice * (1 + stopPct / 100);
    const tpPrice = input.side === "BUY"
      ? refPrice * (1 + (stopPct * 1.8) / 100)
      : refPrice * (1 - (stopPct * 1.8) / 100);

    // Risk-based sizing: how much $ are we willing to lose if stop hits?
    const riskBudgetUsd = (cfg.riskPerTradePct / 100) * equity * Math.max(0.4, input.confidence);
    const riskPerUnit = Math.abs(refPrice - stopPrice);
    let qty = riskPerUnit > 0 ? riskBudgetUsd / riskPerUnit : 0;
    let notional = qty * refPrice;

    // Per-trade and per-pair notional caps
    const maxTradeNotional = (cfg.maxNotionalPerTradePct / 100) * equity;
    const maxPairNotional = (cfg.maxNotionalPerPairPct / 100) * equity;
    const existingPairExposure = input.exposureByPair.get(input.pair) ?? 0;
    const remainingPairRoom = Math.max(0, maxPairNotional - existingPairExposure);
    notional = Math.min(notional, maxTradeNotional, remainingPairRoom);

    // Cash constraint (leave some buffer)
    const cashAvail = Math.max(0, input.cashUsd - 5);
    notional = Math.min(notional, cashAvail);

    if (notional < cfg.minNotionalPerTradeUsd) {
      return { ok: false, reason: `Notional too small ($${notional.toFixed(2)} < $${cfg.minNotionalPerTradeUsd})` };
    }
    qty = notional / refPrice;
    return { ok: true, qty, notionalUsd: notional, stopPrice, takeProfit: tpPrice };
  }
}

function nextDailyReset(): number {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}
