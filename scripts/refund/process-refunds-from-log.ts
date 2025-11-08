import { ethers } from "ethers";
import { readFile } from "fs/promises";
import { log, parseArgs, argString } from "../script-utils";

/**
 * Process refunds by parsing a log file containing dry-run refund information
 *
 * This script:
 * 1. Parses a log file containing "[DRY RUN] Would refund:" entries
 * 2. Extracts payer addresses and USDC amounts
 * 3. Calls adminRefund on the VendingMachine contract for each entry
 *
 * Usage:
 *   bun run scripts/refund/process-refunds-from-log.ts --log=gov-refund.log --dry-run true
 *   bun run scripts/refund/process-refunds-from-log.ts --log=gov-refund.log --max 10
 *
 * Log format expected:
 *   [DRY RUN] Would refund:
 *     Payer: 0x...
 *     Amount: $20.00 (20000000 USDC 6d)
 *     Token: 0x...
 */

const VM_ABI = [
  "function adminRefund(address to, uint256 usdcAmount) external"
];

const GAS_LIMIT_REFUND = 200_000n;

type RefundEntry = {
  payer: string;
  usdcAmount6d: string;
  token: string;
  amountUsd: string;
};

let currentNonce = 0;

// Get contract setup
const rpcUrl = process.env.RPC_URL_BASE;
const vmAddress = process.env.VENDING_MACHINE_ADDRESS;
const adminKey = process.env.ADMIN_PRIVATE_KEY;

if (!rpcUrl) throw new Error("RPC_URL_BASE not set");
if (!vmAddress) throw new Error("VENDING_MACHINE_ADDRESS not set");
if (!adminKey) throw new Error("ADMIN_PRIVATE_KEY not set");

const provider = new ethers.JsonRpcProvider(rpcUrl);
const adminWallet = new ethers.Wallet(adminKey, provider);
const vm = new ethers.Contract(vmAddress, VM_ABI, adminWallet);

/**
 * Parse log file and extract refund entries
 */
async function parseLogFile(logPath: string): Promise<RefundEntry[]> {
  const content = await readFile(logPath, "utf-8");
  const lines = content.split("\n");

  const entries: RefundEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Look for "[DRY RUN] Would refund:" marker
    if (line.includes("[DRY RUN] Would refund:")) {
      // Next 3 lines contain: Payer, Amount, Token
      if (i + 3 < lines.length) {
        const payerLine = lines[i + 1];
        const amountLine = lines[i + 2];
        const tokenLine = lines[i + 3];

        // Extract payer: "  Payer: 0x..."
        const payerMatch = payerLine.match(/Payer:\s+(0x[a-fA-F0-9]+)/);

        // Extract amount: "  Amount: $20.00 (20000000 USDC 6d)"
        const amountMatch = amountLine.match(/Amount:\s+\$([0-9.]+)\s+\(([0-9]+)\s+USDC 6d\)/);

        // Extract token: "  Token: 0x..."
        const tokenMatch = tokenLine.match(/Token:\s+(0x[a-fA-F0-9]+)/);

        if (payerMatch && amountMatch && tokenMatch) {
          entries.push({
            payer: payerMatch[1],
            amountUsd: amountMatch[1],
            usdcAmount6d: amountMatch[2],
            token: tokenMatch[1],
          });
        } else {
          log.warn({ lineNumber: i + 1 }, "Failed to parse refund entry");
        }
      }
    }
  }

  return entries;
}

/**
 * Execute refund on-chain
 */
async function executeRefund(entry: RefundEntry, index: number, total: number): Promise<void> {
  const { payer, usdcAmount6d, amountUsd } = entry;

  log.info({
    progress: `${index}/${total}`,
    payer,
    usdcAmount: `$${amountUsd}`
  }, "Processing refund");

  // Execute refund
  const tx = await vm.adminRefund(payer, usdcAmount6d, {
    gasLimit: GAS_LIMIT_REFUND,
    nonce: currentNonce
  });

  currentNonce++;

  const txHash = tx.hash;
  log.info({ payer, txHash }, "Refund transaction submitted");

  // Wait for confirmation
  log.info({ payer, txHash }, "Waiting for confirmation...");
  const receipt = await tx.wait();

  if (receipt.status !== 1) {
    throw new Error(`refund_tx_failed for payer ${payer} with tx hash ${txHash}`);
  }

  log.info({
    payer,
    txHash,
    blockNumber: receipt.blockNumber
  }, "REFUND completed successfully");
}

