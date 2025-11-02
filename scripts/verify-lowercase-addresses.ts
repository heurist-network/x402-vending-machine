import { prisma } from "../src/db";
import { log } from "./script-utils";

/**
 * Migration script to convert all existing addresses to lowercase
 *
 * This migrates ALL tables using direct SQL UPDATE for efficiency.
 *
 * Run with: bun run scripts/migrate-lowercase-addresses.ts
 */

async function main() {
  log.info("Starting migration to lowercase all addresses using SQL...");

  try {
    log.info("Verifying migration...");

    const mixedCasePurchases = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count
      FROM purchases
      WHERE payer != LOWER(payer)
         OR recipient != LOWER(recipient)
         OR token_lower != LOWER(token_lower)
         OR (operator IS NOT NULL AND operator != LOWER(operator))
    `;

    const mixedCaseLaunches = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count
      FROM launches
      WHERE creator != LOWER(creator)
         OR (token_lower IS NOT NULL AND token_lower != LOWER(token_lower))
    `;

    const mixedPurchaseCount = Number(mixedCasePurchases[0].count);
    const mixedLaunchCount = Number(mixedCaseLaunches[0].count);

    if (mixedPurchaseCount === 0 && mixedLaunchCount === 0) {
      log.info("✓ Verification passed: All addresses are lowercase");
    } else {
      log.error(
        { mixedCasePurchases: mixedPurchaseCount, mixedCaseLaunches: mixedLaunchCount },
        "✗ Verification failed: Some addresses still have mixed case"
      );
      process.exit(1);
    }

    // Show sample of migrated data
    log.info("\nSample of migrated addresses:");

    const samplePurchases = await prisma.purchase.findMany({
      take: 5,
      select: {
        id: true,
        payer: true,
        recipient: true,
        tokenLower: true,
      },
    });

    samplePurchases.forEach((p, i) => {
      log.info({
        index: i + 1,
        payer: p.payer,
        recipient: p.recipient,
        tokenLower: p.tokenLower,
      });
    });

  } catch (error) {
    log.error({ error }, "Migration failed - transaction rolled back");
    throw error;
  }
}

main()
  .catch((err) => {
    log.error({ err }, "Migration failed");
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
