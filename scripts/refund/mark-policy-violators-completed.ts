import { prisma } from "../../src/db";
import { log, parseArgs, argString } from "../script-utils";

/**
 * Mark purchases from policy-violating addresses as "completed" to prevent refunds
 *
 * This script:
 * 1. Finds purchases with recipient addresses in the POLICY_VIOLATORS list
 * 2. Updates purchases in "to_refund" status to "completed"
 * 3. Marks associated REFUND jobs as "dead"
 *
 * Usage:
 *   bun run scripts/refund/mark-policy-violators-completed.ts --dry-run true  # Preview
 *   bun run scripts/refund/mark-policy-violators-completed.ts                 # Execute
 */

// ============================================================================
// CONFIGURATION - Add addresses that violated policy (bot users, etc.)
// ============================================================================
const POLICY_VIOLATORS: string[] = [
  // add addresses here
];

async function main() {
  const args = parseArgs();
  const dryRun = argString(args, "dry-run") === "true";

  if (POLICY_VIOLATORS.length === 0) {
    console.log("⚠️  No policy violators configured in POLICY_VIOLATORS array");
    console.log("   Edit this script and add addresses to the POLICY_VIOLATORS constant");
    process.exit(0);
  }

  // Normalize addresses to lowercase
  const violatorAddresses = POLICY_VIOLATORS.map(addr => addr.toLowerCase());

  log.info({
    violatorCount: violatorAddresses.length,
    dryRun
  }, "Starting policy violator cleanup...");

  console.log("\nPolicy violating addresses:");
  violatorAddresses.forEach((addr, i) => {
    console.log(`  ${i + 1}. ${addr}`);
  });
  console.log();

  // Find all purchases from policy violators that are eligible for refund
  // This includes: to_refund, queued, processing (payment received but not delivered)
  const purchasesToUpdate = await prisma.purchase.findMany({
    where: {
      recipient: {
        in: violatorAddresses
      },
      status: {
        in: ["to_refund", "queued", "processing"]
      }
    },
    select: {
      id: true,
      recipient: true,
      tokenLower: true,
      usdcAmount6d: true,
      status: true,
      createdAt: true
    }
  });

  log.info({ count: purchasesToUpdate.length }, "Purchases found eligible for refund");

  if (purchasesToUpdate.length === 0) {
    console.log("✅ No refundable purchases found for policy violators");
    console.log("   Nothing to update");
    return;
  }

  // Group by status for reporting
  const byStatus: Record<string, number> = {};
  for (const p of purchasesToUpdate) {
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  }

  // Find REFUND jobs for these purchases
  const purchaseIds = purchasesToUpdate.map(p => p.id);
  const refundJobs = await prisma.job.findMany({
    where: {
      kind: "REFUND",
      payload: {
        path: ["purchaseId"],
        string_contains: purchaseIds[0] // This is a simple check, we'll filter in memory
      }
    },
    select: {
      id: true,
      status: true,
      payload: true
    }
  });

  // Filter jobs that match our purchase IDs
  const jobsToUpdate = refundJobs.filter(job => {
    const payload = job.payload as any;
    return payload.purchaseId && purchaseIds.includes(payload.purchaseId);
  });

  log.info({ count: jobsToUpdate.length }, "REFUND jobs found for these purchases");

  // Calculate total USDC amount
  const totalUsdcAmount = purchasesToUpdate.reduce((sum, p) => sum + p.usdcAmount6d, 0n);

  console.log("\n=== SUMMARY ===\n");
  console.log(`Purchases to mark as completed: ${purchasesToUpdate.length}`);
  console.log(`Total USDC amount: $${(Number(totalUsdcAmount) / 1e6).toFixed(2)}`);
  console.log(`REFUND jobs to mark as dead: ${jobsToUpdate.length}`);

  console.log("\nBy current status:");
  for (const [status, count] of Object.entries(byStatus)) {
    console.log(`  - ${status}: ${count}`);
  }

  console.log("\nPurchase details:");
  purchasesToUpdate.forEach((p, i) => {
    const usdcAmount = (Number(p.usdcAmount6d) / 1e6).toFixed(2);
    console.log(`  ${i + 1}. ${p.recipient} - $${usdcAmount} USDC - Status: ${p.status} - Token: ${p.tokenLower}`);
  });

  if (dryRun) {
    console.log("\n🔍 DRY RUN - No changes made");
    console.log("\nActions that would be taken:");
    console.log(`  - Update ${purchasesToUpdate.length} purchases: status → "completed"`);
    console.log(`  - Update ${jobsToUpdate.length} REFUND jobs: status → "dead"`);
    console.log("\nRun without --dry-run to execute these changes");
    return;
  }

  console.log("\n⚠️  EXECUTING CHANGES...\n");

  // Update purchases to "completed"
  let updatedPurchases = 0;
  for (const purchase of purchasesToUpdate) {
    await prisma.purchase.update({
      where: { id: purchase.id },
      data: { status: "completed" }
    });
    updatedPurchases++;

    if (updatedPurchases % 10 === 0) {
      log.info({ progress: `${updatedPurchases}/${purchasesToUpdate.length}` }, "Updating purchases...");
    }
  }

  log.info({ count: updatedPurchases }, "Purchases updated to 'completed'");

  // Update REFUND jobs to "dead"
  let updatedJobs = 0;
  for (const job of jobsToUpdate) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "dead" }
    });
    updatedJobs++;
  }

  log.info({ count: updatedJobs }, "REFUND jobs marked as 'dead'");

  console.log("\n✅ COMPLETED\n");
  console.log(`Updated ${updatedPurchases} purchases to 'completed' status`);
  console.log(`Marked ${updatedJobs} REFUND jobs as 'dead'`);
  console.log(`Total USDC amount affected: $${(Number(totalUsdcAmount) / 1e6).toFixed(2)}\n`);

  console.log("These purchases will not be refunded.");
  console.log("Policy violators will not receive refunds for bot/automated purchases.");
}

main()
  .catch((err) => {
    log.error({ err }, "Script error");
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
