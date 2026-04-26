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

// ── AI strategist ──────────────────────────────────────────────────────────

function renderAI(snap) {
  const ai = snap.ai || {};
  const cfg = ai.budget?.cfg || {};
  const b = ai.budget || {};
  $("ai-model").textContent = ai.configured ? (ai.model || "—") + (ai.hasMistral ? " · mistral" : ai.hasNvidia ? " · nvidia" : "") : "not configured";
  const used = b.used || 0;
  const max = b.cfg?.dailyMax || 0;
  $("ai-budget").textContent = max ? `${used} / ${max}` : "—";
  const pct = max ? Math.min(100, (used / max) * 100) : 0;
  $("ai-budget-fill").style.width = pct + "%";
  $("ai-budget-fill").style.background = pct > 80 ? "var(--sell)" : pct > 50 ? "var(--warn)" : "var(--buy)";
  const session = snap.session;
  $("ai-session").textContent = session ? `${session.session} · ${(session.sizingMultiplier * 100).toFixed(0)}% sizing${!session.allowEntries ? " · entries blocked" : ""}` : "—";
  $("ai-last").textContent = ai.lastResult ? `${fmtTime(ai.lastResult.ts)} (${ai.lastResult.reason})${ai.lastResult.error ? " — " + ai.lastResult.error : ""}` : "—";
  const dec = ai.lastResult?.decision || snap.lastDecision;
  if (dec) {
    $("ai-regime").textContent = dec.regime || "—";
    $("ai-regime").className = "ai-val pill " + regimeClass(dec.regime);
    $("ai-thesis").textContent = dec.thesis || "—";
    const parts = [];
    if (dec.configPatch && Object.keys(dec.configPatch).length) {
      parts.push(`<span class="ai-act ai-act-cfg">cfg patch: ${Object.entries(dec.configPatch).map(([k,v]) => `${k}=${v}`).join(", ")}</span>`);
    }
    if (dec.exits?.length) {
      parts.push(...dec.exits.map(e => `<span class="ai-act ai-act-exit">EXIT ${e.pair} (${e.urgency}): ${e.reason}</span>`));
    }
    if (dec.signals?.length) {
      parts.push(...dec.signals.map(s => `<span class="ai-act ai-act-signal">${s.action} ${s.pair} ${(s.confidence*100).toFixed(0)}%: ${s.reasoning}</span>`));
    }
    if (dec.pause) parts.push('<span class="ai-act ai-act-exit">PAUSE</span>');
    if (dec.resume) parts.push('<span class="ai-act ai-act-cfg">RESUME</span>');
    $("ai-actions").innerHTML = parts.join("");
  }
  $("ai-sub").textContent = `${b.history?.length || 0} calls today · resets in ${fmtCountdown(b.resetsAt)}`;

  // Alert banner
  if (snap.lastAlert?.text && Date.now() - snap.lastAlert.ts < 60 * 60_000) {
    if ($("ai-alert").dataset.shownTs !== String(snap.lastAlert.ts)) {
      $("ai-alert").classList.remove("hidden");
      $("ai-alert-text").textContent = snap.lastAlert.text;
      $("ai-alert").dataset.shownTs = String(snap.lastAlert.ts);
    }
  }
}

function regimeClass(r) {
  switch (r) {
    case "trending_up": return "pill-ok";
    case "trending_down": return "pill-bad";
    case "volatile": return "pill-warn";
    case "crisis": return "pill-bad";
    case "ranging": return "pill-muted";
    default: return "pill-muted";
  }
}
function fmtCountdown(ts) {
  if (!ts) return "—";
  const ms = Math.max(0, ts - Date.now());
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h + "h " + m + "m";
}

// ── News ───────────────────────────────────────────────────────────────────

