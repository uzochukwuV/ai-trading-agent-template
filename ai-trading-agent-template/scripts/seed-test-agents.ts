/**
 * seed-test-agents.ts
 * Creates 3 test agents that go through the full ERC-8004 flow:
 *   register → claim vault → set risk params → submit trade intents → post checkpoints → reputation
 *
 * All 3 agents will appear on the leaderboard at leaderboard.stevekimoi.me
 *
 * Run: npx hardhat run scripts/seed-test-agents.ts --network sepolia
 */

import { ethers } from "hardhat";

// ── Shared contract addresses (Sepolia) ──────────────────────────────────────
const REGISTRY_ADDR    = "0x97b07dDc405B0c28B17559aFFE63BdB3632d0ca3";
const VAULT_ADDR       = "0x0E7CD8ef9743FEcf94f9103033a044caBD45fC90";
const ROUTER_ADDR      = "0xd6A6952545FF6E6E6681c2d15C59f9EB8F40FdBC";
const VALIDATION_ADDR  = "0x92bF63E5C7Ac6980f237a7164Ab413BE226187F1";
const REPUTATION_ADDR  = "0x423a9904e39537a9997fbaF0f220d79D7d545763";

// ── ABIs (only what we need) ──────────────────────────────────────────────────
const REGISTRY_ABI = [
  "function register(address agentWallet, string name, string description, string[] capabilities, string agentURI) external returns (uint256 agentId)",
  "function getAgent(uint256 agentId) external view returns (tuple(address operatorWallet, address agentWallet, string name, string description, string[] capabilities, uint256 registeredAt, bool active))",
  "event AgentRegistered(uint256 indexed agentId, address indexed operatorWallet, address indexed agentWallet, string name)",
];

const VAULT_ABI = [
  "function claimAllocation(uint256 agentId) external",
  "function hasClaimed(uint256 agentId) external view returns (bool)",
  "function allocationPerTeam() external view returns (uint256)",
  "function unallocatedBalance() external view returns (uint256)",
];

const ROUTER_ABI = [
  "function setRiskParams(uint256 agentId, uint256 maxPositionUsdScaled, uint256 maxDrawdownBps, uint256 maxTradesPerHour) external",
  "function submitTradeIntent(tuple(uint256 agentId, address agentWallet, string pair, string action, uint256 amountUsdScaled, uint256 maxSlippageBps, uint256 nonce, uint256 deadline) intent, bytes signature) external returns (bool approved, string reason)",
  "function getIntentNonce(uint256 agentId) external view returns (uint256)",
  "event TradeApproved(uint256 indexed agentId, bytes32 indexed intentHash, uint256 amountUsdScaled)",
  "event TradeRejected(uint256 indexed agentId, bytes32 indexed intentHash, string reason)",
  "event TradeIntentSubmitted(uint256 indexed agentId, bytes32 indexed intentHash, string pair, string action, uint256 amountUsdScaled)",
];

const VALIDATION_ABI = [
  "function postEIP712Attestation(uint256 agentId, bytes32 checkpointHash, uint8 score, string notes) external",
  "function getAverageValidationScore(uint256 agentId) external view returns (uint256)",
];

const REPUTATION_ABI = [
  "function submitFeedback(uint256 agentId, uint8 score, bytes32 outcomeRef, string comment, uint8 feedbackType) external",
  "function getAverageScore(uint256 agentId) external view returns (uint256)",
];

// ── EIP-712 domain for RiskRouter ─────────────────────────────────────────────
const ROUTER_DOMAIN = {
  name: "RiskRouter",
  version: "1",
  chainId: 11155111,
  verifyingContract: ROUTER_ADDR,
};

const TRADE_INTENT_TYPES = {
  TradeIntent: [
    { name: "agentId",         type: "uint256" },
    { name: "agentWallet",     type: "address" },
    { name: "pair",            type: "string"  },
    { name: "action",          type: "string"  },
    { name: "amountUsdScaled", type: "uint256" },
    { name: "maxSlippageBps",  type: "uint256" },
    { name: "nonce",           type: "uint256" },
    { name: "deadline",        type: "uint256" },
  ],
};

