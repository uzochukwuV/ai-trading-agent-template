/**
 * Enriched Agent Loop — uses CompositeStrategy with full market data
 *
 * Each tick:
 *   1. Fetch enriched market data (ticker + OHLC + order book + trades)
 *   2. CompositeStrategy.analyzeEnriched(market) → TradeDecision
 *   3. Format human-readable explanation
 *   4. If BUY/SELL:
 *      a. Build + sign TradeIntent (EIP-712, agentWallet)
 *      b. Submit TradeIntent to RiskRouter — get approval/rejection on-chain
 *      c. If approved: execute via Kraken CLI
 *   5. Generate EIP-712 signed checkpoint (includes intentHash)
 *   6. Post checkpoint hash to ValidationRegistry
 *   7. Append checkpoint to checkpoints.jsonl
 *   8. Log paper trading P&L
 */

import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

import { TradingStrategy, EnrichedMarketData, TradeDecision } from "../types/index";
import { getAgentId, getAgentRegistration } from "./identity";
import { CompositeStrategy } from "./composite-strategy";
import { KrakenClient } from "../exchange/kraken";
import { VaultClient } from "../onchain/vault";
import { RiskRouterClient } from "../onchain/riskRouter";
import { ValidationRegistryClient } from "../onchain/validationRegistry";
import { formatExplanation, formatCheckpointLog } from "../explainability/reasoner";
import { generateCheckpoint } from "../explainability/checkpoint";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const SEPOLIA_CHAIN_ID = 11155111;
const TRADING_PAIR    = process.env.TRADING_PAIR || "XBTUSD";
const POLL_INTERVAL   = parseInt(process.env.POLL_INTERVAL_MS || "120000"); // 2min default (reduce hourly trade count)
const CHECKPOINTS_FILE = path.join(process.cwd(), "checkpoints.jsonl");
const HOLD_INTENT_HASH = ethers.ZeroHash;

// OHLC config
const OHLC_INTERVAL = parseInt(process.env.OHLC_INTERVAL_MIN || "15");
const OHLC_COUNT = parseInt(process.env.OHLC_COUNT || "50");

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enriched market data formatter
// ─────────────────────────────────────────────────────────────────────────────

