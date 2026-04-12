/**
 * Unified Agent Loop — scanner + account management + trading in ONE loop
 *
 * Each tick:
 *   1. Check paper account status (balances, P&L, positions)
 *   2. Scan ALL watchlist pairs via enriched market data (OHLC + order book + trades)
 *   3. Compute composite scores for each pair (RSI, MACD, Bollinger, order book, trade flow)
 *   4. Check existing positions for deteriorating signals → SELL
 *   5. Pick highest-conviction BUY signal if we have capacity
 *   6. If BUY/SELL:
 *      a. Build + sign TradeIntent (EIP-712, agentWallet)
 *      b. Submit TradeIntent to RiskRouter — get approval/rejection on-chain
 *      c. If approved: execute via Kraken CLI
 *   7. Generate EIP-712 signed checkpoint (includes intentHash)
 *   8. Post checkpoint hash to ValidationRegistry
 *   9. Append checkpoint to checkpoints.jsonl
 *  10. Log account summary
 */

import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

import { MarketData, TradeDecision } from "../types/index";
import { getAgentId, getAgentRegistration } from "./identity";
import { ScannerStrategy } from "./scanner-strategy";
import { DEFAULT_LLM_CONFIG } from "./strategy";
import { KrakenClient } from "../exchange/kraken";
import { VaultClient } from "../onchain/vault";
import { RiskRouterClient } from "../onchain/riskRouter";
import { ValidationRegistryClient } from "../onchain/validationRegistry";
import { formatCheckpointLog } from "../explainability/reasoner";
import { generateCheckpoint } from "../explainability/checkpoint";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const SEPOLIA_CHAIN_ID = 11155111;
const POLL_INTERVAL    = parseInt(process.env.POLL_INTERVAL_MS || "120000"); // 2min
const CHECKPOINTS_FILE = path.join(process.cwd(), "checkpoints.jsonl");
const HOLD_INTENT_HASH = ethers.ZeroHash;

// Scanner config
const MIN_SCORE_BUY    = parseFloat(process.env.MIN_SCORE_BUY || "0.60");
const MAX_SCORE_SELL   = parseFloat(process.env.MAX_SCORE_SELL || "0.40");
const BASE_TRADE_USD   = parseFloat(process.env.BASE_TRADE_USD || "100");
const MAX_POSITIONS    = parseInt(process.env.MAX_POSITIONS || "3");
const WATCHLIST        = process.env.WATCHLIST
  ? process.env.WATCHLIST.split(",").map(s => s.trim())
  : undefined;

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output formatting
// ─────────────────────────────────────────────────────────────────────────────

function formatScanTable(results: any[]): string {
  if (!results?.length) return "";
  const header = `  Pair              Score    RSI    Trend       OB Imb    Trade Flow  Action`;
  const sep    = `  ───────────────── ──────   ────   ──────────  ────────  ──────────  ──────`;
  const rows = results.slice(0, 15).map(r => {
    const ob = r.orderBookImbalance !== undefined ? (r.orderBookImbalance * 100).toFixed(0) + "%" : "N/A";
    const tf = r.tradeVolumeBias !== undefined ? (r.tradeVolumeBias * 100).toFixed(0) + "%" : "N/A";
    return `  ${r.pair.padEnd(17)} ${(r.compositeScore * 100).toFixed(1).padStart(5)}%  ${r.rsi?.toFixed(1).padStart(5) ?? "  N/A"}  ${r.trend.padEnd(11)} ${String(ob).padEnd(9)} ${String(tf).padEnd(11)} ${r.action}`;
  }).join("\n");
  return `${header}\n${sep}\n${rows}`;
}

