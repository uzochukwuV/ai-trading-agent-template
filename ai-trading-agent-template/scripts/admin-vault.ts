/**
 * admin-vault.ts
 * Owner-only script to lower allocationPerTeam and top up the HackathonVault.
 *
 * Run: npx hardhat run scripts/admin-vault.ts --network sepolia
 */

import { ethers } from "hardhat";

const VAULT_ADDRESS = "0x0E7CD8ef9743FEcf94f9103033a044caBD45fC90";
const NEW_ALLOCATION = ethers.parseEther("0.001"); // 0.001 ETH per team (down from 0.05)
const TOP_UP_AMOUNT  = ethers.parseEther("0.04");  // deposit 0.04 ETH — covers 40 teams at 0.001 each

async function main() {
  const [owner] = await ethers.getSigners();
  console.log("Owner:", owner.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(owner.address)), "ETH\n");

  const vault = await ethers.getContractAt(
    [
      "function setAllocationPerTeam(uint256 newAmount) external",
      "function allocationPerTeam() external view returns (uint256)",
      "function deposit() external payable",
      "function totalVaultBalance() external view returns (uint256)",
      "function unallocatedBalance() external view returns (uint256)",
      "function owner() external view returns (address)",
    ],
    VAULT_ADDRESS,
    owner
  );

  // Verify ownership
  const vaultOwner = await vault.owner();
  if (vaultOwner.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error(`Not owner. Vault owner is ${vaultOwner}, you are ${owner.address}`);
  }

  // Current state
  const currentAllocation = await vault.allocationPerTeam();
  const currentBalance    = await vault.totalVaultBalance();
  const unallocated       = await vault.unallocatedBalance();
  console.log("── Current state ──────────────────────────");
  console.log("allocationPerTeam:", ethers.formatEther(currentAllocation), "ETH");
  console.log("vault balance:    ", ethers.formatEther(currentBalance), "ETH");
  console.log("unallocated:      ", ethers.formatEther(unallocated), "ETH\n");

  // Step 1 — lower allocation
  console.log(`Setting allocationPerTeam → ${ethers.formatEther(NEW_ALLOCATION)} ETH...`);
  const tx1 = await vault.setAllocationPerTeam(NEW_ALLOCATION);
  await tx1.wait();
  console.log("✅ allocationPerTeam updated. tx:", tx1.hash);

  // Step 2 — top up vault
  console.log(`\nDepositing ${ethers.formatEther(TOP_UP_AMOUNT)} ETH into vault...`);
  const tx2 = await vault.deposit({ value: TOP_UP_AMOUNT });
  await tx2.wait();
  console.log("✅ Vault funded. tx:", tx2.hash);

  // Final state
  const newBalance  = await vault.totalVaultBalance();
  const newUnalloc  = await vault.unallocatedBalance();
  const newAlloc    = await vault.allocationPerTeam();
  console.log("\n── Updated state ──────────────────────────");
  console.log("allocationPerTeam:", ethers.formatEther(newAlloc), "ETH");
  console.log("vault balance:    ", ethers.formatEther(newBalance), "ETH");
  console.log("unallocated:      ", ethers.formatEther(newUnalloc), "ETH");
  console.log(`\nCapacity: ~${Number(newUnalloc / newAlloc)} more claims available`);
}

main().catch((e) => { console.error(e); process.exit(1); });
