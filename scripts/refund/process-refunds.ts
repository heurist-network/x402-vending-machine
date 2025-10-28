import { ethers } from "ethers";
import { prisma } from "../../src/db";
import { log, parseArgs, argString } from "../script-utils";

/**
 * Standalone script to process REFUND jobs
 *
 * This script:
 * 1. Claims REFUND jobs from the queue
 * 2. Calls adminRefund on the VendingMachine contract
 * 3. Updates purchase status to 'refunded'
 *
 * Supports dry-run mode for testing without actual blockchain transactions
 */

const VM_ABI = [
  "function adminRefund(address to, uint256 usdcAmount) external"
];

const GAS_LIMIT_REFUND = 200_000n;

type RefundJob = {
  id: bigint;
  kind: string;
  uniqueKey: string | null;
  payload: any;
  status: string;
};

let currentNonce = 0;

// Get contract setup
const rpcUrl = process.env.RPC_URL_BASE;
const vmAddress = process.env.VENDING_MACHINE_ADDRESS;
const adminKey = process.env.ADMIN_PRIVATE_KEY;

if (!rpcUrl) throw new Error("RPC_URL_BASE not set");
if (!vmAddress) throw new Error("VENDING_MACHINE_ADDRESS not set");
if (!adminKey) throw new Error("ADMIN_PRIVATE_KEY not set");

const provider = new ethers.JsonRpcProvider(rpcUrl);
const adminWallet = new ethers.Wallet(adminKey, provider);
const vm = new ethers.Contract(vmAddress, VM_ABI, adminWallet);

async function processRefund(job: RefundJob, dryRun: boolean): Promise<void> {
  const { purchaseId, payer, usdcAmount6d } = job.payload;

  if (!purchaseId) throw new Error("refund_purchase_id_missing");
  if (!payer) throw new Error("refund_payer_missing");
  if (!usdcAmount6d) throw new Error("refund_amount_missing");

  // Get purchase details
  const purchase = await prisma.purchase.findUnique({
    where: { id: purchaseId },
    select: {
      status: true,
      payer: true,
      usdcAmount6d: true,
      tokenLower: true,
      x402Nonce: true,
      refundTxHash: true
    }
  });

  if (!purchase) throw new Error("purchase_not_found");

  // Validate status
  if (purchase.status !== "to_refund") {
    log.info({ purchaseId, status: purchase.status }, "Skipping refund - incorrect status");
    return;
  }

  // Check if already refunded
  if (purchase.refundTxHash) {
    log.warn({ purchaseId, refundTxHash: purchase.refundTxHash }, "Purchase already has refundTxHash");
    return;
  }

  const usdcDecimal = (parseFloat(usdcAmount6d) / 1e6).toFixed(2);
  log.info({ purchaseId, payer, usdcAmount: `$${usdcDecimal}` }, "Processing refund");

  if (dryRun) {
    console.log(`\n[DRY RUN] Would refund:`);
    console.log(`  Purchase ID: ${purchaseId}`);
    console.log(`  Payer: ${payer}`);
    console.log(`  Amount: $${usdcDecimal} (${usdcAmount6d} USDC 6d)`);
    console.log(`  Token: ${purchase.tokenLower}`);
    console.log(`  x402 Nonce: ${purchase.x402Nonce}`);
    console.log();
    return;
  }

  // Execute refund
  log.info({ purchaseId, payer, usdcAmount6d }, "Calling adminRefund on-chain");

  const tx = await vm.adminRefund(payer, usdcAmount6d, {
    gasLimit: GAS_LIMIT_REFUND,
    nonce: currentNonce
  });

  currentNonce++;

  const txHash = tx.hash;
  log.info({ purchaseId, txHash }, "Refund transaction submitted");

  // Update DB with tx hash immediately
  await prisma.purchase.update({
    where: { id: purchaseId },
    data: { refundTxHash: txHash }
  });

  // Wait for confirmation
  log.info({ purchaseId, txHash }, "Waiting for confirmation...");
  const receipt = await tx.wait();

  if (receipt.status !== 1) {
    throw new Error(`refund_tx_failed for purchase ${purchaseId} with tx hash ${txHash}`);
  }

  // Update status to refunded
  await prisma.purchase.update({
    where: { id: purchaseId },
    data: { status: "refunded" }
  });

  log.info({ purchaseId, txHash, blockNumber: receipt.blockNumber }, "REFUND completed successfully");
}