function renderNews(snap) {
  const news = snap.news;
  if (!news) {
    $("news-sub").textContent = "—";
    $("fg-value").textContent = "—";
    $("fg-fill").style.width = "0%";
    $("fg-label").textContent = "—";
    $("trending-list").textContent = "—";
    $("news-feed").innerHTML = '<div class="empty">no news loaded</div>';
    return;
  }
  $("news-sub").textContent = news.articles?.length + " headlines · " + fmtTime(news.fetchedAt);
  const fg = news.sentiment?.fearGreed;
  if (fg) {
    $("fg-value").textContent = Math.round(fg.value);
    $("fg-fill").style.width = Math.min(100, fg.value) + "%";
    $("fg-fill").style.background = fg.value < 25 ? "var(--sell)" : fg.value < 45 ? "#ff9d3a" : fg.value < 55 ? "var(--hold)" : fg.value < 75 ? "#7ec96b" : "var(--buy)";
    $("fg-label").textContent = fg.label;
  } else {
    $("fg-value").textContent = "—";
    $("fg-fill").style.width = "0%";
    $("fg-label").textContent = "—";
  }
  const trending = news.sentiment?.trending || [];
  $("trending-list").innerHTML = trending.length
    ? trending.map(t => `<span class="trending-pill">${t.symbol}</span>`).join("")
    : "—";

  const articles = news.articles || [];
  $("news-feed").innerHTML = articles.length
    ? articles.map(a => {
        const url = a.url ? `<a href="${a.url}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a>` : escapeHtml(a.title);
        const meta = [a.source, a.publishedAt ? fmtTime(a.publishedAt) : null].filter(Boolean).join(" · ");
        return `<div class="news-item"><div class="news-title">${url}</div><div class="news-meta">${meta}</div></div>`;
      }).join("")
    : '<div class="empty">no news loaded</div>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// ── On-chain ───────────────────────────────────────────────────────────────

function renderOnchain(snap) {
  const oc = snap.onchain;
  if (!oc || !oc.configured) {
    $("oc-status").textContent = "NOT CONFIGURED";
    $("oc-status").className = "ai-val pill pill-muted";
    $("oc-address").textContent = "set SEPOLIA_RPC_URL + SEPOLIA_PRIVATE_KEY";
    $("oc-balance").textContent = "—";
    $("onchain-sub").textContent = "disabled";
    $("btn-oc-toggle").disabled = true;
    $("btn-oc-now").disabled = true;
    return;
  }
  $("btn-oc-toggle").disabled = false;
  $("btn-oc-now").disabled = false;
  if (oc.enabled) {
    $("oc-status").textContent = "ENABLED";
    $("oc-status").className = "ai-val pill pill-ok";
    $("btn-oc-toggle").textContent = "Disable";
  } else {
    $("oc-status").textContent = "DISABLED";
    $("oc-status").className = "ai-val pill pill-warn";
    $("btn-oc-toggle").textContent = "Enable";
  }
  $("oc-address").textContent = oc.address || "—";
  $("oc-balance").textContent = oc.balanceEth != null ? oc.balanceEth.toFixed(5) + " ETH" : "—";
  $("onchain-sub").textContent = `${oc.checkpoints?.length || 0} anchors`;
  if (document.activeElement?.id !== "oc-interval") {
    $("oc-interval").value = String(oc.intervalMs);
  }
  const list = oc.checkpoints || [];
  $("oc-list").innerHTML = list.length
    ? list.slice(0, 5).map(c => `
        <div class="oc-item">
          <span class="oc-time">${fmtTime(c.ts)}</span>
          <span class="oc-eq">eq $${c.payloadSummary?.equity?.toFixed(2) ?? "—"}</span>
          <a href="${c.explorerUrl}" target="_blank" rel="noopener" class="oc-tx">${c.txHash.slice(0,10)}…${c.txHash.slice(-6)}</a>
        </div>`).join("")
    : '<div class="empty">no checkpoints yet</div>';
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
    renderAI(snap);
    renderNews(snap);
    renderOnchain(snap);
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

  // AI strategist
  $("btn-ai-run").addEventListener("click", async () => {
    const btn = $("btn-ai-run"); const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "thinking…";
    try {
      const r = await authedApi("/api/ai/run", {});
      if (!r.ok) alert("AI: " + (r.error || "failed"));
    } catch (e) { alert("AI error: " + e.message); }
    finally { btn.disabled = false; btn.textContent = orig; refreshAll(); }
  });
  $("btn-ai-cap-apply").addEventListener("click", async () => {
    const v = Number($("ai-cap").value);
    const r = await authedApi("/api/ai/budget", { dailyMax: v });
    if (!r.ok) alert(r.error || "failed");
    refreshAll();
  });
  $("ai-alert-close").addEventListener("click", () => $("ai-alert").classList.add("hidden"));

  // On-chain controls
  $("btn-oc-toggle").addEventListener("click", async () => {
    const isOn = $("btn-oc-toggle").textContent.trim().toLowerCase().startsWith("dis");
    const r = await authedApi("/api/onchain/enable", { enabled: !isOn });
    if (!r.ok) alert(r.error || "failed");
    refreshAll();
  });
  $("btn-oc-now").addEventListener("click", async () => {
    if (!confirm("Send a Sepolia transaction now to anchor a checkpoint?")) return;
    const btn = $("btn-oc-now"); const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "broadcasting…";
    try {
      const r = await authedApi("/api/onchain/checkpoint", {});
      if (!r.ok) alert(r.error || "failed");
    } catch (e) { alert("error: " + e.message); }
    finally { btn.disabled = false; btn.textContent = orig; refreshAll(); }
  });
  $("oc-interval").addEventListener("change", async (e) => {
    const r = await authedApi("/api/onchain/interval", { intervalMs: Number(e.target.value) });
    if (!r.ok) alert(r.error || "failed");
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
