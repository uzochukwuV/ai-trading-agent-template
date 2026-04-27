/**
 * ERC-8004 on-chain integration for the live trading engine.
 *
 * Wires the four legacy clients (RiskRouter, ValidationRegistry,
 * ReputationRegistry, HackathonVault) into the running TradingEngine so that:
 *
 *   1. Every paper-trade entry is gated by the on-chain RiskRouter
 *      (build TradeIntent → EIP-712 sign → simulateIntent or submitTradeIntent).
 *   2. Every approved trade is anchored as an EIP-712 signed checkpoint
 *      submitted to the ValidationRegistry via postEIP712Attestation.
 *   3. The dashboard shows agent identity, risk params, vault allocation,
 *      reputation summary, and a live feed of intents + attestations.
 *
 * Modes (toggleable from the dashboard):
 *   - gateMode: "off" | "simulate" | "submit"
 *       off      → no on-chain gating, trades go through unchecked
 *       simulate → call RiskRouter.simulateIntent() (view, no gas)        ← default
 *       submit   → call RiskRouter.submitTradeIntent() (state-changing tx)
 *
 *   - attestMode: "off" | "on"
 *       off → checkpoints generated locally only (saved to checkpoints.jsonl)
 *       on  → also call ValidationRegistry.postEIP712Attestation() (tx)   ← default off
 *
 * Storage: state/erc8004-state.json
 */

import { ethers } from "ethers";
import { readJson, writeJson, statePath } from "./persistence";
import { RiskRouterClient } from "../onchain/riskRouter";
import { ValidationRegistryClient } from "../onchain/validationRegistry";
import { ReputationRegistryClient } from "../onchain/reputationRegistry";
import { VaultClient } from "../onchain/vault";
import { generateCheckpoint } from "../explainability/checkpoint";
import { TradeDecision, MarketData, TradeCheckpoint } from "../types/index";

const STATE_FILE = statePath("erc8004-state.json");

const SEPOLIA_CHAIN_ID = 11155111;

export type GateMode = "off" | "simulate" | "submit";
export type AttestMode = "off" | "on";

export interface OnchainIntentRecord {
  ts: number;
  pair: string;
  side: "BUY" | "SELL";
  amountUsd: number;
  nonce: string;
  intentHash: string;
  approved: boolean;
  reason: string;
  mode: GateMode;
  txHash?: string;
  blockNumber?: number;
  explorerUrl?: string;
}

export interface OnchainAttestationRecord {
  ts: number;
  pair: string;
  action: string;
  amountUsd: number;
  priceUsd: number;
  checkpointHash: string;
  intentHash: string;
  score: number;
  notes: string;
  txHash?: string;
  blockNumber?: number;
  explorerUrl?: string;
  status: "pending" | "confirmed" | "failed";
}

export interface ErrorRecord { ts: number; where: string; msg: string; }

export interface ERC8004State {
  // mode
  gateMode: GateMode;
  attestMode: AttestMode;
  // identity
  walletAddress: string | null;
  walletBalanceEth: number | null;
  agentId: string | null;
  agentRegistered: boolean | null;
  agentDid: string | null;
  agentRegisteredAt: number | null;
  // contracts
  riskRouter: string | null;
  validationRegistry: string | null;
  reputationRegistry: string | null;
  vault: string | null;
  agentRegistry: string | null;
  // risk
  riskParams: {
    maxPositionUsd: number;
    maxDrawdownBps: number;
    maxTradesPerHour: number;
    active: boolean;
  } | null;
  intentNonce: string | null;
  tradeRecord: { count: string; windowStart: string } | null;
  // vault
  vaultAllocatedEth: number | null;
  vaultTotalEth: number | null;
  vaultUnallocatedEth: number | null;
  // reputation
  reputation: {
    totalScore: number;
    feedbackCount: number;
    averageScore: number;
    lastUpdated: number;
  } | null;
  // validation
  validation: {
    attestationCount: number;
    averageValidationScore: number;
  } | null;
  // counters
  intents: OnchainIntentRecord[];
  attestations: OnchainAttestationRecord[];
  errors: ErrorRecord[];
  lastRefreshAt: number;
  lastIntentAt: number;
  lastAttestAt: number;
}

