import { prisma } from "../src/db";
import { argString, log, parseArgs } from "./script-utils";
import { formatUnits } from "ethers";

/**
 * Standalone script to read launches from the database
 *
 * Usage:
 *   bun run scripts/list-launches.ts                    # List all launches
 *   bun run scripts/list-launches.ts --filter=open      # List open launches
 *   bun run scripts/list-launches.ts --filter=graduated # List graduated launches
 *   bun run scripts/list-launches.ts --filter=refundable # List refundable launches
 *   bun run scripts/list-launches.ts --limit=50         # Limit results
 */

async function main() {
  const args = parseArgs();
  const filter = argString(args, "filter") || "";
  const limit = args.limit ? Number(args.limit) : 200;

  log.info({ filter: filter || "all", limit }, "Fetching launches...");

  // Build where clause based on filter
  const now14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  let where: any = {};

  if (filter === "open") {
    where = { graduated: false, createdAt: { gte: now14 } };
  } else if (filter === "graduated") {
    where = { graduated: true };
  } else if (filter === "refundable") {
    where = { graduated: false, createdAt: { lt: now14 } };
  }

  // Fetch launches
  const launches = await prisma.launch.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      tokenLower: true,
      onchainId: true,
      name: true,
      symbol: true,
      size: true,
      creator: true,
      graduated: true,
      status: true,
      createdAt: true,
      usdcAccounted6d: true,
      targetUsdc6d: true,
      usdcQueued6d: true,
      txHash: true,
      error: true,
    },
  });

  log.info({ count: launches.length }, `Found ${launches.length} launches`);

  // Display results
  if (launches.length === 0) {
    log.info("No launches found");
    return;
  }

  log.info(`\n${"=".repeat(100)}`);

  launches.forEach((launch, index) => {
    const usdcAccounted = launch.usdcAccounted6d ? formatUnits(launch.usdcAccounted6d, 6) : "0";
    const targetUsdc = launch.targetUsdc6d ? formatUnits(launch.targetUsdc6d, 6) : "0";
    const usdcQueued = formatUnits(launch.usdcQueued6d, 6);
    const progress = launch.targetUsdc6d && launch.targetUsdc6d > 0n
      ? ((Number(launch.usdcAccounted6d || 0n) / Number(launch.targetUsdc6d)) * 100).toFixed(2)
      : "0.00";

    log.info(
      {
        index: index + 1,
        name: launch.name,
        symbol: launch.symbol,
        token: launch.tokenLower,
        onchainId: launch.onchainId?.toString(),
        size: launch.size,
        creator: launch.creator,
        status: launch.status,
        graduated: launch.graduated,
        progress: `${progress}%`,
        usdcAccounted,
        targetUsdc,
        usdcQueued,
        txHash: launch.txHash,
        error: launch.error,
        createdAt: launch.createdAt,
      },
      `#${index + 1} - ${launch.name} (${launch.symbol})`
    );
  });

  log.info(`\n${"=".repeat(100)}`);

  // Summary statistics
  const statusCounts = new Map<string, number>();
  const sizeCounts = new Map<string, number>();
  let graduatedCount = 0;
  let totalUsdcAccounted = 0n;

  for (const launch of launches) {
    statusCounts.set(launch.status, (statusCounts.get(launch.status) || 0) + 1);
    sizeCounts.set(launch.size, (sizeCounts.get(launch.size) || 0) + 1);
    if (launch.graduated) graduatedCount++;
    if (launch.usdcAccounted6d) totalUsdcAccounted += launch.usdcAccounted6d;
  }

  log.info("\nSummary:");
  log.info(`- Total launches: ${launches.length}`);
  log.info(`- Graduated: ${graduatedCount}`);
  log.info(`- Total USDC accounted: ${formatUnits(totalUsdcAccounted, 6)}`);

  log.info("\nBy status:");
  for (const [status, count] of statusCounts) {
    log.info(`  - ${status}: ${count}`);
  }

  log.info("\nBy size:");
  for (const [size, count] of sizeCounts) {
    log.info(`  - ${size}: ${count}`);
  }
}

main()
  .catch((err) => {
    log.error({ err }, "list-launches script error");
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
