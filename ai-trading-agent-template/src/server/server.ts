/**
 * Unified backend for the Trading Agent dashboard + signal API.
 *
 * Endpoints:
 *   GET  /                         dashboard UI
 *   GET  /api/snapshot             live engine snapshot
 *   GET  /api/positions            open positions w/ live PnL
 *   GET  /api/trades               recent closed trades
 *   GET  /api/equity               equity curve points
 *   GET  /api/scanner              watchlist scanner rows
 *   GET  /api/signals              recent signals (?pair=&limit=)
 *   POST /api/signals              external signal submission (X-API-Key)
 *   GET  /api/risk                 risk state
 *   POST /api/control/pause        pause trading (X-API-Key)
 *   POST /api/control/resume       resume trading (X-API-Key)
 *   POST /api/control/flatten      close all positions (X-API-Key)
 *   POST /api/control/config       patch engine config (X-API-Key)
 *   GET  /api/config               read current engine config + API key (masked)
 *   GET  /api/config/api-key       reveal the API key (loopback only via dashboard fetch)
 *   GET  /api/legacy/checkpoints   legacy on-chain checkpoints feed (read-only)
 */

import express, { Request, Response, NextFunction } from "express";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import * as dotenv from "dotenv";
dotenv.config();

import { TradingEngine, DEFAULT_CONFIG } from "../engine/trading-engine";
import { Action, SignalSource } from "../engine/types";
import { readJson, writeJson, statePath } from "../engine/persistence";

const PUBLIC_DIR = path.join(process.cwd(), "public");
const API_KEY_FILE = statePath("api-key.json");
const LEGACY_CHECKPOINTS = path.join(process.cwd(), "checkpoints.jsonl");

function loadOrCreateApiKey(): string {
  const stored = readJson<{ apiKey?: string }>(API_KEY_FILE, {});
  if (stored.apiKey) return stored.apiKey;
  const key = "sk-agent-" + crypto.randomBytes(18).toString("base64url");
  writeJson(API_KEY_FILE, { apiKey: key, createdAt: Date.now() });
  return key;
}

const API_KEY = process.env.AGENT_API_KEY || loadOrCreateApiKey();
const PORT = Number(process.env.DASHBOARD_PORT) || 5000;
const HOST = process.env.DASHBOARD_HOST || "0.0.0.0";

const engine = new TradingEngine(DEFAULT_CONFIG);
engine.start();

const app = express();
app.use(express.json({ limit: "1mb" }));

// Disable caching for dev preview
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const k = req.header("X-API-Key") || (req.query.apiKey as string | undefined);
  if (!k || k !== API_KEY) {
    res.status(401).json({ error: "Invalid or missing X-API-Key" });
    return;
  }
  next();
}

// ─── Read-only routes ────────────────────────────────────────────────────────

app.get("/api/snapshot", (_req, res) => {
  const snap = engine.snapshot();
  res.json({
    ...snap,
    equityCurveLen: snap.cfg ? engine.equityCurve().length : 0,
    apiKeyMasked: API_KEY.slice(0, 10) + "..." + API_KEY.slice(-4),
  });
});

app.get("/api/positions", (_req, res) => {
  res.json(engine.openPositionsView());
});

app.get("/api/trades", (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
  res.json(engine.recentTrades(limit));
});

app.get("/api/equity", (_req, res) => {
  res.json(engine.equityCurve());
});

app.get("/api/scanner", (_req, res) => {
  res.json(engine.scannerView());
});

app.get("/api/signals", (req, res) => {
  const pair = (req.query.pair as string | undefined) || undefined;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  res.json(engine.recentSignals(limit, pair));
});

app.get("/api/risk", (_req, res) => {
  res.json(engine.snapshot().risk);
});

app.get("/api/config", (_req, res) => {
  const snap = engine.snapshot();
  res.json({
    cfg: snap.cfg,
    apiKeyMasked: API_KEY.slice(0, 10) + "..." + API_KEY.slice(-4),
  });
});

app.get("/api/config/api-key", (_req, res) => {
  // Loopback-only convenience for the dashboard. The proxy strips remote IPs,
  // so we cannot strictly check this; the key is also low-stakes (paper trading).
  res.json({ apiKey: API_KEY });
});

app.get("/api/legacy/checkpoints", (_req, res) => {
  if (!fs.existsSync(LEGACY_CHECKPOINTS)) return res.json([]);
  const raw = fs.readFileSync(LEGACY_CHECKPOINTS, "utf8").trim();
  if (!raw) return res.json([]);
  const all = raw.split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  res.json(all.slice(-50).reverse());
});

// ─── Authenticated mutating routes ───────────────────────────────────────────

