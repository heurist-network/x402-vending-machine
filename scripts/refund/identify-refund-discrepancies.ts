import { ethers } from "ethers";
import { prisma } from "../../src/db";
import { log, parseArgs, argString } from "../script-utils";
import { writeFile } from "fs/promises";
import { join } from "path";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEFAULT_START_BLOCK = 37434263;
const BLOCK_RANGE = 500; // Query in chunks to avoid RPC limits

// Event signatures
const AUTHORIZATION_USED_SIG = "AuthorizationUsed(address,bytes32)";
const PURCHASE_RECORDED_SIG = "PurchaseRecorded(uint256,address,uint256,uint256)";

type AuthorizationEvent = {
  authorizer: string;
  nonce: string;
  transactionHash: string;
  blockNumber: number;
};

type PurchaseRecordedEvent = {
  id: bigint;
  buyer: string;
  usdcAmount: bigint;
  tokensAllocated: bigint;
  transactionHash: string;
  blockNumber: number;
};

type RefundCandidate = {
  purchaseId: string;
  x402Nonce: string;
  payer: string;
  recipient: string;
  usdcAmount6d: string;
  tokenLower: string;
  onchainId: string;
  status: string;
  paymentTxHash: string | null;
  paymentBlockNumber: number | null;
  purchaseTxHash: string | null;
  refundTxHash: string | null;
  existingRefundJob: string | null;
  reason: string;
  createdAt: Date;
};

type AnalysisSummary = {
  totalCandidates: number;
  totalUsdcAmount: bigint;
  startBlock: number;
  endBlock: number;
  byReason: Record<string, number>;
  byStatus: Record<string, number>;
  usdcByStatus: Record<string, bigint>;
};

async function queryAuthorizationUsedEvents(
  provider: ethers.JsonRpcProvider,
  fromBlock: number,
  toBlock: number | string,
  nonces: string[]
): Promise<Map<string, AuthorizationEvent>> {
  log.info({ fromBlock, toBlock, nonceCount: nonces.length }, "Querying AuthorizationUsed events...");

  const topic0 = ethers.id(AUTHORIZATION_USED_SIG);
  const authEvents = new Map<string, AuthorizationEvent>();
  const nonceSet = new Set(nonces.map(n => n.toLowerCase()));

  // Query all AuthorizationUsed events in block range, then filter
  // This is more efficient than querying each nonce individually

  for (let start = fromBlock; start <= (typeof toBlock === "number" ? toBlock : fromBlock); start += BLOCK_RANGE) {
    const end = Math.min(start + BLOCK_RANGE - 1, typeof toBlock === "number" ? toBlock : start + BLOCK_RANGE - 1);

    log.info({ progress: `Block ${start} to ${end}` }, "Querying AuthorizationUsed events...");

    const filter = {
      address: USDC_BASE,
      topics: [topic0],
      fromBlock: start,
      toBlock: end,
    };

    try {
      const logs = await provider.getLogs(filter);

      for (const logItem of logs) {
        const nonce = logItem.topics[2].toLowerCase(); // nonce is topic[2]
        const authorizer = ethers.getAddress("0x" + logItem.topics[1].slice(26)); // authorizer is topic[1]

        // Only include if nonce is in our list
        if (!nonceSet.has(nonce)) continue;

        authEvents.set(nonce, {
          authorizer,
          nonce,
          transactionHash: logItem.transactionHash,
          blockNumber: logItem.blockNumber,
        });
      }

      log.info({ blockRange: `${start}-${end}`, eventsFound: logs.length, matched: authEvents.size }, "Batch completed");
    } catch (err) {
      log.error({ err, blockRange: `${start}-${end}` }, "Failed to query AuthorizationUsed batch");
      throw err;
    }

    // If we're using "latest", break after first iteration
    if (typeof toBlock === "string") break;
  }

  log.info({ count: authEvents.size }, "AuthorizationUsed events retrieved");
  return authEvents;
}

