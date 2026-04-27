// Trading Agent Dashboard — client logic
const state = { apiKey: null, cfg: null, watchlist: [], activeTab: "spot", futCfg: null };

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

  // Combined bar (always visible across tabs)
  renderCombinedBar(snap);
}

// ── Combined header (spot + perp) ──────────────────────────────────────────

function renderCombinedBar(snap) {
  const spotEq = snap.equity ?? 0;
  const futEq = snap.futures?.portfolioValue ?? 0;
  const combined = snap.combinedEquity ?? (spotEq + futEq);
  const dayPnlSpot = snap.risk?.dailyPnl ?? 0;
  const dayPnlFut = snap.futures?.dailyPnl ?? 0;
  const totalDay = dayPnlSpot + dayPnlFut;

  $("ck-combined").textContent = fmtUsd(combined);
  $("ck-combined-sub").textContent = `spot ${fmtUsd(spotEq)} · perp ${fmtUsd(futEq)}`;

  $("ck-day").textContent = fmtUsd(totalDay);
  $("ck-day").className = "ckpi-value " + cssDir(totalDay);
  $("ck-day-sub").textContent = `spot ${fmtUsd(dayPnlSpot)} · perp ${fmtUsd(dayPnlFut)}`;

  const a = snap.allocator;
  if (a) {
    $("ck-alloc-target").textContent = `${a.spotTargetPct.toFixed(0)} / ${a.futuresTargetPct.toFixed(0)}`;
    $("ck-alloc-actual").textContent = `actual ${a.spotActualPct.toFixed(0)} / ${a.futuresActualPct.toFixed(0)}`;
    $("ck-tilt").textContent = (a.leverageBias > 0 ? "+" : "") + a.leverageBias.toFixed(2);
    $("ck-tilt").className = "ckpi-value " + (a.leverageBias > 0.1 ? "up" : a.leverageBias < -0.1 ? "down" : "");
    const nextIn = Math.max(0, a.nextRebalanceAt - Date.now());
    $("ck-rebalance").textContent = a.frozenUntil > Date.now()
      ? `frozen ${fmtCountdown(a.frozenUntil)}`
      : `next rebal ${fmtCountdown(a.nextRebalanceAt)}`;
    $("alloc-bar-spot").style.width = a.spotTargetPct + "%";
    $("alloc-bar-fut").style.width  = a.futuresTargetPct + "%";
    $("alloc-reason").textContent = a.reason || "—";

    // Mirror to allocator panel inside futures tab
    $("alloc-spot-target").textContent = a.spotTargetPct.toFixed(0) + "%";
    $("alloc-fut-target").textContent  = a.futuresTargetPct.toFixed(0) + "%";
    $("alloc-last").textContent = a.lastRebalanceAt ? fmtTime(a.lastRebalanceAt) : "never";
    $("alloc-next").textContent = a.nextRebalanceAt ? fmtTime(a.nextRebalanceAt) : "—";
    $("alloc-frozen").textContent = a.frozenUntil > Date.now() ? `until ${fmtTime(a.frozenUntil)}` : "no";
    $("alloc-sub").textContent = `${a.history?.length || 0} rebalances · ${a.enabled ? "enabled" : "disabled"}`;
    if (document.activeElement?.id !== "alloc-spot-input") $("alloc-spot-input").value = a.spotTargetPct.toFixed(0);
    if (document.activeElement?.id !== "alloc-fut-input")  $("alloc-fut-input").value  = a.futuresTargetPct.toFixed(0);
  }
}

// ── Futures rendering ──────────────────────────────────────────────────────

function renderFutures(snap) {
  const f = snap.futures;
  if (!f) return;
  state.futCfg = f.cfg;

  // Sub line + status
  const lev = f.cfg?.maxLeverage || 0;
  const dlev = f.cfg?.defaultLeverage || 0;
  $("fut-sub").textContent = f.configured
    ? (f.lastPollAt ? `last poll ${fmtTime(f.lastPollAt)}` : "warming up...")
    : "not configured (set KRAKEN_FUTURES_DEMO_KEY/SECRET)";

  // KPIs
  $("fut-kpi-equity").textContent = fmtUsd(f.portfolioValue);
  $("fut-kpi-avail").textContent  = fmtUsd(f.availableMargin);
  $("fut-kpi-avail-sub").textContent = `init margin ${fmtUsd(f.initialMargin)}`;
  $("fut-kpi-upnl").textContent = fmtUsd(f.unrealizedPnl);
  $("fut-kpi-upnl").className   = "kpi-value " + cssDir(f.unrealizedPnl);
  $("fut-kpi-upnl-sub").textContent = (f.positions?.length || 0) + " positions";
  $("fut-kpi-day").textContent  = fmtUsd(f.dailyPnl);
  $("fut-kpi-day").className    = "kpi-value " + cssDir(f.dailyPnl);
  $("fut-kpi-day-sub").textContent = fmtPct(f.dailyPnlPct);
  $("fut-kpi-day-sub").className   = "kpi-foot " + cssDir(f.dailyPnl);
  $("fut-kpi-lev").textContent  = lev ? lev + "x" : "—";
  $("fut-kpi-lev-sub").textContent = `default ${dlev}x · cap ${lev}x`;

  let status = "ARMED", statusCls = "up";
  if (!f.configured) { status = "OFFLINE"; statusCls = ""; }
  else if (f.killSwitch) { status = "KILL SWITCH"; statusCls = "down"; }
  else if (f.paused)     { status = "PAUSED"; statusCls = "down"; }
  else if (!f.enabled)   { status = "DISABLED"; statusCls = ""; }
  $("fut-kpi-status").textContent = status;
  $("fut-kpi-status").className = "kpi-value " + statusCls;
  $("fut-kpi-status-sub").textContent = f.killReason || f.pauseReason || f.lastError || "ok";

  // Positions
  const pos = f.positions || [];
  $("fut-pos-sub").textContent = `${pos.length} open · uPnL ${fmtUsd(f.unrealizedPnl)}`;
  const pbody = $("fut-pos-body");
  if (!pos.length) {
    pbody.innerHTML = '<tr><td colspan="11" class="empty-row">no open perp positions</td></tr>';
  } else {
    pbody.innerHTML = pos.map(p => {
      const liqDist = p.liqDistancePct;
      const liqCls = liqDist == null ? "" : liqDist < 5 ? "liq-near" : liqDist < 15 ? "liq-mid" : "liq-far";
      return `
      <tr>
        <td><strong>${p.symbol}</strong></td>
        <td class="tag-${p.side === 'long' ? 'buy' : 'sell'}">${p.side.toUpperCase()}</td>
        <td class="r">${fmtNum(p.size, 4)}</td>
        <td class="r">${fmtUsd(p.notionalUsd)}</td>
        <td class="r">${fmtUsd(p.entryPrice, 2)}</td>
        <td class="r">${fmtUsd(p.markPrice, 2)}</td>
        <td class="r"><span class="lev-pill">${p.leverage ? p.leverage.toFixed(1) + "x" : "—"}</span></td>
        <td class="r ${liqCls}">${p.liquidationPrice ? fmtUsd(p.liquidationPrice, 2) : "—"}<br><small>${liqDist != null ? liqDist.toFixed(1) + "% away" : ""}</small></td>
        <td class="r ${cssDir(p.unrealizedPnlUsd)}">${fmtUsd(p.unrealizedPnlUsd)}<br><small>${fmtPct(p.unrealizedPnlPct)}</small></td>
        <td class="r ${cssDir(-p.unrealizedFundingUsd)}">${fmtUsd(p.unrealizedFundingUsd)}<br><small>${p.fundingRate != null ? (p.fundingRate * 100).toFixed(4) + "%" : "—"}</small></td>
        <td class="r"><button class="fut-close-btn" data-close="${p.symbol}">CLOSE</button></td>
      </tr>`;
    }).join("");
    // Wire close buttons
    pbody.querySelectorAll("[data-close]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm(`Close ${btn.dataset.close} at market?`)) return;
        btn.disabled = true; btn.textContent = "…";
        try {
          const r = await authedApi("/api/futures/close", { symbol: btn.dataset.close, reason: "manual close from dashboard" });
          if (!r.ok) alert(r.error || "close failed");
        } catch (e) { alert("close error: " + e.message); }
        finally { refreshAll(); }
      });
    });
  }

  // Funding ticker — derived from positions for now (one fundingRate per perp held).
  const fund = $("fut-funding");
  if (!pos.length) {
    fund.innerHTML = '<div class="empty">no open perps — funding ticker shows held perps only</div>';
  } else {
    fund.innerHTML = pos.map(p => {
      const r8 = p.fundingRate;
      const color = r8 == null ? "" : r8 > 0 ? "down" : "up"; // positive funding = longs pay
      return `
        <div class="prism-cell ${r8 == null ? 'prism-n' : (r8 > 0 ? 'prism-be' : 'prism-b')}">
          <div class="prism-row1">
            <span class="prism-pair">${p.symbol}</span>
            <span class="prism-px">${fmtUsd(p.markPrice, 2)}</span>
          </div>
          <div class="prism-row2">
            <span class="prism-overall">${p.side.toUpperCase()}</span>
            <span class="prism-net ${color}">${r8 != null ? (r8 * 100).toFixed(4) + "%/8h" : "—"}</span>
          </div>
          <div class="prism-reasons">unreal funding: ${fmtUsd(p.unrealizedFundingUsd)}</div>
        </div>`;
    }).join("");
  }
  $("fut-fund-sub").textContent = pos.length ? `${pos.length} active perps` : "no active perps";

  // Pair select for manual order — use mapped spot pairs (engine maps to PF_*)
  populateFutPairSelect();
}

function populateFutPairSelect() {
  const sel = $("fut-pair");
  if (sel.options.length === state.watchlist.length || !state.watchlist.length) return;
  const cur = sel.value;
  sel.innerHTML = state.watchlist.map(p => `<option value="${p}">${p}</option>`).join("");
  if (cur) sel.value = cur;
}

function renderFuturesTrades(trades) {
  $("fut-trades-sub").textContent = trades.length + " recent";
  const body = $("fut-trades-body");
  if (!trades.length) { body.innerHTML = '<tr><td colspan="9" class="empty-row">no closed perp trades yet</td></tr>'; return; }
  body.innerHTML = trades.map(t => `
    <tr>
      <td>${t.pair}</td>
      <td class="tag-${t.side === 'BUY' ? 'buy' : 'sell'}">${t.side}</td>
      <td class="r">${fmtUsd(t.entryPrice, 2)}</td>
      <td class="r">${fmtUsd(t.exitPrice, 2)}</td>
      <td class="r">${fmtNum(t.qty, 4)}</td>
      <td class="r ${cssDir(t.pnlUsd)}">${fmtUsd(t.pnlUsd)}</td>
      <td class="r ${cssDir(t.pnlUsd)}">${fmtPct(t.pnlPct)}</td>
      <td title="${t.reasonClose || ''}">${t.reasonClose || '—'}</td>
      <td class="r">${fmtDur((t.closedAt || 0) - (t.openedAt || 0))}</td>
    </tr>`).join("");
}

let futChartCache = [];
function drawFuturesEquity(points) {
  const canvas = $("chart-fut-equity");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(1,0,0,1,0,0); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  $("fut-equity-sub").textContent = points.length + " samples";
  if (points.length < 2) {
    ctx.fillStyle = "#8a93a3"; ctx.font = "11px JetBrains Mono"; ctx.textAlign = "center";
    ctx.fillText("collecting perp equity samples...", W / 2, H / 2);
    return;
  }
  const ys = points.map(p => p.portfolioValue);
  let min = Math.min(...ys), max = Math.max(...ys);
  const startEq = ys[0];
  min = Math.min(min, startEq); max = Math.max(max, startEq);
  const pad = (max - min) * 0.1 || max * 0.005;
  min -= pad; max += pad;
  const range = max - min || 1;
  const padL = 56, padR = 12, padT = 12, padB = 24;
  const x = i => padL + (i / (points.length - 1)) * (W - padL - padR);
  const y = v => H - padB - ((v - min) / range) * (H - padT - padB);

  ctx.strokeStyle = "#1a2029"; ctx.lineWidth = 1;
  ctx.fillStyle = "#8a93a3"; ctx.font = "9px JetBrains Mono"; ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = min + (range * i / 4); const yy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.fillText("$" + v.toFixed(0), padL - 6, yy + 3);
  }
  const startY = y(startEq);
  ctx.strokeStyle = "#5a4318"; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(padL, startY); ctx.lineTo(W - padR, startY); ctx.stroke();
  ctx.setLineDash([]);

  const last = ys[ys.length - 1]; const isUp = last >= startEq;
  const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
  grad.addColorStop(0, isUp ? "rgba(212,160,23,0.30)" : "rgba(255,93,93,0.25)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.beginPath(); ctx.moveTo(x(0), y(ys[0]));
  for (let i = 1; i < ys.length; i++) ctx.lineTo(x(i), y(ys[i]));
  ctx.lineTo(x(ys.length - 1), H - padB); ctx.lineTo(x(0), H - padB); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath(); ctx.moveTo(x(0), y(ys[0]));
  for (let i = 1; i < ys.length; i++) ctx.lineTo(x(i), y(ys[i]));
  ctx.strokeStyle = isUp ? "#d4a017" : "#ff5d5d"; ctx.lineWidth = 1.6; ctx.stroke();

  ctx.beginPath();
  ctx.arc(x(ys.length - 1), y(ys[ys.length - 1]), 3, 0, Math.PI * 2);
  ctx.fillStyle = isUp ? "#d4a017" : "#ff5d5d"; ctx.fill();
}

