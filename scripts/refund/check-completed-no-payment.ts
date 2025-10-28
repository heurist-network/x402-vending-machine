import { prisma } from "../../src/db";
import { log } from "../script-utils";

/**
 * Ad-hoc script to investigate purchases marked as "completed"
 * but with no payment event found on-chain
 */

async function main() {
  console.log("\n=== COMPLETED PURCHASES WITHOUT PAYMENT EVENTS ===\n");

  // Get all completed purchases
  const completedPurchases = await prisma.purchase.findMany({
    where: {
      status: "completed"
    },
    orderBy: {
      createdAt: "asc"
    }
  });

  console.log(`Total completed purchases: ${completedPurchases.length}\n`);

  // Separate by whether they have payment tracking info
  const withPaymentInfo = completedPurchases.filter(p => p.paymentTxHash && p.paymentBlockNumber);
  const withoutPaymentInfo = completedPurchases.filter(p => !p.paymentTxHash || !p.paymentBlockNumber);

  console.log(`✅ With payment tracking info: ${withPaymentInfo.length}`);
  console.log(`❌ Without payment tracking info: ${withoutPaymentInfo.length}\n`);

  if (withoutPaymentInfo.length > 0) {
    console.log("Purchases WITHOUT payment tracking info:\n");
    console.log("ID | Created At | Payer | Token | USDC | x402Nonce | txHash");
    console.log("-".repeat(120));

    let totalUsdc = 0n;
    for (const p of withoutPaymentInfo) {
      const createdAt = p.createdAt.toISOString().substring(0, 19);
      const usdcDecimal = (parseFloat(p.usdcAmount6d.toString()) / 1e6).toFixed(2);
      const payerShort = p.payer.substring(0, 8) + "...";
      const tokenShort = p.tokenLower.substring(0, 8) + "...";
      const nonceShort = p.x402Nonce.substring(0, 12) + "...";
      const txHashShort = p.txHash ? p.txHash.substring(0, 12) + "..." : "null";

      console.log(`${p.id.substring(0, 8)} | ${createdAt} | ${payerShort} | ${tokenShort} | $${usdcDecimal} | ${nonceShort} | ${txHashShort}`);
      totalUsdc += p.usdcAmount6d;
    }

    console.log("-".repeat(120));
    console.log(`Total: ${withoutPaymentInfo.length} purchases, $${(parseFloat(totalUsdc.toString()) / 1e6).toFixed(2)}\n`);

    // Show detailed info for first 3
    console.log("\n📋 DETAILED VIEW (first 3):\n");
    for (const p of withoutPaymentInfo.slice(0, 3)) {
      console.log("─".repeat(80));
      console.log(`Purchase ID: ${p.id}`);
      console.log(`Created At: ${p.createdAt.toISOString()}`);
      console.log(`Status: ${p.status}`);
      console.log(`Token: ${p.tokenLower}`);
      console.log(`Onchain ID: ${p.onchainId}`);
      console.log(`Payer: ${p.payer}`);
      console.log(`Recipient: ${p.recipient}`);
      console.log(`USDC Amount: $${(parseFloat(p.usdcAmount6d.toString()) / 1e6).toFixed(2)} (${p.usdcAmount6d})`);
      console.log(`x402 Nonce: ${p.x402Nonce}`);
      console.log(`Purchase txHash: ${p.txHash || "null"}`);
      console.log(`Refund txHash: ${p.refundTxHash || "null"}`);
      console.log(`Payment txHash: ${p.paymentTxHash || "NOT SET"}`);
      console.log(`Payment Block: ${p.paymentBlockNumber || "NOT SET"}`);
      console.log(`Operator: ${p.operator || "null"}`);
      console.log();
    }
  }

  // Also check: purchases with txHash but marked completed
  console.log("\n📊 ANALYSIS BY PURCHASE TX HASH:\n");
  const completedWithTxHash = completedPurchases.filter(p => p.txHash);
  const completedWithoutTxHash = completedPurchases.filter(p => !p.txHash);

  console.log(`Completed WITH purchase txHash: ${completedWithTxHash.length}`);
  console.log(`Completed WITHOUT purchase txHash: ${completedWithoutTxHash.length}`);

  if (completedWithoutTxHash.length > 0) {
    console.log("\n⚠️  WARNING: These purchases are marked 'completed' but have NO purchase transaction hash!");
    console.log("This is a data integrity issue - they should have a txHash.\n");

    for (const p of completedWithoutTxHash.slice(0, 5)) {
      console.log(`- ${p.id}: $${(parseFloat(p.usdcAmount6d.toString()) / 1e6).toFixed(2)} | Created: ${p.createdAt.toISOString()}`);
    }
  }

  // Check if these need refunds
  console.log("\n\n💡 RECOMMENDATIONS:\n");
  if (withoutPaymentInfo.length > 0) {
    console.log("1. Run backfill script with wider block range:");
    console.log("   bun run scripts/backfill-payment-tracking.ts --start-block 37000000");
    console.log("");
    console.log("2. If backfill finds payment events, these are OK (payment was made)");
    console.log("");
    console.log("3. If backfill still finds nothing:");
    console.log("   - These may be test/invalid purchases");
    console.log("   - Or payment events are outside indexed blocks");
    console.log("   - Verify on Basescan using the x402Nonce");
    console.log("");
    console.log("4. To verify a specific nonce on-chain:");
    console.log("   - Go to https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913#events");
    console.log("   - Search for AuthorizationUsed events");
    console.log("   - Filter by the nonce value shown above");
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
