import { formatUnits } from "ethers";
import { prisma } from "../src/db";
import { argString, log, parseArgs } from "./script-utils";

async function main() {
  const args = parseArgs();
  const tokenFilter = (argString(args, "token") || process.env.DB_TOKEN)?.toLowerCase();

  if (tokenFilter) {
    const launch = await prisma.launch.findUnique({
      where: { tokenLower: tokenFilter }
    });
    if (!launch) {
      log.error({ token: tokenFilter }, "Launch not found");
      return;
    }

    await printLaunch(launch);
    await printPurchases(tokenFilter);
  } else {
    const launches = await prisma.launch.findMany({
      orderBy: { createdAt: "desc" },
      take: Number(argString(args, "limit") || process.env.DB_LIMIT || "10")
    });
    for (const launch of launches) {
      await printLaunch(launch);
    }
  }
}

async function printLaunch(launch: any) {
  log.info({
    id: launch.id,
    token: launch.tokenLower,
    name: launch.name,
    symbol: launch.symbol,
    size: launch.size,
    status: launch.status,
    graduated: launch.graduated,
    createdAt: launch.createdAt,
    usdcAccounted: formatUnits(launch.usdcAccounted6d, 6),
    usdcQueued: formatUnits(launch.usdcQueued6d, 6),
    targetUsdc: formatUnits(launch.targetUsdc6d, 6)
  });
}

async function printPurchases(tokenLower: string) {
  const groups = await prisma.purchase.groupBy({
    by: ["status"],
    where: { tokenLower },
    _count: true,
    _sum: { usdcAmount6d: true }
  });

  for (const g of groups) {
    log.info({
      status: g.status,
      count: g._count,
      usdc: g._sum.usdcAmount6d ? formatUnits(g._sum.usdcAmount6d, 6) : "0"
    }, "Purchase stats");
  }
}

main()
  .catch((err) => {
    log.error({ err }, "db-snapshot failed");
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
