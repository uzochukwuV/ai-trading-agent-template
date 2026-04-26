/**
 * Capital Allocator — manages target equity split between Spot and Futures buckets.
 *
 * Important context: the two buckets live on separate exchanges (Kraken Spot
 * paper engine vs. Kraken Futures demo). We do NOT actually move USD between
 * them. Instead the allocator computes a *logical* target split that the
 * router uses to decide which bucket to send a new signal to and at what size.
 *
 * Guardrails (in order of priority):
 *   1. Hard floors: each bucket must keep >= floorPct of combined equity in
 *      "share of capital deployed", so neither side ever gets starved.
 *   2. Max rotation per cycle: target shift can't change by more than
 *      maxDailyRotationPct of combined equity per rebalance.
 *   3. Cooldown: at most one rebalance per rebalanceCooldownMs.
 *   4. Loss freeze: if either bucket lost >= freezeLossPct in 24h, freeze
 *      allocation changes for freezeForMs.
 *
 * Performance metric: rolling Sharpe over `windowMs` of each bucket's
 * combined equity curve. Falls back to raw realized PnL ratio if not enough
 * samples.
 *
 * AI macro tilt: a separate field `leverageBias` in [-1, +1] set by the AI
 * strategist's allocation hint. The router uses it to bias its leverage
 * choice on futures trades (does NOT affect bucket targets directly).
 */

import { AllocatorState } from "./types";
import { readJson, writeJson, statePath } from "./persistence";

const STATE_FILE = statePath("allocator-state.json");

export interface AllocatorCfg {
  initialSpotPct: number;          // e.g. 70
  initialFuturesPct: number;       // e.g. 30
  floorPct: number;                // each bucket >= this share (e.g. 20)
  maxDailyRotationPct: number;     // max change per rebalance (e.g. 10)
  rebalanceCooldownMs: number;     // e.g. 6 * 60 * 60_000
  freezeLossPct: number;           // e.g. 3 (% daily loss in either bucket triggers freeze)
  freezeForMs: number;             // e.g. 24 * 60 * 60_000
  windowMs: number;                // rolling perf window (e.g. 7 days)
  enabled: boolean;
}

export const DEFAULT_ALLOCATOR_CFG: AllocatorCfg = {
  initialSpotPct: 70,
  initialFuturesPct: 30,
  floorPct: 20,
  maxDailyRotationPct: 10,
  rebalanceCooldownMs: 6 * 60 * 60_000,
  freezeLossPct: 3,
  freezeForMs: 24 * 60 * 60_000,
  windowMs: 7 * 24 * 60 * 60_000,
  enabled: true,
};

export interface PerfStat {
  /** Realized + unrealized return over the window, expressed as fraction (0.05 = +5%) */
  totalReturn: number;
  /** Mean return per sample */
  mean: number;
  /** Std dev of returns per sample */
  stdev: number;
  /** Sharpe ≈ mean/stdev * sqrt(N). Returns 0 if stdev==0 or insufficient samples. */
  sharpe: number;
  /** Number of return samples used */
  samples: number;
  /** Realized day-over-day PnL pct (for freeze trigger) */
  dailyPnlPct: number;
}

export class CapitalAllocator {
  cfg: AllocatorCfg;
  state: AllocatorState;

  constructor(cfg: Partial<AllocatorCfg> = {}) {
    this.cfg = { ...DEFAULT_ALLOCATOR_CFG, ...cfg };
    const persisted = readJson<{ state?: AllocatorState; cfg?: Partial<AllocatorCfg> }>(STATE_FILE, {});
    if (persisted.cfg) this.cfg = { ...this.cfg, ...persisted.cfg };
    this.state = persisted.state ?? {
      enabled: this.cfg.enabled,
      spotTargetPct: this.cfg.initialSpotPct,
      futuresTargetPct: this.cfg.initialFuturesPct,
      spotEquityUsd: 0,
      futuresEquityUsd: 0,
      combinedEquityUsd: 0,
      spotActualPct: this.cfg.initialSpotPct,
      futuresActualPct: this.cfg.initialFuturesPct,
      leverageBias: 0,
      lastRebalanceAt: 0,
      nextRebalanceAt: Date.now() + this.cfg.rebalanceCooldownMs,
      frozenUntil: 0,
      reason: "init",
      history: [],
    };
  }

  setEnabled(on: boolean) { this.state.enabled = on; this.persist(); }
  setLeverageBias(bias: number) { this.state.leverageBias = clamp(bias, -1, 1); this.persist(); }
  manualOverride(spotPct: number, futuresPct: number, reason = "manual override") {
    const total = spotPct + futuresPct;
    if (total <= 0) return;
    this.state.spotTargetPct = (spotPct / total) * 100;
    this.state.futuresTargetPct = (futuresPct / total) * 100;
    this.state.lastRebalanceAt = Date.now();
    this.state.nextRebalanceAt = Date.now() + this.cfg.rebalanceCooldownMs;
    this.state.reason = reason;
    this.state.history.push({
      t: Date.now(), spotPct: this.state.spotTargetPct, futuresPct: this.state.futuresTargetPct,
      tilt: this.state.leverageBias, reason,
    });
    if (this.state.history.length > 100) this.state.history.splice(0, this.state.history.length - 100);
    this.persist();
  }