async function queryPurchaseRecordedEvents(
  provider: ethers.JsonRpcProvider,
  vendingMachineAddress: string,
  fromBlock: number,
  toBlock: number | string,
  onchainIds: bigint[]
): Promise<Map<string, PurchaseRecordedEvent[]>> {
  log.info({ fromBlock, toBlock, onchainIdCount: onchainIds.length }, "Querying PurchaseRecorded events...");

  const topic0 = ethers.id(PURCHASE_RECORDED_SIG);
  const purchaseEvents = new Map<string, PurchaseRecordedEvent[]>();

  const iface = new ethers.Interface([
    "event PurchaseRecorded(uint256 indexed id, address buyer, uint256 usdcAmount, uint256 tokensAllocated)"
  ]);

  for (let start = fromBlock; start <= (typeof toBlock === "number" ? toBlock : fromBlock); start += BLOCK_RANGE) {
    const end = Math.min(start + BLOCK_RANGE - 1, typeof toBlock === "number" ? toBlock : start + BLOCK_RANGE - 1);

    log.info({ progress: `Block ${start} to ${end}` }, "Querying PurchaseRecorded events...");

    const filter = {
      address: vendingMachineAddress,
      topics: [topic0],
      fromBlock: start,
      toBlock: end,
    };

    try {
      const logs = await provider.getLogs(filter);

      for (const logItem of logs) {
        const parsed = iface.parseLog({
          topics: logItem.topics as string[],
          data: logItem.data,
        });

        if (!parsed) continue;

        const id = parsed.args.id;
        const buyer = parsed.args.buyer;
        const usdcAmount = parsed.args.usdcAmount;
        const tokensAllocated = parsed.args.tokensAllocated;

        // Create a key using buyer address (lowercase) to match with purchase records
        const key = buyer.toLowerCase();

        const event: PurchaseRecordedEvent = {
          id,
          buyer: key,
          usdcAmount,
          tokensAllocated,
          transactionHash: logItem.transactionHash,
          blockNumber: logItem.blockNumber,
        };

        if (!purchaseEvents.has(key)) {
          purchaseEvents.set(key, []);
        }
        purchaseEvents.get(key)!.push(event);
      }

      log.info({ blockRange: `${start}-${end}`, eventsFound: logs.length }, "Batch completed");
    } catch (err) {
      log.error({ err, blockRange: `${start}-${end}` }, "Failed to query PurchaseRecorded batch");
      throw err;
    }

    // If we're using "latest", break after first iteration
    if (typeof toBlock === "string") break;
  }

  log.info({ count: purchaseEvents.size }, "PurchaseRecorded buyer addresses with events retrieved");
  return purchaseEvents;
}

