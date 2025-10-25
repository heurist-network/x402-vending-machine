import { prisma } from "./db";
import { claimJob, finishJob, enqueueJob } from "./queue";
import { initContracts, pickOperator, readLaunch } from "./web3";
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const WORKER_ID = `vm-worker-${process.pid}`;

const web3 = await initContracts();

async function handleCOIN(job: any) {
  const { name, symbol, initialURI, creator, size } = job.payload;
  const vm = pickOperator(web3.vm, web3.operators);
  const tx = await vm.coin(name, symbol, initialURI, creator, size === 'TEST' ? 0 : size === 'S' ? 1 : 2);
  const rcpt = await tx.wait();

  const parsed = rcpt.logs.map((l: any) => {
    try { return vm.interface.parseLog(l); } catch { return null; }
  }).find((x: any) => x && x.name === "Coined");
  if (!parsed) throw new Error("Coined event not found");

  const onchainId: number = Number(parsed.args.id);
  const token: string = (parsed.args.token as string).toLowerCase();
  const L = await readLaunch(web3.vm, onchainId);

  await prisma.launch.create({
    data: {
      tokenLower: token,
      onchainId: BigInt(onchainId),
      name,
      symbol,
      size,
      creator,
      contractUri: initialURI,
      createdAt: new Date(L.createdAt * 1000),
      graduated: L.graduated,
      allocatedTokens: L.allocated.toString(),
      targetUsdc6d: L.targetUSDC,
      usdcAccounted6d: L.usdcAccounted
    }
  });

  await prisma.coinRequest.update({
    where: { id: job.id.toString() },
    data: {
      status: "done",
      onchainId: BigInt(onchainId),
      tokenLower: token,
      txHash: tx.hash
    }
  });

  log.info({ onchainId, token }, "COIN done");
}

async function handlePURCHASE(job: any) {
  const { tokenLower, payer, usdcAmount6d, x402Nonce } = job.payload;
  const launch = await prisma.launch.findUnique({
    where: { tokenLower },
    select: { onchainId: true }
  });
  if (!launch || !launch.onchainId) throw new Error("unknown_token");
  const onchainId = Number(launch.onchainId);

  const L = await readLaunch(web3.vm, onchainId);

  if (L.graduated) {
    log.warn({ tokenLower, payer, x402Nonce }, "Purchase failed: launch already graduated, enqueueing refund");
    await prisma.purchase.updateMany({
      where: { tokenLower, x402Nonce },
      data: { status: "to_refund" }
    });
    await enqueueJob("REFUND", `refund:${tokenLower}:${payer}`, { tokenLower, buyer: payer }, undefined, 3);
    return;
  }

  const FAIR_CAP = 900_000_000n * 10n ** 18n;
  const remainingAllocation = FAIR_CAP - L.allocated;
  const usdcAmountBigInt = BigInt(usdcAmount6d);
  const TOKENS_PER_USDC_6D = L.size === 0 ? 200_000_000n * 10n ** 12n : L.size === 1 ? 200_000n * 10n ** 12n : 20_000n * 10n ** 12n;
  const tokensRequested = usdcAmountBigInt * TOKENS_PER_USDC_6D;

  if (tokensRequested > remainingAllocation) {
    log.warn({ tokenLower, payer, x402Nonce, remainingAllocation: remainingAllocation.toString() }, "Purchase failed: insufficient allocation, enqueueing refund");
    await prisma.purchase.updateMany({
      where: { tokenLower, x402Nonce },
      data: { status: "to_refund" }
    });
    await enqueueJob("REFUND", `refund:${tokenLower}:${payer}`, { tokenLower, buyer: payer }, undefined, 3);
    return;
  }

  const vm = pickOperator(web3.vm, web3.operators);
  const tx = await vm.handlePurchase(onchainId, payer, usdcAmount6d);
  await tx.wait();

  await prisma.purchase.updateMany({
    where: { tokenLower, x402Nonce },
    data: {
      status: "handled",
      operator: vm.runner?.address ?? "operator"
    }
  });

  const updatedL = await readLaunch(web3.vm, onchainId);
  await prisma.launch.update({
    where: { tokenLower },
    data: {
      allocatedTokens: updatedL.allocated.toString(),
      usdcAccounted6d: updatedL.usdcAccounted,
      graduated: updatedL.graduated
    }
  });

  if (!updatedL.graduated && updatedL.usdcAccounted >= updatedL.targetUSDC) {
    await enqueueJob("GRADUATE", `grad:${tokenLower}`, { tokenLower }, undefined, 10);
    log.info({ tokenLower, onchainId }, "Auto-enqueued GRADUATE job - target USDC reached");
  }
}

async function handleGRADUATE(job: any) {
  const { tokenLower } = job.payload;
  const launch = await prisma.launch.findUnique({
    where: { tokenLower },
    select: { onchainId: true }
  });
  if (!launch || !launch.onchainId) throw new Error("unknown_token");
  const onchainId = Number(launch.onchainId);

  const vm = pickOperator(web3.vm, web3.operators);
  const tx = await vm.graduate(onchainId);
  await tx.wait();

  await prisma.launch.update({
    where: { tokenLower },
    data: { graduated: true }
  });
}

async function handleREFUND(job: any) {
  const { tokenLower, buyer } = job.payload;
  const launch = await prisma.launch.findUnique({
    where: { tokenLower },
    select: { onchainId: true }
  });
  if (!launch || !launch.onchainId) throw new Error("unknown_token");
  const onchainId = Number(launch.onchainId);

  const vm = pickOperator(web3.vm, web3.operators);
  const tx = await vm.refund(onchainId, buyer);
  await tx.wait();

  await prisma.purchase.updateMany({
    where: { tokenLower, payer: buyer },
    data: { status: "refunded" }
  });
}

async function loop() {
  const job = await claimJob(WORKER_ID);
  if (!job) return;
  try {
    if (job.kind === "COIN") await handleCOIN(job);
    else if (job.kind === "PURCHASE") await handlePURCHASE(job);
    else if (job.kind === "GRADUATE") await handleGRADUATE(job);
    else if (job.kind === "REFUND") await handleREFUND(job);
    await finishJob(job.id, true);
  } catch (e) {
    console.error(e);
    await finishJob(job.id, false, e);
  }
}

setInterval(loop, 500);
