import { formatUnits } from "ethers";
import { prisma } from "../src/db";
import { argString, log, parseArgs } from "./script-utils";

type JobRecord = Awaited<ReturnType<typeof prisma.job.findMany>>[number];

async function main() {
  const args = parseArgs();
  const statusFilter = argString(args, "status");
  const kindFilter = argString(args, "kind");
  const limitInput = Number(argString(args, "limit") || process.env.QUEUE_LIMIT || "20");
  const limit = Number.isFinite(limitInput) && limitInput > 0 ? limitInput : 20;

  const where: Record<string, any> = {};
  if (statusFilter) {
    where.status = statusFilter.toLowerCase();
  }
  if (kindFilter) {
    where.kind = kindFilter.toUpperCase();
  }

  const jobs = await prisma.job.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit
  });

  if (!jobs.length) {
    log.info("No jobs found");
    return;
  }

  const { launchesById, launchesByToken, purchasesById } = await loadRelatedEntities(jobs);

  for (const job of jobs) {
    const details = buildDetails(job, launchesById, launchesByToken, purchasesById);
    log.info(
      {
        id: job.id,
        kind: job.kind,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        runAfter: job.runAfter,
        lockedBy: job.lockedBy,
        lockedAt: job.lockedAt,
        reference: details
      },
      "queue item"
    );
  }
}

async function loadRelatedEntities(jobs: JobRecord[]) {
  const launchIds = new Set<string>();
  const tokenLowers = new Set<string>();
  const purchaseIds = new Set<string>();

  for (const job of jobs) {
    const payload = job.payload as any;
    if (!payload) continue;
    if (job.kind === "COIN" && payload.launchId) {
      launchIds.add(payload.launchId);
    }
    if (job.kind === "PURCHASE" && payload.purchaseId) {
      purchaseIds.add(payload.purchaseId);
    }
    if (job.kind === "GRADUATE" && payload.tokenLower) {
      tokenLowers.add(payload.tokenLower);
    }
    if (job.kind === "REFUND" && payload.purchaseId) {
      purchaseIds.add(payload.purchaseId);
    }
  }

  const launchesById = new Map<string, any>();
  const launchesByToken = new Map<string, any>();
  if (launchIds.size) {
    const launches = await prisma.launch.findMany({
      where: { id: { in: Array.from(launchIds) } },
      select: {
        id: true,
        tokenLower: true,
        name: true,
        symbol: true,
        status: true,
        size: true,
        creator: true,
        contractUri: true
      }
    });
    for (const launch of launches) {
      launchesById.set(launch.id, launch);
      if (launch.tokenLower) launchesByToken.set(launch.tokenLower, launch);
    }
  }

  const missingTokenLowers: string[] = [];
  for (const token of tokenLowers) {
    if (!launchesByToken.has(token)) {
      missingTokenLowers.push(token);
    }
  }
  if (missingTokenLowers.length) {
    const launches = await prisma.launch.findMany({
      where: { tokenLower: { in: missingTokenLowers } },
      select: {
        id: true,
        tokenLower: true,
        name: true,
        symbol: true,
        status: true,
        size: true,
        creator: true,
        contractUri: true
      }
    });
    for (const launch of launches) {
      if (launch.id) launchesById.set(launch.id, launch);
      if (launch.tokenLower) launchesByToken.set(launch.tokenLower, launch);
    }
  }

  const purchasesById = new Map<string, any>();
  if (purchaseIds.size) {
    const purchases = await prisma.purchase.findMany({
      where: { id: { in: Array.from(purchaseIds) } },
      select: {
        id: true,
        tokenLower: true,
        payer: true,
        recipient: true,
        usdcAmount6d: true,
        status: true,
        createdAt: true
      }
    });
    for (const purchase of purchases) {
      purchasesById.set(purchase.id, purchase);
    }
  }

  return { launchesById, launchesByToken, purchasesById };
}

function buildDetails(
  job: JobRecord,
  launchesById: Map<string, any>,
  launchesByToken: Map<string, any>,
  purchasesById: Map<string, any>
) {
  const payload = job.payload as any;
  if (!payload) return null;

  if (job.kind === "COIN") {
    const launch = payload.launchId ? launchesById.get(payload.launchId) : undefined;
    return {
      launchId: payload.launchId,
      name: payload.name,
      symbol: payload.symbol,
      size: payload.size,
      creator: payload.creator || launch?.creator,
      token: launch?.tokenLower || null,
      metadataUri: launch?.contractUri || payload.metadataUri || null
    };
  }

  if (job.kind === "PURCHASE") {
    const purchase = payload.purchaseId ? purchasesById.get(payload.purchaseId) : undefined;
    return {
      purchaseId: payload.purchaseId,
      token: purchase?.tokenLower || payload.tokenLower || null,
      payer: purchase?.payer || null,
      recipient: purchase?.recipient || payload.recipient || null,
      usdc: purchase ? formatUnits(purchase.usdcAmount6d, 6) : payload.usdcAmount6d || null,
      status: purchase?.status || null
    };
  }

  if (job.kind === "GRADUATE") {
    const launch = payload.tokenLower ? launchesByToken.get(payload.tokenLower) : undefined;
    return {
      token: payload.tokenLower || launch?.tokenLower || null,
      name: launch?.name || null,
      symbol: launch?.symbol || null,
      size: launch?.size || null
    };
  }

  if (job.kind === "REFUND") {
    const purchase = payload.purchaseId ? purchasesById.get(payload.purchaseId) : undefined;
    return {
      purchaseId: payload.purchaseId,
      token: purchase?.tokenLower || payload.tokenLower || null,
      payer: purchase?.payer || null,
      usdc: purchase ? formatUnits(purchase.usdcAmount6d, 6) : payload.usdcAmount6d || null,
      status: purchase?.status || null
    };
  }

  return payload;
}

main()
  .catch((err) => {
    log.error({ err }, "queue-snapshot failed");
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
