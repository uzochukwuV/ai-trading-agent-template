/**
 * Kraken CLI client
 *
 * Wraps the Kraken CLI binary (https://github.com/kraken-oss/kraken-cli) instead
 * of rolling our own HTTP/HMAC client. The CLI handles all exchange plumbing:
 *   - Cryptographic nonce management
 *   - HMAC-SHA512 request signing
 *   - Rate-limit retries
 *   - Paper-trading sandbox (--sandbox flag)
 *
 * Prerequisites:
 *   1. Install the Kraken CLI:
 *      curl -sSL https://github.com/kraken-oss/kraken-cli/releases/latest/download/install.sh | sh
 *      (or download the binary for your platform from the releases page)
 *   2. Set KRAKEN_API_KEY and KRAKEN_API_SECRET in .env
 *   3. Set KRAKEN_SANDBOX=true for paper trading
 *
 * The CLI also ships with a built-in MCP server for AI agent integration.
 * See the KrakenMCPClient below for the MCP-based approach.
 *
 * CLI docs: https://github.com/kraken-oss/kraken-cli
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { KrakenOrder, KrakenOrderResult, MarketData, OHLCV, OrderBook, RecentTrade, PaperBalance, PaperAccountStatus, PaperPosition, EnrichedMarketData } from "../types/index";

const execFileAsync = promisify(execFile);

// Path to the kraken CLI binary. Override with KRAKEN_CLI_PATH env var
// if the binary is not on PATH.
const KRAKEN_BIN = process.env.KRAKEN_CLI_PATH || "kraken";

export class KrakenClient {
  private readonly sandbox: boolean;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor() {
    this.sandbox = process.env.KRAKEN_SANDBOX === "true";
    this.apiKey = process.env.KRAKEN_API_KEY || "";
    this.apiSecret = process.env.KRAKEN_API_SECRET || "";

    if (!this.apiKey || !this.apiSecret) {
      console.warn("[kraken] No API credentials set — private commands will fail");
    }
    if (this.sandbox) {
      console.log("[kraken] Running in SANDBOX (paper trading) mode");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core CLI runner
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Execute a Kraken CLI command and return parsed JSON output.
   *
   * The CLI is invoked as:
   *   kraken [--sandbox] [--api-key KEY --api-secret SECRET] <subcommand> [args...]
   *
   * All output is JSON by default when --json flag is passed.
   */
  private async run(subcommand: string[], isPrivate = false): Promise<unknown> {
    const args: string[] = [];

    if (isPrivate && !this.sandbox) {
      args.push("--api-key", this.apiKey, "--api-secret", this.apiSecret);
    }

    args.push(...subcommand);
    args.push("-o", "json");

    try {
      const { stdout } = await execFileAsync(KRAKEN_BIN, args, { timeout: 15000 });
      return JSON.parse(stdout.trim());
    } catch (err: unknown) {
      // If CLI binary not found, surface a helpful error
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `[kraken] Kraken CLI binary not found at "${KRAKEN_BIN}".\n` +
          `Install it from https://github.com/kraken-oss/kraken-cli or set KRAKEN_CLI_PATH`
        );
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Market data (public — no auth)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch live ticker data for a trading pair.
   *
   * CLI equivalent:
   *   kraken --json ticker --pair XBTUSD
   */
  async getTicker(pair: string): Promise<MarketData> {
    const result = await this.run(["ticker", pair]) as KrakenTickerResponse;

    // CLI returns data directly (no result wrapper): { "XXBTZUSD": { a, b, c, ... } }
    type TickerEntry = { a?: string[]; b?: string[]; c?: string[]; v?: string[]; p?: string[]; h?: string[]; l?: string[]; last?: string; price?: string; bid?: string; ask?: string; volume?: string; vwap?: string; high?: string; low?: string; };
    const data = (result.result ?? result) as Record<string, TickerEntry>;
    const t = data[pair] ?? data[Object.keys(data)[0]];
    if (!t) throw new Error(`[kraken] No ticker data for pair: ${pair}`);

    return {
      pair,
      price: parseFloat(t.c?.[0] ?? t.last ?? t.price ?? "0"),
      bid:   parseFloat(t.b?.[0] ?? t.bid ?? "0"),
      ask:   parseFloat(t.a?.[0] ?? t.ask ?? "0"),
      volume: parseFloat(t.v?.[1] ?? t.volume ?? "0"),
      vwap:   parseFloat(t.p?.[1] ?? t.vwap ?? "0"),
      high:   parseFloat(t.h?.[1] ?? t.high ?? "0"),
      low:    parseFloat(t.l?.[1] ?? t.low ?? "0"),
      timestamp: Date.now(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trading (private — requires API key)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Place a market or limit order.
   *
   * CLI equivalent:
   *   kraken --json order add --pair XBTUSD --type buy --ordertype market --volume 0.001
   *
   * In sandbox mode the CLI uses paper trading — no real funds are affected.
   */
  async placeOrder(order: KrakenOrder): Promise<KrakenOrderResult> {
    let args: string[];
    if (this.sandbox) {
      // Paper trading: kraken paper buy <PAIR> <VOL> [--type limit --price P]
      args = ["paper", order.type, order.pair, order.volume];
      if (order.ordertype === "limit" && order.price) args.push("--type", "limit", "--price", order.price);
    } else {
      args = ["order", "buy" === order.type ? "buy" : "sell", order.pair, order.volume, "--type", order.ordertype];
      if (order.price) args.push("--price", order.price);
    }

    const result = await this.run(args, !this.sandbox) as Record<string, unknown>;
    const data = result.result ?? result;

    // Handle paper trading response: { action, order_id, pair, price, side, trade_id, volume, cost, fee }
    if (this.sandbox && typeof data === "object" && data !== null && "action" in data) {
      const paperResult = data as Record<string, string | number>;
      const txid = [String(paperResult.trade_id ?? paperResult.order_id ?? `PAPER-${Date.now()}`)];
      const side = paperResult.side ?? order.type;
      const vol = paperResult.volume ?? order.volume;
      const pair = paperResult.pair ?? order.pair;
      return {
        txid,
        descr: { order: `PAPER ${side} ${vol} ${pair} @ $${paperResult.price ?? "market"}` },
      };
    }

    // Handle live trading response
    const orderResult = data as { txid?: string[]; descr?: { order: string } };
    if ((result as { error?: string[] }).error?.length) {
      throw new Error(`[kraken] Order error: ${(result as { error: string[] }).error.join(", ")}`);
    }

    return {
      txid: orderResult.txid ?? [`${this.sandbox ? "SANDBOX" : "ORDER"}-${Date.now()}`],
      descr: orderResult.descr ?? { order: `${order.type} ${order.volume} ${order.pair}` },
    };
  }

  /**
   * Get open orders.
   *
   * CLI equivalent:
   *   kraken --json order list
   */
  async getOpenOrders(): Promise<Record<string, unknown>> {
    const result = await this.run(["order", "list"], true) as { result?: Record<string, unknown> };
    return result.result ?? {};
  }

  /**
   * Get account balance.
   *
   * CLI equivalent:
   *   kraken --json balance
   */
  async getBalance(): Promise<Record<string, string>> {
    const result = await this.run(["balance"], true) as { result?: Record<string, string> };
    return result.result ?? {};
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Extended market data
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get OHLC candle data.
   *
   * CLI: kraken ohlc --pair XBTUSD --interval 15 -o json
   */
  async getOHLC(pair: string, interval = 15, count = 50): Promise<OHLCV[]> {
    const result = await this.run(["ohlc", pair, "--interval", String(interval)]) as Record<string, unknown>;
    const data = (result.result ?? result) as Record<string, string[][] | { last: string }>;
    const candles: OHLCV[] = [];

    for (const [key, entries] of Object.entries(data)) {
      if (key === "last") continue;
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          // Each entry: [time, open, high, low, close, vwap, volume, count]
          if (Array.isArray(entry) && entry.length >= 7) {
            candles.push({
              timestamp: parseInt(entry[0]) * 1000,
              open: parseFloat(entry[1]),
              high: parseFloat(entry[2]),
              low: parseFloat(entry[3]),
              close: parseFloat(entry[4]),
              vwap: parseFloat(entry[5]) || undefined,
              volume: parseFloat(entry[6]),
              count: entry[7] ? parseInt(entry[7]) : undefined,
            });
          }
        }
      }
    }
    // Sort ascending by time and take the requested count
    candles.sort((a, b) => a.timestamp - b.timestamp);
    return candles.slice(-count);
  }

  /**
   * Get order book.
   *
   * CLI: kraken orderbook --pair XBTUSD --depth 10 -o json
   */
  async getOrderBook(pair: string, depth = 10): Promise<OrderBook> {
    const result = await this.run(["orderbook", pair, "--depth", String(depth)]) as Record<string, unknown>;
    const data = (result.result ?? result) as Record<string, { bids: string[][]; asks: string[][] }>;
    const entry = data[pair] ?? data[Object.keys(data)[0]];
    if (!entry) throw new Error(`[kraken] No order book for pair: ${pair}`);

    const bids: Array<{ price: number; volume: number }> = [];
    const asks: Array<{ price: number; volume: number }> = [];

    if (Array.isArray(entry.bids)) {
      for (const level of entry.bids) {
        bids.push({ price: parseFloat(level[0]), volume: parseFloat(level[1]) });
      }
    }
    if (Array.isArray(entry.asks)) {
      for (const level of entry.asks) {
        asks.push({ price: parseFloat(level[0]), volume: parseFloat(level[1]) });
      }
    }

    return { pair, bids, asks, timestamp: Date.now() };
  }

  /**
   * Get recent trades.
   *
   * CLI: kraken trades --pair XBTUSD -o json
   */
  async getRecentTrades(pair: string, count = 50): Promise<RecentTrade[]> {
    const result = await this.run(["trades", pair]) as Record<string, unknown>;
    const data = result.result ?? result;
    const trades: RecentTrade[] = [];

    const entries = Array.isArray(data) ? data : ((data as Record<string, string[][]>)[pair] ?? (data as Record<string, string[][]>)[Object.keys(data)[0]] ?? []);
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (Array.isArray(entry) && entry.length >= 6) {
          // [price, volume, time, buy/sell, limit/market, misc]
          trades.push({
            price: parseFloat(entry[0]),
            volume: parseFloat(entry[1]),
            timestamp: Math.round(parseFloat(entry[2]) * 1000),
            side: entry[3] === "b" ? "buy" : "sell",
          });
        }
      }
    }
    return trades.slice(-count);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Paper trading
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialize paper trading account.
   *
   * CLI: kraken paper init --balance 10000 --currency USD -o json
   */
  async paperInit(balance = 10000, currency = "USD"): Promise<{ success: boolean }> {
    const result = await this.run(["paper", "init", "--balance", String(balance), "--currency", currency]) as { error?: string[] };
    if (result.error?.length) throw new Error(`[kraken] Paper init error: ${result.error.join(", ")}`);
    return { success: true };
  }

  /**
   * Reset paper trading account.
   *
   * CLI: kraken paper reset --balance 10000 --currency USD -o json
   */
  async paperReset(balance = 10000, currency = "USD"): Promise<{ success: boolean }> {
    const result = await this.run(["paper", "reset", "--balance", String(balance), "--currency", currency, "--yes"]) as { error?: string[] };
    if (result.error?.length) throw new Error(`[kraken] Paper reset error: ${result.error.join(", ")}`);
    return { success: true };
  }

  /**
   * Get paper account balances.
   *
   * CLI: kraken paper balance -o json
   */
  async getPaperBalances(): Promise<PaperBalance[]> {
    const result = await this.run(["paper", "balance"]) as { result?: Record<string, { balance: string; available?: string }> };
    const data = result.result ?? {};
    return Object.entries(data).map(([currency, info]) => ({
      currency,
      balance: parseFloat(info.balance),
      available: parseFloat(info.available ?? info.balance),
    }));
  }

  /**
   * Get paper account summary with P&L.
   *
   * CLI: kraken paper status -o json
   */
  async getPaperStatus(): Promise<PaperAccountStatus> {
    const result = await this.run(["paper", "status"]) as Record<string, unknown>;
    const data = (result.result ?? result) as Record<string, unknown>;

    // Parse the structured response
    const initialBalance = parseFloat((data.initial_balance ?? data.initialBalance ?? "10000") as string);
    const currentBalance = parseFloat((data.balance ?? data.currentBalance ?? String(initialBalance)) as string);
    const equity = parseFloat((data.equity ?? String(currentBalance)) as string);
    const pnl = equity - initialBalance;

    const positions: PaperPosition[] = [];
    const positionsData = data.positions as Array<Record<string, string>> | undefined;
    if (positionsData) {
      for (const pos of positionsData) {
        positions.push({
          asset: pos.asset ?? pos.symbol ?? "UNKNOWN",
          volume: parseFloat(pos.volume ?? pos.quantity ?? "0"),
          avgEntryPrice: parseFloat(pos.avg_price ?? pos.avgEntryPrice ?? "0"),
          currentPrice: parseFloat(pos.current_price ?? pos.currentPrice ?? "0"),
          pnl: parseFloat(pos.pnl ?? "0"),
          pnlPercent: parseFloat(pos.pnl_percent ?? pos.pnlPercent ?? "0"),
        });
      }
    }

    return {
      initialBalance,
      currentBalance,
      equity,
      pnl,
      pnlPercent: initialBalance > 0 ? (pnl / initialBalance) * 100 : 0,
      positions,
    };
  }

  /**
   * Get paper trade history.
   *
   * CLI: kraken paper history -o json
   */
  async getPaperHistory(): Promise<RecentTrade[]> {
    const result = await this.run(["paper", "history"]) as { result?: Array<Record<string, string>> };
    const data = result.result ?? [];
    return data.map(entry => ({
      price: parseFloat(entry.price ?? "0"),
      volume: parseFloat(entry.volume ?? "0"),
      timestamp: entry.timestamp ? parseInt(entry.timestamp) * 1000 : Date.now(),
      side: (entry.side ?? entry.type ?? "buy").includes("buy") ? "buy" : "sell",
    }));
  }

  /**
   * Cancel all paper orders.
   *
   * CLI: kraken paper cancel-all -o json --yes
   */
  async cancelAllPaperOrders(): Promise<{ success: boolean }> {
    const result = await this.run(["paper", "cancel-all", "--yes"]) as { error?: string[] };
    if (result.error?.length) throw new Error(`[kraken] Cancel all error: ${result.error.join(", ")}`);
    return { success: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Convenience: fetch enriched market data
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch enriched market data combining ticker, OHLC, order book, and trades.
   * This is the recommended entry point for advanced strategies.
   */
  async getEnrichedMarketData(pair: string, ohlcInterval = 15, ohlcCount = 50, obDepth = 10, tradeCount = 50): Promise<EnrichedMarketData> {
    const [ticker, ohlc, orderBook, recentTrades] = await Promise.all([
      this.getTicker(pair),
      this.getOHLC(pair, ohlcInterval, ohlcCount),
      this.getOrderBook(pair, obDepth).catch(() => undefined),
      this.getRecentTrades(pair, tradeCount).catch(() => undefined),
    ]);

    // Calculate order book metrics
    let bidDepth = 0, askDepth = 0, orderBookImbalance: number | undefined;
    if (orderBook) {
      bidDepth = orderBook.bids.slice(0, 10).reduce((sum, l) => sum + l.volume, 0);
      askDepth = orderBook.asks.slice(0, 10).reduce((sum, l) => sum + l.volume, 0);
      const total = bidDepth + askDepth;
      orderBookImbalance = total > 0 ? (bidDepth - askDepth) / total : 0;
    }

    // Calculate trade volume bias
    let tradeVolumeBias: number | undefined;
    if (recentTrades && recentTrades.length > 0) {
      const totalVol = recentTrades.reduce((s, t) => s + t.volume, 0);
      const buyVol = recentTrades.filter(t => t.side === "buy").reduce((s, t) => s + t.volume, 0);
      tradeVolumeBias = totalVol > 0 ? (2 * buyVol / totalVol) - 1 : 0; // -1 to 1
    }

    return {
      pair: ticker.pair,
      price: ticker.price,
      bid: ticker.bid,
      ask: ticker.ask,
      spreadBps: ticker.price > 0 ? ((ticker.ask - ticker.bid) / ticker.price) * 10000 : 0,
      volume24h: ticker.volume,
      vwap24h: ticker.vwap,
      high24h: ticker.high,
      low24h: ticker.low,
      ohlc,
      orderBook: orderBook ?? undefined,
      bidDepth,
      askDepth,
      orderBookImbalance,
      recentTrades: recentTrades ?? undefined,
      tradeVolumeBias,
      timestamp: Date.now(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kraken MCP client (alternative — for agents using the MCP protocol directly)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Kraken CLI ships with a built-in MCP server that exposes Kraken operations
 * as structured tools for AI agents. This is the preferred integration if your
 * agent already uses the Model Context Protocol.
 *
 * Start the MCP server:
 *   kraken mcp serve --port 8080
 *
 * The server exposes tools like:
 *   - kraken_ticker   { pair: string }
 *   - kraken_balance  {}
 *   - kraken_order    { pair, type, ordertype, volume }
 *
 * For LangChain/Claude tool use, wire the MCP server as a tool provider.
 * For direct use, call the MCP server via HTTP as shown below.
 *
 * See: https://github.com/kraken-oss/kraken-cli#mcp-server
 */
export class KrakenMCPClient {
  private readonly baseUrl: string;

  constructor(port = 8080) {
    this.baseUrl = `http://localhost:${port}`;
    console.log(`[kraken-mcp] Connecting to MCP server at ${this.baseUrl}`);
    console.log(`[kraken-mcp] Start server with: kraken mcp serve --port ${port}`);
  }

  /**
   * Call a tool on the MCP server.
   */
  async callTool(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    // Dynamic import to keep axios optional if only CLI mode is used
    const axios = (await import("axios")).default;
    const { data } = await axios.post(`${this.baseUrl}/tools/${toolName}`, params);
    return data;
  }

  async getTicker(pair: string): Promise<MarketData> {
    const result = await this.callTool("kraken_ticker", { pair }) as KrakenTickerResponse;
    const t = result.result?.[pair] ?? result.result?.[Object.keys(result.result ?? {})[0]];
    if (!t) throw new Error(`[kraken-mcp] No ticker data for pair: ${pair}`);
    return {
      pair,
      price: parseFloat(t.c?.[0] ?? t.last ?? "0"),
      bid: parseFloat(t.b?.[0] ?? t.bid ?? "0"),
      ask: parseFloat(t.a?.[0] ?? t.ask ?? "0"),
      volume: parseFloat(t.v?.[1] ?? t.volume ?? "0"),
      vwap: parseFloat(t.p?.[1] ?? t.vwap ?? "0"),
      high: parseFloat((t.h?.[1] ?? (t as Record<string, unknown>).high ?? "0") as string),
      low: parseFloat((t.l?.[1] ?? (t as Record<string, unknown>).low ?? "0") as string),
      timestamp: Date.now(),
    };
  }

  async placeOrder(order: KrakenOrder): Promise<KrakenOrderResult> {
    const result = await this.callTool("kraken_order", { ...order }) as KrakenOrderResponse;
    return {
      txid: result.result?.txid ?? [`MCP-${Date.now()}`],
      descr: result.result?.descr ?? { order: `${order.type} ${order.volume} ${order.pair}` },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types for CLI response shapes
// ─────────────────────────────────────────────────────────────────────────────

interface KrakenTickerResponse {
  error?: string[];
  result?: Record<string, {
    a?: string[]; b?: string[]; c?: string[]; v?: string[];
    p?: string[]; h?: string[]; l?: string[];
    last?: string; price?: string; bid?: string; ask?: string; volume?: string; vwap?: string; high?: string; low?: string;
  }>;
}

interface KrakenOrderResponse {
  error?: string[];
  result?: {
    txid: string[];
    descr: { order: string };
  };
}