async function main() {
  const args = parseArgs();
  const logPath = argString(args, "log");
  const maxRefunds = parseInt(argString(args, "max") || "1000", 10);
  const dryRun = argString(args, "dry-run") === "true";

  if (!logPath) {
    console.error("Error: --log argument is required");
    console.log("\nUsage:");
    console.log("  bun run scripts/refund/process-refunds-from-log.ts --log=gov-refund.log --dry-run true");
    console.log("  bun run scripts/refund/process-refunds-from-log.ts --log=gov-refund.log --max 10");
    process.exit(1);
  }

  if (dryRun) {
    console.log("\n🔍 DRY RUN MODE - No blockchain transactions will be executed\n");
  }

  log.info({ logPath, maxRefunds, dryRun }, "Starting refund processor from log file");

  // Parse log file
  console.log(`\nParsing log file: ${logPath}\n`);
  const entries = await parseLogFile(logPath);

  log.info({ totalEntries: entries.length }, "Parsed refund entries from log");

  if (entries.length === 0) {
    console.log("⚠️  No refund entries found in log file");
    console.log("Expected format:");
    console.log("  [DRY RUN] Would refund:");
    console.log("    Payer: 0x...");
    console.log("    Amount: $20.00 (20000000 USDC 6d)");
    console.log("    Token: 0x...");
    return;
  }

  // Limit to max refunds
  const entriesToProcess = entries.slice(0, maxRefunds);

  // Group by token for summary
  const byToken: Record<string, { count: number; totalUsdc: bigint }> = {};
  for (const entry of entriesToProcess) {
    const token = entry.token.toLowerCase();
    if (!byToken[token]) {
      byToken[token] = { count: 0, totalUsdc: 0n };
    }
    byToken[token].count++;
    byToken[token].totalUsdc += BigInt(entry.usdcAmount6d);
  }

  console.log(`Found ${entries.length} refund entries in log file`);
  console.log(`Will process ${entriesToProcess.length} entries\n`);

  console.log("Breakdown by token:");
  for (const [token, stats] of Object.entries(byToken)) {
    const totalUsd = (Number(stats.totalUsdc) / 1e6).toFixed(2);
    console.log(`  ${token}: ${stats.count} refunds, $${totalUsd} total`);
  }
  console.log();

  if (dryRun) {
    console.log("=== DRY RUN - Sample Entries ===\n");
    for (let i = 0; i < Math.min(5, entriesToProcess.length); i++) {
      const entry = entriesToProcess[i];
      console.log(`${i + 1}. Payer: ${entry.payer}`);
      console.log(`   Amount: $${entry.amountUsd} (${entry.usdcAmount6d} USDC 6d)`);
      console.log(`   Token: ${entry.token}\n`);
    }

    if (entriesToProcess.length > 5) {
      console.log(`... and ${entriesToProcess.length - 5} more entries\n`);
    }

    console.log("Run without --dry-run true to execute refunds on-chain");
    return;
  }

  // Initialize nonce from admin wallet's current transaction count
  currentNonce = await provider.getTransactionCount(adminWallet.address);
  log.info({ currentNonce, adminAddress: adminWallet.address }, "Admin wallet nonce initialized");

  let succeeded = 0;
  let failed = 0;
  let totalUsdcRefunded = 0n;

  console.log("\n=== EXECUTING REFUNDS ===\n");

  for (let i = 0; i < entriesToProcess.length; i++) {
    const entry = entriesToProcess[i];

    try {
      await executeRefund(entry, i + 1, entriesToProcess.length);
      succeeded++;
      totalUsdcRefunded += BigInt(entry.usdcAmount6d);
    } catch (error: any) {
      failed++;
      log.error({
        err: error,
        payer: entry.payer,
        amount: entry.usdcAmount6d
      }, "Refund failed");

      // Continue with next refund even if one fails
      console.log(`❌ Failed to refund ${entry.payer}: ${error.message}\n`);
    }
  }

  const totalUsdcDecimal = (Number(totalUsdcRefunded) / 1e6).toFixed(2);

  console.log("\n=== REFUND PROCESSING SUMMARY ===\n");
  console.log(`Entries processed: ${entriesToProcess.length}`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total USDC refunded: $${totalUsdcDecimal}\n`);

  if (failed > 0) {
    console.log("⚠️  Some refunds failed - check logs for details");
  } else {
    console.log("✅ All refunds completed successfully");
  }
}

main()
  .catch((err) => {
    log.error({ err }, "Refund processor error");
    process.exit(1);
  });