// ── Test agent definitions ────────────────────────────────────────────────────
// One trade + one checkpoint per agent to minimise gas usage
const TEST_AGENTS = [
  {
    name:         "AlphaBot",
    description:  "Momentum-based BTC/USD trading agent. Buys strength, cuts losers fast.",
    capabilities: ["trading", "momentum", "eip712-signing"],
    // Deterministic seed so we can resume without re-registering
    agentWalletSeed: "alphabot-agent-wallet-seed-v1",
    trades: [
      { pair: "XBTUSD", action: "BUY", amountUsdScaled: 20000, score: 82,
        note: "Strong uptrend detected. RSI 68, volume spike +40%. Entering long." },
    ],
  },
  {
    name:         "DeltaHedge",
    description:  "Risk-adjusted delta-neutral agent. Pairs BTC longs with ETH shorts to capture spread.",
    capabilities: ["trading", "hedging", "risk-management", "eip712-signing"],
    agentWalletSeed: "deltahedge-agent-wallet-seed-v1",
    trades: [
      { pair: "ETHUSD", action: "SELL", amountUsdScaled: 25000, score: 90,
        note: "Opening hedge leg. ETH overextended vs BTC. Short with tight stop." },
    ],
  },
  {
    name:         "GridMaster",
    description:  "Grid trading agent. Places layered orders at fixed intervals, profits from volatility.",
    capabilities: ["trading", "grid-strategy", "mean-reversion", "eip712-signing"],
    agentWalletSeed: "gridmaster-agent-wallet-seed-v1",
    trades: [
      { pair: "XBTUSD", action: "BUY", amountUsdScaled: 8000, score: 80,
        note: "Grid level 1 triggered. Price -2% from anchor. First accumulation." },
    ],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function signTradeIntent(
  agentWallet: ethers.Wallet,
  agentId: bigint,
  trade: { pair: string; action: string; amountUsdScaled: number },
  nonce: bigint
): Promise<{ intent: object; signature: string }> {
  const deadline = Math.floor(Date.now() / 1000) + 600; // 10 min

  const intent = {
    agentId,
    agentWallet: agentWallet.address,
    pair:            trade.pair,
    action:          trade.action,
    amountUsdScaled: trade.amountUsdScaled,
    maxSlippageBps:  100,
    nonce,
    deadline,
  };

  const signature = await agentWallet.signTypedData(ROUTER_DOMAIN, TRADE_INTENT_TYPES, intent);
  return { intent, signature };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [operator] = await ethers.getSigners();
  const provider   = operator.provider!;

  console.log("\n" + "=".repeat(60));
  console.log("  Seed Test Agents — ERC-8004 Full Flow");
  console.log("=".repeat(60));
  console.log(`Operator: ${operator.address}`);
  console.log(`Balance:  ${ethers.formatEther(await provider.getBalance(operator.address))} ETH\n`);

  // Connect to shared contracts
  const registry   = new ethers.Contract(REGISTRY_ADDR,   REGISTRY_ABI,   operator);
  const vault      = new ethers.Contract(VAULT_ADDR,      VAULT_ABI,      operator);
  const router     = new ethers.Contract(ROUTER_ADDR,     ROUTER_ABI,     operator);
  const validation = new ethers.Contract(VALIDATION_ADDR, VALIDATION_ABI, operator);
  const reputation = new ethers.Contract(REPUTATION_ADDR, REPUTATION_ABI, operator);

  // Vault state
  const allocation  = await vault.allocationPerTeam();
  const unallocated = await vault.unallocatedBalance();
  console.log(`Vault allocation/team: ${ethers.formatEther(allocation)} ETH`);
  console.log(`Vault unallocated:     ${ethers.formatEther(unallocated)} ETH\n`);

  const results: { name: string; agentId: bigint; validationScore: bigint; reputationScore: bigint }[] = [];

  for (const agentDef of TEST_AGENTS) {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`  Agent: ${agentDef.name}`);
    console.log("─".repeat(50));

    // Deterministic wallet — same address every run, safe to resume
    const agentWallet = new ethers.Wallet(
      ethers.id(agentDef.agentWalletSeed)  // keccak256 of seed → private key
    );
    console.log(`  agentWallet: ${agentWallet.address}`);

    // ── Step 1: Register (skip if already registered) ────────────────────────
    process.stdout.write("  [1/5] Registering on AgentRegistry... ");

    const REGISTRY_FULL_ABI = [
      ...REGISTRY_ABI,
      "function walletToAgentId(address agentWallet) external view returns (uint256)",
    ];
    const registryFull = new ethers.Contract(REGISTRY_ADDR, REGISTRY_FULL_ABI, operator);

    let agentId: bigint;
    const existingId: bigint = await registryFull.walletToAgentId(agentWallet.address);

    if (existingId > 0n) {
      agentId = existingId;
      console.log(`already registered — agentId = ${agentId}`);
    } else {
      const agentURI = `data:application/json,${encodeURIComponent(JSON.stringify({
        name:         agentDef.name,
        description:  agentDef.description,
        capabilities: agentDef.capabilities,
        agentWallet:  agentWallet.address,
        version:      "1.0.0",
      }))}`;

      const regTx = await registry.register(
        agentWallet.address,
        agentDef.name,
        agentDef.description,
        agentDef.capabilities,
        agentURI
      );
      const regReceipt = await regTx.wait();

      agentId = 0n;
      for (const log of regReceipt.logs) {
        try {
          const parsed = registry.interface.parseLog(log);
          if (parsed?.name === "AgentRegistered") { agentId = parsed.args.agentId as bigint; break; }
        } catch {}
      }
      if (agentId === 0n) throw new Error("AgentRegistered event not found");
      console.log(`agentId = ${agentId}`);
    }

    // ── Step 2: Claim vault allocation ───────────────────────────────────────
    process.stdout.write("  [2/5] Claiming vault allocation... ");
    const alreadyClaimed = await vault.hasClaimed(agentId);
    if (alreadyClaimed) {
      console.log("already claimed, skipping");
    } else {
      const claimTx = await vault.claimAllocation(agentId);
      await claimTx.wait();
      console.log(`✅ ${ethers.formatEther(allocation)} ETH claimed`);
    }

    // ── Step 3: Set risk params ──────────────────────────────────────────────
    process.stdout.write("  [3/5] Setting risk params on RiskRouter... ");
    const riskTx = await router.setRiskParams(
      agentId,
      BigInt(50000),  // $500 max per trade
      BigInt(500),    // 5% max drawdown
      BigInt(10)      // 10 trades/hour
    );
    await riskTx.wait();
    console.log("✅");

    // ── Step 4: Submit trade intents ─────────────────────────────────────────
    console.log(`  [4/5] Submitting ${agentDef.trades.length} trade intents...`);
    for (const trade of agentDef.trades) {
      const nonce = await router.getIntentNonce(agentId);
      const { intent, signature } = await signTradeIntent(agentWallet, agentId, trade, nonce);

      const tx = await router.submitTradeIntent(intent, signature);
      const receipt = await tx.wait();

      // Find approval/rejection event
      let outcome = "?";
      for (const log of receipt.logs) {
        try {
          const parsed = router.interface.parseLog(log);
          if (parsed?.name === "TradeApproved") outcome = "✅ APPROVED";
          if (parsed?.name === "TradeRejected") outcome = `❌ REJECTED: ${parsed.args.reason}`;
        } catch {}
      }
      console.log(`    ${trade.action} ${trade.pair} $${trade.amountUsdScaled / 100} — ${outcome}`);
    }

    // ── Step 5a: Post checkpoints to ValidationRegistry ──────────────────────
    console.log(`  [5/5] Posting checkpoints + reputation...`);
    for (const trade of agentDef.trades) {
      const checkpointData = JSON.stringify({
        agentId: agentId.toString(),
        timestamp: Date.now(),
        action: trade.action,
        pair: trade.pair,
        amountUsdScaled: trade.amountUsdScaled,
        reasoning: trade.note,
      });
      const checkpointHash = ethers.keccak256(ethers.toUtf8Bytes(checkpointData));

      const valTx = await validation.postEIP712Attestation(
        agentId,
        checkpointHash,
        trade.score,
        trade.note
      );
      await valTx.wait();
      console.log(`    Checkpoint posted — score: ${trade.score}/100`);
    }

    const finalValidation = await validation.getAverageValidationScore(agentId);
    const finalReputation = await reputation.getAverageScore(agentId);
    console.log(`    → Avg validation score: ${finalValidation}`);
    console.log(`    → Avg reputation score: ${finalReputation}`);

    results.push({ name: agentDef.name, agentId, validationScore: finalValidation, reputationScore: finalReputation });
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("  Done — 3 agents live on leaderboard");
  console.log("=".repeat(60));
  console.log("  Check: http://leaderboard.stevekimoi.me\n");
  console.log("  Agent".padEnd(16) + "agentId".padEnd(12) + "Validation".padEnd(14) + "Reputation");
  console.log("  " + "─".repeat(50));
  for (const r of results) {
    console.log(`  ${r.name.padEnd(14)} ${String(r.agentId).padEnd(10)} ${String(r.validationScore).padEnd(12)} ${r.reputationScore}`);
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
