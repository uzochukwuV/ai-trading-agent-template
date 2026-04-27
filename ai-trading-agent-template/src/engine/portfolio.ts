/**
 * Portfolio — open positions, cash, equity, exposure, performance metrics.
 */

import { ClosedTrade, EquityPoint, Position, Tick } from "./types";

export class Portfolio {
  cash: number;
  open: Position[] = [];
  closed: ClosedTrade[] = [];
  equityCurve: EquityPoint[] = [];
  realizedPnl = 0;
  feesPaid = 0;

  constructor(public startingCash: number) {
    this.cash = startingCash;
  }

  // ─── State mutators ────────────────────────────────────────────────────────

  applyOpen(pos: Position, fillNotional: number, fee: number): void {
    this.cash -= fillNotional + fee;
    this.feesPaid += fee;
    this.open.push(pos);
  }

  applyClose(pos: Position, closed: ClosedTrade, fillNotional: number, fee: number): void {
    this.cash += fillNotional - fee;
    this.feesPaid += fee;
    this.realizedPnl += closed.pnlUsd;
    this.open = this.open.filter(p => p.id !== pos.id);
    this.closed.push(closed);
    if (this.closed.length > 1000) this.closed.splice(0, this.closed.length - 1000);
  }

  exposureByPair(ticks: Map<string, Tick>): Map<string, number> {
    const m = new Map<string, number>();
    for (const p of this.open) {
      const tk = ticks.get(p.pair);
      const px = tk ? tk.price : p.entryPrice;
      const v = (m.get(p.pair) ?? 0) + Math.abs(p.qty * px);
      m.set(p.pair, v);
    }
    return m;
  }

  // ─── Metrics ───────────────────────────────────────────────────────────────

  unrealizedPnl(ticks: Map<string, Tick>): number {
    let pnl = 0;
    for (const p of this.open) {
      const tk = ticks.get(p.pair);
      if (!tk) continue;
      pnl += p.side === "BUY"
        ? (tk.bid - p.entryPrice) * p.qty
        : (p.entryPrice - tk.ask) * p.qty;
    }
    return pnl;
  }

  positionsValue(ticks: Map<string, Tick>): number {
    let v = 0;
    for (const p of this.open) {
      const tk = ticks.get(p.pair);
      const px = tk ? (p.side === "BUY" ? tk.bid : tk.ask) : p.entryPrice;
      v += p.qty * px;
    }
    return v;
  }

  equity(ticks: Map<string, Tick>): number {
    return this.cash + this.positionsValue(ticks);
  }

  recordEquity(ticks: Map<string, Tick>): EquityPoint {
    const positionsValue = this.positionsValue(ticks);
    const equity = this.cash + positionsValue;
    const point: EquityPoint = {
      t: Date.now(),
      equity,
      cash: this.cash,
      positionsValue,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: this.unrealizedPnl(ticks),
    };
    const last = this.equityCurve[this.equityCurve.length - 1];
    // Keep curve compact: only store new point if 30s elapsed or a position changed
    if (!last || (point.t - last.t) > 30_000) {
      this.equityCurve.push(point);
      if (this.equityCurve.length > 720) this.equityCurve.splice(0, this.equityCurve.length - 720);
    }
    return point;
  }

  performance(): {
    totalPnl: number;
    totalReturnPct: number;
    winRate: number;
    avgWinPct: number;
    avgLossPct: number;
    profitFactor: number;
    sharpe: number;
    maxDrawdownPct: number;
    closedCount: number;
    feesPaid: number;
  } {
    const closed = this.closed;
    const wins = closed.filter(c => c.pnlUsd > 0);
    const losses = closed.filter(c => c.pnlUsd <= 0);
    const winRate = closed.length ? wins.length / closed.length : 0;
    const avgWinPct = wins.length ? wins.reduce((a, b) => a + b.pnlPct, 0) / wins.length : 0;
    const avgLossPct = losses.length ? losses.reduce((a, b) => a + b.pnlPct, 0) / losses.length : 0;
    const grossWin = wins.reduce((a, b) => a + b.pnlUsd, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b.pnlUsd, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

    // Sharpe approximation from equity curve returns
    let sharpe = 0;
    if (this.equityCurve.length > 5) {
      const rets: number[] = [];
      for (let i = 1; i < this.equityCurve.length; i++) {
        const a = this.equityCurve[i - 1].equity;
        const b = this.equityCurve[i].equity;
        if (a > 0) rets.push((b - a) / a);
      }
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
      const std = Math.sqrt(variance);
      sharpe = std > 0 ? (mean / std) * Math.sqrt(365 * 24 * 60 * 2) : 0; // assuming ~30s sampling
    }

    // Max drawdown from equity curve
    let peak = -Infinity;
    let maxDD = 0;
    for (const p of this.equityCurve) {
      if (p.equity > peak) peak = p.equity;
      if (peak > 0) {
        const dd = (peak - p.equity) / peak * 100;
        if (dd > maxDD) maxDD = dd;
      }
    }

    const totalPnl = this.realizedPnl;
    const totalReturnPct = this.startingCash > 0 ? (totalPnl / this.startingCash) * 100 : 0;
    return {
      totalPnl,
      totalReturnPct,
      winRate,
      avgWinPct,
      avgLossPct,
      profitFactor,
      sharpe,
      maxDrawdownPct: maxDD,
      closedCount: closed.length,
      feesPaid: this.feesPaid,
    };
  }
}
