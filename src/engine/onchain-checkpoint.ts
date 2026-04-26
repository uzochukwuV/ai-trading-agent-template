/**
 * On-chain checkpointing to Sepolia (ERC-8004 style identity attestation).
 *
 * Periodically writes a content-addressed hash of the engine state to
 * Sepolia via a self-transaction with a `data` payload. Cheap, public,
 * and gives the agent a verifiable activity log on-chain.
 *
 * Disabled by default — opt-in via dashboard. Requires SEPOLIA_RPC_URL
 * and SEPOLIA_PRIVATE_KEY secrets.
 */

import { ethers } from "ethers";
import { readJson, writeJson, statePath } from "./persistence";

const STATE_FILE = statePath("onchain-checkpoints.json");

export interface OnchainCheckpoint {
  ts: number;
  txHash: string;
  blockNumber?: number;
  digest: string;
  payloadSummary: { equity: number; trades: number; positions: number };
  explorerUrl: string;
}

export interface OnchainState {
  enabled: boolean;
  intervalMs: number;
  lastCheckpointAt: number;
  address: string | null;
  balanceEth: number | null;
  errors: Array<{ ts: number; msg: string }>;
  checkpoints: OnchainCheckpoint[];
}

function defaultState(): OnchainState {
  return {
    enabled: false,
    intervalMs: 6 * 60 * 60 * 1000,        // every 6h by default
    lastCheckpointAt: 0,
    address: null,
    balanceEth: null,
    errors: [],
    checkpoints: [],
  };
}

export class OnchainCheckpointer {
  state: OnchainState;
  private wallet: ethers.Wallet | null = null;
  private provider: ethers.JsonRpcProvider | null = null;

  constructor(private rpcUrl?: string, private privateKey?: string) {
    this.state = readJson<OnchainState>(STATE_FILE, defaultState());
    if (rpcUrl && privateKey) {
      try {
        this.provider = new ethers.JsonRpcProvider(rpcUrl);
        this.wallet = new ethers.Wallet(privateKey, this.provider);
        this.state.address = this.wallet.address;
        void this.refreshBalance();
      } catch (e) {
        this.recordError("init: " + (e as Error).message);
      }
    }
    this.persist();
  }

  isConfigured(): boolean { return !!this.wallet; }

  setEnabled(on: boolean): void {
    this.state.enabled = !!on;
    this.persist();
  }

  setIntervalMs(ms: number): void {
    this.state.intervalMs = Math.max(15 * 60 * 1000, Math.min(24 * 60 * 60 * 1000, Math.floor(ms)));
    this.persist();
  }

  publicState() {
    return {
      configured: this.isConfigured(),
      ...this.state,
      checkpoints: this.state.checkpoints.slice(-20).reverse(),
      errors: this.state.errors.slice(-10).reverse(),
    };
  }

  async refreshBalance(): Promise<void> {
    if (!this.wallet || !this.provider) return;
    try {
      const wei = await this.provider.getBalance(this.wallet.address);
      this.state.balanceEth = Number(ethers.formatEther(wei));
      this.persist();
    } catch (e) {
      this.recordError("balance: " + (e as Error).message);
    }
  }

  shouldCheckpoint(): boolean {
    if (!this.state.enabled || !this.wallet) return false;
    return Date.now() - this.state.lastCheckpointAt >= this.state.intervalMs;
  }

  /**
   * Write a checkpoint to the chain. The payload is JSON-stringified and
   * its keccak256 hash is what we anchor. We send a 0-ETH self-transaction
   * with the digest as data, which any verifier can later check.
   */
  async writeCheckpoint(payload: { equity: number; trades: number; positions: number; extra?: any }): Promise<OnchainCheckpoint | null> {
    if (!this.wallet || !this.provider) return null;
    const json = JSON.stringify(payload);
    const digest = ethers.id(json);
    try {
      const tx = await this.wallet.sendTransaction({
        to: this.wallet.address,
        value: 0n,
        data: digest,         // 32-byte digest as the on-chain anchor
      });
      const cp: OnchainCheckpoint = {
        ts: Date.now(),
        txHash: tx.hash,
        digest,
        payloadSummary: { equity: payload.equity, trades: payload.trades, positions: payload.positions },
        explorerUrl: `https://sepolia.etherscan.io/tx/${tx.hash}`,
      };
      this.state.checkpoints.push(cp);
      if (this.state.checkpoints.length > 100) this.state.checkpoints.splice(0, this.state.checkpoints.length - 100);
      this.state.lastCheckpointAt = Date.now();
      this.persist();
      // Best-effort confirmation update in the background
      void tx.wait().then(rec => {
        if (rec) cp.blockNumber = rec.blockNumber;
        this.persist();
      }).catch(e => this.recordError("wait: " + (e as Error).message));
      void this.refreshBalance();
      return cp;
    } catch (e) {
      this.recordError("send: " + (e as Error).message);
      return null;
    }
  }

  private recordError(msg: string): void {
    this.state.errors.push({ ts: Date.now(), msg });
    if (this.state.errors.length > 50) this.state.errors.splice(0, this.state.errors.length - 50);
    this.persist();
  }

  private persist(): void {
    try { writeJson(STATE_FILE, this.state); } catch { /* ignore */ }
  }
}
