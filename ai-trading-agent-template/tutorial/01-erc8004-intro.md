# Part 1: What Is ERC-8004 and Why Does It Matter?

## The problem: your AI agent is a ghost

You build a trading bot. It runs, it trades, it makes decisions. But from the blockchain's perspective, it doesn't exist. There's just a wallet address, no identity, no record of what the agent is, who operates it, or what it's supposed to do.

This creates real problems:
- **No accountability**: anyone can claim any wallet address is their "AI agent"
- **No discoverability**: other contracts can't verify they're talking to an authorized agent
- **No reputation**: the agent builds no on-chain history that others can trust

ERC-8004 solves this.

---

## What ERC-8004 is

ERC-8004 is a standard for **AI Agent Identity Registry** on Ethereum. It defines a registry contract where agents can be registered with structured metadata, and every registration produces a unique, verifiable `agentId`.

Think of it like ENS (Ethereum Name Service), but for AI agents instead of human-readable names.

### What gets stored on-chain

From [`contracts/AgentRegistry.sol` L33–L41](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/contracts/AgentRegistry.sol#L33-L41):

```solidity
struct AgentRegistration {
    address operatorWallet;  // Owns the ERC-721 token, pays gas
    address agentWallet;     // Hot wallet the agent uses for signing
    string  name;
    string  description;
    string[] capabilities;   // e.g. ["trading", "analysis", "eip712-signing"]
    uint256 registeredAt;
    bool    active;
}
```

### What you get back: `agentId`

When you call `register()`, the contract mints an ERC-721 token and returns its ID:

```solidity
agentId = _nextAgentId++;   // auto-incrementing uint256
_mint(msg.sender, agentId); // ERC-721 mint — you own this token
```

This `agentId` (the ERC-721 token ID) becomes the agent's **persistent on-chain identity** — used for:
- Capital allocation in the agent Vault
- Risk validation in the Risk Router
- Cryptographic signing in EIP-712 checkpoints

---

## Why on-chain agent identity matters

### 1. The identity layer is already built

By using ERC-8004, every team's agent automatically gets a verifiable identity without having to invent their own scheme. The registry is the shared ground truth.

### 2. Reputation becomes composable

Because `agentId` is persistent and tied to on-chain activity, every trade, every checkpoint, every vault interaction is linked to that identity. Future systems could build reputation scores, whitelists, or risk tiers on top of this.

### 3. The scaffolding stays the same

This is the "reusable template" angle: the identity, reputation system, and validation scaffolding (ERC-8004 → Vault → RiskRouter → EIP-712) stay constant across teams. What changes is the strategy inside. Your agent's identity doesn't care if you're running a momentum strategy, an LLM, or a neural network.

---

## The AgentRegistry contract

Here's the core registration function ([`contracts/AgentRegistry.sol` L92–L120](https://github.com/Stephen-Kimoi/ai-trading-agent-template/blob/main/contracts/AgentRegistry.sol#L92-L120)):

```solidity
function register(
    address agentWallet,
    string calldata name,
    string calldata description,
    string[] calldata capabilities,
    string calldata agentURI
) external returns (uint256 agentId) {
    require(bytes(name).length > 0, "AgentRegistry: name required");
    require(agentWallet != address(0), "AgentRegistry: invalid agentWallet");

    agentId = _nextAgentId++;
    _mint(msg.sender, agentId);        // ERC-721 mint
    _setTokenURI(agentId, agentURI);

    agents[agentId] = AgentRegistration({
        operatorWallet: msg.sender,
        agentWallet: agentWallet,
        name: name,
        description: description,
        capabilities: capabilities,
        registeredAt: block.timestamp,
        active: true
    });

    walletToAgentId[agentWallet] = agentId;
    emit AgentRegistered(agentId, msg.sender, agentWallet, name);
}
```

Key properties:
- **Mints an ERC-721 token**: your agent identity is a transferable NFT
- **Two wallet roles**: `operatorWallet` (owns the token) and `agentWallet` (signs trades at runtime)
- **Auto-incrementing agentId**: starts at 0, stable and unique forever
- **Emits an event**: `AgentRegistered(agentId, operatorWallet, agentWallet, name)` — queryable on Etherscan

---

## Next step

In Part 2, you'll deploy the AgentRegistry to Sepolia and register your first agent.

→ [Part 2: Registering Your Agent On-Chain](./02-register-agent.md)