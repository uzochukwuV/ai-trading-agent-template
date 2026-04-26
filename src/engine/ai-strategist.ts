/**
 * AI Strategist — Mistral-powered (with NVIDIA NIM fallback) portfolio
 * supervisor that runs INFREQUENTLY and only when it can add value.
 *
 * Triggers:
 *   - periodic regime check (gated by AICallBudget)
 *   - emergency: drawdown crosses threshold, position deeply underwater
 *   - manual: user clicks "Ask AI" on dashboard
 *
 * Receives a compact JSON briefing (portfolio, scanner, news, sentiment,
 * session) and is asked to return a strict JSON decision document.
 */

import { AICallBudget, BudgetReason } from "./budget";
import { NewsFeed } from "./news-feed";
import { evaluateSession, SessionState } from "./time-filter";
import { EngineConfig, Position, ScannerRow, RiskState, Action } from "./types";

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

export interface StrategistBriefing {
  ts: number;
  session: SessionState;
  portfolio: {
    equity: number;
    cash: number;
    realizedPnl: number;
    unrealizedPnl: number;
    feesPaid: number;
    closedCount: number;
    winRate: number;
    profitFactor: number;
    sharpe: number | null;
    maxDrawdownPct: number;
  };
  risk: RiskState;
  cfg: EngineConfig;
  open: Array<{
    pair: string;
    side: "BUY" | "SELL";
    qty: number;
    entryPrice: number;
    currentPrice: number;
    unrealizedPnl: number;
    unrealizedPnlPct: number;
    holdMinutes: number;
    stopPrice: number;
    takeProfit: number;
  }>;
  scanner: ScannerRow[];
  recentClosed: Array<{ pair: string; side: string; pnlUsd: number; pnlPct: number; reasonClose: string; holdMinutes: number }>;
  news: { headlines: string[]; fearGreed: number | null; fearGreedLabel: string | null; trending: string[] };
  prism?: Array<{
    pair: string;
    signal: string;                // strong_bullish/bullish/neutral/bearish/strong_bearish
    strength: string;              // weak/moderate/strong
    net: number;                   // bullish - bearish score
    rsi?: number;
    macdHist?: number;
    reasons: string[];
  }>;
}

export interface StrategistDecision {
  regime: "trending_up" | "trending_down" | "ranging" | "volatile" | "crisis" | "neutral";
  thesis: string;
  confidence: number;
  configPatch: Partial<EngineConfig> | null;
  exits: Array<{ pair: string; urgency: "low" | "med" | "high"; reason: string }>;
  signals: Array<{ pair: string; action: Action; confidence: number; reasoning: string }>;
  alert: string | null;
  pause: boolean;
  resume: boolean;
}

