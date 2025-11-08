import { ethers } from "ethers";
import { prisma } from "../../src/db";
import { log, parseArgs, argString } from "../script-utils";
import { queryAuthorizationUsedForNonces, type PaymentInfo } from "./payment-tracking-utils";

/**
 * Backfill script to populate payment_tx_hash and payment_block_number
 * for existing purchases in the database.
 *
 * This queries the USDC contract for AuthorizationUsed events and updates
 * the purchase records with the payment transaction information.
 *
 * CONFIGURATION: Set the block range for your specific token launch
 * Use scripts/refund/find-token-event-blocks.ts to find the correct range
 *
 * CACHING: Results are cached in .cache/refund/ directory based on block range.
 * If you run this script with the same block range as identify-refund-discrepancies.ts,
 * the cached data will be reused for faster execution.
 */

// ============================================================================
// CONFIGURATION - Update these for your specific token/launch
// ============================================================================
const START_BLOCK = 37650103;  // Start from token Coined event block
const END_BLOCK: number | undefined = 37656382;  // Set to Graduated block, or undefined for current block

async function main() {
  const args = parseArgs();
  const startBlockArg = argString(args, "start-block");
  const endBlockArg = argString(args, "end-block");
  const dryRun = argString(args, "dry-run") === "true";

  const rpcUrl = process.env.RPC_URL_BASE;
  if (!rpcUrl) throw new Error("RPC_URL_BASE not set in environment");

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // Priority: CLI args > script constants > defaults
  let startBlock: number;
  let endBlock: number;

  if (startBlockArg) {
    startBlock = parseInt(startBlockArg, 10);
    if (isNaN(startBlock)) {
      log.error("Invalid start-block argument");
      process.exit(1);
    }
  } else {
    startBlock = START_BLOCK;
  }

  if (endBlockArg) {
    endBlock = parseInt(endBlockArg, 10);
    if (isNaN(endBlock)) {
      log.error("Invalid end-block argument");
      process.exit(1);
    }
  } else {
    endBlock = END_BLOCK ?? await provider.getBlockNumber();
  }

  log.info({ startBlock, endBlock, dryRun }, "Starting payment tracking backfill...");

  // Get all purchases that don't have payment tracking info
  const purchases = await prisma.purchase.findMany({
    where: {
      paymentTxHash: null,
    },
    select: {
      id: true,
      x402Nonce: true,
    },
  });

  log.info({ count: purchases.length }, "Purchases needing backfill");

  if (purchases.length === 0) {
    console.log("✅ All purchases already have payment tracking info");
    return;
  }

  const nonces = purchases.map(p => p.x402Nonce);

  // Query blockchain for payment info
  const paymentInfo = await queryAuthorizationUsedForNonces(provider, startBlock, endBlock, nonces);

  // Build update map
  const updates: Array<{ id: string; txHash: string; blockNumber: number }> = [];

  for (const purchase of purchases) {
    const info = paymentInfo.get(purchase.x402Nonce.toLowerCase());
    if (info) {
      updates.push({
        id: purchase.id,
        txHash: info.txHash,
        blockNumber: info.blockNumber,
      });
    }
  }

  console.log("\n=== BACKFILL SUMMARY ===\n");
  console.log(`Total purchases needing backfill: ${purchases.length}`);
  console.log(`Payment info found for: ${updates.length}`);
  console.log(`Missing payment info: ${purchases.length - updates.length}\n`);

  if (dryRun) {
    console.log("DRY RUN - No database changes made");
    console.log("\nSample updates (first 5):");
    for (const update of updates.slice(0, 5)) {
      console.log(`  Purchase ${update.id}: block ${update.blockNumber}, tx ${update.txHash}`);
    }
    return;
  }

  // Apply updates
  let updateCount = 0;
  for (const update of updates) {
    await prisma.purchase.update({
      where: { id: update.id },
      data: {
        paymentTxHash: update.txHash,
        paymentBlockNumber: BigInt(update.blockNumber),
      },
    });
    updateCount++;

    if (updateCount % 10 === 0) {
      log.info({ progress: `${updateCount}/${updates.length}` }, "Updating...");
    }
  }

  console.log(`✅ Successfully updated ${updateCount} purchases`);

  if (purchases.length - updates.length > 0) {
    console.log(`\n⚠️  Warning: ${purchases.length - updates.length} purchases could not be backfilled`);
    console.log("   These payments may have occurred outside the queried block range");
    console.log("   Try running again with a wider block range using --start-block");
  }
}

main()
  .catch((err) => {
    log.error({ err }, "Backfill script error");
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
