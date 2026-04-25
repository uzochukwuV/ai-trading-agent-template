# AI Trading Agent

An autonomous crypto trading agent template with multi-signal technical analysis, LLM-assisted decision making, on-chain identity (ERC-8004), Kraken execution, and EIP-712 signed checkpoints. See `README.md` for the full project description.

## Replit setup

- **Runtime:** Node.js 20 (configured in `.replit` via `modules = ["nodejs-20", "web"]`)
- **Package manager:** npm (run `npm install` once on a fresh clone)
- **TypeScript runner:** `ts-node` (used for the dashboard and agent scripts)

### Workflow

A single workflow named **Dashboard** is configured:

- Command: `npx ts-node scripts/dashboard.ts`
- Port: `5000` (mapped to the Replit web preview)
- Host: `0.0.0.0`
- Output type: `webview`

The dashboard reads `checkpoints.jsonl` from the project root and exposes:

- `GET /` — embedded HTML UI (Agent Terminal)
- `GET /api/status` — agent + contract config from env vars
- `GET /api/checkpoints` — last 50 checkpoints in reverse chronological order
- `GET /api/price` — most recent price snapshot

`scripts/dashboard.ts` was patched for Replit to bind to `0.0.0.0:5000` (configurable via `DASHBOARD_HOST` / `DASHBOARD_PORT`) and to send `Cache-Control: no-store` so the proxied iframe always sees fresh content. Nothing else in the codebase was changed.

### Other commands (run from the shell when needed)

These are not wired into workflows because they require user-provided secrets (Sepolia RPC URL, private keys, Kraken API keys, OpenRouter key):

- `npm run compile` — compile Hardhat contracts
- `npm run deploy` — deploy contracts to Sepolia
- `npm run register` — register the agent on-chain
- `npm run run-agent` — run the trading agent loop (writes to `checkpoints.jsonl`)
- `npm run run-momentum` — run the momentum strategy
- `npm test` — run Hardhat tests

Copy `.env.example` to `.env` and fill in the required values before running any of these.

## Project structure

See `README.md` for the full breakdown. Key directories:

- `contracts/` — Solidity contracts (AgentRegistry, HackathonVault, RiskRouter, ReputationRegistry, ValidationRegistry)
- `src/agent/` — agent loop, strategies, indicators
- `src/exchange/` — Kraken client
- `src/onchain/` — contract interaction wrappers
- `src/explainability/` — EIP-712 checkpoint generation/verification
- `scripts/` — deploy, register, run, dashboard
- `tutorial/` — step-by-step walkthrough docs

## Deployment

Configured as a VM deployment (long-running Node process) running the dashboard on port 5000.
