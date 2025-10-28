# x402 Vending Machine

## Overview

The x402 Vending Machine is a fair-launch token platform that lets anyone create (“coin”) a new ERC-20 token and offer it directly via Coinbase’s x402 payment protocol.

Buyers pay USDC on Base through a single fixed x402 `payTo` vault address, and receive their tokens asynchronously once the payment is verified.

The system enforces a transparent, onchain life cycle: Coin → Sell → Graduate → Trade / Refund

Every step is verifiable on-chain.

## Smart Contract Components

1. VendingMachine.sol

This is the main controller and factory of the system. It manages launching, accounting, token minting, refunding and graduation (finalizing the launch).

Key features:
- It owns a vault contract that receives all USDC payments
- Each launch tracks its own share of funds on-chain, so launches do not interfere with each other.
- Operators (trusted backend accounts) call `coin()` to deploy a new token created by the user.
- When handlePurchase() or handleBatchPurchase() is called (after x402 verification), tokens are minted instantly to buyers.
- Tokens are non-transferable until graduation, preventing premature trading.
- Graduation: Once exactly 800 million tokens have been sold, anyone can call `graduate()`. The contract swaps all accounted USDC to HEU on Uniswap V3, mints 100M tokens for liquidity, add Token/HEU liquidity pair on Uniswap V2, and enables trading via `enableTransfers()`
- Refunds: If the launch does not graduate within 14 days, operators can refund buyers one by one.

2. X402Token.sol

An ERC-20 token with several upgrades:

- 1 billion fixed max supply
- ERC-7572 metadata support. The token creator can edit `contractURI` to customize token metadata such as token icon image and social links.
- ERC-3009 support for transfer-with-authorization. This makes it possible for this token to be used as a payment token in x402.
- Tokens cannot be transferred until `enableTransfers()` is called at graduation. This keeps the launch fair, no pre-market or insider trading.

3. TreasuryVault.sol

A minimal vault contract that:

- Holds all USDC payments (x402 `payTo` points here).
- Executes swaps and liquidity creation.

It has no admin keys. Only the Vending Machine can operate it.

## Off-chain System Requirements

1. x402 API Server (Express / Node.js)

The API server acts as the entry point for users to interact with the vending machine.

Responsibilities:

- Exposes the x402 endpoints. Two purchase options: buy 1 USDC with `/buy` or buy 10 USDC with `/buy10x`. Provides `/coin` API to launch a token.
- Provides read-only APIs to return the status of the system and each token: `/launches` to view all launches. `/availableLaunches` to view open (<14 days old) and not-yet-graduated launches. `/refundableLaunches` to view refundable launches. `/tokenDetails` to show total $ sold, % progress, refund status and token metadata.
- Call the Coinbase facilitator /verify and /settle APIs. Extract the user address and payment amount and insert the data into a queue.

2. Backend event processor

The event processor subscribes to every verified purchase events, calls smart contracts to launch a token or handle purchases (individually, or in batches).

- A group of operator wallets work in parallel.
- Call the Vending Machine contract.
- Prevent overselling: check `allocated < fairCap` and `graduated == false` before handling purchases.
- Record all activities in the database.

## Example Launch Lifecycle

1. Coin

- A user or an agent calls `/coin` x402 API with the token name and metadata.
- An operator deploys the token contract with transfers disabled.

2. Sell

- Buyers use x402 to pay USDC and get a fixed amount of tokens per USDC spent asynchronously. The tokens are not transferable at this stage.

3. Graduate

- When 800 M tokens sold, the operator can call `graduate()`.
- Vault swaps the accumulated USDC → HEU, adds LP, enables transfers. Token is now freely tradable.

4. Refund

- If not graduated in 14 days, operators refund users one by one.
- Refund burns tokens from user wallets and returns USDC.
