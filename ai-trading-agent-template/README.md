# AI Trading Agent

An autonomous crypto trading agent with multi-signal technical analysis, LLM-assisted decision making, on-chain identity, and cryptographic auditability.

- **Multi-pair scanner** — scans 20+ Kraken pairs in parallel every tick
- **Composite signal engine** — RSI, MACD, Bollinger Bands, ATR, VWAP, order book imbalance, trade flow
- **LLM fallback** — calls OpenRouter (Nemotron, Claude, Llama) when signals are ambiguous or conflicting
- **On-chain identity** via ERC-8004 Agent Registry (Sepolia)
- **Trade execution** via Kraken REST API (paper trading supported)
- **Capital management** via Hackathon Vault + Risk Router contracts
- **Cryptographic auditability** via EIP-712 signed checkpoints posted to Sepolia

Any team can fork this, swap in their own strategy, and run it — the identity, risk, and audit layers stay the same.

---

## Architecture

```
OHLCV + Order Book + Trade Flow (Kraken API)
                ↓
     Technical Indicators
  RSI · MACD · Bollinger · ATR · VWAP
                ↓
   Composite Scoring Engine (weighted 0–1)
         ↓               ↓
   Clear signal     Ambiguous/conflicting
         ↓               ↓
      Act now      LLM via OpenRouter
                  (Nemotron / Claude / Llama)
                ↓
   [On-chain] RiskRouter.validateTrade()
                ↓
      [Exchange] Kraken.placeOrder()
                ↓
   EIP-712 Checkpoint → ValidationRegistry (Sepolia)
                ↓
        checkpoints.jsonl (local audit log)
```

---

## Signal Engine

Five weighted signals produce a composite score from 0 (strong sell) to 1 (strong buy):

| Signal | Weight | Logic |
|---|---|---|
| RSI (14) | 25% | <30 oversold → bullish, >70 overbought → bearish |
| MACD | 25% | Histogram direction and magnitude |
| Bollinger Bands (20) | 15% | %B near lower band → bullish, near upper → bearish |
| Order Book Imbalance | 20% | Bid-heavy → bullish, ask-heavy → bearish |
| Trade Flow Bias | 15% | Buy-dominated recent trades → bullish |

**Score ≥ 0.60** → BUY · **Score ≤ 0.40** → SELL · Otherwise → HOLD

When the score is within ±0.10 of neutral (0.50), or signals conflict, the agent calls an LLM for a tie-break.

---

## LLM Fallback

Configured via environment variables:

```env
OPENROUTER_API_KEY=...
LLM_MODEL=nvidia/nemotron-4-340b-instruct   # default (free tier available)
LLM_ENABLED=true
```

Available models on OpenRouter:
- `nvidia/nemotron-4-340b-instruct` — free tier
- `anthropic/claude-3.5-haiku` — cheap, fast
- `meta-llama/llama-3.3-70b-instruct` — good quality
- `google/gemini-2.0-flash-lite` — fast, cheap

The LLM receives the full market context: OHLCV candles, all indicator values, order book depth, and trade flow. It returns structured JSON `{ action, amount, confidence, reasoning }`. If the LLM call fails, the agent falls back to pure technical analysis — no single point of failure.

---

## Prerequisites

