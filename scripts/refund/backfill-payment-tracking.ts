import { ethers } from "ethers";
import { prisma } from "../../src/db";
import { log, parseArgs, argString } from "../script-utils";

/**
 * Backfill script to populate payment_tx_hash and payment_block_number
 * for existing purchases in the database.
 *
 * This queries the USDC contract for AuthorizationUsed events and updates
 * the purchase records with the payment transaction information.
 */

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEFAULT_START_BLOCK = 37434263;
const BLOCK_RANGE = 500;
const AUTHORIZATION_USED_SIG = "AuthorizationUsed(address,bytes32)";

type PaymentInfo = {
  txHash: string;
  blockNumber: number;
};

async function queryAuthorizationUsedForNonces(
  provider: ethers.JsonRpcProvider,
  fromBlock: number,
  toBlock: number,
  nonces: string[]
): Promise<Map<string, PaymentInfo>> {
  log.info({ fromBlock, toBlock, nonceCount: nonces.length }, "Querying AuthorizationUsed events...");

  const topic0 = ethers.id(AUTHORIZATION_USED_SIG);
  const paymentInfo = new Map<string, PaymentInfo>();
  const nonceSet = new Set(nonces.map(n => n.toLowerCase()));

  for (let start = fromBlock; start <= toBlock; start += BLOCK_RANGE) {
    const end = Math.min(start + BLOCK_RANGE - 1, toBlock);

    log.info({ progress: `Block ${start} to ${end}` }, "Querying AuthorizationUsed events...");

    const filter = {
      address: USDC_BASE,
      topics: [topic0],
      fromBlock: start,
      toBlock: end,
    };

    try {
      const logs = await provider.getLogs(filter);

      for (const logItem of logs) {
        const nonce = logItem.topics[2].toLowerCase();

        if (!nonceSet.has(nonce)) continue;

        paymentInfo.set(nonce, {
          txHash: logItem.transactionHash,
          blockNumber: logItem.blockNumber,
        });
      }

      log.info({ blockRange: `${start}-${end}`, matched: paymentInfo.size }, "Batch completed");
    } catch (err) {
      log.error({ err, blockRange: `${start}-${end}` }, "Failed to query batch");
      throw err;
    }
  }

  log.info({ count: paymentInfo.size }, "Payment info retrieved");
  return paymentInfo;
}

async function main() {
  const args = parseArgs();
  const startBlockArg = argString(args, "start-block");
  const endBlockArg = argString(args, "end-block");
  const dryRun = argString(args, "dry-run") === "true";

  const startBlock = startBlockArg ? parseInt(startBlockArg, 10) : DEFAULT_START_BLOCK;

  if (isNaN(startBlock)) {
    log.error("Invalid start-block argument");
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL_BASE;
  if (!rpcUrl) throw new Error("RPC_URL_BASE not set in environment");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const endBlock = endBlockArg ? parseInt(endBlockArg, 10) : await provider.getBlockNumber();

  if (endBlockArg && isNaN(endBlock)) {
    log.error("Invalid end-block argument");
    process.exit(1);
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