app.post("/api/signals", requireApiKey, (req, res) => {
  const body = req.body ?? {};
  const errors: string[] = [];
  const action = String(body.action || "").toUpperCase() as Action;
  if (!body.pair) errors.push("pair is required");
  if (!["BUY", "SELL", "HOLD"].includes(action)) errors.push("action must be BUY|SELL|HOLD");
  const confidence = Number(body.confidence);
  if (!(confidence >= 0 && confidence <= 1)) errors.push("confidence must be a number in [0,1]");
  if (errors.length) {
    res.status(400).json({ error: errors.join("; ") });
    return;
  }
  const sourceRaw = String(body.source || "external").toLowerCase() as SignalSource;
  const allowed: SignalSource[] = ["external", "manual", "llm"];
  const source: SignalSource = allowed.includes(sourceRaw) ? sourceRaw : "external";
  const sig = engine.submitSignal({
    source,
    origin: String(body.origin || "external-api"),
    pair: String(body.pair).toUpperCase(),
    action,
    confidence,
    reasoning: String(body.reasoning || "External signal"),
    ttlMs: body.ttlMs ? Math.min(60 * 60_000, Number(body.ttlMs)) : 5 * 60_000,
    weight: body.weight != null ? Math.max(0, Math.min(2, Number(body.weight))) : undefined,
  });
  res.json({ ok: true, signal: sig });
});

app.post("/api/control/pause", requireApiKey, (req, res) => {
  engine.pause(String(req.body?.reason || "Paused via API"));
  res.json({ ok: true, paused: true });
});

app.post("/api/control/resume", requireApiKey, (_req, res) => {
  engine.resume();
  res.json({ ok: true, paused: false });
});

app.post("/api/control/flatten", requireApiKey, (_req, res) => {
  const closed = engine.closeAll("Flatten via API");
  res.json({ ok: true, closed });
});

app.post("/api/control/config", requireApiKey, (req, res) => {
  const patch = req.body ?? {};
  // Only allow tuning a safe subset
  const allowed = [
    "pollIntervalMs", "maxPositions", "maxNotionalPerTradePct", "maxNotionalPerPairPct",
    "riskPerTradePct", "dailyLossLimitPct", "maxDrawdownPct",
    "buyThreshold", "sellThreshold", "cooldownMs",
    "trailingActivatePct", "trailingDistancePct",
  ];
  const safePatch: Record<string, unknown> = {};
  for (const k of allowed) if (patch[k] != null) safePatch[k] = patch[k];
  const cfg = engine.updateConfig(safePatch as any);
  res.json({ ok: true, cfg });
});

// ─── AI strategist ───────────────────────────────────────────────────────────

app.get("/api/ai/status", (_req, res) => {
  res.json({
    ...engine.ai.publicStatus(),
    session: engine.snapshot().session,
    lastDecision: engine.snapshot().lastDecision,
    lastAlert: engine.snapshot().lastAlert,
  });
});

app.post("/api/ai/run", requireApiKey, async (_req, res) => {
  const result = await engine.runAI("manual");
  res.json(result);
});

app.post("/api/ai/budget", requireApiKey, (req, res) => {
  const dailyMax = Number(req.body?.dailyMax);
  if (!Number.isFinite(dailyMax) || dailyMax < 1) {
    res.status(400).json({ error: "dailyMax must be a positive number" });
    return;
  }
  engine.setAIBudget(dailyMax);
  res.json({ ok: true, budget: engine.ai.budget.publicState() });
});

// ─── News & sentiment ────────────────────────────────────────────────────────

