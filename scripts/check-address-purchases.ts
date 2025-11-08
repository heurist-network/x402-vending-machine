import { prisma } from "../src/db";
import { argString, log, parseArgs } from "./script-utils";

async function main() {
  const args = parseArgs();
  const address =
    argString(args, "address") ||
    process.env.ADDRESS ||
    "0xF12C4868b232feA855ec3f7E12Dc1FaDa142c2ce".toLowerCase();

  log.info({ address }, "Checking purchases for address");

  // Check as payer
  const asPayer = await prisma.purchase.findMany({
    where: { payer: address },
    orderBy: { createdAt: "asc" },
  });

  log.info(
    { count: asPayer.length },
    `\n${"=".repeat(80)}\nPurchases where address is PAYER`
  );

  asPayer.forEach((purchase, index) => {
    log.info(
      {
        purchaseNumber: index + 1,
        id: purchase.id,
        payer: purchase.payer,
        recipient: purchase.recipient,
        tokenLower: purchase.tokenLower,
        onchainId: purchase.onchainId.toString(),
        usdcAmount6d: purchase.usdcAmount6d.toString(),
        x402Nonce: purchase.x402Nonce,
        status: purchase.status,
        txHash: purchase.txHash,
        refundTxHash: purchase.refundTxHash,
        paymentTxHash: purchase.paymentTxHash,
        paymentBlockNumber: purchase.paymentBlockNumber?.toString(),
        operator: purchase.operator,
        createdAt: purchase.createdAt,
      },
      `Purchase #${index + 1} (as payer)`
    );
  });

  // Check as recipient
  const asRecipient = await prisma.purchase.findMany({
    where: { recipient: address },
    orderBy: { createdAt: "asc" },
  });

  log.info(
    { count: asRecipient.length },
    `\n${"=".repeat(80)}\nPurchases where address is RECIPIENT`
  );

  asRecipient.forEach((purchase, index) => {
    log.info(
      {
        purchaseNumber: index + 1,
        id: purchase.id,
        payer: purchase.payer,
        recipient: purchase.recipient,
        tokenLower: purchase.tokenLower,
        onchainId: purchase.onchainId.toString(),
        usdcAmount6d: purchase.usdcAmount6d.toString(),
        x402Nonce: purchase.x402Nonce,
        status: purchase.status,
        txHash: purchase.txHash,
        refundTxHash: purchase.refundTxHash,
        paymentTxHash: purchase.paymentTxHash,
        paymentBlockNumber: purchase.paymentBlockNumber?.toString(),
        operator: purchase.operator,
        createdAt: purchase.createdAt,
      },
      `Purchase #${index + 1} (as recipient)`
    );
  });

  // Get all unique purchase IDs for job lookup
  const allPurchases = [...asPayer, ...asRecipient];
  const purchaseIds = allPurchases.map((p) => p.id);

  if (purchaseIds.length === 0) {
    log.warn("No purchases found for this address");
    return;
  }

  // Check related jobs
  log.info(
    `\n${"=".repeat(80)}\nChecking related jobs in job table`
  );

  // Look for jobs that reference these purchase IDs in their payload
  const jobs = await prisma.job.findMany({
    orderBy: { createdAt: "asc" },
  });

  const relatedJobs = jobs.filter((job) => {
    const payloadStr = JSON.stringify(job.payload);
    return purchaseIds.some((id) => payloadStr.includes(id));
  });

  log.info(
    { count: relatedJobs.length },
    `Found ${relatedJobs.length} related jobs`
  );

  relatedJobs.forEach((job, index) => {
    log.info(
      {
        jobNumber: index + 1,
        id: job.id.toString(),
        kind: job.kind,
        uniqueKey: job.uniqueKey,
        payload: job.payload,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        runAfter: job.runAfter,
        lockedBy: job.lockedBy,
        lockedAt: job.lockedAt,
        createdAt: job.createdAt,
      },
      `Job #${index + 1}`
    );
  });

  // Also check for jobs with the same paymentTxHash
  const uniquePaymentTxHashes = [
    ...new Set(
      allPurchases
        .map((p) => p.paymentTxHash)
        .filter((hash): hash is string => hash !== null)
    ),
  ];

  if (uniquePaymentTxHashes.length > 0) {
    log.info(
      `\n${"=".repeat(80)}\nChecking for other purchases with same payment tx hash`
    );

    for (const txHash of uniquePaymentTxHashes) {
      const sameTxPurchases = await prisma.purchase.findMany({
        where: { paymentTxHash: txHash },
        orderBy: { createdAt: "asc" },
      });

      if (sameTxPurchases.length > 1) {
        log.warn(
          { txHash, count: sameTxPurchases.length },
          `FOUND ${sameTxPurchases.length} PURCHASES WITH SAME PAYMENT TX HASH!`
        );

        sameTxPurchases.forEach((purchase, index) => {
          log.warn(
            {
              occurrence: index + 1,
              id: purchase.id,
              payer: purchase.payer,
              recipient: purchase.recipient,
              usdcAmount6d: purchase.usdcAmount6d.toString(),
              x402Nonce: purchase.x402Nonce,
              status: purchase.status,
              paymentTxHash: purchase.paymentTxHash,
              createdAt: purchase.createdAt,
            },
            `Duplicate payment tx - Purchase #${index + 1}`
          );
        });
      }
    }
  }

  log.info(`\n${"=".repeat(80)}\nSummary:`);
  log.info(`- Purchases as payer: ${asPayer.length}`);
  log.info(`- Purchases as recipient: ${asRecipient.length}`);
  log.info(`- Related jobs: ${relatedJobs.length}`);
}

main()
  .catch((err) => {
    log.error({ err }, "check-address-purchases script error");
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