function formatEnrichedExplanation(decision: TradeDecision, data: EnrichedMarketData): string {
  const time = new Date().toISOString();
  const price = data.price.toLocaleString("en-US", { style: "currency", currency: "USD" });
  const confidencePct = (decision.confidence * 100).toFixed(0);

  const header = decision.action === "HOLD"
    ? `[${time}] HOLD ${data.pair} @ ${price}`
    : `[${time}] ${decision.action} ${data.pair} — $${decision.amount} @ ${price}`;

  const lines = [
    header,
    `  Confidence: ${confidencePct}%`,
    `  Spread: ${data.spreadBps.toFixed(1)}bps | Vol 24h: ${data.volume24h.toFixed(2)}`,
  ];

  if (data.orderBookImbalance !== undefined) {
    lines.push(`  Order Book: ${(data.orderBookImbalance * 100).toFixed(1)}% imbalance`);
  }
  if (data.tradeVolumeBias !== undefined) {
    lines.push(`  Trade Flow: ${(data.tradeVolumeBias * 100).toFixed(1)}% ${data.tradeVolumeBias > 0 ? "buy" : "sell"} bias`);
  }
  if (data.ohlc.length > 0) {
    const first = data.ohlc[0];
    const last = data.ohlc[data.ohlc.length - 1];
    const change = ((last.close - first.open) / first.open * 100).toFixed(2);
    lines.push(`  OHLC Range: ${data.ohlc.length} candles, ${change}% over period`);
  }
  lines.push("");
  lines.push(decision.reasoning);

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent runner
// ─────────────────────────────────────────────────────────────────────────────

export async function runEnrichedAgent(strategy: any) {
  const rpcUrl           = requireEnv("SEPOLIA_RPC_URL");
  const privateKey       = requireEnv("PRIVATE_KEY");
  const registryAddress  = requireEnv("AGENT_REGISTRY_ADDRESS");
  const vaultAddress     = requireEnv("HACKATHON_VAULT_ADDRESS");
  const routerAddress    = requireEnv("RISK_ROUTER_ADDRESS");
  const validationAddress = requireEnv("VALIDATION_REGISTRY_ADDRESS");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const operatorSigner = new ethers.Wallet(privateKey, provider);

  const agentWalletKey = process.env.AGENT_WALLET_PRIVATE_KEY || privateKey;
  const agentWallet = new ethers.Wallet(agentWalletKey, provider);

  // Resolve agent identity
  const agentId = await getAgentId(operatorSigner, registryAddress, {
    name: "CompositeTradingAgent",
    description: "Multi-signal composite trading strategy with RSI, MACD, Bollinger Bands, order book, and trade flow analysis",
    capabilities: ["trading", "analysis", "explainability", "eip712-signing", "composite-signals"],
    agentWallet: agentWallet.address,
    agentURI: `data:application/json,${encodeURIComponent(JSON.stringify({
      name: "CompositeTradingAgent",
      description: "Multi-signal composite trading strategy",
      capabilities: ["trading", "analysis", "eip712-signing", "composite-signals"],
      agentWallet: agentWallet.address,
      version: "2.0.0",
    }))}`,
  });

  const reg = await getAgentRegistration(provider, registryAddress, agentId);
  console.log(`[agent] agentWallet: ${reg.agentWallet}`);

  // Init clients
  const kraken     = new KrakenClient();
  const vault      = new VaultClient(vaultAddress, provider);
  const riskRouter = new RiskRouterClient(routerAddress, agentWallet, SEPOLIA_CHAIN_ID);
  const validation = new ValidationRegistryClient(validationAddress, agentWallet);

  // Initialize paper trading if sandbox mode
  if (process.env.KRAKEN_SANDBOX === "true") {
    try {
      await kraken.paperInit(10000, "USD");
      console.log(`[agent] Paper trading initialized: $10,000 USD`);
    } catch (e) {
      console.log(`[agent] Paper trading already initialized or error (non-fatal):`, (e as Error).message);
    }
  }

  console.log(`\n[agent] Starting enriched agent loop`);
  console.log(`[agent] agentId:  ${agentId}`);
  console.log(`[agent] Pair:     ${TRADING_PAIR}`);
  console.log(`[agent] Interval: ${POLL_INTERVAL / 1000}s`);
  console.log(`[agent] OHLC:     ${OHLC_INTERVAL}m × ${OHLC_COUNT} candles`);
  console.log(`[agent] Checkpoints: ${CHECKPOINTS_FILE}\n`);

  // ─────────────────────────────────────────────────────────────────────────
  // Main tick
  // ─────────────────────────────────────────────────────────────────────────

  let tickCount = 0;

  const tick = async () => {
    tickCount++;
    try {
      // 1. Fetch enriched market data
      const market = await kraken.getEnrichedMarketData(TRADING_PAIR, OHLC_INTERVAL, OHLC_COUNT);
      console.log(`[agent] ${TRADING_PAIR} @ $${market.price.toLocaleString()} | Spread: ${market.spreadBps.toFixed(1)}bps | Candles: ${market.ohlc.length}`);

      // 2. Strategy decision
      const decision = await strategy.analyzeEnriched(market);

      // 3. Human-readable explanation
      const explanation = formatEnrichedExplanation(decision, market);
      console.log(explanation);

      let intentHash = HOLD_INTENT_HASH;

      // 4. Actionable trade: submit signed TradeIntent to RiskRouter
      if (decision.action !== "HOLD" && decision.amount > 0) {

        // 4a. Build + sign the TradeIntent (EIP-712)
        const intent = await riskRouter.buildIntent(
          agentId,
          agentWallet.address,
          decision.pair,
          decision.action as "BUY" | "SELL",
          decision.amount
        );
        const signed = await riskRouter.signIntent(intent, agentWallet);
        intentHash = signed.intentHash;

        console.log(`[agent] TradeIntent signed. nonce=${intent.nonce}, deadline=${new Date(Number(intent.deadline) * 1000).toISOString()}`);

        // 4b. Submit to RiskRouter — on-chain validation
        const validation_result = await riskRouter.submitIntent(signed);

        if (!validation_result.approved) {
          console.warn(`[agent] TradeIntent REJECTED by RiskRouter: ${validation_result.reason}`);
          decision.action = "HOLD";
          decision.amount = 0;
          decision.reasoning += `\n[BLOCKED by RiskRouter: ${validation_result.reason}]`;
        } else {
          // 4c. Execute via Kraken CLI (paper or live)
          const volumeBase = (decision.amount / market.price).toFixed(8);
          const result = await kraken.placeOrder({
            pair:      decision.pair,
            type:      decision.action === "BUY" ? "buy" : "sell",
            ordertype: "market",
            volume:    volumeBase,
          });
          console.log(`[agent] Order placed: ${result.txid.join(", ")}`);
          console.log(`[agent] ${result.descr.order}`);

          // Log paper status if sandbox
          if (process.env.KRAKEN_SANDBOX === "true") {
            try {
              const paperStatus = await kraken.getPaperStatus();
              console.log(`[agent] Paper P&L: $${paperStatus.pnl.toFixed(2)} (${paperStatus.pnlPercent.toFixed(2)}%)`);
            } catch {}
          }
        }
      }

      // 5. Generate EIP-712 signed checkpoint
      const checkpoint = await generateCheckpoint(
        agentId,
        decision,
        { pair: market.pair, price: market.price, bid: market.bid, ask: market.ask, volume: market.volume24h, vwap: market.vwap24h, high: market.high24h, low: market.low24h, timestamp: market.timestamp },
        intentHash,
        agentWallet,
        registryAddress,
        SEPOLIA_CHAIN_ID
      );

      console.log(formatCheckpointLog(checkpoint));

      // 6. Post checkpoint hash to ValidationRegistry
      const cp = checkpoint as typeof checkpoint & { checkpointHash?: string };
      if (cp.checkpointHash) {
        try {
          await validation.postCheckpointAttestation(
            agentId,
            cp.checkpointHash,
            Math.round(decision.confidence * 100),
            `${decision.action} ${decision.pair} @ $${market.price}`
          );
          console.log(`[agent] Checkpoint posted to ValidationRegistry: ${cp.checkpointHash.slice(0, 20)}...`);
        } catch (e) {
          console.warn(`[agent] ValidationRegistry post failed (non-fatal):`, e);
        }
      }

      // 7. Persist to checkpoints.jsonl
      fs.appendFileSync(CHECKPOINTS_FILE, JSON.stringify(checkpoint) + "\n");

      // 8. Periodic paper status summary (every 5 ticks)
      if (tickCount % 5 === 0 && process.env.KRAKEN_SANDBOX === "true") {
        try {
          const status = await kraken.getPaperStatus();
          console.log(`\n[agent] ── Paper Status (tick ${tickCount}) ──`);
          console.log(`[agent] Equity: $${status.equity.toFixed(2)} | P&L: $${status.pnl.toFixed(2)} (${status.pnlPercent.toFixed(2)}%)`);
          for (const pos of status.positions) {
            console.log(`[agent]   ${pos.asset}: ${pos.volume} @ $${pos.avgEntryPrice.toFixed(2)} → $${pos.currentPrice.toFixed(2)} (${pos.pnlPercent.toFixed(2)}%)`);
          }
          console.log(`[agent] ──────────────────────────\n`);
        } catch {}
      }

    } catch (err) {
      console.error(`[agent] Error in tick:`, err);
    }
  };

  await tick();
  setInterval(tick, POLL_INTERVAL);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

// Strategy is instantiated in scripts/run-enriched-agent.ts
// This file exports runEnrichedAgent for use by the script.