async function claimRefundJob(workerId: string): Promise<RefundJob | null> {
  const now = new Date();

  const job = await prisma.job.findFirst({
    where: {
      kind: "REFUND",
      status: "queued",
      runAfter: { lte: now }
    },
    orderBy: { createdAt: "asc" }
  });

  if (!job) return null;

  // Claim the job
  const updated = await prisma.job.updateMany({
    where: {
      id: job.id,
      status: "queued"
    },
    data: {
      status: "in_progress",
      lockedBy: workerId,
      lockedAt: now
    }
  });

  if (updated.count === 0) {
    // Job was claimed by another worker
    return null;
  }

  return job as RefundJob;
}

async function finishJob(jobId: bigint, success: boolean, error?: any): Promise<void> {
  if (success) {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "done" }
    });
  } else {
    // No retry - mark as dead immediately on failure
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "dead",
        attempts: 1,
        lockedBy: null,
        lockedAt: null
      }
    });
  }
}

async function main() {
  const args = parseArgs();
  const maxJobs = parseInt(argString(args, "max") || "10", 10);
  const dryRun = argString(args, "dry-run") === "true";
  const workerId = `refund-processor-${Date.now()}`;

  if (dryRun) {
    console.log("\n🔍 DRY RUN MODE - No blockchain transactions will be executed\n");
  }

  log.info({ maxJobs, dryRun, workerId }, "Starting refund processor");

  // Initialize nonce from admin wallet's current transaction count
  currentNonce = await provider.getTransactionCount(adminWallet.address);
  log.info({ currentNonce, adminAddress: adminWallet.address }, "Admin wallet nonce initialized");

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let totalUsdcRefunded = 0n;

  if (dryRun) {
    // In dry-run mode, just query jobs WITHOUT claiming them
    const now = new Date();
    const jobs = await prisma.job.findMany({
      where: {
        kind: "REFUND",
        status: "queued",
        runAfter: { lte: now }
      },
      orderBy: { createdAt: "asc" },
      take: maxJobs
    });

    console.log(`\nFound ${jobs.length} REFUND jobs to preview\n`);

    for (const job of jobs) {
      processed++;
      const usdcAmount = BigInt(job.payload.usdcAmount6d || 0);

      log.info({ jobId: job.id, purchaseId: job.payload.purchaseId }, `Preview job ${processed}/${jobs.length}`);

      try {
        await processRefund(job as RefundJob, true);
        succeeded++;
        totalUsdcRefunded += usdcAmount;
      } catch (error: any) {
        failed++;
        log.error({ err: error, jobId: job.id }, "Preview failed");
      }
    }
  } else {
    // In real mode, claim and process jobs
    for (let i = 0; i < maxJobs; i++) {
      const job = await claimRefundJob(workerId);

      if (!job) {
        log.info("No more REFUND jobs to process");
        break;
      }

      processed++;
      const usdcAmount = BigInt(job.payload.usdcAmount6d || 0);

      log.info({ jobId: job.id, purchaseId: job.payload.purchaseId }, `Processing job ${processed}/${maxJobs}`);

      try {
        await processRefund(job, false);
        await finishJob(job.id, true);
        succeeded++;
        totalUsdcRefunded += usdcAmount;
        log.info({ jobId: job.id }, "Job completed successfully");
      } catch (error: any) {
        failed++;
        log.error({ err: error, jobId: job.id }, "Job failed");
        await finishJob(job.id, false, error);
      }
    }
  }

  const totalUsdcDecimal = (parseFloat(totalUsdcRefunded.toString()) / 1e6).toFixed(2);

  console.log("\n=== REFUND PROCESSING SUMMARY ===\n");
  console.log(`Jobs processed: ${processed}`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total USDC refunded: $${totalUsdcDecimal}\n`);

  if (dryRun) {
    console.log("🔍 This was a DRY RUN - no actual refunds were executed");
    console.log("Run without --dry-run true to execute refunds on-chain");
  } else if (failed > 0) {
    console.log("⚠️  Some jobs failed and were marked as DEAD (no retry)");
    console.log("Review failed jobs manually before re-enqueueing");
  }

  console.log();
}

main()
  .catch((err) => {
    log.error({ err }, "Refund processor error");
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
