import * as dotenv from "dotenv";
dotenv.config();
import { KrakenFuturesClient } from "../src/engine/kraken-futures";

(async () => {
  const c = new KrakenFuturesClient({
    env: "demo",
    apiKey: process.env.KRAKEN_FUTURES_DEMO_KEY,
    apiSecret: process.env.KRAKEN_FUTURES_DEMO_SECRET,
  });
  console.log("authed?", c.isAuthed());
  try {
    const acc = await c.getAccounts();
    console.log("accounts ok, types:", Object.keys(acc.raw));
    if (acc.flex) {
      console.log("flex summary:", JSON.stringify({
        type: acc.flex.type,
        portfolioValue: acc.flex.portfolioValue,
        marginEquity: acc.flex.marginEquity,
        availableMargin: acc.flex.availableMargin,
        balances: acc.flex.balances,
      }, null, 2));
    }
  } catch (e) {
    console.error("ACCOUNTS ERROR:", (e as Error).message);
  }
  try {
    const pos = await c.getOpenPositions();
    console.log("openPositions:", pos.length, pos.map(p => `${p.symbol} ${p.side} ${p.size}@${p.price}`));
  } catch (e) {
    console.error("POSITIONS ERROR:", (e as Error).message);
  }
  try {
    const ts = await c.getTickers();
    const x = ts.get("PF_XBTUSD");
    console.log("PF_XBTUSD ticker:", x ? `mark=${x.markPrice} bid=${x.bid} ask=${x.ask} fund=${x.fundingRate}` : "missing");
    console.log("ticker count:", ts.size);
  } catch (e) {
    console.error("TICKERS ERROR:", (e as Error).message);
  }
})();
