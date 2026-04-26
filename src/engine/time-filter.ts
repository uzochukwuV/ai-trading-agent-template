/**
 * Time-of-day liquidity filter.
 *
 * Crypto runs 24/7 but liquidity / spreads are not uniform. We define
 * windows that:
 *   - block new entries during the worst liquidity windows
 *   - dampen position sizing during low-liquidity windows
 *   - boost sizing during peak overlap (London-NY)
 *
 * Times are in UTC.
 */

export interface SessionState {
  utcHour: number;
  weekday: number;        // 0 Sun .. 6 Sat
  session: "off-hours" | "asia" | "europe" | "overlap" | "us" | "weekend-low";
  allowEntries: boolean;
  sizingMultiplier: number;        // multiply riskBudget by this
  reason: string;
}

export function evaluateSession(now = new Date()): SessionState {
  const h = now.getUTCHours();
  const wd = now.getUTCDay();        // 0=Sun, 6=Sat
  const isWeekend = wd === 0 || wd === 6;

  // Worst window: weekend graveyard 00:00-04:00 UTC, when spreads blow out
  if (isWeekend && h >= 0 && h < 4) {
    return { utcHour: h, weekday: wd, session: "weekend-low", allowEntries: false, sizingMultiplier: 0,
      reason: "Weekend graveyard hours (00-04 UTC) — entries blocked" };
  }

  // Off-hours global lull (very early UTC weekdays before Asia warms up)
  if (!isWeekend && (h >= 1 && h < 5)) {
    return { utcHour: h, weekday: wd, session: "off-hours", allowEntries: true, sizingMultiplier: 0.5,
      reason: "Pre-Asia lull — sizing reduced 50%" };
  }

  // Asia session — moderate
  if (h >= 0 && h < 7) {
    return { utcHour: h, weekday: wd, session: "asia", allowEntries: true, sizingMultiplier: 0.85,
      reason: "Asia session — slightly reduced sizing" };
  }

  // Europe open — good liquidity
  if (h >= 7 && h < 12) {
    return { utcHour: h, weekday: wd, session: "europe", allowEntries: true, sizingMultiplier: 1.0,
      reason: "Europe session — normal sizing" };
  }

  // London / NY overlap — best liquidity
  if (h >= 12 && h < 17) {
    return { utcHour: h, weekday: wd, session: "overlap", allowEntries: true, sizingMultiplier: 1.15,
      reason: "London-NY overlap — peak liquidity" };
  }

  // US afternoon
  if (h >= 17 && h < 21) {
    return { utcHour: h, weekday: wd, session: "us", allowEntries: true, sizingMultiplier: 1.0,
      reason: "US afternoon — normal sizing" };
  }

  // Late US / pre-Asia
  return { utcHour: h, weekday: wd, session: "off-hours", allowEntries: true, sizingMultiplier: 0.7,
    reason: "Late US pre-Asia handoff — sizing reduced" };
}
