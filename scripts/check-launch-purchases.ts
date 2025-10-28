import { prisma } from "../src/db";
import { argString, log, parseArgs } from "./script-utils";
import { formatUnits } from "ethers";

/**
 * Check all purchases for a given launch to debug usdc_queued discrepancies
 */

async function main() {
  const args = parseArgs();
  const token = argString(args, "token") || process.env.TOKEN || "0xaa9abdcdb1789bd7df555ed5dc33e4bb845505fe";
  const tokenLower = token.toLowerCase();

  // Get launch details
  const launch = await prisma.launch.findUnique({
    where: { tokenLower },
    select: {
      id: true,
      name: true,
      symbol: true,
      tokenLower: true,
      onchainId: true,
      status: true,
      graduated: true,
      targetUsdc6d: true,
      usdcAccounted6d: true,
      usdcQueued6d: true,
      createdAt: true
    }
  });

  if (!launch) {
    log.error({ tokenLower }, "Launch not found");
    process.exit(1);
  }

  log.info({
    name: launch.name,
    symbol: launch.symbol,
    tokenLower: launch.tokenLower,
    onchainId: launch.onchainId?.toString(),
    status: launch.status,
    graduated: launch.graduated,
    targetUsdc: formatUnits(launch.targetUsdc6d ?? 0n, 6),
    usdcAccounted: formatUnits(launch.usdcAccounted6d ?? 0n, 6),
    usdcQueued: formatUnits(launch.usdcQueued6d ?? 0n, 6),
    createdAt: launch.createdAt
  }, "Launch details");

  // Get all purchases
  const purchases = await prisma.purchase.findMany({
    where: { tokenLower },
    select: {
      id: true,
      payer: true,
      recipient: true,
      usdcAmount6d: true,
      status: true,
      txHash: true,
      refundTxHash: true,
      operator: true,
      createdAt: true
    },
    orderBy: { createdAt: "asc" }
  });

  log.info({ count: purchases.length }, "Total purchases found");

  // Group by status
  const byStatus: Record<string, typeof purchases> = {};
  let totalByStatus: Record<string, bigint> = {};

  for (const p of purchases) {
    if (!byStatus[p.status]) {
      byStatus[p.status] = [];
      totalByStatus[p.status] = 0n;
    }
    byStatus[p.status].push(p);
    totalByStatus[p.status] += p.usdcAmount6d;
  }

  console.log("\n📊 Purchase status breakdown:\n");
  for (const [status, list] of Object.entries(byStatus)) {
    console.log(`  ${status}: ${list.length} purchases, total: ${formatUnits(totalByStatus[status], 6)} USDC`);
  }

  // Calculate expected usdcQueued
  const queuedStatuses = ["queued", "processing"];
  const expectedQueued = purchases
    .filter(p => queuedStatuses.includes(p.status))
    .reduce((sum, p) => sum + p.usdcAmount6d, 0n);

  console.log("\n🔍 Analysis:\n");
  console.log(`  Expected usdcQueued (queued + processing): ${formatUnits(expectedQueued, 6)} USDC`);
  console.log(`  Actual usdcQueued in DB: ${formatUnits(launch.usdcQueued6d ?? 0n, 6)} USDC`);
  console.log(`  Difference: ${formatUnits((launch.usdcQueued6d ?? 0n) - expectedQueued, 6)} USDC`);

  // Show details for queued/processing purchases
  const activeStatuses = ["queued", "processing", "to_refund"];
  const activePurchases = purchases.filter(p => activeStatuses.includes(p.status));

  if (activePurchases.length > 0) {
    console.log(`\n📋 Active purchases (${activePurchases.length}):\n`);
    for (const p of activePurchases) {
      console.log(`  ID: ${p.id}`);
      console.log(`    Status: ${p.status}`);
      console.log(`    Amount: ${formatUnits(p.usdcAmount6d, 6)} USDC`);
      console.log(`    Payer: ${p.payer}`);
      console.log(`    Recipient: ${p.recipient}`);
      console.log(`    Created: ${p.createdAt}`);
      console.log(`    TxHash: ${p.txHash || "N/A"}`);
      console.log(`    RefundTxHash: ${p.refundTxHash || "N/A"}`);
      console.log("");
    }
  }

  // Show summary
  console.log("\n📈 Summary:\n");
  const completedTotal = totalByStatus["completed"] || 0n;
  const refundedTotal = (totalByStatus["refunded"] || 0n) + (totalByStatus["to_refund"] || 0n);
  const queuedTotal = (totalByStatus["queued"] || 0n) + (totalByStatus["processing"] || 0n);

  console.log(`  Completed: ${formatUnits(completedTotal, 6)} USDC`);
  console.log(`  Refunded/To Refund: ${formatUnits(refundedTotal, 6)} USDC`);
  console.log(`  Queued/Processing: ${formatUnits(queuedTotal, 6)} USDC`);
  console.log(`  Total purchases: ${formatUnits(completedTotal + refundedTotal + queuedTotal, 6)} USDC`);
}

main()
  .catch((err) => {
    log.error({ err }, "check-launch-purchases script error");
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
