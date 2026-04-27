/**
 * Paper Trading Management Script
 *
 * Commands:
 *   npx ts-node scripts/paper-manager.ts init     — Initialize paper account
 *   npx ts-node scripts/paper-manager.ts reset    — Reset paper account
 *   npx ts-node scripts/paper-manager.ts status   — Show paper status
 *   npx ts-node scripts/paper-manager.ts balance  — Show balances
 *   npx ts-node scripts/paper-manager.ts history  — Show trade history
 */

import * as dotenv from "dotenv";
dotenv.config();

import { KrakenClient } from "../src/exchange/kraken";

const kraken = new KrakenClient();

async function main() {
  const command = process.argv[2];

  switch (command) {
    case "init": {
      const balance = parseFloat(process.argv[3] || "10000");
      const currency = process.argv[4] || "USD";
      console.log(`Initializing paper trading: $${balance} ${currency}`);
      await kraken.paperInit(balance, currency);
      console.log("✓ Paper trading initialized");
      break;
    }

    case "reset": {
      const balance = parseFloat(process.argv[3] || "10000");
      const currency = process.argv[4] || "USD";
      console.log(`Resetting paper trading: $${balance} ${currency}`);
      await kraken.paperReset(balance, currency);
      console.log("✓ Paper trading reset");
      break;
    }

    case "status": {
      const status = await kraken.getPaperStatus();
      console.log("\n─── Paper Trading Status ───");
      console.log(`Initial Balance:  $${status.initialBalance.toFixed(2)}`);
      console.log(`Current Balance:  $${status.currentBalance.toFixed(2)}`);
      console.log(`Equity:           $${status.equity.toFixed(2)}`);
      console.log(`P&L:              $${status.pnl.toFixed(2)} (${status.pnlPercent.toFixed(2)}%)`);

      if (status.positions.length > 0) {
        console.log("\n─── Positions ───");
        for (const pos of status.positions) {
          console.log(`  ${pos.asset}: ${pos.volume} units`);
          console.log(`    Entry: $${pos.avgEntryPrice.toFixed(2)} → Current: $${pos.currentPrice.toFixed(2)}`);
          console.log(`    P&L: $${pos.pnl.toFixed(2)} (${pos.pnlPercent.toFixed(2)}%)`);
        }
      } else {
        console.log("\nNo open positions");
      }
      console.log("─".repeat(30));
      break;
    }

    case "balance": {
      const balances = await kraken.getPaperBalances();
      console.log("\n─── Paper Balances ───");
      for (const b of balances) {
        console.log(`  ${b.currency}: ${b.balance.toFixed(4)} (available: ${b.available.toFixed(4)})`);
      }
      console.log("─".repeat(30));
      break;
    }

    case "history": {
      const history = await kraken.getPaperHistory();
      console.log("\n─── Paper Trade History ───");
      if (history.length === 0) {
        console.log("  No trades yet");
      } else {
        for (const trade of history.slice(-20)) {
          const time = new Date(trade.timestamp).toISOString();
          console.log(`  ${time} ${trade.side.toUpperCase()} ${trade.volume} @ $${trade.price.toFixed(2)}`);
        }
      }
      console.log("─".repeat(30));
      break;
    }

    case "cancel-all": {
      await kraken.cancelAllPaperOrders();
      console.log("✓ All paper orders cancelled");
      break;
    }

    default:
      console.log(`
Paper Trading Management

Usage:
  npx ts-node scripts/paper-manager.ts init [balance] [currency]   — Initialize paper account
  npx ts-node scripts/paper-manager.ts reset [balance] [currency]  — Reset paper account
  npx ts-node scripts/paper-manager.ts status                      — Show status & P&L
  npx ts-node scripts/paper-manager.ts balance                     — Show balances
  npx ts-node scripts/paper-manager.ts history                     — Show trade history
  npx ts-node scripts/paper-manager.ts cancel-all                  — Cancel all orders

Examples:
  npx ts-node scripts/paper-manager.ts init 10000 USD
  npx ts-node scripts/paper-manager.ts status
      `);
  }
}

main().catch((err) => {
  console.error("[paper] Fatal:", err);
  process.exit(1);
});
