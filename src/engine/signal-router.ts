/**
 * Signal Router — decides whether an aggregated signal should be executed
 * on Spot or Futures (or skipped), and at what leverage.
 *
 * This is intentionally rule-based, not AI-per-trade, so:
 *   - Decisions are auditable and reproducible
 *   - We don't burn AI budget on routing
 *   - The router can be tested in isolation
 *
 * The AI strategist only injects a per-cycle macro tilt
 * (`leverageBias` ∈ [-1, +1]) which biases the leverage chosen for
 * futures trades. The bucket selection itself is deterministic.
 *
 * Inputs the router needs at decision time:
 *   - The pair, action, confidence, and contributing source(s)
 *   - The current allocator state (target percentages + observed actuals)
 *   - The current futures availability (configured? enabled? room?)
 *   - Whether the *other* bucket already holds a position on this asset
 *     (no double-dipping)
 *
 * Output:
 *   { bucket: "spot" | "futures" | "skip", leverage?: number,
 *     notionalShareHint: number,  // 0..1 hint multiplier for sizing
 *     reason: string }
 */

import { Action, Bucket, AllocatorState, SignalSource } from "./types";

export interface RouterInput {
  pair: string;
  action: Action;
  confidence: number;                    // 0..1
  sources: SignalSource[];               // all contributing sources, in order of weight
  topReason: string;                     // human-readable
  allocator: AllocatorState;
  futuresAvailable: boolean;             // configured + enabled + room
  futuresHasPosition: boolean;           // already long/short this pair on futures
  spotHasPosition: boolean;              // already long/short this pair on spot
  pairTags?: { volatile?: boolean; meme?: boolean; rangeBound?: boolean };
  maxLeverageHardCap?: number;           // futures engine's cap (e.g. 5)
  defaultLeverage?: number;              // futures engine's default (e.g. 2)
}

export interface RouterDecision {
  bucket: Bucket | "skip";
  leverage?: number;             // only for futures
  notionalShareHint: number;     // 0..1, applied on top of caller's risk sizing
  reason: string;
}

/**
 * Pure function — no side effects. Returns the routing decision.
 */
export function routeSignal(input: RouterInput): RouterDecision {
  const a = input.action;
  if (a === "HOLD") return { bucket: "skip", notionalShareHint: 0, reason: "HOLD" };

  const tilt = clamp(input.allocator.leverageBias ?? 0, -1, 1);
  const conf = clamp(input.confidence, 0, 1);
  const techConf = input.sources.includes("technical");
  const llmConf = input.sources.includes("llm");
  const prismConf = input.sources.includes("prism");
  const trailingExit = input.sources.some(s => s === "trailing-stop" || s === "stop-loss" || s === "take-profit");
  // Manual signals always go to spot (operator intent).
  const manual = input.sources.includes("manual") || input.sources.includes("external");

  // ── Hard skips & forced routes ──────────────────────────────────────────
  if (trailingExit) {
    // exit-side signals are always handled by the bucket holding the position
    return { bucket: "skip", notionalShareHint: 0, reason: "exit signal handled by owning bucket" };
  }
  if (input.pairTags?.volatile || input.pairTags?.meme) {
    return { bucket: "spot", notionalShareHint: 0.6, reason: "volatile/meme → spot only (no leverage)" };
  }
  if (manual) {
    return { bucket: "spot", notionalShareHint: 1.0, reason: "manual/external signal → spot" };
  }
  if (input.pairTags?.rangeBound) {
    return { bucket: "spot", notionalShareHint: 0.8, reason: "range-bound regime → spot only" };
  }

  // ── No-double-dipping rule ──────────────────────────────────────────────
  // If both buckets already hold a position on this pair, skip entirely.
  if (input.spotHasPosition && input.futuresHasPosition) {
    return { bucket: "skip", notionalShareHint: 0, reason: "both buckets already hold this asset" };
  }

  // ── Allocator-driven floor enforcement ──────────────────────────────────
  const spotAvail = input.allocator.spotTargetPct >= 5;
  const futAvail = input.futuresAvailable && input.allocator.futuresTargetPct >= 5;

  // ── Strong-trend high-confidence path → futures preferred ───────────────
  // Conditions: confidence >= 0.7 AND (technical + (llm OR prism)) corroboration
  // AND not already on futures for this pair AND futures available.
  const strongCorroborated = conf >= 0.7 && techConf && (llmConf || prismConf);
  if (strongCorroborated && futAvail && !input.futuresHasPosition) {
    const lev = computeLeverage({
      conf,
      tilt,
      hardCap: input.maxLeverageHardCap ?? 5,
      defaultLev: input.defaultLeverage ?? 2,
    });
    // If spot is also empty for this pair, we can prefer futures fully.
    // If spot already holds an OPPOSITE position, we'd be hedging — skip
    // to avoid unintentional pair-trade.
    if (input.spotHasPosition) {
      return { bucket: "skip", notionalShareHint: 0, reason: `spot already holds ${input.pair}; would conflict` };
    }
    return {
      bucket: "futures",
      leverage: lev,
      notionalShareHint: clamp(0.7 + (conf - 0.7) * 0.5, 0.5, 1),
      reason: `strong trend conf=${conf.toFixed(2)} + corroboration → futures @${lev}x (tilt=${tilt.toFixed(2)})`,
    };
  }

  // ── Medium confidence → spot ────────────────────────────────────────────
  if (spotAvail && !input.spotHasPosition) {
    return {
      bucket: "spot",
      notionalShareHint: clamp(0.5 + (conf - 0.5) * 0.6, 0.4, 1),
      reason: `conf=${conf.toFixed(2)} → spot (single-source or moderate conviction)`,
    };
  }

  // ── Spot not available (e.g. already holds this asset) → futures fallback
  if (futAvail && !input.futuresHasPosition && conf >= 0.55) {
    const lev = Math.min(input.defaultLeverage ?? 2, input.maxLeverageHardCap ?? 5);
    return {
      bucket: "futures",
      leverage: lev,
      notionalShareHint: 0.5,
      reason: `spot blocked (held); fallback to futures @${lev}x`,
    };
  }

  return { bucket: "skip", notionalShareHint: 0, reason: "no available bucket meets routing rules" };
}

function computeLeverage(opts: {
  conf: number;        // 0..1
  tilt: number;        // -1..+1
  hardCap: number;     // exchange cap
  defaultLev: number;  // baseline
}): number {
  // Base leverage = default + slope * (conf - 0.7), then add tilt scaled by ±1.5x.
  const slope = 6;     // conf 0.7 -> +0, conf 1.0 -> +1.8
  const base = opts.defaultLev + Math.max(0, opts.conf - 0.7) * slope;
  const withTilt = base + opts.tilt * 1.5;
  // Floor at 1, cap at hardCap.
  return Math.round(clamp(withTilt, 1, opts.hardCap) * 10) / 10;
}

function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }
