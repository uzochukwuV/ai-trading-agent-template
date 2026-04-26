# AI Trading Agent — Dual-Desk (Spot + Perp)

An autonomous crypto trading agent with a **dual-desk architecture**:

- **Spot Desk** — Kraken public REST data + paper broker (legacy)
- **Perp Desk** — Kraken Futures **DEMO** account, real signed orders against the demo book

A deterministic **signal router** decides per signal whether it's executed on spot or perp, and a **capital allocator** rebalances target equity between the two buckets using rolling Sharpe + AI macro tilt.

It also keeps the original technical / LLM signal stack, news/sentiment ingestion, Prism vendor signals, ERC-8004 on-chain identity, and EIP-712 signed checkpoints.

## Replit setup

- **Runtime:** Node.js 20 (`modules = ["nodejs-20", "web"]` in `.replit`)
- **Package manager:** npm
- **TypeScript runner:** `ts-node`

### Workflow

A single workflow named **Dashboard** is configured:

- Command: `npx ts-node scripts/dashboard.ts`
- Port: `5000` (mapped to the Replit web preview)
- Host: `0.0.0.0`
- Output type: `webview`

`scripts/dashboard.ts` boots the trading engine + Express server, persists state under `data/`, and serves `public/` (the Agent Terminal UI).

### Required / optional environment secrets

| Secret | Purpose |
| --- | --- |
| `KRAKEN_FUTURES_DEMO_KEY` / `KRAKEN_FUTURES_DEMO_SECRET` | Perp desk — signs requests to `https://demo-futures.kraken.com/derivatives/api/v3`. Without these the perp desk runs in disabled mode and the spot desk operates alone. |
| `MISTRAL_API_KEY` and/or `NVIDIA_API_KEY` | AI strategist provider (Mistral preferred, NVIDIA fallback) |
| `PRISM_API_KEY` | Prism vendor signals (optional; degrades gracefully) |
| `SEPOLIA_RPC_URL` / `SEPOLIA_PRIVATE_KEY` | ERC-8004 on-chain checkpoint anchoring (optional) |

The dashboard generates and prints an external-signal API key on startup; users authenticate write endpoints with `X-API-Key`.

## Architecture

### Engines

- `src/engine/trading-engine.ts` — owns spot portfolio, signal bus, AI strategist, news, Prism, on-chain checkpointer, **futures engine**, and **capital allocator**.
- `src/engine/futures-engine.ts` — polls the Kraken Futures DEMO REST API every few seconds (accounts, openpositions, tickers), tracks own equity curve, exposes `openPosition / closePosition / closeAll` (market reduce-only orders), enforces own risk caps (max leverage cap, max positions, daily loss limit, liquidation buffer auto-close at 5% distance, kill switch on −5% daily).
- `src/engine/kraken-futures.ts` — minimal HMAC-SHA512-signed REST client for the Kraken Futures derivatives API + spot↔perp pair mapper (PF_XBTUSD ↔ XBTUSD, etc.) for all eight watchlist symbols.

### Routing & allocation

- `src/engine/signal-router.ts` — deterministic rules that turn an aggregated signal into `{ bucket: "spot" | "futures" | "skip", leverage?, notionalShareHint, reason }`. Volatile/meme/manual → spot; mean-reversion → spot; strong corroborated trend (conf ≥ 0.7) on majors → futures with `leverage = clamp(1 + tilt + (conf-0.7)*8, 1, maxLev)`. No double-dipping across buckets.
- `src/engine/allocator.ts` — capital allocator rebalancing targets between buckets using **rolling 7-day Sharpe** with PnL fallback. Defaults: 70/30 spot-perp split. Guardrails: 20 % floor each side, 10 % max daily rotation, 6 h cooldown between rebalances, **24 h freeze on > 3 % daily loss**, idle-cash-only. Also produces an AI **leverageBias** (−1..+1) used by the router.

### UI

`public/index.html` + `public/app.js` + `public/styles.css` — the Agent Terminal. New in v3:

- **Combined header strip** always visible: combined equity, P&L today (spot + perp), allocator target/actual split with bar, AI tilt, next-rebalance ETA.
- **Tab switcher**: SPOT DESK / PERP DESK (also via `?tab=spot|futures` query param).
- **Spot tab** — unchanged structurally (KPI hero, risk strip, AI strategist, Prism, news, equity, scanner, positions, trades, signal/risk forms, on-chain panel, API docs).
- **Perp tab** — perp KPI strip (portfolio value, available margin, unreal/today PnL, max leverage, status), perp equity curve, funding-rate ticker per held perp, open perp positions table (with leverage, liq price + distance, funding), manual perp order form (pair, side, notional, leverage 1–5x), capital-allocator panel with manual override, recent perp trades.

### Server endpoints (new in v3)

Spot endpoints unchanged. Added:

- `GET /api/futures/snapshot` — perp engine state
- `GET /api/futures/positions` — open perp positions
- `GET /api/futures/trades?limit=N` — recent closed perp trades
- `GET /api/futures/equity` — perp equity curve points
- `POST /api/futures/order` — open perp position (authed; `pair`, `side`, `notionalUsd`, `leverage`, `reasoning`)
- `POST /api/futures/close` — close one perp position (authed; `symbol`, `reason`)
- `POST /api/futures/control/{pause,resume,enable,reset-kill,flatten,poll}` — perp engine control (authed)
- `GET /api/allocator` — current allocator state + history
- `POST /api/allocator/{manual,enable,tilt}` — allocator control (authed)
- `GET /api/snapshot` extended with `combinedEquity`, `futures`, `allocator`

## Defaults & guardrails (v3)

- Initial capital split: **70 % spot / 30 % perp** (logical target — accounts are physically separate)
- Perp leverage: default **3x**, hard cap **5x**
- Allocator rebalance: 7-day Sharpe window, 10 % max daily rotation, 20 % hard floor each, 6 h cooldown, 24 h freeze on > 3 % daily loss
- Perp kill switch: −5 % daily PnL on the perp account
- Perp liquidation auto-close: when liq price < 5 % from mark
- Router: AI macro tilt is **per cycle, not per trade** (one AI call/cycle)

## Project structure

- `contracts/` — Solidity contracts (AgentRegistry, HackathonVault, RiskRouter, ReputationRegistry, ValidationRegistry)
- `src/engine/` — trading engine, broker, futures engine, allocator, router, signal bus, AI strategist, news, Prism, onchain
- `src/server/` — Express server + endpoints
- `src/agent/` — original agent loop and strategies (still available)
- `src/exchange/` — Kraken spot client
- `public/` — Agent Terminal UI
- `scripts/` — `dashboard.ts`, `test-futures.ts` (futures REST smoke), legacy deploy/register/run-agent scripts
- `tutorial/` — step-by-step walkthrough docs

## Other commands (run from the shell when needed)

These need user-provided secrets and aren't wired into workflows:

- `npm run compile` — compile Hardhat contracts
- `npm run deploy` — deploy contracts to Sepolia
- `npm run register` — register the agent on-chain
- `npm run run-agent` — run the legacy trading agent loop
- `npm run run-momentum` — run the momentum strategy
- `npm test` — run Hardhat tests
- `npx ts-node scripts/test-futures.ts` — verify Kraken Futures DEMO connectivity + auth

## Deployment

Configured as a VM deployment (long-running Node process) running the dashboard on port 5000.
