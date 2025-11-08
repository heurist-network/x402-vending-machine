# Refund Processing System

Complete 5-step workflow to identify, track, and process refunds when x402 payments succeed but token delivery fails.

---

## The 5-Step Process

### Step 0: Find Token Block Range (one-time per token)

Identify the exact block range for your token launch to optimize blockchain scanning:

```bash
# Find Coined and Graduated blocks for a token
bun run scripts/refund/find-token-event-blocks.ts --token=0xYourTokenAddress

# With custom start block
bun run scripts/refund/find-token-event-blocks.ts --token=0xYourTokenAddress --start-block=37000000
```

**Output**:
- Coined block (when token was launched)
- Graduated block (if token graduated)
- Suggested START_BLOCK and END_BLOCK values

**Next**: Update the configuration in `backfill-payment-tracking.ts` and `identify-refund-discrepancies.ts`:

---

### Step 1: Backfill Payment Data (one-time)

Populate `payment_tx_hash` and `payment_block_number` from on-chain AuthorizationUsed events:

```bash
# Dry run
bun run scripts/refund/backfill-payment-tracking.ts --dry-run true

# Execute
bun run scripts/refund/backfill-payment-tracking.ts
```

**Output**: Shows how many purchases got payment data populated.

---

### Step 2: Identify Discrepancies

Find purchases where payment was made but tokens weren't delivered:

```bash
# Required: specify token address
bun run scripts/refund/identify-refund-discrepancies.ts --token=0xYourTokenAddress

# With custom block range
bun run scripts/refund/identify-refund-discrepancies.ts --token=0xYourTokenAddress --start-block=37625000 --end-block=37647991
```

**IMPORTANT**: You MUST specify `--token` parameter to analyze a specific token. This prevents false positives when the database contains purchases for multiple tokens.

**Output:**
- Summary with $ amounts by status
- CSV file: `refund-discrepancies.csv`
- Shows which purchases already have REFUND jobs vs need new jobs

**Key metrics:**
- Total candidates and $ amount
- Already processing vs needs action
- Breakdown by purchase status

---

### Step 2.5 (Optional): Remove Policy Violators

Prevent refunds for addresses that violated policy (bot users, automated purchases):

```bash
# Edit script, add addresses to POLICY_VIOLATORS array, then:
bun run scripts/refund/mark-policy-violators-completed.ts --dry-run true  # Preview
bun run scripts/refund/mark-policy-violators-completed.ts                 # Execute
```

**What it does:** Finds purchases (status: `to_refund`, `queued`, `processing`) from violating addresses and marks them as `completed` to prevent refunds. Associated REFUND jobs are marked as `dead`.

---

### Step 3: Enqueue REFUND Jobs

Create REFUND jobs for purchases that need them (from CSV):

```bash
# Preview
bun run scripts/refund/enqueue-refunds-from-csv.ts --dry-run true --csv refund-discrepancies.csv

# Execute
bun run scripts/refund/enqueue-refunds-from-csv.ts --csv refund-discrepancies.csv
```

**What it does:**
- Reads CSV from Step 2
- Skips purchases that already have active REFUND jobs
- Creates job entries in `jobs` table
- Updates purchase status to `to_refund`

**Safety**: Idempotent - checks for duplicates before creating jobs.

---

### Step 4: Process Refunds

Execute on-chain refunds using standalone refund processor:

```bash
# Test first (no blockchain transactions)
bun run scripts/refund/process-refunds.ts --token=0xYourTokenAddress --dry-run true --max 5

# Execute refunds (start small!)
bun run scripts/refund/process-refunds.ts --token=0xYourTokenAddress --max 5

# Process more
bun run scripts/refund/process-refunds.ts --token=0xYourTokenAddress --max 20
```

**What it does:**
1. Claims REFUND jobs from queue for the specified token
2. Calls `adminRefund(payer, usdcAmount)` on VendingMachine
3. Updates purchase with `refund_tx_hash`
4. Waits for confirmation
5. Updates status to `refunded`
6. Marks job as `done`

**Parameters:**
- `--token`: Token address (required)
- `--dry-run true`: Preview without executing
- `--max N`: Process at most N jobs

**Note:** This uses a standalone script, NOT the `handleREFUND` in `job-processor.ts` (which is disabled for refunds).

---

## Monitoring & Verification

**Check job status:**
```sql
SELECT status, COUNT(*) FROM jobs WHERE kind='REFUND' GROUP BY status;
```

**Check refund progress:**
```sql
SELECT status, COUNT(*), SUM(usdc_amount_6d)/1e6 as total_usdc
FROM purchases
WHERE status IN ('to_refund', 'refunded')
GROUP BY status;
```

**Verify completion:** Re-run Step 2 to see updated status.

**On-chain verification:** Check transactions on Basescan using `refund_tx_hash`.

---

## Complete Example

```bash
# 0. One-time setup
source .env
psql "$DATABASE_URL" < prisma/migrations/complete_purchases_schema.sql
npx prisma generate

# 1. Find token block range (first time for each token)
bun run scripts/refund/find-token-event-blocks.ts --token=0xYourTokenAddress
# Output: START_BLOCK = 37653276, END_BLOCK = 37800000
# Update the constants in backfill-payment-tracking.ts and identify-refund-discrepancies.ts

# 2. Backfill payment data
bun run scripts/refund/backfill-payment-tracking.ts

# 3. Identify what needs refunding
bun run scripts/refund/identify-refund-discrepancies.ts
# Shows: 67 candidates, $593 total
#   - 48 already have jobs ($290)
#   - 19 need jobs ($303)

# 4. Enqueue missing jobs
bun run scripts/refund/enqueue-refunds-from-csv.ts \
  --csv refund-discrepancies.csv --dry-run true  # Preview
bun run scripts/refund/enqueue-refunds-from-csv.ts \
  --csv refund-discrepancies.csv  # Create

# 5. Process refunds
bun run scripts/refund/process-refunds.ts --dry-run true --max 5  # Test
bun run scripts/refund/process-refunds.ts --max 5  # Execute
bun run scripts/refund/process-refunds.ts --max 20  # More

# 6. Verify
bun run scripts/refund/identify-refund-discrepancies.ts
# Should show: Most refunded, less needs action
```

---

## Important Notes

✅ **Always use dry-run first** before executing refunds

✅ **Monitor continuously** - Watch logs and check job status

✅ **Keep audit trail** - Save CSV files and track total $ refunded

⚠️ **Security** - Keep ADMIN_PRIVATE_KEY secure

⚠️ **Idempotency** - Safe to run scripts multiple times, duplicates are prevented