  /**
   * Tick the allocator. Updates observed equities & actual percentages, and
   * runs a rebalance if conditions are met.
   *
   *   spotEquityUsd: spot bucket's portfolio value (cash + positions value)
   *   futuresEquityUsd: futures bucket's portfolio value (margin equity)
   *   spotPerf: rolling perf for spot
   *   futuresPerf: rolling perf for futures
   */
  tick(input: {
    spotEquityUsd: number;
    futuresEquityUsd: number;
    spotPerf: PerfStat;
    futuresPerf: PerfStat;
  }): AllocatorState {
    const now = Date.now();
    const combined = input.spotEquityUsd + input.futuresEquityUsd;
    this.state.spotEquityUsd = input.spotEquityUsd;
    this.state.futuresEquityUsd = input.futuresEquityUsd;
    this.state.combinedEquityUsd = combined;
    if (combined > 0) {
      this.state.spotActualPct = (input.spotEquityUsd / combined) * 100;
      this.state.futuresActualPct = (input.futuresEquityUsd / combined) * 100;
    }

    if (!this.state.enabled || !this.cfg.enabled) {
      this.state.reason = "allocator disabled";
      this.persist();
      return this.state;
    }

    // Freeze on big losses
    if (input.spotPerf.dailyPnlPct <= -this.cfg.freezeLossPct
        || input.futuresPerf.dailyPnlPct <= -this.cfg.freezeLossPct) {
      const until = now + this.cfg.freezeForMs;
      if (until > this.state.frozenUntil) {
        this.state.frozenUntil = until;
        this.state.reason = `frozen: daily loss spot=${input.spotPerf.dailyPnlPct.toFixed(2)}% futures=${input.futuresPerf.dailyPnlPct.toFixed(2)}%`;
      }
    }

    if (now < this.state.frozenUntil) {
      this.state.reason = `frozen until ${new Date(this.state.frozenUntil).toISOString()} (recent loss)`;
      this.persist();
      return this.state;
    }

    if (now < this.state.nextRebalanceAt) {
      this.state.reason = `cooldown — next rebalance ${new Date(this.state.nextRebalanceAt).toISOString()}`;
      this.persist();
      return this.state;
    }

    // Compute desired weights from Sharpe (positive scores only; negative ones penalize that bucket).
    const sSpot = Math.max(input.spotPerf.sharpe, -2);
    const sFut = Math.max(input.futuresPerf.sharpe, -2);
    // Shift Sharpe to positive domain by adding 3 (so even -2 -> 1 weight)
    const wSpot = sSpot + 3;
    const wFut = sFut + 3;
    const wTotal = wSpot + wFut;
    let desiredSpotPct = (wSpot / wTotal) * 100;
    let desiredFutPct = 100 - desiredSpotPct;

    // Apply hard floors
    if (desiredSpotPct < this.cfg.floorPct) {
      desiredSpotPct = this.cfg.floorPct;
      desiredFutPct = 100 - desiredSpotPct;
    }
    if (desiredFutPct < this.cfg.floorPct) {
      desiredFutPct = this.cfg.floorPct;
      desiredSpotPct = 100 - desiredFutPct;
    }

    // Clamp the shift by maxDailyRotationPct
    const currentSpotPct = this.state.spotTargetPct;
    const delta = desiredSpotPct - currentSpotPct;
    const maxStep = this.cfg.maxDailyRotationPct;
    const clamped = clamp(delta, -maxStep, maxStep);
    const newSpotPct = currentSpotPct + clamped;
    const newFutPct = 100 - newSpotPct;

    this.state.spotTargetPct = newSpotPct;
    this.state.futuresTargetPct = newFutPct;
    this.state.lastRebalanceAt = now;
    this.state.nextRebalanceAt = now + this.cfg.rebalanceCooldownMs;
    this.state.reason = `rebalanced: spot Sharpe ${sSpot.toFixed(2)}, fut Sharpe ${sFut.toFixed(2)} → desired ${desiredSpotPct.toFixed(0)}/${desiredFutPct.toFixed(0)}, applied step ${clamped.toFixed(2)}%`;
    this.state.history.push({
      t: now, spotPct: newSpotPct, futuresPct: newFutPct,
      tilt: this.state.leverageBias, reason: this.state.reason,
    });
    if (this.state.history.length > 100) this.state.history.splice(0, this.state.history.length - 100);

    this.persist();
    return this.state;
  }

  publicState(): AllocatorState { return { ...this.state, history: this.state.history.slice(-30) }; }

  private persist(): void {
    try { writeJson(STATE_FILE, { state: this.state, cfg: this.cfg }); }
    catch (e) { console.warn("[allocator] persist failed:", (e as Error).message); }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }

/**
 * Compute rolling perf stats from an equity curve. Each entry must have a
 * `t` (ms) and a numeric equity field — we accept `equity` or `portfolioValue`.
 */
export function computePerfStats(curve: Array<{ t: number; equity?: number; portfolioValue?: number }>, windowMs: number): PerfStat {
  const cutoff = Date.now() - windowMs;
  const pts = curve.filter(c => c.t >= cutoff).map(c => ({ t: c.t, e: Number(c.equity ?? c.portfolioValue ?? 0) })).filter(c => c.e > 0);
  if (pts.length < 3) {
    return { totalReturn: 0, mean: 0, stdev: 0, sharpe: 0, samples: pts.length, dailyPnlPct: 0 };
  }
  const first = pts[0].e;
  const last = pts[pts.length - 1].e;
  const totalReturn = (last - first) / first;
  // Sample returns
  const rets: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i - 1].e > 0) rets.push((pts[i].e - pts[i - 1].e) / pts[i - 1].e);
  }
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(rets.length) : 0;

  // Daily PnL: compare last to ~24h ago
  const dayCutoff = Date.now() - 24 * 60 * 60_000;
  let dayBaseline = first;
  for (const p of pts) { if (p.t >= dayCutoff) { dayBaseline = p.e; break; } }
  const dailyPnlPct = dayBaseline > 0 ? ((last - dayBaseline) / dayBaseline) * 100 : 0;

  return { totalReturn, mean, stdev, sharpe, samples: rets.length, dailyPnlPct };
}
