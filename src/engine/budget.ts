/**
 * AI Call Budget — strict daily quota for LLM calls.
 *
 * The user explicitly does NOT want the LLM prompted continuously. We
 * enforce a hard daily cap (default 30 calls/day) that resets at UTC
 * midnight, and we partition the cap into:
 *   - reserved for emergencies (drawdown / large losers / kill events)
 *   - reserved for manual dashboard triggers
 *   - the rest for periodic regime checks
 *
 * The bucket is persisted so it survives restarts.
 */

import { readJson, writeJson, statePath } from "./persistence";

const BUDGET_FILE = statePath("ai-budget.json");

export type BudgetReason =
  | "periodic"
  | "emergency"
  | "manual"
  | "event"
  | "warmup";

export interface BudgetState {
  date: string;             // UTC YYYY-MM-DD
  used: number;
  reservedEmergency: number;
  reservedManual: number;
  perReason: Record<BudgetReason, number>;
  lastCallAt: number;
  lastReason: BudgetReason | null;
  history: Array<{ at: number; reason: BudgetReason; ok: boolean; note?: string }>;
}

export interface BudgetConfig {
  dailyMax: number;             // total per UTC day
  reservedEmergency: number;    // saved for emergencies
  reservedManual: number;       // saved for manual triggers
  minSpacingMs: number;         // minimum gap between any two calls
}

export const DEFAULT_BUDGET: BudgetConfig = {
  dailyMax: 30,
  reservedEmergency: 5,
  reservedManual: 2,
  minSpacingMs: 60_000,
};

function todayKey(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function emptyState(): BudgetState {
  return {
    date: todayKey(),
    used: 0,
    reservedEmergency: DEFAULT_BUDGET.reservedEmergency,
    reservedManual: DEFAULT_BUDGET.reservedManual,
    perReason: { periodic: 0, emergency: 0, manual: 0, event: 0, warmup: 0 },
    lastCallAt: 0,
    lastReason: null,
    history: [],
  };
}

export class AICallBudget {
  cfg: BudgetConfig;
  state: BudgetState;

  constructor(cfg: Partial<BudgetConfig> = {}) {
    this.cfg = { ...DEFAULT_BUDGET, ...cfg };
    this.state = readJson<BudgetState>(BUDGET_FILE, emptyState());
    this.rolloverIfNeeded();
  }

  private rolloverIfNeeded(): void {
    const t = todayKey();
    if (this.state.date !== t) {
      this.state = { ...emptyState(), date: t };
      this.persist();
    }
  }

  private persist(): void {
    try { writeJson(BUDGET_FILE, this.state); } catch { /* ignore */ }
  }

  remaining(): number {
    this.rolloverIfNeeded();
    return Math.max(0, this.cfg.dailyMax - this.state.used);
  }

  remainingForReason(reason: BudgetReason): number {
    this.rolloverIfNeeded();
    const totalLeft = this.remaining();
    if (reason === "emergency" || reason === "event") return totalLeft;
    if (reason === "manual") {
      // manual can use everything except the emergency reserve
      const cap = this.cfg.dailyMax - this.cfg.reservedEmergency;
      return Math.max(0, Math.min(totalLeft, cap - this.state.perReason.manual - this.state.perReason.periodic - this.state.perReason.warmup));
    }
    // periodic / warmup may use only the public pool (total minus emergency minus manual reserves)
    const cap = this.cfg.dailyMax - this.cfg.reservedEmergency - this.cfg.reservedManual;
    const publicUsed = this.state.perReason.periodic + this.state.perReason.warmup;
    return Math.max(0, Math.min(totalLeft, cap - publicUsed));
  }

  canCall(reason: BudgetReason, ignoreSpacing = false): { ok: boolean; reason?: string } {
    this.rolloverIfNeeded();
    if (this.remainingForReason(reason) <= 0) {
      return { ok: false, reason: `daily ${reason} budget exhausted (${this.state.used}/${this.cfg.dailyMax})` };
    }
    if (!ignoreSpacing && this.state.lastCallAt && Date.now() - this.state.lastCallAt < this.cfg.minSpacingMs) {
      const wait = Math.ceil((this.cfg.minSpacingMs - (Date.now() - this.state.lastCallAt)) / 1000);
      return { ok: false, reason: `min spacing not met, ${wait}s remaining` };
    }
    return { ok: true };
  }

  charge(reason: BudgetReason, note?: string): void {
    this.rolloverIfNeeded();
    this.state.used += 1;
    this.state.perReason[reason] = (this.state.perReason[reason] ?? 0) + 1;
    this.state.lastCallAt = Date.now();
    this.state.lastReason = reason;
    this.state.history.push({ at: Date.now(), reason, ok: true, note });
    if (this.state.history.length > 200) this.state.history.splice(0, this.state.history.length - 200);
    this.persist();
  }

  recordFailed(reason: BudgetReason, note?: string): void {
    // We do NOT charge failed calls. We still record them in history.
    this.state.history.push({ at: Date.now(), reason, ok: false, note });
    if (this.state.history.length > 200) this.state.history.splice(0, this.state.history.length - 200);
    this.persist();
  }

  publicState() {
    return {
      ...this.state,
      cfg: this.cfg,
      remaining: this.remaining(),
      resetsAt: nextUtcMidnight(),
    };
  }
}

function nextUtcMidnight(): number {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}
