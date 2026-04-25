// Trading Agent Dashboard — client logic
const state = { apiKey: null, cfg: null, watchlist: [] };

const $ = (id) => document.getElementById(id);

const fmtUsd = (n, d = 2) => n == null || isNaN(n) ? "$—"
  : (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPct = (n, d = 2) => n == null || isNaN(n) ? "—"
  : (n >= 0 ? "+" : "") + n.toFixed(d) + "%";
const fmtNum = (n, d = 2) => n == null || isNaN(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtTime = (ts) => {
  const d = new Date(typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts);
  return d.toLocaleTimeString("en-US", { hour12: false });
};
const fmtDur = (ms) => {
  if (ms < 1000) return ms + "ms";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m";
  const h = Math.round(m / 60);
  return h + "h";
};
const cssDir = (n) => n > 0 ? "up" : n < 0 ? "down" : "";

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

async function authedApi(path, body) {
  if (!state.apiKey) {
    const r = await fetch("/api/config/api-key");
    state.apiKey = (await r.json()).apiKey;
  }
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": state.apiKey },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

// ── Snapshot rendering ─────────────────────────────────────────────────────

function renderSnapshot(snap) {
  // Mode badge
  const badge = $("mode-badge");
  if (snap.risk?.killSwitch) {
    badge.textContent = "KILL SWITCH";
    badge.className = "badge badge-killed";
  } else if (snap.risk?.paused) {
    badge.textContent = "PAUSED";
    badge.className = "badge badge-paused";
  } else {
    badge.textContent = "LIVE · PAPER";
    badge.className = "badge badge-live";
  }

  $("data-source").textContent = `data: ${snap.syntheticMode ? "synthetic" : "kraken public"}`;
  $("last-update").textContent = "tick " + fmtTime(snap.lastTickAt || Date.now());

  // KPIs
  const equity = snap.equity ?? 0;
  const start = snap.cfg?.startingCashUsd ?? 0;
  const totalPnl = (snap.realizedPnl || 0) + (snap.unrealizedPnl || 0);
  const totalRetPct = start > 0 ? (totalPnl / start) * 100 : 0;
  $("kpi-equity").textContent = fmtUsd(equity);
  $("kpi-equity-sub").textContent = `cash ${fmtUsd(snap.cash)} · pos ${fmtUsd(snap.positionsValue)}`;
  const vEquity = $("kpi-equity"); vEquity.className = "kpi-value " + cssDir(totalPnl);

  $("kpi-total-pnl").textContent = fmtUsd(totalPnl);
  $("kpi-total-pnl").className = "kpi-value " + cssDir(totalPnl);
  $("kpi-total-pnl-sub").textContent = fmtPct(totalRetPct);
  $("kpi-total-pnl-sub").className = "kpi-foot " + cssDir(totalPnl);

  $("kpi-day-pnl").textContent = fmtUsd(snap.risk?.dailyPnl);
  $("kpi-day-pnl").className = "kpi-value " + cssDir(snap.risk?.dailyPnl);
  $("kpi-day-pnl-sub").textContent = fmtPct(snap.risk?.dailyPnlPct);
  $("kpi-day-pnl-sub").className = "kpi-foot " + cssDir(snap.risk?.dailyPnl);

  const perf = snap.performance ?? {};
  $("kpi-winrate").textContent = perf.closedCount ? (perf.winRate * 100).toFixed(0) + "%" : "—";
  $("kpi-winrate-sub").textContent = (perf.closedCount || 0) + " trades";
  $("kpi-pf").textContent = perf.profitFactor && isFinite(perf.profitFactor) ? perf.profitFactor.toFixed(2) : (perf.closedCount ? "∞" : "—");
  $("kpi-pf-sub").textContent = `avg ${(perf.avgWinPct || 0).toFixed(2)}% / ${(perf.avgLossPct || 0).toFixed(2)}%`;
  $("kpi-sharpe").textContent = perf.sharpe ? perf.sharpe.toFixed(2) : "—";
  $("kpi-mdd").textContent = perf.maxDrawdownPct ? "-" + perf.maxDrawdownPct.toFixed(2) + "%" : "—";
  $("kpi-mdd-sub").textContent = "fees " + fmtUsd(perf.feesPaid);

  $("kpi-exp").textContent = fmtUsd(snap.positionsValue);
  $("kpi-exp-sub").textContent = (snap.open?.length || 0) + " positions · " + (snap.risk?.exposurePct || 0).toFixed(1) + "%";

  // Risk strip
  const r = snap.risk || {};
  const killEl = $("risk-kill");
  if (r.killSwitch) { killEl.textContent = "TRIPPED"; killEl.className = "pill pill-bad"; }
  else if (r.paused) { killEl.textContent = "PAUSED"; killEl.className = "pill pill-warn"; }
  else { killEl.textContent = "ARMED"; killEl.className = "pill pill-ok"; }
  $("risk-kill-reason").textContent = r.killReason || "";

  const dailyPct = Math.min(100, Math.abs(r.dailyPnlPct || 0) / (snap.cfg?.dailyLossLimitPct || 5) * 100);
  $("meter-daily").style.width = dailyPct + "%";
  $("meter-daily-text").textContent = `${(r.dailyPnlPct || 0).toFixed(2)}% / -${snap.cfg?.dailyLossLimitPct}%`;

  const ddPct = Math.min(100, (r.drawdownPct || 0) / (snap.cfg?.maxDrawdownPct || 15) * 100);
  $("meter-dd").style.width = ddPct + "%";
  $("meter-dd-text").textContent = `${(r.drawdownPct || 0).toFixed(2)}% / ${snap.cfg?.maxDrawdownPct}%`;

  const expPct = Math.min(100, r.exposurePct || 0);
  $("meter-exp").style.width = expPct + "%";
  $("meter-exp-text").textContent = `${(r.exposurePct || 0).toFixed(1)}% of equity`;

  // Open positions
  const open = snap.open || [];
  $("positions-sub").textContent = `${open.length} open · uPnL ${fmtUsd(snap.unrealizedPnl)}`;
  const tbody = $("positions-body");
  if (!open.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-row">no open positions</td></tr>';
  } else {
    tbody.innerHTML = open.map(p => `
      <tr>
        <td>${p.pair}</td>
        <td class="tag-${p.side === 'BUY' ? 'buy' : 'sell'}">${p.side}</td>
        <td class="r">${fmtNum(p.qty, 6)}</td>
        <td class="r">${fmtUsd(p.entryPrice, 4)}</td>
        <td class="r">${fmtUsd(p.currentPrice, 4)}</td>
        <td class="r"><span title="stop / take-profit">${fmtUsd(p.stopPrice, 4)} / ${fmtUsd(p.takeProfit, 4)}</span></td>
        <td class="r ${cssDir(p.unrealizedPnl)}">${fmtUsd(p.unrealizedPnl)} (${fmtPct(p.unrealizedPnlPct)})</td>
        <td><span class="src-tag ${p.source}">${p.source}</span></td>
      </tr>`).join("");
  }

  // Cache cfg + watchlist
  state.cfg = snap.cfg;
  state.watchlist = snap.cfg?.watchlist || [];
  populatePairSelect();
  syncCfgInputs(snap.cfg);
}

// ── Scanner ────────────────────────────────────────────────────────────────

function renderScanner(rows) {
  $("scanner-sub").textContent = rows.length + " pairs";
  const body = $("scanner-body");
  if (!rows.length) { body.innerHTML = '<tr><td colspan="7" class="empty-row">scanning...</td></tr>'; return; }
  body.innerHTML = rows.map(r => {
    const scoreColor = r.action === "BUY" ? "var(--buy)" : r.action === "SELL" ? "var(--sell)" : "var(--hold)";
    return `
      <tr>
        <td><strong>${r.pair}</strong></td>
        <td class="r">${fmtUsd(r.price, r.price < 1 ? 5 : 2)}</td>
        <td class="r">${r.rsi != null ? r.rsi.toFixed(1) : "—"}</td>
        <td class="r">${r.macdHist != null ? (r.macdHist >= 0 ? "+" : "") + r.macdHist.toFixed(3) : "—"}</td>
        <td>${r.trend}</td>
        <td class="r">${(r.score * 100).toFixed(0)}<span class="score-bar"><span class="score-fill" style="width:${(r.score*100).toFixed(0)}%; background:${scoreColor}"></span></span></td>
        <td class="tag-${r.action.toLowerCase()}">${r.action}</td>
      </tr>`;
  }).join("");
}

// ── Trades ─────────────────────────────────────────────────────────────────

function renderTrades(trades) {
  $("trades-sub").textContent = trades.length + " recent";
  const body = $("trades-body");
  if (!trades.length) { body.innerHTML = '<tr><td colspan="8" class="empty-row">no closed trades yet</td></tr>'; return; }
  body.innerHTML = trades.map(t => `
    <tr>
      <td>${t.pair}</td>
      <td class="tag-${t.side === 'BUY' ? 'buy' : 'sell'}">${t.side}</td>
      <td class="r">${fmtUsd(t.entryPrice, 4)}</td>
      <td class="r">${fmtUsd(t.exitPrice, 4)}</td>
      <td class="r ${cssDir(t.pnlUsd)}">${fmtUsd(t.pnlUsd)}</td>
      <td class="r ${cssDir(t.pnlUsd)}">${fmtPct(t.pnlPct)}</td>
      <td title="${t.reasonClose}">${t.reasonClose}</td>
      <td class="r">${fmtDur(t.closedAt - t.openedAt)}</td>
    </tr>`).join("");
}

// ── Signals ────────────────────────────────────────────────────────────────

function renderSignals(sigs) {
  $("signals-sub").textContent = sigs.length + " in window";
  const feed = $("signals-feed");
  if (!sigs.length) { feed.innerHTML = '<div class="empty">waiting for signals...</div>'; return; }
  feed.innerHTML = sigs.map(s => `
    <div class="feed-item">
      <span class="feed-time">${fmtTime(s.createdAt)}</span>
      <span class="src-tag ${s.source}">${s.source}</span>
      <span class="feed-body" title="${(s.reasoning || '').replace(/"/g,'&quot;')}">
        <strong class="tag-${(s.action || 'HOLD').toLowerCase()}">${s.action}</strong>
        <strong>${s.pair}</strong> — ${s.reasoning || '—'}
      </span>
      <span class="feed-confidence">${Math.round((s.confidence || 0) * 100)}%</span>
    </div>`).join("");
}

// ── Equity chart (canvas) ──────────────────────────────────────────────────

function drawEquity(points) {
  const canvas = $("chart-equity");
  const ctx = canvas.getContext("2d");
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  $("equity-sub").textContent = points.length + " samples";
  if (points.length < 2) {
    ctx.fillStyle = "#8a93a3"; ctx.font = "11px JetBrains Mono"; ctx.textAlign = "center";
    ctx.fillText("collecting data...", W / 2, H / 2);
    return;
  }
  const ys = points.map(p => p.equity);
  let min = Math.min(...ys), max = Math.max(...ys);
  const startEq = points[0].equity;
  min = Math.min(min, startEq); max = Math.max(max, startEq);
  const pad = (max - min) * 0.1 || max * 0.005;
  min -= pad; max += pad;
  const range = max - min || 1;
  const padL = 50, padR = 12, padT = 12, padB = 24;
  const x = i => padL + (i / (points.length - 1)) * (W - padL - padR);
  const y = v => H - padB - ((v - min) / range) * (H - padT - padB);

  // Grid + y-axis labels
  ctx.strokeStyle = "#1a2029"; ctx.lineWidth = 1;
  ctx.fillStyle = "#8a93a3"; ctx.font = "9px JetBrains Mono"; ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = min + (range * i / 4);
    const yy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.fillText("$" + v.toFixed(0), padL - 6, yy + 3);
  }

  // Starting equity baseline
  const startY = y(startEq);
  ctx.strokeStyle = "#5a4318"; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(padL, startY); ctx.lineTo(W - padR, startY); ctx.stroke();
  ctx.setLineDash([]);

  // Area fill
  const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
  const last = ys[ys.length - 1];
  const isUp = last >= startEq;
  grad.addColorStop(0, isUp ? "rgba(41,196,111,0.25)" : "rgba(255,93,93,0.25)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.beginPath();
  ctx.moveTo(x(0), y(ys[0]));
  for (let i = 1; i < ys.length; i++) ctx.lineTo(x(i), y(ys[i]));
  ctx.lineTo(x(ys.length - 1), H - padB);
  ctx.lineTo(x(0), H - padB); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(x(0), y(ys[0]));
  for (let i = 1; i < ys.length; i++) ctx.lineTo(x(i), y(ys[i]));
  ctx.strokeStyle = isUp ? "#29c46f" : "#ff5d5d"; ctx.lineWidth = 1.6;
  ctx.stroke();

  // Last dot
  ctx.beginPath();
  ctx.arc(x(ys.length - 1), y(ys[ys.length - 1]), 3, 0, Math.PI * 2);
  ctx.fillStyle = isUp ? "#29c46f" : "#ff5d5d"; ctx.fill();
}

// ── Form helpers ───────────────────────────────────────────────────────────

function populatePairSelect() {
  const sel = $("sig-pair");
  if (sel.options.length === state.watchlist.length) return;
  const cur = sel.value;
  sel.innerHTML = state.watchlist.map(p => `<option value="${p}">${p}</option>`).join("");
  if (cur) sel.value = cur;
}

function syncCfgInputs(cfg) {
  if (!cfg) return;
  const map = [
    ["cfg-rpt", "riskPerTradePct"], ["cfg-mp", "maxPositions"], ["cfg-mnt", "maxNotionalPerTradePct"],
    ["cfg-dll", "dailyLossLimitPct"], ["cfg-mdd", "maxDrawdownPct"],
    ["cfg-bt", "buyThreshold"], ["cfg-st", "sellThreshold"],
    ["cfg-ta", "trailingActivatePct"], ["cfg-td", "trailingDistancePct"],
  ];
  for (const [id, key] of map) {
    const el = $(id);
    if (!el || cfg[key] == null) continue;
    if (document.activeElement === el) continue; // don't fight user input
    el.value = cfg[key];
    const lbl = $(id + "-val"); if (lbl) lbl.textContent = cfg[key];
  }
}

// ── Live update loop ───────────────────────────────────────────────────────

let chartCache = [];
async function refreshAll() {
  try {
    const [snap, scanner, trades, signals, eq] = await Promise.all([
      api("/api/snapshot"),
      api("/api/scanner"),
      api("/api/trades?limit=20"),
      api("/api/signals?limit=40"),
      api("/api/equity"),
    ]);
    renderSnapshot(snap);
    renderScanner(scanner);
    renderTrades(trades);
    renderSignals(signals);
    chartCache = eq;
    drawEquity(eq);
  } catch (e) {
    $("mode-badge").textContent = "OFFLINE";
    $("mode-badge").className = "badge badge-killed";
    console.warn("refresh error", e);
  }
}

window.addEventListener("resize", () => drawEquity(chartCache));

// ── Event wiring ───────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Sliders live label
  for (const id of ["cfg-rpt","cfg-mp","cfg-mnt","cfg-dll","cfg-mdd","cfg-bt","cfg-st","cfg-ta","cfg-td"]) {
    const el = $(id), lbl = $(id + "-val");
    if (!el || !lbl) continue;
    el.addEventListener("input", () => lbl.textContent = el.value);
  }
  $("sig-conf").addEventListener("input", e => $("sig-conf-val").textContent = e.target.value);
  $("sig-weight").addEventListener("input", e => $("sig-weight-val").textContent = e.target.value);

  // Controls
  $("btn-pause").addEventListener("click", async () => {
    await authedApi("/api/control/pause", { reason: "Paused via dashboard" });
    refreshAll();
  });
  $("btn-resume").addEventListener("click", async () => {
    await authedApi("/api/control/resume", {});
    refreshAll();
  });
  $("btn-flatten").addEventListener("click", async () => {
    if (!confirm("Close all open positions at market?")) return;
    await authedApi("/api/control/flatten", {});
    refreshAll();
  });

  // Submit signal
  $("signal-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("signal-status");
    status.textContent = "publishing...";
    status.className = "form-status";
    try {
      const ttlMs = Math.max(10, Number($("sig-ttl").value)) * 1000;
      const r = await authedApi("/api/signals", {
        pair: $("sig-pair").value,
        action: $("sig-action").value,
        confidence: Number($("sig-conf").value),
        source: $("sig-source").value,
        origin: $("sig-origin").value,
        reasoning: $("sig-reason").value,
        weight: Number($("sig-weight").value),
        ttlMs,
      });
      if (r.ok) { status.textContent = "Published " + r.signal.id; status.className = "form-status ok"; }
      else { status.textContent = r.error || "Error"; status.className = "form-status err"; }
      refreshAll();
    } catch (e) {
      status.textContent = "Error: " + e.message; status.className = "form-status err";
    }
  });

  // Config patch
  $("cfg-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("cfg-status");
    status.textContent = "applying...";
    const patch = {
      riskPerTradePct: Number($("cfg-rpt").value),
      maxPositions: Number($("cfg-mp").value),
      maxNotionalPerTradePct: Number($("cfg-mnt").value),
      dailyLossLimitPct: Number($("cfg-dll").value),
      maxDrawdownPct: Number($("cfg-mdd").value),
      buyThreshold: Number($("cfg-bt").value),
      sellThreshold: Number($("cfg-st").value),
      trailingActivatePct: Number($("cfg-ta").value),
      trailingDistancePct: Number($("cfg-td").value),
    };
    const r = await authedApi("/api/control/config", patch);
    status.textContent = r.ok ? "Config applied" : (r.error || "Error");
    status.className = r.ok ? "form-status ok" : "form-status err";
    refreshAll();
  });

  // API key reveal/copy
  $("btn-reveal-key").addEventListener("click", async () => {
    const r = await fetch("/api/config/api-key");
    const j = await r.json();
    state.apiKey = j.apiKey;
    $("api-key-display").textContent = j.apiKey;
  });
  $("btn-copy-key").addEventListener("click", async () => {
    if (!state.apiKey) {
      const r = await fetch("/api/config/api-key");
      state.apiKey = (await r.json()).apiKey;
    }
    navigator.clipboard.writeText(state.apiKey).catch(() => {});
    const btn = $("btn-copy-key"); btn.textContent = "Copied!"; setTimeout(() => btn.textContent = "Copy", 1200);
  });

  // Curl URL: use page origin
  $("curl-url").textContent = window.location.origin + "/api/signals";

  refreshAll();
  setInterval(refreshAll, 4000);
});