async function identifyDiscrepancies(
  startBlock: number,
  endBlock?: number
): Promise<{ candidates: RefundCandidate[]; summary: AnalysisSummary }> {
  const rpcUrl = process.env.RPC_URL_BASE;
  const vendingMachineAddress = process.env.VENDING_MACHINE_ADDRESS;

  if (!rpcUrl) throw new Error("RPC_URL_BASE not set in environment");
  if (!vendingMachineAddress) throw new Error("VENDING_MACHINE_ADDRESS not set in environment");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const currentBlock = endBlock || await provider.getBlockNumber();

  log.info({ currentBlock, startBlock }, "Fetching purchases from database...");

  // Get all purchases from DB
  const purchases = await prisma.purchase.findMany({
    orderBy: { createdAt: "asc" },
  });

  log.info({ count: purchases.length }, "Purchases retrieved from database");

  // Check how many purchases already have payment tracking info
  const withPaymentInfo = purchases.filter(p => p.paymentTxHash && p.paymentBlockNumber);
  const withoutPaymentInfo = purchases.filter(p => !p.paymentTxHash || !p.paymentBlockNumber);

  log.info({
    withPaymentInfo: withPaymentInfo.length,
    withoutPaymentInfo: withoutPaymentInfo.length
  }, "Payment tracking info status");

  // Get all REFUND jobs to check what's already queued or processed
  const refundJobs = await prisma.job.findMany({
    where: {
      kind: "REFUND"
    },
    select: {
      uniqueKey: true,
      status: true,
      payload: true
    }
  });

  // Build a map of purchase IDs that already have refund jobs
  const existingRefundsByPurchaseId = new Map<string, { status: string; uniqueKey: string }>();
  for (const job of refundJobs) {
    const payload = job.payload as any;
    if (payload?.purchaseId) {
      existingRefundsByPurchaseId.set(payload.purchaseId, {
        status: job.status,
        uniqueKey: job.uniqueKey || ""
      });
    }
  }

  log.info({ refundJobCount: refundJobs.length }, "Existing REFUND jobs retrieved");

  if (purchases.length === 0) {
    log.warn("No purchases found in database");
    return [];
  }

  // Extract nonces and onchain IDs
  const onchainIds = [...new Set(purchases.map(p => p.onchainId))].filter(Boolean) as bigint[];

  // Build auth events map from existing DB data first
  const authEvents = new Map<string, AuthorizationEvent>();

  for (const purchase of purchases) {
    if (purchase.paymentTxHash && purchase.paymentBlockNumber) {
      authEvents.set(purchase.x402Nonce.toLowerCase(), {
        authorizer: purchase.payer,
        nonce: purchase.x402Nonce,
        transactionHash: purchase.paymentTxHash,
        blockNumber: Number(purchase.paymentBlockNumber),
      });
    }
  }

  log.info({ count: authEvents.size }, "Auth events loaded from database");

  // Query blockchain only for nonces not in DB
  const noncesToQuery = purchases
    .filter(p => !p.paymentTxHash || !p.paymentBlockNumber)
    .map(p => p.x402Nonce);

  if (noncesToQuery.length > 0) {
    log.info({ count: noncesToQuery.length }, "Querying blockchain for missing payment info");

    const queriedAuthEvents = await queryAuthorizationUsedEvents(
      provider,
      startBlock,
      currentBlock,
      noncesToQuery
    );

    // Merge with existing
    for (const [nonce, event] of queriedAuthEvents) {
      authEvents.set(nonce, event);
    }
  }

  const purchaseEvents = await queryPurchaseRecordedEvents(
    provider,
    vendingMachineAddress,
    startBlock,
    currentBlock,
    onchainIds
  );

  log.info("Analyzing discrepancies...");

  const refundCandidates: RefundCandidate[] = [];

  for (const purchase of purchases) {
    const nonce = purchase.x402Nonce.toLowerCase();
    const recipient = purchase.recipient.toLowerCase();

    // Check if payment was made (AuthorizationUsed event exists)
    const authEvent = authEvents.get(nonce);
    const paymentMade = !!authEvent;

    // Check if tokens were delivered (PurchaseRecorded event exists)
    let tokensDelivered = false;
    let purchaseTxHash: string | null = null;

    if (purchase.txHash) {
      // Check if this txHash has a PurchaseRecorded event
      // Match by recipient (buyer in the event) and transaction hash
      const buyerEvents = purchaseEvents.get(recipient) || [];
      const matchingEvent = buyerEvents.find(e =>
        e.transactionHash.toLowerCase() === purchase.txHash!.toLowerCase() &&
        e.usdcAmount === purchase.usdcAmount6d
      );
      tokensDelivered = !!matchingEvent;
      if (matchingEvent) {
        purchaseTxHash = matchingEvent.transactionHash;
      }
    }

    // Check if this purchase already has a refund (IDEMPOTENCY)
    const existingRefundJob = existingRefundsByPurchaseId.get(purchase.id);
    const hasRefundTxHash = !!purchase.refundTxHash;
    const isAlreadyRefunded = purchase.status === "refunded";
    const hasActiveRefundJob = existingRefundJob && existingRefundJob.status !== "dead";

    // Skip if already refunded or has active refund processing
    if (isAlreadyRefunded && hasRefundTxHash) {
      log.debug({ purchaseId: purchase.id }, "Skipping - already refunded");
      continue;
    }

    // Determine if this is a refund candidate
    let reason = "";
    let isRefundCandidate = false;

    if (paymentMade && !tokensDelivered) {
      // Payment made but no tokens delivered - this is the main discrepancy
      if (purchase.status === "completed") {
        // DB says completed but no on-chain delivery event - this is a critical issue
        reason = "DB shows completed but no PurchaseRecorded event found";
        isRefundCandidate = true;
      } else if (purchase.status === "queued" || purchase.status === "processing") {
        reason = "Payment received but purchase still pending";
        isRefundCandidate = true;
      } else if (purchase.status === "to_refund") {
        if (hasActiveRefundJob) {
          reason = "Already has active REFUND job - no action needed";
          isRefundCandidate = true; // Include for tracking but mark as handled
        } else {
          reason = "Marked for refund but no active job - may need re-queue";
          isRefundCandidate = true;
        }
      } else if (purchase.status === "refunded") {
        if (!hasRefundTxHash) {
          reason = "Status shows refunded but no refundTxHash - verify";
          isRefundCandidate = true;
        }
        // If has refundTxHash, already skipped above
      }
    } else if (!paymentMade && purchase.status === "completed") {
      // Completed purchases without payment event found = likely block range issue
      // These are NOT refund candidates - just missing payment tracking data
      // Skip these - they should run backfill script instead
      log.info({
        purchaseId: purchase.id,
        txHash: purchase.txHash
      }, "Completed purchase missing payment event - likely needs backfill, not refund");
      continue;
    } else if (paymentMade && tokensDelivered && purchase.status !== "completed") {
      reason = "Tokens delivered but DB status is not completed (DB sync issue)";
      // This is a DB inconsistency, not a refund case - log but don't mark for refund
      log.warn({
        purchaseId: purchase.id,
        status: purchase.status,
        txHash: purchase.txHash
      }, "DB inconsistency detected - purchase delivered but status not updated");
    } else if (!paymentMade && !tokensDelivered && purchase.status === "queued") {
      reason = "No payment and no delivery - possibly never processed";
      isRefundCandidate = true;
    }

    if (isRefundCandidate) {
      refundCandidates.push({
        purchaseId: purchase.id,
        x402Nonce: purchase.x402Nonce,
        payer: purchase.payer,
        recipient: purchase.recipient,
        usdcAmount6d: purchase.usdcAmount6d.toString(),
        tokenLower: purchase.tokenLower,
        onchainId: purchase.onchainId.toString(),
        status: purchase.status,
        paymentTxHash: authEvent?.transactionHash || null,
        paymentBlockNumber: authEvent?.blockNumber || null,
        purchaseTxHash,
        refundTxHash: purchase.refundTxHash,
        existingRefundJob: existingRefundJob ? `${existingRefundJob.status}:${existingRefundJob.uniqueKey}` : null,
        reason,
        createdAt: purchase.createdAt,
      });
    }
  }

  log.info({ count: refundCandidates.length }, "Refund candidates identified");

  // Calculate summary
  let totalUsdcAmount = 0n;
  const byReason: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const usdcByStatus: Record<string, bigint> = {};

  for (const candidate of refundCandidates) {
    const amount = BigInt(candidate.usdcAmount6d);
    totalUsdcAmount += amount;
    byReason[candidate.reason] = (byReason[candidate.reason] || 0) + 1;
    byStatus[candidate.status] = (byStatus[candidate.status] || 0) + 1;
    usdcByStatus[candidate.status] = (usdcByStatus[candidate.status] || 0n) + amount;
  }

  const summary: AnalysisSummary = {
    totalCandidates: refundCandidates.length,
    totalUsdcAmount,
    startBlock,
    endBlock: currentBlock,
    byReason,
    byStatus,
    usdcByStatus,
  };

  return { candidates: refundCandidates, summary };
}