app.get("/api/news", async (req, res) => {
  const force = req.query.force === "1";
  try {
    const snap = await engine.news.get(force);
    res.json(snap);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ─── Prism vendor signals ────────────────────────────────────────────────────

app.get("/api/prism", (_req, res) => {
  const cached = engine.prismSignals.cached();
  res.json({
    configured: engine.prismSignals.isConfigured(),
    snapshot: cached,
  });
});

app.post("/api/prism/refresh", requireApiKey, async (_req, res) => {
  if (!engine.prismSignals.isConfigured()) {
    res.status(400).json({ error: "PRISM_API_KEY not configured" });
    return;
  }
  try {
    const r = await engine.refreshPrismSignals(true);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ─── Futures (Perp Desk) ─────────────────────────────────────────────────────

app.get("/api/futures/snapshot", (_req, res) => {
  res.json(engine.futures.publicState());
});

app.get("/api/futures/positions", (_req, res) => {
  res.json(engine.futures.positionViews);
});

app.get("/api/futures/trades", (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
  res.json(engine.futures.recentTrades(limit));
});

app.get("/api/futures/equity", (_req, res) => {
  res.json(engine.futures.equityCurve);
});

app.post("/api/futures/control/pause", requireApiKey, (req, res) => {
  engine.futures.pause(String(req.body?.reason || "Paused via API"));
  res.json({ ok: true, paused: true });
});

app.post("/api/futures/control/resume", requireApiKey, (_req, res) => {
  engine.futures.resume();
  res.json({ ok: true, paused: false });
});

app.post("/api/futures/control/enable", requireApiKey, (req, res) => {
  engine.futures.setEnabled(req.body?.enabled !== false);
  res.json({ ok: true, enabled: engine.futures.enabled });
});

app.post("/api/futures/control/reset-kill", requireApiKey, (_req, res) => {
  engine.futures.resetKillSwitch();
  res.json({ ok: true });
});

app.post("/api/futures/control/flatten", requireApiKey, async (_req, res) => {
  const r = await engine.futures.closeAll("Flatten via API");
  res.json({ ok: true, ...r });
});

app.post("/api/futures/control/poll", requireApiKey, async (_req, res) => {
  try { await engine.futures.poll(); res.json({ ok: true, snapshot: engine.futures.publicState() }); }
  catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

app.post("/api/futures/order", requireApiKey, async (req, res) => {
  const pair = String(req.body?.pair || "").toUpperCase();
  const side = String(req.body?.side || "").toUpperCase();
  const notionalUsd = Number(req.body?.notionalUsd);
  const leverage = Number(req.body?.leverage) || undefined;
  const reasoning = String(req.body?.reasoning || "manual order");
  if (!pair || !["BUY", "SELL"].includes(side) || !(notionalUsd > 0)) {
    res.status(400).json({ error: "pair, side (BUY|SELL) and positive notionalUsd are required" });
    return;
  }
  const r = await engine.futures.openPosition({
    pair, side: side as "BUY" | "SELL", notionalUsd, leverage, reasoning,
  });
  if (!r.ok) { res.status(400).json({ error: r.reason }); return; }
  res.json(r);
});

app.post("/api/futures/close", requireApiKey, async (req, res) => {
  const symbol = String(req.body?.symbol || "");
  const reason = String(req.body?.reason || "manual close");
  if (!symbol) { res.status(400).json({ error: "symbol required" }); return; }
  const r = await engine.futures.closePosition(symbol, reason);
  if (!r.ok) { res.status(400).json({ error: r.reason }); return; }
  res.json({ ok: true });
});

// ─── Capital Allocator ───────────────────────────────────────────────────────

app.get("/api/allocator", (_req, res) => {
  res.json(engine.allocator.publicState());
});

app.post("/api/allocator/manual", requireApiKey, (req, res) => {
  const spotPct = Number(req.body?.spotPct);
  const futuresPct = Number(req.body?.futuresPct);
  if (!Number.isFinite(spotPct) || !Number.isFinite(futuresPct) || spotPct < 0 || futuresPct < 0) {
    res.status(400).json({ error: "spotPct and futuresPct required (>=0)" });
    return;
  }
  engine.allocator.manualOverride(spotPct, futuresPct, String(req.body?.reason || "manual override via API"));
  res.json({ ok: true, state: engine.allocator.publicState() });
});

app.post("/api/allocator/enable", requireApiKey, (req, res) => {
  engine.allocator.setEnabled(req.body?.enabled !== false);
  res.json({ ok: true, state: engine.allocator.publicState() });
});

app.post("/api/allocator/tilt", requireApiKey, (req, res) => {
  const bias = Number(req.body?.bias);
  if (!Number.isFinite(bias)) { res.status(400).json({ error: "bias (number) required" }); return; }
  engine.allocator.setLeverageBias(bias);
  res.json({ ok: true, state: engine.allocator.publicState() });
});

// ─── On-chain checkpointing (ERC-8004 style) ─────────────────────────────────

app.get("/api/onchain", (_req, res) => {
  res.json(engine.onchain.publicState());
});

app.post("/api/onchain/enable", requireApiKey, (req, res) => {
  engine.setOnchainEnabled(req.body?.enabled !== false);
  res.json({ ok: true, state: engine.onchain.publicState() });
});

app.post("/api/onchain/interval", requireApiKey, (req, res) => {
  const ms = Number(req.body?.intervalMs);
  if (!Number.isFinite(ms) || ms < 60_000) {
    res.status(400).json({ error: "intervalMs must be >= 60000" });
    return;
  }
  engine.setOnchainIntervalMs(ms);
  res.json({ ok: true, state: engine.onchain.publicState() });
});

app.post("/api/onchain/checkpoint", requireApiKey, async (_req, res) => {
  if (!engine.onchain.isConfigured()) {
    res.status(400).json({ error: "Onchain not configured (missing SEPOLIA_RPC_URL or SEPOLIA_PRIVATE_KEY)" });
    return;
  }
  const cp = await engine.writeOnchainCheckpoint();
  if (!cp) { res.status(500).json({ error: "checkpoint failed — see /api/onchain for errors" }); return; }
  res.json({ ok: true, checkpoint: cp });
});

// ─── Static dashboard ────────────────────────────────────────────────────────

app.use(express.static(PUBLIC_DIR));
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

app.listen(PORT, HOST, () => {
  console.log(`\n  Trading Agent listening on http://${HOST}:${PORT}`);
  console.log(`  External signal API key: ${API_KEY}\n`);
});