export interface StrategistResult {
  ok: boolean;
  reason: BudgetReason;
  ts: number;
  briefing?: StrategistBriefing;
  decision?: StrategistDecision;
  rawText?: string;
  error?: string;
  model?: string;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export class AIStrategist {
  budget: AICallBudget;
  news: NewsFeed;
  lastResult: StrategistResult | null = null;
  history: StrategistResult[] = [];
  private mistralKey: string | undefined;
  private nvidiaKey: string | undefined;
  private model: string;

  constructor(opts: {
    budget: AICallBudget;
    news: NewsFeed;
    mistralKey?: string;
    nvidiaKey?: string;
    model?: string;
  }) {
    this.budget = opts.budget;
    this.news = opts.news;
    this.mistralKey = opts.mistralKey;
    this.nvidiaKey = opts.nvidiaKey;
    this.model = opts.model || "mistral-large-latest";
  }

  isConfigured(): boolean { return !!this.mistralKey || !!this.nvidiaKey; }

  publicStatus() {
    return {
      configured: this.isConfigured(),
      model: this.model,
      hasMistral: !!this.mistralKey,
      hasNvidia: !!this.nvidiaKey,
      news: this.news.isConfigured(),
      budget: this.budget.publicState(),
      lastResult: this.lastResult ? {
        ok: this.lastResult.ok,
        ts: this.lastResult.ts,
        reason: this.lastResult.reason,
        model: this.lastResult.model,
        latencyMs: this.lastResult.latencyMs,
        decision: this.lastResult.decision,
        error: this.lastResult.error,
      } : null,
      history: this.history.slice(-20).map(r => ({
        ts: r.ts, ok: r.ok, reason: r.reason, model: r.model,
        regime: r.decision?.regime, thesis: r.decision?.thesis,
      })),
    };
  }

  async run(reason: BudgetReason, briefing: StrategistBriefing): Promise<StrategistResult> {
    const ignoreSpacing = reason === "emergency" || reason === "manual";
    const gate = this.budget.canCall(reason, ignoreSpacing);
    if (!gate.ok) {
      const r: StrategistResult = { ok: false, reason, ts: Date.now(), error: gate.reason, briefing };
      this.lastResult = r;
      return r;
    }
    if (!this.isConfigured()) {
      const r: StrategistResult = { ok: false, reason, ts: Date.now(), error: "no AI key configured", briefing };
      this.lastResult = r;
      return r;
    }
    const t0 = Date.now();
    const prompt = buildPrompt(briefing, reason);
    let model = this.model;
    let raw = "";
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;

    try {
      if (this.mistralKey) {
        const out = await callMistral(this.mistralKey, this.model, prompt);
        raw = out.text; model = `mistral:${this.model}`;
        tokensIn = out.usage?.prompt_tokens; tokensOut = out.usage?.completion_tokens;
      } else if (this.nvidiaKey) {
        const out = await callNvidia(this.nvidiaKey, "moonshotai/kimi-k2-thinking", prompt);
        raw = out.text; model = `nvidia:moonshotai/kimi-k2-thinking`;
        tokensIn = out.usage?.prompt_tokens; tokensOut = out.usage?.completion_tokens;
      }
    } catch (e) {
      this.budget.recordFailed(reason, (e as Error).message);
      const r: StrategistResult = { ok: false, reason, ts: Date.now(), briefing, error: (e as Error).message, latencyMs: Date.now() - t0, model };
      this.lastResult = r;
      this.history.push(r);
      return r;
    }

    const decision = parseDecision(raw, briefing);
    this.budget.charge(reason, decision?.thesis?.slice(0, 80));
    const r: StrategistResult = {
      ok: true, reason, ts: Date.now(), briefing,
      decision: decision ?? undefined,
      rawText: raw, latencyMs: Date.now() - t0, model, tokensIn, tokensOut,
    };
    this.lastResult = r;
    this.history.push(r);
    if (this.history.length > 50) this.history.splice(0, this.history.length - 50);
    return r;
  }
}

// ─── Prompt construction ─────────────────────────────────────────────────────

function buildPrompt(b: StrategistBriefing, reason: BudgetReason): string {
  const compactScanner = b.scanner.map(r => ({
    p: r.pair, px: round(r.price, r.price < 1 ? 5 : 2),
    rsi: r.rsi != null ? round(r.rsi, 1) : null,
    macd: r.macdHist != null ? round(r.macdHist, 3) : null,
    trend: r.trend, score: round(r.score, 2), bias: r.action,
  }));
  const compactOpen = b.open.map(p => ({
    p: p.pair, side: p.side, qty: round(p.qty, 6),
    entry: round(p.entryPrice, 4), mark: round(p.currentPrice, 4),
    upnl: round(p.unrealizedPnl, 2), upnlPct: round(p.unrealizedPnlPct, 2),
    hold_min: round(p.holdMinutes, 1), stop: round(p.stopPrice, 4), tp: round(p.takeProfit, 4),
  }));
  const compactClosed = b.recentClosed.slice(-15).map(c => ({
    p: c.pair, side: c.side, pnl: round(c.pnlUsd, 2), pct: round(c.pnlPct, 2),
    why: c.reasonClose, hold_min: round(c.holdMinutes, 1),
  }));

  const briefingJson = JSON.stringify({
    ts: new Date(b.ts).toISOString(),
    trigger: reason,
    session: b.session,
    portfolio: b.portfolio,
    risk: b.risk,
    cfg: b.cfg,
    open: compactOpen,
    scanner: compactScanner,
    recent_closed: compactClosed,
    news: b.news,
    prism_signals: b.prism ?? [],
  }, null, 0);

  return [
    "You are the senior risk-and-strategy supervisor for an automated crypto paper-trading bot.",
    "You are NOT called continuously — you have a strict daily call budget. Every call must add value.",
    "Your job:",
    "  1. Classify the current market regime.",
    "  2. Recommend exits for losing or stale positions when conditions changed.",
    "  3. Optionally adjust the engine config (more defensive in volatility, more aggressive in trends).",
    "  4. Optionally publish high-confidence directional signals (action BUY/SELL) for specific pairs.",
    "  5. Decide whether to pause the bot entirely (e.g. crisis / black-swan news).",
    "",
    "Reply with STRICT JSON ONLY, no prose, matching this schema:",
    "{",
    '  "regime": "trending_up|trending_down|ranging|volatile|crisis|neutral",',
    '  "thesis": "1-3 sentence summary of your view",',
    '  "confidence": 0.0-1.0,',
    '  "configPatch": null OR an object with any of:',
    '     buyThreshold (0.51..0.9), sellThreshold (0.1..0.49),',
    '     riskPerTradePct (0.1..3), maxPositions (1..8),',
    '     maxNotionalPerTradePct (5..50), trailingActivatePct (0.5..5),',
    '     trailingDistancePct (0.2..3), cooldownMs (30000..600000),',
    '     dailyLossLimitPct (1..15), maxDrawdownPct (3..30),',
    '  "exits": [{"pair":"XBTUSD","urgency":"low|med|high","reason":"..."}],',
    '  "signals": [{"pair":"SOLUSD","action":"BUY|SELL|HOLD","confidence":0..1,"reasoning":"..."}],',
    '  "alert": null OR "short user-visible alert string",',
    '  "pause": false,',
    '  "resume": false',
    "}",
    "",
    "Rules:",
    "- Be conservative. Prefer no change over a bad change.",
    "- Only request exits if the position is significantly underwater AND the regime/news has shifted against it, OR it is stale (held a long time without progress).",
    "- Only emit signals you are >0.6 confident about.",
    "- Use `pause:true` only on real crisis news (exchange halt, exploit, US ban, etc.).",
    "- If everything looks fine, return `regime: neutral`, empty arrays, configPatch null.",
    "",
    "Briefing:",
    briefingJson,
  ].join("\n");
}

function round(n: number, d: number): number {
  const k = 10 ** d;
  return Math.round(n * k) / k;
}

// ─── Decision parsing ────────────────────────────────────────────────────────

const ALLOWED_CFG_KEYS = new Set([
  "buyThreshold", "sellThreshold", "riskPerTradePct", "maxPositions",
  "maxNotionalPerTradePct", "trailingActivatePct", "trailingDistancePct",
  "cooldownMs", "dailyLossLimitPct", "maxDrawdownPct",
]);

const CFG_BOUNDS: Record<string, [number, number]> = {
  buyThreshold: [0.51, 0.9], sellThreshold: [0.1, 0.49],
  riskPerTradePct: [0.1, 3], maxPositions: [1, 8],
  maxNotionalPerTradePct: [5, 50],
  trailingActivatePct: [0.5, 5], trailingDistancePct: [0.2, 3],
  cooldownMs: [30_000, 600_000],
  dailyLossLimitPct: [1, 15], maxDrawdownPct: [3, 30],
};

function parseDecision(raw: string, briefing: StrategistBriefing): StrategistDecision | null {
  if (!raw) return null;
  let txt = raw.trim();
  // Strip markdown code fences
  if (txt.startsWith("```")) {
    txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  // Find first { and matching last }
  const i = txt.indexOf("{");
  const j = txt.lastIndexOf("}");
  if (i === -1 || j === -1 || j <= i) return null;
  let parsed: any;
  try { parsed = JSON.parse(txt.slice(i, j + 1)); } catch { return null; }

  const validPairs = new Set(briefing.cfg.watchlist);
  const openPairs = new Set(briefing.open.map(o => o.pair));

  const decision: StrategistDecision = {
    regime: pickEnum(parsed.regime, ["trending_up","trending_down","ranging","volatile","crisis","neutral"], "neutral"),
    thesis: typeof parsed.thesis === "string" ? parsed.thesis.slice(0, 600) : "",
    confidence: clamp(Number(parsed.confidence), 0, 1, 0.5),
    configPatch: null,
    exits: [],
    signals: [],
    alert: typeof parsed.alert === "string" && parsed.alert.trim() ? parsed.alert.slice(0, 240) : null,
    pause: parsed.pause === true,
    resume: parsed.resume === true,
  };

  if (parsed.configPatch && typeof parsed.configPatch === "object") {
    const patch: Partial<EngineConfig> = {};
    for (const k of Object.keys(parsed.configPatch)) {
      if (!ALLOWED_CFG_KEYS.has(k)) continue;
      const v = Number((parsed.configPatch as any)[k]);
      if (!Number.isFinite(v)) continue;
      const [lo, hi] = CFG_BOUNDS[k];
      (patch as any)[k] = clamp(v, lo, hi, v);
    }
    if (Object.keys(patch).length) decision.configPatch = patch;
  }

  if (Array.isArray(parsed.exits)) {
    for (const e of parsed.exits) {
      if (!e || typeof e !== "object") continue;
      const pair = String(e.pair || "").toUpperCase();
      if (!openPairs.has(pair)) continue;        // only exit positions we hold
      decision.exits.push({
        pair,
        urgency: pickEnum(e.urgency, ["low","med","high"], "med"),
        reason: typeof e.reason === "string" ? e.reason.slice(0, 240) : "AI exit",
      });
    }
  }

  if (Array.isArray(parsed.signals)) {
    for (const s of parsed.signals) {
      if (!s || typeof s !== "object") continue;
      const pair = String(s.pair || "").toUpperCase();
      const action = pickEnum(String(s.action || "").toUpperCase(), ["BUY","SELL","HOLD"], "HOLD") as Action;
      if (!validPairs.has(pair)) continue;
      const conf = clamp(Number(s.confidence), 0, 1, 0);
      if (conf < 0.6 || action === "HOLD") continue;
      decision.signals.push({
        pair, action, confidence: conf,
        reasoning: typeof s.reasoning === "string" ? s.reasoning.slice(0, 240) : "AI signal",
      });
    }
  }

  return decision;
}

function pickEnum<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  const s = typeof v === "string" ? v as T : fallback;
  return allowed.includes(s) ? s : fallback;
}
function clamp(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

// ─── HTTP callers ────────────────────────────────────────────────────────────

async function callMistral(key: string, model: string, prompt: string): Promise<{ text: string; usage?: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(MISTRAL_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a disciplined risk-aware crypto trading supervisor. Reply with strict JSON only." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 1200,
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`Mistral HTTP ${r.status}: ${body.slice(0, 200)}`);
    }
    const j: any = await r.json();
    const text = j?.choices?.[0]?.message?.content ?? "";
    return { text, usage: j?.usage };
  } finally { clearTimeout(t); }
}

async function callNvidia(key: string, model: string, prompt: string): Promise<{ text: string; usage?: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const r = await fetch(NVIDIA_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a disciplined risk-aware crypto trading supervisor. Reply with strict JSON only." },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 1500,
        stream: false,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`NVIDIA HTTP ${r.status}: ${body.slice(0, 200)}`);
    }
    const j: any = await r.json();
    const text = j?.choices?.[0]?.message?.content ?? "";
    return { text, usage: j?.usage };
  } finally { clearTimeout(t); }
}