- Node.js 20+
- Sepolia ETH ([sepoliafaucet.com](https://sepoliafaucet.com))
- Infura or Alchemy Sepolia RPC URL
- Kraken Pro account with API keys (see below)
- OpenRouter API key (optional, for LLM fallback)

---

## Setup

```bash
git clone <this-repo>
cd ai-trading-agent-template
npm install
cp .env.example .env
```

Fill in your `.env`:

```env
SEPOLIA_RPC_URL=...
PRIVATE_KEY=...
KRAKEN_API_KEY=...
KRAKEN_API_SECRET=...

# Optional — LLM fallback
OPENROUTER_API_KEY=...
LLM_MODEL=nvidia/nemotron-4-340b-instruct
LLM_ENABLED=true
```

### Kraken API key

Use **Kraken Pro** (kraken.com → Go to Kraken Pro). Go to **Settings → API** and create a key with these permissions only:

- **Funds:** Query
- **Orders and trades:** Query open orders & trades, Create & modify orders, Cancel & close orders

---

## Quickstart

### 1. Deploy contracts

```bash
npx hardhat run scripts/deploy.ts --network sepolia
```

Copy all 5 addresses to your `.env`:

```env
AGENT_REGISTRY_ADDRESS=...
HACKATHON_VAULT_ADDRESS=...
RISK_ROUTER_ADDRESS=...
REPUTATION_REGISTRY_ADDRESS=...
VALIDATION_REGISTRY_ADDRESS=...
```

### 2. Register your agent

```bash
npm run register
```

Copy the printed `AGENT_ID` to your `.env`:

```env
AGENT_ID=0
```

### 3. Run the agent + dashboard

```bash
# Terminal 1 — agent loop
npm run run-agent

# Terminal 2 — live dashboard at http://localhost:3000
npm run dashboard
```

Example output:

```
[agent] Starting agent loop
[agent] agentId:  0
[agent] Scanning 20 pairs every 30s

[scanner] Scanning 20 pairs...
[scanner] SOLUSD: score=0.71 RSI=28.4 (oversold) MACD=bullish OB=bid-heavy
[scanner] Selected SOLUSD as highest-conviction BUY

[2026-03-27T11:02:50.000Z] BUY SOLUSD @ $142.30
  Confidence: 71%
  Reason: RSI oversold + MACD bullish crossover + bid-heavy order book
  Amount: $142.00

────────────────────────────────────────────────────────────────────────
CHECKPOINT — BUY SOLUSD
  Agent:      0
  Timestamp:  2026-03-27T11:02:50.000Z
  Amount:     $142.00
  Price:      $142.30
  Confidence: 71%
  Sig:        0x4f93af3b...c66c3bb31c
  Signer:     0xYourAgentWallet
────────────────────────────────────────────────────────────────────────

[agent] Checkpoint posted to ValidationRegistry: 0xa6993f19...
```

---

## Strategies

### ScannerStrategy (default)

Scans all watchlist pairs in parallel, scores each with the composite engine, and picks the highest-conviction signal. Tracks open positions and monitors them for exit signals.

```typescript
import { ScannerStrategy } from "./src/agent/scanner-strategy.js";
const strategy = new ScannerStrategy(krakenClient, {
  minScoreToBuy: 0.60,
  maxScoreToSell: 0.40,
  baseTradeAmountUsd: 100,
  maxConcurrentPositions: 3,
});
```

Default watchlist: BTC, ETH, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK, MATIC, ATOM, LTC, UNI, NEAR, FIL, APT, ARB, OP, PEPE (20 pairs).

### CompositeStrategy

Single-pair composite scoring with full signal breakdown. Use when you want to focus on one pair.

```typescript
import { CompositeStrategy } from "./src/agent/composite-strategy.js";
const strategy = new CompositeStrategy({ buyThreshold: 0.55, sellThreshold: 0.45 });
```

### HybridStrategy

Composite technical analysis with automatic LLM fallback on ambiguous signals.

```typescript
import { HybridStrategy } from "./src/agent/strategy.js";
const strategy = new HybridStrategy({ llmThreshold: 0.10 });
```

### MomentumStrategy

Simple price momentum over a rolling window. Good baseline for testing.

```typescript
import { MomentumStrategy } from "./src/agent/strategy.js";
const strategy = new MomentumStrategy(5, 100); // windowSize=5, tradeAmount=$100
```

### Plug in your own

Any strategy only needs to implement one method:

```typescript
interface TradingStrategy {
  analyze(data: MarketData): Promise<TradeDecision>;
}
```

---

## Project structure

```
contracts/
  AgentRegistry.sol        # ERC-8004 agent identity registry
  HackathonVault.sol       # Capital vault with per-agent allocation
  RiskRouter.sol           # On-chain risk validation

src/
  types/index.ts           # Shared TypeScript interfaces
  agent/
    index.ts               # Main agent loop
    identity.ts            # ERC-8004 registration
    strategy.ts            # MomentumStrategy, LLMStrategy, HybridStrategy
    composite-strategy.ts  # Multi-signal weighted composite strategy
    scanner-strategy.ts    # Multi-pair scanner (default)
    indicators.ts          # RSI, MACD, Bollinger, ATR, VWAP, ROC
    enriched-agent.ts      # Agent loop using enriched market data
  exchange/
    kraken.ts              # Kraken client — ticker, OHLCV, order book, trades
  onchain/
    vault.ts               # Vault contract interactions
    riskRouter.ts          # RiskRouter contract interactions
    reputationRegistry.ts  # Reputation tracking
    validationRegistry.ts  # Checkpoint submission
  explainability/
    reasoner.ts            # Human-readable explanation formatter
    checkpoint.ts          # EIP-712 checkpoint generation + verification

scripts/
  deploy.ts                # Deploy all contracts to Sepolia
  register-agent.ts        # Register agent on-chain
  run-agent.ts             # Run the agent
  dashboard.ts             # Live web dashboard (http://localhost:3000)
```

---

## Verify a checkpoint

```typescript
import { verifyCheckpoint } from "./src/explainability/checkpoint.js";

const valid = verifyCheckpoint(
  checkpoint,
  process.env.AGENT_REGISTRY_ADDRESS!,
  11155111,
  process.env.EXPECTED_SIGNER_ADDRESS!
);
console.log(valid); // true
```

---

## Tutorial

Step-by-step walkthrough in the `tutorial/` folder:

1. [What is ERC-8004 and why does it matter?](tutorial/01-erc8004-intro.md)
2. [Registering your agent on-chain](tutorial/02-register-agent.md)
3. [Connecting to Kraken API](tutorial/03-kraken-connection.md)
4. [The Vault and Risk Router](tutorial/04-vault-riskrouter.md)
5. [Building the explanation layer](tutorial/05-explanation-layer.md)
6. [EIP-712 signed checkpoints](tutorial/06-eip712-checkpoints.md)
7. [Using this as a reusable template](tutorial/07-reusable-template.md)

---

## License

MIT

---

## Docker

Build and run the agent in a container:

```bash
cp .env.example .env        # fill in your keys
npm run docker:build        # build image
npm run docker:up           # start in background
npm run docker:logs         # follow logs
npm run docker:down         # stop
```

The `checkpoints.jsonl` file is mounted as a volume so it persists across restarts.
