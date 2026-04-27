import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { AgentRegistry, HackathonVault } from "../typechain-types";

describe("HackathonVault — claim flow", () => {
  let registry: AgentRegistry;
  let vault: HackathonVault;
  let owner: HardhatEthersSigner;
  let team1: HardhatEthersSigner;
  let team2: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const ALLOCATION = ethers.parseEther("0.001");

  // Helper: register an agent and return its agentId
  async function registerAgent(signer: HardhatEthersSigner): Promise<bigint> {
    const agentWallet = ethers.Wallet.createRandom();
    const tx = await registry.connect(signer).register(
      agentWallet.address,
      "Test Agent",
      "A test trading agent",
      ["trading"],
      "https://example.com/agent.json"
    );
    const receipt = await tx.wait();
    const event = receipt?.logs
      .map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "AgentRegistered");
    return event?.args.agentId as bigint;
  }

  beforeEach(async () => {
    [owner, team1, team2, stranger] = await ethers.getSigners();

    // Deploy fresh contracts for each test
    const RegistryFactory = await ethers.getContractFactory("AgentRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory("HackathonVault");
    vault = await VaultFactory.deploy(await registry.getAddress(), ALLOCATION);
    await vault.waitForDeployment();
  });

  // ── Funding ────────────────────────────────────────────────────────────────

  describe("deposit()", () => {
    it("accepts ETH via deposit()", async () => {
      await vault.connect(owner).deposit({ value: ethers.parseEther("0.1") });
      expect(await vault.totalVaultBalance()).to.equal(ethers.parseEther("0.1"));
    });

    it("accepts ETH via direct transfer (receive fallback)", async () => {
      await owner.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther("0.05") });
      expect(await vault.totalVaultBalance()).to.equal(ethers.parseEther("0.05"));
    });

    it("reverts on zero deposit", async () => {
      await expect(vault.connect(owner).deposit({ value: 0 }))
        .to.be.revertedWith("HackathonVault: zero deposit");
    });

    it("anyone can deposit (not just owner)", async () => {
      await vault.connect(stranger).deposit({ value: ethers.parseEther("0.01") });
      expect(await vault.totalVaultBalance()).to.equal(ethers.parseEther("0.01"));
    });
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe("claimAllocation() — success", () => {
    let agentId: bigint;

    beforeEach(async () => {
      // Fund vault and register an agent
      await vault.connect(owner).deposit({ value: ethers.parseEther("0.1") });
      agentId = await registerAgent(team1);
    });

    it("claim succeeds for a registered agent", async () => {
      await expect(vault.connect(team1).claimAllocation(agentId)).to.not.be.reverted;
    });

    it("sets hasClaimed to true after claim", async () => {
      await vault.connect(team1).claimAllocation(agentId);
      expect(await vault.hasClaimed(agentId)).to.be.true;
    });

    it("records the correct allocated capital for the agent", async () => {
      await vault.connect(team1).claimAllocation(agentId);
      expect(await vault.getBalance(agentId)).to.equal(ALLOCATION);
    });

    it("increments totalAllocated", async () => {
      await vault.connect(team1).claimAllocation(agentId);
      expect(await vault.totalAllocated()).to.equal(ALLOCATION);
    });

    it("vault ETH balance does not change after claim (ETH stays in vault)", async () => {
      const before = await vault.totalVaultBalance();
      await vault.connect(team1).claimAllocation(agentId);
      expect(await vault.totalVaultBalance()).to.equal(before);
    });

    it("unallocatedBalance decreases by allocationPerTeam", async () => {
      const before = await vault.unallocatedBalance();
      await vault.connect(team1).claimAllocation(agentId);
      expect(await vault.unallocatedBalance()).to.equal(before - ALLOCATION);
    });

    it("anyone can call claimAllocation on behalf of any agentId", async () => {
      // stranger calling claim for team1's agent — should work
      await expect(vault.connect(stranger).claimAllocation(agentId)).to.not.be.reverted;
    });

    it("emits CapitalAllocated event", async () => {
      await expect(vault.connect(team1).claimAllocation(agentId))
        .to.emit(vault, "CapitalAllocated")
        .withArgs(agentId, ALLOCATION);
    });

    it("multiple agents can each claim their allocation", async () => {
      const agentId2 = await registerAgent(team2);
      await vault.connect(team1).claimAllocation(agentId);
      await vault.connect(team2).claimAllocation(agentId2);

      expect(await vault.getBalance(agentId)).to.equal(ALLOCATION);
      expect(await vault.getBalance(agentId2)).to.equal(ALLOCATION);
      expect(await vault.totalAllocated()).to.equal(ALLOCATION * 2n);
    });
  });

  // ── Failure cases ──────────────────────────────────────────────────────────

  describe("claimAllocation() — reverts", () => {
    it("reverts if agent is not registered", async () => {
      await vault.connect(owner).deposit({ value: ethers.parseEther("0.1") });
      await expect(vault.connect(team1).claimAllocation(999n))
        .to.be.revertedWith("HackathonVault: agent not registered");
    });

    it("reverts on double claim", async () => {
      await vault.connect(owner).deposit({ value: ethers.parseEther("0.1") });
      const agentId = await registerAgent(team1);
      await vault.connect(team1).claimAllocation(agentId);
      await expect(vault.connect(team1).claimAllocation(agentId))
        .to.be.revertedWith("HackathonVault: already claimed");
    });

    it("reverts when vault is underfunded", async () => {
      // Vault has 0 ETH — no deposit
      const agentId = await registerAgent(team1);
      await expect(vault.connect(team1).claimAllocation(agentId))
        .to.be.revertedWith("HackathonVault: vault underfunded");
    });

    it("reverts when vault has ETH but not enough for one more claim", async () => {
      // Deposit exactly enough for 1 claim, register 2 agents
      await vault.connect(owner).deposit({ value: ALLOCATION });
      const agentId1 = await registerAgent(team1);
      const agentId2 = await registerAgent(team2);

      // First claim succeeds
      await vault.connect(team1).claimAllocation(agentId1);

      // Second claim fails — vault is now fully allocated
      await expect(vault.connect(team2).claimAllocation(agentId2))
        .to.be.revertedWith("HackathonVault: vault underfunded");
    });
  });

  // ── Owner admin ────────────────────────────────────────────────────────────

  describe("setAllocationPerTeam()", () => {
    it("owner can lower allocationPerTeam", async () => {
      const lower = ethers.parseEther("0.0005");
      await vault.connect(owner).setAllocationPerTeam(lower);
      expect(await vault.allocationPerTeam()).to.equal(lower);
    });

    it("new allocation applies to future claims", async () => {
      await vault.connect(owner).deposit({ value: ethers.parseEther("0.1") });
      const lower = ethers.parseEther("0.0005");
      await vault.connect(owner).setAllocationPerTeam(lower);

      const agentId = await registerAgent(team1);
      await vault.connect(team1).claimAllocation(agentId);
      expect(await vault.getBalance(agentId)).to.equal(lower);
    });

    it("non-owner cannot call setAllocationPerTeam", async () => {
      await expect(vault.connect(stranger).setAllocationPerTeam(1n))
        .to.be.revertedWith("HackathonVault: not owner");
    });
  });

  // ── Against live Sepolia state ─────────────────────────────────────────────
  // These run against the actual deployed contracts via a Sepolia fork.
  // Skipped by default — run with: FORK=1 npx hardhat test

  describe("Sepolia fork — live contract state", function () {
    before(function () {
      if (!process.env.FORK) this.skip();
    });

    it("allocationPerTeam is 0.001 ETH after our update", async () => {
      const liveVault = await ethers.getContractAt(
        "HackathonVault",
        "0x0E7CD8ef9743FEcf94f9103033a044caBD45fC90"
      );
      expect(await liveVault.allocationPerTeam()).to.equal(ethers.parseEther("0.001"));
    });

    it("vault has unallocated balance available for claims", async () => {
      const liveVault = await ethers.getContractAt(
        "HackathonVault",
        "0x0E7CD8ef9743FEcf94f9103033a044caBD45fC90"
      );
      const unallocated = await liveVault.unallocatedBalance();
      expect(unallocated).to.be.greaterThan(0n);
    });
  });
});
