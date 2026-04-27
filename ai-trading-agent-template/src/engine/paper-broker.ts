/**
 * Paper Broker — simulated order execution against the live order book top.
 * Applies fees and slippage so PnL accounting matches a realistic exchange.
 */

import { Position, ClosedTrade, Side, Tick, EngineConfig } from "./types";

export interface OpenResult {
  position: Position;
  fillPrice: number;
  feeUsd: number;
}

export interface CloseResult {
  closed: ClosedTrade;
  fillPrice: number;
  feeUsd: number;
}

export class PaperBroker {
  constructor(private cfg: EngineConfig) {}

  applySlippage(side: Side, price: number): number {
    const slip = this.cfg.slippageBps / 10000;
    return side === "BUY" ? price * (1 + slip) : price * (1 - slip);
  }

  feeUsd(notional: number): number {
    return notional * (this.cfg.takerFeeBps / 10000);
  }

  open(opts: {
    side: Side;
    pair: string;
    qty: number;
    tick: Tick;
    stopPrice: number;
    takeProfit: number;
    reasoning: string;
    source: Position["source"];
  }): OpenResult {
    const refPrice = opts.side === "BUY" ? opts.tick.ask : opts.tick.bid;
    const fillPrice = this.applySlippage(opts.side, refPrice);
    const notional = fillPrice * opts.qty;
    const fee = this.feeUsd(notional);
    const pos: Position = {
      id: `pos-${opts.pair}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      pair: opts.pair,
      side: opts.side,
      qty: opts.qty,
      entryPrice: fillPrice,
      entryNotional: notional + fee,
      openedAt: Date.now(),
      stopPrice: opts.stopPrice,
      takeProfit: opts.takeProfit,
      highWaterPrice: fillPrice,
      reasoning: opts.reasoning,
      source: opts.source,
    };
    return { position: pos, fillPrice, feeUsd: fee };
  }

  close(pos: Position, tick: Tick, reasonClose: string): CloseResult {
    const exitSide: Side = pos.side === "BUY" ? "SELL" : "BUY";
    const refPrice = exitSide === "BUY" ? tick.ask : tick.bid;
    const fillPrice = this.applySlippage(exitSide, refPrice);
    const notional = fillPrice * pos.qty;
    const fee = this.feeUsd(notional);
    const grossPnl = pos.side === "BUY"
      ? (fillPrice - pos.entryPrice) * pos.qty
      : (pos.entryPrice - fillPrice) * pos.qty;
    const pnlUsd = grossPnl - fee - (pos.entryNotional - pos.entryPrice * pos.qty); // subtract entry fee that was added in
    const entryNotionalNoFee = pos.entryPrice * pos.qty;
    const pnlPct = entryNotionalNoFee > 0 ? (pnlUsd / entryNotionalNoFee) * 100 : 0;
    const closed: ClosedTrade = {
      id: pos.id,
      pair: pos.pair,
      side: pos.side,
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      exitPrice: fillPrice,
      openedAt: pos.openedAt,
      closedAt: Date.now(),
      pnlUsd,
      pnlPct,
      reasonOpen: pos.reasoning,
      reasonClose,
      source: pos.source,
    };
    return { closed, fillPrice, feeUsd: fee };
  }
}
