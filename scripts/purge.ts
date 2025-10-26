import { prisma } from "../src/db";
import { argString, log, parseArgs } from "./script-utils";

async function main() {
  const args = parseArgs();
  const launchId = argString(args, "launch");
  const purchaseId = argString(args, "purchase");

  if (!launchId && !purchaseId) {
    log.error("Must provide either --launch <id> or --purchase <id>");
    process.exit(1);
  }

  if (launchId && purchaseId) {
    log.error("Cannot provide both --launch and --purchase, choose one");
    process.exit(1);
  }

  if (launchId) {
    await purgeLaunch(launchId);
  } else if (purchaseId) {
    await purgePurchase(purchaseId);
  }
}

async function purgeLaunch(id: string) {
  const launch = await prisma.launch.findUnique({
    where: { id }
  });

  if (!launch) {
    log.error({ id }, "Launch not found");
    return;
  }

  if (launch.status !== "queued") {
    log.error({ id, status: launch.status }, "Launch status must be 'queued' to purge");
    return;
  }

  log.info({ id, name: launch.name, symbol: launch.symbol }, "Purging launch");

  await prisma.launch.delete({
    where: { id }
  });

  log.info({ id }, "Launch purged successfully");
}

async function purgePurchase(id: string) {
  const purchase = await prisma.purchase.findUnique({
    where: { id }
  });

  if (!purchase) {
    log.error({ id }, "Purchase not found");
    return;
  }

  if (purchase.status !== "queued") {
    log.error({ id, status: purchase.status }, "Purchase status must be 'queued' to purge");
    return;
  }

  log.info({
    id,
    tokenLower: purchase.tokenLower,
    payer: purchase.payer
  }, "Purging purchase");

  await prisma.purchase.delete({
    where: { id }
  });

  log.info({ id }, "Purchase purged successfully");
}

main()
  .catch((err) => {
    log.error({ err }, "purge failed");
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