// ── Tab switching ──────────────────────────────────────────────────────────

function switchTab(name) {
  state.activeTab = name;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $("tab-spot").classList.toggle("hidden", name !== "spot");
  $("tab-futures").classList.toggle("hidden", name !== "futures");
  $("tab-meta-spot").classList.toggle("hidden", name !== "spot");
  $("tab-meta-futures").classList.toggle("hidden", name !== "futures");
  document.body.classList.toggle("tab-futures", name === "futures");
  document.body.classList.toggle("tab-spot", name === "spot");
  if (name === "futures") drawFuturesEquity(futChartCache);
  else drawEquity(chartCache);
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

// ── Prism vendor signals ───────────────────────────────────────────────────

function renderPrism(snap) {
  const p = snap.prism;
  const grid = $("prism-grid");
  if (!p) {
    $("prism-sub").textContent = "not configured";
    grid.innerHTML = '<div class="empty">no prism data yet — first poll runs at engine start</div>';
    return;
  }
  const ageMin = Math.round((Date.now() - p.fetchedAt) / 60_000);
  const nextIn = Math.max(0, Math.round((p.cacheUntil - Date.now()) / 60_000));
  const counts = { strong_bullish:0, bullish:0, neutral:0, bearish:0, strong_bearish:0 };
  for (const e of p.entries) counts[e.overall] = (counts[e.overall] || 0) + 1;
  $("prism-sub").textContent =
    `${p.entries.length} pairs · ${ageMin}m old · refresh in ${nextIn}m` +
    (p.degraded?.length ? ` · degraded: ${p.degraded.join(",")}` : "") +
    (p.errors?.length ? ` · ${p.errors.length} errors` : "");
  if (!p.entries.length) {
    grid.innerHTML = '<div class="empty">prism returned no signals — markets may be flat or symbols degraded</div>';
    return;
  }
  grid.innerHTML = p.entries.map(e => {
    const cls = prismCellClass(e.overall);
    const reasons = (e.activeSignals || []).map(a => `${a.type}:${a.signal}`).join(", ") || "—";
    const rsi = e.indicators?.rsi != null ? e.indicators.rsi.toFixed(1) : "—";
    const macdH = e.indicators?.macdHistogram != null ? e.indicators.macdHistogram.toFixed(2) : "—";
    const px = e.currentPrice != null ? "$" + (e.currentPrice < 1 ? e.currentPrice.toFixed(5) : e.currentPrice.toFixed(2)) : "—";
    return `
      <div class="prism-cell ${cls}">
        <div class="prism-row1">
          <span class="prism-pair">${e.pair}</span>
          <span class="prism-px">${px}</span>
        </div>
        <div class="prism-row2">
          <span class="prism-overall">${prismLabel(e.overall)}</span>
          <span class="prism-net">net ${e.netScore >= 0 ? "+" : ""}${e.netScore}</span>
        </div>
        <div class="prism-row3">
          <span>RSI ${rsi}</span><span>MACD-H ${macdH}</span>
        </div>
        <div class="prism-reasons">${escapeHtml(reasons)}</div>
      </div>`;
  }).join("");
}
function prismCellClass(o) {
  switch (o) {
    case "strong_bullish": return "prism-sb";
    case "bullish": return "prism-b";
    case "bearish": return "prism-be";
    case "strong_bearish": return "prism-sbe";
    default: return "prism-n";
  }
}
function prismLabel(o) {
  return ({ strong_bullish: "STRONG BUY", bullish: "BUY", neutral: "NEUTRAL", bearish: "SELL", strong_bearish: "STRONG SELL" })[o] || o;
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

// ── ERC-8004 (RiskRouter + ValidationRegistry + Vault + Reputation) ────────

function shortAddr(a) { return a ? `${a.slice(0,6)}…${a.slice(-4)}` : "—"; }
function shortHash(h) { return h ? `${h.slice(0,10)}…${h.slice(-6)}` : "—"; }
function explorerTx(h) { return `https://sepolia.etherscan.io/tx/${h}`; }
function explorerAddr(a) { return `https://sepolia.etherscan.io/address/${a}`; }

function renderErc8004(snap) {
  const e = snap.erc8004;
  if (!e) return;
  if (!e.configured) {
    $("erc-sub").textContent = "not configured";
    $("erc-agent-status").textContent = "NOT CONFIGURED";
    $("erc-agent-status").className = "ai-val pill pill-warn";
    return;
  }

  $("erc-sub").textContent = `gate ${e.gateMode} · attest ${e.attestMode}`;
  $("erc-agent").textContent = e.agentId ? `#${e.agentId}${e.agentDid ? " — " + e.agentDid : ""}` : "—";
  $("erc-agent-status").textContent = e.agentRegistered ? "REGISTERED" : "UNREGISTERED";
  $("erc-agent-status").className = "ai-val pill " + (e.agentRegistered ? "pill-ok" : "pill-warn");

  const addr = e.walletAddress;
  const w = $("erc-wallet-link");
  w.textContent = shortAddr(addr);
  w.href = addr ? explorerAddr(addr) : "#";
  $("erc-wallet-balance").textContent = e.walletBalanceEth != null ? Number(e.walletBalanceEth).toFixed(5) + " ETH" : "—";

  $("erc-vault-alloc").textContent = e.vaultAllocatedEth != null ? Number(e.vaultAllocatedEth).toFixed(5) + " ETH" : "—";
  $("erc-vault-total").textContent = e.vaultTotalEth != null
    ? `${Number(e.vaultTotalEth).toFixed(5)} / ${Number(e.vaultUnallocatedEth ?? 0).toFixed(5)} ETH`
    : "—";

  const r = e.reputation || {};
  $("erc-reputation").textContent = r.feedbackCount != null
    ? `avg ${r.averageScore ?? "—"} (${r.feedbackCount} ratings)` : "—";

  const val = e.validation || {};
  $("erc-validation").textContent = val.attestationCount != null
    ? `avg ${val.averageValidationScore ?? "—"} (${val.attestationCount} attestations)` : "—";

  const rp = e.riskParams;
  $("erc-risk").textContent = rp
    ? `max trade $${rp.maxTradeUsd}, daily $${rp.maxDailyVolumeUsd}, concurrent ${rp.maxConcurrent}`
    : "not set on chain (RiskRouter accepts default policy)";

  const tr = e.tradeRecord;
  $("erc-window").textContent = tr
    ? `${tr.count} trades on chain` + (tr.windowStart ? ` · window since ${fmtTime(Number(tr.windowStart) * 1000)}` : "")
    : "—";

  $("erc-nonce").textContent = e.intentNonce != null ? `#${e.intentNonce}` : "—";

  if (document.activeElement?.id !== "erc-gate-mode") $("erc-gate-mode").value = e.gateMode || "simulate";
  if (document.activeElement?.id !== "erc-attest-mode") $("erc-attest-mode").value = e.attestMode || "off";

  const intents = e.intents || [];
  $("erc-intents-sub").textContent = `${intents.length} recent`;
  $("erc-intents").innerHTML = intents.length
    ? intents.slice(-6).reverse().map(i => `
        <div class="oc-item">
          <span class="oc-time">${fmtTime(i.ts)}</span>
          <span class="oc-eq">${i.side} ${i.pair} $${Number(i.amountUsd).toFixed(0)} → ${i.decision || (i.approved ? "APPROVED" : "REJECTED")}</span>
          ${i.txHash
            ? `<a href="${explorerTx(i.txHash)}" target="_blank" rel="noopener" class="oc-tx">${shortHash(i.txHash)}</a>`
            : `<span class="oc-tx">${shortHash(i.intentHash)}</span>`}
        </div>`).join("")
    : '<div class="empty">no intents yet</div>';

  const atts = e.attestations || [];
  $("erc-att-sub").textContent = `${atts.length} recent`;
  $("erc-attestations").innerHTML = atts.length
    ? atts.slice(-6).reverse().map(a => `
        <div class="oc-item">
          <span class="oc-time">${fmtTime(a.ts)}</span>
          <span class="oc-eq">score ${a.score ?? "—"} · ${a.pair || "trade"}</span>
          ${a.txHash
            ? `<a href="${explorerTx(a.txHash)}" target="_blank" rel="noopener" class="oc-tx">${shortHash(a.txHash)}</a>`
            : `<span class="oc-tx">${shortHash(a.checkpointHash)}</span>`}
        </div>`).join("")
    : '<div class="empty">no attestations yet</div>';
}

// ── Live update loop ───────────────────────────────────────────────────────

let chartCache = [];
async function refreshAll() {
  try {
    const [snap, scanner, trades, signals, eq, futTrades, futEq] = await Promise.all([
      api("/api/snapshot"),
      api("/api/scanner"),
      api("/api/trades?limit=20"),
      api("/api/signals?limit=40"),
      api("/api/equity"),
      api("/api/futures/trades?limit=20").catch(() => []),
      api("/api/futures/equity").catch(() => []),
    ]);
    renderSnapshot(snap);
    renderScanner(scanner);
    renderTrades(trades);
    renderSignals(signals);
    renderAI(snap);
    renderNews(snap);
    renderPrism(snap);
    renderOnchain(snap);
    renderErc8004(snap);
    chartCache = eq;
    if (state.activeTab === "spot") drawEquity(eq);
    // Futures
    renderFutures(snap);
    renderFuturesTrades(Array.isArray(futTrades) ? futTrades : []);
    futChartCache = Array.isArray(futEq) ? futEq : [];
    if (state.activeTab === "futures") drawFuturesEquity(futChartCache);
  } catch (e) {
    $("mode-badge").textContent = "OFFLINE";
    $("mode-badge").className = "badge badge-killed";
    console.warn("refresh error", e);
  }
}

window.addEventListener("resize", () => {
  if (state.activeTab === "spot") drawEquity(chartCache);
  else drawFuturesEquity(futChartCache);
});

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

  // Prism refresh
  $("btn-prism-refresh").addEventListener("click", async () => {
    const btn = $("btn-prism-refresh"); const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "polling…";
    try {
      const r = await authedApi("/api/prism/refresh", {});
      if (!r.ok) alert("Prism: " + (r.error || "failed"));
    } catch (e) { alert("Prism error: " + e.message); }
    finally { btn.disabled = false; btn.textContent = orig; refreshAll(); }
  });

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

  // ERC-8004 controls
  $("btn-erc-refresh").addEventListener("click", async () => {
    const btn = $("btn-erc-refresh"); const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "refreshing…";
    try {
      const r = await authedApi("/api/erc8004/refresh", {});
      if (!r.ok) alert("ERC-8004: " + (r.error || "failed"));
    } catch (e) { alert("error: " + e.message); }
    finally { btn.disabled = false; btn.textContent = orig; refreshAll(); }
  });
  $("erc-gate-mode").addEventListener("change", async (e) => {
    const r = await authedApi("/api/erc8004/gate-mode", { mode: e.target.value });
    if (!r.ok) alert(r.error || "failed");
    refreshAll();
  });
  $("erc-attest-mode").addEventListener("change", async (e) => {
    const r = await authedApi("/api/erc8004/attest-mode", { mode: e.target.value });
    if (!r.ok) alert(r.error || "failed");
    refreshAll();
  });
  $("btn-erc-probe").addEventListener("click", async () => {
    const status = $("erc-probe-status");
    const btn = $("btn-erc-probe"); const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "probing…";
    status.textContent = "sending probe…";
    try {
      const r = await authedApi("/api/erc8004/probe", { pair: "XBTUSD", side: "BUY", amountUsd: 25 });
      if (!r.ok) { status.textContent = "error: " + (r.error || "failed"); return; }
      const g = r.gate || {};
      status.innerHTML = `gate: <strong>${g.decision}</strong>${g.reason ? " — " + g.reason : ""}`
        + (g.intentHash ? `<br><span class="oc-mono">intent ${shortHash(g.intentHash)}</span>` : "")
        + (r.checkpointHash ? `<br><span class="oc-mono">checkpoint ${shortHash(r.checkpointHash)}</span>` : "");
    } catch (e) { status.textContent = "error: " + e.message; }
    finally { btn.disabled = false; btn.textContent = orig; refreshAll(); }
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

  // ── Tab switcher ─────────────────────────────────────────────────────────
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  // Initial tab from ?tab=spot|futures
  try {
    const initialTab = new URLSearchParams(location.search).get("tab");
    if (initialTab === "futures" || initialTab === "spot") switchTab(initialTab);
  } catch (_) {}

  // ── Futures controls ─────────────────────────────────────────────────────
  $("fut-lev").addEventListener("input", e => $("fut-lev-val").textContent = e.target.value);

  $("btn-fut-pause").addEventListener("click", async () => {
    await authedApi("/api/futures/control/pause", { reason: "Paused via dashboard" });
    refreshAll();
  });
  $("btn-fut-resume").addEventListener("click", async () => {
    await authedApi("/api/futures/control/resume", {});
    refreshAll();
  });
  $("btn-fut-flatten").addEventListener("click", async () => {
    if (!confirm("Close ALL open perp positions at market on the demo account?")) return;
    const r = await authedApi("/api/futures/control/flatten", {});
    if (r.error) alert(r.error);
    refreshAll();
  });
  $("btn-fut-poll").addEventListener("click", async () => {
    const btn = $("btn-fut-poll"); const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "polling…";
    try { await authedApi("/api/futures/control/poll", {}); }
    catch (e) { alert("poll error: " + e.message); }
    finally { btn.disabled = false; btn.textContent = orig; refreshAll(); }
  });

  // Manual perp order
  $("fut-order-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("fut-order-status");
    status.textContent = "submitting...";
    status.className = "form-status";
    try {
      const r = await authedApi("/api/futures/order", {
        pair: $("fut-pair").value,
        side: $("fut-side").value,
        notionalUsd: Number($("fut-notional").value),
        leverage: Number($("fut-lev").value),
        reasoning: $("fut-reason").value,
      });
      if (r.ok) {
        status.textContent = `OK — opened ${r.symbol} (${r.side}) size ${(r.size || 0).toFixed(4)} @ ${(r.markPrice || 0).toFixed(2)}`;
        status.className = "form-status ok";
      } else {
        status.textContent = r.error || "Error";
        status.className = "form-status err";
      }
      refreshAll();
    } catch (e) {
      status.textContent = "Error: " + e.message; status.className = "form-status err";
    }
  });

  // Allocator manual override
  $("alloc-manual-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("alloc-status");
    const sp = Number($("alloc-spot-input").value);
    const fp = Number($("alloc-fut-input").value);
    if (Math.abs(sp + fp - 100) > 0.5) {
      status.textContent = `Spot + Perp must sum to 100 (got ${sp + fp})`;
      status.className = "form-status err"; return;
    }
    status.textContent = "applying…"; status.className = "form-status";
    try {
      const r = await authedApi("/api/allocator/manual", {
        spotPct: sp, futuresPct: fp, reason: "manual override from dashboard",
      });
      if (r.ok) { status.textContent = `OK — ${sp}/${fp}`; status.className = "form-status ok"; }
      else { status.textContent = r.error || "Error"; status.className = "form-status err"; }
      refreshAll();
    } catch (e) {
      status.textContent = "Error: " + e.message; status.className = "form-status err";
    }
  });

  refreshAll();
  setInterval(refreshAll, 4000);
});
