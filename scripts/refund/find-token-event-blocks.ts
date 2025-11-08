import { ethers } from "ethers";
import { prisma } from "../../src/db";
import { argString, log, parseArgs } from "../script-utils";

/**
 * Find the block numbers for Coined and Graduated events for a specific token
 *
 * Fast version: Uses database data to find transaction hashes, then queries blocks
 *
 * Usage:
 *   bun run scripts/refund/find-token-event-blocks.ts --token=0x1234...
 */

async function findTokenEventBlocks(
  provider: ethers.JsonRpcProvider,
  tokenAddress: string
): Promise<{
  coinedBlock: number | null;
  coinedTxHash: string | null;
  graduatedBlock: number | null;
  graduatedTxHash: string | null;
  launchId: string | null;
  graduated: boolean;
}> {

  const tokenLower = tokenAddress.toLowerCase();

  log.info({ tokenAddress: tokenLower }, "Looking up token in database...");

  // Find launch in database by token address
  const launch = await prisma.launch.findUnique({
    where: { tokenLower },
    select: {
      id: true,
      tokenLower: true,
      txHash: true,
      graduated: true,
      onchainId: true,
    }
  });

  if (!launch) {
    log.warn({ tokenAddress: tokenLower }, "Token not found in database");
    return {
      coinedBlock: null,
      coinedTxHash: null,
      graduatedBlock: null,
      graduatedTxHash: null,
      launchId: null,
      graduated: false
    };
  }

  log.info({
    launchId: launch.id,
    onchainId: launch.onchainId?.toString(),
    txHash: launch.txHash,
    graduated: launch.graduated
  }, "Launch found in database");

  let coinedBlock: number | null = null;
  let graduatedBlock: number | null = null;
  let graduatedTxHash: string | null = null;

  // Get Coined block from txHash
  if (launch.txHash) {
    log.info({ txHash: launch.txHash }, "Fetching Coined transaction block...");
    try {
      const receipt = await provider.getTransactionReceipt(launch.txHash);
      if (receipt) {
        coinedBlock = receipt.blockNumber;
        log.info({ block: coinedBlock, txHash: launch.txHash }, "Found Coined block");
      } else {
        log.warn({ txHash: launch.txHash }, "Transaction receipt not found");
      }
    } catch (err) {
      log.error({ err, txHash: launch.txHash }, "Failed to fetch Coined transaction");
    }
  } else {
    log.warn("No txHash found in database for Coined event");
  }

  // If graduated, search for the Graduated event transaction
  if (launch.graduated && launch.onchainId !== null) {
    log.info({ onchainId: launch.onchainId.toString() }, "Token is graduated, searching for Graduated event...");

    // Search for GRADUATE job in jobs table
    const graduateJob = await prisma.job.findFirst({
      where: {
        kind: "GRADUATE",
        payload: {
          path: ["launchId"],
          equals: launch.id
        },
        status: "done"
      },
      select: {
        payload: true
      }
    });

    if (graduateJob) {
      const payload = graduateJob.payload as any;
      if (payload.txHash) {
        graduatedTxHash = payload.txHash;
        log.info({ txHash: graduatedTxHash }, "Found Graduated txHash in job");

        try {
          const receipt = await provider.getTransactionReceipt(graduatedTxHash);
          if (receipt) {
            graduatedBlock = receipt.blockNumber;
            log.info({ block: graduatedBlock, txHash: graduatedTxHash }, "Found Graduated block");
          }
        } catch (err) {
          log.error({ err, txHash: graduatedTxHash }, "Failed to fetch Graduated transaction");
        }
      }
    } else {
      log.info("No GRADUATE job found in database (may have been graduated directly on-chain)");
    }
  }

  return {
    coinedBlock,
    coinedTxHash: launch.txHash,
    graduatedBlock,
    graduatedTxHash,
    launchId: launch.id,
    graduated: launch.graduated
  };
}

async function main() {
  const args = parseArgs();
  const tokenAddress = argString(args, "token");

  if (!tokenAddress) {
    console.error("Error: --token argument is required");
    console.log("\nUsage:");
    console.log("  bun run scripts/refund/find-token-event-blocks.ts --token=0x1234...");
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL_BASE;

  if (!rpcUrl) throw new Error("RPC_URL_BASE not set in environment");

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  log.info({ token: tokenAddress }, "Starting search...");

  const result = await findTokenEventBlocks(provider, tokenAddress);

  console.log("\n" + "=".repeat(80));
  console.log("TOKEN EVENT BLOCKS");
  console.log("=".repeat(80));
  console.log(`Token Address:   ${tokenAddress}`);
  console.log(`Launch ID:       ${result.launchId || "NOT FOUND"}`);
  console.log(`Graduated:       ${result.graduated ? "Yes" : "No"}`);
  console.log();

  if (result.graduated && result.coinedBlock !== null) {
    console.log(`⚠️  WARNING: For graduated tokens, the block shown below is the GRADUATION block.`);
    console.log(`⚠️  The Coined tx is overwritten in the database after graduation.`);
    console.log(`⚠️  To find the Coined block, check the token contract deployment time on Basescan:`);
    console.log(`⚠️  https://basescan.org/address/${tokenAddress}`);
    console.log();
  }

  console.log(`Coined Block:    ${result.coinedBlock !== null ? result.coinedBlock : "NOT FOUND"}${result.graduated && result.coinedBlock !== null ? " (ACTUALLY GRADUATION BLOCK - SEE WARNING ABOVE)" : ""}`);
  console.log(`Coined TxHash:   ${result.coinedTxHash || "NOT FOUND"}${result.graduated && result.coinedTxHash ? " (ACTUALLY GRADUATION TX)" : ""}`);
  console.log();
  console.log(`Graduated Block: ${result.graduatedBlock !== null ? result.graduatedBlock : result.graduated ? "NOT FOUND IN JOBS" : "NOT GRADUATED"}`);
  console.log(`Graduated TxHash: ${result.graduatedTxHash || (result.graduated ? "NOT FOUND IN JOBS" : "N/A")}`);
  console.log("=".repeat(80));

  if (result.coinedBlock !== null && !result.graduated) {
    console.log("\nSuggested block range for refund scripts:");
    console.log(`START_BLOCK = ${result.coinedBlock}`);
    console.log(`END_BLOCK = undefined  // Use current block (not graduated yet)`);
    console.log("\nUpdate these constants in backfill-payment-tracking.ts and identify-refund-discrepancies.ts");
  } else if (result.graduated) {
    console.log("\n⚠️  MANUAL ACTION REQUIRED:");
    console.log(`1. Visit https://basescan.org/address/${tokenAddress}`);
    console.log(`2. Find the contract creation transaction (earliest transaction)`);
    console.log(`3. Get the block number from that transaction`);
    console.log(`4. Use that as START_BLOCK in your refund scripts`);
    if (result.coinedBlock !== null) {
      console.log(`5. Use END_BLOCK = ${result.coinedBlock} (graduation block)`);
    }
    console.log("\nUpdate these constants in backfill-payment-tracking.ts and identify-refund-discrepancies.ts");
  } else {
    console.log("\n⚠️  Could not determine block range. Token may not exist or tx not in database.");
  }
}

main()
  .catch((err) => {
    log.error({ err }, "Script error");
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
