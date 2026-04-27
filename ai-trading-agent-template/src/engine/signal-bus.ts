/**
 * Signal Bus — collects signals from many sources and aggregates them
 * per pair. Sources include the technical strategy, optional LLM, and
 * external submissions from users / bots over HTTP.
 *
 * Each source has a configurable trust weight. Aggregation produces a
 * decisive action only when net conviction exceeds a threshold.
 */

import { Signal, SignalSource, Action } from "./types";

const DEFAULT_WEIGHTS: Record<SignalSource, number> = {
  technical: 1.0,
  llm: 0.8,
  prism: 0.9,                // independent multi-indicator vendor signal
  external: 0.6,             // external sources start with lower trust
  "trailing-stop": 1.0,
  "stop-loss": 1.0,
  "take-profit": 1.0,
  manual: 1.5,
};

export interface AggregatedDecision {
  pair: string;
  action: Action;
  confidence: number;
  reasoning: string;
  contributing: Signal[];
  netScore: number;          // -1..+1 (sell..buy)
}

export class SignalBus {
  private signals: Signal[] = [];
  private weights: Record<SignalSource, number>;
  private maxHistory = 500;

  constructor(weights?: Partial<Record<SignalSource, number>>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) };
  }

  publish(s: Signal): Signal {
    if (!s.id) s.id = `${s.source}-${s.pair}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    if (!s.createdAt) s.createdAt = Date.now();
    s.weight = s.weight ?? this.weights[s.source] ?? 0.5;
    this.signals.push(s);
    if (this.signals.length > this.maxHistory) this.signals.splice(0, this.signals.length - this.maxHistory);
    return s;
  }

  recent(limit = 50, pair?: string): Signal[] {
    const all = pair ? this.signals.filter(s => s.pair === pair) : this.signals;
    return all.slice(-limit).reverse();
  }

  /**
   * Aggregate live signals for a single pair into a decision.
   * Signals past their TTL are ignored.
   */
  aggregate(pair: string, ttlMs = 5 * 60_000): AggregatedDecision {
    const now = Date.now();
    const live = this.signals.filter(s => s.pair === pair && (now - s.createdAt) <= (s.ttlMs ?? ttlMs));
    if (!live.length) {
      return { pair, action: "HOLD", confidence: 0, reasoning: "No live signals", contributing: [], netScore: 0 };
    }
    let num = 0, den = 0;
    for (const s of live) {
      const dir = s.action === "BUY" ? 1 : s.action === "SELL" ? -1 : 0;
      const w = (s.weight ?? 1) * Math.max(0.1, s.confidence);
      num += dir * w;
      den += w;
    }
    const netScore = den > 0 ? num / den : 0;
    let action: Action = "HOLD";
    if (netScore >= 0.35) action = "BUY";
    else if (netScore <= -0.35) action = "SELL";
    const confidence = Math.min(1, Math.abs(netScore));
    const sources = Array.from(new Set(live.map(s => s.source))).join(", ");
    const reasoning = `${live.length} signal(s) from ${sources}: net ${netScore >= 0 ? "+" : ""}${netScore.toFixed(2)}`;
    return { pair, action, confidence, reasoning, contributing: live.slice(-10), netScore };
  }

  setWeight(source: SignalSource, w: number): void {
    this.weights[source] = w;
  }
}