function formatAccountSummary(status: any): string {
  const lines = [
    `\n  ── Account Summary ──`,
    `  Equity:  $${status.equity?.toFixed(2) ?? "N/A"}`,
    `  P&L:     $${status.pnl?.toFixed(2) ?? "N/A"} (${status.pnlPercent?.toFixed(2) ?? "N/A"}%)`,
  ];
  if (status.positions?.length) {
    lines.push(`  Positions (${status.positions.length}):`);
    for (const p of status.positions) {
      lines.push(`    ${p.asset}: ${p.volume} @ $${p.avgEntryPrice.toFixed(2)} → $${p.currentPrice.toFixed(2)} (${p.pnlPercent?.toFixed(2) ?? "N/A"}%)`);
    }
  } else {
    lines.push(`  Positions: none`);
  }
  lines.push(`  ─────────────────────\n`);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent runner
// ─────────────────────────────────────────────────────────────────────────────

export async function runAgent() {
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

  // ── Init ALL clients ──────────────────────────────────────────────────────
  const kraken     = new KrakenClient();
  const vault      = new VaultClient(vaultAddress, provider);
  const riskRouter = new RiskRouterClient(routerAddress, agentWallet, SEPOLIA_CHAIN_ID);
  const validation = new ValidationRegistryClient(validationAddress, agentWallet);

  // ── Init scanner (shares the KrakenClient) ────────────────────────────────
  const useLLM = DEFAULT_LLM_CONFIG.enabled && !!DEFAULT_LLM_CONFIG.apiKey;
  const scanner = new ScannerStrategy(kraken, {
    watchlist: WATCHLIST,
    minScoreToBuy: MIN_SCORE_BUY,
    maxScoreToSell: MAX_SCORE_SELL,
    baseTradeAmountUsd: BASE_TRADE_USD,
    maxConcurrentPositions: MAX_POSITIONS,
    useLLM,
  });

  // ── Register agent identity ───────────────────────────────────────────────
  const agentId = await getAgentId(operatorSigner, registryAddress, {
    name: "ScannerTradingAgent",
    description: "Multi-pair scanner trading agent with composite technical analysis and paper account management",
    capabilities: ["trading", "analysis", "explainability", "eip712-signing", "multi-pair-scanner"],
    agentWallet: agentWallet.address,
    agentURI: `data:application/json,${encodeURIComponent(JSON.stringify({
      name: "ScannerTradingAgent",
      description: "Multi-pair scanner trading agent",
      capabilities: ["trading", "analysis", "eip712-signing", "multi-pair-scanner"],
      agentWallet: agentWallet.address,
      version: "3.0.0",
    }))}`,
  });

  const reg = await getAgentRegistration(provider, registryAddress, agentId);
  console.log(`[agent] agentWallet: ${reg.agentWallet}`);

  // ── Initialize paper trading ──────────────────────────────────────────────
  try {
    await kraken.paperInit(10000, "USD");
  } catch {
    // Already initialized — that's fine
  }

  // ── Startup banner ────────────────────────────────────────────────────────
  console.log(`\n[agent] ═══════════════════════════════════════════`);
  console.log(`[agent]  Unified Trading Agent v3.0`);
  console.log(`[agent] ═══════════════════════════════════════════`);
  console.log(`[agent] agentId:      ${agentId}`);
  console.log(`[agent] Watchlist:    ${(WATCHLIST || ["default (20 pairs)"]).length} pairs`);
  console.log(`[agent] Buy ≥ ${(MIN_SCORE_BUY * 100).toFixed(0)}%  |  Sell ≤ ${(MAX_SCORE_SELL * 100).toFixed(0)}%  |  Max positions: ${MAX_POSITIONS}`);
  console.log(`[agent] Base trade:   $${BASE_TRADE_USD}`);
  console.log(`[agent] Interval:     ${POLL_INTERVAL / 1000}s`);
  console.log(`[agent] Checkpoints:  ${CHECKPOINTS_FILE}`);
  console.log(`[agent] ═══════════════════════════════════════════\n`);

  // ── Main tick ─────────────────────────────────────────────────────────────
  let tickCount = 0;

  const tick = async () => {
    tickCount++;
    try {
      console.log(`\n[agent] ═══════════════════════════════════════════`);
      console.log(`[agent]  Tick #${tickCount} — ${new Date().toISOString()}`);
      console.log(`[agent] ═══════════════════════════════════════════\n`);

      // ── Step 1: Check account status ────────────────────────────────────
      console.log(`[agent] → Checking account...`);
      const accountStatus = await kraken.getPaperStatus();
      console.log(formatAccountSummary(accountStatus));

      // ── Step 2: Scan all pairs ──────────────────────────────────────────
      console.log(`[agent] → Scanning ${scanner.watchlist.length} pairs...`);
      const scanResult = await scanner.scanAndDecide();
      const allResults = (scanResult as any).allResults || [];

      if (allResults.length > 0) {
        console.log(formatScanTable(allResults));
      }

      console.log(`\n[agent] → Decision: ${scanResult.action} ${scanResult.pair}`);
      console.log(`[agent]   Confidence: ${(scanResult.confidence * 100).toFixed(1)}%`);
      console.log(`[agent]   Amount: $${scanResult.amount}`);

      if (scanResult.reasoning.length > 800) {
        console.log(`[agent]   Reasoning: ${scanResult.reasoning.slice(0, 800)}...`);
      } else {
        console.log(`[agent]   Reasoning: ${scanResult.reasoning}`);
      }

      // ── Step 3: Execute trade ───────────────────────────────────────────
      let intentHash = HOLD_INTENT_HASH;
      let decision = { ...scanResult }; // mutable copy

      if (decision.action !== "HOLD" && decision.amount > 0) {

        // 3a. Build + sign TradeIntent
        const intent = await riskRouter.buildIntent(
          agentId,
          agentWallet.address,
          decision.pair,
          decision.action as "BUY" | "SELL",
          decision.amount
        );
        const signed = await riskRouter.signIntent(intent, agentWallet);
        intentHash = signed.intentHash;

        console.log(`\n[agent] → TradeIntent: ${decision.action} ${decision.pair} $${decision.amount}`);
        console.log(`[agent]   Nonce: ${intent.nonce}, Deadline: ${new Date(Number(intent.deadline) * 1000).toISOString()}`);

        // 3b. Submit to RiskRouter
        const validationResult = await riskRouter.submitIntent(signed);

        if (!validationResult.approved) {
          console.warn(`[agent]   ✗ REJECTED: ${validationResult.reason}`);
          decision.action = "HOLD";
          decision.amount = 0;
          decision.reasoning += ` [BLOCKED: ${validationResult.reason}]`;
        } else {
          console.log(`[agent]   ✓ APPROVED by RiskRouter`);

          // Get execution price
          const price = allResults.find((r: any) => r.pair === decision.pair)?.price;
          if (price && price > 0) {
            // 3c. Execute via Kraken
            const volumeBase = (decision.amount / price).toFixed(8);
            const result = await kraken.placeOrder({
              pair:      decision.pair,
              type:      decision.action === "BUY" ? "buy" : "sell",
              ordertype: "market",
              volume:    volumeBase,
            });
            console.log(`[agent]   ✓ Order filled: ${result.txid.join(", ")}`);
            console.log(`[agent]     ${result.descr.order}`);

            // Track position
            if (decision.action === "BUY") {
              scanner.recordPosition(decision.pair, price, decision.amount, parseFloat(volumeBase));
              console.log(`[agent]     Position tracked: ${decision.pair}`);
            } else {
              scanner.removePosition(decision.pair);
              console.log(`[agent]     Position closed: ${decision.pair}`);
            }
          }
        }
      } else {
        console.log(`[agent]   (no trade — HOLD or amount is 0)`);
      }

      // ── Step 4: Generate checkpoint ─────────────────────────────────────
      let checkpointMarket: MarketData;
      const tradedResult = allResults.find((r: any) => r.pair === decision.pair);
      checkpointMarket = {
        pair: decision.pair,
        price: tradedResult?.price ?? 0,
        bid: tradedResult?.price ?? 0,
        ask: tradedResult?.price ?? 0,
        volume: 0,
        vwap: tradedResult?.price ?? 0,
        high: tradedResult?.price ?? 0,
        low: tradedResult?.price ?? 0,
        timestamp: Date.now(),
      };

      const checkpoint = await generateCheckpoint(
        agentId,
        decision,
        checkpointMarket,
        intentHash,
        agentWallet,
        registryAddress,
        SEPOLIA_CHAIN_ID
      );

      console.log(formatCheckpointLog(checkpoint));

      // ── Step 5: Post to ValidationRegistry ──────────────────────────────
      const cp = checkpoint as typeof checkpoint & { checkpointHash?: string };
      if (cp.checkpointHash && decision.action !== "HOLD") {
        try {
          await validation.postCheckpointAttestation(
            agentId,
            cp.checkpointHash,
            Math.round(decision.confidence * 100),
            `${decision.action} ${decision.pair} @ score ${(decision.confidence * 100).toFixed(1)}%`
          );
          console.log(`[agent] → Checkpoint posted to ValidationRegistry`);
        } catch (e) {
          console.warn(`[agent] → ValidationRegistry post failed (non-fatal): ${(e as Error).message}`);
        }
      }

      // ── Step 6: Persist checkpoint ──────────────────────────────────────
      fs.appendFileSync(CHECKPOINTS_FILE, JSON.stringify(checkpoint) + "\n");

      // ── Step 7: Final account check ─────────────────────────────────────
      const finalStatus = await kraken.getPaperStatus();
      console.log(formatAccountSummary(finalStatus));

      // Sync scanner positions with actual paper account positions
      for (const pos of (finalStatus.positions || [])) {
        if (!scanner.getPositions().has(pos.asset + "USD")) {
          // Paper account has a position the scanner doesn't know about — add it
          scanner.recordPosition(
            pos.asset + "USD",
            pos.avgEntryPrice,
            pos.volume * pos.avgEntryPrice,
            pos.volume
          );
        }
      }

    } catch (err) {
      console.error(`[agent] Error in tick #${tickCount}:`, err);
    }
  };

  // Run first tick immediately, then on interval
  await tick();
  setInterval(tick, POLL_INTERVAL);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

runAgent().catch((err) => {
  console.error("[agent] Fatal error:", err);
  process.exit(1);
});
