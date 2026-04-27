/**
 * Run the unified trading agent.
 *
 * Usage:
 *   npx ts-node scripts/run-agent.ts
 *
 * One loop handles everything:
 *   1. Check paper account (balances, P&L, positions)
 *   2. Scan ALL watchlist pairs (enriched data: OHLC + order book + trades)
 *   3. Analyze signals (RSI, MACD, Bollinger, OB imbalance, trade flow)
 *   4. Execute trades (RiskRouter validation → Kraken execution)
 *   5. Manage positions (track buys, monitor for sell signals)
 *   6. Post checkpoints to ValidationRegistry
 *   7. Log account summary
 *
 * Env variables:
 *   POLL_INTERVAL_MS   - Tick interval in ms (default: 120000)
 *   WATCHLIST          - Comma-separated pairs (default: 20 liquid USD pairs)
 *   MIN_SCORE_BUY      - Min composite score to BUY (default: 0.60)
 *   MAX_SCORE_SELL     - Max score to SELL held positions (default: 0.40)
 *   BASE_TRADE_USD     - Base trade size in USD (default: 100)
 *   MAX_POSITIONS      - Max concurrent positions (default: 3)
 */

import "../src/agent/index";
