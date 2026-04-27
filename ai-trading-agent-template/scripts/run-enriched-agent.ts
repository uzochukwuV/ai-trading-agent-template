/**
 * Run the enriched composite trading agent.
 *
 * Usage: npx ts-node scripts/run-enriched-agent.ts
 */

import { runEnrichedAgent } from "../src/agent/enriched-agent";
import { CompositeStrategy } from "../src/agent/composite-strategy";

const strategy = new CompositeStrategy({
  baseTradeAmountUsd: 100,
  maxTradeAmountUsd: 500,
  buyThreshold: 0.55,
  sellThreshold: 0.45,
});

runEnrichedAgent(strategy).catch((err) => {
  console.error("[script] Fatal:", err);
  process.exit(1);
});
