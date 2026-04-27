# AI Trading Agents Hackathon — Claude Context

## Overview
Lablab.ai hackathon running **March 30 – April 12, 2026** built around ERC-8004 (AI Agent Identity Registry).
Leaderboard: https://leaderboard.stevekimoi.me
Server: Contabo VPS — ssh root@154.38.174.112 (password in env)

---

## Deployed Contracts (Sepolia)

| Contract | Address |
|---|---|
| AgentRegistry | 0x97b07dDc405B0c28B17559aFFE63BdB3632d0ca3 |
| HackathonVault | 0x0E7CD8ef9743FEcf94f9103033a044caBD45fC90 |
| RiskRouter | 0xd6A6952545FF6E6E6681c2d15C59f9EB8F40FdBC |
| ValidationRegistry | 0x92bF63E5C7Ac6980f237a7164Ab413BE226187F1 |
| ReputationRegistry | 0x423a9904e39537a9997fbaF0f220d79D7d545763 |

---

## Key Scripts

### `scripts/seed-test-agents.ts`
Creates 3 test agents (AlphaBot #14, DeltaHedge #15, GridMaster #16) through the full ERC-8004 flow.
Uses deterministic wallets via `ethers.id(seed)` so it's safe to re-run without re-registering.
Run: `npx hardhat run scripts/seed-test-agents.ts --network sepolia`

### `scripts/admin-vault.ts`
Owner-only. Lowers `allocationPerTeam` and tops up the HackathonVault.
Current settings: allocationPerTeam = 0.001 ETH, vault has ~0.039 ETH unallocated.
Run: `npx hardhat run scripts/admin-vault.ts --network sepolia`

### `scripts/auto-reputation.ts`
**Judge bot** — reads all registered agents' on-chain metrics and submits reputation scores
to ReputationRegistry from a dedicated judge wallet.

**Judge wallet:** 0xC15FdA1D429C758C01a2084AacfACa90Ff15a2f1
**Judge wallet seed:** `lablab-hackathon-judge-wallet-v1`
**Balance:** ~0.039 ETH remaining (as of Apr 7 2026)

Scoring formula:
- Validation avg score * 0.50 => 0-50 pts
- Trades submitted * 3 => 0-30 pts (capped at 10 trades)
- Vault claimed => 0 or 10 pts
- Any validation posted => 0 or 10 pts (activity bonus)

**Important:** ReputationRegistry only allows ONE feedback submission per rater per agent.
The judge wallet has already rated agents #1-6 and #7-24 (first full run on Apr 7).
Future runs will only score newly registered agents (agentId > 24).

**Cron:** Running every 4h on server — `crontab -l` to verify.
Log: `/var/log/auto-rep.log`

Run manually: `npx hardhat run scripts/auto-reputation.ts --network sepolia`

---

## Leaderboard (`leaderboard.html`)

Served from `/var/www/leaderboard/index.html` on the Contabo server.
Deploy: `sshpass -p '...' scp leaderboard.html root@154.38.174.112:/var/www/leaderboard/index.html`

**Key technical notes:**
- Uses ethers v5 (CDN: cdnjs.cloudflare.com) — NOT ethers v6
- `getAgent()` ABI must use `tuple(...)` wrapper or ethers v5 fails to decode struct returns
- RPCs: publicnode + drpc (Infura removed — was returning 403)
- Default theme: light. Toggle saves to localStorage.
- Ranking: validation score primary, reputation tiebreaker
- Auto-refreshes every 30s

---

## HackathonVault — Important Notes

- Vault claim is **optional** for building/judging. RiskRouter does NOT check vault balance.
- Vault tracks notional sandbox capital on-chain for judging purposes only.
- ETH stays in the vault contract; only `allocatedCapital[agentId]` mapping updates on claim.
- allocationPerTeam was lowered from 0.05 ETH -> 0.001 ETH on Apr 6 to allow more teams to claim.

---

## Reputation Scoring — Important Notes

- Operators CANNOT self-rate (contract enforces this).
- The judge wallet (`0xC15FdA1...`) is the automated rater — it is NOT the operator of any agent.
- Contract allows only ONE feedback per rater per agent — the bot cannot update scores on re-runs.
- Validation score (from ValidationRegistry) IS something teams control by posting checkpoints.
- Reputation score comes from the judge bot + any external validators.

---

## Tests

`test/HackathonVault.test.ts` — 20 passing unit tests for the vault claim flow.
Run: `npx hardhat test`
Run with Sepolia fork: `FORK=1 npx hardhat test`
