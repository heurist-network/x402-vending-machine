import pino from "pino";
import type { Logger } from "pino";
import { prisma } from "./db";
import { enqueueJob } from "./queue";
import { initContracts, pickOperator, readLaunch } from "./web3";

const defaultLog = pino({ level: process.env.LOG_LEVEL || "info" });

export type JobProcessor = {
  process(job: any): Promise<void>;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateJobPayload(job: any, updates: Record<string, any>) {
  const merged = { ...job.payload, ...updates };
  const jsonPayload = JSON.parse(JSON.stringify(merged));
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await prisma.job.update({
        where: { id: job.id },
        data: { payload: jsonPayload }
      });
      job.payload = merged;
      return;
    } catch (err) {
      lastErr = err;
      await sleep(200 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function waitForReceipt(provider: Awaited<ReturnType<typeof initContracts>>["provider"], txHash: string) {
  const receipt = await provider.waitForTransaction(txHash);
  if (!receipt) throw new Error("tx_not_found");
  if (receipt.status !== 1) throw new Error("tx_failed");
  return receipt;
}

function sizeToIndex(size: string): number {
  if (size === "TEST") return 0;
  if (size === "S") return 1;
  return 2;
}

async function handleCOIN(log: Logger, web3: Awaited<ReturnType<typeof initContracts>>, job: any) {
  const { launchId, name, symbol, metadataUri, creator, size } = job.payload;
  if (!launchId) throw new Error("launch_id_missing");

  const launch = await prisma.launch.findUnique({
    where: { id: launchId },
    select: {
      status: true,
      tokenLower: true,
      onchainId: true
    }
  });
  if (!launch) throw new Error("launch_not_found");

  if (launch.status === "active" && launch.tokenLower && launch.onchainId) {
    log.info({ launchId, token: launch.tokenLower }, "Skipping handleCOIN - already active");
    return;
  }

  if (launch.status !== "processing") {
    await prisma.launch.update({
      where: { id: launchId },
      data: { status: "processing" }
    });
  }

  const iface = web3.vm.interface;
  let txHash: string | undefined = job.payload.txHash;
  let receipt: any;

  // idempotency check: if the txHash is provided, we wait for the receipt. avoid calling the contract again.
  if (txHash) {
    receipt = await waitForReceipt(web3.provider, txHash);
  } else {
    const vm = pickOperator(web3.vm, web3.operators);
    const tx = await vm.coin(name, symbol, metadataUri, creator, sizeToIndex(size));
    txHash = tx.hash;
    await updateJobPayload(job, { txHash });
    receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error("coin_tx_failed");

    // TODO: verify the contract on basescan
  }

  const parsed = receipt.logs
    .map((logItem: any) => {
      try {
        return iface.parseLog(logItem);
      } catch {
        return null;
      }
    })
    .find((entry: any) => entry && entry.name === "Coined");
  if (!parsed) throw new Error("Coined event not found");

  const onchainId = Number(parsed.args.id);
  const token = (parsed.args.token as string).toLowerCase();
  const launchData = await readLaunch(web3.vm, onchainId);

  await prisma.launch.update({
    where: { id: launchId },
    data: {
      status: "active",
      tokenLower: token,
      onchainId,
      txHash,
      contractUri: metadataUri,
      graduated: launchData.graduated,
      targetUsdc6d: launchData.targetUSDC,
      usdcAccounted6d: launchData.usdcAccounted
    }
  });

  log.info({ launchId, onchainId, token }, "COIN completed");
}

async function handlePURCHASE(log: Logger, web3: Awaited<ReturnType<typeof initContracts>>, job: any) {
  const { purchaseId, tokenLower, recipient } = job.payload;
  if (!purchaseId) throw new Error("purchase_id_missing");

  const purchase = await prisma.purchase.findUnique({
    where: { id: purchaseId },
    select: {
      payer: true,
      recipient: true,
      status: true,
      onchainId: true,
      usdcAmount6d: true,
      txHash: true,
      operator: true
    }
  });
  if (!purchase) throw new Error("purchase_not_found");

  if (purchase.status === "completed" || purchase.status === "refunded") {
    log.info({ tokenLower, purchaseId, status: purchase.status }, "Skipping handlePURCHASE - already finalized");
    return;
  }

  if (purchase.status === "to_refund") {
    log.info({ tokenLower, purchaseId }, "Skipping handlePURCHASE - marked for refund");
    return;
  }

  if (!purchase.onchainId) throw new Error("purchase_missing_onchain_id");
  const onchainId = Number(purchase.onchainId);

  if (purchase.status !== "processing") {
    await prisma.purchase.update({
      where: { id: purchaseId },
      data: { status: "processing" }
    });
  }

  let txHash: string | undefined = job.payload.txHash || purchase.txHash || undefined;
  let operatorAddr: string | undefined = job.payload.operator || purchase.operator || undefined;

  const usdcAmountBigInt = purchase.usdcAmount6d;
  const usdcAmountString = purchase.usdcAmount6d.toString();

  if (!txHash) {
    const launch = await prisma.launch.findUnique({
      where: { tokenLower },
      select: { onchainId: true }
    });
    if (!launch || !launch.onchainId) throw new Error("unknown_token");

    const L = await readLaunch(web3.vm, onchainId);

    if (L.graduated) {
      log.warn({ tokenLower, recipient, purchaseId }, "Purchase failed: launch already graduated, enqueueing refund");
      await prisma.$transaction([
        prisma.purchase.update({
          where: { id: purchaseId },
          data: { status: "to_refund" }
        }),
        prisma.launch.update({
          where: { tokenLower },
          data: { usdcQueued6d: { decrement: usdcAmountBigInt } }
        })
      ]);
      await enqueueJob("REFUND", `refund:${purchaseId}`, {
        purchaseId,
        tokenLower,
        payer: purchase.payer,
        usdcAmount6d: usdcAmountString
      }, undefined, 3);
      return;
    }

    const FAIR_CAP = 900_000_000n * 10n ** 18n;
    const remainingAllocation = FAIR_CAP - L.allocated;
    const TOKENS_PER_USDC_6D =
      L.size === 0 ? 200_000_000n * 10n ** 12n : L.size === 1 ? 200_000n * 10n ** 12n : 20_000n * 10n ** 12n;
    const tokensRequested = usdcAmountBigInt * TOKENS_PER_USDC_6D;

    if (tokensRequested > remainingAllocation) {
      log.warn({ tokenLower, recipient, purchaseId, remainingAllocation: remainingAllocation.toString() }, "Purchase failed: insufficient allocation, enqueueing refund");
      await prisma.$transaction([
        prisma.purchase.update({
          where: { id: purchaseId },
          data: { status: "to_refund" }
        }),
        prisma.launch.update({
          where: { tokenLower },
          data: { usdcQueued6d: { decrement: usdcAmountBigInt } }
        })
      ]);
      await enqueueJob("REFUND", `refund:${purchaseId}`, {
        purchaseId,
        tokenLower,
        payer: purchase.payer,
        usdcAmount6d: usdcAmountString
      }, undefined, 3);
      return;
    }

    const vm = pickOperator(web3.vm, web3.operators);
    const tx = await vm.handlePurchase(onchainId, purchase.recipient, usdcAmountString);
    txHash = tx.hash;
    operatorAddr = vm.runner?.address ?? "operator";
    await updateJobPayload(job, { txHash, operator: operatorAddr });
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error("purchase_tx_failed");
  } else {
    await waitForReceipt(web3.provider, txHash);
  }

  const updatedL = await readLaunch(web3.vm, onchainId);

  await prisma.$transaction([
    prisma.purchase.update({
      where: { id: purchaseId },
      data: {
        status: "completed",
        ...(operatorAddr ? { operator: operatorAddr } : {}),
        ...(txHash ? { txHash } : {})
      }
    }),
    prisma.launch.update({
      where: { tokenLower },
      data: {
        usdcQueued6d: { decrement: usdcAmountBigInt },
        usdcAccounted6d: updatedL.usdcAccounted,
        graduated: updatedL.graduated
      }
    })
  ]);

  if (!updatedL.graduated && updatedL.usdcAccounted >= updatedL.targetUSDC) {
    await enqueueJob("GRADUATE", `grad:${tokenLower}`, { tokenLower }, undefined, 3);
    log.info({ tokenLower, onchainId }, "Auto-enqueued GRADUATE job - target USDC reached");
  }
}

async function handleGRADUATE(log: Logger, web3: Awaited<ReturnType<typeof initContracts>>, job: any) {
  const { tokenLower } = job.payload;
  const launch = await prisma.launch.findUnique({
    where: { tokenLower },
    select: { onchainId: true, status: true, graduated: true }
  });
  if (!launch || !launch.onchainId) throw new Error("unknown_token");
  const onchainId = Number(launch.onchainId);

  if (launch.graduated) {
    if (launch.status !== "active") {
      await prisma.launch.update({
        where: { tokenLower },
        data: { status: "active", graduated: true }
      });
    }
    log.info({ tokenLower, onchainId }, "GRADUATE already completed");
    return;
  }

  if (launch.status !== "processing") {
    await prisma.launch.update({
      where: { tokenLower },
      data: { status: "processing" }
    });
  }

  const txHash: string | undefined = job.payload.txHash;

  if (txHash) {
    await waitForReceipt(web3.provider, txHash);
  } else {
    const vm = pickOperator(web3.vm, web3.operators);
    const tx = await vm.graduate(onchainId);
    await updateJobPayload(job, { txHash: tx.hash });
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error("graduate_tx_failed");
  }

  const updatedL = await readLaunch(web3.vm, onchainId);

  await prisma.launch.update({
    where: { tokenLower },
    data: {
      status: "active",
      graduated: updatedL.graduated,
      usdcAccounted6d: updatedL.usdcAccounted
    }
  });

  log.info({ tokenLower, onchainId }, "GRADUATE done");
}

async function handleREFUND(log: Logger, web3: Awaited<ReturnType<typeof initContracts>>, job: any) {
  const { purchaseId, tokenLower } = job.payload;
  if (!purchaseId) throw new Error("refund_purchase_id_missing");

  const purchase = await prisma.purchase.findUnique({
    where: { id: purchaseId },
    select: {
      status: true,
      payer: true,
      onchainId: true,
      usdcAmount6d: true,
      txHash: true
    }
  });
  if (!purchase) throw new Error("purchase_not_found");

  if (purchase.status === "refunded") {
    log.info({ purchaseId }, "Skipping refund - already refunded");
    return;
  }

  if (!purchase.onchainId) throw new Error("refund_missing_onchain_id");
  const onchainId = Number(purchase.onchainId);

  if (purchase.status !== "processing") {
    await prisma.purchase.update({
      where: { id: purchaseId },
      data: { status: "processing" }
    });
  }

  const usdcAmount = purchase.usdcAmount6d;
  let txHash: string | undefined = job.payload.txHash || purchase.txHash || undefined;

  if (!txHash) {
    const vm = pickOperator(web3.vm, web3.operators);
    const tx = await vm.refund(onchainId, purchase.payer);
    txHash = tx.hash;
    await updateJobPayload(job, { txHash });
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error("refund_tx_failed");
  } else {
    await waitForReceipt(web3.provider, txHash);
  }

  const updatedL = await readLaunch(web3.vm, onchainId);

  await prisma.$transaction([
    prisma.purchase.update({
      where: { id: purchaseId },
      data: {
        status: "refunded",
        ...(txHash ? { txHash } : {})
      }
    }),
    prisma.launch.update({
      where: { tokenLower },
      data: {
        usdcAccounted6d: updatedL.usdcAccounted
      }
    })
  ]);

  log.info({ purchaseId }, "REFUND done");
}

export async function buildJobProcessor(logger: Logger = defaultLog): Promise<JobProcessor> {
  const web3 = await initContracts();

  return {
    async process(job: any) {
      if (job.kind === "COIN") return handleCOIN(logger, web3, job);
      if (job.kind === "PURCHASE") return handlePURCHASE(logger, web3, job);
      if (job.kind === "GRADUATE") return handleGRADUATE(logger, web3, job);
      if (job.kind === "REFUND") return handleREFUND(logger, web3, job);
      logger.warn({ kind: job.kind }, "Unknown job kind");
    }
  };
}
