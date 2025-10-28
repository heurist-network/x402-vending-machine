# Refund Processing System

Complete 4-step workflow to identify, track, and process refunds when x402 payments succeed but token delivery fails.

---

## The 4-Step Process

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
bun run scripts/refund/identify-refund-discrepancies.ts
```

**Output:**
- Summary with $ amounts by status
- CSV file: `refund-discrepancies.csv`
- Shows which purchases already have REFUND jobs vs need new jobs

**Key metrics:**
- Total candidates and $ amount
- Already processing vs needs action
- Breakdown by purchase status

---

### Step 3: Enqueue REFUND Jobs

Create REFUND jobs for purchases that need them (from CSV):

```bash
# Preview
bun run scripts/refund/enqueue-refunds-from-csv.ts \
  --csv refund-discrepancies.csv --dry-run true

# Execute
bun run scripts/refund/enqueue-refunds-from-csv.ts \
  --csv refund-discrepancies.csv
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
bun run scripts/refund/process-refunds.ts --dry-run true --max 5

# Execute refunds (start small!)
bun run scripts/refund/process-refunds.ts --max 5

# Process more
bun run scripts/refund/process-refunds.ts --max 20
```

**What it does:**
1. Claims REFUND jobs from queue
2. Calls `adminRefund(payer, usdcAmount)` on VendingMachine
3. Updates purchase with `refund_tx_hash`
4. Waits for confirmation
5. Updates status to `refunded`
6. Marks job as `done`

**Parameters:**
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
# 1. One-time setup
source .env
psql "$DATABASE_URL" < prisma/migrations/complete_purchases_schema.sql
npx prisma generate

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