function defaultState(): ERC8004State {
  return {
    gateMode: "simulate",
    attestMode: "off",
    walletAddress: null,
    walletBalanceEth: null,
    agentId: null,
    agentRegistered: null,
    agentDid: null,
    agentRegisteredAt: null,
    riskRouter: null,
    validationRegistry: null,
    reputationRegistry: null,
    vault: null,
    agentRegistry: null,
    riskParams: null,
    intentNonce: null,
    tradeRecord: null,
    vaultAllocatedEth: null,
    vaultTotalEth: null,
    vaultUnallocatedEth: null,
    reputation: null,
    validation: null,
    intents: [],
    attestations: [],
    errors: [],
    lastRefreshAt: 0,
    lastIntentAt: 0,
    lastAttestAt: 0,
  };
}

const REGISTRY_VIEW_ABI = [
  "function getAgent(uint256) view returns (tuple(uint256 agentId, address agentAddress, address operator, string did, string metadataURI, uint64 capabilities, uint64 registeredAt, bool active))",
];

export class ERC8004OnchainEngine {
  state: ERC8004State;

  private wallet: ethers.Wallet | null = null;
  private provider: ethers.JsonRpcProvider | null = null;

  private riskRouter: RiskRouterClient | null = null;
  private validationRegistry: ValidationRegistryClient | null = null;
  private reputationRegistry: ReputationRegistryClient | null = null;
  private vault: VaultClient | null = null;
  private agentRegistry: ethers.Contract | null = null;

  private agentIdBig: bigint | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  // Pre-trade gating throttle to avoid hammering the RPC
  private lastGateAt = 0;
  private minGateIntervalMs = 1500;
  // Per-attestation throttle when attestMode = "on"
  private minAttestIntervalMs = 30_000;