function generateCSV(candidates: RefundCandidate[]): string {
  const headers = [
    "purchase_id",
    "x402_nonce",
    "payer",
    "recipient",
    "usdc_amount_6d",
    "usdc_amount_decimal",
    "token_lower",
    "onchain_id",
    "current_status",
    "payment_tx_hash",
    "payment_block_number",
    "purchase_tx_hash",
    "refund_tx_hash",
    "existing_refund_job",
    "reason",
    "created_at",
  ].join(",");

  const rows = candidates.map(c => {
    const usdcDecimal = (parseFloat(c.usdcAmount6d) / 1e6).toFixed(2);
    return [
      c.purchaseId,
      c.x402Nonce,
      c.payer,
      c.recipient,
      c.usdcAmount6d,
      usdcDecimal,
      c.tokenLower,
      c.onchainId,
      c.status,
      c.paymentTxHash || "",
      c.paymentBlockNumber?.toString() || "",
      c.purchaseTxHash || "",
      c.refundTxHash || "",
      c.existingRefundJob || "",
      `"${c.reason}"`,
      c.createdAt.toISOString(),
    ].join(",");
  });

  return [headers, ...rows].join("\n");
}

async function main() {
  const args = parseArgs();
  const outputPath = argString(args, "output") || "refund-discrepancies.csv";
  const startBlockArg = argString(args, "start-block");
  const endBlockArg = argString(args, "end-block");

  const startBlock = startBlockArg ? parseInt(startBlockArg, 10) : DEFAULT_START_BLOCK;
  const endBlock = endBlockArg ? parseInt(endBlockArg, 10) : undefined;

  if (isNaN(startBlock)) {
    log.error("Invalid start-block argument");
    process.exit(1);
  }

  if (endBlockArg && isNaN(endBlock!)) {
    log.error("Invalid end-block argument");
    process.exit(1);
  }

  log.info({ startBlock, endBlock: endBlock || "latest", outputPath }, "Starting refund discrepancy analysis...");

  try {
    const { candidates, summary } = await identifyDiscrepancies(startBlock, endBlock);

    // Print summary
    console.log("\n=== REFUND DISCREPANCY ANALYSIS SUMMARY ===\n");
    console.log(`Block range: ${summary.startBlock} to ${summary.endBlock}`);
    console.log(`Total refund candidates: ${summary.totalCandidates}`);
    console.log(`Total USDC amount: $${(parseFloat(summary.totalUsdcAmount.toString()) / 1e6).toFixed(2)}\n`);

    if (summary.totalCandidates === 0) {
      log.info("No refund discrepancies found!");
      console.log("✅ No discrepancies detected. All purchases are properly tracked.");
      return;
    }

    console.log("By status (count and $ amount):");
    for (const [status, count] of Object.entries(summary.byStatus)) {
      const usdcAmount = summary.usdcByStatus[status] || 0n;
      const usdcDecimal = (parseFloat(usdcAmount.toString()) / 1e6).toFixed(2);
      console.log(`  - ${status}: ${count} purchases ($${usdcDecimal})`);
    }

    console.log("\nBy reason:");
    for (const [reason, count] of Object.entries(summary.byReason)) {
      console.log(`  - ${reason}: ${count}`);
    }

    // Highlight key accounting numbers
    console.log("\n💰 ACCOUNTING VERIFICATION:");
    const toRefundAmount = summary.usdcByStatus["to_refund"] || 0n;
    const refundedAmount = summary.usdcByStatus["refunded"] || 0n;
    const queuedAmount = summary.usdcByStatus["queued"] || 0n;
    const processingAmount = summary.usdcByStatus["processing"] || 0n;

    console.log(`  - Marked to_refund: $${(parseFloat(toRefundAmount.toString()) / 1e6).toFixed(2)}`);
    console.log(`  - Already refunded: $${(parseFloat(refundedAmount.toString()) / 1e6).toFixed(2)}`);
    console.log(`  - Pending (queued): $${(parseFloat(queuedAmount.toString()) / 1e6).toFixed(2)}`);
    console.log(`  - Pending (processing): $${(parseFloat(processingAmount.toString()) / 1e6).toFixed(2)}`);

    // Calculate what actually needs action vs already being handled
    const alreadyProcessing = candidates.filter(c =>
      c.existingRefundJob && !c.existingRefundJob.startsWith("dead:")
    );
    const needsAction = candidates.filter(c =>
      !c.existingRefundJob || c.existingRefundJob.startsWith("dead:")
    );

    let alreadyProcessingAmount = 0n;
    let needsActionAmount = 0n;

    for (const c of alreadyProcessing) {
      alreadyProcessingAmount += BigInt(c.usdcAmount6d);
    }
    for (const c of needsAction) {
      needsActionAmount += BigInt(c.usdcAmount6d);
    }

    console.log("\n🎯 ACTION REQUIRED:");
    console.log(`  - Already processing (has active job): ${alreadyProcessing.length} purchases ($${(parseFloat(alreadyProcessingAmount.toString()) / 1e6).toFixed(2)})`);
    console.log(`  - Needs action (no active job): ${needsAction.length} purchases ($${(parseFloat(needsActionAmount.toString()) / 1e6).toFixed(2)})`);

    // Generate CSV
    const csv = generateCSV(candidates);

    // Write to file
    const fullPath = join(process.cwd(), outputPath);
    await writeFile(fullPath, csv, "utf-8");

    log.info({ path: fullPath, count: candidates.length }, "Refund discrepancies CSV written");

    console.log(`\n📄 CSV written to: ${fullPath}`);
    console.log("\nNext steps:");
    console.log("1. Review the CSV file to verify the refund candidates");
    console.log("2. Check the 'existing_refund_job' column - if empty, refund needs to be queued");
    console.log("3. For legitimate refunds without active jobs:");
    console.log("   - Update purchase status to 'to_refund'");
    console.log("   - Enqueue REFUND jobs");
    console.log("4. For purchases with 'Already has active REFUND job', just monitor progress");

  } catch (err) {
    log.error({ err }, "Failed to identify refund discrepancies");
    throw err;
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
