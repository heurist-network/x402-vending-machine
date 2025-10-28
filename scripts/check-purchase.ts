import { prisma } from "../src/db";
import { argString, log, parseArgs } from "./script-utils";

async function main() {
  const args = parseArgs();
  const purchaseId = argString(args, "id") || process.env.PURCHASE_ID || "51596a2b-e9f4-444e-b53b-86e77ccf2a57";

  const purchase = await prisma.purchase.findUnique({
    where: { id: purchaseId }
  });

  if (!purchase) {
    log.error({ purchaseId }, "Purchase not found");
    process.exit(1);
  }

  log.info({
    id: purchase.id,
    tokenLower: purchase.tokenLower,
    onchainId: purchase.onchainId?.toString(),
    payer: purchase.payer,
    recipient: purchase.recipient,
    usdcAmount6d: purchase.usdcAmount6d.toString(),
    x402Nonce: purchase.x402Nonce,
    txHash: purchase.txHash,
    refundTxHash: purchase.refundTxHash,
    status: purchase.status,
    operator: purchase.operator,
    createdAt: purchase.createdAt
  }, "Purchase record");
}

main()
  .catch((err) => {
    log.error({ err }, "check-purchase script error");
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