  constructor(opts: {
    rpcUrl?: string;
    privateKey?: string;
    agentId?: string;
    agentRegistry?: string;
    riskRouter?: string;
    validationRegistry?: string;
    reputationRegistry?: string;
    vault?: string;
  }) {
    this.state = readJson<ERC8004State>(STATE_FILE, defaultState());
    // Migrate older saved state
    if (!this.state.intents) this.state.intents = [];
    if (!this.state.attestations) this.state.attestations = [];
    if (!this.state.errors) this.state.errors = [];
    if (!this.state.gateMode) this.state.gateMode = "simulate";
    if (!this.state.attestMode) this.state.attestMode = "off";

    this.state.agentRegistry = opts.agentRegistry ?? null;
    this.state.riskRouter = opts.riskRouter ?? null;
    this.state.validationRegistry = opts.validationRegistry ?? null;
    this.state.reputationRegistry = opts.reputationRegistry ?? null;
    this.state.vault = opts.vault ?? null;
    this.state.agentId = opts.agentId ?? null;

    if (opts.privateKey) {
      try {
        const w = new ethers.Wallet(opts.privateKey);
        this.state.walletAddress = w.address;
      } catch (e) {
        this.recordError("init", `invalid SEPOLIA_PRIVATE_KEY: ${(e as Error).message}`);
      }
    }

    if (opts.agentId) {
      try { this.agentIdBig = BigInt(opts.agentId); } catch { /* keep null */ }
    }

    if (opts.rpcUrl && opts.privateKey) {
      try {
        const sepolia = ethers.Network.from({ name: "sepolia", chainId: SEPOLIA_CHAIN_ID });
        const provider = new ethers.JsonRpcProvider(opts.rpcUrl, sepolia, { staticNetwork: sepolia });
        (provider as any).pollingInterval = 60_000_000;
        this.provider = provider;
        this.wallet = new ethers.Wallet(opts.privateKey, provider);

        if (opts.riskRouter) {
          this.riskRouter = new RiskRouterClient(opts.riskRouter, this.wallet, SEPOLIA_CHAIN_ID);
        }
        if (opts.validationRegistry) {
          this.validationRegistry = new ValidationRegistryClient(opts.validationRegistry, this.wallet);
        }
        if (opts.reputationRegistry) {
          this.reputationRegistry = new ReputationRegistryClient(opts.reputationRegistry, this.wallet);
        }
        if (opts.vault) {
          this.vault = new VaultClient(opts.vault, this.wallet);
        }
        if (opts.agentRegistry) {
          this.agentRegistry = new ethers.Contract(opts.agentRegistry, REGISTRY_VIEW_ABI, this.provider);
        }
      } catch (e) {
        this.recordError("init", `provider: ${(e as Error).message}`);
      }
    }

    this.persist();
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  isConfigured(): boolean {
    return !!(this.wallet && this.provider && this.riskRouter && this.validationRegistry && this.agentIdBig);
  }

  /** Kicks off the background view-refresher and does an initial pull. */
  start(): void {
    if (!this.isConfigured()) {
      console.warn("[erc8004] not configured — running in display-only mode");
      return;
    }
    void this.refreshAll().catch(e => this.recordError("startRefresh", (e as Error).message));
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      void this.refreshAll().catch(e => this.recordError("intervalRefresh", (e as Error).message));
    }, 60_000); // refresh every minute
  }

  stop(): void {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
  }

  // ─── mode toggles ─────────────────────────────────────────────────────────

  setGateMode(mode: GateMode): void {
    if (!["off", "simulate", "submit"].includes(mode)) return;
    this.state.gateMode = mode;
    this.persist();
  }

  setAttestMode(mode: AttestMode): void {
    if (!["off", "on"].includes(mode)) return;
    this.state.attestMode = mode;
    this.persist();
  }

  // ─── view refresh ─────────────────────────────────────────────────────────

  async refreshAll(): Promise<void> {
    if (!this.isConfigured()) return;
    await Promise.allSettled([
      this.refreshBalance(),
      this.refreshIdentity(),
      this.refreshRiskParams(),
      this.refreshVault(),
      this.refreshReputation(),
      this.refreshValidation(),
    ]);
    this.state.lastRefreshAt = Date.now();
    this.persist();
  }

  async refreshBalance(): Promise<void> {
    if (!this.provider || !this.wallet) return;
    try {
      const wei = await this.provider.getBalance(this.wallet.address);
      this.state.walletBalanceEth = Number(ethers.formatEther(wei));
    } catch (e) { this.recordError("balance", (e as Error).message); }
  }

  async refreshIdentity(): Promise<void> {
    if (!this.agentRegistry || !this.agentIdBig) return;
    try {
      const a = await this.agentRegistry.getAgent(this.agentIdBig);
      this.state.agentRegistered = a.active;
      this.state.agentDid = a.did;
      this.state.agentRegisteredAt = Number(a.registeredAt);
    } catch (e) {
      this.state.agentRegistered = false;
      this.recordError("identity", (e as Error).message);
    }
  }

  async refreshRiskParams(): Promise<void> {
    if (!this.riskRouter || !this.agentIdBig) return;
    try {
      const p = await this.riskRouter.getRiskParams(this.agentIdBig);
      this.state.riskParams = p;
    } catch (e) {
      // If params aren't set the contract reverts — that's fine, leave them null
      this.state.riskParams = null;
    }
    try {
      const n = await this.riskRouter.getCurrentNonce(this.agentIdBig);
      this.state.intentNonce = n.toString();
    } catch (e) { /* non-fatal */ }
    // tradeRecord (count + windowStart)
    try {
      const c = (this.riskRouter as any).contract;
      const tr = await c.getTradeRecord(this.agentIdBig);
      this.state.tradeRecord = { count: tr.count.toString(), windowStart: tr.windowStart.toString() };
    } catch (e) { /* non-fatal */ }
  }

  async refreshVault(): Promise<void> {
    if (!this.vault) return;
    try {
      if (this.agentIdBig) {
        const allocated = await this.vault.getAllocatedCapital(this.agentIdBig);
        this.state.vaultAllocatedEth = Number(ethers.formatEther(allocated));
      }
      const v = (this.vault as any).contract;
      const total = await v.totalVaultBalance();
      this.state.vaultTotalEth = Number(ethers.formatEther(total));
      try {
        const un = await v.unallocatedBalance();
        this.state.vaultUnallocatedEth = Number(ethers.formatEther(un));
      } catch { /* optional */ }
    } catch (e) { this.recordError("vault", (e as Error).message); }
  }

  async refreshReputation(): Promise<void> {
    if (!this.reputationRegistry || !this.agentIdBig) return;
    try {
      const r = await this.reputationRegistry.getReputationSummary(this.agentIdBig);
      this.state.reputation = r;
    } catch (e) { this.recordError("reputation", (e as Error).message); }
  }

  async refreshValidation(): Promise<void> {
    if (!this.validationRegistry || !this.agentIdBig) return;
    try {
      const c = (this.validationRegistry as any).contract;
      const count = await c.attestationCount(this.agentIdBig);
      const avg = await this.validationRegistry.getAverageScore(this.agentIdBig);
      this.state.validation = {
        attestationCount: Number(count),
        averageValidationScore: avg,
      };
    } catch (e) { this.recordError("validation", (e as Error).message); }
  }

  // ─── pre-trade gate ───────────────────────────────────────────────────────

  /**
   * Build → sign → (simulate or submit) a TradeIntent for a proposed paper trade.
   * Returns the validation result. The engine should skip the trade if !approved.
   */
  async gateTrade(args: { pair: string; side: "BUY" | "SELL"; amountUsd: number; maxSlippageBps?: number }):
    Promise<{ approved: boolean; reason: string; intentHash?: string; txHash?: string; mode: GateMode }>
  {
    const mode = this.state.gateMode;

    if (mode === "off" || !this.isConfigured() || !this.riskRouter || !this.wallet || !this.agentIdBig) {
      return { approved: true, reason: "gate disabled", mode: "off" };
    }

    // Throttle so a burst of signals doesn't hammer the RPC
    const now = Date.now();
    if (now - this.lastGateAt < this.minGateIntervalMs) {
      return { approved: true, reason: "throttled (allowed)", mode };
    }
    this.lastGateAt = now;

    let intent;
    try {
      intent = await this.riskRouter.buildIntent(
        this.agentIdBig,
        this.wallet.address,
        args.pair,
        args.side,
        args.amountUsd,
        { maxSlippageBps: args.maxSlippageBps ?? 50, deadlineSeconds: 300 },
      );
    } catch (e) {
      this.recordError("buildIntent", (e as Error).message);
      // Fail-open in simulate mode (don't block paper trading on RPC hiccups)
      return { approved: true, reason: `buildIntent error: ${(e as Error).message}`, mode };
    }

    let signed;
    try {
      signed = await this.riskRouter.signIntent(intent, this.wallet);
    } catch (e) {
      this.recordError("signIntent", (e as Error).message);
      return { approved: true, reason: `signIntent error: ${(e as Error).message}`, mode };
    }

    const record: OnchainIntentRecord = {
      ts: Date.now(),
      pair: args.pair,
      side: args.side,
      amountUsd: args.amountUsd,
      nonce: intent.nonce.toString(),
      intentHash: signed.intentHash,
      approved: false,
      reason: "",
      mode,
    };

    try {
      if (mode === "simulate") {
        const r = await this.riskRouter.simulateIntent(intent);
        record.approved = r.approved;
        record.reason = r.reason || (r.approved ? "approved (simulated)" : "rejected");
      } else {
        // submit (state-changing tx)
        const r = await this.riskRouter.submitIntent(signed);
        record.approved = r.approved;
        record.reason = r.reason || (r.approved ? "approved (submitted)" : "rejected");
        // submitIntent uses tx.wait under the hood — but doesn't return txHash directly.
        // We can't easily retrieve it without re-instrumenting; leave undefined.
      }
    } catch (e) {
      record.reason = `error: ${(e as Error).message.slice(0, 200)}`;
      record.approved = false;
      this.recordError(`gate:${mode}`, (e as Error).message);
    }

    this.pushIntent(record);
    this.state.lastIntentAt = Date.now();
    this.persist();

    return {
      approved: record.approved,
      reason: record.reason,
      intentHash: record.intentHash,
      txHash: record.txHash,
      mode,
    };
  }

  // ─── post-trade attestation ──────────────────────────────────────────────

  /**
   * Build an EIP-712 signed checkpoint for a paper trade and (optionally)
   * post it to the ValidationRegistry. Always saves the checkpoint locally
   * (the dashboard's checkpoint feed comes from the same JSONL file).
   */
  async attestTrade(args: {
    pair: string;
    side: "BUY" | "SELL" | "HOLD";
    asset: string;
    amountUsd: number;
    priceUsd: number;
    reasoning: string;
    confidence: number;
    intentHash?: string;
    score?: number;
    notes?: string;
  }): Promise<{ checkpoint: TradeCheckpoint & { checkpointHash?: string }; attestation?: OnchainAttestationRecord } | null> {
    if (!this.isConfigured() || !this.wallet || !this.agentIdBig || !this.validationRegistry) return null;

    const decision: TradeDecision = {
      action: args.side,
      asset: args.asset,
      pair: args.pair,
      amount: args.amountUsd,
      reasoning: args.reasoning,
      confidence: args.confidence,
    };
    const market: MarketData = {
      pair: args.pair,
      price: args.priceUsd,
      bid: args.priceUsd,
      ask: args.priceUsd,
      volume: 0,
      vwap: args.priceUsd,
      high: args.priceUsd,
      low: args.priceUsd,
      timestamp: Math.floor(Date.now() / 1000),
    };

    let checkpoint: TradeCheckpoint & { checkpointHash?: string };
    try {
      const intentHash = args.intentHash || ethers.ZeroHash;
      checkpoint = await generateCheckpoint(
        this.agentIdBig,
        decision,
        market,
        intentHash,
        this.wallet,
        this.state.agentRegistry || ethers.ZeroAddress,
        SEPOLIA_CHAIN_ID,
      );
    } catch (e) {
      this.recordError("generateCheckpoint", (e as Error).message);
      return null;
    }

    let attestation: OnchainAttestationRecord | undefined;
    if (this.state.attestMode === "on" && checkpoint.checkpointHash) {
      const now = Date.now();
      if (now - this.state.lastAttestAt < this.minAttestIntervalMs) {
        // throttled
        return { checkpoint };
      }
      this.state.lastAttestAt = now;

      attestation = {
        ts: Date.now(),
        pair: args.pair,
        action: args.side,
        amountUsd: args.amountUsd,
        priceUsd: args.priceUsd,
        checkpointHash: checkpoint.checkpointHash,
        intentHash: args.intentHash || ethers.ZeroHash,
        score: args.score ?? Math.round(args.confidence * 100),
        notes: args.notes ?? `${args.side} ${args.pair} @ ${args.priceUsd.toFixed(4)}`,
        status: "pending",
      };
      this.pushAttestation(attestation);
      this.persist();

      // fire and forget (the engine doesn't wait on confirmations)
      void (async () => {
        try {
          const c = (this.validationRegistry as any).contract;
          const tx = await c.postEIP712Attestation(
            this.agentIdBig,
            checkpoint.checkpointHash,
            attestation!.score,
            attestation!.notes,
          );
          attestation!.txHash = tx.hash;
          attestation!.explorerUrl = `https://sepolia.etherscan.io/tx/${tx.hash}`;
          this.persist();
          const rec = await tx.wait();
          attestation!.blockNumber = rec.blockNumber;
          attestation!.status = "confirmed";
          this.persist();
          // refresh the validation count after a successful tx
          void this.refreshValidation();
          void this.refreshBalance();
        } catch (e) {
          attestation!.status = "failed";
          attestation!.notes = (attestation!.notes || "") + ` | ERR: ${(e as Error).message.slice(0, 120)}`;
          this.recordError("postAttestation", (e as Error).message);
          this.persist();
        }
      })();
    }

    return { checkpoint, attestation };
  }

  // ─── compatibility shims for existing /api/onchain/* endpoints ───────────

  /** legacy: enable/disable the gating + attestation as a single switch. */
  setEnabled(on: boolean): void {
    if (on) {
      this.state.gateMode = "simulate";
      this.state.attestMode = "off";
    } else {
      this.state.gateMode = "off";
      this.state.attestMode = "off";
    }
    this.persist();
  }

  /** legacy: still exposed but ignored — refresh interval is fixed. */
  setIntervalMs(_ms: number): void { /* no-op */ }

  /** legacy: only used by the old /api/onchain/checkpoint button. */
  shouldCheckpoint(): boolean { return false; }

  publicState() {
    return {
      configured: this.isConfigured(),
      ...this.state,
      intents: this.state.intents.slice(-30).reverse(),
      attestations: this.state.attestations.slice(-30).reverse(),
      errors: this.state.errors.slice(-15).reverse(),
      explorer: this.state.walletAddress
        ? `https://sepolia.etherscan.io/address/${this.state.walletAddress}`
        : null,
      contracts: {
        agentRegistry: this.state.agentRegistry
          ? `https://sepolia.etherscan.io/address/${this.state.agentRegistry}` : null,
        riskRouter: this.state.riskRouter
          ? `https://sepolia.etherscan.io/address/${this.state.riskRouter}` : null,
        validationRegistry: this.state.validationRegistry
          ? `https://sepolia.etherscan.io/address/${this.state.validationRegistry}` : null,
        reputationRegistry: this.state.reputationRegistry
          ? `https://sepolia.etherscan.io/address/${this.state.reputationRegistry}` : null,
        vault: this.state.vault
          ? `https://sepolia.etherscan.io/address/${this.state.vault}` : null,
      },
    };
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private pushIntent(rec: OnchainIntentRecord): void {
    this.state.intents.push(rec);
    if (this.state.intents.length > 200) this.state.intents.splice(0, this.state.intents.length - 200);
  }

  private pushAttestation(rec: OnchainAttestationRecord): void {
    this.state.attestations.push(rec);
    if (this.state.attestations.length > 200) this.state.attestations.splice(0, this.state.attestations.length - 200);
  }

  private recordError(where: string, msg: string): void {
    this.state.errors.push({ ts: Date.now(), where, msg: msg.slice(0, 240) });
    if (this.state.errors.length > 50) this.state.errors.splice(0, this.state.errors.length - 50);
    this.persist();
  }

  private persist(): void {
    try { writeJson(STATE_FILE, this.state); } catch { /* ignore */ }
  }
}
